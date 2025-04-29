# core/config_manager.py - 配置管理器

import os
import json
import time
from utils.logger import setup_logger


class ConfigManager:
    """配置管理器，处理配置的加载、保存和访问"""

    def __init__(self, config_dir="config"):
        self.config_dir = config_dir
        self.main_config_path = os.path.join(config_dir, "config.json")

        # 设置日志
        self.logger = setup_logger("ConfigManager")

        # 配置缓存
        self.main_config = {}

        # 确保配置目录存在
        os.makedirs(self.config_dir, exist_ok=True)

        # 加载配置
        self.reload_all_configs()

    def _load_json_file(self, file_path, default_value=None):
        """从文件加载 JSON 数据

        Args:
            file_path: 文件路径
            default_value: 默认值

        Returns:
            dict: 加载的数据或默认值
        """
        if default_value is None:
            default_value = {}

        try:
            if os.path.exists(file_path):
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                    if not content:
                        return default_value
                    return json.loads(content)
            return default_value
        except json.JSONDecodeError as e:
            self.logger.error(f"解析配置文件 {file_path} 失败: {e}")
            self._backup_corrupted_file(file_path)
            return default_value
        except Exception as e:
            self.logger.error(f"加载配置文件 {file_path} 失败: {e}")
            return default_value

    def _save_json_file(self, file_path, data):
        """保存 JSON 数据到文件

        Args:
            file_path: 文件路径
            data: 要保存的数据

        Returns:
            bool: 是否成功保存
        """
        try:
            # 确保父目录存在
            os.makedirs(os.path.dirname(file_path), exist_ok=True)

            # 保存数据
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
            return True
        except Exception as e:
            self.logger.error(f"保存配置文件 {file_path} 失败: {e}")
            return False

    def _backup_corrupted_file(self, file_path):
        """备份损坏的配置文件

        Args:
            file_path: 文件路径
        """
        if os.path.exists(file_path):
            backup_path = f"{file_path}.bak.{int(time.time())}"
            try:
                os.rename(file_path, backup_path)
                self.logger.debug(f"已将损坏的配置文件备份为 {backup_path}")
            except Exception as e:
                self.logger.error(f"备份损坏的配置文件 {file_path} 失败: {e}")

    def reload_main_config(self):
        """重新加载主配置

        Returns:
            dict: 加载的配置
        """
        default_config = {
            "token": "",
            "admin_ids": [],
            "log_level": "INFO",
            "allowed_groups": {},
            "network": {
                "connect_timeout": 20.0,
                "read_timeout": 20.0,
                "write_timeout": 20.0,
                "poll_interval": 1.0
            }
        }

        # 加载配置
        config = self._load_json_file(self.main_config_path, default_config)

        # 检查是否需要补充缺失的配置项
        needs_save = False
        for key, value in default_config.items():
            if key not in config:
                config[key] = value
                needs_save = True

        # 如果有缺失的配置项，保存配置
        if needs_save:
            self._save_json_file(self.main_config_path, config)
            self.logger.debug("已自动补充主配置中的缺失项并保存")

        self.main_config = config
        return config

    def reload_all_configs(self):
        """重新加载所有配置"""
        self.reload_main_config()
        self.logger.debug("所有配置已重新加载")

    def save_main_config(self):
        """保存主配置

        Returns:
            bool: 是否成功保存
        """
        return self._save_json_file(self.main_config_path, self.main_config)

    def get_token(self):
        """获取 Bot Token

        Returns:
            str: Bot Token
        """
        token = self.main_config.get("token", "")

        # 检查 token 是否为空
        if not token:
            self.logger.warning("Bot Token 未设置")
            return ""

        # 检查 token 是否为示例值
        invalid_tokens = ['your_token_here', 'YOUR_TELEGRAM_BOT_TOKEN_HERE']
        if token in invalid_tokens or 'your_token' in token.lower(
        ) or 'token_here' in token.lower():
            self.logger.warning("Bot Token 是示例值，请修改为真实值")
            return ""

        return token

    def set_token(self, token):
        """设置 Bot Token

        Args:
            token: Token 字符串

        Returns:
            bool: 是否成功设置
        """
        # 检查 token 是否为示例值
        invalid_tokens = ['your_token_here', 'YOUR_TELEGRAM_BOT_TOKEN_HERE']
        if token in invalid_tokens or 'your_token' in token.lower(
        ) or 'token_here' in token.lower():
            self.logger.warning("尝试设置示例 Token，操作被拒绝")
            return False

        self.main_config["token"] = token
        return self.save_main_config()

    def get_valid_admin_ids(self):
        """获取有效的管理员 ID 列表

        Returns:
            list: 管理员 ID 列表
        """
        admin_ids = self.main_config.get("admin_ids", [])

        # 检查是否为空
        if not admin_ids:
            self.logger.warning("管理员 ID 列表为空")
            return []

        # 过滤掉示例 ID
        valid_ids = [id for id in admin_ids if id != 123456789]

        # 如果过滤后为空，记录警告
        if not valid_ids and 123456789 in admin_ids:
            self.logger.warning("管理员 ID 列表仅包含示例值 123456789")

        return valid_ids

    def is_admin(self, user_id):
        """检查用户是否为管理员

        Args:
            user_id: 用户 ID

        Returns:
            bool: 是否为管理员
        """
        return user_id in self.get_valid_admin_ids()

    def is_allowed_group(self, group_id):
        """检查群组是否允许使用 bot

        Args:
            group_id: 群组 ID

        Returns:
            bool: 是否允许
        """
        allowed_groups = self.main_config.get("allowed_groups", {})
        return str(group_id) in allowed_groups

    def add_allowed_group(self, group_id, added_by, group_name=None):
        """添加允许的群组到白名单

        Args:
            group_id: 群组 ID
            added_by: 添加者 ID
            group_name: 群组名称（可选）

        Returns:
            bool: 是否成功添加
        """
        # 确保 allowed_groups 字段存在
        if "allowed_groups" not in self.main_config:
            self.main_config["allowed_groups"] = {}

        group_id_str = str(group_id)
        group_data = {"added_by": added_by, "added_at": time.time()}

        # 如果提供了群组名称，添加到数据中
        if group_name:
            group_data["group_name"] = group_name

        self.main_config["allowed_groups"][group_id_str] = group_data

        # 保存配置
        success = self.save_main_config()
        if success:
            self.logger.debug(f"群组 {group_id} 已添加到白名单")
        return success

    def remove_allowed_group(self, group_id):
        """从白名单移除群组

        Args:
            group_id: 群组 ID

        Returns:
            bool: 是否成功移除
        """
        if "allowed_groups" in self.main_config:
            group_id_str = str(group_id)
            if group_id_str in self.main_config["allowed_groups"]:
                del self.main_config["allowed_groups"][group_id_str]
                success = self.save_main_config()
                if success:
                    self.logger.debug(f"群组 {group_id} 已从白名单移除")
                return success
        return False

    def list_allowed_groups(self):
        """列出所有允许的群组

        Returns:
            dict: 群组信息
        """
        return self.main_config.get("allowed_groups", {})
