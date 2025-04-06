## 基本结构

每个模块应该是 `modules` 目录下的独立 Python 文件，遵循以下结构：

```py
# 必需的模块元数据
MODULE_NAME = "模块名称"
MODULE_VERSION = "版本号"
MODULE_DESCRIPTION = "模块描述"
MODULE_DEPENDENCIES = []  # 依赖的其他模块
MODULE_COMMANDS = []  # 模块提供的命令

# 模块状态 (可选，用于热更新)
_state = {}

# 命令处理函数
async def command_handler(update, context):
    """命令处理函数"""
    pass

# 获取和设置状态的函数 (可选，用于热更新)
def get_state(module_interface):
    """获取模块状态"""
    return _state

def set_state(module_interface, state):
    """设置模块状态"""
    global _state
    _state = state

# 必需的模块接口函数
def setup(module_interface):
    """模块初始化"""
    # 注册命令和处理器
    # 加载状态
    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")

def cleanup(module_interface):
    """模块清理"""
    # 清理资源
    # 保存状态
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
```

## 示例：Echo 模块

```py
# modules/echo.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler

# 模块元数据
MODULE_NAME = "echo"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "回显用户输入的文本"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["echo"]

# 模块状态
_state = {
    "usage_count": 0
}

@error_handler
async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    global _state

    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    # 更新使用次数
    _state["usage_count"] += 1

    text = " ".join(context.args)
    await update.message.reply_text(f"{text}")

# 状态管理函数
def get_state(module_interface):
    return _state

def set_state(module_interface, state):
    global _state
    _state = state

def setup(module_interface):
    """模块初始化"""
    # 注册命令
    module_interface.register_command("echo", echo_command)

    # 加载保存的状态
    saved_state = module_interface.load_state(default={"usage_count": 0})
    global _state
    _state = saved_state

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")

def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
```

## 核心组件

1. 模块元数据（必需）

   - `MODULE_NAME`：模块名称，通常与文件名相同

   - `MODULE_VERSION`：版本号，如 "1.0.0"

   - `MODULE_DESCRIPTION`：简短描述

   - `MODULE_DEPENDENCIES`：依赖模块列表

   - `MODULE_COMMANDS`：模块提供的命令列表

2. 模块状态管理（推荐）

   - `_state`：模块状态变量，用于保存模块运行状态

   - `get_state(module_interface)`：获取状态，用于热更新

   - `set_state(module_interface, state)`：设置状态，用于热更新

3. 模块接口函数（必需）

   - `setup(module_interface)`：初始化模块，注册命令和处理器

   - `cleanup(module_interface)`：清理模块资源

4. ModuleInterface 提供的方法

   **命令注册**

   - `register_command(command, callback, admin_only=False)`：注册命令

   - `register_handler(handler, group=0)`：注册自定义处理器

   **状态管理**

   - `save_state(state, format="json")`：保存模块状态

   - `load_state(default=None, format="json")`：加载模块状态

   - `delete_state(format="json")`：删除模块状态

   **事件系统**

   - `subscribe_event(event_type, callback)`：订阅事件

   - `publish_event(event_type, **event_data)`：发布事件

   - `unsubscribe_event(subscription)`：取消订阅

   **模块间通信**

   - `get_module_interface(module_name)`：获取其他模块的接口

   - `call_module_method(module_name, method_name, *args, **kwargs)`：调用其他模块的方法

   **日志记录**

   - `logger`：日志记录器，用于记录模块日志

   **权限控制**

   ```py
   # 所有用户可用
   module_interface.register_command("cmd", handler)

   # 群组管理员和超级管理员可用
   module_interface.register_command("admin_cmd", handler, admin_only="group_admin")

   # 仅超级管理员可用
   module_interface.register_command("super_cmd", handler, admin_only="super_admin")
   ```

## 最佳实践

1. **代码规范**

   使用装饰器：使用 `@error_handler` 装饰命令处理函数

   中英文空格：确保显示文字中英文之间有空格

   异步函数：命令处理函数必须是 `async def` 定义的异步函数

   参数获取：通过 `context.args` 获取命令参数

2. **状态管理**

   持久化状态：使用 `module_interface.save_state()` 和 `load_state()` 持久化状态

   热更新支持：实现 `get_state()` 和 `set_state()` 函数支持热更新

   定期保存：对于重要数据，定期保存而不仅在 `cleanup()` 时保存

3. **日志记录**

   统一日志：使用 `module_interface.logger` 而不是 `print` 记录日志

   日志级别：根据重要性选择 `DEBUG/INFO/WARNING/ERROR` 级别

   标准格式：初始化和清理时使用标准日志格式

4. **事件通信**

   松耦合设计：使用事件系统实现模块间松耦合通信

   异步处理：事件处理函数必须是异步函数

   错误隔离：事件处理中的错误不应影响发布者

## 后台任务示例

```py
import asyncio

_background_task = None

async def background_task(module_interface):
    while True:
        try:
            # 执行任务
            module_interface.logger.debug("执行后台任务")
            await asyncio.sleep(60)
        except asyncio.CancelledError:
            break
        except Exception as e:
            module_interface.logger.error(f"后台任务出错: {e}")
            await asyncio.sleep(10)  # 错误后短暂暂停

def setup(module_interface):
    global _background_task
    _background_task = asyncio.create_task(background_task(module_interface))
    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")

def cleanup(module_interface):
    global _background_task
    if _background_task:
        _background_task.cancel()
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
```

## 事件通信示例

### 发布事件

```py
async def publish_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    module_interface = context.bot_data["bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 发布事件
    event_data = {
        "user_id": update.effective_user.id,
        "message": "事件测试"
    }
    subscribers = await module_interface.publish_event("test_event", **event_data)

    await update.message.reply_text(f"事件已发布，{subscribers} 个订阅者接收")
```

### 订阅事件

```py
# 事件处理函数
async def handle_event(event_type, source_module, user_id, message, **kwargs):
    # 处理事件
    print(f"收到来自 {source_module} 的事件: {message}")

def setup(module_interface):
    # 注册命令
    module_interface.register_command("cmd", command_handler)

    # 订阅事件
    module_interface.subscribe_event("test_event", handle_event)

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")
```

## 模块间调用示例

```py
async def call_other_module(update: Update, context: ContextTypes.DEFAULT_TYPE):
    module_interface = context.bot_data["bot_engine"].module_loader.get_module_interface(MODULE_NAME)

    # 调用其他模块的方法
    result = await module_interface.call_module_method(
        "other_module", "get_data", user_id=update.effective_user.id
    )

    if result:
        await update.message.reply_text(f"获取到数据: {result}")
    else:
        await update.message.reply_text("获取数据失败")
```

遵循以上新版标准，您可以充分利用框架的增强功能，开发出更强大、更可靠的模块。
