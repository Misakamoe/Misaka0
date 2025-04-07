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

    def subscribe(self, event_type, callback, priority=0, filter_func=None):
        """订阅事件
        
        Args:
            event_type: 事件类型
            callback: 回调函数，必须是异步函数
            priority: 优先级，数字越大优先级越高
            filter_func: 过滤函数，返回 True 时才调用回调
        
        Returns:
            tuple: (event_type, callback) 用于取消订阅
        """
        if not asyncio.iscoroutinefunction(callback):
            logger.warning(f"订阅的回调不是异步函数: {callback.__name__}")
            return None

        # 创建订阅者记录
        subscriber = {
            "callback": callback,
            "priority": priority,
            "filter": filter_func
        }

        self.subscribers[event_type].append(subscriber)

        # 按优先级排序
        self.subscribers[event_type].sort(key=lambda s: s["priority"],
                                          reverse=True)

        logger.debug(f"已订阅事件 {event_type}，优先级: {priority}")
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

        # 查找并移除订阅
        for i, subscriber in enumerate(self.subscribers[event_type]):
            if subscriber["callback"] == callback:
                self.subscribers[event_type].pop(i)
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
        for subscriber in self.subscribers[event_type]:
            # 检查过滤器
            filter_func = subscriber.get("filter")
            if filter_func and not filter_func(event_type, **event_data):
                continue

            # 创建任务，但不等待完成
            callback = subscriber["callback"]
            task = asyncio.create_task(
                self._safe_callback(callback, event_type, **event_data))
            tasks.append(task)

        # 返回订阅者数量
        return len(tasks)

    async def publish_and_wait(self, event_type, timeout=None, **event_data):
        """发布事件并等待所有回调完成
        
        Args:
            event_type: 事件类型
            timeout: 超时时间（秒），None表示无限等待
            **event_data: 事件数据
            
        Returns:
            tuple: (接收到事件的订阅者数量, 成功完成的回调数量)
        """
        if event_type not in self.subscribers:
            return 0, 0

        tasks = []
        for subscriber in self.subscribers[event_type]:
            # 检查过滤器
            filter_func = subscriber.get("filter")
            if filter_func and not filter_func(event_type, **event_data):
                continue

            # 创建任务
            callback = subscriber["callback"]
            task = asyncio.create_task(
                self._safe_callback(callback, event_type, **event_data))
            tasks.append(task)

        if not tasks:
            return 0, 0

        # 等待所有任务完成或超时
        if timeout is not None:
            done, pending = await asyncio.wait(tasks, timeout=timeout)
            # 取消未完成的任务
            for task in pending:
                task.cancel()
            # 等待取消操作完成
            if pending:
                await asyncio.gather(*pending, return_exceptions=True)
            return len(tasks), len(done)
        else:
            # 无限等待
            results = await asyncio.gather(*tasks, return_exceptions=True)
            successful = sum(1 for r in results
                             if not isinstance(r, Exception))
            return len(tasks), successful

    async def _safe_callback(self, callback, event_type, **event_data):
        """安全地调用回调函数，捕获异常"""
        try:
            await callback(event_type=event_type, **event_data)
            return True
        except Exception as e:
            logger.error(f"处理事件 {event_type} 的回调出错: {e}", exc_info=True)
            return False
