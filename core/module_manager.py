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
        # 将处理器包装在模块启用检查中
        original_callback = handler.callback

        async def checked_callback(update, context):
            # 检查模块是否在当前聊天中启用
            chat_id = update.effective_chat.id if update.effective_chat else None
            if not chat_id or not self.config_manager.is_module_enabled_for_chat(
                    self.module_name, chat_id):
                return

            # 调用原始回调
            return await original_callback(update, context)

        # 替换回调函数
        handler.callback = checked_callback

        # 添加到应用
        self.application.add_handler(handler, group)
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

        # 包装回调确保模块已启用
        async def checked_callback(event_type, **event_data):
            # 检查模块是否在当前聊天中启用
            chat_id = event_data.get("chat_id")

            # 如果没有提供聊天 ID，使用全局启用检查
            if chat_id is None:
                if not self.config_manager.is_module_enabled(self.module_name):
                    return
            # 否则检查特定聊天
            elif not self.config_manager.is_module_enabled_for_chat(
                    self.module_name, chat_id):
                return

            # 调用原始回调
            return await callback(event_type, **event_data)

        # 订阅事件
        subscription = self.event_system.subscribe(event_type,
                                                   checked_callback)
        if subscription:
            self.event_subscriptions.append(subscription)
            return True

        return False

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
                self.application.remove_handler(handler, group)
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

        # 命令将由 CommandManager 统一清理
        self.commands = []


class ModuleManager:
    """模块管理器，负责模块的加载、卸载、启用和禁用"""

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

        # 依赖跟踪
        self.dependencies = {}  # 模块名 -> [依赖模块]
        self.dependents = {}  # 模块名 -> [依赖此模块的模块]

        # 确保模块目录存在
        os.makedirs(modules_dir, exist_ok=True)

        # 添加模块目录到 Python 路径
        if modules_dir not in sys.path:
            sys.path.append(os.path.abspath(modules_dir))

    async def load_enabled_modules(self):
        """加载所有启用的模块"""
        # 获取全局启用的模块
        enabled_modules = self.config_manager.get_enabled_modules()
        self.logger.info(f"正在加载全局启用的模块: {enabled_modules}")

        # 获取群组启用的模块
        group_modules = set()
        for modules in self.config_manager.modules_config.get(
                "group_modules", {}).values():
            group_modules.update(modules)

        if group_modules:
            self.logger.info(f"正在加载群组启用的模块: {list(group_modules)}")

        # 合并去重
        all_modules = list(set(enabled_modules) | group_modules)

        if not all_modules:
            self.logger.info("没有启用的模块需要加载")
            return

        # 构建模块依赖图
        dependencies = await self._build_dependency_graph(all_modules)

        # 检测循环依赖
        circular_deps = self._detect_circular_dependencies(dependencies)
        if circular_deps:
            for cycle in circular_deps:
                self.logger.error(f"检测到循环依赖: {' -> '.join(cycle)}")

        # 按照依赖顺序加载模块
        sorted_modules = self._sort_modules_by_dependencies(
            all_modules, dependencies)

        # 加载模块
        for module_name in sorted_modules:
            await self.load_and_enable_module(module_name)

    async def load_and_enable_module(self, module_name):
        """加载并启用模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 是否成功加载并启用
        """
        # 获取模块锁
        async with self._get_module_lock(module_name):
            # 检查模块是否已加载
            if module_name in self.loaded_modules:
                self.logger.debug(f"模块 {module_name} 已加载")
                return True

            # 获取模块依赖
            try:
                metadata = await self._get_module_metadata(module_name)
                if not metadata:
                    self.logger.error(f"无法获取模块 {module_name} 的元数据")
                    return False

                dependencies = metadata.get("dependencies", [])

                # 先加载依赖
                for dep in dependencies:
                    # 检查依赖是否已启用
                    if dep not in self.config_manager.get_enabled_modules():
                        self.logger.info(f"自动启用依赖模块: {dep}")
                        self.config_manager.enable_module(dep)

                    # 加载依赖
                    dep_loaded = await self.load_and_enable_module(dep)
                    if not dep_loaded:
                        self.logger.error(
                            f"加载依赖 {dep} 失败，无法加载模块 {module_name}")
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

                # 创建模块接口
                interface = ModuleInterface(module_name, self.application,
                                            self, self.command_manager,
                                            self.event_system,
                                            self.state_manager)

                # 初始化模块
                try:
                    await module.setup(interface)

                    # 更新依赖跟踪
                    self.dependencies[module_name] = dependencies
                    for dep in dependencies:
                        if dep not in self.dependents:
                            self.dependents[dep] = []
                        if module_name not in self.dependents[dep]:
                            self.dependents[dep].append(module_name)

                    # 添加到已加载模块
                    self.loaded_modules[module_name] = {
                        "module": module,
                        "interface": interface,
                        "metadata": metadata
                    }

                    self.logger.info(f"模块 {module_name} 已加载并启用")
                    return True

                except Exception as e:
                    self.logger.error(f"初始化模块 {module_name} 失败: {e}")
                    self.logger.debug(traceback.format_exc())
                    return False

            except Exception as e:
                self.logger.error(f"加载模块 {module_name} 时出错: {e}")
                self.logger.debug(traceback.format_exc())
                return False

    async def disable_and_unload_module(self, module_name, force=False):
        """禁用并卸载模块
        
        Args:
            module_name: 模块名称
            force: 是否强制卸载（即使有其他模块依赖它）
            
        Returns:
            Tuple[bool, List[str]]: (是否成功, 依赖此模块的模块列表)
        """
        # 获取模块锁
        async with self._get_module_lock(module_name):
            # 检查模块是否已加载
            if module_name not in self.loaded_modules:
                self.logger.debug(f"模块 {module_name} 未加载，无需禁用")
                return True, []

            # 检查是否有模块依赖此模块
            dependent_modules = self.dependents.get(module_name, [])
            if dependent_modules and not force:
                self.logger.warning(
                    f"模块 {module_name} 被以下模块依赖: {dependent_modules}")
                return False, dependent_modules

            # 如果强制卸载，先卸载所有依赖此模块的模块
            if dependent_modules and force:
                for dep_mod in dependent_modules.copy():  # 创建副本以避免修改迭代中的列表
                    success, _ = await self.disable_and_unload_module(
                        dep_mod, force=True)
                    if not success:
                        self.logger.error(f"卸载依赖模块 {dep_mod} 失败")
                        return False, dependent_modules

            # 卸载模块
            success = await self._unload_module(module_name)
            if success:
                self.logger.info(f"模块 {module_name} 已禁用并卸载")
                return True, []
            else:
                self.logger.error(f"禁用并卸载模块 {module_name} 失败")
                return False, []

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

            # 清理模块接口
            await interface.cleanup()

            # 注销命令
            await self.command_manager.unregister_module_commands(module_name)

            # 更新依赖跟踪
            if module_name in self.dependencies:
                # 减少其依赖模块的被依赖计数
                for dep in self.dependencies[module_name]:
                    if dep in self.dependents and module_name in self.dependents[
                            dep]:
                        self.dependents[dep].remove(module_name)
                del self.dependencies[module_name]

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

    async def cleanup_unused_modules(self):
        """清理未使用的模块
        
        Returns:
            int: 清理的模块数量
        """
        # 获取全局和群组启用的所有模块
        enabled_modules = set(self.config_manager.get_enabled_modules())

        for modules in self.config_manager.modules_config.get(
                "group_modules", {}).values():
            enabled_modules.update(modules)

        # 找出已加载但未启用的模块
        to_unload = []
        for module_name in list(self.loaded_modules.keys()):
            if module_name not in enabled_modules:
                to_unload.append(module_name)

        # 卸载模块
        unloaded_count = 0
        for module_name in to_unload:
            success, dependents = await self.disable_and_unload_module(
                module_name)
            if success:
                unloaded_count += 1
                self.logger.info(f"已清理未使用的模块: {module_name}")

        return unloaded_count

    async def unload_all_modules(self):
        """卸载所有模块"""
        # 按照依赖关系的逆序卸载模块
        modules_to_unload = list(self.loaded_modules.keys())

        # 对模块按依赖关系排序（被依赖的后卸载）
        sorted_modules = self._sort_modules_by_dependencies(
            modules_to_unload, self.dependencies)
        sorted_modules.reverse()  # 反转顺序，先卸载依赖其他模块的模块

        for module_name in sorted_modules:
            await self._unload_module(module_name)

        self.logger.info(f"已卸载全部 {len(sorted_modules)} 个模块")

    async def reload_module(self, module_name):
        """重新加载模块（热更新）
        
        Args:
            module_name: 模块名称
            
        Returns:
            bool: 是否成功重新加载
        """
        # 获取模块锁
        async with self._get_module_lock(module_name):
            # 检查模块是否已加载
            if module_name not in self.loaded_modules:
                self.logger.error(f"模块 {module_name} 未加载，无法重新加载")
                return False

            # 保存模块状态
            module_info = self.loaded_modules[module_name]
            module = module_info["module"]
            interface = module_info["interface"]

            state = None
            if hasattr(module, "get_state") and callable(module.get_state):
                try:
                    state = await module.get_state(interface)
                except Exception as e:
                    self.logger.error(f"获取模块 {module_name} 状态时出错: {e}")

            # 卸载模块
            success = await self._unload_module(module_name)
            if not success:
                self.logger.error(f"卸载模块 {module_name} 失败，无法重新加载")
                return False

            # 从 sys.modules 中清除以确保完全重新加载
            module_path = f"{self.modules_dir}.{module_name}"
            if module_path in sys.modules:
                del sys.modules[module_path]

            if module_name in sys.modules:
                del sys.modules[module_name]

            # 重新加载模块
            success = await self.load_and_enable_module(module_name)
            if not success:
                self.logger.error(f"重新加载模块 {module_name} 失败")
                return False

            # 恢复模块状态
            if state is not None and module_name in self.loaded_modules:
                new_module = self.loaded_modules[module_name]["module"]
                new_interface = self.loaded_modules[module_name]["interface"]

                if hasattr(new_module, "set_state") and callable(
                        new_module.set_state):
                    try:
                        await new_module.set_state(new_interface, state)
                        self.logger.info(f"已恢复模块 {module_name} 的状态")
                    except Exception as e:
                        self.logger.error(f"恢复模块 {module_name} 状态时出错: {e}")

            self.logger.info(f"模块 {module_name} 已成功重新加载")
            return True

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

    def get_module_dependencies(self, module_name):
        """获取模块的依赖
        
        Args:
            module_name: 模块名称
            
        Returns:
            list: 依赖模块列表
        """
        return self.dependencies.get(module_name, [])

    def get_module_dependents(self, module_name):
        """获取依赖此模块的模块
        
        Args:
            module_name: 模块名称
            
        Returns:
            list: 依赖此模块的模块列表
        """
        return self.dependents.get(module_name, [])

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
                "name": getattr(module, "MODULE_NAME", module_name),
                "version": getattr(module, "MODULE_VERSION", "unknown"),
                "description": getattr(module, "MODULE_DESCRIPTION", ""),
                "dependencies": getattr(module, "MODULE_DEPENDENCIES", []),
                "commands": getattr(module, "MODULE_COMMANDS", []),
                "author": getattr(module, "MODULE_AUTHOR", "unknown"),
            }

            return metadata
        except Exception as e:
            self.logger.error(f"获取模块 {module_name} 元数据失败: {e}")
            return None

    async def _build_dependency_graph(self, module_names):
        """构建模块依赖图
        
        Args:
            module_names: 模块名称列表
            
        Returns:
            dict: 依赖图 (模块名 -> 依赖列表)
        """
        dependency_graph = {}

        for module_name in module_names:
            metadata = await self._get_module_metadata(module_name)
            if metadata:
                dependency_graph[module_name] = metadata.get(
                    "dependencies", [])
            else:
                dependency_graph[module_name] = []

        return dependency_graph

    def _detect_circular_dependencies(self, dependency_graph):
        """检测循环依赖
        
        Args:
            dependency_graph: 依赖图
            
        Returns:
            list: 循环依赖列表 [(模块1, 模块2, ...), ...]
        """
        circular_dependencies = []
        visited = set()
        stack = set()

        def visit(node, path=None):
            if path is None:
                path = []

            if node in stack:
                # 发现循环
                cycle = path[path.index(node):] + [node]
                if tuple(cycle) not in circular_dependencies:
                    circular_dependencies.append(tuple(cycle))
                return

            if node in visited:
                return

            visited.add(node)
            stack.add(node)

            for dependency in dependency_graph.get(node, []):
                if dependency in dependency_graph:
                    visit(dependency, path + [node])

            stack.remove(node)

        for node in dependency_graph:
            if node not in visited:
                visit(node)

        return circular_dependencies

    def _sort_modules_by_dependencies(self, module_names, dependency_graph):
        """按依赖关系对模块进行排序
        
        Args:
            module_names: 模块名称列表
            dependency_graph: 依赖图
            
        Returns:
            list: 排序后的模块列表
        """
        # 实现拓扑排序
        visited = set()
        temp_mark = set()
        result = []

        def visit(node):
            if node in temp_mark:
                # 存在循环依赖，跳过
                return

            if node not in visited:
                temp_mark.add(node)

                # 递归访问依赖
                for dependency in dependency_graph.get(node, []):
                    if dependency in module_names:
                        visit(dependency)

                temp_mark.remove(node)
                visited.add(node)
                result.append(node)

        # 访问所有模块
        for module in module_names:
            if module not in visited:
                visit(module)

        # 反转结果，因为我们需要先加载依赖
        result.reverse()
        return result
