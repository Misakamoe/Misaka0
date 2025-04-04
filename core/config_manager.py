# core/config_manager.py
import os
import json
import logging
import time


class ConfigManager:

    def __init__(self, config_dir="config"):
        # 设置日志
        self.logger = logging.getLogger("ConfigManager")

        self.config_dir = config_dir
        self.main_config_path = os.path.join(config_dir, "config.json")
        self.modules_config_path = os.path.join(config_dir, "modules.json")

        # 配置缓存和时间戳
        self.main_config = {}
        self.modules_config = {}
        self.main_config_timestamp = 0
        self.modules_config_timestamp = 0

        # 初始化配置
        self.reload_main_config()
        self.reload_modules_config()

    def _load_config(self, config_path, default_config):
        """加载配置文件，如果不存在则创建默认配置"""
        os.makedirs(os.path.dirname(config_path), exist_ok=True)

        if os.path.exists(config_path):
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                    # 检查文件是否为空
                    if not content:
                        # 文件为空，写入默认配置
                        with open(config_path, 'w', encoding='utf-8') as wf:
                            json.dump(default_config, wf, indent=4)
                        return default_config
                    return json.loads(content)
            except Exception as e:
                self.logger.error(f"加载配置文件 {config_path} 失败: {e}")
                # 备份损坏的配置文件
                if os.path.exists(config_path):
                    backup_path = f"{config_path}.bak.{int(time.time())}"
                    try:
                        os.rename(config_path, backup_path)
                        self.logger.info(f"已将损坏的配置文件备份为 {backup_path}")
                    except Exception:
                        pass
                # 创建新的默认配置
                with open(config_path, 'w', encoding='utf-8') as f:
                    json.dump(default_config, f, indent=4)
                return default_config
        else:
            # 创建默认配置文件
            with open(config_path, 'w', encoding='utf-8') as f:
                json.dump(default_config, f, indent=4)
            return default_config

    def reload_main_config(self):
        """重新加载主配置"""
        default_config = {"token": "", "admin_ids": [], "log_level": "INFO"}

        if os.path.exists(self.main_config_path):
            self.main_config_timestamp = os.path.getmtime(
                self.main_config_path)

        self.main_config = self._load_config(self.main_config_path,
                                             default_config)
        self.logger.info("主配置已重新加载")
        return self.main_config

    def reload_modules_config(self):
        """重新加载模块配置"""
        default_config = {"enabled_modules": []}

        if os.path.exists(self.modules_config_path):
            self.modules_config_timestamp = os.path.getmtime(
                self.modules_config_path)

        self.modules_config = self._load_config(self.modules_config_path,
                                                default_config)
        self.logger.info("模块配置已重新加载")
        return self.modules_config

    def reload_all_configs(self):
        """重新加载所有配置"""
        self.reload_main_config()
        self.reload_modules_config()
        self.logger.info("所有配置已重新加载")

    def save_main_config(self):
        """保存主配置"""
        # 检查是否需要更新文件
        if os.path.exists(self.main_config_path):
            if self.main_config_timestamp >= os.path.getmtime(
                    self.main_config_path):
                with open(self.main_config_path, 'w', encoding='utf-8') as f:
                    json.dump(self.main_config, f, indent=4)
                self.main_config_timestamp = os.path.getmtime(
                    self.main_config_path)
                return

        # 文件不存在或需要更新
        with open(self.main_config_path, 'w', encoding='utf-8') as f:
            json.dump(self.main_config, f, indent=4)

        if os.path.exists(self.main_config_path):
            self.main_config_timestamp = os.path.getmtime(
                self.main_config_path)

    def save_modules_config(self):
        """保存模块配置"""
        # 检查是否需要更新文件
        if os.path.exists(self.modules_config_path):
            if self.modules_config_timestamp >= os.path.getmtime(
                    self.modules_config_path):
                with open(self.modules_config_path, 'w',
                          encoding='utf-8') as f:
                    json.dump(self.modules_config, f, indent=4)
                self.modules_config_timestamp = os.path.getmtime(
                    self.modules_config_path)
                return

        # 文件不存在或需要更新
        with open(self.modules_config_path, 'w', encoding='utf-8') as f:
            json.dump(self.modules_config, f, indent=4)

        if os.path.exists(self.modules_config_path):
            self.modules_config_timestamp = os.path.getmtime(
                self.modules_config_path)

    def get_token(self):
        """获取 Bot Token"""
        return self.main_config.get("token", "")

    def set_token(self, token):
        """设置 Bot Token"""
        self.main_config["token"] = token
        self.save_main_config()

    def is_admin(self, user_id):
        """检查用户是否为管理员"""
        return user_id in self.main_config.get("admin_ids", [])

    def add_admin(self, user_id):
        """添加管理员"""
        if user_id not in self.main_config.get("admin_ids", []):
            self.main_config.setdefault("admin_ids", []).append(user_id)
            self.save_main_config()

    def get_enabled_modules(self):
        """获取已启用模块列表"""
        return self.modules_config.get("enabled_modules", [])

    def enable_module(self, module_name):
        """启用模块"""
        if module_name not in self.modules_config.get("enabled_modules", []):
            self.modules_config.setdefault("enabled_modules",
                                           []).append(module_name)
            self.save_modules_config()

    def disable_module(self, module_name):
        """禁用模块"""
        if module_name in self.modules_config.get("enabled_modules", []):
            self.modules_config["enabled_modules"].remove(module_name)
            self.save_modules_config()
