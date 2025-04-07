# utils/text_utils.py


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
