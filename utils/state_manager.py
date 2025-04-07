# utils/state_manager.py

import json
import os
import pickle
import logging
import shutil
import time
from datetime import datetime
import glob

logger = logging.getLogger("StateManager")


class StateManager:
    """模块状态管理器，提供状态的保存和加载功能"""

    def __init__(self,
                 storage_dir="data/module_states",
                 max_backups=5,
                 cleanup_days=30):
        self.storage_dir = storage_dir
        self.backup_dir = os.path.join(storage_dir, "backups")
        self.max_backups = max_backups
        self.cleanup_days = cleanup_days

        # 创建目录
        os.makedirs(storage_dir, exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)

        # 启动时执行一次清理
        self._cleanup_old_backups()

    def get_state_file_path(self, module_name, format="json"):
        """获取状态文件路径"""
        return os.path.join(self.storage_dir, f"{module_name}.{format}")

    def _with_error_handling(self,
                             operation,
                             module_name,
                             func,
                             default_return=None):
        """通用错误处理逻辑
        
        Args:
            operation: 操作名称（用于日志）
            module_name: 模块名称
            func: 要执行的函数
            default_return: 出错时的返回值
            
        Returns:
            任意: 函数的返回值，或出错时的默认值
        """
        try:
            return func()
        except Exception as e:
            logger.error(f"{operation}模块 {module_name} 状态时出错: {e}")
            return default_return

    def _backup_state(self, module_name, format="json"):
        """备份模块状态
        
        Args:
            module_name: 模块名称
            format: 状态格式
            
        Returns:
            bool: 是否成功备份
        """
        source_path = self.get_state_file_path(module_name, format)
        if not os.path.exists(source_path):
            return False

        # 创建备份文件名，包含时间戳
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        backup_path = os.path.join(self.backup_dir,
                                   f"{module_name}_{timestamp}.{format}")

        # 复制文件
        try:
            shutil.copy2(source_path, backup_path)
            logger.debug(f"已备份模块 {module_name} 的状态到 {backup_path}")

            # 删除多余的备份
            self._cleanup_module_backups(module_name, format)
            return True
        except Exception as e:
            logger.error(f"备份模块 {module_name} 状态时出错: {e}")
            return False

    def _cleanup_module_backups(self, module_name, format="json"):
        """清理指定模块的多余备份
        
        保留最新的 max_backups 个备份
        """
        pattern = os.path.join(self.backup_dir, f"{module_name}_*.{format}")
        backup_files = sorted(glob.glob(pattern),
                              key=os.path.getmtime,
                              reverse=True)

        # 如果备份数量超过限制，删除旧的备份
        if len(backup_files) > self.max_backups:
            for old_file in backup_files[self.max_backups:]:
                try:
                    os.remove(old_file)
                    logger.debug(f"已删除旧备份: {old_file}")
                except Exception as e:
                    logger.error(f"删除旧备份 {old_file} 时出错: {e}")

    def _cleanup_old_backups(self):
        """清理过旧的备份文件
        
        删除超过 cleanup_days 天的备份
        """
        now = time.time()
        max_age = self.cleanup_days * 86400  # 转换为秒

        # 获取所有备份文件
        backup_files = glob.glob(os.path.join(self.backup_dir, "*.*"))

        for file_path in backup_files:
            try:
                file_age = now - os.path.getmtime(file_path)
                if file_age > max_age:
                    os.remove(file_path)
                    logger.debug(f"已删除过期备份: {file_path}")
            except Exception as e:
                logger.error(f"检查或删除备份 {file_path} 时出错: {e}")

    def save_state(self, module_name, state, format="json"):
        """保存模块状态
        
        Args:
            module_name: 模块名称
            state: 要保存的状态数据（必须是可序列化的）
            format: 存储格式，支持 'json' 或 'pickle'
        
        Returns:
            bool: 保存是否成功
        """
        # 先创建备份
        self._backup_state(module_name, format)

        # 定义保存操作
        def _do_save():
            file_path = self.get_state_file_path(module_name, format)

            if format == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(state, f, ensure_ascii=False, indent=2)
            elif format == "pickle":
                with open(file_path, 'wb') as f:
                    pickle.dump(state, f)
            else:
                logger.error(f"不支持的存储格式: {format}")
                return False

            logger.debug(f"已保存模块 {module_name} 的状态")
            return True

        # 执行保存操作并处理错误
        return self._with_error_handling("保存", module_name, _do_save, False)

    def load_state(self, module_name, default=None, format="json"):
        """加载模块状态
        
        Args:
            module_name: 模块名称
            default: 如果状态不存在，返回的默认值
            format: 存储格式，支持 'json' 或 'pickle'
        
        Returns:
            加载的状态数据，如果加载失败则返回默认值
        """

        def _do_load():
            file_path = self.get_state_file_path(module_name, format)

            if not os.path.exists(file_path):
                return default

            if format == "json":
                with open(file_path, 'r', encoding='utf-8') as f:
                    return json.load(f)
            elif format == "pickle":
                with open(file_path, 'rb') as f:
                    return pickle.load(f)
            else:
                logger.error(f"不支持的存储格式: {format}")
                return default

        # 执行加载操作并处理错误
        return self._with_error_handling("加载", module_name, _do_load, default)

    def delete_state(self, module_name, format="json"):
        """删除模块状态
        
        Args:
            module_name: 模块名称
            format: 存储格式
        
        Returns:
            bool: 删除是否成功
        """
        # 先创建备份
        self._backup_state(module_name, format)

        def _do_delete():
            file_path = self.get_state_file_path(module_name, format)

            if os.path.exists(file_path):
                os.remove(file_path)
                logger.debug(f"已删除模块 {module_name} 的状态")
                return True
            return False

        # 执行删除操作并处理错误
        return self._with_error_handling("删除", module_name, _do_delete, False)

    def list_states(self):
        """列出所有保存的状态
        
        Returns:
            dict: 模块名称到格式列表的映射
        """
        result = {}

        # 查找所有状态文件
        for file_name in os.listdir(self.storage_dir):
            if os.path.isfile(os.path.join(self.storage_dir,
                                           file_name)) and '.' in file_name:
                module_name, format = file_name.rsplit('.', 1)
                if module_name not in result:
                    result[module_name] = []
                result[module_name].append(format)

        return result

    def get_backup_info(self, module_name=None):
        """获取备份信息
        
        Args:
            module_name: 如果提供，只获取指定模块的备份信息
            
        Returns:
            dict: 备份信息
        """
        result = {}

        # 确定查找模式
        if module_name:
            pattern = os.path.join(self.backup_dir, f"{module_name}_*.*")
        else:
            pattern = os.path.join(self.backup_dir, "*.*")

        # 查找所有备份文件
        for file_path in glob.glob(pattern):
            file_name = os.path.basename(file_path)
            if '_' in file_name and '.' in file_name:
                # 解析文件名
                name_with_timestamp, format = file_name.rsplit('.', 1)
                module_name, timestamp = name_with_timestamp.rsplit('_', 1)

                if module_name not in result:
                    result[module_name] = []

                # 添加备份信息
                backup_time = os.path.getmtime(file_path)
                backup_size = os.path.getsize(file_path)
                result[module_name].append({
                    'timestamp':
                    timestamp,
                    'format':
                    format,
                    'time':
                    datetime.fromtimestamp(backup_time).strftime(
                        "%Y-%m-%d %H:%M:%S"),
                    'size':
                    backup_size
                })

        # 对每个模块的备份按时间排序
        for module_name in result:
            result[module_name].sort(key=lambda x: x['timestamp'],
                                     reverse=True)

        return result
