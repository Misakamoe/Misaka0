# modules/ai.py - AI 聊天助手

import os
import json
import time
import asyncio
import aiohttp
import base64
import telegram
import re
from typing import Dict, List, Optional, Any, Tuple, Callable, Union
from utils.formatter import TextFormatter
from telegram import Update, File, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "ai"
MODULE_VERSION = "3.1.1"
MODULE_DESCRIPTION = "支持多种 AI 的聊天助手"
MODULE_COMMANDS = ["ai", "aiconfig", "aiclear", "aiwhitelist"]
MODULE_CHAT_TYPES = ["private", "group"]  # 支持私聊和群组

# 按钮回调前缀
CALLBACK_PREFIX = "ai_cfg"

# 模块接口引用
_interface = None

# 配置文件路径
CONFIG_FILE = "config/ai_config.json"  # 配置文件（API keys、服务商配置等）

# 常量定义
MAX_CONTEXT_LENGTH = 15  # 上下文最大消息对数
REQUEST_TIMEOUT = 60  # API 请求超时时间（秒）
MAX_MESSAGE_LENGTH = 4000  # Telegram 最大消息长度
MIN_UPDATE_INTERVAL = 1.5  # 最小流式更新间隔（秒）
MAX_CONCURRENT_REQUESTS = 5  # 最大并发请求数

# 服务商模板
PROVIDER_TEMPLATES = {
    "openai": {
        "name": "OpenAI",
        "api_url": "https://api.openai.com/v1/chat/completions",
        "api_key": "",
        "model": "gpt-4o",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai",
        "supports_image": True
    },
    "gemini": {
        "name": "Gemini",
        "api_url":
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
        "api_key": "",
        "model": "gemini-2.0-flash",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai",  # 使用 OpenAI 兼容模式
        "supports_image": True
    },
    "xai": {
        "name": "Grok",
        "api_url": "https://api.x.ai/v1/chat/completions",
        "api_key": "",
        "model": "grok-3-beta",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai",  # 使用 OpenAI 兼容模式
        "supports_image": True
    },
    "anthropic": {
        "name": "Claude",
        "api_url": "https://api.anthropic.com/v1/messages",
        "api_key": "",
        "model": "claude-3-7-sonnet-latest",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "anthropic",
        "supports_image": True
    },
    "custom": {
        "name": "Custom",
        "api_url": "",
        "api_key": "",
        "model": "",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai",
        "supports_image": True
    }
}

# 模块状态
_state = {
    "providers": {},  # 服务商配置
    "whitelist": {},  # 白名单用户 ID -> 用户信息
    "conversations": {},  # 用户对话上下文
    "default_provider": None,  # 默认服务商
    "usage_stats": {  # 使用统计
        "total_requests": 0,
        "requests_by_provider": {},
        "requests_by_user": {}
    },
    "conversation_timeout": 24 * 60 * 60,  # 默认 24 小时超时
    "concurrent_requests": 0,  # 当前并发请求数
    "request_lock": None  # 请求锁（运行时初始化）
}


class AIServiceProvider:
    """AI 服务提供商抽象基类"""

    @staticmethod
    async def format_request(provider: Dict[str, Any],
                             messages: List[Dict[str, str]],
                             images: Optional[List[Dict[str, Any]]] = None,
                             stream: bool = False) -> Dict[str, Any]:
        """格式化 API 请求

        Args:
            provider: 服务商配置
            messages: 消息列表
            images: 图像列表 (可选)
            stream: 是否使用流式请求

        Returns:
            Dict: 格式化的请求数据
        """
        request_format = provider.get("request_format", "openai")

        if request_format == "openai":
            return OpenAIProvider.format_request(provider, messages, images,
                                                 stream)
        elif request_format == "anthropic":
            return AnthropicProvider.format_request(provider, messages, images,
                                                    stream)
        else:
            raise ValueError(f"不支持的请求格式: {request_format}")

    @staticmethod
    async def parse_response(provider: Dict[str, Any],
                             response_data: Dict[str, Any]) -> str:
        """解析 API 响应

        Args:
            provider: 服务商配置
            response_data: API 响应数据

        Returns:
            str: 解析后的文本响应
        """
        request_format = provider.get("request_format", "openai")

        if request_format == "openai":
            return OpenAIProvider.parse_response(response_data)
        elif request_format == "anthropic":
            return AnthropicProvider.parse_response(response_data)
        else:
            raise ValueError(f"不支持的响应格式: {request_format}")

    @staticmethod
    async def prepare_api_request(
            provider: Dict[str, Any],
            request_data: Dict[str, Any]) -> Tuple[str, Dict[str, str]]:
        """准备 API 请求 URL 和头信息

        Args:
            provider: 服务商配置
            request_data: 请求数据

        Returns:
            Tuple[str, Dict[str, str]]: API URL 和请求头
        """
        request_format = provider.get("request_format", "openai")

        # 准备 API URL
        api_url = provider["api_url"]

        # 准备请求头
        headers = {"Content-Type": "application/json"}

        # 不同服务商的认证方式
        if request_format == "openai":
            headers["Authorization"] = f"Bearer {provider['api_key']}"
        elif request_format == "anthropic":
            headers["x-api-key"] = provider["api_key"]
            headers["anthropic-version"] = "2023-06-01"

        return api_url, headers


class OpenAIProvider:
    """OpenAI 服务提供商实现"""

    @staticmethod
    def format_request(provider: Dict[str, Any],
                       messages: List[Dict[str, str]],
                       images: Optional[List[Dict[str, Any]]] = None,
                       stream: bool = False) -> Dict[str, Any]:
        """格式化 OpenAI 请求"""
        # 如果有图像且模型支持图像
        if images and provider.get("model", "").startswith(
            ("gpt-4-vision", "gpt-4o")):
            # 构建包含图像的消息
            vision_messages = []

            for msg in messages:
                if msg["role"] == "user" and images:
                    # 为用户消息添加图像
                    content = [{"type": "text", "text": msg["content"]}]

                    # 添加图像
                    for img in images:
                        content.append({
                            "type": "image_url",
                            "image_url": {
                                "url": f"data:image/jpeg;base64,{img['data']}",
                                "detail": "high"
                            }
                        })

                    vision_messages.append({
                        "role": msg["role"],
                        "content": content
                    })
                else:
                    # 保持其他消息不变
                    vision_messages.append(msg)

            return {
                "model": provider["model"],
                "messages": vision_messages,
                "temperature": provider["temperature"],
                "stream": stream,
                "max_tokens": 4096
            }
        else:
            # 标准文本请求
            return {
                "model": provider["model"],
                "messages": messages,
                "temperature": provider["temperature"],
                "stream": stream,
                "max_tokens": 4096
            }

    @staticmethod
    def parse_response(response_data: Dict[str, Any]) -> str:
        """解析 OpenAI 响应"""
        try:
            return response_data["choices"][0]["message"]["content"]
        except (KeyError, IndexError) as e:
            _interface.logger.error(f"解析 OpenAI 响应失败: {e}")
            return None

    @staticmethod
    async def process_stream(line: bytes, callback: Callable[[str], None],
                             full_response: str) -> str:
        """处理 OpenAI 流式响应"""
        if not line or line == b'data: [DONE]':
            return full_response

        try:
            # 移除 "data: " 前缀并解析 JSON
            if line.startswith(b'data: '):
                json_data = json.loads(line[6:])

                if 'choices' in json_data and json_data['choices']:
                    delta = json_data['choices'][0].get('delta', {})
                    if 'content' in delta and delta['content']:
                        content = delta['content']
                        full_response += content

                        # 只有当有实际内容时才调用回调
                        if full_response.strip():
                            await callback(full_response)
        except Exception as e:
            _interface.logger.error(f"解析 OpenAI 流式响应失败: {e}")

        return full_response


# 注意: 我们现在使用 OpenAI 兼容模式，不再需要单独的 GeminiProvider 类


class AnthropicProvider:
    """Anthropic Claude 服务提供商实现"""

    @staticmethod
    def format_request(provider: Dict[str, Any],
                       messages: List[Dict[str, str]],
                       images: Optional[List[Dict[str, Any]]] = None,
                       stream: bool = False) -> Dict[str, Any]:
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
                # 处理用户消息，可能包含图像
                if images and msg == messages[-1]:
                    # 构建包含图像的内容
                    content = [{"type": "text", "text": msg["content"]}]

                    # 添加图像
                    for img in images:
                        content.append({
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/jpeg",
                                "data": img["data"]
                            }
                        })

                    anthropic_messages.append({
                        "role": "user",
                        "content": content
                    })
                else:
                    # 普通文本消息
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
            "max_tokens": 4000,
            "stream": stream
        }

        # 添加系统提示 (如果有)
        if system:
            request["system"] = system

        return request

    @staticmethod
    def parse_response(response_data: Dict[str, Any]) -> str:
        """解析 Anthropic 响应"""
        try:
            if isinstance(response_data.get("content"), list):
                text_blocks = [
                    block["text"] for block in response_data["content"]
                    if block["type"] == "text"
                ]
                return "".join(text_blocks)
            return None
        except (KeyError, IndexError) as e:
            _interface.logger.error(f"解析 Anthropic 响应失败: {e}")
            return None

    @staticmethod
    async def process_stream(line: bytes, callback: Callable[[str], None],
                             full_response: str) -> str:
        """处理 Anthropic 流式响应"""
        if not line or line == b'data: [DONE]':
            return full_response

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

                        # 只有当有实际内容时才调用回调
                        if full_response.strip():
                            await callback(full_response)
        except Exception as e:
            _interface.logger.error(f"解析 Anthropic 流式响应失败: {e}")

        return full_response


class ConversationManager:
    """用户对话管理"""

    @staticmethod
    def get_user_context(user_id: Union[int, str]) -> List[Dict[str, Any]]:
        """获取用户对话上下文

        Args:
            user_id: 用户 ID

        Returns:
            List[Dict]: 用户对话上下文
        """
        global _state
        user_id_str = str(user_id)

        if user_id_str not in _state["conversations"]:
            # 初始化新用户的上下文
            _state["conversations"][user_id_str] = []

        return _state["conversations"][user_id_str]

    @staticmethod
    def add_message(user_id: Union[int, str], role: str,
                    content: str) -> List[Dict[str, Any]]:
        """添加消息到用户上下文

        Args:
            user_id: 用户 ID
            role: 消息角色 (user, assistant, system)
            content: 消息内容

        Returns:
            List[Dict]: 更新后的用户上下文
        """
        global _state
        user_id_str = str(user_id)
        context = ConversationManager.get_user_context(user_id_str)

        # 添加新消息
        context.append({
            "role": role,
            "content": content,
            "timestamp": time.time()
        })

        # 限制上下文长度
        if len(context) > MAX_CONTEXT_LENGTH * 2:  # 成对限制 (用户 + 助手)
            # 保留系统消息 (如果有) 和最近的消息
            system_messages = [
                msg for msg in context if msg["role"] == "system"
            ]
            recent_messages = context[-MAX_CONTEXT_LENGTH * 2:]
            context = system_messages + recent_messages
            _state["conversations"][user_id_str] = context

        # 更新用户统计
        if role == "user":
            _state["usage_stats"]["requests_by_user"][user_id_str] = \
                _state["usage_stats"]["requests_by_user"].get(user_id_str, 0) + 1

        # 保存上下文
        save_contexts()

        return context

    @staticmethod
    def clear_context(user_id: Union[int, str]) -> bool:
        """清除用户对话上下文，保留系统提示

        Args:
            user_id: 用户 ID

        Returns:
            bool: 是否成功清除
        """
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

    @staticmethod
    def cleanup_expired() -> int:
        """清理过期的对话

        Returns:
            int: 清理的对话数量
        """
        global _state
        now = time.time()
        timeout = _state.get("conversation_timeout", 24 * 60 * 60)  # 默认 24 小时
        expired_count = 0

        # 如果设置为永不超时，直接返回
        if timeout == float('inf'):
            return 0

        for user_id, context in list(_state["conversations"].items()):
            if not context:
                continue

            # 获取最后一条消息的时间
            last_message_time = max(
                [msg.get("timestamp", 0) for msg in context]) if context else 0

            # 如果超过超时时间，清除对话（保留系统消息）
            if now - last_message_time > timeout:
                system_messages = [
                    msg for msg in context if msg["role"] == "system"
                ]
                _state["conversations"][user_id] = system_messages
                expired_count += 1

        return expired_count

    @staticmethod
    def format_for_api(provider_id: str,
                       user_id: Union[int, str]) -> List[Dict[str, str]]:
        """格式化用户上下文为 API 请求格式

        Args:
            provider_id: 服务商 ID
            user_id: 用户 ID

        Returns:
            List[Dict]: 格式化的消息列表
        """
        global _state

        provider_data = _state["providers"].get(provider_id)
        if not provider_data:
            return []

        # 获取用户上下文
        context = ConversationManager.get_user_context(user_id)

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
                messages.append({
                    "role": msg["role"],
                    "content": msg["content"]
                })

        return messages


class AIManager:
    """AI 功能管理类"""

    @staticmethod
    async def call_ai_api(
            provider_id: str,
            messages: List[Dict[str, str]],
            images: Optional[List[Dict[str, Any]]] = None,
            stream: bool = False,
            update_callback: Optional[Callable[[str], Any]] = None) -> str:
        """调用 AI API

        Args:
            provider_id: 服务商 ID
            messages: 消息列表
            images: 图像列表 (可选)
            stream: 是否使用流式模式
            update_callback: 流式更新回调函数

        Returns:
            str: API 响应文本
        """
        global _state

        # 检查并初始化请求锁
        if _state["request_lock"] is None:
            _state["request_lock"] = asyncio.Lock()

        # 检查并发请求数
        async with _state["request_lock"]:
            if _state["concurrent_requests"] >= MAX_CONCURRENT_REQUESTS:
                return "⚠️ 系统正在处理过多请求，请稍后再试"

            _state["concurrent_requests"] += 1

        try:
            # 检查服务商
            if provider_id not in _state["providers"]:
                return "错误：未找到指定的服务商配置"

            provider = _state["providers"][provider_id]

            # 检查 API 密钥
            if not provider.get("api_key"):
                return "错误：未配置 API 密钥"

            # 准备请求数据
            try:
                request_data = await AIServiceProvider.format_request(
                    provider, messages, images, stream)
            except Exception as e:
                _interface.logger.error(f"格式化请求失败: {e}")
                return f"格式化请求失败: {str(e)}"

            # 准备 API 请求
            try:
                api_url, headers = await AIServiceProvider.prepare_api_request(
                    provider, request_data)
            except Exception as e:
                _interface.logger.error(f"准备 API 请求失败: {e}")
                return f"准备 API 请求失败: {str(e)}"

            # 创建一个任务来处理 API 请求，这样不会阻塞其他操作
            if stream and update_callback:
                # 流式模式
                api_task = asyncio.create_task(
                    AIManager._stream_request(provider, api_url, headers,
                                              request_data, update_callback,
                                              provider_id))
            else:
                # 非流式模式
                api_task = asyncio.create_task(
                    AIManager._standard_request(provider, api_url, headers,
                                                request_data, provider_id))

            # 等待任务完成并获取结果
            return await api_task

        finally:
            # 减少并发请求计数
            async with _state["request_lock"]:
                _state["concurrent_requests"] -= 1

    @staticmethod
    async def _stream_request(provider: Dict[str, Any], api_url: str,
                              headers: Dict[str, str], request_data: Dict[str,
                                                                          Any],
                              update_callback: Callable[[str], Any],
                              provider_id: str) -> str:
        """处理流式 API 请求

        Args:
            provider: 服务商配置
            api_url: API URL
            headers: 请求头
            request_data: 请求数据
            update_callback: 更新回调函数
            provider_id: 服务商 ID

        Returns:
            str: 完整响应文本
        """
        global _state

        request_format = provider.get("request_format", "openai")
        full_response = ""
        last_update_time = time.time()

        try:
            _interface.logger.debug(f"正在流式调用 {provider['name']} API")

            async with aiohttp.ClientSession() as session:
                async with session.post(api_url,
                                        json=request_data,
                                        headers=headers,
                                        timeout=REQUEST_TIMEOUT) as response:

                    if response.status != 200:
                        error_text = await response.text()
                        _interface.logger.error(
                            f"API 请求失败: {response.status} - {error_text}")
                        return f"API 请求失败: HTTP {response.status}"

                    # 根据不同服务商处理流式响应
                    if request_format == "openai":
                        # OpenAI 流式响应处理 (包括 Gemini OpenAI 兼容模式)
                        async for line in response.content:
                            line = line.strip()

                            # 处理流式响应行
                            full_response = await OpenAIProvider.process_stream(
                                line,
                                # 包装回调以控制更新频率
                                lambda text: AIManager._throttled_update(
                                    text, update_callback, last_update_time),
                                full_response)

                            # 更新最后更新时间
                            current_time = time.time()
                            if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
                                last_update_time = current_time

                    elif request_format == "anthropic":
                        # Anthropic 流式响应处理
                        async for line in response.content:
                            line = line.strip()

                            # 处理流式响应行
                            full_response = await AnthropicProvider.process_stream(
                                line,
                                # 包装回调以控制更新频率
                                lambda text: AIManager._throttled_update(
                                    text, update_callback, last_update_time),
                                full_response)

                            # 更新最后更新时间
                            current_time = time.time()
                            if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
                                last_update_time = current_time

            # 更新使用统计
            _state["usage_stats"]["total_requests"] += 1
            _state["usage_stats"]["requests_by_provider"][provider_id] = \
                _state["usage_stats"]["requests_by_provider"].get(provider_id, 0) + 1

            # 确保回调一个最终内容
            if full_response:
                await update_callback(full_response)

            return full_response

        except aiohttp.ClientError as e:
            _interface.logger.error(f"API 请求错误: {str(e)}")
            return f"API 请求错误: {str(e)}"
        except asyncio.TimeoutError:
            _interface.logger.error("API 请求超时")
            return "API 请求超时，请稍后再试"
        except Exception as e:
            _interface.logger.error(f"调用 AI API 时发生错误: {str(e)}")
            return f"发生错误: {str(e)}"

    @staticmethod
    async def _standard_request(provider: Dict[str, Any], api_url: str,
                                headers: Dict[str,
                                              str], request_data: Dict[str,
                                                                       Any],
                                provider_id: str) -> str:
        """处理标准 API 请求

        Args:
            provider: 服务商配置
            api_url: API URL
            headers: 请求头
            request_data: 请求数据
            provider_id: 服务商 ID

        Returns:
            str: 响应文本
        """
        global _state

        try:
            _interface.logger.debug(f"正在调用 {provider['name']} API")

            async with aiohttp.ClientSession() as session:
                async with session.post(api_url,
                                        json=request_data,
                                        headers=headers,
                                        timeout=REQUEST_TIMEOUT) as response:

                    if response.status != 200:
                        error_text = await response.text()
                        _interface.logger.error(
                            f"API 请求失败: {response.status} - {error_text}")
                        return f"API 请求失败: HTTP {response.status}"

                    response_json = await response.json()

                    # 解析响应
                    result = await AIServiceProvider.parse_response(
                        provider, response_json)
                    if result is None:
                        _interface.logger.error(
                            f"解析 API 响应失败: {response_json}")
                        return "解析 API 响应失败"

                    # 更新使用统计
                    _state["usage_stats"]["total_requests"] += 1
                    _state["usage_stats"]["requests_by_provider"][provider_id] = \
                        _state["usage_stats"]["requests_by_provider"].get(provider_id, 0) + 1

                    return result

        except aiohttp.ClientError as e:
            _interface.logger.error(f"API 请求错误: {str(e)}")
            return f"API 请求错误: {str(e)}"
        except asyncio.TimeoutError:
            _interface.logger.error("API 请求超时")
            return "API 请求超时，请稍后再试"
        except Exception as e:
            _interface.logger.error(f"调用 AI API 时发生错误: {str(e)}")
            return f"发生错误: {str(e)}"

    @staticmethod
    async def _throttled_update(text: str, callback: Callable[[str], Any],
                                last_update_time: float) -> None:
        """限制更新频率的回调包装器

        Args:
            text: 更新文本
            callback: 原始回调函数
            last_update_time: 上次更新时间
        """
        current_time = time.time()
        if current_time - last_update_time >= MIN_UPDATE_INTERVAL:
            await callback(text)

    @staticmethod
    def is_user_authorized(user_id: int,
                           context: ContextTypes.DEFAULT_TYPE) -> bool:
        """检查用户是否有权使用 AI 功能

        Args:
            user_id: 用户 ID
            context: 上下文对象

        Returns:
            bool: 是否有权限
        """
        global _state

        # 超级管理员总是可以使用
        config_manager = context.bot_data.get("config_manager")
        if config_manager and config_manager.is_admin(user_id):
            return True

        # 白名单用户可以使用
        user_id_str = str(user_id)
        if user_id_str in _state["whitelist"]:
            return True

        # 其他用户不能使用
        return False

    @staticmethod
    def is_super_admin(user_id: int,
                       context: ContextTypes.DEFAULT_TYPE) -> bool:
        """检查用户是否是超级管理员

        Args:
            user_id: 用户 ID
            context: 上下文对象

        Returns:
            bool: 是否是超级管理员
        """
        # 获取配置管理器
        config_manager = context.bot_data.get("config_manager")
        if config_manager and config_manager.is_admin(user_id):
            return True

        return False

    @staticmethod
    async def process_ai_response(provider_id: str, messages: List[Dict[str,
                                                                        str]],
                                  images: List[Dict[str, Any]],
                                  thinking_message, user_id: Union[int, str]):
        """处理 AI 响应，作为异步任务运行

        Args:
            provider_id: 服务商 ID
            messages: 消息列表
            images: 图像列表
            thinking_message: “正在思考”消息对象
            user_id: 用户 ID
        """
        try:
            # 完整响应变量
            full_response = ""

            # 创建流式更新回调函数
            async def update_message_callback(text):
                nonlocal full_response
                try:
                    # 确保文本不为空
                    if not text.strip():
                        return

                    full_response = text

                    # 如果文本太长，只显示最后部分
                    if len(text) <= MAX_MESSAGE_LENGTH:
                        await thinking_message.edit_text(text)
                    else:
                        # 如果消息超长，只更新最后部分
                        await thinking_message.edit_text(
                            text[-MAX_MESSAGE_LENGTH:])

                except Exception as e:
                    # 忽略"消息未修改"错误
                    if "Message is not modified" not in str(e):
                        _interface.logger.error(f"更新消息失败: {e}")

            # 调用流式 AI API
            response = await AIManager.call_ai_api(provider_id, messages,
                                                   images, True,
                                                   update_message_callback)

            # 添加 AI 回复到上下文
            ConversationManager.add_message(user_id, "assistant", response)

            # 流式传输完成后，尝试将最终消息转换为 HTML 格式
            try:
                # 转换为 HTML 格式
                html_response = TextFormatter.markdown_to_html(response)

                # 检查长度
                if len(html_response) <= MAX_MESSAGE_LENGTH:
                    try:
                        # 直接更新原消息为 HTML 格式
                        await thinking_message.edit_text(html_response,
                                                         parse_mode="HTML")
                    except telegram.error.BadRequest as e:
                        # 忽略"消息未修改"错误
                        if "Message is not modified" not in str(e):
                            _interface.logger.error(f"转换为 HTML 格式失败: {str(e)}")
                else:
                    # 如果 HTML 太长，需要分段发送
                    # 先删除原消息
                    await thinking_message.delete()

                    # 分段发送 HTML
                    parts = []
                    for i in range(0, len(html_response), MAX_MESSAGE_LENGTH):
                        parts.append(html_response[i:i + MAX_MESSAGE_LENGTH])

                    _interface.logger.info(f"消息过长，将分为 {len(parts)} 段发送")

                    # 发送第一段
                    first_message = await thinking_message.reply_text(
                        parts[0], parse_mode="HTML")

                    # 发送剩余段落
                    for part in parts[1:]:
                        await first_message.reply_text(part, parse_mode="HTML")

            except Exception as e:
                _interface.logger.error(f"转换为 HTML 格式失败: {e}")
                # 如果转换失败，保留原始纯文本消息
        except Exception as e:
            _interface.logger.error(f"AI 响应处理错误: {e}")
            # 尝试发送错误消息
            try:
                await thinking_message.edit_text(f"处理请求时出错: {str(e)}")
            except:
                pass

    @staticmethod
    async def process_image(photo_file: File) -> Optional[Dict[str, str]]:
        """处理图像文件

        Args:
            photo_file: Telegram 图像文件

        Returns:
            Dict: 处理后的图像数据，包含 base64 编码
        """
        try:
            # 下载图像
            image_data = await photo_file.download_as_bytearray()

            # 转换为 base64
            image_base64 = base64.b64encode(image_data).decode('utf-8')

            return {"data": image_base64, "mime_type": "image/jpeg"}
        except Exception as e:
            _interface.logger.error(f"处理图像失败: {e}")
            return None


# 配置菜单和回调处理


async def show_config_main_menu(update: Update,
                                context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示 AI 配置主菜单"""
    # 构建菜单文本
    menu_text = "<b>🤖 AI 配置面板</b>\n\n"
    menu_text += "请选择要配置的选项："

    # 构建按钮 (水平排列)
    keyboard = [
        [
            InlineKeyboardButton("View Config",
                                 callback_data=f"{CALLBACK_PREFIX}_view"),
            InlineKeyboardButton("View Stats",
                                 callback_data=f"{CALLBACK_PREFIX}_stats")
        ],
        [
            InlineKeyboardButton("Add Provider",
                                 callback_data=f"{CALLBACK_PREFIX}_add"),
            InlineKeyboardButton("Edit Provider",
                                 callback_data=f"{CALLBACK_PREFIX}_edit")
        ],
        [
            InlineKeyboardButton("Del Provider",
                                 callback_data=f"{CALLBACK_PREFIX}_delete"),
            InlineKeyboardButton("Set Default",
                                 callback_data=f"{CALLBACK_PREFIX}_default")
        ],
        [
            InlineKeyboardButton("Set Timeout",
                                 callback_data=f"{CALLBACK_PREFIX}_timeout")
        ]
    ]

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if update.callback_query:
        # 如果是回调查询，使用 edit_message_text
        await update.callback_query.edit_message_text(
            menu_text, reply_markup=reply_markup, parse_mode="HTML")
    else:
        # 如果是直接命令，使用 reply_text
        message = update.message or update.edited_message
        if message:
            await message.reply_text(menu_text,
                                     reply_markup=reply_markup,
                                     parse_mode="HTML")
        else:
            _interface.logger.error("无法获取消息对象，无法显示配置菜单")


async def show_provider_templates(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示服务商模板选择界面"""
    query = update.callback_query

    # 构建模板选择文本
    templates_text = "<b>🤖 选择服务商模板</b>\n\n"
    templates_text += "请选择要创建的服务商类型："

    # 构建模板按钮
    keyboard = []
    for template_id, template in PROVIDER_TEMPLATES.items():
        if template_id != "custom":  # 将自定义模板放在最后
            keyboard.append([
                InlineKeyboardButton(
                    f"{template['name']}",
                    callback_data=f"{CALLBACK_PREFIX}_template_{template_id}")
            ])

    # 添加自定义模板和返回按钮
    keyboard.append([
        InlineKeyboardButton(
            "Custom", callback_data=f"{CALLBACK_PREFIX}_template_custom")
    ])
    keyboard.append([
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送模板选择界面
    try:
        await query.edit_message_text(templates_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
    except telegram.error.BadRequest as e:
        # 忽略"消息未修改"错误
        if "Message is not modified" not in str(e):
            _interface.logger.error(f"更新模板选择界面失败: {str(e)}")
            await query.answer("更新消息失败，请重试")


async def show_provider_list(update: Update,
                             context: ContextTypes.DEFAULT_TYPE,
                             action_type: str) -> None:
    """显示服务商列表选择界面

    Args:
        update: 更新对象
        context: 上下文对象
        action_type: 操作类型 (edit, delete, default)
    """
    global _state
    query = update.callback_query

    # 构建标题和说明
    if action_type == "edit":
        title = "✏️ 编辑服务商"
        description = "请选择要编辑的服务商："
    elif action_type == "delete":
        title = "🗑️ 删除服务商"
        description = "请选择要删除的服务商："
    elif action_type == "default":
        title = "✅ 设置默认服务商"
        description = "请选择要设置为默认的服务商："
    else:
        title = "选择服务商"
        description = "请选择一个服务商："

    # 构建列表文本
    list_text = f"<b>{title}</b>\n\n{description}"

    # 构建服务商按钮
    keyboard = []

    if not _state["providers"]:
        list_text += "\n\n<i>暂无服务商配置</i>"
    else:
        for provider_id, provider in _state["providers"].items():
            # 标记默认服务商和配置状态
            is_default = "✅ " if provider_id == _state[
                "default_provider"] else ""
            is_configured = "🔑 " if provider.get("api_key") else "⚠️ "

            # 按钮文本
            button_text = f"{is_default}{is_configured}{provider_id} ({provider.get('name', provider_id)})"

            # 按钮回调数据
            callback_data = f"{CALLBACK_PREFIX}_{action_type}_{provider_id}"

            keyboard.append([
                InlineKeyboardButton(button_text, callback_data=callback_data)
            ])

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送服务商列表
    try:
        await query.edit_message_text(list_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
    except telegram.error.BadRequest as e:
        # 忽略"消息未修改"错误
        if "Message is not modified" not in str(e):
            _interface.logger.error(f"更新服务商列表失败: {str(e)}")
            await query.answer("更新消息失败，请重试")


async def show_timeout_options(update: Update,
                               context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示超时时间选项"""
    global _state
    query = update.callback_query

    # 当前超时时间
    current_timeout_seconds = _state.get("conversation_timeout", 24 * 60 * 60)

    # 检查是否是无限超时
    if current_timeout_seconds == float('inf'):
        current_timeout = "never"
        current_display = "永不超时"
    else:
        current_timeout = current_timeout_seconds // 3600
        current_display = f"{current_timeout} 小时"

    # 构建超时选项文本
    timeout_text = "<b>⏱️ 设置对话超时时间</b>\n\n"
    timeout_text += f"当前超时时间: <code>{current_display}</code>\n\n"
    timeout_text += "请选择新的超时时间："

    # 构建超时选项按钮 (水平排列)
    keyboard = []
    row = []
    for i, hours in enumerate([1, 3, 6, 12, 24, 48, "never"]):
        # 标记当前选项
        marker = "▷ " if hours == current_timeout else ""
        # 处理 "never" 选项的特殊显示
        display_text = f"{marker}Never" if hours == "never" else f"{marker}{hours} hours"
        row.append(
            InlineKeyboardButton(
                display_text,
                callback_data=f"{CALLBACK_PREFIX}_set_timeout_{hours}"))

        # 每两个按钮一行
        if i % 2 == 1 or i == 6:  # 最后一个按钮可能是单独一行
            keyboard.append(row)
            row = []

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送超时选项
    try:
        await query.edit_message_text(timeout_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
    except telegram.error.BadRequest as e:
        # 忽略"消息未修改"错误
        if "Message is not modified" not in str(e):
            _interface.logger.error(f"更新超时选项失败: {str(e)}")
            await query.answer("更新消息失败，请重试")


async def show_usage_stats(update: Update,
                           context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示使用统计数据"""
    global _state
    query = update.callback_query

    stats = _state["usage_stats"]

    stats_text = "<b>📊 AI 使用统计</b>\n\n"

    # 总请求数
    stats_text += f"<b>总请求数:</b> <code>{stats.get('total_requests', 0)}</code>\n\n"

    # 按服务商统计
    stats_text += "<b>按服务商统计:</b>\n"
    if not stats.get('requests_by_provider'):
        stats_text += "<i>暂无数据</i>\n"
    else:
        for provider, count in stats.get('requests_by_provider', {}).items():
            provider_name = _state["providers"].get(provider, {}).get(
                "name",
                provider) if provider in _state["providers"] else provider
            stats_text += f"• <code>{provider}</code> ({provider_name}): <code>{count}</code>\n"

    # 按用户统计 (仅显示前 10 位活跃用户)
    stats_text += "\n<b>按用户统计 (前 10 位):</b>\n"
    if not stats.get('requests_by_user'):
        stats_text += "<i>暂无数据</i>\n"
    else:
        # 按使用量排序
        sorted_users = sorted(stats.get('requests_by_user', {}).items(),
                              key=lambda x: x[1],
                              reverse=True)[:10]

        for user_id, count in sorted_users:
            stats_text += f"• 用户 <code>{user_id}</code>: <code>{count}</code> 次请求\n"

    # 添加返回按钮
    keyboard = [[
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送统计数据
    try:
        await query.edit_message_text(stats_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
    except Exception as e:
        _interface.logger.error(f"发送 AI 统计信息失败: {e}")
        await query.edit_message_text("发送统计信息失败，请联系管理员查看日志",
                                      reply_markup=reply_markup)


async def show_whitelist_menu(update: Update,
                              context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示白名单管理菜单"""
    global _state

    # 检查是否是群聊
    is_group = update.effective_chat.type != "private"

    whitelist_text = "<b>👥 AI 白名单管理</b>\n\n"

    # 显示当前白名单
    if not _state["whitelist"]:
        whitelist_text += "<i>白名单为空</i>\n\n"
    else:
        whitelist_text += "<b>当前白名单用户:</b>\n"
        for i, (user_id_str,
                user_info) in enumerate(_state["whitelist"].items(), 1):
            # 获取用户名
            username = user_info.get("username", "未知用户名")

            # 构建显示文本
            user_display = f"{i}. <code>{user_id_str}</code>"
            if username and username != "未知用户名":
                user_display += f" (@{username})"

            whitelist_text += f"{user_display}\n"
        whitelist_text += "\n"

    # 如果是群聊，添加提示信息
    if is_group:
        whitelist_text += "您可以通过以下方式管理白名单：\n"
        whitelist_text += "1. 使用 /aiwhitelist 回复用户消息来添加\n"
        whitelist_text += "2. 使用下方按钮添加\n\n"

    whitelist_text += "请选择操作："

    # 构建白名单管理按钮 (水平排列)
    keyboard = [[
        InlineKeyboardButton("Add User",
                             callback_data=f"{CALLBACK_PREFIX}_whitelist_add"),
        InlineKeyboardButton(
            "Remove User", callback_data=f"{CALLBACK_PREFIX}_whitelist_remove")
    ],
                [
                    InlineKeyboardButton(
                        "Clear All",
                        callback_data=f"{CALLBACK_PREFIX}_whitelist_clear")
                ]]

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if update.callback_query:
        # 如果是回调查询，使用 edit_message_text
        query = update.callback_query
        try:
            await query.edit_message_text(whitelist_text,
                                          reply_markup=reply_markup,
                                          parse_mode="HTML")
        except telegram.error.BadRequest as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新白名单管理菜单失败: {str(e)}")
                await query.answer("更新消息失败，请重试")
    else:
        # 如果是直接命令或文本输入，使用 reply_text
        message = update.message or update.edited_message
        if message:
            await message.reply_text(whitelist_text,
                                     reply_markup=reply_markup,
                                     parse_mode="HTML")
        else:
            _interface.logger.error("无法获取消息对象，无法显示白名单管理菜单")


async def handle_specific_actions(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE,
                                  action: str, callback_data: str) -> None:
    """处理特定的按钮操作"""
    global _state
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.answer("系统错误：无法获取会话管理器")
        return

    # 解析回调数据
    parts = callback_data.replace(f"{CALLBACK_PREFIX}_", "").split("_")

    # 处理特定操作

    # 处理模板选择
    if action == "template" and len(parts) >= 2:
        template_id = parts[1]

        # 验证模板是否存在
        if template_id not in PROVIDER_TEMPLATES and template_id != "custom":
            _interface.logger.warning(
                f"用户 {user_id} 尝试使用不存在的模板: {template_id}")
            await show_provider_templates(update, context)
            return

        # 设置会话状态，记录选择的模板
        await session_manager.set(user_id,
                                  "selected_template",
                                  template_id,
                                  chat_id=chat_id)

        # 提示输入新服务商 ID
        await query.edit_message_text(
            f"<b>🤖 创建新服务商</b>\n\n"
            f"已选择模板: <code>{template_id}</code>\n\n"
            f"请输入新服务商的 ID (仅使用字母、数字和下划线):",
            parse_mode="HTML")

        # 设置会话状态，等待用户输入服务商 ID
        await session_manager.set(user_id,
                                  "ai_waiting_for",
                                  "provider_id",
                                  chat_id=chat_id)

    # 处理设置超时时间
    elif action == "set" and "timeout" in parts:
        timeout_value = parts[-1]

        if timeout_value == "never":
            # 设置为非常大的值，实际上相当于永不超时
            _state["conversation_timeout"] = float('inf')
            await query.answer("已将对话超时时间设置为永不超时")
            _interface.logger.info(f"用户 {user_id} 将对话超时时间设置为永不超时")
        else:
            # 正常的小时数设置
            hours = int(timeout_value)
            _state["conversation_timeout"] = hours * 3600
            await query.answer(f"已将对话超时时间设置为 {hours} 小时")
            _interface.logger.info(f"用户 {user_id} 将对话超时时间设置为 {hours} 小时")

        # 保存配置
        save_config()

        # 返回超时设置菜单
        await show_timeout_options(update, context)

    # 处理服务商操作
    elif action in ["edit", "delete", "default"] and len(parts) >= 2:

        # 检查回调数据格式
        if parts[1] == "provider" and len(parts) >= 3:
            # 格式: action_provider_id
            provider_id = parts[2]
        elif len(parts) >= 2:
            # 格式: action_id
            provider_id = parts[1]
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的回调数据: {callback_data}")
            await show_config_main_menu(update, context)
            return

        # 验证服务商是否存在
        if provider_id not in _state["providers"]:
            _interface.logger.warning(
                f"用户 {user_id} 尝试操作不存在的服务商: {provider_id}")
            await show_config_main_menu(update, context)
            return

        if action == "edit":
            # 编辑服务商
            await session_manager.set(user_id,
                                      "editing_provider",
                                      provider_id,
                                      chat_id=chat_id)
            await show_provider_edit_menu(update, context, provider_id)

        elif action == "delete":
            # 删除服务商
            # 显示确认对话框
            await show_delete_confirmation(update, context, provider_id)

        elif action == "default":
            # 设置默认服务商
            _state["default_provider"] = provider_id

            # 保存配置
            save_config()

            _interface.logger.info(f"用户 {user_id} 将默认服务商设置为 {provider_id}")

            # 返回主菜单
            await show_config_main_menu(update, context)

    # 处理白名单操作
    elif action == "whitelist":
        whitelist_action = parts[-1]

        if whitelist_action == "add":
            # 检查是否是群聊
            is_group = update.effective_chat.type != "private"

            if is_group:
                # 在群聊中显示提示
                keyboard = [[
                    InlineKeyboardButton(
                        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}_whitelist")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await query.edit_message_text(
                    "<b>👥 添加用户到白名单</b>\n\n"
                    "请使用 /aiwhitelist 命令回复用户消息来添加用户",
                    reply_markup=reply_markup,
                    parse_mode="HTML")
            else:
                # 在私聊中提示输入用户 ID
                keyboard = [[
                    InlineKeyboardButton(
                        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}_whitelist")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await query.edit_message_text(
                    "<b>👥 添加用户到白名单</b>\n\n"
                    "请输入要添加的用户 ID (数字):",
                    reply_markup=reply_markup,
                    parse_mode="HTML")

                # 设置会话状态，等待用户输入用户 ID
                await session_manager.set(user_id,
                                          "ai_waiting_for",
                                          "whitelist_add_user_id",
                                          chat_id=chat_id)

        elif whitelist_action == "remove":
            # 显示可移除的用户列表
            await show_whitelist_remove_menu(update, context)

        elif whitelist_action == "clear":
            # 显示确认对话框 (水平排列)
            keyboard = [[
                InlineKeyboardButton(
                    "◯ Confirm",
                    callback_data=f"{CALLBACK_PREFIX}_whitelist_clear_confirm"
                ),
                InlineKeyboardButton(
                    "⨉ Cancel", callback_data=f"{CALLBACK_PREFIX}_whitelist")
            ]]

            reply_markup = InlineKeyboardMarkup(keyboard)

            try:
                await query.edit_message_text(
                    "<b>⚠️ 确认清空白名单</b>\n\n"
                    "您确定要清空整个白名单吗？此操作不可撤销",
                    reply_markup=reply_markup,
                    parse_mode="HTML")
            except telegram.error.BadRequest as e:
                # 忽略"消息未修改"错误
                if "Message is not modified" not in str(e):
                    _interface.logger.error(f"更新白名单清空确认对话框失败: {str(e)}")
                    await query.answer("更新消息失败，请重试")

        elif whitelist_action == "clear_confirm":
            # 清空白名单
            _state["whitelist"] = {}

            # 保存配置
            save_config()

            await query.answer("已清空白名单")
            _interface.logger.info(f"用户 {user_id} 清空了 AI 白名单")

            # 返回白名单管理菜单
            await show_whitelist_menu(update, context)

    # 处理编辑参数操作
    elif action == "edit_param" and len(parts) >= 3:
        # 获取参数
        provider_id = parts[1]
        param = parts[2]

        # 编辑参数

        # 验证服务商是否存在
        if provider_id not in _state["providers"]:
            _interface.logger.warning(
                f"用户 {user_id} 尝试编辑不存在的服务商: {provider_id}")
            await show_config_main_menu(update, context)
            return

        # 提示用户输入新值
        current_value = _state["providers"][provider_id].get(param, "")

        # 构建提示文本
        prompt_text = f"<b>✏️ 编辑参数</b>\n\n"
        prompt_text += f"服务商: <code>{provider_id}</code>\n"
        prompt_text += f"参数: <code>{param}</code>\n"
        prompt_text += f"当前值: <code>{current_value}</code>\n\n"

        if param == "temperature":
            prompt_text += "请输入新的温度值 (0.0-1.0):"
        elif param == "supports_image":
            prompt_text += "请输入是否支持图像 (yes/no):"
        else:
            prompt_text += "请输入新的值:"

        # 发送提示
        await query.edit_message_text(prompt_text, parse_mode="HTML")

        # 设置会话状态，等待用户输入
        await session_manager.set(user_id,
                                  "ai_waiting_for",
                                  f"edit_param_{provider_id}_{param}",
                                  chat_id=chat_id)

    # 处理删除确认操作
    elif action == "delete_confirm":

        # 确保回调数据格式正确
        if len(parts) >= 3:
            # 格式: delete_confirm_provider_id
            provider_id = parts[2]

            # 验证服务商是否存在
            if provider_id not in _state["providers"]:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试删除不存在的服务商: {provider_id}")
                await show_config_main_menu(update, context)
                return

            # 删除服务商
            del _state["providers"][provider_id]

            # 如果删除的是默认服务商，重置默认服务商
            if _state["default_provider"] == provider_id:
                if _state["providers"]:
                    # 设置第一个服务商为默认
                    _state["default_provider"] = next(iter(
                        _state["providers"]))
                else:
                    _state["default_provider"] = None

            # 保存配置
            save_config()

            _interface.logger.info(f"用户 {user_id} 删除了服务商: {provider_id}")

            # 返回主菜单
            await show_config_main_menu(update, context)
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的删除确认回调数据: {callback_data}")
            await show_config_main_menu(update, context)

    # 处理白名单用户移除操作
    elif action == "whitelist_remove_user":
        # 检查回调数据格式
        if len(parts) >= 2:
            # 从最后一个部分获取用户 ID
            user_id_str = parts[-1]

            # 验证用户是否在白名单中
            if user_id_str not in _state["whitelist"]:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试移除不在白名单中的用户: {user_id_str}")
                await show_whitelist_menu(update, context)
                return

            # 获取用户信息用于日志和显示
            user_info = _state["whitelist"][user_id_str]
            username = user_info.get("username", "")
            display_name = f"{user_id_str}"
            if username and username != "未知用户名":
                display_name = f"{display_name} (@{username})"

            # 从白名单中移除
            del _state["whitelist"][user_id_str]

            # 保存配置
            save_config()

            _interface.logger.info(f"用户 {user_id} 将用户 {display_name} 从白名单中移除")

            # 返回白名单菜单
            try:
                await query.edit_message_text(
                    f"<b>✅ 已将用户 {user_id_str} 从白名单中移除</b>",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}_whitelist")
                    ]]),
                    parse_mode="HTML")
            except telegram.error.BadRequest as e:
                # 忽略"消息未修改"错误
                if "Message is not modified" not in str(e):
                    _interface.logger.error(f"更新白名单用户移除消息失败: {str(e)}")
                    # 尝试发送新消息
                    try:
                        message = update.message or update.edited_message
                        if message:
                            await message.reply_text(
                                f"<b>✅ 已将用户 {user_id_str} 从白名单中移除</b>",
                                reply_markup=InlineKeyboardMarkup([[
                                    InlineKeyboardButton(
                                        "⇠ Back",
                                        callback_data=
                                        f"{CALLBACK_PREFIX}_whitelist")
                                ]]),
                                parse_mode="HTML")
                    except Exception as e2:
                        _interface.logger.error(f"发送白名单用户移除消息失败: {str(e2)}")
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的移除用户回调数据: {callback_data}")
            await show_whitelist_menu(update, context)

    # 处理测试服务商操作
    elif action == "test_provider":
        provider_id = parts[-1]

        # 验证服务商是否存在
        if provider_id not in _state["providers"]:
            await show_provider_edit_menu(update, context, provider_id)
            return

        # 检查服务商是否配置完整
        provider = _state["providers"][provider_id]
        if not provider.get("api_key"):
            await show_provider_edit_menu(update, context, provider_id)
            return

        # 发送测试消息
        await query.edit_message_text(
            f"<b>🧪 测试服务商: {provider_id}</b>\n\n"
            f"正在发送测试请求...",
            parse_mode="HTML")

        # 准备测试消息
        test_messages = [{
            "role":
            "user",
            "content":
            "Hello, this is a test message. Please respond with a short greeting."
        }]

        try:
            # 调用 API
            response = await AIManager.call_ai_api(provider_id, test_messages,
                                                   [], False, None)

            # 显示结果
            result_text = f"<b>🧪 测试结果: {provider_id}</b>\n\n"
            result_text += f"<b>状态:</b> ✅ 成功\n\n"
            result_text += f"<b>响应:</b>\n<code>{response[:200]}</code>"

            # 添加返回按钮
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}_back")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text(result_text,
                                          reply_markup=reply_markup,
                                          parse_mode="HTML")

        except Exception as e:
            # 显示错误
            error_text = f"<b>🧪 测试结果: {provider_id}</b>\n\n"
            error_text += f"<b>状态:</b> ❌ 失败\n\n"
            error_text += f"<b>错误:</b>\n<code>{str(e)[:200]}</code>"

            # 添加返回按钮
            keyboard = [[
                InlineKeyboardButton("⇠ Back",
                                     callback_data=f"{CALLBACK_PREFIX}_back")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await query.edit_message_text(error_text,
                                          reply_markup=reply_markup,
                                          parse_mode="HTML")

    # 处理编辑服务商返回操作
    elif action == "edit_provider":
        provider_id = parts[-1]

        # 验证服务商是否存在
        if provider_id not in _state["providers"]:
            await show_config_main_menu(update, context)
            return

        # 显示编辑菜单
        await show_provider_edit_menu(update, context, provider_id)

    # 处理其他未知操作
    else:
        _interface.logger.warning(f"用户 {user_id} 尝试执行未实现的操作: {action}")


async def show_provider_edit_menu(update: Update,
                                  context: ContextTypes.DEFAULT_TYPE,
                                  provider_id: str) -> None:
    """显示服务商编辑菜单"""
    global _state

    provider = _state["providers"].get(provider_id, {})

    # 构建编辑菜单文本
    edit_text = f"<b>✏️ 编辑服务商: {provider_id}</b>\n\n"
    edit_text += "请选择要编辑的参数："

    # 构建编辑选项按钮 (水平排列)
    keyboard = [
        [
            InlineKeyboardButton(
                "Name",
                callback_data=f"{CALLBACK_PREFIX}_edit_param_{provider_id}_name"
            ),
            InlineKeyboardButton(
                "Model",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_model")
        ],
        [
            InlineKeyboardButton(
                "API URL",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_api_url"),
            InlineKeyboardButton(
                "API Key",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_api_key")
        ],
        [
            InlineKeyboardButton(
                "Temperature",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_temperature"),
            InlineKeyboardButton(
                "Request",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_request_format")
        ],
        [
            InlineKeyboardButton(
                "System Prompt",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_system_prompt"),
            InlineKeyboardButton(
                "Image Support",
                callback_data=
                f"{CALLBACK_PREFIX}_edit_param_{provider_id}_supports_image")
        ],
        [
            InlineKeyboardButton(
                "Test Provider",
                callback_data=f"{CALLBACK_PREFIX}_test_provider_{provider_id}"
            ),
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}_back")
        ]
    ]

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if update.callback_query:
        # 如果是回调查询，使用 edit_message_text
        query = update.callback_query
        try:
            await query.edit_message_text(edit_text,
                                          reply_markup=reply_markup,
                                          parse_mode="HTML")
        except telegram.error.BadRequest as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新编辑菜单失败: {str(e)}")
                await query.answer("更新消息失败，请重试")
    else:
        # 如果是直接命令或文本输入，使用 reply_text
        message = update.message or update.edited_message
        if message:
            await message.reply_text(edit_text,
                                     reply_markup=reply_markup,
                                     parse_mode="HTML")
        else:
            _interface.logger.error(f"无法获取消息对象，无法显示服务商编辑菜单: {provider_id}")


async def show_delete_confirmation(update: Update,
                                   context: ContextTypes.DEFAULT_TYPE,
                                   provider_id: str) -> None:
    """显示删除确认对话框"""
    query = update.callback_query

    # 构建确认对话框 (水平排列)
    keyboard = [[
        InlineKeyboardButton(
            "◯ Confirm",
            callback_data=f"{CALLBACK_PREFIX}_delete_confirm_{provider_id}"),
        InlineKeyboardButton("⨉ Cancel",
                             callback_data=f"{CALLBACK_PREFIX}_back")
    ]]

    reply_markup = InlineKeyboardMarkup(keyboard)

    try:
        await query.edit_message_text(
            f"<b>⚠️ 确认删除</b>\n\n"
            f"您确定要删除服务商 <code>{provider_id}</code> 吗？此操作不可撤销",
            reply_markup=reply_markup,
            parse_mode="HTML")
    except telegram.error.BadRequest as e:
        # 忽略"消息未修改"错误
        if "Message is not modified" not in str(e):
            _interface.logger.error(f"更新删除确认对话框失败: {str(e)}")
            await query.answer("更新消息失败，请重试")


async def show_whitelist_remove_menu(
        update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示白名单移除菜单"""
    global _state

    # 构建移除菜单文本
    remove_text = "<b>➖ 从白名单中移除用户</b>\n\n"

    if not _state["whitelist"]:
        remove_text += "<i>白名单为空</i>"
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}_whitelist")
        ]]
    else:
        remove_text += "请选择要移除的用户："

        # 构建用户按钮
        keyboard = []
        for user_id_str, user_info in _state["whitelist"].items():
            # 获取用户名
            username = user_info.get("username", "未知用户名")

            # 构建按钮文本
            button_text = f"User {user_id_str}"
            if username and username != "未知用户名":
                button_text = f"@{username} ({user_id_str})"

            keyboard.append([
                InlineKeyboardButton(
                    button_text,
                    callback_data=
                    f"{CALLBACK_PREFIX}_whitelist_remove_user_{user_id_str}")
            ])

        # 添加返回按钮
        keyboard.append([
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}_whitelist")
        ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if update.callback_query:
        # 如果是回调查询，使用 edit_message_text
        query = update.callback_query
        try:
            await query.edit_message_text(remove_text,
                                          reply_markup=reply_markup,
                                          parse_mode="HTML")
        except telegram.error.BadRequest as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新白名单移除菜单失败: {str(e)}")
                await query.answer("更新消息失败，请重试")
    else:
        # 如果是直接命令或文本输入，使用 reply_text
        message = update.message or update.edited_message
        if message:
            await message.reply_text(remove_text,
                                     reply_markup=reply_markup,
                                     parse_mode="HTML")
        else:
            _interface.logger.error("无法获取消息对象，无法显示白名单移除菜单")


async def handle_config_callback(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理配置按钮回调"""
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        await query.answer("系统错误：无法获取会话管理器")
        return

    # 检查是否有等待用户输入的会话状态
    waiting_for = await session_manager.get(user_id,
                                            "ai_waiting_for",
                                            None,
                                            chat_id=chat_id)

    # 如果有等待状态，记录日志
    if waiting_for:
        _interface.logger.debug(
            f"用户 {user_id} 在聊天 {chat_id} 中有等待状态: {waiting_for}")

    # 解析回调数据
    callback_data = query.data
    parts = callback_data.replace(f"{CALLBACK_PREFIX}_", "").split("_")

    # 特殊处理各种操作
    if len(parts) >= 2 and parts[0] == "delete" and parts[1] == "confirm":
        action = "delete_confirm"
    elif len(parts) >= 2 and parts[0] == "edit" and parts[1] == "param":
        action = "edit_param"
        # 确保完整保留参数名称，不要截断
        if len(parts) >= 4:
            # 如果参数名称包含下划线，需要重新组合
            if len(parts) > 4:
                # 重新组合参数名称（从索引3开始到最后）
                parts = parts[:3] + ["_".join(parts[3:])]
    elif len(parts) >= 2 and parts[0] == "test" and parts[1] == "provider":
        action = "test_provider"
    elif len(parts) >= 3 and parts[0] == "whitelist" and parts[
            1] == "remove" and parts[2] == "user":
        action = "whitelist_remove_user"
    elif len(parts) >= 3 and parts[0] == "whitelist" and parts[
            1] == "clear" and parts[2] == "confirm":
        action = "whitelist_clear_confirm"
    else:
        action = parts[0]

    # 记录操作日志
    _interface.logger.debug(f"处理配置回调: {callback_data}, 动作: {action}")

    # 处理配置页面分页
    if callback_data.startswith(f"{CALLBACK_PREFIX}_config_page:"):
        # 分页回调直接调用配置查看函数
        await show_current_config(update, context)
        return

    # 根据不同操作处理
    if action == "view":
        # 查看当前配置
        await show_current_config(update, context)

    elif action == "add":
        # 添加服务商
        await show_provider_templates(update, context)

    elif action == "edit":
        # 检查是否是选择服务商
        if len(parts) == 1:
            # 显示服务商列表
            await show_provider_list(update, context, "edit")
        else:
            # 直接处理服务商编辑
            provider_id = parts[1]
            if provider_id in _state["providers"]:
                await session_manager.set(user_id, "editing_provider",
                                          provider_id)
                await show_provider_edit_menu(update, context, provider_id)
            else:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试编辑不存在的服务商: {provider_id}")
                await show_provider_list(update, context, "edit")

    elif action == "delete":
        # 检查是否是选择服务商
        if len(parts) == 1:
            # 显示服务商列表
            await show_provider_list(update, context, "delete")
        else:
            # 直接处理服务商删除
            provider_id = parts[1]
            if provider_id in _state["providers"]:
                await show_delete_confirmation(update, context, provider_id)
            else:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试删除不存在的服务商: {provider_id}")
                await show_provider_list(update, context, "delete")

    elif action == "delete_confirm":
        # 处理删除确认操作
        if len(parts) >= 3:
            provider_id = parts[2]

            # 验证服务商是否存在
            if provider_id not in _state["providers"]:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试删除不存在的服务商: {provider_id}")
                await show_config_main_menu(update, context)
                return

            # 删除服务商
            del _state["providers"][provider_id]

            # 如果删除的是默认服务商，重置默认服务商
            if _state["default_provider"] == provider_id:
                if _state["providers"]:
                    # 设置第一个服务商为默认
                    _state["default_provider"] = next(iter(
                        _state["providers"]))
                else:
                    _state["default_provider"] = None

            # 保存配置
            save_config()

            _interface.logger.info(f"用户 {user_id} 删除了服务商: {provider_id}")

            # 返回主菜单
            await show_config_main_menu(update, context)
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的删除确认回调数据: {callback_data}")
            await show_config_main_menu(update, context)

    elif action == "default":
        # 检查是否是选择服务商
        if len(parts) == 1:
            # 显示服务商列表
            await show_provider_list(update, context, "default")
        else:
            # 直接设置默认服务商
            provider_id = parts[1]
            if provider_id in _state["providers"]:
                _state["default_provider"] = provider_id
                save_config()
                _interface.logger.info(f"用户 {user_id} 将默认服务商设置为 {provider_id}")
                await show_config_main_menu(update, context)
            else:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试设置不存在的服务商为默认: {provider_id}")
                await show_provider_list(update, context, "default")

    elif action == "timeout":
        # 设置超时时间
        await show_timeout_options(update, context)

    elif action == "stats":
        # 查看使用统计
        await show_usage_stats(update, context)

    elif action == "whitelist_clear_confirm":
        # 清空白名单
        _state["whitelist"] = {}  # 使用字典结构

        # 保存配置
        save_config()

        _interface.logger.info(f"用户 {user_id} 清空了 AI 白名单")

        # 发送成功消息
        try:
            await query.edit_message_text(
                "<b>✅ 白名单已清空</b>\n\n"
                "所有用户已从白名单中移除",
                reply_markup=InlineKeyboardMarkup([[
                    InlineKeyboardButton(
                        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}_whitelist")
                ]]),
                parse_mode="HTML")
        except telegram.error.BadRequest as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新白名单清空确认消息失败: {str(e)}")
                # 尝试发送新消息
                try:
                    message = update.message or update.edited_message
                    if message:
                        await message.reply_text(
                            "<b>✅ 白名单已清空</b>\n\n"
                            "所有用户已从白名单中移除",
                            reply_markup=InlineKeyboardMarkup([[
                                InlineKeyboardButton(
                                    "⇠ Back",
                                    callback_data=f"{CALLBACK_PREFIX}_whitelist"
                                )
                            ]]),
                            parse_mode="HTML")
                except Exception as e2:
                    _interface.logger.error(f"发送白名单清空确认消息失败: {str(e2)}")

    elif action == "whitelist":
        # 管理白名单
        if len(parts) == 1:
            # 清除任何等待状态
            await session_manager.delete(user_id,
                                         "ai_waiting_for",
                                         chat_id=chat_id)

            # 显示白名单主菜单
            await show_whitelist_menu(update, context)
        elif len(parts) >= 2:
            whitelist_action = parts[1]

            if whitelist_action == "add":
                # 检查是否是群聊
                is_group = update.effective_chat.type != "private"

                try:
                    # 添加返回按钮
                    keyboard = [[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}_whitelist")
                    ]]
                    reply_markup = InlineKeyboardMarkup(keyboard)

                    if is_group:
                        # 在群聊中提示两种方式
                        await query.edit_message_text(
                            "<b>👥 添加用户到白名单</b>\n\n"
                            "请输入用户 ID (数字):",
                            reply_markup=reply_markup,
                            parse_mode="HTML")

                        # 设置会话状态，等待用户输入用户 ID
                        await session_manager.set(user_id,
                                                  "ai_waiting_for",
                                                  "whitelist_add_user_id",
                                                  chat_id=chat_id)
                    else:
                        # 在私聊中提示输入用户 ID
                        await query.edit_message_text(
                            "<b>👥 添加用户到白名单</b>\n\n"
                            "请输入要添加的用户 ID (数字):",
                            reply_markup=reply_markup,
                            parse_mode="HTML")

                        # 设置会话状态，等待用户输入用户 ID
                        await session_manager.set(user_id,
                                                  "ai_waiting_for",
                                                  "whitelist_add_user_id",
                                                  chat_id=chat_id)
                except telegram.error.BadRequest as e:
                    # 忽略"消息未修改"错误
                    if "Message is not modified" not in str(e):
                        _interface.logger.error(f"更新添加用户到白名单提示失败: {str(e)}")
                        # 尝试发送新消息
                        try:
                            message = update.message or update.edited_message
                            if message:
                                # 检查是否是群聊
                                is_group = update.effective_chat.type != "private"

                                if is_group:
                                    # 在群聊中显示提示
                                    keyboard = [[
                                        InlineKeyboardButton(
                                            "⇠ Back",
                                            callback_data=
                                            f"{CALLBACK_PREFIX}_whitelist")
                                    ]]
                                    reply_markup = InlineKeyboardMarkup(
                                        keyboard)

                                    await message.reply_text(
                                        "<b>👥 添加用户到白名单</b>\n\n"
                                        "请使用 /aiwhitelist 命令回复用户消息来添加用户",
                                        reply_markup=reply_markup,
                                        parse_mode="HTML")
                                else:
                                    # 在私聊中提示输入用户 ID
                                    keyboard = [[
                                        InlineKeyboardButton(
                                            "⇠ Back",
                                            callback_data=
                                            f"{CALLBACK_PREFIX}_whitelist")
                                    ]]
                                    reply_markup = InlineKeyboardMarkup(
                                        keyboard)

                                    await message.reply_text(
                                        "<b>👥 添加用户到白名单</b>\n\n"
                                        "请输入要添加的用户 ID (数字):",
                                        reply_markup=reply_markup,
                                        parse_mode="HTML")

                                    # 设置会话状态，等待用户输入用户 ID
                                    await session_manager.set(
                                        user_id,
                                        "ai_waiting_for",
                                        "whitelist_add_user_id",
                                        chat_id=chat_id)
                        except Exception as e2:
                            _interface.logger.error(
                                f"发送添加用户到白名单提示失败: {str(e2)}")

            elif whitelist_action == "remove":
                # 显示可移除的用户列表
                await show_whitelist_remove_menu(update, context)

            elif whitelist_action == "clear":
                # 显示确认对话框
                keyboard = [[
                    InlineKeyboardButton(
                        "◯ Confirm",
                        callback_data=
                        f"{CALLBACK_PREFIX}_whitelist_clear_confirm"),
                    InlineKeyboardButton(
                        "⨉ Cancel",
                        callback_data=f"{CALLBACK_PREFIX}_whitelist")
                ]]

                reply_markup = InlineKeyboardMarkup(keyboard)

                try:
                    await query.edit_message_text(
                        "<b>⚠️ 确认清空白名单</b>\n\n"
                        "您确定要清空整个白名单吗？此操作不可撤销",
                        reply_markup=reply_markup,
                        parse_mode="HTML")
                except telegram.error.BadRequest as e:
                    # 忽略"消息未修改"错误
                    if "Message is not modified" not in str(e):
                        _interface.logger.error(f"更新白名单清空确认对话框失败: {str(e)}")
                        # 尝试发送新消息
                        try:
                            message = update.message or update.edited_message
                            if message:
                                await message.reply_text(
                                    "<b>⚠️ 确认清空白名单</b>\n\n"
                                    "您确定要清空整个白名单吗？此操作不可撤销",
                                    reply_markup=reply_markup,
                                    parse_mode="HTML")
                        except Exception as e2:
                            _interface.logger.error(
                                f"发送白名单清空确认对话框失败: {str(e2)}")

            else:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试执行未知的白名单操作: {whitelist_action}")
                await show_whitelist_menu(update, context)

    elif action == "edit_param":
        # 处理编辑参数操作
        if len(parts) >= 4:
            provider_id = parts[2]
            param_name = parts[3]

            # 记录操作日志
            _interface.logger.debug(
                f"编辑参数: provider_id={provider_id}, param={param_name}")

            # 验证服务商是否存在
            if provider_id not in _state["providers"]:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试编辑不存在的服务商: {provider_id}")
                await show_config_main_menu(update, context)
                return

            # 提示用户输入新值
            current_value = _state["providers"][provider_id].get(
                param_name, "")

            # 构建提示文本
            prompt_text = f"<b>✏️ 编辑参数</b>\n\n"
            prompt_text += f"服务商: <code>{provider_id}</code>\n"
            prompt_text += f"参数: <code>{param_name}</code>\n"
            prompt_text += f"当前值: <code>{current_value}</code>\n\n"

            if param_name == "temperature":
                prompt_text += "请输入新的温度值 (0.0-1.0):"
            elif param_name == "supports_image":
                prompt_text += "请输入是否支持图像 (yes/no):"
            else:
                prompt_text += "请输入新的值:"

            # 发送提示
            await query.edit_message_text(prompt_text, parse_mode="HTML")

            # 设置会话状态，等待用户输入
            await session_manager.set(user_id,
                                      "ai_waiting_for",
                                      f"edit_param_{provider_id}_{param_name}",
                                      chat_id=chat_id)
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的编辑参数回调数据: {callback_data}")
            await show_config_main_menu(update, context)

    elif action == "test_provider":
        # 处理测试服务商操作
        if len(parts) >= 3:
            provider_id = parts[2]

            # 验证服务商是否存在
            if provider_id not in _state["providers"]:
                _interface.logger.warning(
                    f"用户 {user_id} 尝试测试不存在的服务商: {provider_id}")
                await show_config_main_menu(update, context)
                return

            # 检查服务商是否配置完整
            provider = _state["providers"][provider_id]
            if not provider.get("api_key"):
                _interface.logger.warning(
                    f"用户 {user_id} 尝试测试未配置 API 密钥的服务商: {provider_id}")
                await show_provider_edit_menu(update, context, provider_id)
                return

            # 发送测试消息
            await query.edit_message_text(
                f"<b>🧪 测试服务商: {provider_id}</b>\n\n"
                f"正在发送测试请求...",
                parse_mode="HTML")

            # 准备测试消息
            test_messages = [{
                "role":
                "user",
                "content":
                "Hello, this is a test message. Please respond with a short greeting."
            }]

            try:
                # 调用 API
                response = await AIManager.call_ai_api(provider_id,
                                                       test_messages, [],
                                                       False, None)

                # 显示结果
                result_text = f"<b>🧪 测试结果: {provider_id}</b>\n\n"
                result_text += f"<b>状态:</b> ✅ 成功\n\n"
                result_text += f"<b>响应:</b>\n<code>{response[:200]}</code>"

                # 添加返回按钮
                keyboard = [[
                    InlineKeyboardButton(
                        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await query.edit_message_text(result_text,
                                              reply_markup=reply_markup,
                                              parse_mode="HTML")

            except Exception as e:
                # 显示错误
                error_text = f"<b>🧪 测试结果: {provider_id}</b>\n\n"
                error_text += f"<b>状态:</b> ❌ 失败\n\n"
                error_text += f"<b>错误:</b>\n<code>{str(e)[:200]}</code>"

                # 添加返回按钮
                keyboard = [[
                    InlineKeyboardButton(
                        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await query.edit_message_text(error_text,
                                              reply_markup=reply_markup,
                                              parse_mode="HTML")
        else:
            _interface.logger.warning(
                f"用户 {user_id} 发送了格式错误的测试服务商回调数据: {callback_data}")
            await show_config_main_menu(update, context)

    elif action == "back":
        # 清除任何等待状态
        await session_manager.delete(user_id,
                                     "ai_waiting_for",
                                     chat_id=chat_id)

        # 返回主菜单
        await show_config_main_menu(update, context)

    else:
        # 处理其他特定操作
        await handle_specific_actions(update, context, action, callback_data)


async def show_current_config(update: Update,
                              context: ContextTypes.DEFAULT_TYPE) -> None:
    """显示当前 AI 配置"""
    global _state
    query = update.callback_query

    # 获取页码参数（优先从上下文获取，其次从回调数据获取）
    page = context.user_data.get("ai_config_page_index", 0)  # 默认从上下文获取

    # 如果是分页回调，则从回调数据获取
    if query and ":" in query.data:
        parts = query.data.split(":")
        if len(parts) >= 2 and parts[0] == f"{CALLBACK_PREFIX}_config_page":
            try:
                page = int(parts[1])
                # 更新上下文中的页码
                context.user_data["ai_config_page_index"] = page
            except ValueError:
                pass  # 保持原有页码

    # 构建配置信息（使用 HTML 格式）
    config_text = "<b>🤖 当前 AI 配置</b>\n\n"

    # 默认服务商
    default_provider = _state["default_provider"]
    if default_provider and default_provider in _state["providers"]:
        provider_name = _state["providers"][default_provider].get(
            "name", default_provider)
        config_text += f"<b>当前默认服务商:</b> <code>{default_provider}</code> ({provider_name})\n\n"
    else:
        config_text += f"<b>当前默认服务商:</b> <i>未设置</i>\n\n"

    # 对话超时设置
    timeout_hours = _state.get("conversation_timeout", 24 * 60 * 60) // 3600
    config_text += f"<b>对话超时时间:</b> <code>{timeout_hours}</code> 小时\n\n"

    # 服务商列表
    config_text += "<b>已配置的服务商:</b>\n"

    if not _state["providers"]:
        config_text += "<i>暂无服务商配置</i>\n"
    else:
        # 检查是否有完全配置的服务商（有 API 密钥的）
        configured_providers = [
            p for p, data in _state["providers"].items() if data.get("api_key")
        ]

        if not configured_providers:
            config_text += "<i>已创建服务商，但尚未配置 API 密钥</i>\n\n"

        # 获取服务商列表
        provider_items = list(_state["providers"].items())

        # 设置每页显示的服务商数量
        page_size = 2  # 每页显示2个服务商
        total_pages = max(1,
                          (len(provider_items) + page_size - 1) // page_size)

        # 确保页码在有效范围内
        page = max(0, min(page, total_pages - 1))

        # 保存当前页码到上下文
        context.user_data["ai_config_page_index"] = page

        # 计算当前页的服务商范围
        start_idx = page * page_size
        end_idx = min(start_idx + page_size, len(provider_items))

        # 显示当前页的服务商
        for provider_id, provider in provider_items[start_idx:end_idx]:
            # 标记默认服务商和配置状态
            is_default = "✅ " if provider_id == default_provider else ""
            is_configured = "🔑 " if provider.get("api_key") else "⚠️ "

            config_text += f"\n{is_default}{is_configured}<b>{provider_id}</b>\n"
            config_text += f"  📝 名称: <code>{provider.get('name', provider_id)}</code>\n"
            config_text += f"  🤖 模型: <code>{provider.get('model', '未设置')}</code>\n"

            # API URL (可能很长，截断显示)
            api_url = provider.get('api_url', '未设置')
            if len(api_url) > 20:
                api_url = api_url[:17] + "..."
            config_text += f"  🔗 API URL: <code>{api_url}</code>\n"

            # API Key (隐藏显示)
            api_key = provider.get('api_key', '')
            if api_key:
                masked_key = f"{api_key[:4]}...{api_key[-4:]}" if len(
                    api_key) > 8 else "****"
                config_text += f"  🔑 API Key: <code>{masked_key}</code>\n"
            else:
                config_text += "  🔑 API Key: <code>未设置</code> ⚠️\n"

            config_text += f"  🌡️ 温度: <code>{provider.get('temperature', 0.7)}</code>\n"

            # 系统提示 (可能很长，截断显示)
            system_prompt = provider.get('system_prompt', '未设置')
            if len(system_prompt) > 12:
                system_prompt = system_prompt[:9] + "..."
            config_text += f"  💬 系统提示: <code>{system_prompt}</code>\n"

            config_text += f"  📋 请求格式: <code>{provider.get('request_format', 'openai')}</code>\n"

            # 图像支持
            supports_image = "✅" if provider.get("supports_image",
                                                 False) else "❌"
            config_text += f"  🖼️ 图像支持: {supports_image}\n"

        # 不在文本中添加页码信息，因为已经在按钮中显示了

    # 创建按钮
    keyboard = []

    # 添加分页按钮（如果有多页）
    if len(_state["providers"]) > 2:  # 如果有多于2个服务商
        nav_row = []

        # 上一页按钮
        if page > 0:
            nav_row.append(
                InlineKeyboardButton(
                    "◁ Prev",
                    callback_data=f"{CALLBACK_PREFIX}_config_page:{page - 1}"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        # 页码指示 - 不可点击
        nav_row.append(
            InlineKeyboardButton(f"{page + 1}/{total_pages}",
                                 callback_data="noop"))

        # 下一页按钮
        if page < total_pages - 1:
            nav_row.append(
                InlineKeyboardButton(
                    "Next ▷",
                    callback_data=f"{CALLBACK_PREFIX}_config_page:{page + 1}"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        keyboard.append(nav_row)

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back", callback_data=f"{CALLBACK_PREFIX}_back")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    try:
        await query.edit_message_text(config_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
    except telegram.error.BadRequest as e:
        # 忽略"消息未修改"错误
        if "Message is not modified" in str(e):
            pass
        else:
            # 如果是其他错误（可能是 HTML 格式问题），发送纯文本
            _interface.logger.error(f"发送 AI 配置信息失败: {e}")
            await query.edit_message_text("发送配置信息失败，请联系管理员查看日志",
                                          reply_markup=reply_markup)
    except Exception as e:
        # 处理其他异常
        _interface.logger.error(f"发送 AI 配置信息失败: {e}")
        await query.edit_message_text("发送配置信息失败，请联系管理员查看日志",
                                      reply_markup=reply_markup)


class ConfigHandler:
    """配置命令处理器"""

    @staticmethod
    async def show_config(update: Update,
                          context: ContextTypes.DEFAULT_TYPE) -> None:
        """显示当前 AI 配置（旧版本，保留兼容性）"""
        # 直接调用新的基于按钮的配置界面
        await show_config_main_menu(update, context)

    @staticmethod
    async def show_stats(update: Update,
                         context: ContextTypes.DEFAULT_TYPE) -> None:
        """显示 AI 使用统计"""
        global _state
        # 获取消息对象（可能是新消息或编辑的消息）
        message = update.message or update.edited_message

        stats = _state["usage_stats"]

        stats_text = "<b>📊 AI 使用统计</b>\n\n"

        # 总请求数
        stats_text += f"<b>总请求数:</b> <code>{stats.get('total_requests', 0)}</code>\n\n"

        # 按服务商统计
        stats_text += "<b>按服务商统计:</b>\n"
        if not stats.get('requests_by_provider'):
            stats_text += "<i>暂无数据</i>\n"
        else:
            for provider, count in stats.get('requests_by_provider',
                                             {}).items():
                provider_name = _state["providers"].get(provider, {}).get(
                    "name",
                    provider) if provider in _state["providers"] else provider
                stats_text += f"• <code>{provider}</code> ({provider_name}): <code>{count}</code>\n"

        # 按用户统计 (仅显示前 10 位活跃用户)
        stats_text += "\n<b>按用户统计 (前 10 位):</b>\n"
        if not stats.get('requests_by_user'):
            stats_text += "<i>暂无数据</i>\n"
        else:
            # 按使用量排序
            sorted_users = sorted(stats.get('requests_by_user', {}).items(),
                                  key=lambda x: x[1],
                                  reverse=True)[:10]

            for user_id, count in sorted_users:
                stats_text += f"• 用户 <code>{user_id}</code>: <code>{count}</code> 次请求\n"

        try:
            await message.reply_text(stats_text, parse_mode="HTML")
        except Exception as e:
            _interface.logger.error(f"发送 AI 统计信息失败: {e}")
            await message.reply_text("发送统计信息失败，请联系管理员查看日志")


# 命令处理函数


async def ai_config_command(update: Update,
                            context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiconfig 命令 - 配置 AI 设置（使用按钮和会话）"""
    global _state

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否是私聊
    if update.effective_chat.type != "private":
        await message.reply_text("⚠️ 出于安全考虑，AI 配置只能在私聊中进行")
        return

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await message.reply_text("⚠️ 系统错误：无法获取会话管理器")
        return

    # 清除之前的会话状态（如果有）
    await session_manager.clear(user_id, chat_id=chat_id)

    # 显示主菜单
    await show_config_main_menu(update, context)


async def ai_whitelist_command(update: Update,
                               context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiwhitelist 命令 - 管理 AI 白名单"""
    global _state

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查是否是回复某人的消息
    if message.reply_to_message and message.reply_to_message.from_user:
        user_id = message.reply_to_message.from_user.id
        user_id_str = str(user_id)
        username = message.reply_to_message.from_user.username or "未知用户名"
        full_name = message.reply_to_message.from_user.full_name or "未知姓名"

        # 检查用户是否已在白名单中
        if user_id_str in _state["whitelist"]:
            safe_username = username.replace('.', '\\.').replace('-', '\\-')
            await message.reply_text(
                f"用户 `{user_id}` (@{safe_username}) 已在白名单中",
                parse_mode="MARKDOWN")
            return

        # 添加到白名单
        _state["whitelist"][user_id_str] = {
            "username": username,
            "added_at": time.time()
        }

        # 保存配置
        save_config()

        safe_username = username.replace('.', '\\.').replace('-', '\\-')
        safe_full_name = full_name.replace('.', '\\.').replace('-', '\\-')
        await message.reply_text(
            f"✅ 已将用户 `{user_id}` (@{safe_username}, {safe_full_name}) 添加到白名单",
            parse_mode="MARKDOWN")
        _interface.logger.info(
            f"用户 {update.effective_user.id} 将用户 {user_id} (@{username}) 添加到 AI 白名单"
        )
    else:
        # 如果不是回复消息，则显示白名单管理界面
        await show_whitelist_menu(update, context)


async def ai_clear_command(update: Update,
                           context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiclear 命令 - 清除对话上下文"""
    user_id = update.effective_user.id

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查权限 - 仅超级管理员和白名单用户可用
    if not AIManager.is_user_authorized(user_id, context):
        await message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 清除上下文
    if ConversationManager.clear_context(user_id):
        await message.reply_text("✅ 已清除您的对话历史")
        _interface.logger.info(f"用户 {user_id} 清除了对话历史")
    else:
        await message.reply_text("您还没有任何对话历史")


async def ai_command(update: Update,
                     context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /ai 命令 - 向 AI 发送消息"""
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查权限 - 仅超级管理员和白名单用户可用
    if not AIManager.is_user_authorized(user_id, context):
        await message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 获取回复的消息（如果有）
    replied_message = message.reply_to_message

    # 初始化消息文本和图像列表
    message_text = ""
    images = []

    # 检查是否有命令参数
    if context.args:
        # 获取命令参数作为消息内容
        message_text = " ".join(context.args)

    # 检查是否回复了消息
    if replied_message:
        # 如果回复的消息有文本，添加到消息内容
        if replied_message.text or replied_message.caption:
            replied_text = replied_message.text or replied_message.caption
            # 如果已经有命令参数，则将回复的文本作为上下文
            if message_text:
                message_text = f"{message_text}\n\n引用内容：\n{replied_text}"
            else:
                message_text = replied_text

        # 如果回复的消息有图片，处理图片
        if replied_message.photo:
            # 检查默认服务商
            provider_id = _state["default_provider"]
            if not provider_id or provider_id not in _state["providers"]:
                await message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
                _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
                return

            # 检查服务商是否支持图像
            provider = _state["providers"].get(provider_id, {})
            if provider.get("supports_image", False):
                # 获取最大尺寸的图像
                photo = replied_message.photo[-1]
                photo_file = await context.bot.get_file(photo.file_id)

                # 处理图像
                image_data = await AIManager.process_image(photo_file)
                if image_data:
                    images.append(image_data)
                    # 不再显示"已添加图片"的提示
            else:
                await message.reply_text("⚠️ 当前服务商不支持图像处理")
                return

    # 如果没有消息内容（既没有命令参数也没有回复消息），显示帮助信息
    if not message_text and not images:
        await message.reply_text(
            "请输入要发送给 AI 的消息或回复一条消息\n"
            "例如: `/ai 你好，请介绍一下自己`\n\n"
            "🔄 使用 /aiclear 可清除对话历史\n"
            "📷 可以回复图片消息让 AI 分析图像内容",
            parse_mode="MARKDOWN")
        return

    # 如果只有图片没有文字，添加默认提示
    if not message_text and images:
        message_text = "请分析这张图片"

    # 检查消息长度
    if len(message_text) > MAX_MESSAGE_LENGTH:
        await message.reply_text(f"⚠️ 消息太长，请将长度控制在 {MAX_MESSAGE_LENGTH} 字符以内")
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 发送"正在思考"消息
    thinking_message = await message.reply_text("🤔 正在思考中...")

    # 添加用户消息到上下文
    ConversationManager.add_message(user_id, "user", message_text)

    # 准备 API 请求
    messages = ConversationManager.format_for_api(provider_id, user_id)

    # 完整响应变量
    full_response = ""

    # 创建流式更新回调函数
    async def update_message_callback(text):
        nonlocal full_response
        try:
            # 确保文本不为空
            if not text.strip():
                return

            full_response = text

            # 如果文本太长，只显示最后部分
            if len(text) <= MAX_MESSAGE_LENGTH:
                try:
                    await thinking_message.edit_text(text)
                except telegram.error.BadRequest as e:
                    # 忽略"消息未修改"错误
                    if "Message is not modified" not in str(e):
                        _interface.logger.error(f"更新消息失败: {str(e)}")
            else:
                # 如果消息超长，只更新最后部分
                try:
                    await thinking_message.edit_text(text[-MAX_MESSAGE_LENGTH:]
                                                     )
                except telegram.error.BadRequest as e:
                    # 忽略"消息未修改"错误
                    if "Message is not modified" not in str(e):
                        _interface.logger.error(f"更新消息失败: {str(e)}")

        except Exception as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新消息失败: {str(e)}")

    # 调用流式 AI API
    response = await AIManager.call_ai_api(provider_id, messages, images, True,
                                           update_message_callback)

    # 添加 AI 回复到上下文
    ConversationManager.add_message(user_id, "assistant", response)

    # 流式传输完成后，尝试将最终消息转换为 HTML 格式
    try:
        # 转换为 HTML 格式
        html_response = TextFormatter.markdown_to_html(response)

        # 检查长度
        if len(html_response) <= MAX_MESSAGE_LENGTH:
            try:
                # 直接更新原消息为 HTML 格式
                await thinking_message.edit_text(html_response,
                                                 parse_mode="HTML")
            except telegram.error.BadRequest as e:
                # 忽略"消息未修改"错误
                if "Message is not modified" not in str(e):
                    _interface.logger.error(f"转换为 HTML 格式失败: {str(e)}")
        else:
            # 如果 HTML 太长，需要分段发送
            # 先删除原消息
            await thinking_message.delete()

            # 分段发送 HTML
            parts = []
            for i in range(0, len(html_response), MAX_MESSAGE_LENGTH):
                parts.append(html_response[i:i + MAX_MESSAGE_LENGTH])

            _interface.logger.info(f"消息过长，将分为 {len(parts)} 段发送")

            # 发送第一段
            first_message = await message.reply_text(parts[0],
                                                     parse_mode="HTML")

            # 发送剩余段落
            for part in parts[1:]:
                await first_message.reply_text(part, parse_mode="HTML")

    except Exception as e:
        _interface.logger.error(f"转换为 HTML 格式失败: {e}")
        # 如果转换失败，保留原始纯文本消息
        # 不需要额外操作，因为流式更新已经显示了完整的纯文本响应

    _interface.logger.info(f"用户 {user_id} 使用 {provider_id} 服务商获得了 AI 回复")


async def handle_config_input(update: Update,
                              context: ContextTypes.DEFAULT_TYPE,
                              waiting_for: str) -> None:
    """处理配置过程中的用户输入"""
    global _state
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id
    message = update.message
    message_text = message.text

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await message.reply_text("⚠️ 系统错误：无法获取会话管理器")
        return

    # 处理不同类型的输入
    if waiting_for == "provider_id":
        # 处理新服务商 ID 输入
        provider_id = message_text.strip()

        # 验证 ID 格式
        if not re.match(r'^[a-zA-Z0-9_]+$', provider_id):
            await message.reply_text("⚠️ 服务商 ID 只能包含字母、数字和下划线，请重新输入：")
            return

        # 检查 ID 是否已存在
        if provider_id in _state["providers"]:
            await message.reply_text(
                f"⚠️ 服务商 ID `{provider_id}` 已存在，请使用其他 ID：",
                parse_mode="MARKDOWN")
            return

        # 获取选择的模板
        template_id = await session_manager.get(user_id,
                                                "selected_template",
                                                "custom",
                                                chat_id=chat_id)

        # 创建新服务商
        _state["providers"][provider_id] = PROVIDER_TEMPLATES[
            template_id].copy()
        _state["providers"][provider_id]["name"] = provider_id

        # 如果没有默认服务商，设置为默认
        if not _state["default_provider"]:
            _state["default_provider"] = provider_id

        # 保存配置
        save_config()

        # 清除等待状态
        await session_manager.delete(user_id,
                                     "ai_waiting_for",
                                     chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "selected_template",
                                     chat_id=chat_id)

        # 发送成功消息并直接显示编辑菜单
        await message.reply_text(
            f"✅ 已创建新服务商: `{provider_id}` ({template_id} 模板)\n\n"
            f"请编辑服务商的详细配置：",
            parse_mode="MARKDOWN")

        # 直接显示编辑菜单
        await show_provider_edit_menu(update, context, provider_id)

    elif waiting_for.startswith("edit_param_"):
        # 处理编辑参数输入
        parts = waiting_for.split("_")

        # 如果参数名称包含下划线，需要重新组合
        if len(parts) > 4:
            # 重新组合参数名称（从索引3开始到最后）
            parts = parts[:3] + ["_".join(parts[3:])]

        # 记录操作日志
        _interface.logger.debug(f"处理编辑参数输入: waiting_for={waiting_for}")

        # 确保格式正确
        if len(parts) >= 4:
            provider_id = parts[2]
            param_name = parts[3]

            # 验证服务商是否存在
            if provider_id not in _state["providers"]:
                await message.reply_text(f"⚠️ 服务商 `{provider_id}` 不存在",
                                         parse_mode="MARKDOWN")
                await session_manager.delete(user_id,
                                             "ai_waiting_for",
                                             chat_id=chat_id)
                await show_config_main_menu(update, context)
                return

            # 处理不同参数的输入
            if param_name == "temperature":
                # 验证温度值
                try:
                    value = float(message_text)
                    if not (0.0 <= value <= 1.0):
                        await message.reply_text(
                            "⚠️ 温度值必须在 0.0 到 1.0 之间，请重新输入：")
                        return
                except ValueError:
                    await message.reply_text("⚠️ 温度值必须是有效的浮点数，请重新输入：")
                    return

            elif param_name == "supports_image":
                # 转换为布尔值
                value = message_text.lower() in [
                    "true", "yes", "1", "y", "t", "是", "支持"
                ]

            else:
                # 其他参数直接使用输入值
                value = message_text

            # 更新参数
            _state["providers"][provider_id][param_name] = value

            # 保存配置
            save_config()

            # 清除等待状态
            await session_manager.delete(user_id,
                                         "ai_waiting_for",
                                         chat_id=chat_id)

            # 发送成功消息
            await message.reply_text(
                f"✅ 已更新服务商 `{provider_id}` 的 `{param_name}` 参数",
                parse_mode="MARKDOWN")

            # 直接返回编辑菜单，不需要再次选择服务商
            await show_provider_edit_menu(update, context, provider_id)
        else:
            # 格式错误
            _interface.logger.warning(f"编辑参数输入格式错误: {waiting_for}")
            await message.reply_text("⚠️ 参数格式错误，已取消操作")
            await session_manager.delete(user_id,
                                         "ai_waiting_for",
                                         chat_id=chat_id)
            await show_config_main_menu(update, context)

    elif waiting_for == "whitelist_add_user_id":
        # 处理添加白名单用户 ID 输入
        try:
            user_id_to_add = int(message_text)
            user_id_str = str(user_id_to_add)

            # 检查用户是否已在白名单中
            if user_id_str in _state["whitelist"]:
                # 清除等待状态
                await session_manager.delete(user_id,
                                             "ai_waiting_for",
                                             chat_id=chat_id)

                # 发送带有返回按钮的消息
                await message.reply_text(
                    f"用户 `{user_id_to_add}` 已在白名单中",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}_whitelist")
                    ]]),
                    parse_mode="MARKDOWN")
            else:
                # 尝试获取用户信息
                try:
                    # 使用全局接口获取机器人实例
                    bot = context.bot
                    chat = await bot.get_chat(user_id_to_add)
                    username = chat.username or "未知用户名"
                except Exception:
                    # 如果无法获取用户信息，使用默认值
                    username = "未知用户名"

                # 添加到白名单
                _state["whitelist"][user_id_str] = {
                    "username": username,
                    "added_at": time.time()
                }

                # 保存配置
                save_config()

                # 清除等待状态
                await session_manager.delete(user_id,
                                             "ai_waiting_for",
                                             chat_id=chat_id)

                # 发送带有返回按钮的确认消息
                await message.reply_text(
                    f"✅ 已将用户 `{user_id_to_add}` 添加到白名单",
                    reply_markup=InlineKeyboardMarkup([[
                        InlineKeyboardButton(
                            "⇠ Back",
                            callback_data=f"{CALLBACK_PREFIX}_whitelist")
                    ]]),
                    parse_mode="MARKDOWN")

                # 记录日志
                _interface.logger.info(
                    f"用户 {user_id} 在聊天 {chat_id} 中将用户 {user_id_to_add} 添加到 AI 白名单"
                )

        except ValueError:
            # 不清除会话状态，让用户可以重新输入
            await message.reply_text("⚠️ 用户 ID 必须是数字，请重新输入：\n\n",
                                     parse_mode="HTML")
            return

    else:
        # 未知的等待状态
        await message.reply_text("⚠️ 未知的输入状态，已取消操作")
        await session_manager.delete(user_id,
                                     "ai_waiting_for",
                                     chat_id=chat_id)
        await show_config_main_menu(update, context)


async def handle_private_message(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理私聊消息，直接回复 AI 回答"""
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 如果是编辑的消息，不处理
    if update.edited_message:
        return

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        return

    # 检查是否在等待用户输入
    waiting_for = await session_manager.get(user_id,
                                            "ai_waiting_for",
                                            None,
                                            chat_id=chat_id)

    # 如果正在等待用户输入，处理用户输入
    if waiting_for:
        # 处理用户输入
        await handle_config_input(update, context, waiting_for)
        return

    # 检查权限 - 仅超级管理员和白名单用户可用
    if not AIManager.is_user_authorized(user_id, context):
        # 不回复非白名单用户
        return

    # 检查是否有其他模块的活跃会话
    has_other_session = False
    if session_manager:
        # 获取用户在当前聊天中的所有会话数据
        user_sessions = await session_manager.get_all(user_id, chat_id=chat_id)
        # 检查是否有其他模块的会话（不是 ai_ 前缀的键）
        for key in user_sessions:
            if not key.startswith("ai_") and key != "last_activity":
                has_other_session = True
                break

    # 如果有其他模块的活跃会话，不处理消息
    if has_other_session:
        return

    # 获取消息内容
    message_text = message.text

    # 初始化图像列表
    images = []

    # 检查是否回复了消息
    replied_message = message.reply_to_message
    if replied_message:
        # 如果回复的消息有文本，添加到消息内容
        if replied_message.text or replied_message.caption:
            replied_text = replied_message.text or replied_message.caption
            # 将回复的文本作为上下文
            message_text = f"{message_text}\n\n引用内容：\n{replied_text}"

        # 如果回复的消息有图片，处理图片
        if replied_message.photo:
            # 检查默认服务商
            provider_id = _state["default_provider"]
            if not provider_id or provider_id not in _state["providers"]:
                await message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
                _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
                return

            # 检查服务商是否支持图像
            provider = _state["providers"].get(provider_id, {})
            if provider.get("supports_image", False):
                # 获取最大尺寸的图像
                photo = replied_message.photo[-1]
                photo_file = await context.bot.get_file(photo.file_id)

                # 处理图像
                image_data = await AIManager.process_image(photo_file)
                if image_data:
                    images.append(image_data)
                    # 不显示"已添加图片"的提示
            else:
                await message.reply_text("⚠️ 当前服务商不支持图像处理")
                return

    # 检查消息长度
    if len(message_text) > MAX_MESSAGE_LENGTH:
        await message.reply_text(f"⚠️ 消息太长，请将长度控制在 {MAX_MESSAGE_LENGTH} 字符以内")
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 设置 AI 模块的会话状态，表示正在处理消息
    await session_manager.set(user_id, "ai_active", True, chat_id=chat_id)
    await session_manager.set(user_id,
                              "ai_start_time",
                              time.time(),
                              chat_id=chat_id)

    # 检查消息本身是否包含图像
    if message.photo:
        provider = _state["providers"].get(provider_id, {})
        if provider.get("supports_image", False):
            # 获取最大尺寸的图像
            photo = message.photo[-1]
            photo_file = await context.bot.get_file(photo.file_id)

            # 处理图像
            image_data = await AIManager.process_image(photo_file)
            if image_data:
                images.append(image_data)
                # 不发送确认消息，保持对话流畅
        else:
            await message.reply_text("⚠️ 当前服务商不支持图像处理")
            # 清除会话状态
            await session_manager.delete(user_id, "ai_active", chat_id=chat_id)
            return

    try:
        # 发送"正在思考"消息
        thinking_message = await message.reply_text("🤔 正在思考中...")

        # 添加用户消息到上下文
        ConversationManager.add_message(user_id, "user", message_text)

        # 准备 API 请求
        messages = ConversationManager.format_for_api(provider_id, user_id)

        # 创建一个异步任务来处理 AI 请求，不等待它完成
        # 这样可以立即释放会话状态，不会阻塞其他命令
        asyncio.create_task(
            AIManager.process_ai_response(provider_id, messages, images,
                                          thinking_message, user_id))

        # 注意：这里不等待任务完成，立即返回
    finally:
        # 在创建任务后立即清除会话状态
        # 这样其他命令可以立即处理，不需要等待 AI 响应
        # 注意：这意味着在 AI 响应过程中，其他模块可能会处理消息
        await session_manager.delete(user_id, "ai_active", chat_id=chat_id)

    # 注意：HTML 格式转换现在在 process_ai_response 方法中处理

    _interface.logger.info(f"用户 {user_id} 在聊天 {chat_id} 中获得了 AI 回复")


async def handle_private_photo(update: Update,
                               context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理私聊中的图片消息"""
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 如果是编辑的消息，不处理
    if update.edited_message:
        return

    # 检查权限 - 仅超级管理员和白名单用户可用
    if not AIManager.is_user_authorized(user_id, context):
        # 不回复非白名单用户
        return

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        return

    # 检查是否在等待用户输入
    waiting_for = await session_manager.get(user_id,
                                            "ai_waiting_for",
                                            None,
                                            chat_id=chat_id)

    # 如果正在等待输入，不处理图片消息
    if waiting_for:
        return

    # 检查是否有其他模块的活跃会话
    has_other_session = False
    if session_manager:
        # 获取用户在当前聊天中的所有会话数据
        user_sessions = await session_manager.get_all(user_id, chat_id=chat_id)
        # 检查是否有其他模块的会话（不是 ai_ 前缀的键）
        for key in user_sessions:
            if not key.startswith("ai_") and key != "last_activity":
                has_other_session = True
                break

    # 如果有其他模块的活跃会话，不处理消息
    if has_other_session:
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await update.message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 设置 AI 模块的会话状态，表示正在处理消息
    await session_manager.set(user_id, "ai_active", True, chat_id=chat_id)
    await session_manager.set(user_id,
                              "ai_start_time",
                              time.time(),
                              chat_id=chat_id)

    # 检查服务商是否支持图像
    provider = _state["providers"].get(provider_id, {})
    if not provider.get("supports_image", False):
        await update.message.reply_text("⚠️ 当前服务商不支持图像处理")
        # 清除会话状态
        await session_manager.delete(user_id, "ai_active", chat_id=chat_id)
        return

    # 获取图像
    photo = update.message.photo[-1]  # 最大尺寸的图像
    photo_file = await context.bot.get_file(photo.file_id)

    # 处理图像
    image_data = await AIManager.process_image(photo_file)
    if not image_data:
        await update.message.reply_text("❌ 处理图像失败")
        # 清除会话状态
        await session_manager.delete(user_id, "ai_active", chat_id=chat_id)
        return

    # 获取消息文本(如果有)
    message_text = update.message.caption or "分析这张图片"

    # 检查是否回复了消息
    replied_message = update.message.reply_to_message
    if replied_message:
        # 如果回复的消息有文本，添加到消息内容
        if replied_message.text or replied_message.caption:
            replied_text = replied_message.text or replied_message.caption
            # 将回复的文本作为上下文
            if message_text == "分析这张图片":  # 如果是默认文本，直接替换
                message_text = replied_text
            else:  # 否则添加为引用
                message_text = f"{message_text}\n\n引用内容：\n{replied_text}"

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🖼️ 正在分析图像...")

    # 添加用户消息到上下文
    ConversationManager.add_message(user_id, "user", message_text)

    # 准备 API 请求
    messages = ConversationManager.format_for_api(provider_id, user_id)

    # 注意：回调函数现在在 process_ai_response 方法中定义

    try:
        # 创建一个异步任务来处理 AI 请求，不等待它完成
        # 这样可以立即释放会话状态，不会阻塞其他命令
        asyncio.create_task(
            AIManager.process_ai_response(provider_id, messages, [image_data],
                                          thinking_message, user_id))

        # 注意：这里不等待任务完成，立即返回
    finally:
        # 在创建任务后立即清除会话状态
        await session_manager.delete(user_id, "ai_active", chat_id=chat_id)

    # 注意：HTML 格式转换现在在 process_ai_response 方法中处理

    _interface.logger.info(f"用户 {user_id} 在聊天 {chat_id} 中获得了图像分析回复")


async def handle_config_message(update: Update,
                                context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理配置相关的消息（主要用于群聊中的白名单配置）"""
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取消息对象（可能是新消息或编辑的消息）
    # 在后续代码中使用 update.message 而不是单独的变量

    # 如果是编辑的消息，不处理
    if update.edited_message:
        return

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        return

    # 检查是否在等待用户输入
    waiting_for = await session_manager.get(user_id,
                                            "ai_waiting_for",
                                            None,
                                            chat_id=chat_id)

    # 如果正在等待用户输入，处理用户输入
    if waiting_for:
        # 检查是否是超级管理员
        if not AIManager.is_super_admin(user_id, context):
            # 非超级管理员不能配置白名单
            return

        # 处理用户输入
        await handle_config_input(update, context, waiting_for)

    # 如果没有等待用户输入或处理完毕，不做其他处理


# 配置和状态管理函数


def save_config() -> None:
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

    os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

    try:
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(config_to_save, f, ensure_ascii=False, indent=2)
    except Exception as e:
        if _interface:
            _interface.logger.error(f"保存 AI 配置失败: {e}")


def load_config() -> None:
    """加载 AI 配置"""
    global _state

    if not os.path.exists(CONFIG_FILE):
        # 初始化空结构
        _state["providers"] = {}
        _state["whitelist"] = {}  # 使用字典结构存储白名单
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
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            config = json.load(f)

            # 加载提供商配置
            if "providers" in config:
                _state["providers"] = config["providers"]

            # 加载白名单（确保是字典格式）
            if "whitelist" in config:
                if isinstance(config["whitelist"], dict):
                    _state["whitelist"] = config["whitelist"]
                else:
                    # 如果不是字典格式，初始化为空字典
                    _state["whitelist"] = {}
                    # 保存新格式
                    save_config()
            else:
                # 如果配置中没有白名单，初始化为空字典
                _state["whitelist"] = {}

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
        if _interface:
            _interface.logger.error(f"加载 AI 配置失败: {e}")


def save_contexts() -> None:
    """保存所有用户的对话上下文"""
    try:
        # 使用框架的状态管理保存对话上下文
        if _interface:
            # 保存对话上下文到状态
            _interface.save_state({"conversations": _state["conversations"]})

        # 更新保存时间
        _state["last_save_time"] = time.time()
    except Exception as e:
        if _interface:
            _interface.logger.error(f"保存对话上下文失败: {e}")


def load_contexts() -> None:
    """加载所有用户的对话上下文"""
    global _state

    try:
        # 使用框架的状态管理加载对话上下文
        if _interface:
            # 加载对话上下文
            state = _interface.load_state(default={"conversations": {}})
            _state["conversations"] = state.get("conversations", {})
    except Exception as e:
        if _interface:
            _interface.logger.error(f"加载对话上下文失败: {e}")


# 模块状态管理函数


async def setup(module_interface):
    """模块初始化"""
    global _interface, _state
    _interface = module_interface

    # 初始化请求锁
    _state["request_lock"] = asyncio.Lock()

    # 加载配置文件（从 config 目录）和用户对话上下文
    load_config()
    load_contexts()

    # 注册命令
    await module_interface.register_command("aiconfig",
                                            ai_config_command,
                                            admin_level="super_admin",
                                            description="配置 AI 设置")

    await module_interface.register_command("aiwhitelist",
                                            ai_whitelist_command,
                                            admin_level="super_admin",
                                            description="管理 AI 白名单")

    await module_interface.register_command("aiclear",
                                            ai_clear_command,
                                            admin_level=False,
                                            description="清除 AI 对话历史")

    await module_interface.register_command("ai",
                                            ai_command,
                                            admin_level=False,
                                            description="与 AI 进行对话")

    # 注册私聊消息处理器
    text_handler = MessageHandler(
        filters.TEXT & filters.ChatType.PRIVATE & ~filters.COMMAND
        & ~filters.Regex(r'^/'), handle_private_message)
    await module_interface.register_handler(text_handler)

    # 注册私聊图片处理器
    photo_handler = MessageHandler(filters.PHOTO & filters.ChatType.PRIVATE,
                                   handle_private_photo)
    await module_interface.register_handler(photo_handler)

    # 注册配置输入处理器（用于处理群聊中的白名单配置）
    config_input_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/'),
        handle_config_message)
    await module_interface.register_handler(config_input_handler, group=0)

    # 注册配置按钮回调处理器（带权限验证）
    await module_interface.register_callback_handler(
        handle_config_callback,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level="super_admin")

    # 设置定期任务
    async def _periodic_tasks():
        while True:
            try:
                # 每小时检查一次过期对话
                await asyncio.sleep(3600)
                expired_count = ConversationManager.cleanup_expired()
                if expired_count > 0:
                    _interface.logger.info(f"已清理 {expired_count} 个过期对话")

                # 保存用户对话上下文
                save_contexts()
            except Exception as e:
                _interface.logger.error(f"定期任务执行失败: {str(e)}")

    # 启动定期任务
    module_interface.periodic_task = asyncio.create_task(_periodic_tasks())

    _interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(module_interface):
    """模块清理"""
    # 取消定期任务
    if hasattr(module_interface,
               'periodic_task') and module_interface.periodic_task:
        module_interface.periodic_task.cancel()

    # 保存用户对话上下文
    save_contexts()

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
