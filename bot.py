#!/usr/bin/env python3
# bot.py
import os
import sys
import argparse
import logging
import asyncio
from core.bot_engine import BotEngine
from utils.logger import setup_logger


async def main_async():
    # 解析命令行参数
    parser = argparse.ArgumentParser(description="模块化 Telegram Bot")
    parser.add_argument("--config", help="配置目录路径", default="config")
    parser.add_argument("--token", help="Telegram Bot Token")
    parser.add_argument(
        "--log-level",
        choices=["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],
        help="日志级别",
        default="INFO")
    args = parser.parse_args()

    # 设置主日志
    logger = setup_logger("Main", args.log_level)
    logger.info("正在启动模块化 Telegram Bot...")

    try:
        # 创建 Bot 引擎
        bot = BotEngine()

        # 如果通过命令行提供了 token，覆盖配置
        if args.token:
            from core.config_manager import ConfigManager
            config = ConfigManager()
            config.set_token(args.token)
            logger.info("已通过命令行更新 Bot Token")

        # 运行 Bot
        await bot.run()

        # 保持脚本运行，直到收到中断信号
        try:
            # 创建一个永不完成的 future 来保持程序运行
            while True:
                await asyncio.sleep(1)
        except KeyboardInterrupt:
            logger.info("收到键盘中断，正在退出...")
        finally:
            # 确保在退出前停止 bot
            await bot.stop()

    except KeyboardInterrupt:
        logger.info("收到键盘中断，正在退出...")
    except Exception as e:
        logger.error(f"启动 Bot 时发生错误: {e}", exc_info=True)
        return 1

    return 0


def main():
    """入口点函数"""
    # 在 Windows 上需要使用特定的事件循环策略
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())
