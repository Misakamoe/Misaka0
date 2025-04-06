# core/bot_engine.py
import logging
import os
import importlib
import shutil
import asyncio
from datetime import datetime
from telegram import Update
from telegram.ext import Application, MessageHandler, CommandHandler, ContextTypes, filters, ChatMemberHandler

from core.module_loader import ModuleLoader
from core.command_handler import CommandProcessor
from core.config_manager import ConfigManager
from utils.logger import setup_logger
from utils.decorators import error_handler, permission_check, group_check


class BotEngine:
    """Bot 引擎，负责初始化和管理整个机器人"""

    def __init__(self):
        # 初始化配置管理器
        self.config_manager = ConfigManager()

        # 设置日志
        self.logger = setup_logger(
            "BotEngine",
            self.config_manager.main_config.get("log_level", "INFO"))

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

        # 初始化 Telegram Application
        self.application = Application.builder().token(self.token).build()

        # 将配置管理器添加到 bot_data 中以便在回调中访问
        self.application.bot_data["config_manager"] = self.config_manager

        # 将自身添加到 bot_data 中
        self.application.bot_data["bot_engine"] = self

        # 初始化模块加载器
        self.module_loader = ModuleLoader()

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

        # 设置配置文件监视任务
        self.config_watch_task = None

        self.logger.info("Bot 引擎初始化完成")

    async def handle_error(self, update: object,
                           context: ContextTypes.DEFAULT_TYPE) -> None:
        """处理错误"""
        self.logger.error("处理更新时发生异常:", exc_info=context.error)

        # 如果 update 是可用的，发送错误消息
        if update and isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text("处理命令时发生错误，请查看日志获取详情。")

    async def watch_config_changes(self):
        """监视配置文件变化并自动重新加载"""
        while True:
            try:
                # 保存当前模块列表用于比较
                old_modules = set(self.config_manager.get_enabled_modules())

                # 重新加载配置
                self.config_manager.reload_main_config()
                self.config_manager.reload_modules_config()

                # 检查模块列表是否变化
                new_modules = set(self.config_manager.get_enabled_modules())
                if old_modules != new_modules:
                    # 处理新启用的模块
                    for module_name in new_modules - old_modules:
                        self.logger.info(f"检测到新启用的模块: {module_name}")
                        await self.load_single_module(module_name)

                    # 处理新禁用的模块
                    for module_name in old_modules - new_modules:
                        self.logger.info(f"检测到新禁用的模块: {module_name}")
                        await self.unload_single_module(module_name)

            except Exception as e:
                self.logger.error(f"监视配置文件时出错: {e}")

            # 每 5 秒检查一次
            await asyncio.sleep(5)

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

    def load_modules(self):
        """加载已启用的模块"""
        enabled_modules = self.config_manager.get_enabled_modules()
        self.logger.info(f"正在加载全局启用的模块: {enabled_modules}")

        for module_name in enabled_modules:
            asyncio.create_task(self.load_single_module(module_name))

    async def enable_module_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """启用模块命令处理"""
        if not context.args or len(context.args) < 1:
            await update.message.reply_text("用法: /enable <模块名>")
            return

        module_name = context.args[0]
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type

        # 检查模块是否可用
        available_modules = self.module_loader.discover_modules()
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
        if not context.args or len(context.args) < 1:
            await update.message.reply_text("用法: /disable <模块名>")
            return

        module_name = context.args[0]
        chat_id = update.effective_chat.id
        chat_type = update.effective_chat.type

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
                safe_module = module.replace("_", "\\_").replace(
                    "*", "\\*").replace("[", "\\[").replace("`", "\\`")
                safe_desc = desc.replace("_",
                                         "\\_").replace("*", "\\*").replace(
                                             "[", "\\[").replace("`", "\\`")
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
                    safe_module = module.replace("_", "\\_").replace(
                        "*", "\\*").replace("[", "\\[").replace("`", "\\`")
                    message += f"- {safe_module}\n"

        try:
            # 尝试发送带有 Markdown 格式的消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")
        except Exception as e:
            # 如果失败，尝试发送纯文本消息
            self.logger.error(f"使用 Markdown 发送模块列表失败: {e}")
            plain_message = message.replace("*", "").replace(
                "\\_", "_").replace("\\*",
                                    "*").replace("\\[",
                                                 "[").replace("\\`", "`")
            await update.message.reply_text(plain_message)

    async def list_commands_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """列出当前聊天可用的已注册命令"""
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

        if chat_type in ["group", "supergroup"]:
            message = "*当前群组可用命令:*\n"
        else:
            message = "*可用命令:*\n"

        # 获取所有命令及其元数据
        all_commands = self.command_processor.command_handlers.keys()
        command_metadata = self.command_processor.command_metadata

        # 核心命令（按权限分类）
        core_commands_all = ["start", "help", "id", "modules",
                             "commands"]  # 所有用户可用
        core_commands_admin = ["enable", "disable", "reload_config"]  # 管理员可用
        core_commands_super = ["listgroups", "addgroup",
                               "removegroup"]  # 超级管理员可用

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
                    module_cmds = module_data["metadata"].get("commands", [])
                    if cmd in module_cmds:
                        # 检查模块是否在当前聊天中启用
                        if config_manager.is_module_enabled_for_chat(
                                module_name, chat_id):
                            if module_name not in module_commands:
                                module_commands[module_name] = []
                            module_commands[module_name].append(cmd)
                        break

        # 添加基本命令到消息
        if available_commands:
            message += "\n*基本命令:*\n"
            for cmd in sorted(available_commands):
                # 转义可能导致 Markdown 解析错误的字符
                safe_cmd = cmd.replace("_", "\\_").replace("*", "\\*").replace(
                    "[", "\\[").replace("`", "\\`")
                message += f"/{safe_cmd}\n"

        # 添加管理员命令到消息
        if admin_commands:
            message += "\n*管理员命令:*\n"
            for cmd in sorted(admin_commands):
                safe_cmd = cmd.replace("_", "\\_").replace("*", "\\*").replace(
                    "[", "\\[").replace("`", "\\`")
                message += f"/{safe_cmd}\n"

        # 添加超级管理员命令到消息
        if super_admin_commands:
            message += "\n*超级管理员命令:*\n"
            for cmd in sorted(super_admin_commands):
                safe_cmd = cmd.replace("_", "\\_").replace("*", "\\*").replace(
                    "[", "\\[").replace("`", "\\`")
                message += f"/{safe_cmd}\n"

        # 添加模块命令到消息
        if module_commands:
            message += "\n*模块命令:*\n"
            # 按模块分组显示命令
            for module_name, cmds in sorted(module_commands.items()):
                # 获取模块描述
                desc = ""
                metadata = self.module_loader.get_module_metadata(module_name)
                if metadata:
                    desc = metadata.get("description", "")

                # 转义模块名称
                safe_module = module_name.replace("_", "\\_").replace(
                    "*", "\\*").replace("[", "\\[").replace("`", "\\`")

                message += f"\n*{safe_module}* - {desc}\n"
                for cmd in sorted(cmds):
                    # 转义命令
                    safe_cmd = cmd.replace("_",
                                           "\\_").replace("*", "\\*").replace(
                                               "[", "\\[").replace("`", "\\`")
                    message += f"/{safe_cmd}\n"

        if not available_commands and not admin_commands and not super_admin_commands and not module_commands:
            message += "无已注册命令\n"

        try:
            # 尝试发送带有 Markdown 格式的消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")
        except Exception as e:
            # 如果失败，尝试发送纯文本消息
            self.logger.error(f"使用 Markdown 发送命令列表失败: {e}")
            plain_message = message.replace("*", "").replace(
                "\\_", "_").replace("\\*",
                                    "*").replace("\\[",
                                                 "[").replace("\\`", "`")
            await update.message.reply_text(plain_message)

    async def reload_config_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """重新加载配置命令处理"""
        try:
            # 重新加载配置
            self.config_manager.reload_all_configs()

            # 手动更新配置监视任务的时间戳
            if self.config_watch_task:
                # 取消当前任务
                self.config_watch_task.cancel()
                try:
                    await self.config_watch_task
                except asyncio.CancelledError:
                    pass

                # 启动新任务
                self.config_watch_task = asyncio.create_task(
                    self.watch_config_changes())

            await update.message.reply_text("配置已重新加载")
        except Exception as e:
            self.logger.error(f"重新加载配置失败: {e}")
            await update.message.reply_text(f"重新加载配置失败: {e}")

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

    @staticmethod
    def escape_markdown(text):
        """转义 Markdown 特殊字符"""
        if not text:
            return ""
        # 转义以下字符: _ * [ ] ` \
        return text.replace('\\', '\\\\').replace('_', '\\_').replace(
            '*', '\\*').replace('[', '\\[').replace(']',
                                                    '\\]').replace('`', '\\`')

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
                message += f"用户名: @{BotEngine.escape_markdown(replied_user.username)}\n"
            message += f"名称: {BotEngine.escape_markdown(replied_user.full_name)}\n"

            # 直接回复原消息
            await update.message.reply_to_message.reply_text(
                message, parse_mode="MARKDOWN")
        else:
            # 没有回复消息，显示自己的信息和聊天信息
            message = f"👤 *用户信息*\n"
            message += f"用户 ID: `{user.id}`\n"
            if user.username:
                message += f"用户名: @{BotEngine.escape_markdown(user.username)}\n"
            message += f"名称: {BotEngine.escape_markdown(user.full_name)}\n\n"

            message += f"💬 *聊天信息*\n"
            message += f"聊天 ID: `{chat.id}`\n"
            message += f"类型: {chat.type}\n"

            if chat.type in ["group", "supergroup"]:
                message += f"群组名称: {BotEngine.escape_markdown(chat.title)}\n"

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
                            message += f"- {BotEngine.escape_markdown(admin_user.full_name)} (ID: `{admin_user.id}`)"
                            if admin_user.username:
                                message += f" @{BotEngine.escape_markdown(admin_user.username)}"
                            message += f" - {admin.status}\n"
                    except Exception as e:
                        message += f"获取管理员列表失败: {BotEngine.escape_markdown(str(e))}\n"

            # 正常回复当前消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")

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

        await update.message.reply_text(message, parse_mode="MARKDOWN")

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
        if not context.args or len(context.args) < 1:
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

    async def handle_all_messages(self, update: Update,
                                  context: ContextTypes.DEFAULT_TYPE):
        """处理所有消息，用于检测超级管理员在未授权群组的活动"""
        if not update.message or not update.effective_chat:
            return

        chat = update.effective_chat
        user = update.effective_user

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

        # 加载已启用的模块
        self.load_modules()

        # 启动配置监视任务
        self.config_watch_task = asyncio.create_task(
            self.watch_config_changes())

        # 启动轮询
        self.logger.info("启动 Bot 轮询...")

        # 初始化和启动应用
        await self.application.initialize()
        await self.application.start()
        await self.application.updater.start_polling()

        self.logger.info("Bot 已成功启动，按 Ctrl+C 或发送中断信号来停止")

    async def stop(self):
        """停止 Bot"""
        self.logger.info("正在停止 Bot...")

        # 取消配置监视任务
        if self.config_watch_task:
            self.config_watch_task.cancel()
            try:
                await self.config_watch_task
            except asyncio.CancelledError:
                pass

        # 卸载所有模块
        for module_name in list(self.module_loader.loaded_modules.keys()):
            await self.unload_single_module(module_name)

        # 正确顺序停止 Telegram 应用
        try:
            # 首先停止轮询
            if self.application.updater and self.application.updater.running:
                await self.application.updater.stop()

            # 然后停止应用
            await self.application.stop()

            # 最后关闭应用
            await self.application.shutdown()

            self.logger.info("Bot 已成功停止")
        except Exception as e:
            self.logger.error(f"停止 Bot 时发生错误: {e}", exc_info=True)
            # 即使出错，也尝试继续关闭
            self.logger.info("尝试强制关闭 Bot")
