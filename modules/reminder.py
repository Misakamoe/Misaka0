# modules/reminder.py
import asyncio
import json
import os
import time
from datetime import datetime, timedelta
import re
import pytz
from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters
from utils.decorators import error_handler, permission_check

# 模块元数据
MODULE_NAME = "reminder"
MODULE_VERSION = "1.2.0"
MODULE_DESCRIPTION = "定时提醒功能，包括周期性和一次性提醒"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["remind", "remindonce", "reminders",
                   "delreminder"]  # 声明此模块包含的命令

# 存储活跃的提醒任务
_reminder_tasks = {}
# 存储提醒数据的文件路径
_data_file = "config/reminders.json"
# 最小提醒间隔（秒）
MIN_INTERVAL = 10
# 默认时区
DEFAULT_TIMEZONE = 'Asia/Hong_Kong'


class ReminderBase:
    """提醒基类"""

    def __init__(self,
                 reminder_id,
                 message,
                 creator_id,
                 creator_name,
                 chat_id,
                 chat_type,
                 title=None):
        self.id = reminder_id
        self.message = message
        self.creator_id = creator_id
        self.creator_name = creator_name
        self.chat_id = chat_id
        self.chat_type = chat_type
        self.created_at = time.time()
        self.enabled = True
        self.task_running = False
        self.title = title or (message[:15] +
                               "..." if len(message) > 15 else message)

    def to_dict(self):
        """转换为字典用于保存"""
        return {
            "id": self.id,
            "title": self.title,
            "message": self.message,
            "creator_id": self.creator_id,
            "creator_name": self.creator_name,
            "chat_id": self.chat_id,
            "chat_type": self.chat_type,
            "created_at": self.created_at,
            "enabled": self.enabled,
            "task_running": self.task_running
        }

    async def send_reminder(self, context):
        """发送提醒消息"""
        if not self.enabled:
            return

        try:
            await context.bot.send_message(chat_id=self.chat_id,
                                           text=f"⏰ *提醒*\n\n{self.message}",
                                           parse_mode="MARKDOWN")
        except Exception as e:
            print(f"发送提醒消息失败: {e}")

    @classmethod
    def from_dict(cls, data):
        """从字典创建提醒"""
        raise NotImplementedError("子类必须实现此方法")

    async def start_task(self, context):
        """启动提醒任务"""
        raise NotImplementedError("子类必须实现此方法")


class PeriodicReminder(ReminderBase):
    """周期性提醒"""

    def __init__(self,
                 reminder_id,
                 message,
                 creator_id,
                 creator_name,
                 chat_id,
                 chat_type,
                 interval,
                 title=None):
        super().__init__(reminder_id, message, creator_id, creator_name,
                         chat_id, chat_type, title)
        self.interval = interval
        self.last_reminded = None
        self.type = "periodic"

    def to_dict(self):
        """转换为字典用于保存"""
        data = super().to_dict()
        data.update({
            "type": "periodic",
            "interval": self.interval,
            "last_reminded": self.last_reminded
        })
        return data

    @classmethod
    def from_dict(cls, data):
        """从字典创建提醒"""
        reminder = cls(data["id"], data["message"], data["creator_id"],
                       data.get("creator_name", "未知用户"),
                       data.get("chat_id", "unknown"),
                       data.get("chat_type", "unknown"), data["interval"],
                       data.get("title"))
        reminder.created_at = data.get("created_at", time.time())
        reminder.enabled = data.get("enabled", True)
        reminder.task_running = data.get("task_running", False)
        reminder.last_reminded = data.get("last_reminded")
        return reminder

    async def start_task(self, context):
        """启动周期性提醒任务"""
        self.task_running = True
        save_reminders()

        try:
            while True:
                # 等待指定的时间间隔
                await asyncio.sleep(self.interval)

                # 重新加载数据以获取最新状态
                reminder_data = get_reminder(self.chat_id, self.id)
                if not reminder_data:
                    break

                # 更新状态
                self.enabled = reminder_data.get("enabled", True)

                # 发送提醒
                await self.send_reminder(context)

                # 更新最后提醒时间
                self.last_reminded = time.time()
                save_reminders()

        except asyncio.CancelledError:
            # 任务被取消
            pass
        except Exception as e:
            print(f"周期性提醒任务出错: {e}")
        finally:
            # 确保在任务结束时更新状态
            self.task_running = False
            save_reminders()


class OneTimeReminder(ReminderBase):
    """一次性提醒"""

    def __init__(self,
                 reminder_id,
                 message,
                 creator_id,
                 creator_name,
                 chat_id,
                 chat_type,
                 target_time,
                 target_time_str,
                 title=None):
        super().__init__(reminder_id, message, creator_id, creator_name,
                         chat_id, chat_type, title)
        self.target_time = target_time
        self.target_time_str = target_time_str
        self.reminded = False
        self.type = "one_time"

    def to_dict(self):
        """转换为字典用于保存"""
        data = super().to_dict()
        data.update({
            "type": "one_time",
            "target_time": self.target_time,
            "target_time_str": self.target_time_str,
            "reminded": self.reminded
        })
        return data

    @classmethod
    def from_dict(cls, data):
        """从字典创建提醒"""
        reminder = cls(data["id"], data["message"], data["creator_id"],
                       data.get("creator_name", "未知用户"),
                       data.get("chat_id", "unknown"),
                       data.get("chat_type", "unknown"), data["target_time"],
                       data.get("target_time_str", "未知时间"), data.get("title"))
        reminder.created_at = data.get("created_at", time.time())
        reminder.enabled = data.get("enabled", True)
        reminder.task_running = data.get("task_running", False)
        reminder.reminded = data.get("reminded", False)
        return reminder

    async def start_task(self, context):
        """启动一次性提醒任务"""
        self.task_running = True
        save_reminders()

        try:
            # 计算等待时间
            now = time.time()
            wait_time = self.target_time - now

            if wait_time > 0:
                # 等待直到目标时间
                await asyncio.sleep(wait_time)

                # 重新加载数据以获取最新状态
                reminder_data = get_reminder(self.chat_id, self.id)
                if not reminder_data:
                    return

                # 更新状态
                self.enabled = reminder_data.get("enabled", True)

                if not self.enabled:
                    return

                # 发送提醒
                await self.send_reminder(context)

                # 标记为已提醒
                self.reminded = True
                save_reminders()

                # 自动删除已完成的一次性提醒
                delete_reminder(self.chat_id, self.id)

        except asyncio.CancelledError:
            # 任务被取消
            pass
        except Exception as e:
            print(f"一次性提醒任务出错: {e}")
        finally:
            # 确保在任务结束时更新状态
            self.task_running = False
            save_reminders()


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


def save_reminders():
    """保存提醒数据到文件"""
    os.makedirs(os.path.dirname(_data_file), exist_ok=True)

    try:
        with open(_data_file, 'w', encoding='utf-8') as f:
            json.dump(get_all_reminders_dict(),
                      f,
                      indent=4,
                      ensure_ascii=False)
    except Exception as e:
        print(f"保存提醒数据失败: {e}")


def get_all_reminders_dict():
    """获取所有提醒的字典表示"""
    reminders_dict = {}
    for chat_id, reminders in _reminder_tasks.items():
        if chat_id not in reminders_dict:
            reminders_dict[chat_id] = {}
        for reminder_id, task_info in reminders.items():
            reminder = task_info.get("reminder")
            if reminder:
                reminders_dict[chat_id][reminder_id] = reminder.to_dict()
    return reminders_dict


def get_reminder(chat_id, reminder_id):
    """获取特定提醒的数据"""
    chat_id_str = str(chat_id)
    reminder_id_str = str(reminder_id)

    if chat_id_str in _reminder_tasks and reminder_id_str in _reminder_tasks[
            chat_id_str]:
        reminder = _reminder_tasks[chat_id_str][reminder_id_str].get(
            "reminder")
        if reminder:
            return reminder.to_dict()
    return None


def delete_reminder(chat_id, reminder_id):
    """删除提醒"""
    chat_id_str = str(chat_id)
    reminder_id_str = str(reminder_id)

    if chat_id_str in _reminder_tasks and reminder_id_str in _reminder_tasks[
            chat_id_str]:
        # 取消任务
        task = _reminder_tasks[chat_id_str][reminder_id_str].get("task")
        if task:
            task.cancel()
        # 删除记录
        del _reminder_tasks[chat_id_str][reminder_id_str]
        # 如果该聊天没有任何提醒了，删除该聊天的记录
        if not _reminder_tasks[chat_id_str]:
            del _reminder_tasks[chat_id_str]
        # 保存更新
        save_reminders()
        return True
    return False


def parse_interval(interval_str):
    """解析时间间隔字符串为秒数"""
    # 匹配中文格式: "10 分钟", "1 小时", "2 天", "3 周", "1 月", "2 年"
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
        '%Y 年 %m 月 %d 日 %H:%M',
        '%Y 年 %m 月 %d 日 %H:%M:%S',
        '%Y 年 %m 月 %d 日%H:%M',
        '%Y 年 %m 月 %d 日%H:%M:%S',
        '%m 月 %d 日 %H:%M',
        '%m 月 %d 日 %H:%M:%S',
        '%m 月 %d 日%H:%M',
        '%m 月 %d 日%H:%M:%S',

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


def start_reminder_tasks(application):
    """启动所有提醒任务"""
    global _reminder_tasks
    _reminder_tasks = {}

    reminders_data = load_reminders()

    for chat_id_str, chat_reminders in reminders_data.items():
        for reminder_id, reminder_data in chat_reminders.items():
            # 跳过禁用的提醒
            if not reminder_data.get("enabled", True):
                continue

            # 创建提醒对象
            reminder_type = reminder_data.get("type", "periodic")
            reminder = None

            if reminder_type == "one_time":
                # 检查是否已经过期
                if reminder_data.get("reminded", False) or reminder_data.get(
                        "target_time", 0) < time.time():
                    continue

                reminder = OneTimeReminder.from_dict(reminder_data)
            else:  # 周期性提醒
                reminder = PeriodicReminder.from_dict(reminder_data)

            # 初始化聊天记录
            if chat_id_str not in _reminder_tasks:
                _reminder_tasks[chat_id_str] = {}

            # 启动任务
            task = asyncio.create_task(reminder.start_task(application))
            _reminder_tasks[chat_id_str][reminder_id] = {
                "reminder": reminder,
                "task": task
            }

    # 保存更新的状态
    save_reminders()


def stop_reminder_tasks():
    """停止所有提醒任务"""
    global _reminder_tasks

    # 取消所有任务
    for chat_id, reminders in _reminder_tasks.items():
        for reminder_id, task_info in reminders.items():
            task = task_info.get("task")
            if task:
                task.cancel()

            # 更新任务状态
            reminder = task_info.get("reminder")
            if reminder:
                reminder.task_running = False

    # 保存更新的状态
    save_reminders()

    # 清空任务列表
    _reminder_tasks = {}


@error_handler
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
                     "或: `/remindonce 2025 年 4 月 5 日 18:30 提交报告！`\n\n"
                     "*查看提醒:*\n"
                     "/reminders - 列出所有提醒\n\n"
                     "*删除提醒:*\n"
                     "/delreminder ID - 删除指定 ID 的提醒\n\n"
                     "*支持的时间间隔:*\n"
                     "- 中文: 分钟, 小时, 天, 周, 月, 年\n"
                     "- 英文: s/sec, min, h/hr, d/day, w/week, m/mon, y/year\n\n"
                     "*支持的日期时间格式:*\n"
                     "- 中文: 2025 年 4 月 5 日 18:30\n"
                     "- 英文: 2025-04-05 18:30\n"
                     "- 简化: 只有时间 18:30 (今天或明天)\n\n"
                     "*示例:*\n"
                     "- `/remind 1h 该锻炼了！`\n"
                     "- `/remind 1 天 该写周报了！`\n"
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

    # 生成提醒 ID
    reminder_id = str(int(time.time()))

    # 创建周期性提醒
    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)
    reminder = PeriodicReminder(
        reminder_id, message, update.effective_user.id,
        update.effective_user.full_name or update.effective_user.username
        or "未知用户", chat_id_str, update.effective_chat.type, interval_seconds)

    # 初始化聊天记录
    if chat_id_str not in _reminder_tasks:
        _reminder_tasks[chat_id_str] = {}

    # 启动任务
    task = asyncio.create_task(reminder.start_task(context))
    _reminder_tasks[chat_id_str][reminder_id] = {
        "reminder": reminder,
        "task": task
    }

    # 保存更新
    save_reminders()

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


@error_handler
async def remind_once_command(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """处理 /remindonce 命令 - 创建一次性提醒"""
    if not context.args or len(context.args) < 2:
        await update.message.reply_text(
            "用法: /remindonce 时间 内容\n"
            "例如: `/remindonce 8:30 晨会！`\n"
            "或: `/remindonce 2025 年 4 月 5 日 18:30 提交报告！`",
            parse_mode="MARKDOWN")
        return

    # 解析参数
    datetime_str = context.args[0]
    message = " ".join(context.args[1:])

    # 解析日期时间
    target_datetime = parse_datetime(datetime_str)
    if target_datetime is None:
        await update.message.reply_text("无法识别的时间格式，请使用如:\n"
                                        "- 2025 年 4 月 5 日 18:30\n"
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

    # 生成提醒 ID
    reminder_id = str(int(time.time()))

    # 创建一次性提醒
    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)
    reminder = OneTimeReminder(
        reminder_id, message, update.effective_user.id,
        update.effective_user.full_name or update.effective_user.username
        or "未知用户", chat_id_str, update.effective_chat.type, target_timestamp,
        target_datetime.strftime("%Y-%m-%d %H:%M:%S"))

    # 初始化聊天记录
    if chat_id_str not in _reminder_tasks:
        _reminder_tasks[chat_id_str] = {}

    # 启动任务
    task = asyncio.create_task(reminder.start_task(context))
    _reminder_tasks[chat_id_str][reminder_id] = {
        "reminder": reminder,
        "task": task
    }

    # 保存更新
    save_reminders()

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


@error_handler
async def list_reminders(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """列出所有提醒"""
    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)

    # 检查是否有提醒
    if chat_id_str not in _reminder_tasks or not _reminder_tasks[chat_id_str]:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    message = "📋 *当前聊天的提醒列表:*\n\n"

    # 分类存储提醒
    one_time_reminders = []
    periodic_reminders = []

    for reminder_id, task_info in _reminder_tasks[chat_id_str].items():
        reminder = task_info.get("reminder")
        if not reminder:
            continue

        if isinstance(reminder, OneTimeReminder):
            one_time_reminders.append(reminder)
        else:
            periodic_reminders.append(reminder)

    # 先显示一次性提醒
    if one_time_reminders:
        message += "*一次性提醒:*\n"
        for reminder in one_time_reminders:
            status = "✅ 已启用" if reminder.enabled else "❌ 已禁用"
            creator_info = f" (由 {reminder.creator_name} 创建)" if update.effective_chat.type != "private" else ""

            message += (f"🔹 *{reminder.title}*{creator_info}\n"
                        f"  🆔 ID: `{reminder.id}`\n"
                        f"  ⏰ 时间: {reminder.target_time_str}\n"
                        f"  📝 内容: {reminder.message}\n"
                        f"  🔄 状态: {status}\n\n")

    # 再显示周期性提醒
    if periodic_reminders:
        message += "*周期性提醒:*\n"
        for reminder in periodic_reminders:
            status = "✅ 已启用" if reminder.enabled else "❌ 已禁用"
            interval_text = format_interval(reminder.interval)
            creator_info = f" (由 {reminder.creator_name} 创建)" if update.effective_chat.type != "private" else ""

            message += (f"🔹 *{reminder.title}*{creator_info}\n"
                        f"  🆔 ID: `{reminder.id}`\n"
                        f"  ⏰ 间隔: {interval_text}\n"
                        f"  📝 内容: {reminder.message}\n"
                        f"  🔄 状态: {status}\n\n")

    # 如果没有任何提醒可显示
    if not one_time_reminders and not periodic_reminders:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    message += "要删除提醒，请使用 `/delreminder ID`"

    await update.message.reply_text(message, parse_mode="MARKDOWN")


@error_handler
async def delete_reminder_command(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE):
    """删除提醒"""
    if not context.args or len(context.args) < 1:
        await update.message.reply_text("用法: /delreminder ID")
        return

    reminder_id = context.args[0]
    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)

    # 检查提醒是否存在
    if (chat_id_str not in _reminder_tasks
            or reminder_id not in _reminder_tasks[chat_id_str]):
        await update.message.reply_text("找不到该提醒或已被删除。")
        return

    # 在群组中，检查是否有权限删除（管理员或创建者可以删除）
    reminder = _reminder_tasks[chat_id_str][reminder_id].get("reminder")
    if not reminder:
        await update.message.reply_text("找不到该提醒或已被删除。")
        return

    if update.effective_chat.type != "private":
        # 获取用户在群组中的状态
        user_id = update.effective_user.id

        # 如果不是创建者，检查是否是管理员
        if reminder.creator_id != user_id:
            chat_member = await context.bot.get_chat_member(chat_id, user_id)
            is_admin = chat_member.status in ["creator", "administrator"]

            # 如果不是管理员也不是创建者，则无权删除
            if not is_admin:
                await update.message.reply_text("您没有权限删除此提醒，只有提醒创建者或群组管理员可以删除。"
                                                )
                return

    # 删除提醒
    reminder_title = reminder.title
    if delete_reminder(chat_id, reminder_id):
        await update.message.reply_text(f"✅ 提醒 \"{reminder_title}\" 已删除。")
    else:
        await update.message.reply_text("删除提醒失败，请稍后再试。")


def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("remind", remind_command)
    module_interface.register_command("remindonce", remind_once_command)
    module_interface.register_command("reminders", list_reminders)
    module_interface.register_command("delreminder", delete_reminder_command)

    # 启动提醒任务
    start_reminder_tasks(module_interface.application)

    print(f"已注册提醒模块")


def cleanup(module_interface):
    """模块清理"""
    # 停止所有提醒任务
    stop_reminder_tasks()
    print(f"提醒模块已清理")
