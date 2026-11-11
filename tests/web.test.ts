import { createHmac, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InjectOptions } from 'fastify';
import { ActionExecutor, createInvocation, type ActionServices } from '../src/actions.js';
import { AiService } from '../src/ai/service.js';
import { AccessService } from '../src/access.js';
import { ConfigurationService } from '../src/configuration.js';
import { aliasMetadata, AliasService } from '../src/modules/alias.js';
import { rssMetadata, RssService } from '../src/modules/rss.js';
import { rateMetadata, RateService } from '../src/modules/rate.js';
import { weatherMetadata, WeatherService } from '../src/modules/weather.js';
import { stickerMetadata } from '../src/modules/sticker.js';
import { subconvMetadata, SubconvService } from '../src/modules/subconv.js';
import { offlineStickers } from './support/core.js';
import { commands } from '../src/telegram/commands.js';
import type { StartupConfig } from '../src/config.js';
import { JsonStorage, type StorageOptions } from '../src/storage.js';
import { createWebServer, type WebDependencies } from '../src/web/server.js';
import { LOGIN_COOKIE, SESSION_COOKIE, OIDC_ISSUER, type OidcAdapter } from '../src/web/auth.js';
import type { ActionResult, Me } from '../shared/schemas/index.js';
import type { AiAdminSnapshot } from '../shared/schemas/ai-admin.js';

const config: StartupConfig = {
  botToken: '123456789:TEST_ONLY_NOT_A_REAL_BOT_TOKEN_000000', adminIds: [42], dataDir: '/tmp/kilo/not-used',
  logLevel: 'silent', pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
  web: { enabled: true, host: '127.0.0.1', port: 8080, publicBaseUrl: 'https://console.example', oidcClientId: '123456789', oidcClientSecret: 'test-only-client-secret' },
};
const origin = config.web.publicBaseUrl!;
function signedInit(userId = 42): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId, first_name: 'Admin', language_code: 'en' }), query_id: randomUUID() });
  const key = createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const data = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  params.set('hash', createHmac('sha256', key).update(data).digest('hex'));
  return params.toString();
}

const cleanup: (() => Promise<void>)[] = [];
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected live network'); })));
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(options: { storage?: StorageOptions; signal?: AbortSignal; oidc?: OidcAdapter; oidcConfigured?: boolean; timeout?: number } = {}) {
  const directory = await mkdtemp('/tmp/kilo/misaka-web-');
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const staticRoot = join(directory, 'static');
  await mkdir(staticRoot);
  await writeFile(join(staticRoot, 'index.html'), '<!doctype html><html><body><div id="root">Test WebUI</div><script src="/main.js"></script></body></html>');
  await writeFile(join(staticRoot, 'main.js'), 'document.documentElement.dataset.loaded="yes";');
  await writeFile(join(staticRoot, '.secret'), 'PRIVATE_SENTINEL');
  const storage = new JsonStorage(join(directory, 'state'), options.storage);
  await storage.initialize(); cleanup.push(() => storage.close());
  const access = new AccessService(storage, config.adminIds);
  const configuration = new ConfigurationService(storage);
  const aliases = new AliasService(storage, commands.map(command => command.name));
  await access.initialize(); await configuration.initialize(); await aliases.initialize();
  const rss = new RssService(storage, { allowed: target => target.kind === 'private' || access.isAllowed(target.chatId), send: async () => {} });
  await rss.initialize(); cleanup.push(() => rss.stop());
  const rate = new RateService(storage); await rate.initialize(); cleanup.push(() => rate.stop());
  const weather = new WeatherService(storage); await weather.initialize(); cleanup.push(() => weather.stop());
  const stickers = offlineStickers(); cleanup.push(() => stickers.stop());
  const subconv = new SubconvService(storage); await subconv.initialize();
  const effects = {
    describeGroup: vi.fn(async () => ({ title: 'Offline Test Group', present: true })),
    notifyGroup: vi.fn(async () => true), leaveGroup: vi.fn(async () => true), syncPrivateMenu: vi.fn(async () => true),
  };
  const services: ActionServices = { access, configuration, aliases, rss, rate, weather, stickers, subconv, effects,
    status: () => ({ uptimeSeconds: 1, updateCount: 0, authorizedGroupCount: access.count(), polling: 'running', http: 'running', lastApiError: null }),
  };
  const executor = new ActionExecutor(services);
  cleanup.push(() => executor.close());
  const oidc: OidcAdapter = options.oidc ?? {
    authorize: vi.fn(async attempt => new URL(`${OIDC_ISSUER}/auth?state=${attempt.state}&nonce=${attempt.nonce}`)),
    exchange: vi.fn(async () => ({ id: 42, name: 'Browser Admin' })),
  };
  const deps: WebDependencies = { config: { ...config, requestTimeout: options.timeout ?? config.requestTimeout,
    web: options.oidcConfigured === false ? { ...config.web, oidcClientId: undefined, oidcClientSecret: undefined } : config.web },
    executor, configuration, access, botId: () => 123456789, oidc: options.oidcConfigured === false ? undefined : oidc, staticRoot, signal: options.signal };
  const server = await createWebServer(deps);
  cleanup.push(() => server.close());
  const inject = (input: InjectOptions) => server.inject({ ...input, headers: Object.fromEntries(Object.entries({ host: 'console.example', ...input.headers }).filter(([, value]) => value !== undefined)) });
  const browser = async (previousCookie?: string) => {
    const login = await inject({ method: 'GET', url: '/auth/login?returnTo=https://attacker.example' });
    expect(login.statusCode).toBe(302);
    const location = new URL(login.headers.location!);
    const binding = login.cookies.find(value => value.name === LOGIN_COOKIE)!.value;
    const response = await inject({ method: 'GET', url: `/auth/callback?state=${location.searchParams.get('state')}&code=private-code`, headers: { cookie: `${LOGIN_COOKIE}=${binding}${previousCookie ? `; ${previousCookie}` : ''}` } });
    expect(response.headers.location).toBe('/');
    const cookie = `${SESSION_COOKIE}=${response.cookies.find(value => value.name === SESSION_COOKIE)!.value}`;
    const me = (await inject({ method: 'GET', url: '/api/me', headers: { cookie } })).json<Me>();
    return { response, cookie, me, headers: { cookie, origin, 'x-csrf-token': me.csrfToken! } };
  };
  const bearer = async () => {
    const response = await inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload: { initData: signedInit() } });
    expect(response.statusCode).toBe(200);
    const { token, expiresAt } = response.json<{ token: string; expiresAt: string }>();
    return { token, expiresAt, headers: { authorization: `Bearer ${token}`, origin } };
  };
  return { server, inject, deps, storage, access, configuration, aliases, services, executor, effects, oidc, directory, staticRoot, browser, bearer };
}

describe('same-origin HTTP server boundary', () => {
  it('completes real Mini App setup without OIDC or an environment master key and never returns the provider key', async () => {
    const h = await fixture({ oidcConfigured: false });
    const provider = vi.fn(() => { throw new Error('No provider calls during setup'); });
    const ai = new AiService({ config: { ...h.deps.config, dataDir: h.storage.directory }, access: h.access,
      storageLock: h.storage.lock, provider });
    const executor = new ActionExecutor({ ...h.services, ai });
    cleanup.push(async () => { await ai.stop(); await executor.close(); });
    await ai.initialize();
    const server = await createWebServer({ ...h.deps, executor });
    cleanup.push(() => server.close());
    const login = await server.inject({ method: 'POST', url: '/auth/miniapp', headers: { host: 'console.example', origin }, payload: { initData: signedInit() } });
    expect(login.statusCode).toBe(200);
    const headers = { host: 'console.example', origin, authorization: `Bearer ${login.json<{ token: string }>().token}` };
    const before = (await server.inject({ method: 'GET', url: '/api/ai/admin', headers })).json<ActionResult<AiAdminSnapshot>>();
    expect(before.status).toBe('succeeded');
    if (before.status !== 'succeeded') throw new Error('Expected AI snapshot');
    expect(before.data.status.available).toBe(true);
    const response = await server.inject({ method: 'POST', url: '/api/ai/setup', headers, payload: {
      revision: before.data.revision, protocol: 'openai-responses', baseUrl: 'https://provider.invalid/v1',
      model: 'offline-model', apiKey: 'ISOLATED_HTTP_SETUP_SECRET', groupIds: [],
    } });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'succeeded', data: { status: { available: true }, settings: {
      enabled: true, presets: [{ model: 'offline-model', budgetMode: 'usage' }],
      grants: [{ kind: 'private', subjectId: 42 }],
    }, credentials: [{ source: 'vault', hasValue: true }] } });
    expect(response.body).not.toContain('ISOLATED_HTTP_SETUP_SECRET');
    expect(await readFile(join(h.storage.directory, 'ai-master.key'))).toHaveLength(32);
    expect(ai.available(createInvocation({ actorId: 42, botId: 123456789, source: 'telegram', chat: { id: 42, type: 'private' }, language: 'en' }))).toBe(true);
    expect(provider).not.toHaveBeenCalled();
  });

  it('reads target group versions through authenticated Actions and preserves unrelated pending approvals', async () => {
    const h = await fixture({ oidcConfigured: false });
    expect((await h.inject({ method: 'POST', url: '/api/groups/state', payload: { chatId: -100 }, headers: { origin } })).statusCode).toBe(401);
    const { headers } = await h.bearer();
    const state = async (chatId: number) => {
      const response = await h.inject({ method: 'POST', url: '/api/groups/state', headers, payload: { chatId } });
      expect(response.statusCode).toBe(200);
      const result = response.json<ActionResult<{ chatId: number; revision: number; groupRevision: number }>>();
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') throw new Error('Expected group state');
      return result.data;
    };
    expect((await h.inject({ method: 'POST', url: '/api/groups/state', headers, payload: { chatId: -100, actorId: 99 } })).statusCode).toBe(400);
    const first = await state(-100);
    expect((await h.inject({ method: 'PUT', url: '/api/groups', headers, payload: first })).statusCode).toBe(200);
    const target = await state(-100);
    const prepared = (await h.inject({ method: 'POST', url: '/api/groups/revoke', headers, payload: target })).json<ActionResult>();
    expect(prepared.status).toBe('pending_confirmation');
    if (prepared.status !== 'pending_confirmation') throw new Error('Expected group approval');
    expect((await h.inject({ method: 'PUT', url: '/api/groups', headers, payload: await state(-200) })).statusCode).toBe(200);
    const confirmed = await h.inject({ method: 'POST', url: '/api/confirm', headers, payload: { token: prepared.confirmation.token } });
    expect(confirmed.json()).toMatchObject({ status: 'succeeded', data: { chatId: -100, changed: true } });
    expect(h.access.isAllowed(-100)).toBe(false); expect(h.access.isAllowed(-200)).toBe(true);
  });

  it('does not listen or call the network at factory creation; health is minimal', async () => {
    const h = await fixture();
    expect(h.server.server.listening).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await h.inject({ method: 'GET', url: '/health' })).json()).toEqual({ ok: true });
  });

  it('serves only the built same-origin site with restrictive but Telegram-compatible headers', async () => {
    const h = await fixture();
    const page = await h.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Test WebUI');
    const csp = String(page.headers['content-security-policy']);
    expect(csp).toContain("script-src 'self' https://telegram.org");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'self' https://web.telegram.org https://*.web.telegram.org https://t.me");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(page.headers['x-frame-options']).toBeUndefined();
    expect(page.headers['access-control-allow-origin']).toBeUndefined();
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['referrer-policy']).toBe('no-referrer');
    expect(page.headers['strict-transport-security']).toBeDefined();
    expect(page.headers['cache-control']).toBe('no-store');
    expect((await h.inject({ method: 'GET', url: '/main.js' })).statusCode).toBe(200);
    expect((await h.inject({ method: 'GET', url: '/.secret' })).body).not.toContain('PRIVATE_SENTINEL');
    expect((await h.inject({ method: 'GET', url: '/../state/access.json' })).statusCode).toBe(404);
  });

  it('fails startup when built static assets are missing', async () => {
    const h = await fixture();
    await expect(createWebServer({ ...h.deps, staticRoot: join(h.directory, 'missing') })).rejects.toMatchObject({ code: 'UNAVAILABLE' });
  });

  it.each(['attacker.example', 'console.example.attacker.example', 'console.example:444', 'localhost'])('rejects Host %s even behind spoofed forwarding headers', async host => {
    const h = await fixture();
    const response = await h.inject({ method: 'GET', url: '/health', headers: { host, 'x-forwarded-host': 'console.example', 'x-forwarded-proto': 'https' } });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toEqual({ error: { code: 'INVALID_ORIGIN' } });
  });

  it.each(['/api', '/api/me', '/api/status', '/api/groups', '/api/no-such-route', '/api/modules/legacy/config', '/%61pi/no-such-route'])('authenticates management path %s including unknown routes', async url => {
    const h = await fixture();
    const response = await h.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: { code: 'UNAUTHORIZED' } });
  });

  it('does not bypass auth for OPTIONS, HEAD, unknown methods or development headers', async () => {
    const h = await fixture();
    for (const method of ['OPTIONS', 'HEAD', 'PATCH'] as const) {
      expect((await h.inject({ method, url: '/api/unknown', headers: { origin: 'https://attacker.example', 'x-user-id': '42', 'x-admin': 'true' } })).statusCode).toBe(401);
    }
  });

  it('limits auth attempts by direct peer IP and never trusts X-Forwarded-For', async () => {
    const h = await fixture();
    for (let index = 0; index < 20; index++) {
      expect((await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin, 'x-forwarded-for': `192.0.2.${index}` }, payload: { initData: 'invalid' } })).statusCode).toBe(401);
    }
    const blocked = await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin, 'x-forwarded-for': '198.51.100.2' }, payload: { initData: signedInit() } });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json()).toEqual({ error: { code: 'RATE_LIMITED' } });
    expect(blocked.headers['retry-after']).toBeDefined();
  });

  it('rejects oversized and malformed bodies without echoing content', async () => {
    const h = await fixture();
    const huge = await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload: { initData: 'PRIVATE_SENTINEL'.repeat(3000) } });
    expect(huge.statusCode).toBe(400);
    expect(huge.json()).toEqual({ error: { code: 'INVALID_INPUT' } });
    const malformed = await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin, 'content-type': 'application/json' }, payload: '{"PRIVATE_SENTINEL"' });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.body).not.toContain('PRIVATE_SENTINEL');
  });

  it('sanitizes malformed URL framework errors', async () => {
    const h = await fixture();
    const response = await h.inject({ method: 'GET', url: '/api/modules/%F0%ZZPRIVATE_SENTINEL/config' });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: { code: 'INVALID_INPUT' } });
  });
});

describe('HTTP authentication and CSRF', () => {
  it.each([true, false])('publishes only strict public login-method metadata (OIDC configured: %s)', async oidcConfigured => {
    const h = await fixture({ oidcConfigured });
    const response = await h.inject({ method: 'GET', url: '/auth/methods' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ oidc: oidcConfigured, miniapp: true });
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect((await h.inject({ method: 'GET', url: '/auth/methods?oidc=true' })).json()).toEqual({ error: { code: 'INVALID_INPUT' } });
    expect((await h.inject({ method: 'POST', url: '/auth/methods' })).statusCode).toBe(404);
    expect((await h.inject({ method: 'GET', url: '/api/me' })).statusCode).toBe(401);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('guards unconfigured OIDC routes without issuing cookies or granting anonymous API access', async () => {
    const h = await fixture({ oidcConfigured: false });
    const login = await h.inject({ method: 'GET', url: '/auth/login' });
    expect(login.statusCode).toBe(503);
    expect(login.json()).toEqual({ error: { code: 'UNAVAILABLE' } });
    expect(login.headers['set-cookie']).toBeUndefined();
    const callback = await h.inject({ method: 'GET', url: '/auth/callback?code=PRIVATE_CODE&state=PRIVATE_STATE' });
    expect(callback.statusCode).toBe(302);
    expect(callback.headers.location).toBe('/?auth_error=UNAVAILABLE');
    expect(callback.body).not.toContain('PRIVATE');
    expect(callback.cookies.some(value => value.value)).toBe(false);
    for (const url of ['/api/me', '/api/status', '/api/unknown']) {
      expect((await h.inject({ method: 'GET', url, headers: { 'x-user-id': '42', 'x-admin': 'true' } })).statusCode).toBe(401);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rotates opaque secure cookies, returns Me directly and strips OIDC callback secrets', async () => {
    const h = await fixture();
    const first = await h.browser();
    expect(first.me).toMatchObject({ user: { id: 42, name: 'Browser Admin' }, method: 'oidc', language: 'auto', resolvedLanguage: 'zh-CN' });
    expect(first.me.csrfToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const setCookie = String(first.response.headers['set-cookie']);
    expect(setCookie).toContain('HttpOnly'); expect(setCookie).toContain('Secure'); expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=3600'); expect(setCookie).not.toContain('Domain=');
    expect(first.response.headers.location).toBe('/');
    expect(first.response.body).not.toContain('private-code');
    const next = await h.browser(first.cookie);
    expect(next.cookie).not.toBe(first.cookie);
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: { cookie: first.cookie } })).statusCode).toBe(401);
    expect(first.response.cookies.find(value => value.name === LOGIN_COOKIE)?.value).toBe('');
  });

  it('redirects failed OIDC callbacks only to a clean allowlisted error', async () => {
    const h = await fixture({ oidc: {
      authorize: async attempt => new URL(`${OIDC_ISSUER}/auth?state=${attempt.state}`),
      exchange: async () => { throw new Error('PRIVATE_SENTINEL token=secret'); },
    } });
    const login = await h.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(login.headers.location!).searchParams.get('state');
    const binding = login.cookies.find(value => value.name === LOGIN_COOKIE)!.value;
    const result = await h.inject({ method: 'GET', url: `/auth/callback?state=${state}&code=PRIVATE_CODE`, headers: { cookie: `${LOGIN_COOKIE}=${binding}` } });
    expect(result.headers.location).toBe('/?auth_error=AUTH_INVALID');
    expect(result.body).not.toContain('PRIVATE');
    expect(result.cookies.some(value => value.name === SESSION_COOKIE && value.value)).toBe(false);
  });

  it('requires the browser-bound login cookie and rejects duplicate cookies', async () => {
    const h = await fixture();
    const login = await h.inject({ method: 'GET', url: '/auth/login' });
    const state = new URL(login.headers.location!).searchParams.get('state');
    const rejected = await h.inject({ method: 'GET', url: `/auth/callback?state=${state}&code=secret` });
    expect(rejected.headers.location).toBe('/?auth_error=AUTH_INVALID');
    expect(h.oidc.exchange).not.toHaveBeenCalled();
    const session = await h.browser();
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${session.cookie}; ${session.cookie}` } })).statusCode).toBe(401);
  });

  it('strips callback query secrets even when authentication rate limiting fires before the handler', async () => {
    const h = await fixture();
    for (let index = 0; index < 21; index++) {
      const response = await h.inject({ method: 'GET', url: '/auth/callback?code=PRIVATE_CODE&state=PRIVATE_STATE' });
      expect(response.statusCode).toBe(302);
      expect(response.headers.location).toBe(index === 20 ? '/?auth_error=RATE_LIMITED' : '/?auth_error=AUTH_INVALID');
      expect(response.body).not.toContain('PRIVATE');
    }
  });

  it.each([true, false])('creates bearer credentials from verified Mini App data without requiring a cookie (OIDC configured: %s)', async oidcConfigured => {
    const h = await fixture({ oidcConfigured }); const b = await h.bearer();
    expect(b.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Date.parse(b.expiresAt) - Date.now()).toBeGreaterThan(3_590_000);
    const me = await h.inject({ method: 'GET', url: '/api/me', headers: b.headers });
    expect(me.json()).toMatchObject({ user: { id: 42 }, method: 'miniapp', csrfToken: null, resolvedLanguage: 'en' });
    expect(me.headers['set-cookie']).toBeUndefined();
    expect((await h.inject({ method: 'PUT', url: '/api/preferences', headers: b.headers, payload: { language: 'zh-CN' } })).statusCode).toBe(200);
  });

  it.each([true, false])('rejects nonadmins at login and rechecks current admin status on every API request (OIDC configured: %s)', async oidcConfigured => {
    const h = await fixture({ oidcConfigured });
    expect((await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload: { initData: signedInit(43) } })).statusCode).toBe(403);
    const b = await h.bearer();
    vi.spyOn(h.access, 'isAdmin').mockReturnValue(false);
    for (const url of ['/api/me', '/api/status', '/api/unknown']) {
      const response = await h.inject({ method: 'GET', url, headers: b.headers });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'FORBIDDEN' } });
    }
    expect((await h.inject({ method: 'POST', url: '/auth/logout', headers: b.headers })).statusCode).toBe(204);
  });

  it('valid or invalid bearer never falls back to cookies', async () => {
    const h = await fixture(); const browser = await h.browser(); const miniapp = await h.bearer();
    for (const authorization of ['', 'Bearer forged', `Bearer ${'x'.repeat(43)}`, 'Basic anything']) {
      expect((await h.inject({ method: 'GET', url: '/api/me', headers: { cookie: browser.cookie, authorization } })).statusCode).toBe(401);
    }
    const response = await h.inject({ method: 'GET', url: '/api/me', headers: { cookie: browser.cookie, authorization: miniapp.headers.authorization } });
    expect(response.json<Me>().method).toBe('miniapp');
  });

  it('preserves Mini App strict input, replay, Origin and credential-type checks without OIDC', async () => {
    const h = await fixture({ oidcConfigured: false });
    const initData = signedInit();
    for (const payload of [{ initData, actorId: 42 }, { initData, admin: true }]) {
      expect((await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload })).statusCode).toBe(401);
    }
    expect((await h.inject({ method: 'POST', url: '/auth/miniapp', payload: { initData } })).statusCode).toBe(403);
    const login = await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload: { initData } });
    expect(login.statusCode).toBe(200);
    expect(login.headers['set-cookie']).toBeUndefined();
    const { token } = login.json<{ token: string }>();
    expect((await h.inject({ method: 'POST', url: '/auth/miniapp', headers: { origin }, payload: { initData } })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: { cookie: `${SESSION_COOKIE}=${token}` } })).statusCode).toBe(401);
    const headers = { authorization: `Bearer ${token}`, origin };
    for (const invalid of [{ origin: 'https://attacker.example' }, { origin, 'sec-fetch-site': 'cross-site' }]) {
      expect((await h.inject({ method: 'PUT', url: '/api/preferences', headers: { ...headers, ...invalid }, payload: { language: 'en' } })).statusCode).toBe(403);
    }
    expect((await h.inject({ method: 'POST', url: '/auth/logout', headers })).statusCode).toBe(204);
    expect((await h.inject({ method: 'GET', url: '/api/me', headers })).statusCode).toBe(401);
  });

  it.each([undefined, 'null', 'http://console.example', 'https://attacker.example', 'https://console.example.attacker.example'])('requires exact same Origin on cookie and bearer mutations: %s', async suppliedOrigin => {
    const h = await fixture(); const b = await h.bearer(); const c = await h.browser();
    for (const headers of [b.headers, c.headers]) {
      const response = await h.inject({ method: 'PUT', url: '/api/preferences', payload: { language: 'en' }, headers: { ...headers, origin: suppliedOrigin } });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toEqual({ error: { code: 'INVALID_ORIGIN' } });
    }
  });

  it('requires cookie CSRF and rejects a cross-site fetch even with otherwise matching headers', async () => {
    const h = await fixture(); const c = await h.browser();
    for (const csrf of [undefined, 'wrong-token']) {
      const response = await h.inject({ method: 'PUT', url: '/api/preferences', headers: { cookie: c.cookie, origin, 'x-csrf-token': csrf }, payload: { language: 'en' } });
      expect(response.json()).toEqual({ error: { code: 'CSRF_INVALID' } });
    }
    expect((await h.inject({ method: 'PUT', url: '/api/preferences', headers: { ...c.headers, 'sec-fetch-site': 'cross-site' }, payload: { language: 'en' } })).statusCode).toBe(403);
    expect((await h.inject({ method: 'PUT', url: '/api/preferences', headers: c.headers, payload: { language: 'en' } })).statusCode).toBe(200);
  });

  it('logout revokes the selected session and clears cookies', async () => {
    const h = await fixture(); const c = await h.browser(); const b = await h.bearer();
    const response = await h.inject({ method: 'POST', url: '/auth/logout', headers: c.headers });
    expect(response.statusCode).toBe(204);
    expect(response.cookies.find(value => value.name === SESSION_COOKIE)?.value).toBe('');
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: c.headers })).statusCode).toBe(401);
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: b.headers })).statusCode).toBe(200);
    expect((await h.inject({ method: 'POST', url: '/auth/logout', headers: b.headers })).statusCode).toBe(204);
    expect((await h.inject({ method: 'GET', url: '/api/me', headers: b.headers })).statusCode).toBe(401);
  });
});

describe('HTTP adapters share the real Action executor', () => {
  it('reads status, schema, native registry, RSS, groups and preferences as ActionResult', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    for (const url of ['/api/status', '/api/settings/core', '/api/settings/core/schema', '/api/modules', '/api/groups?page=0', '/api/preferences', '/api/rss?page=0']) {
      const response = await h.inject({ method: 'GET', url, headers });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({ status: 'succeeded', invocationId: expect.any(String) });
      expect(response.body).not.toContain(config.botToken);
      expect(response.body).not.toContain(config.web.oidcClientSecret);
    }
    expect((await h.inject({ method: 'GET', url: '/api/modules', headers })).json()).toMatchObject({ data: [aliasMetadata, rssMetadata, rateMetadata, weatherMetadata, stickerMetadata, subconvMetadata] });
    const http = (await h.inject({ method: 'GET', url: '/api/status', headers })).json<ActionResult>();
    const telegram = await h.executor.execute(createInvocation({ actorId: 42, source: 'telegram', botId: 123456789, chat: { id: 42, type: 'private' }, language: 'en' }), 'core.status', {});
    expect(http.status === 'succeeded' && http.data).toEqual(telegram.status === 'succeeded' && telegram.data);
  });

  it('binds actor/source/chat/bot/language/deadline exclusively from trusted authentication', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    const execute = vi.spyOn(h.executor, 'execute');
    const response = await h.inject({ method: 'PUT', url: '/api/preferences', headers: { ...headers, 'x-user-id': '999', 'x-invocation-id': 'forged', 'accept-language': 'zh' }, payload: { language: 'en' } });
    expect(response.statusCode).toBe(200);
    expect(execute.mock.calls[0]![0]).toMatchObject({ actorId: 42, source: 'http', botId: 123456789, chat: { id: 42, type: 'private' }, language: 'en', languageHint: 'en', dataScope: { kind: 'user', id: 42 } });
    expect(execute.mock.calls[0]![0].signal).toBeInstanceOf(AbortSignal);
    expect(execute.mock.calls[0]![0].invocationId).not.toBe('forged');
    expect(execute.mock.calls[0]![0].deadline).toBeGreaterThan(Date.now());
  });

  it.each([
    ['/api/preferences', { language: 'en', actorId: 999 }],
    ['/api/preferences', { language: 'en', source: 'telegram' }],
    ['/api/preferences', { language: 'en', confirmed: true }],
    ['/api/groups', { chatId: '-100123', revision: 0 }],
    ['/api/groups', { chatId: -100123, revision: '0' }],
    ['/api/groups', { chatId: -100123, revision: 0, admin: true }],
    ['/api/settings/core', { revision: 0, settings: { defaultLanguage: 'en', botToken: 'PRIVATE_SENTINEL' } }],
    ['/api/settings/core', { revision: '0', settings: { defaultLanguage: 'en' } }],
  ])('rejects instead of stripping/coercing invalid input at %s', async (url, payload) => {
    const h = await fixture(); const { headers } = await h.bearer();
    const response = await h.inject({ method: 'PUT', url, headers, payload });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(response.body).not.toContain('PRIVATE_SENTINEL');
    expect(h.access.count()).toBe(0);
  });

  it.each(['?page=0&page=1', '?page=1.5', '?page=-1', '?page=1e3', '?page=999999999999999999', '?page=0&actorId=42'])('rejects ambiguous or out-of-bounds pagination %s', async query => {
    const h = await fixture(); const { headers } = await h.bearer();
    expect((await h.inject({ method: 'GET', url: `/api/groups${query}`, headers })).statusCode).toBe(400);
  });

  it('authorizes a group, requires server-held one-use confirmation to revoke, and persists via the same store', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    const added = await h.inject({ method: 'PUT', url: '/api/groups', headers, payload: { chatId: -100123, revision: 0 } });
    expect(added.statusCode).toBe(200); expect(h.access.isAllowed(-100123)).toBe(true);
    const requested = await h.inject({ method: 'POST', url: '/api/groups/revoke', headers, payload: { chatId: -100123, revision: 1 } });
    const pending = requested.json<ActionResult>();
    expect(pending.status).toBe('pending_confirmation');
    if (pending.status !== 'pending_confirmation') throw new Error('Expected pending confirmation');
    expect(h.access.isAllowed(-100123)).toBe(true);
    const confirmed = await h.inject({ method: 'POST', url: '/api/confirm', headers, payload: { token: pending.confirmation.token } });
    expect(confirmed.statusCode).toBe(200); expect(h.access.isAllowed(-100123)).toBe(false);
    expect(h.effects.leaveGroup).toHaveBeenCalledOnce();
    expect((await h.inject({ method: 'POST', url: '/api/confirm', headers, payload: { token: pending.confirmation.token } })).statusCode).toBe(409);
    expect(JSON.parse(await readFile(join(h.storage.directory, 'access.json'), 'utf8')).groups).toEqual({});
  });

  it('rejects fabricated confirmation authority and maintains revision conflicts', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    expect((await h.inject({ method: 'POST', url: '/api/confirm', headers, payload: { token: 'a'.repeat(40), actorId: 42, confirmed: true } })).statusCode).toBe(400);
    const payload = { revision: 0, settings: { defaultLanguage: 'en' } };
    expect((await h.inject({ method: 'PUT', url: '/api/settings/core', headers, payload })).statusCode).toBe(200);
    const stale = await h.inject({ method: 'PUT', url: '/api/settings/core', headers, payload });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it('rejects legacy and nonconfigurable alias schema/config requests through the executor without writes', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    const execute = vi.spyOn(h.executor, 'execute');
    for (const [method, url] of [['GET', '/api/modules/ai/schema'], ['GET', '/api/modules/rss/config'], ['PUT', '/api/modules/echo/config'],
      ['GET', '/api/modules/alias/schema'], ['GET', '/api/modules/alias/config'], ['PUT', '/api/modules/alias/config']] as const) {
      const response = await h.inject({ method, url, headers, ...(method === 'PUT' ? { payload: { path: '../private', enabled: true } } : {}) });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    }
    expect(execute.mock.calls.map(call => call[1])).toEqual(['modules.schema', 'modules.config.get', 'modules.config.update',
      'modules.schema', 'modules.config.get', 'modules.config.update']);
    expect(h.configuration.settings().revision).toBe(0);
    expect(h.aliases.snapshot().revision).toBe(0);
  });

  it('never returns raw framework or executor exceptions', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    vi.spyOn(h.executor, 'execute').mockRejectedValue(new Error('PRIVATE_SENTINEL token=secret'));
    const response = await h.inject({ method: 'GET', url: '/api/status?secret=PRIVATE_QUERY', headers });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ status: 'failed', invocationId: expect.any(String), error: { code: 'INTERNAL_ERROR' } });
    expect(response.body).not.toContain('PRIVATE');
  });
});

describe('HTTP cancellation and lifecycle', () => {
  it('propagates HTTP preClose into a real in-flight store write and waits for cancellation cleanup', async () => {
    let block = false;
    const started = Promise.withResolvers<void>(); const observed = vi.fn();
    const h = await fixture({ storage: { beforeCommit: async (_file, signal) => {
      if (!block) return;
      started.resolve();
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => { observed(); resolve(); }, { once: true }));
    } } });
    const { headers } = await h.bearer(); block = true;
    const pending = h.inject({ method: 'PUT', url: '/api/preferences', headers, payload: { language: 'zh-CN' } }).then(response => response);
    await started.promise;
    await h.server.close();
    const response = await pending;
    expect(observed).toHaveBeenCalledOnce();
    expect(response.json()).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(h.configuration.getPreference(42).language).toBe('auto');
    expect(JSON.parse(await readFile(join(h.storage.directory, 'preferences.json'), 'utf8')).users).toEqual({});
  });

  it('links the parent abort signal to HTTP requests and rejects future work', async () => {
    const parent = new AbortController(); const h = await fixture({ signal: parent.signal });
    const { headers } = await h.bearer();
    const started = Promise.withResolvers<void>(); const observed = vi.fn();
    vi.spyOn(h.executor, 'execute').mockImplementation(async context => {
      started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { observed(); resolve(); }, { once: true }));
      return { status: 'failed', invocationId: context.invocationId, error: { code: 'CANCELLED' } };
    });
    const pending = h.inject({ method: 'GET', url: '/api/status', headers }).then(response => response);
    await started.promise; parent.abort();
    expect((await pending).statusCode).toBe(499);
    expect(observed).toHaveBeenCalledOnce();
    expect((await h.inject({ method: 'GET', url: '/api/status', headers })).statusCode).toBe(499);
  });

  it('cancels work when a real HTTP client disconnects', async () => {
    const h = await fixture(); const { headers } = await h.bearer();
    const started = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
    const cleanupGate = Promise.withResolvers<void>();
    let cleaned = false;
    vi.spyOn(h.executor, 'execute').mockImplementation(async context => {
      started.resolve();
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { aborted.resolve(); resolve(); }, { once: true }));
      await cleanupGate.promise;
      cleaned = true;
      return { status: 'failed', invocationId: context.invocationId, error: { code: 'CANCELLED' } };
    });
    await h.server.listen({ host: '127.0.0.1', port: 0 });
    const address = h.server.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const request = httpRequest({ hostname: '127.0.0.1', port: address.port, path: '/api/status', headers: { ...headers, host: 'console.example' } });
    request.on('error', () => undefined); request.end();
    await started.promise; request.destroy(); await aborted.promise;
    expect(request.destroyed).toBe(true);
    let closed = false;
    const closing = h.server.close().then(() => { closed = true; });
    await new Promise<void>(resolve => setImmediate(resolve));
    try { expect(closed).toBe(false); }
    finally { cleanupGate.resolve(); await closing; }
    expect(cleaned).toBe(true);
  });

  it('abortable operation timeout is observable by the underlying executor', async () => {
    const h = await fixture({ timeout: 1 }); const { headers } = await h.bearer();
    const observed = vi.fn();
    vi.spyOn(h.executor, 'execute').mockImplementation(async context => {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => { observed(context.signal.reason); resolve(); }, { once: true }));
      return { status: 'failed', invocationId: context.invocationId, error: { code: 'TIMEOUT' } };
    });
    const response = await h.inject({ method: 'GET', url: '/api/status', headers });
    expect(response.statusCode).toBe(504);
    expect(observed).toHaveBeenCalledWith(expect.objectContaining({ code: 'TIMEOUT' }));
  });

  it('surfaces a local bind failure without leaving HTTP resources running', async () => {
    const first = await fixture(); const second = await fixture();
    await first.server.listen({ host: '127.0.0.1', port: 0 });
    const address = first.server.server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    await expect(second.server.listen({ host: '127.0.0.1', port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
    await second.server.close();
    expect(second.server.server.listening).toBe(false);
  });
});
