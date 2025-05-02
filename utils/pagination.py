# utils/pagination.py - 分页工具

import math
from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from utils.formatter import TextFormatter


class PaginationHelper:
    """通用分页工具，用于处理长列表的分页显示"""

    def __init__(self,
                 items,
                 page_size=10,
                 format_item=None,
                 title="列表",
                 callback_prefix="page",
                 parse_mode="MARKDOWN",
                 back_button=None):
        """初始化分页工具

        Args:
            items: 要分页的项目列表
            page_size: 每页显示的项目数
            format_item: 项目格式化函数 (item) -> str
            title: 页面标题
            callback_prefix: 回调数据前缀
            parse_mode: 解析模式，可选 "MARKDOWN" 或 "HTML"
            back_button: 返回按钮，如果提供，将添加到键盘底部
        """
        self.items = items
        self.page_size = page_size
        self.format_item = format_item or (lambda x: str(x))
        self.title = title
        self.callback_prefix = callback_prefix
        self.parse_mode = parse_mode
        self.back_button = back_button

        # 计算总页数
        self.total_pages = max(
            1,
            math.ceil(len(items) / page_size) if items else 1)

    def get_page_content(self, page_index):
        """获取指定页的内容

        Args:
            page_index: 页码（从 0 开始）

        Returns:
            tuple: (格式化内容, 键盘标记)
        """
        # 确保页码有效
        page_index = max(0, min(page_index, self.total_pages - 1))

        # 计算当前页的项目范围
        start_idx = page_index * self.page_size
        end_idx = min(start_idx + self.page_size, len(self.items))

        # 构建页面内容
        if self.parse_mode == "HTML":
            content = f"<b>{TextFormatter.escape_html(self.title)}</b>\n\n"
        else:  # 默认使用 Markdown
            content = f"*{TextFormatter.escape_markdown(self.title)}*\n\n"

        # 添加项目
        for item in self.items[start_idx:end_idx]:
            content += self.format_item(item) + "\n"

        # 添加页码信息
        content += f"\n第 {page_index + 1}/{self.total_pages} 页"

        # 构建导航键盘
        keyboard = self.get_navigation_keyboard(page_index)

        return content, keyboard

    def get_navigation_keyboard(self, page_index):
        """获取导航键盘

        Args:
            page_index: 当前页码（从 0 开始）

        Returns:
            InlineKeyboardMarkup: 键盘标记
        """
        keyboard = []
        row = []

        # 生成唯一标识符
        obj_id = str(id(self))

        # 只有当总页数大于1时，才显示导航按钮
        if self.total_pages > 1:
            # 上一页按钮
            if page_index > 0:
                row.append(
                    InlineKeyboardButton(
                        "◁ Prev",
                        callback_data=
                        f"{self.callback_prefix}:{page_index - 1}:{obj_id}"))
            else:
                row.append(InlineKeyboardButton(" ", callback_data="noop"))

            # 页码指示 - 点击可以选择页码
            row.append(
                InlineKeyboardButton(
                    f"{page_index + 1}/{self.total_pages}",
                    callback_data=f"{self.callback_prefix}:select:{obj_id}"))

            # 下一页按钮
            if page_index < self.total_pages - 1:
                row.append(
                    InlineKeyboardButton(
                        "Next ▷",
                        callback_data=
                        f"{self.callback_prefix}:{page_index + 1}:{obj_id}"))
            else:
                row.append(InlineKeyboardButton(" ", callback_data="noop"))

            keyboard.append(row)

        # 添加返回按钮（如果有）
        if self.back_button:
            # 如果 back_button 是一个列表，直接添加
            if isinstance(self.back_button, list):
                keyboard.append(self.back_button)
            else:
                # 否则，将其包装在列表中
                keyboard.append([self.back_button])

        return InlineKeyboardMarkup(keyboard)

    async def send_page(self, update, context, page_index):
        """发送指定页

        Args:
            update: 更新对象
            context: 上下文对象
            page_index: 页码（从 0 开始）

        Returns:
            Message: 发送的消息
        """
        content, keyboard = self.get_page_content(page_index)

        # 保存分页信息到上下文，用于页码选择功能
        if context:
            context.user_data["page_index"] = page_index
            context.user_data["total_pages"] = self.total_pages

        # 如果是回调查询
        if update.callback_query:
            try:
                await update.callback_query.edit_message_text(
                    text=content,
                    reply_markup=keyboard,
                    parse_mode=self.parse_mode)
                await update.callback_query.answer()
                return update.callback_query.message
            except Exception as e:
                # 如果解析失败，尝试纯文本
                if self.parse_mode == "HTML":
                    plain_content = TextFormatter.html_to_plain(content)
                else:
                    plain_content = TextFormatter.markdown_to_plain(content)
                await update.callback_query.edit_message_text(
                    text=plain_content, reply_markup=keyboard)
                await update.callback_query.answer()
                return update.callback_query.message
        else:
            # 获取消息对象（可能是新消息或编辑的消息）
            message = update.message or update.edited_message

            try:
                return await message.reply_text(text=content,
                                                reply_markup=keyboard,
                                                parse_mode=self.parse_mode)
            except Exception:
                # 如果解析失败，尝试纯文本
                if self.parse_mode == "HTML":
                    plain_content = TextFormatter.html_to_plain(content)
                else:
                    plain_content = TextFormatter.markdown_to_plain(content)
                return await message.reply_text(text=plain_content,
                                                reply_markup=keyboard)

    @staticmethod
    async def handle_callback(update, context):
        """处理分页回调

        Args:
            update: 更新对象
            context: 上下文对象
        """
        query = update.callback_query

        # 跳过无操作回调
        if query.data == "noop":
            await query.answer()
            return

        try:
            # 解析回调数据
            parts = query.data.split(":")
            if len(parts) < 2:
                await query.answer("无效的回调数据")
                return

            prefix = parts[0]
            action = parts[1]

            # 处理页码选择
            if action == "select" and len(parts) >= 3:
                # 获取页面标题和解析模式
                title = context.user_data.get("pagination_title", "列表")
                parse_mode = context.user_data.get("pagination_parse_mode",
                                                   "MARKDOWN")

                # 显示页码选择界面
                await PaginationHelper.show_page_selector(
                    update, context, prefix, title, parse_mode)
                return
            elif action.startswith("goto_") and len(parts) >= 3:
                # 处理页码跳转
                try:
                    page_index = int(action.replace("goto_", ""))
                    # 根据前缀确定要调用的命令处理器
                    if prefix == "mod_page":
                        context.user_data["page_index"] = page_index
                        await context.bot_data["command_manager"
                                               ]._list_modules_command(
                                                   update, context)
                    elif prefix == "cmd_page":
                        context.user_data["page_index"] = page_index
                        await context.bot_data["command_manager"
                                               ]._list_commands_command(
                                                   update, context)
                    else:
                        # 其他模块的回调处理器
                        context.user_data["page_index"] = page_index
                        await query.answer("跳转到页面...")
                except ValueError:
                    await query.answer("无效的页码")
                return

            # 常规页面导航
            if len(parts) >= 3:
                try:
                    page_index = int(action)

                    # 根据前缀确定要调用的命令处理器
                    if prefix == "mod_page":
                        context.user_data["page_index"] = page_index
                        await context.bot_data["command_manager"
                                               ]._list_modules_command(
                                                   update, context)
                    elif prefix == "cmd_page":
                        context.user_data["page_index"] = page_index
                        await context.bot_data["command_manager"
                                               ]._list_commands_command(
                                                   update, context)
                    else:
                        # 其他模块的回调处理器
                        context.user_data["page_index"] = page_index
                        await query.answer("处理中...")
                except ValueError:
                    await query.answer("无效的页码")

        except Exception as e:
            # 处理错误
            await query.answer(f"处理回调时出错: {str(e)[:50]}")

    @staticmethod
    async def show_page_selector(update,
                                 context,
                                 prefix,
                                 title="列表",
                                 parse_mode="MARKDOWN"):
        """显示页码选择界面

        Args:
            update: 更新对象
            context: 上下文对象
            prefix: 回调前缀
            title: 页面标题
            parse_mode: 解析模式，可选 "MARKDOWN" 或 "HTML"
        """
        query = update.callback_query

        # 从上下文中获取总页数
        total_pages = context.user_data.get("total_pages", 9)  # 默认 9 页
        current_page = context.user_data.get("page_index", 0) + 1  # 转为1-based

        # 创建页码选择键盘
        keyboard = []

        # 每行最多3个按钮
        buttons_per_row = 3

        # 计算需要多少行
        rows_needed = (total_pages + buttons_per_row - 1) // buttons_per_row

        # 生成唯一标识符
        obj_id = str(id(update))

        # 生成页码按钮
        for row in range(rows_needed):
            button_row = []
            for i in range(1, buttons_per_row + 1):
                page_num = row * buttons_per_row + i
                if page_num <= total_pages:
                    # 当前页使用不同样式
                    if page_num == current_page:
                        button_text = f"▷ {page_num}"
                    else:
                        button_text = str(page_num)

                    button_row.append(
                        InlineKeyboardButton(
                            button_text,
                            callback_data=f"{prefix}:goto_{page_num-1}:{obj_id}"
                        ))
            if button_row:  # 只添加非空行
                keyboard.append(button_row)

        # 添加返回按钮
        keyboard.append([
            InlineKeyboardButton(
                "⇠ Back", callback_data=f"{prefix}:{current_page-1}:{obj_id}")
        ])

        reply_markup = InlineKeyboardMarkup(keyboard)

        # 构建页面标题
        if parse_mode == "HTML":
            content = f"<b>{TextFormatter.escape_html(title)}</b>\n\n请选择要跳转的页码："
        else:  # 默认使用 Markdown
            content = f"*{TextFormatter.escape_markdown(title)}*\n\n请选择要跳转的页码："

        # 更新消息
        try:
            await query.edit_message_text(content,
                                          reply_markup=reply_markup,
                                          parse_mode=parse_mode)
        except Exception:
            # 如果解析失败，尝试纯文本
            if parse_mode == "HTML":
                plain_content = TextFormatter.html_to_plain(content)
            else:
                plain_content = TextFormatter.markdown_to_plain(content)
            await query.edit_message_text(plain_content,
                                          reply_markup=reply_markup)

        await query.answer()

    @staticmethod
    def paginate_buttons(buttons,
                         page_index=0,
                         rows_per_page=5,
                         buttons_per_row=3,
                         nav_callback_prefix="btn_page",
                         show_nav_buttons=True,
                         back_button=None):
        """对按钮进行分页处理

        当按钮数量很多时，将它们分成多个页面显示，每页最多显示指定行数的按钮。

        Args:
            buttons: 按钮列表，每个元素是 (text, callback_data) 元组或 InlineKeyboardButton 对象
            page_index: 当前页码（从 0 开始）
            rows_per_page: 每页显示的最大行数，默认为 5
            buttons_per_row: 每行显示的最大按钮数，默认为 3
            nav_callback_prefix: 导航按钮的回调数据前缀
            show_nav_buttons: 是否显示导航按钮，当只有一页时可以设为 False
            back_button: 返回按钮，如果提供，将添加到键盘底部

        Returns:
            InlineKeyboardMarkup: 分页后的按钮键盘
        """
        if not buttons:
            return InlineKeyboardMarkup([[]])  # 返回空键盘

        # 计算总页数
        buttons_per_page = rows_per_page * buttons_per_row
        total_buttons = len(buttons)
        total_pages = max(1, math.ceil(total_buttons / buttons_per_page))

        # 确保页码有效
        page_index = max(0, min(page_index, total_pages - 1))

        # 计算当前页的按钮范围
        start_idx = page_index * buttons_per_page
        end_idx = min(start_idx + buttons_per_page, total_buttons)

        # 创建当前页的按钮键盘
        keyboard = []
        current_row = []

        for i in range(start_idx, end_idx):
            try:
                # 获取按钮
                button = buttons[i]

                # 如果按钮是元组，创建 InlineKeyboardButton 对象
                if isinstance(button, tuple) and len(button) >= 2:
                    button = InlineKeyboardButton(text=button[0],
                                                  callback_data=button[1])

                # 添加按钮到当前行
                current_row.append(button)

                # 如果当前行已满或已到达最后一个按钮，添加行到键盘
                if len(current_row) >= buttons_per_row or i == end_idx - 1:
                    keyboard.append(current_row.copy())  # 添加当前行的副本
                    current_row = []
            except Exception as e:
                # 继续处理下一个按钮
                pass

        # 只有当需要显示导航按钮且总页数大于1时，才添加导航按钮
        if show_nav_buttons and total_pages > 1:
            nav_row = []

            # 上一页按钮
            if page_index > 0:
                nav_row.append(
                    InlineKeyboardButton(
                        "◁ Prev",
                        callback_data=f"{nav_callback_prefix}:{page_index - 1}"
                    ))
            else:
                nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

            # 页码指示（不可点击）
            nav_row.append(
                InlineKeyboardButton(f"{page_index + 1}/{total_pages}",
                                     callback_data="noop"))

            # 下一页按钮
            if page_index < total_pages - 1:
                nav_row.append(
                    InlineKeyboardButton(
                        "Next ▷",
                        callback_data=f"{nav_callback_prefix}:{page_index + 1}"
                    ))
            else:
                nav_row.append(InlineKeyboardButton(" ", callback_data="noop"))

            keyboard.append(nav_row)

        # 添加返回按钮
        if back_button:
            # 如果 back_button 是一个列表，直接添加
            if isinstance(back_button, list):
                keyboard.append(back_button)
            else:
                # 否则，将其包装在列表中
                keyboard.append([back_button])

        return InlineKeyboardMarkup(keyboard)
