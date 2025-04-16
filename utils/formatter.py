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

        # 转义以下字符: _ * [ ] ( ) ~ ` > # + - = | { } !
        # 注意：不转义点号(.)，因为它在版本号中很常见
        return re.sub(r'([_*\[\]()~`>#\+\-=|{}!\\])', r'\\\1', text)

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
