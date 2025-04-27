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

> **注意**：状态管理系统用于模块的持久化数据存储，适合存储配置和用户设置等数据。对于临时的用户交互状态，应使用会话管理系统。

### 4. 消息处理器注册

```python
# 注册消息处理器
await interface.register_handler(
    handler,  # 处理器对象
    group=5   # 处理器组，决定优先级（建议使用其他模块未使用的组）
)

# 注册带权限验证的回调查询处理器
await interface.register_callback_handler(
    callback,          # 回调函数
    pattern=None,      # 回调数据匹配模式
    admin_level=False, # 权限级别："super_admin", "group_admin" 或 False
    group=0            # 处理器组（对于回调查询处理器，通常不需要设置 group）
)
```

> **注意**：对于 `MessageHandler`，建议使用其他模块未使用的组以避免与其他模块的会话处理冲突。对于 `CallbackQueryHandler`，通常不需要设置 `group` 参数，因为回调查询处理器之间很少相互干扰。

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
    callback_prefix="module_page" # 回调数据前缀（使用模块名作为前缀）
)

# 显示第一页
await pagination.send_page(update, context, 0)

# 注册回调处理器（通常在 setup 中）
# 使用带权限验证的回调处理器注册方法
await interface.register_callback_handler(
    handle_pagination_callback,
    pattern=r"^module_page:(\d+|select|goto_\d+):\d+$",
    admin_level=False  # 所有用户都可以使用
)

# 回调处理函数
async def handle_pagination_callback(update, context):
    await PaginationHelper.handle_callback(update, context)
```

> **注意**：
>
> 1. 分页系统支持页码选择功能，用户可以点击中间的页码按钮直接跳转到指定页面。
> 2. 按钮布局标准为：`◁ Prev [页码] Next ▷`，当前页码使用 `▷` 标记。
> 3. 回调处理器的模式需要匹配三种格式：页码导航、页码选择和页码跳转。
> 4. 每个模块应使用自己的前缀（如 `module_page`）来避免冲突。

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
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    user = update.effective_user
    await message.reply_text(f"你好，{user.first_name}！")
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

# 只允许群组管理员使用的按钮
await interface.register_callback_handler(
    handle_admin_callback,
    pattern=f"^{CALLBACK_PREFIX}",
    admin_level="group_admin"
)

# 只允许超级管理员使用的按钮
await interface.register_callback_handler(
    handle_super_callback,
    pattern=f"^{CALLBACK_PREFIX}super_",
    admin_level="super_admin"
)

# 自定义权限检查（私聊允许所有用户，群组仅允许管理员）
async def custom_permission_check(update, context):
    # 获取聊天类型
    chat_type = interface.get_chat_type(update)

    # 私聊允许所有用户
    if chat_type == "private":
        return True

    # 群组仅允许管理员
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否是群组管理员
    try:
        chat_member = await context.bot.get_chat_member(chat_id, user_id)
        if chat_member.status in ["creator", "administrator"]:
            return True
    except Exception:
        pass

    # 检查是否是超级管理员
    if interface.config_manager.is_admin(user_id):
        return True

    return False
```

> **注意**：
>
> 1. 使用 `register_callback_handler` 注册的回调处理器会自动进行权限验证，无需在回调函数中手动检查权限。
> 2. 当设置 `admin_level="group_admin"` 时，该命令或按钮在私聊中也会被限制，只有超级管理员可用。
> 3. 如果需要在私聊中允许所有用户使用，但在群组中限制为管理员，应使用自定义权限检查。
> 4. 按钮回调处理器的权限验证会自动回应无权限的用户，避免按钮一直显示加载状态。

### 处理消息

```python
from telegram.ext import MessageHandler, filters

async def setup(interface):
    # 注册消息处理器
    # 注意：默认情况下，MessageHandler 不会处理编辑的消息
    # 要处理编辑的消息，需要使用 filters.UpdateType.EDITED_MESSAGE
    handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND &
        (filters.UpdateType.MESSAGE | filters.UpdateType.EDITED_MESSAGE),
        handle_message
    )
    await interface.register_handler(handler, group=5)  # 使用唯一的组号

async def handle_message(update, context):
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 检查是否有其他模块的活跃会话
    session_manager = context.bot_data.get("session_manager")
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否有其他模块的活跃会话
    for module_name in ["other_module", "another_module"]:
        is_active = await session_manager.get(
            user_id, f"{module_name}_active", False, chat_id=chat_id
        )
        if is_active:
            return  # 其他模块有活跃会话，不处理此消息

    # 处理消息
    text = message.text
    await message.reply_text(f"你发送了: {text}")
```

> **注意**：
>
> 1. 所有模块都应该处理编辑的消息，使用 `message = update.message or update.edited_message` 模式。
> 2. 消息处理器应该使用唯一的组号，避免与其他模块冲突。
> 3. 在处理消息前，应检查是否有其他模块的活跃会话，避免干扰。
> 4. 在群组中，必须同时使用用户 ID 和聊天 ID 来检查会话状态。

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
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 获取会话管理器
    session_manager = context.bot_data["session_manager"]
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 设置会话状态（会话与用户 ID 和聊天 ID 绑定）
    # 注意：在群组中，必须同时使用 user_id 和 chat_id
    await session_manager.set(user_id, "module_waiting_for", "name", chat_id=chat_id)
    await session_manager.set(user_id, "module_active", True, chat_id=chat_id)

    # 设置会话键的自动过期时间（秒）
    await session_manager.set(user_id, "module_temp_data", "some_value",
                             chat_id=chat_id, expire_after=300)  # 5分钟后自动过期

    await message.reply_text("请输入您的名字:")

async def handle_message(update, context):
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    session_manager = context.bot_data["session_manager"]
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 首先检查是否是本模块的活跃会话
    is_active = await session_manager.get(user_id, "module_active", False, chat_id=chat_id)
    if not is_active:
        return  # 不是本模块的会话，不处理

    # 检查会话状态
    waiting_for = await session_manager.get(user_id, "module_waiting_for", None, chat_id=chat_id)

    if waiting_for == "name":
        name = message.text
        # 存储用户输入
        await session_manager.set(user_id, "module_name", name, chat_id=chat_id)
        # 清除会话状态
        await session_manager.delete(user_id, "module_waiting_for", chat_id=chat_id)
        await session_manager.delete(user_id, "module_active", chat_id=chat_id)
        await message.reply_text(f"谢谢，{name}！")
```

> **注意**：
>
> 1. 会话是与用户 ID 和聊天 ID 的组合绑定的，而不仅仅是用户 ID。在群组中必须同时指定两者。
> 2. 会话键应当使用模块名作为前缀（如 `module_active`），避免与其他模块冲突。
> 3. 可以使用 `expire_after` 参数设置会话键的自动过期时间（秒），适用于临时数据。
> 4. 在处理消息时，应该首先检查是否是本模块的活跃会话，避免干扰其他模块的会话处理。
> 5. 按钮回调处理完成后，应当清除相关的临时会话状态。

### 发送文件和图片

```python
from telegram import InputFile
import os

async def send_image_command(update, context):
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 从本地文件发送图片
    with open("path/to/image.jpg", "rb") as file:
        await message.reply_photo(
            photo=file,
            caption="这是一张图片"
        )

    # 使用文件 ID 发送图片（图片已上传到 Telegram）
    file_id = "已知的文件 ID"
    await message.reply_photo(
        photo=file_id,
        caption="这是另一张图片"
    )

    # 发送文档文件
    with open("path/to/document.pdf", "rb") as file:
        await message.reply_document(
            document=file,
            caption="这是一个文档"
        )
```

## 五、模块开发最佳实践

1. **命名规范**

   - 模块名使用小写字母
   - 命令名使用小写字母，避免下划线
   - 常量使用大写字母和下划线
   - 会话键使用模块名作为前缀，如 `module_active`

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
   - 使用框架的状态系统存储用户配置，而不是内存存储

5. **性能考虑**

   - 避免阻塞操作
   - 对耗时操作使用异步
   - 合理使用缓存减少重复计算
   - 为临时会话状态设置合理的过期时间

6. **格式化与中英文**

   - 中英文和数字之间添加空格，如：`你发送了 Hello 123 消息`
   - 使用 Markdown 格式化消息时注意转义特殊字符
   - 长文本应当分段发送，避免单条消息过长

7. **用户界面标准**

   - 使用 Markdown 时，确保转义特殊字符
   - 为复杂格式提供降级方案，在格式无法显示时 fallback 到纯文本
   - 避免过度使用格式，保持消息清晰易读
   - 按钮文本使用英文，避免使用中文
   - 返回按钮统一使用 `⇠ Back` 格式
   - 确认按钮使用 `◯ Confirm ⨉ Cancel` 格式
   - 分页按钮使用 `◁ Prev [页码] Next ▷` 格式
   - 当前选中项使用 `▷` 标记
   - 按钮每行最多放置三个，避免过于拥挤

8. **会话管理**

   - 会话键使用模块名作为前缀
   - 在群组中同时使用用户 ID 和聊天 ID
   - 为临时会话状态设置自动过期时间
   - 按钮回调处理完成后清除相关临时会话状态
   - 使用会话状态仅用于多步骤用户输入处理，不用于按钮回调

9. **权限管理**
   - 在群组中限制命令使用权限时，考虑私聊场景
   - 需要在私聊允许所有用户使用，但在群组限制为管理员时，使用自定义权限检查
   - 按钮权限检查应与命令权限检查保持一致

## 六、示例模块

项目中的 `modules/echo.py` 是一个很好的示例模块，它展示了：

1. 命令处理
2. 会话管理
3. 按钮处理
4. 权限验证
