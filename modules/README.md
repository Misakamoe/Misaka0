# 模块开发指南

本文档提供了模块化 Telegram 机器人的模块开发指南，帮助您快速创建符合标准的功能模块。

## 一、模块基本结构

每个模块都是独立的 Python 文件，放置在 `modules` 目录下。基本结构如下：

### 聊天类型支持

通过 `MODULE_CHAT_TYPES` 声明模块支持的聊天类型：

```python
MODULE_CHAT_TYPES = ["private", "group"]  # 支持所有聊天类型

MODULE_CHAT_TYPES = ["private"]  # 仅支持私聊

MODULE_CHAT_TYPES = ["group"]    # 仅支持群组聊天
```

聊天类型说明：

- `private`: 私聊功能，仅在用户与机器人的私聊中可用
- `group`: 群组功能，仅在群组聊天中可用

```python
# modules/your_module.py

# 模块元数据（必需）
MODULE_NAME = "模块名称"           # 显示名称
MODULE_VERSION = "1.0.0"          # 版本号
MODULE_DESCRIPTION = "模块描述"     # 简短描述
MODULE_COMMANDS = ["命令1", "命令2"] # 模块提供的命令列表
MODULE_CHAT_TYPES = ["private", "group"] # 模块支持的聊天类型

# 必需的函数
async def setup(interface):
    """模块初始化函数（必须实现）"""
    # 在这里注册命令和处理器
    pass

async def cleanup(interface):
    """模块清理函数（必须实现）"""
    # 在这里进行必要的清理工作
    pass


# 命令处理函数
async def your_command(update, context):
    """处理您的命令"""
    # 命令逻辑
    pass
```

## 二、ModuleInterface 接口

模块通过 `interface` 对象与机器人系统交互。以下是可用的接口方法：

### 1. 命令注册

```python
await interface.register_command(
    command_name,      # 命令名称（不包含 /）
    callback,          # 回调函数
    admin_level=False, # 权限级别："super_admin", "group_admin" 或 False
    description=""     # 命令描述
)
```

### 2. 事件系统

```python
# 订阅事件
await interface.subscribe_event(
    "event_type",  # 事件类型
    callback,      # 回调函数
    priority=0,    # 优先级（可选）
    filter_func=None  # 过滤函数（可选）
)

# 发布事件
count = await interface.publish_event(
    "event_type",  # 事件类型
    **event_data   # 事件数据
)
```

### 3. 状态管理

```python
# 保存状态
interface.save_state(state_data)  # 状态数据必须可 JSON 序列化

# 加载状态
state = interface.load_state(default=None)  # default 参数是可选的
```

### 4. 消息处理器注册

```python
# 注册消息处理器
await interface.register_handler(
    handler,  # 处理器对象
    group=0   # 处理器组，决定优先级
)
```

### 5. 聊天类型判断

```python
# 获取聊天类型
chat_type = interface.get_chat_type(update)  # 返回 "private", "group" 或 "global"
```

### 6. 日志系统

```python
# 记录日志
interface.logger.debug("调试信息")
interface.logger.info("信息")
interface.logger.warning("警告")
interface.logger.error("错误")
```

### 7. 配置访问

```python
# 获取管理员列表
admin_ids = interface.config_manager.get_valid_admin_ids()

# 检查用户是否是管理员
is_admin = interface.config_manager.is_admin(user_id)

# 检查用户是否是超级管理员
is_super_admin = interface.config_manager.is_super_admin(user_id)

# 检查用户是否是群组管理员
is_group_admin = interface.config_manager.is_group_admin(user_id, chat_id)

# 检查聊天是否在白名单中
is_allowed = interface.config_manager.is_chat_allowed(chat_id)

# 检查群组是否在白名单中
is_allowed_group = interface.config_manager.is_allowed_group(chat_id)
```

## 三、文本处理工具

框架提供了一系列文本处理工具，帮助处理 Markdown、HTML 格式化和分页显示。

### 1. TextFormatter 工具

```python
from utils.formatter import TextFormatter

# Markdown 转义特殊字符
safe_text = TextFormatter.escape_markdown("使用*星号*的文本")

# HTML 转义特殊字符
safe_html = TextFormatter.escape_html("<b>HTML内容</b>")

# Markdown 转换为纯文本
plain_text = TextFormatter.markdown_to_plain("**粗体**文本")

# 规范化空白字符
normalized = TextFormatter.normalize_whitespace("多行\n\n\n文本")

# 智能分割长文本
chunks = TextFormatter.smart_split_text(long_text, max_length=4000, mode="markdown")
```

### 2. 分页显示

```python
from utils.pagination import PaginationHelper

# 创建数据列表
items = [
    {"name": "项目1", "desc": "描述1"},
    {"name": "项目2", "desc": "描述2"},
    # ...更多项目
]

# 定义格式化函数
def format_item(item):
    name = TextFormatter.escape_markdown(item["name"])
    desc = TextFormatter.escape_markdown(item["desc"])
    return f"*{name}*: {desc}"

# 初始化分页助手
pagination = PaginationHelper(
    items=items,
    page_size=5,                # 每页显示 5 项
    format_item=format_item,    # 项目格式化函数
    title="项目列表",           # 页面标题
    callback_prefix="items_page" # 回调数据前缀
)

# 显示第一页
await pagination.send_page(update, context, 0)

# 注册回调处理器（通常在 setup 中）
from telegram.ext import CallbackQueryHandler
handler = CallbackQueryHandler(
    handle_pagination_callback,
    pattern=r"^items_page:\d+$"
)
await interface.register_handler(handler)

# 回调处理函数
async def handle_pagination_callback(update, context):
    await PaginationHelper.handle_callback(update, context)
```

### 3. 发送长消息

```python
# 自动分段发送长消息
from utils.formatter import TextFormatter

long_text = "非常长的文本内容......"  # 超过 4000 字符的文本

# 智能分割并发送
chunks = TextFormatter.smart_split_text(long_text, max_length=4000)
first_message = None

for i, chunk in enumerate(chunks):
    if i == 0:
        first_message = await update.message.reply_text(chunk)
    else:
        await first_message.reply_text(chunk)  # 回复到第一条消息形成线程
```

### 4. 使用 Markdown 和 HTML 格式

```python
# 安全地发送 Markdown 格式的消息
try:
    message = f"*加粗文本*\n_斜体文本_\n`代码`\n"
    message += f"[链接](https://example.com)\n"
    message += f"用户: {TextFormatter.escape_markdown(user_name)}"

    await update.message.reply_text(message, parse_mode="MARKDOWN")
except Exception as e:
    # 如果 Markdown 解析失败，发送纯文本
    plain_message = TextFormatter.markdown_to_plain(message)
    await update.message.reply_text(plain_message)

# 发送 HTML 格式的消息
try:
    message = "<b>加粗文本</b>\n<i>斜体文本</i>\n<code>代码</code>\n"
    message += f"<a href='https://example.com'>链接</a>\n"
    message += f"用户: {TextFormatter.escape_html(user_name)}"

    await update.message.reply_text(message, parse_mode="HTML")
except Exception as e:
    # 如果 HTML 解析失败，发送纯文本
    plain_message = TextFormatter.strip_html(message)
    await update.message.reply_text(plain_message)
```

## 四、常用功能示例

### 命令处理

```python
async def setup(interface):
    await interface.register_command(
        "hello",
        hello_command,
        description="发送问候消息"
    )

async def hello_command(update, context):
    user = update.effective_user
    await update.message.reply_text(f"你好，{user.first_name}！")
```

### 权限控制

```python
# 只允许群组管理员使用的命令
await interface.register_command(
    "admin_cmd",
    admin_command,
    admin_level="group_admin",
    description="管理员命令"
)

# 只允许超级管理员使用的命令
await interface.register_command(
    "super_cmd",
    super_admin_command,
    admin_level="super_admin",
    description="超级管理员命令"
)
```

### 处理消息

```python
from telegram.ext import MessageHandler, filters

async def setup(interface):
    # 注册消息处理器
    handler = MessageHandler(filters.TEXT & ~filters.COMMAND, handle_message)
    await interface.register_handler(handler)

async def handle_message(update, context):
    text = update.message.text
    await update.message.reply_text(f"你发送了: {text}")
```

### 模块间通信

```python
# 模块 A：发布事件
async def trigger_action(update, context):
    await interface.publish_event(
        "module_a_event",
        user_id=update.effective_user.id,
        chat_id=update.effective_chat.id,
        data="一些数据"
    )

# 模块 B：订阅事件
async def setup(interface):
    await interface.subscribe_event("module_a_event", handle_event)

async def handle_event(event_type, **event_data):
    user_id = event_data.get("user_id")
    chat_id = event_data.get("chat_id")
    data = event_data.get("data")
    # 处理事件...
```

### 保存和加载状态

```python
# 有状态模块
counter = 0

async def setup(interface):
    global counter
    # 加载保存的状态
    state = interface.load_state(default={"counter": 0})
    counter = state.get("counter", 0)

    await interface.register_command("count", count_command)

async def count_command(update, context):
    global counter
    counter += 1
    await update.message.reply_text(f"计数: {counter}")

    # 保存状态
    interface.save_state({"counter": counter})

```

### 使用会话

```python
async def start_survey(update, context):
    # 获取会话管理器
    session_manager = context.bot_data["session_manager"]
    user_id = update.effective_user.id

    # 设置会话状态
    await session_manager.set(user_id, "waiting_for_name", True)
    await update.message.reply_text("请输入您的名字:")

async def handle_message(update, context):
    session_manager = context.bot_data["session_manager"]
    user_id = update.effective_user.id

    # 检查会话状态
    waiting_for_name = await session_manager.get(user_id, "waiting_for_name", False)

    if waiting_for_name:
        name = update.message.text
        await session_manager.set(user_id, "name", name)
        await session_manager.delete(user_id, "waiting_for_name")
        await update.message.reply_text(f"谢谢，{name}！")
```

### 发送文件和图片

```python
from telegram import InputFile
import os

async def send_image_command(update, context):
    # 从本地文件发送图片
    with open("path/to/image.jpg", "rb") as file:
        await update.message.reply_photo(
            photo=file,
            caption="这是一张图片"
        )

    # 使用文件 ID 发送图片（图片已上传到 Telegram）
    file_id = "已知的文件 ID"
    await update.message.reply_photo(
        photo=file_id,
        caption="这是另一张图片"
    )

    # 发送文档文件
    with open("path/to/document.pdf", "rb") as file:
        await update.message.reply_document(
            document=file,
            caption="这是一个文档"
        )
```

## 五、模块开发最佳实践

1. **命名规范**

   - 模块名使用小写字母和下划线
   - 命令名使用小写字母，避免下划线
   - 常量使用大写字母和下划线

2. **文档与注释**

   - 为所有函数添加文档字符串
   - 为复杂逻辑添加注释
   - 清楚标注参数类型和返回值

3. **错误处理**

   - 使用 try-except 捕获可预见的异常
   - 记录错误信息到日志
   - 向用户提供友好的错误消息

4. **资源管理**

   - 在 `cleanup` 中释放所有资源
   - 不要在模块级别创建长期运行的任务
   - 使用 `interface` 提供的方法而不是直接访问底层组件

5. **性能考虑**

   - 避免阻塞操作
   - 对耗时操作使用异步
   - 合理使用缓存减少重复计算

6. **格式化与中英文**

   - 中英文和数字之间添加空格，如：`你发送了 Hello 123 消息`
   - 使用 Markdown 格式化消息时注意转义特殊字符
   - 长文本应当分段发送，避免单条消息过长

7. **输出消息标准**
   - 使用 Markdown 时，确保转义特殊字符
   - 为复杂格式提供降级方案，在格式无法显示时 fallback 到纯文本
   - 避免过度使用格式，保持消息清晰易读

## 六、示例模块

以下是一个完整的示例模块：

```python
# modules/counter.py - 计数器模块

MODULE_NAME = "counter"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "为每个用户跟踪计数，支持增加和重置"
MODULE_COMMANDS = ["count", "reset"]
MODULE_CHAT_TYPES = ["global", "private", "group"]  # 支持所有聊天类型

from telegram import Update
from telegram.ext import ContextTypes
from utils.formatter import TextFormatter

# 用户计数器
user_counters = {}

async def setup(interface):
    """模块初始化"""
    global user_counters

    interface.logger.info("计数器模块已加载")

    # 加载保存的状态
    state = interface.load_state(default={"counters": {}})
    user_counters = state.get("counters", {})

    # 注册命令
    await interface.register_command(
        "count",
        count_command,
        description="增加你的计数"
    )

    await interface.register_command(
        "reset",
        reset_command,
        description="重置你的计数"
    )

async def cleanup(interface):
    """模块清理"""
    interface.logger.info("计数器模块已卸载")

async def count_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /count 命令"""
    user_id = str(update.effective_user.id)
    user_name = TextFormatter.escape_markdown(update.effective_user.first_name)

    # 获取并增加计数
    current_count = user_counters.get(user_id, 0)
    current_count += 1
    user_counters[user_id] = current_count

    # 回复用户
    message = f"*{user_name}* 的计数: `{current_count}`"

    try:
        await update.message.reply_text(message, parse_mode="MARKDOWN")
    except Exception:
        # 降级到纯文本
        plain_message = f"{update.effective_user.first_name} 的计数: {current_count}"
        await update.message.reply_text(plain_message)

    # 保存状态
    interface.save_state({"counters": user_counters})

async def reset_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /reset 命令"""
    user_id = str(update.effective_user.id)

    # 重置计数
    old_count = user_counters.get(user_id, 0)
    user_counters[user_id] = 0

    # 回复用户
    await update.message.reply_text(
        f"你的计数已从 {old_count} 重置为 0"
    )

    # 保存状态
    interface.save_state({"counters": user_counters})
```
