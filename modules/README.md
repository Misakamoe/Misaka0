## 模块开发指南

### 基本结构

每个模块应该是 `modules` 目录下的独立 Python 文件，遵循以下结构：

```py
# 必需的模块元数据
MODULE_NAME = "模块名称"
MODULE_VERSION = "版本号"
MODULE_DESCRIPTION = "模块描述"
MODULE_DEPENDENCIES = []  # 依赖的其他模块
MODULE_COMMANDS = []  # 模块提供的命令

# 命令处理函数
async def command_handler(update, context):
    """命令处理函数"""
    pass

# 必需的模块接口函数
def setup(module_interface):
    """模块初始化"""
    # 注册命令和处理器
    pass

def cleanup(module_interface):
    """模块清理"""
    # 清理资源
    pass
```

### 示例：Echo 模块

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

@error_handler
async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """回显用户输入的文本"""
    if not context.args:
        await update.message.reply_text("请输入要回显的文本")
        return

    text = " ".join(context.args)
    await update.message.reply_text(f"{text}")

def setup(module_interface):
    """模块初始化"""
    module_interface.register_command("echo", echo_command)
    print(f"已注册 echo 命令处理器")

def cleanup(module_interface):
    """模块清理"""
    print(f"echo 模块已清理")
```

### 核心组件

**1. 模块元数据（必需）**

- `MODULE_NAME`：模块名称，通常与文件名相同

- `MODULE_VERSION`：版本号，如 "1.0.0"

- `MODULE_DESCRIPTION`：简短描述

- `MODULE_DEPENDENCIES`：依赖模块列表

- `MODULE_COMMANDS`：模块提供的命令列表

**2. 模块接口函数（必需）**

- `setup(module_interface)`：初始化模块，注册命令和处理器

- `cleanup(module_interface)`：清理模块资源

**3. ModuleInterface 提供的方法**

- `register_command(command, callback, admin_only=False)`：注册命令

- `register_handler(handler, group=0)`：注册自定义处理器

### 权限控制

```py
# 所有用户可用
module_interface.register_command("cmd", handler)

# 群组管理员和超级管理员可用
module_interface.register_command("admin_cmd", handler, admin_only="group_admin")

# 仅超级管理员可用
module_interface.register_command("super_cmd", handler, admin_only="super_admin")
```

### 最佳实践

1. **使用装饰器**：使用 `@error_handler` 装饰命令处理函数

2. **中英文空格**：确保显示文字中英文之间有空格

3. **异步函数**：命令处理函数必须是 `async def` 定义的异步函数

4. **参数获取**：通过 `context.args` 获取命令参数

5. **资源清理**：在 `cleanup` 函数中释放所有资源

### 后台任务示例

```py
import asyncio

_background_task = None

async def background_task():
    while True:
        # 执行任务
        await asyncio.sleep(60)

def setup(module_interface):
    global _background_task
    _background_task = asyncio.create_task(background_task())

def cleanup(module_interface):
    if _background_task:
        _background_task.cancel()
```

### 数据存储示例

```py
import json
import os

DATA_FILE = "config/module_data.json"

def load_data():
    if os.path.exists(DATA_FILE):
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {}

def save_data(data):
    os.makedirs(os.path.dirname(DATA_FILE), exist_ok=True)
    with open(DATA_FILE, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
```

遵循以上标准，您可以快速开发适配框架的模块，实现各种功能扩展。
