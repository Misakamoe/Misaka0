# utils/session_manager.py - 会话管理器

import time
import asyncio
import json
import os
from collections import defaultdict
from utils.logger import setup_logger


class SessionManager:
    """会话管理器，用于支持多步骤交互，会话绑定到聊天ID和用户ID的组合"""

    def __init__(self,
                 timeout=300,
                 cleanup_interval=600,
                 storage_dir="data/sessions"):
        """初始化会话管理器

        Args:
            timeout: 会话超时时间（秒）
            cleanup_interval: 清理间隔（秒）
            storage_dir: 会话存储目录
        """
        self.sessions = defaultdict(dict)  # 会话数据，键为 "chat_id_user_id"
        self.timeout = timeout  # 会话超时时间
        self.cleanup_interval = cleanup_interval  # 清理间隔
        self.storage_dir = storage_dir  # 存储目录
        self.cleanup_task = None  # 清理任务
        self.locks = defaultdict(asyncio.Lock)  # 会话锁
        self.logger = setup_logger("SessionManager")

        # 确保存储目录存在
        os.makedirs(storage_dir, exist_ok=True)

        # 加载持久化的会话数据
        self._load_sessions()

    def _get_session_key(self, user_id, chat_id):
        """生成会话键

        Args:
            user_id: 用户 ID
            chat_id: 聊天 ID

        Returns:
            str: 会话键
        """
        return f"{chat_id}_{user_id}"

    async def start_cleanup(self):
        """启动定期清理任务"""
        if self.cleanup_task is None or self.cleanup_task.done():
            self.cleanup_task = asyncio.create_task(self._cleanup_loop())
            self.logger.info("会话清理任务已启动")

    async def stop_cleanup(self):
        """停止清理任务"""
        if self.cleanup_task and not self.cleanup_task.done():
            self.cleanup_task.cancel()
            try:
                await self.cleanup_task
            except asyncio.CancelledError:
                pass
            self.logger.info("会话清理任务已停止")

    async def _cleanup_loop(self):
        """清理过期会话的循环"""
        try:
            while True:
                count = self.cleanup()
                if count > 0:
                    self.logger.debug(f"已清理 {count} 个过期会话")

                # 保存会话数据
                self._save_sessions()

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
        expired_sessions = []

        for session_key, session in self.sessions.items():
            if session.get("last_activity", 0) + self.timeout < now:
                expired_sessions.append(session_key)

        for session_key in expired_sessions:
            del self.sessions[session_key]

        return len(expired_sessions)

    async def get(self, user_id, key, default=None, chat_id=None):
        """获取会话数据

        Args:
            user_id: 用户 ID
            key: 数据键
            default: 默认值
            chat_id: 聊天 ID

        Returns:
            任意: 会话数据或默认值
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
            session["last_activity"] = time.time()
            return session.get(key, default)

    async def set(self, user_id, key, value, chat_id=None):
        """设置会话数据

        Args:
            user_id: 用户 ID
            key: 数据键
            value: 数据值
            chat_id: 聊天 ID
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
            session[key] = value
            session["last_activity"] = time.time()

    async def delete(self, user_id, key, chat_id=None):
        """删除会话数据

        Args:
            user_id: 用户 ID
            key: 数据键
            chat_id: 聊天 ID

        Returns:
            bool: 是否成功删除
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
            session["last_activity"] = time.time()
            if key in session:
                del session[key]
                return True
            return False

    async def clear(self, user_id, chat_id=None):
        """清除用户的所有会话数据

        Args:
            user_id: 用户 ID
            chat_id: 聊天 ID
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            if session_key in self.sessions:
                self.sessions[session_key] = {"last_activity": time.time()}

    async def has_key(self, user_id, key, chat_id=None):
        """检查会话是否包含指定键

        Args:
            user_id: 用户 ID
            key: 数据键
            chat_id: 聊天 ID

        Returns:
            bool: 是否包含指定键
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
            session["last_activity"] = time.time()
            return key in session

    async def get_all(self, user_id, chat_id=None):
        """获取用户的所有会话数据

        Args:
            user_id: 用户 ID
            chat_id: 聊天 ID

        Returns:
            dict: 会话数据副本
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
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

    async def get_user_sessions(self, user_id):
        """获取用户在所有聊天中的会话

        Args:
            user_id: 用户 ID

        Returns:
            dict: 会话字典，键为聊天 ID
        """
        user_sessions = {}
        user_id_str = str(user_id)

        # 遍历所有会话，找出属于该用户的会话
        for session_key, session in self.sessions.items():
            if session_key.endswith(f"_{user_id_str}"):
                chat_id = session_key.split('_')[0]
                user_sessions[chat_id] = session

        return user_sessions

    def _save_sessions(self):
        """保存会话数据到文件"""
        try:
            # 准备会话数据（只保存活跃会话）
            now = time.time()
            active_sessions = {}

            for session_key, session in self.sessions.items():
                if session.get("last_activity", 0) + self.timeout >= now:
                    # 使用会话键作为 JSON 键
                    active_sessions[session_key] = session

            # 保存到文件
            sessions_file = os.path.join(self.storage_dir, "sessions.json")
            with open(sessions_file, 'w', encoding='utf-8') as f:
                json.dump(active_sessions, f, ensure_ascii=False, indent=2)

        except Exception as e:
            self.logger.error(f"保存会话数据时出错: {e}")

    def _load_sessions(self):
        """从文件加载会话数据"""
        sessions_file = os.path.join(self.storage_dir, "sessions.json")
        if not os.path.exists(sessions_file):
            return

        try:
            with open(sessions_file, 'r', encoding='utf-8') as f:
                data = json.load(f)

            # 直接加载会话数据
            for session_key, session in data.items():
                self.sessions[session_key] = session

            self.logger.info(f"已加载 {len(data)} 个会话")

        except Exception as e:
            self.logger.error(f"加载会话数据时出错: {e}")
