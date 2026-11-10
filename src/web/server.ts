import { access as fileAccess } from 'node:fs/promises';
import { resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import type { ActionExecutor } from '../actions.js';
import type { AccessService } from '../access.js';
import type { ConfigurationService } from '../configuration.js';
import type { StartupConfig } from '../config.js';
import { AppError, httpStatus, safeError, throwIfAborted } from '../errors.js';
import { WebAuth, type OidcAdapter } from './auth.js';
import { registerWebRoutes } from './routes.js';

export interface WebDependencies {
  config: StartupConfig;
  executor: Pick<ActionExecutor, 'execute' | 'confirm'>;
  configuration: Pick<ConfigurationService, 'resolveLanguage'>;
  access: Pick<AccessService, 'isAdmin'>;
  botId: () => number;
  signal?: AbortSignal;
  oidc?: OidcAdapter;
  staticRoot?: string;
}

export async function createWebServer(deps: WebDependencies): Promise<FastifyInstance> {
  throwIfAborted(deps.signal);
  const base = deps.config.web.publicBaseUrl;
  if (!base || new URL(base).protocol !== 'https:' || new URL(base).origin !== base) throw new AppError('UNAVAILABLE');
  const root = resolve(deps.staticRoot ?? 'webui/dist');
  try { await fileAccess(resolve(root, 'index.html')); } catch { throw new AppError('UNAVAILABLE'); }
  throwIfAborted(deps.signal);
  const app = Fastify({
    logger: false, trustProxy: false,
    bodyLimit: 32 * 1024, requestTimeout: deps.config.requestTimeout * 1000,
    connectionTimeout: 15_000, keepAliveTimeout: 5_000, routerOptions: { maxParamLength: 128 },
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, useDefaults: false } },
    return503OnClosing: true,
    frameworkErrors: (_error, _request, reply) => { (reply as FastifyReply).code(400).send({ error: { code: 'INVALID_INPUT' } }); },
  });
  const auth = new WebAuth({ config: deps.config, isAdmin: id => deps.access.isAdmin(id), oidc: deps.oidc });
  const stopping = new AbortController();
  const active = new Map<FastifyRequest, { abort: () => void; cleanup: () => void }>();
  const pending = new Set<Promise<unknown>>();
  const cleanupRequest = (request: FastifyRequest) => { active.get(request)?.cleanup(); active.delete(request); };
  const stop = () => {
    stopping.abort(new AppError('CANCELLED'));
    for (const request of active.values()) request.abort();
    auth.close();
  };
  deps.signal?.addEventListener('abort', stop, { once: true });
  app.decorateRequest('invocationSignal');
  app.decorateRequest('invocationDeadline', 0);
  // Socket closure alone does not drain async handlers whose clients disconnected.
  app.addHook('onRoute', route => {
    const handler = route.handler;
    route.handler = function (request, reply) {
      const work = Promise.resolve().then(() => handler.call(this, request, reply));
      pending.add(work);
      return work.finally(() => { pending.delete(work); cleanupRequest(request); });
    };
  });
  app.addHook('onRequest', async (request, reply) => {
    const controller = new AbortController();
    const signals = [controller.signal, stopping.signal, ...(deps.signal ? [deps.signal] : [])];
    request.invocationSignal = AbortSignal.any(signals);
    request.invocationDeadline = Date.now() + deps.config.requestTimeout * 1000;
    const abort = () => { controller.abort(new AppError('CANCELLED')); cleanupRequest(request); };
    const disconnected = () => { if (!reply.raw.writableFinished) abort(); };
    const timer = setTimeout(() => controller.abort(new AppError('TIMEOUT')), deps.config.requestTimeout * 1000);
    timer.unref();
    request.raw.once('aborted', abort);
    reply.raw.once('close', disconnected);
    active.set(request, { abort, cleanup: () => {
      clearTimeout(timer); request.raw.off('aborted', abort); reply.raw.off('close', disconnected);
    } });
    reply.header('Cache-Control', 'no-store');
    reply.header('Referrer-Policy', 'no-referrer');
    if (request.headers.host !== new URL(base).host) throw new AppError('INVALID_ORIGIN');
    throwIfAborted(request.invocationSignal);
  });
  app.addHook('onResponse', async request => { cleanupRequest(request); });
  app.addHook('preClose', async () => { stop(); await Promise.allSettled([...pending]); });
  app.addHook('onClose', async () => {
    stop(); deps.signal?.removeEventListener('abort', stop);
    for (const request of active.values()) request.cleanup();
    active.clear();
  });
  app.setErrorHandler((error, request, reply) => {
    const path = request.url.split('?')[0];
    if (request.method === 'GET' && path === '/auth/callback' && request.headers.host === new URL(base).host) {
      const code = error instanceof AppError && ['FORBIDDEN', 'CAPACITY', 'RATE_LIMITED', 'CANCELLED'].includes(error.code) ? error.code : 'AUTH_INVALID';
      return reply.redirect(`/?auth_error=${code}`);
    }
    const fastifyCode = (error as { code?: string }).code;
    const failure = fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE' || fastifyCode === 'FST_ERR_CTP_INVALID_JSON_BODY'
      || fastifyCode === 'FST_ERR_CTP_EMPTY_JSON_BODY' || fastifyCode === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' || fastifyCode === 'FST_ERR_VALIDATION'
      ? { code: 'INVALID_INPUT' as const } : safeError(error);
    const authenticationError = ['UNAUTHORIZED', 'FORBIDDEN', 'AUTH_INVALID', 'AUTH_EXPIRED', 'INVALID_ORIGIN', 'CSRF_INVALID'].includes(failure.code);
    const body = request.webSession && path !== '/api/me' && !authenticationError
      ? { status: 'failed', invocationId: request.id, error: failure } : { error: failure };
    return reply.code(httpStatus(failure.code)).send(body);
  });
  try {
    await app.register(cookie);
    await app.register(helmet, {
      contentSecurityPolicy: { directives: {
        // RJSF/AJV compiles only server-registered schemas. Inline scripts stay blocked.
        defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://telegram.org', "'unsafe-eval'"],
        styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"], fontSrc: ["'self'"], objectSrc: ["'none'"],
        baseUri: ["'none'"], formAction: ["'self'"],
        frameAncestors: ["'self'", 'https://web.telegram.org', 'https://*.web.telegram.org', 'https://t.me'],
      } },
      frameguard: false, crossOriginEmbedderPolicy: false,
      crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
      referrerPolicy: { policy: 'no-referrer' },
    });
    await app.register(rateLimit, { global: false, cache: 10_000, errorResponseBuilder: () => new AppError('RATE_LIMITED') });
    await registerWebRoutes(app, deps, auth);
    await app.register(staticFiles, { root, index: ['index.html'], dotfiles: 'deny', cacheControl: false, redirect: false });
    app.setNotFoundHandler(async (request, reply) => reply.code(404).send(request.webSession
      ? { status: 'rejected', invocationId: request.id, error: { code: 'NOT_FOUND' } }
      : { error: { code: 'NOT_FOUND' } }));
    await app.ready();
    throwIfAborted(deps.signal);
    return app;
  } catch (error) { await app.close(); throw error; }
}
