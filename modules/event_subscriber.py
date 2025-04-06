# modules/event_subscriber.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler
from datetime import datetime
import asyncio

# 模块元数据
MODULE_NAME = "event_subscriber"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "事件订阅者示例模块"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["subscribe_events", "unsubscribe_events", "show_events"]

# 模块状态
_state = {"is_subscribed": False, "received_events": []}


# 事件处理函数
async def handle_test_event(event_type, source_module, user_id, user_name,
                            chat_id, message, count, **kwargs):
    """处理测试事件"""
    # 获取模块接口
    from telegram.ext import ApplicationBuilder
    application = ApplicationBuilder().token("dummy").build()
    bot_engine = application.bot_data.get("bot_engine")
    if bot_engine:
        module_interface = bot_engine.module_loader.get_module_interface(
            MODULE_NAME)
        if module_interface:
            module_interface.logger.debug(
                f"收到来自 {source_module} 的事件: {event_type}")

    # 记录事件
    event_info = {
        "time": str(datetime.now()),
        "source": source_module,
        "user": user_name,
        "message": message,
        "count": count
    }

    _state["received_events"].append(event_info)

    # 只保留最近10个事件
    if len(_state["received_events"]) > 10:
        _state["received_events"] = _state["received_events"][-10:]

    # 获取模块接口并保存状态
    if bot_engine:
        module_interface = bot_engine.module_loader.get_module_interface(
            MODULE_NAME)
        if module_interface:
            module_interface.save_state(_state)


@error_handler
async def subscribe_events_command(update: Update,
                                   context: ContextTypes.DEFAULT_TYPE):
    """订阅事件命令"""
    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    if _state["is_subscribed"]:
        await update.message.reply_text("已经订阅了事件，无需重复订阅")
        return

    # 订阅事件
    subscription = module_interface.subscribe_event("test_event",
                                                    handle_test_event)

    if subscription:
        _state["is_subscribed"] = True
        module_interface.save_state(_state)
        await update.message.reply_text("✅ 已成功订阅测试事件")
    else:
        await update.message.reply_text("❌ 订阅事件失败")


@error_handler
async def unsubscribe_events_command(update: Update,
                                     context: ContextTypes.DEFAULT_TYPE):
    """取消订阅事件命令"""
    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    if not _state["is_subscribed"]:
        await update.message.reply_text("未订阅事件，无需取消")
        return

    # 模块接口会在 unregister_all_handlers 中自动取消所有订阅
    _state["is_subscribed"] = False
    module_interface.save_state(_state)

    await update.message.reply_text("✅ 已取消订阅测试事件")


@error_handler
async def show_events_command(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """显示接收到的事件"""
    events = _state["received_events"]

    if not events:
        await update.message.reply_text("尚未收到任何事件")
        return

    message = "收到的事件列表:\n\n"
    for i, event in enumerate(events, 1):
        message += f"{i}. 时间: {event['time']}\n"
        message += f"   来源: {event['source']}\n"
        message += f"   用户: {event['user']}\n"
        message += f"   消息: {event['message']}\n"
        message += f"   计数: {event['count']}\n\n"

    await update.message.reply_text(message)


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
    module_interface.register_command("subscribe_events",
                                      subscribe_events_command)
    module_interface.register_command("unsubscribe_events",
                                      unsubscribe_events_command)
    module_interface.register_command("show_events", show_events_command)

    # 加载保存的状态
    saved_state = module_interface.load_state(default={
        "is_subscribed": False,
        "received_events": []
    })
    global _state
    _state = saved_state

    # 如果之前是已订阅状态，重新订阅
    if _state["is_subscribed"]:
        module_interface.subscribe_event("test_event", handle_test_event)

    module_interface.logger.info(
        f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化，订阅状态: {_state['is_subscribed']}"
    )


def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
