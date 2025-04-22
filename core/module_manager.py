# core/module_manager.py - 模块管理器

import os
import sys
import asyncio
import importlib
import traceback
from utils.logger import setup_logger


class ModuleInterface:
    """模块接口，为模块提供与系统交互的标准接口"""

    def __init__(self, module_name, application, module_manager,
                 command_manager, event_system, state_manager):
        self.module_name = module_name
        self.application = application
        self.module_manager = module_manager
        self.command_manager = command_manager
        self.event_system = event_system
        self.state_manager = state_manager
        self.config_manager = module_manager.config_manager
        self.logger = setup_logger(f"Module.{module_name}")

        # 资源跟踪
        self.handlers = []  # [(handler, group)]
        self.commands = []  # [command_name]
        self.event_subscriptions = []  # [(event_type, callback)]

    async def register_command(self,
                               command_name,
                               callback,
                               admin_level=False,
                               description=""):
        """注册命令
        
        Args:
            command_name: 命令名称
            callback: 命令回调函数
            admin_level: 权限级别 (False, "group_admin", "super_admin")
            description: 命令描述
            
        Returns:
            bool: 是否成功注册
        """
        success = await self.command_manager.register_module_command(
            self.module_name, command_name, callback, admin_level, description)

        if success:
            self.commands.append(command_name)

        return success

    async def register_handler(self, handler, group=0):
        """注册消息处理器
        
        Args:
            handler: 处理器对象
            group: 处理器组
            
        Returns:
            bool: 是否成功注册
        """
        # 保存原始回调函数引用
        original_callback = handler.callback

        async def chat_type_checked_callback(update, context):
            # 获取当前聊天类型和ID
            chat_id = update.effective_chat.id if update.effective_chat else None
            chat_type = self.get_chat_type(update)

            # 获取模块支持的聊天类型
            module = self.module_manager.get_module_info(
                self.module_name)["module"]
            supported_types = getattr(module, "MODULE_CHAT_TYPES",
                                      ["private", "group"])

            # 检查聊天类型是否被支持
            if chat_type not in supported_types:
                return

            # 如果是群组，检查是否在白名单中
            if chat_type == "group" and not self.config_manager.is_allowed_group(
                    chat_id):
                return

            # 调用原始回调
            return await original_callback(update, context)

        # 替换回调函数
        handler.callback = chat_type_checked_callback

        # 直接注册处理器
        self.application.add_handler(handler, group)
        self.logger.debug(f"为模块 {self.module_name} 添加处理器")

        # 跟踪处理器以便清理
        self.handlers.append((handler, group))
        return True

    async def subscribe_event(self, event_type, callback):
        """订阅事件
        
        Args:
            event_type: 事件类型
            callback: 事件回调函数
            
        Returns:
            bool: 是否成功订阅
        """

        # 包装回调确保适用于聊天类型
        async def chat_type_checked_callback(event_type, **event_data):
            # 获取聊天ID
            chat_id = event_data.get("chat_id")

            # 获取模块支持的聊天类型
            module = self.module_manager.get_module_info(
                self.module_name)["module"]
            supported_types = getattr(module, "MODULE_CHAT_TYPES",
                                      ["private", "group"])

            # 确定事件的聊天类型
            chat_type = "global"  # 默认为全局事件
            if chat_id is not None:
                chat_type = "group" if chat_id < 0 else "private"

            # 检查聊天类型是否被支持
            if chat_type not in supported_types:
                return

            # 如果是群组，检查是否在白名单中
            if chat_type == "group" and not self.config_manager.is_allowed_group(
                    chat_id):
                return

            # 调用原始回调
            return await callback(event_type, **event_data)

        # 订阅事件
        subscription = self.event_system.subscribe(event_type,
                                                   chat_type_checked_callback)
        if subscription:
            self.event_subscriptions.append(subscription)
            return True

        return False

    def get_chat_type(self, update):
        """获取更新的聊天类型
        
        Args:
            update: Telegram更新对象
            
        Returns:
            str: 聊天类型 ("private", "group" 或 "global")
        """
        if not update or not update.effective_chat:
            return "global"

        chat_id = update.effective_chat.id
        if chat_id < 0:
            return "group"
        else:
            return "private"

    async def publish_event(self, event_type, **event_data):
        """发布事件
        
        Args:
            event_type: 事件类型
            **event_data: 事件数据
            
        Returns:
            int: 收到事件的订阅者数量
        """
        return await self.event_system.publish(event_type,
                                               source_module=self.module_name,
                                               **event_data)

    def save_state(self, state):
        """保存模块状态
        
        Args:
            state: 要保存的状态（必须可序列化）
            
        Returns:
            bool: 是否成功保存
        """
        return self.state_manager.save_state(self.module_name, state)

    def load_state(self, default=None):
        """加载模块状态
        
        Args:
            default: 默认状态（如果没有保存的状态）
            
        Returns:
            Any: 加载的状态或默认值
        """
        return self.state_manager.load_state(self.module_name, default)

    async def cleanup(self):
        """清理模块资源，在模块卸载前调用"""
        # 注销所有处理器
        for handler, group in self.handlers:
            try:
                # 直接移除处理器
                self.application.remove_handler(handler, group)
                self.logger.debug(f"为模块 {self.module_name} 移除处理器")
            except Exception as e:
                self.logger.error(f"移除处理器时出错: {e}")

        # 取消所有事件订阅
        for subscription in self.event_subscriptions:
            try:
                self.event_system.unsubscribe(subscription)
            except Exception as e:
                self.logger.error(f"取消事件订阅时出错: {e}")

        # 重置资源跟踪
        self.handlers = []
        self.event_subscriptions = []
        self.commands = []


class ModuleManager:
    """模块管理器，负责模块的加载和卸载"""

    def __init__(self,
                 application,
                 config_manager,
                 command_manager,
                 event_system,
                 state_manager,
                 modules_dir="modules"):
        self.application = application
        self.config_manager = config_manager
        self.command_manager = command_manager
        self.event_system = event_system
        self.state_manager = state_manager
        self.modules_dir = modules_dir
        self.logger = setup_logger("ModuleManager")

        # 模块跟踪
        self.loaded_modules = {}  # 模块名 -> {module, interface, metadata}
        self.module_locks = {}  # 模块名 -> 锁

        # 确保模块目录存在
        os.makedirs(modules_dir, exist_ok=True)

        # 添加模块目录到 Python 路径
        if modules_dir not in sys.path:
            sys.path.append(os.path.abspath(modules_dir))

        # 模块管理器初始化完成
        self.logger.info("模块管理器初始化完成")

    async def start(self):
        """启动模块管理器"""
        # 加载所有模块
        await self.load_all_modules()

    async def stop(self):
        """停止模块管理器"""
        # 卸载所有模块
        await self.unload_all_modules()

    async def load_all_modules(self):
        """加载所有可用模块"""
        # 获取所有可用模块
        available_modules = self.discover_modules()
        self.logger.info(f"正在加载所有可用模块: {available_modules}")

        if not available_modules:
            self.logger.info("没有可用模块需要加载")
            return

        # 加载所有模块
        for module_name in available_modules:
            await self.load_module(module_name)

    async def load_module(self, module_name):
        """加载模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 是否成功加载
        """
        # 获取模块锁
        async with self._get_module_lock(module_name):
            # 检查模块是否已加载
            if module_name in self.loaded_modules:
                self.logger.debug(f"模块 {module_name} 已加载")
                return True

            try:
                # 获取模块元数据
                metadata = await self._get_module_metadata(module_name)
                if not metadata:
                    self.logger.error(f"无法获取模块 {module_name} 的元数据")
                    return False

                # 加载模块
                module = await self._import_module(module_name)
                if not module:
                    self.logger.error(f"无法导入模块 {module_name}")
                    return False

                # 验证模块接口
                if not hasattr(module, "setup") or not callable(module.setup):
                    self.logger.error(f"模块 {module_name} 缺少 setup 方法")
                    return False

                # 检查模块是否声明了支持的聊天类型
                if not hasattr(module, "MODULE_CHAT_TYPES"):
                    self.logger.warning(
                        f"模块 {module_name} 未声明 MODULE_CHAT_TYPES，默认为全部支持")
                    setattr(module, "MODULE_CHAT_TYPES", ["private", "group"])

                # 创建模块接口
                interface = ModuleInterface(module_name, self.application,
                                            self, self.command_manager,
                                            self.event_system,
                                            self.state_manager)

                # 初始化模块
                try:
                    await module.setup(interface)

                    # 添加到已加载模块
                    self.loaded_modules[module_name] = {
                        "module": module,
                        "interface": interface,
                        "metadata": metadata
                    }

                    self.logger.info(f"模块 {module_name} 已加载")
                    return True

                except Exception as e:
                    self.logger.error(f"初始化模块 {module_name} 失败: {e}")
                    self.logger.debug(traceback.format_exc())
                    return False

            except Exception as e:
                self.logger.error(f"加载模块 {module_name} 时出错: {e}")
                self.logger.debug(traceback.format_exc())
                return False

    async def unload_module(self, module_name):
        """卸载模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 是否成功卸载
        """
        # 获取模块锁
        async with self._get_module_lock(module_name):
            # 检查模块是否已加载
            if module_name not in self.loaded_modules:
                self.logger.debug(f"模块 {module_name} 未加载，无需卸载")
                return True

            # 卸载模块
            success = await self._unload_module(module_name)
            if success:
                self.logger.info(f"模块 {module_name} 已卸载")
                return True
            else:
                self.logger.error(f"卸载模块 {module_name} 失败")
                return False

    async def _unload_module(self, module_name):
        """卸载模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 是否成功卸载
        """
        if module_name not in self.loaded_modules:
            return True

        try:
            # 获取模块信息
            module_info = self.loaded_modules[module_name]
            module = module_info["module"]
            interface = module_info["interface"]

            # 调用模块的 cleanup 方法（如果存在）
            if hasattr(module, "cleanup") and callable(module.cleanup):
                try:
                    await module.cleanup(interface)
                except Exception as e:
                    self.logger.error(
                        f"调用模块 {module_name} 的 cleanup 方法出错: {e}")

            # 清理模块接口 - 这会安排处理器移除操作而不是直接移除
            await interface.cleanup()

            # 注销命令
            await self.command_manager.unregister_module_commands(module_name)

            # 从已加载模块中移除
            del self.loaded_modules[module_name]

            # 尝试从缓存中卸载模块
            module_path = f"{self.modules_dir}.{module_name}"
            if module_path in sys.modules:
                del sys.modules[module_path]

            if module_name in sys.modules:
                del sys.modules[module_name]

            return True

        except Exception as e:
            self.logger.error(f"卸载模块 {module_name} 时出错: {e}")
            return False

    async def unload_all_modules(self):
        """卸载所有模块"""
        modules_to_unload = list(self.loaded_modules.keys())

        for module_name in modules_to_unload:
            await self._unload_module(module_name)

        self.logger.info(f"已卸载全部 {len(modules_to_unload)} 个模块")

    def get_module_info(self, module_name):
        """获取模块信息
        
        Args:
            module_name: 模块名称
            
        Returns:
            dict: 模块信息或 None
        """
        return self.loaded_modules.get(module_name)

    def is_module_loaded(self, module_name):
        """检查模块是否已加载
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 模块是否已加载
        """
        return module_name in self.loaded_modules

    def get_loaded_modules(self):
        """获取所有已加载模块的信息
        
        Returns:
            dict: 模块名称 -> 模块信息
        """
        return self.loaded_modules

    def discover_modules(self):
        """发现可用模块
        
        Returns:
            list: 可用模块列表
        """
        available_modules = []

        # 检查模块目录
        if not os.path.exists(self.modules_dir):
            return available_modules

        # 扫描目录
        for item in os.listdir(self.modules_dir):
            # 跳过以下划线开头的文件和目录
            if item.startswith('_'):
                continue

            # 处理 Python 文件
            if item.endswith('.py'):
                module_name = item[:-3]  # 去掉 .py 后缀
                available_modules.append(module_name)

            # 处理包（包含 __init__.py 的目录）
            elif os.path.isdir(os.path.join(self.modules_dir, item)) and \
                 os.path.exists(os.path.join(self.modules_dir, item, '__init__.py')):
                available_modules.append(item)

        return available_modules

    def _get_module_lock(self, module_name):
        """获取模块的锁
        
        Args:
            module_name: 模块名称
            
        Returns:
            asyncio.Lock: 模块锁
        """
        if module_name not in self.module_locks:
            self.module_locks[module_name] = asyncio.Lock()
        return self.module_locks[module_name]

    async def _import_module(self, module_name):
        """导入模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            module: 导入的模块或 None
        """
        try:
            # 尝试从不同的路径导入
            try:
                # 直接导入
                return importlib.import_module(module_name)
            except ImportError:
                # 从模块目录导入
                return importlib.import_module(
                    f"{self.modules_dir}.{module_name}")
        except Exception as e:
            self.logger.error(f"导入模块 {module_name} 失败: {e}")
            self.logger.debug(traceback.format_exc())
            return None

    async def _get_module_metadata(self, module_name):
        """获取模块元数据
        
        Args:
            module_name: 模块名称
            
        Returns:
            dict: 模块元数据或 None
        """
        # 模块文件路径
        module_file = os.path.join(self.modules_dir, f"{module_name}.py")

        # 检查文件是否存在
        if not os.path.exists(module_file):
            self.logger.error(f"模块文件不存在: {module_file}")
            return None

        try:
            # 导入模块
            module = await self._import_module(module_name)
            if not module:
                return None

            # 提取元数据
            metadata = {
                "name":
                getattr(module, "MODULE_NAME", module_name),
                "version":
                getattr(module, "MODULE_VERSION", "unknown"),
                "description":
                getattr(module, "MODULE_DESCRIPTION", ""),
                "commands":
                getattr(module, "MODULE_COMMANDS", []),
                "author":
                getattr(module, "MODULE_AUTHOR", "unknown"),
                "chat_types":
                getattr(module, "MODULE_CHAT_TYPES", ["private", "group"]),
            }

            return metadata
        except Exception as e:
            self.logger.error(f"获取模块 {module_name} 元数据失败: {e}")
            return None
