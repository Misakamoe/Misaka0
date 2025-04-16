# modules/reminder.py - 提醒模块

import asyncio
import json
import os
import time
import re
import pytz
from datetime import datetime, timedelta
from telegram import Update
from telegram.ext import ContextTypes

# 模块元数据
MODULE_NAME = "Reminder"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "周期性和一次性提醒功能"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["remind", "remindonce", "reminders", "delreminder"]

# 模块常量
MIN_INTERVAL = 10  # 最小提醒间隔（秒）
DEFAULT_TIMEZONE = 'Asia/Hong_Kong'  # 默认时区
DATA_FILE = "config/reminders.json"  # 数据存储文件
AUTOSAVE_INTERVAL = 300  # 自动保存间隔（秒）

# 模块全局变量
_tasks = {}  # chat_id -> reminder_id -> {reminder, task}
_update_generation = 0  # 更新代数


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
        self.update_generation = _update_generation

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
            "task_running": self.task_running,
            "update_generation": self.update_generation
        }

    async def send_reminder(self, context, module_interface):
        """发送提醒消息"""
        if not self.enabled:
            return False

        try:
            # 检查模块是否在该聊天中启用
            if not context.bot_data.get(
                    "config_manager").is_module_enabled_for_chat(
                        MODULE_NAME, int(self.chat_id)):
                module_interface.logger.debug(
                    f"提醒模块在聊天 {self.chat_id} 中已禁用，跳过发送")
                return False

            # 发送提醒消息
            await context.bot.send_message(chat_id=self.chat_id,
                                           text=f"⏰ *提醒*\n\n{self.message}",
                                           parse_mode="MARKDOWN")
            return True
        except Exception as e:
            module_interface.logger.error(f"发送提醒消息失败: {e}")
            return False

    @classmethod
    def from_dict(cls, data):
        """从字典创建提醒"""
        raise NotImplementedError("子类必须实现此方法")

    async def start_task(self, context, module_interface):
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
        data = super().to_dict()
        data.update({
            "type": "periodic",
            "interval": self.interval,
            "last_reminded": self.last_reminded
        })
        return data

    @classmethod
    def from_dict(cls, data):
        reminder = cls(data["id"], data["message"], data["creator_id"],
                       data.get("creator_name", "未知用户"),
                       data.get("chat_id", "unknown"),
                       data.get("chat_type", "unknown"), data["interval"],
                       data.get("title"))
        reminder.created_at = data.get("created_at", time.time())
        reminder.enabled = data.get("enabled", True)
        reminder.task_running = data.get("task_running", False)
        reminder.last_reminded = data.get("last_reminded")
        reminder.update_generation = _update_generation
        return reminder

    async def start_task(self, context, module_interface):
        """启动周期性提醒任务"""
        self.task_running = True
        save_reminders(module_interface)

        task_generation = self.update_generation

        try:
            while True:
                # 检查是否是当前代数的任务
                if task_generation < _update_generation:
                    module_interface.logger.debug(
                        f"提醒任务 {self.id} 属于旧代数 {task_generation}，当前代数 {_update_generation}，停止执行"
                    )
                    break

                # 计算等待时间
                now = time.time()
                elapsed_time = now - (self.last_reminded or self.created_at)
                wait_time = max(0, self.interval - elapsed_time)

                if wait_time > 0:
                    module_interface.logger.debug(
                        f"提醒 {self.id} 将在 {wait_time:.1f} 秒后发送")
                    await asyncio.sleep(wait_time)

                # 检查代数和模块状态
                if task_generation < _update_generation:
                    module_interface.logger.debug(
                        f"提醒任务 {self.id} 在等待后检测到代数变化，停止")
                    break

                # 检查模块是否启用
                if not context.bot_data.get(
                        "config_manager").is_module_enabled_for_chat(
                            MODULE_NAME, int(self.chat_id)):
                    module_interface.logger.debug(
                        f"提醒模块在聊天 {self.chat_id} 中已禁用，休眠任务")
                    await asyncio.sleep(60)  # 休眠一分钟后再检查
                    continue

                # 发送提醒
                success = await self.send_reminder(context, module_interface)

                if success:
                    module_interface.logger.debug(
                        f"已发送周期性提醒 {self.id} 到聊天 {self.chat_id}")

                # 更新最后提醒时间并保存
                self.last_reminded = time.time()
                save_reminders(module_interface)

        except asyncio.CancelledError:
            module_interface.logger.debug(f"周期性提醒任务 {self.id} 已取消")
        except Exception as e:
            module_interface.logger.error(f"周期性提醒任务出错: {e}")
        finally:
            self.task_running = False
            save_reminders(module_interface)


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
        reminder = cls(data["id"], data["message"], data["creator_id"],
                       data.get("creator_name", "未知用户"),
                       data.get("chat_id", "unknown"),
                       data.get("chat_type", "unknown"), data["target_time"],
                       data.get("target_time_str", "未知时间"), data.get("title"))
        reminder.created_at = data.get("created_at", time.time())
        reminder.enabled = data.get("enabled", True)
        reminder.task_running = data.get("task_running", False)
        reminder.reminded = data.get("reminded", False)
        reminder.update_generation = _update_generation
        return reminder

    async def start_task(self, context, module_interface):
        """启动一次性提醒任务"""
        self.task_running = True
        save_reminders(module_interface)

        task_generation = self.update_generation

        try:
            # 计算等待时间
            now = time.time()
            wait_time = self.target_time - now

            if wait_time > 0:
                module_interface.logger.debug(
                    f"一次性提醒 {self.id} 将在 {wait_time:.1f} 秒后发送")

                # 分段等待，便于检查模块状态
                remaining_time = wait_time
                check_interval = min(remaining_time, 60)  # 最多等待60秒后检查一次

                while remaining_time > 0:
                    await asyncio.sleep(check_interval)
                    remaining_time -= check_interval

                    # 检查代数
                    if task_generation < _update_generation:
                        module_interface.logger.debug(
                            f"一次性提醒任务 {self.id} 检测到代数变化，停止")
                        return

                    # 检查模块是否启用
                    if not context.bot_data.get(
                            "config_manager").is_module_enabled_for_chat(
                                MODULE_NAME, int(self.chat_id)):
                        module_interface.logger.debug(
                            f"提醒模块在聊天 {self.chat_id} 中已禁用，暂停计时")
                        # 不减少时间，等下一次检查
                        continue

                    # 更新下一次检查间隔
                    check_interval = min(remaining_time, 60)

                # 发送提醒前再次检查
                if task_generation < _update_generation:
                    return

                # 发送提醒
                success = await self.send_reminder(context, module_interface)

                if success:
                    module_interface.logger.debug(
                        f"已发送一次性提醒 {self.id} 到聊天 {self.chat_id}")

                # 标记为已提醒并删除
                self.reminded = True
                save_reminders(module_interface)
                delete_reminder(self.chat_id, self.id, module_interface)

        except asyncio.CancelledError:
            module_interface.logger.debug(f"一次性提醒任务 {self.id} 已取消")
        except Exception as e:
            module_interface.logger.error(f"一次性提醒任务出错: {e}")
        finally:
            self.task_running = False
            save_reminders(module_interface)


def get_all_reminders_dict():
    """获取所有提醒的字典表示"""
    reminders_dict = {}
    for chat_id, reminders in _tasks.items():
        if chat_id not in reminders_dict:
            reminders_dict[chat_id] = {}
        for reminder_id, task_info in reminders.items():
            reminder = task_info.get("reminder")
            if reminder:
                reminders_dict[chat_id][reminder_id] = reminder.to_dict()
    return reminders_dict


def load_reminders(module_interface):
    """从文件加载提醒数据"""
    if not os.path.exists(DATA_FILE):
        return {}

    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception as e:
        module_interface.logger.error(f"加载提醒数据失败: {e}")
        return {}


def save_reminders(module_interface):
    """保存提醒数据到文件"""
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)

    try:
        with open(DATA_FILE, 'w', encoding='utf-8') as f:
            json.dump(get_all_reminders_dict(),
                      f,
                      indent=2,
                      ensure_ascii=False)
        module_interface.logger.debug("已保存提醒数据")
    except Exception as e:
        module_interface.logger.error(f"保存提醒数据失败: {e}")


def get_reminder(chat_id, reminder_id):
    """获取特定提醒的数据"""
    chat_id_str = str(chat_id)
    reminder_id_str = str(reminder_id)

    if chat_id_str in _tasks and reminder_id_str in _tasks[chat_id_str]:
        reminder = _tasks[chat_id_str][reminder_id_str].get("reminder")
        if reminder:
            return reminder.to_dict()
    return None


def delete_reminder(chat_id, reminder_id, module_interface):
    """删除提醒"""
    chat_id_str = str(chat_id)
    reminder_id_str = str(reminder_id)

    if chat_id_str in _tasks and reminder_id_str in _tasks[chat_id_str]:
        # 取消任务
        task = _tasks[chat_id_str][reminder_id_str].get("task")
        if task and not task.done():
            task.cancel()
        # 删除记录
        del _tasks[chat_id_str][reminder_id_str]
        # 如果该聊天没有任何提醒了，删除该聊天的记录
        if not _tasks[chat_id_str]:
            del _tasks[chat_id_str]
        # 保存更新
        save_reminders(module_interface)
        return True
    return False


def parse_interval(interval_str):
    """解析时间间隔字符串为秒数"""
    # 处理特殊情况：如 "4月5日" 这种日期格式，不是时间间隔
    if re.search(r"\d+月\d+日|\d+[-/]\d+", interval_str):
        return None

    # 尝试匹配中英文复合格式
    patterns = [
        # 中文复合格式 "2年3月4天5小时6分钟7秒"
        (r"(\d+)(年|月|周|天|小时|分钟|秒)", {
            "年": 31536000,
            "月": 2592000,
            "周": 604800,
            "天": 86400,
            "小时": 3600,
            "分钟": 60,
            "秒": 1
        }),
        # 英文复合格式 "2y3mon4d5h6min7s"
        (
            r"(\d+)(y|year|mon|month|w|week|d|day|h|hr|hour|m|min|minute|s|sec|second)",
            {
                "y": 31536000,
                "year": 31536000,
                "mon": 2592000,
                "month": 2592000,
                "w": 604800,
                "week": 604800,
                "d": 86400,
                "day": 86400,
                "h": 3600,
                "hr": 3600,
                "hour": 3600,
                "min": 60,
                "minute": 60,
                "m": 60,  # m 是分钟而不是月
                "s": 1,
                "sec": 1,
                "second": 1
            })
    ]

    for pattern, unit_map in patterns:
        matches = re.findall(pattern, interval_str, re.IGNORECASE)
        if matches:
            # 检查完整性：所有文本都必须匹配有效的时间格式
            matched_text = ""
            for value, unit in matches:
                matched_text += value + unit

            # 如果有未匹配的部分，认为是无效格式
            if len(matched_text) != len(interval_str):
                return None

            total_seconds = 0
            for value, unit in matches:
                unit = unit.lower()
                if unit in unit_map:
                    total_seconds += int(value) * unit_map[unit]

            if total_seconds > 0:
                return total_seconds

    # 单一时间单位格式 "30分钟", "2小时", "1d", "5min"
    simple_patterns = [
        # 中文单一格式
        (r"^(\d+)(分钟|小时|天|周|月|年)$", {
            "分钟": 60,
            "小时": 3600,
            "天": 86400,
            "周": 604800,
            "月": 2592000,
            "年": 31536000
        }),
        # 英文单一格式
        (
            r"^(\d+)(s|sec|m|min|h|hr|d|day|w|week|mon|month|y|year)$",
            {
                "s": 1,
                "sec": 1,
                "min": 60,
                "m": 60,  # m 是分钟而不是月
                "h": 3600,
                "hr": 3600,
                "d": 86400,
                "day": 86400,
                "w": 604800,
                "week": 604800,
                "mon": 2592000,
                "month": 2592000,
                "y": 31536000,
                "year": 31536000
            })
    ]

    for pattern, unit_map in simple_patterns:
        match = re.match(pattern, interval_str, re.IGNORECASE)
        if match:
            value, unit = match.groups()
            unit = unit.lower()
            if unit in unit_map:
                return int(value) * unit_map[unit]

    # 无法识别
    return None


def parse_datetime(datetime_str):
    """解析日期时间字符串为 datetime 对象"""
    now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))

    # 处理中文月日格式 "4月5日16:00"
    match = re.match(r"(\d+)月(\d+)日(?:(\d+)[:](\d+)(?:[:](\d+))?)?$",
                     datetime_str)
    if match:
        month, day = int(match.group(1)), int(match.group(2))
        hour, minute, second = 0, 0, 0

        if match.group(3):
            hour = int(match.group(3))
        if match.group(4):
            minute = int(match.group(4))
        if match.group(5):
            second = int(match.group(5))

        try:
            dt = datetime(now.year, month, day, hour, minute, second)
            dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            # 如果日期已过，假设是明年
            if dt_with_tz < now:
                dt = datetime(now.year + 1, month, day, hour, minute, second)

            return pytz.timezone(DEFAULT_TIMEZONE).localize(dt)
        except ValueError:
            # 无效日期
            return None

    # 处理中文年月日格式 "2025年4月5日16:00"
    match = re.match(r"(\d+)年(\d+)月(\d+)日(?:(\d+)[:](\d+)(?:[:](\d+))?)?$",
                     datetime_str)
    if match:
        year, month, day = int(match.group(1)), int(match.group(2)), int(
            match.group(3))
        hour, minute, second = 0, 0, 0

        if match.group(4):
            hour = int(match.group(4))
        if match.group(5):
            minute = int(match.group(5))
        if match.group(6):
            second = int(match.group(6))

        try:
            dt = datetime(year, month, day, hour, minute, second)
            return pytz.timezone(DEFAULT_TIMEZONE).localize(dt)
        except ValueError:
            # 无效日期
            return None

    # 处理各种标准格式
    formats = [
        '%Y-%m-%d %H:%M:%S', '%Y-%m-%d %H:%M', '%Y/%m/%d %H:%M:%S',
        '%Y/%m/%d %H:%M', '%d-%m-%Y %H:%M:%S', '%d-%m-%Y %H:%M',
        '%d/%m/%Y %H:%M:%S', '%d/%m/%Y %H:%M', '%Y%m%d %H:%M:%S',
        '%Y%m%d %H:%M', '%Y%m%d%H%M%S', '%Y%m%d%H%M', '%H:%M:%S', '%H:%M'
    ]

    for fmt in formats:
        try:
            dt = datetime.strptime(datetime_str, fmt)

            # 如果只有时间没有日期，假设是今天或明天
            if fmt in ['%H:%M', '%H:%M:%S']:
                dt = dt.replace(year=now.year, month=now.month, day=now.day)
                dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

                # 如果时间已过，则假设是明天
                if dt_with_tz < now:
                    dt = dt + timedelta(days=1)

            return pytz.timezone(DEFAULT_TIMEZONE).localize(dt)
        except ValueError:
            continue

    return None


def format_interval(seconds):
    """将秒数格式化为可读的时间间隔"""
    units = [(31536000, "年"), (2592000, "月"), (604800, "周"), (86400, "天"),
             (3600, "小时"), (60, "分钟"), (1, "秒")]

    # 处理简单单位
    for unit_seconds, unit_name in units:
        if seconds % unit_seconds == 0 and seconds // unit_seconds > 0:
            return f"{seconds // unit_seconds} {unit_name}"

    # 处理复合时间
    result = []
    remaining = seconds

    for unit_seconds, unit_name in units:
        if remaining >= unit_seconds:
            unit_value = remaining // unit_seconds
            remaining %= unit_seconds
            result.append(f"{unit_value} {unit_name}")

    # 最多显示两个最大单位
    if len(result) > 2:
        result = result[:2]

    return " ".join(result)


async def start_reminder_tasks(context, module_interface):
    """启动所有提醒任务"""
    global _tasks
    _tasks = {}

    module_interface.logger.info("正在启动提醒任务...")

    # 加载保存的提醒数据
    reminders_data = load_reminders(module_interface)
    task_count = 0

    for chat_id_str, chat_reminders in reminders_data.items():
        for reminder_id, reminder_data in chat_reminders.items():
            # 跳过禁用的提醒
            if not reminder_data.get("enabled", True):
                continue

            # 创建提醒对象
            reminder_type = reminder_data.get("type", "periodic")
            reminder = None

            if reminder_type == "one_time":
                # 检查是否过期
                if (reminder_data.get("reminded", False)
                        or reminder_data.get("target_time", 0) < time.time()):
                    continue

                reminder = OneTimeReminder.from_dict(reminder_data)
            else:
                reminder = PeriodicReminder.from_dict(reminder_data)

            # 初始化聊天记录
            if chat_id_str not in _tasks:
                _tasks[chat_id_str] = {}

            # 启动任务
            task = asyncio.create_task(
                reminder.start_task(context, module_interface))
            _tasks[chat_id_str][reminder_id] = {
                "reminder": reminder,
                "task": task
            }
            task_count += 1

    if task_count > 0:
        module_interface.logger.info(f"已启动 {task_count} 个提醒任务")
    else:
        module_interface.logger.info("没有找到需要启动的提醒任务")

    # 保存更新的状态
    save_reminders(module_interface)


def stop_reminder_tasks(module_interface):
    """停止所有提醒任务"""
    module_interface.logger.info("正在停止所有提醒任务...")

    # 取消所有任务
    task_count = 0
    for chat_id, reminders in _tasks.items():
        for reminder_id, task_info in reminders.items():
            task = task_info.get("task")
            if task and not task.done():
                task.cancel()
                task_count += 1

            # 更新任务状态
            reminder = task_info.get("reminder")
            if reminder:
                reminder.task_running = False

    save_reminders(module_interface)
    module_interface.logger.info(f"已停止 {task_count} 个提醒任务")


async def remind_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /remind 命令 - 创建周期性提醒"""
    # 获取模块接口
    module_interface = context.bot_data["module_manager"].get_module_info(
        "reminder")["interface"]

    # 如果没有参数，显示帮助信息
    if not context.args or len(context.args) < 2:
        help_text = ("📅 *提醒功能帮助*\n\n"
                     "*创建周期性提醒:*\n"
                     "/remind 间隔 内容\n"
                     "例如: `/remind 30min 该喝水了！`\n"
                     "复合时间: `/remind 2天3小时 长期任务！`\n"
                     "英文复合: `/remind 1y2mon3d 长期任务！`\n\n"
                     "*创建一次性提醒:*\n"
                     "/remindonce 时间 内容\n"
                     "例如: `/remindonce 8:30 晨会！`\n"
                     "或: `/remindonce 2025年4月5日18:30 提交报告！`\n"
                     "或: `/remindonce 6-25 16:00 提交报告！`\n\n"
                     "*查看提醒:*\n"
                     "/reminders - 列出所有提醒\n\n"
                     "*删除提醒:*\n"
                     "/delreminder ID - 删除指定 ID 的提醒")
        await update.message.reply_text(help_text, parse_mode="MARKDOWN")
        return

    # 解析参数
    interval_str = context.args[0]
    message = " ".join(context.args[1:])

    # 解析时间间隔
    interval_seconds = parse_interval(interval_str)
    if interval_seconds is None:
        await update.message.reply_text(
            "⚠️ 无法识别的时间格式，请使用如:\n"
            "- 中文: 分钟、小时、天、周、月、年\n"
            "- 英文: s/sec, m/min, h/hr, d/day, w/week, mon/month, y/year\n"
            "- 复合时间: 2年3月、1天12小时30分钟\n"
            "- 英文复合: 1y2mon3d、1d12h30min")
        return

    # 检查最小间隔
    if interval_seconds < MIN_INTERVAL:
        await update.message.reply_text(f"⚠️ 提醒间隔太短，最小间隔为 {MIN_INTERVAL} 秒。")
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
    if chat_id_str not in _tasks:
        _tasks[chat_id_str] = {}

    # 启动任务
    task = asyncio.create_task(reminder.start_task(context, module_interface))
    _tasks[chat_id_str][reminder_id] = {"reminder": reminder, "task": task}

    # 保存更新
    save_reminders(module_interface)

    # 格式化时间间隔
    interval_text = format_interval(interval_seconds)

    # 发送确认消息
    await update.message.reply_text(
        f"✅ 周期性提醒已创建!\n\n"
        f"⏰ *间隔:* {interval_text}\n"
        f"📝 *内容:* {message}\n"
        f"🆔 *提醒 ID:* `{reminder_id}`\n\n"
        f"每 {interval_text}，我会发送一次提醒。\n"
        f"如需删除，请使用 `/delreminder {reminder_id}`",
        parse_mode="MARKDOWN")

    module_interface.logger.info(
        f"用户 {update.effective_user.id} 创建了周期性提醒 {reminder_id}，"
        f"间隔 {interval_text}")


async def remind_once_command(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """处理 /remindonce 命令 - 创建一次性提醒"""
    # 获取模块接口
    module_interface = context.bot_data["module_manager"].get_module_info(
        "reminder")["interface"]

    if not context.args or len(context.args) < 2:
        await update.message.reply_text(
            "用法: /remindonce 时间 内容\n"
            "例如: `/remindonce 8:30 晨会！`\n"
            "或: `/remindonce 2025年4月5日18:30 提交报告！`\n"
            "或: `/remindonce 6-25 16:00 提交报告！`",
            parse_mode="MARKDOWN")
        return

    # 特殊处理 "6-25 16:00" 这种格式
    full_input = " ".join(context.args)
    special_format_match = re.match(
        r"^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?\s+(.*)",
        full_input)

    target_datetime = None
    message = ""

    if special_format_match:
        month, day = int(special_format_match.group(1)), int(
            special_format_match.group(2))
        hour, minute = int(special_format_match.group(3)), int(
            special_format_match.group(4))
        second = int(special_format_match.group(
            5)) if special_format_match.group(5) else 0
        message = special_format_match.group(6)

        now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))

        try:
            dt = datetime(now.year, month, day, hour, minute, second)
            dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            # 如果日期已过，假设是明年
            if dt_with_tz < now:
                dt = datetime(now.year + 1, month, day, hour, minute, second)
                dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            target_datetime = dt_with_tz
        except ValueError:
            target_datetime = None
    else:
        # 常规解析过程
        datetime_str = context.args[0]
        target_datetime = parse_datetime(datetime_str)
        message = " ".join(context.args[1:])

        # 如果第一个参数无法解析为日期，尝试合并前两个参数
        if target_datetime is None and len(context.args) >= 2:
            datetime_str = f"{context.args[0]} {context.args[1]}"
            target_datetime = parse_datetime(datetime_str)

            if target_datetime is not None:
                message = " ".join(context.args[2:])

    if target_datetime is None:
        await update.message.reply_text("⚠️ 无法识别的时间格式，请使用如:\n"
                                        "- 2025年4月5日18:30\n"
                                        "- 4月5日16:00\n"
                                        "- 6-25 16:00\n"
                                        "- 2025/04/05 18:30\n"
                                        "- 18:30 (今天或明天)")
        return

    if not message:
        await update.message.reply_text("⚠️ 请提供提醒内容。")
        return

    # 转换为时间戳
    target_timestamp = target_datetime.timestamp()

    # 检查是否是过去的时间
    now_timestamp = time.time()
    if target_timestamp <= now_timestamp:
        await update.message.reply_text("⚠️ 提醒时间不能是过去的时间。")
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
    if chat_id_str not in _tasks:
        _tasks[chat_id_str] = {}

    # 启动任务
    task = asyncio.create_task(reminder.start_task(context, module_interface))
    _tasks[chat_id_str][reminder_id] = {"reminder": reminder, "task": task}

    # 保存更新
    save_reminders(module_interface)

    # 计算等待时间
    wait_seconds = target_timestamp - now_timestamp
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

    module_interface.logger.info(
        f"用户 {update.effective_user.id} 创建了一次性提醒 {reminder_id}，"
        f"时间 {target_datetime.strftime('%Y-%m-%d %H:%M:%S')}")


async def list_reminders(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """列出所有提醒"""
    # 获取模块接口
    module_interface = context.bot_data["module_manager"].get_module_info(
        "reminder")["interface"]

    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)

    # 检查是否有提醒
    if chat_id_str not in _tasks or not _tasks[chat_id_str]:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    # 分类提醒
    one_time_reminders = []
    periodic_reminders = []

    for reminder_id, task_info in _tasks[chat_id_str].items():
        reminder = task_info.get("reminder")
        if not reminder:
            continue

        if isinstance(reminder, OneTimeReminder):
            one_time_reminders.append(reminder)
        else:
            periodic_reminders.append(reminder)

    # 构建消息
    message = "📋 *当前聊天的提醒列表:*\n\n"

    # 一次性提醒
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

    # 周期性提醒
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

    # 如果没有任何提醒
    if not one_time_reminders and not periodic_reminders:
        await update.message.reply_text("当前聊天没有创建任何提醒。")
        return

    message += "要删除提醒，请使用 `/delreminder ID`"

    # 发送消息
    try:
        await update.message.reply_text(message, parse_mode="MARKDOWN")
    except Exception as e:
        module_interface.logger.error(f"发送提醒列表失败: {e}")
        # 尝试发送纯文本
        await update.message.reply_text(
            message.replace("*", "").replace("`", ""))


async def delete_reminder_command(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE):
    """删除提醒"""
    # 获取模块接口
    module_interface = context.bot_data["module_manager"].get_module_info(
        "reminder")["interface"]

    if not context.args or len(context.args) < 1:
        await update.message.reply_text("用法: /delreminder ID")
        return

    reminder_id = context.args[0]
    chat_id = update.effective_chat.id
    chat_id_str = str(chat_id)

    # 检查提醒是否存在
    if (chat_id_str not in _tasks or reminder_id not in _tasks[chat_id_str]):
        await update.message.reply_text("❌ 找不到该提醒或已被删除。")
        return

    # 获取提醒对象
    reminder = _tasks[chat_id_str][reminder_id].get("reminder")
    if not reminder:
        await update.message.reply_text("❌ 找不到该提醒或已被删除。")
        return

    # 检查权限（群组中只有创建者或管理员可以删除）
    if update.effective_chat.type != "private":
        user_id = update.effective_user.id

        if reminder.creator_id != user_id:
            chat_member = await context.bot.get_chat_member(chat_id, user_id)
            is_admin = chat_member.status in ["creator", "administrator"]

            if not is_admin:
                await update.message.reply_text(
                    "⚠️ 您没有权限删除此提醒，只有提醒创建者或群组管理员可以删除。")
                return

    # 删除提醒
    reminder_title = reminder.title
    if delete_reminder(chat_id, reminder_id, module_interface):
        await update.message.reply_text(f"✅ 提醒 \"{reminder_title}\" 已删除。")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 删除了提醒 {reminder_id}")
    else:
        await update.message.reply_text("❌ 删除提醒失败，请稍后再试。")


def get_state(module_interface):
    """获取模块状态（用于热更新）"""
    module_interface.logger.debug("正在获取模块状态用于热更新")
    return {"reminders_data": get_all_reminders_dict()}


def set_state(module_interface, state):
    """设置模块状态（用于热更新）"""
    global _update_generation

    module_interface.logger.debug("正在恢复模块状态")

    # 递增更新代数
    _update_generation += 1

    # 清除旧任务
    for chat_id, reminders in _tasks.items():
        for reminder_id, task_info in reminders.items():
            task = task_info.get("task")
            if task and not task.done():
                task.cancel()

    # 从保存的状态中恢复提醒
    start_reminder_tasks(module_interface.application, module_interface)


async def setup(module_interface):
    """模块初始化"""
    global _update_generation, _tasks
    _update_generation = 0
    _tasks = {}

    # 注册命令
    await module_interface.register_command("remind",
                                            remind_command,
                                            description="创建周期性提醒")
    await module_interface.register_command("remindonce",
                                            remind_once_command,
                                            description="创建一次性提醒")
    await module_interface.register_command("reminders",
                                            list_reminders,
                                            description="列出所有提醒")
    await module_interface.register_command("delreminder",
                                            delete_reminder_command,
                                            description="删除提醒")

    # 启动提醒任务
    await start_reminder_tasks(module_interface.application, module_interface)

    # 创建自动保存任务
    async def auto_save():
        while True:
            await asyncio.sleep(AUTOSAVE_INTERVAL)
            save_reminders(module_interface)

    module_interface.auto_save_task = asyncio.create_task(auto_save())

    # 记录模块初始化
    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(module_interface):
    """模块清理"""
    module_interface.logger.info(f"正在清理模块 {MODULE_NAME}")

    # 取消自动保存任务
    if hasattr(module_interface,
               "auto_save_task") and module_interface.auto_save_task:
        module_interface.auto_save_task.cancel()

    # 停止所有提醒任务
    stop_reminder_tasks(module_interface)

    # 保存状态
    save_reminders(module_interface)

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理完成")
