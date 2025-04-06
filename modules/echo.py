# modules/echo.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler

# 模块元数据
MODULE_NAME = "echo"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "回显用户输入的文本"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["echo"]

# 模块状态
_state = {"usage_count": 0}


@error_handler
async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    global _state

    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    # 更新使用次数
    _state["usage_count"] += 1

    text = " ".join(context.args)
    await update.message.reply_text(f"{text}")


# 状态管理函数
def get_state(module_interface):
    return _state


def set_state(module_interface, state):
    global _state
    _state = state


def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("echo", echo_command)

    # 加载保存的状态
    saved_state = module_interface.load_state(default={"usage_count": 0})
    global _state
    _state = saved_state

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
