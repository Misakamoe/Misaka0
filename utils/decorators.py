# utils/decorators.py
import functools
import logging
import traceback
from telegram import Update
from telegram.ext import ContextTypes

logger = logging.getLogger("Decorators")


def error_handler(func):
    """错误处理装饰器，统一处理命令和回调中的异常"""

    @functools.wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE,
                      *args, **kwargs):
        try:
            return await func(update, context, *args, **kwargs)
        except Exception as e:
            # 记录详细错误信息
            logger.error(f"处理 {func.__name__} 时出错: {e}")
            logger.debug(traceback.format_exc())

            # 向用户发送友好的错误消息
            if update and update.effective_message:
                await update.effective_message.reply_text(
                    f"😔 处理您的请求时出现错误，请稍后再试。")
            return None

    return wrapper


def permission_check(permission_level="user"):
    """权限检查装饰器
    
    参数:
        permission_level: 
            "user" - 所有用户可用
            "group_admin" - 群组管理员和超级管理员可用
            "super_admin" - 仅超级管理员可用
    """

    def decorator(func):

        @functools.wraps(func)
        async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE,
                          *args, **kwargs):
            if not update or not update.effective_user:
                return None

            user_id = update.effective_user.id
            chat_id = update.effective_chat.id if update.effective_chat else None
            config_manager = context.bot_data.get("config_manager")

            # 检查是否是超级管理员
            is_super_admin = config_manager.is_admin(user_id)

            # 检查群组权限
            if permission_level in ["group_admin", "super_admin"]:
                # 超级管理员通过所有权限检查
                if is_super_admin:
                    return await func(update, context, *args, **kwargs)

                # 群组管理员检查
                if permission_level == "group_admin" and chat_id and update.effective_chat.type in [
                        "group", "supergroup"
                ]:
                    try:
                        chat_member = await context.bot.get_chat_member(
                            chat_id, user_id)
                        is_group_admin = chat_member.status in [
                            "creator", "administrator"
                        ]
                        if is_group_admin:
                            return await func(update, context, *args, **kwargs)
                    except Exception as e:
                        logger.error(
                            f"检查用户 {user_id} 在群组 {chat_id} 的权限失败: {e}")

                # 权限不足
                await update.effective_message.reply_text(
                    "⚠️ 您没有执行此命令的权限。" if permission_level ==
                    "group_admin" else "⚠️ 此命令仅超级管理员可用。")
                return None

            # 基本用户权限，所有人都可以使用
            return await func(update, context, *args, **kwargs)

        return wrapper

    return decorator


def group_check(func):
    """群组检查装饰器，确保命令只在允许的群组中使用"""

    @functools.wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE,
                      *args, **kwargs):
        if not update.effective_chat:
            return None

        chat = update.effective_chat
        user = update.effective_user
        config_manager = context.bot_data.get("config_manager")

        # 私聊总是允许
        if chat.type == "private":
            return await func(update, context, *args, **kwargs)

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
                    return await func(update, context, *args, **kwargs)

            # 构建友好的提示信息
            message = f"⚠️ 此群组未获授权使用 Bot。\n\n"
            message += f"群组 ID: `{chat.id}`\n"
            message += f"群组名称: {chat.title}\n\n"

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
        return await func(update, context, *args, **kwargs)

    return wrapper


def module_check(func):
    """模块检查装饰器，确保命令只在模块启用时使用"""

    @functools.wraps(func)
    async def wrapper(update: Update, context: ContextTypes.DEFAULT_TYPE,
                      *args, **kwargs):
        if not update.effective_message or not update.effective_chat:
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
            return await func(update, context, *args, **kwargs)

        # 核心命令不需要检查
        core_commands = [
            "start", "help", "id", "modules", "commands", "enable", "disable",
            "reload_config", "listgroups", "addgroup", "removegroup"
        ]
        if command in core_commands:
            return await func(update, context, *args, **kwargs)

        # 查找命令所属的模块
        module_of_command = None
        bot_engine = context.bot_data.get("bot_engine")
        for module_name, module_data in bot_engine.module_loader.loaded_modules.items(
        ):
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
        return await func(update, context, *args, **kwargs)

    return wrapper
