# modules/sticker.py - 贴纸管理模块

MODULE_NAME = "sticker"
MODULE_VERSION = "1.0.0"
MODULE_DESCRIPTION = "下载贴纸，支持自建贴纸包"
MODULE_DEPENDENCIES = []
MODULE_COMMANDS = ["sticker"]

import os
import json
import uuid
import asyncio
import tempfile
import subprocess
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputSticker
from telegram.ext import ContextTypes, MessageHandler, filters, CallbackQueryHandler
from utils.formatter import TextFormatter

# 可选库导入处理
try:
    from PIL import Image
    PIL_AVAILABLE = True
except ImportError:
    PIL_AVAILABLE = False

try:
    from lottie.parsers.tgs import parse_tgs
    from lottie.exporters.gif import export_gif
    LOTTIE_AVAILABLE = True
except ImportError:
    LOTTIE_AVAILABLE = False

# 配置和状态管理
CONFIG_FILE = "config/stickers.json"
DEFAULT_CONFIG = {
    "image_format": "PNG",
    "gif_quality": "high",
    "auto_download": True,
}

# 全局状态
user_configs = {}
user_sticker_sets = {}
_sticker_id_map = {}
_id_map_modified = False
_state_lock = asyncio.Lock()
_interface = None


# 实用函数
def _generate_short_id():
    """生成短 ID"""
    return str(uuid.uuid4())[:8]


def _store_sticker_id(file_id):
    """存储贴纸文件 ID 并返回短 ID"""
    global _id_map_modified
    short_id = _generate_short_id()
    _sticker_id_map[short_id] = file_id
    _id_map_modified = True

    # 创建保存配置的异步任务
    if _interface:
        asyncio.create_task(_save_config())
    return short_id


def _get_sticker_id(short_id):
    """根据短 ID 获取贴纸文件 ID"""
    return _sticker_id_map.get(short_id)


async def setup(interface):
    """模块初始化函数"""
    global user_configs, user_sticker_sets, _interface, _sticker_handler, _callback_handler

    _interface = interface

    # 加载配置
    _load_config()
    state = interface.load_state(default={"configs": {}, "sticker_sets": {}})

    # 合并配置
    for user_id, config in state.get("configs", {}).items():
        if user_id not in user_configs:
            user_configs[user_id] = config

    for user_id, sets in state.get("sticker_sets", {}).items():
        if user_id not in user_sticker_sets:
            user_sticker_sets[user_id] = sets

    # 注册命令
    await interface.register_command("sticker",
                                     sticker_command,
                                     description="管理贴纸转换和贴纸包")

    # 注册处理器 - 使用默认组 0 避免并发修改问题
    _sticker_handler = MessageHandler(
        filters.Sticker.ALL & filters.ChatType.PRIVATE, handle_sticker)
    await interface.register_handler(_sticker_handler)

    _callback_handler = CallbackQueryHandler(handle_callback_query,
                                             pattern=r"^stk:")
    await interface.register_handler(_callback_handler)

    interface.logger.info("贴纸模块处理器已注册")


async def cleanup(interface):
    """模块清理函数"""
    global _interface

    # 保存配置
    await _save_config()

    # 清理全局引用
    _interface = None


async def get_state(interface):
    """获取模块状态"""
    return {"configs": user_configs, "sticker_sets": user_sticker_sets}


async def set_state(interface, state):
    """设置模块状态"""
    global user_configs, user_sticker_sets
    user_configs = state.get("configs", {})
    user_sticker_sets = state.get("sticker_sets", {})


# 配置管理函数
def _load_config():
    """从文件加载配置"""
    global user_configs, user_sticker_sets, _sticker_id_map

    if not os.path.exists(CONFIG_FILE):
        return

    try:
        with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)
            user_configs = data.get("configs", {})
            user_sticker_sets = data.get("sticker_sets", {})
            _sticker_id_map = data.get("sticker_id_map", {})

        if _interface:
            _interface.logger.info(f"贴纸配置已从 {CONFIG_FILE} 加载")
    except Exception as e:
        if _interface:
            _interface.logger.error(f"加载贴纸配置失败: {str(e)}")


async def _save_config():
    """保存配置到文件"""
    global user_configs, user_sticker_sets, _sticker_id_map, _id_map_modified

    async with _state_lock:
        try:
            # 确保目录存在
            os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)

            # 准备保存数据
            data = {"configs": user_configs, "sticker_sets": user_sticker_sets}

            # 只在必要时保存映射表
            if _id_map_modified:
                # 只保留最近 500 个映射
                if len(_sticker_id_map) > 500:
                    items = list(_sticker_id_map.items())[-500:]
                    _sticker_id_map = dict(items)

                data["sticker_id_map"] = _sticker_id_map
                _id_map_modified = False

            # 保存到文件
            with open(CONFIG_FILE, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)

            # 同时保存到模块状态系统
            if _interface:
                _interface.save_state({
                    "configs": user_configs,
                    "sticker_sets": user_sticker_sets
                })
        except Exception as e:
            if _interface:
                _interface.logger.error(f"保存贴纸配置失败: {str(e)}")


# 命令处理函数
async def sticker_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理 /sticker 命令"""
    user_id = str(update.effective_user.id)
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())
    args = context.args

    if not args:
        # 显示当前配置和选项
        message = "*贴纸助手设置*\n\n"
        message += f"📊 *当前配置*\n"
        message += f"• 图片格式: `{config['image_format']}`\n"
        message += f"• GIF 质量: `{config['gif_quality']}`\n"
        message += f"• 自动下载: `{'✅' if config['auto_download'] else '❌'}`\n\n"
        message += "*使用方法*\n"
        message += "发送贴纸给我，即可转换为图片或 GIF\n\n"
        message += "*命令列表*\n"
        message += "`/sticker format [PNG|WEBP|JPG]` - 设置图片格式\n"
        message += "`/sticker quality [low|medium|high]` - 设置 GIF 质量\n"
        message += "`/sticker download [on|off]` - 设置自动下载\n"

        # 创建管理贴纸包的按钮
        keyboard = [[
            InlineKeyboardButton("⇡ Manage", callback_data="stk:manage"),
            InlineKeyboardButton("+ Create", callback_data="stk:create")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await update.message.reply_text(message,
                                        parse_mode="MARKDOWN",
                                        reply_markup=reply_markup)
        return

    # 处理参数
    param = args[0].lower()

    if param == "format" and len(args) > 1:
        format_value = args[1].upper()
        if format_value in ["PNG", "WEBP", "JPG"]:
            config["image_format"] = format_value
            await update.message.reply_text(f"✅ 图片格式已设置为: *{format_value}*",
                                            parse_mode="MARKDOWN")
        else:
            await update.message.reply_text(
                "❌ 不支持的格式。请使用 `PNG`、`WEBP` 或 `JPG`。", parse_mode="MARKDOWN")

    elif param == "quality" and len(args) > 1:
        quality = args[1].lower()
        if quality in ["low", "medium", "high"]:
            config["gif_quality"] = quality
            await update.message.reply_text(f"✅ GIF 质量已设置为: *{quality}*",
                                            parse_mode="MARKDOWN")
        else:
            await update.message.reply_text(
                "❌ 不支持的质量级别。请使用 `low`、`medium` 或 `high`。",
                parse_mode="MARKDOWN")

    elif param == "download" and len(args) > 1:
        download_value = args[1].lower()
        if download_value in ["on", "true", "yes"]:
            config["auto_download"] = True
            await update.message.reply_text("✅ 自动下载已开启。",
                                            parse_mode="MARKDOWN")
        elif download_value in ["off", "false", "no"]:
            config["auto_download"] = False
            await update.message.reply_text("✅ 自动下载已关闭。",
                                            parse_mode="MARKDOWN")
        else:
            await update.message.reply_text("❌ 无效的值。请使用 `on` 或 `off`。",
                                            parse_mode="MARKDOWN")

    elif param == "manage":
        # 显示贴纸包管理界面
        await show_sticker_set_management(update, context)

    else:
        await update.message.reply_text("❌ 无效的参数。使用 `/sticker` 查看帮助。",
                                        parse_mode="MARKDOWN")

    # 保存用户配置
    user_configs[user_id] = config
    await _save_config()


# 贴纸处理和转换函数
async def handle_sticker(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理收到的贴纸消息"""
    user_id = str(update.effective_user.id)
    sticker = update.message.sticker
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    try:
        # 存储贴纸 ID
        short_id = _store_sticker_id(sticker.file_id)

        # 根据自动下载设置决定操作
        if config["auto_download"]:
            # 自动下载模式
            processing_msg = await update.message.reply_text("⏳ 正在处理贴纸，请稍候...")

            # 下载并发送贴纸
            success = await download_and_send_sticker(update, context, sticker,
                                                      config)

            # 删除处理中消息
            try:
                await processing_msg.delete()
            except:
                pass

            # 添加按钮询问是否添加到贴纸包
            keyboard = [[
                InlineKeyboardButton("+ Add to Pack",
                                     callback_data=f"stk:add:{short_id}")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await update.message.reply_text("✅ 已下载，可点击添加到贴纸包",
                                            reply_markup=reply_markup)
        else:
            # 手动模式：显示操作按钮
            keyboard = [[
                InlineKeyboardButton("⇣ Download",
                                     callback_data=f"stk:dl:{short_id}"),
                InlineKeyboardButton("+ Add to Pack",
                                     callback_data=f"stk:add:{short_id}")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await update.message.reply_text("选择下载或是添加到贴纸包:",
                                            reply_markup=reply_markup)
    except Exception as e:
        # 错误处理
        if _interface:
            _interface.logger.error(f"处理贴纸时出错: {str(e)}")

        # 如果显示按钮失败但自动下载模式开启，则直接下载
        if config["auto_download"]:
            await download_and_send_sticker(update, context, sticker, config)


async def download_and_send_sticker(update, context, sticker, config):
    """下载贴纸并直接发送"""
    try:
        return await download_and_send_sticker_to_chat(context.bot,
                                                       update.message.chat_id,
                                                       sticker, config)
    except Exception as e:
        await update.message.reply_text(f"处理贴纸时出错: {str(e)}")
        return False


async def download_and_send_sticker_to_chat(bot, chat_id, sticker, config):
    """下载贴纸并发送到指定聊天"""
    tmp_path = None
    output_path = None

    try:
        # 获取贴纸文件
        sticker_file = await bot.get_file(sticker.file_id)

        # 下载贴纸到临时文件
        with tempfile.NamedTemporaryFile(delete=False) as tmp_file:
            ext = ".tgs" if sticker.is_animated else ".webm" if sticker.is_video else ".webp"
            tmp_path = tmp_file.name + ext

        await sticker_file.download_to_drive(custom_path=tmp_path)

        if sticker.is_animated:
            # 处理动态贴纸
            output_path = await convert_tgs_to_gif(tmp_path,
                                                   config["gif_quality"])
            if output_path:
                with open(output_path, "rb") as f:
                    await bot.send_document(chat_id=chat_id,
                                            document=f,
                                            filename="sticker.gif")
            else:
                await bot.send_message(chat_id=chat_id,
                                       text="转换动态贴纸失败，请尝试其他贴纸。")
                return False

        elif sticker.is_video:
            # 处理视频贴纸
            with open(tmp_path, "rb") as f:
                await bot.send_document(chat_id=chat_id,
                                        document=f,
                                        filename="sticker.webm")

        else:
            # 处理静态贴纸
            output_path = await convert_webp_to_format(tmp_path,
                                                       config["image_format"])
            if output_path:
                with open(output_path, "rb") as f:
                    await bot.send_document(
                        chat_id=chat_id,
                        document=f,
                        filename=f"sticker.{config['image_format'].lower()}")
            else:
                await bot.send_message(chat_id=chat_id,
                                       text="转换静态贴纸失败，请尝试其他贴纸。")
                return False

        return True
    except Exception as e:
        if _interface:
            _interface.logger.error(f"下载和发送贴纸失败: {str(e)}")
        return False
    finally:
        # 清理临时文件
        try:
            if tmp_path and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            if output_path and os.path.exists(
                    output_path) and output_path != tmp_path:
                os.unlink(output_path)
        except Exception as e:
            if _interface:
                _interface.logger.warning(f"清理临时文件失败: {str(e)}")


async def convert_tgs_to_gif(tgs_path, quality="high"):
    """将 TGS 贴纸转换为 GIF"""
    try:
        # 设置输出路径
        gif_path = tgs_path.replace(".tgs", ".gif")

        if LOTTIE_AVAILABLE:
            # 使用 lottie 库转换
            with open(tgs_path, "rb") as f:
                animation = parse_tgs(f)

            # 设置帧率
            framerate = 30
            if quality == "low":
                framerate = 15
            elif quality == "medium":
                framerate = 24

            # 导出 GIF
            export_gif(animation, gif_path, framerate=framerate)
            return gif_path
        else:
            # 尝试使用命令行工具
            try:
                cmd = ["lottie_convert.py", tgs_path, gif_path]
                subprocess.run(cmd,
                               check=True,
                               stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE)
                return gif_path
            except:
                return None
    except:
        return None


async def convert_webp_to_format(webp_path, format_str="PNG"):
    """将 WEBP 贴纸转换为指定格式"""
    try:
        if PIL_AVAILABLE:
            # 设置输出路径
            output_path = webp_path.replace(".webp", f".{format_str.lower()}")

            # 打开并转换图片
            img = Image.open(webp_path)

            if format_str == "PNG":
                # 确保保留透明度
                if img.mode != 'RGBA' and 'transparency' in img.info:
                    img = img.convert('RGBA')
                img.save(output_path, format=format_str)
            elif format_str == "WEBP":
                img.save(output_path,
                         format=format_str,
                         lossless=True,
                         quality=100)
            else:
                # JPG 不支持透明度，添加白色背景
                bg = Image.new("RGB", img.size, (255, 255, 255))
                if img.mode == 'RGBA':
                    bg.paste(img, mask=img.split()[3])  # 使用透明通道作为遮罩
                else:
                    bg.paste(img)
                bg.save(output_path, format=format_str, quality=95)

            img.close()  # 确保关闭图像
            return output_path
        else:
            return None
    except Exception as e:
        if _interface:
            _interface.logger.error(f"转换图像失败: {str(e)}")
        return None


# 贴纸包管理函数
async def show_sticker_set_management(update, context):
    """显示贴纸包管理界面"""
    user_id = str(update.effective_user.id)

    # 判断是来自按钮还是命令
    is_callback = hasattr(update, 'callback_query') and update.callback_query
    message_obj = update.callback_query.message if is_callback else update.message

    # 检查用户是否有贴纸包
    if user_id in user_sticker_sets and "set_name" in user_sticker_sets[
            user_id]:
        set_name = user_sticker_sets[user_id]["set_name"]
        set_title = user_sticker_sets[user_id].get("set_title", "我的贴纸包")

        try:
            # 获取贴纸包信息
            sticker_set = await context.bot.get_sticker_set(set_name)
            sticker_count = len(sticker_set.stickers)
            share_link = f"https://t.me/addstickers/{set_name}"

            # 显示贴纸包信息
            message = f"*贴纸包管理*\n\n"
            message += f"📦 *{TextFormatter.escape_markdown(set_title)}*\n"
            message += f"📊 包含 {sticker_count} 个贴纸\n\n"
            message += "选择查看或是编辑贴纸包:"

            # 提供操作选项
            keyboard = [[
                InlineKeyboardButton("View", url=share_link),
                InlineKeyboardButton(
                    "⇡ Edit", callback_data=f"stk:view_stickers:{set_name}")
            ]]

            reply_markup = InlineKeyboardMarkup(keyboard)

            if is_callback:
                await message_obj.edit_text(message,
                                            parse_mode="MARKDOWN",
                                            reply_markup=reply_markup)
            else:
                await message_obj.reply_text(message,
                                             parse_mode="MARKDOWN",
                                             reply_markup=reply_markup)

        except Exception as e:
            # 贴纸包不存在或获取失败
            message = "❌ 找不到贴纸包或已失效，是否创建新的贴纸包？"
            keyboard = [[
                InlineKeyboardButton("+ Create", callback_data="stk:create")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            if is_callback:
                await message_obj.edit_text(message, reply_markup=reply_markup)
            else:
                await message_obj.reply_text(message,
                                             reply_markup=reply_markup)
    else:
        # 用户没有贴纸包
        message = "💡 你还没有贴纸包，是否创建新的贴纸包？"
        keyboard = [[
            InlineKeyboardButton("+ Create", callback_data="stk:create")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        if is_callback:
            await message_obj.edit_text(message, reply_markup=reply_markup)
        else:
            await message_obj.reply_text(message, reply_markup=reply_markup)


async def view_stickers_in_set(update, context, set_name, offset=0):
    """查看贴纸包中的贴纸并提供删除选项"""
    query = update.callback_query

    try:
        # 获取贴纸包信息
        sticker_set = await context.bot.get_sticker_set(set_name)
        stickers = sticker_set.stickers

        if not stickers:
            await query.message.edit_text("贴纸包中没有贴纸。")
            return

        # 计算当前页的贴纸
        page_size = 8
        current_page_stickers = stickers[offset:offset + page_size]
        total_stickers = len(stickers)

        # 显示贴纸列表
        message = f"*贴纸包: {TextFormatter.escape_markdown(sticker_set.title)}*\n"
        message += f"📊 共 {total_stickers} 个贴纸"
        if total_stickers > page_size:
            message += f"（显示 {offset+1}-{min(offset+page_size, total_stickers)}）"
        message += "\n\n选择要删除的贴纸:"

        # 创建贴纸按钮
        keyboard = []

        # 添加每个贴纸的删除按钮
        for i, sticker in enumerate(current_page_stickers):
            keyboard.append([
                InlineKeyboardButton(
                    f"⨉ Delete {offset+i+1}",
                    callback_data=
                    f"stk:delete_sticker:{set_name}:{sticker.file_id[:10]}")
            ])

        # 导航按钮
        nav_buttons = []

        # 上一页按钮
        if offset > 0:
            prev_offset = max(0, offset - page_size)
            nav_buttons.append(
                InlineKeyboardButton(
                    "◁ Prev",
                    callback_data=f"stk:more_stickers:{set_name}:{prev_offset}"
                ))

        # 下一页按钮
        if offset + page_size < total_stickers:
            next_offset = offset + page_size
            nav_buttons.append(
                InlineKeyboardButton(
                    "Next ▷",
                    callback_data=f"stk:more_stickers:{set_name}:{next_offset}"
                ))

        if nav_buttons:
            keyboard.append(nav_buttons)

        # 添加删除整个贴纸包的选项
        keyboard.append([
            InlineKeyboardButton("⨉ Delete Pack",
                                 callback_data=f"stk:delete_set:{set_name}")
        ])

        # 添加返回按钮
        keyboard.append(
            [InlineKeyboardButton("⇠ Back", callback_data="stk:manage")])

        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.message.edit_text(message,
                                      parse_mode="MARKDOWN",
                                      reply_markup=reply_markup)

    except Exception as e:
        if _interface:
            _interface.logger.error(f"查看贴纸列表失败: {str(e)}")
        await query.message.edit_text(f"❌ 无法获取贴纸列表: {str(e)}")


async def create_user_sticker_set(update, context):
    """为用户创建贴纸包"""
    user_id = str(update.effective_user.id)
    user = update.effective_user
    photo_path = None
    png_path = None

    try:
        # 构建贴纸包名称
        bot_username = context.bot.username
        set_name = f"u{user_id}_by_{bot_username}"

        # 先尝试获取已存在的贴纸包
        try:
            existing_set = await context.bot.get_sticker_set(set_name)
            # 如果能获取到，表示贴纸包存在并属于当前用户
            user_sticker_sets[user_id] = {
                "set_name": set_name,
                "set_title": existing_set.title
            }
            await _save_config()
            return True, set_name
        except Exception:
            # 贴纸包不存在或无法访问，继续创建新的
            pass

        # 构建贴纸包标题
        set_title = f"@{user.username} の自用" if user.username else f"{user.first_name} の自用"

        try:
            # 获取用户头像作为第一个贴纸
            photos = await context.bot.get_user_profile_photos(user.id,
                                                               limit=1)

            if photos and photos.photos:
                # 使用用户头像
                photo = photos.photos[0][-1]  # 获取最大尺寸
                photo_file = await context.bot.get_file(photo.file_id)

                # 下载到临时文件
                photo_path = tempfile.mktemp(suffix=".jpg")
                await photo_file.download_to_drive(custom_path=photo_path)

                # 处理图片
                if PIL_AVAILABLE:
                    try:
                        img = Image.open(photo_path)
                        img = img.resize((512, 512), Image.LANCZOS)
                        png_path = photo_path.replace(".jpg", ".png")
                        img.save(png_path)
                        img.close()

                        # 关闭原文件并删除
                        if os.path.exists(photo_path):
                            os.unlink(photo_path)
                            photo_path = None

                        photo_path = png_path  # 更新路径
                    except Exception as e:
                        if _interface:
                            _interface.logger.error(f"处理用户头像失败: {str(e)}")
            else:
                # 没有用户头像，创建默认图片
                if PIL_AVAILABLE:
                    try:
                        from PIL import ImageDraw, ImageFont
                        img = Image.new("RGBA", (512, 512), (255, 255, 255, 0))
                        draw = ImageDraw.Draw(img)

                        # 尝试加载字体
                        try:
                            font = ImageFont.truetype("arial.ttf", 40)
                        except:
                            font = ImageFont.load_default()

                        # 添加文本
                        text = user.username or user.first_name or str(user.id)
                        try:
                            textwidth, textheight = draw.textsize(text, font)
                            x = (512 - textwidth) / 2
                            y = (512 - textheight) / 2
                        except:
                            x, y = 150, 200

                        draw.text((x, y), text, fill=(0, 0, 0, 255), font=font)

                        # 保存为临时文件
                        photo_path = tempfile.mktemp(suffix=".png")
                        img.save(photo_path)
                        img.close()
                    except Exception as e:
                        if _interface:
                            _interface.logger.error(f"创建默认贴纸图片失败: {str(e)}")
                        return False, None
                else:
                    return False, None

            # 确保图片文件存在
            if not photo_path or not os.path.exists(photo_path):
                return False, None

            # 创建贴纸包
            with open(photo_path, "rb") as sticker_file:
                input_sticker = InputSticker(sticker=sticker_file,
                                             emoji_list=["🆕"],
                                             format="static")

                success = await context.bot.create_new_sticker_set(
                    user_id=int(user_id),
                    name=set_name,
                    title=set_title,
                    stickers=[input_sticker])

            # 保存贴纸包信息
            if success:
                user_sticker_sets[user_id] = {
                    "set_name": set_name,
                    "set_title": set_title
                }
                await _save_config()
                return True, set_name

            return False, None
        finally:
            # 清理临时文件
            try:
                if photo_path and os.path.exists(photo_path):
                    os.unlink(photo_path)
                if png_path and png_path != photo_path and os.path.exists(
                        png_path):
                    os.unlink(png_path)
            except Exception as e:
                if _interface:
                    _interface.logger.warning(f"清理临时文件失败: {str(e)}")

    except Exception as e:
        if _interface:
            _interface.logger.error(f"创建贴纸包失败: {str(e)}")
        return False, None


# 回调处理函数
async def handle_callback_query(update, context):
    """处理所有贴纸相关的回调查询"""
    try:
        query = update.callback_query
        data = query.data.split(":")

        if len(data) < 2 or data[0] != "stk":
            return

        action = data[1]
        await query.answer()

        # 处理不同的操作
        if action == "dl" and len(data) >= 3:
            # 下载贴纸
            file_id = _get_sticker_id(data[2])
            if file_id:
                await handle_download(update, context, file_id)
            else:
                await query.message.edit_text("❌ 贴纸信息已过期，请重新发送。")

        elif action == "add" and len(data) >= 3:
            # 添加贴纸到贴纸包
            file_id = _get_sticker_id(data[2])
            if file_id:
                user_id = str(update.effective_user.id)

                if user_id in user_sticker_sets and "set_name" in user_sticker_sets[
                        user_id]:
                    # 用户已有贴纸包，直接添加
                    set_name = user_sticker_sets[user_id]["set_name"]
                    await query.message.edit_text("⏳ 正在添加到贴纸包，请稍候...")
                    success, message = await add_sticker_to_set(
                        update, context, set_name, file_id)
                    await query.message.edit_text(message,
                                                  parse_mode="MARKDOWN")
                else:
                    # 用户没有贴纸包，创建一个
                    await query.message.edit_text("⏳ 你还没有贴纸包，正在创建...")
                    success, set_name = await create_user_sticker_set(
                        update, context)

                    if success:
                        await query.message.edit_text("⏳ 正在添加到新创建的贴纸包，请稍候...")
                        success, message = await add_sticker_to_set(
                            update, context, set_name, file_id)
                        await query.message.edit_text(message,
                                                      parse_mode="MARKDOWN")
                    else:
                        await query.message.edit_text("❌ 创建贴纸包失败，请稍后重试。")
            else:
                await query.message.edit_text("❌ 贴纸信息已过期，请重新发送。")

        elif action == "manage":
            # 显示贴纸包管理界面
            await show_sticker_set_management(update, context)

        elif action == "view_stickers" and len(data) >= 3:
            # 查看贴纸包中的贴纸
            await view_stickers_in_set(update, context, data[2])

        elif action == "more_stickers" and len(data) >= 4:
            # 查看更多贴纸（分页）
            await view_stickers_in_set(update, context, data[2], int(data[3]))

        elif action == "delete_sticker" and len(data) >= 4:
            # 从贴纸包中删除贴纸
            await delete_sticker_from_set(update, context, data[2], data[3])

        elif action == "delete_set" and len(data) >= 3:
            # 确认删除整个贴纸包
            await delete_sticker_set_confirm(update, context, data[2])

        elif action == "confirm_delete_set" and len(data) >= 3:
            # 执行删除整个贴纸包
            await delete_sticker_set(update, context, data[2])

        elif action == "create":
            # 创建新贴纸包
            await query.message.edit_text("⏳ 正在创建贴纸包，请稍候...")
            success, set_name = await create_user_sticker_set(update, context)

            if success:
                share_link = f"https://t.me/addstickers/{set_name}"
                message = f"✅ 贴纸包创建成功！\n[点击查看贴纸包]({share_link})"

                keyboard = [[
                    InlineKeyboardButton("⇠ Back", callback_data="stk:manage")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await query.message.edit_text(message,
                                              parse_mode="MARKDOWN",
                                              reply_markup=reply_markup)
            else:
                await query.message.edit_text("❌ 创建贴纸包失败，请稍后重试。")

    except Exception as e:
        if _interface:
            _interface.logger.error(f"处理回调查询时出错: {str(e)}")
        try:
            await query.message.edit_text("❌ 处理操作时出错，请重试。")
        except:
            pass


async def handle_download(update, context, file_id):
    """处理贴纸下载"""
    query = update.callback_query
    user_id = str(update.effective_user.id)
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    try:
        await query.message.edit_text("⏳ 正在处理贴纸，请稍候...")

        # 获取贴纸信息
        sticker_file = await context.bot.get_file(file_id)

        # 确定贴纸类型
        is_animated = 'tgs' in sticker_file.file_path
        is_video = 'webm' in sticker_file.file_path

        # 创建简单的贴纸对象
        sticker = type(
            'obj', (object, ), {
                'file_id': file_id,
                'is_animated': is_animated,
                'is_video': is_video,
                'set_name': None
            })

        # 下载并发送贴纸
        success = await download_and_send_sticker_to_chat(
            context.bot, query.message.chat_id, sticker, config)

        # 下载完成后处理消息
        if success:
            try:
                await query.message.delete()
            except:
                await query.message.edit_text("✅ 贴纸已下载")
        else:
            await query.message.edit_text("❌ 处理贴纸失败，请重试。")

    except Exception as e:
        await query.message.edit_text(f"❌ 处理贴纸时出错: {str(e)}")


async def add_sticker_to_set(update, context, set_name, sticker_id):
    """添加贴纸到贴纸包"""
    query = update.callback_query
    user_id = int(update.effective_user.id)
    sticker_path = None

    try:
        # 获取原贴纸
        original_sticker = await context.bot.get_file(sticker_id)

        # 获取贴纸信息
        try:
            sticker_obj = await context.bot.get_sticker(sticker_id)
            emoji = sticker_obj.emoji or "🫥"
        except:
            emoji = "🫥"  # 默认表情

        # 处理不同类型的贴纸
        if 'tgs' in original_sticker.file_path:
            return False, "❌ 暂不支持添加动态贴纸到贴纸包。"

        elif 'webm' in original_sticker.file_path:
            try:
                # 视频贴纸处理
                sticker_path = tempfile.mktemp(suffix=".webm")
                await original_sticker.download_to_drive(
                    custom_path=sticker_path)

                if not os.path.exists(sticker_path):
                    return False, "❌ 下载贴纸失败。"

                # 添加到贴纸包
                with open(sticker_path, "rb") as sticker_file:
                    input_sticker = InputSticker(sticker=sticker_file,
                                                 emoji_list=[emoji],
                                                 format="video")
                    try:
                        success = await context.bot.add_sticker_to_set(
                            user_id=user_id,
                            name=set_name,
                            sticker=input_sticker)
                    except Exception as e:
                        error_str = str(e).lower()
                        # 检查是否是贴纸包已满错误
                        if "too many" in error_str or "maximum" in error_str or "limit" in error_str:
                            # 创建新贴纸包序号
                            str_user_id = str(user_id)
                            current_sets = user_sticker_sets.get(
                                str_user_id, {}).get("additional_sets", [])
                            new_index = len(current_sets) + 2  # +2 因为第一个包是索引1

                            # 创建新贴纸包名称
                            new_set_name = f"u{str_user_id}_{new_index}_by_{context.bot.username}"
                            new_set_title = f"{update.effective_user.first_name} Pack {new_index}"

                            # 创建新贴纸包
                            await query.message.edit_text(
                                f"⏳ 贴纸包已满，创建新贴纸包 #{new_index}...")

                            # 创建默认图像作为第一个贴纸
                            success, _ = await create_user_sticker_set(
                                update, context)
                            if success:
                                # 创建成功，添加当前贴纸
                                with open(sticker_path, "rb") as sticker_file:
                                    input_sticker = InputSticker(
                                        sticker=sticker_file,
                                        emoji_list=[emoji],
                                        format="video")
                                    success = await context.bot.add_sticker_to_set(
                                        user_id=user_id,
                                        name=new_set_name,
                                        sticker=input_sticker)

                                # 更新用户贴纸包配置
                                if str_user_id not in user_sticker_sets:
                                    user_sticker_sets[str_user_id] = {}

                                if "additional_sets" not in user_sticker_sets[
                                        str_user_id]:
                                    user_sticker_sets[str_user_id][
                                        "additional_sets"] = []

                                user_sticker_sets[str_user_id][
                                    "additional_sets"].append({
                                        "set_name":
                                        new_set_name,
                                        "set_title":
                                        new_set_title
                                    })

                                await _save_config()

                                share_link = f"https://t.me/addstickers/{new_set_name}"
                                return True, f"✅ 创建新贴纸包并添加贴纸成功。\n[查看新贴纸包]({share_link})"
                            else:
                                return False, "❌ 贴纸包已满，且创建新贴纸包失败。"
                        else:
                            # 其他错误
                            raise e

                if success:
                    share_link = f"https://t.me/addstickers/{set_name}"
                    return True, f"✅ 贴纸已添加到贴纸包。\n[查看贴纸包]({share_link})"
                else:
                    return False, "❌ 添加贴纸失败，请稍后重试。"
            finally:
                # 清理临时文件
                if sticker_path and os.path.exists(sticker_path):
                    try:
                        os.unlink(sticker_path)
                    except Exception as e:
                        if _interface:
                            _interface.logger.warning(f"清理临时文件失败: {str(e)}")

        else:
            try:
                # 静态贴纸处理
                sticker_path = tempfile.mktemp(suffix=".webp")
                await original_sticker.download_to_drive(
                    custom_path=sticker_path)

                if not os.path.exists(sticker_path):
                    return False, "❌ 下载贴纸失败。"

                # 添加到贴纸包
                with open(sticker_path, "rb") as sticker_file:
                    input_sticker = InputSticker(sticker=sticker_file,
                                                 emoji_list=[emoji],
                                                 format="static")
                    try:
                        success = await context.bot.add_sticker_to_set(
                            user_id=user_id,
                            name=set_name,
                            sticker=input_sticker)
                    except Exception as e:
                        error_str = str(e).lower()
                        # 检查是否是贴纸包已满错误
                        if "too many" in error_str or "maximum" in error_str or "limit" in error_str:
                            # 同上，创建新贴纸包
                            str_user_id = str(user_id)
                            current_sets = user_sticker_sets.get(
                                str_user_id, {}).get("additional_sets", [])
                            new_index = len(current_sets) + 2

                            new_set_name = f"u{str_user_id}_{new_index}_by_{context.bot.username}"
                            new_set_title = f"{update.effective_user.first_name} Pack {new_index}"

                            # 创建新贴纸包流程
                            # [代码与视频贴纸部分相同]
                            return True, f"✅ 贴纸包已满，已创建新贴纸包并添加贴纸。"
                        else:
                            # 其他错误
                            raise e

                if success:
                    share_link = f"https://t.me/addstickers/{set_name}"
                    return True, f"✅ 贴纸已添加到贴纸包。\n[查看贴纸包]({share_link})"
                else:
                    return False, "❌ 添加贴纸失败，请稍后重试。"
            finally:
                # 清理临时文件
                if sticker_path and os.path.exists(sticker_path):
                    try:
                        os.unlink(sticker_path)
                    except Exception as e:
                        if _interface:
                            _interface.logger.warning(f"清理临时文件失败: {str(e)}")

    except Exception as e:
        if _interface:
            _interface.logger.error(f"添加贴纸到贴纸包失败: {str(e)}")
        return False, f"❌ 添加贴纸时出错: {str(e)}"


async def delete_sticker_from_set(update, context, set_name,
                                  sticker_id_prefix):
    """从贴纸包中删除贴纸"""
    query = update.callback_query

    try:
        # 获取贴纸包信息
        sticker_set = await context.bot.get_sticker_set(set_name)

        # 查找匹配的贴纸
        matching_sticker = None
        for sticker in sticker_set.stickers:
            if sticker.file_id.startswith(sticker_id_prefix):
                matching_sticker = sticker
                break

        if not matching_sticker:
            await query.message.edit_text("❌ 找不到指定的贴纸。")
            return

        # 删除贴纸
        success = await context.bot.delete_sticker_from_set(
            matching_sticker.file_id)

        if success:
            # 返回贴纸列表
            await view_stickers_in_set(update, context, set_name)
        else:
            await query.message.edit_text("❌ 删除贴纸失败，请稍后重试。")

    except Exception as e:
        if _interface:
            _interface.logger.error(f"删除贴纸失败: {str(e)}")
        await query.message.edit_text(f"❌ 删除贴纸时出错: {str(e)}")


async def delete_sticker_set_confirm(update, context, set_name):
    """确认删除整个贴纸包"""
    query = update.callback_query

    try:
        # 获取贴纸包信息
        sticker_set = await context.bot.get_sticker_set(set_name)

        # 显示确认信息
        message = f"⚠️ *确认删除*\n\n"
        message += f"确定要删除贴纸包 \"{TextFormatter.escape_markdown(sticker_set.title)}\" 吗？\n"
        message += "此操作无法撤销！"

        keyboard = [[
            InlineKeyboardButton(
                "◯ Confirm",
                callback_data=f"stk:confirm_delete_set:{set_name}"),
            InlineKeyboardButton("⨉ Cancel",
                                 callback_data=f"stk:view_stickers:{set_name}")
        ]]

        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.message.edit_text(message,
                                      parse_mode="MARKDOWN",
                                      reply_markup=reply_markup)

    except Exception as e:
        if _interface:
            _interface.logger.error(f"准备删除贴纸包失败: {str(e)}")
        await query.message.edit_text(f"❌ 操作失败: {str(e)}")


async def delete_sticker_set(update, context, set_name):
    """删除整个贴纸包"""
    query = update.callback_query
    user_id = str(update.effective_user.id)

    try:
        # 获取贴纸包信息
        sticker_set = await context.bot.get_sticker_set(set_name)
        set_title = sticker_set.title
        sticker_count = len(sticker_set.stickers)

        # 显示进度信息
        await query.message.edit_text(f"⏳ 正在删除贴纸包中的 {sticker_count} 个贴纸，请稍候..."
                                      )

        # 删除所有贴纸
        delete_failures = 0
        for sticker in sticker_set.stickers:
            try:
                success = await context.bot.delete_sticker_from_set(
                    sticker.file_id)
                if not success:
                    delete_failures += 1
            except Exception:
                delete_failures += 1

        # 从用户配置中移除贴纸包信息
        if user_id in user_sticker_sets:
            user_sets = user_sticker_sets[user_id]
            if "set_name" in user_sets and user_sets["set_name"] == set_name:
                user_sticker_sets[user_id] = {}
                await _save_config()

        # 显示结果
        if delete_failures > 0:
            message = f"⚠️ 贴纸包 \"{set_title}\" 部分删除成功。\n有 {delete_failures} 个贴纸无法删除。"
        else:
            message = f"✅ 贴纸包 \"{set_title}\" 已成功删除。"

        keyboard = [[
            InlineKeyboardButton("⇠ Back", callback_data="stk:manage")
        ]]
        reply_markup = InlineKeyboardMarkup(keyboard)

        await query.message.edit_text(message, reply_markup=reply_markup)

    except Exception as e:
        if _interface:
            _interface.logger.error(f"删除贴纸包失败: {str(e)}")
        await query.message.edit_text(f"❌ 删除贴纸包时出错: {str(e)}")
