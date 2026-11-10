# utils/weather_icons.py - 天气图标映射
"""
提供 OpenWeatherMap、和风天气和彩云天气源的天气状况到图标的映射
"""

# 统一的天气图标映射
WEATHER_ICONS = {
    # ===== 晴天 =====
    # OpenWeatherMap
    "clear": "☀️",
    "sunny": "☀️",
    "clear sky": "☀️",
    # 和风天气
    "晴": "☀️",
    "晴天": "☀️",
    # 彩云天气
    "CLEAR_DAY": "☀️",
    "CLEAR_NIGHT": "🌙",
    "晴夜": "🌙",

    # ===== 多云 =====
    # OpenWeatherMap
    "clouds": "☁️",
    "cloudy": "☁️",
    "few clouds": "🌤️",
    "scattered clouds": "⛅",
    "broken clouds": "☁️",
    "overcast clouds": "☁️",
    # 和风天气
    "多云": "⛅",
    "局部多云": "🌤️",
    "晴间多云": "🌤️",
    "阴": "☁️",
    "阴天": "☁️",
    "少云": "🌤️",
    # 彩云天气
    "PARTLY_CLOUDY_DAY": "🌤️",
    "PARTLY_CLOUDY_NIGHT": "☁️",
    "CLOUDY": "☁️",

    # ===== 雨 =====
    # OpenWeatherMap
    "rain": "🌧️",
    "light rain": "🌦️",
    "moderate rain": "🌧️",
    "heavy rain": "⛈️",
    "shower rain": "🌧️",
    "drizzle": "🌦️",
    # 和风天气
    "小雨": "🌦️",
    "中雨": "🌧️",
    "大雨": "⛈️",
    "暴雨": "🌊",
    "大暴雨": "🌊",
    "特大暴雨": "🌊",
    "阵雨": "🌦️",
    "强阵雨": "🌧️",
    "毛毛雨": "🌦️",
    "细雨": "🌦️",
    "小到中雨": "🌦️",
    "中到大雨": "🌧️",
    "大到暴雨": "⛈️",
    "暴雨到大暴雨": "🌊",
    "大暴雨到特大暴雨": "🌊",
    # 彩云天气
    "LIGHT_RAIN": "🌦️",
    "MODERATE_RAIN": "🌧️",
    "HEAVY_RAIN": "⛈️",
    "STORM_RAIN": "🌊",

    # ===== 雷雨 =====
    # OpenWeatherMap
    "thunderstorm": "⚡",
    "thunderstorm with light rain": "⚡",
    "thunderstorm with rain": "⚡",
    "thunderstorm with heavy rain": "⚡",
    # 和风天气
    "雷阵雨": "⚡",
    "强雷阵雨": "⚡",
    "雷阵雨伴有冰雹": "⚡",
    "雷暴": "🌩️",

    # ===== 雪 =====
    # OpenWeatherMap
    "snow": "❄️",
    "light snow": "🌨️",
    "moderate snow": "❄️",
    "heavy snow": "⛄",
    # 和风天气
    "小雪": "🌨️",
    "中雪": "❄️",
    "大雪": "⛄",
    "暴雪": "☃️",
    "小到中雪": "🌨️",
    "中到大雪": "❄️",
    "大到暴雪": "⛄",
    "阵雪": "🌨️",
    "雨夹雪": "🌨️",
    "雨雪天气": "🌨️",
    "阵雨夹雪": "🌨️",
    # 彩云天气
    "LIGHT_SNOW": "🌨️",
    "MODERATE_SNOW": "❄️",
    "HEAVY_SNOW": "⛄",
    "STORM_SNOW": "☃️",

    # ===== 雾霾 =====
    # OpenWeatherMap
    "mist": "🌫️",
    "fog": "🌫️",
    "haze": "😷",
    # 和风天气
    "雾": "🌫️",
    "霾": "😷",
    "浓雾": "🌫️",
    "强浓雾": "🌫️",
    "大雾": "🌫️",
    "特强浓雾": "🌫️",
    "薄雾": "🌫️",
    "中度霾": "😷",
    "重度霾": "😷",
    "严重霾": "😷",
    # 彩云天气
    "FOG": "🌫️",
    "HAZE": "😷",
    "LIGHT_HAZE": "😷",
    "MODERATE_HAZE": "😷",
    "HEAVY_HAZE": "😷",

    # ===== 沙尘 =====
    # 和风天气
    "扬沙": "🏜️",
    "浮尘": "🏜️",
    "沙尘暴": "🏜️",
    "强沙尘暴": "🏜️",
    # 彩云天气
    "DUST": "🏜️",
    "SAND": "🏜️",

    # ===== 其他 =====
    # 和风天气
    "冻雨": "❄️",
    "热": "🥵",
    "冷": "🥶",
    # 彩云天气
    "WIND": "💨",

    # 默认
    "default": "🌈"
}

# 彩云天气的 skycon 代码到中文描述的映射
CAIYUN_SKYCON_MAP = {
    "CLEAR_DAY": "晴天",
    "CLEAR_NIGHT": "晴夜",
    "PARTLY_CLOUDY_DAY": "多云",
    "PARTLY_CLOUDY_NIGHT": "多云",
    "CLOUDY": "阴天",
    "LIGHT_HAZE": "轻度雾霾",
    "MODERATE_HAZE": "中度雾霾",
    "HEAVY_HAZE": "重度雾霾",
    "LIGHT_RAIN": "小雨",
    "MODERATE_RAIN": "中雨",
    "HEAVY_RAIN": "大雨",
    "STORM_RAIN": "暴雨",
    "FOG": "雾",
    "LIGHT_SNOW": "小雪",
    "MODERATE_SNOW": "中雪",
    "HEAVY_SNOW": "大雪",
    "STORM_SNOW": "暴雪",
    "DUST": "浮尘",
    "SAND": "沙尘",
    "WIND": "大风"
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


def get_caiyun_description(skycon):
    """获取彩云天气 skycon 代码对应的中文描述

    Args:
        skycon: 彩云天气的 skycon 代码

    Returns:
        str: 中文天气描述
    """
    return CAIYUN_SKYCON_MAP.get(skycon, skycon)
