# core/command_handler.py

import logging
import difflib
from telegram.ext import CommandHandler, ContextTypes, MessageHandler, filters
from telegram import Update
from utils.logger import setup_logger
from utils.decorators import error_handler, permission_check, group_check, module_check
from utils.text_utils import TextUtils


class CommandProcessor:
    """命令处理器，负责注册和管理命令"""

    def __init__(self, application):
        self.application = application
        self.logger = setup_logger("CommandProcessor")
        self.command_handlers = {}
        self.command_metadata = {}  # 存储命令元数据

        # 添加未知命令处理器（低优先级，确保在所有其他处理器之后运行）
        unknown_command_handler = MessageHandler(
            filters.COMMAND & ~filters.UpdateType.EDITED_MESSAGE,
            self.handle_unknown_command)
        self.application.add_handler(unknown_command_handler, group=999)

    def register_command(self, command, callback, admin_only=False):
        """注册命令处理器
        
        参数:
            command: 命令名称
            callback: 回调函数
            admin_only: 
                False - 所有用户可用
                "group_admin" - 群组管理员和超级管理员可用
                "super_admin" - 仅超级管理员可用
        """
        if command in self.command_handlers:
            self.logger.warning(f"命令 {command} 已存在，将被覆盖")
            # 移除旧的处理器
            self.unregister_command(command)

        # 添加命令元数据
        self.command_metadata[command] = {"admin_only": admin_only}

        # 应用所有装饰器
        wrapped_callback = error_handler(callback)

        # 根据权限级别应用权限检查
        if admin_only:
            wrapped_callback = permission_check(
                "super_admin" if admin_only ==
                "super_admin" else "group_admin")(wrapped_callback)

        # 应用群组检查和模块检查
        wrapped_callback = group_check(module_check(wrapped_callback))

        # 创建命令处理器
        handler = CommandHandler(command, wrapped_callback)

        # 注册到 application
        self.application.add_handler(handler)

        # 保存处理器引用以便后续可能的移除
        self.command_handlers[command] = handler
        self.logger.debug(f"注册命令 /{command}")

    def register_command_group(self, commands, module_name=None):
        """批量注册一组命令
        
        Args:
            commands: 命令配置字典，格式为 {命令名: {callback, admin_only, aliases}}
            module_name: 模块名称，用于日志记录
            
        Returns:
            dict: 注册结果，命令名到成功状态的映射
        """
        results = {}
        prefix = f"[{module_name}] " if module_name else ""

        for cmd_name, cmd_data in commands.items():
            callback = cmd_data.get("callback")
            admin_only = cmd_data.get("admin_only", False)
            aliases = cmd_data.get("aliases", [])

            if not callback:
                self.logger.warning(f"{prefix}命令 {cmd_name} 没有提供回调函数，跳过注册")
                results[cmd_name] = False
                continue

            # 注册主命令
            try:
                self.register_command(cmd_name, callback, admin_only)
                results[cmd_name] = True
                self.logger.debug(f"{prefix}注册命令 /{cmd_name}")
            except Exception as e:
                self.logger.error(f"{prefix}注册命令 /{cmd_name} 失败: {e}")
                results[cmd_name] = False

            # 注册别名
            for alias in aliases:
                try:
                    self.register_command(alias, callback, admin_only)
                    results[alias] = True
                    self.logger.debug(
                        f"{prefix}注册命令别名 /{alias} -> /{cmd_name}")
                except Exception as e:
                    self.logger.error(f"{prefix}注册命令别名 /{alias} 失败: {e}")
                    results[alias] = False

        return results

    def unregister_command(self, command):
        """注销命令处理器"""
        if command not in self.command_handlers:
            self.logger.warning(f"命令 /{command} 不存在，无法注销")
            return False

        # 从 application 移除
        self.application.remove_handler(self.command_handlers[command])
        # 从记录中删除
        del self.command_handlers[command]
        # 从元数据中删除
        if command in self.command_metadata:
            del self.command_metadata[command]

        self.logger.debug(f"注销命令 /{command}")
        return True

    def get_command_metadata(self, command):
        """获取命令元数据"""
        return self.command_metadata.get(command, {})

    def find_similar_command(self, command):
        """查找最相似的命令"""
        if not command or command in self.command_handlers:
            return None

        # 使用 difflib 查找最相似的命令
        similar_commands = difflib.get_close_matches(
            command, self.command_handlers.keys(), n=1, cutoff=0.6)

        return similar_commands[0] if similar_commands else None

    @error_handler
    async def handle_unknown_command(self, update: Update,
                                     context: ContextTypes.DEFAULT_TYPE):
        """处理未知命令"""
        if not update.message or not update.message.text:
            return

        # 提取命令名称
        text = update.message.text
        if not text.startswith('/'):
            return

        command = text.split()[0][1:].split('@')[0]

        # 检查是否是未知命令
        if command in self.command_handlers:
            return  # 已知命令，不处理

        # 查找相似命令
        similar_command = self.find_similar_command(command)
        if similar_command:
            await update.message.reply_text(f"您是否想使用 /{similar_command} 命令?")
        # 如果没有找到相似命令，不做任何响应

    def register_core_commands(self, bot_engine):
        """注册核心命令"""
        # 启动命令
        self.register_command("start", self._start_command)

        # 帮助命令
        self.register_command("help", self._help_command)

        # 获取 ID 命令
        self.register_command("id", bot_engine.get_id_command)

        # 模块管理命令
        self.register_command("enable",
                              bot_engine.enable_module_command,
                              admin_only="group_admin")
        self.register_command("disable",
                              bot_engine.disable_module_command,
                              admin_only="group_admin")
        self.register_command("modules", bot_engine.list_modules_command)

        # 命令列表命令
        self.register_command("commands", bot_engine.list_commands_command)

        # 统计信息命令
        self.register_command("stats",
                              bot_engine.stats_command,
                              admin_only="super_admin")

        # 健康状态命令
        self.register_command("health",
                              bot_engine.health_status_command,
                              admin_only="super_admin")

        # 群组白名单管理命令
        self.register_command("listgroups",
                              bot_engine.list_allowed_groups_command,
                              admin_only="super_admin")
        self.register_command("addgroup",
                              bot_engine.add_allowed_group_command,
                              admin_only="super_admin")
        self.register_command("removegroup",
                              bot_engine.remove_allowed_group_command,
                              admin_only="super_admin")

    @error_handler
    async def _start_command(self, update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
        """启动命令处理"""
        await update.message.reply_sticker(
            sticker=
            'CAACAgEAAxkBAAIBmGJ1Mt3gP0VaAvccwfw1lwgt53VlAAIXCQACkSkAARB0sik1UbskECQE'
        )

    @error_handler
    async def _help_command(self, update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
        """帮助命令处理"""
        help_text = "可用命令:\n"
        help_text += "/start - 启动机器人\n"
        help_text += "/help - 显示此帮助信息\n"
        help_text += "/id - 显示 ID 信息\n"
        help_text += "/modules - 列出模块\n"
        help_text += "/commands - 列出所有命令\n"

        # 对于管理员显示额外命令
        config_manager = context.bot_data.get("config_manager")
        user_id = update.effective_user.id
        chat = update.effective_chat

        # 检查是否是超级管理员
        is_super_admin = config_manager.is_admin(user_id)

        # 检查是否是群组管理员
        is_group_admin = False
        if chat.type in ["group", "supergroup"]:
            try:
                chat_member = await context.bot.get_chat_member(
                    chat.id, user_id)
                is_group_admin = chat_member.status in [
                    "creator", "administrator"
                ]
            except Exception:
                pass

        # 显示管理员命令
        if is_super_admin or is_group_admin:
            help_text += "\n管理员命令:\n"
            help_text += "/enable <模块名> - 启用模块\n"
            help_text += "/disable <模块名> - 禁用模块\n"

        # 显示超级管理员命令
        if is_super_admin:
            help_text += "\n超级管理员命令:\n"
            help_text += "/stats - 显示机器人统计信息\n"
            help_text += "/health - 显示机器人健康状态\n"
            help_text += "/listgroups - 列出允许的群组\n"
            help_text += "/addgroup [群组 ID] - 添加群组到白名单\n"
            help_text += "/removegroup <群组 ID> - 从白名单移除群组\n"

        await update.message.reply_text(help_text)
