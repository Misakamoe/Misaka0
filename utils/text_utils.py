# utils/text_utils.py

import re


class TextUtils:
    """文本处理工具类"""

    @staticmethod
    def escape_markdown(text):
        """转义 Markdown 特殊字符"""
        if not text:
            return ""
        # 转义以下字符: _ * [ ] ` \
        return text.replace('\\', '\\\\').replace('_', '\\_').replace(
            '*', '\\*').replace('[', '\\[').replace(']',
                                                    '\\]').replace('`', '\\`')

    @staticmethod
    def format_user_info(user, include_username=True):
        """格式化用户信息为 Markdown 格式"""
        info = f"{TextUtils.escape_markdown(user.full_name)} (ID: `{user.id}`)"
        if include_username and user.username:
            info += f" @{TextUtils.escape_markdown(user.username)}"
        return info

    @staticmethod
    def format_chat_info(chat):
        """格式化聊天信息为 Markdown 格式"""
        info = f"ID: `{chat.id}`\n类型: {chat.type}\n"
        if chat.type in ["group", "supergroup"]:
            info += f"群组名称: {TextUtils.escape_markdown(chat.title)}\n"
        return info

    @staticmethod
    def markdown_to_plain(text):
        """将 Markdown 格式转换为纯文本"""
        if not text:
            return ""
        # 移除 Markdown 格式
        return text.replace("*", "").replace("\\_", "_").replace(
            "\\*", "*").replace("\\[", "[").replace("\\`", "`")

    @staticmethod
    def markdown_to_html(text):
        """
        将 Markdown 格式转换为 Telegram 支持的 HTML 格式
        基本处理代码块和常见格式，不过于严格
        """
        if not text:
            return ""

        # 先转义所有 HTML 特殊字符，确保文本安全
        # 但保留 Markdown 标记
        safe_text = ""
        in_code_block = False
        in_inline_code = False
        i = 0

        while i < len(text):
            # 检查是否是代码块开始/结束
            if text[i:i + 3] == "```" and not in_inline_code:
                in_code_block = not in_code_block
                safe_text += "```"
                i += 3
                continue

            # 检查是否是行内代码开始/结束
            if text[i] == "`" and not in_code_block:
                in_inline_code = not in_inline_code
                safe_text += "`"
                i += 1
                continue

            # 在代码块或行内代码内，不转义
            if in_code_block or in_inline_code:
                safe_text += text[i]
            else:
                # 转义 HTML 特殊字符，但保留 Markdown 标记
                if text[i] == "<":
                    safe_text += "&lt;"
                elif text[i] == ">":
                    safe_text += "&gt;"
                elif text[i] == "&":
                    safe_text += "&amp;"
                else:
                    safe_text += text[i]

            i += 1

        # 处理代码块 (```)
        def replace_code_block(match):
            lang = match.group(1) or ""
            code = match.group(2)

            # 简单添加语言信息
            lang_info = f"<b>{lang}</b>\n" if lang else ""

            return f"{lang_info}<pre>{code}</pre>"

        # 处理行内代码 (`)
        def replace_inline_code(match):
            code = match.group(1)
            return f"<code>{code}</code>"

        # 处理加粗 (** 或 __)
        def replace_bold(match):
            text = match.group(1) or match.group(2)
            return f"<b>{text}</b>"

        # 处理斜体 (* 或 _)
        def replace_italic(match):
            text = match.group(1) or match.group(2)
            return f"<i>{text}</i>"

        # 处理删除线 (~~)
        def replace_strikethrough(match):
            text = match.group(1)
            return f"<s>{text}</s>"

        # 按顺序应用替换
        # 1. 首先处理代码块
        processed_text = re.sub(r'```(\w*)\n([\s\S]*?)\n```',
                                replace_code_block, safe_text)

        # 2. 处理行内代码
        processed_text = re.sub(r'`([^`\n]+?)`', replace_inline_code,
                                processed_text)

        # 3. 处理其他格式
        processed_text = re.sub(r'\*\*(.*?)\*\*|__(.*?)__', replace_bold,
                                processed_text)
        processed_text = re.sub(
            r'(?<!\*)\*((?!\*).+?)\*(?!\*)|(?<!_)_((?!_).+?)_(?!_)',
            replace_italic, processed_text)
        processed_text = re.sub(r'~~(.*?)~~', replace_strikethrough,
                                processed_text)

        return processed_text

    @staticmethod
    async def send_long_message_html(update, text, module_interface):
        """分段发送长 HTML 格式消息"""
        try:
            # 首先将文本转换为 HTML 格式
            html_text = TextUtils.markdown_to_html(text)

            # Telegram 消息最大长度约为 4096 字符
            MAX_LENGTH = 4000

            if len(html_text) <= MAX_LENGTH:
                try:
                    return await update.message.reply_text(html_text,
                                                           parse_mode="HTML")
                except Exception as e:
                    module_interface.logger.error(f"发送 HTML 消息失败: {e}")
                    # 回退到纯文本
                    return await update.message.reply_text(text)

            # 需要分段发送
            module_interface.logger.info("消息过长，需要分段发送")

            # 按段落分割原始文本
            parts = []
            paragraphs = text.split("\n\n")

            current_part = ""
            for para in paragraphs:
                test_part = current_part + "\n\n" + para if current_part else para
                test_html = TextUtils.markdown_to_html(test_part)

                if len(test_html) > MAX_LENGTH:
                    if current_part:
                        parts.append(current_part)
                        current_part = para
                    else:
                        # 单个段落太长，直接添加，后面单独处理
                        parts.append(para)
                else:
                    current_part = test_part

            if current_part:
                parts.append(current_part)

            # 发送所有部分
            first_message = None
            for i, part in enumerate(parts):
                # 将每个部分转换为 HTML
                html_part = TextUtils.markdown_to_html(part)

                try:
                    if i == 0:
                        first_message = await update.message.reply_text(
                            html_part, parse_mode="HTML")
                    else:
                        await first_message.reply_text(html_part,
                                                       parse_mode="HTML")
                except Exception as e:
                    module_interface.logger.error(f"发送 HTML 部分失败: {e}")

                    # 如果 HTML 渲染失败，尝试发送纯文本
                    if i == 0:
                        first_message = await update.message.reply_text(part)
                    else:
                        await first_message.reply_text(part)

            return first_message

        except Exception as e:
            module_interface.logger.error(f"HTML 消息处理失败: {e}")
            # 回退到纯文本
            try:
                # 直接分段发送纯文本
                MAX_PLAIN_LENGTH = 4000

                if len(text) <= MAX_PLAIN_LENGTH:
                    return await update.message.reply_text(text)

                # 分段发送
                parts = []
                for i in range(0, len(text), MAX_PLAIN_LENGTH):
                    parts.append(text[i:i + MAX_PLAIN_LENGTH])

                module_interface.logger.info(f"消息过长，将分为 {len(parts)} 段纯文本发送")

                # 发送第一段
                first_message = await update.message.reply_text(parts[0])

                # 发送剩余段落
                for part in parts[1:]:
                    await first_message.reply_text(part)

                return first_message
            except Exception as inner_e:
                module_interface.logger.error(f"发送纯文本也失败: {inner_e}")
                # 最后的回退：发送一个简单的错误消息
                await update.message.reply_text("生成回复时出错，请重试")
                return None
