# core/command_manager.py - 命令管理器

import asyncio
import difflib
import time
import datetime
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
                pattern=r"^(mod_page|cmd_page):\d+:\d+$|^noop$"))

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
                "description": "显示用户和聊天 ID 信息"
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
            },
            {
                "name": "removegroup",
                "callback": bot_engine._remove_allowed_group_command,
                "admin_level": "super_admin",
                "description": "从白名单移除群组"
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

            # 创建处理器
            handler = CommandHandler(
                command_name,
                self._create_command_wrapper(command_name, callback,
                                             admin_level, module_name))

            # 添加到应用
            self.application.add_handler(handler)
            self.logger.debug(f"已注册命令 /{command_name} (模块: {module_name})")

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

            self.logger.debug(f"已注销命令 /{command_name}")
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
                                await update.message.reply_text(
                                    f"模块 {module_name} 不支持在 {chat_type} 中使用。")
                                return

                # 检查用户权限
                if not await self._check_permission(admin_level, update,
                                                    context):
                    return

                # 执行命令
                await callback(update, context)

            except Exception as e:
                self.logger.error(f"执行命令 /{command_name} 时出错: {e}",
                                  exc_info=True)
                await update.message.reply_text("执行命令时出错，请查看日志了解详情。")

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
            if update.message and update.message.text and update.message.text.startswith(
                    '/'):
                command = update.message.text.split()[0][1:].split('@')[0]

            # 超级管理员的特权命令列表
            special_commands = ["addgroup", "listgroups", "removegroup"]

            # 如果是超级管理员且正在使用特权命令，允许执行
            if is_super_admin and command in special_commands:
                self.logger.info(
                    f"超级管理员 {user.id} 在非白名单群组 {chat.id} 中使用特权命令: /{command}")
                return True

            # 构建提示消息
            from utils.formatter import TextFormatter  # 导入转义工具
            message = f"⚠️ 此群组未获授权使用 Bot。\n\n"
            message += f"群组 ID: `{chat.id}`\n"
            message += f"群组名称: {TextFormatter.escape_markdown(chat.title)}\n\n"

            # 如果是超级管理员，提供快速添加到白名单的提示
            if is_super_admin:
                message += f"您是超级管理员，可以使用以下命令授权此群组：\n"
                message += f"`/addgroup {chat.id}`"
                await update.message.reply_text(message, parse_mode="MARKDOWN")
            else:
                await update.message.reply_text(message)

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
            await update.message.reply_text("⚠️ 此命令仅超级管理员可用。")
            return False

        # 检查是否是群组管理员
        if admin_level == "group_admin":
            try:
                chat_member = await context.bot.get_chat_member(
                    chat_id, user_id)
                if chat_member.status in ["creator", "administrator"]:
                    return True
            except Exception as e:
                self.logger.error(f"检查群组权限时出错: {e}")

            await update.message.reply_text("⚠️ 您没有执行此命令的权限。")
            return False

        return False

    async def _handle_unknown_command(self, update, context):
        """处理未知命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        if not update.message or not update.message.text:
            return

        # 提取命令名称
        text = update.message.text
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

            await update.message.reply_text(suggestion)

    async def _start_command(self, update, context):
        """处理 /start 命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        await update.message.reply_sticker(
            sticker=
            'CAACAgEAAxkBAAIBmGJ1Mt3gP0VaAvccwfw1lwgt53VlAAIXCQACkSkAARB0sik1UbskECQE'
        )

    async def _help_command(self, update, context):
        """处理 /help 命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        help_text = "🫥 *机器人帮助*\n\n"
        help_text += "*基本命令：*\n"
        help_text += "/start - 启动机器人\n"
        help_text += "/help - 显示此帮助信息\n"
        help_text += "/id - 显示用户和聊天 ID 信息\n"
        help_text += "/modules - 列出可用模块\n"
        help_text += "/commands - 列出可用命令\n\n"

        # 检查用户权限
        user_id = update.effective_user.id

        # 检查是否是超级管理员
        is_super_admin = self.config_manager.is_admin(user_id)

        # 显示超级管理员命令
        if is_super_admin:
            help_text += "*超级管理员命令：*\n"
            help_text += "/stats - 显示机器人统计信息\n"
            help_text += "/listgroups - 列出允许的群组\n"
            help_text += "/addgroup <群组ID> - 添加群组到白名单\n"
            help_text += "/removegroup <群组ID> - 从白名单移除群组\n"

        try:
            await update.message.reply_text(help_text, parse_mode="MARKDOWN")
        except Exception:
            # 如果 Markdown 解析失败，发送纯文本
            await update.message.reply_text(
                TextFormatter.markdown_to_plain(help_text))

    async def _id_command(self, update, context):
        """处理 /id 命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        user = update.effective_user
        chat = update.effective_chat

        # 检查是否是回复消息
        if update.message.reply_to_message:
            # 显示被回复用户的信息
            replied_user = update.message.reply_to_message.from_user
            message = f"👤 *用户信息*\n"
            message += f"用户 ID: `{replied_user.id}`\n"

            if replied_user.username:
                message += f"用户名: @{TextFormatter.escape_markdown(replied_user.username)}\n"

            message += f"名称: {TextFormatter.escape_markdown(replied_user.full_name)}\n"

            try:
                await update.message.reply_to_message.reply_text(
                    message, parse_mode="MARKDOWN")
            except Exception:
                # 如果 Markdown 解析失败，发送纯文本
                await update.message.reply_to_message.reply_text(
                    TextFormatter.markdown_to_plain(message))

        else:
            # 显示自己的信息和聊天信息
            message = f"👤 *用户信息*\n"
            message += f"用户 ID: `{user.id}`\n"

            if user.username:
                message += f"用户名: @{TextFormatter.escape_markdown(user.username)}\n"

            message += f"名称: {TextFormatter.escape_markdown(user.full_name)}\n\n"

            message += f"💬 *聊天信息*\n"
            message += f"聊天 ID: `{chat.id}`\n"
            message += f"类型: {chat.type}\n"

            if chat.type in ["group", "supergroup"]:
                message += f"群组名称: {TextFormatter.escape_markdown(chat.title)}\n"

            try:
                await update.message.reply_text(message, parse_mode="MARKDOWN")
            except Exception:
                # 如果 Markdown 解析失败，发送纯文本
                await update.message.reply_text(
                    TextFormatter.markdown_to_plain(message))

    async def _list_modules_command(self, update, context):
        """处理 /modules 命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type
        current_chat_type = "private" if chat_type == "private" else "group"

        # 获取已安装的模块
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

        # 使用分页帮助器
        pagination = PaginationHelper(
            items=module_list,
            page_size=8,
            format_item=lambda item: self._format_module_item(item),
            title=f"模块列表（当前聊天类型：{current_chat_type}）",
            callback_prefix="mod_page")

        # 显示第一页
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

        # 获取用户权限
        user_id = update.effective_user.id
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

        # 使用分页帮助器
        pagination = PaginationHelper(
            items=command_list,
            page_size=10,
            format_item=lambda item: self._format_command_item(item),
            title=f"命令列表（当前聊天类型：{current_chat_type}）",
            callback_prefix="cmd_page")

        # 显示第一页
        await pagination.send_page(update, context, 0)

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

        if item["admin_level"] == "super_admin":
            return f"/{name} - {description} (超级管理员, {module})"
        elif item["admin_level"] == "group_admin":
            return f"/{name} - {description} (管理员, {module})"
        else:
            return f"/{name} - {description} ({module})"

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
            page_index = int(parts[1])

            chat_id = update.effective_chat.id
            chat_type = update.effective_chat.type
            current_chat_type = "private" if chat_type == "private" else "group"

            # 获取用户权限
            user_id = update.effective_user.id
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

            if prefix == "mod_page":
                # 模块列表分页
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

                # 按支持当前聊天类型和名称排序
                module_list.sort(
                    key=lambda x: (not x["supports_current_type"], x["name"]))

                # 使用分页帮助器
                pagination = PaginationHelper(
                    items=module_list,
                    page_size=8,
                    format_item=lambda item: self._format_module_item(item),
                    title=f"模块列表（当前聊天类型：{current_chat_type}）",
                    callback_prefix="mod_page")

                # 显示请求的页面
                await pagination.send_page(update, context, page_index)

            elif prefix == "cmd_page":
                # 命令列表分页
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

                    if admin_level == "group_admin" and not (is_super_admin or
                                                             is_group_admin):
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
                command_list.sort(key=lambda x: (x["module"] != "core", x[
                    "module"], x["name"]))

                # 使用分页帮助器
                pagination = PaginationHelper(
                    items=command_list,
                    page_size=10,
                    format_item=lambda item: self._format_command_item(item),
                    title=f"命令列表（当前聊天类型：{current_chat_type}）",
                    callback_prefix="cmd_page")

                # 显示请求的页面
                await pagination.send_page(update, context, page_index)

            else:
                await query.answer("未知的回调类型")

        except Exception as e:
            self.logger.error(f"处理分页回调时出错: {e}", exc_info=True)
            await query.answer("处理回调时出错")

    async def _stats_command(self, update, context):
        """处理 /stats 命令
        
        Args:
            update: 更新对象
            context: 上下文对象
        """
        bot_engine = context.bot_data.get("bot_engine")
        module_manager = context.bot_data.get("module_manager")

        # 计算运行时间
        uptime_seconds = time.time() - bot_engine.stats["start_time"]
        days, remainder = divmod(uptime_seconds, 86400)
        hours, remainder = divmod(remainder, 3600)
        minutes, seconds = divmod(remainder, 60)
        uptime_str = f"{int(days)} 天 {int(hours)} 小时 {int(minutes)} 分钟"

        # 获取已加载模块数量
        loaded_modules = len(module_manager.loaded_modules)

        # 构建统计信息
        message = f"📊 *机器人统计信息*\n\n"
        message += f"⏱️ 运行时间: {uptime_str}\n"
        message += f"📦 已加载模块: {loaded_modules}\n"
        message += f"🔖 已注册命令: {len(self.commands)}\n"

        # 最后清理时间
        if bot_engine.stats.get("last_cleanup", 0) > 0:
            last_cleanup = datetime.fromtimestamp(
                bot_engine.stats["last_cleanup"]).strftime("%Y-%m-%d %H:%M:%S")
            message += f"🧹 最后清理: {last_cleanup}\n"

        try:
            await update.message.reply_text(message, parse_mode="MARKDOWN")
        except Exception:
            # 如果 Markdown 解析失败，发送纯文本
            await update.message.reply_text(
                TextFormatter.markdown_to_plain(message))
