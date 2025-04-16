# utils/state_manager.py - 状态管理器

import json
import os
import pickle
import time
import glob
from datetime import datetime

from utils.logger import setup_logger


class StateManager:
    """模块状态管理器，提供状态的保存和加载功能"""

    def __init__(self,
                 storage_dir="data/module_states",
                 max_backups=5,
                 cleanup_days=30):
        """初始化状态管理器
        
        Args:
            storage_dir: 状态存储目录
            max_backups: 每个模块保留的最大备份数
            cleanup_days: 自动清理超过多少天的备份
        """
        self.storage_dir = storage_dir
        self.backup_dir = os.path.join(storage_dir, "backups")
        self.max_backups = max_backups
        self.cleanup_days = cleanup_days
        self.logger = setup_logger("StateManager")

        # 创建目录
        os.makedirs(storage_dir, exist_ok=True)
        os.makedirs(self.backup_dir, exist_ok=True)

        # 启动时执行一次清理
        self._cleanup_old_backups()

    def get_state_file_path(self, module_name, format="json"):
        """获取状态文件路径
        
        Args:
            module_name: 模块名称
            format: 文件格式
            
        Returns:
            str: 文件路径
        """
        return os.path.join(self.storage_dir, f"{module_name}.{format}")

    def save_state(self, module_name, state, format="json"):
        """保存模块状态
        
        Args:
            module_name: 模块名称
            state: 要保存的状态数据
            format: 存储格式，支持 'json' 或 'pickle'
            
        Returns:
            bool: 是否成功保存
        """
        if state is None:
            return False

        # 先创建备份
        self._backup_state(module_name, format)

        try:
            file_path = self.get_state_file_path(module_name, format)

            if format == "json":
                with open(file_path, 'w', encoding='utf-8') as f:
                    json.dump(state, f, ensure_ascii=False, indent=2)
            elif format == "pickle":
                with open(file_path, 'wb') as f:
                    pickle.dump(state, f)
            else:
                self.logger.error(f"不支持的存储格式: {format}")
                return False

            self.logger.debug(f"已保存模块 {module_name} 的状态")
            return True

        except Exception as e:
            self.logger.error(f"保存模块 {module_name} 状态时出错: {e}")
            return False

    def load_state(self, module_name, default=None, format="json"):
        """加载模块状态
        
        Args:
            module_name: 模块名称
            default: 默认值
            format: 存储格式
            
        Returns:
            任意: 加载的状态或默认值
        """
        try:
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
                self.logger.error(f"不支持的存储格式: {format}")
                return default

        except Exception as e:
            self.logger.error(f"加载模块 {module_name} 状态时出错: {e}")
            return default

    def delete_state(self, module_name, format="json"):
        """删除模块状态
        
        Args:
            module_name: 模块名称
            format: 存储格式
            
        Returns:
            bool: 是否成功删除
        """
        # 先创建备份
        self._backup_state(module_name, format)

        try:
            file_path = self.get_state_file_path(module_name, format)

            if os.path.exists(file_path):
                os.remove(file_path)
                self.logger.debug(f"已删除模块 {module_name} 的状态")
                return True
            return False

        except Exception as e:
            self.logger.error(f"删除模块 {module_name} 状态时出错: {e}")
            return False

    def _backup_state(self, module_name, format="json"):
        """备份模块状态
        
        Args:
            module_name: 模块名称
            format: 存储格式
            
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
            import shutil
            shutil.copy2(source_path, backup_path)
            self.logger.debug(f"已备份模块 {module_name} 的状态到 {backup_path}")

            # 删除多余的备份
            self._cleanup_module_backups(module_name, format)
            return True

        except Exception as e:
            self.logger.error(f"备份模块 {module_name} 状态时出错: {e}")
            return False

    def _cleanup_module_backups(self, module_name, format="json"):
        """清理指定模块的多余备份
        
        Args:
            module_name: 模块名称
            format: 存储格式
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
                    self.logger.debug(f"已删除旧备份: {old_file}")
                except Exception as e:
                    self.logger.error(f"删除旧备份 {old_file} 时出错: {e}")

    def _cleanup_old_backups(self):
        """清理过旧的备份文件"""
        now = time.time()
        max_age = self.cleanup_days * 86400  # 转换为秒

        # 获取所有备份文件
        backup_files = glob.glob(os.path.join(self.backup_dir, "*.*"))

        for file_path in backup_files:
            try:
                file_age = now - os.path.getmtime(file_path)
                if file_age > max_age:
                    os.remove(file_path)
                    self.logger.debug(f"已删除过期备份: {file_path}")
            except Exception as e:
                self.logger.error(f"检查或删除备份 {file_path} 时出错: {e}")
