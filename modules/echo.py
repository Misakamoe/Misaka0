# modules/echo.py

from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler
from utils.text_utils import TextUtils

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

    # 记录使用情况
    user = update.effective_user
    user_info = f"{user.full_name} (ID: {user.id})"
    context.bot_data["bot_engine"].logger.debug(
        f"用户 {user_info} 使用了 echo 命令，当前使用次数: {_state['usage_count']}")

    # 获取并回显文本
    text = " ".join(context.args)
    await update.message.reply_text(text)


# 状态管理函数
def get_state(module_interface):
    """获取模块状态"""
    return _state


def set_state(module_interface, state):
    """设置模块状态"""
    global _state
    _state = state
    module_interface.logger.debug(f"模块状态已更新: {state}")


def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("echo", echo_command)

    # 加载保存的状态
    saved_state = module_interface.load_state(default={"usage_count": 0})
    global _state
    _state = saved_state

    # 定期保存状态的事件订阅（可选）
    # module_interface.subscribe_event("hourly_save", _save_state_handler)

    module_interface.logger.info(
        f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化，当前使用次数: {_state['usage_count']}"
    )


def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(
        f"模块 {MODULE_NAME} 已清理，最终使用次数: {_state['usage_count']}")


# 可选：定期保存状态的事件处理函数
async def _save_state_handler(event_type, **event_data):
    """响应定期保存事件"""
    if "module_interface" in event_data:
        module_interface = event_data["module_interface"]
        module_interface.save_state(_state)
        module_interface.logger.debug(
            f"已定期保存模块状态，当前使用次数: {_state['usage_count']}")
