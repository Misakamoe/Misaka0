# utils/event_system.py
import asyncio
import logging
from collections import defaultdict

logger = logging.getLogger("EventSystem")


class EventSystem:
    """事件发布/订阅系统"""

    def __init__(self):
        # 使用 defaultdict 存储事件订阅者
        self.subscribers = defaultdict(list)

    def subscribe(self, event_type, callback):
        """订阅事件
        
        Args:
            event_type: 事件类型
            callback: 回调函数，必须是异步函数
        
        Returns:
            tuple: (event_type, callback) 用于取消订阅
        """
        if not asyncio.iscoroutinefunction(callback):
            logger.warning(f"订阅的回调不是异步函数: {callback.__name__}")
            return None

        self.subscribers[event_type].append(callback)
        logger.debug(f"已订阅事件 {event_type}")
        return (event_type, callback)

    def unsubscribe(self, subscription):
        """取消订阅
        
        Args:
            subscription: subscribe 方法返回的订阅信息
        
        Returns:
            bool: 是否成功取消订阅
        """
        if not subscription:
            return False

        event_type, callback = subscription
        if event_type in self.subscribers and callback in self.subscribers[
                event_type]:
            self.subscribers[event_type].remove(callback)
            logger.debug(f"已取消订阅事件 {event_type}")
            return True
        return False

    def unsubscribe_all(self, event_type=None):
        """取消所有订阅
        
        Args:
            event_type: 如果提供，只取消该事件类型的订阅
        """
        if event_type:
            if event_type in self.subscribers:
                self.subscribers[event_type].clear()
                logger.debug(f"已取消所有 {event_type} 事件的订阅")
        else:
            self.subscribers.clear()
            logger.debug("已取消所有事件的订阅")

    async def publish(self, event_type, **event_data):
        """发布事件
        
        Args:
            event_type: 事件类型
            **event_data: 事件数据
        
        Returns:
            int: 接收到事件的订阅者数量
        """
        if event_type not in self.subscribers:
            return 0

        tasks = []
        for callback in self.subscribers[event_type]:
            # 创建任务，但不等待完成
            task = asyncio.create_task(
                self._safe_callback(callback, event_type, **event_data))
            tasks.append(task)

        # 返回订阅者数量
        return len(tasks)

    async def _safe_callback(self, callback, event_type, **event_data):
        """安全地调用回调函数，捕获异常"""
        try:
            await callback(event_type=event_type, **event_data)
        except Exception as e:
            logger.error(f"处理事件 {event_type} 的回调出错: {e}", exc_info=True)
