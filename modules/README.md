# 模块开发指南

本文档提供了该框架模块的开发指南，帮助您快速创建符合标准的功能模块。

## 一、模块基本结构

每个模块都是独立的 Python 文件，放置在 `modules` 目录下。基本结构如下：

```python
# modules/your_module.py

# 模块元数据（必需）
MODULE_NAME = "module_name"  # 模块名称
MODULE_VERSION = "1.0.0"  # 版本号
MODULE_DESCRIPTION = "模块描述"  # 简要说明
MODULE_COMMANDS = ["command1", "command2"]  # 模块提供的命令列表
MODULE_CHAT_TYPES = ["private", "group"]  # 模块支持的聊天类型


# 必需的函数
async def setup(interface):
    """模块初始化函数"""
    # 在这里注册命令和处理器
    pass


async def cleanup(interface):
    """模块清理函数"""
    # 在这里进行必要的清理工作
    pass


# 命令处理函数
async def your_command(update, context):
    """处理您的命令"""
    # 命令逻辑
    pass
```

### 聊天类型支持

通过 `MODULE_CHAT_TYPES` 声明模块支持的聊天类型：

```python
MODULE_CHAT_TYPES = ["private", "group"]  # 在所有聊天类型可用

MODULE_CHAT_TYPES = ["private"]  # 仅支持私聊

MODULE_CHAT_TYPES = ["group"]  # 仅支持群组聊天
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

> **注意**：
>
> 设置权限后该命令在任何聊天类型中都会被限制，如需仅在群组中限制为管理员，应使用自定义权限检查，可参考 `reminder` 或 `rss` 模块。

### 2. 事件系统

```python
# 订阅事件
await interface.subscribe_event(event_type, callback)

# 发布事件
await interface.publish_event(event_type, **event_data)
```

### 3. 状态管理

```python
# 保存状态
interface.save_state(state_data)  # 状态数据必须可 JSON 序列化

# 加载状态
state = interface.load_state(default=None)  # default 参数可选
```

> **注意**：
>
> 状态管理系统用于模块的持久化数据存储，Docker 更新保留此数据需挂载 `data` 目录。对于临时的用户交互状态，可使用会话管理系统。

### 4. 处理器注册

```python
# 注册消息处理器
await interface.register_handler(
    handler,  # 处理器对象
    group=114514  # 处理器组，决定优先级
    # 包含相同过滤类型的处理器必须使用不同的组
)

# 注册带权限验证的回调查询处理器
await interface.register_callback_handler(
    callback,          # 回调函数
    pattern=None,      # 回调数据匹配模式
    admin_level=False, # 权限级别："super_admin", "group_admin" 或 False
    group=1919810      # 处理器组（回调查询处理器通常不需要设置）
)
```

### 5. 日志系统

```python
# 记录日志
interface.logger.debug("调试信息")
interface.logger.info("信息")
interface.logger.warning("警告")
interface.logger.error("错误")
```

### 6. 配置访问

```python
# 获取管理员列表
admin_ids = interface.config_manager.get_valid_admin_ids()

# 检查用户是否是超级管理员
is_admin = interface.config_manager.is_admin(user_id)

# 检查群组是否在白名单中
is_allowed_group = interface.config_manager.is_allowed_group(chat_id)
```

## 三、文本处理工具

框架提供了一系列文本处理工具，帮助处理 Markdown、HTML 格式化和分页显示。

### 1. TextFormatter 工具

```python
from utils.formatter import TextFormatter

# Markdown 转义特殊字符
safe_text = TextFormatter.escape_markdown("**Markdown**文本")

# HTML 转义特殊字符
safe_html = TextFormatter.escape_html("<b>HTML内容</b>")

# Markdown 转换为纯文本
plain_text = TextFormatter.markdown_to_plain("**Markdown**文本")

# HTML 转换为纯文本
plain_html = TextFormatter.html_to_plain("<b>HTML内容</b>")

# 规范化空白字符
normalized = TextFormatter.normalize_whitespace("多行\n\n\n文本")

# 智能分割长文本
chunks = TextFormatter.smart_split_text(long_text, max_length=4000, mode="markdown")
```

### 2. 分页显示

```python
from utils.pagination import PaginationHelper

# 创建分页助手
pagination = PaginationHelper(
    items,  # 要分页的项目列表
    page_size=10,  # 每页显示的项目数
    format_item=None,  # 项目格式化函数 (item) -> str
    title="列表",  # 页面标题
    callback_prefix="page",  # 回调数据前缀
    parse_mode="MARKDOWN",  # 解析模式，可选 "MARKDOWN" 或 "HTML"
    back_button=None)  # 返回按钮，如果提供，将添加到键盘底部

# 获取指定页的内容
content, keyboard = pagination.get_page_content(page_index)

# 发送指定页的消息
await pagination.send_page(update, context, page_index)

# 按钮分页
keyboard = PaginationHelper.paginate_buttons(
    buttons,  # 按钮列表
    page_index=0,  # 当前页码（从 0 开始）
    rows_per_page=5,  # 每页显示的最大行数
    buttons_per_row=3,  # 每行显示的最大按钮数
    nav_callback_prefix="btn_page",  # 导航按钮的回调数据前缀
    show_nav_buttons=True,  # 是否显示导航按钮
    back_button=None)  # 返回按钮，如果提供，将添加到键盘底部
```

## 四、功能示例

### 权限控制

```python
# 只允许群组管理员使用的命令
await interface.register_command(
    "admin_cmd",
    admin_command,
    admin_level="group_admin",
    description="管理员命令"
)

# 只允许超级管理员使用的按钮
await interface.register_callback_handler(
    handle_super_callback,
    pattern=f"^{CALLBACK_PREFIX}super_",
    admin_level="super_admin"
)

# 自定义权限检查（私聊允许所有用户，群组仅允许管理员）
async def custom_permission_check(update, context):
    if update.effective_chat.type == "private":
        return True
    else:
        return await interface.command_manager._check_permission("group_admin", update, context)
```

> **注意**：
>
> 设置权限后回调按钮在任何聊天类型中都会被限制，如需仅在群组中限制为管理员，应使用自定义权限检查，可参考 `reminder` 或 `rss` 模块。

### 处理消息

```python
from telegram.ext import MessageHandler, filters

async def setup(interface):
    # 注册消息处理器
    # 处理文本消息，但不处理命令和以 / 开头的消息
    handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/'),
        handle_message)
    await interface.register_handler(handler, group=114514)


async def handle_message(update, context):
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 获取会话管理器
    session_manager = interface.session_manager
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否有其他模块的活跃会话
    if await session_manager.has_other_module_session(user_id,
                                                      MODULE_NAME,
                                                      chat_id=chat_id):
        return  # 其他模块有活跃会话，不处理此消息

    # 处理消息
    text = message.text
    await message.reply_text(f"您发送的消息是: {text}")
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
    session_manager = interface.session_manager
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否有其他模块的活跃会话
    if await session_manager.has_other_module_session(user_id,
                                                      MODULE_NAME,
                                                      chat_id=chat_id):
        return  # 其他模块有活跃会话，不处理此消息

    # 设置会话状态
    await session_manager.set(user_id,  # 用户ID
                              "module_waiting_for",  # 会话状态键
                              "name",  # 会话状态值
                              chat_id=chat_id,  # 聊天ID
                              expire_after=300,  # 会话键的过期时间（秒）
                              module_name=MODULE_NAME)  # 模块名称

    await message.reply_text("请输入您的名字:")


async def handle_message(update, context):
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    session_manager = interface.session_manager
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 检查是否是本模块的活跃会话
    if not await session_manager.is_session_owned_by(
            user_id, MODULE_NAME, chat_id=chat_id):
        return

    # 检查会话状态
    waiting_for = await session_manager.get(user_id,
                                            "module_waiting_for",
                                            None,
                                            chat_id=chat_id)

    if waiting_for == "name":
        name = message.text

        # 清除会话状态
        await session_manager.delete(user_id,
                                     "module_waiting_for",
                                     chat_id=chat_id)
        # 释放会话控制权
        await session_manager.release_session(user_id,
                                              MODULE_NAME,
                                              chat_id=chat_id)

        await message.reply_text(f"谢谢，{name}！")
```

> **注意**：
>
> 可选 `expire_after` 参数设置会话键的自动过期时间（秒），适用于临时数据。
>
> 在开启会话前，应该首先检查是否有其他模块的活跃会话。
>
> 在处理消息前，应该检查是否是本模块的活跃会话。

## 五、模块开发最佳实践

1. **命名规范**

   - 命令名避免下划线
   - 常量使用大写字母和下划线
   - 模块使用自己的回调前缀

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
   - 使用状态管理存储运行时数据

5. **性能考虑**

   - 避免阻塞操作
   - 对耗时操作使用异步
   - 合理使用缓存减少重复计算

6. **格式化与中英文**

   - 中英文和数字之间添加空格，提高可读性
   - 使用 Markdown 格式化消息时注意转义特殊字符

7. **用户界面标准**

   - 为复杂文本显示提供降级方案
   - 保持消息清晰易读
   - 按钮文本使用英文
   - 返回按钮统一使用 `⇠ Back` 格式
   - 确认按钮使用 `◯ Confirm ⨉ Cancel` 格式
   - 分页按钮使用 `◁ Prev [页码] Next ▷` 格式
   - 当前选中项使用 `▷` 标记
   - 按钮每行最多放置三个，避免过于拥挤

8. **会话管理**

   - 会话键使用模块名作为前缀
   - 为临时会话状态设置自动过期时间
   - 处理完成后清除相关会话状态

9. **权限管理**
   - 在群组中限制命令使用权限时，考虑私聊场景
   - 按钮权限检查应与命令权限检查保持一致

## 六、示例模块

请参考 `modules/echo.py`
