import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StartupConfig } from '../src/config.js';

const config: StartupConfig = {
  botToken: '12345:OFFLINE_ONLY', adminIds: [1], dataDir: '/tmp/kilo/index-test', logLevel: 'silent',
  pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 },
};
const initialExitCode = process.exitCode;
let originalInt: NodeJS.SignalsListener[];
let originalTerm: NodeJS.SignalsListener[];
const cleanups: (() => void)[] = [];

async function settle(): Promise<void> {
  // The entrypoint intentionally does not export its top-level main promise.
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  process.exitCode = undefined;
  originalInt = process.listeners('SIGINT');
  originalTerm = process.listeners('SIGTERM');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden'); }));
});

afterEach(async () => {
  for (const release of cleanups.splice(0)) release();
  await settle();
  for (const listener of process.listeners('SIGINT')) if (!originalInt.includes(listener)) process.removeListener('SIGINT', listener);
  for (const listener of process.listeners('SIGTERM')) if (!originalTerm.includes(listener)) process.removeListener('SIGTERM', listener);
  vi.doUnmock('../src/app.js');
  vi.doUnmock('../src/config.js');
  vi.doUnmock('pino');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  process.exitCode = initialExitCode;
});

async function entry(options: { startupPending?: boolean; stopPending?: boolean; configError?: Error } = {}) {
  const startup = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  void startup.promise.catch(() => undefined);
  void completion.promise.catch(() => undefined);
  if (!options.startupPending) startup.resolve();
  if (!options.stopPending) stopped.resolve();
  cleanups.push(() => { startup.resolve(); completion.resolve(); stopped.resolve(); });
  const logger = { error: vi.fn(), fatal: vi.fn() };
  const pino = vi.fn(() => logger);
  const app = {
    start: vi.fn(() => startup.promise),
    stop: vi.fn(() => stopped.promise),
    done: completion.promise,
  };
  const createApplication = vi.fn(() => app);
  class ConfigurationError extends Error {
    constructor(readonly fields: string[]) { super('private config details'); }
  }
  const loadConfig = vi.fn(async () => {
    if (options.configError) throw options.configError;
    return config;
  });
  vi.doMock('../src/app.js', () => ({ createApplication }));
  vi.doMock('../src/config.js', () => ({ loadConfig, ConfigurationError }));
  vi.doMock('pino', () => ({ default: pino }));
  await import('../src/index.js');
  await settle();
  const signal = (name: 'SIGINT' | 'SIGTERM') => {
    const previous = name === 'SIGINT' ? originalInt : originalTerm;
    const handler = process.listeners(name).find(listener => !previous.includes(listener));
    if (!handler) throw new Error('Lifecycle signal handler is missing');
    handler(name);
  };
  return { app, startup, completion, stopped, logger, pino, createApplication, loadConfig, signal };
}

describe('Node entrypoint lifecycle coordination', () => {
  it('loads validated config before constructing and starting exactly one application', async () => {
    const f = await entry();
    expect(f.loadConfig).toHaveBeenCalledOnce();
    expect(f.createApplication).toHaveBeenCalledWith(config, { logger: f.logger });
    expect(f.app.start).toHaveBeenCalledOnce();
    expect(f.app.stop).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    f.completion.resolve();
    await settle();
    expect(f.app.stop).toHaveBeenCalledOnce();
    expect(process.listeners('SIGINT')).toEqual(originalInt);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
    expect(process.exitCode).toBeUndefined();
  });

  it('handles SIGINT and SIGTERM idempotently with one watchdog, drains before removing listeners', async () => {
    const f = await entry({ stopPending: true });
    f.signal('SIGINT');
    f.signal('SIGTERM');
    expect(f.app.stop).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    f.completion.resolve();
    await settle();
    expect(f.app.stop).toHaveBeenCalledTimes(3);
    expect(process.listeners('SIGINT')).not.toEqual(originalInt);
    f.stopped.resolve();
    await settle();
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listeners('SIGINT')).toEqual(originalInt);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
    expect(process.exitCode).toBeUndefined();
  });

  it('arms a 15-second watchdog only for signal shutdown and logs only safe deadline data', async () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const f = await entry({ stopPending: true });
    expect(vi.getTimerCount()).toBe(0);
    f.signal('SIGTERM');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(exit).toHaveBeenCalledWith(1);
    expect(f.logger.fatal).toHaveBeenCalledWith({ event: 'shutdown_deadline', code: 'TIMEOUT' });
    f.completion.resolve(); f.stopped.resolve();
    await settle();
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
  });

  it('waits for cleanup after startup failure, then reports a safe failure and removes handlers', async () => {
    const f = await entry({ startupPending: true, stopPending: true });
    f.startup.reject(new Error('SECRET_TOKEN https://private.example'));
    await settle();
    expect(f.app.stop).toHaveBeenCalledOnce();
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    f.stopped.resolve();
    await settle();
    expect(f.logger.error).toHaveBeenCalledWith({ event: 'startup_failed', code: 'UNAVAILABLE' });
    expect(JSON.stringify(f.logger.error.mock.calls)).not.toContain('SECRET_TOKEN');
    expect(process.exitCode).toBe(1);
    expect(process.listeners('SIGINT')).toEqual(originalInt);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
  });

  it('coordinates unexpected application failure through stop before reporting process failure', async () => {
    const f = await entry({ stopPending: true });
    f.completion.reject(new Error('private runtime exception'));
    await settle();
    expect(f.app.stop).toHaveBeenCalledOnce();
    expect(f.logger.error).not.toHaveBeenCalled();
    f.stopped.resolve();
    await settle();
    expect(process.exitCode).toBe(1);
    expect(f.logger.error).toHaveBeenCalledWith({ event: 'startup_failed', code: 'UNAVAILABLE' });
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
  });

  it('does not construct an application or register signals when config loading fails', async () => {
    const f = await entry({ configError: new Error('SECRET_ENV') });
    expect(f.createApplication).not.toHaveBeenCalled();
    expect(process.listeners('SIGINT')).toEqual(originalInt);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
    expect(f.logger.error).toHaveBeenCalledWith({ event: 'startup_failed', code: 'UNAVAILABLE' });
    expect(process.exitCode).toBe(1);
  });

  it('treats a signal-cancelled startup as a normal shutdown rather than a startup failure', async () => {
    const f = await entry({ startupPending: true });
    f.signal('SIGTERM');
    const { AppError } = await import('../src/errors.js');
    f.startup.reject(new AppError('CANCELLED'));
    f.completion.resolve();
    await settle();
    expect(f.app.stop).toHaveBeenCalledTimes(2);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.logger.error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it('reports a safe storage diagnostic instead of hiding corrupt-state failures', async () => {
    const f = await entry({ startupPending: true });
    const { AppError } = await import('../src/errors.js');
    f.startup.reject(new AppError('STORAGE_ERROR'));
    await settle();
    expect(f.logger.error).toHaveBeenCalledWith({ event: 'startup_failed', code: 'STORAGE_ERROR' });
    expect(process.exitCode).toBe(1);
  });

  it.each(['non-cancellation error after signal', 'cancellation without signal'])('does not suppress %s', async scenario => {
    const f = await entry({ startupPending: true });
    const { AppError } = await import('../src/errors.js');
    if (scenario === 'non-cancellation error after signal') f.signal('SIGTERM');
    f.startup.reject(scenario === 'cancellation without signal' ? new AppError('CANCELLED') : new Error('private startup failure'));
    f.completion.resolve();
    await settle();
    expect(f.logger.error).toHaveBeenCalledWith({ event: 'startup_failed', code: scenario === 'cancellation without signal' ? 'CANCELLED' : 'UNAVAILABLE' });
    expect(process.exitCode).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(process.listeners('SIGTERM')).toEqual(originalTerm);
  });
});
