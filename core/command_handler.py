# core/command_handler.py
import logging
from telegram.ext import CommandHandler, ContextTypes
from telegram import Update
from utils.logger import setup_logger
from utils.decorators import error_handler, permission_check, group_check, module_check


class CommandProcessor:
    """命令处理器，负责注册和管理命令"""

    def __init__(self, application):
        self.application = application
        self.logger = setup_logger("CommandProcessor")
        self.command_handlers = {}
        self.command_metadata = {}  # 存储命令元数据

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

        # 配置重载命令
        self.register_command("reload_config",
                              bot_engine.reload_config_command,
                              admin_only="group_admin")

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
        await update.message.reply_text("😋 何か御用でしょうか\n\n使用 /help 查看可用命令。")

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
            help_text += "/reload_config - 重新加载配置\n"

        # 显示超级管理员命令
        if is_super_admin:
            help_text += "\n超级管理员命令:\n"
            help_text += "/listgroups - 列出允许的群组\n"
            help_text += "/addgroup [群组 ID] - 添加群组到白名单\n"
            help_text += "/removegroup <群组 ID> - 从白名单移除群组\n"

        await update.message.reply_text(help_text)
