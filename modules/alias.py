# modules/alias.py

from telegram import Update, MessageEntity
from telegram.ext import ContextTypes, MessageHandler, filters
from utils.decorators import error_handler

# 模块元数据
MODULE_NAME = "alias"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "提供命令别名功能，支持中文命令"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["alias"]  # 只包含英文命令

# 模块状态
_state = {
    "aliases": {
        "alias": ["别名"],  # 为 alias 命令本身添加中文别名
        # 可以添加更多命令别名
    }
}

# 反向映射表（自动生成）
_reverse_aliases = {}
# 模块接口引用
_module_interface = None


def _update_reverse_aliases():
    """更新反向映射表"""
    global _reverse_aliases
    _reverse_aliases = {}
    for cmd, alias_list in _state["aliases"].items():
        for alias in alias_list:
            _reverse_aliases[alias] = cmd


@error_handler
async def process_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理所有消息，检查是否包含中文命令别名"""
    if not update.message or not update.message.text:
        return

    message_text = update.message.text

    # 只处理带 "/" 开头的命令别名，如 /复读
    if message_text.startswith('/'):
        command = message_text[1:].split(' ')[0].split('@')[0]  # 提取命令部分
        if command in _reverse_aliases:
            aliased_command = _reverse_aliases[command]
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

                # 尝试执行命令
                try:
                    # 尝试获取对应的模块接口
                    cmd_module = _module_interface.get_module_interface(
                        aliased_command)
                    if cmd_module:
                        # 假设模块有一个与命令同名的处理函数
                        handler_name = f"{aliased_command}_command"
                        # 调用模块方法
                        await _module_interface.call_module_method(
                            aliased_command, handler_name, update, context)
                        _module_interface.logger.debug(
                            f"成功执行别名命令: /{aliased_command}")
                        return True
                except Exception as e:
                    _module_interface.logger.debug(f"尝试直接调用模块方法失败: {str(e)}")

                # 尝试通过事件系统
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
                        return True
                except Exception as e:
                    _module_interface.logger.debug(f"尝试通过事件系统执行命令失败: {str(e)}")

                # 如果所有方法都失败，记录警告
                _module_interface.logger.warning(
                    f"未找到别名命令的处理器: /{aliased_command}")

                return False
            finally:
                # 恢复原始参数
                if original_args is not None:
                    context.args = original_args
                else:
                    if hasattr(context, 'args'):
                        delattr(context, 'args')


@error_handler
async def alias_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """管理命令别名"""
    if not context.args or len(context.args) < 1:
        # 显示当前所有别名
        reply = "当前命令别名：\n"
        for cmd, aliases in _state["aliases"].items():
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
        if cmd not in _state["aliases"]:
            _state["aliases"][cmd] = []

        # 添加别名
        if alias not in _state["aliases"][cmd]:
            _state["aliases"][cmd].append(alias)
            _update_reverse_aliases()
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
            _state["aliases"][cmd].remove(alias)
            _update_reverse_aliases()
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


def setup(module_interface):
    """模块初始化"""
    global _module_interface
    _module_interface = module_interface

    # 更新反向映射表
    _update_reverse_aliases()

    # 注册命令
    module_interface.register_command("alias",
                                      alias_command,
                                      admin_only="super_admin")

    # 注册消息处理器，只处理带 / 的消息
    module_interface.register_handler(
        MessageHandler(filters.Regex(r'^/'), process_message),
        group=-100  # 使用高优先级
    )

    # 加载状态
    saved_state = module_interface.load_state(
        default={"aliases": {
            "alias": ["别名"]
        }})
    global _state
    _state = saved_state
    _update_reverse_aliases()

    module_interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


def cleanup(module_interface):
    """模块清理"""
    # 保存状态
    module_interface.save_state(_state)
    module_interface.logger.info(f"模块 {MODULE_NAME} 已清理")
