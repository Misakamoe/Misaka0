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

# 注销所有处理器
module_interface.unregister_all_handlers()
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
subscription = module_interface.subscribe_event("event_name", callback, priority=0, filter_func=None)

# 发布事件
await module_interface.publish_event("event_name", key1=value1, key2=value2)

# 发布事件并等待所有处理器完成
count, success = await module_interface.publish_event_and_wait("event_name", timeout=None, key1=value1)

# 取消订阅
module_interface.unsubscribe_event(subscription)
```

### 会话管理

```py
# 获取会话数据
value = await context.bot_data["session_manager"].get(user_id, "key", default=None)

# 设置会话数据
await context.bot_data["session_manager"].set(user_id, "key", value)

# 检查会话是否包含某个键
exists = await context.bot_data["session_manager"].has_key(user_id, "key")

# 删除会话数据
await context.bot_data["session_manager"].delete(user_id, "key")

# 清除用户所有会话数据
await context.bot_data["session_manager"].clear(user_id)

# 获取用户所有会话数据
data = await context.bot_data["session_manager"].get_all(user_id)

# 获取活跃会话数量
count = await context.bot_data["session_manager"].get_active_sessions_count()
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

## 文本工具类 (TextUtils)

TextUtils 提供了丰富的文本处理功能：

```py
# Markdown 转义
safe_text = TextUtils.escape_markdown("需要转义的文本 * _ ` [ ]")

# 格式化用户信息为 Markdown
user_info = TextUtils.format_user_info(user, include_username=True)

# 格式化聊天信息为 Markdown
chat_info = TextUtils.format_chat_info(chat)

# Markdown 转纯文本
plain_text = TextUtils.markdown_to_plain("*加粗* _斜体_")

# Markdown 转 HTML
html_text = TextUtils.markdown_to_html("**加粗** _斜体_ `代码`")

# 分段发送长 HTML 消息
await TextUtils.send_long_message_html(update, long_text, module_interface)

# 智能分割文本
parts = TextUtils.smart_split_text(text, max_length)

# 移除 HTML 标签
plain_text = TextUtils.strip_html("<p>HTML文本</p>")

# 规范化空白字符
normalized = TextUtils.normalize_whitespace("多余的  空格\n\n\n和空行")

# 转义 HTML 特殊字符
safe_html = TextUtils.escape_html("<script>alert('XSS')</script>")

```

## 装饰器

项目提供了以下装饰器用于简化常见任务：

```py
# 错误处理装饰器
from utils.decorators import error_handler

@error_handler
async def command_handler(update, context):
    # 此处的错误会被统一处理
    pass

# 权限检查装饰器
from utils.decorators import permission_check

@permission_check("super_admin")  # 或 "group_admin"
async def admin_command(update, context):
    # 只有管理员可以执行
    pass

# 群组检查装饰器
from utils.decorators import group_check

@group_check
async def group_command(update, context):
    # 只在允许的群组中可用
    pass

# 模块检查装饰器
from utils.decorators import module_check

@module_check
async def module_command(update, context):
    # 只在模块启用时可用
    pass
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

### 事件系统

- 模块间通知：当一个模块中发生重要变化时通知其他模块

- 解耦复杂功能：将复杂功能分解为多个模块，通过事件协调它们

- 创建可扩展的钩子系统：允许未来添加的模块响应现有事件

- 事件处理函数的签名应为：

  ```py
  async def handle_event(event_type, **event_data):
    # 处理事件
    pass
  ```

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
