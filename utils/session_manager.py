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
        """清理过期会话和过期的会话键

        Returns:
            int: 清理的会话数量和键数量
        """
        now = time.time()
        expired_sessions = []
        expired_keys_count = 0

        for session_key, session in self.sessions.items():
            # 检查整个会话是否过期
            if session.get("last_activity", 0) + self.timeout < now:
                expired_sessions.append(session_key)
                continue

            # 检查会话中的各个键是否有单独的过期时间
            keys_to_delete = []
            for key, value in session.items():
                # 跳过特殊键
                if key == "last_activity":
                    continue

                # 检查键是否有过期时间
                if isinstance(value, dict) and "_expire_at" in value:
                    if value["_expire_at"] < now:
                        keys_to_delete.append(key)

            # 删除过期的键
            for key in keys_to_delete:
                del session[key]
                expired_keys_count += 1

        # 删除过期的会话
        for session_key in expired_sessions:
            del self.sessions[session_key]

        return len(expired_sessions) + expired_keys_count

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

            # 获取值
            value = session.get(key)

            # 如果键不存在，返回默认值
            if value is None:
                return default

            # 检查值是否是带有过期时间的字典
            if isinstance(value, dict) and "_expire_at" in value:
                # 检查是否已过期
                if value["_expire_at"] < time.time():
                    # 已过期，删除键并返回默认值
                    del session[key]
                    return default

                # 未过期，返回实际值
                return value.get("_value", value)

            # 普通值，直接返回
            return value

    async def set(self, user_id, key, value, chat_id=None, expire_after=None):
        """设置会话数据

        Args:
            user_id: 用户 ID
            key: 数据键
            value: 数据值
            chat_id: 聊天 ID
            expire_after: 可选，键的过期时间（秒），如果设置，该键将在指定时间后自动过期
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]

            # 如果设置了过期时间，将值包装在字典中
            if expire_after is not None:
                # 如果值已经是字典并且包含 _expire_at，则更新它
                if isinstance(value, dict) and "_expire_at" in value:
                    value["_expire_at"] = time.time() + expire_after
                else:
                    # 否则创建一个新的包装字典
                    value = {
                        "_value": value,
                        "_expire_at": time.time() + expire_after
                    }

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

            # 检查键是否存在
            if key not in session:
                return False

            # 获取值
            value = session[key]

            # 检查值是否是带有过期时间的字典
            if isinstance(value, dict) and "_expire_at" in value:
                # 检查是否已过期
                if value["_expire_at"] < time.time():
                    # 已过期，删除键并返回 False
                    del session[key]
                    return False

            return True

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

            # 处理过期的键
            now = time.time()
            keys_to_delete = []
            result = {}

            for k, v in session.items():
                # 跳过 last_activity
                if k == "last_activity":
                    continue

                # 检查值是否是带有过期时间的字典
                if isinstance(v, dict) and "_expire_at" in v:
                    # 检查是否已过期
                    if v["_expire_at"] < now:
                        # 已过期，标记为删除
                        keys_to_delete.append(k)
                        continue

                    # 未过期，添加实际值到结果
                    result[k] = v.get("_value", v)
                else:
                    # 普通值，直接添加
                    result[k] = v

            # 删除过期的键
            for k in keys_to_delete:
                del session[k]

            return result

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

    async def get_all_keys(self, user_id, chat_id=None):
        """获取用户会话中的所有键名

        Args:
            user_id: 用户 ID
            chat_id: 聊天 ID

        Returns:
            list: 键名列表
        """
        session_key = self._get_session_key(user_id, chat_id)

        async with self.locks[session_key]:
            session = self.sessions[session_key]
            session["last_activity"] = time.time()

            # 处理过期的键
            now = time.time()
            keys_to_delete = []
            result = []

            for k, v in session.items():
                # 跳过 last_activity
                if k == "last_activity":
                    continue

                # 检查值是否是带有过期时间的字典
                if isinstance(v, dict) and "_expire_at" in v:
                    # 检查是否已过期
                    if v["_expire_at"] < now:
                        # 已过期，标记为删除
                        keys_to_delete.append(k)
                        continue

                # 添加键名到结果
                result.append(k)

            # 删除过期的键
            for k in keys_to_delete:
                del session[k]

            return result

    def _save_sessions(self):
        """保存会话数据到文件"""
        try:
            # 准备会话数据（只保存活跃会话）
            now = time.time()
            active_sessions = {}

            for session_key, session in self.sessions.items():
                # 检查会话是否活跃
                if session.get("last_activity", 0) + self.timeout >= now:
                    # 创建会话副本
                    session_copy = {}

                    # 处理会话中的每个键
                    for k, v in session.items():
                        # 检查值是否是带有过期时间的字典
                        if isinstance(v, dict) and "_expire_at" in v:
                            # 检查是否已过期
                            if v["_expire_at"] < now:
                                # 已过期，不保存
                                continue

                            # 保存原始格式，包括过期时间
                            session_copy[k] = v
                        else:
                            # 普通值，直接保存
                            session_copy[k] = v

                    # 使用会话键作为 JSON 键
                    active_sessions[session_key] = session_copy

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
