# modules/weather.py - 天气查询模块

import aiohttp
import json
import os
import asyncio
from datetime import datetime
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, CallbackQueryHandler

# 模块元数据
MODULE_NAME = "weather"
MODULE_VERSION = "3.0.0"
MODULE_DESCRIPTION = "天气查询，支持多种天气源"
MODULE_COMMANDS = ["weather", "forecast", "weatherset"]
MODULE_CHAT_TYPES = ["private", "group"]  # 支持所有聊天类型

# 模块状态
_state = {
    "user_locations": {},  # 用户默认位置
    "active_source": "openweathermap",  # 默认天气源
    "api_keys": {},  # 各源的 API 密钥
    "cache": {},  # 缓存最近的天气数据
    "cache_time": {}  # 缓存时间
}

# 模块接口
_module_interface = None

# 支持的天气源
WEATHER_SOURCES = {
    "openweathermap": {
        "name": "OpenWeatherMap",
        "url": "https://api.openweathermap.org/data/2.5/weather",
        "forecast_url": "https://api.openweathermap.org/data/2.5/forecast",
        "params": lambda location, api_key: {
            "q": location,
            "appid": api_key,
            "units": "metric",
            "lang": "zh_cn"
        }
    },
    "qweather": {
        "name": "和风天气",
        "url": "https://devapi.qweather.com/v7/weather/now",
        "forecast_url": "https://devapi.qweather.com/v7/weather/7d",
        "params": lambda location, api_key: {
            "location": location,
            "key": api_key,
            "lang": "zh"
        },
        "location_type": "name"
    },
    "caiyunapp": {
        "name": "彩云天气",
        "url": "https://api.caiyunapp.com/v2/{key}/{location}/realtime",
        "forecast_url":
        "https://api.caiyunapp.com/v2/{key}/{location}/daily?dailysteps={days}",
        "params": lambda location, api_key: {  # 彩云天气不需要额外参数，但保留函数签名一致性
            # 这里不使用参数，因为已经在 URL 中包含了
            "dummy": "placeholder"
        },
        "requires_coords": True
    }
}

# 天气图标映射
WEATHER_ICONS = {
    # 晴天
    "clear": "☀️",
    "sunny": "☀️",
    "clear sky": "☀️",
    "晴": "☀️",
    "晴天": "☀️",
    "晴夜": "🌙",
    "CLEAR_DAY": "☀️",
    "CLEAR_NIGHT": "🌙",

    # 多云
    "clouds": "☁️",
    "cloudy": "☁️",
    "few clouds": "🌤️",
    "scattered clouds": "⛅",
    "broken clouds": "☁️",
    "overcast clouds": "☁️",
    "多云": "⛅",
    "局部多云": "🌤️",
    "晴间多云": "🌤️",
    "阴": "☁️",
    "阴天": "☁️",
    "PARTLY_CLOUDY_DAY": "🌤️",
    "PARTLY_CLOUDY_NIGHT": "☁️",
    "CLOUDY": "☁️",

    # 雨
    "rain": "🌧️",
    "light rain": "🌦️",
    "moderate rain": "🌧️",
    "heavy rain": "⛈️",
    "小雨": "🌦️",
    "中雨": "🌧️",
    "大雨": "⛈️",
    "暴雨": "🌊",
    "LIGHT_RAIN": "🌦️",
    "MODERATE_RAIN": "🌧️",
    "HEAVY_RAIN": "⛈️",
    "STORM_RAIN": "🌊",

    # 雪
    "snow": "❄️",
    "light snow": "🌨️",
    "moderate snow": "❄️",
    "heavy snow": "⛄",
    "小雪": "🌨️",
    "中雪": "❄️",
    "大雪": "⛄",
    "暴雪": "☃️",
    "LIGHT_SNOW": "🌨️",
    "MODERATE_SNOW": "❄️",
    "HEAVY_SNOW": "⛄",
    "STORM_SNOW": "☃️",

    # 雾霾
    "mist": "🌫️",
    "fog": "🌫️",
    "haze": "😷",
    "雾": "🌫️",
    "霾": "😷",
    "FOG": "🌫️",
    "HAZE": "😷",

    # 雷暴
    "thunderstorm": "⚡",
    "雷阵雨": "⚡",
    "雷暴": "🌩️",

    # 默认
    "default": "🌈"
}

# 风向图标
WIND_ICONS = {
    "北": "⬇️",
    "东北": "↙️",
    "东": "⬅️",
    "东南": "↖️",
    "南": "⬆️",
    "西南": "↗️",
    "西": "➡️",
    "西北": "↘️"
}

# 配置文件路径
CONFIG_FILE = "config/weather_config.json"
# 缓存过期时间（分钟）
CACHE_EXPIRY = 30

# 回调前缀
CALLBACK_PREFIX = "weather_"

# 会话状态
SESSION_WAITING_API_KEY = "waiting_api_key"


async def weather_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """查询当前天气

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    user_id = str(update.effective_user.id)

    # 获取位置参数
    location = " ".join(context.args) if context.args else None

    # 如果没提供位置，使用默认位置
    if not location:
        if user_id in _state["user_locations"]:
            location = _state["user_locations"][user_id]
        else:
            await message.reply_text("🌍 请提供位置名称，如: /weather 北京")
            return
    else:
        # 记住用户的位置
        _state["user_locations"][user_id] = location
        if _module_interface:
            _module_interface.logger.info(f"用户 {user_id} 设置了默认位置: {location}")

    # 获取活跃的天气源
    source = _state["active_source"]
    api_key = _state["api_keys"].get(source)

    if not api_key:
        await message.reply_text(
            f"⚠️ 未设置 {WEATHER_SOURCES[source]['name']} 的 API 密钥，请使用 /weatherset 命令设置"
        )
        return

    # 发送等待消息
    waiting_msg = await message.reply_text("🔍 正在查询天气，请稍候...")

    # 检查缓存
    cache_key = f"weather:{source}:{location}"
    if cache_key in _state["cache"] and _state["cache_time"].get(
            cache_key, 0) > datetime.now().timestamp() - CACHE_EXPIRY * 60:
        weather_data = _state["cache"][cache_key]
        weather_text = format_weather(weather_data, source, location)
        await waiting_msg.edit_text(weather_text, parse_mode="MARKDOWN")
        if _module_interface:
            _module_interface.logger.debug(f"使用缓存的天气数据: {location}")
        return

    # 尝试所有可用的源，直到成功
    available_sources = []
    for source_name, _ in WEATHER_SOURCES.items():
        if source_name in _state["api_keys"] and _state["api_keys"][
                source_name]:
            available_sources.append(source_name)

    # 把当前活跃源放在首位
    if _state["active_source"] in available_sources:
        available_sources.remove(_state["active_source"])
        available_sources.insert(0, _state["active_source"])

    success = False
    for source in available_sources:
        api_key = _state["api_keys"].get(source)
        if not api_key:
            continue

        # 查询天气
        weather_data = await fetch_weather(source, api_key, location)

        # 检查是否有错误
        if isinstance(weather_data, dict) and "error" in weather_data:
            if _module_interface:
                _module_interface.logger.warning(
                    f"使用 {source} 获取 {location} 的天气数据失败: {weather_data['error']}"
                )
            continue

        if weather_data:
            # 缓存结果
            cache_key = f"weather:{source}:{location}"
            _state["cache"][cache_key] = weather_data
            _state["cache_time"][cache_key] = datetime.now().timestamp()

            # 格式化天气信息
            weather_text = format_weather(weather_data, source, location)

            # 更新消息
            await waiting_msg.edit_text(weather_text, parse_mode="MARKDOWN")

            # 设置为活跃源
            if source != _state["active_source"]:
                _state["active_source"] = source
                if _module_interface:
                    _module_interface.logger.info(f"切换天气源为 {source}")

            success = True
            break

    if not success:
        await waiting_msg.edit_text(
            f"❌ 无法获取 {location} 的天气信息\n请检查位置名称或 API 密钥是否正确\n\n请使用 /weatherset 设置有效的 API 密钥"
        )
        if _module_interface:
            _module_interface.logger.error(f"无法获取 {location} 的天气信息")


async def forecast_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """查询天气预报

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    user_id = str(update.effective_user.id)

    # 获取位置参数和天数
    args = context.args or []
    days = 3  # 默认3天

    if args and args[-1].isdigit():
        days = min(int(args[-1]), 7)  # 最多7天
        location = " ".join(args[:-1])
    else:
        location = " ".join(args)

    # 如果没提供位置，使用默认位置
    if not location:
        if user_id in _state["user_locations"]:
            location = _state["user_locations"][user_id]
        else:
            await message.reply_text("🌍 请提供位置名称，如: /forecast 北京 3")
            return

    # 获取活跃的天气源
    source = _state["active_source"]
    api_key = _state["api_keys"].get(source)

    if not api_key:
        await message.reply_text(
            f"⚠️ 未设置 {WEATHER_SOURCES[source]['name']} 的 API 密钥，请使用 /weatherset 命令设置"
        )
        return

    # 发送等待消息
    waiting_msg = await message.reply_text("🔍 正在查询天气预报，请稍候...")

    # 检查缓存
    cache_key = f"forecast:{source}:{location}:{days}"
    if cache_key in _state["cache"] and _state["cache_time"].get(
            cache_key, 0) > datetime.now().timestamp() - CACHE_EXPIRY * 60:
        forecast_data = _state["cache"][cache_key]
        forecast_text = format_forecast(forecast_data, source, location, days)
        await waiting_msg.edit_text(forecast_text, parse_mode="MARKDOWN")
        if _module_interface:
            _module_interface.logger.debug(f"使用缓存的天气预报数据: {location}, {days}天")
        return

    # 尝试所有可用的源，直到成功
    available_sources = []
    for source_name, _ in WEATHER_SOURCES.items():
        if source_name in _state["api_keys"] and _state["api_keys"][
                source_name]:
            available_sources.append(source_name)

    # 把当前活跃源放在首位
    if _state["active_source"] in available_sources:
        available_sources.remove(_state["active_source"])
        available_sources.insert(0, _state["active_source"])

    success = False
    for source in available_sources:
        api_key = _state["api_keys"].get(source)
        if not api_key:
            continue

        # 查询天气预报
        forecast_data = await fetch_forecast(source, api_key, location, days)

        # 检查是否有错误
        if isinstance(forecast_data, dict) and "error" in forecast_data:
            if _module_interface:
                _module_interface.logger.warning(
                    f"使用 {source} 获取 {location} 的天气预报数据失败: {forecast_data['error']}"
                )
            continue

        if forecast_data:
            # 缓存结果
            cache_key = f"forecast:{source}:{location}:{days}"
            _state["cache"][cache_key] = forecast_data
            _state["cache_time"][cache_key] = datetime.now().timestamp()

            # 格式化天气预报信息
            forecast_text = format_forecast(forecast_data, source, location,
                                            days)

            # 更新消息
            await waiting_msg.edit_text(forecast_text, parse_mode="MARKDOWN")

            # 设置为活跃源
            if source != _state["active_source"]:
                _state["active_source"] = source
                if _module_interface:
                    _module_interface.logger.info(f"切换天气源为 {source}")

            success = True
            break

    if not success:
        await waiting_msg.edit_text(
            f"❌ 无法获取 {location} 的天气预报\n请检查位置名称或 API 密钥是否正确\n\n请使用 /weatherset 设置有效的 API 密钥"
        )
        if _module_interface:
            _module_interface.logger.error(f"无法获取 {location} 的天气预报信息")


async def weather_set_command(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """天气模块设置命令

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查是否是私聊
    if update.effective_chat.type != "private":
        await message.reply_text("⚠️ 出于安全考虑，天气模块配置只能在私聊中进行")
        return

    # 显示设置面板
    await show_settings_panel(update, context)


# 设置面板相关函数
async def show_settings_panel(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """显示天气设置主面板

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    # 检查是从回调查询还是从命令调用
    is_callback = update.callback_query is not None

    # 构建设置面板文本
    settings_text = "*🔧 天气模块设置*\n\n"
    settings_text += f"当前天气源: {WEATHER_SOURCES[_state['active_source']]['name']}\n\n"
    settings_text += "API 密钥状态:\n"

    for source, info in WEATHER_SOURCES.items():
        key = _state["api_keys"].get(source, "")
        status = "已设置" if key else "未设置"
        settings_text += f"- {info['name']}: {status}\n"

    settings_text += "\n请选择操作:"

    # 创建主菜单按钮
    keyboard = [[
        InlineKeyboardButton("Source Settings",
                             callback_data=f"{CALLBACK_PREFIX}menu_source")
    ],
                [
                    InlineKeyboardButton(
                        "API Key Settings",
                        callback_data=f"{CALLBACK_PREFIX}menu_api")
                ],
                [
                    InlineKeyboardButton(
                        "View Details",
                        callback_data=f"{CALLBACK_PREFIX}show_details")
                ]]

    # 创建按钮标记
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送或编辑消息
    if is_callback:
        await update.callback_query.edit_message_text(
            settings_text, reply_markup=reply_markup, parse_mode="MARKDOWN")
    else:
        message = update.message or update.edited_message
        await message.reply_text(settings_text,
                                 reply_markup=reply_markup,
                                 parse_mode="MARKDOWN")


async def show_source_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示天气源设置菜单

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    query = update.callback_query

    # 构建设置面板文本
    settings_text = "*🔧 天气源设置*\n\n"
    settings_text += f"当前天气源: {WEATHER_SOURCES[_state['active_source']]['name']}\n\n"
    settings_text += "请选择天气源:"

    # 创建按钮
    keyboard = []

    # 添加设置默认源按钮
    source_buttons = []
    for source, info in WEATHER_SOURCES.items():
        source_buttons.append(
            InlineKeyboardButton(
                f"▷ {info['name']}"
                if source == _state["active_source"] else f"{info['name']}",
                callback_data=f"{CALLBACK_PREFIX}set_source_{source}"))

    # 每行一个按钮
    for button in source_buttons:
        keyboard.append([button])

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    # 创建按钮标记
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    await query.edit_message_text(settings_text,
                                  reply_markup=reply_markup,
                                  parse_mode="MARKDOWN")


async def show_api_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示 API 密钥设置菜单

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    query = update.callback_query

    # 构建设置面板文本
    settings_text = "*🔧 API 密钥设置*\n\n"
    settings_text += "请选择要设置 API 密钥的服务:"

    # 创建按钮
    keyboard = []

    # 添加设置 API 密钥按钮
    api_buttons = []
    for source, info in WEATHER_SOURCES.items():
        api_buttons.append(
            InlineKeyboardButton(
                f"{info['name']} API",
                callback_data=f"{CALLBACK_PREFIX}set_key_{source}"))

    # 每行一个按钮
    for button in api_buttons:
        keyboard.append([button])

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    # 创建按钮标记
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    await query.edit_message_text(settings_text,
                                  reply_markup=reply_markup,
                                  parse_mode="MARKDOWN")


async def show_details(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示详细设置信息

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    query = update.callback_query

    # 构建详细信息文本
    info_text = "*🔧 天气模块详细信息*\n\n"
    info_text += f"默认天气源: {WEATHER_SOURCES[_state['active_source']]['name']}\n\n"
    info_text += "API 密钥:\n"

    for source, key in _state["api_keys"].items():
        if source in WEATHER_SOURCES:
            masked_key = key[:4] + "*****" + key[-4:] if len(
                key) > 8 else "********"
            info_text += f"- {WEATHER_SOURCES[source]['name']}: `{masked_key}`\n"

    # 创建返回按钮
    keyboard = [[
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    await query.edit_message_text(info_text,
                                  reply_markup=reply_markup,
                                  parse_mode="MARKDOWN")


async def start_set_api_key(update: Update, context: ContextTypes.DEFAULT_TYPE,
                            source: str):
    """开始设置 API 密钥流程

    Args:
        update: Telegram 更新对象
        context: 回调上下文
        source: 天气源名称
    """
    query = update.callback_query
    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.edit_message_text(
            "System error, please contact administrator")
        return

    # 获取聊天ID
    chat_id = update.effective_chat.id

    # 设置会话状态
    await session_manager.set(user_id, "weather_active", True, chat_id=chat_id)
    await session_manager.set(user_id,
                              "weather_step",
                              SESSION_WAITING_API_KEY,
                              chat_id=chat_id)
    await session_manager.set(user_id,
                              "weather_source",
                              source,
                              chat_id=chat_id)

    # 创建返回按钮
    keyboard = [[
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_api")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    await query.edit_message_text(
        f"请输入 {WEATHER_SOURCES[source]['name']} 的 API 密钥:\n\n"
        f"• 使用 /cancel 命令可以取消操作",
        reply_markup=reply_markup,
        parse_mode="MARKDOWN")


async def set_weather_source(update: Update,
                             context: ContextTypes.DEFAULT_TYPE, source: str):
    """设置默认天气源

    Args:
        update: Telegram 更新对象
        context: 回调上下文
        source: 天气源名称
    """
    query = update.callback_query

    if source not in WEATHER_SOURCES:
        await query.answer(f"❌ 不支持的天气源: {source}")
        return

    # 设置默认天气源
    _state["active_source"] = source

    if _module_interface:
        _module_interface.logger.info(
            f"用户 {update.effective_user.id} 将默认天气源设置为 {WEATHER_SOURCES[source]['name']}"
        )

    # 显示成功消息
    await query.answer(f"✅ 已将默认天气源设置为: {WEATHER_SOURCES[source]['name']}")

    # 更新源设置面板
    await show_source_menu(update, context)


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    query = update.callback_query
    user_id = update.effective_user.id
    data = query.data

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    chat_id = update.effective_chat.id

    # 确保回调查询得到响应
    await query.answer()

    # 处理不同的回调
    if data == f"{CALLBACK_PREFIX}back_to_main":
        # 返回主设置面板
        if session_manager:
            await session_manager.delete(user_id,
                                         "weather_active",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "weather_step",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "weather_source",
                                         chat_id=chat_id)

        await show_settings_panel(update, context)

    elif data == f"{CALLBACK_PREFIX}back_to_api":
        # 返回 API 设置菜单
        if session_manager:
            await session_manager.delete(user_id,
                                         "weather_active",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "weather_step",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "weather_source",
                                         chat_id=chat_id)

        await show_api_menu(update, context)

    elif data == f"{CALLBACK_PREFIX}menu_source":
        # 显示源设置菜单
        await show_source_menu(update, context)

    elif data == f"{CALLBACK_PREFIX}menu_api":
        # 显示 API 设置菜单
        await show_api_menu(update, context)

    elif data == f"{CALLBACK_PREFIX}show_details":
        # 显示详细设置
        await show_details(update, context)

    elif data.startswith(f"{CALLBACK_PREFIX}set_source_"):
        # 设置默认天气源
        source = data.replace(f"{CALLBACK_PREFIX}set_source_", "")
        await set_weather_source(update, context, source)

    elif data.startswith(f"{CALLBACK_PREFIX}set_key_"):
        # 设置 API 密钥
        source = data.replace(f"{CALLBACK_PREFIX}set_key_", "")
        await start_set_api_key(update, context, source)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理用户消息（用于会话流程）

    Args:
        update: Telegram 更新对象
        context: 回调上下文
    """
    # 检查是否有活动会话
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id
    session_manager = context.bot_data.get("session_manager")

    if not session_manager:
        return

    # 检查是否是天气模块的活跃会话
    is_active = await session_manager.get(user_id,
                                          "weather_active",
                                          False,
                                          chat_id=chat_id)
    if not is_active:
        return

    # 获取当前步骤
    step = await session_manager.get(user_id,
                                     "weather_step",
                                     None,
                                     chat_id=chat_id)

    # 处理不同步骤的输入
    if step == SESSION_WAITING_API_KEY:
        # 处理 API 密钥输入
        source = await session_manager.get(user_id,
                                           "weather_source",
                                           None,
                                           chat_id=chat_id)
        api_key = update.message.text.strip()

        # 清除会话状态
        await session_manager.delete(user_id,
                                     "weather_active",
                                     chat_id=chat_id)
        await session_manager.delete(user_id, "weather_step", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "weather_source",
                                     chat_id=chat_id)

        # 设置 API 密钥
        _state["api_keys"][source] = api_key

        # 记录设置操作，但不记录 API 密钥
        if _module_interface:
            _module_interface.logger.info(
                f"用户 {user_id} 设置了 {WEATHER_SOURCES[source]['name']} 的 API 密钥")

        # 发送成功消息
        await update.message.reply_text(
            f"✅ 已成功设置 {WEATHER_SOURCES[source]['name']} 的 API 密钥\n\n"
            f"使用 /weatherset 命令可以查看和管理设置")


# 获取天气图标
def get_weather_icon(description):
    """根据天气描述获取对应的图标

    Args:
        description: 天气描述文本或代码

    Returns:
        str: 天气图标 emoji
    """
    description = description.lower() if isinstance(description,
                                                    str) else str(description)

    for key, icon in WEATHER_ICONS.items():
        if key.lower() in description.lower():
            return icon

    return WEATHER_ICONS["default"]


# 获取风向文字
def get_wind_direction(degrees):
    """根据角度获取风向文字

    Args:
        degrees: 风向角度（0-360）

    Returns:
        str: 风向文字（北、东北、东等）
    """
    try:
        degrees = float(degrees)
        directions = ["北", "东北", "东", "东南", "南", "西南", "西", "西北"]
        index = round(degrees / 45) % 8
        return directions[index]
    except:
        return "未知"


# 天气数据获取函数
async def fetch_weather(source, api_key, location, module_interface=None):
    """获取当前天气数据

    Args:
        source: 天气源名称
        api_key: API 密钥
        location: 位置名称或坐标
        module_interface: 模块接口

    Returns:
        dict: 天气数据或错误信息
    """
    return await _fetch_data(source,
                             api_key,
                             location,
                             is_forecast=False,
                             module_interface=module_interface)


async def fetch_forecast(source,
                         api_key,
                         location,
                         days=3,
                         module_interface=None):
    """获取天气预报数据

    Args:
        source: 天气源名称
        api_key: API 密钥
        location: 位置名称或坐标
        days: 预报天数
        module_interface: 模块接口

    Returns:
        dict: 天气预报数据或错误信息
    """
    return await _fetch_data(source,
                             api_key,
                             location,
                             is_forecast=True,
                             days=days,
                             module_interface=module_interface)


async def _fetch_data(source,
                      api_key,
                      location,
                      is_forecast=False,
                      days=3,
                      module_interface=None):
    """获取天气数据的通用函数

    Args:
        source: 天气源名称
        api_key: API 密钥
        location: 位置名称或坐标
        is_forecast: 是否获取预报数据
        days: 预报天数
        module_interface: 模块接口

    Returns:
        dict: 天气数据或错误信息
    """
    # 使用全局模块接口如果没有提供
    interface = module_interface or _module_interface

    source_info = WEATHER_SOURCES[source]
    url = source_info["forecast_url"] if is_forecast else source_info["url"]

    original_location = location

    # OpenWeatherMap 不支持中文城市名，尝试转换
    if source == "openweathermap" and any('\u4e00' <= char <= '\u9fff'
                                          for char in location):
        from utils.city_mapping import translate_city_name
        english_location = translate_city_name(location)
        if english_location != location:
            location = english_location
            if interface:
                interface.logger.info(
                    f"将中文城市名 '{original_location}' 转换为英文 '{location}'")
        else:
            if interface:
                interface.logger.warning(f"未知的中文城市名 '{location}'，将尝试直接使用")

    # 和风天气需要先查询位置 ID
    if source == "qweather" and source_info.get("location_type") == "name":
        location_id, _ = await get_qweather_location_id(
            location, api_key, interface)
        if not location_id:
            if interface:
                interface.logger.warning(f"和风天气位置 ID 查询失败: {location}")
            return {"error": "location_not_found"}
        location = location_id  # 使用位置 ID

    # 彩云天气需要坐标
    if source == "caiyunapp" and source_info.get(
            "requires_coords", False) and "," not in location:
        lat, lon = await get_coordinates(location, interface)
        if not lat or not lon:
            if interface:
                interface.logger.warning(f"无法获取位置坐标: {location}")
            return {"error": "coordinates_not_found"}
        location = f"{lon},{lat}"  # 彩云天气使用经度,纬度格式

    # 处理 URL 中的变量
    safe_url = url
    if "{key}" in url:
        url = url.replace("{key}", api_key)
        # 创建安全版本的 URL 用于日志记录
        safe_url = safe_url.replace("{key}", "***API_KEY***")
    if "{location}" in url:
        url = url.replace("{location}", location)
        safe_url = safe_url.replace("{location}", location)
    if "{days}" in url and is_forecast:
        url = url.replace("{days}", str(days))
        safe_url = safe_url.replace("{days}", str(days))

    # 获取请求参数，并创建安全版本用于日志记录
    params = source_info["params"](location, api_key)
    safe_params = params.copy() if isinstance(params, dict) else {}

    # 从日志中移除 API 密钥
    if "appid" in safe_params:
        safe_params["appid"] = "***API_KEY***"
    if "key" in safe_params:
        safe_params["key"] = "***API_KEY***"

    # 记录请求详情（使用安全版本）
    if interface:
        prefix = "预报" if is_forecast else ""
        interface.logger.debug(f"{prefix}请求 URL: {safe_url}")
        interface.logger.debug(f"{prefix}请求参数: {safe_params}")

    try:
        async with aiohttp.ClientSession() as session:
            headers = {"Accept": "application/json"}
            async with session.get(url, params=params,
                                   headers=headers) as response:
                if interface:
                    prefix = "预报 " if is_forecast else ""
                    interface.logger.debug(
                        f"{prefix}API 响应状态码: {response.status}")

                if response.status == 200:
                    data = await response.json()
                    # 检查 API 特定的错误响应
                    if source == "openweathermap":
                        cod = data.get("cod")
                        if (isinstance(cod, str)
                                and cod != "200") or (isinstance(cod, int)
                                                      and cod != 200):
                            return {
                                "error": data.get('message', 'unknown_error')
                            }
                    elif source == "qweather" and data.get("code") != "200":
                        return {"error": data.get('message', 'unknown_error')}
                    return data
                elif response.status == 404 and source == "openweathermap":
                    return {"error": "city_not_found"}
                else:
                    return {"error": f"http_error_{response.status}"}
    except Exception as e:
        if interface:
            interface.logger.error(f"{'预报' if is_forecast else ''}请求异常: {e}")
        return {"error": str(e)}


# 获取和风天气位置 ID
async def get_qweather_location_id(location, api_key, module_interface=None):
    """获取和风天气位置 ID

    Args:
        location: 位置名称
        api_key: API 密钥
        module_interface: 模块接口

    Returns:
        tuple: (位置ID, 位置名称) 或 (None, None)
    """
    # 使用全局模块接口如果没有提供
    interface = module_interface or _module_interface

    url = "https://geoapi.qweather.com/v2/city/lookup"
    params = {"location": location, "key": api_key, "lang": "zh"}

    # 创建安全版本用于日志记录
    safe_params = params.copy()
    safe_params["key"] = "***API_KEY***"

    if interface:
        interface.logger.debug(f"和风天气位置查询参数: {safe_params}")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params) as response:
                if response.status == 200:
                    data = await response.json()
                    if data["code"] == "200" and "location" in data and len(
                            data["location"]) > 0:
                        return data["location"][0]["id"], data["location"][0][
                            "name"]
                    else:
                        if interface:
                            interface.logger.warning(
                                f"和风天气位置查询失败: {data.get('code')} - {data.get('message', '未知错误')}"
                            )
                        return None, None
                else:
                    if interface:
                        interface.logger.warning(
                            f"和风天气位置查询 HTTP 错误: {response.status}")
                    return None, None
    except Exception as e:
        if interface:
            interface.logger.error(f"和风天气位置查询异常: {e}")
        return None, None


# 获取位置坐标
async def get_coordinates(location, module_interface=None):
    """获取位置的经纬度坐标

    Args:
        location: 位置名称或坐标字符串
        module_interface: 模块接口

    Returns:
        tuple: (纬度, 经度) 或 (None, None)
    """
    # 使用全局模块接口如果没有提供
    interface = module_interface or _module_interface

    # 如果已经是坐标格式，直接返回
    if "," in location:
        try:
            lat, lon = location.split(",")
            return float(lat), float(lon)
        except:
            pass

    # 尝试使用 OpenStreetMap 的 Nominatim 服务获取坐标
    url = "https://nominatim.openstreetmap.org/search"
    params = {"q": location, "format": "json", "limit": 1}
    headers = {"User-Agent": "TelegramWeatherBot/1.0"}

    if interface:
        interface.logger.debug(f"地理编码请求参数: {params}")

    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(url, params=params,
                                   headers=headers) as response:
                if response.status == 200:
                    data = await response.json()
                    if data and len(data) > 0:
                        lat = float(data[0]["lat"])
                        lon = float(data[0]["lon"])
                        if interface:
                            interface.logger.debug(
                                f"获取到位置 {location} 的坐标: {lat}, {lon}")
                        return lat, lon
                    else:
                        if interface:
                            interface.logger.warning(f"无法找到位置: {location}")
                        return None, None
                else:
                    if interface:
                        interface.logger.warning(
                            f"地理编码请求失败: {response.status}")
                    return None, None
    except Exception as e:
        if interface:
            interface.logger.error(f"地理编码异常: {e}")
        return None, None


# 格式化天气信息
def format_weather(data, source, location):
    """根据不同的天气源格式化天气信息

    Args:
        data: 天气数据
        source: 天气源名称
        location: 位置名称

    Returns:
        str: 格式化的天气信息文本（Markdown 格式）
    """
    if source == "openweathermap":
        try:
            temp = data["main"]["temp"]
            feels_like = data["main"]["feels_like"]
            humidity = data["main"]["humidity"]
            wind_speed = data["wind"]["speed"]
            wind_deg = data["wind"].get("deg", 0)
            description = data["weather"][0]["description"]
            city_name = data["name"]
            country = data["sys"]["country"]

            # 获取天气图标
            weather_icon = get_weather_icon(description)

            # 获取风向
            wind_direction = get_wind_direction(wind_deg)
            wind_icon = WIND_ICONS.get(wind_direction, "🧭")

            # 温度图标
            temp_icon = "🥶" if temp < 5 else "❄️" if temp < 10 else "😎" if temp > 30 else "🌡️"

            return f"""
*{weather_icon} {city_name}, {country} 当前天气*

🌡️ *温度*: {temp:.1f}°C {temp_icon}
🤒 *体感温度*: {feels_like:.1f}°C
☁️ *天气状况*: {description} {weather_icon}
💧 *湿度*: {humidity}%
🌬️ *风速/风向*: {wind_speed} m/s {wind_icon} {wind_direction}

_数据来源: {WEATHER_SOURCES[source]['name']}_
_更新时间: {datetime.now().strftime("%Y-%m-%d %H:%M")}_
            """
        except Exception as e:
            return f"无法解析 {location} 的天气数据: {str(e)}"

    elif source == "qweather":
        try:
            # 和风天气 API v7 响应结构
            if "code" in data and data["code"] == "200":
                now = data.get("now", {})
                temp = now.get("temp", "N/A")
                feels_like = now.get("feelsLike", "N/A")
                humidity = now.get("humidity", "N/A")
                wind_speed = now.get("windSpeed", "N/A")
                wind_dir = now.get("windDir", "N/A")
                description = now.get("text", "N/A")

                # 获取天气图标
                weather_icon = get_weather_icon(description)

                # 获取风向图标
                wind_icon = WIND_ICONS.get(wind_dir, "🧭")

                # 温度图标
                try:
                    temp_float = float(temp)
                    temp_icon = "🥶" if temp_float < 5 else "❄️" if temp_float < 10 else "😎" if temp_float > 30 else "🌡️"
                except:
                    temp_icon = "🌡️"

                return f"""
*{weather_icon} {location} 当前天气*

🌡️ *温度*: {temp}°C {temp_icon}
🤒 *体感温度*: {feels_like}°C
☁️ *天气状况*: {description} {weather_icon}
💧 *湿度*: {humidity}%
🌬️ *风速/风向*: {wind_speed} km/h {wind_icon} {wind_dir}

_数据来源: {WEATHER_SOURCES[source]['name']}_
_更新时间: {datetime.now().strftime("%Y-%m-%d %H:%M")}_
                """
            else:
                return f"❌ 和风天气 API 返回错误: {data.get('code')} - {data.get('message', '未知错误')}"
        except Exception as e:
            return f"无法解析 {location} 的天气数据，错误: {str(e)}"

    elif source == "caiyunapp":
        try:
            result = data.get("result", {})
            realtime = result.get("realtime", {})
            temp = realtime.get("temperature", "N/A")
            humidity = realtime.get("humidity", 0)
            if isinstance(humidity, (int, float)):
                humidity = int(humidity * 100)
            wind_speed = realtime.get("wind", {}).get("speed", "N/A")
            wind_direction = realtime.get("wind", {}).get("direction", 0)
            skycon = realtime.get("skycon", "UNKNOWN")

            # 将彩云天气的 skycon 转换为中文描述
            skycon_map = {
                "CLEAR_DAY": "晴天",
                "CLEAR_NIGHT": "晴夜",
                "PARTLY_CLOUDY_DAY": "多云",
                "PARTLY_CLOUDY_NIGHT": "多云",
                "CLOUDY": "阴天",
                "LIGHT_RAIN": "小雨",
                "MODERATE_RAIN": "中雨",
                "HEAVY_RAIN": "大雨",
                "STORM_RAIN": "暴雨",
                "LIGHT_SNOW": "小雪",
                "MODERATE_SNOW": "中雪",
                "HEAVY_SNOW": "大雪",
                "STORM_SNOW": "暴雪",
                "FOG": "雾",
                "HAZE": "霾"
            }

            description = skycon_map.get(skycon, skycon)

            # 获取天气图标
            weather_icon = get_weather_icon(skycon)

            # 获取风向
            wind_dir_text = get_wind_direction(wind_direction)
            wind_icon = WIND_ICONS.get(wind_dir_text, "🧭")

            # 温度图标
            try:
                temp_float = float(temp)
                temp_icon = "🥶" if temp_float < 5 else "❄️" if temp_float < 10 else "😎" if temp_float > 30 else "🌡️"
            except:
                temp_icon = "🌡️"

            return f"""
*{weather_icon} {location} 当前天气*

🌡️ *温度*: {temp}°C {temp_icon}
☁️ *天气状况*: {description} {weather_icon}
💧 *湿度*: {humidity}%
🌬️ *风速/风向*: {wind_speed} m/s {wind_icon} {wind_dir_text}

_数据来源: {WEATHER_SOURCES[source]['name']}_
_更新时间: {datetime.now().strftime("%Y-%m-%d %H:%M")}_
            """
        except Exception as e:
            return f"无法解析 {location} 的天气数据，错误: {str(e)}"

    return f"不支持的天气源: {source}"


def format_forecast(data, source, location, days=3):
    """根据不同的天气源格式化天气预报信息

    Args:
        data: 天气预报数据
        source: 天气源名称
        location: 位置名称
        days: 预报天数

    Returns:
        str: 格式化的天气预报信息文本（Markdown 格式）
    """
    if source == "openweathermap":
        try:
            result = f"*📅 {location} {days} 天天气预报*\n\n"

            # OpenWeatherMap 的预报是每 3 小时一次，需要按天汇总
            day_forecasts = {}

            for item in data.get("list", []):
                date = datetime.fromtimestamp(item["dt"]).strftime("%Y-%m-%d")

                if date not in day_forecasts:
                    if len(day_forecasts) >= days:
                        break

                    day_forecasts[date] = {
                        "temp_min": float('inf'),
                        "temp_max": float('-inf'),
                        "descriptions": set(),
                        "humidity": [],
                        "wind_speed": [],
                        "wind_deg": []
                    }

                forecast = day_forecasts[date]
                forecast["temp_min"] = min(forecast["temp_min"],
                                           item["main"]["temp_min"])
                forecast["temp_max"] = max(forecast["temp_max"],
                                           item["main"]["temp_max"])
                forecast["descriptions"].add(item["weather"][0]["description"])
                forecast["humidity"].append(item["main"]["humidity"])
                forecast["wind_speed"].append(item["wind"]["speed"])
                forecast["wind_deg"].append(item["wind"].get("deg", 0))

            for date, forecast in day_forecasts.items():
                day_name = datetime.strptime(date,
                                             "%Y-%m-%d").strftime("%m-%d %A")
                descriptions = list(forecast["descriptions"])[:2]
                avg_humidity = sum(forecast["humidity"]) / len(
                    forecast["humidity"])
                avg_wind = sum(forecast["wind_speed"]) / len(
                    forecast["wind_speed"])
                avg_wind_deg = sum(forecast["wind_deg"]) / len(
                    forecast["wind_deg"])

                # 获取天气图标
                weather_icon = get_weather_icon(descriptions[0])

                # 获取风向
                wind_direction = get_wind_direction(avg_wind_deg)
                wind_icon = WIND_ICONS.get(wind_direction, "🧭")

                # 温度图标
                temp_avg = (forecast["temp_min"] + forecast["temp_max"]) / 2
                temp_icon = "🥶" if temp_avg < 5 else "❄️" if temp_avg < 10 else "😎" if temp_avg > 30 else "🌡️"

                result += f"*{weather_icon} {day_name}*\n"
                result += f"🌡️ *温度*: {forecast['temp_min']:.1f}°C ~ {forecast['temp_max']:.1f}°C {temp_icon}\n"
                result += f"☁️ *天气*: {' / '.join(descriptions)} {weather_icon}\n"
                result += f"💧 *湿度*: {avg_humidity:.0f}%\n"
                result += f"🌬️ *风速/风向*: {avg_wind:.1f} m/s {wind_icon} {wind_direction}\n\n"

            result += f"_数据来源: {WEATHER_SOURCES[source]['name']}_"
            return result
        except Exception as e:
            return f"无法解析 {location} 的天气预报数据，错误: {str(e)}"

    elif source == "qweather":
        try:
            # 和风天气 API v7 响应结构
            if "code" in data and data["code"] == "200":
                daily = data.get("daily", [])
                # 使用用户请求的天数，而不是返回数据的长度
                result = f"*📅 {location} {days} 天天气预报*\n\n"

                for day in daily[:days]:
                    date = datetime.strptime(day.get("fxDate", ""),
                                             "%Y-%m-%d").strftime("%m-%d %A")

                    # 获取天气图标
                    weather_icon = get_weather_icon(day.get("textDay", ""))

                    # 获取风向图标
                    wind_icon = WIND_ICONS.get(day.get("windDirDay", ""), "🧭")

                    # 温度图标
                    try:
                        temp_min = float(day.get('tempMin', 0))
                        temp_max = float(day.get('tempMax', 0))
                        temp_avg = (temp_min + temp_max) / 2
                        temp_icon = "🥶" if temp_avg < 5 else "❄️" if temp_avg < 10 else "😎" if temp_avg > 30 else "🌡️"
                    except:
                        temp_icon = "🌡️"

                    result += f"*{weather_icon} {date}*\n"
                    result += f"🌡️ *温度*: {day.get('tempMin', 'N/A')}°C ~ {day.get('tempMax', 'N/A')}°C {temp_icon}\n"
                    result += f"☁️ *天气*: {day.get('textDay', 'N/A')} / {day.get('textNight', 'N/A')} {weather_icon}\n"
                    result += f"💧 *湿度*: {day.get('humidity', 'N/A')}%\n"
                    result += f"🌬️ *风速/风向*: {day.get('windSpeedDay', 'N/A')} km/h {wind_icon} {day.get('windDirDay', 'N/A')}\n\n"

                result += f"_数据来源: {WEATHER_SOURCES[source]['name']}_"
                return result
            else:
                return f"❌ 和风天气 API 返回错误: {data.get('code')} - {data.get('message', '未知错误')}"
        except Exception as e:
            return f"无法解析 {location} 的天气预报数据，错误: {str(e)}"

    elif source == "caiyunapp":
        try:
            result_data = data.get("result", {})
            daily = result_data.get("daily", {})
            temperature = daily.get("temperature", [])

            # 使用用户请求的天数，而不是返回数据的长度
            result = f"*📅 {location} {days} 天天气预报*\n\n"

            # 彩云天气的 skycon 转换为中文描述
            skycon_map = {
                "CLEAR_DAY": "晴天",
                "CLEAR_NIGHT": "晴夜",
                "PARTLY_CLOUDY_DAY": "多云",
                "PARTLY_CLOUDY_NIGHT": "多云",
                "CLOUDY": "阴天",
                "LIGHT_RAIN": "小雨",
                "MODERATE_RAIN": "中雨",
                "HEAVY_RAIN": "大雨",
                "STORM_RAIN": "暴雨",
                "LIGHT_SNOW": "小雪",
                "MODERATE_SNOW": "中雪",
                "HEAVY_SNOW": "大雪",
                "STORM_SNOW": "暴雪",
                "FOG": "雾",
                "HAZE": "霾"
            }

            skycon_data = daily.get("skycon", [])
            humidity_data = daily.get("humidity", [])
            wind_data = daily.get("wind", [])

            for i in range(min(days, len(temperature))):
                if i < len(temperature):
                    date_str = temperature[i].get("date", "")
                    date = datetime.strptime(date_str, "%Y-%m-%d")
                    day_name = date.strftime("%m-%d %A")

                    temp_min = temperature[i].get("min", "N/A")
                    temp_max = temperature[i].get("max", "N/A")

                    skycon = skycon_data[i].get(
                        "value",
                        "UNKNOWN") if i < len(skycon_data) else "UNKNOWN"
                    description = skycon_map.get(skycon, skycon)

                    # 获取天气图标
                    weather_icon = get_weather_icon(skycon)

                    # 温度图标
                    try:
                        temp_min_float = float(temp_min)
                        temp_max_float = float(temp_max)
                        temp_avg = (temp_min_float + temp_max_float) / 2
                        temp_icon = "🥶" if temp_avg < 5 else "❄️" if temp_avg < 10 else "😎" if temp_avg > 30 else "🌡️"
                    except:
                        temp_icon = "🌡️"

                    result += f"*{weather_icon} {day_name}*\n"
                    result += f"🌡️ *温度*: {temp_min}°C ~ {temp_max}°C {temp_icon}\n"
                    result += f"☁️ *天气*: {description} {weather_icon}\n"

                    if i < len(humidity_data):
                        humidity = humidity_data[i].get("avg", 0)
                        if isinstance(humidity, (int, float)):
                            humidity = int(humidity * 100)
                        result += f"💧 *湿度*: {humidity}%\n"

                    if i < len(wind_data):
                        wind_speed = wind_data[i].get("avg",
                                                      {}).get("speed", "N/A")
                        wind_dir = wind_data[i].get("avg",
                                                    {}).get("direction", 0)
                        wind_dir_text = get_wind_direction(wind_dir)
                        wind_icon = WIND_ICONS.get(wind_dir_text, "🧭")
                        result += f"🌬️ *风速/风向*: {wind_speed} m/s {wind_icon} {wind_dir_text}\n"

                    result += "\n"

            result += f"_数据来源: {WEATHER_SOURCES[source]['name']}_"
            return result
        except Exception as e:
            return f"无法解析 {location} 的天气预报数据，错误: {str(e)}"

    return f"不支持的天气源: {source}"


# 状态管理函数
async def get_state(interface):
    """获取模块状态

    Args:
        interface: 模块接口

    Returns:
        dict: 模块状态数据
    """
    interface.logger.debug("获取天气模块状态")
    # 只返回可序列化数据
    state_copy = _state.copy()
    # 移除缓存相关数据，避免存储大量临时数据
    if "cache" in state_copy:
        del state_copy["cache"]
    if "cache_time" in state_copy:
        del state_copy["cache_time"]
    return state_copy


async def set_state(interface, state):
    """设置模块状态

    Args:
        interface: 模块接口
        state: 状态数据
    """
    global _state
    # 保留缓存相关数据
    cache = _state.get("cache", {})
    cache_time = _state.get("cache_time", {})

    # 更新状态
    _state.update(state)

    # 恢复缓存数据
    if "cache" not in _state:
        _state["cache"] = cache
    if "cache_time" not in _state:
        _state["cache_time"] = cache_time

    interface.logger.debug("天气模块状态已更新")


# 清理过期缓存
def cleanup_cache():
    """清理过期的缓存数据

    清理超过 CACHE_EXPIRY 分钟的缓存数据

    Returns:
        int: 清理的缓存条目数量
    """
    now = datetime.now().timestamp()
    expiry_time = CACHE_EXPIRY * 60  # 转换为秒

    expired_keys = []
    for key, timestamp in _state["cache_time"].items():
        if now - timestamp > expiry_time:
            expired_keys.append(key)

    for key in expired_keys:
        if key in _state["cache"]:
            del _state["cache"][key]
        del _state["cache_time"][key]

    return len(expired_keys)


# 模块接口函数
async def setup(interface):
    """模块初始化

    Args:
        interface: 模块接口
    """
    global _module_interface
    _module_interface = interface

    # 加载配置文件
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                config_data = json.load(f)

                if "active_source" in config_data:
                    _state["active_source"] = config_data["active_source"]

                if "api_keys" in config_data:
                    _state["api_keys"] = config_data["api_keys"]

            interface.logger.info("已从文件加载天气模块配置")
    except Exception as e:
        interface.logger.error(f"加载天气配置失败: {e}")

    # 注册命令
    await interface.register_command("weather",
                                     weather_command,
                                     description="查询当前天气")

    await interface.register_command("forecast",
                                     forecast_command,
                                     description="查询天气预报")

    await interface.register_command("weatherset",
                                     weather_set_command,
                                     admin_level="super_admin",
                                     description="天气模块设置")

    # 注册回调处理器
    await interface.register_callback_handler(button_callback,
                                              pattern=f"^{CALLBACK_PREFIX}",
                                              admin_level="super_admin")

    # 注册消息处理器（用于会话流程，仅处理私聊消息）
    from telegram.ext import MessageHandler, filters
    message_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE,
        handle_message)
    await interface.register_handler(message_handler, group=7)

    # 加载用户位置状态
    state = interface.load_state(default={})
    if state:
        await set_state(interface, state)
        interface.logger.info(f"已加载 {len(_state['user_locations'])} 个用户的位置信息")

    # 初始化缓存
    if "cache" not in _state:
        _state["cache"] = {}
    if "cache_time" not in _state:
        _state["cache_time"] = {}

    # 启动定期清理缓存的任务
    async def cleanup_task():
        while True:
            await asyncio.sleep(CACHE_EXPIRY * 60)  # 每隔缓存过期时间清理一次
            cleaned = cleanup_cache()
            if cleaned > 0:
                interface.logger.debug(f"已清理 {cleaned} 条过期天气缓存")

    # 创建清理任务
    interface.cleanup_task = asyncio.create_task(cleanup_task())

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理

    Args:
        interface: 模块接口
    """
    # 取消清理任务
    if hasattr(interface, 'cleanup_task') and interface.cleanup_task:
        interface.cleanup_task.cancel()
        try:
            await interface.cleanup_task
        except asyncio.CancelledError:
            pass

    # 保存配置文件
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

        config_data = {
            "active_source": _state["active_source"],
            "api_keys": _state["api_keys"]
        }

        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(config_data, f, indent=2)

        interface.logger.info("天气模块配置已保存")
    except Exception as e:
        interface.logger.error(f"保存天气配置失败: {e}")

    # 保存用户位置 - 使用 get_state 获取可序列化状态
    interface.save_state(await get_state(interface))
    interface.logger.info(f"已保存 {len(_state['user_locations'])} 个用户的位置信息")
    interface.logger.info(f"模块 {MODULE_NAME} 已清理")
