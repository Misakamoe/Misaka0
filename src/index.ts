import pino from 'pino';
import { createApplication } from './app.js';
import { ConfigurationError, loadConfig } from './config.js';
import { AppError } from './errors.js';

async function main(): Promise<void> {
  const config = await loadConfig();
  const logger = pino({ level: config.logLevel, base: undefined });
  const application = createApplication(config, { logger });
  let watchdog: NodeJS.Timeout | undefined;
  let shutdownRequested = false;
  const shutdown = () => {
    shutdownRequested = true;
    watchdog ??= setTimeout(() => {
      logger.fatal({ event: 'shutdown_deadline', code: 'TIMEOUT' });
      process.exit(1);
    }, 15_000);
    void application.stop().catch(() => { process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  try {
    await application.start();
    await application.done;
  } catch (error) {
    if (!shutdownRequested || !(error instanceof AppError) || error.code !== 'CANCELLED') throw error;
    await application.done;
  } finally {
    await application.stop();
    if (watchdog) clearTimeout(watchdog);
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', shutdown);
  }
}

void main().catch(error => {
  // Never print raw framework errors, URLs, environment, or exception inputs.
  const logger = pino({ level: 'error', base: undefined });
  logger.error({ event: 'startup_failed', code: error instanceof ConfigurationError ? 'CONFIG_INVALID' : error instanceof AppError ? error.code : 'UNAVAILABLE',
    ...(error instanceof ConfigurationError ? { fields: error.fields } : {}) });
  process.exitCode = 1;
});
