# core/bot_engine.py
import logging
import os
import importlib
import shutil
import asyncio
from telegram import Update
from telegram.ext import Application, MessageHandler, CommandHandler, ContextTypes, filters

from core.module_loader import ModuleLoader
from core.command_handler import CommandProcessor
from core.config_manager import ConfigManager
from utils.logger import setup_logger


class BotEngine:

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
            self.logger.error("未设置 Bot Token，请在 config/config.json 中设置 token")
            raise ValueError("Bot Token 未设置")

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
        self.application.add_error_handler(self.error_handler)

        # 设置配置文件监视任务
        self.config_watch_task = None

        self.logger.info("Bot 引擎初始化完成")

    async def error_handler(self, update: object,
                            context: ContextTypes.DEFAULT_TYPE) -> None:
        """处理错误"""
        self.logger.error("处理更新时发生异常:", exc_info=context.error)

        # 如果 update 是可用的，发送错误消息
        if update and isinstance(update, Update) and update.effective_message:
            await update.effective_message.reply_text("处理命令时发生错误，请查看日志获取详情。")

    async def watch_config_changes(self):
        """监视配置文件变化并自动重新加载"""
        last_main_config_mtime = os.path.getmtime(
            self.config_manager.main_config_path) if os.path.exists(
                self.config_manager.main_config_path) else 0
        last_modules_config_mtime = os.path.getmtime(
            self.config_manager.modules_config_path) if os.path.exists(
                self.config_manager.modules_config_path) else 0

        while True:
            try:
                # 检查主配置文件
                if os.path.exists(self.config_manager.main_config_path):
                    current_mtime = os.path.getmtime(
                        self.config_manager.main_config_path)
                    if current_mtime > last_main_config_mtime:
                        self.logger.info("检测到主配置文件变化，重新加载...")
                        self.config_manager.reload_main_config()
                        last_main_config_mtime = current_mtime

                # 检查模块配置文件
                if os.path.exists(self.config_manager.modules_config_path):
                    current_mtime = os.path.getmtime(
                        self.config_manager.modules_config_path)
                    if current_mtime > last_modules_config_mtime:
                        self.logger.info("检测到模块配置文件变化，重新加载...")
                        old_modules = set(
                            self.config_manager.get_enabled_modules())

                        self.config_manager.reload_modules_config()

                        new_modules = set(
                            self.config_manager.get_enabled_modules())

                        # 处理新启用的模块
                        for module_name in new_modules - old_modules:
                            await self.load_single_module(module_name)

                        # 处理新禁用的模块
                        for module_name in old_modules - new_modules:
                            await self.unload_single_module(module_name)

                        last_modules_config_mtime = current_mtime

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
        module_data = self.module_loader.load_module(module_name)
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
        try:
            module_data["module"].setup(self.application, self)
            self.logger.info(f"模块 {module_name} 已加载并初始化")
            return True
        except Exception as e:
            self.logger.error(f"初始化模块 {module_name} 失败: {e}")
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
        module_data = self.module_loader.loaded_modules[module_name]
        try:
            # 如果模块有 cleanup 方法，调用它
            if hasattr(module_data["module"], "cleanup"):
                module_data["module"].cleanup(self.application, self)

            # 卸载模块
            self.module_loader.unload_module(module_name)
            self.logger.info(f"模块 {module_name} 已卸载")
            return True
        except Exception as e:
            self.logger.error(f"卸载模块 {module_name} 失败: {e}")
            return False

    def load_modules(self):
        """加载已启用的模块"""
        enabled_modules = self.config_manager.get_enabled_modules()
        self.logger.info(f"正在加载已启用的模块: {enabled_modules}")

        for module_name in enabled_modules:
            asyncio.create_task(self.load_single_module(module_name))

    async def enable_module_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """启用模块命令处理"""
        if not context.args or len(context.args) < 1:
            await update.message.reply_text("用法: /enable <模块名>")
            return

        module_name = context.args[0]

        # 检查模块是否可用
        available_modules = self.module_loader.discover_modules()
        if module_name not in available_modules:
            await update.message.reply_text(f"找不到模块 {module_name}")
            return

        # 检查模块是否已启用
        if module_name in self.config_manager.get_enabled_modules():
            await update.message.reply_text(f"模块 {module_name} 已启用")
            return

        # 加载并启用模块
        if await self.load_single_module(module_name):
            # 将模块添加到已启用列表
            self.config_manager.enable_module(module_name)
            await update.message.reply_text(f"模块 {module_name} 已启用")
        else:
            await update.message.reply_text(f"启用模块 {module_name} 失败，请查看日志")

    async def disable_module_command(self, update: Update,
                                     context: ContextTypes.DEFAULT_TYPE):
        """禁用模块命令处理"""
        if not context.args or len(context.args) < 1:
            await update.message.reply_text("用法: /disable <模块名>")
            return

        module_name = context.args[0]

        # 检查模块是否已启用
        if module_name not in self.config_manager.get_enabled_modules():
            await update.message.reply_text(f"模块 {module_name} 未启用")
            return

        # 卸载模块
        if await self.unload_single_module(module_name):
            # 从已启用列表中移除
            self.config_manager.disable_module(module_name)
            await update.message.reply_text(f"模块 {module_name} 已禁用")
        else:
            await update.message.reply_text(
                f"禁用模块 {module_name} 失败，可能有其他模块依赖于它")

    async def list_modules_command(self, update: Update,
                                   context: ContextTypes.DEFAULT_TYPE):
        """列出模块命令处理"""
        enabled_modules = self.config_manager.get_enabled_modules()
        available_modules = self.module_loader.discover_modules()

        # 构建消息
        message = "📦 *模块列表*\n\n"

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
        if available_not_enabled and self.config_manager.is_admin(
                update.effective_user.id):
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
        """列出所有已注册命令"""
        application_handlers = self.application.handlers

        message = "*已注册命令:*\n"

        # 列出 application 中的所有 handlers
        if application_handlers:
            command_list = []
            for group, handlers in application_handlers.items():
                for handler in handlers:
                    if isinstance(handler, CommandHandler):
                        command_list.extend(handler.commands)

            # 去重并排序
            command_list = sorted(set(command_list))

            # 添加到消息
            for cmd in command_list:
                # 转义可能导致 Markdown 解析错误的字符
                safe_cmd = cmd.replace("_", "\\_").replace("*", "\\*").replace(
                    "[", "\\[").replace("`", "\\`")
                message += f"/{safe_cmd}\n"
        else:
            message += "无已注册命令\n"

        try:
            # 尝试发送带有 Markdown 格式的消息
            await update.message.reply_text(message, parse_mode="MARKDOWN")
        except Exception as e:
            # 如果失败，尝试发送纯文本消息
            self.logger.error(f"使用 Markdown 发送命令列表失败: {e}")
            plain_message = message.replace("*", "")
            await update.message.reply_text(plain_message)

    async def reload_config_command(self, update: Update,
                                    context: ContextTypes.DEFAULT_TYPE):
        """重新加载配置命令处理"""
        try:
            # 重新加载配置
            self.config_manager.reload_all_configs()
            await update.message.reply_text("配置已重新加载")
        except Exception as e:
            self.logger.error(f"重新加载配置失败: {e}")
            await update.message.reply_text(f"重新加载配置失败: {e}")

    async def run(self):
        """启动 Bot"""
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
