# core/config_manager.py

import os
import json
import logging
import time
from datetime import datetime
from utils.logger import setup_logger


class ConfigManager:
    """配置管理器，处理所有配置的加载、保存和访问"""

    def __init__(self, config_dir="config"):
        # 设置日志
        self.logger = setup_logger("ConfigManager")

        self.config_dir = config_dir
        self.main_config_path = os.path.join(config_dir, "config.json")
        self.modules_config_path = os.path.join(config_dir, "modules.json")

        # 配置缓存和文件哈希
        self.main_config = {}
        self.modules_config = {}
        self.main_config_hash = ""
        self.modules_config_hash = ""

        # 初始化配置
        self._ensure_config_dir()
        self.reload_all_configs()

    def _ensure_config_dir(self):
        """确保配置目录存在"""
        os.makedirs(self.config_dir, exist_ok=True)

    def _get_file_hash(self, file_path):
        """获取文件内容哈希值"""
        if not os.path.exists(file_path):
            return ""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                return hash(f.read())
        except Exception:
            return ""

    def _load_json_file(self, file_path, default_value=None):
        """从文件加载 JSON 数据"""
        if default_value is None:
            default_value = {}

        try:
            if os.path.exists(file_path):
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read().strip()
                    # 检查文件是否为空
                    if not content:
                        return default_value
                    return json.loads(content)
            return default_value
        except json.JSONDecodeError as e:
            self.logger.error(f"解析配置文件 {file_path} 失败: {e}")
            # 备份损坏的配置文件
            self._backup_corrupted_file(file_path)
            return default_value
        except Exception as e:
            self.logger.error(f"加载配置文件 {file_path} 失败: {e}")
            return default_value

    def _save_json_file(self, file_path, data):
        """保存 JSON 数据到文件"""
        try:
            with open(file_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=4, ensure_ascii=False)
            return True
        except Exception as e:
            self.logger.error(f"保存配置文件 {file_path} 失败: {e}")
            return False

    def _backup_corrupted_file(self, file_path):
        """备份损坏的配置文件"""
        if os.path.exists(file_path):
            backup_path = f"{file_path}.bak.{int(time.time())}"
            try:
                os.rename(file_path, backup_path)
                self.logger.info(f"已将损坏的配置文件备份为 {backup_path}")
            except Exception as e:
                self.logger.error(f"备份损坏的配置文件失败: {e}")

    def _reload_config(self, file_path, default_config, validate_func=None):
        """通用配置重新加载函数
        
        Args:
            file_path: 配置文件路径
            default_config: 默认配置
            validate_func: 配置验证函数
            
        Returns:
            dict: 加载的配置
        """
        # 获取当前文件哈希
        current_hash = self._get_file_hash(file_path)

        # 确定配置类型（main 或 modules）
        config_type = "main" if file_path == self.main_config_path else "modules"
        old_hash = self.main_config_hash if config_type == "main" else self.modules_config_hash
        config_changed = (current_hash != old_hash)

        # 加载配置
        new_config = self._load_json_file(file_path, default_config)

        # 检查是否需要补充缺失的配置项
        needs_save = False
        for key, value in default_config.items():
            if key not in new_config:
                new_config[key] = value
                needs_save = True

        # 如果有缺失的配置项，保存更新后的配置
        if needs_save:
            self._save_json_file(file_path, new_config)
            # 更新哈希值
            current_hash = self._get_file_hash(file_path)
            self.logger.info(f"{config_type} 配置已自动补充缺失项并保存")
            config_changed = True

        # 验证配置有效性
        if validate_func:
            validate_func(new_config)

        # 更新内存中的配置和哈希
        if config_type == "main":
            self.main_config = new_config
            self.main_config_hash = current_hash
        else:
            self.modules_config = new_config
            self.modules_config_hash = current_hash

        # 只在配置实际变化时输出日志
        if config_changed:
            self.logger.info(f"{config_type} 配置已重新加载")

        return new_config

    def reload_main_config(self):
        """重新加载主配置"""
        default_config = {
            "token": "",
            "admin_ids": [],
            "log_level": "INFO",
            "allowed_groups": {}
        }
        return self._reload_config(self.main_config_path, default_config,
                                   self._validate_main_config)

    def reload_modules_config(self):
        """重新加载模块配置"""
        default_config = {
            "enabled_modules": [],
            "group_modules": {},
            "module_configs": {}  # 添加模块配置部分
        }
        return self._reload_config(self.modules_config_path, default_config)

    def reload_all_configs(self):
        """重新加载所有配置"""
        self.reload_main_config()
        self.reload_modules_config()
        self.logger.info("所有配置已重新加载")

    def _validate_main_config(self, config):
        """验证主配置的有效性"""
        # 验证 token
        token = config.get("token", "")
        if token:
            # 检查 token 是否为示例值
            invalid_tokens = [
                'your_token_here', 'YOUR_TELEGRAM_BOT_TOKEN_HERE'
            ]
            if token in invalid_tokens or 'your_token' in token.lower(
            ) or 'token_here' in token.lower():
                self.logger.warning("配置中的 Bot Token 是示例值，请修改为真实值")

        # 验证管理员 ID
        admin_ids = config.get("admin_ids", [])
        if admin_ids:
            # 检查是否包含示例 ID
            if 123456789 in admin_ids:
                self.logger.warning("配置中的管理员 ID 包含示例值 123456789，请修改为真实值")

    def save_main_config(self):
        """保存主配置"""
        success = self._save_json_file(self.main_config_path, self.main_config)
        if success:
            # 更新哈希值
            self.main_config_hash = self._get_file_hash(self.main_config_path)
        return success

    def save_modules_config(self):
        """保存模块配置"""
        success = self._save_json_file(self.modules_config_path,
                                       self.modules_config)
        if success:
            # 更新哈希值
            self.modules_config_hash = self._get_file_hash(
                self.modules_config_path)
        return success

    # Token 管理
    def get_token(self):
        """获取 Bot Token，并验证其有效性"""
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
        """设置 Bot Token"""
        # 检查 token 是否为示例值
        invalid_tokens = ['your_token_here', 'YOUR_TELEGRAM_BOT_TOKEN_HERE']
        if token in invalid_tokens or 'your_token' in token.lower(
        ) or 'token_here' in token.lower():
            self.logger.warning("尝试设置示例 Bot Token，操作被拒绝")
            return False

        self.main_config["token"] = token
        return self.save_main_config()

    # 管理员管理
    def get_valid_admin_ids(self):
        """获取有效的管理员 ID 列表"""
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
        """检查用户是否为管理员"""
        return user_id in self.get_valid_admin_ids()

    def add_admin(self, user_id):
        """添加管理员"""
        # 检查是否是示例 ID
        if user_id == 123456789:
            self.logger.warning("尝试添加示例管理员 ID，操作被拒绝")
            return False

        if user_id not in self.main_config.get("admin_ids", []):
            self.main_config.setdefault("admin_ids", []).append(user_id)
            return self.save_main_config()
        return True

    def remove_admin(self, user_id):
        """移除管理员"""
        if user_id in self.main_config.get("admin_ids", []):
            self.main_config["admin_ids"].remove(user_id)
            return self.save_main_config()
        return True

    # 模块管理
    def get_enabled_modules(self):
        """获取已启用模块列表"""
        return self.modules_config.get("enabled_modules", [])

    def enable_module(self, module_name):
        """启用模块"""
        if module_name not in self.modules_config.get("enabled_modules", []):
            self.modules_config.setdefault("enabled_modules",
                                           []).append(module_name)
            return self.save_modules_config()
        return True

    def disable_module(self, module_name):
        """禁用模块"""
        if module_name in self.modules_config.get("enabled_modules", []):
            self.modules_config["enabled_modules"].remove(module_name)
            return self.save_modules_config()
        return True

    # 群组管理
    def is_allowed_group(self, group_id):
        """检查群组是否允许使用 bot"""
        allowed_groups = self.main_config.get("allowed_groups", {})
        return str(group_id) in allowed_groups

    def add_allowed_group(self, group_id, added_by):
        """添加允许的群组到白名单"""
        # 确保 allowed_groups 字段存在
        if "allowed_groups" not in self.main_config:
            self.main_config["allowed_groups"] = {}

        group_id_str = str(group_id)
        self.main_config["allowed_groups"][group_id_str] = {
            "added_by": added_by,
            "added_at": time.time()
        }
        # 保存配置
        success = self.save_main_config()
        if success:
            self.logger.info(f"群组 {group_id} 已添加到白名单")
        return success

    def remove_allowed_group(self, group_id):
        """从白名单移除群组"""
        if "allowed_groups" in self.main_config:
            group_id_str = str(group_id)
            if group_id_str in self.main_config["allowed_groups"]:
                del self.main_config["allowed_groups"][group_id_str]
                success = self.save_main_config()
                if success:
                    self.logger.info(f"群组 {group_id} 已从白名单移除")
                return success
        return False

    def list_allowed_groups(self):
        """列出所有允许的群组"""
        return self.main_config.get("allowed_groups", {})

    # 聊天特定的模块管理
    def get_enabled_modules_for_chat(self, chat_id):
        """获取指定聊天的已启用模块列表"""
        chat_id_str = str(chat_id)

        # 检查是否是群组 ID（群组 ID 通常为负数）
        if chat_id < 0:  # 群组 ID
            # 获取群组特定的模块列表，如果不存在则返回空列表
            return self.modules_config.get("group_modules",
                                           {}).get(chat_id_str, [])
        else:  # 私聊 ID
            # 私聊使用全局设置
            return self.modules_config.get("enabled_modules", [])

    def enable_module_for_chat(self, module_name, chat_id):
        """为特定聊天启用模块"""
        chat_id_str = str(chat_id)

        # 检查是否是群组 ID
        if chat_id < 0:  # 群组 ID
            # 确保 group_modules 存在
            if "group_modules" not in self.modules_config:
                self.modules_config["group_modules"] = {}

            # 确保该群组的配置存在，初始化为空列表
            if chat_id_str not in self.modules_config["group_modules"]:
                self.modules_config["group_modules"][chat_id_str] = []

            # 启用模块
            if module_name not in self.modules_config["group_modules"][
                    chat_id_str]:
                self.modules_config["group_modules"][chat_id_str].append(
                    module_name)
                return self.save_modules_config()
            return True
        else:  # 私聊 ID
            # 使用全局设置
            return self.enable_module(module_name)

    def disable_module_for_chat(self, module_name, chat_id):
        """为特定聊天禁用模块"""
        chat_id_str = str(chat_id)

        # 检查是否是群组 ID
        if chat_id < 0:  # 群组 ID
            # 确保 group_modules 存在
            if "group_modules" not in self.modules_config:
                self.modules_config["group_modules"] = {}

            # 确保该群组的配置存在，初始化为空列表
            if chat_id_str not in self.modules_config["group_modules"]:
                self.modules_config["group_modules"][chat_id_str] = []
                return self.save_modules_config()  # 已经是空列表，没有模块可禁用

            # 禁用模块
            if module_name in self.modules_config["group_modules"][
                    chat_id_str]:
                self.modules_config["group_modules"][chat_id_str].remove(
                    module_name)
                return self.save_modules_config()
            return True
        else:  # 私聊 ID
            # 使用全局设置
            return self.disable_module(module_name)

    def is_module_enabled_for_chat(self, module_name, chat_id):
        """检查模块是否在特定聊天中启用"""
        return module_name in self.get_enabled_modules_for_chat(chat_id)

    # 模块配置管理
    def get_module_config(self, module_name):
        """获取模块配置"""
        # 确保模块配置存在
        if "module_configs" not in self.modules_config:
            self.modules_config["module_configs"] = {}
            self.save_modules_config()

        # 返回模块配置，如果不存在则返回空字典
        return self.modules_config.get("module_configs",
                                       {}).get(module_name, {})

    def save_module_config(self, module_name, config):
        """保存模块配置"""
        # 确保模块配置存在
        if "module_configs" not in self.modules_config:
            self.modules_config["module_configs"] = {}

        # 更新配置
        self.modules_config["module_configs"][module_name] = config

        # 保存配置
        return self.save_modules_config()
