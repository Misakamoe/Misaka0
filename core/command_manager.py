# core/command_manager.py - 命令管理器

import asyncio
import difflib
import time
import telegram
from datetime import datetime
from telegram.ext import CommandHandler, MessageHandler, filters, CallbackQueryHandler
from utils.logger import setup_logger
from utils.formatter import TextFormatter
from utils.pagination import PaginationHelper


class CommandManager:
    """命令管理器，处理命令注册、权限检查和执行"""

    def __init__(self, application, config_manager):
        self.application = application
        self.config_manager = config_manager
        self.logger = setup_logger("CommandManager")

        # 命令注册信息
        self.commands = {
        }  # 命令名 -> {module, callback, admin_level, description}
        self.module_commands = {}  # 模块名 -> [命令名列表]

        # 锁
        self.command_lock = asyncio.Lock()

        # 暂时存储 start 贴纸的 Telegram 文件 ID
        self.start_sticker_id = None

        # 添加未知命令处理器
        self.application.add_handler(
            MessageHandler(
                filters.COMMAND & ~filters.UpdateType.EDITED_MESSAGE,
                self._handle_unknown_command),
            group=999  # 低优先级，最后处理
        )

        # 添加分页命令的回调处理
        self.application.add_handler(
            CallbackQueryHandler(
                self._handle_command_page_callback,
                pattern=
                r"^(mod_page|cmd_page):(select|\d+|goto_\d+):\d+$|^noop$"))

    async def register_core_commands(self, bot_engine):
        """注册核心命令"""
        # 注册核心命令
        core_commands = [
            {
                "name": "start",
                "callback": self._start_command,
                "admin_level": False,
                "description": "启动机器人"
            },
            {
                "name": "help",
                "callback": self._help_command,
                "admin_level": False,
                "description": "显示帮助信息"
            },
            {
                "name": "id",
                "callback": self._id_command,
                "admin_level": False,
                "description": "显示用户和聊天 ID"
            },
            {
                "name": "modules",
                "callback": self._list_modules_command,
                "admin_level": False,
                "description": "列出可用模块"
            },
            {
                "name": "commands",
                "callback": self._list_commands_command,
                "admin_level": False,
                "description": "列出可用命令"
            },
            {
                "name": "stats",
                "callback": self._stats_command,
                "admin_level": "super_admin",
                "description": "显示机器人统计信息"
            },
            {
                "name": "cancel",
                "callback": self._cancel_command,
                "admin_level": False,
                "description": "取消当前操作"
            },
            # 添加群组管理命令
            {
                "name": "listgroups",
                "callback": bot_engine._list_allowed_groups_command,
                "admin_level": "super_admin",
                "description": "列出允许的群组"
            },
            {
                "name": "addgroup",
                "callback": bot_engine._add_allowed_group_command,
                "admin_level": "super_admin",
                "description": "添加群组到白名单"
            }
        ]

        # 注册命令
        for cmd in core_commands:
            await self.register_command("core", cmd["name"], cmd["callback"],
                                        cmd["admin_level"], cmd["description"])

    async def register_command(self,
                               module_name,
                               command_name,
                               callback,
                               admin_level=False,
                               description=""):
        """注册命令

        Args:
            module_name: 模块名称
            command_name: 命令名称
            callback: 回调函数
            admin_level: 管理权限要求 (False, "group_admin", "super_admin")
            description: 命令描述

        Returns:
            bool: 是否成功注册
        """
        async with self.command_lock:
            # 检查命令是否已注册
            if command_name in self.commands:
                existing = self.commands[command_name]
                self.logger.warning(
                    f"命令 /{command_name} 已被模块 {existing['module']} 注册，"
                    f"将被模块 {module_name} 覆盖")

                # 移除旧的处理器
                await self.unregister_command(command_name)

            # 保存命令信息
            self.commands[command_name] = {
                "module": module_name,
                "callback": callback,
                "admin_level": admin_level,
                "description": description
            }

            # 更新模块命令映射
            if module_name not in self.module_commands:
                self.module_commands[module_name] = []
            if command_name not in self.module_commands[module_name]:
                self.module_commands[module_name].append(command_name)

            # 创建处理器，允许处理编辑后的消息
            handler = CommandHandler(command_name,
                                     self._create_command_wrapper(
                                         command_name, callback, admin_level,
                                         module_name),
                                     filters=filters.UpdateType.MESSAGES
                                     | filters.UpdateType.EDITED_MESSAGE)

            # 添加到应用
            self.application.add_handler(handler)

            return True

    async def register_module_command(self,
                                      module_name,
                                      command_name,
                                      callback,
                                      admin_level=False,
                                      description=""):
        """注册模块命令（别名）

        Args:
            module_name: 模块名称
            command_name: 命令名称
            callback: 回调函数
            admin_level: 管理权限要求
            description: 命令描述

        Returns:
            bool: 是否成功注册
        """
        return await self.register_command(module_name, command_name, callback,
                                           admin_level, description)

    async def register_callback_handler(self,
                                        module_name,
                                        callback,
                                        pattern=None,
                                        admin_level=False,
                                        group=0):
        """注册带权限验证的回调查询处理器

        Args:
            module_name: 模块名称
            callback: 回调函数
            pattern: 回调数据匹配模式
            admin_level: 管理权限要求 (False, "group_admin", "super_admin")
            group: 处理器组

        Returns:
            bool: 是否成功注册
        """

        # 创建权限包装器
        async def permission_wrapper(update, context):
            try:
                # 检查命令是否来自有效群组
                if not await self._check_allowed_group(update, context):
                    return

                # 检查用户权限
                if not await self._check_permission(admin_level, update,
                                                    context):
                    # 如果是回调查询，回应它以避免按钮一直显示加载状态
                    if update.callback_query:
                        await update.callback_query.answer("⚠️ 您没有执行此操作的权限")
                    return

                # 调用原始回调
                return await callback(update, context)
            except telegram.error.Forbidden as e:
                # 处理权限错误（例如机器人被踢出群组）
                self.logger.warning(f"权限错误: {e}")
                return
            except Exception as e:
                self.logger.error(f"权限包装器中发生错误: {e}")
                # 如果是回调查询，回应它以避免按钮一直显示加载状态
                if update.callback_query:
                    try:
                        await update.callback_query.answer("处理回调时出错")
                    except Exception:
                        pass
                return

        # 创建回调处理器
        handler = CallbackQueryHandler(permission_wrapper, pattern=pattern)

        # 添加到应用
        self.application.add_handler(handler, group)

        return True

    async def unregister_command(self, command_name):
        """注销单个命令

        Args:
            command_name: 命令名称

        Returns:
            bool: 是否成功注销
        """
        async with self.command_lock:
            if command_name not in self.commands:
                return False

            # 获取命令信息
            command_info = self.commands[command_name]
            module_name = command_info["module"]

            # 从应用中移除处理器
            for handler in list(self.application.handlers[0]):
                if isinstance(handler, CommandHandler):
                    # 兼容不同版本的 python-telegram-bot
                    if hasattr(handler, 'commands'):
                        # 新版本使用 commands 属性（列表）
                        if command_name in handler.commands:
                            self.application.remove_handler(handler, 0)
                    elif hasattr(handler, 'command'):
                        # 旧版本可能使用 command 属性
                        if handler.command == [command_name]:
                            self.application.remove_handler(handler, 0)

            # 从命令映射中移除
            del self.commands[command_name]

            # 从模块命令映射中移除
            if module_name in self.module_commands and command_name in self.module_commands[
                    module_name]:
                self.module_commands[module_name].remove(command_name)
                if not self.module_commands[module_name]:
                    del self.module_commands[module_name]

            return True

    async def unregister_module_commands(self, module_name):
        """注销模块的所有命令

        Args:
            module_name: 模块名称

        Returns:
            int: 注销的命令数量
        """
        if module_name not in self.module_commands:
            return 0

        command_count = len(self.module_commands[module_name])
        commands_to_unregister = list(self.module_commands[module_name])

        for command_name in commands_to_unregister:
            await self.unregister_command(command_name)

        return command_count

    def _create_command_wrapper(self, command_name, callback, admin_level,
                                module_name):
        """创建命令包装器，处理权限检查和模块聊天类型检查

        Args:
            command_name: 命令名称
            callback: 回调函数
            admin_level: 管理权限要求
            module_name: 模块名称

        Returns:
            function: 包装后的回调函数
        """

        async def wrapper(update, context):
            try:
                # 获取消息对象（可能是新消息或编辑的消息）
                message = update.message or update.edited_message

                # 如果是编辑的消息，记录调试日志
                if update.edited_message:
                    self.logger.debug(
                        f"处理编辑后的命令: /{command_name} (用户: {update.effective_user.id})"
                    )

                # 检查命令是否来自有效群组
                if not await self._check_allowed_group(update, context):
                    return

                # 获取聊天类型
                chat_type = "private" if update.effective_chat.type == "private" else "group"

                # 核心命令不进行模块聊天类型检查
                if module_name != "core":
                    # 获取模块管理器
                    module_manager = context.bot_data.get("module_manager")
                    if module_manager:
                        # 获取模块信息
                        module_info = module_manager.get_module_info(
                            module_name)
                        if module_info:
                            # 检查模块是否支持当前聊天类型
                            module = module_info["module"]
                            supported_types = getattr(module,
                                                      "MODULE_CHAT_TYPES",
                                                      ["private", "group"])

                            if chat_type not in supported_types:
                                await message.reply_text(
                                    f"模块 {module_name} 不支持在 {chat_type} 中使用")
                                return

                # 检查用户权限
                if not await self._check_permission(admin_level, update,
                                                    context):
                    return

                # 执行命令
                await callback(update, context)

            except telegram.error.Forbidden as e:
                # 处理权限错误（例如机器人被踢出群组）
                self.logger.warning(f"执行命令 /{command_name} 时发生权限错误: {e}")
                return
            except Exception as e:
                self.logger.error(f"执行命令 /{command_name} 时出错: {e}")
                message = update.message or update.edited_message
                if message:
                    try:
                        await message.reply_text("执行命令时出错，请查看日志了解详情")
                    except Exception as reply_error:
                        self.logger.debug(f"无法发送错误消息: {reply_error}")

        return wrapper

    async def _check_allowed_group(self, update, context):
        """检查是否在允许的群组中执行命令

        Args:
            update: 更新对象
            context: 上下文对象

        Returns:
            bool: 是否允许执行命令
        """
        chat = update.effective_chat
        user = update.effective_user

        # 私聊总是允许
        if chat.type == "private":
            return True

        # 检查是否是允许的群组
        if chat.type in [
                "group", "supergroup"
        ] and not self.config_manager.is_allowed_group(chat.id):
            # 检查是否是超级管理员
            is_super_admin = self.config_manager.is_admin(user.id)

            # 获取当前命令 - 提取完整的命令名
            command = None
            message = update.message or update.edited_message
            if message and message.text and message.text.startswith('/'):
                command = message.text.split()[0][1:].split('@')[0]

            # 超级管理员的特权命令列表
            special_commands = ["addgroup", "listgroups"]

            # 如果是超级管理员且正在使用特权命令，允许执行
            if is_super_admin and command in special_commands:
                self.logger.debug(
                    f"超级管理员 {user.id} 在非白名单群组 {chat.id} 中使用特权命令: /{command}")
                return True

            # 构建提示消息
            from utils.formatter import TextFormatter  # 导入转义工具
            message = f"⚠️ 此群组未获授权使用 Bot\n\n"
            message += f"群组 ID: `{chat.id}`\n"
            message += f"群组名称: {TextFormatter.escape_markdown(chat.title)}\n\n"

            # 获取消息对象
            msg = update.message or update.edited_message

            # 确保消息对象存在，如果不存在（例如机器人被踢出群组），则直接返回 False
            if not msg:
                self.logger.info(f"无法在群组 {chat.id} 中发送消息，可能是机器人已被踢出")
                return False

            # 如果是超级管理员，提供快速添加到白名单的提示
            if is_super_admin:
                message += f"您是超级管理员，可以使用以下命令授权此群组：\n"
                message += f"`/addgroup {chat.id}`"
                await msg.reply_text(message, parse_mode="MARKDOWN")
            else:
                await msg.reply_text(message)

            return False

        return True

    async def _check_permission(self, admin_level, update, context):
        """检查用户权限

        Args:
            admin_level: 管理权限要求
            update: 更新对象
            context: 上下文对象

        Returns:
            bool: 是否有权限
        """
        if not admin_level:
            return True

        user_id = update.effective_user.id
        chat_id = update.effective_chat.id

        # 检查是否是超级管理员
        if self.config_manager.is_admin(user_id):
            return True

        # 如果需要超级管理员权限，到这里就返回 False
        if admin_level == "super_admin":
            # 如果是回调查询，不需要回复消息，因为已经在 permission_wrapper 中处理了
            if not update.callback_query:
                message = update.message or update.edited_message
                if message:
                    await message.reply_text("⚠️ 此命令仅超级管理员可用")
            return False

        # 检查是否是群组管理员
        if admin_level == "group_admin":
            try:
                chat_member = await context.bot.get_chat_member(
                    chat_id, user_id)
                if chat_member.status in ["creator", "administrator"]:
                    return True
            except telegram.error.Forbidden as e:
                # 处理权限错误（例如机器人被踢出群组）
                self.logger.warning(f"检查群组权限时发生权限错误: {e}")
                return False
            except Exception as e:
                self.logger.warning(f"检查群组权限时出错: {e}")

            # 如果是回调查询，不需要回复消息，因为已经在 permission_wrapper 中处理了
            if not update.callback_query:
                message = update.message or update.edited_message
                if message:
                    await message.reply_text("⚠️ 您没有执行此命令的权限")
            return False

    async def _handle_unknown_command(self, update, context):
        """处理未知命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        # 获取消息对象（可能是新消息或编辑的消息）
        message = update.message or update.edited_message

        if not message or not message.text:
            return

        # 提取命令名称
        text = message.text
        if not text.startswith('/'):
            return

        command = text.split()[0][1:].split('@')[0]

        # 检查是否是未知命令
        if command in self.commands:
            return  # 已知命令，不处理

        # 查找相似命令
        similar_commands = difflib.get_close_matches(command,
                                                     self.commands.keys(),
                                                     n=3,
                                                     cutoff=0.6)

        if similar_commands:
            # 构建建议消息
            suggestion = "您可能想要使用以下命令：\n"
            for cmd in similar_commands:
                suggestion += f"/{cmd}"
                description = self.commands[cmd].get("description", "")
                if description:
                    suggestion += f" - {description}"
                suggestion += "\n"

            await message.reply_text(suggestion)

    async def _start_command(self, update, context):
        """处理 /start 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        # 获取消息对象（可能是新消息或编辑的消息）
        message = update.message or update.edited_message

        # 如果已有贴纸 ID，直接使用
        if self.start_sticker_id:
            try:
                await message.reply_sticker(sticker=self.start_sticker_id)
                return
            except Exception as e:
                self.logger.debug(f"使用已保存的贴纸 ID 失败: {e}")
                # 如果失败，重置 ID 并尝试发送文件
                self.start_sticker_id = None

        # 如果没有贴纸 ID 或使用 ID 失败，发送文件并保存返回的 ID
        try:
            with open("start.webp", "rb") as sticker_file:
                sticker_message = await message.reply_sticker(
                    sticker=sticker_file)
                # 保存返回的贴纸 ID 以便下次使用
                if sticker_message and sticker_message.sticker:
                    self.start_sticker_id = sticker_message.sticker.file_id
        except Exception as e:
            self.logger.error(f"发送贴纸失败: {e}")

    async def _help_command(self, update, context):
        """处理 /help 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        help_text = "🫥 *使用帮助*\n\n"
        help_text += "*开源地址*：[Misakamoe/Misaka0](https://github.com/Misakamoe/Misaka0)\n\n"
        help_text += "*基本命令：*\n"
        help_text += "/help - 显示此帮助信息\n"
        help_text += "/id - 显示用户和聊天 ID 信息\n"
        help_text += "/modules - 列出可用模块\n"
        help_text += "/commands - 列出可用命令\n\n"

        # 获取消息对象（可能是新消息或编辑的消息）
        message = update.message or update.edited_message

        try:
            await message.reply_text(help_text,
                                     parse_mode="MARKDOWN",
                                     disable_web_page_preview=True)
        except Exception:
            # 如果 Markdown 解析失败，发送纯文本
            await message.reply_text(TextFormatter.markdown_to_plain(help_text)
                                     )

    async def _id_command(self, update, context):
        """处理 /id 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        user = update.effective_user
        chat = update.effective_chat

        # 获取消息对象（可能是新消息或编辑的消息）
        msg = update.message or update.edited_message

        # 检查是否是回复消息
        if msg.reply_to_message:
            # 显示被回复用户的信息
            replied_user = msg.reply_to_message.from_user
            message_text = f"👤 *用户信息*\n"
            message_text += f"用户 ID: `{replied_user.id}`\n"

            if replied_user.username:
                message_text += f"用户名: @{TextFormatter.escape_markdown(replied_user.username)}\n"

            message_text += f"名称: {TextFormatter.escape_markdown(replied_user.full_name)}\n"

            try:
                await msg.reply_to_message.reply_text(message_text,
                                                      parse_mode="MARKDOWN")
            except Exception:
                # 如果 Markdown 解析失败，发送纯文本
                await msg.reply_to_message.reply_text(
                    TextFormatter.markdown_to_plain(message_text))

        else:
            # 显示自己的信息和聊天信息
            message_text = f"👤 *用户信息*\n"
            message_text += f"用户 ID: `{user.id}`\n"

            if user.username:
                message_text += f"用户名: @{TextFormatter.escape_markdown(user.username)}\n"

            message_text += f"名称: {TextFormatter.escape_markdown(user.full_name)}\n\n"

            message_text += f"💬 *聊天信息*\n"
            message_text += f"聊天 ID: `{chat.id}`\n"
            message_text += f"类型: {chat.type}\n"

            if chat.type in ["group", "supergroup"]:
                message_text += f"群组名称: {TextFormatter.escape_markdown(chat.title)}\n"

            try:
                await msg.reply_text(message_text, parse_mode="MARKDOWN")
            except Exception:
                # 如果 Markdown 解析失败，发送纯文本
                await msg.reply_text(
                    TextFormatter.markdown_to_plain(message_text))

    async def _list_modules_command(self, update, context):
        """处理 /modules 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        chat_type = update.effective_chat.type
        current_chat_type = "private" if chat_type == "private" else "group"

        # 构建模块列表
        module_list = self._build_module_list(context, current_chat_type)

        # 创建分页助手并显示第一页
        pagination = self._create_module_pagination(module_list,
                                                    current_chat_type)
        await pagination.send_page(update, context, 0)

    def _format_module_item(self, item):
        """格式化模块项目

        Args:
            item: 模块信息

        Returns:
            str: 格式化后的文本
        """
        name = TextFormatter.escape_markdown(item["name"])
        description = TextFormatter.escape_markdown(
            item["description"]) if item["description"] else "_无描述_"
        version = TextFormatter.escape_markdown(item["version"])

        # 显示支持的聊天类型
        chat_types = []
        if "private" in item["supported_types"]:
            chat_types.append("私聊")
        if "group" in item["supported_types"]:
            chat_types.append("群组")

        chat_types_str = ", ".join(chat_types)
        status = "✅" if item["supports_current_type"] else "❌"

        return f"{status} *{name}* v{version} [{chat_types_str}]\n  {description}"

    async def _list_commands_command(self, update, context):
        """处理 /commands 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type
        current_chat_type = "private" if chat_type == "private" else "group"
        user_id = update.effective_user.id

        # 构建命令列表
        command_list = await self._build_command_list(context, user_id,
                                                      chat_id, chat_type,
                                                      current_chat_type)

        # 创建分页助手并显示第一页
        pagination = self._create_command_pagination(command_list,
                                                     current_chat_type)
        await pagination.send_page(update, context, 0)

    def _build_module_list(self, context, current_chat_type):
        """构建模块列表

        Args:
            context: 上下文对象
            current_chat_type: 当前聊天类型 ("private" 或 "group")

        Returns:
            list: 模块信息列表
        """
        module_manager = context.bot_data.get("module_manager")
        installed_modules = module_manager.discover_modules()

        # 构建模块信息列表
        module_list = []
        for module_name in installed_modules:
            if module_name.startswith('_'):
                continue

            # 获取模块信息
            module_info = module_manager.get_module_info(module_name)

            if module_info:
                metadata = module_info["metadata"]
                description = metadata.get("description", "")
                version = metadata.get("version", "unknown")

                # 获取模块支持的聊天类型
                module = module_info["module"]
                supported_types = getattr(module, "MODULE_CHAT_TYPES",
                                          ["private", "group"])
            else:
                metadata = None
                description = ""
                version = "unknown"
                supported_types = ["private", "group"]  # 默认全部支持

            # 检查是否支持当前聊天类型
            supports_current_type = current_chat_type in supported_types

            module_list.append({
                "name": module_name,
                "supports_current_type": supports_current_type,
                "supported_types": supported_types,
                "description": description,
                "version": version,
                "loaded": module_info is not None
            })

        # 按当前聊天类型支持状态和名称排序
        module_list.sort(
            key=lambda x: (not x["supports_current_type"], x["name"]))

        return module_list

    async def _build_command_list(self, context, user_id, chat_id, chat_type,
                                  current_chat_type):
        """构建命令列表

        Args:
            context: 上下文对象
            user_id: 用户ID
            chat_id: 聊天ID
            chat_type: 原始聊天类型
            current_chat_type: 简化的聊天类型 ("private" 或 "group")

        Returns:
            list: 命令信息列表
        """
        # 获取用户权限
        is_super_admin = self.config_manager.is_admin(user_id)

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

        # 收集命令信息
        command_list = []

        # 获取模块管理器
        module_manager = context.bot_data.get("module_manager")

        for cmd_name, cmd_info in self.commands.items():
            module_name = cmd_info["module"]
            admin_level = cmd_info["admin_level"]
            description = cmd_info["description"]

            # 检查权限
            if admin_level == "super_admin" and not is_super_admin:
                continue

            if admin_level == "group_admin" and not (is_super_admin
                                                     or is_group_admin):
                continue

            # 核心模块命令总是可用
            if module_name == "core":
                command_list.append({
                    "name": cmd_name,
                    "module": module_name,
                    "admin_level": admin_level,
                    "description": description
                })
                continue

            # 检查非核心模块命令是否支持当前聊天类型
            module_info = module_manager.get_module_info(module_name)
            if module_info:
                module = module_info["module"]
                supported_types = getattr(module, "MODULE_CHAT_TYPES",
                                          ["private", "group"])
                if current_chat_type in supported_types:
                    command_list.append({
                        "name": cmd_name,
                        "module": module_name,
                        "admin_level": admin_level,
                        "description": description
                    })

        # 按模块和名称排序
        command_list.sort(
            key=lambda x: (x["module"] != "core", x["module"], x["name"]))

        return command_list

    def _create_module_pagination(self, module_list, current_chat_type):
        """创建模块分页助手

        Args:
            module_list: 模块信息列表
            current_chat_type: 当前聊天类型

        Returns:
            PaginationHelper: 分页助手实例
        """
        return PaginationHelper(
            items=module_list,
            page_size=8,
            format_item=lambda item: self._format_module_item(item),
            title=f"模块列表（当前聊天类型：{current_chat_type}）",
            callback_prefix="mod_page")

    def _create_command_pagination(self, command_list, current_chat_type):
        """创建命令分页助手

        Args:
            command_list: 命令信息列表
            current_chat_type: 当前聊天类型

        Returns:
            PaginationHelper: 分页助手实例
        """
        return PaginationHelper(
            items=command_list,
            page_size=10,
            format_item=lambda item: self._format_command_item(item),
            title=f"命令列表（当前聊天类型：{current_chat_type}）",
            callback_prefix="cmd_page")

    def _format_command_item(self, item):
        """格式化命令项目

        Args:
            item: 命令信息

        Returns:
            str: 格式化后的文本
        """
        name = TextFormatter.escape_markdown(item["name"])
        description = TextFormatter.escape_markdown(
            item["description"]) if item["description"] else "_无描述_"
        module = TextFormatter.escape_markdown(item["module"])

        # 单行紧凑格式，使用不同样式区分，命令不加粗
        command_part = f"/{name}"

        # 根据权限级别添加不同格式
        if item["admin_level"] == "super_admin":
            return f"{command_part} - {description} *[超管·{module}]*"
        elif item["admin_level"] == "group_admin":
            return f"{command_part} - {description} *[管理·{module}]*"
        else:
            return f"{command_part} - {description} *[{module}]*"

    async def _calculate_modules_total_pages(self, context):
        """计算模块列表的总页数

        Args:
            context: 上下文对象

        Returns:
            tuple: (总页数, 页面大小)
        """
        # 获取当前聊天类型（这里不重要，因为我们只需要计算总数）
        current_chat_type = "private"  # 默认值，实际上不影响计数

        # 使用辅助方法构建模块列表
        module_list = self._build_module_list(context, current_chat_type)

        # 计算总页数
        page_size = 8  # 与 _create_module_pagination 中的值保持一致
        actual_total_pages = max(1, (len(module_list) + page_size - 1) //
                                 page_size)

        return actual_total_pages, page_size

    async def _calculate_commands_total_pages(self, context, user_id, chat_id,
                                              chat_type):
        """计算命令列表的总页数

        Args:
            context: 上下文对象
            user_id: 用户ID
            chat_id: 聊天ID
            chat_type: 聊天类型

        Returns:
            tuple: (总页数, 页面大小)
        """
        # 简化聊天类型
        current_chat_type = "private" if chat_type == "private" else "group"

        # 使用辅助方法构建命令列表
        command_list = await self._build_command_list(context, user_id,
                                                      chat_id, chat_type,
                                                      current_chat_type)

        # 计算总页数
        page_size = 10  # 与 _create_command_pagination 中的值保持一致
        actual_total_pages = max(1, (len(command_list) + page_size - 1) //
                                 page_size)

        return actual_total_pages, page_size

    async def _handle_command_page_callback(self, update, context):
        """处理命令分页回调

        Args:
            update: 更新对象
            context: 上下文对象
        """
        query = update.callback_query

        # 跳过无操作回调
        if query.data == "noop":
            await query.answer()
            return

        try:
            # 解析回调数据
            parts = query.data.split(":")
            prefix = parts[0]
            action = parts[1]

            chat_id = update.effective_chat.id
            chat_type = update.effective_chat.type
            current_chat_type = "private" if chat_type == "private" else "group"

            # 处理页码选择
            if action == "select" and len(parts) >= 3:
                # 重新计算实际的总页数
                if prefix == "mod_page":
                    # 模块列表分页
                    actual_total_pages, _ = await self._calculate_modules_total_pages(
                        context)

                    # 保存到上下文
                    context.user_data["total_pages"] = actual_total_pages

                elif prefix == "cmd_page":
                    # 命令列表分页
                    user_id = update.effective_user.id
                    chat_id = update.effective_chat.id
                    chat_type = update.effective_chat.type

                    actual_total_pages, _ = await self._calculate_commands_total_pages(
                        context, user_id, chat_id, chat_type)

                    # 保存到上下文
                    context.user_data["total_pages"] = actual_total_pages

                # 显示页码选择界面
                await PaginationHelper.show_page_selector(
                    update, context, prefix, parts[2])
                return
            elif action.startswith("goto_") and len(parts) >= 3:
                # 处理页码跳转
                try:
                    page_index = int(action.replace("goto_", ""))

                    # 重新计算实际的总页数
                    if prefix == "mod_page":
                        # 模块列表分页
                        actual_total_pages, _ = await self._calculate_modules_total_pages(
                            context)

                        # 确保页码在有效范围内
                        page_index = max(
                            0, min(page_index, actual_total_pages - 1))

                        # 保存到上下文
                        context.user_data["total_pages"] = actual_total_pages

                    elif prefix == "cmd_page":
                        # 命令列表分页
                        user_id = update.effective_user.id
                        chat_id = update.effective_chat.id
                        chat_type = update.effective_chat.type

                        actual_total_pages, _ = await self._calculate_commands_total_pages(
                            context, user_id, chat_id, chat_type)

                        # 确保页码在有效范围内
                        page_index = max(
                            0, min(page_index, actual_total_pages - 1))

                        # 保存到上下文
                        context.user_data["total_pages"] = actual_total_pages

                except ValueError:
                    await query.answer("无效的页码")
                    return
            else:
                # 常规页面导航
                try:
                    page_index = int(action)

                    # 重新计算实际的总页数
                    if prefix == "mod_page":
                        # 模块列表分页
                        actual_total_pages, _ = await self._calculate_modules_total_pages(
                            context)

                        # 确保页码在有效范围内
                        page_index = max(
                            0, min(page_index, actual_total_pages - 1))

                        # 保存到上下文
                        context.user_data["total_pages"] = actual_total_pages

                    elif prefix == "cmd_page":
                        # 命令列表分页
                        user_id = update.effective_user.id
                        chat_id = update.effective_chat.id
                        chat_type = update.effective_chat.type

                        actual_total_pages, _ = await self._calculate_commands_total_pages(
                            context, user_id, chat_id, chat_type)

                        # 确保页码在有效范围内
                        page_index = max(
                            0, min(page_index, actual_total_pages - 1))

                        # 保存到上下文
                        context.user_data["total_pages"] = actual_total_pages

                except ValueError:
                    await query.answer("无效的页码")
                    return

            # 获取用户ID
            user_id = update.effective_user.id

            if prefix == "mod_page":
                # 模块列表分页
                module_list = self._build_module_list(context,
                                                      current_chat_type)

                # 创建分页助手并显示请求的页面
                pagination = self._create_module_pagination(
                    module_list, current_chat_type)
                await pagination.send_page(update, context, page_index)

            elif prefix == "cmd_page":
                # 命令列表分页
                command_list = await self._build_command_list(
                    context, user_id, chat_id, chat_type, current_chat_type)

                # 创建分页助手并显示请求的页面
                pagination = self._create_command_pagination(
                    command_list, current_chat_type)
                await pagination.send_page(update, context, page_index)

            else:
                await query.answer("未知的回调类型")

        except Exception as e:
            self.logger.error(f"处理分页回调时出错: {e}")
            await query.answer("处理回调时出错")

    async def _stats_command(self, update, context):
        """处理 /stats 命令

        Args:
            update: 更新对象
            context: 上下文对象
        """
        # 获取消息对象（可能是新消息或编辑的消息）
        message_obj = update.message or update.edited_message

        bot_engine = context.bot_data.get("bot_engine")
        module_manager = context.bot_data.get("module_manager")
        session_manager = context.bot_data.get("session_manager")

        # 计算运行时间
        uptime_seconds = time.time() - bot_engine.stats["start_time"]
        days, remainder = divmod(uptime_seconds, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, seconds = divmod(remainder, 60)

        # 只显示非零的时间单位
        uptime_parts = []
        if int(days) > 0:
            uptime_parts.append(f"{int(days)} 天")
        if int(hours) > 0 or int(days) > 0:
            uptime_parts.append(f"{int(hours)} 小时")
        if int(minutes) > 0 or int(hours) > 0 or int(days) > 0:
            uptime_parts.append(f"{int(minutes)} 分钟")
        uptime_parts.append(f"{int(seconds)} 秒")

        uptime_str = " ".join(uptime_parts)

        # 获取已加载模块数量
        loaded_modules = len(module_manager.loaded_modules)

        # 构建统计信息
        stats_message = f"📊 *机器人统计信息*\n\n"
        stats_message += f"⏱️ 运行时间: {uptime_str}\n"
        stats_message += f"📦 已加载模块: {loaded_modules}\n"
        stats_message += f"🔖 已注册命令: {len(self.commands)}\n"

        # 获取系统信息
        import platform
        stats_message += f"🖥️ 系统: {platform.system()} {platform.release()}\n"

        # 获取活跃会话数量
        active_sessions = await session_manager.get_active_sessions_count()
        stats_message += f"👥 活跃会话: {active_sessions}\n"

        # 获取处理器数量
        handler_count = sum(
            len(handlers) for handlers in self.application.handlers.values())
        stats_message += f"🔄 注册处理器: {handler_count}\n"

        # 获取内存使用情况
        try:
            import psutil
            process = psutil.Process()
            memory_info = process.memory_info()
            memory_usage_mb = memory_info.rss / 1024 / 1024  # 转换为MB
            stats_message += f"💾 内存占用: {memory_usage_mb:.2f} MB\n"
        except ImportError:
            # psutil 可能未安装，跳过内存统计
            self.logger.warning("无法导入 psutil 模块，跳过内存使用统计")
            pass

        # 获取网络配置
        network_config = self.config_manager.main_config.get("network", {})
        poll_interval = network_config.get("poll_interval", 1.0)
        stats_message += f"📡 轮询间隔: {poll_interval} 秒\n"

        # 最后清理时间
        if bot_engine.stats.get("last_cleanup", 0) > 0:
            last_cleanup = datetime.fromtimestamp(
                bot_engine.stats["last_cleanup"]).strftime("%Y-%m-%d %H:%M:%S")
            stats_message += f"🧹 最后清理: {last_cleanup}\n"

        try:
            await message_obj.reply_text(stats_message, parse_mode="MARKDOWN")
        except Exception:
            # 如果 Markdown 解析失败，发送纯文本
            await message_obj.reply_text(
                TextFormatter.markdown_to_plain(stats_message))

    async def _cancel_command(self, update, context):
        """处理 /cancel 命令，取消当前操作

        Args:
            update: 更新对象
            context: 上下文对象
        """
        # 获取消息对象（可能是新消息或编辑的消息）
        message = update.message or update.edited_message
        user_id = update.effective_user.id
        chat_id = update.effective_chat.id

        # 获取会话管理器
        session_manager = context.bot_data.get("session_manager")
        if not session_manager:
            await message.reply_text("⚠️ 系统错误：无法获取会话管理器")
            return

        # 获取当前会话数据（指定 chat_id）
        session_data = await session_manager.get_all(user_id, chat_id=chat_id)

        # 检查是否有活跃会话
        if not session_data:
            await message.reply_text("没有需要取消的操作")
            return

        # 清除用户的所有会话数据（指定 chat_id）
        await session_manager.clear(user_id, chat_id=chat_id)

        # 回复用户
        await message.reply_text("✅ 已取消当前操作")
        self.logger.debug(f"用户 {user_id} 在聊天 {chat_id} 中取消了当前操作")
