# modules/rss.py - RSS 订阅模块

import asyncio
import aiohttp
import feedparser
import os
import json
import re
import time
from datetime import datetime
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import ContextTypes, filters, MessageHandler
from utils.formatter import TextFormatter
from utils.pagination import PaginationHelper

# 模块元数据
MODULE_NAME = "rss"
MODULE_VERSION = "3.1.0"
MODULE_DESCRIPTION = "RSS 订阅，智能间隔和健康监控"
MODULE_COMMANDS = ["rss"]
MODULE_CHAT_TYPES = ["private", "group"]  # 支持私聊和群组

# 默认检查间隔配置
DEFAULT_MIN_INTERVAL = 60  # 最小检查间隔（秒）
DEFAULT_MAX_INTERVAL = 3600  # 最大检查间隔（秒）
DEFAULT_INTERVAL = 300  # 默认检查间隔（秒）
HEALTH_CHECK_THRESHOLD = 5  # 连续失败次数阈值
MAX_TIMESTAMPS = 10  # 保存的最大时间戳数量
MAX_ENTRY_IDS = 100  # 每个源保存的最大条目 ID 数量

# 按钮回调前缀
CALLBACK_PREFIX = "rss_"

# 会话状态
SESSION_ADD_URL = "add_url"
SESSION_ADD_TITLE = "add_title"
SESSION_REMOVE = "remove"

# 模块状态
_state = {
    "last_check": {},  # 记录每个源最后一次检查的时间
    "last_entry_ids": {},  # 记录每个源最后一次推送的条目 ID
    "last_sent_time": {},  # 记录最近发送到每个聊天的时间
    "update_timestamps": {},  # 记录源更新的时间戳列表
    "check_intervals": {},  # 每个源的自定义检查间隔
    "source_health": {}  # 源健康状态记录
}

# 配置文件路径
CONFIG_FILE = "config/rss_subscriptions.json"  # 配置文件（订阅信息）

# 默认配置
DEFAULT_CONFIG = {
    "subscriptions": {
        "private": {},  # 用户 ID -> [订阅列表]
        "group": {}  # 群组 ID -> [订阅列表]
    },
    "sources": {}  # URL -> {title, last_updated, ...}
}

# 全局变量
_config = DEFAULT_CONFIG.copy()
_check_task = None
_module_interface = None


# 加载配置
def load_config():
    """加载 RSS 配置"""
    global _config
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                _config = json.load(f)
        else:
            _config = DEFAULT_CONFIG.copy()
            save_config()
    except Exception as e:
        _module_interface.logger.error(f"加载 RSS 配置失败: {e}")
        _config = DEFAULT_CONFIG.copy()


# 保存配置
def save_config():
    """保存 RSS 配置"""
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(_config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        _module_interface.logger.error(f"保存 RSS 配置失败: {e}")
        return False


# RSS 命令处理函数
async def rss_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """管理 RSS 订阅"""
    # 获取消息对象（可能是新消息、编辑的消息或回调查询的消息）
    if hasattr(update, 'callback_query') and update.callback_query:
        message = update.callback_query.message
    else:
        message = update.message or update.edited_message

    # 确保消息对象不为空
    if not message:
        _module_interface.logger.error("无法获取消息对象")
        return

    # 在群组中检查用户是否为管理员
    if update.effective_chat.type != "private":
        # 使用 _check_permission 方法检查权限
        command_manager = _module_interface.command_manager
        if not await command_manager._check_permission("group_admin", update,
                                                       context):
            # 权限检查失败 - 回调查询发送错误消息
            if hasattr(update, 'callback_query') and update.callback_query:
                await update.callback_query.answer("⚠️ 只有管理员可以管理 RSS 订阅")
            return

    # 显示主菜单
    list_callback = f"{CALLBACK_PREFIX}list"
    add_callback = f"{CALLBACK_PREFIX}add"
    health_callback = f"{CALLBACK_PREFIX}health"

    keyboard = [[
        InlineKeyboardButton("Add", callback_data=add_callback),
        InlineKeyboardButton("List", callback_data=list_callback)
    ], [InlineKeyboardButton("Health", callback_data=health_callback)]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if hasattr(update, 'callback_query') and update.callback_query:
        await update.callback_query.edit_message_text(
            "<b>📢 RSS 订阅管理</b>\n\n"
            "请选择要执行的操作：",
            reply_markup=reply_markup,
            parse_mode="HTML")
    else:
        await message.reply_text("<b>📢 RSS 订阅管理</b>\n\n"
                                 "请选择要执行的操作：",
                                 reply_markup=reply_markup,
                                 parse_mode="HTML")


async def list_subscriptions(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """列出当前订阅"""
    # 检查是否是回调查询
    callback_query = None
    if hasattr(update, 'callback_query') and update.callback_query:
        callback_query = update.callback_query
        message = callback_query.message
    else:
        message = update.message or update.edited_message

    # 确保消息对象不为空
    if not message:
        _module_interface.logger.error("无法获取消息对象")
        return

    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    subscriptions = _config["subscriptions"][chat_type].get(chat_id, [])

    if not subscriptions:
        # 创建返回主菜单的按钮
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}main")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        if callback_query:
            await callback_query.edit_message_text("⚠️ 当前没有 RSS 订阅",
                                                   reply_markup=reply_markup)
        else:
            await message.reply_text("⚠️ 当前没有 RSS 订阅",
                                     reply_markup=reply_markup)
        return

    # 获取页码参数（从上下文获取）
    page_index = context.user_data.get("rss_page_index", 0)

    # 创建订阅项目列表
    subscription_items = []
    for i, url in enumerate(subscriptions, 1):
        source_info = _config["sources"].get(url, {})
        title = source_info.get("title", url)
        subscription_items.append({"index": i, "url": url, "title": title})

    # 创建格式化函数
    def format_subscription(item):
        safe_title = TextFormatter.escape_html(item["title"])
        safe_url = TextFormatter.escape_html(item["url"])
        return f"{item['index']}. <b>{safe_title}</b>\n   <code>{safe_url}</code>\n"

    # 创建返回按钮
    back_button = InlineKeyboardButton("⇠ Back",
                                       callback_data=f"{CALLBACK_PREFIX}main")

    # 创建操作按钮行
    operation_row = [
        InlineKeyboardButton("Remove",
                             callback_data=f"{CALLBACK_PREFIX}remove"),
        back_button
    ]

    # 创建分页助手
    pagination = PaginationHelper(
        items=subscription_items,
        page_size=5,
        format_item=format_subscription,
        title="📋 RSS 订阅列表",
        callback_prefix=f"{CALLBACK_PREFIX}list_page",
        parse_mode="HTML",
        back_button=operation_row)

    # 获取分页内容
    content, keyboard = pagination.get_page_content(page_index)

    # 保存分页信息到上下文，用于页码选择功能
    context.user_data["pagination_title"] = "📋 RSS 订阅列表"
    context.user_data["pagination_parse_mode"] = "HTML"
    context.user_data["total_pages"] = pagination.total_pages

    # 保存页码到上下文
    context.user_data["rss_page_index"] = page_index

    # 发送或更新消息
    if callback_query:
        await callback_query.edit_message_text(text=content,
                                               reply_markup=keyboard,
                                               parse_mode="HTML")
        await callback_query.answer()
    else:
        await message.reply_text(text=content,
                                 reply_markup=keyboard,
                                 parse_mode="HTML")


async def rss_health_command(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """查询 RSS 源健康状态"""
    # 获取回调查询
    callback_query = update.callback_query

    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    subscriptions = _config["subscriptions"][chat_type].get(chat_id, [])

    # 创建返回主菜单的按钮
    keyboard = [[
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}main")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    if not subscriptions:
        await callback_query.edit_message_text("⚠️ 当前没有 RSS 订阅",
                                               reply_markup=reply_markup)
        return

    # 获取页码参数（从上下文获取）
    page_index = context.user_data.get("rss_health_page_index", 0)

    # 创建健康状态项目列表
    health_items = []
    for i, url in enumerate(subscriptions, 1):
        source_info = _config["sources"].get(url, {})
        source_title = source_info.get('title', url)

        health_info = _state["source_health"].get(
            url, {
                "consecutive_failures": 0,
                "last_success": 0,
                "total_checks": 0,
                "total_failures": 0,
                "is_healthy": True
            })

        # 计算成功率
        total_checks = health_info["total_checks"]
        success_rate = "N/A"
        if total_checks > 0:
            success_rate = f"{((total_checks - health_info['total_failures']) / total_checks * 100):.1f}%"

        # 最后成功时间
        last_success = "从未"
        if health_info["last_success"] > 0:
            last_success_time = datetime.fromtimestamp(
                health_info["last_success"])
            last_success = last_success_time.strftime("%Y-%m-%d %H:%M:%S")

        # 检查间隔
        interval = _state["check_intervals"].get(url, DEFAULT_INTERVAL)

        health_items.append({
            "index": i,
            "title": source_title,
            "is_healthy": health_info["is_healthy"],
            "success_rate": success_rate,
            "last_success": last_success,
            "interval": interval
        })

    # 创建格式化函数
    def format_health_item(item):
        safe_title = TextFormatter.escape_html(item["title"])
        status_icon = "✅" if item["is_healthy"] else "⚠️"

        return (f"{status_icon} <b>{safe_title}</b>\n"
                f"  • 状态: {'正常' if item['is_healthy'] else '异常'}\n"
                f"  • 成功率: {item['success_rate']}\n"
                f"  • 最后成功: {item['last_success']}\n"
                f"  • 检查间隔: {item['interval']:.0f} 秒\n")

    # 创建返回按钮
    back_button = InlineKeyboardButton("⇠ Back",
                                       callback_data=f"{CALLBACK_PREFIX}main")

    # 创建返回按钮行
    back_row = [back_button]

    # 创建分页助手
    pagination = PaginationHelper(
        items=health_items,
        page_size=4,  # 每页显示4个健康状态
        format_item=format_health_item,
        title="📊 RSS 源健康状态",
        callback_prefix=f"{CALLBACK_PREFIX}health_page",
        parse_mode="HTML",
        back_button=back_row)

    # 获取分页内容
    content, keyboard = pagination.get_page_content(page_index)

    # 保存分页信息到上下文，用于页码选择功能
    context.user_data["pagination_title"] = "📊 RSS 源健康状态"
    context.user_data["pagination_parse_mode"] = "HTML"
    context.user_data["total_pages"] = pagination.total_pages

    # 保存页码到上下文
    context.user_data["rss_health_page_index"] = page_index

    # 更新消息
    await callback_query.edit_message_text(text=content,
                                           reply_markup=keyboard,
                                           parse_mode="HTML")
    await callback_query.answer()


async def add_subscription(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """添加订阅 - 启动会话流程"""
    # 获取回调查询
    callback_query = update.callback_query

    # 获取会话管理器
    session_manager = _module_interface.session_manager
    if not session_manager:
        await callback_query.answer("系统错误，请联系管理员")
        return

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否有其他模块的活跃会话
    if await session_manager.has_other_module_session(user_id,
                                                      MODULE_NAME,
                                                      chat_id=chat_id):
        await callback_query.answer("⚠️ 请先完成或取消其他活跃会话")
        return

    # 设置会话状态，等待用户输入 URL
    await session_manager.set(user_id,
                              "rss_step",
                              SESSION_ADD_URL,
                              chat_id=chat_id,
                              module_name=MODULE_NAME)

    # 创建返回按钮
    keyboard = [[
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}cancel")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 更新消息
    await callback_query.edit_message_text("请输入要订阅的 RSS 源 URL：",
                                           reply_markup=reply_markup)


async def handle_add_url(update: Update,
                         context: ContextTypes.DEFAULT_TYPE,
                         url: str,
                         session_manager=None):
    """处理用户输入的 RSS URL"""
    message = update.message
    user_id = update.effective_user.id
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    if chat_id not in _config["subscriptions"][chat_type]:
        _config["subscriptions"][chat_type][chat_id] = []

    subscriptions = _config["subscriptions"][chat_type][chat_id]

    # 检查是否已订阅
    if url in subscriptions:
        # 创建返回按钮
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}main")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await message.reply_text("⚠️ 已经订阅了该 RSS 源", reply_markup=reply_markup)

        # 清除会话状态
        await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)
        return

    # 验证并获取 RSS 源信息
    try:
        # 发送处理中消息
        processing_msg = await message.reply_text("🔍 正在验证 RSS 源...")

        feed = await fetch_feed(url)

        if not feed or not feed.get('entries'):
            # 创建返回按钮
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}main")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await processing_msg.edit_text("❌ 无效的 RSS 源，请检查 URL 是否正确",
                                           reply_markup=reply_markup)

            # 清除会话状态
            await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
            await session_manager.release_session(user_id,
                                                  module_name=MODULE_NAME,
                                                  chat_id=chat_id)
            return

        # 获取源标题
        feed_title = feed.get('feed', {}).get('title', url)

        # 保存 URL 并进入下一步（输入自定义标题）
        await session_manager.set(user_id,
                                  "rss_url",
                                  url,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)
        await session_manager.set(user_id,
                                  "rss_feed_title",
                                  feed_title,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)
        await session_manager.set(user_id,
                                  "rss_step",
                                  SESSION_ADD_TITLE,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

        # 创建按钮（使用默认标题或返回）
        keyboard = [[
            InlineKeyboardButton(
                "Use Default",
                callback_data=f"{CALLBACK_PREFIX}use_default_title")
        ],
                    [
                        InlineKeyboardButton(
                            "⇠ Back", callback_data=f"{CALLBACK_PREFIX}cancel")
                    ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await processing_msg.edit_text(
            f"✅ RSS 源有效\n\n"
            f"默认标题: <b>{TextFormatter.escape_html(feed_title)}</b>\n\n"
            f"请选择使用默认标题，或输入自定义标题：",
            reply_markup=reply_markup,
            parse_mode="HTML")

    except Exception as e:
        # 创建返回按钮
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}main")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await message.reply_text(f"❌ 添加 RSS 源失败: {str(e)}",
                                 reply_markup=reply_markup)

        # 清除会话状态
        await session_manager.delete(user_id, "rss_url", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "rss_feed_title",
                                     chat_id=chat_id)
        await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)


async def handle_add_title(update: Update,
                           context: ContextTypes.DEFAULT_TYPE,
                           title: str = None,
                           session_manager=None):
    """处理用户输入的自定义标题或使用默认标题"""
    # 检查是否是回调查询
    callback_query = None
    if hasattr(update, 'callback_query') and update.callback_query:
        callback_query = update.callback_query
        message = callback_query.message
    else:
        message = update.message or update.edited_message

    # 确保消息对象不为空
    if not message and not callback_query:
        _module_interface.logger.error("无法获取消息对象或回调查询")
        return

    user_id = update.effective_user.id
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取保存的 URL 和默认标题
    url = await session_manager.get(user_id, "rss_url", None, chat_id=chat_id)
    feed_title = await session_manager.get(user_id,
                                           "rss_feed_title",
                                           None,
                                           chat_id=chat_id)

    if not url:
        # 清理会话状态
        await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
        await session_manager.delete(user_id, "rss_url", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "rss_feed_title",
                                     chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)

        if callback_query:
            await callback_query.answer("⚠️ 会话已过期，请重新开始")
            # 显示主菜单
            await rss_command(update, context)
        elif message:
            await message.reply_text("⚠️ 会话已过期，请重新开始")
            await rss_command(update, context)
        return

    # 如果没有提供标题，则使用默认标题
    custom_title = title or feed_title

    # 获取当前聊天的订阅
    subscriptions = _config["subscriptions"][chat_type][chat_id]

    # 添加到订阅
    subscriptions.append(url)

    # 添加源信息
    _config["sources"][url] = {
        "title": custom_title,
        "last_updated": datetime.now().isoformat()
    }

    # 记录最后检查时间
    _state["last_check"][url] = datetime.now().timestamp()

    # 初始化健康状态
    _state["source_health"][url] = {
        "consecutive_failures": 0,
        "last_success": datetime.now().timestamp(),
        "total_checks": 1,
        "total_failures": 0,
        "is_healthy": True
    }

    # 保存配置
    save_config()

    # 清除会话状态
    await session_manager.delete(user_id, "rss_url", chat_id=chat_id)
    await session_manager.delete(user_id, "rss_feed_title", chat_id=chat_id)
    await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
    await session_manager.release_session(user_id,
                                          module_name=MODULE_NAME,
                                          chat_id=chat_id)

    # 创建返回按钮
    keyboard = [[
        InlineKeyboardButton("List", callback_data=f"{CALLBACK_PREFIX}list"),
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}main")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 显示成功消息
    safe_title = TextFormatter.escape_html(custom_title)
    safe_url = TextFormatter.escape_html(url)
    success_text = (f"✅ 成功添加 RSS 订阅\n\n"
                    f"📚 <b>{safe_title}</b>\n"
                    f"🔗 <code>{safe_url}</code>")

    if callback_query:
        await callback_query.edit_message_text(success_text,
                                               reply_markup=reply_markup,
                                               parse_mode="HTML")
    elif message:
        await message.reply_text(success_text,
                                 reply_markup=reply_markup,
                                 parse_mode="HTML")

    # 异步获取 feed 内容并初始化条目 ID
    asyncio.create_task(initialize_feed_entries(url, _module_interface))


async def initialize_feed_entries(url, interface):
    """初始化 feed 条目 ID（异步执行）"""
    try:
        feed = await fetch_feed(url)
        if feed and feed.get('entries'):
            _state["last_entry_ids"][url] = [
                entry.get('id', '') or entry.get('link', '')
                for entry in feed.get('entries')
            ][:MAX_ENTRY_IDS]
            interface.logger.debug(f"已初始化 RSS 源 {url} 的条目 ID")
    except Exception as e:
        interface.logger.error(f"初始化 RSS 源 {url} 的条目 ID 失败: {e}")


async def fetch_feed(url):
    """异步获取 RSS 源"""
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, timeout=10) as response:
                if response.status == 200:
                    content = await response.text()
                    feed = feedparser.parse(content)
                    return feed
                return None
    except Exception as e:
        _module_interface.logger.error(f"获取 RSS 源 {url} 失败: {e}")
        return None


async def notify_source_unhealthy(url, source_info, subscribed_chats,
                                  module_interface):
    """通知订阅者源可能有问题"""
    source_title = source_info.get('title', url)
    safe_title = TextFormatter.escape_html(source_title)
    message = (f"⚠️ <b>RSS 源可能不可用</b>\n\n"
               f"RSS 源 <b>{safe_title}</b> 连续 {HEALTH_CHECK_THRESHOLD} 次检查失败")

    # 发送通知给所有订阅者
    for chat_id, _ in subscribed_chats:
        try:
            await module_interface.application.bot.send_message(
                chat_id=chat_id, text=message, parse_mode="HTML")
        except Exception as e:
            module_interface.logger.error(f"向聊天 {chat_id} 发送源健康警告失败: {e}")


async def notify_source_recovered(url, source_info, subscribed_chats,
                                  module_interface):
    """通知订阅者源已恢复"""
    source_title = source_info.get('title', url)
    safe_title = TextFormatter.escape_html(source_title)
    message = (f"✅ <b>RSS 源已恢复</b>\n\n"
               f"RSS 源 <b>{safe_title}</b> 现在已经恢复正常")

    # 发送通知给所有订阅者
    for chat_id, _ in subscribed_chats:
        try:
            await module_interface.application.bot.send_message(
                chat_id=chat_id, text=message, parse_mode="HTML")
        except Exception as e:
            module_interface.logger.error(f"向聊天 {chat_id} 发送源恢复通知失败: {e}")


async def initialize_entry_ids(module_interface):
    """启动时初始化所有源的条目 ID，将现有条目标记为已推送"""
    module_interface.logger.info("正在初始化所有 RSS 源的条目 ID...")

    for url, source_info in _config["sources"].items():
        try:
            feed = await fetch_feed(url)
            if feed and feed.get('entries'):
                # 记录所有条目的 ID
                _state["last_entry_ids"][url] = [
                    entry.get('id', '') or entry.get('link', '')
                    for entry in feed.get('entries')
                ]
                module_interface.logger.debug(
                    f"已初始化源 '{source_info.get('title', url)}' 的 {len(_state['last_entry_ids'][url])} 个条目 ID"
                )
        except Exception as e:
            module_interface.logger.error(f"初始化源 {url} 的条目 ID 时出错: {e}")

    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info("所有 RSS 源的条目 ID 初始化完成")


async def check_updates(module_interface):
    """定期检查 RSS 更新"""
    try:
        while True:
            try:
                # 使用异步并发池限制同时检查的源数量
                tasks = []
                current_time = datetime.now().timestamp()

                for url, source_info in _config["sources"].items():
                    # 获取上次检查时间
                    last_check = _state["last_check"].get(url, 0)

                    # 获取该源的检查间隔（如果有自定义间隔则使用，否则使用默认值）
                    check_interval = _state["check_intervals"].get(
                        url, DEFAULT_INTERVAL)

                    # 如果距离上次检查不到指定间隔，跳过
                    if current_time - last_check < check_interval:
                        continue

                    # 创建检查任务
                    task = asyncio.create_task(
                        check_feed(url, source_info, module_interface))
                    tasks.append(task)

                # 等待所有任务完成
                if tasks:
                    await asyncio.gather(*tasks)

                # 保存状态
                module_interface.save_state(_state)

            except Exception as e:
                module_interface.logger.error(f"RSS 检查任务出错: {e}")

            # 等待下一次检查周期
            await asyncio.sleep(60)  # 每分钟检查一次待检查的源
    except asyncio.CancelledError:
        module_interface.logger.info("RSS 检查任务被取消")
        raise


async def check_feed(url, source_info, module_interface):
    """检查单个 RSS 源的更新"""
    # 如果这个源的条目 ID 列表为空，说明可能还没初始化完成，跳过检查
    if url not in _state["last_entry_ids"] or not _state["last_entry_ids"][url]:
        module_interface.logger.debug(f"源 {url} 的条目 ID 列表为空，跳过检查")
        return

    try:
        # 更新最后检查时间
        current_time = datetime.now().timestamp()
        _state["last_check"][url] = current_time

        # 初始化源健康状态
        if url not in _state["source_health"]:
            _state["source_health"][url] = {
                "consecutive_failures": 0,
                "last_success": current_time,
                "total_checks": 0,
                "total_failures": 0,
                "is_healthy": True
            }

        # 增加总检查次数
        _state["source_health"][url]["total_checks"] += 1

        # 获取订阅该源的所有聊天
        subscribed_chats = []
        for chat_type in ["private", "group"]:
            for chat_id_str, urls in _config["subscriptions"][chat_type].items(
            ):
                if url in urls:
                    # 将字符串 ID 转换为整数
                    chat_id = int(chat_id_str)
                    # 检查聊天是否在白名单中
                    if module_interface.config_manager.is_allowed_group(
                            chat_id) or chat_type == "private":
                        subscribed_chats.append((chat_id, chat_type))

        if not subscribed_chats:
            return

        # 获取 RSS 内容
        feed = await fetch_feed(url)
        if not feed or not feed.get('entries'):
            # 更新健康状态 - 失败
            _state["source_health"][url]["consecutive_failures"] += 1
            _state["source_health"][url]["total_failures"] += 1

            # 检查是否超过健康阈值
            if _state["source_health"][url][
                    "consecutive_failures"] >= HEALTH_CHECK_THRESHOLD:
                if _state["source_health"][url]["is_healthy"]:
                    _state["source_health"][url]["is_healthy"] = False
                    # 通知订阅者源可能有问题
                    await notify_source_unhealthy(url, source_info,
                                                  subscribed_chats,
                                                  module_interface)

            return

        # 更新健康状态 - 成功
        if _state["source_health"][url]["consecutive_failures"] > 0:
            _state["source_health"][url]["consecutive_failures"] = 0

        # 如果源之前不健康，现在恢复了，发送通知
        if not _state["source_health"][url]["is_healthy"]:
            _state["source_health"][url]["is_healthy"] = True
            await notify_source_recovered(url, source_info, subscribed_chats,
                                          module_interface)

        _state["source_health"][url]["last_success"] = current_time

        # 获取上次推送的条目 ID
        last_entry_ids = _state["last_entry_ids"].get(url, [])

        # 找出新条目
        new_entries = []
        new_entry_ids = []

        for entry in feed.get('entries', []):
            # 获取条目 ID
            entry_id = entry.get('id', '')
            if not entry_id:
                entry_id = entry.get('link', '')

            # 只检查 ID，不使用时间过滤
            if entry_id and entry_id not in last_entry_ids:
                new_entries.append(entry)
                new_entry_ids.append(entry_id)

        # 更新最后条目 ID（最多保存 MAX_ENTRY_IDS 个 ID 防止过大）
        _state["last_entry_ids"][url] = (new_entry_ids +
                                         last_entry_ids)[:MAX_ENTRY_IDS]

        # 如果有新条目，更新时间戳并调整检查间隔
        if new_entries:
            # 更新时间戳列表
            if url not in _state["update_timestamps"]:
                _state["update_timestamps"][url] = []

            _state["update_timestamps"][url].append(current_time)
            # 只保留最近的 MAX_TIMESTAMPS 个时间戳
            _state["update_timestamps"][url] = _state["update_timestamps"][
                url][-MAX_TIMESTAMPS:]

            # 调整检查间隔
            if len(_state["update_timestamps"][url]) >= 2:
                # 计算间隔
                timestamps = _state["update_timestamps"][url]
                intervals = [
                    timestamps[i] - timestamps[i - 1]
                    for i in range(1, len(timestamps))
                ]
                avg_interval = sum(intervals) / len(intervals)

                # 计算变异系数（如果可能）
                if len(intervals) > 1:
                    # 计算标准差
                    variance = sum((x - avg_interval)**2
                                   for x in intervals) / len(intervals)
                    std_dev = variance**0.5
                    cv = std_dev / avg_interval if avg_interval > 0 else 0

                    # 根据变异系数调整因子
                    if cv > 0.5:  # 高变异（更新不规律）
                        factor = 4  # 更频繁检查
                    elif cv > 0.3:  # 中等变异
                        factor = 3
                    else:  # 低变异（更新规律）
                        factor = 2
                else:
                    cv = 0
                    factor = 3  # 默认使用较保守的因子

                # 计算新间隔
                new_interval = max(
                    DEFAULT_MIN_INTERVAL,
                    min(DEFAULT_MAX_INTERVAL, avg_interval / factor))

                # 渐进式调整（最多一次变化30%）
                current_interval = _state["check_intervals"].get(
                    url, DEFAULT_INTERVAL)
                max_change = current_interval * 0.3
                if new_interval < current_interval:
                    new_interval = max(new_interval,
                                       current_interval - max_change)
                else:
                    new_interval = min(new_interval,
                                       current_interval + max_change)

                _state["check_intervals"][url] = new_interval

                module_interface.logger.debug(
                    f"源 '{source_info.get('title', url)}' 的检查间隔已调整为 {new_interval:.0f} 秒 (变异系数: {cv:.2f}, 因子: {factor})"
                )

        # 推送新条目（最多推送 5 条，防止刷屏）
        for entry in new_entries[:5]:
            await send_entry(entry, source_info, url, subscribed_chats,
                             module_interface)

    except Exception as e:
        module_interface.logger.error(f"检查 RSS 源 {url} 时出错: {e}")

        # 更新健康状态 - 失败
        if url in _state["source_health"]:
            _state["source_health"][url]["consecutive_failures"] += 1
            _state["source_health"][url]["total_failures"] += 1


async def send_entry(entry, source_info, url, subscribed_chats,
                     module_interface):
    """发送 RSS 条目更新"""
    try:
        # 提取内容
        title = entry.get('title', '无标题')
        link = entry.get('link', '')
        published = entry.get('published', '')

        # 获取摘要内容，优先使用 content，然后是 summary，最后是 description
        content = ''
        if 'content' in entry and entry.content:
            # 有些源在 content 字段提供完整内容
            for content_item in entry.content:
                if 'value' in content_item:
                    content = content_item.value
                    break

        if not content and 'summary' in entry:
            content = entry.summary

        if not content and 'description' in entry:
            content = entry.description

        # 清理 HTML 标签，保留纯文本内容
        content = TextFormatter.strip_html(content)
        # 规范化空白字符，删除多余的空行和空格
        content = TextFormatter.normalize_whitespace(content)

        # 限制长度，保留前 200 个字符
        if len(content) > 200:
            content = content[:197] + "..."

        # 查找图片
        image_url = None

        # 尝试从 media:content 中获取图片
        if 'media_content' in entry and entry.media_content:
            for media in entry.media_content:
                if media.get('medium') == 'image' or media.get(
                        'type', '').startswith('image/'):
                    image_url = media.get('url')
                    break

        # 尝试从 enclosures 中获取图片
        if not image_url and 'enclosures' in entry and entry.enclosures:
            for enclosure in entry.enclosures:
                if enclosure.get('type', '').startswith('image/'):
                    image_url = enclosure.get('href') or enclosure.get('url')
                    break

        # 尝试从 content 中提取第一张图片
        if not image_url and entry.get('summary', ''):
            img_match = re.search(r'<img[^>]+src=[\'"]([^\'"]+)[\'"]',
                                  entry.get('summary', ''))
            if img_match:
                image_url = img_match.group(1)

        # 使用 HTML 格式发送消息
        safe_title = TextFormatter.escape_html(title)
        safe_content = TextFormatter.escape_html(content)
        source_title = source_info.get('title', url)
        safe_source_title = TextFormatter.escape_html(source_title)

        html_content = (f"<b>📰 {safe_title}</b>\n\n"
                        f"{safe_content}\n\n")

        if published:
            html_content += f"⏰ {published}\n"

        html_content += f"📚 来自: <b>{safe_source_title}</b>"

        # 创建链接按钮
        keyboard = None
        if link:
            keyboard = InlineKeyboardMarkup(
                [[InlineKeyboardButton("View Original", url=link)]])

        # 发送到所有订阅的聊天
        current_time = time.time()

        for chat_id, _ in subscribed_chats:
            # 检查是否需要添加延迟
            if str(chat_id) in _state.get("last_sent_time", {}):
                time_since_last = current_time - _state["last_sent_time"][str(
                    chat_id)]

                # 使用固定延迟，提供更一致的用户体验
                if time_since_last < 1:  # 如果距离上次发送不到1秒
                    # 短消息快速发送
                    delay = 3
                    module_interface.logger.debug(
                        f"为聊天 {chat_id} 添加 {delay} 秒延迟")
                    await asyncio.sleep(delay)
                    current_time = time.time()  # 更新当前时间
                elif time_since_last < 5:  # 如果距离上次发送不到5秒
                    # 中等延迟
                    delay = 2
                    module_interface.logger.debug(
                        f"为聊天 {chat_id} 添加 {delay} 秒延迟")
                    await asyncio.sleep(delay)
                    current_time = time.time()  # 更新当前时间

            # 记录本次发送时间
            if "last_sent_time" not in _state:
                _state["last_sent_time"] = {}
            _state["last_sent_time"][str(chat_id)] = current_time

            try:
                if image_url:
                    # 如果有图片，发送图片 + 文字
                    await module_interface.application.bot.send_photo(
                        chat_id=chat_id,
                        photo=image_url,
                        caption=html_content,
                        parse_mode="HTML",
                        reply_markup=keyboard)
                else:
                    # 否则只发送文字
                    await module_interface.application.bot.send_message(
                        chat_id=chat_id,
                        text=html_content,
                        parse_mode="HTML",
                        reply_markup=keyboard,
                        disable_web_page_preview=False  # 允许网页预览，可能会显示文章中的图片
                    )
            except Exception as e:
                # 如果发送失败（可能是图片无效），回退到纯文本
                try:
                    module_interface.logger.warning(f"发送图片消息失败，回退到纯文本: {e}")
                    await module_interface.application.bot.send_message(
                        chat_id=chat_id,
                        text=html_content,
                        parse_mode="HTML",
                        reply_markup=keyboard,
                        disable_web_page_preview=True)
                except Exception as text_error:
                    module_interface.logger.error(
                        f"向聊天 {chat_id} 发送 RSS 更新失败: {text_error}")

    except Exception as e:
        module_interface.logger.error(f"发送 RSS 条目时出错: {e}")


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    callback_query = update.callback_query
    data = callback_query.data
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否是 RSS 模块的回调
    if not data.startswith(CALLBACK_PREFIX):
        return

    # 在群组中检查用户是否为管理员
    if update.effective_chat.type != "private":
        # 使用 _check_permission 方法检查权限
        command_manager = _module_interface.command_manager
        if not await command_manager._check_permission("group_admin", update,
                                                       context):
            await callback_query.answer("⚠️ 只有管理员可以管理 RSS 订阅")
            return

    # 处理 PaginationHelper 的回调
    if data.startswith(f"{CALLBACK_PREFIX}list_page:") or data.startswith(
            f"{CALLBACK_PREFIX}health_page:"):
        try:
            # 解析回调数据
            parts = data.split(":")
            if len(parts) >= 2:
                prefix = parts[0]
                action = parts[1]

                # 处理页码选择
                if action == "select":
                    # 获取页面标题和解析模式
                    page_title = context.user_data.get("pagination_title",
                                                       "列表")
                    parse_mode = context.user_data.get("pagination_parse_mode",
                                                       "MARKDOWN")

                    # 显示页码选择界面
                    await PaginationHelper.show_page_selector(
                        update,
                        context,
                        prefix,
                        title=page_title,
                        parse_mode=parse_mode)
                    return
                elif action.startswith("goto_"):
                    # 处理页码跳转
                    try:
                        page_index = int(action.replace("goto_", ""))

                        if prefix == f"{CALLBACK_PREFIX}list_page":
                            # 更新上下文中的页码
                            context.user_data["rss_page_index"] = page_index
                            # 调用列表函数
                            await list_subscriptions(update, context)
                        elif prefix == f"{CALLBACK_PREFIX}health_page":
                            # 更新上下文中的页码
                            context.user_data[
                                "rss_health_page_index"] = page_index
                            # 调用健康状态函数
                            await rss_health_command(update, context)
                        return
                    except ValueError:
                        await callback_query.answer("无效的页码")
                        return
                else:
                    # 常规页面导航
                    try:
                        page_index = int(action)

                        if prefix == f"{CALLBACK_PREFIX}list_page":
                            # 更新上下文中的页码
                            context.user_data["rss_page_index"] = page_index
                            # 调用列表函数
                            await list_subscriptions(update, context)
                        elif prefix == f"{CALLBACK_PREFIX}health_page":
                            # 更新上下文中的页码
                            context.user_data[
                                "rss_health_page_index"] = page_index
                            # 调用健康状态函数
                            await rss_health_command(update, context)
                        return
                    except ValueError:
                        await callback_query.answer("无效的页码")
                        return
        except Exception as e:
            _module_interface.logger.error(f"处理分页回调时出错: {e}")
            await callback_query.answer("处理分页请求时出错")
            return

    # 提取操作
    parts = data.split('_')
    if len(parts) < 2:
        await callback_query.answer("无效的回调数据")
        return

    # 处理特殊情况：use_default_title
    if data.startswith(f"{CALLBACK_PREFIX}use_default_title"):
        action = "use_default_title"
    else:
        action = parts[1]

    # 处理不同的操作

    try:
        if action == "main":
            # 返回主菜单
            list_callback = f"{CALLBACK_PREFIX}list"
            add_callback = f"{CALLBACK_PREFIX}add"
            health_callback = f"{CALLBACK_PREFIX}health"

            keyboard = [[
                InlineKeyboardButton("Add", callback_data=add_callback),
                InlineKeyboardButton("List", callback_data=list_callback)
            ], [InlineKeyboardButton("Health", callback_data=health_callback)]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await callback_query.edit_message_text(
                "<b>📢 RSS 订阅管理</b>\n\n"
                "请选择要执行的操作：",
                reply_markup=reply_markup,
                parse_mode="HTML")
        elif action == "list":
            # 列出订阅
            await list_subscriptions(update, context)
        elif action == "add":
            # 添加订阅
            await add_subscription(update, context)
        elif action == "health":
            # 查看健康状态
            await rss_health_command(update, context)
        elif action == "cancel":
            # 取消当前操作
            session_manager = _module_interface.session_manager

            if session_manager:
                # 获取当前步骤
                step = await session_manager.get(user_id,
                                                 "rss_step",
                                                 None,
                                                 chat_id=chat_id)

                # 删除特定的会话键
                await session_manager.delete(user_id,
                                             "rss_step",
                                             chat_id=chat_id)
                await session_manager.delete(user_id,
                                             "rss_url",
                                             chat_id=chat_id)
                await session_manager.delete(user_id,
                                             "rss_feed_title",
                                             chat_id=chat_id)
                await session_manager.delete(user_id,
                                             "rss_subscriptions",
                                             chat_id=chat_id)

                # 释放会话
                await session_manager.release_session(user_id,
                                                      module_name=MODULE_NAME,
                                                      chat_id=chat_id)

                # 根据当前步骤决定返回到哪个页面
                if step == SESSION_REMOVE:
                    # 如果是从删除页面取消，返回列表页面
                    await list_subscriptions(update, context)
                else:
                    # 如果是从添加页面取消，返回主菜单
                    await rss_command(update, context)
            else:
                # 如果没有会话管理器，返回主菜单
                await rss_command(update, context)
        elif action == "use_default_title":
            # 使用默认标题
            session_manager = _module_interface.session_manager
            await handle_add_title(update,
                                   context,
                                   session_manager=session_manager)
        elif action == "remove":
            # 启动删除订阅会话
            session_manager = _module_interface.session_manager

            # 检查是否有其他模块的活跃会话
            if await session_manager.has_other_module_session(user_id,
                                                              MODULE_NAME,
                                                              chat_id=chat_id):
                await callback_query.answer("⚠️ 请先完成或取消其他活跃会话")
                return

            # 设置会话状态，等待用户输入要删除的序号
            await session_manager.set(user_id,
                                      "rss_step",
                                      SESSION_REMOVE,
                                      chat_id=chat_id,
                                      module_name=MODULE_NAME)

            # 获取当前聊天的订阅列表
            chat_id_str = str(update.effective_chat.id)
            chat_type = "private" if update.effective_chat.type == "private" else "group"
            subscriptions = _config["subscriptions"][chat_type].get(
                chat_id_str, [])

            # 保存订阅列表到会话
            await session_manager.set(user_id,
                                      "rss_subscriptions",
                                      subscriptions,
                                      chat_id=chat_id,
                                      module_name=MODULE_NAME)

            # 创建返回按钮
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}cancel")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            # 编辑消息，显示订阅列表并提示用户输入要删除的序号
            text = "<b>🗑️ 删除 RSS 订阅</b>\n\n"
            text += "当前订阅列表：\n"

            # 显示订阅列表
            for i, url in enumerate(subscriptions, 1):
                source_info = _config["sources"].get(url, {})
                title = source_info.get("title", url)
                # 使用 HTML 格式，避免转义问题
                safe_title = TextFormatter.escape_html(title)
                text += f"{i}. <b>{safe_title}</b>\n"

            text += "\n请输入要删除的订阅序号（1-" + str(len(subscriptions)) + "）\n"
            text += "可以输入多个序号，用空格分隔"

            await callback_query.edit_message_text(text,
                                                   reply_markup=reply_markup,
                                                   parse_mode="HTML")
        else:
            await callback_query.answer("未知操作")
    except Exception as e:
        _module_interface.logger.error(f"处理回调查询时出错: {e}")
        await callback_query.answer("处理请求时出错")


async def handle_remove_input(update: Update,
                              context: ContextTypes.DEFAULT_TYPE,
                              input_text: str,
                              session_manager=None):
    """处理用户输入的删除序号"""
    message = update.message
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id
    chat_id_str = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取保存的订阅列表
    subscriptions = await session_manager.get(user_id,
                                              "rss_subscriptions",
                                              None,
                                              chat_id=chat_id)
    if not subscriptions:
        await message.reply_text("⚠️ 会话已过期或没有订阅")

        # 清除会话状态
        await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "rss_subscriptions",
                                     chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)
        return

    # 解析输入的序号
    indices = []
    try:
        # 分割输入文本（支持空格分隔和换行分隔）
        parts = input_text.replace('\n', ' ').split()
        for part in parts:
            idx = int(part.strip())
            if 1 <= idx <= len(subscriptions):
                indices.append(idx - 1)  # 转换为 0-based 索引
            else:
                await message.reply_text(
                    f"⚠️ 无效的序号: {idx}，有效范围是 1-{len(subscriptions)}")
                return
    except ValueError:
        await message.reply_text("⚠️ 请输入有效的数字序号")
        return

    if not indices:
        await message.reply_text("⚠️ 未指定任何有效序号")
        return

    # 按照索引从大到小排序，以便从后往前删除，避免索引变化
    indices.sort(reverse=True)

    # 删除指定的订阅
    deleted_titles = []
    for idx in indices:
        url = subscriptions[idx]
        source_info = _config["sources"].get(url, {})
        title = source_info.get("title", url)
        deleted_titles.append(title)

        # 从订阅列表中删除
        if chat_id_str in _config["subscriptions"][
                chat_type] and url in _config["subscriptions"][chat_type][
                    chat_id_str]:
            _config["subscriptions"][chat_type][chat_id_str].remove(url)

        # 检查这个源是否还被其他聊天订阅
        still_subscribed = False
        for chat_type_key in ["private", "group"]:
            for _, urls in _config["subscriptions"][chat_type_key].items():
                if url in urls:
                    still_subscribed = True
                    break
            if still_subscribed:
                break

        # 如果没有其他订阅，清理源信息和状态
        if not still_subscribed:
            if url in _config["sources"]:
                del _config["sources"][url]
            if url in _state["last_check"]:
                del _state["last_check"][url]
            if url in _state["last_entry_ids"]:
                del _state["last_entry_ids"][url]
            if url in _state["update_timestamps"]:
                del _state["update_timestamps"][url]
            if url in _state["check_intervals"]:
                del _state["check_intervals"][url]
            if url in _state["source_health"]:
                del _state["source_health"][url]

    # 保存配置
    save_config()

    # 清除会话状态
    await session_manager.delete(user_id, "rss_step", chat_id=chat_id)
    await session_manager.delete(user_id, "rss_subscriptions", chat_id=chat_id)
    await session_manager.release_session(user_id,
                                          module_name=MODULE_NAME,
                                          chat_id=chat_id)

    # 创建返回按钮
    keyboard = [[
        InlineKeyboardButton("List", callback_data=f"{CALLBACK_PREFIX}list"),
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}main")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 显示成功消息
    text = f"✅ 成功删除 {len(indices)} 个 RSS 订阅:\n\n"
    for title in deleted_titles:
        safe_title = TextFormatter.escape_html(title)
        text += f"• <b>{safe_title}</b>\n"

    await message.reply_text(text,
                             reply_markup=reply_markup,
                             parse_mode="HTML")


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理用户消息（用于会话流程）"""

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id
    session_manager = _module_interface.session_manager

    if not session_manager:
        return

    # 检查是否是 RSS 模块的活动会话
    if not await session_manager.is_session_owned_by(
            user_id, MODULE_NAME, chat_id=chat_id):
        return

    # 获取当前步骤
    step = await session_manager.get(user_id,
                                     "rss_step",
                                     None,
                                     chat_id=chat_id)

    # 处理不同步骤的输入
    if step == SESSION_ADD_URL:
        # 处理 URL 输入
        url = update.message.text.strip()
        await handle_add_url(update, context, url, session_manager)
    elif step == SESSION_ADD_TITLE:
        # 处理标题输入
        title = update.message.text.strip()
        await handle_add_title(update, context, title, session_manager)
    elif step == SESSION_REMOVE:
        # 处理删除序号输入
        input_text = update.message.text.strip()
        await handle_remove_input(update, context, input_text, session_manager)


async def setup(interface):
    """模块初始化"""
    global _module_interface, _check_task

    # 记录模块接口
    _module_interface = interface

    # 加载配置
    load_config()

    # 加载状态（从框架的状态管理中加载）
    saved_state = interface.load_state(
        default={
            "last_check": {},
            "last_entry_ids": {},
            "last_sent_time": {},
            "update_timestamps": {},
            "check_intervals": {},
            "source_health": {}
        })

    # 更新状态
    if saved_state:
        _state.update(saved_state)

    # 注册命令 - 所有人可用，在群组中的权限检查将在命令处理函数中实现
    await interface.register_command("rss",
                                     rss_command,
                                     admin_level=False,
                                     description="管理 RSS 订阅")

    # 注册带权限验证的回调查询处理器 - 所有人可用，在群组中的权限检查将在回调处理函数中实现
    await interface.register_callback_handler(handle_callback_query,
                                              pattern=f"^{CALLBACK_PREFIX}",
                                              admin_level=False)
    interface.logger.debug("已注册回调查询处理器")

    # 注册消息处理器（用于会话流程）
    message_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/'),
        handle_message)
    await interface.register_handler(message_handler, group=6)

    # 创建启动任务，先初始化再启动检查
    await initialize_entry_ids(interface)
    _check_task = asyncio.create_task(check_updates(interface))

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理"""
    global _check_task

    # 取消检查任务
    if _check_task and not _check_task.done():
        _check_task.cancel()
        try:
            await _check_task
        except asyncio.CancelledError:
            interface.logger.debug("RSS 检查任务已取消")
            pass
        except Exception as e:
            interface.logger.error(f"RSS 检查任务取消时出错: {e}")

    # 保存状态到框架的状态管理中
    interface.save_state(_state)

    interface.logger.info(f"模块 {MODULE_NAME} 已清理完成")
