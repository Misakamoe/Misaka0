#!/usr/bin/env python3
# bot.py
import os
import sys
import argparse
import logging
import asyncio
import signal
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

    bot = None
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

        # 使用事件来等待中断，而不是循环
        stop_event = asyncio.Event()

        def signal_handler():
            logger.info("收到停止信号，准备关闭...")
            stop_event.set()

        # 为 SIGINT 和 SIGTERM 设置处理器
        try:
            # 在 Windows 上可能不支持 SIGTERM
            loop = asyncio.get_running_loop()
            signals = [signal.SIGINT]
            if sys.platform != 'win32':
                signals.append(signal.SIGTERM)

            for sig in signals:
                loop.add_signal_handler(sig, signal_handler)
        except NotImplementedError:
            # 如果平台不支持信号处理，则使用传统方法
            logger.warning("当前平台不支持信号处理，将使用传统的键盘中断检测")

        # 等待停止事件或键盘中断
        try:
            await stop_event.wait()
        except asyncio.CancelledError:
            logger.info("任务被取消")
        except KeyboardInterrupt:
            logger.info("收到键盘中断")

        logger.info("正在优雅地关闭...")

        # 确保在退出前停止 bot
        if bot:
            await bot.stop()

    except KeyboardInterrupt:
        logger.info("收到键盘中断，正在退出...")
        if bot:
            await bot.stop()
    except Exception as e:
        logger.error(f"启动 Bot 时发生错误: {e}", exc_info=True)
        if bot:
            try:
                await bot.stop()
            except Exception as stop_error:
                logger.error(f"停止 Bot 时发生错误: {stop_error}")
        return 1

    logger.info("Bot 已完全关闭")
    return 0


def main():
    """入口点函数"""
    # 在 Windows 上需要使用特定的事件循环策略
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

    return asyncio.run(main_async())


if __name__ == "__main__":
    sys.exit(main())
