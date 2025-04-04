# utils/logger.py
import logging
import os
from datetime import datetime


def setup_logger(name, log_level="INFO"):
    """设置日志记录器"""
    # 创建 logs 目录
    os.makedirs("logs", exist_ok=True)

    # 设置日志级别
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

    # 文件处理器 - 使用日期进行轮转
    log_file = f"logs/{name}_{datetime.now().strftime('%Y%m%d')}.log"
    file_handler = logging.FileHandler(log_file, encoding='utf-8')
    file_handler.setLevel(level)

    # 格式化器
    formatter = logging.Formatter(
        '%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    console_handler.setFormatter(formatter)
    file_handler.setFormatter(formatter)

    # 添加处理器
    logger.addHandler(console_handler)
    logger.addHandler(file_handler)

    return logger
