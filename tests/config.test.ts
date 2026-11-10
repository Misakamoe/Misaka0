import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../src/config.js';
import { environment, testToken } from './support/core.js';

describe('startup configuration isolation', () => {
  let cwd: string;
  beforeEach(async () => { cwd = await mkdtemp(join(tmpdir(), 'misaka-config-')); });
  afterEach(async () => { await rm(cwd, { recursive: true, force: true }); });

  it('uses only MISAKA variables, safe defaults, frozen startup state and deduplicated IDs', async () => {
    const config = await loadConfig({ cwd, env: { ...environment, MISAKA_ADMIN_IDS: '1, 2,1' } });
    expect(config.adminIds).toEqual([1, 2]);
    expect(config.dataDir).toBe(join(cwd, 'data/misaka'));
    expect(config.pollingTimeout).toBe(30);
    expect(config.requestTimeout).toBe(60);
    expect(config.dropPendingUpdates).toBe(false);
    expect(config.web).toEqual({ enabled: false, host: '127.0.0.1', port: 8080 });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.adminIds)).toBe(true);
    await expect(loadConfig({ cwd, env: { TELEGRAM_BOT_TOKEN: testToken, ADMIN_IDS: '1' } })).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('process environment overrides .env even when explicitly empty, without rewriting it', async () => {
    const original = `MISAKA_BOT_TOKEN=${testToken}\nMISAKA_ADMIN_IDS=9\nMISAKA_LOG_LEVEL=DEBUG\n`;
    await writeFile(join(cwd, '.env'), original);
    const config = await loadConfig({ cwd, env: { MISAKA_ADMIN_IDS: '1', MISAKA_LOG_LEVEL: 'WARN' } });
    expect(config.adminIds).toEqual([1]);
    expect(config.logLevel).toBe('warn');
    await expect(loadConfig({ cwd, env: { MISAKA_BOT_TOKEN: '' } })).rejects.toMatchObject({ fields: expect.arrayContaining(['MISAKA_BOT_TOKEN']) });
    expect(await readFile(join(cwd, '.env'), 'utf8')).toBe(original);
  });

  it.each([
    ['MISAKA_BOT_TOKEN', 'secret-value'], ['MISAKA_BOT_TOKEN', '12345:short'],
    ['MISAKA_ADMIN_IDS', ''], ['MISAKA_ADMIN_IDS', '0'], ['MISAKA_ADMIN_IDS', '-1'],
    ['MISAKA_ADMIN_IDS', '1,,2'], ['MISAKA_ADMIN_IDS', '1e3'], ['MISAKA_ADMIN_IDS', '1.1'],
    ['MISAKA_ADMIN_IDS', '9007199254740992'], ['MISAKA_ADMIN_IDS', '+1'],
    ['MISAKA_LOG_LEVEL', 'verbose'], ['MISAKA_POLLING_TIMEOUT', '0'], ['MISAKA_POLLING_TIMEOUT', '51'],
    ['MISAKA_REQUEST_TIMEOUT', '30'], ['MISAKA_REQUEST_TIMEOUT', '1.5'], ['MISAKA_REQUEST_TIMEOUT', '301'],
    ['MISAKA_DROP_PENDING_UPDATES', '1'], ['MISAKA_WEB_ENABLED', 'TRUE'],
    ['MISAKA_WEB_PORT', '0'], ['MISAKA_WEB_PORT', '65536'], ['MISAKA_WEB_HOST', 'bad/host'],
    ['MISAKA_DATA_DIR', ''], ['MISAKA_DATA_DIR', 'data'], ['MISAKA_DATA_DIR', 'data/states'],
    ['MISAKA_DATA_DIR', 'data/sessions/anything'], ['MISAKA_DATA_DIR', 'legacy/ptb'], ['MISAKA_DATA_DIR', 'config'],
    ['MISAKA_QWEATHER_API_HOST', 'evil.example'], ['MISAKA_QWEATHER_API_HOST', 'test.qweatherapi.com.evil.example'],
    ['MISAKA_QWEATHER_API_HOST', 'https://test.qweatherapi.com'], ['MISAKA_QWEATHER_API_HOST', 'test..qweatherapi.com'],
    ['MISAKA_EXCHANGE_RATE_API_KEY', 'secret-value'], ['MISAKA_QWEATHER_API_KEY', 'key\ninjected-header'],
  ])('rejects invalid %s without leaking its value', async (key, value) => {
    let failure: unknown;
    try { await loadConfig({ cwd, env: { ...environment, [key]: value } }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ConfigurationError);
    expect((failure as ConfigurationError).fields).toContain(key);
    expect(String(failure)).not.toContain(testToken);
    expect(String(failure)).not.toContain('secret-value');
  });

  it('requires complete HTTPS OIDC configuration only when web is enabled', async () => {
    await expect(loadConfig({ cwd, env: { ...environment, MISAKA_WEB_ENABLED: 'true' } })).rejects.toBeInstanceOf(ConfigurationError);
    const webEnv = { ...environment, MISAKA_WEB_ENABLED: 'true', MISAKA_PUBLIC_BASE_URL: 'https://bot.example/', MISAKA_OIDC_CLIENT_ID: '12345', MISAKA_OIDC_CLIENT_SECRET: 'test-secret' };
    const config = await loadConfig({ cwd, env: webEnv });
    expect(config.web.publicBaseUrl).toBe('https://bot.example');
    for (const bad of ['http://bot.example', 'https://user:secret@bot.example', 'https://bot.example/elsewhere', 'https://bot.example/?code=secret', 'javascript:alert(1)']) {
      await expect(loadConfig({ cwd, env: { ...webEnv, MISAKA_PUBLIC_BASE_URL: bad } })).rejects.toMatchObject({ fields: ['MISAKA_PUBLIC_BASE_URL'] });
    }
  });
  it('keeps lookup service keys in frozen startup configuration and permits absent optional providers', async () => {
    const config = await loadConfig({ cwd, env: { ...environment, MISAKA_EXCHANGE_RATE_API_KEY: 'TEST_ONLY_EXCHANGE_KEY',
      MISAKA_QWEATHER_API_KEY: 'TEST_ONLY_WEATHER_KEY', MISAKA_QWEATHER_API_HOST: 'test.re.qweatherapi.com' } });
    expect(config.providers?.exchangeRateKey).toBe('TEST_ONLY_EXCHANGE_KEY');
    expect(config.providers?.qweatherHost).toBe('test.re.qweatherapi.com');
    expect(config.providers?.openWeatherKey).toBeUndefined();
    expect(Object.isFrozen(config.providers)).toBe(true);
  });

  it('protects old data and detects symlink ancestors even for nonexistent target directories', async () => {
    await mkdir(join(cwd, 'data/states'), { recursive: true });
    const sentinel = join(cwd, 'data/states/sentinel.json');
    await writeFile(sentinel, '{"legacy":true}');
    await symlink(join(cwd, 'data/states'), join(cwd, 'redirect'));
    await expect(loadConfig({ cwd, env: { ...environment, MISAKA_DATA_DIR: 'redirect/new' } })).rejects.toMatchObject({ fields: ['MISAKA_DATA_DIR'] });
    await loadConfig({ cwd, env: environment });
    expect(await readFile(sentinel, 'utf8')).toBe('{"legacy":true}');
  });
});
