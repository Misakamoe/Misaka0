#!/bin/bash
set -e

# 检查配置目录权限
if [ ! -w "/app/config" ]; then
  echo "错误: 配置目录不可写。请确保挂载正确的卷并设置适当的权限。"
  exit 1
fi

# 检查是否有配置文件，如果没有则创建示例配置
if [ ! -f config/config.json ]; then
  echo "配置文件不存在，创建示例配置..."
  cp config/config.json.example config/config.json
fi

# 使用环境变量更新配置（如果提供）
if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
  # 检查是否是示例值
  if [[ "$TELEGRAM_BOT_TOKEN" == "your_token_here" || "$TELEGRAM_BOT_TOKEN" == "YOUR_TELEGRAM_BOT_TOKEN_HERE" || -z "$TELEGRAM_BOT_TOKEN" ]]; then
    echo "错误: 请提供真实的 Telegram Bot Token，而不是示例值或空值"
    exit 1
  fi
  echo "从环境变量更新 Bot Token..."
  python -c "import json; c=json.load(open('config/config.json')); c['token']='$TELEGRAM_BOT_TOKEN'; json.dump(c, open('config/config.json', 'w'), indent=4)"
fi

if [ -n "$ADMIN_IDS" ]; then
  # 检查是否是示例 ID
  if [[ "$ADMIN_IDS" == "123456789" ]]; then
    echo "错误: 请提供真实的管理员 ID，而不是示例值"
    exit 1
  fi
  echo "从环境变量更新管理员 ID..."
  python -c "import json; c=json.load(open('config/config.json')); c['admin_ids']=[int(id) for id in '$ADMIN_IDS'.split(',') if id]; json.dump(c, open('config/config.json', 'w'), indent=4)"
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
    
    print('配置验证通过')
except Exception as e:
    print(f'配置验证失败: {e}')
    sys.exit(1)
"; then
  echo "配置验证失败，请提供有效的 Token 和管理员 ID"
  exit 1
fi

echo "配置有效，启动机器人..."

# 执行命令
exec "$@"
