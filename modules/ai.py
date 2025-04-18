# modules/ai.py - AI 聊天助手

import os
import json
import time
import asyncio
import aiohttp
import base64
import telegram
from typing import Dict, List, Optional, Any, Tuple, Callable, Union
from utils.formatter import TextFormatter
from telegram import Update, File
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "ai"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "支持多种 AI 的聊天助手"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["ai", "aiconfig", "aiclear", "aiwhitelist"]

# 模块接口引用
_interface = None

# 配置文件路径
CONFIG_FILE = "config/ai_config.json"
CONTEXT_FILE = "data/ai_contexts.json"

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
        "model": "gpt-4.1-nano",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "openai",
        "supports_image": True
    },
    "gemini": {
        "name": "Gemini",
        "api_url":
        "https://generativelanguage.googleapis.com/v1/models/{model}:generateContent",
        "api_key": "",
        "model": "gemini-2.0-flash",
        "temperature": 0.7,
        "system_prompt": "你是一个有用的助手。",
        "request_format": "gemini",
        "supports_image": True
    },
    "anthropic": {
        "name": "Claude",
        "api_url": "https://api.anthropic.com/v1/messages",
        "api_key": "",
        "model": "claude-3-5-sonnet-latest",
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
    "whitelist": [],  # 白名单用户 ID
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
        elif request_format == "gemini":
            return GeminiProvider.format_request(provider, messages, images,
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
        elif request_format == "gemini":
            return GeminiProvider.parse_response(response_data)
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


class GeminiProvider:
    """Google Gemini 服务提供商实现"""

    @staticmethod
    def format_request(provider: Dict[str, Any],
                       messages: List[Dict[str, str]],
                       images: Optional[List[Dict[str, Any]]] = None,
                       stream: bool = False) -> Dict[str, Any]:
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
                user_parts = [{"text": content}]

                # 添加图像（如果有且是最后一条用户消息）
                if images and msg == messages[-1] and msg["role"] == "user":
                    for img in images:
                        user_parts.append({
                            "inline_data": {
                                "mime_type": "image/jpeg",
                                "data": img["data"]
                            }
                        })

                gemini_messages.append({"role": "user", "parts": user_parts})
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

    @staticmethod
    def parse_response(response_data: Dict[str, Any]) -> str:
        """解析 Gemini 响应"""
        try:
            return response_data["candidates"][0]["content"]["parts"][0][
                "text"]
        except (KeyError, IndexError) as e:
            _interface.logger.error(f"解析 Gemini 响应失败: {e}")
            return None

    @staticmethod
    async def process_stream(line: bytes, callback: Callable[[str], None],
                             full_response: str) -> str:
        """处理 Gemini 流式响应"""
        if not line.strip():
            return full_response

        try:
            json_data = json.loads(line)

            # 提取文本内容
            if 'candidates' in json_data and json_data['candidates']:
                candidate = json_data['candidates'][0]
                if 'content' in candidate and 'parts' in candidate['content']:
                    for part in candidate['content']['parts']:
                        if 'text' in part and part['text']:
                            content = part['text']
                            full_response += content

                            # 只有当有实际内容时才调用回调
                            if full_response.strip():
                                await callback(full_response)
        except Exception as e:
            _interface.logger.error(f"解析 Gemini 流式响应失败: {e}")

        return full_response


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

            # 流式模式
            if stream and update_callback:
                return await AIManager._stream_request(provider, api_url,
                                                       headers, request_data,
                                                       update_callback,
                                                       provider_id)

            # 非流式模式
            return await AIManager._standard_request(provider, api_url,
                                                     headers, request_data,
                                                     provider_id)

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
                        # OpenAI 流式响应处理
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

                                    # 处理流式响应行
                                    full_response = await GeminiProvider.process_stream(
                                        line,
                                        # 包装回调以控制更新频率
                                        lambda text: AIManager.
                                        _throttled_update(
                                            text, update_callback,
                                            last_update_time),
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
                           context: ContextTypes.DEFAULT_TYPE,
                           chat_type: str = None) -> bool:
        """检查用户是否有权使用 AI 功能
        
        Args:
            user_id: 用户 ID
            context: 上下文对象
            chat_type: 聊天类型
            
        Returns:
            bool: 是否有权限
        """
        global _state

        # 超级管理员总是可以使用
        config_manager = context.bot_data.get("config_manager")
        if config_manager and config_manager.is_admin(user_id):
            return True

        # 白名单用户可以使用
        if user_id in _state["whitelist"]:
            return True

        # 其他用户不能使用
        return False

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


class ConfigHandler:
    """配置命令处理器"""

    @staticmethod
    async def show_config(update: Update,
                          context: ContextTypes.DEFAULT_TYPE) -> None:
        """显示当前 AI 配置"""
        global _state

        # 构建配置信息（使用 HTML 格式）
        config_text = "<b>🤖 AI 配置面板</b>\n\n"

        # 默认服务商
        default_provider = _state["default_provider"]
        if default_provider and default_provider in _state["providers"]:
            provider_name = _state["providers"][default_provider].get(
                "name", default_provider)
            config_text += f"<b>当前默认服务商:</b> <code>{default_provider}</code> ({provider_name})\n\n"
        else:
            config_text += f"<b>当前默认服务商:</b> <i>未设置</i>\n\n"

        # 对话超时设置
        timeout_hours = _state.get("conversation_timeout",
                                   24 * 60 * 60) // 3600
        config_text += f"<b>对话超时时间:</b> <code>{timeout_hours}</code> 小时\n\n"

        # 服务商列表
        config_text += "<b>已配置的服务商:</b>\n"

        if not _state["providers"]:
            config_text += "<i>暂无服务商配置，请使用</i> <code>/aiconfig new</code> <i>创建服务商</i>\n"
        else:
            # 检查是否有完全配置的服务商（有 API 密钥的）
            configured_providers = [
                p for p, data in _state["providers"].items()
                if data.get("api_key")
            ]

            if not configured_providers:
                config_text += "<i>已创建服务商，但尚未配置 API 密钥。请使用</i> <code>/aiconfig provider &lt;ID&gt; api_key YOUR_KEY</code> <i>配置</i>\n\n"

            # 显示所有服务商
            for provider_id, provider in _state["providers"].items():
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

        # 添加使用说明
        config_text += "\n<b>📚 配置命令:</b>\n"
        config_text += "• <code>/aiconfig provider &lt;ID&gt; &lt;参数&gt; &lt;值&gt;</code> - 配置服务商参数\n"
        config_text += "• <code>/aiconfig new &lt;ID&gt; [模板]</code> - 创建新服务商\n"
        config_text += "• <code>/aiconfig default &lt;ID&gt;</code> - 设置默认服务商\n"
        config_text += "• <code>/aiconfig delete &lt;ID&gt;</code> - 删除服务商\n"
        config_text += "• <code>/aiconfig test &lt;ID&gt;</code> - 测试服务商\n"
        config_text += "• <code>/aiconfig stats</code> - 查看使用统计\n"
        config_text += "• <code>/aiconfig timeout &lt;小时数&gt;</code> - 设置对话超时时间\n"

        try:
            await update.message.reply_text(config_text, parse_mode="HTML")
        except Exception as e:
            # 如果发送失败（可能是 HTML 格式问题），发送纯文本
            _interface.logger.error(f"发送 AI 配置信息失败: {e}")
            await update.message.reply_text("发送配置信息失败，请联系管理员查看日志")

    @staticmethod
    async def show_stats(update: Update,
                         context: ContextTypes.DEFAULT_TYPE) -> None:
        """显示 AI 使用统计"""
        global _state

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

        # 按用户统计 (仅显示前10位活跃用户)
        stats_text += "\n<b>按用户统计 (前10位):</b>\n"
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
            await update.message.reply_text(stats_text, parse_mode="HTML")
        except Exception as e:
            _interface.logger.error(f"发送 AI 统计信息失败: {e}")
            await update.message.reply_text("发送统计信息失败，请联系管理员查看日志")

    @staticmethod
    async def show_whitelist(update: Update,
                             context: ContextTypes.DEFAULT_TYPE) -> None:
        """显示当前 AI 白名单"""
        global _state

        whitelist_text = "<b>👥 AI 白名单用户</b>\n\n"

        if not _state["whitelist"]:
            whitelist_text += "<i>白名单为空</i>\n"
        else:
            for i, user_id in enumerate(_state["whitelist"], 1):
                whitelist_text += f"{i}. <code>{user_id}</code>\n"

        whitelist_text += "\n<b>📚 白名单管理命令:</b>\n"
        whitelist_text += "• <code>/aiwhitelist add &lt;用户ID&gt;</code> - 添加用户到白名单\n"
        whitelist_text += "• <code>/aiwhitelist remove &lt;用户ID&gt;</code> - 从白名单中移除用户\n"
        whitelist_text += "• <code>/aiwhitelist clear</code> - 清空白名单\n"
        whitelist_text += "\n💡 提示：回复用户消息并使用 <code>/aiwhitelist add</code> 可快速添加该用户\n"

        try:
            await update.message.reply_text(whitelist_text, parse_mode="HTML")
        except Exception as e:
            _interface.logger.error(f"发送 AI 白名单信息失败: {e}")
            await update.message.reply_text("发送白名单信息失败，请联系管理员查看日志")


# 命令处理函数


async def ai_config_command(update: Update,
                            context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiconfig 命令 - 配置 AI 设置"""
    global _state

    # 检查是否是私聊
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ 出于安全考虑，AI 配置只能在私聊中进行")
        return

    # 解析参数
    if not context.args:
        # 显示当前配置
        await ConfigHandler.show_config(update, context)
        return

    # 配置命令格式: /aiconfig <操作> [参数...]
    operation = context.args[0].lower()

    if operation == "provider":
        # 配置服务商: /aiconfig provider <provider_id> <参数> <值>
        if len(context.args) < 4:
            await update.message.reply_text(
                "用法: `/aiconfig provider <provider_id> <参数> <值>`\n"
                "参数可以是: name, api\\_url, api\\_key, model, temperature, system\\_prompt, request\\_format, supports\\_image",
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
            "system_prompt", "request_format", "supports_image"
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

        # 特殊处理 supports_image (转换为布尔值)
        if param == "supports_image":
            value = value.lower() in ["true", "yes", "1", "y", "t"]

        # 更新参数
        _state["providers"][provider_id][param] = value

        # 保存配置
        save_config()

        await update.message.reply_text(
            f"✅ 已更新服务商 `{provider_id}` 的 `{param}` 参数", parse_mode="MARKDOWN")
        _interface.logger.info(
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
        _interface.logger.info(
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
        _interface.logger.info(
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
        _interface.logger.info(
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
            "role":
            "user",
            "content":
            "Hello, can you introduce yourself briefly?"
        }]

        # 调用 API
        response = await AIManager.call_ai_api(provider_id, test_messages)

        # 显示响应
        await update.message.reply_text(f"📝 测试结果:\n\n{response}")

        _interface.logger.info(
            f"用户 {update.effective_user.id} 测试了服务商 {provider_id}")

    elif operation == "stats":
        # 查看使用统计: /aiconfig stats
        await ConfigHandler.show_stats(update, context)

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
            _interface.logger.info(
                f"用户 {update.effective_user.id} 将对话超时时间设置为 {hours} 小时")
        except ValueError:
            await update.message.reply_text("小时数必须是有效的数字")

    else:
        # 未知操作
        await update.message.reply_text(
            f"未知操作: `{operation}`\n"
            "可用操作: provider, default, delete, new, test, stats, timeout",
            parse_mode="MARKDOWN")


async def ai_whitelist_command(update: Update,
                               context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiwhitelist 命令 - 管理 AI 白名单"""
    global _state

    if not context.args:
        # 显示当前白名单
        await ConfigHandler.show_whitelist(update, context)
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
            safe_username = username.replace('.', '\\.').replace('-', '\\-')
            await update.message.reply_text(
                f"用户 `{user_id}` (@{safe_username}) 已在白名单中",
                parse_mode="MARKDOWN")
            return

        # 添加到白名单
        _state["whitelist"].append(user_id)

        # 保存配置
        save_config()

        safe_username = username.replace('.', '\\.').replace('-', '\\-')
        safe_full_name = full_name.replace('.', '\\.').replace('-', '\\-')
        await update.message.reply_text(
            f"✅ 已将用户 `{user_id}` (@{safe_username}, {safe_full_name}) 添加到白名单",
            parse_mode="MARKDOWN")
        _interface.logger.info(
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
            _interface.logger.info(
                f"用户 {update.effective_user.id} 将用户 {user_id} 从 AI 白名单中移除")
        except ValueError:
            await update.message.reply_text("用户 ID 必须是数字")

    elif operation == "clear":
        # 清空白名单
        _state["whitelist"] = []

        # 保存配置
        save_config()

        await update.message.reply_text("✅ 已清空 AI 白名单")
        _interface.logger.info(f"用户 {update.effective_user.id} 清空了 AI 白名单")

    else:
        # 未知操作
        await update.message.reply_text(
            f"未知操作: `{operation}`\n"
            "可用操作: add, remove, clear",
            parse_mode="MARKDOWN")


async def ai_clear_command(update: Update,
                           context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /aiclear 命令 - 清除对话上下文"""
    user_id = update.effective_user.id

    # 检查权限
    if not AIManager.is_user_authorized(user_id, context,
                                        update.effective_chat.type):
        await update.message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 清除上下文
    if ConversationManager.clear_context(user_id):
        await update.message.reply_text("✅ 已清除您的对话历史")
        _interface.logger.info(f"用户 {user_id} 清除了对话历史")
    else:
        await update.message.reply_text("您还没有任何对话历史")


async def ai_command(update: Update,
                     context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理 /ai 命令 - 向 AI 发送消息"""
    user_id = update.effective_user.id

    # 检查权限
    if not AIManager.is_user_authorized(user_id, context,
                                        update.effective_chat.type):
        await update.message.reply_text("⚠️ 您没有使用 AI 功能的权限\n请联系管理员将您添加到白名单")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 功能但没有权限")
        return

    # 检查是否有消息内容
    if not context.args:
        await update.message.reply_text(
            "请输入要发送给 AI 的消息\n"
            "例如: `/ai 你好，请介绍一下自己`\n\n"
            "🔄 使用 `/aiclear` 可清除对话历史\n"
            "📷 在私聊中可以发送图片并附加文字描述使用多模态功能",
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
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 获取图像（如果有）
    replied_message = update.message.reply_to_message
    images = []

    if replied_message and replied_message.photo:
        # 如果回复的消息包含图像
        provider = _state["providers"].get(provider_id, {})
        if provider.get("supports_image", False):
            # 获取最大尺寸的图像
            photo = replied_message.photo[-1]
            photo_file = await context.bot.get_file(photo.file_id)

            # 处理图像
            image_data = await AIManager.process_image(photo_file)
            if image_data:
                images.append(image_data)
                await update.message.reply_text("📷 已添加图片到请求中")
        else:
            await update.message.reply_text("⚠️ 当前服务商不支持图像处理")

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🤔 正在思考中...")

    # 添加用户消息到上下文
    ConversationManager.add_message(user_id, "user", message_text)

    # 准备 API 请求
    messages = ConversationManager.format_for_api(provider_id, user_id)

    # 完整响应变量
    full_response = ""
    is_completed = False

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
            first_message = await update.message.reply_text(parts[0],
                                                            parse_mode="HTML")

            # 发送剩余段落
            for part in parts[1:]:
                await first_message.reply_text(part, parse_mode="HTML")

    except Exception as e:
        _interface.logger.error(f"转换为 HTML 格式失败: {e}")
        # 如果转换失败，保留原始纯文本消息
        # 不需要额外操作，因为流式更新已经显示了完整的纯文本响应

    _interface.logger.info(f"用户 {user_id} 使用 {provider_id} 服务商获得了 AI 回复")


async def handle_private_message(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理私聊消息，直接回复 AI 回答"""
    user_id = update.effective_user.id

    # 检查权限
    if not AIManager.is_user_authorized(user_id, context, "private"):
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
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 检查是否有图像
    images = []
    if update.message.photo:
        provider = _state["providers"].get(provider_id, {})
        if provider.get("supports_image", False):
            # 获取最大尺寸的图像
            photo = update.message.photo[-1]
            photo_file = await context.bot.get_file(photo.file_id)

            # 处理图像
            image_data = await AIManager.process_image(photo_file)
            if image_data:
                images.append(image_data)
                # 不发送确认消息，保持对话流畅
        else:
            await update.message.reply_text("⚠️ 当前服务商不支持图像处理")
            return

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🤔 正在思考中...")

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
                await thinking_message.edit_text(text)
            else:
                # 如果消息超长，只更新最后部分
                await thinking_message.edit_text(text[-MAX_MESSAGE_LENGTH:])

        except Exception as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新消息失败: {e}")

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
            first_message = await update.message.reply_text(parts[0],
                                                            parse_mode="HTML")

            # 发送剩余段落
            for part in parts[1:]:
                await first_message.reply_text(part, parse_mode="HTML")

    except Exception as e:
        _interface.logger.error(f"转换为 HTML 格式失败: {e}")
        # 如果转换失败，保留原始纯文本消息
        # 不需要额外操作，因为流式更新已经显示了完整的纯文本响应

    _interface.logger.info(f"用户 {user_id} 在私聊中获得了 AI 回复")


async def handle_private_photo(update: Update,
                               context: ContextTypes.DEFAULT_TYPE) -> None:
    """处理私聊中的图片消息"""
    user_id = update.effective_user.id

    # 检查权限
    if not AIManager.is_user_authorized(user_id, context, "private"):
        # 不回复非白名单用户
        return

    # 检查默认服务商
    provider_id = _state["default_provider"]
    if not provider_id or provider_id not in _state["providers"]:
        await update.message.reply_text("⚠️ 未配置默认 AI 服务商，请联系管理员")
        _interface.logger.warning(f"用户 {user_id} 尝试使用 AI 但未配置默认服务商")
        return

    # 检查服务商是否支持图像
    provider = _state["providers"].get(provider_id, {})
    if not provider.get("supports_image", False):
        await update.message.reply_text("⚠️ 当前服务商不支持图像处理")
        return

    # 获取图像
    photo = update.message.photo[-1]  # 最大尺寸的图像
    photo_file = await context.bot.get_file(photo.file_id)

    # 处理图像
    image_data = await AIManager.process_image(photo_file)
    if not image_data:
        await update.message.reply_text("❌ 处理图像失败")
        return

    # 获取消息文本(如果有)
    message_text = update.message.caption or "分析这张图片"

    # 发送"正在思考"消息
    thinking_message = await update.message.reply_text("🖼️ 正在分析图像...")

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
                await thinking_message.edit_text(text)
            else:
                # 如果消息超长，只更新最后部分
                await thinking_message.edit_text(text[-MAX_MESSAGE_LENGTH:])

        except Exception as e:
            # 忽略"消息未修改"错误
            if "Message is not modified" not in str(e):
                _interface.logger.error(f"更新消息失败: {e}")

    # 调用流式 AI API
    response = await AIManager.call_ai_api(provider_id, messages, [image_data],
                                           True, update_message_callback)

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
            first_message = await update.message.reply_text(parts[0],
                                                            parse_mode="HTML")

            # 发送剩余段落
            for part in parts[1:]:
                await first_message.reply_text(part, parse_mode="HTML")

    except Exception as e:
        _interface.logger.error(f"转换为 HTML 格式失败: {e}")
        # 如果转换失败，保留原始纯文本消息
        # 不需要额外操作，因为流式更新已经显示了完整的纯文本响应

    _interface.logger.info(f"用户 {user_id} 在私聊中获得了图像分析回复")


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
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
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
        if _interface:
            _interface.logger.error(f"加载 AI 配置失败: {e}")


def save_contexts() -> None:
    """保存所有用户的对话上下文"""
    try:
        os.makedirs(os.path.dirname(CONTEXT_FILE), exist_ok=True)
        with open(CONTEXT_FILE, 'w', encoding='utf-8') as f:
            json.dump(_state["conversations"], f, ensure_ascii=False, indent=2)

        # 更新保存时间
        _state["last_save_time"] = time.time()
    except Exception as e:
        if _interface:
            _interface.logger.error(f"保存对话上下文失败: {e}")


def load_contexts() -> None:
    """加载所有用户的对话上下文"""
    global _state

    if not os.path.exists(CONTEXT_FILE):
        return

    try:
        with open(CONTEXT_FILE, 'r', encoding='utf-8') as f:
            _state["conversations"] = json.load(f)
    except Exception as e:
        if _interface:
            _interface.logger.error(f"加载对话上下文失败: {e}")


# 模块状态管理函数


def get_state(module_interface):
    """获取模块状态（用于热更新）"""
    module_interface.logger.debug("正在获取 AI 模块状态用于热更新")

    # 只返回可序列化的状态数据
    serializable_state = {
        "providers":
        _state["providers"].copy() if "providers" in _state else {},
        "whitelist":
        _state["whitelist"].copy() if "whitelist" in _state else [],
        "conversations":
        _state["conversations"].copy() if "conversations" in _state else {},
        "default_provider": _state.get("default_provider"),
        "usage_stats":
        _state["usage_stats"].copy() if "usage_stats" in _state else {
            "total_requests": 0,
            "requests_by_provider": {},
            "requests_by_user": {}
        },
        "conversation_timeout": _state.get("conversation_timeout",
                                           24 * 60 * 60),
        # 显式排除不可序列化对象
        # "concurrent_requests": _state.get("concurrent_requests", 0),
        # "request_lock": None,  # 锁不可序列化
    }

    return serializable_state


# 修改 ai.py 中的 set_state 函数
def set_state(module_interface, state):
    """设置模块状态（用于热更新）"""
    global _state

    # 创建新的状态对象
    new_state = {}

    # 从保存的状态中复制可序列化部分
    new_state["providers"] = state.get("providers", {})
    new_state["whitelist"] = state.get("whitelist", [])
    new_state["conversations"] = state.get("conversations", {})
    new_state["default_provider"] = state.get("default_provider")
    new_state["usage_stats"] = state.get("usage_stats", {
        "total_requests": 0,
        "requests_by_provider": {},
        "requests_by_user": {}
    })
    new_state["conversation_timeout"] = state.get("conversation_timeout",
                                                  24 * 60 * 60)

    # 初始化运行时状态
    new_state["concurrent_requests"] = 0
    new_state["request_lock"] = asyncio.Lock()

    # 替换整个状态对象
    _state = new_state

    module_interface.logger.debug("已恢复 AI 模块状态")


async def setup(module_interface):
    """模块初始化"""
    global _interface, _state
    _interface = module_interface

    # 初始化请求锁
    _state["request_lock"] = asyncio.Lock()

    # 从持久化存储加载状态
    saved_state = module_interface.load_state(default={})
    if saved_state:
        set_state(module_interface, saved_state)
    else:
        # 如果没有保存的状态，加载配置文件
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
                                            description="向 AI 发送消息")

    # 注册私聊消息处理器
    text_handler = MessageHandler(
        filters.TEXT & filters.ChatType.PRIVATE & ~filters.COMMAND
        & ~filters.Regex(r'^/'), handle_private_message)
    await module_interface.register_handler(text_handler)

    # 注册私聊图片处理器
    photo_handler = MessageHandler(filters.PHOTO & filters.ChatType.PRIVATE,
                                   handle_private_photo)
    await module_interface.register_handler(photo_handler)

    # 设置定期任务
    async def _periodic_tasks():
        while True:
            try:
                # 每小时检查一次过期对话
                await asyncio.sleep(3600)
                expired_count = ConversationManager.cleanup_expired()
                if expired_count > 0:
                    _interface.logger.info(f"已清理 {expired_count} 个过期对话")

                # 保存状态 - 确保获取清理过的状态
                serializable_state = get_state(module_interface)
                module_interface.save_state(serializable_state)
                save_contexts()
                _interface.logger.debug("已定期保存 AI 模块状态")
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

    # 保存状态 - 使用 get_state 获取可序列化状态
    module_interface.save_state(get_state(module_interface))
    save_contexts()

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
