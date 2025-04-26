# modules/reminder.py - 提醒模块

import asyncio
import json
import os
import time
import re
import pytz
from datetime import datetime, timedelta
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "reminder"
MODULE_VERSION = "3.1.0"
MODULE_DESCRIPTION = "周期性和一次性提醒功能"
MODULE_COMMANDS = ["remind"]
MODULE_CHAT_TYPES = ["private", "group"]  # 支持所有聊天类型

# 按钮回调前缀
CALLBACK_PREFIX = "reminder_"

# 模块接口引用
_module_interface = None

# 模块常量
MIN_INTERVAL = 10  # 最小提醒间隔（秒）
DEFAULT_TIMEZONE = 'Asia/Hong_Kong'  # 默认时区
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
            # 检查聊天是否在白名单中（如果是群组）
            chat_id_int = int(self.chat_id)
            if chat_id_int < 0 and not context.bot_data.get(
                    "config_manager").is_allowed_group(chat_id_int):
                module_interface.logger.debug(
                    f"提醒模块在聊天 {self.chat_id} 中不在白名单中，跳过发送")
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
                 first_reminder_time=None,
                 title=None,
                 pattern=None,
                 pattern_type=None):
        super().__init__(reminder_id, message, creator_id, creator_name,
                         chat_id, chat_type, title)
        self.interval = interval
        self.last_reminded = None
        self.first_reminder_time = first_reminder_time  # 第一次提醒的时间戳
        self.type = "periodic"
        self.pattern = pattern  # 存储原始模式，如 "25日"
        self.pattern_type = pattern_type  # 模式类型：monthly, yearly, daily, standard

    def to_dict(self):
        data = super().to_dict()
        data.update({
            "type": "periodic",
            "interval": self.interval,
            "last_reminded": self.last_reminded,
            "first_reminder_time": self.first_reminder_time,
            "pattern": self.pattern,
            "pattern_type": self.pattern_type
        })
        return data

    @classmethod
    def from_dict(cls, data):
        reminder = cls(data["id"], data["message"], data["creator_id"],
                       data.get("creator_name", "未知用户"),
                       data.get("chat_id", "unknown"),
                       data.get("chat_type", "unknown"), data["interval"],
                       data.get("first_reminder_time"), data.get("title"),
                       data.get("pattern"), data.get("pattern_type"))
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
            # 如果设置了第一次提醒时间，先等待到那个时间
            if self.first_reminder_time and self.first_reminder_time > time.time(
            ):
                first_wait_time = self.first_reminder_time - time.time()

                if first_wait_time > 0:
                    module_interface.logger.debug(
                        f"周期性提醒 {self.id} 将在 {first_wait_time:.1f} 秒后首次发送")

                    # 分段等待，便于检查模块状态
                    remaining_time = first_wait_time
                    check_interval = min(remaining_time, 60)  # 最多等待60秒后检查一次

                    while remaining_time > 0:
                        await asyncio.sleep(check_interval)
                        remaining_time -= check_interval

                        # 检查代数
                        if task_generation < _update_generation:
                            module_interface.logger.debug(
                                f"周期性提醒任务 {self.id} 检测到代数变化，停止")
                            return

                        # 检查聊天是否在白名单中（如果是群组）
                        chat_id_int = int(self.chat_id)
                        if chat_id_int < 0 and not context.bot_data.get(
                                "config_manager").is_allowed_group(
                                    chat_id_int):
                            module_interface.logger.debug(
                                f"提醒模块在聊天 {self.chat_id} 中不在白名单中，暂停计时")
                            # 不减少时间，等下一次检查
                            continue

                        # 更新下一次检查间隔
                        check_interval = min(remaining_time, 60)

                    # 发送第一次提醒
                    success = await self.send_reminder(context,
                                                       module_interface)

                    if success:
                        module_interface.logger.debug(
                            f"已发送周期性提醒 {self.id} 的首次提醒到聊天 {self.chat_id}")

                    # 更新最后提醒时间并保存
                    self.last_reminded = time.time()
                    save_reminders(module_interface)

            while True:
                # 检查是否是当前代数的任务
                if task_generation < _update_generation:
                    module_interface.logger.debug(
                        f"提醒任务 {self.id} 属于旧代数 {task_generation}，当前代数 {_update_generation}，停止执行"
                    )
                    break

                # 计算等待时间
                now = time.time()

                # 如果有特殊模式类型且已设置下一次提醒时间，直接使用
                if self.pattern_type in [
                        "monthly", "yearly", "daily"
                ] and self.first_reminder_time and self.first_reminder_time > now:
                    wait_time = self.first_reminder_time - now
                    module_interface.logger.debug(
                        f"提醒 {self.id} 使用模式计算的下一次提醒时间，将在 {wait_time:.1f} 秒后发送")
                else:
                    # 否则使用标准间隔计算
                    elapsed_time = now - (self.last_reminded
                                          or self.created_at)
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

                # 检查聊天是否在白名单中（如果是群组）
                chat_id_int = int(self.chat_id)
                if chat_id_int < 0 and not context.bot_data.get(
                        "config_manager").is_allowed_group(chat_id_int):
                    module_interface.logger.debug(
                        f"提醒模块在聊天 {self.chat_id} 中不在白名单中，休眠任务")
                    await asyncio.sleep(60)  # 休眠一分钟后再检查
                    continue

                # 发送提醒
                success = await self.send_reminder(context, module_interface)

                if success:
                    module_interface.logger.debug(
                        f"已发送周期性提醒 {self.id} 到聊天 {self.chat_id}")

                # 更新最后提醒时间
                self.last_reminded = time.time()

                # 如果是特殊模式类型（monthly, yearly, daily），重新计算下一次提醒时间
                if self.pattern_type in ["monthly", "yearly", "daily"]:
                    now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))
                    next_time = None

                    if self.pattern_type == "monthly":
                        # 获取模式中的日期
                        day = int(re.match(r"(\d+)日$", self.pattern).group(1))

                        # 计算下个月的这个日期
                        if now.month == 12:
                            next_month = 1
                            next_year = now.year + 1
                        else:
                            next_month = now.month + 1
                            next_year = now.year

                        try:
                            # 尝试创建下个月的日期（处理月份天数不同的情况）
                            next_time = datetime(next_year, next_month, day, 0,
                                                 0, 0)
                            next_time = pytz.timezone(
                                DEFAULT_TIMEZONE).localize(next_time)
                            self.first_reminder_time = next_time.timestamp()
                            module_interface.logger.debug(
                                f"已重新计算周期性提醒 {self.id} 的下一次提醒时间: {next_time}")
                        except ValueError:
                            # 如果日期无效（例如2月30日），使用月末
                            if day > 28:  # 可能是月末日期
                                # 获取下个月的最后一天
                                if next_month == 12:
                                    last_day = 31
                                else:
                                    # 计算下下个月的第一天，然后回退一天
                                    next_next_month = next_month + 1 if next_month < 12 else 1
                                    next_next_year = next_year if next_month < 12 else next_year + 1
                                    first_day_next_next_month = datetime(
                                        next_next_year, next_next_month, 1)
                                    last_day_next_month = first_day_next_next_month - timedelta(
                                        days=1)
                                    last_day = last_day_next_month.day

                                next_time = datetime(next_year, next_month,
                                                     last_day, 0, 0, 0)
                                next_time = pytz.timezone(
                                    DEFAULT_TIMEZONE).localize(next_time)
                                self.first_reminder_time = next_time.timestamp(
                                )
                                module_interface.logger.debug(
                                    f"已调整周期性提醒 {self.id} 的下一次提醒时间到月末: {next_time}"
                                )

                    elif self.pattern_type == "yearly":
                        # 获取模式中的月和日
                        match = re.match(
                            r"(\d+)月(\d+)日(?:(\d+)[:](\d+)(?:[:](\d+))?)?$",
                            self.pattern)
                        if match:
                            month, day = int(match.group(1)), int(
                                match.group(2))
                            hour, minute, second = 0, 0, 0

                            if match.group(3):
                                hour = int(match.group(3))
                            if match.group(4):
                                minute = int(match.group(4))
                            if match.group(5):
                                second = int(match.group(5))

                            try:
                                # 计算明年的这个日期
                                next_time = datetime(now.year + 1, month, day,
                                                     hour, minute, second)
                                next_time = pytz.timezone(
                                    DEFAULT_TIMEZONE).localize(next_time)
                                self.first_reminder_time = next_time.timestamp(
                                )
                                module_interface.logger.debug(
                                    f"已重新计算周期性提醒 {self.id} 的下一次提醒时间: {next_time}"
                                )
                            except ValueError:
                                # 处理2月29日的情况（闰年问题）
                                if month == 2 and day == 29:
                                    # 如果明年不是闰年，使用2月28日
                                    next_time = datetime(
                                        now.year + 1, 2, 28, hour, minute,
                                        second)
                                    next_time = pytz.timezone(
                                        DEFAULT_TIMEZONE).localize(next_time)
                                    self.first_reminder_time = next_time.timestamp(
                                    )
                                    module_interface.logger.debug(
                                        f"已调整周期性提醒 {self.id} 的下一次提醒时间（非闰年）: {next_time}"
                                    )

                    elif self.pattern_type == "daily":
                        # 获取模式中的时间
                        match = re.match(
                            r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$",
                            self.pattern)
                        if match:
                            hour, minute = int(match.group(1)), int(
                                match.group(2))
                            second = int(
                                match.group(3)) if match.group(3) else 0

                            # 计算明天的这个时间
                            tomorrow = now + timedelta(days=1)
                            next_time = tomorrow.replace(hour=hour,
                                                         minute=minute,
                                                         second=second,
                                                         microsecond=0)
                            self.first_reminder_time = next_time.timestamp()
                            module_interface.logger.debug(
                                f"已重新计算周期性提醒 {self.id} 的下一次提醒时间: {next_time}")

                # 保存更新
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

                    # 检查聊天是否在白名单中（如果是群组）
                    chat_id_int = int(self.chat_id)
                    if chat_id_int < 0 and not context.bot_data.get(
                            "config_manager").is_allowed_group(chat_id_int):
                        module_interface.logger.debug(
                            f"提醒模块在聊天 {self.chat_id} 中不在白名单中，暂停计时")
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


def save_reminders(interface, save_to_config=True):
    """保存提醒数据（使用框架提供的 save_state 方法）

    Args:
        interface: 模块接口
        save_to_config: 是否同时保存到配置文件（默认为 True）
    """
    try:
        # 获取所有提醒数据
        reminders_data = get_all_reminders_dict()
        reminder_count = sum(
            len(chat_reminders) for chat_reminders in reminders_data.values())

        # 使用框架提供的 save_state 方法保存数据
        interface.save_state(reminders_data)
        interface.logger.debug(f"已保存 {reminder_count} 个提醒数据到框架状态")

        # 如果需要，同时保存到配置文件
        if save_to_config:
            import os
            import json
            config_file = "config/reminders.json"
            os.makedirs(os.path.dirname(config_file), exist_ok=True)
            with open(config_file, 'w', encoding='utf-8') as f:
                json.dump(reminders_data, f, indent=2, ensure_ascii=False)
            interface.logger.debug(
                f"已同步 {reminder_count} 个提醒数据到配置文件 {config_file}")

        return True
    except Exception as e:
        interface.logger.error(f"保存提醒数据失败: {e}")
        return False


def get_reminder(chat_id, reminder_id):
    """获取特定提醒的数据"""
    chat_id_str = str(chat_id)
    reminder_id_str = str(reminder_id)

    if chat_id_str in _tasks and reminder_id_str in _tasks[chat_id_str]:
        reminder = _tasks[chat_id_str][reminder_id_str].get("reminder")
        if reminder:
            return reminder.to_dict()
    return None


def delete_reminder(chat_id, reminder_id, interface):
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
        save_reminders(interface)
        return True
    return False


def parse_interval(interval_str):
    """解析时间间隔字符串为秒数或元组 (秒数, 第一次提醒时间戳)"""
    now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))

    # 处理日期格式 "6月25日16:00" (每年6月25日16:00)
    match = re.match(r"(\d+)月(\d+)日(?:(\d+)[:](\d+)(?:[:](\d+))?)?$",
                     interval_str)
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
            # 计算今年的这个日期
            this_year = datetime(now.year, month, day, hour, minute, second)
            this_year_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(this_year)

            # 计算明年的这个日期
            next_year = datetime(now.year + 1, month, day, hour, minute,
                                 second)
            next_year_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(next_year)

            # 确定下一次提醒的时间
            if this_year_tz > now:
                # 如果今年的日期还没到，使用今年的
                next_reminder_time = this_year_tz.timestamp()
            else:
                # 如果今年的日期已过，使用明年的
                next_reminder_time = next_year_tz.timestamp()

            # 返回一年的秒数、第一次提醒时间、原始模式和模式类型
            return {
                "interval": 31536000,  # 365 * 24 * 60 * 60
                "first_time": next_reminder_time,
                "pattern": interval_str,
                "pattern_type": "yearly",
                "pattern_data": {
                    "month": month,
                    "day": day,
                    "hour": hour,
                    "minute": minute,
                    "second": second
                }
            }
        except ValueError:
            # 无效日期
            return None

    # 处理日期格式 "25日" (每月25日)
    match = re.match(r"(\d+)日$", interval_str)
    if match:
        day = int(match.group(1))

        try:
            # 计算本月的这个日期
            this_month = datetime(now.year, now.month, day)
            this_month_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(
                this_month)

            # 计算下个月的这个日期
            if now.month == 12:
                next_month = datetime(now.year + 1, 1, day)
            else:
                next_month = datetime(now.year, now.month + 1, day)
            next_month_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(
                next_month)

            # 确定下一次提醒的时间
            if this_month_tz > now:
                # 如果本月的日期还没到，使用本月的
                next_reminder_time = this_month_tz.timestamp()
            else:
                # 如果本月的日期已过，使用下个月的
                next_reminder_time = next_month_tz.timestamp()

            # 返回一个月的秒数、第一次提醒时间、原始模式和模式类型
            return {
                "interval": 2592000,  # 30 * 24 * 60 * 60
                "first_time": next_reminder_time,
                "pattern": interval_str,
                "pattern_type": "monthly",
                "pattern_data": {
                    "day": day
                }
            }
        except ValueError:
            # 无效日期
            return None

    # 处理时间格式 "16:00" (每天16:00)
    match = re.match(r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$", interval_str)
    if match:
        hour, minute = int(match.group(1)), int(match.group(2))
        second = int(match.group(3)) if match.group(3) else 0

        try:
            # 计算今天的这个时间
            today = now.replace(hour=hour,
                                minute=minute,
                                second=second,
                                microsecond=0)

            # 如果今天的时间已过，则使用明天的
            if today < now:
                today = today + timedelta(days=1)

            # 返回一天的秒数、第一次提醒时间、原始模式和模式类型
            return {
                "interval": 86400,  # 24 * 60 * 60
                "first_time": today.timestamp(),
                "pattern": interval_str,
                "pattern_type": "daily",
                "pattern_data": {
                    "hour": hour,
                    "minute": minute,
                    "second": second
                }
            }
        except ValueError:
            # 无效时间
            return None

    # 处理标准时间间隔格式
    # 中文单位
    chinese_units = {
        "秒": 1,
        "分钟": 60,
        "小时": 3600,
        "天": 86400,
        "周": 604800,
        "月": 2592000,  # 30天
        "年": 31536000  # 365天
    }

    # 英文单位（支持多种写法）
    english_units = {
        "s": 1,
        "sec": 1,
        "second": 1,
        "seconds": 1,
        "m": 60,
        "min": 60,
        "minute": 60,
        "minutes": 60,
        "h": 3600,
        "hr": 3600,
        "hour": 3600,
        "hours": 3600,
        "d": 86400,
        "day": 86400,
        "days": 86400,
        "w": 604800,
        "week": 604800,
        "weeks": 604800,
        "mon": 2592000,
        "month": 2592000,
        "months": 2592000,
        "y": 31536000,
        "year": 31536000,
        "years": 31536000
    }

    # 处理中文格式
    total_seconds = 0
    remaining = interval_str

    for unit, seconds in chinese_units.items():
        parts = remaining.split(unit, 1)
        if len(parts) > 1:
            try:
                value = float(parts[0])
                total_seconds += value * seconds
                remaining = parts[1]
            except ValueError:
                pass

    if total_seconds > 0 and not remaining.strip():
        return total_seconds

    # 处理英文格式
    # 尝试匹配 "1h2m3s" 这种格式
    pattern = r"(\d+)([a-zA-Z]+)"
    matches = re.findall(pattern, interval_str)

    if matches:
        total_seconds = 0
        for value, unit in matches:
            if unit in english_units:
                total_seconds += int(value) * english_units[unit]

        if total_seconds > 0:
            return total_seconds

    # 尝试匹配纯数字 + 单位格式，如 "30min"
    match = re.match(r"^(\d+)([a-zA-Z]+)$", interval_str)
    if match:
        value, unit = match.groups()
        if unit in english_units:
            return int(value) * english_units[unit]

    # 尝试匹配纯数字（假设是秒）
    if interval_str.isdigit():
        return int(interval_str)

    return None


def parse_datetime(datetime_str):
    """解析日期时间字符串为 datetime 对象"""
    now = datetime.now(pytz.timezone(DEFAULT_TIMEZONE))

    # 处理时间间隔格式（如 "30s", "5min", "1h" 等）
    interval_seconds = parse_interval(datetime_str)
    if interval_seconds is not None:
        # 计算目标时间 = 当前时间 + 间隔
        target_time = now + timedelta(seconds=interval_seconds)
        return target_time

    # 处理 "6-25 16:00" 或 "6/25 16:00" 格式
    match = re.match(
        r"^(\d{1,2})[-/](\d{1,2})\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$",
        datetime_str)
    if match:
        month, day = int(match.group(1)), int(match.group(2))
        hour, minute = int(match.group(3)), int(match.group(4))
        second = int(match.group(5)) if match.group(5) else 0

        try:
            dt = datetime(now.year, month, day, hour, minute, second)
            dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            # 如果日期已过，假设是明年
            if dt_with_tz < now:
                dt = datetime(now.year + 1, month, day, hour, minute, second)
                dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            return dt_with_tz
        except ValueError:
            # 无效日期
            return None

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

    # 处理日期格式 "25日" (每月25日)
    match = re.match(r"(\d+)日$", datetime_str)
    if match:
        day = int(match.group(1))

        try:
            # 尝试当前月份
            dt = datetime(now.year, now.month, day, 0, 0, 0)
            dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            # 如果日期已过，则使用下个月
            if dt_with_tz < now:
                # 计算下个月
                if now.month == 12:
                    next_month = 1
                    next_year = now.year + 1
                else:
                    next_month = now.month + 1
                    next_year = now.year

                dt = datetime(next_year, next_month, day, 0, 0, 0)
                dt_with_tz = pytz.timezone(DEFAULT_TIMEZONE).localize(dt)

            return dt_with_tz
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


def format_interval(seconds, original_str=None, first_time=None):
    """将秒数格式化为可读的时间间隔

    Args:
        seconds: 间隔秒数
        original_str: 原始输入字符串
        first_time: 第一次提醒的时间戳
    """
    # 如果有原始字符串，优先使用
    if original_str:
        # 检查是否是日期格式
        if re.match(r"(\d+)月(\d+)日", original_str):
            return f"每年{original_str}"
        elif re.match(r"(\d+)日$", original_str):
            return f"每月{original_str}"
        elif re.match(r"(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?$", original_str):
            return f"每天{original_str}"

    # 如果有第一次提醒时间，检查是否是特殊周期
    if first_time:
        dt = datetime.fromtimestamp(first_time,
                                    pytz.timezone(DEFAULT_TIMEZONE))

        # 检查是否是每年的特定日期
        if seconds == 31536000:  # 365天
            return f"每年{dt.month}月{dt.day}日{dt.hour:02d}:{dt.minute:02d}"

        # 检查是否是每月的特定日期
        elif seconds == 2592000:  # 30天
            return f"每月{dt.day}日{dt.hour:02d}:{dt.minute:02d}"

        # 检查是否是每天的特定时间
        elif seconds == 86400:  # 24小时
            return f"每天{dt.hour:02d}:{dt.minute:02d}"

    # 处理标准时间间隔
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


async def start_reminder_tasks(context, interface):
    """启动所有提醒任务"""
    global _tasks
    _tasks = {}

    interface.logger.info("正在启动提醒任务...")

    # 加载提醒数据
    reminders_data = {}
    config_file = "config/reminders.json"

    # 尝试从框架状态加载
    try:
        state_data = interface.load_state()
        if state_data:
            reminders_data = state_data
            reminder_count = sum(
                len(chat_reminders)
                for chat_reminders in reminders_data.values())
            interface.logger.info(f"已从框架状态加载 {reminder_count} 个提醒")
        # 如果框架状态中没有数据，尝试从配置文件加载
        elif os.path.exists(config_file):
            try:
                with open(config_file, 'r', encoding='utf-8') as f:
                    reminders_data = json.load(f)
                    reminder_count = sum(
                        len(chat_reminders)
                        for chat_reminders in reminders_data.values())
                    interface.logger.info(f"已从配置文件加载 {reminder_count} 个提醒")

                    # 同步到框架状态
                    interface.save_state(reminders_data)
            except Exception as e:
                interface.logger.error(f"从配置文件加载提醒数据失败: {e}")
        else:
            interface.logger.warning("没有找到提醒数据，将创建新文件")
    except Exception as e:
        interface.logger.error(f"加载提醒数据失败: {e}")

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
            task = asyncio.create_task(reminder.start_task(context, interface))
            _tasks[chat_id_str][reminder_id] = {
                "reminder": reminder,
                "task": task
            }
            task_count += 1

    if task_count > 0:
        interface.logger.info(f"已启动 {task_count} 个提醒任务")
    else:
        interface.logger.info("没有找到需要启动的提醒任务")

    # 保存更新的状态
    save_reminders(interface)


def stop_reminder_tasks(interface):
    """停止所有提醒任务"""
    interface.logger.info("正在停止所有提醒任务...")

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

    save_reminders(interface)
    interface.logger.info(f"已停止 {task_count} 个提醒任务")


async def remind_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /remind 命令 - 创建周期性提醒"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await message.reply_text("系统错误，请联系管理员")
        return

    # 显示主菜单
    keyboard = [[
        InlineKeyboardButton("Periodic",
                             callback_data=f"{CALLBACK_PREFIX}periodic"),
        InlineKeyboardButton("One-time",
                             callback_data=f"{CALLBACK_PREFIX}onetime")
    ], [InlineKeyboardButton("List", callback_data=f"{CALLBACK_PREFIX}list")]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    await message.reply_text(
        "📅 *提醒功能*\n\n"
        "请选择要创建的提醒类型：\n\n"
        "• *周期性提醒*：按固定时间间隔重复提醒\n"
        "• *一次性提醒*：在指定时间提醒一次\n"
        "• *查看提醒*：列出当前所有提醒",
        reply_markup=reply_markup,
        parse_mode="MARKDOWN")


# 模块使用框架的状态管理器和配置文件同时保存数据，确保数据持久化


async def handle_reminder_input(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理用户输入的提醒信息"""
    # 处理所有聊天类型的消息
    message = update.message
    if not message:
        return

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        return

    # 检查是否是 reminder 模块的活跃会话
    is_active = await session_manager.get(user_id,
                                          "reminder_active",
                                          False,
                                          chat_id=chat_id)
    if not is_active:
        return

    # 获取会话状态
    reminder_type = await session_manager.get(user_id,
                                              "reminder_type",
                                              None,
                                              chat_id=chat_id)
    reminder_step = await session_manager.get(user_id,
                                              "reminder_step",
                                              None,
                                              chat_id=chat_id)

    # 获取模块接口
    interface = context.bot_data["module_manager"].get_module_info(
        "reminder")["interface"]

    # 处理周期性提醒
    if reminder_type == "periodic":
        if reminder_step == "interval":
            # 解析时间间隔
            interval_str = message.text.strip()
            interval_result = parse_interval(interval_str)

            if interval_result is None:
                await message.reply_text(
                    "⚠️ 无法识别的时间格式，请使用如:\n"
                    "- 中文: 分钟、小时、天、周、月、年\n"
                    "- 英文: s/sec, m/min, h/hr, d/day, w/week, mon/month, y/year\n"
                    "- 复合时间: 2年3月、1天12小时30分钟\n"
                    "- 英文复合: 1y2mon3d、1d12h30min\n"
                    "- 日期格式: 6月25日16:00（每年）、25日（每月）、16:00（每天）")
                return

            # 处理不同格式的返回值
            first_reminder_time = None
            pattern = None
            pattern_type = None

            if isinstance(interval_result, dict):
                # 日期格式返回字典 {"interval": 秒数, "first_time": 时间戳, "pattern": 原始模式, "pattern_type": 模式类型}
                interval_seconds = interval_result["interval"]
                first_reminder_time = interval_result["first_time"]
                pattern = interval_result.get("pattern")
                pattern_type = interval_result.get("pattern_type")
            else:
                # 标准时间间隔格式返回秒数
                interval_seconds = interval_result
                pattern_type = "standard"

            # 检查最小间隔
            if interval_seconds < MIN_INTERVAL:
                await message.reply_text(f"⚠️ 提醒间隔太短，最小间隔为 {MIN_INTERVAL} 秒")
                return

            # 保存间隔、原始字符串、第一次提醒时间和模式信息并进入下一步
            await session_manager.set(user_id,
                                      "reminder_interval",
                                      interval_seconds,
                                      chat_id=chat_id)
            await session_manager.set(user_id,
                                      "reminder_interval_str",
                                      interval_str,
                                      chat_id=chat_id)
            if first_reminder_time:
                await session_manager.set(user_id,
                                          "reminder_first_time",
                                          first_reminder_time,
                                          chat_id=chat_id)
            if pattern:
                await session_manager.set(user_id,
                                          "reminder_pattern",
                                          pattern,
                                          chat_id=chat_id)
            if pattern_type:
                await session_manager.set(user_id,
                                          "reminder_pattern_type",
                                          pattern_type,
                                          chat_id=chat_id)
            await session_manager.set(user_id,
                                      "reminder_step",
                                      "message",
                                      chat_id=chat_id)

            # 发送提示消息
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}cancel")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await message.reply_text("请输入提醒内容：", reply_markup=reply_markup)

        elif reminder_step == "message":
            # 获取提醒内容
            reminder_message = message.text.strip()

            if not reminder_message:
                await message.reply_text("⚠️ 提醒内容不能为空")
                return

            # 获取之前保存的间隔、第一次提醒时间和模式信息
            interval_seconds = await session_manager.get(user_id,
                                                         "reminder_interval",
                                                         None,
                                                         chat_id=chat_id)
            first_reminder_time = await session_manager.get(
                user_id, "reminder_first_time", None, chat_id=chat_id)
            pattern = await session_manager.get(user_id,
                                                "reminder_pattern",
                                                None,
                                                chat_id=chat_id)
            pattern_type = await session_manager.get(user_id,
                                                     "reminder_pattern_type",
                                                     "standard",
                                                     chat_id=chat_id)

            # 清除会话状态
            await session_manager.delete(user_id,
                                         "reminder_type",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_step",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_interval",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_interval_str",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_first_time",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_pattern",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_pattern_type",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_active",
                                         chat_id=chat_id)

            # 生成提醒 ID
            reminder_id = str(int(time.time()))

            # 创建周期性提醒
            chat_id = update.effective_chat.id
            chat_id_str = str(chat_id)
            reminder = PeriodicReminder(
                reminder_id, reminder_message, update.effective_user.id,
                update.effective_user.full_name
                or update.effective_user.username or "未知用户", chat_id_str,
                update.effective_chat.type, interval_seconds,
                first_reminder_time, None, pattern, pattern_type)

            # 初始化聊天记录
            if chat_id_str not in _tasks:
                _tasks[chat_id_str] = {}

            # 启动任务
            task = asyncio.create_task(reminder.start_task(context, interface))
            _tasks[chat_id_str][reminder_id] = {
                "reminder": reminder,
                "task": task
            }

            # 保存更新
            save_reminders(interface)

            # 获取原始输入字符串
            interval_str = await session_manager.get(user_id,
                                                     "reminder_interval_str",
                                                     None,
                                                     chat_id=chat_id)

            # 格式化时间间隔
            interval_text = format_interval(interval_seconds, interval_str,
                                            first_reminder_time)

            # 发送确认消息
            await message.reply_text(
                f"✅ 周期性提醒已创建!\n\n"
                f"⏰ *间隔:* {interval_text}\n"
                f"📝 *内容:* {reminder_message}\n"
                f"🆔 *提醒 ID:* `{reminder_id}`\n\n"
                f"我会按照 {interval_text} 发送提醒\n"
                f"如需删除请在 /remind 面板中操作",
                parse_mode="MARKDOWN")

            interface.logger.info(
                f"用户 {update.effective_user.id} 创建了周期性提醒 {reminder_id}，"
                f"间隔 {interval_text}")

    # 处理一次性提醒
    elif reminder_type == "onetime":
        if reminder_step == "datetime":
            # 解析日期时间
            datetime_str = message.text.strip()
            target_datetime = parse_datetime(datetime_str)

            if target_datetime is None:
                await message.reply_text("⚠️ 无法识别的时间格式，请使用如:\n"
                                         "- 2025年4月5日18:30\n"
                                         "- 4月5日16:00\n"
                                         "- 6-25 16:00\n"
                                         "- 2025/04/05 18:30\n"
                                         "- 18:30 (今天或明天)\n"
                                         "- 30s、5min、1h (从现在开始计时)")
                return

            # 转换为时间戳
            target_timestamp = target_datetime.timestamp()

            # 检查是否是过去的时间
            now_timestamp = time.time()
            if target_timestamp <= now_timestamp:
                await message.reply_text("⚠️ 提醒时间不能是过去的时间")
                return

            # 保存时间戳并进入下一步
            await session_manager.set(user_id,
                                      "reminder_datetime",
                                      target_timestamp,
                                      chat_id=chat_id)
            await session_manager.set(
                user_id,
                "reminder_datetime_str",
                target_datetime.strftime("%Y-%m-%d %H:%M:%S"),
                chat_id=chat_id)
            await session_manager.set(user_id,
                                      "reminder_step",
                                      "message",
                                      chat_id=chat_id)

            # 发送提示消息
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}cancel")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await message.reply_text("请输入提醒内容：", reply_markup=reply_markup)

        elif reminder_step == "message":
            # 获取提醒内容
            reminder_message = message.text.strip()

            if not reminder_message:
                await message.reply_text("⚠️ 提醒内容不能为空")
                return

            # 获取之前保存的时间戳
            target_timestamp = await session_manager.get(user_id,
                                                         "reminder_datetime",
                                                         None,
                                                         chat_id=chat_id)
            target_datetime_str = await session_manager.get(
                user_id, "reminder_datetime_str", None, chat_id=chat_id)

            # 清除会话状态
            await session_manager.delete(user_id,
                                         "reminder_type",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_step",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_datetime",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_datetime_str",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "reminder_active",
                                         chat_id=chat_id)

            # 生成提醒 ID
            reminder_id = str(int(time.time()))

            # 创建一次性提醒
            chat_id = update.effective_chat.id
            chat_id_str = str(chat_id)
            reminder = OneTimeReminder(
                reminder_id, reminder_message, update.effective_user.id,
                update.effective_user.full_name
                or update.effective_user.username or "未知用户", chat_id_str,
                update.effective_chat.type, target_timestamp,
                target_datetime_str)

            # 初始化聊天记录
            if chat_id_str not in _tasks:
                _tasks[chat_id_str] = {}

            # 启动任务
            task = asyncio.create_task(reminder.start_task(context, interface))
            _tasks[chat_id_str][reminder_id] = {
                "reminder": reminder,
                "task": task
            }

            # 保存更新
            save_reminders(interface)

            # 计算等待时间
            now_timestamp = time.time()
            wait_seconds = target_timestamp - now_timestamp
            wait_text = format_interval(int(wait_seconds))

            # 发送确认消息
            await message.reply_text(
                f"✅ 一次性提醒已创建!\n\n"
                f"⏰ *时间:* {target_datetime_str}\n"
                f"⏳ *等待:* {wait_text}\n"
                f"📝 *内容:* {reminder_message}\n"
                f"🆔 *提醒 ID:* `{reminder_id}`\n\n"
                f"到时间我会发送一次提醒\n"
                f"如需删除请在 /remind 面板中操作",
                parse_mode="MARKDOWN")

            interface.logger.info(
                f"用户 {update.effective_user.id} 创建了一次性提醒 {reminder_id}，"
                f"时间 {target_datetime_str}")


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

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
    if action == "periodic":
        # 设置会话状态，等待用户输入周期性提醒信息
        await session_manager.set(user_id,
                                  "reminder_type",
                                  "periodic",
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "reminder_step",
                                  "interval",
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "reminder_active",
                                  True,
                                  chat_id=chat_id)

        # 发送提示消息
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}cancel")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(
            "请输入提醒间隔：\n\n"
            "例如：30分钟、2小时、1天、1周等\n"
            "复合时间：2天3小时、1年2月3天\n"
            "英文格式：30min、2h、1d、1w等\n"
            "日期格式：6月25日16:00（每年）、25日（每月）、16:00（每天）",
            reply_markup=reply_markup)

    elif action == "onetime":
        # 设置会话状态，等待用户输入一次性提醒信息
        await session_manager.set(user_id,
                                  "reminder_type",
                                  "onetime",
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "reminder_step",
                                  "datetime",
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "reminder_active",
                                  True,
                                  chat_id=chat_id)

        # 发送提示消息
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}cancel")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(
            "请输入提醒时间：\n\n"
            "例如：8:30、明天9:00、2025年4月5日18:30\n"
            "或：4月5日16:00、6-25 16:00等\n"
            "时间间隔：30s、5min、1h（从现在开始计时）",
            reply_markup=reply_markup)

    elif action == "cancel":
        # 清除会话状态
        await session_manager.delete(user_id, "reminder_type", chat_id=chat_id)
        await session_manager.delete(user_id, "reminder_step", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "reminder_interval",
                                     chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "reminder_interval_str",
                                     chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "reminder_first_time",
                                     chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "reminder_datetime",
                                     chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "reminder_active",
                                     chat_id=chat_id)

        # 返回主菜单
        keyboard = [[
            InlineKeyboardButton("Periodic",
                                 callback_data=f"{CALLBACK_PREFIX}periodic"),
            InlineKeyboardButton("One-time",
                                 callback_data=f"{CALLBACK_PREFIX}onetime")
        ],
                    [
                        InlineKeyboardButton(
                            "List", callback_data=f"{CALLBACK_PREFIX}list")
                    ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(
            "📅 *提醒功能*\n\n"
            "请选择要创建的提醒类型：\n\n"
            "• *周期性提醒*：按固定时间间隔重复提醒\n"
            "• *一次性提醒*：在指定时间提醒一次\n"
            "• *查看提醒*：列出当前所有提醒",
            reply_markup=reply_markup,
            parse_mode="MARKDOWN")

    elif action == "list":
        # 显示提醒列表
        chat_id = update.effective_chat.id
        chat_id_str = str(chat_id)

        # 检查是否有提醒
        if chat_id_str not in _tasks or not _tasks[chat_id_str]:
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}cancel")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text("当前聊天没有创建任何提醒",
                                          reply_markup=reply_markup)
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
        reminder_list_message = "📋 *当前聊天的提醒列表:*\n\n"

        # 一次性提醒
        if one_time_reminders:
            reminder_list_message += "*一次性提醒:*\n"
            for reminder in one_time_reminders:
                status = "✅ 已启用" if reminder.enabled else "❌ 已禁用"
                creator_info = f" (由 {reminder.creator_name} 创建)" if update.effective_chat.type != "private" else ""

                reminder_list_message += (
                    f"🔹 *{reminder.title}*{creator_info}\n"
                    f"  🆔 ID: `{reminder.id}`\n"
                    f"  ⏰ 时间: {reminder.target_time_str}\n"
                    f"  📝 内容: {reminder.message}\n"
                    f"  🔄 状态: {status}\n\n")

        # 周期性提醒
        if periodic_reminders:
            reminder_list_message += "*周期性提醒:*\n"
            for reminder in periodic_reminders:
                status = "✅ 已启用" if reminder.enabled else "❌ 已禁用"
                interval_text = format_interval(reminder.interval, None,
                                                reminder.first_reminder_time)
                creator_info = f" (由 {reminder.creator_name} 创建)" if update.effective_chat.type != "private" else ""

                reminder_list_message += (
                    f"🔹 *{reminder.title}*{creator_info}\n"
                    f"  🆔 ID: `{reminder.id}`\n"
                    f"  ⏰ 间隔: {interval_text}\n"
                    f"  📝 内容: {reminder.message}\n"
                    f"  🔄 状态: {status}\n\n")

        # 如果没有任何提醒
        if not one_time_reminders and not periodic_reminders:
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}cancel")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text("当前聊天没有创建任何提醒",
                                          reply_markup=reply_markup)
            return

        # 添加删除和返回按钮
        keyboard = [[
            InlineKeyboardButton("Delete Reminders",
                                 callback_data=f"{CALLBACK_PREFIX}delete")
        ],
                    [
                        InlineKeyboardButton(
                            "⇠ Back", callback_data=f"{CALLBACK_PREFIX}cancel")
                    ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        # 发送消息
        try:
            await query.edit_message_text(reminder_list_message,
                                          reply_markup=reply_markup,
                                          parse_mode="MARKDOWN")
        except Exception as e:
            _module_interface.logger.error(f"发送提醒列表失败: {e}")
            # 尝试发送纯文本
            await query.edit_message_text(reminder_list_message.replace(
                "*", "").replace("`", ""),
                                          reply_markup=reply_markup)

    # 处理删除提醒界面
    elif action == "delete":
        chat_id = update.effective_chat.id
        chat_id_str = str(chat_id)

        # 检查是否有提醒
        if chat_id_str not in _tasks or not _tasks[chat_id_str]:
            await query.answer("当前聊天没有创建任何提醒")
            return

        # 构建提醒列表按钮
        keyboard = []

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

        # 添加一次性提醒按钮
        if one_time_reminders:
            for reminder in one_time_reminders:
                button_text = f"🕒 {reminder.title} ({reminder.target_time_str})"
                keyboard.append([
                    InlineKeyboardButton(
                        button_text,
                        callback_data=f"{CALLBACK_PREFIX}del_{reminder.id}")
                ])

        # 添加周期性提醒按钮
        if periodic_reminders:
            for reminder in periodic_reminders:
                interval_text = format_interval(reminder.interval, None,
                                                reminder.first_reminder_time)
                button_text = f"🔄 {reminder.title} ({interval_text})"
                keyboard.append([
                    InlineKeyboardButton(
                        button_text,
                        callback_data=f"{CALLBACK_PREFIX}del_{reminder.id}")
                ])

        # 添加返回按钮
        keyboard.append([
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}list")
        ])

        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text("请选择要删除的提醒：", reply_markup=reply_markup)

    # 处理删除提醒操作
    elif action.startswith("del_"):
        # 获取提醒 ID
        reminder_id = action[4:]
        chat_id = update.effective_chat.id
        chat_id_str = str(chat_id)

        # 检查提醒是否存在
        if (chat_id_str not in _tasks
                or reminder_id not in _tasks[chat_id_str]):
            await query.answer("❌ 找不到该提醒或已被删除")

            # 返回主菜单
            keyboard = [[
                InlineKeyboardButton(
                    "Periodic", callback_data=f"{CALLBACK_PREFIX}periodic"),
                InlineKeyboardButton("One-time",
                                     callback_data=f"{CALLBACK_PREFIX}onetime")
            ],
                        [
                            InlineKeyboardButton(
                                "List", callback_data=f"{CALLBACK_PREFIX}list")
                        ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text(
                "📅 *提醒功能*\n\n"
                "请选择要创建的提醒类型：\n\n"
                "• *周期性提醒*：按固定时间间隔重复提醒\n"
                "• *一次性提醒*：在指定时间提醒一次\n"
                "• *查看提醒*：列出当前所有提醒",
                reply_markup=reply_markup,
                parse_mode="MARKDOWN")
            return

        # 获取提醒对象
        reminder = _tasks[chat_id_str][reminder_id].get("reminder")
        if not reminder:
            await query.answer("❌ 找不到该提醒或已被删除")
            return

        # 检查权限（群组中只有创建者或管理员可以删除）
        if update.effective_chat.type != "private":
            user_id = update.effective_user.id

            if reminder.creator_id != user_id:
                chat_member = await context.bot.get_chat_member(
                    chat_id, user_id)
                is_admin = chat_member.status in ["creator", "administrator"]

                if not is_admin:
                    await query.answer("⚠️ 您没有权限删除此提醒，只有提醒创建者或群组管理员可以删除")
                    return

        # 删除提醒
        reminder_title = reminder.title
        if delete_reminder(chat_id, reminder_id, _module_interface):
            await query.answer(f"✅ 提醒 \"{reminder_title}\" 已删除")
            _module_interface.logger.info(
                f"用户 {update.effective_user.id} 删除了提醒 {reminder_id}")

            # 返回主菜单
            keyboard = [[
                InlineKeyboardButton(
                    "Periodic", callback_data=f"{CALLBACK_PREFIX}periodic"),
                InlineKeyboardButton("One-time",
                                     callback_data=f"{CALLBACK_PREFIX}onetime")
            ],
                        [
                            InlineKeyboardButton(
                                "List", callback_data=f"{CALLBACK_PREFIX}list")
                        ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text(
                "📅 *提醒功能*\n\n"
                "请选择要创建的提醒类型：\n\n"
                "• *周期性提醒*：按固定时间间隔重复提醒\n"
                "• *一次性提醒*：在指定时间提醒一次\n"
                "• *查看提醒*：列出当前所有提醒",
                reply_markup=reply_markup,
                parse_mode="MARKDOWN")
        else:
            await query.answer("❌ 删除提醒失败，请稍后再试")

    # 确保回调查询得到响应
    await query.answer()


async def setup(interface):
    """模块初始化"""
    global _update_generation, _tasks, _module_interface
    _update_generation = 0
    _tasks = {}
    _module_interface = interface

    # 注册命令
    await interface.register_command("remind",
                                     remind_command,
                                     admin_level=False,
                                     description="创建提醒")

    # 注册带权限验证的按钮回调处理器
    await interface.register_callback_handler(
        handle_callback_query,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level=False  # 所有用户都可以使用
    )

    # 注册文本输入处理器，处理所有聊天类型的消息
    text_input_handler = MessageHandler(filters.TEXT & ~filters.COMMAND,
                                        handle_reminder_input)
    await interface.register_handler(text_input_handler, group=4)

    # 加载提醒数据（优先从框架状态加载，如果没有则从配置文件加载）
    interface.logger.info("准备加载提醒数据")

    # 启动提醒任务
    await start_reminder_tasks(interface.application, interface)

    # 创建自动保存任务
    async def auto_save():
        while True:
            try:
                await asyncio.sleep(AUTOSAVE_INTERVAL)
                # 保存提醒数据（同时保存到框架状态和配置文件）
                save_reminders(interface, save_to_config=True)
                interface.logger.debug("已自动保存提醒数据")
            except asyncio.CancelledError:
                interface.logger.debug("自动保存任务已取消")
                break
            except Exception as e:
                interface.logger.error(f"自动保存任务出错: {e}")

    interface.auto_save_task = asyncio.create_task(auto_save())

    # 记录模块初始化
    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理"""
    interface.logger.info(f"正在清理模块 {MODULE_NAME}")

    # 取消自动保存任务
    if hasattr(interface, "auto_save_task") and interface.auto_save_task:
        interface.auto_save_task.cancel()
        try:
            await interface.auto_save_task
        except asyncio.CancelledError:
            pass

    # 停止所有提醒任务
    stop_reminder_tasks(interface)

    # 保存状态（持久化存储）
    reminders_data = get_all_reminders_dict()
    reminder_count = sum(
        len(chat_reminders) for chat_reminders in reminders_data.values())

    # 保存提醒数据（同时保存到框架状态和配置文件）
    save_reminders(interface, save_to_config=True)
    interface.logger.info(f"已保存 {reminder_count} 个提醒到框架状态和配置文件")

    interface.logger.info(f"模块 {MODULE_NAME} 已清理完成")
