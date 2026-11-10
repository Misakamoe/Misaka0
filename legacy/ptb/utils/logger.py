# utils/logger.py - 日志工具

import os
import glob
import time
import logging
from logging.handlers import RotatingFileHandler


def setup_logger(name,
                 log_level=None,
                 max_size=5 * 1024 * 1024,
                 backup_count=5,
                 cleanup_days=15):
    """设置日志记录器

    Args:
        name: 日志记录器名称
        log_level: 日志级别，如果为 None，则尝试从全局配置获取
        max_size: 单个日志文件最大大小（字节）
        backup_count: 保留的日志文件数量
        cleanup_days: 清理超过多少天的日志

    Returns:
        logging.Logger: 配置好的日志记录器
    """
    # 创建 logs 目录
    logs_dir = "logs"
    os.makedirs(logs_dir, exist_ok=True)

    # 设置日志级别
    if log_level is None:
        from core.bot_engine import BotEngine
        if hasattr(BotEngine, 'global_log_level'):
            level = BotEngine.global_log_level
        else:
            level = logging.INFO
    else:
        level = getattr(logging, log_level.upper(), logging.INFO)

    # 创建日志记录器
    logger = logging.getLogger(name)
    logger.setLevel(level)

    # 清除现有的处理器
    if logger.handlers:
        logger.handlers.clear()

    # 控制台处理器
    console_handler = logging.StreamHandler()
    console_handler.setLevel(level)

    # 文件处理器 - 使用 RotatingFileHandler 实现轮转
    log_file = os.path.join(logs_dir, f"{name}.log")
    file_handler = RotatingFileHandler(log_file,
                                       maxBytes=max_size,
                                       backupCount=backup_count,
                                       encoding='utf-8')
    file_handler.setLevel(level)

    # 格式化器
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler.setFormatter(formatter)
    file_handler.setFormatter(formatter)

    # 添加处理器
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)

    # 清理旧日志
    cleanup_old_logs(logs_dir, cleanup_days)

    return logger


def cleanup_old_logs(logs_dir="logs", days=15):
    """清理旧日志文件

    Args:
        logs_dir: 日志目录
        days: 保留的天数
    """
    if not os.path.exists(logs_dir):
        return

    # 创建一个只输出到控制台的日志记录器
    cleanup_logger = logging.getLogger("LogCleaner")
    # 清除现有的处理器
    if cleanup_logger.handlers:
        cleanup_logger.handlers.clear()
    # 只添加控制台处理器
    console_handler = logging.StreamHandler()
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler.setFormatter(formatter)
    cleanup_logger.addHandler(console_handler)
    cleanup_logger.setLevel(logging.INFO)

    # 当前时间
    now = time.time()
    # 最大保留时间（秒）
    max_age = days * 86400

    # 查找所有日志文件
    log_files = glob.glob(os.path.join(logs_dir, "*.log*"))

    for log_file in log_files:
        try:
            # 获取文件修改时间
            file_time = os.path.getmtime(log_file)
            # 如果文件超过保留期限，删除
            if now - file_time > max_age:
                os.remove(log_file)
                cleanup_logger.info(f"已删除过期日志文件: {log_file}")
        except Exception as e:
            cleanup_logger.error(f"清理日志文件 {log_file} 时出错: {e}")
