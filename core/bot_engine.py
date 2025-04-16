# core/bot_engine.py - 机器人核心引擎

import asyncio
import logging
import os
import time
from datetime import datetime
import gc
import telegram
from telegram.ext import Application

from core.config_manager import ConfigManager
from core.module_manager import ModuleManager
from core.command_manager import CommandManager
from core.event_system import EventSystem
from utils.logger import setup_logger
from utils.session_manager import SessionManager
from utils.state_manager import StateManager


class BotEngine:
    """Bot 引擎，负责协调各组件的工作"""

    def __init__(self, config_dir="config", token=None):
        # 初始化配置管理器
        self.config_manager = ConfigManager(config_dir)

        # 设置日志
        self.logger = setup_logger(
            "BotEngine",
            self.config_manager.main_config.get("log_level", "INFO"))

        # 降低网络错误的日志级别
        logging.getLogger("telegram.request").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)

        # 如果提供了 token，更新配置
        if token:
            self.config_manager.set_token(token)
            self.logger.info("已通过命令行更新 Bot Token")

        # 获取 Token
        self.token = self.config_manager.get_token()
        if not self.token:
            raise ValueError("Bot Token 未设置或无效")

        # 检查管理员 ID
        admin_ids = self.config_manager.get_valid_admin_ids()
        if not admin_ids:
            self.logger.warning("未设置有效的管理员 ID，只有机器人本身能执行管理操作")

        # 初始化组件
        self.application = None
        self.module_manager = None
        self.command_manager = None
        self.event_system = None
        self.session_manager = None
        self.state_manager = None

        # 任务跟踪
        self.tasks = []

        # 初始化统计数据
        self.stats = {
            "start_time": time.time(),
            "last_cleanup": 0,
            "module_stats": {}
        }

        self.logger.info("Bot 引擎已创建")

    async def initialize(self):
        """初始化机器人组件"""
        self.logger.info("正在初始化机器人组件...")

        # 获取网络设置
        network_config = self.config_manager.main_config.get("network", {})
        self.connect_timeout = network_config.get("connect_timeout", 20.0)
        self.read_timeout = network_config.get("read_timeout", 20.0)
        self.write_timeout = network_config.get("write_timeout", 20.0)
        self.poll_interval = network_config.get("poll_interval", 1.0)

        # 检查是否配置了代理
        self.proxy_url = self.config_manager.main_config.get("proxy_url", None)

        # 初始化 Telegram Application
        builder = Application.builder().token(self.token)

        # 如果配置了代理，应用代理设置
        if self.proxy_url:
            self.logger.info(f"使用代理: {self.proxy_url}")
            builder = builder.proxy_url(self.proxy_url)

        self.application = builder.build()

        # 将 bot_engine 和 config_manager 添加到 bot_data 中
        self.application.bot_data["bot_engine"] = self
        self.application.bot_data["config_manager"] = self.config_manager

        # 初始化事件系统
        self.event_system = EventSystem()
        self.application.bot_data["event_system"] = self.event_system

        # 初始化会话管理器
        self.session_manager = SessionManager()
        self.application.bot_data["session_manager"] = self.session_manager

        # 初始化状态管理器
        self.state_manager = StateManager()
        self.application.bot_data["state_manager"] = self.state_manager

        # 初始化命令管理器
        self.command_manager = CommandManager(self.application,
                                              self.config_manager)
        self.application.bot_data["command_manager"] = self.command_manager

        # 初始化模块管理器
        self.module_manager = ModuleManager(self.application,
                                            self.config_manager,
                                            self.command_manager,
                                            self.event_system,
                                            self.state_manager)
        self.application.bot_data["module_manager"] = self.module_manager

        # 注册错误处理器
        self.application.add_error_handler(self.handle_error)

        self.logger.info("机器人组件初始化完成")

    async def start(self):
        """启动机器人"""
        self.logger.info("正在启动机器人...")

        # 初始化应用
        await self.application.initialize()

        # 注册核心命令
        await self.command_manager.register_core_commands(self)

        # 启动机器人
        await self.application.start()

        # 启动轮询
        await self.application.updater.start_polling(
            poll_interval=self.poll_interval,
            timeout=self.read_timeout,
            bootstrap_retries=5,
            drop_pending_updates=False,
            allowed_updates=None,
            error_callback=self.polling_error_callback)

        # 加载模块
        await self.module_manager.load_enabled_modules()

        # 启动会话清理
        await self.session_manager.start_cleanup()

        # 启动定期清理任务
        cleanup_task = asyncio.create_task(self.periodic_cleanup())
        self.tasks.append(cleanup_task)

        # 启动配置监视
        config_watch_task = asyncio.create_task(self.watch_config_changes())
        self.tasks.append(config_watch_task)

        self.logger.info("机器人已成功启动")

    async def stop(self):
        """停止机器人"""
        self.logger.info("正在停止机器人...")

        # 取消所有任务
        for task in self.tasks:
            if not task.done():
                task.cancel()

        # 等待任务取消完成
        if self.tasks:
            await asyncio.gather(*self.tasks, return_exceptions=True)

        # 停止会话清理
        if self.session_manager:
            await self.session_manager.stop_cleanup()

        # 卸载所有模块
        if self.module_manager:
            await self.module_manager.unload_all_modules()

        # 停止轮询
        if hasattr(self.application, 'updater') and self.application.updater:
            await self.application.updater.stop()

        # 停止应用
        if self.application:
            try:
                await self.application.stop()
                await self.application.shutdown()
            except Exception as e:
                self.logger.error(f"停止应用时出错: {e}")

        self.logger.info("机器人已停止")

    async def handle_error(self, update, context):
        """全局错误处理器"""
        self.logger.error("处理更新时发生异常:", exc_info=context.error)

        # 尝试发送错误消息
        if update and hasattr(
                update, 'effective_message') and update.effective_message:
            await update.effective_message.reply_text("处理命令时发生错误，请查看日志获取详情。")

    def polling_error_callback(self, error):
        """轮询错误回调"""
        if isinstance(error, telegram.error.NetworkError):
            self.logger.warning(f"网络连接暂时中断: {error}，将自动重试")
        else:
            self.logger.error(f"轮询时发生错误: {error}", exc_info=True)

    async def periodic_cleanup(self, interval=3600):
        """定期清理资源"""
        try:
            while True:
                await asyncio.sleep(interval)

                self.logger.info("开始执行资源清理...")
                start_time = time.time()

                # 执行垃圾回收
                collected = gc.collect()
                self.logger.debug(f"垃圾回收完成，回收了 {collected} 个对象")

                # 清理未使用的模块
                unused_count = await self.module_manager.cleanup_unused_modules(
                )
                if unused_count > 0:
                    self.logger.info(f"已清理 {unused_count} 个未使用的模块")

                # 更新统计信息
                self.stats["last_cleanup"] = time.time()

                elapsed = time.time() - start_time
                self.logger.info(f"资源清理完成，耗时 {elapsed:.2f} 秒")

        except asyncio.CancelledError:
            self.logger.info("资源清理任务已取消")
            raise

    async def watch_config_changes(self):
        """监控配置文件变化"""
        config_dir = self.config_manager.config_dir
        main_config_path = os.path.join(config_dir, "config.json")
        modules_config_path = os.path.join(config_dir, "modules.json")

        # 初始化文件最后修改时间
        last_mtimes = {
            main_config_path:
            os.path.getmtime(main_config_path)
            if os.path.exists(main_config_path) else 0,
            modules_config_path:
            os.path.getmtime(modules_config_path)
            if os.path.exists(modules_config_path) else 0
        }

        check_interval = 5  # 5 秒检查一次

        try:
            while True:
                try:
                    # 检查配置文件
                    for path in [main_config_path, modules_config_path]:
                        if not os.path.exists(path):
                            continue

                        current_mtime = os.path.getmtime(path)
                        if current_mtime > last_mtimes[path]:
                            self.logger.info(f"检测到配置文件变化: {path}")
                            last_mtimes[path] = current_mtime

                            # 适当延迟，确保文件写入完成
                            await asyncio.sleep(0.5)

                            # 重新加载配置
                            if path == main_config_path:
                                self.config_manager.reload_main_config()
                            else:
                                old_modules = set(
                                    self.config_manager.get_enabled_modules())
                                self.config_manager.reload_modules_config()
                                new_modules = set(
                                    self.config_manager.get_enabled_modules())

                                # 处理新启用的模块
                                for module_name in new_modules - old_modules:
                                    self.logger.info(
                                        f"检测到新启用的模块: {module_name}")
                                    await self.module_manager.load_and_enable_module(
                                        module_name)

                                # 处理新禁用的模块
                                for module_name in old_modules - new_modules:
                                    self.logger.info(
                                        f"检测到模块已禁用: {module_name}")
                                    await self.module_manager.disable_and_unload_module(
                                        module_name)

                    await asyncio.sleep(check_interval)

                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.logger.error(f"监控配置文件时出错: {e}", exc_info=True)
                    await asyncio.sleep(check_interval)

        except asyncio.CancelledError:
            self.logger.info("配置文件监控任务已取消")
            raise
