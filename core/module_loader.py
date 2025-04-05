# core/module_loader.py
import importlib
import os
import sys
import logging
from utils.logger import setup_logger


class ModuleInterface:
    """模块接口类，提供模块与核心系统交互的标准接口"""

    def __init__(self, module_name, application, bot_engine):
        self.module_name = module_name
        self.application = application
        self.bot_engine = bot_engine
        self.command_processor = bot_engine.command_processor
        self.config_manager = bot_engine.config_manager
        self.registered_handlers = []

    def register_command(self, command, callback, admin_only=False):
        """注册命令处理器"""
        # 使用命令处理器注册命令
        self.command_processor.register_command(command, callback, admin_only)

    def register_handler(self, handler, group=0):
        """注册自定义处理器"""
        self.application.add_handler(handler, group)
        self.registered_handlers.append((handler, group))

    def unregister_all_handlers(self):
        """注销所有注册的处理器"""
        for handler, group in self.registered_handlers:
            try:
                self.application.remove_handler(handler, group)
            except Exception as e:
                pass
        self.registered_handlers.clear()


class ModuleLoader:
    """模块加载器，负责发现、加载和卸载模块"""

    def __init__(self, modules_dir="modules"):
        self.modules_dir = modules_dir
        self.loaded_modules = {}
        self.logger = setup_logger("ModuleLoader")

        # 确保模块目录存在
        os.makedirs(modules_dir, exist_ok=True)

        # 将模块目录添加到 Python 路径
        if modules_dir not in sys.path:
            sys.path.append(os.path.abspath(modules_dir))

    def discover_modules(self):
        """发现可用模块"""
        available_modules = []

        # 打印模块目录路径，用于调试
        self.logger.debug(f"正在扫描模块目录: {os.path.abspath(self.modules_dir)}")

        # 检查目录是否存在
        if not os.path.exists(self.modules_dir) or not os.path.isdir(
                self.modules_dir):
            self.logger.error(f"模块目录不存在或不是目录: {self.modules_dir}")
            return available_modules

        # 遍历模块目录
        for item in os.listdir(self.modules_dir):
            module_path = os.path.join(self.modules_dir, item)

            self.logger.debug(f"发现项目: {item} (路径: {module_path})")

            # 检查是否是目录且包含 __init__.py 文件
            if os.path.isdir(module_path) and os.path.isfile(
                    os.path.join(module_path, "__init__.py")):
                available_modules.append(item)
                self.logger.debug(f"发现包模块: {item}")
            # 或者是 .py 文件但不是 __init__.py
            elif item.endswith(".py") and item != "__init__.py":
                available_modules.append(item[:-3])  # 去掉 .py 扩展名
                self.logger.debug(f"发现文件模块: {item[:-3]}")

        self.logger.info(f"发现可用模块: {available_modules}")
        return available_modules

    def load_module(self, module_name, application=None, bot_engine=None):
        """加载单个模块"""
        if module_name in self.loaded_modules:
            self.logger.info(f"模块 {module_name} 已加载")
            return self.loaded_modules[module_name]

        try:
            # 尝试从不同的位置导入模块
            module = None
            import_paths = [
                module_name,  # 直接导入
                f"modules.{module_name}",  # 从 modules 包导入
                f".{module_name}"  # 相对导入
            ]

            for path in import_paths:
                try:
                    self.logger.debug(f"尝试从 {path} 导入模块")
                    module = importlib.import_module(path)
                    self.logger.debug(f"成功从 {path} 导入模块")
                    break
                except ImportError as e:
                    self.logger.debug(f"从 {path} 导入失败: {e}")

            if module is None:
                self.logger.error(f"无法导入模块 {module_name}")
                return None

            # 验证模块接口
            if not hasattr(module, "setup") or not callable(module.setup):
                self.logger.error(f"模块 {module_name} 缺少 setup 方法")
                return None

            # 提取模块元数据
            metadata = {
                "name": getattr(module, "MODULE_NAME", module_name),
                "version": getattr(module, "MODULE_VERSION", "unknown"),
                "description": getattr(module, "MODULE_DESCRIPTION", ""),
                "dependencies": getattr(module, "MODULE_DEPENDENCIES", []),
                "commands": getattr(module, "MODULE_COMMANDS", [])  # 添加命令列表
            }

            # 创建模块接口
            interface = None
            if application and bot_engine:
                interface = ModuleInterface(module_name, application,
                                            bot_engine)

            # 存储模块和元数据
            self.loaded_modules[module_name] = {
                "module": module,
                "metadata": metadata,
                "interface": interface
            }

            self.logger.info(f"成功加载模块 {module_name} v{metadata['version']}")
            return self.loaded_modules[module_name]

        except Exception as e:
            self.logger.error(f"加载模块 {module_name} 失败: {e}", exc_info=True)
            return None

    def initialize_module(self, module_name, application, bot_engine):
        """初始化已加载的模块"""
        if module_name not in self.loaded_modules:
            self.logger.error(f"模块 {module_name} 未加载，无法初始化")
            return False

        module_data = self.loaded_modules[module_name]
        module = module_data["module"]

        # 如果模块接口不存在，创建一个
        if not module_data.get("interface"):
            module_data["interface"] = ModuleInterface(module_name,
                                                       application, bot_engine)

        try:
            # 调用模块的 setup 方法
            module.setup(module_data["interface"])
            self.logger.info(f"模块 {module_name} 已初始化")
            return True
        except Exception as e:
            self.logger.error(f"初始化模块 {module_name} 失败: {e}", exc_info=True)
            return False

    def unload_module(self, module_name):
        """卸载模块"""
        if module_name not in self.loaded_modules:
            self.logger.warning(f"模块 {module_name} 未加载")
            return False

        try:
            module_data = self.loaded_modules[module_name]
            module = module_data["module"]
            interface = module_data.get("interface")

            # 如果模块有 cleanup 方法，调用它
            if hasattr(module, "cleanup") and callable(module.cleanup):
                try:
                    if interface:
                        module.cleanup(interface)
                    else:
                        # 兼容旧接口
                        module.cleanup(None, None)
                except Exception as e:
                    self.logger.error(f"清理模块 {module_name} 失败: {e}")

            # 如果有接口，注销所有处理器
            if interface:
                interface.unregister_all_handlers()

            # 从已加载模块中移除
            del self.loaded_modules[module_name]

            # 尝试从 sys.modules 中移除模块
            module_paths = [
                module_name, f"modules.{module_name}", f".{module_name}"
            ]

            for path in module_paths:
                if path in sys.modules:
                    del sys.modules[path]

            self.logger.info(f"成功卸载模块 {module_name}")
            return True

        except Exception as e:
            self.logger.error(f"卸载模块 {module_name} 失败: {e}")
            return False

    def get_module_metadata(self, module_name):
        """获取模块元数据"""
        if module_name in self.loaded_modules:
            return self.loaded_modules[module_name]["metadata"]
        return None

    def is_module_loaded(self, module_name):
        """检查模块是否已加载"""
        return module_name in self.loaded_modules

    def get_module_interface(self, module_name):
        """获取模块接口"""
        if module_name in self.loaded_modules:
            return self.loaded_modules[module_name].get("interface")
        return None
