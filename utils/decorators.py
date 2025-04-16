# utils/decorators.py - 装饰器工具

import functools
import traceback
import telegram
import asyncio
import time
from telegram import Update
from utils.logger import setup_logger

logger = setup_logger("Decorators")


def error_handler(func):
    """错误处理装饰器，统一处理命令和回调中的异常
    
    Args:
        func: 要装饰的函数
        
    Returns:
        function: 装饰后的函数
    """

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)

        except telegram.error.NetworkError as e:
            # 对网络错误只记录警告
            logger.warning(f"网络错误: {e}")

            # 向用户发送友好的错误消息
            update = None
            for arg in args:
                if isinstance(arg, Update):
                    update = arg
                    break

            if update and update.effective_message:
                await update.effective_message.reply_text("网络连接暂时中断，请稍后再试。")

            return None

        except Exception as e:
            # 记录详细错误信息
            logger.error(f"处理 {func.__name__} 时出错: {e}")
            logger.debug(traceback.format_exc())

            # 向用户发送友好的错误消息
            update = None
            for arg in args:
                if isinstance(arg, Update):
                    update = arg
                    break

            if update and update.effective_message:
                await update.effective_message.reply_text(
                    f"😔 处理您的请求时出现错误，请稍后再试。")

            return None

    return wrapper


def async_retry(max_retries=3, retry_delay=1, backoff_factor=2):
    """异步重试装饰器
    
    Args:
        max_retries: 最大重试次数
        retry_delay: 初始重试延迟（秒）
        backoff_factor: 退避因子
        
    Returns:
        function: 装饰器函数
    """

    def decorator(func):

        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            retries = 0
            delay = retry_delay

            while True:
                try:
                    return await func(*args, **kwargs)
                except (telegram.error.NetworkError, telegram.error.TimedOut,
                        asyncio.TimeoutError) as e:
                    retries += 1
                    if retries > max_retries:
                        logger.error(f"达到最大重试次数 ({max_retries})，放弃重试: {e}")
                        raise

                    logger.warning(
                        f"发生错误，将在 {delay} 秒后重试 ({retries}/{max_retries}): {e}")
                    await asyncio.sleep(delay)
                    delay *= backoff_factor

        return wrapper

    return decorator


def rate_limit(calls=1, period=60):
    """速率限制装饰器
    
    Args:
        calls: 允许的调用次数
        period: 时间周期（秒）
        
    Returns:
        function: 装饰器函数
    """

    def decorator(func):
        # 使用类级别的速率限制器，避免重置装饰器状态
        # 这依赖于被装饰函数的唯一性
        state = {"last_reset": 0, "call_count": 0, "lock": asyncio.Lock()}

        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            async with state["lock"]:
                current_time = time.time()

                # 检查是否需要重置计数器
                if current_time - state["last_reset"] > period:
                    state["last_reset"] = current_time
                    state["call_count"] = 0

                # 检查是否超过了速率限制
                if state["call_count"] >= calls:
                    # 获取更新对象
                    update = None
                    for arg in args:
                        if isinstance(arg, Update):
                            update = arg
                            break

                    if update and update.effective_message:
                        await update.effective_message.reply_text(
                            f"请稍等一会儿再使用此命令。")
                    return None

                # 增加计数器
                state["call_count"] += 1

            # 执行原始函数
            return await func(*args, **kwargs)

        return wrapper

    return decorator
