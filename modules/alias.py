# modules/alias.py - 命令别名模块

import asyncio
import json
import os
import random
from typing import Dict, Optional, Any
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes, MessageHandler, filters
from utils.pagination import PaginationHelper

# 模块元数据
MODULE_NAME = "alias"
MODULE_VERSION = "3.1.0"
MODULE_DESCRIPTION = "命令别名，支持中文命令和动作"
MODULE_COMMANDS = ["alias"]  # 只包含英文命令
MODULE_CHAT_TYPES = ["private", "group"]  # 在私聊和群组中都允许使用别名功能

# 按钮回调前缀
CALLBACK_PREFIX = "alias_"

# 存储别名数据的文件路径
CONFIG_FILE = "config/aliases.json"

# 内置动作模板（不会被保存到配置文件中）
ACTION_TEMPLATES = {
    "default": [
        "{user} {action}了 {target}", "{user} {action}了 {target}",
        "{user} 想{action} {target}", "{user} 正在{action} {target}",
        "{user} 轻轻地{action}了 {target}", "{user} 悄悄地{action}了 {target}",
        "{user} 试着{action} {target}", "{user} 偷偷地{action}了 {target}",
        "{user} 温柔地{action}了 {target}", "{user} 用力地{action}了 {target}",
        "{user} 开心地{action}着 {target}", "{user} 忍不住{action}了 {target}",
        "{user} 突然{action}了 {target}", "{user} 缓缓地{action}着 {target}"
    ],
    # 特定动作的专属模板
    "抱": [
        "{user} 紧紧地抱住了 {target}", "{user} 给了 {target} 一个温暖的拥抱",
        "{user} 抱了抱 {target}", "{user} 张开双臂抱住了 {target}",
        "{user} 热情地拥抱了 {target}", "{user} 给了 {target} 一个大大的拥抱"
    ],
    "摸": [
        "{user} 轻轻摸了摸 {target} 的头", "{user} 摸了摸 {target}",
        "{user} 悄悄地摸了摸 {target}", "{user} 忍不住摸了摸 {target}",
        "{user} 温柔地摸着 {target}"
    ],
    "亲": [
        "{user} 亲了亲 {target}", "{user} 轻轻地在 {target} 脸上亲了一下",
        "{user} 偷偷地亲了 {target} 一口", "{user} 送给 {target} 一个吻"
    ],
    "拍": [
        "{user} 拍了拍 {target}", "{user} 轻轻拍了拍 {target} 的肩膀",
        "{user} 鼓励地拍了拍 {target}", "{user} 友好地拍拍 {target}"
    ],
    "戳": [
        "{user} 戳了戳 {target}", "{user} 悄悄地戳了戳 {target}",
        "{user} 用手指轻轻戳了戳 {target}", "{user} 忍不住戳了戳 {target}"
    ],
    "举": [
        "{user} 一把举起了 {target}", "{user} 试图举起 {target}",
        "{user} 轻松地举起了 {target}", "{user} 用尽全力举起了 {target}"
    ],
    "抓": [
        "{user} 抓住了 {target}", "{user} 一把抓住了 {target}",
        "{user} 紧紧抓住 {target} 不放", "{user} 悄悄地抓住了 {target}"
    ],
    "咬": [
        "{user} 轻轻咬了一口 {target}", "{user} 忍不住咬了咬 {target}",
        "{user} 假装要咬 {target}", "{user} 张嘴咬了 {target} 一小口"
    ]
}

# 模块接口引用
_interface = None

# 模块状态
_state = {
    "aliases": {
        "alias": ["别名"],  # 为 alias 命令本身添加中文别名
    },
    "permissions": {
        "alias": "super_admin",  # alias 命令需要超级管理员权限
    }
}

# 反向映射表（自动生成）
_reverse_aliases = {}

# 异步锁
_state_lock = asyncio.Lock()

# 消息处理器引用
_message_handler = None

# 模块状态变量


def _update_reverse_aliases():
    """更新反向映射表"""
    global _reverse_aliases
    _reverse_aliases = {}
    for cmd, alias_list in _state["aliases"].items():
        for alias in alias_list:
            _reverse_aliases[alias] = cmd


def _load_aliases() -> Dict[str, Any]:
    """从文件加载别名数据"""
    if not os.path.exists(CONFIG_FILE):
        return _state  # 返回默认状态

    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # 确保有 permissions 字段
            if "permissions" not in data:
                data["permissions"] = {"alias": "super_admin"}
            return data
    except Exception as e:
        if _interface:
            _interface.logger.error(f"加载别名数据失败: {e}")
        return _state  # 返回默认状态


async def _save_aliases():
    """保存别名数据到文件和框架状态（异步安全）"""
    global _state

    async with _state_lock:
        # 保存到配置文件
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

        try:
            # 创建一个副本
            save_state = {
                "aliases": _state["aliases"],
                "permissions": _state["permissions"]
            }

            # 保存到配置文件
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(save_state, f, ensure_ascii=False, indent=2)

            # 同时保存到框架的状态管理中
            if _interface:
                _interface.save_state(_state)
                _interface.logger.debug(f"别名数据已保存到 {CONFIG_FILE} 和框架状态")
        except Exception as e:
            if _interface:
                _interface.logger.error(f"保存别名数据失败: {e}")


def _check_alias_cycle(cmd: str,
                       alias: str,
                       visited: Optional[set] = None) -> bool:
    """检查是否会形成别名循环引用

    Args:
        cmd: 要添加别名的命令
        alias: 别名
        visited: 已访问的命令列表

    Returns:
        bool: 是否形成循环
    """
    if visited is None:
        visited = set()

    if cmd in visited:
        return True

    visited.add(cmd)

    if alias in _reverse_aliases:
        target = _reverse_aliases[alias]
        return _check_alias_cycle(target, alias, visited)

    return False


def is_chinese_command(command: str) -> bool:
    """检查是否是中文命令"""
    # 简单检查是否包含中文字符
    return any('\u4e00' <= char <= '\u9fff' for char in command)


async def handle_action_command(update: Update,
                                context: ContextTypes.DEFAULT_TYPE,
                                action: str):
    """处理动作命令"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 获取发送者信息
    user = update.effective_user
    user_name = user.full_name
    user_mention = f'<a href="tg://user?id={user.id}">{user_name}</a>'

    # 检查是否回复了其他消息
    target_mention = "自己"
    if message.reply_to_message:
        target_user = message.reply_to_message.from_user
        if target_user:
            target_name = target_user.full_name
            target_mention = f'<a href="tg://user?id={target_user.id}">{target_name}</a>'

    # 获取动作模板
    templates = ACTION_TEMPLATES.get(
        action, ACTION_TEMPLATES.get("default", ["{user} {action}了 {target}"]))

    # 随机选择一个模板
    template = random.choice(templates)

    # 生成动作消息
    action_message = template.format(user=user_mention,
                                     action=action,
                                     target=target_mention)

    # 发送消息
    await message.reply_text(action_message, parse_mode="HTML")


async def process_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理所有消息，检查是否包含中文命令别名或动作命令"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    if not message or not message.text:
        return

    message_text = message.text

    # 只处理带 "/" 开头的命令别名，如 /复读
    if message_text.startswith('/'):
        command = message_text[1:].split(' ')[0].split('@')[0]  # 提取命令部分

        # 检查是否是已知别名
        if command in _reverse_aliases:
            # 获取原始命令
            aliased_command = _reverse_aliases[command]

            # 提取参数
            args_text = message_text[len(command) + 1:].strip()
            args = args_text.split() if args_text else []

            # 记录命令调用
            _interface.logger.debug(
                f"执行别名命令: /{aliased_command} (别名: {command})")

            # 获取命令管理器
            command_manager = _interface.application.bot_data.get(
                "command_manager")
            if not command_manager:
                return

            # 获取命令信息
            cmd_info = command_manager.commands.get(aliased_command)
            if not cmd_info:
                return

            # 获取命令权限级别
            admin_level = cmd_info.get("admin_level", False)

            # 检查用户权限
            if admin_level:
                user_id = update.effective_user.id
                chat_id = update.effective_chat.id

                # 根据权限级别进行不同的检查
                if admin_level == "super_admin":
                    # 检查是否是超级管理员
                    if not _interface.config_manager.is_admin(user_id):
                        await message.reply_text(f"⚠️ 您没有执行此命令的权限")
                        return

                elif admin_level == "group_admin":
                    # 检查是否是群组管理员
                    if not _interface.config_manager.is_chat_admin(
                            chat_id, user_id):
                        await message.reply_text(f"⚠️ 您没有执行此命令的权限")
                        return

            # 保存原始参数
            original_args = context.args if hasattr(context, 'args') else None

            try:
                # 设置新参数
                context.args = args

                # 执行命令回调
                callback = cmd_info.get("callback")
                if callback:
                    await callback(update, context)
                    return

                # 如果直接执行失败，尝试通过事件系统
                await _interface.publish_event("execute_command",
                                               command=aliased_command,
                                               update=update,
                                               context=context)

            finally:
                # 恢复原始参数
                if original_args is not None:
                    context.args = original_args
                else:
                    if hasattr(context, 'args'):
                        delattr(context, 'args')

        # 处理中文动作命令（彩蛋功能）
        elif is_chinese_command(command) and ' ' not in command:
            # 检查是否是中文命令且不包含空格
            await handle_action_command(update, context, command)


async def alias_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """管理命令别名"""
    # 显示按钮界面
    await show_alias_main_menu(update, context)


async def show_alias_main_menu(update: Update, _: ContextTypes.DEFAULT_TYPE):
    """显示别名管理主菜单"""
    # 构建别名列表文本
    reply = "<b>📋 命令别名管理</b>\n\n"
    reply += "<b>当前命令别名：</b>\n"

    # 检查是否有别名
    has_aliases = False
    for cmd, aliases in _state["aliases"].items():
        if aliases:  # 只显示有别名的命令
            has_aliases = True
            alias_str = ", ".join([f"「{a}」" for a in aliases])
            reply += f"/{cmd} → {alias_str}\n"

    if not has_aliases:
        reply += "<i>暂无别名</i>\n"

    # 构建按钮 - 使用短英文文本和水平排列
    keyboard = [[
        InlineKeyboardButton("Add", callback_data=f"{CALLBACK_PREFIX}add"),
        InlineKeyboardButton("Remove",
                             callback_data=f"{CALLBACK_PREFIX}remove"),
        InlineKeyboardButton("Help", callback_data=f"{CALLBACK_PREFIX}help")
    ]]

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 检查是否是回调查询
    if update.callback_query:
        # 如果是回调查询，使用 edit_message_text
        await update.callback_query.edit_message_text(
            reply, reply_markup=reply_markup, parse_mode="HTML")
    else:
        # 如果是直接命令，使用 reply_text
        message = update.message or update.edited_message
        if message:
            await message.reply_text(reply,
                                     reply_markup=reply_markup,
                                     parse_mode="HTML")
        else:
            _interface.logger.error("无法获取消息对象，无法显示别名管理主菜单")


async def add_alias(cmd: str, alias: str) -> str:
    """添加别名并返回结果消息"""
    # 检查命令是否存在
    command_manager = _interface.application.bot_data.get("command_manager")
    if not command_manager or cmd not in command_manager.commands:
        return f"⚠️ 命令 /{cmd} 不存在"

    # 检查别名是否与现有命令冲突
    if alias in command_manager.commands:
        return f"⚠️ 别名「{alias}」与现有命令冲突，请使用其他名称"

    # 检查是否会形成循环引用
    if _check_alias_cycle(cmd, alias):
        return f"⚠️ 添加别名「{alias}」会形成循环引用"

    # 获取命令的权限要求
    cmd_info = command_manager.commands.get(cmd, {})
    admin_level = cmd_info.get("admin_level", False)

    # 如果命令存在权限要求，保存到状态中
    if admin_level:
        if "permissions" not in _state:
            _state["permissions"] = {}
        _state["permissions"][cmd] = admin_level

    # 检查命令是否在别名表中
    if cmd not in _state["aliases"]:
        _state["aliases"][cmd] = []

    # 添加别名
    if alias not in _state["aliases"][cmd]:
        async with _state_lock:
            _state["aliases"][cmd].append(alias)
            _update_reverse_aliases()
        await _save_aliases()  # 保存到文件和框架状态
        return f"✅ 已为 /{cmd} 添加别名「{alias}」"
    else:
        return f"⚠️ 别名「{alias}」已存在"


async def remove_alias(cmd: str, alias: str) -> str:
    """删除别名并返回结果消息"""
    # 检查命令是否存在
    if cmd not in _state["aliases"]:
        return f"⚠️ 命令 /{cmd} 没有任何别名"

    # 移除别名
    if alias in _state["aliases"][cmd]:
        async with _state_lock:
            _state["aliases"][cmd].remove(alias)
            # 如果别名列表为空，考虑完全移除该命令
            if not _state["aliases"][cmd] and cmd != "alias":  # 保留 alias 命令本身
                del _state["aliases"][cmd]
                # 如果有权限记录，也可以移除
                if cmd in _state.get("permissions", {}):
                    del _state["permissions"][cmd]
            _update_reverse_aliases()
        await _save_aliases()  # 保存到文件和框架状态
        return f"✅ 已从 /{cmd} 移除别名「{alias}」"
    else:
        return f"⚠️ 别名「{alias}」不存在"


async def register_message_handler():
    """注册消息处理器"""
    global _interface, _message_handler

    # 注册新的消息处理器，使用较低优先级的组(10)，确保其他处理器先处理
    _message_handler = MessageHandler(filters.Regex(r'^/'), process_message)

    # 使用模块接口注册处理器（组 10，优先级较低）
    await _interface.register_handler(_message_handler, group=10)
    _interface.logger.info("别名消息处理器已注册（优先级较低）")


# 状态管理函数已移除，使用框架的状态管理功能


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    query = update.callback_query
    user_id = update.effective_user.id

    # 权限检查已在框架层面处理

    # 获取回调数据
    callback_data = query.data

    # 检查前缀
    if not callback_data.startswith(CALLBACK_PREFIX):
        return

    # 移除前缀
    action = callback_data[len(CALLBACK_PREFIX):]

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await query.answer("系统错误，请联系管理员")
        return

    # 处理不同的操作
    if action == "add":
        # 重置分页状态
        await session_manager.set(user_id, "alias_cmd_page", 0)
        # 显示添加别名界面
        await show_add_alias_menu(update, context)

    elif action == "remove":
        # 重置分页状态
        await session_manager.set(user_id, "alias_remove_page", 0)
        # 显示删除别名界面
        await show_remove_alias_menu(update, context)

    elif action == "help":
        # 显示帮助信息
        help_text = "<b>📚 命令别名帮助</b>\n\n"
        help_text += "命令别名允许您为现有命令创建更易记的名称，特别是中文名称。\n\n"
        help_text += "<b>使用方法：</b>\n"
        help_text += "• 使用 <code>/alias</code> 命令打开别名管理界面\n"
        help_text += "• 点击 <b>Add</b> 按钮添加新别名\n"
        help_text += "• 点击 <b>Remove</b> 按钮删除现有别名\n\n"
        help_text += "<b>示例：</b>\n"
        help_text += "添加别名 <code>帮助</code> 给命令 <code>/help</code>\n"
        help_text += "您可以使用 <code>/帮助</code> 代替 <code>/help</code>"

        # 添加返回按钮 - 使用短英文文本
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(help_text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")

    elif action == "back":
        # 清除会话状态
        await session_manager.delete(user_id, "alias_waiting_for")
        await session_manager.delete(user_id, "alias_selected_cmd")
        await session_manager.delete(user_id, "alias_active")
        await session_manager.delete(user_id, "alias_cmd_page")
        await session_manager.delete(user_id, "alias_remove_page")

        # 返回主菜单
        await show_alias_main_menu(update, context)

    elif action == "prev_page":
        # 获取当前页码
        current_page = await session_manager.get(user_id, "alias_cmd_page", 0)
        # 设置为上一页
        await session_manager.set(user_id, "alias_cmd_page", current_page - 1)
        # 刷新命令选择界面
        await show_add_alias_menu(update, context)

    elif action == "next_page":
        # 获取当前页码
        current_page = await session_manager.get(user_id, "alias_cmd_page", 0)
        # 设置为下一页
        await session_manager.set(user_id, "alias_cmd_page", current_page + 1)
        # 刷新命令选择界面
        await show_add_alias_menu(update, context)

    elif action == "prev_remove_page":
        # 获取当前页码
        current_page = await session_manager.get(user_id, "alias_remove_page",
                                                 0)
        # 设置为上一页
        await session_manager.set(user_id, "alias_remove_page",
                                  current_page - 1)
        # 刷新删除别名界面
        await show_remove_alias_menu(update, context)

    elif action == "next_remove_page":
        # 获取当前页码
        current_page = await session_manager.get(user_id, "alias_remove_page",
                                                 0)
        # 设置为下一页
        await session_manager.set(user_id, "alias_remove_page",
                                  current_page + 1)
        # 刷新删除别名界面
        await show_remove_alias_menu(update, context)

    elif action.startswith("select_cmd_"):
        # 选择命令后，提示输入别名
        cmd = action[len("select_cmd_"):]

        # 保存到会话
        await session_manager.set(user_id, "alias_selected_cmd", cmd)
        await session_manager.set(user_id, "alias_waiting_for", "alias_input")

        # 设置模块会话标记，防止其他模块处理消息
        await session_manager.set(user_id, "alias_active", True)

        # 提示用户输入别名
        text = f"<b>➕ 添加别名</b>\n\n"
        text += f"已选择命令: <code>/{cmd}</code>\n\n"
        text += "请输入要添加的别名（不需要加 / 前缀）："

        # 添加取消按钮 - 使用短英文文本
        keyboard = [[
            InlineKeyboardButton("⨉ Cancel",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")

    elif action.startswith("remove_alias_"):
        # 解析命令和别名
        parts = action[len("remove_alias_"):].split("_")
        if len(parts) >= 2:
            cmd = parts[0]
            alias = parts[1]

            # 删除别名
            result = await remove_alias(cmd, alias)

            # 显示结果
            await query.answer(result)

            # 返回删除别名菜单
            await show_remove_alias_menu(update, context)

    # 确保回调查询得到响应
    await query.answer()


async def show_add_alias_menu(update: Update,
                              context: ContextTypes.DEFAULT_TYPE):
    """显示添加别名界面，使用PaginationHelper支持分页"""
    # 确保是回调查询
    if not update.callback_query:
        _interface.logger.error("show_add_alias_menu 被非回调查询调用")
        return

    query = update.callback_query
    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await query.answer("系统错误，请联系管理员")
        return

    # 获取所有可用命令
    command_manager = _interface.application.bot_data.get("command_manager")
    if not command_manager:
        await query.answer("无法获取命令列表")
        return

    # 获取分页信息
    page = await session_manager.get(user_id, "alias_cmd_page", 0)

    # 获取所有命令并排序
    commands = sorted(command_manager.commands.keys())

    # 创建命令按钮生成函数
    def create_command_buttons(commands_subset):
        buttons = []
        row = []
        for cmd in commands_subset:
            # 确保回调数据不超过64字节
            callback_data = f"{CALLBACK_PREFIX}select_cmd_{cmd}"
            if len(callback_data.encode('utf-8')) <= 64:
                if len(row) < 3:  # 每行三个按钮
                    row.append(
                        InlineKeyboardButton(f"{cmd}",
                                             callback_data=callback_data))
                else:
                    buttons.append(row)
                    row = [
                        InlineKeyboardButton(f"{cmd}",
                                             callback_data=callback_data)
                    ]

        # 添加最后一行
        if row:
            buttons.append(row)

        # 添加返回按钮
        buttons.append([
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ])

        return buttons

    # 创建分页助手
    pagination = PaginationHelper(
        items=commands,
        page_size=15,  # 每页15个命令
        format_item=lambda cmd: f"{cmd}",  # 简单格式化
        title="添加别名 - 选择命令",
        callback_prefix=f"{CALLBACK_PREFIX}cmd_page")

    # 获取页面内容
    content, standard_keyboard = pagination.get_page_content(page)

    # 创建自定义按钮布局
    custom_buttons = create_command_buttons(
        commands[page * pagination.page_size:min(
            (page + 1) * pagination.page_size, len(commands))])

    # 在返回按钮前添加分页导航按钮
    if pagination.total_pages > 1:
        nav_row = []
        if page > 0:
            nav_row.append(
                InlineKeyboardButton(
                    "◁ Prev", callback_data=f"{CALLBACK_PREFIX}prev_page"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        nav_row.append(
            InlineKeyboardButton(f"{page + 1}/{pagination.total_pages}",
                                 callback_data="noop"))

        if page < pagination.total_pages - 1:
            nav_row.append(
                InlineKeyboardButton(
                    "Next ▷", callback_data=f"{CALLBACK_PREFIX}next_page"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        # 插入导航按钮到返回按钮前
        custom_buttons.insert(len(custom_buttons) - 1, nav_row)

    # 创建自定义键盘标记
    custom_keyboard = InlineKeyboardMarkup(custom_buttons)

    # 构建HTML格式的消息
    text = "<b>➕ 添加别名</b>\n\n"
    text += "请选择要为其添加别名的命令："
    if pagination.total_pages > 1:
        text += f"\n<i>第 {page + 1}/{pagination.total_pages} 页</i>"

    # 保存当前页码
    await session_manager.set(user_id, "alias_cmd_page", page)

    # 发送消息
    await query.edit_message_text(text,
                                  reply_markup=custom_keyboard,
                                  parse_mode="HTML")


async def show_remove_alias_menu(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE):
    """显示删除别名界面，使用PaginationHelper支持分页"""
    # 确保是回调查询
    if not update.callback_query:
        _interface.logger.error("show_remove_alias_menu 被非回调查询调用")
        return

    query = update.callback_query
    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await query.answer("系统错误，请联系管理员")
        return

    # 收集所有可删除的别名
    all_aliases = []
    for cmd, aliases in _state["aliases"].items():
        for alias in aliases:
            # 跳过 alias 命令的默认别名
            if cmd == "alias" and alias == "别名":
                continue
            all_aliases.append((cmd, alias))

    # 检查是否有别名
    if not all_aliases:
        text = "<b>➖ 删除别名</b>\n\n"
        text += "<i>暂无别名可删除</i>"

        # 添加返回按钮 - 使用短英文文本
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.edit_message_text(text,
                                      reply_markup=reply_markup,
                                      parse_mode="HTML")
        return

    # 获取分页信息
    page = await session_manager.get(user_id, "alias_remove_page", 0)

    # 创建别名按钮生成函数
    def create_alias_buttons(aliases_subset):
        buttons = []
        for cmd, alias in aliases_subset:
            # 确保回调数据不超过64字节
            callback_data = f"{CALLBACK_PREFIX}remove_alias_{cmd}_{alias}"
            if len(callback_data.encode('utf-8')) <= 64:
                # 使用更简洁的按钮文本
                buttons.append([
                    InlineKeyboardButton(
                        f"{cmd} → {alias}",  # 移除斜杠前缀和中文引号
                        callback_data=callback_data)
                ])

        # 添加返回按钮
        buttons.append([
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ])

        return buttons

    # 创建分页助手
    pagination = PaginationHelper(
        items=all_aliases,
        page_size=10,  # 每页10个别名
        format_item=lambda item: f"{item[0]} → {item[1]}",  # 格式化为 "命令 → 别名"
        title="删除别名",
        callback_prefix=f"{CALLBACK_PREFIX}remove_page")

    # 获取当前页码
    page = max(0, min(page, pagination.total_pages - 1))

    # 保存当前页码
    await session_manager.set(user_id, "alias_remove_page", page)

    # 创建自定义按钮布局
    custom_buttons = create_alias_buttons(
        all_aliases[page * pagination.page_size:min(
            (page + 1) * pagination.page_size, len(all_aliases))])

    # 在返回按钮前添加分页导航按钮
    if pagination.total_pages > 1:
        nav_row = []
        if page > 0:
            nav_row.append(
                InlineKeyboardButton(
                    "◁ Prev",
                    callback_data=f"{CALLBACK_PREFIX}prev_remove_page"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        nav_row.append(
            InlineKeyboardButton(f"{page + 1}/{pagination.total_pages}",
                                 callback_data="noop"))

        if page < pagination.total_pages - 1:
            nav_row.append(
                InlineKeyboardButton(
                    "Next ▷",
                    callback_data=f"{CALLBACK_PREFIX}next_remove_page"))
        else:
            nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

        # 插入导航按钮到返回按钮前
        custom_buttons.insert(len(custom_buttons) - 1, nav_row)

    # 创建自定义键盘标记
    custom_keyboard = InlineKeyboardMarkup(custom_buttons)

    # 构建HTML格式的消息
    text = "<b>➖ 删除别名</b>\n\n"
    text += "请选择要删除的别名："
    if pagination.total_pages > 1:
        text += f"\n<i>第 {page + 1}/{pagination.total_pages} 页</i>"

    # 发送消息
    await query.edit_message_text(text,
                                  reply_markup=custom_keyboard,
                                  parse_mode="HTML")


async def handle_alias_input(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """处理用户输入的别名"""
    # 只处理私聊消息
    if update.effective_chat.type != "private":
        return

    message = update.message
    if not message:
        return

    user_id = update.effective_user.id

    # 获取会话管理器
    session_manager = context.bot_data.get("session_manager")
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        return

    # 检查是否是 alias 模块的活跃会话
    is_active = await session_manager.get(user_id, "alias_active", False)
    if not is_active:
        return

    # 获取会话状态
    waiting_for = await session_manager.get(user_id, "alias_waiting_for")

    # 记录会话状态
    _interface.logger.debug(
        f"处理别名输入: user_id={user_id}, waiting_for={waiting_for}")

    if waiting_for == "alias_input":
        # 获取选择的命令
        cmd = await session_manager.get(user_id, "alias_selected_cmd")

        if not cmd:
            await message.reply_text("⚠️ 会话已过期，请重新开始")
            await session_manager.delete(user_id, "alias_waiting_for")
            await session_manager.delete(user_id, "alias_selected_cmd")
            return

        # 获取用户输入的别名
        alias = message.text.strip()

        # 检查别名格式
        if not alias or ' ' in alias or '/' in alias:
            await message.reply_text("⚠️ 别名不能包含空格或斜杠，请重新输入：")
            return

        # 添加别名
        result = await add_alias(cmd, alias)

        # 清除会话状态
        await session_manager.delete(user_id, "alias_waiting_for")
        await session_manager.delete(user_id, "alias_selected_cmd")
        await session_manager.delete(user_id, "alias_active")  # 清除模块会话标记

        # 显示结果 - 使用短英文文本
        keyboard = [[
            InlineKeyboardButton("⇠ Back",
                                 callback_data=f"{CALLBACK_PREFIX}back")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await message.reply_text(result, reply_markup=reply_markup)


async def setup(interface):
    """模块初始化"""
    global _interface, _state
    _interface = interface

    # 从文件加载别名数据
    loaded_state = _load_aliases()

    # 使用框架的状态管理加载之前保存的状态
    saved_state = interface.load_state(default=None)

    # 如果有保存的状态，优先使用保存的状态
    if saved_state:
        _state.update(saved_state)
    # 否则使用从配置文件加载的状态
    elif loaded_state:
        _state.update(loaded_state)
        # 将状态保存到框架的状态管理中
        interface.save_state(_state)

    # 更新反向映射表
    _update_reverse_aliases()

    # 注册命令
    await interface.register_command("alias",
                                     alias_command,
                                     admin_level="super_admin",
                                     description="管理命令别名")

    # 注册带权限验证的按钮回调处理器
    await interface.register_callback_handler(handle_callback_query,
                                              pattern=f"^{CALLBACK_PREFIX}",
                                              admin_level="super_admin")

    # 注册文本输入处理器 - 使用较高优先级，确保在其他模块之前处理
    text_input_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & filters.ChatType.PRIVATE,
        handle_alias_input)
    await interface.register_handler(text_input_handler, group=1)

    # 延迟注册处理器，确保所有命令已经注册
    asyncio.create_task(delayed_register_handler())

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def delayed_register_handler():
    """延迟注册消息处理器，确保所有命令都已注册"""
    global _interface

    # 等待 2s 让所有模块初始化
    await asyncio.sleep(2)

    # 注册消息处理器
    await register_message_handler()


async def cleanup(interface):
    """模块清理"""
    # 保存别名数据到文件和框架状态
    await _save_aliases()

    # 保存状态到框架的状态管理中
    interface.save_state(_state)

    interface.logger.info(f"模块 {MODULE_NAME} 已清理")
