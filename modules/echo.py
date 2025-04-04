# modules/echo.py
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes

# 模块元数据
MODULE_NAME = "echo"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "回显用户输入的文本"
MODULE_DEPENDENCIES = []

# 存储添加的处理器，用于清理
_handlers = []


async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    text = " ".join(context.args)
    await update.message.reply_text(f"{text}")


def setup(application, bot):
    """模块初始化"""
    global _handlers

    # 注册命令
    handler = CommandHandler("echo", echo_command)
    application.add_handler(handler)

    # 记录添加的处理器
    _handlers.append((handler, 0))  # (handler, group)

    print(f"已注册 echo 命令处理器")


def cleanup(application, bot):
    """模块清理"""
    global _handlers

    # 移除所有添加的处理器
    for handler, group in _handlers:
        try:
            application.remove_handler(handler, group)
            print(f"已移除 echo 处理器")
        except Exception as e:
            print(f"移除处理器失败: {e}")

    # 清空处理器列表
    _handlers = []
