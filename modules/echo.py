# modules/echo.py - echo 模块示例

from telegram import Update
from telegram.ext import ContextTypes

MODULE_NAME = "Echo"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "简单复读用户发送的消息"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["echo"]


async def setup(interface):
    """模块初始化
    
    Args:
        interface: 模块接口
    """
    interface.logger.info("echo 模块已加载")

    # 注册命令
    await interface.register_command("echo",
                                     echo_command,
                                     admin_level=False,
                                     description="回复你发送的文本")


async def cleanup(interface):
    """模块清理
    
    Args:
        interface: 模块接口
    """
    interface.logger.info("echo 模块已卸载")


async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /echo 命令
    
    Args:
        update: 更新对象
        context: 上下文对象
    """
    if not context.args:
        await update.message.reply_text("用法: /echo <文本>")
        return

    # 获取用户输入
    text = " ".join(context.args)

    # 回复消息
    await update.message.reply_text(f"{text}")
