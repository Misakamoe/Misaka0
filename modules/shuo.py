# modules/shuo.py - 说说发布模块

import json
import os
import re
import aiohttp
from datetime import datetime
from telegram import Update, InlineKeyboardMarkup, InlineKeyboardButton
from telegram.ext import ContextTypes, MessageHandler, filters
from utils.formatter import TextFormatter
from utils.pagination import PaginationHelper

# 模块元数据
MODULE_NAME = "shuo"
MODULE_VERSION = "3.1.0"
MODULE_DESCRIPTION = "发布说说到 GitHub 仓库"
MODULE_COMMANDS = ["shuo"]
MODULE_CHAT_TYPES = ["private"]  # 仅限私聊使用

# 模块配置文件路径
CONFIG_FILE = "config/shuo_config.json"

# 按钮回调前缀
CALLBACK_PREFIX = "shuo_"

# 会话状态常量
SESSION_WAITING_CONTENT = "waiting_content"
SESSION_WAITING_CONFIG = "waiting_config"

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

    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    user_id = update.effective_user.id

    # 检查是否配置了 GitHub 信息
    if not _config["github_token"] or not _config[
            "github_repo"] or not _config["json_path"]:
        # 创建配置按钮
        keyboard = [[
            InlineKeyboardButton("Config",
                                 callback_data=f"{CALLBACK_PREFIX}open_config")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await message.reply_text("⚠️ 模块配置不完整\n请先设置 GitHub 令牌、仓库和文件路径",
                                 reply_markup=reply_markup)
        return

    # 如果有参数，直接处理
    if context.args:
        content = " ".join(context.args)
        await publish_shuo(update, None, content)
        return

    # 获取聊天ID
    chat_id = update.effective_chat.id

    # 使用辅助函数显示主菜单
    await show_shuo_main_menu(message=message,
                              user_id=user_id,
                              chat_id=chat_id,
                              edit_mode=False)


async def publish_shuo(update: Update, _: ContextTypes.DEFAULT_TYPE,
                       content: str):
    """发布说说的核心功能"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

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
    waiting_message = await message.reply_text("🔄 正在发布说说，请稍候...")

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
            await waiting_message.edit_text(
                f"✅ 说说已成功发布\n\n"
                f"<b>Key:</b> {TextFormatter.escape_html(new_post['key'])}\n"
                f"<b>时间:</b> {TextFormatter.escape_html(new_post['date'])}\n"
                f"<b>内容:</b>\n{content}",
                parse_mode="HTML")
        else:
            await waiting_message.edit_text("❌ 发布失败，请稍后重试或检查 GitHub 配置")

    except Exception as e:
        _module_interface.logger.error(f"发布说说失败: {e}")
        await waiting_message.edit_text(f"❌ 发布过程中出现错误: {str(e)}")


async def show_config(update: Update, _: ContextTypes.DEFAULT_TYPE):
    """显示配置界面"""
    # 显示当前配置和按钮界面
    repo = TextFormatter.escape_markdown(
        _config['github_repo']) if _config['github_repo'] else '未设置'
    path = TextFormatter.escape_markdown(
        _config['json_path']) if _config['json_path'] else '未设置'
    branch = TextFormatter.escape_markdown(_config['github_branch'])
    token = "已设置" if _config['github_token'] else '未设置'

    config_text = ("*📝 说说模块配置*\n\n"
                   f"*GitHub 令牌:* {token}\n"
                   f"*GitHub 仓库:* {repo}\n"
                   f"*分支:* {branch}\n"
                   f"*JSON 路径:* {path}\n"
                   f"*当前 Key:* {_config['last_key']}\n\n"
                   "请选择要修改的配置项：")

    # 创建配置按钮
    keyboard = [[
        InlineKeyboardButton("Token",
                             callback_data=f"{CALLBACK_PREFIX}config_token"),
        InlineKeyboardButton("Repo",
                             callback_data=f"{CALLBACK_PREFIX}config_repo")
    ],
                [
                    InlineKeyboardButton(
                        "Path", callback_data=f"{CALLBACK_PREFIX}config_path"),
                    InlineKeyboardButton(
                        "Branch",
                        callback_data=f"{CALLBACK_PREFIX}config_branch")
                ],
                [
                    InlineKeyboardButton(
                        "⇠ Back",
                        callback_data=f"{CALLBACK_PREFIX}back_to_main")
                ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是回调查询还是直接消息
    if update.callback_query:
        # 如果是回调查询，编辑现有消息
        await update.callback_query.edit_message_text(
            config_text, parse_mode="MARKDOWN", reply_markup=reply_markup)
    else:
        # 如果是直接消息，发送新消息
        message = update.message or update.edited_message
        await message.reply_text(config_text,
                                 parse_mode="MARKDOWN",
                                 reply_markup=reply_markup)


async def update_config(update: Update, _: ContextTypes.DEFAULT_TYPE, key: str,
                        value: str):
    """更新配置项"""
    # 映射简化命令到配置项
    key_mapping = {
        "token": "github_token",
        "repo": "github_repo",
        "path": "json_path",
        "branch": "github_branch"
    }

    # 获取配置键
    config_key = key_mapping[key]

    # 对于敏感配置，在日志中隐藏实际值
    log_value = value if config_key != "github_token" else "******"

    # 更新配置
    _config[config_key] = value
    save_config()

    # 记录成功消息
    _module_interface.logger.info(f"已设置配置 {key} = {log_value}")

    # 显示更新后的配置
    await show_config(update, None)


async def button_callback(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调"""
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = _module_interface.session_manager

    # 解析回调数据
    data = query.data

    if data.startswith(f"{CALLBACK_PREFIX}page_"):
        # 翻页
        page = int(data.replace(f"{CALLBACK_PREFIX}page_", ""))
        await show_posts_page(update, context, page)

    elif data.startswith(f"{CALLBACK_PREFIX}delete_"):
        # 显示删除确认界面
        post_key = data.replace(f"{CALLBACK_PREFIX}delete_", "")

        # 调用显示确认删除界面函数
        await show_confirm_delete(update, context, post_key)

    elif data.startswith(f"{CALLBACK_PREFIX}confirm_delete_"):
        # 确认删除
        post_key = data.replace(f"{CALLBACK_PREFIX}confirm_delete_", "")

        # 调用删除函数
        await delete_post(update, context, post_key)

    elif data == f"{CALLBACK_PREFIX}cancel_delete":
        # 取消删除，返回说说列表
        await show_posts_page(update, context, page=0)

    elif data == f"{CALLBACK_PREFIX}back_to_config":
        # 返回配置面板，清除会话状态
        if session_manager:
            await session_manager.delete(user_id, "shuo_step", chat_id=chat_id)
            await session_manager.delete(user_id,
                                         "shuo_config_type",
                                         chat_id=chat_id)
            # 释放模块会话
            await session_manager.release_session(user_id,
                                                  module_name=MODULE_NAME,
                                                  chat_id=chat_id)

        # 重新显示配置面板
        await show_config(update, None)

    elif data == f"{CALLBACK_PREFIX}back_to_main":
        # 返回主菜单
        await show_shuo_main_menu(message=update.callback_query.message,
                                  user_id=user_id,
                                  chat_id=chat_id,
                                  edit_mode=True,
                                  query=query)

    elif data == f"{CALLBACK_PREFIX}open_config":
        # 打开配置面板，清除会话状态
        if session_manager:
            await session_manager.delete(user_id, "shuo_step", chat_id=chat_id)
            # 释放模块会话
            await session_manager.release_session(user_id,
                                                  module_name=MODULE_NAME,
                                                  chat_id=chat_id)

        # 显示配置面板
        await show_config(update, None)

    elif data == f"{CALLBACK_PREFIX}open_manage":
        # 打开管理面板，清除会话状态
        if session_manager:
            await session_manager.delete(user_id, "shuo_step", chat_id=chat_id)
            # 释放模块会话
            await session_manager.release_session(user_id,
                                                  module_name=MODULE_NAME,
                                                  chat_id=chat_id)

        # 显示说说列表
        await show_posts_page(update, context, page=0)

    elif data.startswith(f"{CALLBACK_PREFIX}config_"):
        # 配置操作
        config_type = data.replace(f"{CALLBACK_PREFIX}config_", "")

        if not session_manager:
            await query.edit_message_text("系统错误，请联系管理员")
            return

        # 检查是否有其他模块的活跃会话
        if await session_manager.has_other_module_session(user_id,
                                                          MODULE_NAME,
                                                          chat_id=chat_id):
            await query.answer("⚠️ 请先完成或取消其他活跃会话")
            return

        # 设置会话状态，等待用户输入配置值
        await session_manager.set(user_id,
                                  "shuo_step",
                                  SESSION_WAITING_CONFIG,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)
        await session_manager.set(user_id,
                                  "shuo_config_type",
                                  config_type,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

        # 创建返回按钮
        keyboard = [[
            InlineKeyboardButton(
                "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_config")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        # 根据配置类型显示不同的提示
        if config_type == "token":
            await query.edit_message_text(
                "请输入 GitHub 个人访问令牌：\n\n"
                "您可以在 [GitHub](https://github.com/settings/personal-access-tokens) 创建访问令牌",
                reply_markup=reply_markup,
                parse_mode="MARKDOWN",
                disable_web_page_preview=True)
        elif config_type == "repo":
            await query.edit_message_text(
                "请输入 GitHub 仓库名称：\n\n"
                "格式：用户名/仓库名，例如：username/repo",
                reply_markup=reply_markup)
        elif config_type == "path":
            await query.edit_message_text(
                "请输入 JSON 文件在仓库中的路径：\n\n"
                "例如：data/posts.json",
                reply_markup=reply_markup)
        elif config_type == "branch":
            await query.edit_message_text("请输入分支名称：\n\n"
                                          "默认为 master",
                                          reply_markup=reply_markup)

    # 确保回调查询得到响应
    await query.answer()


# 辅助函数
async def show_shuo_main_menu(message,
                              user_id=None,
                              chat_id=None,
                              edit_mode=False,
                              query=None):
    """显示说说主菜单

    Args:
        message: 消息对象
        user_id: 用户ID
        chat_id: 聊天ID
        edit_mode: 是否编辑现有消息
        query: 回调查询对象，用于显示临时通知

    """
    # 创建按钮面板
    keyboard = [[
        InlineKeyboardButton("Config",
                             callback_data=f"{CALLBACK_PREFIX}open_config"),
        InlineKeyboardButton("Manage",
                             callback_data=f"{CALLBACK_PREFIX}open_manage")
    ]]
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 获取会话管理器
    session_manager = _module_interface.session_manager

    # 设置会话状态，等待用户输入说说内容
    if user_id and chat_id:
        # 检查是否有其他模块的活跃会话
        if await session_manager.has_other_module_session(user_id,
                                                          MODULE_NAME,
                                                          chat_id=chat_id):
            if edit_mode and query:
                # 如果是回调查询，使用临时通知
                await query.answer("⚠️ 请先完成或取消其他活跃会话")
                return
            else:
                # 如果是普通消息，回复新消息
                await message.reply_text("⚠️ 请先完成或取消其他活跃会话")
            return

        await session_manager.set(user_id,
                                  "shuo_step",
                                  SESSION_WAITING_CONTENT,
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

    # 菜单文本
    menu_text = ("📝 *请输入要发布的说说内容*\n\n"
                 "• 可以使用 #Tag 添加 Tag\n"
                 "• 支持 HTML 标签进行格式化：\n"
                 "  `<b>粗体</b>` `<s>删除线</s>`\n"
                 "  `<i>斜体</i>` `<u>下划线</u>`\n"
                 "  `<code>代码</code>`\n"
                 "  `<a href=\"链接\">文本</a>`\n\n"
                 "• 使用 /cancel 命令可以取消操作")

    # 发送或编辑消息
    if edit_mode:
        await message.edit_text(menu_text,
                                reply_markup=reply_markup,
                                parse_mode="MARKDOWN")
    else:
        await message.reply_text(menu_text,
                                 reply_markup=reply_markup,
                                 parse_mode="MARKDOWN")


async def show_posts_page(update: Update,
                          context: ContextTypes.DEFAULT_TYPE,
                          page=0):
    """显示特定页的说说列表，使用PaginationHelper"""
    query = update.callback_query

    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await query.edit_message_text("⚠️ 没有找到任何说说，或无法获取数据")
        return

    # 创建格式化函数
    def format_post(post):
        key = post.get("key", "")
        date = post.get("date", "")
        content = post.get("content", "")
        tags = post.get("tags", [])

        # 内容不转义，保留原始 HTML 标签
        plain_content = TextFormatter.normalize_whitespace(content)

        safe_key = TextFormatter.escape_html(key)
        safe_date = TextFormatter.escape_html(date)

        # 构建格式化文本
        formatted_text = f"<b>Key: {safe_key}</b>\n"
        formatted_text += f"📅 {safe_date}\n"
        formatted_text += f"📝 {plain_content}"

        # 显示标签
        if tags:
            safe_tags = [TextFormatter.escape_html(tag) for tag in tags]
            tags_text = " ".join([f"#{tag}" for tag in safe_tags])
            formatted_text += f"\n🏷 {tags_text}"
        return formatted_text

    # 创建返回按钮
    back_button = InlineKeyboardButton(
        "⇠ Back", callback_data=f"{CALLBACK_PREFIX}back_to_main")

    # 为每个说说创建删除按钮
    def create_item_buttons(post):
        post_key = post.get("key", "")
        if post_key:
            return [
                InlineKeyboardButton(
                    f"Del #{post_key}",
                    callback_data=f"{CALLBACK_PREFIX}delete_{post_key}")
            ]
        return []

    # 创建分页助手
    pagination = PaginationHelper(
        items=json_data,
        page_size=4,  # 每页4条说说
        format_item=format_post,
        title="📝 说说列表",
        callback_prefix=f"{CALLBACK_PREFIX}page",
        parse_mode="HTML",
        back_button=back_button)

    try:
        content, keyboard = pagination.get_page_content(page)

        # 添加删除按钮
        start_idx = page * pagination.page_size
        end_idx = min(start_idx + pagination.page_size, len(json_data))
        current_page_data = json_data[start_idx:end_idx]

        # 创建新键盘，包含删除按钮和导航按钮
        keyboard_buttons = []

        # 为每个说说添加删除按钮，每行两个
        delete_buttons = []
        for post in current_page_data:
            buttons = create_item_buttons(post)
            if buttons:
                delete_buttons.extend(buttons)

        # 每行最多两个按钮
        for i in range(0, len(delete_buttons), 2):
            row = delete_buttons[i:i + 2]
            keyboard_buttons.append(row)

        # 添加导航按钮（从原键盘获取）
        for row in keyboard.inline_keyboard:
            if len(row) > 1 and ("Prev" in row[0].text
                                 or "Next" in row[-1].text):
                keyboard_buttons.append(row)
                break

        # 添加返回按钮
        for row in keyboard.inline_keyboard:
            if len(row) == 1 and "Back" in row[0].text:
                keyboard_buttons.append(row)
                break

        custom_keyboard = InlineKeyboardMarkup(keyboard_buttons)

        await query.edit_message_text(content,
                                      parse_mode="HTML",
                                      reply_markup=custom_keyboard,
                                      disable_web_page_preview=True)
    except Exception as e:
        _module_interface.logger.error(f"发送 HTML 格式消息失败: {e}", exc_info=True)
        # 回退到纯文本
        plain_text = TextFormatter.html_to_plain(content)
        await query.edit_message_text(plain_text,
                                      reply_markup=custom_keyboard,
                                      disable_web_page_preview=True)


async def show_confirm_delete(update: Update, _: ContextTypes.DEFAULT_TYPE,
                              post_key: str):
    """显示删除确认界面"""
    # 获取消息对象
    query = update.callback_query

    # 发送处理中消息
    await query.edit_message_text("🔄 正在获取说说信息...")

    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await query.edit_message_text("⚠️ 无法获取说说数据")
        return

    # 查找特定 key 的说说
    post_index = next(
        (i for i, item in enumerate(json_data) if item.get("key") == post_key),
        -1)

    if post_index == -1:
        await query.edit_message_text(f"⚠️ 未找到 key 为 {post_key} 的说说")
        return

    # 创建确认按钮
    keyboard = InlineKeyboardMarkup([[
        InlineKeyboardButton(
            "◯ Confirm",
            callback_data=f"{CALLBACK_PREFIX}confirm_delete_{post_key}"),
        InlineKeyboardButton("⨉ Cancel",
                             callback_data=f"{CALLBACK_PREFIX}cancel_delete")
    ]])

    # 获取说说内容预览
    post = json_data[post_index]
    content = post.get("content", "")
    date = post.get("date", "")

    plain_content = TextFormatter.normalize_whitespace(content)

    safe_key = TextFormatter.escape_html(post_key)
    safe_date = TextFormatter.escape_html(date)

    await query.edit_message_text(
        f"⚠️ <b>确定要删除这条说说吗？</b>\n\n"
        f"<b>Key:</b> {safe_key}\n"
        f"<b>时间:</b> {safe_date}\n"
        f"<b>内容:</b> {plain_content}",
        reply_markup=keyboard,
        parse_mode="HTML",
        disable_web_page_preview=True)


async def delete_post(update: Update, context: ContextTypes.DEFAULT_TYPE,
                      post_key: str):
    """删除特定 key 的说说"""
    # 获取消息对象
    query = update.callback_query

    # 发送处理中消息
    await query.edit_message_text("🔄 正在处理...")

    # 获取 JSON 数据
    json_data = await fetch_json_from_github()

    if not json_data:
        await query.edit_message_text("⚠️ 无法获取说说数据")
        return

    # 查找特定 key 的说说
    post_index = next(
        (i for i, item in enumerate(json_data) if item.get("key") == post_key),
        -1)

    if post_index == -1:
        await query.edit_message_text(f"⚠️ 未找到 key 为 {post_key} 的说说")
        return

    # 删除说说
    del json_data[post_index]

    # 更新 GitHub 上的文件
    success = await update_github_json(json_data)

    if success:
        # 删除成功后，返回说说列表
        await show_posts_page(update, context, page=0)
    else:
        await query.edit_message_text("❌ 删除失败，请稍后重试")


# GitHub 操作函数
async def fetch_json_from_github():
    """从 GitHub 获取现有的 JSON 数据"""
    try:
        url = f"https://api.github.com/repos/{_config['github_repo']}/contents/{_config['json_path']}?ref={_config['github_branch']}"
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
                            _module_interface.logger.debug(
                                "GitHub 上的 JSON 文件为空，返回空列表")
                            return []
                    except json.JSONDecodeError as e:
                        _module_interface.logger.error(f"JSON 解析错误: {e}",
                                                       exc_info=True)
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
        _module_interface.logger.error(f"获取 GitHub JSON 数据时出错: {e}",
                                       exc_info=True)
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
        _module_interface.logger.error(f"更新 GitHub JSON 时出错: {e}",
                                       exc_info=True)
        return False


async def handle_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理用户消息（用于会话流程）"""

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = _module_interface.session_manager

    # 检查是否是说说模块的活跃会话
    if not await session_manager.is_session_owned_by(
            user_id, MODULE_NAME, chat_id=chat_id):
        return

    # 获取当前步骤
    step = await session_manager.get(user_id,
                                     "shuo_step",
                                     None,
                                     chat_id=chat_id)

    # 处理不同步骤的输入
    if step == SESSION_WAITING_CONTENT:
        # 处理说说内容输入
        content = update.message.text.strip()

        # 清除会话状态
        await session_manager.delete(user_id, "shuo_step", chat_id=chat_id)
        # 释放模块会话
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)

        # 发布说说
        await publish_shuo(update, None, content)

    elif step == SESSION_WAITING_CONFIG:
        # 处理配置值输入
        config_type = await session_manager.get(user_id,
                                                "shuo_config_type",
                                                None,
                                                chat_id=chat_id)
        value = update.message.text.strip()

        # 清除会话状态
        await session_manager.delete(user_id, "shuo_step", chat_id=chat_id)
        await session_manager.delete(user_id,
                                     "shuo_config_type",
                                     chat_id=chat_id)
        # 释放模块会话
        await session_manager.release_session(user_id,
                                              module_name=MODULE_NAME,
                                              chat_id=chat_id)

        # 更新配置
        await update_config(update, None, config_type, value)


async def setup(interface):
    """模块初始化"""
    global _module_interface, _state
    _module_interface = interface

    # 加载配置
    load_config()

    # 加载状态
    saved_state = interface.load_state(default={"file_sha": ""})
    if saved_state and isinstance(saved_state, dict):
        _state["file_sha"] = saved_state.get("file_sha", "")

    # 注册命令 - 仅限超级管理员在私聊中使用
    await interface.register_command("shuo",
                                     shuo_command,
                                     admin_level="super_admin",
                                     description="发布、管理和配置说说")

    # 注册带权限验证的回调处理器
    await interface.register_callback_handler(button_callback,
                                              pattern=f"^{CALLBACK_PREFIX}",
                                              admin_level="super_admin")

    # 注册消息处理器（用于会话流程）- 仅限私聊
    message_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE
        & ~filters.Regex(r'^/'), handle_message)
    await interface.register_handler(message_handler, group=7)

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理"""
    # 保存状态
    interface.save_state({"file_sha": _state.get("file_sha", "")})
    interface.logger.info(f"模块 {MODULE_NAME} 已清理完成")
