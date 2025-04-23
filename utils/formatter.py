# utils/formatter.py - 文本格式化工具

import re


class TextFormatter:
    """文本格式化工具，处理 Markdown、HTML 等格式"""

    @staticmethod
    def escape_markdown(text):
        """转义 Markdown 特殊字符
        
        Args:
            text: 原始文本
            
        Returns:
            str: 转义后的文本
        """
        if not text:
            return ""

        # 只转义真正需要的特殊字符: _ * [ ] ( ) ~ `
        # 不转义: - = | { } . ! > # + \
        return re.sub(r'([_*\[\]()~`])', r'\\\1', text)

    @staticmethod
    def escape_html(text):
        """转义 HTML 特殊字符
        
        Args:
            text: 原始文本
            
        Returns:
            str: 转义后的文本
        """
        if not text:
            return ""

        return text.replace("&", "&amp;").replace("<", "&lt;").replace(
            ">", "&gt;").replace('"', "&quot;").replace("'", "&#39;")

    @staticmethod
    def markdown_to_plain(text):
        """将 Markdown 格式转换为纯文本
        
        Args:
            text: Markdown 文本
            
        Returns:
            str: 纯文本
        """
        if not text:
            return ""

        # 移除 Markdown 格式标记
        # 1. 移除加粗和斜体
        text = re.sub(r'\*\*(.*?)\*\*', r'\1', text)
        text = re.sub(r'__(.*?)__', r'\1', text)
        text = re.sub(r'\*(.*?)\*', r'\1', text)
        text = re.sub(r'_(.*?)_', r'\1', text)

        # 2. 移除代码块
        text = re.sub(r'```(?:.*?)\n([\s\S]*?)```', r'\1', text)
        text = re.sub(r'`(.*?)`', r'\1', text)

        # 3. 移除链接
        text = re.sub(r'\[(.*?)\]\(.*?\)', r'\1', text)

        # 4. 移除转义字符
        text = re.sub(r'\\([\\`*_{}\[\]()#+\-.!])', r'\1', text)

        return text

    @staticmethod
    def smart_split_text(text, max_length=4000, mode="markdown"):
        """智能分割文本，确保不会在格式标记中间切断
        
        Args:
            text: 要分割的文本
            max_length: 每段最大长度
            mode: 文本格式模式 ("markdown", "html", "plain")
            
        Returns:
            list: 分割后的文本段落
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
            if mode == "markdown":
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
                        last_marker = text.rfind(marker, current_pos,
                                                 split_pos)
                        if last_marker > current_pos + 10:  # 确保至少有一些内容
                            split_pos = last_marker

            # 添加这一部分
            parts.append(text[current_pos:split_pos])
            current_pos = split_pos

        return parts

    def strip_html(text):
        """移除 HTML 标签"""
        if not text:
            return ""
        return re.sub(r'<[^>]+>', '', text)

    @staticmethod
    def normalize_whitespace(text):
        """规范化文本中的空白字符
        
        Args:
            text: 原始文本
            
        Returns:
            str: 规范化后的文本
        """
        # 将多个空行替换为一个空行
        text = re.sub(r'\n\s*\n', '\n\n', text)
        # 删除每行开头和结尾的空白
        text = re.sub(r'^\s+|\s+$', '', text, flags=re.MULTILINE)
        # 删除整个文本开头和结尾的空白
        return text.strip()

    @staticmethod
    def markdown_to_html(markdown_text):
        """将 Markdown 文本转换为 Telegram 支持的 HTML
        
        Args:
            markdown_text: Markdown 格式的文本
            
        Returns:
            str: HTML 格式的文本
        """
        if not markdown_text:
            return ""

        # 替换 HTML 特殊字符
        text = markdown_text.replace("&", "&amp;").replace("<",
                                                           "&lt;").replace(
                                                               ">", "&gt;")

        # 处理代码块
        import re

        # 首先处理代码块 (```)
        def replace_code_block(match):
            code = match.group(2)
            return f"<pre>{code}</pre>"

        text = re.sub(r'```(?:(\w+)\n)?([\s\S]+?)```', replace_code_block,
                      text)

        # 处理行内代码 (`)
        text = re.sub(r'`([^`\n]+?)`', r'<code>\1</code>', text)

        # 处理加粗 (** 或 __)
        text = re.sub(r'\*\*(.*?)\*\*', r'<b>\1</b>', text)
        text = re.sub(r'__(.*?)__', r'<b>\1</b>', text)

        # 处理斜体 (* 或 _)
        text = re.sub(r'\*([^\*]+?)\*', r'<i>\1</i>', text)
        text = re.sub(r'_([^_]+?)_', r'<i>\1</i>', text)

        # 处理删除线 (~~)
        text = re.sub(r'~~(.*?)~~', r'<s>\1</s>', text)

        # 替换URL链接
        text = re.sub(r'\[(.*?)\]\((.*?)\)', r'<a href="\2">\1</a>', text)

        return text

    @staticmethod
    def smart_split_html(html_text, max_length=4000):
        """智能分割 HTML 文本，确保标签完整性
        
        Args:
            html_text: HTML 文本
            max_length: 每段最大长度
            
        Returns:
            list: 分段后的 HTML 文本列表
        """
        if len(html_text) <= max_length:
            return [html_text]

        parts = []
        current_pos = 0

        while current_pos < len(html_text):
            # 找到一个合适的分割点
            end_pos = current_pos + max_length

            if end_pos >= len(html_text):
                # 已经到达文本末尾
                parts.append(html_text[current_pos:])
                break

            # 尝试找一个有意义的分割点 (在换行符后)
            br_pos = html_text.rfind('\n', current_pos, end_pos)
            if br_pos != -1 and br_pos > current_pos + max_length // 2:
                split_pos = br_pos + 1  # 包含换行符
            else:
                # 尝试在段落处分割
                para_pos = html_text.rfind('</pre>', current_pos, end_pos)
                if para_pos != -1 and para_pos > current_pos + max_length // 2:
                    split_pos = para_pos + 6  # </pre> 的长度
                else:
                    # 尝试在有意义的地方分割
                    candidates = [
                        html_text.rfind('</code>', current_pos, end_pos),
                        html_text.rfind('</b>', current_pos, end_pos),
                        html_text.rfind('</i>', current_pos, end_pos),
                        html_text.rfind('</s>', current_pos, end_pos),
                        html_text.rfind('</a>', current_pos, end_pos),
                        html_text.rfind('. ', current_pos, end_pos),
                        html_text.rfind('? ', current_pos, end_pos),
                        html_text.rfind('! ', current_pos, end_pos),
                        html_text.rfind('; ', current_pos, end_pos),
                    ]

                    # 选择最远的有效分割点
                    best_pos = max([
                        p for p in candidates
                        if p != -1 and p > current_pos + max_length // 4
                    ] or [-1])

                    if best_pos != -1:
                        split_pos = best_pos + 2  # 包括标点和空格
                    else:
                        # 如果没有好的分割点，在空格处分割
                        space_pos = html_text.rfind(
                            ' ', current_pos + max_length // 2, end_pos)
                        if space_pos != -1:
                            split_pos = space_pos + 1
                        else:
                            # 最后手段：强制分割
                            split_pos = end_pos

            # 确保我们不会切断 HTML 标签
            # 检查是否在标签内
            tag_start = html_text.rfind('<', current_pos, split_pos)
            if tag_start != -1:
                tag_end = html_text.find('>', tag_start)
                if tag_end != -1 and tag_end >= split_pos:
                    # 我们在标签内部，移动到标签之前
                    split_pos = tag_start

            # 检查是否有未闭合的标签
            open_tags = []
            for match in re.finditer(r'<(/?)([a-z]+)[^>]*>',
                                     html_text[current_pos:split_pos],
                                     re.IGNORECASE):
                if match.group(1) == '':  # 开始标签
                    open_tags.append(match.group(2))
                else:  # 结束标签
                    if open_tags and open_tags[-1] == match.group(2):
                        open_tags.pop()

            # 如果有未闭合的标签，添加闭合标签
            closing_tags = ''
            for tag in reversed(open_tags):
                closing_tags += f'</{tag}>'

            # 添加这一部分，包括必要的闭合标签
            parts.append(html_text[current_pos:split_pos] + closing_tags)

            # 下一部分开始时，添加之前未闭合的标签
            opening_tags = ''
            for tag in open_tags:
                opening_tags += f'<{tag}>'

            current_pos = split_pos

        return parts
