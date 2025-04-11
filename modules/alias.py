# modules/alias.py

import asyncio
import json
import os
import random
import threading
from telegram import Update
from telegram.ext import ContextTypes, MessageHandler, filters
from utils.decorators import error_handler
from utils.text_utils import TextUtils

# 模块元数据
MODULE_NAME = "alias"
MODULE_VERSION = "1.5.0"
MODULE_DESCRIPTION = "命令别名，支持中文命令和动作"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["alias"]  # 只包含英文命令

# 存储别名数据的文件路径
_data_file = "config/aliases.json"

# 内置动作模板（不会被保存到配置文件中）
_action_templates = {
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
# 模块接口引用
_module_interface = None
# 消息处理器引用
_message_handler = None
# 状态锁
_state_lock = threading.Lock()


def _update_reverse_aliases():
    """更新反向映射表"""
    global _reverse_aliases
    _reverse_aliases = {}
    for cmd, alias_list in _state["aliases"].items():
        for alias in alias_list:
            _reverse_aliases[alias] = cmd


def load_aliases():
    """从文件加载别名数据"""
    if not os.path.exists(_data_file):
        return _state  # 返回默认状态

    try:
        with open(_data_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
            # 确保有 permissions 字段
            if "permissions" not in data:
                data["permissions"] = {"alias": "super_admin"}
            # 不从文件加载 action_templates
            if "action_templates" in data:
                del data["action_templates"]
            return data
    except Exception as e:
        if _module_interface:
            _module_interface.logger.error(f"加载别名数据失败: {e}")
        return _state  # 返回默认状态


def save_aliases():
    """保存别名数据到文件（线程安全）"""
    global _state

    with _state_lock:
        os.makedirs(os.path.dirname(_data_file), exist_ok=True)

        try:
            # 创建一个不包含 action_templates 的副本
            save_state = _state.copy()
            if "action_templates" in save_state:
                del save_state["action_templates"]

            with open(_data_file, 'w', encoding='utf-8') as f:
                json.dump(save_state, f, ensure_ascii=False, indent=2)
            if _module_interface:
                _module_interface.logger.debug(f"别名数据已保存到 {_data_file}")
        except Exception as e:
            if _module_interface:
                _module_interface.logger.error(f"保存别名数据失败: {e}")


def _get_command_metadata(command):
    """获取命令的元数据，包括权限要求"""
    if not _module_interface:
        return {}

    bot_engine = _module_interface.bot_engine
    command_processor = bot_engine.command_processor

    # 尝试从命令处理器获取元数据
    if hasattr(command_processor, "get_command_metadata"):
        return command_processor.get_command_metadata(command)

    # 如果无法从命令处理器获取，尝试从状态中获取
    if "permissions" in _state and command in _state["permissions"]:
        return {"admin_only": _state["permissions"][command]}

    return {}


async def _check_permission(context, user_id, chat_id, admin_only):
    """检查用户是否有执行命令的权限
    
    Args:
        context: 上下文对象
        user_id: 用户 ID
        chat_id: 聊天 ID
        admin_only: 权限级别 ("super_admin" 或 "group_admin")
        
    Returns:
        bool: 是否有权限
    """
    config_manager = context.bot_data.get("config_manager")
    if not config_manager:
        _module_interface.logger.error("权限检查失败: 找不到 config_manager")
        return False

    # 检查是否是超级管理员
    if config_manager.is_admin(user_id):
        return True

    # 如果只需要超级管理员权限，此时可以返回 False
    if admin_only == "super_admin":
        return False

    # 检查是否是群组管理员（仅当需要群组管理员权限时）
    if admin_only == "group_admin" and chat_id:
        try:
            chat_member = await context.bot.get_chat_member(chat_id, user_id)
            return chat_member.status in ["creator", "administrator"]
        except Exception as e:
            _module_interface.logger.error(
                f"检查用户 {user_id} 在群组 {chat_id} 的权限失败: {e}")

    return False


def _is_command_exists(cmd):
    """检查命令是否存在"""
    if not _module_interface:
        return True  # 无法验证，假设存在

    bot_engine = _module_interface.bot_engine
    for module_name, module_data in bot_engine.module_loader.loaded_modules.items(
    ):
        if hasattr(module_data["module"], "MODULE_COMMANDS"):
            if cmd in module_data["module"].MODULE_COMMANDS:
                return True
    return False


def _get_module_of_command(command):
    """获取命令所属的模块名称"""
    if not _module_interface:
        return None

    bot_engine = _module_interface.bot_engine
    for module_name, module_data in bot_engine.module_loader.loaded_modules.items(
    ):
        if hasattr(module_data["module"], "MODULE_COMMANDS"):
            if command in module_data["module"].MODULE_COMMANDS:
                return module_name
    return None


def _is_module_enabled_for_chat(module_name, chat_id, context):
    """检查模块是否在指定聊天中启用"""
    if not chat_id:
        return True  # 如果无法确定聊天 ID，则假设启用

    config_manager = context.bot_data.get("config_manager")
    if not config_manager:
        return True  # 如果无法获取配置管理器，则假设启用

    # 核心命令不需要检查
    core_modules = ["core"]
    if module_name in core_modules:
        return True

    # 检查模块是否在当前聊天中启用
    return config_manager.is_module_enabled_for_chat(module_name, chat_id)


def _check_alias_cycle(cmd, alias, visited=None):
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


def is_chinese_command(command):
    """检查是否是中文命令"""
    # 简单检查是否包含中文字符
    return any('\u4e00' <= char <= '\u9fff' for char in command)


@error_handler
async def handle_action_command(update: Update,
                                context: ContextTypes.DEFAULT_TYPE, action):
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

    # 获取动作模板（从内置模板中获取）
    templates = _action_templates.get(
        action, _action_templates.get("default",
                                      ["{user} {action}了 {target}"]))

    # 随机选择一个模板
    template = random.choice(templates)

    # 生成动作消息
    action_message = template.format(user=user_mention,
                                     action=action,
                                     target=target_mention)

    # 发送消息
    await update.message.reply_text(action_message, parse_mode="HTML")


@error_handler
async def process_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理所有消息，检查是否包含中文命令别名或动作命令"""
    # 检查 alias 模块是否启用
    chat_id = update.effective_chat.id if update.effective_chat else None
    if not _is_module_enabled_for_chat("alias", chat_id, context):
        return None  # 如果 alias 模块被禁用，允许消息继续传递

    if not update.message or not update.message.text:
        return None  # 允许消息继续传递

    message_text = update.message.text

    # 只处理带 "/" 开头的命令别名，如 /复读
    if message_text.startswith('/'):
        command = message_text[1:].split(' ')[0].split('@')[0]  # 提取命令部分
        if command in _reverse_aliases:
            aliased_command = _reverse_aliases[command]

            # 检查模块是否在当前群组启用
            chat_id = update.effective_chat.id if update.effective_chat else None
            module_name = _get_module_of_command(aliased_command)

            if module_name and not _is_module_enabled_for_chat(
                    module_name, chat_id, context):
                # 模块未启用，发送提示
                chat_type = update.effective_chat.type if update.effective_chat else "unknown"
                if chat_type in ["group", "supergroup"]:
                    await update.effective_message.reply_text(
                        f"模块 {module_name} 未在当前群组启用。")
                else:
                    await update.effective_message.reply_text(
                        f"模块 {module_name} 未启用。")
                return True  # 阻止消息继续传递

            # 检查原始命令的权限要求
            command_metadata = _get_command_metadata(aliased_command)
            admin_only = command_metadata.get("admin_only", False)

            # 如果命令需要权限，进行权限检查
            if admin_only:
                # 获取用户信息
                user_id = update.effective_user.id

                # 检查用户权限
                if not await _check_permission(context, user_id, chat_id,
                                               admin_only):
                    # 权限不足，发送提示
                    if update.effective_message:
                        await update.effective_message.reply_text(
                            "⚠️ 您没有执行此命令的权限。" if admin_only ==
                            "group_admin" else "⚠️ 此命令仅超级管理员可用。")
                    return True  # 阻止消息继续传递

            # 提取参数
            args_text = message_text[len(command) + 1:].strip()
            args = args_text.split() if args_text else []

            # 记录命令调用
            _module_interface.logger.debug(
                f"执行别名命令: /{aliased_command} (别名: {command})")

            # 保存原始参数
            original_args = context.args if hasattr(context, 'args') else None

            try:
                # 设置新参数
                context.args = args

                command_executed = False

                # 尝试执行命令
                try:
                    # 获取命令所属的模块名称
                    module_name = _get_module_of_command(aliased_command)
                    if module_name:
                        # 获取模块接口
                        cmd_module = _module_interface.get_module_interface(
                            module_name)
                        if cmd_module:
                            # 命令处理函数名称
                            handler_name = f"{aliased_command}_command"
                            # 调用模块方法
                            await _module_interface.call_module_method(
                                module_name, handler_name, update, context)
                            _module_interface.logger.debug(
                                f"成功执行别名命令: /{aliased_command} (模块: {module_name})"
                            )
                            command_executed = True
                        else:
                            _module_interface.logger.debug(
                                f"找不到模块接口: {module_name}")
                    else:
                        _module_interface.logger.debug(
                            f"找不到命令 /{aliased_command} 所属的模块")
                except Exception as e:
                    _module_interface.logger.debug(f"尝试直接调用模块方法失败: {str(e)}")

                # 如果直接调用失败，尝试通过事件系统
                if not command_executed:
                    try:
                        # 发布命令执行事件
                        result = await _module_interface.publish_event(
                            "execute_command",
                            command=aliased_command,
                            update=update,
                            context=context)
                        if result and result[0] > 0:
                            _module_interface.logger.debug(
                                f"通过事件系统执行别名命令: /{aliased_command}")
                            command_executed = True
                    except Exception as e:
                        _module_interface.logger.debug(
                            f"尝试通过事件系统执行命令失败: {str(e)}")

                # 如果所有方法都失败，记录警告
                if not command_executed:
                    _module_interface.logger.warning(
                        f"未找到别名命令的处理器: /{aliased_command}")

                # 只有在成功执行命令时才返回 True 阻止消息继续传递
                return command_executed

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
            return True  # 阻止消息继续传递

    # 如果不是别名或处理失败，明确返回 None 允许消息继续传递
    return None


@error_handler
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
        if not _is_command_exists(cmd):
            await update.message.reply_text(f"⚠️ 命令 /{cmd} 不存在")
            return

        # 检查别名是否与现有命令冲突
        bot_engine = context.bot_data.get("bot_engine")
        if bot_engine:
            for module_name, module_data in bot_engine.module_loader.loaded_modules.items(
            ):
                if hasattr(module_data["module"], "MODULE_COMMANDS"):
                    if alias in module_data["module"].MODULE_COMMANDS:
                        await update.message.reply_text(
                            f"⚠️ 别名「{alias}」与现有命令冲突，请使用其他名称")
                        return

        # 检查是否会形成循环引用
        if _check_alias_cycle(cmd, alias):
            await update.message.reply_text(f"⚠️ 添加别名「{alias}」会形成循环引用")
            return

        # 获取命令的权限要求
        command_metadata = _get_command_metadata(cmd)
        admin_only = command_metadata.get("admin_only", False)

        # 如果命令存在权限要求，保存到状态中
        if admin_only:
            if "permissions" not in _state:
                _state["permissions"] = {}
            _state["permissions"][cmd] = admin_only

        # 检查命令是否在别名表中
        if cmd not in _state["aliases"]:
            _state["aliases"][cmd] = []

        # 添加别名
        if alias not in _state["aliases"][cmd]:
            with _state_lock:
                _state["aliases"][cmd].append(alias)
                _update_reverse_aliases()
            save_aliases()  # 保存到文件
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
            with _state_lock:
                _state["aliases"][cmd].remove(alias)
                # 如果别名列表为空，考虑完全移除该命令
                if not _state["aliases"][
                        cmd] and cmd != "alias":  # 保留 alias 命令本身
                    del _state["aliases"][cmd]
                    # 如果有权限记录，也可以移除
                    if cmd in _state.get("permissions", {}):
                        del _state["permissions"][cmd]
                _update_reverse_aliases()
            save_aliases()  # 保存到文件
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


@error_handler
async def register_message_handler():
    """安全地注册消息处理器"""
    global _module_interface, _message_handler

    # 获取 bot_engine 引用
    bot_engine = _module_interface.bot_engine

    # 使用更新锁确保安全
    async with bot_engine.update_lock:
        # 如果已经注册了处理器，先注销
        if _message_handler:
            try:
                # 安全地注销处理器
                handlers_to_remove = list(
                    _module_interface.registered_handlers)
                _module_interface.registered_handlers = []

                for handler, group in handlers_to_remove:
                    try:
                        _module_interface.application.remove_handler(
                            handler, group)
                    except Exception as e:
                        _module_interface.logger.warning(f"移除处理器时出错: {e}")

                _message_handler = None
            except Exception as e:
                _module_interface.logger.error(f"注销消息处理器失败: {e}")

        # 注册新的消息处理器
        _message_handler = MessageHandler(filters.Regex(r'^/'),
                                          process_message)
        _module_interface.register_handler(_message_handler,
                                           group=100)  # 使用较低的优先级
        _module_interface.logger.info("别名消息处理器已安全注册")


# 所有模块加载完成的事件处理
@error_handler
async def on_all_modules_loaded(event_type, **event_data):
    """当所有模块加载完成时调用"""
    global _module_interface

    # 获取 bot_engine 引用
    bot_engine = _module_interface.bot_engine

    # 延迟一点时间再注册处理器，确保所有命令都已注册
    await asyncio.sleep(1)

    # 使用更新锁保护处理器注册
    async with bot_engine.update_lock:
        # 注册消息处理器
        await register_message_handler()

    _module_interface.logger.info("所有模块加载完成，别名系统已更新")


# 状态管理函数
def get_state(module_interface):
    """获取模块状态"""
    return _state


def set_state(module_interface, state):
    """设置模块状态"""
    global _state
    with _state_lock:
        _state = state
        _update_reverse_aliases()
    module_interface.logger.debug(f"模块状态已更新: {state}")


def setup(module_interface):
    """模块初始化"""
    global _module_interface, _state
    _module_interface = module_interface

    # 从文件加载别名数据
    loaded_state = load_aliases()
    if loaded_state:
        _state.update(loaded_state)

    # 更新反向映射表
    _update_reverse_aliases()

    # 注册命令
    module_interface.register_command("alias",
                                      alias_command,
                                      admin_only="super_admin")

    # 订阅模块加载完成事件
    module_interface.subscribe_event("all_modules_loaded",
                                     on_all_modules_loaded)

    # 创建一个延迟任务来安全地注册消息处理器
    asyncio.create_task(delayed_register_handler(module_interface))

    # 同时也保存到模块状态系统（作为备份）
    module_interface.save_state(_state)

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def delayed_register_handler(module_interface):
    """安全地延迟注册消息处理器"""
    global _message_handler, _module_interface

    try:
        # 延迟一段时间，确保所有命令都已注册
        await asyncio.sleep(2)

        # 获取 bot_engine 引用
        bot_engine = module_interface.bot_engine

        # 使用更新锁保护处理器注册
        async with bot_engine.update_lock:
            # 注册消息处理器
            _message_handler = MessageHandler(filters.Regex(r'^/'),
                                              process_message)
            module_interface.register_handler(_message_handler,
                                              group=100)  # 使用较低的优先级
            module_interface.logger.info("别名消息处理器已安全注册")
    except Exception as e:
        module_interface.logger.error(f"延迟注册消息处理器失败: {e}")


def cleanup(module_interface):
    """模块清理"""
    global _message_handler

    # 保存别名数据到文件
    save_aliases()

    # 同时也保存到模块状态系统（作为备份）
    module_interface.save_state(_state)

    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
