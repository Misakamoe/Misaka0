import { createHmac } from 'node:crypto';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT, type JWK, type JWTPayload } from 'jose';
import type { CustomFetch } from 'openid-client';
import type { StartupConfig } from '../src/config.js';
import { createOidcAdapter, OIDC_ISSUER, WebAuth, type OidcAdapter } from '../src/web/auth.js';

const config: StartupConfig = {
  botToken: '123456789:TEST_ONLY_NOT_A_REAL_BOT_TOKEN_000000', adminIds: [42], dataDir: '/tmp/kilo/web-auth-test',
  logLevel: 'silent', pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
  web: { enabled: true, host: '127.0.0.1', port: 8080, publicBaseUrl: 'https://console.example', oidcClientId: '123456789', oidcClientSecret: 'test-only-client-secret' },
};
const signal = () => new AbortController().signal;
const attempt = { state: 'state', nonce: 'nonce', verifier: 'a'.repeat(43) };
const callback = () => new URL('https://console.example/auth/callback?state=state&code=private-code');
const mockOidc = (): OidcAdapter => ({
  authorize: vi.fn(async value => new URL(`${OIDC_ISSUER}/auth?state=${value.state}&nonce=${value.nonce}`)),
  exchange: vi.fn(async () => ({ id: 42, name: 'Admin' })),
});
function signedInit(fields: Record<string, string> = {}, token = config.botToken): string {
  const params = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 42, first_name: 'Admin', language_code: 'en' }), ...fields });
  const data = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(token).digest();
  params.set('hash', createHmac('sha256', key).update(data).digest('hex'));
  return params.toString();
}

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let rotated: Awaited<ReturnType<typeof generateKeyPair>>;
let jwk: JWK;
let rotatedJwk: JWK;
beforeAll(async () => {
  keys = await generateKeyPair('RS256');
  rotated = await generateKeyPair('RS256');
  jwk = { ...await exportJWK(keys.publicKey), kid: 'first', alg: 'RS256', use: 'sig' };
  rotatedJwk = { ...await exportJWK(rotated.publicKey), kid: 'rotated', alg: 'RS256', use: 'sig' };
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function realOidc(patch: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims: JWTPayload = { iss: OIDC_ISSUER, aud: config.web.oidcClientId, sub: 'NOT_THE_TELEGRAM_ID', id: 42, name: 'Admin', nonce: attempt.nonce, iat: now, exp: now + 3600, ...patch };
  const state = { privateKey: keys.privateKey, jwks: [jwk], kid: 'first' };
  const customFetch: CustomFetch = vi.fn(async (url, init) => {
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    if (url === `${OIDC_ISSUER}/token`) {
      const body = new URLSearchParams(init.body as string);
      expect(body.get('grant_type')).toBe('authorization_code');
      expect(body.get('code_verifier')).toHaveLength(43);
      expect(body.get('redirect_uri')).toBe('https://console.example/auth/callback');
      const authorization = new Headers(init.headers).get('authorization')!;
      expect(authorization.startsWith('Basic ')).toBe(true);
      expect(Buffer.from(authorization.slice(6), 'base64').toString().split(':').map(decodeURIComponent)).toEqual(['123456789', 'test-only-client-secret']);
      const idToken = await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: state.kid }).sign(state.privateKey);
      return Response.json({ token_type: 'Bearer', access_token: 'private-access-token', expires_in: 3600, id_token: idToken });
    }
    if (url === `${OIDC_ISSUER}/.well-known/jwks.json`) return Response.json({ keys: state.jwks });
    throw new Error('Unexpected outbound request');
  });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('No live network'); }));
  return { adapter: createOidcAdapter(config, { customFetch }), customFetch, claims, state };
}

describe('production OIDC with mocked token and JWKS endpoints', () => {
  it('constructs without network and authorizes only openid profile using state, nonce and S256', async () => {
    const h = realOidc();
    expect(h.customFetch).not.toHaveBeenCalled();
    const url = await h.adapter.authorize(attempt, signal());
    expect(url.origin + url.pathname).toBe(`${OIDC_ISSUER}/auth`);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ scope: 'openid profile', response_type: 'code', state: 'state', nonce: 'nonce', code_challenge_method: 'S256', redirect_uri: 'https://console.example/auth/callback' });
    expect(url.searchParams.get('code_challenge')).not.toBe(attempt.verifier);
    expect(url.href).not.toContain(config.web.oidcClientSecret);
    expect(h.customFetch).not.toHaveBeenCalled();
  });

  it('verifies signatures and returns Telegram id, never sub', async () => {
    const h = realOidc();
    await expect(h.adapter.exchange(callback(), attempt, signal())).resolves.toEqual({ id: 42, name: 'Admin' });
    expect(h.customFetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['wrong issuer', { iss: 'https://attacker.example' }],
    ['wrong audience', { aud: 'another-client' }],
    ['wrong nonce', { nonce: 'attacker' }],
    ['missing nonce', { nonce: undefined }],
    ['missing Telegram id', { id: undefined, sub: '42' }],
    ['string Telegram id', { id: '42' }],
    ['unsafe Telegram id', { id: Number.MAX_SAFE_INTEGER + 1 }],
    ['negative Telegram id', { id: -42 }],
    ['bot account', { is_bot: true }],
    ['missing issued time', { iat: undefined }],
    ['missing expiry', { exp: undefined }],
    ['multi-audience without azp', { aud: ['123456789', 'other'] }],
    ['wrong azp', { aud: ['123456789', 'other'], azp: 'other' }],
  ])('rejects %s without exposing claims or provider errors', async (_name, patch) => {
    const h = realOidc(patch);
    await expect(h.adapter.exchange(callback(), attempt, signal())).rejects.toMatchObject({ code: 'AUTH_INVALID', message: 'AUTH_INVALID' });
  });

  it.each([
    ['expired', -1, 0], ['future issued', 3600, 31], ['old issued', 3600, -301], ['expiry before issuance', 1, 2],
  ])('rejects %s timestamp boundaries', async (_name, expiry, issued) => {
    const now = Math.floor(Date.now() / 1000);
    const h = realOidc({ iat: now + issued, exp: now + expiry });
    await expect(h.adapter.exchange(callback(), attempt, signal())).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('rejects a forged signature even when claims match', async () => {
    const h = realOidc();
    h.state.privateKey = rotated.privateKey;
    await expect(h.adapter.exchange(callback(), attempt, signal())).rejects.toMatchObject({ code: 'AUTH_INVALID' });
  });

  it('uses newly rotated provider keys on the next exchange', async () => {
    const h = realOidc();
    await h.adapter.exchange(callback(), attempt, signal());
    h.state.privateKey = rotated.privateKey;
    h.state.kid = 'rotated';
    h.state.jwks = [rotatedJwk];
    await expect(h.adapter.exchange(callback(), attempt, signal())).resolves.toMatchObject({ id: 42 });
    expect(h.customFetch).toHaveBeenCalledTimes(4);
  });

  it('rejects mismatched callback state before making a network request', async () => {
    const h = realOidc();
    const url = callback(); url.searchParams.set('state', 'forged');
    await expect(h.adapter.exchange(url, attempt, signal())).rejects.toMatchObject({ code: 'AUTH_INVALID' });
    expect(h.customFetch).not.toHaveBeenCalled();
  });

  it('cancels the underlying token HTTP fetch, not just a racing promise', async () => {
    const started = Promise.withResolvers<void>();
    const aborted = vi.fn();
    const customFetch: CustomFetch = vi.fn(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => { aborted(); reject(new Error('private upstream failure')); }, { once: true });
      started.resolve();
    }));
    const controller = new AbortController();
    const pending = createOidcAdapter(config, { customFetch }).exchange(callback(), attempt, controller.signal);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(aborted).toHaveBeenCalledOnce();
  });
});

describe('one-use browser-bound attempts and memory sessions', () => {
  const make = (options: Partial<ConstructorParameters<typeof WebAuth>[0]> = {}) => new WebAuth({ config, isAdmin: id => id === 42, oidc: mockOidc(), ...options });
  const finishUrl = (url: URL) => new URL(`https://console.example/auth/callback?state=${url.searchParams.get('state')}&code=private-code`);

  it('rotates cookies, issues independent CSRF tokens, supports revocation and close', async () => {
    const auth = make();
    const first = await auth.begin(signal());
    const a = await auth.finish(finishUrl(first.url), first.binding, undefined, signal());
    const next = await auth.begin(signal());
    const b = await auth.finish(finishUrl(next.url), next.binding, a.token, signal());
    expect(b.token).not.toBe(a.token);
    expect(b.session.csrfToken).not.toBe(a.session.csrfToken);
    expect(b.session.expiresAt - Date.now()).toBeGreaterThan(3_590_000);
    expect(() => auth.authenticate(undefined, a.token)).toThrow('AUTH_EXPIRED');
    expect(auth.authenticate(undefined, b.token).session.id).toBe(42);
    auth.revoke(b.token);
    expect(() => auth.authenticate(undefined, b.token)).toThrow('AUTH_EXPIRED');
    auth.close();
  });

  it('rejects stolen state without browser binding and consumes the failed attempt', async () => {
    const oidc = mockOidc(); const auth = make({ oidc });
    const login = await auth.begin(signal());
    const url = finishUrl(login.url);
    await expect(auth.finish(url, 'different-browser', undefined, signal())).rejects.toThrow('AUTH_INVALID');
    await expect(auth.finish(url, login.binding, undefined, signal())).rejects.toThrow('AUTH_INVALID');
    expect(oidc.exchange).not.toHaveBeenCalled();
  });

  it('allows exactly one callback exchange under concurrent replay', async () => {
    const oidc = mockOidc(); const auth = make({ oidc });
    const login = await auth.begin(signal());
    const results = await Promise.allSettled([auth.finish(finishUrl(login.url), login.binding, undefined, signal()), auth.finish(finishUrl(login.url), login.binding, undefined, signal())]);
    expect(results.map(result => result.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(oidc.exchange).toHaveBeenCalledOnce();
  });

  it.each(['&state=duplicate', '&returnTo=https://attacker.example', '&error=private-provider-error', '&code=duplicate'])('rejects ambiguous callback %s', async extra => {
    const oidc = mockOidc(); const auth = make({ oidc });
    const login = await auth.begin(signal());
    await expect(auth.finish(new URL(finishUrl(login.url).href + extra), login.binding, undefined, signal())).rejects.toThrow('AUTH_INVALID');
    expect(oidc.exchange).not.toHaveBeenCalled();
  });

  it('bounds attempt capacity and expires attempts after five minutes', async () => {
    let now = Date.now(); const auth = make({ now: () => now, attemptCapacity: 1 });
    const login = await auth.begin(signal());
    await expect(auth.begin(signal())).rejects.toThrow('CAPACITY');
    now += 300_000;
    await expect(auth.finish(finishUrl(login.url), login.binding, undefined, signal())).rejects.toThrow('AUTH_INVALID');
    await expect(auth.begin(signal())).resolves.toHaveProperty('binding');
  });

  it('expires sessions absolutely after one hour even if used, and prunes capacity', () => {
    let now = Date.now(); const auth = make({ now: () => now, sessionCapacity: 1 });
    const first = auth.miniapp(signedInit(), signal());
    auth.authenticate(`Bearer ${first.token}`, undefined);
    expect(() => auth.miniapp(signedInit({ query_id: 'another' }), signal())).toThrow('CAPACITY');
    now += 3_600_000;
    expect(() => auth.authenticate(`Bearer ${first.token}`, undefined)).toThrow('AUTH_EXPIRED');
    expect(auth.miniapp(signedInit({ auth_date: String(Math.floor(now / 1000)) }), signal()).session.id).toBe(42);
  });

  it('denies valid identities that are not current configured admins', async () => {
    const auth = make({ isAdmin: () => false });
    expect(() => auth.miniapp(signedInit(), signal())).toThrow('FORBIDDEN');
    const login = await auth.begin(signal());
    await expect(auth.finish(finishUrl(login.url), login.binding, undefined, signal())).rejects.toThrow('FORBIDDEN');
  });

  it('does not fall back from invalid bearer to valid cookie or mix credential types', async () => {
    const auth = make(); const login = await auth.begin(signal());
    const browser = await auth.finish(finishUrl(login.url), login.binding, undefined, signal());
    const miniapp = auth.miniapp(signedInit(), signal());
    expect(() => auth.authenticate('Bearer bogus', browser.token)).toThrow('AUTH_INVALID');
    expect(() => auth.authenticate(`Bearer ${'x'.repeat(43)}`, browser.token)).toThrow('AUTH_EXPIRED');
    expect(() => auth.authenticate(`Bearer ${browser.token}`, undefined)).toThrow('AUTH_INVALID');
    expect(() => auth.authenticate(undefined, miniapp.token)).toThrow('AUTH_INVALID');
    expect(auth.authenticate(`Bearer ${miniapp.token}`, browser.token).session.method).toBe('miniapp');
  });

  it('never creates credentials for a cancelled operation', async () => {
    const auth = make(); const controller = new AbortController(); controller.abort();
    await expect(auth.begin(controller.signal)).rejects.toThrow('CANCELLED');
    expect(() => auth.miniapp(signedInit(), controller.signal)).toThrow('CANCELLED');
  });
});

describe('Telegram Mini App original HMAC validation', () => {
  const make = (options: Partial<ConstructorParameters<typeof WebAuth>[0]> = {}) => new WebAuth({ config, isAdmin: () => true, oidc: mockOidc(), ...options });
  it('accepts original signed fields including signature, then rejects replay despite reordering', () => {
    const auth = make(); const initData = signedInit({ signature: 'official-additional-signature', query_id: 'q' });
    const login = auth.miniapp(initData, signal());
    expect(login.session).toMatchObject({ id: 42, name: 'Admin', languageHint: 'en', method: 'miniapp', csrfToken: null });
    expect(() => auth.miniapp([...new URLSearchParams(initData)].reverse().map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('&'), signal())).toThrow('AUTH_INVALID');
  });

  it.each([
    ['another bot', () => signedInit({}, '987654321:DIFFERENT_TEST_TOKEN')],
    ['tampered user', () => signedInit().replace('Admin', 'Attacker')],
    ['duplicate hash', () => signedInit() + '&hash=' + '0'.repeat(64)],
    ['duplicate field', () => signedInit() + '&auth_date=1'],
    ['encoded duplicate', () => signedInit() + '&%75ser=null'],
    ['malformed percent', () => signedInit() + '&extra=%Q0'],
    ['oversized', () => 'x'.repeat(16_385)],
    ['empty', () => ''],
    ['invalid hash', () => signedInit().replace(/hash=.+$/, 'hash=invalid')],
    ['missing user', () => signedInit({ user: '' })],
    ['broken user JSON', () => signedInit({ user: '{secret' })],
    ['non-object user', () => signedInit({ user: '42' })],
    ['array user', () => signedInit({ user: '[]' })],
    ['user without id', () => signedInit({ user: '{"first_name":"Admin"}' })],
    ['string user id', () => signedInit({ user: '{"id":"42","first_name":"Admin"}' })],
    ['negative user id', () => signedInit({ user: '{"id":-42,"first_name":"Admin"}' })],
    ['unsafe user id', () => signedInit({ user: '{"id":9007199254740992,"first_name":"Admin"}' })],
    ['bot user', () => signedInit({ user: '{"id":42,"first_name":"Bot","is_bot":true}' })],
    ['invalid language', () => signedInit({ user: '{"id":42,"first_name":"Admin","language_code":123}' })],
    ['missing date', () => signedInit({ auth_date: '' })],
    ['exponential date', () => signedInit({ auth_date: '1e9' })],
    ['old date', () => signedInit({ auth_date: String(Math.floor(Date.now() / 1000) - 301) })],
    ['future date', () => signedInit({ auth_date: String(Math.floor(Date.now() / 1000) + 31) })],
  ])('rejects %s', (_name, build) => {
    expect(() => make().miniapp(build(), signal())).toThrow('AUTH_INVALID');
  });

  it('accepts bounded clock skew but keeps future credentials in replay cache until no longer valid', () => {
    let now = Math.floor(Date.now() / 1000) * 1000;
    const auth = make({ now: () => now, replayCapacity: 1 });
    const future = signedInit({ auth_date: String(now / 1000 + 30) });
    auth.miniapp(future, signal());
    now += 300_000;
    expect(() => auth.miniapp(future, signal())).toThrow('AUTH_INVALID');
    expect(() => auth.miniapp(signedInit({ auth_date: String(now / 1000) }), signal())).toThrow('CAPACITY');
    now += 30_001;
    expect(auth.miniapp(signedInit({ auth_date: String(Math.floor(now / 1000)) }), signal()).session.id).toBe(42);
  });
});
