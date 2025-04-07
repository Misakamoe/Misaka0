# 模块开发指南

## 模块结构

每个模块应该是 `modules` 目录下的独立 Python 文件，遵循以下结构：

```py
# 必需的模块元数据
MODULE_NAME = "模块名称"
MODULE_VERSION = "版本号"
MODULE_DESCRIPTION = "模块描述"
MODULE_DEPENDENCIES = []  # 依赖的其他模块
MODULE_COMMANDS = []  # 模块提供的命令

# 模块状态 (用于热更新)
_state = {}

# 命令处理函数
async def command_handler(update, context):
    """命令处理函数"""
    pass

# 获取和设置状态的函数 (用于热更新)
def get_state(module_interface):
    """获取模块状态"""
    return _state

def set_state(module_interface, state):
    """设置模块状态"""
    global _state
    _state = state
    module_interface.logger.debug(f"模块状态已更新: {state}")

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

## ModuleInterface 提供的方法

### 命令注册

```py
# 所有用户可用
module_interface.register_command("cmd", handler)

# 群组管理员和超级管理员可用
module_interface.register_command("admin_cmd", handler, admin_only="group_admin")

# 仅超级管理员可用
module_interface.register_command("super_cmd", handler, admin_only="super_admin")

# 注册自定义处理器
module_interface.register_handler(handler, group=0)
```

### 状态管理

```py
# 保存状态
module_interface.save_state(state, format="json")

# 加载状态
state = module_interface.load_state(default={}, format="json")

# 删除状态
module_interface.delete_state(format="json")
```

### 事件系统

```py
# 订阅事件
subscription = module_interface.subscribe_event("event_name", callback, priority=0)

# 发布事件
await module_interface.publish_event("event_name", key1=value1, key2=value2)

# 发布事件并等待所有处理器完成
count, success = await module_interface.publish_event_and_wait("event_name", key1=value1)

# 取消订阅
module_interface.unsubscribe_event(subscription)
```

### 模块间通信

```py
# 获取其他模块的接口
other_module = module_interface.get_module_interface("other_module")

# 调用其他模块的方法
result = await module_interface.call_module_method("other_module", "method_name", arg1, arg2, key=value)
```

### 日志记录

```py
# 不同级别的日志
module_interface.logger.debug("调试信息")
module_interface.logger.info("信息")
module_interface.logger.warning("警告")
module_interface.logger.error("错误")
```

## 最佳实践

### 代码规范

- 使用装饰器：使用 `@error_handler` 装饰命令处理函数

- 中英文空格：确保显示文字中英文之间有空格

- 异步函数：命令处理函数必须是 `async def` 定义的异步函数

- 参数获取：通过 `context.args` 获取命令参数

- 使用工具类：使用 `TextUtils` 处理文本格式化和转义

### 状态管理

- 持久化状态：使用 `module_interface.save_state()` 和 `load_state()` 持久化状态

- 热更新支持：实现 `get_state()` 和 `set_state()` 函数支持热更新

- 定期保存：对于重要数据，定期保存而不仅在 `cleanup()` 时保存

- 状态备份：状态变更前会自动创建备份，可通过 `StateManager.get_backup_info()` 查看

### 日志记录

- 统一日志：使用 `module_interface.logger` 而不是 `print` 记录日志

- 日志级别：根据重要性选择 `DEBUG/INFO/WARNING/ERROR` 级别

- 标准格式：初始化和清理时使用标准日志格式

- 日志轮转：日志文件会自动轮转，控制大小和数量

- 日志清理：旧日志文件会自动清理，避免占用过多磁盘空间

### 事件通信

- 松耦合设计：使用事件系统实现模块间松耦合通信

- 异步处理：事件处理函数必须是异步函数

- 错误隔离：事件处理中的错误不会影响发布者

- 事件过滤：可以使用过滤函数只接收关心的事件

- 事件优先级：可以设置事件处理的优先级

### 错误处理

- 统一处理：使用 `@error_handler` 装饰器统一处理异常

- 友好提示：向用户展示友好的错误消息

- 详细日志：在日志中记录详细的错误信息和堆栈跟踪

- 防御性编程：检查参数有效性，使用辅助方法验证输入

### 安全与权限

- 权限检查：使用 `@permission_check` 装饰器控制命令访问权限

- 群组白名单：只允许授权的群组使用机器人

- 模块启用检查：使用 `@module_check` 确保只有启用的模块可用

- 安全转义：使用 `TextUtils.escape_markdown` 转义特殊字符

## 示例模块

### Echo 模块

```py
# modules/echo.py
from telegram import Update
from telegram.ext import ContextTypes
from utils.decorators import error_handler
from utils.text_utils import TextUtils

# 模块元数据
MODULE_NAME = "echo"
MODULE_VERSION = "1.1.0"
MODULE_DESCRIPTION = "回显用户输入的文本"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["echo"]

# 模块状态
_state = {"usage_count": 0}

@error_handler
async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    global _state

    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    # 更新使用次数
    _state["usage_count"] += 1

    # 获取并回显文本
    text = " ".join(context.args)
    await update.message.reply_text(text)

# 状态管理函数
def get_state(module_interface):
    return _state

def set_state(module_interface, state):
    global _state
    _state = state
    module_interface.logger.debug(f"模块状态已更新: {state}")

def setup(module_interface):
    # 注册命令
    module_interface.register_command("echo", echo_command)

    # 加载状态
    saved_state = module_interface.load_state(default={"usage_count": 0})
    global _state
    _state = saved_state

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")

def cleanup(module_interface):
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
```
