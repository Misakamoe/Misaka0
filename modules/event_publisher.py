# modules/event_publisher.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler
from datetime import datetime

# 模块元数据
MODULE_NAME = "event_publisher"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "事件发布者示例模块"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["publish_event"]

# 模块状态
_state = {"event_count": 0}


@error_handler
async def publish_event_command(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """发布测试事件"""
    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 增加计数
    _state["event_count"] += 1

    # 保存状态
    module_interface.save_state(_state)

    # 构建事件数据
    event_data = {
        "user_id": update.effective_user.id,
        "user_name": update.effective_user.full_name,
        "chat_id": update.effective_chat.id,
        "message": "这是一个测试事件",
        "count": _state["event_count"]
    }

    # 发布事件
    subscribers = await module_interface.publish_event("test_event",
                                                       **event_data)

    await update.message.reply_text(f"已发布测试事件！\n"
                                    f"- 事件计数: {_state['event_count']}\n"
                                    f"- 订阅者数量: {subscribers}")


# 获取模块状态的方法（用于热更新）
def get_state(module_interface):
    return _state


# 设置模块状态的方法（用于热更新）
def set_state(module_interface, state):
    global _state
    _state = state


def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("publish_event", publish_event_command)

    # 加载保存的状态
    saved_state = module_interface.load_state(default={"event_count": 0})
    global _state
    _state = saved_state

    module_interface.logger.info(
        f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化，当前事件计数: {_state['event_count']}"
    )


def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
