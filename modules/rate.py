# modules/rate.py - 汇率转换模块

import json
import os
import time
import aiohttp
import asyncio
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "rate"
MODULE_VERSION = "3.2.0"
MODULE_DESCRIPTION = "汇率转换，支持法币/虚拟货币"
MODULE_COMMANDS = ["rate", "setrate"]
MODULE_CHAT_TYPES = ["private", "group"]

# 按钮回调前缀
CALLBACK_PREFIX = "rate_"

# 模块状态
_state = {
    "last_update": 0,
    "update_interval": 3600,  # 每小时更新一次汇率数据
    "fiat_rates": {},
    "crypto_rates": {},
    "data_loaded": False  # 数据是否已加载的标志
}

# 配置文件路径
_config_file = "config/rate.json"
_module_interface = None

# API 配置
EXCHANGERATE_API_KEY = ""
EXCHANGERATE_API_URL = "https://v6.exchangerate-api.com/v6/{}/latest/{}"
COINGECKO_API_URL = "https://api.coingecko.com/api/v3/simple/price?ids={}&vs_currencies={}"
_update_task = None


def load_config():
    """从配置文件加载设置"""
    global EXCHANGERATE_API_KEY

    if os.path.exists(_config_file):
        try:
            with open(_config_file, 'r', encoding='utf-8') as f:
                config = json.load(f)
                EXCHANGERATE_API_KEY = config.get("api_key", "")
                return config
        except Exception as e:
            _module_interface.logger.error(f"加载配置文件失败: {e}")

    # 创建默认配置
    default_config = {"api_key": "", "update_interval": 3600}

    # 保存默认配置
    try:
        os.makedirs(os.path.dirname(_config_file), exist_ok=True)
        with open(_config_file, 'w', encoding='utf-8') as f:
            json.dump(default_config, f, indent=2, ensure_ascii=False)
    except Exception as e:
        _module_interface.logger.error(f"保存默认配置失败: {e}")

    return default_config


def save_config(config):
    """保存配置到文件

    Args:
        config (dict): 配置信息

    Returns:
        bool: 保存是否成功
    """
    try:
        os.makedirs(os.path.dirname(_config_file), exist_ok=True)
        with open(_config_file, 'w', encoding='utf-8') as f:
            json.dump(config, f, indent=2, ensure_ascii=False)
        return True
    except Exception as e:
        _module_interface.logger.error(f"保存配置失败: {e}")
        return False


async def update_exchange_rates():
    """更新汇率数据"""
    global _state

    current_time = time.time()
    # 如果距离上次更新时间小于更新间隔，直接返回
    if current_time - _state["last_update"] < _state[
            "update_interval"] and _state["data_loaded"]:
        return

    _module_interface.logger.debug("正在更新汇率数据...")

    try:
        # 更新法币汇率
        await update_fiat_rates()

        # 更新虚拟货币汇率
        await update_crypto_rates()

        # 更新时间戳
        _state["last_update"] = current_time

        # 如果两种汇率数据都有内容，标记为已加载
        if _state["fiat_rates"] and _state["crypto_rates"]:
            _state["data_loaded"] = True
            _module_interface.logger.debug("汇率数据初始加载完成")

        # 保存状态到框架的状态管理中
        _module_interface.save_state(_state)
    except Exception as e:
        _module_interface.logger.error(f"更新汇率数据失败: {e}")


async def update_fiat_rates():
    """更新法币汇率"""
    if not EXCHANGERATE_API_KEY:
        _module_interface.logger.warning("未设置 ExchangeRate API 密钥，无法更新法币汇率")
        raise ValueError("未设置 API 密钥")

    # 使用美元作为基准货币
    base_currency = "USD"
    url = EXCHANGERATE_API_URL.format(EXCHANGERATE_API_KEY, base_currency)

    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                if data.get("result") == "success":
                    _state["fiat_rates"] = data.get("conversion_rates", {})
                    _module_interface.logger.debug(
                        f"已更新 {len(_state['fiat_rates'])} 种法币汇率")
                else:
                    error_type = data.get("error_type", "未知错误")
                    _module_interface.logger.error(f"获取法币汇率失败: {error_type}")
                    raise ValueError(f"错误: {error_type}")
            else:
                _module_interface.logger.error(
                    f"获取法币汇率请求失败: {response.status}")
                raise ValueError(f"状态码 {response.status}")


async def update_crypto_rates():
    """更新虚拟货币汇率"""
    from utils.currency_data import CRYPTO_CURRENCY_ALIASES

    # 获取所有虚拟货币 ID
    crypto_ids = list(set(CRYPTO_CURRENCY_ALIASES.values()))
    # 使用美元和人民币作为计价货币
    vs_currencies = "usd,cny,eur,gbp,jpy"

    # 构建 API URL
    url = COINGECKO_API_URL.format(",".join(crypto_ids), vs_currencies)

    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                _state["crypto_rates"] = data
                _module_interface.logger.debug(f"已更新 {len(data)} 种虚拟货币汇率")
            else:
                _module_interface.logger.error(
                    f"获取虚拟货币汇率请求失败: {response.status}")


async def convert_currency(amount, from_currency, to_currency):
    """转换货币

    Args:
        amount (float): 要转换的金额
        from_currency (str): 源货币名称或代码
        to_currency (str): 目标货币名称或代码

    Returns:
        tuple: (转换后金额, 错误信息)，如果转换成功则错误信息为 None
    """
    from utils.currency_data import CurrencyData

    # 检查数据是否已加载
    if not _state["data_loaded"]:
        # 如果数据未加载，尝试立即更新
        await update_exchange_rates()

        # 再次检查数据是否已加载
        if not _state["data_loaded"]:
            return None, "汇率数据正在加载中，请稍后再试"

    # 确保汇率数据是最新的
    await update_exchange_rates()

    # 获取货币代码
    from_code, from_type = CurrencyData.get_currency_code(from_currency)
    to_code, to_type = CurrencyData.get_currency_code(to_currency)

    if not from_code:
        return None, f"无法识别源货币: {from_currency}"

    if not to_code:
        return None, f"无法识别目标货币: {to_currency}"

    # 法币到法币的转换
    if from_type == "fiat" and to_type == "fiat":
        if "USD" not in _state["fiat_rates"]:
            return None, "汇率数据尚未加载，请稍后再试"

        # 获取相对于美元的汇率
        from_rate = 1.0 if from_code == "USD" else _state["fiat_rates"].get(
            from_code, 0)
        to_rate = 1.0 if to_code == "USD" else _state["fiat_rates"].get(
            to_code, 0)

        if from_rate == 0:
            return None, f"未找到 {from_currency} 的汇率数据"

        if to_rate == 0:
            return None, f"未找到 {to_currency} 的汇率数据"

        # 计算转换后的金额
        result = amount * (to_rate / from_rate)
        return result, None

    # 虚拟货币到法币的转换
    elif from_type == "crypto" and to_type == "fiat":
        if from_code not in _state["crypto_rates"]:
            return None, f"未找到 {from_currency} 的汇率数据"

        # 获取虚拟货币对美元的汇率
        crypto_data = _state["crypto_rates"].get(from_code, {})

        # 尝试直接获取对目标货币的汇率
        to_code_lower = to_code.lower()
        if to_code_lower in crypto_data:
            crypto_to_fiat_rate = crypto_data.get(to_code_lower, 0)
            if crypto_to_fiat_rate == 0:
                return None, f"未找到 {from_currency} 到 {to_currency} 的汇率数据"

            result = amount * crypto_to_fiat_rate
            return result, None
        else:
            # 如果没有直接汇率，通过美元中转
            crypto_to_usd_rate = crypto_data.get("usd", 0)
            if crypto_to_usd_rate == 0:
                return None, f"未找到 {from_currency} 到美元的汇率数据"

            # 美元到目标法币的转换
            usd_to_fiat_rate = 1.0 if to_code == "USD" else _state[
                "fiat_rates"].get(to_code, 0)
            if usd_to_fiat_rate == 0:
                return None, f"未找到美元到 {to_currency} 的汇率数据"

            result = amount * crypto_to_usd_rate * usd_to_fiat_rate
            return result, None

    # 法币到虚拟货币的转换
    elif from_type == "fiat" and to_type == "crypto":
        if to_code not in _state["crypto_rates"]:
            return None, f"未找到 {to_currency} 的汇率数据"

        # 获取虚拟货币对美元的汇率
        crypto_data = _state["crypto_rates"].get(to_code, {})

        # 尝试直接获取对源货币的汇率
        from_code_lower = from_code.lower()
        if from_code_lower in crypto_data:
            fiat_to_crypto_rate = crypto_data.get(from_code_lower, 0)
            if fiat_to_crypto_rate == 0:
                return None, f"未找到 {from_currency} 到 {to_currency} 的汇率数据"

            # 注意这里是除以汇率
            result = amount / fiat_to_crypto_rate
            return result, None
        else:
            # 如果没有直接汇率，通过美元中转
            # 源法币到美元的转换
            fiat_to_usd_rate = 1.0 if from_code == "USD" else (
                1 / _state["fiat_rates"].get(from_code, 0))
            if fiat_to_usd_rate == 0:
                return None, f"未找到 {from_currency} 到美元的汇率数据"

            # 美元到目标虚拟货币的转换
            usd_to_crypto_rate = crypto_data.get("usd", 0)
            if usd_to_crypto_rate == 0:
                return None, f"未找到美元到 {to_currency} 的汇率数据"

            # 先转成美元，再转成虚拟货币
            result = amount * fiat_to_usd_rate / usd_to_crypto_rate
            return result, None

    # 虚拟货币到虚拟货币的转换
    elif from_type == "crypto" and to_type == "crypto":
        if from_code not in _state["crypto_rates"] or to_code not in _state[
                "crypto_rates"]:
            return None, f"未找到 {from_currency} 或 {to_currency} 的汇率数据"

        # 获取两种虚拟货币对美元的汇率
        from_crypto_data = _state["crypto_rates"].get(from_code, {})
        to_crypto_data = _state["crypto_rates"].get(to_code, {})

        from_to_usd_rate = from_crypto_data.get("usd", 0)
        to_to_usd_rate = to_crypto_data.get("usd", 0)

        if from_to_usd_rate == 0 or to_to_usd_rate == 0:
            return None, f"未找到必要的汇率数据进行转换"

        # 通过美元中转
        result = amount * (from_to_usd_rate / to_to_usd_rate)
        return result, None

    return None, "不支持的货币类型组合"


async def rate_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /rate 命令"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 如果没有参数，显示帮助信息
    if not context.args or len(context.args) < 2:
        help_text = ("💱 *汇率转换帮助*\n\n"
                     "*使用方法:*\n"
                     "/rate <金额> <源货币> <目标货币>\n"
                     "/rate <源货币> <目标货币> \\[金额=1]\n\n"
                     "*示例:*（支持多种输入方式）\n"
                     "`/rate 100 USD 中国`\n"
                     "`/rate 比特币 CN`\n\n"
                     "*支持的货币:*\n"
                     "- 法币: CNY, USD, EUR, GBP, JPY 等\n"
                     "- 虚拟货币: BTC, ETH, USDT 等\n\n"
                     "*配置命令:*\n"
                     "/setrate - 配置汇率模块")
        await message.reply_text(help_text, parse_mode="MARKDOWN")
        return

    # 解析参数
    amount = 1.0
    from_currency = ""
    to_currency = ""

    # 检查第一个参数是否是数字
    try:
        amount = float(context.args[0])
        from_currency = context.args[1]
        to_currency = context.args[2] if len(context.args) > 2 else ""
    except ValueError:
        # 如果第一个参数不是数字，则假定格式为 "源货币 目标货币 [金额]"
        from_currency = context.args[0]
        to_currency = context.args[1]
        # 检查是否提供了金额
        if len(context.args) > 2:
            try:
                amount = float(context.args[2])
            except ValueError:
                await message.reply_text(
                    "无法识别的金额。请使用数字表示金额\n例如: `/rate 100 美元 人民币`",
                    parse_mode="MARKDOWN")
                return

    # 如果没有提供目标货币
    if not to_currency:
        await message.reply_text("请同时提供源货币和目标货币\n例如: `/rate 100 美元 人民币`",
                                 parse_mode="MARKDOWN")
        return

    # 执行货币转换
    result, error = await convert_currency(amount, from_currency, to_currency)

    if error:
        await message.reply_text(f"❌ 转换失败: {error}")
        return

    # 获取货币代码和类型
    from utils.currency_data import CurrencyData
    from_code, from_type = CurrencyData.get_currency_code(from_currency)
    to_code, to_type = CurrencyData.get_currency_code(to_currency)

    # 格式化结果
    formatted_from = CurrencyData.format_currency_amount(
        amount, from_code, from_type)
    formatted_to = CurrencyData.format_currency_amount(result, to_code,
                                                       to_type)

    # 获取更新时间
    update_time = time.strftime("%Y-%m-%d %H:%M:%S",
                                time.localtime(_state["last_update"]))

    # 发送结果
    result_message = (f"💱 *汇率转换结果*\n\n"
                      f"{formatted_from} = {formatted_to}\n\n"
                      f"*汇率更新时间:* {update_time}")

    await message.reply_text(result_message, parse_mode="MARKDOWN")


def get_config_ui():
    """获取配置界面

    Returns:
        tuple: (配置文本, 按钮标记)
    """
    config = load_config()
    api_key = config.get("api_key", "")
    # 隐藏部分 API 密钥以保护安全
    masked_key = "未设置" if not api_key else f"{api_key[:4]}...{api_key[-4:]}" if len(
        api_key) > 8 else "已设置"
    update_interval = config.get("update_interval", 3600)

    # 构建按钮
    keyboard = [[
        InlineKeyboardButton("API Key",
                             callback_data=f"{CALLBACK_PREFIX}set_api_key"),
        InlineKeyboardButton("Interval",
                             callback_data=f"{CALLBACK_PREFIX}set_interval")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    config_text = (f"🔧 *汇率模块配置*\n\n"
                   f"API 密钥: `{masked_key}`\n"
                   f"更新间隔: `{update_interval}秒`\n\n"
                   f"请选择要修改的设置：")

    return config_text, reply_markup


async def setrate_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /setrate 命令，用于管理员设置汇率模块配置

    Args:
        update: 更新对象
        context: 上下文对象（未使用，但 Telegram 库要求提供）
    """
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查是否是私聊
    if update.effective_chat.type != "private":
        await message.reply_text("⚠️ 出于安全考虑只能在私聊中进行")
        return

    # 获取配置界面
    config_text, reply_markup = get_config_ui()

    # 发送配置界面
    await message.reply_text(config_text,
                             reply_markup=reply_markup,
                             parse_mode="MARKDOWN")


async def periodic_update():
    """定期更新汇率数据"""
    try:
        while True:
            await asyncio.sleep(_state["update_interval"])
            try:
                await update_exchange_rates()
            except Exception as e:
                _module_interface.logger.error(f"定期更新汇率失败: {e}")
    except asyncio.CancelledError:
        _module_interface.logger.debug("汇率更新任务已取消")
        raise


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询

    Args:
        update: 更新对象
        context: 上下文对象
    """
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
    session_manager = _module_interface.session_manager
    if not session_manager:
        await query.answer("系统错误，请联系管理员")
        return

    # 处理不同的操作
    if action == "set_api_key":

        # 检查是否有其他模块的活跃会话
        if await session_manager.has_other_module_session(user_id,
                                                          MODULE_NAME,
                                                          chat_id=chat_id):
            await query.answer("⚠️ 请先完成或取消其他活跃会话")
            return

        # 设置会话状态，等待用户输入 API 密钥
        await session_manager.set(user_id,
                                  "rate_waiting_for",
                                  "api_key",
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

        # 发送提示消息
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}cancel")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(
            "请输入 ExchangeRate API 密钥：\n\n"
            "您可以在 [exchangerate-api.com](https://www.exchangerate-api.com/) 注册获取免费 API 密钥",
            reply_markup=reply_markup,
            parse_mode="MARKDOWN",
            disable_web_page_preview=True)

    elif action == "set_interval":

        # 检查是否有其他模块的活跃会话
        if await session_manager.has_other_module_session(user_id,
                                                          MODULE_NAME,
                                                          chat_id=chat_id):
            await query.answer("⚠️ 请先完成或取消其他活跃会话")
            return

        # 设置会话状态，等待用户输入更新间隔
        await session_manager.set(user_id,
                                  "rate_waiting_for",
                                  "interval",
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

        # 发送提示消息
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}cancel")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(
            "请输入汇率数据更新间隔（秒）：\n\n"
            "最小值为 600 秒（10 分钟）",
            reply_markup=reply_markup)

    elif action == "cancel":
        # 清除会话状态
        await session_manager.delete(user_id,
                                     "rate_waiting_for",
                                     chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              MODULE_NAME,
                                              chat_id=chat_id)

        # 获取配置界面
        config_text, reply_markup = get_config_ui()

        # 显示配置界面
        await query.edit_message_text(config_text,
                                      reply_markup=reply_markup,
                                      parse_mode="MARKDOWN")

    # 确保回调查询得到响应
    await query.answer()


async def handle_rate_input(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """处理用户输入的汇率配置

    Args:
        update: 更新对象
        context: 上下文对象
    """
    # 只处理私聊消息
    if update.effective_chat.type != "private":
        return

    message = update.message
    if not message:
        return

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = _module_interface.session_manager
    if not session_manager:
        return

    # 检查是否是 rate 模块的活跃会话
    if not await session_manager.is_session_owned_by(
            user_id, MODULE_NAME, chat_id=chat_id):
        return

    # 获取会话状态
    waiting_for = await session_manager.get(user_id,
                                            "rate_waiting_for",
                                            None,
                                            chat_id=chat_id)

    if waiting_for == "api_key":
        # 获取用户输入的 API 密钥
        api_key = message.text.strip()

        # 清除会话状态
        await session_manager.delete(user_id,
                                     "rate_waiting_for",
                                     chat_id=chat_id)
        await session_manager.release_session(user_id,
                                              MODULE_NAME,
                                              chat_id=chat_id)

        # 更新配置
        config = load_config()
        config["api_key"] = api_key

        if save_config(config):
            # 更新全局变量
            global EXCHANGERATE_API_KEY
            EXCHANGERATE_API_KEY = api_key

            await message.reply_text("✅ API 密钥已更新")

            # 临时保存法定货币汇率数据，以便在更新失败时恢复
            old_fiat_rates = _state["fiat_rates"].copy()

            try:
                # 调用法定货币汇率更新函数
                await update_fiat_rates()
                await message.reply_text("✅ 汇率数据已更新，API 密钥有效")
            except Exception as e:
                # 恢复法定货币汇率数据
                _state["fiat_rates"] = old_fiat_rates
                await message.reply_text(f"⚠️ API 密钥无效: {str(e)}")
        else:
            await message.reply_text("❌ 保存配置失败")

    elif waiting_for == "interval":
        # 获取用户输入的更新间隔
        try:
            interval = int(message.text.strip())

            # 清除会话状态
            await session_manager.delete(user_id,
                                         "rate_waiting_for",
                                         chat_id=chat_id)
            await session_manager.release_session(user_id,
                                                  MODULE_NAME,
                                                  chat_id=chat_id)

            if interval < 600:  # 设置最小间隔，如10分钟
                await message.reply_text("⚠️ 更新间隔不能小于 600 秒（10 分钟）")
                return

            config = load_config()
            config["update_interval"] = interval

            if save_config(config):
                # 更新状态
                _state["update_interval"] = interval

                # 保存状态到框架的状态管理中
                _module_interface.save_state(_state)

                # 重启定期更新任务
                global _update_task
                if _update_task and not _update_task.done():
                    _update_task.cancel()

                _update_task = asyncio.create_task(periodic_update())

                await message.reply_text(f"✅ 更新间隔已设置为 {interval} 秒")
            else:
                await message.reply_text("❌ 保存配置失败")
        except ValueError:
            await message.reply_text("❌ 请输入有效的数字作为更新间隔")

            # 清除会话状态
            await session_manager.delete(user_id,
                                         "rate_waiting_for",
                                         chat_id=chat_id)
            await session_manager.release_session(user_id,
                                                  MODULE_NAME,
                                                  chat_id=chat_id)


async def setup(interface):
    """模块初始化

    Args:
        interface: 模块接口
    """
    global _module_interface, _state, _update_task
    _module_interface = interface

    # 加载配置
    config = load_config()
    _state["update_interval"] = config.get("update_interval", 3600)

    # 注册命令
    await interface.register_command(
        "rate",
        rate_command,
        admin_level=False,
        description="查询汇率",
    )
    await interface.register_command(
        "setrate",
        setrate_command,
        admin_level="super_admin",
        description="汇率模块配置",
    )  # 仅超级管理员可用

    # 注册带权限验证的按钮回调处理器
    await interface.register_callback_handler(
        handle_callback_query,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level="super_admin"  # 仅超级管理员可用
    )

    # 注册文本输入处理器
    text_input_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/')
        & filters.ChatType.PRIVATE, handle_rate_input)
    await interface.register_handler(text_input_handler, group=4)

    # 使用框架的状态管理加载状态
    saved_state = interface.load_state(
        default={
            "last_update": 0,
            "update_interval": _state["update_interval"],
            "fiat_rates": {},
            "crypto_rates": {},
            "data_loaded": False
        })

    # 更新状态
    if saved_state:
        _state.update(saved_state)

    # 启动更新任务
    _update_task = asyncio.create_task(periodic_update())

    # 立即更新汇率数据
    asyncio.create_task(update_exchange_rates())

    interface.logger.info(
        f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化，更新间隔: {_state['update_interval']} 秒"
    )


async def cleanup(interface):
    """模块清理

    Args:
        interface: 模块接口
    """
    # 取消更新任务
    global _update_task
    if _update_task and not _update_task.done():
        _update_task.cancel()
        try:
            await _update_task
        except asyncio.CancelledError:
            pass

    # 保存状态到框架的状态管理中
    interface.save_state(_state)

    interface.logger.info(f"模块 {MODULE_NAME} 已清理")
