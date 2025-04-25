# modules/echo.py - echo 模块示例

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters

MODULE_NAME = "echo"
MODULE_VERSION = "3.1.0"
MODULE_DESCRIPTION = "简单复读用户发送的消息"
MODULE_COMMANDS = ["echo"]
MODULE_CHAT_TYPES = ["private", "group"]  # 支持所有聊天类型

# 按钮回调前缀
CALLBACK_PREFIX = "echo_"

# 模块接口引用
_interface = None


async def setup(interface):
    """模块初始化

    Args:
        interface: 模块接口
    """
    global _interface
    _interface = interface

    interface.logger.info("echo 模块已加载")

    # 注册命令
    await interface.register_command("echo",
                                     echo_command,
                                     admin_level=False,
                                     description="回复你发送的文本")

    # 注册带权限验证的按钮回调处理器
    await interface.register_callback_handler(
        handle_callback_query,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level=False  # 所有用户都可以使用
    )

    # 注册文本输入处理器
    text_input_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE,
        handle_echo_input)
    await interface.register_handler(text_input_handler, group=2)


async def cleanup(interface):
    """模块清理

    Args:
        interface: 模块接口
    """
    interface.logger.info("echo 模块已卸载")


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    query = update.callback_query
    user_id = update.effective_user.id

    # 获取回调数据
    callback_data = query.data

    # 检查前缀
    if not callback_data.startswith(CALLBACK_PREFIX):
        return

    # 移除前缀
    action = callback_data[len(CALLBACK_PREFIX):]

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.answer("系统错误，请联系管理员")
        return

    # 处理不同的操作
    if action == "cancel":
        # 清除会话状态
        await session_manager.delete(user_id, "echo_waiting_for")
        await session_manager.delete(user_id, "echo_active")

        # 发送取消消息
        await query.edit_message_text("已取消操作")

    # 确保回调查询得到响应
    await query.answer()


async def handle_echo_input(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """处理用户输入的文本"""
    # 只处理私聊消息
    if update.effective_chat.type != "private":
        return

    message = update.message
    if not message:
        return

    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        return

    # 检查是否是 echo 模块的活跃会话
    is_active = await session_manager.get(user_id, "echo_active", False)
    if not is_active:
        return

    # 获取会话状态
    waiting_for = await session_manager.get(user_id, "echo_waiting_for")

    if waiting_for == "text":
        # 获取用户输入的文本
        text = message.text

        # 清除会话状态
        await session_manager.delete(user_id, "echo_waiting_for")
        await session_manager.delete(user_id, "echo_active")

        # 复读文本
        await message.reply_text(f"{text}")


async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /echo 命令

    Args:
        update: 更新对象
        context: 上下文对象
    """
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await message.reply_text("系统错误，请联系管理员")
        return

    # 如果有参数，直接处理
    if context.args:
        text = " ".join(context.args)
        await message.reply_text(f"{text}")
        return

    # 否则，启动会话模式
    await session_manager.set(user_id, "echo_waiting_for", "text")
    await session_manager.set(user_id, "echo_active", True)

    # 发送提示消息
    keyboard = [[
        InlineKeyboardButton("⨉ Cancel",
                             callback_data=f"{CALLBACK_PREFIX}cancel")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await message.reply_text("请输入要复读的文本：", reply_markup=reply_markup)
