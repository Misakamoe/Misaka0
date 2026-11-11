import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CustomFetch } from 'openid-client';
import type { StartupConfig } from '../config.js';
import { AppError, throwIfAborted } from '../errors.js';

export const OIDC_ISSUER = 'https://oauth.telegram.org';
export const SESSION_COOKIE = '__Host-misaka_session';
export const LOGIN_COOKIE = '__Host-misaka_login';
const SESSION_TTL = 60 * 60 * 1000;
const LOGIN_TTL = 5 * 60 * 1000;
const FUTURE_SKEW = 30;
const opaque = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const validId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function secretEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

export interface Identity {
  id: number;
  name: string;
  languageHint?: string;
}

export interface OidcAttempt {
  state: string;
  nonce: string;
  verifier: string;
}

export interface OidcAdapter {
  authorize(attempt: OidcAttempt, signal: AbortSignal): Promise<URL>;
  exchange(callback: URL, attempt: OidcAttempt, signal: AbortSignal): Promise<Identity>;
}

/** Official metadata is pinned: discovery cannot change issuer or credential destinations. */
export function createOidcAdapter(config: StartupConfig, options: { customFetch?: CustomFetch } = {}): OidcAdapter {
  const { publicBaseUrl, oidcClientId, oidcClientSecret } = config.web;
  if (!publicBaseUrl || !oidcClientId || !oidcClientSecret) throw new AppError('UNAVAILABLE');
  const redirectUri = `${publicBaseUrl}/auth/callback`;
  let library: Promise<typeof import('openid-client')> | undefined;
  const load = () => library ??= import('openid-client');
  const configuration = (signal: AbortSignal, client: typeof import('openid-client')) => {
    const oidc = new client.Configuration({
      issuer: OIDC_ISSUER,
      authorization_endpoint: `${OIDC_ISSUER}/auth`,
      token_endpoint: `${OIDC_ISSUER}/token`,
      jwks_uri: `${OIDC_ISSUER}/.well-known/jwks.json`,
      response_types_supported: ['code'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
    }, oidcClientId, { client_secret: oidcClientSecret, [client.clockTolerance]: 0 }, client.ClientSecretBasic(oidcClientSecret));
    oidc.timeout = Math.min(config.requestTimeout, 15);
    oidc[client.customFetch] = (url, init) => {
      throwIfAborted(signal);
      if (![`${OIDC_ISSUER}/token`, `${OIDC_ISSUER}/.well-known/jwks.json`].includes(String(url))) throw new AppError('AUTH_INVALID');
      const combined = init.signal ? AbortSignal.any([signal, init.signal]) : signal;
      if (options.customFetch) return options.customFetch(url, { ...init, signal: combined });
      return fetch(url, { ...init, signal: combined, body: init.body instanceof Uint8Array ? new Uint8Array(init.body) : init.body });
    };
    // Code-flow tokens are not signature-checked by openid-client unless explicitly enabled.
    client.enableNonRepudiationChecks(oidc);
    return oidc;
  };
  return {
    async authorize(attempt, signal) {
      throwIfAborted(signal);
      const client = await load();
      throwIfAborted(signal);
      const challenge = await client.calculatePKCECodeChallenge(attempt.verifier);
      throwIfAborted(signal);
      return client.buildAuthorizationUrl(configuration(signal, client), {
        redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile',
        state: attempt.state, nonce: attempt.nonce,
        code_challenge: challenge, code_challenge_method: 'S256',
      });
    },
    async exchange(callback, attempt, signal) {
      try {
        throwIfAborted(signal);
        if (callback.origin + callback.pathname !== redirectUri || callback.hash) throw new AppError('AUTH_INVALID');
        const client = await load();
        throwIfAborted(signal);
        // A fresh client per exchange fetches the current JWKS, including rotated keys.
        const tokens = await client.authorizationCodeGrant(configuration(signal, client), callback, {
          expectedState: attempt.state, expectedNonce: attempt.nonce,
          pkceCodeVerifier: attempt.verifier, idTokenExpected: true,
        });
        throwIfAborted(signal);
        const claims = tokens.claims();
        const now = Math.floor(Date.now() / 1000);
        if (!claims || claims.iss !== OIDC_ISSUER || !validId(claims.id)
          || !Number.isSafeInteger(claims.iat) || !Number.isSafeInteger(claims.exp)
          || claims.iat > now + FUTURE_SKEW || claims.iat < now - 300
          || claims.exp <= now || claims.exp <= claims.iat
          || claims.nonce !== attempt.nonce
          || !(claims.aud === oidcClientId || (Array.isArray(claims.aud) && claims.aud.includes(oidcClientId)))
          || (claims.is_bot !== undefined && claims.is_bot !== false)) throw new AppError('AUTH_INVALID');
        return { id: claims.id, name: typeof claims.name === 'string' ? claims.name.slice(0, 128) : String(claims.id) };
      } catch {
        throwIfAborted(signal);
        throw new AppError('AUTH_INVALID');
      }
    },
  };
}

class ExpiringMap<T extends { expiresAt: number }> {
  private readonly values = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  constructor(private readonly capacity: number, private readonly now: () => number,
    private readonly maxBytes: number, private readonly measure: (key: string, value: T) => number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new AppError('INVALID_INPUT');
  }
  prune(): void {
    for (const [key, entry] of this.values) if (entry.value.expiresAt <= this.now()) this.delete(key);
  }
  get(key: string): T | undefined { this.prune(); return this.values.get(key)?.value; }
  delete(key: string): void {
    const entry = this.values.get(key);
    if (entry) { this.bytes -= entry.bytes; this.values.delete(key); }
  }
  set(key: string, value: T): void {
    this.prune();
    const bytes = this.measure(key, value);
    const total = this.bytes - (this.values.get(key)?.bytes ?? 0) + bytes;
    if (this.values.size >= this.capacity && !this.values.has(key)) throw new AppError('CAPACITY');
    if (total > this.maxBytes) throw new AppError('CAPACITY');
    this.values.set(key, { value, bytes }); this.bytes = total;
  }
  clear(): void { this.values.clear(); this.bytes = 0; }
}

export interface Session extends Identity {
  method: 'oidc' | 'miniapp';
  expiresAt: number;
  csrfToken: string | null;
}

/** Each factory owns its credentials; nothing is stored or scheduled at import time. */
export class WebAuth {
  private readonly now: () => number;
  private readonly sessions: ExpiringMap<Session>;
  private readonly attempts: ExpiringMap<OidcAttempt & { binding: string; expiresAt: number }>;
  private readonly replays: ExpiringMap<{ expiresAt: number }>;
  private readonly oidc: OidcAdapter | undefined;

  constructor(private readonly options: {
    config: StartupConfig;
    isAdmin: (id: number) => boolean;
    oidc?: OidcAdapter;
    now?: () => number;
    sessionCapacity?: number;
    attemptCapacity?: number;
    replayCapacity?: number;
    sessionBytes?: number;
    attemptBytes?: number;
    replayBytes?: number;
  }) {
    this.now = options.now ?? Date.now;
    this.sessions = new ExpiringMap(options.sessionCapacity ?? 10_000, this.now, options.sessionBytes ?? 1024 * 1024,
      (key, value) => 256 + 2 * (key.length + value.name.length + (value.languageHint?.length ?? 0) + (value.csrfToken?.length ?? 0)));
    this.attempts = new ExpiringMap(options.attemptCapacity ?? 1_000, this.now, options.attemptBytes ?? 256 * 1024,
      (key, value) => 256 + 2 * (key.length + value.binding.length + value.state.length + value.nonce.length + value.verifier.length));
    this.replays = new ExpiringMap(options.replayCapacity ?? 10_000, this.now, options.replayBytes ?? 512 * 1024,
      key => 128 + key.length * 2);
    this.oidc = options.config.web.oidcClientId && options.config.web.oidcClientSecret
      ? options.oidc ?? createOidcAdapter(options.config) : undefined;
  }

  get oidcEnabled(): boolean { return this.oidc !== undefined; }

  async begin(signal: AbortSignal): Promise<{ url: URL; binding: string }> {
    throwIfAborted(signal);
    if (!this.oidc) throw new AppError('UNAVAILABLE');
    const attempt = { state: opaque(), nonce: opaque(), verifier: opaque() };
    const binding = opaque();
    this.attempts.set(attempt.state, { ...attempt, binding: digest(binding), expiresAt: this.now() + LOGIN_TTL });
    try {
      const url = await this.oidc.authorize(attempt, signal);
      throwIfAborted(signal);
      if (url.origin !== OIDC_ISSUER || url.pathname !== '/auth') throw new AppError('AUTH_INVALID');
      return { url, binding };
    } catch (error) { this.attempts.delete(attempt.state); throw error; }
  }

  async finish(callback: URL, binding: string | undefined, previousCookie: string | undefined, signal: AbortSignal): Promise<{ token: string; session: Session }> {
    throwIfAborted(signal);
    if (!this.oidc) throw new AppError('UNAVAILABLE');
    const state = callback.searchParams.get('state') ?? '';
    const attempt = this.attempts.get(state);
    // Consume before any asynchronous exchange, even when the callback fails.
    this.attempts.delete(state);
    if (!attempt || !binding || !secretEqual(attempt.binding, digest(binding))
      || Buffer.byteLength(callback.href) > 8192 || callback.hash
      || callback.origin + callback.pathname !== `${this.options.config.web.publicBaseUrl}/auth/callback`) throw new AppError('AUTH_INVALID');
    const seen = new Set<string>();
    for (const [key] of callback.searchParams) {
      if (seen.has(key) || !['state', 'code', 'iss', 'error', 'error_description', 'error_uri'].includes(key)) throw new AppError('AUTH_INVALID');
      seen.add(key);
    }
    if (!callback.searchParams.get('code') || callback.searchParams.has('error')) throw new AppError('AUTH_INVALID');
    const identity = await this.oidc.exchange(callback, attempt, signal);
    throwIfAborted(signal);
    return this.issue(identity, 'oidc', previousCookie);
  }

  miniapp(initData: string, signal: AbortSignal): { token: string; session: Session } {
    throwIfAborted(signal);
    if (!initData || Buffer.byteLength(initData) > 16_384 || /%(?![a-f\d]{2})/i.test(initData)) throw new AppError('AUTH_INVALID');
    const params = new URLSearchParams(initData);
    const seen = new Set<string>();
    for (const [key] of params) {
      if (seen.has(key) || !/^[a-z_]+$/.test(key)) throw new AppError('AUTH_INVALID');
      seen.add(key);
    }
    const hash = params.get('hash');
    if (!hash || !/^[a-f\d]{64}$/.test(hash)) throw new AppError('AUTH_INVALID');
    params.delete('hash');
    const data = [...params].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${key}=${value}`).join('\n');
    const key = createHmac('sha256', 'WebAppData').update(this.options.config.botToken).digest();
    const expected = createHmac('sha256', key).update(data).digest('hex');
    if (!secretEqual(expected, hash)) throw new AppError('AUTH_INVALID');
    const date = params.get('auth_date') ?? '';
    const authDate = Number(date);
    const now = this.now() / 1000;
    if (!/^\d+$/.test(date) || !Number.isSafeInteger(authDate) || authDate < now - 300 || authDate > now + FUTURE_SKEW) throw new AppError('AUTH_INVALID');
    let user: unknown;
    try { user = JSON.parse(params.get('user') ?? 'null'); } catch { throw new AppError('AUTH_INVALID'); }
    if (!user || typeof user !== 'object' || Array.isArray(user) || !('id' in user) || !validId(user.id)
      || !('first_name' in user) || typeof user.first_name !== 'string' || !user.first_name || user.first_name.length > 128
      || ('is_bot' in user && user.is_bot !== false)
      || ('language_code' in user && (typeof user.language_code !== 'string' || user.language_code.length > 35))) throw new AppError('AUTH_INVALID');
    if (this.replays.get(hash)) throw new AppError('AUTH_INVALID');
    this.replays.set(hash, { expiresAt: (authDate + 300) * 1000 + 1 });
    throwIfAborted(signal);
    return this.issue({ id: user.id, name: user.first_name, ...('language_code' in user ? { languageHint: user.language_code as string } : {}) }, 'miniapp');
  }

  private issue(identity: Identity, method: Session['method'], previousCookie?: string): { token: string; session: Session } {
    if (!validId(identity.id) || !this.options.isAdmin(identity.id)) throw new AppError('FORBIDDEN');
    const token = opaque();
    const session: Session = { ...identity, name: identity.name.slice(0, 128), method, expiresAt: this.now() + SESSION_TTL, csrfToken: method === 'oidc' ? opaque() : null };
    this.sessions.set(digest(token), session);
    if (previousCookie) this.revoke(previousCookie);
    return { token, session };
  }

  authenticate(authorization: string | undefined, cookie: string | undefined): { session: Session; token: string } {
    let token: string;
    let method: Session['method'];
    if (authorization !== undefined) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization);
      if (!match?.[1]) throw new AppError('AUTH_INVALID');
      token = match[1]; method = 'miniapp';
    } else {
      if (!cookie) throw new AppError('UNAUTHORIZED');
      if (!/^[A-Za-z0-9_-]{43}$/.test(cookie)) throw new AppError('AUTH_INVALID');
      token = cookie; method = 'oidc';
    }
    const session = this.sessions.get(digest(token));
    if (!session) throw new AppError('AUTH_EXPIRED');
    if (session.method !== method) throw new AppError('AUTH_INVALID');
    return { session, token };
  }

  revoke(token: string): void { this.sessions.delete(digest(token)); }
  close(): void { this.sessions.clear(); this.attempts.clear(); this.replays.clear(); }
}
