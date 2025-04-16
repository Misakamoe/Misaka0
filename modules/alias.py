# modules/alias.py - 命令别名模块

import asyncio
import json
import os
import random
from typing import Dict, Optional, Any
from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters

# 模块元数据
MODULE_NAME = "Alias"
MODULE_VERSION = "2.0.0"
MODULE_DESCRIPTION = "命令别名，支持中文命令和动作"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["alias"]  # 只包含英文命令

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
    """保存别名数据到文件（异步安全）"""
    global _state

    async with _state_lock:
        os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

        try:
            # 创建一个副本
            save_state = {
                "aliases": _state["aliases"],
                "permissions": _state["permissions"]
            }

            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(save_state, f, ensure_ascii=False, indent=2)
            if _interface:
                _interface.logger.debug(f"别名数据已保存到 {CONFIG_FILE}")
        except Exception as e:
            if _interface:
                _interface.logger.error(f"保存别名数据失败: {e}")


async def _get_command_metadata(command: str) -> Dict[str, Any]:
    """获取命令的元数据，包括权限要求"""
    # 从状态中获取
    if "permissions" in _state and command in _state["permissions"]:
        return {"admin_level": _state["permissions"][command]}

    # 尝试从命令管理器获取
    try:
        command_manager = _interface.application.bot_data.get(
            "command_manager")
        if command_manager and hasattr(command_manager, "commands"):
            cmd_info = command_manager.commands.get(command, {})
            if cmd_info:
                return {"admin_level": cmd_info.get("admin_level", False)}
    except Exception as e:
        _interface.logger.debug(f"获取命令元数据时出错: {e}")

    return {}


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
    # 获取发送者信息
    user = update.effective_user
    user_name = user.full_name
    user_mention = f'<a href="tg://user?id={user.id}">{user_name}</a>'

    # 检查是否回复了其他消息
    target_mention = "自己"
    if update.message.reply_to_message:
        target_user = update.message.reply_to_message.from_user
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
    await update.message.reply_text(action_message, parse_mode="HTML")


async def process_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理所有消息，检查是否包含中文命令别名或动作命令"""
    if not update.message or not update.message.text:
        return

    message_text = update.message.text

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

            # 保存原始参数
            original_args = context.args if hasattr(context, 'args') else None

            try:
                # 设置新参数
                context.args = args

                # 尝试执行命令
                command_manager = _interface.application.bot_data.get(
                    "command_manager")
                if command_manager:
                    # 获取命令信息
                    cmd_info = command_manager.commands.get(aliased_command)
                    if cmd_info:
                        # 获取回调函数
                        callback = cmd_info.get("callback")
                        if callback:
                            # 执行命令
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
    if not context.args or len(context.args) < 1:
        # 显示当前所有别名
        reply = "当前命令别名：\n"
        for cmd, aliases in _state["aliases"].items():
            if aliases:  # 只显示有别名的命令
                alias_str = ", ".join([f"「{a}」" for a in aliases])
                reply += f"/{cmd} → {alias_str}\n"
        await update.message.reply_text(reply)
        return

    # 子命令: add 或 remove
    action = context.args[0].lower()

    if action in ["add", "添加"] and len(context.args) >= 3:
        # 添加新别名: /alias add echo 复读
        cmd = context.args[1].lower()
        if cmd.startswith('/'):
            cmd = cmd[1:]

        alias = context.args[2]

        # 检查命令是否存在
        command_manager = _interface.application.bot_data.get(
            "command_manager")
        if not command_manager or cmd not in command_manager.commands:
            await update.message.reply_text(f"⚠️ 命令 /{cmd} 不存在")
            return

        # 检查别名是否与现有命令冲突
        if alias in command_manager.commands:
            await update.message.reply_text(f"⚠️ 别名「{alias}」与现有命令冲突，请使用其他名称")
            return

        # 检查是否会形成循环引用
        if _check_alias_cycle(cmd, alias):
            await update.message.reply_text(f"⚠️ 添加别名「{alias}」会形成循环引用")
            return

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
            await _save_aliases()  # 保存到文件
            await update.message.reply_text(f"已为 /{cmd} 添加别名「{alias}」")
        else:
            await update.message.reply_text(f"别名「{alias}」已存在")

    elif action in ["remove", "删除"] and len(context.args) >= 3:
        # 删除别名: /alias remove echo 复读
        cmd = context.args[1].lower()
        if cmd.startswith('/'):
            cmd = cmd[1:]

        alias = context.args[2]

        # 检查命令是否存在
        if cmd not in _state["aliases"]:
            await update.message.reply_text(f"命令 /{cmd} 没有任何别名")
            return

        # 移除别名
        if alias in _state["aliases"][cmd]:
            async with _state_lock:
                _state["aliases"][cmd].remove(alias)
                # 如果别名列表为空，考虑完全移除该命令
                if not _state["aliases"][
                        cmd] and cmd != "alias":  # 保留 alias 命令本身
                    del _state["aliases"][cmd]
                    # 如果有权限记录，也可以移除
                    if cmd in _state.get("permissions", {}):
                        del _state["permissions"][cmd]
                _update_reverse_aliases()
            await _save_aliases()  # 保存到文件
            await update.message.reply_text(f"已从 /{cmd} 移除别名「{alias}」")
        else:
            await update.message.reply_text(f"别名「{alias}」不存在")

    else:
        # 显示帮助信息
        help_text = ("命令别名管理：\n"
                     "`/alias` - 显示当前所有别名\n"
                     "`/alias add <命令> <别名>` - 添加命令别名\n"
                     "`/alias remove <命令> <别名>` - 删除命令别名\n\n"
                     "示例：\n"
                     "`/alias add help 帮助`\n"
                     "`/alias remove help 帮助`")
        await update.message.reply_text(help_text, parse_mode="MARKDOWN")


async def register_message_handler():
    """安全地注册消息处理器"""
    global _interface, _message_handler

    # 如果已经注册了处理器，先注销
    if _message_handler:
        try:
            # 从接口的已注册处理器列表中移除
            for i, (handler, group) in enumerate(_interface.handlers):
                if handler == _message_handler:
                    _interface.handlers.pop(i)
                    break

            # 从应用中移除处理器
            _interface.application.remove_handler(_message_handler, 100)
            _message_handler = None
        except Exception as e:
            _interface.logger.error(f"注销消息处理器失败: {e}")

    # 注册新的消息处理器
    _message_handler = MessageHandler(filters.Regex(r'^/'), process_message)
    await _interface.register_handler(_message_handler, group=100)  # 使用较低的优先级
    _interface.logger.info("别名消息处理器已安全注册")


# 所有模块加载完成的事件处理
async def on_all_modules_loaded(event_type, **event_data):
    """当所有模块加载完成时调用"""
    # 延迟一点时间再注册处理器，确保所有命令都已注册
    await asyncio.sleep(1)

    # 注册消息处理器
    await register_message_handler()

    _interface.logger.info("所有模块加载完成，别名系统已更新")


# 状态管理函数
def get_state(module_interface):
    """获取模块状态"""
    return _state


def set_state(module_interface, state):
    """设置模块状态"""
    global _state
    _state = state
    _update_reverse_aliases()
    module_interface.logger.debug(f"模块状态已更新: {state}")


async def setup(module_interface):
    """模块初始化"""
    global _interface, _state
    _interface = module_interface

    # 从文件加载别名数据
    loaded_state = _load_aliases()
    if loaded_state:
        _state.update(loaded_state)

    # 更新反向映射表
    _update_reverse_aliases()

    # 注册命令
    await module_interface.register_command("alias",
                                            alias_command,
                                            admin_level="super_admin",
                                            description="管理命令别名")

    # 订阅模块加载完成事件
    await module_interface.subscribe_event("all_modules_loaded",
                                           on_all_modules_loaded)

    # 创建一个延迟任务来安全地注册消息处理器
    asyncio.create_task(delayed_register_handler())

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def delayed_register_handler():
    """安全地延迟注册消息处理器"""
    # 延迟一段时间，确保所有命令都已注册
    await asyncio.sleep(2)

    # 注册消息处理器
    await register_message_handler()


async def cleanup(module_interface):
    """模块清理"""
    # 保存别名数据到文件
    await _save_aliases()

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
