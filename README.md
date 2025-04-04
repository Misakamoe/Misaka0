## 模块化 Telegram Bot

一个模块化、可扩展的 Telegram Bot 框架，支持动态加载/卸载模块，配置热重载等功能。

### 特性

- 🧩 模块化架构，支持动态加载/卸载模块
- 🔄 配置热重载，无需重启即可更新配置
- 🛡️ 权限管理，支持管理员命令
- 📋 完善的日志系统
- 🐳 Docker 支持，轻松部署

## AI 生成项目声明

> 本项目由 AI 生成。作为维护者，我缺乏专业知识来处理相关技术问题。
>
> ⭐ 因此，我无法接受任何针对本项目的 Issue 或 Pull request。
>
> 欢迎按照 MIT 许可证自由复制和修改此项目以供您自己使用。

## 快速开始

### 配置

1. 复制示例配置文件：

   ```bash
   cp config/config.json.example config/config.json
   ```

2. 编辑配置文件，添加你的 Telegram Bot Token 和管理员 ID：

   ```json
   {
     "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE",
     "admin_ids": [12345678],
     "log_level": "INFO"
   }
   ```

### 部署方式

**方式 1: 直接运行**

```bash
# 安装依赖
pip install -r requirements.txt

# 运行 Bot
python bot.py
```

**方式 2: Docker Compose**

```bash
# 启动容器
docker-compose up -d

# 查看日志
docker-compose logs -f
```

**方式 3: Docker**

```bash
# 构建镜像
docker build -t modular-telegram-bot .

# 运行容器
docker run -d --name telegram-bot \
  -v $(pwd)/config:/app/config \
  -v $(pwd)/logs:/app/logs \
  modular-telegram-bot
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
ExecStart=/usr/bin/python3 /path/to/bot/bot.py
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

- `/modules` - 列出可用模块

- `/commands` - 列出所有可用命令

**管理员命令**

- `/enable` <模块名> - 启用模块

- `/disable` <模块名> - 禁用模块

- `/reload_config` - 重新加载配置

### 开发模块

请参阅 `modules/README.md` 了解如何开发新模块。

### 项目结构

```bash
.
├── bot.py # 主入口点
├── config/ # 配置目录
│ ├── config.json # 主配置
│ └── modules.json # 模块配置
├── core/ # 核心组件
│ ├── bot_engine.py # Bot 引擎
│ ├── command_handler.py # 命令处理器
│ ├── config_manager.py # 配置管理器
│ └── module_loader.py # 模块加载器
├── modules/ # 模块目录
│ ├── echo.py # 示例模块
│ └── README.md # 模块开发指南
└── utils/ # 工具函数
└── logger.py # 日志工具
```
