# modules/ai.py

import json
import os
import time
import asyncio
import aiohttp
from typing import Dict, List, Optional, Any
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters, CommandHandler, CallbackQueryHandler
from utils.decorators import error_handler, permission_check, module_check
from utils.text_utils import TextUtils

# 模块元数据
MODULE_NAME = "ai"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "AI 聊天小助手"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["ai", "aiconfig", "aiclear", "aiwhitelist"]

# 模块状态
_state = {
    "providers": {},  # 服务商配置
    "whitelist": [],  # 白名单用户 ID
    "conversations": {},  # 用户对话上下文
    "default_provider": None,  # 默认服务商
    "last_save_time": 0,  # 上次保存时间
    "usage_stats": {  # 使用统计
        "total_requests": 0,
        "requests_by_provider": {},
        "requests_by_user": {}
    },
    "conversation_timeout": 24 * 60 * 60,  # 默认 24 小时超时
}

# 配置文件路径
_config_file = "config/ai_config.json"
# 上下文保存路径
_context_file = "data/ai_contexts.json"
# 最大上下文长度
MAX_CONTEXT_LENGTH = 10
# 最大请求超时时间 (秒)
REQUEST_TIMEOUT = 60
# 最大消息长度
MAX_MESSAGE_LENGTH = 4000
# 流式处理配置
STREAM_CHUNK_SIZE = 15  # 每次更新的字符数
MIN_UPDATE_INTERVAL = 0.5  # 最小更新间隔(秒)

# 服务商配置模板
PROVIDER_TEMPLATES = {
    "openai": {
        "name": "OpenAI",
        "api_url": "https://api.openai.com/v1/chat/completions",
        "api_key": "",
        "model": "gpt-3.5-turbo",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai"
    },
    "gemini": {
        "name": "Google Gemini",
        "api_url":
        "https://generativelanguage.googleapis.com/v1/models/{model}:generateContent",
        "api_key": "",
        "model": "gemini-pro",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "gemini"
    },
    "anthropic": {
        "name": "Anthropic Claude",
        "api_url": "https://api.anthropic.com/v1/messages",
        "api_key": "",
        "model": "claude-3-opus-20240229",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "anthropic"
    },
    "custom": {
        "name": "自定义 API",
        "api_url": "",
        "api_key": "",
        "model": "",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai"
    }
}


# 不同服务商的请求格式化函数
def format_openai_request(provider, messages, stream=False):
    """格式化 OpenAI 请求"""
    return {
        "model": provider["model"],
        "messages": messages,
        "temperature": provider["temperature"],
        "stream": stream
    }


def format_gemini_request(provider, messages, stream=False):
    """格式化 Gemini 请求"""
    # 转换消息格式为 Gemini 格式
    gemini_messages = []

    for msg in messages:
        role = msg["role"]
        content = msg["content"]

        if role == "system":
            # 系统消息作为用户消息的前缀
            if gemini_messages and gemini_messages[-1]["role"] == "user":
                gemini_messages[-1]["parts"].append({"text": content})
            else:
                gemini_messages.append({
                    "role": "user",
                    "parts": [{
                        "text": content
                    }]
                })
        elif role == "user":
            gemini_messages.append({
                "role": "user",
                "parts": [{
                    "text": content
                }]
            })
        elif role == "assistant":
            gemini_messages.append({
                "role": "model",
                "parts": [{
                    "text": content
                }]
            })

    return {
        "contents": gemini_messages,
        "generationConfig": {
            "temperature": provider["temperature"]
        },
        "stream": stream
    }


def format_anthropic_request(provider, messages, stream=False):
    """格式化 Anthropic 请求"""
    # 提取系统提示
    system = ""
    for msg in messages:
        if msg["role"] == "system":
            system = msg["content"]
            break

    # 构建消息列表
    anthropic_messages = []
    for msg in messages:
        if msg["role"] == "user":
            anthropic_messages.append({
                "role": "user",
                "content": msg["content"]
            })
        elif msg["role"] == "assistant":
            anthropic_messages.append({
                "role": "assistant",
                "content": msg["content"]
            })

    # 构建请求
    request = {
        "model": provider["model"],
        "messages": anthropic_messages,
        "temperature": provider["temperature"],
        "max_tokens": 4000,  # 可配置的最大令牌数
        "stream": stream
    }

    # 添加系统提示 (如果有)
    if system:
        request["system"] = system

    return request


# 请求格式映射
REQUEST_FORMATTERS = {
    "openai": format_openai_request,
    "gemini": format_gemini_request,
    "anthropic": format_anthropic_request
}


# 不同服务商的响应解析函数
def parse_openai_response(response_json):
    """解析 OpenAI 响应"""
    try:
        return response_json["choices"][0]["message"]["content"]
    except (KeyError, IndexError):
        return None


def parse_gemini_response(response_json):
    """解析 Gemini 响应"""
    try:
        return response_json["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError):
        return None


def parse_anthropic_response(response_json):
    """解析 Anthropic 响应"""
    try:
        return response_json["content"][0]["text"]
    except (KeyError, IndexError):
        return None


# 响应解析器映射
RESPONSE_PARSERS = {
    "openai": parse_openai_response,
    "gemini": parse_gemini_response,
    "anthropic": parse_anthropic_response
}


async def call_ai_api_stream(provider_id, messages, module_interface,
                             update_callback):
    """流式调用 AI API"""
    global _state

    if provider_id not in _state["providers"]:
        return "错误：未找到指定的服务商配置"

    provider = _state["providers"][provider_id]

    # 检查 API 密钥
    if not provider.get("api_key"):
        return "错误：未配置 API 密钥"

    # 获取请求格式化器
    request_format = provider.get("request_format", "openai")
    formatter = REQUEST_FORMATTERS.get(request_format)
    if not formatter:
        return f"错误：不支持的请求格式 {request_format}"

    # 格式化请求 (启用流式)
    request_data = formatter(provider, messages, stream=True)

    # 准备 API URL
    api_url = provider["api_url"]
    if "{model}" in api_url:
        api_url = api_url.replace("{model}", provider["model"])

    # 准备请求头
    headers = {"Content-Type": "application/json"}

    # 不同服务商的认证方式
    if request_format == "openai":
        headers["Authorization"] = f"Bearer {provider['api_key']}"
    elif request_format == "gemini":
        # Gemini 使用 URL 参数传递 API 密钥
        api_url = f"{api_url}?key={provider['api_key']}"
    elif request_format == "anthropic":
        headers["x-api-key"] = provider["api_key"]
        headers["anthropic-version"] = "2023-06-01"

    try:
        module_interface.logger.debug(f"正在流式调用 {provider['name']} API")

        full_response = ""
        last_update_time = time.time()

        async with aiohttp.ClientSession() as session:
            async with session.post(api_url,
                                    json=request_data,
                                    headers=headers,
                                    timeout=REQUEST_TIMEOUT) as response:
                if response.status != 200:
                    error_text = await response.text()
                    module_interface.logger.error(
                        f"API 请求失败: {response.status} - {error_text}")
                    return f"API 请求失败: HTTP {response.status}"

                # 根据不同服务商处理流式响应
                if request_format == "openai":
                    # OpenAI 流式响应处理
                    async for line in response.content:
                        line = line.strip()
                        if not line or line == b'data: [DONE]':
                            continue

                        try:
                            # 移除 "data: " 前缀并解析 JSON
                            if line.startswith(b'data: '):
                                json_data = json.loads(line[6:])

                                if 'choices' in json_data and json_data[
                                        'choices']:
                                    delta = json_data['choices'][0].get(
                                        'delta', {})
                                    if 'content' in delta and delta['content']:
                                        content = delta['content']
                                        full_response += content

                                        # 确保有内容才更新
                                        if full_response.strip():
                                            # 控制更新频率
                                            current_time = time.time()
                                            if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
                                                await update_callback(
                                                    full_response)
                                                last_update_time = current_time
                        except Exception as e:
                            module_interface.logger.error(f"解析流式响应失败: {e}")

                elif request_format == "anthropic":
                    # Anthropic 流式响应处理
                    async for line in response.content:
                        line = line.strip()
                        if not line or line == b'data: [DONE]':
                            continue

                        try:
                            # 移除 "data: " 前缀并解析 JSON
                            if line.startswith(b'data: '):
                                json_data = json.loads(line[6:])

                                if 'type' in json_data and json_data[
                                        'type'] == 'content_block_delta':
                                    delta = json_data.get('delta', {})
                                    if 'text' in delta and delta['text']:
                                        content = delta['text']
                                        full_response += content

                                        # 确保有内容才更新
                                        if full_response.strip():
                                            # 控制更新频率
                                            current_time = time.time()
                                            if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
                                                await update_callback(
                                                    full_response)
                                                last_update_time = current_time
                        except Exception as e:
                            module_interface.logger.error(f"解析流式响应失败: {e}")

                elif request_format == "gemini":
                    # Gemini 流式响应处理
                    buffer = b""

                    async for chunk in response.content:
                        buffer += chunk

                        # 尝试解析完整的 JSON 对象
                        if b'\n' in buffer:
                            lines = buffer.split(b'\n')
                            # 保留最后一个可能不完整的行
                            buffer = lines.pop()

                            for line in lines:
                                if not line.strip():
                                    continue

                                try:
                                    json_data = json.loads(line)

                                    # 提取文本内容
                                    if 'candidates' in json_data and json_data[
                                            'candidates']:
                                        candidate = json_data['candidates'][0]
                                        if 'content' in candidate and 'parts' in candidate[
                                                'content']:
                                            for part in candidate['content'][
                                                    'parts']:
                                                if 'text' in part and part[
                                                        'text']:
                                                    content = part['text']
                                                    full_response += content

                                                    # 只有当有实际内容时才更新
                                                    if full_response.strip():
                                                        # 控制更新频率
                                                        current_time = time.time(
                                                        )
                                                        if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
                                                            await update_callback(
                                                                full_response)
                                                            last_update_time = current_time
                                except Exception as e:
                                    module_interface.logger.error(
                                        f"解析 Gemini 流式响应失败: {e} - 行: {line}")

                # 确保完整响应被发送
                if full_response:
                    await update_callback(full_response)

        # 更新使用统计
        _state["usage_stats"]["total_requests"] += 1
        _state["usage_stats"]["requests_by_provider"][
            provider_id] = _state["usage_stats"]["requests_by_provider"].get(
                provider_id, 0) + 1

        return full_response

    except aiohttp.ClientError as e:
        module_interface.logger.error(f"API 请求错误: {str(e)}")
        return f"API 请求错误: {str(e)}"
    except asyncio.TimeoutError:
        module_interface.logger.error("API 请求超时")
        return "API 请求超时，请稍后再试"
    except Exception as e:
        module_interface.logger.error(f"调用 AI API 时发生错误: {str(e)}")
        return f"发生错误: {str(e)}"


async def call_ai_api(provider_id,
                      messages,
                      module_interface,
                      use_stream=False):
    """调用 AI API，可选是否使用流式模式"""
    if use_stream:
        # 当使用流式模式但没有回调时，创建一个空回调
        async def dummy_callback(_):
            pass

        return await call_ai_api_stream(provider_id, messages,
                                        module_interface, dummy_callback)

    # 以下是原始的非流式实现
    global _state

    if provider_id not in _state["providers"]:
        return "错误：未找到指定的服务商配置"

    provider = _state["providers"][provider_id]

    # 检查 API 密钥
    if not provider.get("api_key"):
        return "错误：未配置 API 密钥"

    # 获取请求格式化器
    request_format = provider.get("request_format", "openai")
    formatter = REQUEST_FORMATTERS.get(request_format)
    if not formatter:
        return f"错误：不支持的请求格式 {request_format}"

    # 格式化请求
    request_data = formatter(provider, messages, stream=False)

    # 准备 API URL
    api_url = provider["api_url"]
    if "{model}" in api_url:
        api_url = api_url.replace("{model}", provider["model"])

    # 准备请求头
    headers = {"Content-Type": "application/json"}

    # 不同服务商的认证方式
    if request_format == "openai":
        headers["Authorization"] = f"Bearer {provider['api_key']}"
    elif request_format == "gemini":
        # Gemini 使用 URL 参数传递 API 密钥
        api_url = f"{api_url}?key={provider['api_key']}"
    elif request_format == "anthropic":
        headers["x-api-key"] = provider["api_key"]
        headers["anthropic-version"] = "2023-06-01"

    try:
        module_interface.logger.debug(f"正在调用 {provider['name']} API")

        async with aiohttp.ClientSession() as session:
            async with session.post(api_url,
                                    json=request_data,
                                    headers=headers,
                                    timeout=REQUEST_TIMEOUT) as response:
                if response.status != 200:
                    error_text = await response.text()
                    module_interface.logger.error(
                        f"API 请求失败: {response.status} - {error_text}")
                    return f"API 请求失败: HTTP {response.status}"

                response_json = await response.json()

                # 获取响应解析器
                parser = RESPONSE_PARSERS.get(request_format)
                if not parser:
                    return f"错误：不支持的响应格式 {request_format}"

                # 解析响应
                result = parser(response_json)
                if result is None:
                    module_interface.logger.error(
                        f"解析 API 响应失败: {response_json}")
                    return "解析 API 响应失败"

                # 更新使用统计
                _state["usage_stats"]["total_requests"] += 1
                _state["usage_stats"]["requests_by_provider"][
                    provider_id] = _state["usage_stats"][
                        "requests_by_provider"].get(provider_id, 0) + 1

                return result

    except aiohttp.ClientError as e:
        module_interface.logger.error(f"API 请求错误: {str(e)}")
        return f"API 请求错误: {str(e)}"
    except asyncio.TimeoutError:
        module_interface.logger.error("API 请求超时")
        return "API 请求超时，请稍后再试"
    except Exception as e:
        module_interface.logger.error(f"调用 AI API 时发生错误: {str(e)}")
        return f"发生错误: {str(e)}"


async def send_long_message(update, text, module_interface):
    """分段发送长消息"""
    # Telegram 消息最大长度约为 4096 字符
    MAX_LENGTH = 4000

    if len(text) <= MAX_LENGTH:
        return await update.message.reply_text(text)

    parts = []
    for i in range(0, len(text), MAX_LENGTH):
        parts.append(text[i:i + MAX_LENGTH])

    module_interface.logger.info(f"消息过长，将分为 {len(parts)} 段发送")

    # 发送第一段
    first_message = await update.message.reply_text(parts[0])

    # 发送剩余段落
    for part in parts[1:]:
        await first_message.reply_text(part)

    return first_message


def _get_module_interface():
    """获取模块接口（辅助函数）"""
    try:
        from telegram.ext import ApplicationBuilder
        application = ApplicationBuilder().token("dummy").build()
        bot_engine = application.bot_data.get("bot_engine")
        if bot_engine:
            return bot_engine.module_loader.get_module_interface(MODULE_NAME)
    except:
        pass
    return None


def get_user_context(user_id):
    """获取用户的对话上下文"""
    global _state
    user_id_str = str(user_id)

    if user_id_str not in _state["conversations"]:
        # 初始化新用户的上下文
        _state["conversations"][user_id_str] = []

    return _state["conversations"][user_id_str]


def add_message_to_context(user_id, role, content):
    """添加消息到用户上下文"""
    global _state
    user_id_str = str(user_id)
    context = get_user_context(user_id_str)

    # 添加新消息
    context.append({
        "role": role,
        "content": content,
        "timestamp": time.time()
    })

    # 限制上下文长度
    if len(context) > MAX_CONTEXT_LENGTH * 2:  # 成对限制 (用户+助手)
        # 保留系统消息 (如果有) 和最近的消息
        system_messages = [msg for msg in context if msg["role"] == "system"]
        recent_messages = context[-MAX_CONTEXT_LENGTH * 2:]
        context = system_messages + recent_messages
        _state["conversations"][user_id_str] = context

    # 更新用户统计
    if role == "user":
        _state["usage_stats"]["requests_by_user"][
            user_id_str] = _state["usage_stats"]["requests_by_user"].get(
                user_id_str, 0) + 1

    # 保存上下文
    save_contexts()

    return context


def clear_user_context(user_id):
    """清除用户的对话上下文"""
    global _state
    user_id_str = str(user_id)

    if user_id_str in _state["conversations"]:
        # 保留系统提示
        system_messages = [
            msg for msg in _state["conversations"][user_id_str]
            if msg["role"] == "system"
        ]
        _state["conversations"][user_id_str] = system_messages
        save_contexts()
        return True

    return False


def cleanup_expired_conversations():
    """清理过期的对话"""
    global _state
    now = time.time()
    timeout = _state.get("conversation_timeout", 24 * 60 * 60)  # 默认24小时
    expired_count = 0

    for user_id, context in list(_state["conversations"].items()):
        if not context:
            continue

        # 获取最后一条消息的时间
        last_message_time = max([msg.get("timestamp", 0)
                                 for msg in context]) if context else 0

        # 如果超过超时时间，清除对话（保留系统消息）
        if now - last_message_time > timeout:
            system_messages = [
                msg for msg in context if msg["role"] == "system"
            ]
            _state["conversations"][user_id] = system_messages
            expired_count += 1

    return expired_count


def format_context_for_api(provider, user_id):
    """格式化用户上下文为 API 请求格式"""
    provider_data = _state["providers"].get(provider)
    if not provider_data:
        return []

    # 获取用户上下文
    context = get_user_context(user_id)

    # 添加系统提示作为第一条消息 (如果不存在)
    has_system = any(msg["role"] == "system" for msg in context)

    messages = []
    if not has_system and provider_data.get("system_prompt"):
        messages.append({
            "role": "system",
            "content": provider_data["system_prompt"]
        })

    # 添加上下文消息 (去掉时间戳)
    for msg in context:
        if msg["role"] in ["user", "assistant", "system"]:
            messages.append({"role": msg["role"], "content": msg["content"]})

    return messages


def save_contexts():
    """保存所有用户的对话上下文"""
    try:
        os.makedirs(os.path.dirname(_context_file), exist_ok=True)
        with open(_context_file, 'w', encoding='utf-8') as f:
            json.dump(_state["conversations"], f, ensure_ascii=False, indent=2)

        # 更新保存时间
        _state["last_save_time"] = time.time()
    except Exception as e:
        module_interface = _get_module_interface()
        if module_interface:
            module_interface.logger.error(f"保存对话上下文失败: {e}")


def load_contexts():
    """加载所有用户的对话上下文"""
    global _state

    if not os.path.exists(_context_file):
        return

    try:
        with open(_context_file, 'r', encoding='utf-8') as f:
            _state["conversations"] = json.load(f)
    except Exception as e:
        module_interface = _get_module_interface()
        if module_interface:
            module_interface.logger.error(f"加载对话上下文失败: {e}")


def save_config():
    """保存 AI 配置"""
    global _state

    config_to_save = {
        "providers": _state["providers"],
        "whitelist": _state["whitelist"],
        "default_provider": _state["default_provider"],
        "usage_stats": _state["usage_stats"],
        "conversation_timeout": _state.get("conversation_timeout",
                                           24 * 60 * 60)
    }

    os.makedirs(os.path.dirname(_config_file), exist_ok=True)

    try:
        with open(_config_file, 'w', encoding='utf-8') as f:
            json.dump(config_to_save, f, ensure_ascii=False, indent=2)
    except Exception as e:
        module_interface = _get_module_interface()
        if module_interface:
            module_interface.logger.error(f"保存 AI 配置失败: {e}")


def load_config():
    """加载 AI 配置"""
    global _state

    if not os.path.exists(_config_file):
        # 不自动创建默认服务商，只初始化空结构
        _state["providers"] = {}
        _state["whitelist"] = []
        _state["default_provider"] = None
        _state["usage_stats"] = {
            "total_requests": 0,
            "requests_by_provider": {},
            "requests_by_user": {}
        }
        _state["conversation_timeout"] = 24 * 60 * 60  # 默认 24 小时

        # 创建配置文件
        save_config()
        return

    try:
        with open(_config_file, 'r', encoding='utf-8') as f:
            config = json.load(f)

            # 加载提供商配置
            if "providers" in config:
                _state["providers"] = config["providers"]

            # 加载白名单
            if "whitelist" in config:
                _state["whitelist"] = config["whitelist"]

            # 加载默认提供商
            if "default_provider" in config:
                _state["default_provider"] = config["default_provider"]

            # 加载使用统计
            if "usage_stats" in config:
                _state["usage_stats"] = config["usage_stats"]

            # 加载对话超时设置
            if "conversation_timeout" in config:
                _state["conversation_timeout"] = config["conversation_timeout"]
    except Exception as e:
        module_interface = _get_module_interface()
        if module_interface:
            module_interface.logger.error(f"加载 AI 配置失败: {e}")


def is_super_admin(user_id, context):
    """检查用户是否为超级管理员"""
    try:
        # 使用 config_manager 检查管理员权限
        config_manager = context.bot_data.get("config_manager")
        if config_manager:
            return config_manager.is_admin(user_id)
    except Exception as e:
        module_interface = _get_module_interface()
        if module_interface:
            module_interface.logger.error(f"检查超级管理员权限时出错: {e}")
    return False


def is_whitelisted(user_id):
    """检查用户是否在白名单中"""
    global _state
    return int(user_id) in _state["whitelist"]


def can_use_ai(user_id, chat_type, context):
    """检查用户是否可以使用 AI 功能"""
    # 转换为整数 ID
    user_id = int(user_id)

    # 超级管理员总是可以使用
    config_manager = context.bot_data.get("config_manager")
    if config_manager and config_manager.is_admin(user_id):
        return True

    # 白名单用户可以使用
    if is_whitelisted(user_id):
        return True

    # 其他用户不能使用
    return False


@error_handler
@permission_check(admin_only="super_admin")
async def ai_config_command(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """处理 /aiconfig 命令 - 配置 AI 设置"""
    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 检查是否是私聊
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ 出于安全考虑，AI 配置只能在私聊中进行")
        return

    # 解析参数
    if not context.args:
        # 显示当前配置
        await show_ai_config(update, context)
        return

    # 配置命令格式: /aiconfig <操作> [参数...]
    operation = context.args[0].lower()

    if operation == "provider":
        # 配置服务商: /aiconfig provider <provider_id> <参数> <值>
        if len(context.args) < 4:
            await update.message.reply_text(
                "用法: `/aiconfig provider <provider_id> <参数> <值>`\n"
                "参数可以是: name, api\\_url, api\\_key, model, temperature, system\\_prompt, request\\_format",
                parse_mode="MARKDOWN")
            return

        provider_id = context.args[1]
        param = context.args[2]
        value = " ".join(context.args[3:])

        # 检查服务商是否存在
        if provider_id not in _state[
                "providers"] and provider_id not in PROVIDER_TEMPLATES:
            await update.message.reply_text(f"未知的服务商 ID: `{provider_id}`",
                                            parse_mode="MARKDOWN")
            return

        # 如果是新服务商，从模板创建
        if provider_id not in _state["providers"]:
            if provider_id in PROVIDER_TEMPLATES:
                _state["providers"][provider_id] = PROVIDER_TEMPLATES[
                    provider_id].copy()
            else:
                _state["providers"][provider_id] = PROVIDER_TEMPLATES[
                    "custom"].copy()
                _state["providers"][provider_id]["name"] = provider_id

        # 更新参数
        valid_params = [
            "name", "api_url", "api_key", "model", "temperature",
            "system_prompt", "request_format"
        ]

        if param not in valid_params:
            # 转义参数名称，防止被解释为 Markdown 格式
            valid_params_escaped = [
                p.replace("_", "\\_") for p in valid_params
            ]
            await update.message.reply_text(
                f"无效的参数: `{param}`\n"
                f"有效参数: {', '.join(valid_params_escaped)}",
                parse_mode="MARKDOWN")
            return

        # 特殊处理 temperature (转换为浮点数)
        if param == "temperature":
            try:
                value = float(value)
                if not (0.0 <= value <= 1.0):
                    await update.message.reply_text(
                        "temperature 必须在 0.0 到 1.0 之间")
                    return
            except ValueError:
                await update.message.reply_text("temperature 必须是有效的浮点数")
                return

        # 更新参数
        _state["providers"][provider_id][param] = value

        # 保存配置
        save_config()

        await update.message.reply_text(
            f"✅ 已更新服务商 `{provider_id}` 的 `{param}` 参数", parse_mode="MARKDOWN")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 更新了服务商 {provider_id} 的 {param} 参数")

    elif operation == "default":
        # 设置默认服务商: /aiconfig default <provider_id>
        if len(context.args) < 2:
            await update.message.reply_text(
                "用法: `/aiconfig default <provider_id>`", parse_mode="MARKDOWN")
            return

        provider_id = context.args[1]

        # 检查服务商是否存在
        if provider_id not in _state["providers"]:
            await update.message.reply_text(f"未知的服务商 ID: `{provider_id}`",
                                            parse_mode="MARKDOWN")
            return

        # 更新默认服务商
        _state["default_provider"] = provider_id

        # 保存配置
        save_config()

        await update.message.reply_text(f"✅ 已将默认服务商设置为: `{provider_id}`",
                                        parse_mode="MARKDOWN")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 将默认服务商设置为 {provider_id}")

    elif operation == "delete":
        # 删除服务商: /aiconfig delete <provider_id>
        if len(context.args) < 2:
            await update.message.reply_text(
                "用法: `/aiconfig delete <provider_id>`", parse_mode="MARKDOWN")
            return

        provider_id = context.args[1]

        # 检查服务商是否存在
        if provider_id not in _state["providers"]:
            await update.message.reply_text(f"未知的服务商 ID: `{provider_id}`",
                                            parse_mode="MARKDOWN")
            return

        # 如果删除的是默认服务商，重置默认服务商
        if _state["default_provider"] == provider_id:
            _state["default_provider"] = None

        # 删除服务商
        del _state["providers"][provider_id]

        # 保存配置
        save_config()

        await update.message.reply_text(f"✅ 已删除服务商: `{provider_id}`",
                                        parse_mode="MARKDOWN")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 删除了服务商 {provider_id}")

    elif operation == "new":
        # 创建新服务商: /aiconfig new <provider_id> [template]
        if len(context.args) < 2:
            await update.message.reply_text(
                "用法: `/aiconfig new <provider_id> [template]`\n"
                f"可用模板: {', '.join(PROVIDER_TEMPLATES.keys())}",
                parse_mode="MARKDOWN")
            return

        provider_id = context.args[1]
        template = context.args[2] if len(context.args) > 2 else "custom"

        # 检查服务商 ID 是否已存在
        if provider_id in _state["providers"]:
            await update.message.reply_text(f"服务商 ID 已存在: `{provider_id}`",
                                            parse_mode="MARKDOWN")
            return

        # 检查模板是否存在
        if template not in PROVIDER_TEMPLATES:
            await update.message.reply_text(
                f"未知的模板: `{template}`\n"
                f"可用模板: {', '.join(PROVIDER_TEMPLATES.keys())}",
                parse_mode="MARKDOWN")
            return

        # 创建新服务商
        _state["providers"][provider_id] = PROVIDER_TEMPLATES[template].copy()
        _state["providers"][provider_id]["name"] = provider_id

        # 如果没有默认服务商，设置为默认
        if not _state["default_provider"]:
            _state["default_provider"] = provider_id

        # 保存配置
        save_config()

        await update.message.reply_text(
            f"✅ 已创建新服务商: `{provider_id}` (使用 {template} 模板)\n"
            f"请使用 `/aiconfig provider {provider_id} api_key YOUR_API_KEY` 设置 API 密钥",
            parse_mode="MARKDOWN")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 创建了新服务商 {provider_id}")

    elif operation == "test":
        # 测试服务商: /aiconfig test <provider_id>
        if len(context.args) < 2:
            await update.message.reply_text(
                "用法: `/aiconfig test <provider_id>`", parse_mode="MARKDOWN")
            return

        provider_id = context.args[1]

        # 检查服务商是否存在
        if provider_id not in _state["providers"]:
            await update.message.reply_text(f"未知的服务商 ID: `{provider_id}`",
                                            parse_mode="MARKDOWN")
            return

        # 发送测试消息
        await update.message.reply_text(f"🔄 正在测试服务商 `{provider_id}`...",
                                        parse_mode="MARKDOWN")

        # 准备测试消息
        test_messages = [{
            "role": "user",
            "content": "Hello, can you tell me what time is it?"
        }]

        # 调用 API
        response = await call_ai_api(provider_id, test_messages,
                                     module_interface)

        # 显示响应 - 使用 HTML 渲染
        try:
            # 使用 HTML 格式发送响应
            html_response = TextUtils.markdown_to_html(
                f"📝 测试结果:\n\n{response}")
            await update.message.reply_text(html_response, parse_mode="HTML")
        except Exception as e:
            module_interface.logger.error(f"HTML 渲染测试结果失败: {e}")
            # 回退到纯文本
            await update.message.reply_text(f"📝 测试结果:\n\n{response}")

        module_interface.logger.info(
            f"用户 {update.effective_user.id} 测试了服务商 {provider_id}")

    elif operation == "stats":
        # 查看使用统计: /aiconfig stats
        await show_ai_stats(update, context)

    elif operation == "timeout":
        # 设置对话超时时间: /aiconfig timeout <小时数>
        if len(context.args) < 2:
            await update.message.reply_text(
                "用法: `/aiconfig timeout <小时数>`\n"
                "当前超时时间: " +
                str(_state.get("conversation_timeout", 24 * 60 * 60) // 3600) +
                " 小时",
                parse_mode="MARKDOWN")
            return

        try:
            hours = float(context.args[1])
            if hours <= 0:
                await update.message.reply_text("超时时间必须大于 0 小时")
                return

            # 更新超时时间 (转换为秒)
            _state["conversation_timeout"] = int(hours * 3600)

            # 保存配置
            save_config()

            await update.message.reply_text(f"✅ 已将对话超时时间设置为 {hours} 小时")
            module_interface.logger.info(
                f"用户 {update.effective_user.id} 将对话超时时间设置为 {hours} 小时")
        except ValueError:
            await update.message.reply_text("小时数必须是有效的数字")

    else:
        # 未知操作
        await update.message.reply_text(
            f"未知操作: `{operation}`\n"
            "可用操作: provider, default, delete, new, test, stats, timeout",
            parse_mode="MARKDOWN")


async def show_ai_config(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示当前 AI 配置"""
    global _state

    # 构建配置信息
    config_text = "🤖 *AI 配置面板*\n\n"

    # 默认服务商
    default_provider = _state["default_provider"]
    if default_provider and default_provider in _state["providers"]:
        provider_name = _state["providers"][default_provider].get(
            "name", default_provider)
        config_text += f"*当前默认服务商:* `{TextUtils.escape_markdown(default_provider)}` ({TextUtils.escape_markdown(provider_name)})\n\n"
    else:
        config_text += f"*当前默认服务商:* _未设置_\n\n"

    # 对话超时设置
    timeout_hours = _state.get("conversation_timeout", 24 * 60 * 60) // 3600
    config_text += f"*对话超时时间:* `{timeout_hours}` 小时\n\n"

    # 服务商列表
    config_text += "*已配置的服务商:*\n"

    if not _state["providers"]:
        config_text += "_暂无服务商配置，请使用_ `/aiconfig new` _创建服务商_\n"
    else:
        # 检查是否有完全配置的服务商（有 API 密钥的）
        configured_providers = [
            p for p, data in _state["providers"].items() if data.get("api_key")
        ]

        if not configured_providers:
            config_text += "_已创建服务商，但尚未配置 API 密钥。请使用_ `/aiconfig provider <ID> api_key YOUR_KEY` _配置_\n\n"

        # 显示所有服务商
        for provider_id, provider in _state["providers"].items():
            # 标记默认服务商和配置状态
            is_default = "✅ " if provider_id == default_provider else ""
            is_configured = "🔑 " if provider.get("api_key") else "⚠️ "

            config_text += f"\n{is_default}{is_configured}*{TextUtils.escape_markdown(provider_id)}*\n"
            config_text += f"  📝 名称: `{TextUtils.escape_markdown(provider.get('name', provider_id))}`\n"
            config_text += f"  🤖 模型: `{TextUtils.escape_markdown(provider.get('model', '未设置'))}`\n"

            # API URL (可能很长，截断显示)
            api_url = provider.get('api_url', '未设置')
            if len(api_url) > 30:
                api_url = api_url[:27] + "..."
            config_text += f"  🔗 API URL: `{TextUtils.escape_markdown(api_url)}`\n"

            # API Key (隐藏显示)
            api_key = provider.get('api_key', '')
            if api_key:
                masked_key = f"{api_key[:4]}...{api_key[-4:]}" if len(
                    api_key) > 8 else "****"
                config_text += f"  🔑 API Key: `{TextUtils.escape_markdown(masked_key)}`\n"
            else:
                config_text += "  🔑 API Key: `未设置` ⚠️\n"

            config_text += f"  🌡️ 温度: `{provider.get('temperature', 0.7)}`\n"

            # 系统提示 (可能很长，截断显示)
            system_prompt = provider.get('system_prompt', '未设置')
            if len(system_prompt) > 30:
                system_prompt = system_prompt[:27] + "..."
            config_text += f"  💬 系统提示: `{TextUtils.escape_markdown(system_prompt)}`\n"

            config_text += f"  📋 请求格式: `{TextUtils.escape_markdown(provider.get('request_format', 'openai'))}`\n"

    # 添加使用说明
    config_text += "\n*📚 配置命令:*\n"
    config_text += "• `/aiconfig provider <ID> <参数> <值>` - 配置服务商参数\n"
    config_text += "• `/aiconfig new <ID> [模板]` - 创建新服务商\n"
    config_text += "• `/aiconfig default <ID>` - 设置默认服务商\n"
    config_text += "• `/aiconfig delete <ID>` - 删除服务商\n"
    config_text += "• `/aiconfig test <ID>` - 测试服务商\n"
    config_text += "• `/aiconfig stats` - 查看使用统计\n"
    config_text += "• `/aiconfig timeout <小时数>` - 设置对话超时时间\n"

    try:
        await update.message.reply_text(config_text, parse_mode="MARKDOWN")
    except Exception as e:
        # 如果发送失败（可能是 Markdown 格式问题），尝试发送纯文本
        module_interface = context.bot_data[
            "bot_engine"].module_loader.get_module_interface(MODULE_NAME)
        module_interface.logger.error(f"发送 AI 配置信息失败: {e}")
        plain_text = TextUtils.markdown_to_plain(config_text)
        await update.message.reply_text(plain_text)


async def show_ai_stats(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示 AI 使用统计"""
    global _state

    stats = _state["usage_stats"]

    stats_text = "📊 *AI 使用统计*\n\n"

    # 总请求数
    stats_text += f"*总请求数:* `{stats.get('total_requests', 0)}`\n\n"

    # 按服务商统计
    stats_text += "*按服务商统计:*\n"
    if not stats.get('requests_by_provider'):
        stats_text += "_暂无数据_\n"
    else:
        for provider, count in stats.get('requests_by_provider', {}).items():
            provider_name = _state["providers"].get(provider, {}).get(
                "name",
                provider) if provider in _state["providers"] else provider
            stats_text += f"• `{TextUtils.escape_markdown(provider)}` ({TextUtils.escape_markdown(provider_name)}): `{count}`\n"

    # 按用户统计 (仅显示前10位活跃用户)
    stats_text += "\n*按用户统计 (前10位):*\n"
    if not stats.get('requests_by_user'):
        stats_text += "_暂无数据_\n"
    else:
        # 按使用量排序
        sorted_users = sorted(stats.get('requests_by_user', {}).items(),
                              key=lambda x: x[1],
                              reverse=True)[:10]

        for user_id, count in sorted_users:
            stats_text += f"• 用户 `{user_id}`: `{count}` 次请求\n"

    try:
        await update.message.reply_text(stats_text, parse_mode="MARKDOWN")
    except Exception as e:
        module_interface = context.bot_data[
            "bot_engine"].module_loader.get_module_interface(MODULE_NAME)
        module_interface.logger.error(f"发送 AI 统计信息失败: {e}")
        plain_text = TextUtils.markdown_to_plain(stats_text)
        await update.message.reply_text(plain_text)


@error_handler
@permission_check(admin_only="super_admin")
async def ai_whitelist_command(update: Update,
                               context: ContextTypes.DEFAULT_TYPE):
    """处理 /aiwhitelist 命令 - 管理 AI 白名单"""
    global _state

    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    if not context.args:
        # 显示当前白名单
        await show_ai_whitelist(update, context)
        return

    # 解析命令: /aiwhitelist <操作> <用户ID>
    operation = context.args[0].lower()

    if operation == "add":
        # 添加用户到白名单
        if len(context.args) < 2 and not update.message.reply_to_message:
            await update.message.reply_text(
                "用法: `/aiwhitelist add <用户ID>`\n或回复某人的消息添加他们",
                parse_mode="MARKDOWN")
            return

        # 检查是否是回复某人的消息
        if update.message.reply_to_message and update.message.reply_to_message.from_user:
            user_id = update.message.reply_to_message.from_user.id
            username = update.message.reply_to_message.from_user.username or "未知用户名"
            full_name = update.message.reply_to_message.from_user.full_name or "未知姓名"
        else:
            # 从参数获取用户 ID
            try:
                user_id = int(context.args[1])
                username = "未知用户名"
                full_name = "未知姓名"
            except ValueError:
                await update.message.reply_text("用户 ID 必须是数字")
                return

        # 检查用户是否已在白名单中
        if user_id in _state["whitelist"]:
            escaped_username = TextUtils.escape_markdown(username)
            await update.message.reply_text(
                f"用户 `{user_id}` (@{escaped_username}) 已在白名单中",
                parse_mode="MARKDOWN")
            return

        # 添加到白名单
        _state["whitelist"].append(user_id)

        # 保存配置
        save_config()

        # 使用 TextUtils 转义用户名和全名中的特殊字符
        escaped_username = TextUtils.escape_markdown(username)
        escaped_full_name = TextUtils.escape_markdown(full_name)

        await update.message.reply_text(
            f"✅ 已将用户 `{user_id}` (@{escaped_username}, {escaped_full_name}) 添加到白名单",
            parse_mode="MARKDOWN")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 将用户 {user_id} 添加到 AI 白名单")

    elif operation == "remove":
        # 从白名单中移除用户
        if len(context.args) < 2:
            await update.message.reply_text("用法: `/aiwhitelist remove <用户ID>`",
                                            parse_mode="MARKDOWN")
            return

        try:
            user_id = int(context.args[1])

            # 检查用户是否在白名单中
            if user_id not in _state["whitelist"]:
                await update.message.reply_text(f"用户 `{user_id}` 不在白名单中",
                                                parse_mode="MARKDOWN")
                return

            # 从白名单中移除
            _state["whitelist"].remove(user_id)

            # 保存配置
            save_config()

            await update.message.reply_text(f"✅ 已将用户 `{user_id}` 从白名单中移除",
                                            parse_mode="MARKDOWN")
            module_interface.logger.info(
                f"用户 {update.effective_user.id} 将用户 {user_id} 从 AI 白名单中移除")
        except ValueError:
            await update.message.reply_text("用户 ID 必须是数字")

    elif operation == "clear":
        # 清空白名单
        _state["whitelist"] = []

        # 保存配置
        save_config()

        await update.message.reply_text("✅ 已清空 AI 白名单")
        module_interface.logger.info(
            f"用户 {update.effective_user.id} 清空了 AI 白名单")

    else:
        # 未知操作
        await update.message.reply_text(
            f"未知操作: `{operation}`\n"
            "可用操作: add, remove, clear",
            parse_mode="MARKDOWN")


async def show_ai_whitelist(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """显示当前 AI 白名单"""
    global _state

    whitelist_text = "👥 *AI 白名单用户*\n\n"

    if not _state["whitelist"]:
        whitelist_text += "_白名单为空_\n"
    else:
        for i, user_id in enumerate(_state["whitelist"], 1):
            whitelist_text += f"{i}. `{user_id}`\n"

    whitelist_text += "\n*📚 白名单管理命令:*\n"
    whitelist_text += "• `/aiwhitelist add <用户ID>` - 添加用户到白名单\n"
    whitelist_text += "• `/aiwhitelist remove <用户ID>` - 从白名单中移除用户\n"
    whitelist_text += "• `/aiwhitelist clear` - 清空白名单\n"
    whitelist_text += "\n💡 提示：回复用户消息并使用 `/aiwhitelist add` 可快速添加该用户\n"

    try:
        await update.message.reply_text(whitelist_text, parse_mode="MARKDOWN")
    except Exception as e:
        # 如果发送失败，尝试发送纯文本
        module_interface = context.bot_data[
            "bot_engine"].module_loader.get_module_interface(MODULE_NAME)
        module_interface.logger.error(f"发送 AI 白名单信息失败: {e}")
        plain_text = TextUtils.markdown_to_plain(whitelist_text)
        await update.message.reply_text(plain_text)


@error_handler
@module_check
async def ai_clear_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /aiclear 命令 - 清除对话上下文"""
    user_id = update.effective_user.id

    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 检查权限
    if not can_use_ai(user_id, update.effective_chat.type, context):
        await update.message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        module_interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 清除上下文
    if clear_user_context(user_id):
        await update.message.reply_text("✅ 已清除您的对话历史")
        module_interface.logger.info(f"用户 {user_id} 清除了对话历史")
    else:
        await update.message.reply_text("您还没有任何对话历史")


@error_handler
@module_check
async def ai_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /ai 命令 - 向 AI 发送消息"""
    user_id = update.effective_user.id

    # 获取模块接口
    module_interface = context.bot_data[
        "bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 检查权限
    if not can_use_ai(user_id, update.effective_chat.type, context):
        await update.message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        module_interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 检查是否有消息内容
    if not context.args:
        await update.message.reply_text(
            "请输入要发送给 AI 的消息\n"
            "例如: `/ai 你好，请介绍一下自己`\n\n"
            "🔄 使用 `/aiclear` 可清除对话历史",
            parse_mode="MARKDOWN")
        return

    # 获取消息内容
    message_text = " ".join(context.args)

    # 检查消息长度
    if len(message_text) > MAX_MESSAGE_LENGTH:
        await update.message.reply_text(
            f"⚠️ 消息太长，请将长度控制在 {MAX_MESSAGE_LENGTH} 字符以内")
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await update.message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        module_interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🤔 正在思考中...")

    # 添加用户消息到上下文
    add_message_to_context(user_id, "user", message_text)

    # 准备 API 请求
    messages = format_context_for_api(provider_id, user_id)

    # 创建流式更新回调函数
    async def update_message_callback(text):
        try:
            # 确保文本不为空
            if not text.strip():
                return

            # 存储上一次更新的文本，避免重复更新
            if not hasattr(update_message_callback, 'last_text'):
                update_message_callback.last_text = ""

            # 如果文本与上次相同，不更新
            if text == update_message_callback.last_text:
                return

            # 流式更新时使用纯文本
            if len(text) <= MAX_MESSAGE_LENGTH:
                await thinking_message.edit_text(text)
            else:
                # 如果消息超长，只更新最后部分
                await thinking_message.edit_text(text[-MAX_MESSAGE_LENGTH:])

            # 更新上次文本
            update_message_callback.last_text = text
        except Exception as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                module_interface.logger.error(f"更新消息失败: {e}")

    # 调用流式 AI API
    response = await call_ai_api_stream(provider_id, messages,
                                        module_interface,
                                        update_message_callback)

    # 添加 AI 回复到上下文
    add_message_to_context(user_id, "assistant", response)

    # 处理最终响应 - 使用 HTML 格式
    try:
        # 删除"思考中"消息
        await thinking_message.delete()

        # 使用 HTML 格式发送响应
        await TextUtils.send_long_message_html(update, response,
                                               module_interface)
    except Exception as e:
        module_interface.logger.error(f"处理最终响应失败: {e}")
        # 直接发送纯文本
        try:
            # 分段发送纯文本
            MAX_PLAIN_LENGTH = 4000

            if len(response) <= MAX_PLAIN_LENGTH:
                await update.message.reply_text(response)
            else:
                # 分段发送
                parts = []
                for i in range(0, len(response), MAX_PLAIN_LENGTH):
                    parts.append(response[i:i + MAX_PLAIN_LENGTH])

                module_interface.logger.info(f"消息过长，将分为 {len(parts)} 段纯文本发送")

                # 发送第一段
                first_message = await update.message.reply_text(parts[0])

                # 发送剩余段落
                for part in parts[1:]:
                    await first_message.reply_text(part)

        except Exception as inner_e:
            module_interface.logger.error(f"发送纯文本也失败: {inner_e}")
            # 最后的回退：发送一个简单的错误消息
            await update.message.reply_text("生成回复时出错，请重试")

    module_interface.logger.info(
        f"用户 {user_id} 使用 {provider_id} 服务商获得了 AI 流式回复")


@error_handler
async def handle_private_message(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE):
    """处理私聊消息，直接回复 AI 回答"""
    # 如果是命令，忽略
    if update.message.text.startswith('/'):
        return

    # 检查模块是否启用
    bot_engine = context.bot_data.get("bot_engine")
    config_manager = context.bot_data.get("config_manager")
    chat_id = update.effective_chat.id

    # 手动检查模块是否为当前聊天启用
    if not config_manager.is_module_enabled_for_chat(MODULE_NAME, chat_id):
        return

    user_id = update.effective_user.id

    # 获取模块接口
    module_interface = bot_engine.module_loader.get_module_interface(
        MODULE_NAME)

    # 检查权限
    if not can_use_ai(user_id, "private", context):
        # 不回复非白名单用户
        return

    # 获取消息内容
    message_text = update.message.text

    # 检查消息长度
    if len(message_text) > MAX_MESSAGE_LENGTH:
        await update.message.reply_text(
            f"⚠️ 消息太长，请将长度控制在 {MAX_MESSAGE_LENGTH} 字符以内")
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await update.message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        module_interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🤔 正在思考中...")

    # 添加用户消息到上下文
    add_message_to_context(user_id, "user", message_text)

    # 准备 API 请求
    messages = format_context_for_api(provider_id, user_id)

    # 创建流式更新回调函数
    async def update_message_callback(text):
        try:
            # 确保文本不为空
            if not text.strip():
                return

            # 存储上一次更新的文本，避免重复更新
            if not hasattr(update_message_callback, 'last_text'):
                update_message_callback.last_text = ""

            # 如果文本与上次相同，不更新
            if text == update_message_callback.last_text:
                return

            # 流式更新时使用纯文本
            if len(text) <= MAX_MESSAGE_LENGTH:
                await thinking_message.edit_text(text)
            else:
                # 如果消息超长，只更新最后部分
                await thinking_message.edit_text(text[-MAX_MESSAGE_LENGTH:])

            # 更新上次文本
            update_message_callback.last_text = text
        except Exception as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                module_interface.logger.error(f"更新消息失败: {e}")

    # 调用流式 AI API
    response = await call_ai_api_stream(provider_id, messages,
                                        module_interface,
                                        update_message_callback)

    # 添加 AI 回复到上下文
    add_message_to_context(user_id, "assistant", response)

    # 处理最终响应 - 使用 HTML 格式
    try:
        # 删除"思考中"消息
        await thinking_message.delete()

        # 使用 HTML 格式发送响应
        await TextUtils.send_long_message_html(update, response,
                                               module_interface)
    except Exception as e:
        module_interface.logger.error(f"处理最终响应失败: {e}")
        # 直接发送纯文本
        try:
            # 分段发送纯文本
            MAX_PLAIN_LENGTH = 4000

            if len(response) <= MAX_PLAIN_LENGTH:
                await update.message.reply_text(response)
            else:
                # 分段发送
                parts = []
                for i in range(0, len(response), MAX_PLAIN_LENGTH):
                    parts.append(response[i:i + MAX_PLAIN_LENGTH])

                module_interface.logger.info(f"消息过长，将分为 {len(parts)} 段纯文本发送")

                # 发送第一段
                first_message = await update.message.reply_text(parts[0])

                # 发送剩余段落
                for part in parts[1:]:
                    await first_message.reply_text(part)

        except Exception as inner_e:
            module_interface.logger.error(f"发送纯文本也失败: {inner_e}")
            # 最后的回退：发送一个简单的错误消息
            await update.message.reply_text("生成回复时出错，请重试")

    module_interface.logger.info(f"用户 {user_id} 在私聊中获得了 AI 流式回复")


# 获取模块状态的方法（用于热更新）
def get_state(module_interface):
    """获取模块状态（用于热更新）"""
    module_interface.logger.debug("正在获取 AI 模块状态用于热更新")
    return _state


# 设置模块状态的方法（用于热更新）
def set_state(module_interface, state):
    """设置模块状态（用于热更新）"""
    global _state

    # 确保状态中包含所有必要的字段
    state.setdefault("providers", {})
    state.setdefault("whitelist", [])
    state.setdefault("conversations", {})
    state.setdefault("default_provider", None)
    state.setdefault("last_save_time", time.time())
    state.setdefault("usage_stats", {
        "total_requests": 0,
        "requests_by_provider": {},
        "requests_by_user": {}
    })
    state.setdefault("conversation_timeout", 24 * 60 * 60)  # 默认 24 小时

    _state = state
    module_interface.logger.debug("已恢复 AI 模块状态")


def setup(module_interface):
    """模块初始化"""
    global _state, re

    # 确保导入了 re 模块
    if 're' not in globals():
        import re

    # 初始化状态
    _state = {
        "providers": {},
        "whitelist": [],
        "conversations": {},
        "default_provider": None,
        "last_save_time": time.time(),
        "usage_stats": {
            "total_requests": 0,
            "requests_by_provider": {},
            "requests_by_user": {}
        },
        "conversation_timeout": 24 * 60 * 60  # 默认 24 小时
    }

    # 从持久化存储加载状态
    saved_state = module_interface.load_state(default={})
    if saved_state:
        set_state(module_interface, saved_state)
    else:
        # 如果没有保存的状态，加载配置文件
        load_config()
        load_contexts()

    # 注册命令
    module_interface.register_command("aiconfig",
                                      ai_config_command,
                                      admin_only="super_admin")
    module_interface.register_command("aiwhitelist",
                                      ai_whitelist_command,
                                      admin_only="super_admin")
    module_interface.register_command("aiclear", ai_clear_command)
    module_interface.register_command("ai", ai_command)

    # 注册私聊消息处理器
    private_handler = MessageHandler(
        filters.TEXT & filters.ChatType.PRIVATE & ~filters.COMMAND,
        handle_private_message)
    module_interface.register_handler(private_handler)

    # 设置定期任务
    async def _periodic_tasks():
        while True:
            try:
                # 每小时检查一次过期对话
                await asyncio.sleep(3600)
                expired_count = cleanup_expired_conversations()
                if expired_count > 0:
                    module_interface.logger.info(f"已清理 {expired_count} 个过期对话")

                # 保存状态
                module_interface.save_state(_state)
                module_interface.logger.debug("已定期保存 AI 模块状态")
            except Exception as e:
                module_interface.logger.error(f"定期任务执行失败: {e}")

    # 启动定期任务
    module_interface.periodic_task = asyncio.create_task(_periodic_tasks())

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


def cleanup(module_interface):
    """模块清理"""
    # 取消定期任务
    if hasattr(module_interface,
               'periodic_task') and module_interface.periodic_task:
        module_interface.periodic_task.cancel()

    # 保存状态
    module_interface.save_state(_state)

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
