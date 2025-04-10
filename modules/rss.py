# modules/rss.py

import asyncio
import aiohttp
import feedparser
import os
import json
import re
import random
import time
from datetime import datetime
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import ContextTypes
from utils.decorators import error_handler
from utils.text_utils import TextUtils

# 模块元数据
MODULE_NAME = "rss"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "RSS 订阅，智能间隔和健康监控"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["rss"]

# 默认检查间隔配置
DEFAULT_MIN_INTERVAL = 60  # 最小检查间隔（秒）
DEFAULT_MAX_INTERVAL = 3600  # 最大检查间隔（秒）
DEFAULT_INTERVAL = 300  # 默认检查间隔（秒）
HEALTH_CHECK_THRESHOLD = 5  # 连续失败次数阈值
MAX_TIMESTAMPS = 10  # 保存的最大时间戳数量

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
CONFIG_FILE = "config/rss_subscriptions.json"

# 默认配置
DEFAULT_CONFIG = {
    "subscriptions": {
        "private": {},  # 用户 ID -> [订阅列表]
        "group": {}  # 群组 ID -> [订阅列表]
    },
    "sources": {}  # URL -> {title, description, ...}
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
@error_handler
async def rss_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """管理 RSS 订阅"""
    if not context.args:
        await show_help(update, context)
        return

    action = context.args[0].lower()

    if action == "list":
        await list_subscriptions(update, context)
    elif action == "add" and len(context.args) >= 2:
        await add_subscription(update, context)
    elif action == "remove" and len(context.args) >= 2:
        await remove_subscription(update, context)
    elif action == "health":
        await rss_health_command(update, context)
    else:
        await show_help(update, context)


async def show_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示帮助信息"""
    help_text = ("📢 *RSS 订阅管理*\n\n"
                 "可用命令：\n"
                 "• `/rss list` - 列出当前订阅\n"
                 "• `/rss add <url> [title]` - 添加订阅\n"
                 "• `/rss remove <url 或序号>` - 删除订阅\n"
                 "• `/rss health` - 查看源健康状态\n")
    await update.message.reply_text(help_text, parse_mode="Markdown")


async def list_subscriptions(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """列出当前订阅"""
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    subscriptions = _config["subscriptions"][chat_type].get(chat_id, [])

    if not subscriptions:
        await update.message.reply_text("⚠️ 当前没有 RSS 订阅。")
        return

    text = "📋 *RSS 订阅列表*\n\n"
    for i, url in enumerate(subscriptions, 1):
        source_info = _config["sources"].get(url, {})
        title = source_info.get("title", url)
        # 对标题和 URL 进行转义，防止 Markdown 解析错误
        title = TextUtils.escape_markdown(title)
        url = TextUtils.escape_markdown(url)
        text += f"{i}. *{title}*\n"
        text += f"   `{url}`\n\n"

    await update.message.reply_text(text, parse_mode="Markdown")


@error_handler
async def rss_health_command(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """查询 RSS 源健康状态"""
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    subscriptions = _config["subscriptions"][chat_type].get(chat_id, [])

    if not subscriptions:
        await update.message.reply_text("⚠️ 当前没有 RSS 订阅。")
        return

    text = "📊 <b>RSS 源健康状态</b>\n\n"

    for url in subscriptions:
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

        # 健康状态图标
        status_icon = "✅" if health_info["is_healthy"] else "⚠️"

        # 检查间隔
        interval = _state["check_intervals"].get(url, DEFAULT_INTERVAL)

        text += (f"{status_icon} <b>{source_title}</b>\n"
                 f"  • 状态: {'正常' if health_info['is_healthy'] else '异常'}\n"
                 f"  • 成功率: {success_rate}\n"
                 f"  • 最后成功: {last_success}\n"
                 f"  • 检查间隔: {interval:.0f} 秒\n\n")

    await update.message.reply_text(text, parse_mode="HTML")


async def add_subscription(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """添加订阅"""
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    url = context.args[1]
    custom_title = " ".join(context.args[2:]) if len(
        context.args) > 2 else None

    # 获取当前聊天的订阅
    if chat_id not in _config["subscriptions"][chat_type]:
        _config["subscriptions"][chat_type][chat_id] = []

    subscriptions = _config["subscriptions"][chat_type][chat_id]

    # 检查是否已订阅
    if url in subscriptions:
        await update.message.reply_text("⚠️ 已经订阅了该 RSS 源。")
        return

    # 验证并获取 RSS 源信息
    try:
        # 发送处理中消息
        processing_msg = await update.message.reply_text("🔍 正在验证 RSS 源...")

        feed = await fetch_feed(url)

        if not feed or not feed.get('entries'):
            await processing_msg.edit_text("❌ 无效的 RSS 源，请检查 URL 是否正确。")
            return

        # 添加到订阅
        subscriptions.append(url)

        # 添加源信息
        feed_title = feed.get('feed', {}).get('title', url)
        _config["sources"][url] = {
            "title": custom_title or feed_title,
            "description": feed.get('feed', {}).get('description', ''),
            "last_updated": datetime.now().isoformat()
        }

        # 记录最后检查时间和条目 ID
        _state["last_check"][url] = datetime.now().timestamp()
        if feed.get('entries'):
            _state["last_entry_ids"][url] = [
                entry.get('id', '') or entry.get('link', '')
                for entry in feed.get('entries')
            ]

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

        # 更新消息，显示成功添加
        success_text = (
            f"✅ 成功添加 RSS 订阅\n\n"
            f"📚 *{TextUtils.escape_markdown(_config['sources'][url]['title'])}*\n"
            f"🔗 `{TextUtils.escape_markdown(url)}`")
        await processing_msg.edit_text(success_text, parse_mode="Markdown")

        # 显示最新几条内容的预览
        preview_entries = feed.get('entries', [])[:3]  # 最多显示 3 条
        if preview_entries:
            preview_text = f"📋 *最新内容预览*\n\n"
            for entry in preview_entries:
                title = entry.get('title', '无标题')
                published = entry.get('published', '')

                preview_text += f"• *{TextUtils.escape_markdown(title)}*\n"
                if published:
                    preview_text += f"  ⏰ {TextUtils.escape_markdown(published)}\n"

            await update.message.reply_text(preview_text,
                                            parse_mode="Markdown")

    except Exception as e:
        await update.message.reply_text(f"❌ 添加 RSS 源失败: {str(e)}")


async def remove_subscription(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """删除订阅"""
    chat_id = str(update.effective_chat.id)
    chat_type = "private" if update.effective_chat.type == "private" else "group"

    # 获取当前聊天的订阅
    if chat_id not in _config["subscriptions"][chat_type]:
        await update.message.reply_text("⚠️ 当前没有 RSS 订阅。")
        return

    subscriptions = _config["subscriptions"][chat_type][chat_id]

    if not subscriptions:
        await update.message.reply_text("⚠️ 当前没有 RSS 订阅。")
        return

    # 处理参数（可以是 URL 或序号）
    arg = context.args[1]
    url_to_remove = None

    # 判断是序号还是 URL
    if arg.isdigit():
        index = int(arg) - 1
        if 0 <= index < len(subscriptions):
            url_to_remove = subscriptions[index]
        else:
            await update.message.reply_text("❌ 无效的序号，请使用 `/rss list` 查看可用的订阅。")
            return
    else:
        # 假设是 URL
        url_to_remove = arg

    # 移除订阅
    if url_to_remove in subscriptions:
        # 获取源标题
        source_title = _config["sources"].get(url_to_remove,
                                              {}).get("title", url_to_remove)

        subscriptions.remove(url_to_remove)

        # 检查这个源是否还被其他聊天订阅
        still_subscribed = False
        for chat_type_key in ["private", "group"]:
            for chat_id_key, urls in _config["subscriptions"][
                    chat_type_key].items():
                if url_to_remove in urls:
                    still_subscribed = True
                    break
            if still_subscribed:
                break

        # 如果没有其他订阅，清理源信息和状态
        if not still_subscribed:
            if url_to_remove in _config["sources"]:
                del _config["sources"][url_to_remove]
            if url_to_remove in _state["last_check"]:
                del _state["last_check"][url_to_remove]
            if url_to_remove in _state["last_entry_ids"]:
                del _state["last_entry_ids"][url_to_remove]
            if url_to_remove in _state["update_timestamps"]:
                del _state["update_timestamps"][url_to_remove]
            if url_to_remove in _state["check_intervals"]:
                del _state["check_intervals"][url_to_remove]
            if url_to_remove in _state["source_health"]:
                del _state["source_health"][url_to_remove]

        # 保存配置
        save_config()

        success_text = (f"✅ 成功删除 RSS 订阅\n\n"
                        f"📚 *{TextUtils.escape_markdown(source_title)}*")
        await update.message.reply_text(success_text, parse_mode="Markdown")
    else:
        await update.message.reply_text(
            "❌ 未找到该 RSS 订阅，请使用 `/rss list` 查看可用的订阅。")


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
    message = (
        f"⚠️ <b>RSS 源可能不可用</b>\n\n"
        f"RSS 源 <b>{source_title}</b> 连续 {HEALTH_CHECK_THRESHOLD} 次检查失败。\n"
        f"这可能是临时问题，也可能是源已经不再更新或地址变更。\n\n"
        f"如果问题持续存在，建议使用 <code>/rss remove</code> 命令取消订阅。")

    # 发送通知给所有订阅者
    for chat_id, _ in subscribed_chats:
        try:
            await module_interface.bot_engine.application.bot.send_message(
                chat_id=chat_id, text=message, parse_mode="HTML")
        except Exception as e:
            module_interface.logger.error(f"向聊天 {chat_id} 发送源健康警告失败: {e}")


async def notify_source_recovered(url, source_info, subscribed_chats,
                                  module_interface):
    """通知订阅者源已恢复"""
    source_title = source_info.get('title', url)
    message = (f"✅ <b>RSS 源已恢复</b>\n\n"
               f"之前报告有问题的 RSS 源 <b>{source_title}</b> 现在已经恢复正常。")

    # 发送通知给所有订阅者
    for chat_id, _ in subscribed_chats:
        try:
            await module_interface.bot_engine.application.bot.send_message(
                chat_id=chat_id, text=message, parse_mode="HTML")
        except Exception as e:
            module_interface.logger.error(f"向聊天 {chat_id} 发送源恢复通知失败: {e}")


async def check_updates(module_interface):
    """定期检查 RSS 更新"""
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


async def check_feed(url, source_info, module_interface):
    """检查单个 RSS 源的更新"""
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
                    # 检查模块是否在该聊天中启用
                    if module_interface.config_manager.is_module_enabled_for_chat(
                            MODULE_NAME, chat_id):
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

        # 判断是否是首次检查
        is_first_check = not last_entry_ids

        # 找出新条目
        new_entries = []
        new_entry_ids = []

        for entry in feed.get('entries', []):
            entry_id = entry.get('id', '')
            if not entry_id:
                entry_id = entry.get('link', '')

            if entry_id and entry_id not in last_entry_ids:
                new_entries.append(entry)
                new_entry_ids.append(entry_id)

        # 更新最后条目 ID（最多保存 50 个 ID 防止过大）
        _state["last_entry_ids"][url] = (new_entry_ids + last_entry_ids)[:50]

        # 如果是首次检查，不发送任何通知，只记录条目 ID
        if is_first_check:
            module_interface.logger.info(
                f"首次检查源 '{source_info.get('title', url)}'，记录 {len(new_entry_ids)} 个条目 ID 但不发送通知"
            )
            new_entries = []  # 清空新条目列表，防止发送

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
                # 计算平均更新间隔
                timestamps = _state["update_timestamps"][url]
                intervals = [
                    timestamps[i] - timestamps[i - 1]
                    for i in range(1, len(timestamps))
                ]
                avg_interval = sum(intervals) / len(intervals)

                # 将检查间隔设为平均更新间隔的一半，但有上下限
                new_interval = max(DEFAULT_MIN_INTERVAL,
                                   min(DEFAULT_MAX_INTERVAL, avg_interval / 2))
                _state["check_intervals"][url] = new_interval

                module_interface.logger.info(
                    f"源 '{source_info.get('title', url)}' 的检查间隔已调整为 {new_interval:.0f} 秒"
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
        content = TextUtils.strip_html(content)
        # 规范化空白字符，删除多余的空行和空格
        content = TextUtils.normalize_whitespace(content)

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
        html_content = (f"<b>📰 {title}</b>\n\n"
                        f"{content}\n\n")

        if published:
            html_content += f"⏰ {published}\n"

        source_title = source_info.get('title', url)
        html_content += f"📚 来自: <b>{source_title}</b>"

        # 创建链接按钮
        keyboard = None
        if link:
            keyboard = InlineKeyboardMarkup(
                [[InlineKeyboardButton("🔗 查看原文", url=link)]])

        # 发送到所有订阅的聊天
        current_time = time.time()

        for chat_id, chat_type in subscribed_chats:
            # chat_id 已经在 check_feed 函数中转换为整数
            # 再次检查模块是否在该聊天中启用（可能在处理过程中被禁用）
            if not module_interface.config_manager.is_module_enabled_for_chat(
                    MODULE_NAME, chat_id):
                continue

            # 检查是否需要添加延迟
            if str(chat_id) in _state.get("last_sent_time", {}):
                time_since_last = current_time - _state["last_sent_time"][str(
                    chat_id)]
                if time_since_last < 5:  # 如果距离上次发送不到 5 秒
                    # 添加 5-10 秒的随机延迟
                    delay = 5 + random.random() * 5
                    module_interface.logger.debug(
                        f"为聊天 {chat_id} 添加 {delay:.2f} 秒延迟")
                    await asyncio.sleep(delay)
                    current_time = time.time()  # 更新当前时间

            # 记录本次发送时间
            if "last_sent_time" not in _state:
                _state["last_sent_time"] = {}
            _state["last_sent_time"][str(chat_id)] = current_time

            try:
                if image_url:
                    # 如果有图片，发送图片 + 文字
                    await module_interface.bot_engine.application.bot.send_photo(
                        chat_id=chat_id,
                        photo=image_url,
                        caption=html_content,
                        parse_mode="HTML",
                        reply_markup=keyboard)
                else:
                    # 否则只发送文字
                    await module_interface.bot_engine.application.bot.send_message(
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
                    await module_interface.bot_engine.application.bot.send_message(
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
    global _check_task, _module_interface

    # 记录模块接口
    _module_interface = module_interface

    # 加载配置
    load_config()

    # 加载状态
    saved_state = module_interface.load_state(
        default={
            "last_check": {},
            "last_entry_ids": {},
            "last_sent_time": {},
            "update_timestamps": {},
            "check_intervals": {},
            "source_health": {}
        })

    # 确保所有必需的状态字段都存在
    for key in [
            "last_check", "last_entry_ids", "last_sent_time",
            "update_timestamps", "check_intervals", "source_health"
    ]:
        if key not in saved_state:
            saved_state[key] = {}

    global _state
    _state = saved_state

    # 注册命令，在群组中只允许管理员使用
    module_interface.register_command("rss",
                                      rss_command,
                                      admin_only="group_admin")

    # 启动检查任务
    _check_task = asyncio.create_task(check_updates(module_interface))

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


def cleanup(module_interface):
    """模块清理"""
    global _check_task

    # 取消检查任务
    if _check_task and not _check_task.done():
        _check_task.cancel()

    # 保存状态
    module_interface.save_state(_state)

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
