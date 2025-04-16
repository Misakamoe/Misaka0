# utils/decorators.py - 装饰器工具

import functools
import traceback
import inspect
import telegram
from telegram import Update
from utils.logger import setup_logger

logger = setup_logger("Decorators")


def error_handler(func):
    """错误处理装饰器，统一处理命令和回调中的异常"""

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        try:
            return await func(*args, **kwargs)
        except telegram.error.NetworkError as e:
            # 对网络错误只记录警告
            logger.warning(f"网络错误: {str(e)}")

            # 向用户发送友好的错误消息
            update = None
            for arg in args:
                if isinstance(arg, Update):
                    update = arg
                    break

            if update and update.effective_message:
                await update.effective_message.reply_text("网络连接暂时中断，请稍后再试。")
            return None
        except Exception as e:
            # 记录详细错误信息
            logger.error(f"处理 {func.__name__} 时出错: {str(e)}")
            logger.debug(traceback.format_exc())

            # 向用户发送友好的错误消息
            update = None
            for arg in args:
                if isinstance(arg, Update):
                    update = arg
                    break

            if update and update.effective_message:
                await update.effective_message.reply_text(
                    "😔 处理您的请求时出现错误，请稍后再试。")
            return None

    return wrapper


def _get_update_context_args(args, is_method=False):
    """从装饰器参数中提取 update, context 和其他参数
    
    Args:
        args: 参数元组
        is_method: 是否是类方法
        
    Returns:
        tuple: (self/None, update, context, other_args)
    """
    if is_method:
        # 类方法: self, update, context, ...
        if len(args) < 3:
            logger.error(f"参数不足，期望(self, update, context)，实际参数数量: {len(args)}")
            return None, None, None, []
        self, update, context = args[0], args[1], args[2]
        other_args = args[3:]
    else:
        # 普通函数: update, context, ...
        if len(args) < 2:
            logger.error(f"参数不足，期望(update, context)，实际参数数量: {len(args)}")
            return None, None, None, []
        self = None
        update, context = args[0], args[1]
        other_args = args[2:]

    # 验证 update 参数
    if not isinstance(update, Update):
        logger.error(f"update 参数无效")
        return None, None, None, []

    return self, update, context, other_args


def permission_check(admin_level="False"):
    """权限检查装饰器
    
    Args:
        admin_level: 
            "False" - 所有用户可用
            "group_admin" - 群组管理员和超级管理员可用
            "super_admin" - 仅超级管理员可用
    """

    def decorator(func):
        # 检查函数签名来确定是否是类方法
        sig = inspect.signature(func)
        params = list(sig.parameters.keys())
        is_method = len(params) >= 1 and params[0] == 'self'

        @functools.wraps(func)
        async def wrapper(*args, **kwargs):
            # 获取 update 和 context
            self, update, context, other_args = _get_update_context_args(
                args, is_method)
            if not update or not context:
                return None

            # 确保 update.effective_user 存在
            if not update.effective_user:
                logger.error(f"权限检查失败: update.effective_user 不存在")
                return None

            user_id = update.effective_user.id
            chat_id = update.effective_chat.id if update.effective_chat else None
            config_manager = context.bot_data.get("config_manager")

            # 检查权限
            if admin_level in ["group_admin", "super_admin"]:
                # 检查是否是超级管理员
                if config_manager.is_admin(user_id):
                    if is_method:
                        return await func(self, update, context, *other_args,
                                          **kwargs)
                    else:
                        return await func(update, context, *other_args,
                                          **kwargs)

                # 群组管理员检查
                if admin_level == "group_admin" and chat_id and update.effective_chat.type in [
                        "group", "supergroup"
                ]:
                    try:
                        chat_member = await context.bot.get_chat_member(
                            chat_id, user_id)
                        if chat_member.status in ["creator", "administrator"]:
                            if is_method:
                                return await func(self, update, context,
                                                  *other_args, **kwargs)
                            else:
                                return await func(update, context, *other_args,
                                                  **kwargs)
                    except Exception as e:
                        logger.error(f"检查群组权限时出错: {e}")

                # 权限不足，发送提示
                if update.effective_message:
                    await update.effective_message.reply_text(
                        "⚠️ 您没有执行此命令的权限。" if admin_level ==
                        "group_admin" else "⚠️ 此命令仅超级管理员可用。")
                return None

            # 基本用户权限，所有人都可以使用
            if is_method:
                return await func(self, update, context, *other_args, **kwargs)
            else:
                return await func(update, context, *other_args, **kwargs)

        return wrapper

    return decorator


def group_check(func):
    """群组检查装饰器，确保命令只在允许的群组中使用"""
    # 检查函数签名来确定是否是类方法
    sig = inspect.signature(func)
    params = list(sig.parameters.keys())
    is_method = len(params) >= 1 and params[0] == 'self'

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        # 获取 update 和 context
        self, update, context, other_args = _get_update_context_args(
            args, is_method)
        if not update or not context:
            return None

        chat = update.effective_chat
        if not chat:
            logger.error(f"群组检查失败: update.effective_chat 不存在")
            return None

        user = update.effective_user
        config_manager = context.bot_data.get("config_manager")

        # 私聊总是允许
        if chat.type == "private":
            if is_method:
                return await func(self, update, context, *other_args, **kwargs)
            else:
                return await func(update, context, *other_args, **kwargs)

        # 检查群组是否在白名单中
        if chat.type in ["group", "supergroup"
                         ] and not config_manager.is_allowed_group(chat.id):
            # 超级管理员可以使用特定命令
            is_super_admin = config_manager.is_admin(user.id)
            if is_super_admin:
                # 超级管理员专用命令列表
                super_admin_commands = [
                    "listgroups", "addgroup", "removegroup"
                ]

                # 获取当前命令
                command = None
                if update.message and update.message.text and update.message.text.startswith(
                        '/'):
                    command = update.message.text.split()[0][1:].split('@')[0]

                if command in super_admin_commands:
                    if is_method:
                        return await func(self, update, context, *other_args,
                                          **kwargs)
                    else:
                        return await func(update, context, *other_args,
                                          **kwargs)

            # 构建友好的提示信息
            from utils.formatter import TextFormatter  # 导入转义工具
            message = f"⚠️ 此群组未获授权使用 Bot。\n\n"
            message += f"群组 ID: `{chat.id}`\n"
            message += f"群组名称: {TextFormatter.escape_markdown(chat.title)}\n\n"

            # 如果是超级管理员，提供快速添加到白名单的提示
            if is_super_admin:
                message += f"您是超级管理员，可以使用以下命令授权此群组：\n"
                message += f"`/addgroup {chat.id}`"

                # 发送带有 Markdown 格式的消息
                await update.effective_message.reply_text(
                    message, parse_mode="MARKDOWN")
            else:
                await update.effective_message.reply_text(message)
            return None

        # 群组在白名单中，允许执行命令
        if is_method:
            return await func(self, update, context, *other_args, **kwargs)
        else:
            return await func(update, context, *other_args, **kwargs)

    return wrapper


def module_check(func):
    """模块检查装饰器，确保命令只在模块启用时使用"""
    # 检查函数签名来确定是否是类方法
    sig = inspect.signature(func)
    params = list(sig.parameters.keys())
    is_method = len(params) >= 1 and params[0] == 'self'

    @functools.wraps(func)
    async def wrapper(*args, **kwargs):
        # 获取 update 和 context
        self, update, context, other_args = _get_update_context_args(
            args, is_method)
        if not update or not context:
            return None

        if not update.effective_message or not update.effective_chat:
            logger.error(f"模块检查失败: update 缺少必要属性")
            return None

        chat_id = update.effective_chat.id
        config_manager = context.bot_data.get("config_manager")

        # 获取当前命令
        command = None
        if update.message and update.message.text and update.message.text.startswith(
                '/'):
            command = update.message.text.split()[0][1:].split('@')[0]
        else:
            # 如果不是命令，直接执行
            if is_method:
                return await func(self, update, context, *other_args, **kwargs)
            else:
                return await func(update, context, *other_args, **kwargs)

        # 核心命令不需要检查
        core_commands = [
            "start", "help", "id", "modules", "commands", "enable", "disable",
            "listgroups", "addgroup", "removegroup", "stats"
        ]
        if command in core_commands:
            if is_method:
                return await func(self, update, context, *other_args, **kwargs)
            else:
                return await func(update, context, *other_args, **kwargs)

        # 查找命令所属的模块
        module_of_command = None
        module_manager = context.bot_data.get("module_manager")

        for module_name, module_data in module_manager.loaded_modules.items():
            if hasattr(module_data["module"], "MODULE_COMMANDS"
                       ) and command in module_data["module"].MODULE_COMMANDS:
                module_of_command = module_name
                break

        # 如果找到了模块，检查它是否在当前聊天中启用
        if module_of_command and not config_manager.is_module_enabled_for_chat(
                module_of_command, chat_id):
            chat_type = update.effective_chat.type
            if chat_type in ["group", "supergroup"]:
                await update.effective_message.reply_text(
                    f"模块 {module_of_command} 未在当前群组启用。")
            else:
                await update.effective_message.reply_text(
                    f"模块 {module_of_command} 未启用。")
            return None

        # 模块已启用，允许执行命令
        if is_method:
            return await func(self, update, context, *other_args, **kwargs)
        else:
            return await func(update, context, *other_args, **kwargs)

    return wrapper
