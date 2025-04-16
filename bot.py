#!/usr/bin/env python3
# bot.py - 机器人主入口

import os
import sys
import argparse
import logging
import asyncio
import signal
import time
from core.bot_engine import BotEngine
from utils.logger import setup_logger


async def main_async():
    """异步主函数"""
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

    # 创建停止事件
    stop_event = asyncio.Event()

    # 信号处理
    def signal_handler():
        logger.info("收到停止信号，准备关闭...")
        stop_event.set()

    # 设置信号处理
    loop = asyncio.get_running_loop()
    for sig in [signal.SIGINT, signal.SIGTERM]:
        try:
            loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            # 在不支持的平台上，依赖键盘中断
            logger.warning("当前平台不支持信号处理，将使用传统的键盘中断检测")
            pass

    # 创建并运行机器人
    bot = None
    try:
        # 创建 Bot 引擎
        bot = BotEngine(config_dir=args.config, token=args.token)

        # 初始化并启动
        await bot.initialize()
        await bot.start()

        # 等待停止信号
        try:
            await stop_event.wait()
        except asyncio.CancelledError:
            # 捕获 CancelledError，这通常是由 Ctrl+C 触发的
            logger.info("收到取消信号，准备关闭...")

        logger.info("正在优雅地关闭...")
        await bot.stop()

    except KeyboardInterrupt:
        logger.info("收到键盘中断，正在关闭...")
        if bot:
            await bot.stop()
    except Exception as e:
        logger.error(f"启动过程中发生错误: {e}", exc_info=True)
        if bot:
            await bot.stop()
        return 1

    logger.info("机器人已完全关闭")
    return 0


def main():
    """入口点函数"""
    # 在 Windows 上需要使用特定的事件循环策略
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())
