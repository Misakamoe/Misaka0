# core/module_loader.py
import importlib
import os
import sys
import logging
import asyncio
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

        # 添加日志器
        self.logger = bot_engine.logger

        # 添加状态管理器
        from utils.state_manager import StateManager
        self.state_manager = StateManager()

        # 添加事件系统引用
        self.event_system = bot_engine.event_system
        self.subscriptions = []  # 存储模块的事件订阅，用于清理

    def register_command(self, command, callback, admin_only=False):
        """注册命令处理器"""
        # 使用命令处理器注册命令
        self.command_processor.register_command(command, callback, admin_only)

    def register_handler(self, handler, group=0):
        """注册自定义处理器"""
        self.application.add_handler(handler, group)
        self.registered_handlers.append((handler, group))

    def unregister_all_handlers(self):
        """注销所有注册的处理器和订阅"""
        # 注销处理器
        for handler, group in self.registered_handlers:
            try:
                self.application.remove_handler(handler, group)
            except Exception as e:
                pass
        self.registered_handlers.clear()

        # 取消所有事件订阅
        for subscription in self.subscriptions:
            self.event_system.unsubscribe(subscription)
        self.subscriptions.clear()

    # 添加状态管理方法
    def save_state(self, state, format="json"):
        """保存模块状态"""
        return self.state_manager.save_state(self.module_name, state, format)

    def load_state(self, default=None, format="json"):
        """加载模块状态"""
        return self.state_manager.load_state(self.module_name, default, format)

    def delete_state(self, format="json"):
        """删除模块状态"""
        return self.state_manager.delete_state(self.module_name, format)

    # 添加事件系统方法
    def subscribe_event(self, event_type, callback):
        """订阅事件"""
        subscription = self.event_system.subscribe(event_type, callback)
        if subscription:
            self.subscriptions.append(subscription)
        return subscription

    def unsubscribe_event(self, subscription):
        """取消订阅事件"""
        if self.event_system.unsubscribe(
                subscription) and subscription in self.subscriptions:
            self.subscriptions.remove(subscription)
            return True
        return False

    async def publish_event(self, event_type, **event_data):
        """发布事件"""
        return await self.event_system.publish(event_type,
                                               source_module=self.module_name,
                                               **event_data)

    # 添加模块间通信方法
    def get_module_interface(self, module_name):
        """获取其他模块的接口"""
        return self.bot_engine.module_loader.get_module_interface(module_name)

    async def call_module_method(self, module_name, method_name, *args,
                                 **kwargs):
        """调用其他模块的方法
        
        Args:
            module_name: 目标模块名称
            method_name: 方法名称
            *args, **kwargs: 传递给方法的参数
            
        Returns:
            方法的返回值，如果调用失败则返回 None
        """
        try:
            # 获取目标模块
            module_data = self.bot_engine.module_loader.loaded_modules.get(
                module_name)
            if not module_data:
                return None

            module = module_data["module"]

            # 检查方法是否存在
            if not hasattr(module, method_name) or not callable(
                    getattr(module, method_name)):
                return None

            # 获取方法
            method = getattr(module, method_name)

            # 调用方法
            if asyncio.iscoroutinefunction(method):
                return await method(*args, **kwargs)
            else:
                return method(*args, **kwargs)

        except Exception as e:
            self.bot_engine.logger.error(
                f"调用模块 {module_name} 的方法 {method_name} 时出错: {e}")
            return None


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

    def hot_reload_module(self,
                          module_name,
                          application=None,
                          bot_engine=None):
        """热更新模块，保留状态"""
        if module_name not in self.loaded_modules:
            self.logger.error(f"模块 {module_name} 未加载，无法热更新")
            return False

        try:
            # 保存当前模块状态
            old_module_data = self.loaded_modules[module_name]
            old_module = old_module_data["module"]
            old_interface = old_module_data.get("interface")

            # 保存模块状态（如果模块实现了 get_state 方法）
            module_state = None
            if hasattr(old_module, "get_state") and callable(
                    old_module.get_state):
                try:
                    if old_interface:
                        module_state = old_module.get_state(old_interface)
                    else:
                        module_state = old_module.get_state()
                    self.logger.debug(f"已保存模块 {module_name} 的状态")
                except Exception as e:
                    self.logger.warning(f"保存模块 {module_name} 状态时出错: {e}")

            # 注销当前处理器，但不调用 cleanup
            if old_interface:
                old_interface.unregister_all_handlers()

            # 从 sys.modules 中移除模块，强制重新加载
            module_paths = [
                module_name, f"modules.{module_name}", f".{module_name}"
            ]
            for path in module_paths:
                if path in sys.modules:
                    del sys.modules[path]

            # 重新加载模块代码
            module = None
            import_paths = [
                module_name, f"modules.{module_name}", f".{module_name}"
            ]

            for path in import_paths:
                try:
                    module = importlib.import_module(path)
                    importlib.reload(module)  # 强制重新加载
                    break
                except ImportError as e:
                    continue

            if module is None:
                self.logger.error(f"热更新: 无法重新加载模块 {module_name}")
                # 恢复旧模块
                self.loaded_modules[module_name] = old_module_data
                return False

            # 验证模块接口
            if not hasattr(module, "setup") or not callable(module.setup):
                self.logger.error(f"热更新: 模块 {module_name} 缺少 setup 方法")
                # 恢复旧模块
                self.loaded_modules[module_name] = old_module_data
                return False

            # 提取新的模块元数据
            metadata = {
                "name": getattr(module, "MODULE_NAME", module_name),
                "version": getattr(module, "MODULE_VERSION", "unknown"),
                "description": getattr(module, "MODULE_DESCRIPTION", ""),
                "dependencies": getattr(module, "MODULE_DEPENDENCIES", []),
                "commands": getattr(module, "MODULE_COMMANDS", [])
            }

            # 创建新的模块接口
            interface = None
            if application and bot_engine:
                interface = ModuleInterface(module_name, application,
                                            bot_engine)

            # 更新模块数据
            self.loaded_modules[module_name] = {
                "module": module,
                "metadata": metadata,
                "interface": interface
            }

            # 初始化模块
            if interface:
                # 调用模块的 setup 方法
                module.setup(interface)

                # 恢复模块状态（如果模块实现了 set_state 方法）
                if module_state is not None and hasattr(
                        module, "set_state") and callable(module.set_state):
                    try:
                        module.set_state(interface, module_state)
                        self.logger.debug(f"已恢复模块 {module_name} 的状态")
                    except Exception as e:
                        self.logger.warning(f"恢复模块 {module_name} 状态时出错: {e}")

            self.logger.info(f"成功热更新模块 {module_name} v{metadata['version']}")
            return True

        except Exception as e:
            self.logger.error(f"热更新模块 {module_name} 失败: {e}", exc_info=True)
            return False

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
