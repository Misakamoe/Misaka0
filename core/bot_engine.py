# core/bot_engine.py

import logging
import os
import importlib
import shutil
import asyncio
import gc
import time
from datetime import datetime
import telegram
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import Application, MessageHandler, CommandHandler, ContextTypes, CallbackQueryHandler, filters, ChatMemberHandler
import threading

from core.module_loader import ModuleLoader
from core.command_handler import CommandProcessor
from core.config_manager import ConfigManager
from utils.logger import setup_logger
from utils.decorators import error_handler, permission_check, group_check, module_check
from utils.event_system import EventSystem
from utils.text_utils import TextUtils
from utils.session_manager import SessionManager
from utils.health_monitor import HealthMonitor


class BotEngine:
    """Bot 引擎，负责初始化和管理整个机器人"""

    # 示例模块
    EXAMPLE_MODULES = ['echo']

    def __init__(self):
        # 初始化配置管理器
        self.config_manager = ConfigManager()

        # 设置日志
        self.logger = setup_logger(
            "BotEngine",
            self.config_manager.main_config.get("log_level", "INFO"))

        # 降低网络错误的日志级别，减少日志噪音
        logging.getLogger("telegram.request").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)

        # 获取 Token
        self.token = self.config_manager.get_token()
        if not self.token:
            self.logger.error(
                "未设置有效的 Bot Token，请在 config/config.json 中设置 token")
            raise ValueError("Bot Token 未设置或无效")

        # 检查管理员 ID
        admin_ids = self.config_manager.get_valid_admin_ids()
        if not admin_ids:
            self.logger.error(
                "未设置有效的管理员 ID，请在 config/config.json 中设置 admin_ids")
            raise ValueError("管理员 ID 未设置或无效")

        # 从配置中获取网络设置
        network_config = self.config_manager.main_config.get("network", {})
        self.connect_timeout = network_config.get("connect_timeout", 20.0)
        self.read_timeout = network_config.get("read_timeout", 20.0)
        self.write_timeout = network_config.get("write_timeout", 20.0)
        self.poll_interval = network_config.get("poll_interval", 1.0)
        self.retry_delay = network_config.get("retry_delay", 5)

        # 检查是否配置了代理
        self.proxy_url = self.config_manager.main_config.get("proxy_url", None)

        # 初始化 Telegram Application
        builder = Application.builder().token(self.token)

        # 如果配置了代理，应用代理设置
        if self.proxy_url:
            self.logger.info(f"使用代理: {self.proxy_url}")
            builder = builder.proxy_url(self.proxy_url)

        self.application = builder.build()

        # 将配置管理器添加到 bot_data 中以便在回调中访问
        self.application.bot_data["config_manager"] = self.config_manager

        # 将自身添加到 bot_data 中
        self.application.bot_data["bot_engine"] = self

        # 添加更新锁，用于协调热更新和处理更新
        self.update_lock = asyncio.Lock()

        # 初始化事件系统
        self.event_system = EventSystem()
        self.application.bot_data["event_system"] = self.event_system

        # 初始化模块加载器
        self.module_loader = ModuleLoader()

        # 初始化会话管理器
        self.session_manager = SessionManager()
        self.application.bot_data["session_manager"] = self.session_manager

        # 初始化命令处理器
        self.command_processor = CommandProcessor(self.application)

        # 注册核心命令
        self.command_processor.register_core_commands(self)

        # 注册错误处理器
        self.application.add_error_handler(self.handle_error)

        # 注册群组成员变更处理器
        self.application.add_handler(
            ChatMemberHandler(self.handle_my_chat_member,
                              ChatMemberHandler.MY_CHAT_MEMBER))

        # 注册处理所有消息的处理器
        self.application.add_handler(
            MessageHandler(
                filters.ALL & ~filters.COMMAND
                & ~filters.UpdateType.EDITED_MESSAGE,
                self.handle_all_messages),
            group=999  # 使用高数字确保它在最后处理
        )

        # 配置文件监控相关
        self.config_watch_task = None
        self.config_change_lock = asyncio.Lock()
        self.last_config_change = {}  # 记录最后修改时间

        # 资源清理任务
        self.cleanup_task = None

        # 初始化统计数据
        self.stats = {
            "start_time": time.time(),
            "last_cleanup": time.time(),
            "memory_usage": [],
            "module_stats": {}
        }

        # 初始化健康监控系统（在其他组件初始化之后）
        self.health_monitor = HealthMonitor(self)

        # 注册命令分页回调处理器
        self.application.add_handler(
            CallbackQueryHandler(self.handle_command_page_callback,
                                 pattern=r"^cmd_page_\d+$|^cmd_noop$"))

        self.logger.info("Bot 引擎初始化完成")

    # 辅助方法
    async def _check_command_args(self, update, context, min_args, usage_msg):
        """检查命令参数
        
        Args:
            update: 更新对象
            context: 上下文对象
            min_args: 最小参数数量
            usage_msg: 用法提示消息
            
        Returns:
            bool: 参数是否有效
        """
        if not context.args or len(context.args) < min_args:
            await update.message.reply_text(usage_msg)
            return False
        return True

    async def _send_markdown_message(self, update, message, fallback=True):
        """发送 Markdown 格式消息，出错时尝试发送纯文本
        
        Args:
            update: 更新对象
            message: Markdown 格式消息
            fallback: 是否在出错时尝试发送纯文本
            
        Returns:
            bool: 是否成功发送
        """
        try:
            # 尝试发送带有 Markdown 格式的消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")
            return True
        except Exception as e:
            if not fallback:
                raise

            # 如果失败，尝试发送纯文本消息
            self.logger.error(f"使用 Markdown 发送消息失败: {e}")
            plain_message = TextUtils.markdown_to_plain(message)
            await update.message.reply_text(plain_message)
            return False

    # 错误处理
    async def handle_error(self, update: object,
                           context: ContextTypes.DEFAULT_TYPE) -> None:
        """处理错误"""
        self.logger.error("处理更新时发生异常:", exc_info=context.error)

        # 如果 update 是可用的，发送错误消息
        if update and isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text("处理命令时发生错误，请查看日志获取详情。")

    # 轮询错误回调
    def polling_error_callback(self, error):
        """轮询错误回调"""
        if isinstance(error, telegram.error.NetworkError):
            # 对于网络错误，只记录警告而不是错误
            self.logger.warning(f"网络连接暂时中断: {error}，将自动重试")
            return

        # 对于其他错误，正常记录
        self.logger.error(f"轮询时发生错误: {error}", exc_info=True)

    @error_handler
    async def health_status_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """显示机器人健康状态"""
        if not hasattr(self, 'health_monitor'):
            await update.message.reply_text("健康监控系统未初始化")
            return

        try:
            status = self.health_monitor.get_health_status()

            # 构建状态消息，确保所有文本都进行了转义
            message = f"📊 *机器人健康状态*\n\n"
            message += f"⚡ 状态: {TextUtils.escape_markdown(status['status'])}\n"

            last_check = status['last_check'] or '未检查'
            message += f"⏱️ 上次检查: {TextUtils.escape_markdown(last_check)}\n"

            message += f"⚠️ 故障次数: {status['failures']}\n"
            message += f"🔄 恢复次数: {status['recoveries']}\n"

            if status.get('last_recovery'):
                message += f"🛠️ 上次恢复: {TextUtils.escape_markdown(status['last_recovery'])}\n"

            # 添加组件状态
            message += "\n*组件状态:*\n"
            for component, comp_status in status['components'].items():
                status_emoji = "✅" if comp_status[
                    'status'] == "healthy" else "❌"
                safe_component = TextUtils.escape_markdown(component)
                safe_status = TextUtils.escape_markdown(comp_status['status'])
                message += f"{status_emoji} {safe_component}: {safe_status}\n"

            await update.message.reply_text(message, parse_mode="MARKDOWN")

        except Exception as e:
            self.logger.error(f"生成健康状态报告时出错: {e}", exc_info=True)
            await update.message.reply_text("生成健康状态报告时出错，请查看日志获取详情。")

    # 资源清理
    async def cleanup_resources(self):
        """定期清理资源，减少内存占用"""
        cleanup_interval = 3600  # 每小时清理一次

        while True:
            try:
                await asyncio.sleep(cleanup_interval)

                start_time = time.time()
                self.logger.info("开始执行资源清理...")

                # 获取清理前的内存使用情况
                before_mem = self._get_memory_usage()

                # 1. 触发 Python 垃圾回收
                collected = gc.collect()
                self.logger.debug(f"垃圾回收完成，回收了 {collected} 个对象")

                # 2. 清理未使用的模块
                await self._cleanup_unused_modules()

                # 3. 清理会话管理器中的过期会话
                session_count = self.session_manager.cleanup()
                if session_count > 0:
                    self.logger.info(f"已清理 {session_count} 个过期会话")

                # 获取清理后的内存使用情况
                after_mem = self._get_memory_usage()
                mem_diff = before_mem - after_mem

                # 更新统计信息
                self.stats["last_cleanup"] = time.time()
                self.stats["memory_usage"].append({
                    "time": time.time(),
                    "before": before_mem,
                    "after": after_mem,
                    "diff": mem_diff
                })

                # 只保留最近的 10 条记录
                if len(self.stats["memory_usage"]) > 10:
                    self.stats["memory_usage"] = self.stats["memory_usage"][
                        -10:]

                elapsed = time.time() - start_time
                self.logger.info(
                    f"资源清理完成，耗时 {elapsed:.2f} 秒，释放了 {mem_diff:.2f} MB 内存")

            except asyncio.CancelledError:
                self.logger.info("资源清理任务已取消")
                break
            except Exception as e:
                self.logger.error(f"资源清理过程中出错: {e}", exc_info=True)
                # 出错后等待较短时间再重试
                await asyncio.sleep(300)

    def _get_memory_usage(self):
        """获取当前进程的内存使用量（MB）"""
        try:
            import psutil
            process = psutil.Process(os.getpid())
            mem_info = process.memory_info()
            return mem_info.rss / 1024 / 1024  # 转换为 MB
        except ImportError:
            # 如果没有安装 psutil，返回 -1
            return -1
        except Exception as e:
            self.logger.error(f"获取内存使用量时出错: {e}")
            return -1

    async def _cleanup_unused_modules(self):
        """清理未使用的模块"""
        # 获取全局和群组启用的所有模块
        enabled_modules = set(self.config_manager.get_enabled_modules())

        # 获取所有群组的启用模块
        for modules in self.config_manager.modules_config.get(
                "group_modules", {}).values():
            enabled_modules.update(modules)

        # 检查已加载但未启用的模块
        unloaded_count = 0
        for module_name in list(self.module_loader.loaded_modules.keys()):
            # 跳过示例模块
            if module_name in self.EXAMPLE_MODULES:
                continue

            # 如果模块未启用，卸载它
            if module_name not in enabled_modules:
                try:
                    if await self.unload_single_module(module_name):
                        unloaded_count += 1
                        self.logger.info(f"已卸载未使用的模块: {module_name}")
                except Exception as e:
                    self.logger.error(f"卸载模块 {module_name} 时出错: {e}")

        if unloaded_count > 0:
            self.logger.info(f"共卸载了 {unloaded_count} 个未使用的模块")

        return unloaded_count

    # 配置监控
    async def watch_config_changes(self):
        """监控配置文件变化的异步任务"""
        config_dir = self.config_manager.config_dir
        main_config_path = os.path.join(config_dir, "config.json")
        modules_config_path = os.path.join(config_dir, "modules.json")

        # 初始化文件最后修改时间
        self.last_config_change = {
            main_config_path:
            os.path.getmtime(main_config_path)
            if os.path.exists(main_config_path) else 0,
            modules_config_path:
            os.path.getmtime(modules_config_path)
            if os.path.exists(modules_config_path) else 0
        }

        self.logger.info(f"开始监控配置文件变化，目录: {config_dir}")

        # 防抖动变量
        debounce_timers = {}

        # 使用更长的检查间隔以减少资源消耗
        check_interval = 5  # 5 秒检查一次
        error_backoff = 1  # 出错后的回退系数

        try:
            while True:
                try:
                    changed_files = []

                    # 检查配置文件
                    for config_path in [main_config_path, modules_config_path]:
                        if not os.path.exists(config_path):
                            continue

                        try:
                            current_mtime = os.path.getmtime(config_path)
                            if current_mtime > self.last_config_change.get(
                                    config_path, 0):
                                self.logger.debug(f"检测到配置文件变化: {config_path}")
                                self.last_config_change[
                                    config_path] = current_mtime
                                changed_files.append(config_path)
                        except (OSError, IOError) as e:
                            self.logger.warning(f"检查文件 {config_path} 时出错: {e}")

                    # 处理变更的文件
                    for config_path in changed_files:
                        # 取消之前的定时器（如果存在）
                        if config_path in debounce_timers and not debounce_timers[
                                config_path].done():
                            debounce_timers[config_path].cancel()

                        # 创建新的延迟处理任务
                        debounce_timers[config_path] = asyncio.create_task(
                            self.debounce_config_change(config_path, 1.0))

                    # 重置错误回退
                    error_backoff = 1

                    # 等待下一次检查
                    await asyncio.sleep(check_interval)

                except Exception as e:
                    self.logger.error(f"监控配置文件时出错: {e}", exc_info=True)
                    # 出错后使用指数回退策略
                    wait_time = check_interval * error_backoff
                    error_backoff = min(error_backoff * 2, 60)  # 最多等待5分钟
                    await asyncio.sleep(wait_time)

        except asyncio.CancelledError:
            self.logger.info("配置文件监控任务已取消")
            # 取消所有未完成的防抖动任务
            for path, task in debounce_timers.items():
                if not task.done():
                    task.cancel()
            raise

    async def debounce_config_change(self, file_path, delay):
        """延迟处理配置文件变更，实现防抖动"""
        try:
            # 等待指定的延迟时间
            await asyncio.sleep(delay)
            # 处理配置变更
            await self.handle_config_change(file_path)
        except asyncio.CancelledError:
            # 如果任务被取消，不做任何处理
            pass

    async def handle_config_change(self, file_path):
        """处理配置文件变更"""
        # 使用锁防止并发处理同一个文件
        async with self.config_change_lock:
            try:
                self.logger.info(f"处理配置文件变更: {file_path}")

                # 保存当前模块列表用于比较
                old_modules = set(self.config_manager.get_enabled_modules())

                # 根据文件路径重新加载相应配置
                if file_path.endswith("config.json"):
                    self.config_manager.reload_main_config()
                    self.logger.info("已重新加载主配置文件")
                elif file_path.endswith("modules.json"):
                    self.config_manager.reload_modules_config()
                    self.logger.info("已重新加载模块配置文件")

                # 检查模块列表是否变化
                new_modules = set(self.config_manager.get_enabled_modules())

                # 处理新启用的模块
                for module_name in new_modules - old_modules:
                    self.logger.info(f"检测到新启用的模块: {module_name}，正在自动加载...")
                    success = await self.load_single_module(module_name)
                    if success:
                        self.logger.info(f"模块 {module_name} 已成功加载")
                    else:
                        self.logger.error(f"模块 {module_name} 加载失败")

                # 处理新禁用的模块
                for module_name in old_modules - new_modules:
                    self.logger.info(f"检测到模块 {module_name} 已被禁用")

                # 确保存在最后修改时间记录
                if not hasattr(self, '_last_module_mtime'):
                    self._last_module_mtime = {}

                # 收集需要热更新的模块
                modules_to_update = []
                for module_name in self.module_loader.loaded_modules.keys():
                    if module_name in new_modules:  # 只处理仍然启用的模块
                        # 检查模块文件是否有变化
                        module_path = os.path.join(
                            self.module_loader.modules_dir,
                            f"{module_name}.py")
                        if os.path.exists(module_path):
                            # 检查文件是否有变化
                            try:
                                current_mtime = os.path.getmtime(module_path)
                                last_mtime = self._last_module_mtime.get(
                                    module_name, 0)

                                if current_mtime > last_mtime:
                                    self.logger.info(
                                        f"检测到模块 {module_name} 文件变化，将进行热更新")
                                    modules_to_update.append(module_name)
                                    # 更新最后修改时间
                                    self._last_module_mtime[
                                        module_name] = current_mtime
                            except OSError as e:
                                self.logger.warning(
                                    f"检查模块 {module_name} 文件时出错: {e}")

                # 创建一个延迟任务来执行热更新
                if modules_to_update:
                    asyncio.create_task(
                        self._delayed_hot_reload(modules_to_update))

            except Exception as e:
                self.logger.error(f"处理配置变更时出错: {e}", exc_info=True)

    async def _delayed_hot_reload(self, module_names):
        """延迟执行模块热更新，确保在当前更新处理完成后进行"""
        # 等待一小段时间，确保当前的更新处理已完成
        await asyncio.sleep(0.5)

        # 获取更新锁
        async with self.update_lock:
            for module_name in module_names:
                self.logger.info(f"执行模块 {module_name} 的热更新...")
                success = await self.module_loader.hot_reload_module(
                    module_name, self.application, self)
                if success:
                    self.logger.info(f"模块 {module_name} 已成功热更新")
                else:
                    self.logger.warning(f"模块 {module_name} 热更新失败")

    # 模块管理方法
    async def load_single_module(self, module_name):
        """加载单个模块及其依赖"""
        # 检查模块是否已加载
        if self.module_loader.is_module_loaded(module_name):
            self.logger.debug(f"模块 {module_name} 已加载")
            return True

        # 加载模块
        module_data = self.module_loader.load_module(module_name,
                                                     self.application, self)
        if not module_data:
            self.logger.error(f"无法加载模块 {module_name}")
            return False

        # 检查并加载依赖
        dependencies = module_data["metadata"].get("dependencies", [])
        if dependencies:
            self.logger.info(f"模块 {module_name} 依赖于: {dependencies}")
            for dep in dependencies:
                # 检查依赖是否已启用
                if dep not in self.config_manager.get_enabled_modules():
                    self.logger.info(f"自动启用依赖模块: {dep}")
                    self.config_manager.enable_module(dep)

                # 加载依赖
                if not await self.load_single_module(dep):
                    self.logger.error(f"加载依赖 {dep} 失败，无法加载模块 {module_name}")
                    return False

        # 初始化模块
        if self.module_loader.initialize_module(module_name, self.application,
                                                self):
            self.logger.info(f"模块 {module_name} 已加载并初始化")
            return True
        else:
            self.logger.error(f"初始化模块 {module_name} 失败")
            return False

    async def unload_single_module(self, module_name):
        """卸载单个模块"""
        if not self.module_loader.is_module_loaded(module_name):
            self.logger.debug(f"模块 {module_name} 未加载")
            return True

        # 检查其他模块是否依赖于此模块
        for m_name, m_data in self.module_loader.loaded_modules.items():
            if m_name != module_name and module_name in m_data["metadata"].get(
                    "dependencies", []):
                self.logger.warning(f"模块 {m_name} 依赖于 {module_name}，无法卸载")
                return False

        # 卸载模块
        if self.module_loader.unload_module(module_name):
            self.logger.info(f"模块 {module_name} 已卸载")
            return True
        else:
            self.logger.error(f"卸载模块 {module_name} 失败")
            return False

    async def load_modules(self):
        """并行加载全局和群组启用的模块"""
        # 获取全局启用的模块
        enabled_modules = self.config_manager.get_enabled_modules()
        self.logger.info(f"正在加载全局启用的模块: {enabled_modules}")

        # 获取所有群组的启用模块并去重
        group_modules = set()
        for modules in self.config_manager.modules_config.get(
                "group_modules", {}).values():
            group_modules.update(modules)

        if group_modules:
            self.logger.info(f"正在加载群组启用的模块: {list(group_modules)}")

        # 合并去重后的所有需要加载的模块
        all_modules = list(set(enabled_modules) | group_modules)

        if not all_modules:
            return

        # 检查依赖冲突 - 使用轻量级方式获取元数据
        dependency_graph = {}
        circular_dependencies = []

        # 构建依赖图
        for module_name in all_modules:
            try:
                # 不完全加载模块，只提取元数据
                module_path = os.path.join(self.module_loader.modules_dir,
                                           f"{module_name}.py")
                if os.path.exists(module_path):
                    # 读取模块文件
                    with open(module_path, 'r', encoding='utf-8') as f:
                        module_code = f.read()

                    # 提取依赖信息
                    dependencies = []
                    for line in module_code.split('\n'):
                        if line.strip().startswith('MODULE_DEPENDENCIES'):
                            try:
                                # 使用安全的方式评估依赖列表
                                deps_str = line.split('=')[1].strip()
                                if deps_str.startswith(
                                        '[') and deps_str.endswith(']'):
                                    deps_items = deps_str[1:-1].split(',')
                                    dependencies = [
                                        dep.strip(' \'"[]')
                                        for dep in deps_items if dep.strip()
                                    ]
                                break
                            except Exception as e:
                                self.logger.error(
                                    f"解析模块 {module_name} 的依赖信息失败: {e}")
                                dependencies = []

                    dependency_graph[module_name] = dependencies
                    self.logger.debug(f"模块 {module_name} 依赖: {dependencies}")
            except Exception as e:
                self.logger.error(f"读取模块 {module_name} 的依赖信息失败: {e}")
                dependency_graph[module_name] = []

        # 检测循环依赖
        def check_circular_dependency(module, path=None):
            if path is None:
                path = []

            if module in path:
                # 发现循环依赖
                cycle_path = path[path.index(module):] + [module]
                circular_path = " -> ".join(cycle_path)
                if circular_path not in circular_dependencies:
                    circular_dependencies.append(circular_path)
                    self.logger.error(f"检测到循环依赖: {circular_path}")
                return True

            path = path + [module]
            for dep in dependency_graph.get(module, []):
                if dep in dependency_graph and check_circular_dependency(
                        dep, path):
                    return True
            return False

        # 检查每个模块的依赖
        for module in dependency_graph:
            check_circular_dependency(module)

        if circular_dependencies:
            self.logger.warning("由于存在循环依赖，某些模块可能无法正确加载")

        # 创建加载任务列表并执行
        load_tasks = [
            self.load_single_module(module_name) for module_name in all_modules
        ]
        results = await asyncio.gather(*load_tasks, return_exceptions=True)

        # 处理加载结果
        for module_name, result in zip(all_modules, results):
            if isinstance(result, Exception):
                self.logger.error(f"加载模块 {module_name} 时发生错误: {result}")
            elif not result:
                self.logger.warning(f"模块 {module_name} 加载失败")

    # 命令处理方法
    async def enable_module_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """启用模块命令处理"""
        if not await self._check_command_args(update, context, 1,
                                              "用法: /enable <模块名>"):
            return

        module_name = context.args[0]
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type

        # 检查是否是示例模块
        if module_name in self.EXAMPLE_MODULES:
            await update.message.reply_text(f"找不到模块 {module_name}")
            return

        # 检查模块是否可用
        available_modules = [
            m for m in self.module_loader.discover_modules()
            if m not in self.EXAMPLE_MODULES
        ]
        if module_name not in available_modules:
            await update.message.reply_text(f"找不到模块 {module_name}")
            return

        # 检查模块是否已启用
        if self.config_manager.is_module_enabled_for_chat(
                module_name, chat_id):
            if chat_type in ["group", "supergroup"]:
                await update.message.reply_text(f"模块 {module_name} 已在当前群组启用")
            else:
                await update.message.reply_text(f"模块 {module_name} 已全局启用")
            return

        # 加载并启用模块
        if await self.load_single_module(module_name):
            # 为当前聊天启用模块
            self.config_manager.enable_module_for_chat(module_name, chat_id)

            if chat_type in ["group", "supergroup"]:
                await update.message.reply_text(f"模块 {module_name} 已在当前群组启用")
            else:
                await update.message.reply_text(f"模块 {module_name} 已全局启用")
        else:
            await update.message.reply_text(f"启用模块 {module_name} 失败，请查看日志")

    async def disable_module_command(self, update: Update,
                                     context: ContextTypes.DEFAULT_TYPE):
        """禁用模块命令处理"""
        if not await self._check_command_args(update, context, 1,
                                              "用法: /disable <模块名>"):
            return

        module_name = context.args[0]
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type

        # 检查是否是示例模块
        if module_name in self.EXAMPLE_MODULES:
            await update.message.reply_text(f"找不到模块 {module_name}")
            return

        # 检查模块是否已启用
        if not self.config_manager.is_module_enabled_for_chat(
                module_name, chat_id):
            if chat_type in ["group", "supergroup"]:
                await update.message.reply_text(f"模块 {module_name} 未在当前群组启用")
            else:
                await update.message.reply_text(f"模块 {module_name} 未全局启用")
            return

        # 为当前聊天禁用模块
        self.config_manager.disable_module_for_chat(module_name, chat_id)

        if chat_type in ["group", "supergroup"]:
            await update.message.reply_text(f"模块 {module_name} 已在当前群组禁用")
        else:
            await update.message.reply_text(f"模块 {module_name} 已全局禁用")

    async def list_modules_command(self, update: Update,
                                   context: ContextTypes.DEFAULT_TYPE):
        """列出模块命令处理"""
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type

        enabled_modules = self.config_manager.get_enabled_modules_for_chat(
            chat_id)
        available_modules = self.module_loader.discover_modules()

        # 过滤掉示例模块
        available_modules = [
            m for m in available_modules if m not in self.EXAMPLE_MODULES
        ]
        enabled_modules = [
            m for m in enabled_modules if m not in self.EXAMPLE_MODULES
        ]

        # 构建消息
        if chat_type in ["group", "supergroup"]:
            message = "📦 *当前群组的模块列表*\n\n"
        else:
            message = "📦 *全局模块列表*\n\n"

        # 已启用模块
        if enabled_modules:
            message += "*已启用:*\n"
            for module in enabled_modules:
                # 获取模块描述
                desc = ""
                if self.module_loader.is_module_loaded(module):
                    metadata = self.module_loader.loaded_modules[module][
                        "metadata"]
                    desc = f" - {metadata.get('description', '')}"
                # 转义可能导致 Markdown 解析错误的字符
                safe_module = TextUtils.escape_markdown(module)
                safe_desc = TextUtils.escape_markdown(desc)
                message += f"- {safe_module}{safe_desc}\n"

        # 可启用但未启用的模块
        available_not_enabled = [
            m for m in available_modules if m not in enabled_modules
        ]

        # 检查用户权限
        config_manager = context.bot_data.get("config_manager")
        user_id = update.effective_user.id

        is_super_admin = config_manager.is_admin(user_id)
        is_group_admin = False

        if chat_type in ["group", "supergroup"]:
            try:
                chat_member = await context.bot.get_chat_member(
                    chat_id, user_id)
                is_group_admin = chat_member.status in [
                    "creator", "administrator"
                ]
            except Exception:
                pass

        # 只向管理员显示可启用的模块
        if is_super_admin or (chat_type in ["group", "supergroup"]
                              and is_group_admin):
            if available_not_enabled:
                message += "\n*可启用:*\n"
                for module in available_not_enabled:
                    # 转义可能导致 Markdown 解析错误的字符
                    safe_module = TextUtils.escape_markdown(module)
                    message += f"- {safe_module}\n"

        # 使用通用方法发送 Markdown 消息
        await self._send_markdown_message(update, message)

    async def list_commands_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """列出当前聊天可用的已注册命令（带分页）"""
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type
        config_manager = context.bot_data.get("config_manager")
        user_id = update.effective_user.id

        # 检查用户权限
        is_super_admin = config_manager.is_admin(user_id)
        is_group_admin = False

        if chat_type in ["group", "supergroup"]:
            try:
                chat_member = await context.bot.get_chat_member(
                    chat_id, user_id)
                is_group_admin = chat_member.status in [
                    "creator", "administrator"
                ]
            except Exception:
                pass

        # 收集所有命令
        all_commands = self.command_processor.command_handlers.keys()
        command_metadata = self.command_processor.command_metadata

        # 核心命令分类
        core_commands_all = ["start", "help", "id", "modules",
                             "commands"]  # 所有用户可用
        core_commands_admin = ["enable", "disable"]  # 管理员可用
        core_commands_super = [
            "listgroups", "addgroup", "removegroup", "stats", "health"
        ]  # 超级管理员可用

        # 分类命令
        available_commands = []
        admin_commands = []
        super_admin_commands = []
        module_commands = {}  # 使用字典按模块分组

        for cmd in all_commands:
            # 获取命令元数据
            metadata = command_metadata.get(cmd, {})
            admin_level = metadata.get("admin_only", False)

            if cmd in core_commands_all:
                available_commands.append(cmd)
            elif cmd in core_commands_admin and (is_super_admin
                                                 or is_group_admin):
                admin_commands.append(cmd)
            elif cmd in core_commands_super and is_super_admin:
                super_admin_commands.append(cmd)
            else:
                # 检查命令所属的模块
                for module_name, module_data in self.module_loader.loaded_modules.items(
                ):
                    # 跳过示例模块
                    if module_name in self.EXAMPLE_MODULES:
                        continue

                    module_cmds = module_data["metadata"].get("commands", [])
                    if cmd in module_cmds:
                        # 检查模块是否在当前聊天中启用
                        if config_manager.is_module_enabled_for_chat(
                                module_name, chat_id):
                            if module_name not in module_commands:
                                module_commands[module_name] = {
                                    "description":
                                    module_data["metadata"].get(
                                        "description", ""),
                                    "commands": []
                                }
                            module_commands[module_name]["commands"].append(
                                cmd)
                        break

        # 准备分页数据 - 基于内容高度而不是固定的模块分页
        # 每页最大行数（Telegram 消息的合理高度限制）
        MAX_LINES_PER_PAGE = 20

        pages = []
        current_page = ""
        current_page_lines = 0

        # 添加页头
        if chat_type in ["group", "supergroup"]:
            header = "*当前群组可用命令:*\n"
        else:
            header = "*可用命令:*\n"

        current_page = header
        current_page_lines = 1

        # 添加基本命令部分
        if available_commands:
            basic_section = "\n*基本命令:*\n"
            for cmd in sorted(available_commands):
                safe_cmd = TextUtils.escape_markdown(cmd)
                basic_section += f"/{safe_cmd}\n"

            # 检查添加这部分是否会超出页面高度
            section_lines = len(basic_section.split('\n'))
            if current_page_lines + section_lines > MAX_LINES_PER_PAGE:
                # 如果会超出，先保存当前页，然后开始新页
                pages.append(current_page)
                current_page = header + basic_section
                current_page_lines = 1 + section_lines  # header + section
            else:
                # 如果不会超出，直接添加到当前页
                current_page += basic_section
                current_page_lines += section_lines

        # 添加管理员命令部分
        if admin_commands:
            admin_section = "\n*管理员命令:*\n"
            for cmd in sorted(admin_commands):
                safe_cmd = TextUtils.escape_markdown(cmd)
                admin_section += f"/{safe_cmd}\n"

            # 检查添加这部分是否会超出页面高度
            section_lines = len(admin_section.split('\n'))
            if current_page_lines + section_lines > MAX_LINES_PER_PAGE:
                # 如果会超出，先保存当前页，然后开始新页
                pages.append(current_page)
                current_page = header + admin_section
                current_page_lines = 1 + section_lines
            else:
                # 如果不会超出，直接添加到当前页
                current_page += admin_section
                current_page_lines += section_lines

        # 添加超级管理员命令部分
        if super_admin_commands:
            super_admin_section = "\n*超级管理员命令:*\n"
            for cmd in sorted(super_admin_commands):
                safe_cmd = TextUtils.escape_markdown(cmd)
                super_admin_section += f"/{safe_cmd}\n"

            # 检查添加这部分是否会超出页面高度
            section_lines = len(super_admin_section.split('\n'))
            if current_page_lines + section_lines > MAX_LINES_PER_PAGE:
                # 如果会超出，先保存当前页，然后开始新页
                pages.append(current_page)
                current_page = header + super_admin_section
                current_page_lines = 1 + section_lines
            else:
                # 如果不会超出，直接添加到当前页
                current_page += super_admin_section
                current_page_lines += section_lines

        # 添加模块命令部分 - 确保同一模块的命令都在同一页
        if module_commands:
            # 先添加模块标题
            module_title = "\n*模块命令:*\n"
            module_title_lines = 2  # 标题占 2 行

            # 如果添加模块标题会导致当前页超出，先保存当前页
            if current_page_lines + module_title_lines > MAX_LINES_PER_PAGE:
                pages.append(current_page)
                current_page = header + module_title
                current_page_lines = 1 + module_title_lines
            else:
                current_page += module_title
                current_page_lines += module_title_lines

            # 逐个处理模块
            for module_name, module_info in sorted(module_commands.items()):
                desc = module_info["description"]
                cmds = module_info["commands"]

                # 构建这个模块的部分
                module_section = f"\n*{TextUtils.escape_markdown(module_name)}* - {TextUtils.escape_markdown(desc)}\n"
                for cmd in sorted(cmds):
                    safe_cmd = TextUtils.escape_markdown(cmd)
                    module_section += f"/{safe_cmd}\n"

                # 检查添加这个模块是否会使当前页超出高度
                section_lines = len(module_section.split('\n'))

                # 如果添加这个模块会导致当前页超出，先保存当前页，然后把整个模块放到新页
                if current_page_lines + section_lines > MAX_LINES_PER_PAGE:
                    pages.append(current_page)
                    # 新页以页头和模块部分开始
                    current_page = header + module_section
                    current_page_lines = 1 + section_lines
                else:
                    # 如果不会超出，直接添加到当前页
                    current_page += module_section
                    current_page_lines += section_lines

        # 保存最后一页（如果有内容）
        if current_page != header:
            pages.append(current_page)

        # 如果没有命令，添加一个空页
        if not pages:
            pages.append(header + "无已注册命令\n")

        # 存储分页数据到用户会话
        await self.session_manager.set(user_id, "command_pages", pages)
        await self.session_manager.set(user_id, "current_page", 0)

        # 显示第一页
        await self._show_command_page(update, context, 0)

    async def _show_command_page(self, update: Update,
                                 context: ContextTypes.DEFAULT_TYPE,
                                 page_index):
        """显示指定页的命令列表"""
        user_id = update.effective_user.id

        # 获取分页数据
        pages = await self.session_manager.get(user_id, "command_pages", [])

        if not pages:
            # 检查是回调查询还是直接消息
            if update.callback_query:
                await update.callback_query.answer("无可用命令")
                try:
                    await update.callback_query.edit_message_text("无可用命令")
                except Exception:
                    pass
            else:
                await update.message.reply_text("无可用命令")
            return

        # 确保页码有效
        page_index = max(0, min(page_index, len(pages) - 1))

        # 获取当前页内容
        page_content = pages[page_index]

        # 构建消息
        message = page_content

        # 只有当有多个页面时才添加分页按钮
        if len(pages) > 1:
            # 创建分页按钮
            keyboard = []
            buttons = []

            # 上一页按钮
            if page_index > 0:
                buttons.append(
                    InlineKeyboardButton(
                        "◁", callback_data=f"cmd_page_{page_index-1}"))
            else:
                buttons.append(
                    InlineKeyboardButton(" ", callback_data="cmd_noop"))

            # 页码指示器
            buttons.append(
                InlineKeyboardButton(f"{page_index+1}/{len(pages)}",
                                     callback_data="cmd_noop"))

            # 下一页按钮
            if page_index < len(pages) - 1:
                buttons.append(
                    InlineKeyboardButton(
                        "▷", callback_data=f"cmd_page_{page_index+1}"))
            else:
                buttons.append(
                    InlineKeyboardButton(" ", callback_data="cmd_noop"))

            keyboard.append(buttons)
            reply_markup = InlineKeyboardMarkup(keyboard)

            # 发送或编辑消息
            if update.callback_query:
                # 使用回调查询的消息进行编辑
                await update.callback_query.edit_message_text(
                    text=message,
                    parse_mode="MARKDOWN",
                    reply_markup=reply_markup)
            else:
                # 直接回复新消息
                await update.message.reply_text(text=message,
                                                parse_mode="MARKDOWN",
                                                reply_markup=reply_markup)
        else:
            # 只有一页，不需要分页按钮
            if update.callback_query:
                await update.callback_query.edit_message_text(
                    text=message, parse_mode="MARKDOWN")
            else:
                await update.message.reply_text(text=message,
                                                parse_mode="MARKDOWN")

        # 如果是回调查询，回答它
        if update.callback_query:
            await update.callback_query.answer()

    async def handle_command_page_callback(self, update: Update,
                                           context: ContextTypes.DEFAULT_TYPE):
        """处理命令列表分页回调"""
        query = update.callback_query
        user_id = query.from_user.id
        data = query.data

        # 解析回调数据
        if data == "cmd_noop":
            # 无操作按钮，只回答查询
            await query.answer()
            return

        # 解析页码
        try:
            page_index = int(data.split("_")[-1])

            # 检查会话数据是否存在
            if not await self.session_manager.has_key(user_id,
                                                      "command_pages"):
                # 会话数据丢失（可能是 Bot 重启），通知用户
                await query.answer("会话已过期，请重新使用 /commands 命令")
                await query.edit_message_text("列表已过期，请重新使用 /commands 命令",
                                              parse_mode="MARKDOWN")
                return

            await self._show_command_page(update, context, page_index)

            # 更新当前页码
            await self.session_manager.set(user_id, "current_page", page_index)
        except Exception as e:
            self.logger.error(f"处理命令分页回调时出错: {e}", exc_info=True)
            await query.answer("出现错误，请重试")

    @error_handler
    async def stats_command(self, update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
        """显示机器人统计信息"""
        # 计算运行时间
        uptime_seconds = time.time() - self.stats["start_time"]
        days, remainder = divmod(uptime_seconds, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, seconds = divmod(remainder, 60)
        uptime_str = f"{int(days)} 天 {int(hours)} 小时 {int(minutes)} 分钟"

        # 获取内存使用情况
        current_mem = self._get_memory_usage()

        # 获取活跃会话数量
        active_sessions = await self.session_manager.get_active_sessions_count(
        )

        # 获取已加载模块数量
        loaded_modules = len(self.module_loader.loaded_modules)

        # 构建统计信息
        message = f"📊 *机器人统计信息*\n\n"
        message += f"⏱️ 运行时间: {uptime_str}\n"
        message += f"🧠 内存使用: {current_mem:.2f} MB\n"
        message += f"👥 活跃会话: {active_sessions}\n"
        message += f"📦 已加载模块: {loaded_modules}\n"

        # 最后清理时间
        if self.stats.get("last_cleanup", 0) > 0:
            last_cleanup = datetime.fromtimestamp(
                self.stats["last_cleanup"]).strftime("%Y-%m-%d %H:%M:%S")
            message += f"🧹 最后清理: {last_cleanup}\n"

        # 内存清理效果
        if self.stats.get("memory_usage") and len(
                self.stats["memory_usage"]) > 0:
            last_cleanup = self.stats["memory_usage"][-1]
            if last_cleanup.get("diff", 0) > 0:
                message += f"📉 最近清理释放: {last_cleanup['diff']:.2f} MB\n"

        await update.message.reply_text(message, parse_mode="MARKDOWN")

    async def get_id_command(self, update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
        """获取用户 ID 和聊天 ID"""
        user = update.effective_user
        chat = update.effective_chat

        # 检查是否是回复某条消息
        if update.message.reply_to_message:
            # 只显示被回复用户的信息
            replied_user = update.message.reply_to_message.from_user
            message = f"👤 *用户信息*\n"
            message += f"用户 ID: `{replied_user.id}`\n"
            if replied_user.username:
                message += f"用户名: @{TextUtils.escape_markdown(replied_user.username)}\n"
            message += f"名称: {TextUtils.escape_markdown(replied_user.full_name)}\n"

            # 直接回复原消息
            await update.message.reply_to_message.reply_text(
                message, parse_mode="MARKDOWN")
        else:
            # 没有回复消息，显示自己的信息和聊天信息
            message = f"👤 *用户信息*\n"
            message += f"用户 ID: `{user.id}`\n"
            if user.username:
                message += f"用户名: @{TextUtils.escape_markdown(user.username)}\n"
            message += f"名称: {TextUtils.escape_markdown(user.full_name)}\n\n"

            message += f"💬 *聊天信息*\n"
            message += f"聊天 ID: `{chat.id}`\n"
            message += f"类型: {chat.type}\n"

            if chat.type in ["group", "supergroup"]:
                message += f"群组名称: {TextUtils.escape_markdown(chat.title)}\n"

                # 如果是群组管理员或超级管理员，显示更多信息
                config_manager = context.bot_data.get("config_manager")
                is_super_admin = config_manager.is_admin(user.id)

                try:
                    chat_member = await context.bot.get_chat_member(
                        chat.id, user.id)
                    is_group_admin = chat_member.status in [
                        "creator", "administrator"
                    ]
                except Exception:
                    is_group_admin = False

                if is_super_admin or is_group_admin:
                    message += "\n*群组管理员:*\n"
                    try:
                        # 获取群组管理员
                        administrators = await context.bot.get_chat_administrators(
                            chat.id)
                        for admin in administrators:
                            admin_user = admin.user
                            admin_info = TextUtils.format_user_info(admin_user)
                            message += f"- {admin_info} - {admin.status}\n"
                    except Exception as e:
                        error_msg = TextUtils.escape_markdown(str(e))
                        message += f"获取管理员列表失败: {error_msg}\n"

            # 正常回复当前消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")

    # 群组管理方法
    async def handle_my_chat_member(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """处理 Bot 的成员状态变化"""
        chat_member = update.my_chat_member
        chat = chat_member.chat
        user = chat_member.from_user  # 谁改变了 Bot 的状态

        # 只处理群组
        if chat.type not in ["group", "supergroup"]:
            return

        # 确保配置中存在 allowed_groups
        if "allowed_groups" not in self.config_manager.main_config:
            self.config_manager.main_config["allowed_groups"] = {}
            self.config_manager.save_main_config()

        # 检查 Bot 是否被添加到群组
        if (chat_member.old_chat_member.status in ["left", "kicked"]
                and chat_member.new_chat_member.status
                in ["member", "administrator"]):

            # 检查添加者是否是超级管理员
            if self.config_manager.is_admin(user.id):
                # 添加到允许的群组
                self.config_manager.add_allowed_group(chat.id, user.id)
                self.logger.info(f"Bot 被超级管理员 {user.id} 添加到群组 {chat.id}")
                await context.bot.send_message(chat_id=chat.id,
                                               text="✅ Bot 已被授权在此群组使用。")
            else:
                self.logger.warning(f"Bot 被非超级管理员 {user.id} 添加到群组 {chat.id}")
                await context.bot.send_message(
                    chat_id=chat.id, text="⚠️ Bot 只能由超级管理员添加到群组。将自动退出。")
                # 尝试离开群组
                try:
                    await context.bot.leave_chat(chat.id)
                except Exception as e:
                    self.logger.error(f"离开群组 {chat.id} 失败: {e}")

        # 处理 Bot 被踢出群组的情况
        elif (chat_member.old_chat_member.status
              in ["member", "administrator"]
              and chat_member.new_chat_member.status in ["left", "kicked"]):
            # 从白名单移除该群组
            self.config_manager.remove_allowed_group(chat.id)
            self.logger.info(f"Bot 已从群组 {chat.id} 移除，已从白名单删除")

    async def list_allowed_groups_command(self, update: Update,
                                          context: ContextTypes.DEFAULT_TYPE):
        """列出所有允许的群组"""
        allowed_groups = self.config_manager.list_allowed_groups()

        if not allowed_groups:
            await update.message.reply_text("当前没有允许的群组。")
            return

        message = "📋 *允许使用 Bot 的群组列表:*\n\n"

        for group_id, group_info in allowed_groups.items():
            added_time = datetime.fromtimestamp(group_info.get(
                "added_at", 0)).strftime("%Y-%m-%d %H:%M:%S")
            message += f"🔹 *群组 ID:* `{group_id}`\n"
            message += f"  👤 添加者: {group_info.get('added_by', '未知')}\n"
            message += f"  ⏰ 添加时间: {added_time}\n\n"

        await self._send_markdown_message(update, message)

    async def add_allowed_group_command(self, update: Update,
                                        context: ContextTypes.DEFAULT_TYPE):
        """手动添加群组到白名单"""
        chat = update.effective_chat

        # 不带参数时，添加当前群组
        if not context.args:
            if chat.type in ["group", "supergroup"]:
                # 添加到白名单
                if self.config_manager.add_allowed_group(
                        chat.id, update.effective_user.id):
                    await update.message.reply_text(
                        f"✅ 已将当前群组 {chat.id} 添加到白名单。")
                else:
                    await update.message.reply_text(f"❌ 添加当前群组到白名单失败。")
            else:
                await update.message.reply_text("当前不在群组中。用法: /addgroup [群组 ID]"
                                                )
            return

        # 带参数时，添加指定群组
        try:
            group_id = int(context.args[0])

            # 添加到白名单
            if self.config_manager.add_allowed_group(group_id,
                                                     update.effective_user.id):
                await update.message.reply_text(f"✅ 已将群组 {group_id} 添加到白名单。")
            else:
                await update.message.reply_text(f"❌ 添加群组到白名单失败。")
        except ValueError:
            await update.message.reply_text("群组 ID 必须是数字。")
        except Exception as e:
            await update.message.reply_text(f"添加群组失败: {e}")

    async def remove_allowed_group_command(self, update: Update,
                                           context: ContextTypes.DEFAULT_TYPE):
        """从白名单移除群组并退出"""
        if not await self._check_command_args(update, context, 1,
                                              "用法: /removegroup <群组 ID>"):
            return

        try:
            group_id = int(context.args[0])
            current_chat_id = update.effective_chat.id

            # 检查是否在群组中执行此命令
            is_in_target_group = (current_chat_id == group_id)

            # 检查群组是否在白名单中
            if not self.config_manager.is_allowed_group(group_id):
                await update.message.reply_text(f"❌ 群组 {group_id} 不在白名单中。")
                return

            # 如果是在目标群组中执行命令，先发送预警
            if is_in_target_group:
                await update.message.reply_text(f"⚠️ 正在将此群组从授权列表中移除，Bot 将退出。")

            # 从白名单移除
            removed = self.config_manager.remove_allowed_group(group_id)
            if not removed:
                if not is_in_target_group:  # 只有在非目标群组中才发送失败消息
                    await update.message.reply_text(
                        f"❌ 从白名单移除群组 {group_id} 失败。")
                return

            # 如果不是在目标群组中执行命令，尝试向目标群组发送通知
            if not is_in_target_group:
                try:
                    await context.bot.send_message(
                        chat_id=group_id, text="⚠️ 此群组已从授权列表中移除，Bot 将退出。")
                except Exception as e:
                    self.logger.warning(f"向群组 {group_id} 发送退出通知失败: {e}")

            # 尝试退出群组
            try:
                await context.bot.leave_chat(group_id)
                # 记录成功退出的日志
                self.logger.info(f"Bot 已成功退出群组 {group_id}")
                # 只有在非目标群组中才发送成功退出的消息
                if not is_in_target_group:
                    await update.message.reply_text(
                        f"✅ 已将群组 {group_id} 从白名单移除并退出该群组。")
            except Exception as e:
                self.logger.error(f"退出群组 {group_id} 失败: {e}")
                # 只有在非目标群组中才发送退出失败的消息
                if not is_in_target_group:
                    await update.message.reply_text(
                        f"✅ 已将群组 {group_id} 从白名单移除，但退出群组失败: {e}")

        except ValueError:
            await update.message.reply_text("群组 ID 必须是数字。")
        except Exception as e:
            self.logger.error(f"移除群组命令处理失败: {e}", exc_info=True)
            # 只有在非目标群组中才尝试发送错误消息
            if update.effective_chat.id != group_id:
                try:
                    await update.message.reply_text(f"处理命令时发生错误: {e}")
                except Exception:
                    pass

    async def handle_all_messages(self, update: Update,
                                  context: ContextTypes.DEFAULT_TYPE):
        """处理所有消息，用于检测超级管理员在未授权群组的活动和会话状态管理"""
        if not update.message or not update.effective_chat:
            return

        chat = update.effective_chat
        user = update.effective_user
        text = update.message.text if update.message.text else ""

        # 检查用户是否在会话中
        user_id = user.id
        state = await self.session_manager.get(user_id, "state")

        # 如果用户在会话中，处理会话状态
        if state:
            # 这里可以添加会话状态处理逻辑
            # 例如调用相应的处理函数或模块
            pass

        # 只处理群组消息
        if chat.type not in ["group", "supergroup"]:
            return

        # 检查是否是超级管理员
        if self.config_manager.is_admin(user.id):
            # 检查群组是否在白名单中
            if not self.config_manager.is_allowed_group(chat.id):
                # 记录超级管理员在未授权群组的活动
                self.logger.info(f"检测到超级管理员 {user.id} 在未授权群组 {chat.id} 的活动")

    async def check_bot_groups(self):
        """启动时检查 Bot 所在的群组，确保配置正确"""
        self.logger.info("检查 Bot 所在的群组...")

        # 确保配置中存在 allowed_groups
        if "allowed_groups" not in self.config_manager.main_config:
            self.config_manager.main_config["allowed_groups"] = {}
            self.config_manager.save_main_config()
            self.logger.info("已初始化 allowed_groups 配置项")

    async def run(self):
        """启动 Bot"""
        # 检查 Bot 所在群组
        await self.check_bot_groups()

        # 并行加载已启用的模块
        await self.load_modules()

        # 启动配置文件监控任务
        self.config_watch_task = asyncio.create_task(
            self.watch_config_changes())
        self.logger.info("已启动配置文件监控任务")

        # 启动资源清理任务
        self.cleanup_task = asyncio.create_task(self.cleanup_resources())
        self.logger.info("已启动资源清理任务")

        # 启动会话管理器清理任务
        await self.session_manager.start_cleanup()

        # 启动健康监控系统
        await self.health_monitor.start_monitoring()
        self.logger.info("已启动健康监控系统")

        # 启动轮询，设置更健壮的轮询参数
        self.logger.info("启动 Bot 轮询...")

        # 初始化和启动应用
        await self.application.initialize()
        await self.application.start()

        # 配置更健壮的轮询参数
        await self.application.updater.start_polling(
            poll_interval=self.poll_interval,
            timeout=self.read_timeout,
            bootstrap_retries=5,
            drop_pending_updates=False,
            allowed_updates=None,
            error_callback=self.polling_error_callback)

        self.logger.info("Bot 已成功启动，按 Ctrl+C 或发送中断信号来停止")

    async def stop(self):
        """停止 Bot"""
        self.logger.info("正在停止 Bot...")

        # 停止健康监控系统
        if hasattr(self, 'health_monitor'):
            await self.health_monitor.stop_monitoring()
            self.logger.info("健康监控系统已停止")

        # 停止配置监视任务
        if self.config_watch_task and not self.config_watch_task.done():
            self.config_watch_task.cancel()
            try:
                await self.config_watch_task
            except asyncio.CancelledError:
                pass
            self.logger.info("配置文件监控任务已停止")

        # 停止资源清理任务
        if hasattr(self, 'cleanup_task'
                   ) and self.cleanup_task and not self.cleanup_task.done():
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
            self.logger.info("资源清理任务已停止")

        # 停止会话管理器清理任务
        if hasattr(self, 'session_manager'):
            await self.session_manager.stop_cleanup()

        # 卸载所有模块
        for module_name in list(self.module_loader.loaded_modules.keys()):
            await self.unload_single_module(module_name)

        # 正确顺序停止 Telegram 应用
        try:
            # 首先检查 updater 是否在运行
            if hasattr(self.application,
                       'updater') and self.application.updater and getattr(
                           self.application.updater, 'running', False):
                await self.application.updater.stop()

            # 然后检查应用是否在运行
            try:
                await self.application.stop()
            except RuntimeError as e:
                # 忽略 "Application is not running" 错误
                if "not running" not in str(e).lower():
                    raise

            # 最后关闭应用
            try:
                await self.application.shutdown()
            except Exception as e:
                self.logger.warning(f"关闭应用时出现警告: {e}")

            self.logger.info("Bot 已成功停止")
        except Exception as e:
            self.logger.error(f"停止 Bot 时发生错误: {e}", exc_info=True)
            # 即使出错，也尝试继续关闭
            self.logger.info("尝试强制关闭 Bot")
