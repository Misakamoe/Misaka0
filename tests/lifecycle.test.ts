import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { Agent } from 'node:https';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import Fastify from 'fastify';
import { Bot } from 'grammy';
import type { Update, UserFromGetMe } from 'grammy/types';
import { run, type RunnerHandle } from '@grammyjs/runner';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ALLOWED_UPDATES, RUNNER_CONCURRENCY, createApplication, type ApplicationOptions } from '../src/app.js';
import { createInvocation } from '../src/actions.js';
import type { StartupConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { createWebServer } from '../src/web/server.js';
import { menuCommands } from '../src/telegram/commands.js';

type RunnerInput = Parameters<NonNullable<ApplicationOptions['runnerFactory']>>[0];
type RunnerOptions = Parameters<NonNullable<ApplicationOptions['runnerFactory']>>[1];
type ApiCall = { method: string; payload: Record<string, unknown>; signal?: AbortSignal };
const me: UserFromGetMe = {
  id: 12345, is_bot: true, first_name: 'Lifecycle', username: 'lifecycle_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
const cleanups: (() => Promise<unknown>)[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); })));
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function fixture(options: {
  web?: boolean;
  port?: number;
  dropPending?: boolean;
  storage?: ApplicationOptions['storage'];
  graceMs?: number;
  runnerFactory?: ApplicationOptions['runnerFactory'];
  webFactory?: ApplicationOptions['webFactory'];
  statusMetrics?: ApplicationOptions['statusMetrics'];
} = {}) {
  const directory = await mkdtemp('/tmp/kilo/lifecycle-');
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const staticRoot = join(directory, 'public');
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><title>Offline lifecycle</title>');
  const config: StartupConfig = {
    botToken: '12345:OFFLINE_TEST_TOKEN_NEVER_NETWORK', adminIds: [1], dataDir: join(directory, 'state'), logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: options.dropPending ?? false,
    web: { enabled: options.web ?? true, host: '127.0.0.1', port: options.port ?? 0,
      publicBaseUrl: 'https://lifecycle.example', oidcClientId: '12345', oidcClientSecret: 'offline-client-secret' },
  };
  const calls: ApiCall[] = [];
  const trace: string[] = [];
  const network = vi.fn(() => { throw new Error('Telegram network forbidden'); });
  const bot = new Bot(config.botToken, { client: { fetch: network } });
  let apiHook: ((call: ApiCall) => Promise<unknown> | unknown) | undefined;
  bot.api.config.use(async (_previous, method, payload, suppliedSignal) => {
    const signal = suppliedSignal as unknown as AbortSignal | undefined;
    if (signal?.aborted) throw new AppError('CANCELLED');
    const call: ApiCall = { method, payload: payload as Record<string, unknown>, signal };
    calls.push(call);
    trace.push(`api:${method}`);
    const override = await apiHook?.(call);
    if (override !== undefined) return override as never;
    const result: unknown = method === 'getMe' ? me : method === 'getUpdates' ? []
      : method === 'sendMessage' || method === 'sendRichMessage' ? { message_id: 1, date: 100, chat: { id: call.payload.chat_id, type: 'private' } }
      : true;
    return { ok: true, result } as never;
  });
  const runnerTask = Promise.withResolvers<void>();
  void runnerTask.promise.catch(() => undefined);
  let running = false;
  let stopHook: (() => Promise<void>) | undefined;
  const runner: RunnerHandle = {
    start: vi.fn(() => { running = true; }),
    stop: vi.fn(async () => {
      trace.push('runner:stop'); running = false; runnerTask.resolve();
      await stopHook?.(); trace.push('runner:drained');
    }),
    size: () => 0, isRunning: () => running, task: () => running ? runnerTask.promise : undefined,
  };
  let runnerInput!: RunnerInput;
  let runnerOptions!: RunnerOptions;
  const runnerFactory = vi.fn((input: RunnerInput, runOptions: RunnerOptions) => {
    runnerInput = input; runnerOptions = runOptions; trace.push('runner:start'); running = true;
    return options.runnerFactory ? options.runnerFactory(input, runOptions) : runner;
  });
  const webFactory = vi.fn(async (deps: Parameters<NonNullable<ApplicationOptions['webFactory']>>[0]) => {
    trace.push('web:factory');
    const server = await (options.webFactory ? options.webFactory(deps) : createWebServer({ ...deps, staticRoot }));
    server.server.on('listening', () => trace.push('web:listening'));
    server.server.on('close', () => trace.push('web:closed'));
    trace.push('web:ready');
    return server;
  });
  const transportClosed = vi.fn(() => { trace.push('transport:closed'); });
  const app = createApplication(config, {
    bot, runnerFactory, webFactory, shutdownGraceMs: options.graceMs ?? 10, onTransportClosed: transportClosed,
    statusMetrics: options.statusMetrics,
    storage: { beforeCommit: async (filename, signal) => {
      trace.push(`store:${filename}`); await options.storage?.beforeCommit?.(filename, signal);
    } },
  });
  cleanups.push(() => app.stop().catch(() => undefined));
  const done = app.done.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
  const update = (command = '/id'): Update => ({ update_id: 1, message: {
    message_id: 1, date: 100, chat: { id: 1, type: 'private', first_name: 'Admin' },
    from: { id: 1, is_bot: false, first_name: 'Admin', language_code: 'en' }, text: command,
    entities: [{ type: 'bot_command', offset: 0, length: command.length }],
  } });
  return { app, config, directory, bot, calls, trace, network, runnerFactory, runner, webFactory, transportClosed, done, update,
    get runnerInput() { return runnerInput; }, get runnerOptions() { return runnerOptions; },
    hookApi: (hook: NonNullable<typeof apiHook>) => { apiHook = hook; },
    hookStop: (hook: NonNullable<typeof stopHook>) => { stopHook = hook; },
    endRunner: () => { running = false; runnerTask.resolve(); },
    crashRunner: () => { running = false; runnerTask.reject(new Error('private upstream exception')); },
  };
}

describe('application construction and startup', () => {
  it('starts one cached status sampler and drains it before closing the runtime', async () => {
    const release = Promise.withResolvers<void>();
    const metrics = { start: vi.fn(async () => {}), snapshot: vi.fn(() => undefined), stop: vi.fn(async () => release.promise) };
    const f = await fixture({ web: false, statusMetrics: metrics });
    expect(metrics.start).not.toHaveBeenCalled();
    await f.app.start();
    expect(metrics.start).toHaveBeenCalledOnce();
    f.app.status(); expect(metrics.snapshot).toHaveBeenCalledOnce();
    const closing = f.app.stop();
    await vi.waitFor(() => expect(metrics.stop).toHaveBeenCalledOnce());
    expect(f.transportClosed).not.toHaveBeenCalled();
    release.resolve(); await closing;
    expect(f.transportClosed).toHaveBeenCalledOnce();
    await f.app.stop(); expect(metrics.stop).toHaveBeenCalledOnce();
  });

  it('imports and constructs without API calls, listeners, storage writes, or polling', async () => {
    const signals = [process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')];
    vi.resetModules();
    const imported = await import('../src/app.js');
    expect(typeof imported.createApplication).toBe('function');
    expect([process.listenerCount('SIGINT'), process.listenerCount('SIGTERM')]).toEqual(signals);
    const f = await fixture();
    expect(f.trace).toEqual([]);
    expect(f.calls).toEqual([]);
    expect(f.network).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(f.webFactory).not.toHaveBeenCalled();
    expect(f.runnerFactory).not.toHaveBeenCalled();
    expect(await readdir(f.directory)).toEqual(['public']);
    expect(f.app.web).toBeUndefined();
    expect(f.app.runner).toBeUndefined();
    await f.app.stop();
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(await f.done).toEqual({ ok: true });
  });

  it('isolates instances, storage, health, runners and shutdown', async () => {
    const first = await fixture({ web: false });
    const second = await fixture({ web: false });
    await Promise.all([first.app.start(), second.app.start()]);
    await first.runnerInput.handleUpdate(first.update());
    expect(first.app.status().updateCount).toBe(1);
    expect(second.app.status().updateCount).toBe(0);
    await first.app.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
    expect(second.app.configuration.settings().effective.defaultLanguage).toBe('zh-CN');
    await first.app.stop();
    expect(second.app.status().polling).toBe('running');
    expect(second.transportClosed).not.toHaveBeenCalled();
    expect(first.runnerFactory).toHaveBeenCalledOnce();
    expect(second.runnerFactory).toHaveBeenCalledOnce();
  });

  it('loads/registers before identity, webhook cleanup, menus, HTTP listen and one runner', async () => {
    const f = await fixture();
    f.hookApi(async call => {
      if (call.method === 'getMe') {
        expect(f.app.configuration.settings().revision).toBe(0);
        expect(f.app.access.count()).toBe(0);
        const context = createInvocation({ actorId: 1, botId: me.id, source: 'telegram',
          chat: { id: 1, type: 'private' }, language: 'en' });
        expect(await f.app.executor.execute(context, 'core.info', {}))
          .toMatchObject({ status: 'succeeded', data: { moduleCount: 6 } });
        expect(await f.app.executor.execute(context, 'alias.list', {}))
          .toMatchObject({ status: 'succeeded', data: { revision: 0, aliases: { help: ['\u5e2e\u52a9', '\u5e6b\u52a9', '\u30d8\u30eb\u30d7'] } } });
      }
    });
    const firstStart = f.app.start();
    expect(f.app.start()).toBe(firstStart);
    await firstStart;
    expect(f.trace.slice(0, 12)).toEqual(['store:access.json', 'store:settings.json', 'store:preferences.json', 'store:aliases.json', 'store:rss.json', 'store:rates.json', 'store:weather.json', 'store:subconv.json',
      'web:factory', 'web:ready', 'api:getMe', 'api:deleteWebhook']);
    const menuIndices = f.trace.flatMap((entry, index) => entry === 'api:setMyCommands' ? [index] : []);
    expect(menuIndices).toHaveLength(16);
    const menus = f.calls.filter(call => call.method === 'setMyCommands');
    for (const [languageCode, language] of [['', 'zh-CN'], ['en', 'en'], ['zh', 'zh-CN'], ['ja', 'ja']] as const) {
      const localized = menus.filter(call => (call.payload.language_code ?? '') === languageCode);
      expect(localized.map(call => call.payload.scope)).toEqual([
        { type: 'default' }, { type: 'all_private_chats' }, { type: 'all_group_chats' }, { type: 'chat', chat_id: 1 },
      ]);
      for (const call of localized) {
        const scope = call.payload.scope as { type: string };
        expect(call.payload.commands).toEqual(menuCommands(language, scope.type === 'chat', scope.type !== 'all_group_chats'));
      }
    }
    expect(Math.min(...menuIndices)).toBeGreaterThan(f.trace.indexOf('api:deleteWebhook'));
    expect(Math.max(...menuIndices)).toBeLessThan(f.trace.indexOf('web:listening'));
    expect(f.trace.indexOf('web:listening')).toBeLessThan(f.trace.indexOf('runner:start'));
    expect(f.calls.find(call => call.method === 'deleteWebhook')!.payload).toEqual({ drop_pending_updates: false });
    expect(f.calls.every(call => !!call.signal)).toBe(true);
    expect(f.app.status()).toMatchObject({ polling: 'running', http: 'running' });
    expect(f.runnerFactory).toHaveBeenCalledOnce();
    expect(f.runner.start).not.toHaveBeenCalled();
    expect(f.network).not.toHaveBeenCalled();
  });

  it('passes only actual update types, concurrency16 and no sink timeout or runner retry sleep', async () => {
    const f = await fixture({ web: false, dropPending: true });
    await f.app.start();
    expect(ALLOWED_UPDATES).toEqual(['message', 'callback_query', 'my_chat_member', 'stopped_message_generation']);
    expect(RUNNER_CONCURRENCY).toBe(16);
    expect(f.runnerOptions).toEqual({ sink: { concurrency: 16 }, runner: {
      fetch: { timeout: 30, allowed_updates: ALLOWED_UPDATES }, maxRetryTime: 0, silent: true,
    } });
    expect(f.runnerOptions.sink).not.toHaveProperty('timeout');
    expect(f.runnerInput).not.toHaveProperty('init');
    expect(f.calls.find(call => call.method === 'deleteWebhook')!.payload).toEqual({ drop_pending_updates: true });
    expect(f.webFactory).not.toHaveBeenCalled();
    expect(f.app.status().http).toBe('disabled');
  });

  it.each(['access.json', 'settings.json', 'preferences.json', 'aliases.json', 'subconv.json'])('closes transport without contacting Telegram when loading %s fails', async filename => {
    const f = await fixture({ storage: { beforeCommit: async current => { if (current === filename) throw new Error('private storage path'); } } });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(f.calls).toEqual([]);
    expect(f.webFactory).not.toHaveBeenCalled();
    expect(f.runnerFactory).not.toHaveBeenCalled();
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'STORAGE_ERROR' } });
  });

  it.each(['getMe', 'deleteWebhook', 'setMyCommands'])('rolls back prepared HTTP and storage after %s fails', async method => {
    const f = await fixture();
    f.hookApi(call => call.method === method ? { ok: false, error_code: 401, description: 'secret Telegram exception' } : undefined);
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.runnerFactory).not.toHaveBeenCalled();
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    await expect(f.app.configuration.updateSettings({ defaultLanguage: 'en' }, 0)).rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('rejects a verified identity that does not match the configured token bot ID', async () => {
    const f = await fixture();
    f.hookApi(call => call.method === 'getMe' ? { ok: true, result: { ...me, id: me.id + 1 } } : undefined);
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    expect(f.calls.some(call => call.method === 'deleteWebhook')).toBe(false);
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('closes transport on HTTP factory failure before identity and polling', async () => {
    const f = await fixture({ webFactory: async () => { throw new Error('private web error'); } });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.calls).toEqual([]);
    expect(f.runnerFactory).not.toHaveBeenCalled();
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('does not start polling when the actual HTTP port is already bound', async () => {
    const occupied = Fastify();
    await occupied.listen({ host: '127.0.0.1', port: 0 });
    cleanups.push(() => occupied.close());
    const address = occupied.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test address');
    const f = await fixture({ port: address.port });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.runnerFactory).not.toHaveBeenCalled();
    expect(f.app.web!.server.listening).toBe(false);
    expect(occupied.server.listening).toBe(true);
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('closes already-listening HTTP after runner construction fails', async () => {
    const f = await fixture({ runnerFactory: () => { throw new Error('runner construction failed'); } });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.trace).toContain('web:listening');
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.trace.indexOf('web:closed')).toBeLessThan(f.trace.indexOf('transport:closed'));
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it.each(['missing task', 'not running'])('rejects an invalid runner handle: %s', async kind => {
    const stop = vi.fn(async () => undefined);
    const f = await fixture({ runnerFactory: () => ({ start: () => undefined, stop, size: () => 0,
      isRunning: () => kind !== 'not running', task: () => kind === 'missing task' ? undefined : new Promise<void>(() => undefined) }) });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(stop).toHaveBeenCalledOnce();
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });
});

describe('coordinated lifecycle shutdown', () => {
  it.each(['resolve', 'reject'])('treats unexpected runner task %s as failure and closes HTTP and transport', async ending => {
    const f = await fixture();
    await f.app.start();
    if (ending === 'resolve') f.endRunner(); else f.crashRunner();
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(f.app.status()).toMatchObject({ polling: 'failed', http: 'stopped' });
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.runner.stop).toHaveBeenCalledOnce();
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('stops polling when the real HTTP listener closes unexpectedly', async () => {
    const f = await fixture();
    await f.app.start();
    await new Promise<void>((resolve, reject) => f.app.web!.server.close(error => error ? reject(error) : resolve()));
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(f.app.status()).toMatchObject({ polling: 'stopped', http: 'failed' });
    expect(f.runner.stop).toHaveBeenCalledOnce();
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('supports repeated stop, closes the owned HTTPS agent once, and forbids restart', async () => {
    const destroyed = vi.spyOn(Agent.prototype, 'destroy');
    const f = await fixture();
    await f.app.start();
    const stopped = f.app.stop();
    expect(f.app.stop()).toBe(stopped);
    await stopped;
    await f.app.stop();
    expect(f.runner.stop).toHaveBeenCalledOnce();
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(destroyed).toHaveBeenCalledOnce();
    expect(await f.done).toEqual({ ok: true });
    expect(f.app.status()).toMatchObject({ polling: 'stopped', http: 'stopped' });
    await expect(f.app.start()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.runnerFactory).toHaveBeenCalledOnce();
  });

  it('stops safely before startup and rejects all later start attempts', async () => {
    const f = await fixture();
    await f.app.stop();
    await expect(f.app.start()).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.calls).toEqual([]);
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(await f.done).toEqual({ ok: true });
  });

  it('cancels startup identity work and waits for its cleanup before resolving stop/done', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => { release.resolve(); });
    f.hookApi(async call => {
      if (call.method !== 'getMe') return;
      entered.resolve();
      await new Promise<void>(resolve => call.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      f.trace.push('getMe:drained');
      throw new AppError('CANCELLED');
    });
    const starting = f.app.start().catch(error => error);
    await entered.promise;
    let stopped = false;
    const stopping = f.app.stop().then(() => { stopped = true; });
    await aborted.promise;
    await nextTurn();
    expect(stopped).toBe(false);
    expect(f.transportClosed).not.toHaveBeenCalled();
    release.resolve();
    await stopping;
    expect(await starting).toMatchObject({ code: 'CANCELLED' });
    expect(await f.done).toEqual({ ok: true });
    expect(f.trace.indexOf('getMe:drained')).toBeLessThan(f.trace.indexOf('transport:closed'));
    expect(f.calls.some(call => call.method === 'deleteWebhook')).toBe(false);
    expect(f.runnerFactory).not.toHaveBeenCalled();
  });

  it('does not publish completion or close transport while runner shutdown is still pending', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => { release.resolve(); });
    f.hookStop(async () => { entered.resolve(); await release.promise; });
    await f.app.start();
    let completed = false;
    void f.done.then(() => { completed = true; });
    const stopping = f.app.stop();
    await entered.promise;
    await nextTurn();
    expect(completed).toBe(false);
    expect(f.app.status().polling).toBe('stopping');
    expect(f.transportClosed).not.toHaveBeenCalled();
    release.resolve();
    await stopping;
    expect(await f.done).toEqual({ ok: true });
    expect(f.trace.indexOf('runner:drained')).toBeLessThan(f.trace.indexOf('transport:closed'));
  });

  it('still drains HTTP and storage when runner.stop rejects', async () => {
    const f = await fixture();
    f.hookStop(async () => { throw new Error('private runner shutdown error'); });
    await f.app.start();
    await f.app.stop();
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    expect(f.app.web!.server.listening).toBe(false);
    await expect(f.app.configuration.updateSettings({ defaultLanguage: 'en' }, 0)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('does not skip other resource cleanup when runner.stop throws synchronously', async () => {
    const task = new Promise<void>(() => undefined);
    const f = await fixture({ runnerFactory: () => ({
      start: () => undefined, size: () => 0, isRunning: () => true, task: () => task,
      stop: () => { throw new Error('private synchronous runner error'); },
    }) });
    cleanups.push(async () => { await f.app.web?.close(); });
    await f.app.start();
    await f.app.stop().catch(() => undefined);
    expect(f.app.web!.server.listening).toBe(false);
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    await expect(f.app.configuration.updateSettings({ defaultLanguage: 'en' }, 0)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('closes the listener and other resources even if Fastify.close itself throws', async () => {
    const f = await fixture();
    await f.app.start();
    const close = vi.spyOn(f.app.web!, 'close').mockImplementation(() => { throw new Error('private HTTP shutdown failure'); });
    cleanups.push(async () => { close.mockRestore(); await f.app.web!.close(); });
    await f.app.stop();
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.runner.stop).toHaveBeenCalledOnce();
    expect(await f.done).toMatchObject({ ok: false, error: { code: 'UNAVAILABLE' } });
    await expect(f.app.configuration.updateSettings({ defaultLanguage: 'en' }, 0)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it('tracks real Telegram handlers independently of runner.stop and drains canceled sends first', async () => {
    const f = await fixture({ graceMs: 0 });
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => { release.resolve(); });
    f.hookApi(async call => {
      if (call.method !== 'sendMessage' && call.method !== 'sendRichMessage') return;
      entered.resolve();
      await new Promise<void>(resolve => call.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      f.trace.push('update:drained');
      throw new AppError('CANCELLED');
    });
    await f.app.start();
    const updating = f.runnerInput.handleUpdate(f.update()).catch(error => error);
    await entered.promise;
    const stopping = f.app.stop();
    await aborted.promise;
    expect(f.runner.stop).toHaveBeenCalledOnce();
    expect(f.transportClosed).not.toHaveBeenCalled();
    expect(f.app.status().polling).toBe('stopping');
    release.resolve();
    expect((await updating).error).toMatchObject({ code: 'CANCELLED' });
    await stopping;
    expect(f.trace.indexOf('update:drained')).toBeLessThan(f.trace.indexOf('transport:closed'));
    const count = f.calls.length;
    await f.runnerInput.handleUpdate(f.update());
    expect(f.calls).toHaveLength(count);
    expect(await f.done).toEqual({ ok: true });
  });

  it('cancels a real HTTP storage write and drains request/file cleanup before transport closes', async () => {
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = false;
    let writeDrained = false;
    const f = await fixture({ storage: { beforeCommit: async (filename, signal) => {
      if (!block || filename !== 'settings.json') return;
      entered.resolve();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise; writeDrained = true;
    } } });
    cleanups.push(async () => { release.resolve(); });
    await f.app.start();
    const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 1, first_name: 'Admin' }), query_id: 'lifecycle' });
    const key = createHmac('sha256', 'WebAppData').update(f.config.botToken).digest();
    params.set('hash', createHmac('sha256', key).update([...params].sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join('\n')).digest('hex'));
    const auth = await f.app.web!.inject({ method: 'POST', url: '/auth/miniapp', headers: { host: 'lifecycle.example', origin: 'https://lifecycle.example' }, payload: { initData: params.toString() } });
    expect(auth.statusCode).toBe(200);
    const address = f.app.web!.server.address();
    if (!address || typeof address === 'string') throw new Error('Missing test listener');
    block = true;
    const response = new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = httpRequest({ host: '127.0.0.1', port: address.port, method: 'PUT', path: '/api/settings/core', agent: false,
        headers: { host: 'lifecycle.example', origin: 'https://lifecycle.example', authorization: `Bearer ${auth.json<{ token: string }>().token}`, 'content-type': 'application/json', connection: 'close' },
      }, incoming => {
        let body = ''; incoming.setEncoding('utf8'); incoming.on('data', chunk => { body += chunk; });
        incoming.on('end', () => { f.trace.push('http:response'); resolve({ status: incoming.statusCode!, body }); });
      });
      request.on('error', reject); request.end(JSON.stringify({ revision: 0, settings: { defaultLanguage: 'en' } }));
    });
    await entered.promise;
    const stopping = f.app.stop();
    await aborted.promise;
    expect(writeDrained).toBe(false);
    expect(f.transportClosed).not.toHaveBeenCalled();
    release.resolve();
    const reply = await response;
    expect(JSON.parse(reply.body)).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    await stopping;
    expect(writeDrained).toBe(true);
    expect(f.app.configuration.settings().revision).toBe(0);
    expect(JSON.parse(await readFile(join(f.config.dataDir, 'settings.json'), 'utf8')).core.defaultLanguage).toBe('zh-CN');
    expect(f.app.web!.server.listening).toBe(false);
    expect(f.transportClosed).toHaveBeenCalledOnce();
    expect(await f.done).toEqual({ ok: true });
  });
});

describe('owned polling retries', () => {
  it('stops the real runner during a mocked 429 without entering its uncancellable sleep', async () => {
    const f = await fixture({ web: false, runnerFactory: (input, options) => run(input, options) });
    const attempted = Promise.withResolvers<void>();
    f.hookApi(call => {
      if (call.method !== 'getUpdates') return;
      attempted.resolve();
      return { ok: false, error_code: 429, description: 'offline rate limit', parameters: { retry_after: 30 } };
    });
    await f.app.start();
    await attempted.promise;
    await nextTurn();
    await f.app.stop();
    expect(await f.done).toEqual({ ok: true });
    expect(f.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
    expect(f.app.runner!.isRunning()).toBe(false);
    expect(f.transportClosed).toHaveBeenCalledOnce();
  }, 2_000);

  it('waits for actual getUpdates cancellation cleanup before closing transport', async () => {
    const f = await fixture({ web: false, runnerFactory: (input, options) => run(input, options) });
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.push(async () => { release.resolve(); });
    f.hookApi(async call => {
      if (call.method !== 'getUpdates') return;
      entered.resolve();
      await new Promise<void>(resolve => call.signal!.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await release.promise;
      f.trace.push('poll:drained');
      throw new AppError('CANCELLED');
    });
    await f.app.start();
    await entered.promise;
    const stopping = f.app.stop();
    await aborted.promise;
    expect(f.transportClosed).not.toHaveBeenCalled();
    expect(f.app.status().polling).toBe('stopping');
    release.resolve();
    await stopping;
    expect(f.trace.indexOf('poll:drained')).toBeLessThan(f.trace.indexOf('transport:closed'));
    expect(await f.done).toEqual({ ok: true });
  });

  it('retries getUpdates 5xx safely without replaying handlers', async () => {
    const f = await fixture({ web: false });
    let attempt = 0;
    f.hookApi(call => call.method === 'getUpdates' && ++attempt === 1 ? { ok: false, error_code: 500, description: 'private upstream error' } : undefined);
    await f.app.start();
    const params = { offset: 5, limit: 10, timeout: 30, allowed_updates: [...ALLOWED_UPDATES] };
    expect(await f.runnerInput.api.getUpdates(params)).toEqual([]);
    expect(f.calls.filter(call => call.method === 'getUpdates')).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'getUpdates').every(call => JSON.stringify(call.payload) === JSON.stringify(params))).toBe(true);
    expect(f.app.status().updateCount).toBe(0);
    expect(f.app.status().lastApiError?.code).toBe('TELEGRAM_500');
  });

  it('cancels long rate-limit backoff rather than exposing grammY error to runner sleep', async () => {
    const f = await fixture({ web: false, graceMs: 0 });
    const attempted = Promise.withResolvers<void>();
    f.hookApi(call => {
      if (call.method !== 'getUpdates') return;
      attempted.resolve();
      return { ok: false, error_code: 429, description: 'rate limit', parameters: { retry_after: 30 } };
    });
    await f.app.start();
    const polling = f.runnerInput.api.getUpdates({ offset: 1, limit: 10, timeout: 30 }).catch(error => error);
    await attempted.promise;
    await nextTurn();
    await f.app.stop();
    const error = await polling;
    expect(error).not.toHaveProperty('error_code');
    expect(error.name === 'AbortError' || error.code === 'CANCELLED').toBe(true);
    expect(f.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
    expect(f.transportClosed).toHaveBeenCalledOnce();
  });

  it.each([401, 409])('does not retry non-retryable getUpdates HTTP %i or leak raw exception text', async code => {
    const f = await fixture({ web: false });
    f.hookApi(call => call.method === 'getUpdates' ? { ok: false, error_code: code, description: 'SECRET_BOT_TOKEN' } : undefined);
    await f.app.start();
    await expect(f.runnerInput.api.getUpdates({ offset: 1, limit: 10, timeout: 30 })).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
    expect(f.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
    expect(f.app.status().lastApiError?.code).toBe(`TELEGRAM_${code}`);
  });

  it('bounds retry_after beyond the retry window without sleeping or leaking a 429 to runner', async () => {
    const f = await fixture({ web: false });
    f.hookApi(call => call.method === 'getUpdates' ? { ok: false, error_code: 429, description: 'rate limit', parameters: { retry_after: 3600 } } : undefined);
    await f.app.start();
    await expect(f.runnerInput.api.getUpdates({ offset: 1, limit: 10, timeout: 30 })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.calls.filter(call => call.method === 'getUpdates')).toHaveLength(1);
  });
});
