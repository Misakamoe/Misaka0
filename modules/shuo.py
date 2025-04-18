# modules/shuo.py - 说说发布模块

import json
import os
import re
import aiohttp
from datetime import datetime
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import ContextTypes, CallbackQueryHandler
from utils.formatter import TextFormatter

# 模块元数据
MODULE_NAME = "shuo"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "发布说说到 GitHub 仓库"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["shuo", "shuoconfig", "shuodel"]

# 模块配置文件路径
CONFIG_FILE = "config/shuo_config.json"

# 默认配置
DEFAULT_CONFIG = {
    "github_token": "",  # GitHub 个人访问令牌
    "github_repo": "",  # 仓库名称，格式：用户名/仓库名
    "github_branch": "master",  # 分支名
    "json_path": "",  # JSON 文件在仓库中的路径
    "last_key": 0  # 最后使用的 key 值
}

# 本地配置和状态
_config = DEFAULT_CONFIG.copy()
_state = {"file_sha": ""}

# 模块接口实例
_module_interface = None


# 配置管理
def load_config():
    """加载说说模块配置"""
    global _config
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                _config = json.load(f)
        else:
            _config = DEFAULT_CONFIG.copy()
            save_config()
    except Exception as e:
        _module_interface.logger.error(f"加载说说模块配置失败: {e}")
        _config = DEFAULT_CONFIG.copy()


def save_config():
    """保存说说模块配置"""
    try:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
        with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
            json.dump(_config, f, ensure_ascii=False, indent=2)
        return True
    except Exception as e:
        _module_interface.logger.error(f"保存说说模块配置失败: {e}")
        return False


# 命令处理函数
async def shuo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """发布说说命令处理函数"""
    # 检查是否在私聊中使用
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ 此命令只能在私聊中使用。")
        return

    # 检查是否配置了 GitHub 信息
    if not _config["github_token"] or not _config[
            "github_repo"] or not _config["json_path"]:
        await update.message.reply_text("⚠️ 模块配置不完整，请先设置 GitHub 令牌、仓库和文件路径。\n"
                                        "使用 /shuoconfig 命令进行配置。")
        return

    # 获取说说内容
    if not context.args:
        await show_help(update, context)
        return

    content = " ".join(context.args)

    # 检查是否包含标签
    tags = []
    tag_pattern = r'#(\w+)'
    tag_matches = re.findall(tag_pattern, content)

    if tag_matches:
        tags = tag_matches
        # 从内容中移除标签
        for tag in tag_matches:
            content = content.replace(f"#{tag}", "").strip()

    # 发送处理中消息
    message = await update.message.reply_text("🔄 正在发布说说，请稍候...")

    try:
        # 获取现有的 JSON 数据
        json_data = await fetch_json_from_github()

        if json_data is None:
            json_data = []

        # 递增 key (使用配置中的 last_key)
        _config["last_key"] += 1
        save_config()  # 保存配置，确保 key 持久化

        # 创建新的说说对象
        new_post = {
            "author": update.effective_user.first_name,
            "avatar": "",
            "date": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "content": content,  # 直接存储原始内容
            "key": str(_config["last_key"]),
            "tags": tags
        }

        # 添加到 JSON 数据的开头（最新的显示在前面）
        json_data.insert(0, new_post)

        # 更新 GitHub 上的文件
        success = await update_github_json(json_data)

        if success:
            # 发送成功消息
            await message.edit_text(
                f"✅ 说说已成功发布！\n\n"
                f"*Key:* {new_post['key']}\n"
                f"*时间:* {new_post['date']}\n"
                f"*内容:*\n{content}",
                parse_mode="MARKDOWN")
        else:
            await message.edit_text("❌ 发布失败，请稍后重试或检查 GitHub 配置。")

    except Exception as e:
        _module_interface.logger.error(f"发布说说失败: {e}")
        await message.edit_text(f"❌ 发布过程中出现错误: {str(e)}")


async def shuodel_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """删除说说命令"""
    # 检查是否在私聊中使用
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ 此命令只能在私聊中使用。")
        return

    # 检查是否配置了 GitHub 信息
    if not _config["github_token"] or not _config[
            "github_repo"] or not _config["json_path"]:
        await update.message.reply_text("⚠️ 模块配置不完整，请先设置 GitHub 令牌、仓库和文件路径。\n"
                                        "使用 /shuoconfig 命令进行配置。")
        return

    # 如果有参数，则尝试删除特定 key 的说说
    if context.args:
        post_key = context.args[0]
        await delete_post(update, context, post_key)
    else:
        # 否则列出最近的说说
        await list_posts(update, context, page=0)


async def shuoconfig_command(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """配置说说模块"""
    # 检查是否在私聊中使用
    if update.effective_chat.type != "private":
        await update.message.reply_text("⚠️ 此命令只能在私聊中使用。")
        return

    if not context.args or len(context.args) < 2:
        # 显示当前配置
        repo = TextFormatter.escape_markdown(
            _config['github_repo']) if _config['github_repo'] else '未设置'
        path = TextFormatter.escape_markdown(
            _config['json_path']) if _config['json_path'] else '未设置'
        branch = TextFormatter.escape_markdown(_config['github_branch'])

        config_text = ("*📝 说说模块配置*\n\n"
                       f"*GitHub 仓库:* {repo}\n"
                       f"*分支:* {branch}\n"
                       f"*JSON 路径:* {path}\n"
                       f"*当前 Key:* {_config['last_key']}\n\n"
                       "*配置命令:*\n"
                       "`/shuoconfig token YOUR_TOKEN` - 设置 GitHub 令牌\n"
                       "`/shuoconfig repo 用户名/仓库名` - 设置仓库\n"
                       "`/shuoconfig path 文件路径` - 设置 JSON 文件路径\n"
                       "`/shuoconfig branch 分支名` - 设置分支（默认 master）")

        try:
            await update.message.reply_text(config_text, parse_mode="MARKDOWN")
        except Exception as e:
            _module_interface.logger.error(f"发送 Markdown 格式消息失败: {e}")
            # 如果 Markdown 解析失败，尝试使用纯文本发送
            plain_text = TextFormatter.markdown_to_plain(config_text)
            await update.message.reply_text(plain_text)
        return

    key = context.args[0].lower()
    value = " ".join(context.args[1:])

    # 映射简化命令到配置项
    key_mapping = {
        "token": "github_token",
        "repo": "github_repo",
        "path": "json_path",
        "branch": "github_branch"
    }

    if key in key_mapping:
        config_key = key_mapping[key]

        # 对于敏感配置，在日志中隐藏实际值
        log_value = value if config_key != "github_token" else "******"

        _config[config_key] = value
        save_config()

        await update.message.reply_text(f"✅ 已设置 {key} = {log_value}")
    else:
        await update.message.reply_text(f"❌ 未知配置项: {key}\n\n"
                                        "可用配置项: token, repo, path, branch")


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调"""
    query = update.callback_query
    await query.answer()

    # 解析回调数据
    data = query.data

    if data.startswith("shuo_page_"):
        # 翻页
        page = int(data.replace("shuo_page_", ""))
        await show_posts_page(query, context, page)

    elif data.startswith("shuo_confirm_delete_"):
        # 确认删除
        post_key = data.replace("shuo_confirm_delete_", "")

        # 获取 JSON 数据
        json_data = await fetch_json_from_github()

        if not json_data:
            await query.edit_message_text("⚠️ 无法获取说说数据。")
            return

        # 查找并删除特定 key 的说说
        post_index = next((i for i, item in enumerate(json_data)
                           if item.get("key") == post_key), -1)

        if post_index == -1:
            await query.edit_message_text(f"⚠️ 未找到 key 为 {post_key} 的说说。")
            return

        # 删除说说
        del json_data[post_index]

        # 更新 GitHub 上的文件
        success = await update_github_json(json_data)

        if success:
            await query.edit_message_text(f"✅ 成功删除 key 为 {post_key} 的说说！")
        else:
            await query.edit_message_text("❌ 删除失败，请稍后重试。")

    elif data == "shuo_cancel_delete":
        # 取消删除
        await query.edit_message_text("❌ 已取消删除操作。")


# 辅助函数
async def list_posts(update: Update,
                     context: ContextTypes.DEFAULT_TYPE,
                     page=0):
    """列出说说，支持翻页"""
    # 发送处理中消息
    message = await update.message.reply_text("🔄 正在获取说说列表...")

    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await message.edit_text("⚠️ 没有找到任何说说，或无法获取数据。")
        return

    # 计算分页 - 每页 4 条
    items_per_page = 4
    total_pages = (len(json_data) + items_per_page - 1) // items_per_page

    # 确保页码有效
    page = max(0, min(page, total_pages - 1))

    # 获取当前页的数据
    start_idx = page * items_per_page
    end_idx = min(start_idx + items_per_page, len(json_data))
    current_page_data = json_data[start_idx:end_idx]

    # 构建更美观的说说列表
    list_text = f"*📝 说说列表 (第 {page+1}/{total_pages} 页)*\n\n"

    for i, post in enumerate(current_page_data, start_idx + 1):
        key = post.get("key", "")
        date = post.get("date", "")
        content = post.get("content", "")
        tags = post.get("tags", [])

        # 使用 TextFormatter.strip_html 去除 HTML 标签后再截断
        plain_content = TextFormatter.normalize_whitespace(content)
        if len(plain_content) > 30:
            preview_content = plain_content[:27] + "..."
        else:
            preview_content = plain_content

        # 转义 Markdown 特殊字符
        safe_key = TextFormatter.escape_markdown(key)
        safe_date = TextFormatter.escape_markdown(date)
        safe_preview = TextFormatter.escape_markdown(preview_content)

        # 美化格式
        list_text += f"*{i}. Key: {safe_key}*\n"
        list_text += f"📅 {safe_date}\n"
        list_text += f"📝 {safe_preview}\n"

        # 显示标签
        if tags:
            safe_tags = [TextFormatter.escape_markdown(tag) for tag in tags]
            tags_text = " ".join([f"#{tag}" for tag in safe_tags])
            list_text += f"🏷 {tags_text}\n"

        list_text += "\n"

    # 添加使用说明
    list_text += "_使用 /shuodel 数字 key 删除特定说说_"

    # 创建翻页按钮
    buttons = []
    if page > 0:
        buttons.append(
            InlineKeyboardButton("◁ Prev",
                                 callback_data=f"shuo_page_{page-1}"))
    if page < total_pages - 1:
        buttons.append(
            InlineKeyboardButton("Next ▷",
                                 callback_data=f"shuo_page_{page+1}"))

    keyboard = InlineKeyboardMarkup([buttons]) if buttons else None

    # 使用普通 Markdown 格式
    try:
        await message.edit_text(list_text,
                                parse_mode="MARKDOWN",
                                reply_markup=keyboard)
    except Exception as e:
        _module_interface.logger.error(f"发送 Markdown 格式消息失败: {e}")
        # 回退到纯文本
        plain_text = TextFormatter.markdown_to_plain(list_text)
        await message.edit_text(plain_text, reply_markup=keyboard)


async def show_posts_page(query, context, page=0):
    """显示特定页的说说列表"""
    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await query.edit_message_text("⚠️ 没有找到任何说说，或无法获取数据。")
        return

    # 计算分页 - 每页 4 条
    items_per_page = 4
    total_pages = (len(json_data) + items_per_page - 1) // items_per_page

    # 确保页码有效
    page = max(0, min(page, total_pages - 1))

    # 获取当前页的数据
    start_idx = page * items_per_page
    end_idx = min(start_idx + items_per_page, len(json_data))
    current_page_data = json_data[start_idx:end_idx]

    # 构建更美观的说说列表
    list_text = f"*📝 说说列表 (第 {page+1}/{total_pages} 页)*\n\n"

    for i, post in enumerate(current_page_data, start_idx + 1):
        key = post.get("key", "")
        date = post.get("date", "")
        content = post.get("content", "")
        tags = post.get("tags", [])

        # 使用 TextFormatter.normalize_whitespace 处理文本
        plain_content = TextFormatter.normalize_whitespace(content)
        if len(plain_content) > 30:
            preview_content = plain_content[:27] + "..."
        else:
            preview_content = plain_content

        # 转义 Markdown 特殊字符
        safe_key = TextFormatter.escape_markdown(key)
        safe_date = TextFormatter.escape_markdown(date)
        safe_preview = TextFormatter.escape_markdown(preview_content)

        # 美化格式
        list_text += f"*{i}. Key: {safe_key}*\n"
        list_text += f"📅 {safe_date}\n"
        list_text += f"📝 {safe_preview}\n"

        # 显示标签
        if tags:
            safe_tags = [TextFormatter.escape_markdown(tag) for tag in tags]
            tags_text = " ".join([f"#{tag}" for tag in safe_tags])
            list_text += f"🏷 {tags_text}\n"

        list_text += "\n"

    # 添加使用说明
    list_text += "_使用 /shuodel 数字 key 删除特定说说_"

    # 创建翻页按钮
    buttons = []
    if page > 0:
        buttons.append(
            InlineKeyboardButton("◁ Prev",
                                 callback_data=f"shuo_page_{page-1}"))
    if page < total_pages - 1:
        buttons.append(
            InlineKeyboardButton("Next ▷",
                                 callback_data=f"shuo_page_{page+1}"))

    keyboard = InlineKeyboardMarkup([buttons]) if buttons else None

    # 使用普通 Markdown 格式
    try:
        await query.edit_message_text(list_text,
                                      parse_mode="MARKDOWN",
                                      reply_markup=keyboard)
    except Exception as e:
        _module_interface.logger.error(f"发送 Markdown 格式消息失败: {e}")
        # 回退到纯文本
        plain_text = TextFormatter.markdown_to_plain(list_text)
        await query.edit_message_text(plain_text, reply_markup=keyboard)


async def delete_post(update: Update, context: ContextTypes.DEFAULT_TYPE,
                      post_key: str):
    """删除特定 key 的说说"""
    # 发送处理中消息
    message = await update.message.reply_text("🔄 正在处理...")

    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await message.edit_text("⚠️ 无法获取说说数据。")
        return

    # 查找特定 key 的说说
    post_index = next(
        (i for i, item in enumerate(json_data) if item.get("key") == post_key),
        -1)

    if post_index == -1:
        await message.edit_text(f"⚠️ 未找到 key 为 {post_key} 的说说。")
        return

    # 创建确认按钮
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton("○ Confirm",
                             callback_data=f"shuo_confirm_delete_{post_key}"),
        InlineKeyboardButton("× Cancel", callback_data="shuo_cancel_delete")
    ]])

    # 获取说说内容预览
    post = json_data[post_index]
    content = post.get("content", "")
    date = post.get("date", "")

    # 处理内容预览
    plain_content = TextFormatter.normalize_whitespace(content)
    if len(plain_content) > 100:
        preview_content = plain_content[:97] + "..."
    else:
        preview_content = plain_content

    # 转义 Markdown 特殊字符
    safe_key = TextFormatter.escape_markdown(post_key)
    safe_date = TextFormatter.escape_markdown(date)
    safe_preview = TextFormatter.escape_markdown(preview_content)

    await message.edit_text(
        f"⚠️ *确定要删除这条说说吗？*\n\n"
        f"*Key:* {safe_key}\n"
        f"*时间:* {safe_date}\n"
        f"*内容:* {safe_preview}\n\n"
        f"此操作不可撤销！",
        reply_markup=keyboard,
        parse_mode="MARKDOWN")


async def show_help(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示帮助信息，包含 HTML 标签说明"""
    help_text = ("*📝 说说发布帮助*\n\n"
                 "使用此功能可以发布说说到您的 GitHub 仓库。\n\n"
                 "*基本命令:*\n"
                 "`/shuo 你的内容` - 发布一条说说\n\n"
                 "*添加标签:*\n"
                 "在内容中使用 #标签 格式添加标签\n"
                 "例如: `/shuo 今天天气真好 #日常 #心情`\n\n"
                 "*支持 HTML 标签:*\n"
                 "• `<b>粗体</b>` - 粗体文本\n"
                 "• `<i>斜体</i>` - 斜体文本\n"
                 "• `<u>下划线</u>` - 带下划线文本\n"
                 "• `<s>删除线</s>` - 带删除线文本\n"
                 "• `<code>代码</code>` - 等宽字体\n"
                 "• `<pre>预格式化</pre>` - 预格式化文本\n"
                 "• `<a href=\"链接地址\">链接文本</a>` - 超链接\n\n"
                 "*管理命令:*\n"
                 "`/shuoconfig` - 配置模块参数\n"
                 "`/shuodel` - 查看和删除说说")

    try:
        await update.message.reply_text(help_text, parse_mode="MARKDOWN")
    except Exception as e:
        _module_interface.logger.error(f"发送 Markdown 格式消息失败: {e}")
        # 回退到纯文本
        plain_text = TextFormatter.markdown_to_plain(help_text)
        await update.message.reply_text(plain_text)


# GitHub 操作函数
async def fetch_json_from_github():
    """从 GitHub 获取现有的 JSON 数据"""
    try:
        url = f"https://api.github.com/repos/{_config['github_repo']}/contents/{_config['json_path']}"
        headers = {
            "Authorization": f"token {_config['github_token']}",
            "Accept": "application/vnd.github.v3+json"
        }

        async with aiohttp.ClientSession() as session:
            async with session.get(url, headers=headers,
                                   timeout=10) as response:
                if response.status == 200:
                    data = await response.json()
                    content = data.get("content", "")
                    sha = data.get("sha", "")  # 获取文件的 SHA 值，用于更新

                    # 存储 SHA 值以供更新使用
                    _state["file_sha"] = sha

                    # Base64 解码内容
                    import base64
                    decoded_content = base64.b64decode(content).decode('utf-8')

                    # 解析 JSON，处理空文件情况
                    try:
                        if decoded_content.strip():
                            return json.loads(decoded_content)
                        else:
                            # 空文件，返回空列表
                            _module_interface.logger.info(
                                "GitHub 上的 JSON 文件为空，返回空列表")
                            return []
                    except json.JSONDecodeError as e:
                        _module_interface.logger.error(f"JSON 解析错误: {e}")
                        # 返回空列表，而不是 None，这样可以继续操作
                        return []

                elif response.status == 404:
                    # 文件不存在
                    _module_interface.logger.warning(
                        f"GitHub 上不存在文件: {_config['json_path']}")
                    return []
                else:
                    response_text = await response.text()
                    _module_interface.logger.error(
                        f"从 GitHub 获取 JSON 失败: {response.status} - {response_text}"
                    )
                    return []  # 返回空列表，而不是 None

    except Exception as e:
        _module_interface.logger.error(f"获取 GitHub JSON 数据时出错: {e}")
        return []  # 返回空列表，而不是 None


async def update_github_json(json_data):
    """更新 GitHub 上的 JSON 文件"""
    try:
        url = f"https://api.github.com/repos/{_config['github_repo']}/contents/{_config['json_path']}"
        headers = {
            "Authorization": f"token {_config['github_token']}",
            "Accept": "application/vnd.github.v3+json"
        }

        # 将数据转换为压缩的 JSON 字符串 (无缩进，最小化)
        json_content = json.dumps(json_data,
                                  ensure_ascii=False,
                                  separators=(',', ':'))

        # Base64 编码内容
        from base64 import b64encode
        encoded_content = b64encode(
            json_content.encode('utf-8')).decode('utf-8')

        # 准备请求数据 - 使用英文提交消息
        payload = {
            "message":
            f"Update posts - {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
            "content": encoded_content,
            "branch": _config["github_branch"]
        }

        # 如果有 SHA 值，添加到请求中（用于更新现有文件）
        if "file_sha" in _state and _state["file_sha"]:
            payload["sha"] = _state["file_sha"]

        async with aiohttp.ClientSession() as session:
            async with session.put(url,
                                   headers=headers,
                                   json=payload,
                                   timeout=15) as response:
                if response.status in (200, 201):
                    # 更新成功，保存新的 SHA 值
                    data = await response.json()
                    if "content" in data and "sha" in data["content"]:
                        _state["file_sha"] = data["content"]["sha"]
                    return True
                else:
                    response_text = await response.text()
                    _module_interface.logger.error(
                        f"更新 GitHub JSON 失败: {response.status} - {response_text}"
                    )
                    return False

    except Exception as e:
        _module_interface.logger.error(f"更新 GitHub JSON 时出错: {e}")
        return False


# 模块接口函数
def get_state(module_interface):
    """获取模块状态 - 用于热更新"""
    return {"file_sha": _state.get("file_sha", "")}


def set_state(module_interface, state):
    """设置模块状态 - 用于热更新"""
    global _state
    if state and isinstance(state, dict):
        _state["file_sha"] = state.get("file_sha", "")
        module_interface.logger.debug("模块状态已更新")


async def setup(module_interface):
    """模块初始化"""
    global _module_interface
    _module_interface = module_interface

    # 加载配置
    load_config()

    # 加载状态
    saved_state = module_interface.load_state(default={"file_sha": ""})
    set_state(module_interface, saved_state)

    # 注册命令
    await module_interface.register_command("shuo",
                                            shuo_command,
                                            admin_level="super_admin",
                                            description="发布说说到 GitHub 仓库")

    await module_interface.register_command("shuoconfig",
                                            shuoconfig_command,
                                            admin_level="super_admin",
                                            description="配置说说模块参数")

    await module_interface.register_command("shuodel",
                                            shuodel_command,
                                            admin_level="super_admin",
                                            description="查看和删除说说")

    # 注册回调查询处理器
    await module_interface.register_handler(CallbackQueryHandler(
        button_callback, pattern=r"^shuo_"),
                                            group=0)

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(get_state(module_interface))
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
