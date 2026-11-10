# modules/sticker.py - 贴纸管理模块

import os
import json
import uuid
import asyncio
import tempfile
from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup, InputSticker
from telegram.ext import ContextTypes, MessageHandler, filters

# 导入图像处理库
from PIL import Image

try:
    from lottie.parsers.tgs import parse_tgs
    from lottie.exporters.gif import export_gif
    LOTTIE_AVAILABLE = True
except ImportError:
    LOTTIE_AVAILABLE = False

MODULE_NAME = "sticker"
MODULE_VERSION = "2.1.0"
MODULE_DESCRIPTION = "下载贴纸，支持自建贴纸包"
MODULE_COMMANDS = ["sticker"]
MODULE_CHAT_TYPES = ["private"]  # 仅限私聊使用

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

# 定义回调前缀
CALLBACK_PREFIX = "sticker_"


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
    asyncio.create_task(_save_config())
    return short_id


def _get_sticker_id(short_id):
    """根据短 ID 获取贴纸文件 ID"""
    return _sticker_id_map.get(short_id)


async def setup(interface):
    """模块初始化函数"""
    global user_configs, user_sticker_sets, _interface, _sticker_handler

    _interface = interface

    # 加载配置
    _load_config()

    # 使用框架的状态管理加载状态
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
                                     show_main_menu,
                                     admin_level=False,
                                     description="管理贴纸转换和贴纸包")

    # 注册处理器
    _sticker_handler = MessageHandler(filters.Sticker.ALL, handle_sticker)
    await interface.register_handler(_sticker_handler, group=1)

    # 注册回调处理器
    await interface.register_callback_handler(
        handle_callback_query,
        pattern=f"^{CALLBACK_PREFIX}",
        admin_level=False  # 所有用户都可以使用贴纸功能
    )

    interface.logger.info(f"模块 {MODULE_NAME} v{MODULE_VERSION} 已初始化")


async def cleanup(interface):
    """模块清理函数"""
    global _interface

    # 保存配置和状态
    await _save_config()

    # 清理全局引用
    _interface = None

    # 记录模块卸载信息
    interface.logger.info(f"模块 {MODULE_NAME} 已清理完成")


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

        _interface.logger.debug(f"贴纸配置已从 {CONFIG_FILE} 加载")
    except Exception as e:
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

            # 同时保存到框架的状态管理中
            _interface.save_state({
                "configs": user_configs,
                "sticker_sets": user_sticker_sets
            })
        except Exception as e:
            _interface.logger.error(f"保存贴纸配置失败: {str(e)}")


# 设置菜单函数
async def show_main_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示主设置菜单"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message
    query = update.callback_query

    user_id = str(update.effective_user.id)
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    # 构建设置面板文本
    help_message = "*贴纸助手设置*\n\n"
    help_message += f"📊 *当前配置*\n"
    help_message += f"• 图片格式: `{config['image_format']}`\n"
    help_message += f"• GIF 质量: `{config['gif_quality']}`\n"
    help_message += f"• 自动下载: `{'✅' if config['auto_download'] else '❌'}`\n\n"
    help_message += "*使用方法*\n"
    help_message += "发送贴纸给我，即可转换为图片或 GIF\n"

    # 创建设置按钮
    settings_buttons = [
        [
            InlineKeyboardButton(
                "Format Settings",
                callback_data=f"{CALLBACK_PREFIX}menu_format"),
            InlineKeyboardButton(
                "Quality Settings",
                callback_data=f"{CALLBACK_PREFIX}menu_quality")
        ],
        [
            InlineKeyboardButton(
                "Auto Download: ON"
                if config['auto_download'] else "Auto Download: OFF",
                callback_data=f"{CALLBACK_PREFIX}toggle_download")
        ]
    ]

    # 创建贴纸包按钮
    sticker_buttons = []

    # 如果用户有贴纸包，显示查看按钮
    if user_id in user_sticker_sets and "set_name" in user_sticker_sets[
            user_id]:
        set_name = user_sticker_sets[user_id]["set_name"]
        share_link = f"https://t.me/addstickers/{set_name}"
        sticker_buttons.append([
            InlineKeyboardButton("View Pack", url=share_link),
            InlineKeyboardButton("+ Create New",
                                 callback_data=f"{CALLBACK_PREFIX}create")
        ])
    else:
        # 用户没有贴纸包，只显示创建按钮
        sticker_buttons.append([
            InlineKeyboardButton("+ Create Pack",
                                 callback_data=f"{CALLBACK_PREFIX}create")
        ])

    # 合并所有按钮
    keyboard = settings_buttons + sticker_buttons
    reply_markup = InlineKeyboardMarkup(keyboard)

    # 发送或编辑消息
    try:
        if query:
            # 检查查询是否已经被回答
            try:
                await query.answer()
            except Exception:
                pass  # 查询可能已经被回答

            # 编辑消息
            await query.edit_message_text(help_message,
                                          parse_mode="MARKDOWN",
                                          reply_markup=reply_markup)
        else:
            await message.reply_text(help_message,
                                     parse_mode="MARKDOWN",
                                     reply_markup=reply_markup)
    except Exception as e:
        _interface.logger.error(f"显示主菜单时出错: {str(e)}")


async def show_format_menu(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """显示格式设置菜单"""
    query = update.callback_query
    user_id = str(update.effective_user.id)
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    # 构建格式设置文本
    format_text = "*图片格式设置*\n\n"
    format_text += f"当前格式: `{config['image_format']}`\n\n"
    format_text += "选择一个格式:\n"

    # 创建格式选择按钮
    keyboard = []
    for format_option in ["PNG", "WEBP", "JPG"]:
        prefix = "▷ " if format_option == config['image_format'] else ""
        keyboard.append([
            InlineKeyboardButton(
                f"{prefix}{format_option}",
                callback_data=f"{CALLBACK_PREFIX}set_format_{format_option}")
        ])

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    try:
        # 检查查询是否已经被回答
        try:
            await query.answer()
        except Exception:
            pass  # 查询可能已经被回答

        # 编辑消息
        await query.edit_message_text(format_text,
                                      parse_mode="MARKDOWN",
                                      reply_markup=reply_markup)
    except Exception as e:
        _interface.logger.error(f"显示格式菜单时出错: {str(e)}")


async def show_quality_menu(update: Update,
                            context: ContextTypes.DEFAULT_TYPE):
    """显示质量设置菜单"""
    query = update.callback_query
    user_id = str(update.effective_user.id)
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    # 构建质量设置文本
    quality_text = "*GIF 质量设置*\n\n"
    quality_text += f"当前质量: `{config['gif_quality']}`\n\n"
    quality_text += "选择一个质量级别:\n"

    # 创建质量选择按钮
    keyboard = []
    quality_options = {
        "low": "Low (15fps)",
        "medium": "Medium (24fps)",
        "high": "High (30fps)"
    }

    for quality_key, quality_label in quality_options.items():
        prefix = "▷ " if quality_key == config['gif_quality'] else ""
        keyboard.append([
            InlineKeyboardButton(
                f"{prefix}{quality_label}",
                callback_data=f"{CALLBACK_PREFIX}set_quality_{quality_key}")
        ])

    # 添加返回按钮
    keyboard.append([
        InlineKeyboardButton("⇠ Back",
                             callback_data=f"{CALLBACK_PREFIX}back_to_main")
    ])

    reply_markup = InlineKeyboardMarkup(keyboard)

    # 编辑消息
    try:
        # 检查查询是否已经被回答
        try:
            await query.answer()
        except Exception:
            pass  # 查询可能已经被回答

        # 编辑消息
        await query.edit_message_text(quality_text,
                                      parse_mode="MARKDOWN",
                                      reply_markup=reply_markup)
    except Exception as e:
        _interface.logger.error(f"显示质量菜单时出错: {str(e)}")


# 贴纸处理和转换函数
async def handle_sticker(update: Update, context: ContextTypes.DEFAULT_TYPE):
    """处理收到的贴纸消息"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    # 如果是编辑的消息，不处理
    if update.edited_message:
        return

    user_id = str(update.effective_user.id)
    chat_id = update.effective_chat.id

    # 获取会话管理器
    session_manager = _interface.session_manager
    if session_manager:
        # 检查是否有其他模块的活跃会话
        if await session_manager.has_other_module_session(user_id,
                                                          MODULE_NAME,
                                                          chat_id=chat_id):
            return  # 其他模块有活跃会话，不处理此消息

    sticker = message.sticker
    config = user_configs.get(user_id, DEFAULT_CONFIG.copy())

    try:
        # 存储贴纸 ID
        short_id = _store_sticker_id(sticker.file_id)

        # 根据自动下载设置决定操作
        if config["auto_download"]:
            # 自动下载模式
            processing_msg = await message.reply_text("⏳ 正在处理贴纸，请稍候...")

            # 下载并发送贴纸
            download_success = await download_and_send_sticker(
                update, context, sticker, config)

            # 删除处理中消息
            try:
                await processing_msg.delete()
            except:
                pass

            # 只有在下载成功时才显示添加到贴纸包的按钮
            if download_success:
                keyboard = [[
                    InlineKeyboardButton(
                        "+ Add to Pack",
                        callback_data=f"{CALLBACK_PREFIX}add_{short_id}")
                ]]
                reply_markup = InlineKeyboardMarkup(keyboard)

                await message.reply_text("✅ 已下载，可点击添加到贴纸包",
                                         reply_markup=reply_markup)
            else:
                await message.reply_text("❗ 贴纸下载失败，请重试")
        else:
            # 手动模式：显示操作按钮
            keyboard = [[
                InlineKeyboardButton(
                    "⇣ Download",
                    callback_data=f"{CALLBACK_PREFIX}dl_{short_id}"),
                InlineKeyboardButton(
                    "+ Add to Pack",
                    callback_data=f"{CALLBACK_PREFIX}add_{short_id}")
            ]]
            reply_markup = InlineKeyboardMarkup(keyboard)

            await message.reply_text("选择下载或是添加到贴纸包:",
                                     reply_markup=reply_markup)
    except Exception as e:
        # 错误处理
        _interface.logger.error(f"处理贴纸时出错: {str(e)}")

        # 如果显示按钮失败但自动下载模式开启，则直接下载
        if config["auto_download"]:
            await download_and_send_sticker(update, context, sticker, config)


async def download_and_send_sticker(update, context, sticker, config):
    """下载贴纸并直接发送"""
    # 获取消息对象（可能是新消息或编辑的消息）
    message = update.message or update.edited_message

    try:
        return await download_and_send_sticker_to_chat(context.bot,
                                                       message.chat_id,
                                                       sticker, config)
    except Exception as e:
        await message.reply_text(f"处理贴纸时出错: {str(e)}")
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
                                       text="转换动态贴纸失败，请尝试其他贴纸")
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
                                       text="转换静态贴纸失败，请尝试其他贴纸")
                return False

        return True
    except Exception as e:
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
            _interface.logger.debug(f"清理临时文件失败: {str(e)}")


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
            export_gif(animation, gif_path, fps=framerate)
            return gif_path
        else:
            # 尝试使用命令行工具
            try:
                import subprocess
                # 设置帧率
                fps_arg = "30"
                if quality == "low":
                    fps_arg = "15"
                elif quality == "medium":
                    fps_arg = "24"

                cmd = [
                    "lottie_convert.py", tgs_path, gif_path, "--fps", fps_arg
                ]
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
        # 设置输出路径
        # 统一使用小写扩展名
        ext = format_str.lower()
        # 将 jpg 转换为 jpeg 作为格式标识符
        format_str = "JPEG" if format_str.upper(
        ) == "JPG" else format_str.upper()
        output_path = webp_path.replace(".webp", f".{ext}")

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
        elif format_str == "JPEG":
            # JPG 不支持透明度，添加白色背景
            bg = Image.new("RGB", img.size, (255, 255, 255))
            if img.mode == 'RGBA':
                bg.paste(img, mask=img.split()[3])  # 使用透明通道作为遮罩
            else:
                bg.paste(img)
            bg.save(output_path, format=format_str, quality=95)

        img.close()  # 确保关闭图像
        return output_path
    except Exception as e:
        _interface.logger.error(f"转换图像失败: {str(e)}")
        return None


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
                    _interface.logger.error(f"处理用户头像失败: {str(e)}")
            else:
                # 没有用户头像，创建默认图片
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
                    _interface.logger.error(f"创建默认贴纸图片失败: {str(e)}")
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
                _interface.logger.debug(f"清理临时文件失败: {str(e)}")

    except Exception as e:
        _interface.logger.error(f"创建贴纸包失败: {str(e)}")
        return False, None


# 回调处理函数
async def handle_callback_query(update, context):
    """处理所有贴纸相关的回调查询"""
    try:
        query = update.callback_query
        data = query.data

        # 检查前缀
        if not data.startswith(CALLBACK_PREFIX):
            return

        # 移除前缀获取完整动作
        action_with_params = data[len(CALLBACK_PREFIX):]
        if not action_with_params:
            return

        # 分割参数（如果有）
        parts = action_with_params.split("_")

        # 对于特殊情况进行处理
        if action_with_params == "back_to_main":
            action = "back_to_main"
        elif parts[0] == "menu" and len(parts) > 1:
            action = f"menu_{parts[1]}"
        elif parts[0] == "toggle" and len(parts) > 1:
            action = "toggle_download"
        elif parts[0] == "set" and len(parts) > 1:
            if parts[1] == "format" and len(parts) > 2:
                action = "set_format"
                format_value = parts[2]
            elif parts[1] == "quality" and len(parts) > 2:
                action = "set_quality"
                quality_value = parts[2]
            else:
                action = parts[0]
        else:
            action = parts[0]

        # 处理不同的操作
        if action == "dl" and len(parts) > 1:
            # 下载贴纸
            file_id = _get_sticker_id(parts[1])
            if file_id:
                await handle_download(update, context, file_id)
            else:
                await query.message.edit_text("❌ 贴纸信息已过期，请重新发送")

        elif action == "add" and len(parts) > 1:
            # 添加贴纸到贴纸包
            file_id = _get_sticker_id(parts[1])
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
                        await query.message.edit_text("❌ 创建贴纸包失败，请稍后重试")
            else:
                await query.message.edit_text("❌ 贴纸信息已过期，请重新发送")

        elif action == "create":
            # 创建新贴纸包
            await query.message.edit_text("⏳ 正在创建贴纸包，请稍候...")
            success, set_name = await create_user_sticker_set(update, context)

            if success:
                share_link = f"https://t.me/addstickers/{set_name}"
                message = f"✅ 贴纸包[创建成功]({share_link})"
                await query.message.edit_text(message, parse_mode="MARKDOWN")
            else:
                await query.message.edit_text("❌ 创建贴纸包失败，请稍后重试")

        # 设置菜单相关回调
        elif action == "menu_format":
            # 显示格式设置菜单
            await show_format_menu(update, context)

        elif action == "menu_quality":
            # 显示质量设置菜单
            await show_quality_menu(update, context)

        elif action == "back_to_main":
            # 返回主菜单
            await show_main_menu(update, context)

        elif action == "toggle_download":
            # 切换自动下载设置
            user_id = str(update.effective_user.id)
            config = user_configs.get(user_id, DEFAULT_CONFIG.copy())
            config["auto_download"] = not config["auto_download"]
            user_configs[user_id] = config
            await _save_config()

            # 显示更新后的主菜单
            await show_main_menu(update, context)

        elif action == "set_format":
            # 设置图片格式
            if format_value in ["PNG", "WEBP", "JPG"]:
                user_id = str(update.effective_user.id)
                config = user_configs.get(user_id, DEFAULT_CONFIG.copy())
                config["image_format"] = format_value
                user_configs[user_id] = config
                await _save_config()

                # 显示成功消息
                await query.answer(f"✅ 图片格式已设置为: {format_value}")

                # 返回主菜单
                await show_main_menu(update, context)

        elif action == "set_quality":
            # 设置 GIF 质量
            if quality_value in ["low", "medium", "high"]:
                user_id = str(update.effective_user.id)
                config = user_configs.get(user_id, DEFAULT_CONFIG.copy())
                config["gif_quality"] = quality_value
                user_configs[user_id] = config
                await _save_config()

                # 显示成功消息
                await query.answer(f"✅ GIF 质量已设置为: {quality_value}")

                # 返回主菜单
                await show_main_menu(update, context)

        # 确保回调查询得到响应
        await query.answer()

    except Exception as e:
        _interface.logger.error(f"处理回调查询时出错: {str(e)}")
        try:
            await query.message.edit_text("❌ 处理操作时出错，请重试")
        except Exception:
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
            await query.message.edit_text("❌ 处理贴纸失败，请重试")

    except Exception as e:
        await query.message.edit_text(f"❌ 处理贴纸时出错: {str(e)}")


async def add_sticker_to_set(update, context, set_name, sticker_id):
    """添加贴纸到贴纸包"""
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
            return False, "❌ 暂不支持添加动态贴纸到贴纸包"

        elif 'webm' in original_sticker.file_path:
            try:
                # 视频贴纸处理
                sticker_path = tempfile.mktemp(suffix=".webm")
                await original_sticker.download_to_drive(
                    custom_path=sticker_path)

                if not os.path.exists(sticker_path):
                    return False, "❌ 下载贴纸失败"

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
                            # 贴纸包已满
                            return False, "❌ 贴纸包已满，请删除一些现有贴纸"
                        else:
                            # 其他错误
                            raise e

                if success:
                    share_link = f"https://t.me/addstickers/{set_name}"
                    return True, f"✅ 已添加到[贴纸包]({share_link})"
                else:
                    return False, "❌ 添加贴纸失败，请稍后重试"
            finally:
                # 清理临时文件
                if sticker_path and os.path.exists(sticker_path):
                    try:
                        os.unlink(sticker_path)
                    except Exception as e:
                        _interface.logger.warning(f"清理临时文件失败: {str(e)}")

        else:
            try:
                # 静态贴纸处理
                sticker_path = tempfile.mktemp(suffix=".webp")
                await original_sticker.download_to_drive(
                    custom_path=sticker_path)

                if not os.path.exists(sticker_path):
                    return False, "❌ 下载贴纸失败"

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
                            # 贴纸包已满
                            return False, "❌ 贴纸包已满，请删除一些现有贴纸"
                        else:
                            # 其他错误
                            raise e

                if success:
                    share_link = f"https://t.me/addstickers/{set_name}"
                    return True, f"✅ 已添加到[贴纸包]({share_link})"
                else:
                    return False, "❌ 添加贴纸失败，请稍后重试"
            finally:
                # 清理临时文件
                if sticker_path and os.path.exists(sticker_path):
                    try:
                        os.unlink(sticker_path)
                    except Exception as e:
                        _interface.logger.warning(f"清理临时文件失败: {str(e)}")

    except Exception as e:
        _interface.logger.error(f"添加贴纸到贴纸包失败: {str(e)}")
        return False, f"❌ 添加贴纸时出错: {str(e)}"
