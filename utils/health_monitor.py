# utils/health_monitor.py

import asyncio
import time
from datetime import datetime
from telegram.error import TimedOut, RetryAfter, NetworkError
from utils.logger import setup_logger


class HealthMonitor:
    """机器人健康监控系统"""

    def __init__(self,
                 bot_engine,
                 check_interval=60,
                 failure_threshold=3,
                 recovery_timeout=300):
        """初始化健康监控器
        
        Args:
            bot_engine: 机器人引擎实例
            check_interval: 健康检查间隔（秒）
            failure_threshold: 连续失败多少次触发恢复
            recovery_timeout: 恢复操作超时时间（秒）
        """
        self.bot_engine = bot_engine
        self.check_interval = check_interval
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout

        # 使用项目统一的日志设置方式
        self.logger = setup_logger("HealthMonitor")

        self.monitor_task = None
        self.consecutive_failures = 0
        self.last_successful_check = time.time()
        self.is_recovering = False
        self.health_status = {
            "status": "starting",
            "last_check": None,
            "failures": 0,
            "recoveries": 0,
            "last_recovery": None,
            "components": {}
        }

    async def start_monitoring(self):
        """启动健康监控"""
        if self.monitor_task is None or self.monitor_task.done():
            self.monitor_task = asyncio.create_task(self._monitoring_loop())
            self.logger.info("健康监控系统已启动")

    async def stop_monitoring(self):
        """停止健康监控"""
        if self.monitor_task and not self.monitor_task.done():
            self.monitor_task.cancel()
            try:
                await self.monitor_task
            except asyncio.CancelledError:
                pass
            self.logger.info("健康监控系统已停止")

    async def _monitoring_loop(self):
        """健康监控主循环"""
        try:
            while True:
                try:
                    # 执行健康检查
                    healthy = await self._check_health()

                    if healthy:
                        # 重置失败计数
                        self.consecutive_failures = 0
                        self.last_successful_check = time.time()
                        self.health_status["status"] = "healthy"
                    else:
                        # 增加失败计数
                        self.consecutive_failures += 1
                        self.health_status["failures"] += 1
                        self.health_status["status"] = "degraded"

                        self.logger.warning(
                            f"健康检查失败 ({self.consecutive_failures}/{self.failure_threshold})"
                        )

                        # 如果连续失败达到阈值，尝试恢复
                        if self.consecutive_failures >= self.failure_threshold and not self.is_recovering:
                            self.logger.error(
                                f"连续 {self.consecutive_failures} 次健康检查失败，启动恢复流程"
                            )
                            # 创建恢复任务
                            recovery_task = asyncio.create_task(
                                self._recover())
                            # 不等待恢复完成，继续监控循环

                    # 更新健康状态
                    self.health_status["last_check"] = datetime.now().strftime(
                        "%Y-%m-%d %H:%M:%S")

                except Exception as e:
                    self.logger.error(f"健康监控循环出错: {e}", exc_info=True)

                # 等待下一次检查
                await asyncio.sleep(self.check_interval)

        except asyncio.CancelledError:
            self.logger.info("健康监控循环已取消")
            raise

    async def _check_health(self):
        """执行健康检查
        
        Returns:
            bool: 是否健康
        """
        try:
            components_status = {}
            all_healthy = True

            # 1. 检查网络连接
            network_healthy = await self._check_telegram_api()
            components_status["network"] = {
                "status":
                "healthy" if network_healthy else "unhealthy",
                "details":
                "Telegram API 连接正常" if network_healthy else "Telegram API 连接异常"
            }
            all_healthy = all_healthy and network_healthy

            # 2. 检查模块加载器
            module_loader_healthy = self._check_module_loader()
            components_status["module_loader"] = {
                "status": "healthy" if module_loader_healthy else "unhealthy",
                "details": "模块加载器正常" if module_loader_healthy else "模块加载器异常"
            }
            all_healthy = all_healthy and module_loader_healthy

            # 3. 检查配置管理器
            config_healthy = self._check_config_manager()
            components_status["config_manager"] = {
                "status": "healthy" if config_healthy else "unhealthy",
                "details": "配置管理器正常" if config_healthy else "配置管理器异常"
            }
            all_healthy = all_healthy and config_healthy

            # 4. 检查命令处理器
            command_healthy = self._check_command_processor()
            components_status["command_processor"] = {
                "status": "healthy" if command_healthy else "unhealthy",
                "details": "命令处理器正常" if command_healthy else "命令处理器异常"
            }
            all_healthy = all_healthy and command_healthy

            # 5. 检查事件系统
            event_healthy = self._check_event_system()
            components_status["event_system"] = {
                "status": "healthy" if event_healthy else "unhealthy",
                "details": "事件系统正常" if event_healthy else "事件系统异常"
            }
            all_healthy = all_healthy and event_healthy

            # 6. 检查会话管理器
            session_healthy = self._check_session_manager()
            components_status["session_manager"] = {
                "status": "healthy" if session_healthy else "unhealthy",
                "details": "会话管理器正常" if session_healthy else "会话管理器异常"
            }
            all_healthy = all_healthy and session_healthy

            # 更新组件状态
            self.health_status["components"] = components_status

            return all_healthy

        except Exception as e:
            self.logger.error(f"健康检查过程出错: {e}", exc_info=True)
            return False

    async def _check_telegram_api(self):
        """检查 Telegram API 连接
        
        Returns:
            bool: 是否连接正常
        """
        try:
            # 尝试获取 bot 信息作为连接测试
            bot = self.bot_engine.application.bot
            me = await bot.get_me()
            return me is not None
        except (TimedOut, RetryAfter, NetworkError) as e:
            self.logger.warning(f"Telegram API 连接检查失败: {e}")
            return False
        except Exception as e:
            self.logger.error(f"Telegram API 连接检查出错: {e}")
            return False

    def _check_module_loader(self):
        """检查模块加载器
        
        Returns:
            bool: 是否正常
        """
        try:
            module_loader = self.bot_engine.module_loader
            # 检查模块加载器是否存在且能够发现模块
            return module_loader is not None and isinstance(
                module_loader.loaded_modules, dict)
        except Exception as e:
            self.logger.error(f"模块加载器检查出错: {e}")
            return False

    def _check_config_manager(self):
        """检查配置管理器
        
        Returns:
            bool: 是否正常
        """
        try:
            config_manager = self.bot_engine.config_manager
            # 检查配置管理器是否存在且能够访问主配置
            return (config_manager is not None
                    and isinstance(config_manager.main_config, dict)
                    and isinstance(config_manager.modules_config, dict))
        except Exception as e:
            self.logger.error(f"配置管理器检查出错: {e}")
            return False

    def _check_command_processor(self):
        """检查命令处理器
        
        Returns:
            bool: 是否正常
        """
        try:
            command_processor = self.bot_engine.command_processor
            # 检查命令处理器是否存在且能够访问命令处理器
            return (command_processor is not None
                    and isinstance(command_processor.command_handlers, dict))
        except Exception as e:
            self.logger.error(f"命令处理器检查出错: {e}")
            return False

    def _check_event_system(self):
        """检查事件系统
        
        Returns:
            bool: 是否正常
        """
        try:
            event_system = self.bot_engine.event_system
            # 检查事件系统是否存在
            return event_system is not None and hasattr(
                event_system, 'subscribers')
        except Exception as e:
            self.logger.error(f"事件系统检查出错: {e}")
            return False

    def _check_session_manager(self):
        """检查会话管理器
        
        Returns:
            bool: 是否正常
        """
        try:
            session_manager = self.bot_engine.session_manager
            # 检查会话管理器是否存在
            return session_manager is not None and hasattr(
                session_manager, 'sessions')
        except Exception as e:
            self.logger.error(f"会话管理器检查出错: {e}")
            return False

    async def _recover(self):
        """执行恢复操作"""
        if self.is_recovering:
            self.logger.warning("已有恢复操作正在进行，跳过")
            return

        self.is_recovering = True
        self.logger.info("开始执行恢复操作")
        self.health_status["status"] = "recovering"

        try:
            # 记录恢复开始时间
            recovery_start = time.time()
            self.health_status["last_recovery"] = datetime.now().strftime(
                "%Y-%m-%d %H:%M:%S")
            self.health_status["recoveries"] += 1

            # 1. 尝试重新连接 Telegram API
            if not await self._check_telegram_api():
                self.logger.info("尝试重新连接 Telegram API")
                await self._restart_bot_polling()

            # 2. 尝试重新加载配置
            if not self._check_config_manager():
                self.logger.info("尝试重新加载配置")
                await self._reload_config()

            # 3. 尝试重新加载模块
            if not self._check_module_loader():
                self.logger.info("尝试重新加载模块")
                await self._reload_modules()

            # 4. 尝试重置命令处理器
            if not self._check_command_processor():
                self.logger.info("尝试重置命令处理器")
                await self._reset_command_processor()

            # 5. 尝试重置事件系统
            if not self._check_event_system():
                self.logger.info("尝试重置事件系统")
                await self._reset_event_system()

            # 6. 尝试重置会话管理器
            if not self._check_session_manager():
                self.logger.info("尝试重置会话管理器")
                await self._reset_session_manager()

            # 检查恢复是否超时
            if time.time() - recovery_start > self.recovery_timeout:
                self.logger.error(f"恢复操作超时（{self.recovery_timeout}秒），执行完全重启")
                await self._full_restart()

            # 恢复后再次检查健康状态
            healthy = await self._check_health()
            if healthy:
                self.logger.info("恢复操作成功，系统恢复正常")
                self.consecutive_failures = 0
                self.health_status["status"] = "healthy"
            else:
                self.logger.error("恢复操作后系统仍不健康，执行完全重启")
                await self._full_restart()

        except Exception as e:
            self.logger.error(f"恢复操作过程中出错: {e}", exc_info=True)
            # 如果恢复过程中出错，尝试完全重启
            await self._full_restart()
        finally:
            self.is_recovering = False

    async def _restart_bot_polling(self):
        """重启 Bot 轮询"""
        try:
            # 停止当前轮询
            if hasattr(self.bot_engine.application,
                       'updater') and self.bot_engine.application.updater:
                await self.bot_engine.application.updater.stop()

            # 重新启动轮询
            await self.bot_engine.application.updater.start_polling(
                poll_interval=self.bot_engine.poll_interval,
                timeout=self.bot_engine.read_timeout,
                bootstrap_retries=5,
                drop_pending_updates=False,
                allowed_updates=None,
                error_callback=self.bot_engine.polling_error_callback)

            self.logger.info("Bot 轮询已重启")
            return True
        except Exception as e:
            self.logger.error(f"重启 Bot 轮询失败: {e}", exc_info=True)
            return False

    async def _reload_config(self):
        """重新加载配置"""
        try:
            self.bot_engine.config_manager.reload_all_configs()
            self.logger.info("配置已重新加载")
            return True
        except Exception as e:
            self.logger.error(f"重新加载配置失败: {e}", exc_info=True)
            return False

    async def _reload_modules(self):
        """重新加载模块"""
        try:
            # 获取当前已加载的模块列表
            loaded_modules = list(
                self.bot_engine.module_loader.loaded_modules.keys())

            # 先卸载所有模块
            for module_name in loaded_modules:
                await self.bot_engine.unload_single_module(module_name)

            # 重新加载模块
            await self.bot_engine.load_modules()

            self.logger.info("模块已重新加载")
            return True
        except Exception as e:
            self.logger.error(f"重新加载模块失败: {e}", exc_info=True)
            return False

    async def _reset_command_processor(self):
        """重置命令处理器"""
        try:
            # 重新初始化命令处理器
            self.bot_engine.command_processor = self.bot_engine.command_processor.__class__(
                self.bot_engine.application)

            # 重新注册核心命令
            self.bot_engine.command_processor.register_core_commands(
                self.bot_engine)

            self.logger.info("命令处理器已重置")
            return True
        except Exception as e:
            self.logger.error(f"重置命令处理器失败: {e}", exc_info=True)
            return False

    async def _reset_event_system(self):
        """重置事件系统"""
        try:
            # 创建新的事件系统
            from utils.event_system import EventSystem
            self.bot_engine.event_system = EventSystem()

            # 更新 bot_data 中的引用
            self.bot_engine.application.bot_data[
                "event_system"] = self.bot_engine.event_system

            self.logger.info("事件系统已重置")
            return True
        except Exception as e:
            self.logger.error(f"重置事件系统失败: {e}", exc_info=True)
            return False

    async def _reset_session_manager(self):
        """重置会话管理器"""
        try:
            # 停止当前的清理任务
            if hasattr(self.bot_engine.session_manager, 'cleanup_task'
                       ) and self.bot_engine.session_manager.cleanup_task:
                await self.bot_engine.session_manager.stop_cleanup()

            # 创建新的会话管理器
            from utils.session_manager import SessionManager
            self.bot_engine.session_manager = SessionManager()

            # 更新 bot_data 中的引用
            self.bot_engine.application.bot_data[
                "session_manager"] = self.bot_engine.session_manager

            # 启动清理任务
            await self.bot_engine.session_manager.start_cleanup()

            self.logger.info("会话管理器已重置")
            return True
        except Exception as e:
            self.logger.error(f"重置会话管理器失败: {e}", exc_info=True)
            return False

    async def _full_restart(self):
        """执行完全重启
        
        这是最后的恢复手段，尝试完全停止并重启机器人
        """
        self.logger.critical("执行完全重启")

        try:
            # 1. 尝试优雅地停止机器人
            try:
                await self.bot_engine.stop()
            except Exception as e:
                self.logger.error(f"停止机器人失败: {e}", exc_info=True)

            # 2. 等待一小段时间
            await asyncio.sleep(2)

            # 3. 重新初始化关键组件
            # 重新初始化配置管理器
            from core.config_manager import ConfigManager
            self.bot_engine.config_manager = ConfigManager()

            # 重新初始化 Telegram 应用
            token = self.bot_engine.config_manager.get_token()
            from telegram.ext import Application
            builder = Application.builder().token(token)

            # 如果配置了代理，应用代理设置
            proxy_url = self.bot_engine.config_manager.main_config.get(
                "proxy_url", None)
            if proxy_url:
                builder = builder.proxy_url(proxy_url)

            self.bot_engine.application = builder.build()

            # 更新 bot_data
            self.bot_engine.application.bot_data[
                "config_manager"] = self.bot_engine.config_manager
            self.bot_engine.application.bot_data[
                "bot_engine"] = self.bot_engine

            # 重新初始化事件系统
            from utils.event_system import EventSystem
            self.bot_engine.event_system = EventSystem()
            self.bot_engine.application.bot_data[
                "event_system"] = self.bot_engine.event_system

            # 重新初始化模块加载器
            from core.module_loader import ModuleLoader
            self.bot_engine.module_loader = ModuleLoader()

            # 重新初始化会话管理器
            from utils.session_manager import SessionManager
            self.bot_engine.session_manager = SessionManager()
            self.bot_engine.application.bot_data[
                "session_manager"] = self.bot_engine.session_manager

            # 重新初始化命令处理器
            from core.command_handler import CommandProcessor
            self.bot_engine.command_processor = CommandProcessor(
                self.bot_engine.application)

            # 注册核心命令
            self.bot_engine.command_processor.register_core_commands(
                self.bot_engine)

            # 注册错误处理器
            self.bot_engine.application.add_error_handler(
                self.bot_engine.handle_error)

            # 4. 重新启动机器人
            await self.bot_engine.run()

            self.logger.info("机器人已完全重启")
            return True

        except Exception as e:
            self.logger.critical(f"完全重启失败: {e}", exc_info=True)

            # 如果完全重启失败，发送管理员通知
            await self._notify_admins_of_failure("机器人完全重启失败，需要手动干预。")
            return False

    async def _notify_admins_of_failure(self, message):
        """通知管理员系统故障"""
        try:
            admin_ids = self.bot_engine.config_manager.get_valid_admin_ids()
            bot = self.bot_engine.application.bot

            for admin_id in admin_ids:
                try:
                    await bot.send_message(
                        chat_id=admin_id,
                        text=
                        f"⚠️ 系统警告 ⚠️\n\n{message}\n\n时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}"
                    )
                except Exception as e:
                    self.logger.error(f"无法向管理员 {admin_id} 发送通知: {e}")

        except Exception as e:
            self.logger.error(f"发送管理员通知失败: {e}", exc_info=True)

    def get_health_status(self):
        """获取健康状态报告
        
        Returns:
            dict: 健康状态报告
        """
        # 添加一些额外信息
        status = dict(self.health_status)
        status["uptime"] = time.time() - self.bot_engine.stats["start_time"]
        status["consecutive_failures"] = self.consecutive_failures

        return status
