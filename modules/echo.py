# modules/echo.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler

# 模块元数据
MODULE_NAME = "echo"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "回显用户输入的文本"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["echo"]  # 声明此模块包含的命令


@error_handler
async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    text = " ".join(context.args)
    await update.message.reply_text(f"{text}")


def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("echo", echo_command)
    print(f"已注册 echo 命令处理器")


def cleanup(module_interface):
    """模块清理"""
    # 不需要手动清理，ModuleInterface 会自动处理
    print(f"echo 模块已清理")
