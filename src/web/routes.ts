import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { ActionResult, Me, Preference } from '../../shared/schemas/index.js';
import { createInvocation } from '../actions.js';
import { AppError, httpStatus } from '../errors.js';
import { LOGIN_COOKIE, SESSION_COOKIE, secretEqual, type Session, type WebAuth } from './auth.js';
import type { WebDependencies } from './server.js';

declare module 'fastify' {
  interface FastifyRequest {
    invocationSignal: AbortSignal;
    invocationDeadline: number;
    webSession: Session | null;
  }
}

const cookieOptions = { path: '/', secure: true, httpOnly: true, sameSite: 'lax' as const };

function cookie(request: FastifyRequest, name: string): string | undefined {
  const matches = (request.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  if (matches.length > 1) throw new AppError('AUTH_INVALID');
  return matches[0]?.slice(name.length + 1);
}

function origin(request: FastifyRequest, expected: string): void {
  if (request.headers.origin !== expected) throw new AppError('INVALID_ORIGIN');
  if (request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('INVALID_ORIGIN');
}

function mutation(request: FastifyRequest, expected: string, session: Session): void {
  origin(request, expected);
  if (session.method === 'oidc') {
    const csrf = request.headers['x-csrf-token'];
    if (typeof csrf !== 'string' || !session.csrfToken || !secretEqual(csrf, session.csrfToken)) throw new AppError('CSRF_INVALID');
  }
}

function sendResult(reply: FastifyReply, result: ActionResult): FastifyReply {
  return reply.code(result.status === 'failed' || result.status === 'rejected' ? httpStatus(result.error.code) : 200).send(result);
}

export async function registerWebRoutes(app: FastifyInstance, deps: WebDependencies, auth: WebAuth): Promise<void> {
  const base = deps.config.web.publicBaseUrl!;
  app.decorateRequest('webSession', null);
  const authenticate = (request: FastifyRequest) => auth.authenticate(request.headers.authorization,
    request.headers.authorization === undefined ? cookie(request, SESSION_COOKIE) : undefined);
  // Root-level guard also covers unsupported methods and unknown management routes.
  app.addHook('onRequest', async request => {
    let path: string;
    try { path = decodeURIComponent(request.url.split('?')[0] ?? ''); } catch { throw new AppError('INVALID_INPUT'); }
    if (path === '/api' || path.startsWith('/api/')) {
      const { session } = authenticate(request);
      if (!deps.access.isAdmin(session.id)) throw new AppError('FORBIDDEN');
      request.webSession = session;
      if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) mutation(request, base, session);
    }
  });

  app.get('/health', async () => ({ ok: true }));
  app.get('/auth/methods', async request => {
    if (!z.strictObject({}).safeParse(request.query).success) throw new AppError('INVALID_INPUT');
    return { oidc: auth.oidcEnabled, miniapp: true };
  });
  const rateLimit = { max: 20, timeWindow: '1 minute' };
  app.get('/auth/login', { config: { rateLimit } }, async (request, reply) => {
    const { url, binding } = await auth.begin(request.invocationSignal);
    reply.setCookie(LOGIN_COOKIE, binding, { ...cookieOptions, maxAge: 300 });
    return reply.redirect(url.href);
  });
  app.get('/auth/callback', { config: { rateLimit } }, async (request, reply) => {
    reply.clearCookie(LOGIN_COOKIE, cookieOptions);
    try {
      const { token } = await auth.finish(new URL(request.url, base), cookie(request, LOGIN_COOKIE), cookie(request, SESSION_COOKIE), request.invocationSignal);
      reply.setCookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: 3600 });
      return reply.redirect('/');
    } catch (error) {
      const code = error instanceof AppError && ['FORBIDDEN', 'CAPACITY', 'CANCELLED', 'UNAVAILABLE'].includes(error.code) ? error.code : 'AUTH_INVALID';
      return reply.redirect(`/?auth_error=${code}`);
    }
  });
  app.post('/auth/miniapp', { config: { rateLimit } }, async (request, reply) => {
    origin(request, base);
    const input = z.strictObject({ initData: z.string().min(1).max(16_384) }).safeParse(request.body);
    if (!input.success) throw new AppError('AUTH_INVALID');
    const { token, session } = auth.miniapp(input.data.initData, request.invocationSignal);
    return reply.send({ token, expiresAt: new Date(session.expiresAt).toISOString() });
  });
  app.post('/auth/logout', { config: { rateLimit } }, async (request, reply) => {
    // Validate Origin even for expired credentials, then always clear the local cookie.
    origin(request, base);
    reply.clearCookie(SESSION_COOKIE, cookieOptions);
    reply.clearCookie(LOGIN_COOKIE, cookieOptions);
    const { session, token } = authenticate(request);
    mutation(request, base, session);
    auth.revoke(token);
    return reply.code(204).send();
  });

  const context = (request: FastifyRequest) => {
    const session = request.webSession!;
    const languageHint = session.languageHint ?? request.headers['accept-language']?.slice(0, 256);
    return createInvocation({
      actorId: session.id, source: 'http', botId: deps.botId(), chat: { id: session.id, type: 'private' },
      language: deps.configuration.resolveLanguage(session.id, languageHint), languageHint,
      signal: request.invocationSignal, deadline: request.invocationDeadline,
    });
  };

  app.get('/api/me', async (request, reply) => {
    const session = request.webSession!;
    const result = await deps.executor.execute<Preference>(context(request), 'preferences.get', request.query);
    if (result.status !== 'succeeded') return sendResult(reply, result);
    const me: Me = {
      user: { id: session.id, name: session.name }, language: result.data.language,
      resolvedLanguage: result.data.resolvedLanguage, csrfToken: session.csrfToken,
      expiresAt: new Date(session.expiresAt).toISOString(), method: session.method,
    };
    return reply.send(me);
  });
  for (const [path, action] of [
    ['/api/status', 'core.status'], ['/api/preferences', 'preferences.get'],
    ['/api/settings/core', 'core.settings.get'], ['/api/settings/core/schema', 'core.settings.schema'],
    ['/api/modules', 'modules.list'], ['/api/ai/admin', 'ai.admin.get'],
    ['/api/ai/admin/tools', 'ai.admin.tools'],
    ['/api/ai/admin/extensions/status', 'ai.extensions.status'],
  ]) {
    app.get(path!, async (request, reply) => sendResult(reply, await deps.executor.execute(context(request), action!, request.query)));
  }
  app.get('/api/groups', async (request, reply) => {
    // Only the documented query scalar is converted; duplicate/extra fields remain invalid.
    const query = request.query as Record<string, unknown>;
    const input = { ...query };
    if (typeof input.page === 'string' && /^(0|[1-9]\d*)$/.test(input.page)) input.page = Number(input.page);
    return sendResult(reply, await deps.executor.execute(context(request), 'groups.list', input));
  });
  app.get('/api/rss', async (request, reply) => {
    const input = { ...(request.query as Record<string, unknown>) };
    if (typeof input.page === 'string' && /^(0|[1-9]\d*)$/.test(input.page)) input.page = Number(input.page);
    return sendResult(reply, await deps.executor.execute(context(request), 'rss.list', input));
  });
  app.get('/api/rate/currencies', async (request, reply) => {
    const input = { ...(request.query as Record<string, unknown>) };
    if (typeof input.page === 'string' && /^(0|[1-9]\d*)$/.test(input.page)) input.page = Number(input.page);
    return sendResult(reply, await deps.executor.execute(context(request), 'rate.currencies', input));
  });
  app.get('/api/weather/default', async (request, reply) => sendResult(reply, await deps.executor.execute(context(request), 'weather.default.get', {})));
  for (const [method, path, action] of [
    ['PUT', '/api/groups', 'groups.authorize'], ['POST', '/api/groups/revoke', 'groups.revoke'],
    ['POST', '/api/groups/state', 'groups.state'],
    ['PUT', '/api/preferences', 'preferences.set'], ['PUT', '/api/settings/core', 'core.settings.update'],
    ['PUT', '/api/ai/admin', 'ai.admin.update'], ['POST', '/api/ai/disable', 'ai.admin.disable'],
    ['POST', '/api/ai/setup', 'ai.admin.setup'],
    ['POST', '/api/ai/credentials', 'ai.admin.secret.update'],
    ['POST', '/api/ai/admin/extensions/skills/install', 'ai.skills.install'],
    ['POST', '/api/ai/admin/extensions/skills/review', 'ai.skills.review'],
    ['POST', '/api/ai/admin/extensions/mcp/discover', 'ai.mcp.discover'],
    ['POST', '/api/ai/admin/extensions/sandbox/review', 'ai.sandbox.review'],
    ['POST', '/api/ai/admin/extensions/sandbox/local/review', 'ai.sandbox.local.review'],
    ['POST', '/api/ai/admin/extensions/sandbox/local/probe', 'ai.sandbox.local.probe'],
    ['POST', '/api/ai/admin/extensions/mcp/stdio/discover', 'ai.mcp.stdio.discover'],
    ['POST', '/api/rss', 'rss.add'], ['PUT', '/api/rss', 'rss.update'], ['POST', '/api/rss/remove', 'rss.remove'],
    ['POST', '/api/rate/convert', 'rate.convert'], ['POST', '/api/weather/search', 'weather.search'], ['POST', '/api/weather/query', 'weather.query'], ['PUT', '/api/weather/default', 'weather.default.set'],
  ] as const) {
    app.route({ method, url: path, handler: async (request, reply) => sendResult(reply, await deps.executor.execute(context(request), action, request.body)) });
  }
  app.post('/api/confirm', async (request, reply) => {
    const invocation = context(request);
    const input = z.strictObject({ token: z.string().regex(/^[a-f0-9]{40}$/) }).safeParse(request.body);
    if (!input.success) return sendResult(reply, { status: 'rejected', invocationId: invocation.invocationId, error: { code: 'INVALID_INPUT' } });
    return sendResult(reply, await deps.executor.confirm(invocation, input.data.token));
  });
  // Empty module registry must reject these through the executor, not accept arbitrary writes.
  for (const [method, path, action] of [
    ['GET', '/api/modules/:id/schema', 'modules.schema'],
    ['GET', '/api/modules/:id/config', 'modules.config.get'],
    ['PUT', '/api/modules/:id/config', 'modules.config.update'],
  ] as const) {
    app.route({ method, url: path, handler: async (request, reply) => {
      const { id } = request.params as { id: string };
      const input = method === 'GET' ? { ...(request.query as object), id } : { id, input: request.body };
      return sendResult(reply, await deps.executor.execute(context(request), action, input));
    } });
  }
}
