# utils/state_manager.py
import json
import os
import pickle
import logging

logger = logging.getLogger("StateManager")


class StateManager:
    """模块状态管理器，提供状态的保存和加载功能"""

    def __init__(self, storage_dir="data/module_states"):
        self.storage_dir = storage_dir
        os.makedirs(storage_dir, exist_ok=True)

    def get_state_file_path(self, module_name, format="json"):
        """获取状态文件路径"""
        return os.path.join(self.storage_dir, f"{module_name}.{format}")

    def save_state(self, module_name, state, format="json"):
        """保存模块状态
        
        Args:
            module_name: 模块名称
            state: 要保存的状态数据（必须是可序列化的）
            format: 存储格式，支持 'json' 或 'pickle'
        
        Returns:
            bool: 保存是否成功
        """
        try:
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

        except Exception as e:
            logger.error(f"保存模块 {module_name} 状态时出错: {e}")
            return False

    def load_state(self, module_name, default=None, format="json"):
        """加载模块状态
        
        Args:
            module_name: 模块名称
            default: 如果状态不存在，返回的默认值
            format: 存储格式，支持 'json' 或 'pickle'
        
        Returns:
            加载的状态数据，如果加载失败则返回默认值
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
                logger.error(f"不支持的存储格式: {format}")
                return default

        except Exception as e:
            logger.error(f"加载模块 {module_name} 状态时出错: {e}")
            return default

    def delete_state(self, module_name, format="json"):
        """删除模块状态
        
        Args:
            module_name: 模块名称
            format: 存储格式
        
        Returns:
            bool: 删除是否成功
        """
        try:
            file_path = self.get_state_file_path(module_name, format)

            if os.path.exists(file_path):
                os.remove(file_path)
                logger.debug(f"已删除模块 {module_name} 的状态")
                return True
            return False

        except Exception as e:
            logger.error(f"删除模块 {module_name} 状态时出错: {e}")
            return False
