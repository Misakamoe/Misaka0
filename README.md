# 模块化 Telegram Bot

一个高度可扩展、模块化的 Telegram Bot 框架，支持动态加载/卸载模块，配置热重载，事件系统和状态管理。

## 特性

- 🧩 **模块化架构**：支持动态加载/卸载/热更新模块
- 🔄 **配置热重载**：无需重启即可更新配置和模块
- 🛡️ **多级权限管理**：支持超级管理员、群组管理员和普通用户
- 🔒 **群组白名单**：只允许授权的群组使用机器人
- 📊 **状态管理**：模块状态持久化和自动备份
- 📡 **事件系统**：模块间松耦合通信
- 📋 **完善的日志系统**：支持日志轮转和自动清理
- 🐳 **Docker 支持**：轻松部署和维护

## AI 生成项目声明

> 本项目由 AI 生成。作为维护者，我缺乏专业知识来处理相关技术问题。
>
> ⭐ 因此，我无法接受任何针对本项目的 Issue 或 Pull request。
>
> 欢迎按照 MIT 许可证自由复制和修改此项目以供您自己使用。

## 快速开始

### 配置

在部署前，您必须准备配置文件或环境变量。

1. 复制示例配置文件：

   ```bash
   cp config/config.json.example config/config.json
   ```

2. 编辑配置文件，添加你的 Telegram Bot Token 和超级管理员 ID：

   ```json
   {
     "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE",
     "admin_ids": [123456789],
     "log_level": "INFO",
     "allowed_groups": {}
   }
   ```

3. 如果使用环境变量配置，需要设置以下变量：

- `TELEGRAM_BOT_TOKEN`：您的 Telegram Bot Token

- `ADMIN_IDS`：超级管理员 ID，多个 ID 用逗号分隔

使用 Docker 部署时，配置的优先级为：环境变量 > 配置文件

首次运行时，如果没有提供有效的 Token 和 ID，机器人将无法启动

### 部署方式

**方式 1: 使用 Python 虚拟环境**

```bash
# 创建虚拟环境
python -m venv venv

# 激活虚拟环境
# Windows
venv\Scripts\activate
# Linux/macOS
source venv/bin/activate

# 安装依赖
pip install -r requirements.txt

# 运行 Bot
python bot.py
```

**方式 2: Docker Compose （推荐）**

```bash
# 启动容器
# 确保 config/config.json 已正确配置
# 或使用环境变量
# 创建 .env 文件
echo "TELEGRAM_BOT_TOKEN=your_token_here" > .env
echo "ADMIN_IDS=123456789" >> .env

# 启动容器
docker-compose up -d

# 查看日志
docker-compose logs -f
```

**方式 3: Docker**

```bash
# 构建镜像
docker build -t modular-telegram-bot .

# 运行容器（使用已配置的 config）
docker run -d --name telegram-bot -v ./config:/app/config modular-telegram-bot

# 或者使用环境变量运行
docker run -d --name telegram-bot -e TELEGRAM_BOT_TOKEN=your_token_here -e ADMIN_IDS=123456789 -v ./config:/app/config modular-telegram-bot
```

**方式 4: Systemd 服务**

创建服务文件 `/etc/systemd/system/telegram-bot.service`：

```ini
[Unit]
Description=Modular Telegram Bot
After=network.target

[Service]
Type=simple
User=botuser
WorkingDirectory=/path/to/bot
ExecStart=/path/to/venv/bin/python /path/to/bot/bot.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

启动服务：

```bash
sudo systemctl enable telegram-bot
sudo systemctl start telegram-bot
sudo systemctl status telegram-bot
```

### 使用方法

**基本命令**

- `/start` - 启动机器人

- `/help` - 显示帮助信息

- `/id` - 显示用户和聊天 ID

- `/modules` - 列出可用模块

- `/commands` - 列出所有可用命令

**管理员命令**

- `/enable` <模块名> - 启用模块

- `/disable` <模块名> - 禁用模块

- `/listgroups` - 列出授权的群组 (超级管理员)

- `/addgroup` [群组 ID] - 添加群组到白名单 (超级管理员)

- `/removegroup` <群组 ID> - 从白名单移除群组 (超级管理员)

### 开发模块

请参阅 `modules/README.md` 了解如何开发新模块。

### 项目结构

```bash
.
├── bot.py                  # 主入口点
├── config/                 # 配置目录
│   ├── config.json         # 主配置
│   └── modules.json        # 模块配置
├── core/                   # 核心组件
│   ├── bot_engine.py       # Bot 引擎
│   ├── command_handler.py  # 命令处理器
│   ├── config_manager.py   # 配置管理器
│   └── module_loader.py    # 模块加载器
├── modules/                # 模块目录
│   └── echo.py             # 示例模块
├── utils/                  # 工具函数
│   ├── city_mapping.py     # 城市名称映射
│   ├── currency_data.py    # 货币数据工具
│   ├── decorators.py       # 装饰器工具
│   ├── event_system.py     # 事件系统
│   ├── logger.py           # 日志工具
│   ├── state_manager.py    # 状态管理器
│   └── text_utils.py       # 文本处理工具
└── data/                   # 数据目录 (自动创建)
    └── module_states/      # 模块状态存储
```
