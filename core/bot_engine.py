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
        log_level = self.config_manager.main_config.get("log_level", "INFO")
        BotEngine.global_log_level = getattr(logging, log_level.upper(),
                                             logging.INFO)
        self.logger = setup_logger("BotEngine", log_level)

        # 降低网络错误的日志级别
        logging.getLogger("telegram.request").setLevel(logging.WARNING)
        logging.getLogger("httpx").setLevel(logging.WARNING)

        # 如果提供了 token，更新配置
        if token:
            self.config_manager.set_token(token)
            self.logger.debug("已通过命令行更新 Bot Token")

        # 获取 Token
        self.token = self.config_manager.get_token()
        if not self.token:
            raise ValueError("Bot Token 未设置或无效")

        # 检查管理员 ID
        admin_ids = self.config_manager.get_valid_admin_ids()
        if not admin_ids:
            self.logger.warning("未设置有效的管理员 ID")

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

        self.logger.debug("Bot 引擎已创建")

    async def initialize(self):
        """初始化机器人组件"""
        self.logger.info("正在初始化机器人组件...")

        # 获取网络设置
        network_config = self.config_manager.main_config.get("network", {})
        self.connect_timeout = network_config.get("connect_timeout", 20.0)
        self.read_timeout = network_config.get("read_timeout", 20.0)
        self.write_timeout = network_config.get("write_timeout", 20.0)
        self.poll_interval = network_config.get("poll_interval", 1.0)

        # 初始化 Telegram Application
        builder = Application.builder().token(self.token)

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
        self.module_manager = ModuleManager(
            self.application, self.config_manager, self.command_manager,
            self.event_system, self.state_manager, self.session_manager)
        self.application.bot_data["module_manager"] = self.module_manager

        # 注册群组成员变更处理器
        from telegram.ext import ChatMemberHandler
        self.application.add_handler(
            ChatMemberHandler(self._handle_my_chat_member,
                              ChatMemberHandler.MY_CHAT_MEMBER))

        # 注册群组管理回调处理器（使用 command_manager 的权限检查）
        await self.command_manager.register_callback_handler(
            "core",
            self._handle_select_remove_group_callback,
            pattern=r"^select_remove_group$",
            admin_level="super_admin")
        await self.command_manager.register_callback_handler(
            "core",
            self._handle_remove_group_callback,
            pattern=r"^remove_group_-?\d+$",
            admin_level="super_admin")
        await self.command_manager.register_callback_handler(
            "core",
            self._handle_confirm_remove_group_callback,
            pattern=r"^confirm_remove_group_-?\d+$",
            admin_level="super_admin")
        await self.command_manager.register_callback_handler(
            "core",
            self._handle_cancel_remove_group_callback,
            pattern=r"^cancel_remove_group$",
            admin_level="super_admin")
        # 注册授权群组回调处理器
        await self.command_manager.register_callback_handler(
            "core",
            self._handle_auth_group_callback,
            pattern=r"^auth_group_-?\d+$",
            admin_level="super_admin")

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

        # 启动配置文件监控任务
        config_watch_task = asyncio.create_task(self.watch_config_changes())
        self.tasks.append(config_watch_task)
        self.logger.debug("已启动主配置文件监控")

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

        # 检查错误类型，如果是 Forbidden 错误（例如机器人被踢出群组），则只记录日志
        if isinstance(context.error, telegram.error.Forbidden):
            self.logger.warning(f"权限错误: {context.error}")
            return

        # 尝试发送错误消息
        if update and hasattr(
                update, 'effective_message') and update.effective_message:
            try:
                await update.effective_message.reply_text("处理时发生错误，请查看日志获取详情")
            except Exception as e:
                self.logger.warning(f"无法发送错误消息: {e}")

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

                self.logger.debug("开始执行资源清理...")
                start_time = time.time()

                # 执行垃圾回收
                collected = gc.collect()
                self.logger.debug(f"垃圾回收完成，回收了 {collected} 个对象")

                # 更新统计信息
                self.stats["last_cleanup"] = time.time()

                elapsed = time.time() - start_time
                self.logger.debug(f"资源清理完成，耗时 {elapsed:.2f} 秒")

        except asyncio.CancelledError:
            self.logger.debug("资源清理任务已取消")
            raise

    async def watch_config_changes(self):
        """监控配置文件变化"""
        config_dir = self.config_manager.config_dir
        main_config_path = os.path.join(config_dir, "config.json")

        # 初始化文件最后修改时间
        last_mtime = os.path.getmtime(main_config_path) if os.path.exists(
            main_config_path) else 0

        check_interval = 5  # 5 秒检查一次

        try:
            while True:
                try:
                    # 检查配置文件
                    if not os.path.exists(main_config_path):
                        await asyncio.sleep(check_interval)
                        continue

                    current_mtime = os.path.getmtime(main_config_path)
                    if current_mtime > last_mtime:
                        self.logger.info(f"检测到配置文件变化: {main_config_path}")
                        last_mtime = current_mtime

                        # 适当延迟，确保文件写入完成
                        await asyncio.sleep(0.5)

                        # 重新加载配置
                        self.config_manager.reload_main_config()

                    await asyncio.sleep(check_interval)

                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    self.logger.error(f"监控配置文件时出错: {e}", exc_info=True)
                    await asyncio.sleep(check_interval)

        except asyncio.CancelledError:
            self.logger.debug("配置文件监控任务已取消")
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

            # 获取群组名称
            group_name = chat.title

            # 检查添加者是否是超级管理员
            if self.config_manager.is_admin(user.id):
                # 添加到允许的群组
                self.config_manager.add_allowed_group(chat.id, user.id,
                                                      group_name)
                self.logger.info(
                    f"Bot 被超级管理员 {user.id} 添加到群组 {chat.id} ({group_name})")
                await context.bot.send_message(chat_id=chat.id,
                                               text="✅ Bot 已被授权在此群组使用")
            # 检查群组是否已在白名单中
            elif self.config_manager.is_allowed_group(chat.id):
                self.logger.debug(
                    f"Bot 被用户 {user.id} 添加到已授权群组 {chat.id} ({group_name})")
                await context.bot.send_message(chat_id=chat.id,
                                               text="✅ Bot 已被授权在此群组使用")
            else:
                self.logger.info(
                    f"Bot 被用户 {user.id} 添加到未授权群组 {chat.id} ({group_name})")

                # 通知所有超级管理员
                admin_ids = self.config_manager.get_valid_admin_ids()
                for admin_id in admin_ids:
                    try:
                        # 创建授权按钮
                        keyboard = [[
                            telegram.InlineKeyboardButton(
                                "◯ Authorize Group",
                                callback_data=f"auth_group_{chat.id}")
                        ]]
                        reply_markup = telegram.InlineKeyboardMarkup(keyboard)

                        await context.bot.send_message(
                            chat_id=admin_id,
                            text=f"⚠️ Bot 被用户 {user.id} 添加到未授权群组:\n"
                            f"群组 ID: {chat.id}\n"
                            f"群组名称: {group_name}\n\n"
                            f"您可以点击下方按钮授权或使用命令:\n"
                            f"/addgroup {chat.id}",
                            reply_markup=reply_markup)
                    except Exception as e:
                        self.logger.error(f"向管理员 {admin_id} 发送通知失败: {e}")

                # 通知群组
                await context.bot.send_message(
                    chat_id=chat.id, text="⚠️ 已通知管理员授权此群组\n\n10 秒内未获授权将自动退出")

                # 创建延时退出任务
                asyncio.create_task(
                    self._delayed_leave_chat(context.bot, chat.id, 10))

        # 处理 Bot 被踢出群组的情况
        elif (chat_member.old_chat_member.status
              in ["member", "administrator"]
              and chat_member.new_chat_member.status in ["left", "kicked"]):
            # 从白名单移除该群组
            self.config_manager.remove_allowed_group(chat.id)
            self.logger.debug(f"Bot 已从群组 {chat.id} 移除，已从白名单删除")

    async def _list_allowed_groups_command(self, update, context):
        """列出所有允许的群组"""
        # 检查是否是回调查询
        is_callback = update.callback_query is not None

        # 获取消息对象或回调查询对象
        if is_callback:
            query = update.callback_query
            # 如果是回调查询，我们将编辑现有消息而不是发送新消息
            self.logger.debug("通过回调查询显示群组列表")
        else:
            # 获取消息对象（可能是新消息或编辑的消息）
            message_obj = update.message or update.edited_message
            if not message_obj:
                self.logger.error("无法获取消息对象")
                return
            self.logger.debug("通过命令显示群组列表")

        allowed_groups = self.config_manager.list_allowed_groups()

        if not allowed_groups:
            if is_callback:
                await query.edit_message_text("当前没有授权的群组")
            else:
                await message_obj.reply_text("当前没有授权的群组")
            return

        groups_message = "📋 已授权使用 Bot 的群组列表:\n\n"

        # 创建按钮列表
        keyboard = []

        # 为所有群组添加编号
        for i, (group_id, group_info) in enumerate(allowed_groups.items(), 1):
            added_time = datetime.fromtimestamp(group_info.get(
                "added_at", 0)).strftime("%Y-%m-%d")

            # 获取存储的群组名称
            stored_group_name = group_info.get("group_name", "")

            # 尝试获取最新的群组信息
            group_name = stored_group_name
            try:
                # 尝试从 Telegram 获取最新的群组信息
                chat = await context.bot.get_chat(int(group_id))
                if chat and chat.title:
                    group_name = chat.title
                    # 如果群组名称已更改，更新配置
                    if stored_group_name != group_name:
                        self.logger.debug(
                            f"更新群组 {group_id} 的名称: {stored_group_name} -> {group_name}"
                        )
                        self.config_manager.update_group_name(
                            int(group_id), group_name)
            except Exception as e:
                self.logger.debug(f"获取群组 {group_id} 的最新信息失败: {e}")
                # 如果获取失败，使用存储的名称或空字符串

            groups_message += f"{i}. 群组 ID: {group_id}\n"
            if group_name:
                groups_message += f"   📝 群组名称: {group_name}\n"
            groups_message += f"   👤 添加者: `{group_info.get('added_by', '未知')}`\n"
            groups_message += f"   ⏰ 添加时间: {added_time}\n\n"

        # 添加一个移除按钮
        if allowed_groups:
            keyboard.append([
                telegram.InlineKeyboardButton(
                    "Remove Group", callback_data="select_remove_group")
            ])

        reply_markup = telegram.InlineKeyboardMarkup(keyboard)

        try:
            if is_callback:
                # 编辑现有消息
                await query.edit_message_text(groups_message,
                                              reply_markup=reply_markup,
                                              disable_web_page_preview=True,
                                              parse_mode="MARKDOWN")
            else:
                # 发送新消息
                await message_obj.reply_text(groups_message,
                                             reply_markup=reply_markup,
                                             disable_web_page_preview=True,
                                             parse_mode="MARKDOWN")
        except Exception as e:
            self.logger.error(f"发送群组列表失败: {e}")
            # 如果发送失败，尝试发送错误消息
            if is_callback:
                try:
                    await query.answer("发送群组列表失败")
                except Exception:
                    pass
            else:
                try:
                    await message_obj.reply_text("发送群组列表失败")
                except Exception:
                    pass

    async def _handle_remove_group_callback(self, update, context):
        """处理移除群组的回调查询"""
        query = update.callback_query

        # 解析回调数据
        try:
            # 从 "remove_group_123456" 格式中提取群组 ID
            prefix = "remove_group_"
            if query.data.startswith(prefix):
                group_id = int(query.data[len(prefix):])
            else:
                await query.answer("❌ 无效的回调数据格式")
                return
        except (ValueError, IndexError):
            await query.answer("❌ 无效的回调数据")
            return

        # 检查群组是否在白名单中
        if not self.config_manager.is_allowed_group(group_id):
            await query.answer("❌ 群组不在白名单中")
            return

        # 获取群组信息
        allowed_groups = self.config_manager.list_allowed_groups()
        group_info = allowed_groups.get(str(group_id), {})
        group_name = group_info.get("group_name", str(group_id))

        # 构建确认消息
        confirm_text = f"确定要移除以下群组吗？\n\n"
        confirm_text += f"🔹 群组 ID: {group_id}\n"
        if group_name and group_name != str(group_id):
            confirm_text += f"📝 群组名称: {group_name}\n"

        # 创建确认按钮
        keyboard = [[
            telegram.InlineKeyboardButton(
                "◯ Confirm", callback_data=f"confirm_remove_group_{group_id}"),
            telegram.InlineKeyboardButton("⨉ Cancel",
                                          callback_data="cancel_remove_group")
        ]]
        reply_markup = telegram.InlineKeyboardMarkup(keyboard)

        # 回应回调查询
        await query.answer()

        # 编辑消息
        await query.edit_message_text(confirm_text, reply_markup=reply_markup)

    async def _handle_confirm_remove_group_callback(self, update, context):
        """处理确认移除群组的回调查询"""
        query = update.callback_query

        # 解析回调数据
        try:
            # 从 "confirm_remove_group_123456" 格式中提取群组 ID
            prefix = "confirm_remove_group_"
            if query.data.startswith(prefix):
                group_id = int(query.data[len(prefix):])
            else:
                await query.answer("❌ 无效的回调数据格式")
                return
        except (ValueError, IndexError):
            await query.answer("❌ 无效的回调数据")
            return

        # 检查群组是否在白名单中
        if not self.config_manager.is_allowed_group(group_id):
            await query.answer("❌ 群组不在白名单中")
            await self._list_allowed_groups_command(update, context)
            return

        # 从白名单移除
        removed = self.config_manager.remove_allowed_group(group_id)
        if not removed:
            await query.answer("❌ 从白名单移除群组失败")
            return

        # 尝试向目标群组发送通知
        try:
            await context.bot.send_message(chat_id=group_id,
                                           text="⚠️ 此群组已从授权列表中移除，Bot 将自动退出")
        except Exception as e:
            self.logger.warning(f"向群组 {group_id} 发送退出通知失败: {e}")

        # 尝试退出群组
        try:
            await context.bot.leave_chat(group_id)
            self.logger.debug(f"Bot 已成功退出群组 {group_id}")
        except Exception as e:
            self.logger.error(f"退出群组 {group_id} 失败: {e}")

        # 回应回调查询
        await query.answer("✅ 已成功移除群组")

        # 更新群组列表
        try:
            await self._list_allowed_groups_command(update, context)
        except Exception:
            await query.edit_message_text("更新群组列表失败，请重新执行 /listgroups")

    async def _handle_cancel_remove_group_callback(self, update, context):
        """处理取消移除群组的回调查询"""
        query = update.callback_query

        # 回应回调查询
        await query.answer("已取消操作")

        # 返回群组列表
        try:
            await self._list_allowed_groups_command(update, context)
        except Exception:
            await query.edit_message_text("返回群组列表失败，请重新执行 /listgroups")

    async def _delayed_leave_chat(self, bot, chat_id, delay_seconds):
        """延时检查并离开未授权的群组"""
        try:
            # 等待指定的时间
            await asyncio.sleep(delay_seconds)

            # 检查群组是否已被授权
            if not self.config_manager.is_allowed_group(chat_id):
                self.logger.debug(
                    f"群组 {chat_id} 在 {delay_seconds} 秒内未获得授权，Bot 将自动退出")

                # 尝试离开群组
                try:
                    await bot.leave_chat(chat_id)
                    self.logger.debug(f"Bot 已成功退出未授权群组 {chat_id}")
                except Exception as e:
                    self.logger.error(f"离开群组 {chat_id} 失败: {e}")
            else:
                self.logger.debug(f"群组 {chat_id} 已获得授权，Bot 将继续留在群组中")
        except Exception as e:
            self.logger.error(f"延时退出任务出错: {e}")

    async def _handle_auth_group_callback(self, update, context):
        """处理授权群组的回调查询"""
        query = update.callback_query
        user_id = update.effective_user.id

        # 解析回调数据
        try:
            # 从 "auth_group_123456" 格式中提取群组 ID
            prefix = "auth_group_"
            if query.data.startswith(prefix):
                group_id = int(query.data[len(prefix):])
            else:
                await query.answer("❌ 无效的回调数据格式")
                return
        except (ValueError, IndexError):
            await query.answer("❌ 无效的回调数据")
            return

        # 检查群组是否已在白名单中
        if self.config_manager.is_allowed_group(group_id):
            await query.answer("✅ 此群组已在授权列表中")
            return

        # 尝试获取群组信息
        try:
            chat = await context.bot.get_chat(group_id)
            group_name = chat.title
        except Exception as e:
            self.logger.error(f"获取群组 {group_id} 信息失败: {e}")
            group_name = str(group_id)  # 如果无法获取名称，使用ID作为名称

        # 添加到白名单
        if self.config_manager.add_allowed_group(group_id, user_id,
                                                 group_name):
            self.logger.debug(f"管理员 {user_id} 已授权群组 {group_id} ({group_name})")

            # 回应回调查询
            await query.answer("✅ 已成功授权群组")
            await query.edit_message_text(f"✅ 已成功授权群组:\n"
                                          f"群组 ID: {group_id}\n"
                                          f"群组名称: {group_name}")
        else:
            await query.answer("❌ 授权群组失败")
            self.logger.error(f"授权群组 {group_id} 失败")

    async def _handle_select_remove_group_callback(self, update, context):
        """处理选择移除群组的回调查询"""
        query = update.callback_query

        # 获取所有允许的群组
        allowed_groups = self.config_manager.list_allowed_groups()

        if not allowed_groups:
            await query.answer("当前没有授权的群组")
            return

        # 构建选择消息
        select_text = "请选择要移除的群组:\n\n"

        # 创建按钮列表
        keyboard = []

        # 为所有群组添加编号和按钮
        for i, (group_id, group_info) in enumerate(allowed_groups.items(), 1):
            # 获取存储的群组名称
            group_name = group_info.get("group_name", "")

            # 按钮文本
            button_text = f"{i}. {group_name}" if group_name else f"{i}. {group_id}"
            # 如果按钮文本太长，截断它
            if len(button_text) > 30:
                button_text = button_text[:27] + "..."

            keyboard.append([
                telegram.InlineKeyboardButton(
                    button_text, callback_data=f"remove_group_{group_id}")
            ])

        # 添加取消按钮
        keyboard.append([
            telegram.InlineKeyboardButton("⨉ Cancel",
                                          callback_data="cancel_remove_group")
        ])

        reply_markup = telegram.InlineKeyboardMarkup(keyboard)

        # 回应回调查询
        await query.answer()

        # 编辑消息
        await query.edit_message_text(select_text, reply_markup=reply_markup)

    async def _add_allowed_group_command(self, update, context):
        """手动添加群组到白名单"""
        # 获取消息对象（可能是新消息或编辑的消息）
        message_obj = update.message or update.edited_message

        chat = update.effective_chat
        user_id = update.effective_user.id

        self.logger.debug(
            f"用户 {user_id} 执行 /addgroup 命令，聊天类型: {chat.type}, 聊天 ID: {chat.id}"
        )

        # 不带参数时，添加当前群组
        if not context.args:
            if chat.type in ["group", "supergroup"]:
                # 获取群组名称
                group_name = chat.title

                # 添加到白名单
                self.logger.debug(f"尝试添加当前群组 {chat.id} 到白名单")
                if self.config_manager.add_allowed_group(
                        chat.id, user_id, group_name):
                    await message_obj.reply_text(f"✅ 已将当前群组 {chat.id} 添加到白名单")
                    self.logger.debug(f"成功添加群组 {chat.id} ({group_name}) 到白名单")
                else:
                    await message_obj.reply_text(f"❌ 添加当前群组到白名单失败")
                    self.logger.error(f"添加群组 {chat.id} 到白名单失败")
            else:
                await message_obj.reply_text(
                    "⚠️ 当前不在群组中\n用法: /addgroup [群组 ID]")
            return

        # 带参数时，添加指定群组
        try:
            group_id = int(context.args[0])
            self.logger.debug(f"尝试添加群组 {group_id} 到白名单")

            # 添加到白名单
            if self.config_manager.add_allowed_group(group_id, user_id):
                await message_obj.reply_text(f"✅ 已将群组 {group_id} 添加到白名单")
                self.logger.debug(f"成功添加群组 {group_id} 到白名单")
            else:
                await message_obj.reply_text(f"❌ 添加群组到白名单失败")
                self.logger.error(f"添加群组 {group_id} 到白名单失败")
        except ValueError:
            await message_obj.reply_text("群组 ID 必须是数字")
        except Exception as e:
            self.logger.error(f"添加群组失败: {e}", exc_info=True)
            await message_obj.reply_text(f"添加群组失败: {e}")
