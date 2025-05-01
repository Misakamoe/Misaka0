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
MODULE_VERSION = "3.2.0"
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

            # 获取命令管理器
            command_manager = _interface.command_manager
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
                # 使用命令管理器进行权限检查
                if not await command_manager._check_permission(
                        admin_level, update, context):
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

                # 如果没有找到回调函数，记录错误
                _interface.logger.error(f"命令 {aliased_command} 没有回调函数")

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

    # 构建按钮 - 使用两行排列
    keyboard = [[
        InlineKeyboardButton("Add", callback_data=f"{CALLBACK_PREFIX}add"),
        InlineKeyboardButton("Remove",
                             callback_data=f"{CALLBACK_PREFIX}remove")
    ], [InlineKeyboardButton("Help", callback_data=f"{CALLBACK_PREFIX}help")]]

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
    command_manager = _interface.command_manager
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


async def handle_callback_query(update: Update,
                                context: ContextTypes.DEFAULT_TYPE):
    """处理按钮回调查询"""
    query = update.callback_query
    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取回调数据
    callback_data = query.data

    # 检查前缀
    if not callback_data.startswith(CALLBACK_PREFIX):
        return

    # 移除前缀
    action = callback_data[len(CALLBACK_PREFIX):]

    # 获取会话管理器
    session_manager = _interface.session_manager
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        await query.answer("系统错误，请联系管理员")
        return

    # 处理不同的操作
    if action == "add":
        # 显示添加别名界面
        await show_add_alias_menu(update, context, 0)

    elif action == "remove":
        # 显示删除别名界面
        await show_remove_alias_menu(update, context, 0)

    elif action == "help":
        # 显示帮助信息
        help_text = "<b>📚 命令别名帮助</b>\n\n"
        help_text += "您可以为现有命令创建更易记的名称，比如中文名称\n\n"
        help_text += "<b>示例：</b>\n"
        help_text += "添加别名 <code>帮助</code> 给命令 <code>/help</code>\n"
        help_text += "然后可以用 <code>/帮助</code> 代替 <code>/help</code>"

        # 添加返回按钮
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
        await session_manager.delete(user_id,
                                     "alias_waiting_for",
                                     chat_id=chat_id)
        # 释放会话所有权
        await session_manager.release_session(user_id,
                                              MODULE_NAME,
                                              chat_id=chat_id)

        # 返回主菜单
        await show_alias_main_menu(update, context)

    elif action.startswith("cmd_page:"):
        # 处理命令列表分页
        try:
            # 获取页码
            page_num = int(action.split(":")[1])
            # 直接传递页码参数
            await show_add_alias_menu(update, context, page_num)
        except (ValueError, IndexError):
            await query.answer("无效的页码")

    elif action.startswith("remove_page:"):
        # 处理删除别名分页
        try:
            # 获取页码
            page_num = int(action.split(":")[1])
            # 直接传递页码参数
            await show_remove_alias_menu(update, context, page_num)
        except (ValueError, IndexError):
            await query.answer("无效的页码")

    elif action.startswith("select_cmd_"):
        # 选择命令后，提示输入别名
        cmd = action[len("select_cmd_"):]

        # 检查是否有其他模块的活跃会话
        has_other_session = await session_manager.has_other_module_session(
            user_id, MODULE_NAME, chat_id=chat_id)

        if has_other_session:
            # 如果有其他模块的活跃会话，提醒用户
            await query.answer("⚠️ 请先完成或取消其他活跃会话")
            return

        # 保存到会话
        await session_manager.set(user_id,
                                  "alias_waiting_for",
                                  f"alias_input:{cmd}",
                                  chat_id=chat_id,
                                  module_name=MODULE_NAME)

        # 提示用户输入别名
        text = f"<b>➕ 添加别名</b>\n\n"
        text += f"已选择命令: <code>/{cmd}</code>\n\n"
        text += "请输入要添加的别名（不需要加 /）"

        # 添加取消按钮
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
                              context: ContextTypes.DEFAULT_TYPE,
                              page: int = 0):
    """显示添加别名界面，使用PaginationHelper支持分页

    Args:
        update: 更新对象
        context: 上下文对象
        page: 页码，默认为0
    """
    # 确保是回调查询
    if not update.callback_query:
        return

    query = update.callback_query

    # 获取所有可用命令
    command_manager = _interface.command_manager
    if not command_manager:
        await query.answer("无法获取命令列表")
        return

    # 获取所有命令并排序
    commands = sorted(command_manager.commands.keys())

    # 创建按钮列表
    buttons = []
    for cmd in commands:
        # 确保回调数据不超过64字节
        callback_data = f"{CALLBACK_PREFIX}select_cmd_{cmd}"
        if len(callback_data.encode('utf-8')) <= 64:
            button_tuple = (cmd, callback_data)
            buttons.append(button_tuple)

    # 创建返回按钮
    back_button = InlineKeyboardButton("⇠ Back",
                                       callback_data=f"{CALLBACK_PREFIX}back")

    # 使用新的 paginate_buttons 方法创建分页按钮
    try:
        keyboard = PaginationHelper.paginate_buttons(
            buttons=buttons,
            page_index=page,
            rows_per_page=5,  # 每页显示5行
            buttons_per_row=3,  # 每行显示3个按钮
            nav_callback_prefix=f"{CALLBACK_PREFIX}cmd_page",
            back_button=back_button)
    except Exception:
        # 创建一个简单的键盘作为后备
        keyboard = InlineKeyboardMarkup([[back_button]])

    # 构建HTML格式的消息
    text = "<b>➕ 添加别名</b>\n\n"
    text += "请选择要为其添加别名的命令："

    # 发送消息
    await query.edit_message_text(text,
                                  reply_markup=keyboard,
                                  parse_mode="HTML")


async def show_remove_alias_menu(update: Update,
                                 context: ContextTypes.DEFAULT_TYPE,
                                 page: int = 0):
    """显示删除别名界面，使用PaginationHelper支持分页

    Args:
        update: 更新对象
        context: 上下文对象
        page: 页码，默认为0
    """
    # 确保是回调查询
    if not update.callback_query:
        return

    query = update.callback_query

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

    # 创建按钮列表
    buttons = []
    for cmd, alias in all_aliases:
        # 确保回调数据不超过64字节
        callback_data = f"{CALLBACK_PREFIX}remove_alias_{cmd}_{alias}"
        if len(callback_data.encode('utf-8')) <= 64:
            button_text = f"{cmd} → {alias}"
            button_tuple = (button_text, callback_data)
            buttons.append(button_tuple)

    # 创建返回按钮
    back_button = InlineKeyboardButton("⇠ Back",
                                       callback_data=f"{CALLBACK_PREFIX}back")

    # 使用新的 paginate_buttons 方法创建分页按钮
    try:
        keyboard = PaginationHelper.paginate_buttons(
            buttons=buttons,
            page_index=page,
            rows_per_page=5,  # 每页显示5行
            buttons_per_row=1,  # 每行显示1个按钮
            nav_callback_prefix=f"{CALLBACK_PREFIX}remove_page",
            back_button=back_button)
    except Exception:
        # 创建一个简单的键盘作为后备
        keyboard = InlineKeyboardMarkup([[back_button]])

    # 构建HTML格式的消息
    text = "<b>➖ 删除别名</b>\n\n"
    text += "请选择要删除的别名："

    # 发送消息
    await query.edit_message_text(text,
                                  reply_markup=keyboard,
                                  parse_mode="HTML")


async def handle_alias_input(update: Update,
                             context: ContextTypes.DEFAULT_TYPE):
    """处理用户输入的别名"""
    message = update.message
    if not message:
        return

    user_id = update.effective_user.id
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = _interface.session_manager
    if not session_manager:
        _interface.logger.error("无法获取会话管理器")
        return

    # 检查是否是 alias 模块的活跃会话
    is_owned = await session_manager.is_session_owned_by(user_id,
                                                         MODULE_NAME,
                                                         chat_id=chat_id)
    if not is_owned:
        return

    # 获取会话状态
    waiting_for = await session_manager.get(user_id,
                                            "alias_waiting_for",
                                            None,
                                            chat_id=chat_id)

    if waiting_for and waiting_for.startswith("alias_input:"):
        # 从waiting_for中提取命令
        cmd = waiting_for.split(":", 1)[1]

        # 获取用户输入的别名
        alias = message.text.strip()

        # 检查别名格式
        if not alias or ' ' in alias or '/' in alias:
            await message.reply_text("⚠️ 别名不能包含空格或斜杠，请重新输入：")
            return

        # 添加别名
        result = await add_alias(cmd, alias)

        # 清除会话状态
        await session_manager.delete(user_id,
                                     "alias_waiting_for",
                                     chat_id=chat_id)
        # 释放会话所有权
        await session_manager.release_session(user_id,
                                              MODULE_NAME,
                                              chat_id=chat_id)

        # 显示结果
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

    # 注册消息处理器
    message_handler = MessageHandler(filters.Regex(r'^/'), process_message)
    await interface.register_handler(message_handler, group=1)
    interface.logger.info("别名消息处理器已注册")

    # 注册文本输入处理器
    text_input_handler = MessageHandler(
        filters.TEXT & ~filters.COMMAND & ~filters.Regex(r'^/'),
        handle_alias_input)
    await interface.register_handler(text_input_handler, group=2)

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理"""
    # 保存别名数据到文件和框架状态
    await _save_aliases()

    interface.logger.info(f"模块 {MODULE_NAME} 已清理")
