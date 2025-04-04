# core/module_loader.py
import importlib
import os
import sys
import logging


class ModuleLoader:

    def __init__(self, modules_dir="modules"):
        self.modules_dir = modules_dir
        self.loaded_modules = {}
        self.logger = logging.getLogger("ModuleLoader")

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

    def load_module(self, module_name):
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
                "dependencies": getattr(module, "MODULE_DEPENDENCIES", [])
            }

            # 存储模块和元数据
            self.loaded_modules[module_name] = {
                "module": module,
                "metadata": metadata
            }

            self.logger.info(f"成功加载模块 {module_name} v{metadata['version']}")
            return self.loaded_modules[module_name]

        except Exception as e:
            self.logger.error(f"加载模块 {module_name} 失败: {e}", exc_info=True)
            return None

    def unload_module(self, module_name):
        """卸载模块"""
        if module_name not in self.loaded_modules:
            self.logger.warning(f"模块 {module_name} 未加载")
            return False

        try:
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
