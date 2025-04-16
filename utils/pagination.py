# utils/pagination.py - 分页工具

import math
import asyncio
import re
from typing import List, Dict, Any, Callable, Optional, Union

from telegram import Update, InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

from utils.formatter import TextFormatter


class PaginationHelper:
    """通用分页工具，用于处理长列表的分页显示"""

    def __init__(self,
                 items,
                 page_size=10,
                 format_item=None,
                 title="列表",
                 callback_prefix="page"):
        """初始化分页工具
        
        Args:
            items: 要分页的项目列表
            page_size: 每页显示的项目数
            format_item: 项目格式化函数 (item) -> str
            title: 页面标题
            callback_prefix: 回调数据前缀
        """
        self.items = items
        self.page_size = page_size
        self.format_item = format_item or (lambda x: str(x))
        self.title = title
        self.callback_prefix = callback_prefix

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

        # 上一页按钮
        if page_index > 0:
            row.append(
                InlineKeyboardButton(
                    "◀️ 上一页",
                    callback_data=
                    f"{self.callback_prefix}:{page_index - 1}:{id(self)}"))
        else:
            row.append(InlineKeyboardButton(" ", callback_data="noop"))

        # 页码指示
        row.append(
            InlineKeyboardButton(f"{page_index + 1}/{self.total_pages}",
                                 callback_data="noop"))

        # 下一页按钮
        if page_index < self.total_pages - 1:
            row.append(
                InlineKeyboardButton(
                    "下一页 ▶️",
                    callback_data=
                    f"{self.callback_prefix}:{page_index + 1}:{id(self)}"))
        else:
            row.append(InlineKeyboardButton(" ", callback_data="noop"))

        keyboard.append(row)
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

        # 如果是回调查询
        if update.callback_query:
            try:
                await update.callback_query.edit_message_text(
                    text=content, reply_markup=keyboard, parse_mode="MARKDOWN")
                await update.callback_query.answer()
                return update.callback_query.message
            except Exception as e:
                # 如果 Markdown 解析失败，尝试纯文本
                plain_content = TextFormatter.markdown_to_plain(content)
                await update.callback_query.edit_message_text(
                    text=plain_content, reply_markup=keyboard)
                await update.callback_query.answer()
                return update.callback_query.message
        else:
            try:
                return await update.message.reply_text(text=content,
                                                       reply_markup=keyboard,
                                                       parse_mode="MARKDOWN")
            except Exception as e:
                # 如果 Markdown 解析失败，尝试纯文本
                plain_content = TextFormatter.markdown_to_plain(content)
                return await update.message.reply_text(text=plain_content,
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
            page_index = int(parts[1])

            # 根据前缀确定要调用的命令处理器
            if prefix == "mod_page":
                # 调用 _list_modules_command
                await context.bot_data[
                    "command_manager"]._list_modules_command(update, context)
            elif prefix == "cmd_page":
                # 调用 _list_commands_command
                await context.bot_data[
                    "command_manager"]._list_commands_command(update, context)
            else:
                # 其他模块的回调处理器
                await query.answer("处理中...")

        except Exception as e:
            # 处理错误
            import traceback
            print(f"回调处理错误: {e}")
            print(traceback.format_exc())
            await query.answer("处理回调时出错")
