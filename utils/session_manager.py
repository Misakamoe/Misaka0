# utils/session_manager.py

import time
import asyncio
import logging
from collections import defaultdict

logger = logging.getLogger("SessionManager")


class SessionManager:
    """用户会话管理器，用于支持多步骤交互"""

    def __init__(self, timeout=300, cleanup_interval=600):
        """初始化会话管理器
        
        Args:
            timeout: 会话超时时间（秒）
            cleanup_interval: 清理间隔（秒）
        """
        self.sessions = defaultdict(dict)  # 用户会话
        self.timeout = timeout  # 会话超时时间
        self.cleanup_interval = cleanup_interval  # 清理间隔
        self.cleanup_task = None  # 清理任务
        self.locks = defaultdict(asyncio.Lock)  # 会话锁

    async def start_cleanup(self):
        """启动定期清理任务"""
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())
            logger.info("会话清理任务已启动")

    async def stop_cleanup(self):
        """停止清理任务"""
        if self.cleanup_task and not self.cleanup_task.done():
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
            logger.info("会话清理任务已停止")

    async def _cleanup_loop(self):
        """清理过期会话的循环"""
        try:
            while True:
                count = self.cleanup()
                if count > 0:
                    logger.debug(f"已清理 {count} 个过期会话")
                await asyncio.sleep(self.cleanup_interval)
        except asyncio.CancelledError:
            # 任务被取消，退出循环
            pass

    def cleanup(self):
        """清理过期会话
        
        Returns:
            int: 清理的会话数量
        """
        now = time.time()
        expired_users = []

        for user_id, session in self.sessions.items():
            if session.get("last_activity", 0) + self.timeout < now:
                expired_users.append(user_id)

        for user_id in expired_users:
            del self.sessions[user_id]

        return len(expired_users)

    async def get(self, user_id, key, default=None):
        """获取会话数据
        
        Args:
            user_id: 用户 ID
            key: 数据键
            default: 默认值
            
        Returns:
            任意: 会话数据或默认值
        """
        async with self.locks[user_id]:
            session = self.sessions[user_id]
            session["last_activity"] = time.time()
            return session.get(key, default)

    async def set(self, user_id, key, value):
        """设置会话数据
        
        Args:
            user_id: 用户 ID
            key: 数据键
            value: 数据值
        """
        async with self.locks[user_id]:
            session = self.sessions[user_id]
            session[key] = value
            session["last_activity"] = time.time()

    async def delete(self, user_id, key):
        """删除会话数据
        
        Args:
            user_id: 用户 ID
            key: 数据键
            
        Returns:
            bool: 是否成功删除
        """
        async with self.locks[user_id]:
            session = self.sessions[user_id]
            session["last_activity"] = time.time()
            if key in session:
                del session[key]
                return True
            return False

    async def clear(self, user_id):
        """清除用户的所有会话数据
        
        Args:
            user_id: 用户 ID
        """
        async with self.locks[user_id]:
            if user_id in self.sessions:
                self.sessions[user_id] = {"last_activity": time.time()}

    async def has_key(self, user_id, key):
        """检查会话是否包含指定键
        
        Args:
            user_id: 用户 ID
            key: 数据键
            
        Returns:
            bool: 是否包含指定键
        """
        async with self.locks[user_id]:
            session = self.sessions[user_id]
            session["last_activity"] = time.time()
            return key in session

    async def get_all(self, user_id):
        """获取用户的所有会话数据
        
        Args:
            user_id: 用户 ID
            
        Returns:
            dict: 会话数据副本
        """
        async with self.locks[user_id]:
            session = self.sessions[user_id]
            session["last_activity"] = time.time()
            # 返回副本，不包括 last_activity
            return {k: v for k, v in session.items() if k != "last_activity"}

    async def get_active_sessions_count(self):
        """获取活跃会话数量
        
        Returns:
            int: 活跃会话数量
        """
        now = time.time()
        count = 0
        for session in self.sessions.values():
            if session.get("last_activity", 0) + self.timeout >= now:
                count += 1
        return count
