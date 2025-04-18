# modules/rate.py - 汇率转换模块

import json
import os
import time
import aiohttp
import asyncio
from telegram import Update
from telegram.ext import ContextTypes

# 模块元数据
MODULE_NAME = "rate"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "汇率转换，支持法币/虚拟货币"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["rate", "setrate"]

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
            if _module_interface:
                _module_interface.logger.error(f"加载配置文件失败: {e}")

    # 创建默认配置
    default_config = {"api_key": "", "update_interval": 3600}

    # 保存默认配置
    try:
        os.makedirs(os.path.dirname(_config_file), exist_ok=True)
        with open(_config_file, 'w', encoding='utf-8') as f:
            json.dump(default_config, f, indent=2, ensure_ascii=False)
    except Exception as e:
        if _module_interface:
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
        if _module_interface:
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

    if _module_interface:
        _module_interface.logger.info("正在更新汇率数据...")

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
            if _module_interface:
                _module_interface.logger.info("汇率数据初始加载完成")

        if _module_interface:
            _module_interface.logger.info("汇率数据更新完成")
    except Exception as e:
        if _module_interface:
            _module_interface.logger.error(f"更新汇率数据失败: {e}")


async def update_fiat_rates():
    """更新法币汇率"""
    if not EXCHANGERATE_API_KEY:
        if _module_interface:
            _module_interface.logger.warning(
                "未设置 ExchangeRate API 密钥，无法更新法币汇率")
        return

    # 使用美元作为基准货币
    base_currency = "USD"
    url = EXCHANGERATE_API_URL.format(EXCHANGERATE_API_KEY, base_currency)

    async with aiohttp.ClientSession() as session:
        async with session.get(url) as response:
            if response.status == 200:
                data = await response.json()
                if data.get("result") == "success":
                    _state["fiat_rates"] = data.get("conversion_rates", {})
                    if _module_interface:
                        _module_interface.logger.debug(
                            f"已更新 {len(_state['fiat_rates'])} 种法币汇率")
                else:
                    if _module_interface:
                        _module_interface.logger.error(
                            f"获取法币汇率失败: {data.get('error_type')}")
            else:
                if _module_interface:
                    _module_interface.logger.error(
                        f"获取法币汇率请求失败: {response.status}")


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
                if _module_interface:
                    _module_interface.logger.debug(f"已更新 {len(data)} 种虚拟货币汇率")
            else:
                if _module_interface:
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
            return None, "汇率数据正在加载中，请稍后再试。首次使用可能需要等待几秒钟。"

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
    # 如果没有参数，显示帮助信息
    if not context.args or len(context.args) < 2:
        help_text = ("💱 *汇率转换帮助*\n\n"
                     "*使用方法:*\n"
                     "/rate <金额> <源货币> <目标货币>\n"
                     "/rate <源货币> <目标货币> [金额=1]\n\n"
                     "*示例:*\n"
                     "`/rate 100 美元 人民币` - 将 100 美元转换为人民币\n"
                     "`/rate 人民币 日元` - 显示 1 人民币等于多少日元\n"
                     "`/rate 1000 日本 韩国` - 将 1000 日元转换为韩元\n"
                     "`/rate 比特币 人民币` - 显示 1 比特币等于多少人民币\n"
                     "`/rate 100 usdt eth` - 将 100 USDT 转换为以太坊\n\n"
                     "*支持的货币:*\n"
                     "- 法币: 人民币(CNY), 美元(USD), 欧元(EUR), 英镑(GBP), 日元(JPY)等\n"
                     "- 虚拟货币: 比特币(BTC), 以太坊(ETH), 泰达币(USDT)等\n\n"
                     "*支持的表示方式:*\n"
                     "- 货币代码: CNY, USD, BTC, ETH等\n"
                     "- 中文名称: 人民币, 美元, 比特币等\n"
                     "- 国家/地区名称: 中国, 美国, 日本等\n"
                     "- 符号: $, €, £, ¥等")
        await update.message.reply_text(help_text, parse_mode="MARKDOWN")
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
                await update.message.reply_text(
                    "无法识别的金额。请使用数字表示金额，例如: `/rate 100 美元 人民币`",
                    parse_mode="MARKDOWN")
                return

    # 如果没有提供目标货币
    if not to_currency:
        await update.message.reply_text("请同时提供源货币和目标货币，例如: `/rate 100 美元 人民币`",
                                        parse_mode="MARKDOWN")
        return

    # 执行货币转换
    result, error = await convert_currency(amount, from_currency, to_currency)

    if error:
        await update.message.reply_text(f"❌ 转换失败: {error}")
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
    message = (f"💱 *汇率转换结果*\n\n"
               f"{formatted_from} = {formatted_to}\n\n"
               f"*汇率更新时间:* {update_time}")

    await update.message.reply_text(message, parse_mode="MARKDOWN")


async def setrate_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /setrate 命令，用于管理员设置汇率模块配置"""
    # 如果没有参数，显示当前配置
    if not context.args:
        config = load_config()
        api_key = config.get("api_key", "")
        # 隐藏部分 API 密钥以保护安全
        masked_key = "未设置" if not api_key else f"{api_key[:4]}...{api_key[-4:]}" if len(
            api_key) > 8 else "已设置"
        update_interval = config.get("update_interval", 3600)

        config_text = (
            f"🔧 *汇率模块配置*\n\n"
            f"API 密钥: `{masked_key}`\n"
            f"更新间隔: `{update_interval}秒`\n\n"
            f"*设置命令:*\n"
            f"`/setrate api_key YOUR_API_KEY` - 设置 ExchangeRate API 密钥\n"
            f"`/setrate interval 3600` - 设置更新间隔(秒)")

        await update.message.reply_text(config_text, parse_mode="MARKDOWN")
        return

    # 解析参数
    setting_type = context.args[0].lower()

    # 设置 API 密钥
    if setting_type == "api_key" and len(context.args) > 1:
        api_key = context.args[1]
        config = load_config()
        config["api_key"] = api_key

        if save_config(config):
            # 更新全局变量
            global EXCHANGERATE_API_KEY
            EXCHANGERATE_API_KEY = api_key

            await update.message.reply_text("✅ API 密钥已更新",
                                            parse_mode="MARKDOWN")

            # 立即尝试更新汇率数据以验证 API 密钥
            try:
                await update_exchange_rates()
                await update.message.reply_text("✅ 汇率数据已更新，API 密钥有效",
                                                parse_mode="MARKDOWN")
            except Exception as e:
                await update.message.reply_text(
                    f"⚠️ 更新汇率数据失败，请检查 API 密钥: {str(e)}", parse_mode="MARKDOWN")
        else:
            await update.message.reply_text(f"❌ 保存配置失败", parse_mode="MARKDOWN")

        return

    # 设置更新间隔
    if setting_type == "interval" and len(context.args) > 1:
        try:
            interval = int(context.args[1])
            if interval < 600:  # 设置最小间隔，如10分钟
                await update.message.reply_text("⚠️ 更新间隔不能小于 600 秒(10 分钟)",
                                                parse_mode="MARKDOWN")
                return

            config = load_config()
            config["update_interval"] = interval

            if save_config(config):
                # 更新状态
                _state["update_interval"] = interval

                # 重启定期更新任务
                global _update_task
                if _update_task and not _update_task.done():
                    _update_task.cancel()

                _update_task = asyncio.create_task(periodic_update())

                await update.message.reply_text(f"✅ 更新间隔已设置为 {interval} 秒",
                                                parse_mode="MARKDOWN")
            else:
                await update.message.reply_text(f"❌ 保存配置失败",
                                                parse_mode="MARKDOWN")

        except ValueError:
            await update.message.reply_text("❌ 请输入有效的数字作为更新间隔",
                                            parse_mode="MARKDOWN")

        return

    # 如果参数不匹配任何设置选项
    await update.message.reply_text("❌ 无效的设置命令。使用 `/setrate` 查看可用设置选项。",
                                    parse_mode="MARKDOWN")


async def periodic_update():
    """定期更新汇率数据"""
    try:
        while True:
            await asyncio.sleep(_state["update_interval"])
            try:
                await update_exchange_rates()
            except Exception as e:
                if _module_interface:
                    _module_interface.logger.error(f"定期更新汇率失败: {e}")
    except asyncio.CancelledError:
        if _module_interface:
            _module_interface.logger.info("汇率更新任务已取消")
        raise


def get_state(module_interface):
    """获取模块状态（用于热更新）"""
    # 返回可序列化的状态
    serializable_state = {
        "last_update": _state["last_update"],
        "update_interval": _state["update_interval"],
        "fiat_rates": _state["fiat_rates"],
        "crypto_rates": _state["crypto_rates"],
        "data_loaded": _state["data_loaded"]
    }
    return serializable_state


def set_state(module_interface, state):
    """设置模块状态（用于热更新）"""
    global _state
    _state.update(state)
    module_interface.logger.debug(f"模块状态已更新")


async def setup(module_interface):
    """模块初始化"""
    global _module_interface, _state, _update_task
    _module_interface = module_interface

    # 加载配置
    config = load_config()
    _state["update_interval"] = config.get("update_interval", 3600)

    # 注册命令
    await module_interface.register_command(
        "rate",
        rate_command,
        description="查询汇率",
    )
    await module_interface.register_command(
        "setrate",
        setrate_command,
        admin_level="super_admin",
        description="汇率模块配置",
    )  # 仅超级管理员可用

    # 加载状态
    saved_state = module_interface.load_state(default=_state)
    _state.update(saved_state)

    # 启动更新任务
    _update_task = asyncio.create_task(periodic_update())

    # 立即更新汇率数据
    asyncio.create_task(update_exchange_rates())

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(module_interface):
    """模块清理"""
    # 取消更新任务
    global _update_task
    if _update_task and not _update_task.done():
        _update_task.cancel()
        try:
            await _update_task
        except asyncio.CancelledError:
            pass

    # 保存状态
    module_interface.save_state(get_state(module_interface))

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
