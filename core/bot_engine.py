# core/bot_engine.py - 机器人核心引擎

import asyncio
import logging
import os
import time
import gc
import telegram
from datetime import datetime
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

        # 注册群组成员变更处理器
        from telegram.ext import ChatMemberHandler
        self.application.add_handler(
            ChatMemberHandler(self._handle_my_chat_member,
                              ChatMemberHandler.MY_CHAT_MEMBER))

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
        await self.module_manager.start()

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
            await self.module_manager.stop()

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

    async def _handle_my_chat_member(self, update, context):
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

    async def _list_allowed_groups_command(self, update, context):
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

        try:
            await update.message.reply_text(message, parse_mode="MARKDOWN")
        except Exception:
            # 如果 Markdown 解析失败，发送纯文本
            from utils.formatter import TextFormatter
            await update.message.reply_text(
                TextFormatter.markdown_to_plain(message))

    async def _add_allowed_group_command(self, update, context):
        """手动添加群组到白名单"""
        chat = update.effective_chat
        user_id = update.effective_user.id

        self.logger.info(
            f"用户 {user_id} 执行 /addgroup 命令，聊天类型: {chat.type}, 聊天 ID: {chat.id}"
        )

        # 不带参数时，添加当前群组
        if not context.args:
            if chat.type in ["group", "supergroup"]:
                # 添加到白名单
                self.logger.info(f"尝试添加当前群组 {chat.id} 到白名单")
                if self.config_manager.add_allowed_group(chat.id, user_id):
                    await update.message.reply_text(
                        f"✅ 已将当前群组 {chat.id} 添加到白名单。")
                    self.logger.info(f"成功添加群组 {chat.id} 到白名单")
                else:
                    await update.message.reply_text(f"❌ 添加当前群组到白名单失败。")
                    self.logger.error(f"添加群组 {chat.id} 到白名单失败")
            else:
                await update.message.reply_text("当前不在群组中。用法: /addgroup [群组 ID]"
                                                )
            return

        # 带参数时，添加指定群组
        try:
            group_id = int(context.args[0])
            self.logger.info(f"尝试添加群组 {group_id} 到白名单")

            # 添加到白名单
            if self.config_manager.add_allowed_group(group_id, user_id):
                await update.message.reply_text(f"✅ 已将群组 {group_id} 添加到白名单。")
                self.logger.info(f"成功添加群组 {group_id} 到白名单")
            else:
                await update.message.reply_text(f"❌ 添加群组到白名单失败。")
                self.logger.error(f"添加群组 {group_id} 到白名单失败")
        except ValueError:
            await update.message.reply_text("群组 ID 必须是数字。")
        except Exception as e:
            self.logger.error(f"添加群组失败: {e}", exc_info=True)
            await update.message.reply_text(f"添加群组失败: {e}")

    async def _remove_allowed_group_command(self, update, context):
        """从白名单移除群组并退出"""
        if not context.args or len(context.args) != 1:
            await update.message.reply_text("用法: /removegroup <群组 ID>")
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
