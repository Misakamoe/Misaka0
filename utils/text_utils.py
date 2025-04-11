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
        增强版：更好的代码块处理和特殊字符转义
        """
        if not text:
            return ""

        # 先转义所有 HTML 特殊字符，确保文本安全
        # 但保留 Markdown 标记
        safe_text = ""
        in_code_block = False
        in_inline_code = False
        code_block_lang = ""
        i = 0

        while i < len(text):
            # 检查是否是代码块开始
            if text[i:i + 3] == "```" and not in_inline_code:
                if not in_code_block:
                    # 代码块开始
                    in_code_block = True
                    # 检查是否指定了语言
                    end_of_first_line = text.find("\n", i + 3)
                    if end_of_first_line > i + 3:
                        code_block_lang = text[i + 3:end_of_first_line].strip()
                        safe_text += "```" + code_block_lang + "\n"
                        i = end_of_first_line + 1
                        continue
                    else:
                        code_block_lang = ""
                        safe_text += "```\n"
                        i += 3
                        continue
                else:
                    # 代码块结束
                    in_code_block = False
                    code_block_lang = ""
                    safe_text += "```"
                    i += 3
                    continue

            # 检查是否是行内代码开始/结束
            if text[i] == "`" and not in_code_block:
                if not in_inline_code:
                    # 行内代码开始
                    in_inline_code = True
                else:
                    # 行内代码结束
                    in_inline_code = False
                safe_text += "`"
                i += 1
                continue

            # 在代码块或行内代码内，完全转义所有 HTML 特殊字符
            if in_code_block or in_inline_code:
                if text[i] == "<":
                    safe_text += "&lt;"
                elif text[i] == ">":
                    safe_text += "&gt;"
                elif text[i] == "&":
                    safe_text += "&amp;"
                elif text[i] == '"':
                    safe_text += "&quot;"
                elif text[i] == "'":
                    safe_text += "&#39;"
                else:
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

        # 确保所有代码块和行内代码都已正确闭合
        if in_code_block:
            safe_text += "\n```"  # 添加缺失的代码块结束标记
        if in_inline_code:
            safe_text += "`"  # 添加缺失的行内代码结束标记

        # 处理代码块 (```)
        def replace_code_block(match):
            lang = match.group(1) or ""
            code = match.group(2)

            # 确保代码中的所有内容都被完全转义
            # 这里的代码已经在上面的循环中转义过了，所以不需要再次转义

            # 添加语言信息
            lang_info = f"<b>{lang}</b>\n" if lang else ""

            return f"{lang_info}<pre><code>{code}</code></pre>"

        # 处理行内代码 (`)
        def replace_inline_code(match):
            code = match.group(1)
            # 代码内容已经在上面的循环中转义过了
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
        """分段发送长 HTML 格式消息，确保标签正确闭合"""
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
                        # 单个段落太长，需要进一步分割
                        if len(para) > MAX_LENGTH:
                            # 智能分割长段落，确保不会在标签中间切断
                            long_para_parts = TextUtils.smart_split_text(
                                para, MAX_LENGTH)
                            parts.extend(long_para_parts)
                        else:
                            # 单个段落不超长，但转换后的 HTML 可能超长
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
                parts = TextUtils.smart_split_text(text, MAX_PLAIN_LENGTH)

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

    @staticmethod
    def smart_split_text(text, max_length):
        """
        智能分割文本，确保不会在 Markdown 格式标记中间切断
        """
        if len(text) <= max_length:
            return [text]

        parts = []
        current_pos = 0

        while current_pos < len(text):
            # 找到一个合适的分割点
            end_pos = current_pos + max_length

            if end_pos >= len(text):
                # 已经到达文本末尾
                parts.append(text[current_pos:])
                break

            # 尝试在段落、句子或空格处分割
            paragraph_break = text.rfind("\n\n", current_pos, end_pos)
            sentence_break = text.rfind(". ", current_pos, end_pos)
            space_break = text.rfind(" ", current_pos, end_pos)

            # 选择最佳分割点
            if paragraph_break != -1 and paragraph_break > current_pos + max_length // 2:
                split_pos = paragraph_break + 2  # 包含换行符
            elif sentence_break != -1 and sentence_break > current_pos + max_length // 3:
                split_pos = sentence_break + 2  # 包含句号和空格
            elif space_break != -1:
                split_pos = space_break + 1  # 包含空格
            else:
                # 没有找到好的分割点，强制分割
                split_pos = end_pos

            # 检查是否在格式标记中间
            # 检查代码块
            code_block_start = text.rfind("```", current_pos, split_pos)
            if code_block_start != -1:
                code_block_end = text.find("```", code_block_start + 3)
                if code_block_end == -1 or code_block_end > split_pos:
                    # 在代码块中间，调整分割点
                    if code_block_start > current_pos + 10:  # 确保至少有一些内容
                        split_pos = code_block_start
                    else:
                        # 尝试包含整个代码块
                        if code_block_end != -1 and code_block_end - current_pos < max_length * 1.5:
                            split_pos = code_block_end + 3
                        else:
                            # 代码块太长，在代码块开始前分割
                            split_pos = code_block_start

            # 检查行内代码、粗体、斜体等
            for marker in ['`', '**', '*', '__', '_', '~~']:
                marker_count = text.count(marker, current_pos, split_pos)
                if marker_count % 2 != 0:  # 奇数个标记，意味着在标记中间
                    last_marker = text.rfind(marker, current_pos, split_pos)
                    if last_marker > current_pos + 10:  # 确保至少有一些内容
                        split_pos = last_marker

            # 添加这一部分
            parts.append(text[current_pos:split_pos])
            current_pos = split_pos

        return parts

    @staticmethod
    def strip_html(text):
        """移除 HTML 标签"""

        return re.sub(r'<[^>]+>', '', text)

    @staticmethod
    def normalize_whitespace(text):
        """规范化文本中的空白字符，删除多余的空行和空格"""
        # 将多个空行替换为一个空行
        text = re.sub(r'\n\s*\n', '\n\n', text)
        # 删除每行开头和结尾的空白
        text = re.sub(r'^\s+|\s+$', '', text, flags=re.MULTILINE)
        # 删除整个文本开头和结尾的空白
        return text.strip()

    @staticmethod
    def escape_html(text):
        """转义 HTML 特殊字符"""
        if not text:
            return ""
        return (text.replace("&",
                             "&amp;").replace("<",
                                              "&lt;").replace(">", "&gt;"))
