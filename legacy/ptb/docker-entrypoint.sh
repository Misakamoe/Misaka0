#!/bin/bash
set -e

# 检查配置目录权限
if [ ! -w "/app/config" ]; then
  echo "错误: 配置目录不可写。请确保挂载正确的卷并设置适当的权限。"
  exit 1
fi

# 检查是否有配置文件，如果没有则创建示例配置
if [ ! -f config/config.json ]; then
  # 复制示例配置或创建默认配置
  if [ -f config/config.json.example ]; then
    cp config/config.json.example config/config.json
  else
    echo '{"token":"", "admin_ids":[], "log_level":"INFO", "allowed_groups":{}}' >config/config.json
  fi
  echo "已创建默认配置文件，请编辑后重启容器"
fi

# 使用环境变量更新配置中的特定字段（如果提供）
if [ -n "$TELEGRAM_BOT_TOKEN" ] || [ -n "$ADMIN_IDS" ]; then
  # 使用 Python 更新配置，保留其他字段
  python -c "
import json
import os

# 读取现有配置
with open('config/config.json', 'r') as f:
    config = json.load(f)

# 只更新环境变量指定的字段
token = os.environ.get('TELEGRAM_BOT_TOKEN')
if token and token not in ['your_token_here', 'YOUR_TELEGRAM_BOT_TOKEN_HERE', '']:
    config['token'] = token

admin_ids = os.environ.get('ADMIN_IDS')
if admin_ids and admin_ids != '123456789':
    config['admin_ids'] = [int(id) for id in admin_ids.split(',') if id]

# 写回配置文件
with open('config/config.json', 'w') as f:
    json.dump(config, f, indent=2)
"
fi

# 验证配置是否有效
if ! python -c "
import json, sys
try:
    with open('config/config.json') as f:
        config = json.load(f)
    # 检查 token 是否为空或示例值
    token = config.get('token', '')
    if not token:
        print('错误: Telegram Bot Token 不能为空')
        sys.exit(1)
    if token == 'your_token_here' or token == 'YOUR_TELEGRAM_BOT_TOKEN_HERE' or 'your_token' in token.lower() or 'token_here' in token.lower():
        print('错误: 请使用真实的 Telegram Bot Token，而不是示例值')
        sys.exit(1)

    # 检查管理员 ID
    admin_ids = config.get('admin_ids', [])
    if not admin_ids:
        print('错误: 管理员 ID 列表不能为空')
        sys.exit(1)
    if 123456789 in admin_ids:
        print('错误: 请使用真实的管理员 ID，而不是示例值 123456789')
        sys.exit(1)
except Exception as e:
    print(f'配置验证失败: {e}')
    sys.exit(1)
"; then
  echo "配置验证失败，请提供有效的 Token 和管理员 ID"
  exit 1
fi

# 执行命令
exec "$@"
