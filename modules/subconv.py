# modules/subconv.py - 订阅转换模块

import json
import os
import subprocess
import urllib.parse
from io import BytesIO
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputFile
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "subconv"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "基于 subconverter 的订阅转换"
MODULE_COMMANDS = ["subconv"]
MODULE_CHAT_TYPES = ["private"]

# 模块配置文件
CONFIG_FILE = "config/subconv.json"

# 按钮回调前缀
CALLBACK_PREFIX = "subconv_"

# 会话状态常量 - 使用模块名前缀避免与其他模块冲突
SESSION_ACTIVE = "subconv_active"  # 标记会话活跃状态
SESSION_WAITING_BACKEND = "subconv_waiting_backend"
SESSION_WAITING_CONFIG = "subconv_waiting_config"
SESSION_WAITING_EXCLUDE = "subconv_waiting_exclude"
SESSION_WAITING_INCLUDE = "subconv_waiting_include"
SESSION_WAITING_FILENAME = "subconv_waiting_filename"
SESSION_WAITING_GENERATE_URL = "subconv_waiting_generate_url"  # 等待生成链接的URL输入

# 默认配置
DEFAULT_CONFIG = {
    "default_backend_url": "https://suburl.kaze.icu",
    "default_config_url":
    "https://gist.githubusercontent.com/Misakamoe/f9eb77a91fd1a582cedf13e362123cf6/raw/Basic.ini",
    "default_target": "clash",
    "default_emoji": True,
    "default_tfo": True,  # TCP Fast Open 默认开启
    "default_udp": True,  # UDP 默认开启
    "default_scv": True,  # 跳过证书验证 默认开启
    "default_append_type": False,  # 节点类型 默认关闭
    "default_sort": False,  # 排序 默认关闭
    "default_expand": True,  # 展开规则 默认开启
    "default_list": False,  # 节点列表 默认关闭
    "default_new_name": True,  # 使用新字段名 默认开启
    "default_exclude": "",
    "default_include": "",
    "default_filename": "",
    "user_configs": {}  # 用户配置，格式: {user_id: {配置项}}
}

# 支持的目标格式
TARGET_FORMATS = [{
    "name": "Clash",
    "value": "clash"
}, {
    "name": "ClashR",
    "value": "clashr"
}, {
    "name": "Quantumult",
    "value": "quan"
}, {
    "name": "Quantumult X",
    "value": "quanx"
}, {
    "name": "Loon",
    "value": "loon"
}, {
    "name": "SS (SIP002)",
    "value": "ss"
}, {
    "name": "SS Android",
    "value": "sssub"
}, {
    "name": "SSD",
    "value": "ssd"
}, {
    "name": "SSR",
    "value": "ssr"
}, {
    "name": "Surfboard",
    "value": "surfboard"
}, {
    "name": "Surge 2",
    "value": "surge&ver=2"
}, {
    "name": "Surge 3",
    "value": "surge&ver=3"
}, {
    "name": "Surge 4",
    "value": "surge&ver=4"
}, {
    "name": "V2Ray",
    "value": "v2ray"
}]

# 模块接口引用
_module_interface = None

# 模块配置
_config = DEFAULT_CONFIG.copy()

# 模块状态 - 用于存储非超级管理员的配置
_state = {
    "user_configs": {}  # 用户配置，格式: {user_id: {配置项}}
}


def load_config():
    """加载配置文件"""
    global _config
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, "r", encoding="utf-8") as f:
                loaded_config = json.load(f)
                # 合并配置，确保所有默认配置项都存在
                for key in DEFAULT_CONFIG:
                    if key not in loaded_config:
                        loaded_config[key] = DEFAULT_CONFIG[key]
                _config = loaded_config
                _module_interface.logger.info(f"已加载配置文件: {CONFIG_FILE}")
        else:
            # 配置文件不存在，创建默认配置
            save_config()
            _module_interface.logger.info(f"已创建默认配置文件: {CONFIG_FILE}")
    except Exception as e:
        _module_interface.logger.error(f"加载配置文件失败: {e}")


def save_config():
    """保存配置文件"""
    try:
        # 确保配置目录存在
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, "w", encoding="utf-8") as f:
            json.dump(_config, f, ensure_ascii=False, indent=4)
        _module_interface.logger.debug(f"已保存配置文件: {CONFIG_FILE}")
        return True
    except Exception as e:
        _module_interface.logger.error(f"保存配置文件失败: {e}")
        return False


def get_user_config(user_id):
    """获取用户配置，如果是超级管理员则从永久配置获取，否则从框架状态获取"""
    user_id_str = str(user_id)

    # 检查用户是否为超级管理员
    if _module_interface.config_manager.is_admin(user_id):
        # 从永久配置获取
        if user_id_str not in _config["user_configs"]:
            _config["user_configs"][user_id_str] = {}
        return _config["user_configs"][user_id_str]
    else:
        # 从框架状态获取
        if user_id_str not in _state["user_configs"]:
            _state["user_configs"][user_id_str] = {}
        return _state["user_configs"][user_id_str]


def save_user_config(user_id, config_data):
    """保存用户配置"""
    user_id_str = str(user_id)

    # 检查用户是否为超级管理员
    if _module_interface.config_manager.is_admin(user_id):
        # 保存到永久配置
        _config["user_configs"][user_id_str] = config_data
        save_config()
    else:
        # 保存到框架状态
        _state["user_configs"][user_id_str] = config_data
        # 保存状态到框架
        _module_interface.save_state(_state)


def generate_subscription_link(backend_url,
                               target,
                               url,
                               config_url=None,
                               emoji=True,
                               exclude=None,
                               include=None,
                               filename=None,
                               tfo=True,
                               udp=True,
                               scv=True,
                               append_type=False,
                               sort=False,
                               expand=True,
                               list=False,
                               new_name=True):
    """生成订阅转换链接

    Args:
        backend_url: 后端地址
        target: 目标格式
        url: 原始订阅链接
        config_url: 配置文件链接
        emoji: 是否启用 emoji
        exclude: 排除节点
        include: 包含节点
        filename: 文件名
        tfo: 是否启用 TCP Fast Open
        udp: 是否启用 UDP
        scv: 是否跳过证书验证
        append_type: 是否添加节点类型
        sort: 是否排序节点
        expand: 是否展开规则
        list: 是否输出为节点列表
        new_name: 是否使用新字段名

    Returns:
        str: 生成的订阅链接
    """
    # 确保后端地址没有结尾的斜杠
    if backend_url.endswith("/"):
        backend_url = backend_url[:-1]

    # 构建基本参数
    params = {"target": target, "url": url}

    # 添加可选参数
    if config_url:
        params["config"] = config_url

    if emoji is not None:
        params["emoji"] = "true" if emoji else "false"

    if exclude:
        params["exclude"] = exclude

    if include:
        params["include"] = include

    if filename:
        params["filename"] = filename

    # 添加新增的参数
    if tfo is not None:
        params["tfo"] = "true" if tfo else "false"

    if udp is not None:
        params["udp"] = "true" if udp else "false"

    if scv is not None:
        params["scv"] = "true" if scv else "false"

    if append_type is not None:
        params["append_type"] = "true" if append_type else "false"

    if sort is not None:
        params["sort"] = "true" if sort else "false"

    if expand is not None:
        params["expand"] = "true" if expand else "false"

    if list is not None:
        params["list"] = "true" if list else "false"

    if new_name is not None:
        params["new_name"] = "true" if new_name else "false"

    # 构建查询字符串
    query_string = "&".join(
        [f"{k}={urllib.parse.quote(str(v))}" for k, v in params.items()])

    # 返回完整的订阅链接
    return f"{backend_url}/sub?{query_string}"


async def subconv_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """订阅转换命令处理函数"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await message.reply_text("系统错误，请联系管理员")
        return

    # 获取用户配置
    user_config = get_user_config(user_id)

    # 创建主菜单按钮
    keyboard = [[
        InlineKeyboardButton("Generate",
                             callback_data=f"{CALLBACK_PREFIX}generate"),
        InlineKeyboardButton("Settings",
                             callback_data=f"{CALLBACK_PREFIX}settings")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送欢迎消息
    await message.reply_text(
        "欢迎使用订阅转换工具\n\n"
        "此工具基于 subconverter 项目，可以将各种格式的代理订阅链接转换为其他格式\n\n"
        "请选择操作：",
        reply_markup=reply_markup,
        disable_web_page_preview=True)


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    # 获取回调数据
    query = update.callback_query
    data = query.data
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.answer("系统错误，请联系管理员")
        return

    # 获取用户配置
    user_config = get_user_config(user_id)

    # 确认回调查询
    await query.answer()

    # 处理不同的回调数据
    if data == f"{CALLBACK_PREFIX}generate":
        # 显示生成订阅的界面
        await show_generate_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}settings":
        # 显示设置界面
        await show_settings_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}back_to_main":
        # 返回主菜单
        await back_to_main_menu(update, context)

    elif data == f"{CALLBACK_PREFIX}select_target":
        # 显示目标格式选择菜单
        await show_target_selection(update, context)

    elif data.startswith(f"{CALLBACK_PREFIX}target_page:"):
        # 处理目标格式分页
        parts = data.split(":")
        if len(parts) >= 2:
            try:
                page_index = int(parts[1])
                context.user_data["target_page_index"] = page_index
            except ValueError:
                pass
        await show_target_selection(update, context)

    elif data.startswith(f"{CALLBACK_PREFIX}set_target:"):
        # 设置目标格式
        # 从页面内容中提取目标格式
        for item in TARGET_FORMATS:
            if f"{CALLBACK_PREFIX}set_target:{item['value']}" == data:
                user_config["target"] = item["value"]
                save_user_config(user_id, user_config)
                break
        await show_generate_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_emoji":
        # 切换 emoji 设置
        user_config["emoji"] = not user_config.get("emoji", True)
        save_user_config(user_id, user_config)
        await show_generate_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}more_options":
        # 显示更多选项菜单
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_tfo":
        # 切换 TCP Fast Open 设置
        user_config["tfo"] = not user_config.get("tfo", True)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_udp":
        # 切换 UDP 设置
        user_config["udp"] = not user_config.get("udp", True)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_scv":
        # 切换跳过证书验证设置
        user_config["scv"] = not user_config.get("scv", True)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_append_type":
        # 切换节点类型设置
        user_config["append_type"] = not user_config.get("append_type", False)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_sort":
        # 切换排序设置
        user_config["sort"] = not user_config.get("sort", False)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_expand":
        # 切换展开规则设置
        user_config["expand"] = not user_config.get("expand", True)
        save_user_config(user_id, user_config)
        await show_generate_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}toggle_list":
        # 切换节点列表设置
        user_config["list"] = not user_config.get("list", False)
        save_user_config(user_id, user_config)
        await show_more_options_menu(update, context, user_config)

    elif data.startswith(f"{CALLBACK_PREFIX}download_config:"):
        # 下载配置文件
        # 从回调数据中提取URL哈希
        url_hash = data.replace(f"{CALLBACK_PREFIX}download_config:", "")
        if not url_hash:
            await query.answer("无效的订阅链接")
            return

        # 从会话中获取URL
        url_key = f"subconv_temp_url_{url_hash}"
        url_part = await session_manager.get(user_id, url_key, chat_id=chat_id)
        if not url_part:
            await query.answer("订阅链接已过期，请重新生成")
            return

        # 删除临时存储的URL
        await session_manager.delete(user_id, url_key, chat_id=chat_id)

        # 获取用户配置的其他参数
        target = user_config.get("target", _config["default_target"])
        backend_url = user_config.get("backend_url",
                                      _config["default_backend_url"])
        config_url = user_config.get("config_url",
                                     _config["default_config_url"]) or None
        emoji = user_config.get("emoji", _config["default_emoji"])
        exclude = user_config.get("exclude",
                                  _config["default_exclude"]) or None
        include = user_config.get("include",
                                  _config["default_include"]) or None
        filename = user_config.get("filename",
                                   _config["default_filename"]) or None
        tfo = user_config.get("tfo", _config["default_tfo"])
        udp = user_config.get("udp", _config["default_udp"])
        scv = user_config.get("scv", _config["default_scv"])
        append_type = user_config.get("append_type",
                                      _config["default_append_type"])
        sort = user_config.get("sort", _config["default_sort"])
        expand = user_config.get("expand", _config["default_expand"])
        list = user_config.get("list", _config["default_list"])
        new_name = user_config.get("new_name", _config["default_new_name"])

        # 生成订阅链接
        subscription_link = generate_subscription_link(backend_url=backend_url,
                                                       target=target,
                                                       url=url_part,
                                                       config_url=config_url,
                                                       emoji=emoji,
                                                       exclude=exclude,
                                                       include=include,
                                                       filename=filename,
                                                       tfo=tfo,
                                                       udp=udp,
                                                       scv=scv,
                                                       append_type=append_type,
                                                       sort=sort,
                                                       expand=expand,
                                                       list=list,
                                                       new_name=new_name)

        # 通知用户正在下载
        await query.answer("正在下载配置文件...")

        # 发送一条新的下载中消息，保留原始消息
        loading_message = await context.bot.send_message(
            chat_id=chat_id, text="⏳ 正在下载配置文件，请稍候...")

        try:
            # 使用curl下载配置文件，这样可以避免一些服务器的限制
            _module_interface.logger.debug("正在请求订阅转换")

            # 使用subprocess运行curl命令
            curl_command = [
                'curl',
                '-s',  # 静默模式
                '-L',  # 跟随重定向
                '-A',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',  # 设置User-Agent
                subscription_link
            ]

            # 执行curl命令
            try:
                result = subprocess.run(
                    curl_command,
                    capture_output=True,
                    text=False,  # 不使用text=True，避免编码问题
                    check=True)
                # 手动处理编码，尝试UTF-8
                try:
                    config_content = result.stdout.decode('utf-8')
                except UnicodeDecodeError:
                    # 如果UTF-8解码失败，尝试其他编码
                    try:
                        config_content = result.stdout.decode('latin-1')
                    except:
                        config_content = result.stdout.decode('utf-8',
                                                              errors='replace')

                # 检查是否有内容
                if not config_content:
                    _module_interface.logger.error("下载配置文件失败: 返回内容为空")
                    await loading_message.edit_text(
                        "❌ 下载配置文件失败: 返回内容为空\n\n"
                        "请检查订阅链接是否有效",
                        reply_markup=InlineKeyboardMarkup([[
                            InlineKeyboardButton(
                                "⇠ Back",
                                callback_data=
                                f"{CALLBACK_PREFIX}back_to_generate")
                        ]]))
                    return

                # 检查是否包含错误信息
                if "<title>403 Forbidden</title>" in config_content:
                    _module_interface.logger.error("下载配置文件失败: 403 Forbidden")
                    await loading_message.edit_text(
                        "❌ 下载配置文件失败: 403 Forbidden\n\n"
                        "请检查订阅链接是否有效",
                        reply_markup=InlineKeyboardMarkup([[
                            InlineKeyboardButton(
                                "⇠ Back",
                                callback_data=
                                f"{CALLBACK_PREFIX}back_to_generate")
                        ]]))
                    return

            except subprocess.CalledProcessError as e:
                # 记录错误但不包含敏感信息
                _module_interface.logger.error(f"下载配置文件失败: {type(e).__name__}")
                await loading_message.edit_text(
                    f"❌ 下载配置文件失败: curl 命令执行错误\n\n"
                    "请检查订阅链接是否有效",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}back_to_generate")
                    ]]))
                return

            # 确定文件名和MIME类型
            if target in ["clash", "clashr"]:
                file_ext = "yaml"
            elif target in ["surfboard", "loon"]:
                file_ext = "conf"
            else:
                file_ext = "txt"

            # 使用用户设置的文件名或默认文件名
            if filename:
                file_name = f"{filename}.{file_ext}"
            else:
                file_name = f"config.{file_ext}"

            # 编辑下载中消息并发送文件
            await loading_message.delete()  # 删除加载消息

            # 发送文件，不带按钮
            await context.bot.send_document(
                chat_id=chat_id,
                document=InputFile(BytesIO(config_content.encode('utf-8')),
                                   filename=file_name))
        except Exception as e:
            # 处理错误，不记录敏感信息
            _module_interface.logger.error(f"下载配置文件失败: {type(e).__name__}")
            try:
                await loading_message.edit_text(
                    "❌ 下载配置文件失败\n\n"
                    "请检查订阅链接是否有效",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}back_to_generate")
                    ]]))
            except:
                # 如果loading_message已经被删除，则发送新消息
                await context.bot.send_message(
                    chat_id=chat_id,
                    text="❌ 下载配置文件失败\n\n"
                    "请检查订阅链接是否有效",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}back_to_generate")
                    ]]))

    elif data == f"{CALLBACK_PREFIX}set_backend":
        # 设置后端地址
        await query.edit_message_text(
            "请发送 subconverter 后端地址：\n\n"
            "例如：http://127.0.0.1:25500\n\n"
            "发送 /cancel 取消操作",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))
        # 设置会话活跃状态和步骤
        await session_manager.set(user_id,
                                  SESSION_ACTIVE,
                                  True,
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "subconv_step",
                                  SESSION_WAITING_BACKEND,
                                  chat_id=chat_id)

    elif data == f"{CALLBACK_PREFIX}set_config":
        # 设置配置文件链接
        await query.edit_message_text(
            "请发送配置文件链接：\n\n"
            "例如：https://example.com/config.ini\n\n"
            "发送 /cancel 取消操作",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))
        # 设置会话活跃状态和步骤
        await session_manager.set(user_id,
                                  SESSION_ACTIVE,
                                  True,
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "subconv_step",
                                  SESSION_WAITING_CONFIG,
                                  chat_id=chat_id)

    elif data == f"{CALLBACK_PREFIX}set_exclude":
        # 设置排除节点
        await query.edit_message_text(
            "请发送要排除的节点关键词：\n\n"
            "支持正则表达式，多个关键词用 | 分隔\n"
            "例如：香港|台湾|美国\n\n"
            "发送 /cancel 取消操作",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))
        # 设置会话活跃状态和步骤
        await session_manager.set(user_id,
                                  SESSION_ACTIVE,
                                  True,
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "subconv_step",
                                  SESSION_WAITING_EXCLUDE,
                                  chat_id=chat_id)

    elif data == f"{CALLBACK_PREFIX}set_include":
        # 设置包含节点
        await query.edit_message_text(
            "请发送要包含的节点关键词：\n\n"
            "支持正则表达式，多个关键词用 | 分隔\n"
            "例如：香港|台湾|美国\n\n"
            "发送 /cancel 取消操作",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))
        # 设置会话活跃状态和步骤
        await session_manager.set(user_id,
                                  SESSION_ACTIVE,
                                  True,
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "subconv_step",
                                  SESSION_WAITING_INCLUDE,
                                  chat_id=chat_id)

    elif data == f"{CALLBACK_PREFIX}set_filename":
        # 设置文件名
        await query.edit_message_text(
            "请发送订阅文件名：\n\n"
            "例如：my_subscription\n\n"
            "发送 /cancel 取消操作",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))
        # 设置会话活跃状态和步骤
        await session_manager.set(user_id,
                                  SESSION_ACTIVE,
                                  True,
                                  chat_id=chat_id)
        await session_manager.set(user_id,
                                  "subconv_step",
                                  SESSION_WAITING_FILENAME,
                                  chat_id=chat_id)

    elif data == f"{CALLBACK_PREFIX}back_to_generate":
        # 返回生成菜单，清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 清除所有临时URL会话状态
        try:
            # 获取所有会话键
            all_keys = await session_manager.get_all_keys(user_id,
                                                          chat_id=chat_id)
            # 筛选出临时URL会话键
            temp_url_keys = [
                key for key in all_keys if key.startswith("subconv_temp_url_")
            ]
            # 删除所有临时URL会话键
            for key in temp_url_keys:
                await session_manager.delete(user_id, key, chat_id=chat_id)
        except Exception as e:
            _module_interface.logger.error(f"清除临时URL会话状态失败: {e}")

        await show_generate_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}back_to_settings":
        # 返回设置菜单，清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)
        await show_settings_menu(update, context, user_config)

    elif data == f"{CALLBACK_PREFIX}reset_settings":
        # 重置设置
        user_config.clear()
        save_user_config(user_id, user_config)
        await query.edit_message_text(
            "设置已重置为默认值",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "⇠ Back",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif data == f"{CALLBACK_PREFIX}generate_link":
        # 生成订阅链接
        await generate_link(update, context, user_config)


async def show_generate_menu(update: Update,
                             context: ContextTypes.DEFAULT_TYPE, user_config):
    """显示生成订阅的界面"""
    # context 参数由框架提供，虽然此处未使用但必须保留
    query = update.callback_query

    # 获取当前设置
    target = user_config.get("target", _config["default_target"])
    emoji = user_config.get("emoji", _config["default_emoji"])
    tfo = user_config.get("tfo", _config["default_tfo"])
    udp = user_config.get("udp", _config["default_udp"])
    scv = user_config.get("scv", _config["default_scv"])
    append_type = user_config.get("append_type",
                                  _config["default_append_type"])
    sort = user_config.get("sort", _config["default_sort"])
    expand = user_config.get("expand", _config["default_expand"])
    list = user_config.get("list", _config["default_list"])

    # 获取目标格式的显示名称
    target_name = next(
        (item["name"] for item in TARGET_FORMATS if item["value"] == target),
        "未知")

    # 构建按钮
    keyboard = []

    # 目标格式按钮
    keyboard.append([
        InlineKeyboardButton(f"Format: {target_name}",
                             callback_data=f"{CALLBACK_PREFIX}select_target")
    ])

    # 生成链接按钮
    keyboard.append([
        InlineKeyboardButton("Generate Link",
                             callback_data=f"{CALLBACK_PREFIX}generate_link")
    ])

    # Emoji 开关按钮
    emoji_status = "✓ On" if emoji else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"Emoji: {emoji_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_emoji")
    ])

    # 展开规则开关按钮
    expand_status = "✓ On" if expand else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"Expand Rules: {expand_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_expand")
    ])

    # 更多选项按钮
    keyboard.append([
        InlineKeyboardButton("More Options",
                             callback_data=f"{CALLBACK_PREFIX}more_options")
    ])

    # 返回主菜单按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    # 更新消息
    await query.edit_message_text(
        "📋 生成订阅链接\n\n"
        f"*目标格式*: {target_name}\n"
        f"*Emoji*: {'开启' if emoji else '关闭'}\n"
        f"*展开规则*: {'开启' if expand else '关闭'}\n\n"
        "请配置以上选项，然后点击生成订阅链接",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown")


async def show_settings_menu(update: Update,
                             context: ContextTypes.DEFAULT_TYPE, user_config):
    """显示设置界面"""
    # context 参数由框架提供，虽然此处未使用但必须保留
    query = update.callback_query

    # 获取当前设置
    backend_url = user_config.get("backend_url",
                                  _config["default_backend_url"])
    config_url = user_config.get("config_url", _config["default_config_url"])
    exclude = user_config.get("exclude", _config["default_exclude"])
    include = user_config.get("include", _config["default_include"])
    filename = user_config.get("filename", _config["default_filename"])

    # 构建按钮
    keyboard = []

    # 后端地址按钮
    keyboard.append([
        InlineKeyboardButton("Backend URL",
                             callback_data=f"{CALLBACK_PREFIX}set_backend")
    ])

    # 配置文件链接按钮
    keyboard.append([
        InlineKeyboardButton("Config File",
                             callback_data=f"{CALLBACK_PREFIX}set_config")
    ])

    # 节点过滤按钮 (两个按钮放一行)
    keyboard.append([
        InlineKeyboardButton("Exclude",
                             callback_data=f"{CALLBACK_PREFIX}set_exclude"),
        InlineKeyboardButton("Include",
                             callback_data=f"{CALLBACK_PREFIX}set_include")
    ])

    # 文件名和重置按钮 (两个按钮放一行)
    keyboard.append([
        InlineKeyboardButton("FileName",
                             callback_data=f"{CALLBACK_PREFIX}set_filename"),
        InlineKeyboardButton("↺ Reset",
                             callback_data=f"{CALLBACK_PREFIX}reset_settings")
    ])

    # 返回主菜单按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    # 提取配置文件名
    config_name = '未设置'
    if config_url:
        # 尝试从URL中提取文件名
        try:
            # 先尝试从路径中提取
            path_parts = config_url.split('/')
            if path_parts:
                file_with_ext = path_parts[-1]
                # 去掉可能的扩展名
                config_name = file_with_ext.split('.')[0]
        except:
            # 如果提取失败，显示部分URL
            config_name = config_url[:15] + '...'

    # 更新消息
    await query.edit_message_text(
        "⚙️ 订阅转换设置\n\n"
        f"*后端地址*: `{backend_url}`\n"
        f"*配置文件*: {config_name}\n"
        f"*排除节点*: {exclude if exclude else '未设置'}\n"
        f"*包含节点*: {include if include else '未设置'}\n"
        f"*文件名*: {filename if filename else '未设置'}\n\n"
        "请选择要修改的设置项：",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown")


async def back_to_main_menu(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """返回主菜单"""
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if session_manager:
        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

    # 创建主菜单按钮
    keyboard = [[
        InlineKeyboardButton("Generate",
                             callback_data=f"{CALLBACK_PREFIX}generate"),
        InlineKeyboardButton("Settings",
                             callback_data=f"{CALLBACK_PREFIX}settings")
    ]]

    # 更新消息
    await query.edit_message_text(
        "欢迎使用订阅转换工具\n\n"
        "此工具基于 subconverter 项目，可以将各种格式的代理订阅链接转换为其他格式\n\n"
        "请选择操作：",
        reply_markup=InlineKeyboardMarkup(keyboard),
        disable_web_page_preview=True,
        parse_mode="Markdown")


async def generate_link(update: Update, context: ContextTypes.DEFAULT_TYPE,
                        user_config):
    """生成订阅链接"""
    # context 参数由框架提供，虽然此处未使用但必须保留
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.answer("系统错误，请联系管理员")
        return

    # 提示用户输入订阅链接
    await query.edit_message_text(
        "请发送原始订阅链接：\n\n"
        "支持多个链接，请用 | 分隔\n"
        "例如：https://example.com/sub1|https://example.com/sub2\n\n"
        "发送 /cancel 取消操作",
        reply_markup=InlineKeyboardMarkup([[
            InlineKeyboardButton(
                "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_generate")
        ]]))

    # 设置会话活跃状态和步骤
    await session_manager.set(user_id, SESSION_ACTIVE, True, chat_id=chat_id)
    await session_manager.set(user_id,
                              "subconv_step",
                              SESSION_WAITING_GENERATE_URL,
                              chat_id=chat_id)


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理用户消息，用于接收会话中的输入"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        return

    # 检查是否是本模块的活跃会话
    if not await session_manager.has_key(user_id, SESSION_ACTIVE, chat_id=chat_id) or \
       not await session_manager.has_key(user_id, "subconv_step", chat_id=chat_id):
        # 不是本模块的活跃会话，不处理
        return

    # 检查会话是否活跃
    is_active = await session_manager.get(user_id,
                                          SESSION_ACTIVE,
                                          chat_id=chat_id)
    if not is_active:
        # 会话不活跃，不处理
        return

    # 获取会话状态
    step = await session_manager.get(user_id, "subconv_step", chat_id=chat_id)

    # 获取用户配置
    user_config = get_user_config(user_id)

    # 处理取消命令
    if message.text == "/cancel":
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)
        await message.reply_text(
            "操作已取消",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Main",
                    callback_data=f"{CALLBACK_PREFIX}back_to_main")
            ]]))
        return

    # 根据不同的会话状态处理输入
    if step == SESSION_WAITING_BACKEND:
        # 处理后端地址输入
        backend_url = message.text.strip()

        # 简单验证 URL 格式
        if not backend_url.startswith(("http://", "https://")):
            await message.reply_text(
                "❌ 错误：后端地址必须以 http:// 或 https:// 开头！请重新输入或发送 /cancel 取消")
            return

        # 保存后端地址
        user_config["backend_url"] = backend_url
        save_user_config(user_id, user_config)

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 发送成功消息
        await message.reply_text(
            "✅ 后端地址已设置",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Settings",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif step == SESSION_WAITING_CONFIG:
        # 处理配置文件链接输入
        config_url = message.text.strip()

        # 配置文件链接可以为空，表示使用默认配置
        if not config_url:
            user_config["config_url"] = ""
            save_user_config(user_id, user_config)
            await session_manager.delete(user_id,
                                         "subconv_step",
                                         chat_id=chat_id)
            await session_manager.delete(user_id,
                                         SESSION_ACTIVE,
                                         chat_id=chat_id)
            await message.reply_text(
                "✅ 配置文件链接已清除，将使用默认配置",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "Back to Settings",
                        callback_data=f"{CALLBACK_PREFIX}back_to_settings")
                ]]))
            return

        # 简单验证 URL 格式
        if not config_url.startswith(("http://", "https://")):
            await message.reply_text(
                "❌ 错误：配置文件链接必须以 http:// 或 https:// 开头！请重新输入或发送 /cancel 取消")
            return

        # 保存配置文件链接
        user_config["config_url"] = config_url
        save_user_config(user_id, user_config)

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 发送成功消息
        await message.reply_text(
            "✅ 配置文件链接已设置",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Settings",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif step == SESSION_WAITING_EXCLUDE:
        # 处理排除节点输入
        exclude = message.text.strip()

        # 保存排除节点
        user_config["exclude"] = exclude
        save_user_config(user_id, user_config)

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 发送成功消息
        await message.reply_text(
            "✅ 排除节点规则已设置",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Settings",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif step == SESSION_WAITING_INCLUDE:
        # 处理包含节点输入
        include = message.text.strip()

        # 保存包含节点
        user_config["include"] = include
        save_user_config(user_id, user_config)

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 发送成功消息
        await message.reply_text(
            "✅ 包含节点规则已设置",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Settings",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif step == SESSION_WAITING_FILENAME:
        # 处理文件名输入
        filename = message.text.strip()

        # 保存文件名
        user_config["filename"] = filename
        save_user_config(user_id, user_config)

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 发送成功消息
        await message.reply_text(
            "✅ 文件名已设置",
            reply_markup=InlineKeyboardMarkup([[
                InlineKeyboardButton(
                    "Back to Settings",
                    callback_data=f"{CALLBACK_PREFIX}back_to_settings")
            ]]))

    elif step == SESSION_WAITING_GENERATE_URL:
        # 处理生成链接的URL输入
        url = message.text.strip()

        # 获取用户配置的其他参数
        target = user_config.get("target", _config["default_target"])
        backend_url = user_config.get("backend_url",
                                      _config["default_backend_url"])
        config_url = user_config.get("config_url",
                                     _config["default_config_url"]) or None
        emoji = user_config.get("emoji", _config["default_emoji"])
        exclude = user_config.get("exclude",
                                  _config["default_exclude"]) or None
        include = user_config.get("include",
                                  _config["default_include"]) or None
        filename = user_config.get("filename",
                                   _config["default_filename"]) or None
        tfo = user_config.get("tfo", _config["default_tfo"])
        udp = user_config.get("udp", _config["default_udp"])
        scv = user_config.get("scv", _config["default_scv"])
        append_type = user_config.get("append_type",
                                      _config["default_append_type"])
        sort = user_config.get("sort", _config["default_sort"])
        expand = user_config.get("expand", _config["default_expand"])
        list = user_config.get("list", _config["default_list"])
        new_name = user_config.get("new_name", _config["default_new_name"])

        # 生成订阅链接
        subscription_link = generate_subscription_link(backend_url=backend_url,
                                                       target=target,
                                                       url=url,
                                                       config_url=config_url,
                                                       emoji=emoji,
                                                       exclude=exclude,
                                                       include=include,
                                                       filename=filename,
                                                       tfo=tfo,
                                                       udp=udp,
                                                       scv=scv,
                                                       append_type=append_type,
                                                       sort=sort,
                                                       expand=expand,
                                                       list=list,
                                                       new_name=new_name)

        # 获取目标格式的显示名称
        target_name = next(
            (item["name"]
             for item in TARGET_FORMATS if item["value"] == target), "未知")

        # 清除会话状态
        await session_manager.delete(user_id, "subconv_step", chat_id=chat_id)
        await session_manager.delete(user_id, SESSION_ACTIVE, chat_id=chat_id)

        # 构建按钮
        keyboard = []

        # 下载配置文件按钮 (仅对Clash等格式有效)
        if target in ["clash", "clashr", "surfboard", "loon"]:
            # 生成URL的哈希值作为临时标识符
            url_hash = str(hash(url) % 10000000)  # 取模确保不会太长
            # 存储URL到会话中，以便后续使用，5秒后自动过期
            await session_manager.set(user_id,
                                      f"subconv_temp_url_{url_hash}",
                                      url,
                                      chat_id=chat_id,
                                      expire_after=5)  # 5秒后自动过期
            keyboard.append([
                InlineKeyboardButton(
                    "Download Config",
                    callback_data=f"{CALLBACK_PREFIX}download_config:{url_hash}"
                )
            ])

        # 返回按钮
        keyboard.append([
            InlineKeyboardButton(
                "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_generate")
        ])

        # 发送生成的链接
        await message.reply_text(
            f"✅ 已生成 *{target_name}* 格式的订阅链接：\n\n"
            f"`{subscription_link}`\n\n"
            "可以选择下载配置文件（5 秒内有效）：",
            reply_markup=InlineKeyboardMarkup(keyboard),
            parse_mode="Markdown")


async def show_more_options_menu(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE,
                                 user_config):
    """显示更多选项菜单"""
    # context 参数由框架提供，虽然此处未使用但必须保留
    query = update.callback_query

    # 获取当前设置
    tfo = user_config.get("tfo", _config["default_tfo"])
    udp = user_config.get("udp", _config["default_udp"])
    scv = user_config.get("scv", _config["default_scv"])
    append_type = user_config.get("append_type",
                                  _config["default_append_type"])
    sort = user_config.get("sort", _config["default_sort"])
    expand = user_config.get("expand", _config["default_expand"])
    list = user_config.get("list", _config["default_list"])

    # 构建按钮
    keyboard = []

    # TCP Fast Open 开关按钮
    tfo_status = "✓ On" if tfo else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"TCP Fast Open: {tfo_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_tfo")
    ])

    # UDP 开关按钮
    udp_status = "✓ On" if udp else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"UDP: {udp_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_udp")
    ])

    # 跳过证书验证开关按钮
    scv_status = "✓ On" if scv else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"Skip Cert Verify: {scv_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_scv")
    ])

    # 节点类型开关按钮
    append_type_status = "✓ On" if append_type else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(
            f"Show Node Type: {append_type_status}",
            callback_data=f"{CALLBACK_PREFIX}toggle_append_type")
    ])

    # 排序开关按钮
    sort_status = "✓ On" if sort else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"Sort Nodes: {sort_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_sort")
    ])

    # 节点列表开关按钮
    list_status = "✓ On" if list else "✗ Off"
    keyboard.append([
        InlineKeyboardButton(f"Node List: {list_status}",
                             callback_data=f"{CALLBACK_PREFIX}toggle_list")
    ])

    # 返回生成菜单按钮
    keyboard.append([
        InlineKeyboardButton(
            "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_generate")
    ])

    # 更新消息
    await query.edit_message_text(
        "📋 更多选项\n\n"
        f"*TCP Fast Open*: {'开启' if tfo else '关闭'}\n"
        f"*UDP*: {'开启' if udp else '关闭'}\n"
        f"*Skip Cert Verify*: {'开启' if scv else '关闭'}\n"
        f"*Show Node Type*: {'开启' if append_type else '关闭'}\n"
        f"*Sort Nodes*: {'开启' if sort else '关闭'}\n"
        f"*Node List*: {'开启' if list else '关闭'}\n\n"
        "请选择要修改的选项：",
        reply_markup=InlineKeyboardMarkup(keyboard),
        parse_mode="Markdown")


async def show_target_selection(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """显示目标格式选择菜单"""
    # context 参数由框架提供，虽然此处未使用但必须保留
    query = update.callback_query
    user_id = update.effective_user.id

    # 获取用户配置
    user_config = get_user_config(user_id)
    current_target = user_config.get("target", _config["default_target"])

    # 获取页码
    page_index = context.user_data.get("target_page_index", 0)
    page_size = 5

    # 计算总页数
    total_pages = (len(TARGET_FORMATS) + page_size - 1) // page_size

    # 确保页码在有效范围内
    page_index = max(0, min(page_index, total_pages - 1))

    # 创建按钮列表
    keyboard = []

    # 添加选择按钮
    page_start = page_index * page_size
    page_end = min(page_start + page_size, len(TARGET_FORMATS))

    for i in range(page_start, page_end):
        item = TARGET_FORMATS[i]
        keyboard.append([
            InlineKeyboardButton(
                f"{'▷ ' if item['value'] == current_target else '  '}{item['name']}",
                callback_data=f"{CALLBACK_PREFIX}set_target:{item['value']}")
        ])

    # 添加分页导航按钮
    nav_buttons = []

    # 上一页按钮
    if page_index > 0:
        nav_buttons.append(
            InlineKeyboardButton(
                "◁ Prev",
                callback_data=f"{CALLBACK_PREFIX}target_page:{page_index - 1}")
        )
    else:
        nav_buttons.append(InlineKeyboardButton(" ", callback_data="noop"))

    # 页码指示 - 使用noop避免点击时报错
    nav_buttons.append(
        InlineKeyboardButton(f"{page_index + 1}/{total_pages}",
                             callback_data="noop"))

    # 下一页按钮
    if page_index < total_pages - 1:
        nav_buttons.append(
            InlineKeyboardButton(
                "Next ▷",
                callback_data=f"{CALLBACK_PREFIX}target_page:{page_index + 1}")
        )
    else:
        nav_buttons.append(InlineKeyboardButton(" ", callback_data="noop"))

    keyboard.append(nav_buttons)

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton(
            "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_generate")
    ])

    # 创建消息内容
    content = f"*目标格式选择*\n\n"
    content += f"当前格式: {next((item['name'] for item in TARGET_FORMATS if item['value'] == current_target), '未知')}\n\n"
    content += f"第 {page_index + 1}/{total_pages} 页"

    # 更新消息
    await query.edit_message_text(content,
                                  reply_markup=InlineKeyboardMarkup(keyboard),
                                  parse_mode="MARKDOWN")


async def setup(interface):
    """模块初始化"""
    global _module_interface, _state
    _module_interface = interface

    # 加载配置
    load_config()

    # 从框架加载状态
    saved_state = interface.load_state(default={"user_configs": {}})
    if saved_state:
        _state.update(saved_state)
        interface.logger.debug("已从框架加载用户配置状态")

    # 注册命令
    await interface.register_command(
        "subconv",
        subconv_command,
        admin_level=False,  # 所有用户可用
        description="订阅转换工具")

    # 注册回调处理器
    await interface.register_callback_handler(
        handle_callback_query,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level=False  # 所有用户可用
    )

    # 注册消息处理器
    message_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/')
        & filters.ChatType.PRIVATE, handle_message)
    await interface.register_handler(message_handler, group=8)

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理，在卸载模块前调用"""
    # 保存状态到框架
    interface.save_state(_state)
    interface.logger.info(f"模块 {MODULE_NAME} 状态已保存")
