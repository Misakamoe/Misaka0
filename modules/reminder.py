# modules/reminder.py
import asyncio
import json
import os
import time
from datetime import datetime, timedelta
import re
import pytz
from telegram import Update
from telegram.ext import CommandHandler, ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "reminder"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "定时提醒功能，支持创建、管理和删除提醒，包括周期性和一次性提醒"
MODULE_DEPENDENCIES = []

# 存储添加的处理器，用于清理
_handlers = []
# 存储活跃的提醒任务
_reminder_tasks = {}
# 存储提醒数据的文件路径
_data_file = "config/reminders.json"
# 最小提醒间隔（秒）
MIN_INTERVAL = 10
# 默认时区
DEFAULT_TIMEZONE = 'Asia/Shanghai'


def load_reminders():
    """从文件加载提醒数据"""
    if not os.path.exists(_data_file):
        return {}

    try:
        with open(_data_file, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        print(f"加载提醒数据失败: {e}")
        return {}


def save_reminders(reminders):
    """保存提醒数据到文件"""
    os.makedirs(os.path.dirname(_data_file), exist_ok=True)

    try:
        with open(_data_file, 'w', encoding='utf-8') as f:
            json.dump(reminders, f, indent=4, ensure_ascii=False)
    except Exception as e:
        print(f"保存提醒数据失败: {e}")


def parse_interval(interval_str):
    """解析时间间隔字符串为秒数"""
    # 匹配中文格式: "10分钟", "1小时", "2天", "3周", "1月", "2年"
    pattern_cn = r"(\d+)\s*(分钟|小时|天|周|月|年)"
    match_cn = re.match(pattern_cn, interval_str)

    if match_cn:
        value = int(match_cn.group(1))
        unit = match_cn.group(2)

        # 转换为秒
        seconds_map_cn = {
            "分钟": 60,
            "小时": 3600,
            "天": 86400,
            "周": 604800,
            "月": 2592000,  # 30 天近似值
            "年": 31536000  # 365 天近似值
        }

        if unit in seconds_map_cn:
            return value * seconds_map_cn[unit]

    # 匹配英文缩写格式: "10s", "5min", "2h", "1d", "1w", "1M", "1y"
    pattern_en = r"(\d+)\s*(s|sec|min|h|hr|d|day|w|week|m|mon|y|year)"
    match_en = re.match(pattern_en, interval_str, re.IGNORECASE)

    if match_en:
        value = int(match_en.group(1))
        unit = match_en.group(2).lower()

        # 转换为秒
        seconds_map_en = {
            "s": 1,
            "sec": 1,
            "min": 60,
            "h": 3600,
            "hr": 3600,
            "d": 86400,
            "day": 86400,
            "w": 604800,
            "week": 604800,
            "m": 2592000,
            "mon": 2592000,
            "y": 31536000,
            "year": 31536000
        }

        if unit in seconds_map_en:
            return value * seconds_map_en[unit]

    return None


def parse_datetime(datetime_str):
    """解析日期时间字符串为 datetime 对象"""
    # 尝试多种常见日期时间格式
    formats = [
        # 中文格式
        '%Y年%m月%d日 %H:%M',
        '%Y年%m月%d日 %H:%M:%S',
        '%Y年%m月%d日%H:%M',
        '%Y年%m月%d日%H:%M:%S',
        '%m月%d日 %H:%M',
        '%m月%d日 %H:%M:%S',
        '%m月%d日%H:%M',
        '%m月%d日%H:%M:%S',

        # 英文格式
        '%Y-%m-%d %H:%M',
        '%Y-%m-%d %H:%M:%S',
        '%Y/%m/%d %H:%M',
        '%Y/%m/%d %H:%M:%S',
        '%d-%m-%Y %H:%M',
        '%d-%m-%Y %H:%M:%S',
        '%d/%m/%Y %H:%M',
        '%d/%m/%Y %H:%M:%S',

        # 简化格式
        '%Y%m%d %H:%M',
        '%Y%m%d %H:%M:%S',
        '%Y%m%d%H%M',
        '%Y%m%d%H%M%S',

        # 只有时间
        '%H:%M',
        '%H:%M:%S'
    ]

    # 获取当前时区的当前时间
    now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))

    for fmt in formats:
        try:
            # 尝试解析
            dt = datetime.strptime(datetime_str, fmt)

            # 如果只有时间没有日期，假设是今天或明天
            if fmt in ['%H:%M', '%H:%M:%S']:
                dt = dt.replace(year=now.year, month=now.month, day=now.day)
                # 如果时间已经过去，则假设是明天
                dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)
                if dt_with_tz < now:
                    dt = dt + timedelta(days=1)

            # 添加时区信息
            dt = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)
            return dt
        except ValueError:
            continue

    return None


def format_interval(seconds):
    """将秒数格式化为可读的时间间隔"""
    if seconds < 60:
        return f"{seconds} 秒"
    elif seconds < 3600:
        return f"{seconds // 60} 分钟"
    elif seconds < 86400:
        return f"{seconds // 3600} 小时"
    elif seconds < 604800:
        return f"{seconds // 86400} 天"
    elif seconds < 2592000:
        return f"{seconds // 604800} 周"
    elif seconds < 31536000:
        return f"{seconds // 2592000} 月"
    else:
        return f"{seconds // 31536000} 年"


async def reminder_loop(context, chat_id, reminder_id):
    """周期性提醒循环任务"""
    reminders = load_reminders()
    reminder_key = str(chat_id)

    if reminder_key not in reminders or reminder_id not in reminders[
            reminder_key]:
        return

    reminder = reminders[reminder_key][reminder_id]
    interval = reminder["interval"]

    # 设置一个标志，表示任务正在运行
    reminders[reminder_key][reminder_id]["task_running"] = True
    save_reminders(reminders)

    try:
        while True:
            # 等待指定的时间间隔
            await asyncio.sleep(interval)

            # 重新加载数据以获取最新状态
            reminders = load_reminders()
            if reminder_key not in reminders or reminder_id not in reminders[
                    reminder_key]:
                break

            reminder = reminders[reminder_key][reminder_id]

            # 检查是否已禁用
            if not reminder.get("enabled", True):
                continue

            # 发送提醒消息
            await context.bot.send_message(
                chat_id=chat_id,  # 使用保存的 chat_id
                text=f"⏰ *提醒*\n\n{reminder['message']}",
                parse_mode="MARKDOWN")

            # 更新最后提醒时间
            reminders[reminder_key][reminder_id]["last_reminded"] = time.time()
            save_reminders(reminders)

    except asyncio.CancelledError:
        # 任务被取消
        pass
    except Exception as e:
        print(f"提醒任务出错: {e}")
    finally:
        # 确保在任务结束时更新状态
        try:
            reminders = load_reminders()
            if reminder_key in reminders and reminder_id in reminders[
                    reminder_key]:
                reminders[reminder_key][reminder_id]["task_running"] = False
                save_reminders(reminders)
        except Exception:
            pass


async def one_time_reminder(context, chat_id, reminder_id):
    """一次性提醒任务"""
    reminders = load_reminders()
    reminder_key = str(chat_id)

    if reminder_key not in reminders or reminder_id not in reminders[
            reminder_key]:
        return

    reminder = reminders[reminder_key][reminder_id]
    target_time = reminder["target_time"]

    # 设置一个标志，表示任务正在运行
    reminders[reminder_key][reminder_id]["task_running"] = True
    save_reminders(reminders)

    try:
        # 计算等待时间
        now = time.time()
        wait_time = target_time - now

        if wait_time > 0:
            # 等待直到目标时间
            await asyncio.sleep(wait_time)

            # 重新加载数据以获取最新状态
            reminders = load_reminders()
            if reminder_key not in reminders or reminder_id not in reminders[
                    reminder_key]:
                return

            reminder = reminders[reminder_key][reminder_id]

            # 检查是否已禁用
            if not reminder.get("enabled", True):
                return

            # 发送提醒消息
            await context.bot.send_message(
                chat_id=chat_id,
                text=f"⏰ *定时提醒*\n\n{reminder['message']}",
                parse_mode="MARKDOWN")

            # 自动删除已完成的一次性提醒
            reminders = load_reminders()
            if reminder_key in reminders and reminder_id in reminders[
                    reminder_key]:
                del reminders[reminder_key][reminder_id]
                save_reminders(reminders)

    except asyncio.CancelledError:
        # 任务被取消
        pass
    except Exception as e:
        print(f"一次性提醒任务出错: {e}")
    finally:
        # 确保在任务结束时更新状态（如果任务还存在）
        try:
            reminders = load_reminders()
            if reminder_key in reminders and reminder_id in reminders[
                    reminder_key]:
                reminders[reminder_key][reminder_id]["task_running"] = False
                save_reminders(reminders)
        except Exception:
            pass


def start_reminder_tasks(application):
    """启动所有提醒任务"""
    reminders = load_reminders()

    for chat_id_str, chat_reminders in reminders.items():
        for reminder_id, reminder in chat_reminders.items():
            if not reminder.get("enabled", True):
                continue

            # 标记任务为运行中
            reminder["task_running"] = True

            # 根据提醒类型启动不同的任务
            if reminder.get("type") == "one_time":
                # 检查是否已经过期或已提醒
                if reminder.get(
                        "reminded",
                        False) or reminder["target_time"] < time.time():
                    reminder["task_running"] = False
                    continue

                task = asyncio.create_task(
                    one_time_reminder(application, int(chat_id_str),
                                      reminder_id))
            else:  # 周期性提醒
                task = asyncio.create_task(
                    reminder_loop(application, int(chat_id_str), reminder_id))

            _reminder_tasks[(chat_id_str, reminder_id)] = task

    # 保存更新的状态
    save_reminders(reminders)


def stop_reminder_tasks():
    """停止所有提醒任务"""
    reminders = load_reminders()

    # 取消所有任务
    for (chat_id, reminder_id), task in _reminder_tasks.items():
        task.cancel()
        # 更新任务状态
        if chat_id in reminders and reminder_id in reminders[chat_id]:
            reminders[chat_id][reminder_id]["task_running"] = False

    _reminder_tasks.clear()

    # 保存更新的状态
    save_reminders(reminders)


async def remind_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /remind 命令 - 创建周期性提醒或显示帮助"""
    # 如果没有参数，显示帮助信息
    if not context.args or len(context.args) < 2:
        help_text = ("📅 *提醒功能帮助*\n\n"
                     "*创建周期性提醒:*\n"
                     "/remind 间隔 内容\n"
                     "例如: `/remind 30min 该喝水了！`\n\n"
                     "*创建一次性提醒:*\n"
                     "/remindonce 时间 内容\n"
                     "例如: `/remindonce 8:30 晨会！`\n"
                     "或: `/remindonce 2025年4月5日18:30 提交报告！`\n\n"
                     "*查看提醒:*\n"
                     "/reminders - 列出所有提醒\n\n"
                     "*删除提醒:*\n"
                     "/delreminder ID - 删除指定 ID 的提醒\n\n"
                     "*支持的时间间隔:*\n"
                     "- 中文: 分钟, 小时, 天, 周, 月, 年\n"
                     "- 英文: s/sec, min, h/hr, d/day, w/week, m/mon, y/year\n\n"
                     "*支持的日期时间格式:*\n"
                     "- 中文: 2025年4月5日18:30\n"
                     "- 英文: 2025-04-05 18:30\n"
                     "- 简化: 只有时间 18:30 (今天或明天)\n\n"
                     "*示例:*\n"
                     "- `/remind 1h 该锻炼了！`\n"
                     "- `/remind 1天 该写周报了！`\n"
                     "- `/remindonce 8:30 晨会！`")

        await update.message.reply_text(help_text, parse_mode="MARKDOWN")
        return

    # 解析参数
    interval_str = context.args[0]
    message = " ".join(context.args[1:])

    # 解析时间间隔
    interval_seconds = parse_interval(interval_str)
    if interval_seconds is None:
        await update.message.reply_text(
            "无法识别的时间格式，请使用如:\n"
            "- 中文: 分钟、小时、天、周、月、年\n"
            "- 英文: s/sec, min, h/hr, d/day, w/week, m/mon, y/year")
        return

    # 检查最小间隔
    if interval_seconds < MIN_INTERVAL:
        await update.message.reply_text(f"提醒间隔太短，最小间隔为 {MIN_INTERVAL} 秒。")
        return

    # 生成提醒 ID 和标题
    reminder_id = str(int(time.time()))
    # 使用消息的前几个字作为标题
    title = message[:15] + "..." if len(message) > 15 else message

    # 保存到持久化存储
    reminders = load_reminders()

    # 使用 chat_id 而不是 user_id 作为键
    chat_id = str(update.effective_chat.id)

    if chat_id not in reminders:
        reminders[chat_id] = {}

    reminders[chat_id][reminder_id] = {
        "id": reminder_id,
        "title": title,
        "type": "periodic",  # 标记为周期性提醒
        "interval": interval_seconds,
        "message": message,
        "created_at": time.time(),
        "enabled": True,
        "task_running": False,  # 初始状态为未运行
        "creator_id": update.effective_user.id,  # 保存创建者 ID
        "creator_name": update.effective_user.full_name
        or update.effective_user.username,  # 保存创建者名称
        "chat_id": chat_id,  # 保存聊天 ID
        "chat_type": update.effective_chat.type  # 保存聊天类型
    }

    save_reminders(reminders)

    # 启动提醒任务
    task = asyncio.create_task(
        reminder_loop(context, update.effective_chat.id, reminder_id))
    _reminder_tasks[(chat_id, reminder_id)] = task

    # 更新任务状态
    reminders[chat_id][reminder_id]["task_running"] = True
    save_reminders(reminders)

    # 格式化时间间隔
    interval_text = format_interval(interval_seconds)

    # 发送确认消息
    await update.message.reply_text(
        f"✅ 周期性提醒已创建!\n\n"
        f"⏰ *间隔:* {interval_text}\n"
        f"📝 *内容:* {message}\n"
        f"🆔 *提醒 ID:* `{reminder_id}`\n\n"
        f"每 {interval_text} 我会发送一次提醒。\n"
        f"如需删除，请使用 `/delreminder {reminder_id}`",
        parse_mode="MARKDOWN")


async def remind_once_command(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """处理 /remindonce 命令 - 创建一次性提醒"""
    if not context.args or len(context.args) < 2:
        await update.message.reply_text(
            "用法: /remindonce 时间 内容\n"
            "例如: `/remindonce 8:30 晨会！`\n"
            "或: `/remindonce 2025年4月5日18:30 提交报告！`",
            parse_mode="MARKDOWN")
        return

    # 解析参数
    datetime_str = context.args[0]
    message = " ".join(context.args[1:])

    # 解析日期时间
    target_datetime = parse_datetime(datetime_str)
    if target_datetime is None:
        await update.message.reply_text("无法识别的时间格式，请使用如:\n"
                                        "- 2025年4月5日18:30\n"
                                        "- 2025-04-05 18:30\n"
                                        "- 18:30 (今天或明天)")
        return

    # 转换为时间戳
    target_timestamp = target_datetime.timestamp()

    # 检查是否是过去的时间
    now = time.time()
    if target_timestamp <= now:
        await update.message.reply_text("提醒时间不能是过去的时间。")
        return

    # 生成提醒 ID 和标题
    reminder_id = str(int(time.time()))
    # 使用消息的前几个字作为标题
    title = message[:15] + "..." if len(message) > 15 else message

    # 保存到持久化存储
    reminders = load_reminders()
    chat_id = str(update.effective_chat.id)

    if chat_id not in reminders:
        reminders[chat_id] = {}

    reminders[chat_id][reminder_id] = {
        "id": reminder_id,
        "title": title,
        "type": "one_time",  # 标记为一次性提醒
        "target_time": target_timestamp,
        "target_time_str": target_datetime.strftime("%Y-%m-%d %H:%M:%S"),
        "message": message,
        "created_at": time.time(),
        "enabled": True,
        "reminded": False,  # 是否已提醒
        "task_running": False,
        "creator_id": update.effective_user.id,
        "creator_name": update.effective_user.full_name
        or update.effective_user.username,
        "chat_id": chat_id,
        "chat_type": update.effective_chat.type
    }

    save_reminders(reminders)

    # 启动提醒任务
    task = asyncio.create_task(
        one_time_reminder(context, update.effective_chat.id, reminder_id))
    _reminder_tasks[(chat_id, reminder_id)] = task

    # 更新任务状态
    reminders[chat_id][reminder_id]["task_running"] = True
    save_reminders(reminders)

    # 计算等待时间
    wait_seconds = target_timestamp - now
    wait_text = format_interval(int(wait_seconds))

    # 发送确认消息
    await update.message.reply_text(
        f"✅ 一次性提醒已创建!\n\n"
        f"⏰ *时间:* {target_datetime.strftime('%Y-%m-%d %H:%M:%S')}\n"
        f"⏳ *等待:* {wait_text}\n"
        f"📝 *内容:* {message}\n"
        f"🆔 *提醒 ID:* `{reminder_id}`\n\n"
        f"到时间我会发送一次提醒。\n"
        f"如需删除，请使用 `/delreminder {reminder_id}`",
        parse_mode="MARKDOWN")


async def list_reminders(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """列出所有提醒"""
    reminders = load_reminders()
    chat_id = str(update.effective_chat.id)

    if chat_id not in reminders or not reminders[chat_id]:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    message = "📋 *当前聊天的提醒列表:*\n\n"

    # 分类存储提醒
    one_time_reminders = []
    periodic_reminders = []

    for reminder_id, reminder in reminders[chat_id].items():
        # 跳过已完成的一次性提醒（实际上应该已经被删除了）
        if reminder.get("type") == "one_time" and reminder.get(
                "reminded", False):
            continue

        if reminder.get("type") == "one_time":
            one_time_reminders.append((reminder_id, reminder))
        else:
            periodic_reminders.append((reminder_id, reminder))

    # 先显示一次性提醒
    if one_time_reminders:
        message += "*一次性提醒:*\n"
        for reminder_id, reminder in one_time_reminders:
            status = "✅ 已启用" if reminder.get("enabled", True) else "❌ 已禁用"
            target_time = reminder.get("target_time_str", "未知时间")
            creator_info = f" (由 {reminder.get('creator_name', '未知用户')} 创建)" if update.effective_chat.type != "private" else ""

            message += (f"🔹 *{reminder['title']}*{creator_info}\n"
                        f"  🆔 ID: `{reminder_id}`\n"
                        f"  ⏰ 时间: {target_time}\n"
                        f"  📝 内容: {reminder['message']}\n"
                        f"  🔄 状态: {status}\n\n")

    # 再显示周期性提醒
    if periodic_reminders:
        message += "*周期性提醒:*\n"
        for reminder_id, reminder in periodic_reminders:
            status = "✅ 已启用" if reminder.get("enabled", True) else "❌ 已禁用"
            interval_text = format_interval(reminder["interval"])
            creator_info = f" (由 {reminder.get('creator_name', '未知用户')} 创建)" if update.effective_chat.type != "private" else ""

            message += (f"🔹 *{reminder['title']}*{creator_info}\n"
                        f"  🆔 ID: `{reminder_id}`\n"
                        f"  ⏰ 间隔: {interval_text}\n"
                        f"  📝 内容: {reminder['message']}\n"
                        f"  🔄 状态: {status}\n\n")

    # 如果没有任何提醒可显示
    if not one_time_reminders and not periodic_reminders:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    message += "要删除提醒，请使用 `/delreminder ID`"

    await update.message.reply_text(message, parse_mode="MARKDOWN")


async def delete_reminder(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """删除提醒"""
    if not context.args or len(context.args) < 1:
        await update.message.reply_text("用法: /delreminder ID")
        return

    reminder_id = context.args[0]
    reminders = load_reminders()
    chat_id = str(update.effective_chat.id)

    if chat_id not in reminders or reminder_id not in reminders[chat_id]:
        await update.message.reply_text("找不到该提醒或已被删除。")
        return

    # 在群组中，检查是否有权限删除（管理员或创建者可以删除）
    reminder = reminders[chat_id][reminder_id]
    if update.effective_chat.type != "private":
        # 获取用户在群组中的状态
        user_id = update.effective_user.id
        chat_member = await context.bot.get_chat_member(
            update.effective_chat.id, user_id)
        is_admin = chat_member.status in ["creator", "administrator"]

        # 如果不是管理员且不是创建者，则无权删除
        if not is_admin and reminder.get("creator_id") != user_id:
            await update.message.reply_text("您没有权限删除此提醒，只有提醒创建者或群组管理员可以删除。")
            return

    # 取消任务
    if (chat_id, reminder_id) in _reminder_tasks:
        _reminder_tasks[(chat_id, reminder_id)].cancel()
        del _reminder_tasks[(chat_id, reminder_id)]

    # 删除数据
    reminder_title = reminders[chat_id][reminder_id]["title"]
    del reminders[chat_id][reminder_id]
    save_reminders(reminders)

    await update.message.reply_text(f"✅ 提醒 \"{reminder_title}\" 已删除。")


def setup(application, bot):
    """模块初始化"""
    global _handlers

    # 添加命令处理器
    remind_handler = CommandHandler("remind", remind_command)
    remind_once_handler = CommandHandler("remindonce", remind_once_command)
    list_handler = CommandHandler("reminders", list_reminders)
    delete_handler = CommandHandler("delreminder", delete_reminder)

    application.add_handler(remind_handler)
    application.add_handler(remind_once_handler)
    application.add_handler(list_handler)
    application.add_handler(delete_handler)

    _handlers.extend([(remind_handler, 0), (remind_once_handler, 0),
                      (list_handler, 0), (delete_handler, 0)])

    # 启动提醒任务
    start_reminder_tasks(application)

    print(f"已注册提醒模块")


def cleanup(application, bot):
    """模块清理"""
    global _handlers

    # 停止所有提醒任务
    stop_reminder_tasks()

    # 移除所有添加的处理器
    for handler, group in _handlers:
        try:
            application.remove_handler(handler, group)
            print(f"已移除提醒处理器")
        except Exception as e:
            print(f"移除处理器失败: {e}")

    # 清空处理器列表
    _handlers = []
