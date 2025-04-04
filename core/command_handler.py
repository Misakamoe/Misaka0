# core/command_handler.py
import logging
from telegram.ext import CommandHandler, ContextTypes
from telegram import Update


class CommandProcessor:

    def __init__(self, application):
        self.application = application
        self.logger = logging.getLogger("CommandProcessor")
        self.command_handlers = {}

    def register_command(self, command, callback, admin_only=False):
        """注册命令处理器"""
        if command in self.command_handlers:
            self.logger.warning(f"命令 {command} 已存在，将被覆盖")

        # 创建包装函数来处理权限检查
        async def command_wrapper(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE):
            # 记录命令使用
            user = update.effective_user
            chat = update.effective_chat
            self.logger.info(
                f"用户 {user.id} ({user.username}) 在 {chat.id} 使用命令 /{command}")

            # 权限检查
            if admin_only and not context.bot_data.get(
                    "config_manager").is_admin(user.id):
                await update.message.reply_text("此命令仅管理员可用。")
                return

            # 调用原始回调
            return await callback(update, context)

        # 注册到 application
        handler = CommandHandler(command, command_wrapper)
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
        self.logger.debug(f"注销命令 /{command}")
        return True

    def register_core_commands(self, bot_engine):
        """注册核心命令"""
        # 启动命令
        self.register_command("start", self._start_command)

        # 帮助命令
        self.register_command("help", self._help_command)

        # 模块管理命令
        self.register_command(
            "enable",
            lambda u, c: bot_engine.enable_module_command(u, c),
            admin_only=True)
        self.register_command(
            "disable",
            lambda u, c: bot_engine.disable_module_command(u, c),
            admin_only=True)
        self.register_command(
            "modules", lambda u, c: bot_engine.list_modules_command(u, c))

        # 命令列表命令
        self.register_command(
            "commands", lambda u, c: bot_engine.list_commands_command(u, c))

        # 配置重载命令
        self.register_command(
            "reload_config",
            lambda u, c: bot_engine.reload_config_command(u, c),
            admin_only=True)

    async def _start_command(self, update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
        """启动命令处理"""
        await update.message.reply_text("😋 何か御用でしょうか\n\n使用 /help 查看可用命令。")

    async def _help_command(self, update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
        """帮助命令处理"""
        help_text = "可用命令:\n"
        help_text += "/start - 启动机器人\n"
        help_text += "/help - 显示此帮助信息\n"
        help_text += "/modules - 列出模块\n"
        help_text += "/commands - 列出所有命令\n"

        # 对于管理员显示额外命令
        if context.bot_data.get("config_manager").is_admin(
                update.effective_user.id):
            help_text += "\n管理员命令:\n"
            help_text += "/enable <模块名> - 启用模块\n"
            help_text += "/disable <模块名> - 禁用模块\n"
            help_text += "/reload_config - 重新加载配置\n"

        await update.message.reply_text(help_text)
