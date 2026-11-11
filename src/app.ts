import { Agent } from 'node:https';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { run, type RunnerHandle, type RunOptions } from '@grammyjs/runner';
import { Bot, GrammyError, HttpError } from 'grammy';
import type { Update } from 'grammy/types';
import pino, { type Logger } from 'pino';
import type { FastifyInstance } from 'fastify';
import type { RuntimeStatus } from '../shared/schemas/index.js';
import { AccessService } from './access.js';
import { ActionExecutor } from './actions.js';
import type { StartupConfig } from './config.js';
import { ConfigurationService } from './configuration.js';
import { AliasService } from './modules/alias.js';
import { RssService } from './modules/rss.js';
import { RateService } from './modules/rate.js';
import { WeatherService } from './modules/weather.js';
import { StickerService, type StickerTransport } from './modules/sticker.js';
import { SubconvService } from './modules/subconv.js';
import type { StickerConverter } from './modules/sticker-media.js';
import type { ProviderJson } from './modules/provider-http.js';
import type { FeedFetcher } from './modules/rss-feed.js';
import type { createRssSender } from './telegram/rss.js';
import { createStickerTransport } from './telegram/sticker.js';
import { commands } from './telegram/commands.js';
import { AppError, throwIfAborted } from './errors.js';
import { JsonStorage, type StorageOptions } from './storage.js';
import { createTelegramAdapter, createTelegramEffects } from './telegram/index.js';
import { telegramSignal } from './telegram/effects.js';
import type { WebDependencies } from './web/server.js';
import { AiService } from './ai/service.js';
import type { AiProvider, ProviderProfile } from './ai/providers.js';
import { ResourcePolicy } from './resources.js';
import { SystemMetrics } from './system-metrics.js';

export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member', 'stopped_message_generation'] as const;
export const RUNNER_CONCURRENCY = 16;

interface RunnerBot {
  handleUpdate: (update: Update) => Promise<void>;
  errorHandler: (error: unknown) => void;
  api: { getUpdates: Bot['api']['getUpdates'] };
}

export interface ApplicationOptions {
  bot?: Bot;
  logger?: Logger;
  runnerFactory?: (bot: RunnerBot, options: RunOptions<Update>) => RunnerHandle;
  webFactory?: (deps: WebDependencies) => Promise<FastifyInstance>;
  storage?: StorageOptions;
  shutdownGraceMs?: number;
  onTransportClosed?: () => void;
  rssFetcher?: FeedFetcher;
  rateJson?: ProviderJson;
  weatherJson?: ProviderJson;
  stickerTransport?: StickerTransport;
  stickerConverter?: StickerConverter;
  aiProvider?: (profile: ProviderProfile) => AiProvider;
  resources?: ResourcePolicy;
  statusMetrics?: Pick<SystemMetrics, 'start' | 'snapshot' | 'stop'>;
}

function apiCode(error: unknown): string {
  return error instanceof GrammyError ? `TELEGRAM_${error.error_code}`
    : error instanceof AppError ? error.code : 'TELEGRAM_NETWORK';
}

export function createApplication(config: StartupConfig, options: ApplicationOptions = {}) {
  const logger = options.logger ?? pino({ level: config.logLevel, base: undefined });
  const transport = new Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 4 });
  const bot = options.bot ?? new Bot(config.botToken, {
    client: { timeoutSeconds: config.requestTimeout, sensitiveLogs: false, baseFetchConfig: { agent: transport } },
  });
  const shutdown = new AbortController();
  const storage = new JsonStorage(config.dataDir, options.storage);
  const access = new AccessService(storage, config.adminIds);
  const configuration = new ConfigurationService(storage);
  const resources = options.resources ?? new ResourcePolicy({ heavyBytes: 64 * 1024 * 1024 });
  const statusMetrics = options.statusMetrics ?? new SystemMetrics();
  const ai = new AiService({ config, access, resources, storageLock: storage.lock, provider: options.aiProvider,
    stickerFile: async (context, reference) => {
      const { file, format, size } = await stickers.agentFile(context, reference);
      const mimeType = format === 'tgs' ? 'application/x-tgsticker' : format === 'webm' ? 'video/webm' : `image/${format}`;
      return { fileId: file.fileId, uniqueId: file.uniqueId, kind: 'sticker', mimeType, name: `sticker.${format}`, size };
    },
    isMember: async (chatId, userId, signal) => {
      const member = await bot.api.getChatMember(chatId, userId, telegramSignal(signal));
      return member.status !== 'left' && member.status !== 'kicked' && (member.status !== 'restricted' || member.is_member);
    } });
  const aliases = new AliasService(storage, commands.map(command => command.name));
  const rate = new RateService(storage, { key: config.providers?.exchangeRateKey, json: options.rateJson });
  const weather = new WeatherService(storage, { qweatherHost: config.providers?.qweatherHost, qweatherKey: config.providers?.qweatherKey,
    openWeatherKey: config.providers?.openWeatherKey, openMeteo: config.providers?.openMeteo, json: options.weatherJson });
  const stickers = new StickerService({ transport: options.stickerTransport ?? createStickerTransport(bot, config.botToken), convert: options.stickerConverter,
    resources, tempDirectory: join(config.dataDir, 'tmp', 'sticker') });
  const subconv = new SubconvService(storage);
  let initialized = false;
  let ready = false;
  let stopping = false;
  let startedAt = Date.now();
  let runner: RunnerHandle | undefined;
  let web: FastifyInstance | undefined;
  let startTask: Promise<void> | undefined;
  let closeTask: Promise<void> | undefined;
  let stopTask: Promise<void> | undefined;
  let failure: AppError | undefined;
  const inFlight = new Set<Promise<void>>();
  const health: RuntimeStatus = {
    uptimeSeconds: 0, updateCount: 0, authorizedGroupCount: 0,
    polling: 'stopped', http: config.web.enabled ? 'stopped' : 'disabled', lastApiError: null,
  };
  const metrics = {
    recordUpdate: () => { health.updateCount += 1; },
    recordApiError: (code: string) => {
      health.lastApiError = { code: /^[A-Z_0-9]{1,64}$/.test(code) ? code : 'TELEGRAM_ERROR', at: new Date().toISOString() };
    },
  };
  const status = (): RuntimeStatus => ({
    ...health, lastApiError: health.lastApiError ? { ...health.lastApiError } : null,
    uptimeSeconds: Math.max(0, (Date.now() - startedAt) / 1000),
    authorizedGroupCount: initialized ? access.count() : 0,
    resources: statusMetrics.snapshot(),
  });
  let rssSender: Promise<ReturnType<typeof createRssSender>> | undefined;
  const rss = new RssService(storage, {
    allowed: target => target.kind === 'private' || access.isAllowed(target.chatId),
    send: async (target, title, payload, language, silent, signal) => {
      throwIfAborted(signal);
      const send = await (rssSender ??= import('./telegram/rss.js').then(module => module.createRssSender(bot)));
      throwIfAborted(signal);
      await send(target, title, payload,
        target.kind === 'private' ? configuration.resolveLanguage(target.chatId, language) : language, silent, signal);
      try {
        ai.emitModuleEvent('rss.delivered', createHash('sha256').update(JSON.stringify(payload)).digest('hex'), {
          botId: Number(config.botToken.split(':', 1)[0]), chatId: target.chatId, ...(target.threadId ? { threadId: target.threadId } : {}),
          ...(target.kind === 'private' ? { ownerId: target.chatId } : {}) });
      } catch { logger.warn({ event: 'ai_event_capacity' }); }
    },
    fetcher: options.rssFetcher,
    onError: error => {
      if (stopping) return;
      failure = error instanceof AppError ? error : new AppError('INTERNAL_ERROR');
      logger.error({ event: 'rss_stopped', code: failure.code });
      void stop().catch(() => undefined);
    },
  });
  bot.api.config.use(async (previous, method, payload, signal) => {
    try {
      const response = await previous(method, payload, signal);
      if (!response.ok) metrics.recordApiError(`TELEGRAM_${response.error_code}`);
      return response;
    } catch (error) {
      if (!signal?.aborted) metrics.recordApiError(apiCode(error));
      throw error;
    }
  });
  const executor = new ActionExecutor({
    access, configuration, aliases, rss, rate, weather, stickers, subconv, ai, effects: createTelegramEffects(bot, configuration, metrics, config.adminIds), status,
    aiPolicy: { available: context => ai.available(context), authorize: (context, id, effect) => ai.authorize(context, id, effect),
      approvalExempt: (context, id) => ai.approvalExempt(context, id) },
    aiNativeDelivery: (context, file) => ai.deliverNative(context, file),
    onResult: (context, id, result) => ai.observeAction(context, id, result),
    audit: record => logger.info({ event: 'action', ...record }),
    groupAdmin: async (chatId, userId, signal) => {
      const member = await bot.api.getChatMember(chatId, userId, telegramSignal(signal));
      return member.status === 'administrator' || member.status === 'creator';
    },
  });
  ai.attachExecutor(executor);
  const telegram = createTelegramAdapter(bot, { config, executor, access, configuration, stickers, ai, health: metrics, signal: shutdown.signal });
  const completion = Promise.withResolvers<void>();
  // Consumers may attach after start; an early startup failure must not be unhandled.
  void completion.promise.catch(() => undefined);

  async function poll(args: Parameters<Bot['api']['getUpdates']>[0], signal?: Parameters<Bot['api']['getUpdates']>[1]): Promise<Update[]> {
    const request = new AbortController();
    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });
    shutdown.signal.addEventListener('abort', abort, { once: true });
    if (signal?.aborted || shutdown.signal.aborted) request.abort();
    const deadline = Date.now() + 60_000;
    let backoff = 250;
    try {
      for (;;) {
        throwIfAborted(request.signal);
        try { return await bot.api.getUpdates(args, telegramSignal(request.signal)); }
        catch (error) {
          throwIfAborted(request.signal);
          metrics.recordApiError(apiCode(error));
          const retryable = error instanceof HttpError || error instanceof GrammyError && (error.error_code === 429 || error.error_code >= 500);
          const wait = error instanceof GrammyError && error.error_code === 429
            ? Math.max(250, (error.parameters.retry_after ?? 1) * 1000) : backoff;
          if (!retryable || Date.now() + wait > deadline) throw new AppError('UNAVAILABLE');
          // Only getUpdates is retried, with real cancellable backoff. Handlers are never replayed.
          await delay(wait, undefined, { signal: request.signal });
          backoff = Math.min(backoff * 2, 5_000);
        }
      }
    } finally {
      signal?.removeEventListener('abort', abort);
      shutdown.signal.removeEventListener('abort', abort);
    }
  }

  const runnerBot: RunnerBot = {
    api: { getUpdates: poll },
    handleUpdate: (update: Update) => {
      if (stopping) return Promise.resolve();
      const task = bot.handleUpdate(update);
      inFlight.add(task);
      void task.then(() => inFlight.delete(task), () => inFlight.delete(task));
      return task;
    },
    errorHandler: error => {
      if (!shutdown.signal.aborted) logger.warn({ event: 'update_failed', code: apiCode(error) });
    },
  };

  function unexpected(component: 'polling' | 'http'): void {
    if (stopping) return;
    failure = new AppError('UNAVAILABLE');
    health[component] = 'failed';
    logger.error({ event: 'component_stopped', component, code: failure.code });
    void stop().catch(() => undefined);
  }

  function cleanup(): Promise<void> {
    if (closeTask) return closeTask;
    stopping = true;
    closeTask = (async () => {
      if (health.polling !== 'failed') health.polling = 'stopping';
      if (web && health.http !== 'failed') health.http = 'stopping';
      const cancel = setTimeout(() => shutdown.abort(), options.shutdownGraceMs ?? 5_000);
      if (!ready) shutdown.abort();
      try {
        // runner.stop() does not account for all sink tasks; track and drain them ourselves.
        const stoppedRunner = Promise.resolve().then(() => runner?.stop());
        const stoppedWeb = Promise.resolve().then(() => web?.close());
        const stoppedRss = rss.stop();
        const results = await Promise.allSettled([stoppedRunner, stoppedWeb, stoppedRss, rate.stop(), weather.stop(), stickers.stop(), ai.stop(false), subconv.stop(), statusMetrics.stop(), ...inFlight]);
        if (!failure && (results.slice(0, 9).some(result => result.status === 'rejected')
          || !shutdown.signal.aborted && results.some(result => result.status === 'rejected'))) failure = new AppError('UNAVAILABLE');
        shutdown.abort();
        for (const close of [() => executor.close(), () => telegram.stop(), () => ai.stop(), () => storage.close()]) {
          try { await close(); }
          catch { failure ??= new AppError('UNAVAILABLE'); }
        }
        if (web?.server.listening) {
          web.server.closeAllConnections();
          await new Promise<void>(resolve => web!.server.close(() => resolve()));
        }
      } finally {
        clearTimeout(cancel);
        shutdown.abort();
        transport.destroy();
        options.onTransportClosed?.();
        health.polling = failure && health.polling === 'failed' ? 'failed' : 'stopped';
        if (config.web.enabled) health.http = failure && health.http === 'failed' ? 'failed' : 'stopped';
        logger.info({ event: 'application_stopped', code: failure?.code ?? 'STOPPED' });
        if (failure) completion.reject(failure);
        else completion.resolve();
      }
    })();
    return closeTask;
  }

  function start(): Promise<void> {
    if (stopping) return Promise.reject(new AppError('CANCELLED'));
    if (startTask) return startTask;
    startTask = (async () => {
      try {
        startedAt = Date.now();
        health.polling = 'starting';
        await storage.initialize();
        await access.initialize();
        await configuration.initialize();
        await aliases.initialize();
        await rss.initialize();
        await rate.initialize();
        await weather.initialize();
        await subconv.initialize();
        await ai.initialize();
        await statusMetrics.start();
        initialized = true;
        throwIfAborted(shutdown.signal);
        if (config.web.enabled) {
          health.http = 'starting';
          const createWebServer = options.webFactory ?? (await import('./web/server.js')).createWebServer;
          throwIfAborted(shutdown.signal);
          web = await createWebServer({ config, executor, configuration, access, botId: () => bot.botInfo.id, signal: shutdown.signal });
        }
        await bot.init(telegramSignal(shutdown.signal));
        if (bot.botInfo.id !== Number(config.botToken.split(':')[0])) throw new AppError('UNAUTHORIZED');
        await bot.api.deleteWebhook({ drop_pending_updates: config.dropPendingUpdates }, telegramSignal(shutdown.signal));
        await telegram.registerMenus();
        ai.startBackground();
        throwIfAborted(shutdown.signal);
        if (web) {
          await web.listen({ host: config.web.host, port: config.web.port });
          health.http = 'running';
          web.server.on('error', () => unexpected('http'));
          web.server.once('close', () => unexpected('http'));
        }
        throwIfAborted(shutdown.signal);
        runner = (options.runnerFactory ?? run)(runnerBot, {
          sink: { concurrency: RUNNER_CONCURRENCY },
          runner: { fetch: { timeout: config.pollingTimeout, allowed_updates: ALLOWED_UPDATES }, maxRetryTime: 0, silent: true },
        });
        const task = runner.task();
        if (!task || !runner.isRunning()) throw new AppError('UNAVAILABLE');
        health.polling = 'running';
        ready = true;
        rss.start();
        void task.then(() => unexpected('polling'), () => unexpected('polling'));
        logger.info({ event: 'application_ready', botId: bot.botInfo.id, webEnabled: config.web.enabled });
      } catch (error) {
        if (!stopping) { failure = error instanceof AppError ? error : new AppError('UNAVAILABLE'); health.polling = 'failed'; }
        await cleanup();
        throw failure ?? new AppError('CANCELLED');
      }
    })();
    return startTask;
  }

  function stop(): Promise<void> {
    if (stopTask) return stopTask;
    stopping = true;
    if (!ready) shutdown.abort();
    stopTask = (async () => {
      if (startTask && !ready) await startTask.catch(() => undefined);
      await cleanup();
    })();
    return stopTask;
  }

  return { start, stop, done: completion.promise, status, bot, executor, access, configuration, rss, rate, weather, ai,
    get web() { return web; }, get runner() { return runner; } };
}
