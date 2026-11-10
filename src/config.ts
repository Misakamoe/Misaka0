import { readFile, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { basename, dirname, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';

export interface StartupConfig {
  readonly botToken: string;
  readonly adminIds: readonly number[];
  readonly dataDir: string;
  readonly logLevel: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';
  readonly pollingTimeout: number;
  readonly requestTimeout: number;
  readonly dropPendingUpdates: boolean;
  readonly providers?: Readonly<{ exchangeRateKey?: string; openWeatherKey?: string; qweatherKey?: string; qweatherHost?: string; openMeteo?: boolean }>;
  readonly web: Readonly<{
    enabled: boolean;
    host: string;
    port: number;
    publicBaseUrl?: string;
    oidcClientId?: string;
    oidcClientSecret?: string;
  }>;
}

export class ConfigurationError extends Error {
  constructor(readonly fields: string[]) {
    super(`CONFIG_INVALID: ${fields.join(', ')}`);
    this.name = 'ConfigurationError';
  }
}

export async function loadConfig(options: { env?: NodeJS.ProcessEnv; cwd?: string } = {}): Promise<StartupConfig> {
  const cwd = options.cwd ?? process.cwd();
  let file: NodeJS.ProcessEnv = {};
  try { file = parseEnv(await readFile(resolve(cwd, '.env'), 'utf8')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ConfigurationError(['.env']);
  }
  const env = { ...file, ...(options.env ?? process.env) };
  const invalid: string[] = [];
  const text = (name: string, fallback?: string): string => {
    const value = env[`MISAKA_${name}`] ?? fallback;
    if (value === undefined || !value.trim() || value.includes('\0')) {
      invalid.push(`MISAKA_${name}`);
      return '';
    }
    return value.trim();
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const value = text(name, String(fallback));
    const result = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(result) || result < min || result > max) invalid.push(`MISAKA_${name}`);
    return result;
  };
  const boolean = (name: string, fallback: boolean): boolean => {
    const value = text(name, String(fallback));
    if (value !== 'true' && value !== 'false') invalid.push(`MISAKA_${name}`);
    return value === 'true';
  };
  const botToken = text('BOT_TOKEN');
  if (!/^[1-9]\d{4,19}:[A-Za-z0-9_-]{30,128}$/.test(botToken) || !Number.isSafeInteger(Number(botToken.split(':')[0]))) invalid.push('MISAKA_BOT_TOKEN');
  const admins = text('ADMIN_IDS').split(',').map(value => value.trim());
  if (admins.some(value => !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)))) invalid.push('MISAKA_ADMIN_IDS');
  const adminIds = [...new Set(admins.map(Number))];
  const dataValue = text('DATA_DIR', 'data/misaka');
  const dataDir = resolve(cwd, dataValue);
  const forbidden = ['legacy', 'config', 'data/states', 'data/sessions'].map(path => resolve(cwd, path));
  let actual = dataDir;
  const suffix: string[] = [];
  let ancestor = dataDir;
  for (;;) {
    try { actual = resolve(await realpath(ancestor), ...suffix.reverse()); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(ancestor) === ancestor) {
        invalid.push('MISAKA_DATA_DIR'); break;
      }
      suffix.push(basename(ancestor));
      ancestor = dirname(ancestor);
    }
  }
  if ([resolve(cwd), resolve(cwd, 'data'), sep].includes(actual)
    || forbidden.some(path => actual === path || actual.startsWith(`${path}${sep}`))) invalid.push('MISAKA_DATA_DIR');
  const logLevel = text('LOG_LEVEL', 'INFO').toLowerCase();
  if (!['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'].includes(logLevel)) invalid.push('MISAKA_LOG_LEVEL');
  const pollingTimeout = integer('POLLING_TIMEOUT', 30, 1, 50);
  const requestTimeout = integer('REQUEST_TIMEOUT', 60, 2, 300);
  if (requestTimeout <= pollingTimeout) invalid.push('MISAKA_REQUEST_TIMEOUT');
  const dropPendingUpdates = boolean('DROP_PENDING_UPDATES', false);
  const enabled = boolean('WEB_ENABLED', false);
  const optional = (name: string, pattern: RegExp): string | undefined => {
    const value = env[`MISAKA_${name}`]?.trim();
    if (!value) return undefined;
    if (!pattern.test(value)) invalid.push(`MISAKA_${name}`);
    return value;
  };
  const keyPattern = /^[A-Za-z0-9_-]{16,128}$/;
  const providers = Object.freeze({
    exchangeRateKey: optional('EXCHANGE_RATE_API_KEY', keyPattern),
    openWeatherKey: optional('OPENWEATHER_API_KEY', keyPattern),
    qweatherKey: optional('QWEATHER_API_KEY', keyPattern),
    qweatherHost: optional('QWEATHER_API_HOST', /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+qweatherapi\.com$/),
    openMeteo: boolean('OPEN_METEO_ENABLED', true),
  });
  const host = text('WEB_HOST', '127.0.0.1');
  if (!isIP(host) && host !== 'localhost') invalid.push('MISAKA_WEB_HOST');
  const port = integer('WEB_PORT', 8080, 1, 65535);
  let publicBaseUrl: string | undefined;
  let oidcClientId: string | undefined;
  let oidcClientSecret: string | undefined;
  if (enabled) {
    const url = text('PUBLIC_BASE_URL');
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
      publicBaseUrl = parsed.origin;
    } catch { invalid.push('MISAKA_PUBLIC_BASE_URL'); }
    oidcClientId = text('OIDC_CLIENT_ID');
    oidcClientSecret = text('OIDC_CLIENT_SECRET');
    if (!/^[1-9]\d*$/.test(oidcClientId)) invalid.push('MISAKA_OIDC_CLIENT_ID');
  }
  if (invalid.length) throw new ConfigurationError([...new Set(invalid)]);
  return Object.freeze({
    botToken, adminIds: Object.freeze(adminIds), dataDir,
    logLevel: logLevel as StartupConfig['logLevel'], pollingTimeout, requestTimeout, dropPendingUpdates, providers,
    web: Object.freeze({ enabled, host, port, publicBaseUrl, oidcClientId, oidcClientSecret }),
  });
}
