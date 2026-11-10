import { expect, type Page } from '@playwright/test';
import { coreSettingsMetadata, coreSettingsSchema, inputJsonSchema, type LanguagePreference, type SettingsDescriptor } from '../../shared/schemas/index.js';

export const extensionDescriptor: SettingsDescriptor = {
  id: 'fixture', schema_version: 1, nameKey: 'web:fixture.title', descriptionKey: 'web:fixture.description',
  schema: {
    $schema: 'http://json-schema.org/draft-07/schema#', type: 'object', additionalProperties: false,
    required: ['label', 'connection', 'tags', 'mode', 'workers'],
    properties: {
      label: { type: 'string', minLength: 3 },
      connection: { type: 'object', required: ['endpoint'], properties: { endpoint: { type: 'string', minLength: 3 } }, additionalProperties: false },
      tags: { type: 'array', items: { type: 'string' }, uniqueItems: true },
      secret: { type: 'string' }, mode: { type: 'string', enum: ['safe', 'fast'] },
      identity: { type: 'string', readOnly: true }, workers: { type: 'integer', minimum: 1, maximum: 8 },
    },
  },
  fields: {
    label: { labelKey: 'web:fixture.label', effect: 'immediate' },
    connection: { labelKey: 'web:fixture.connection', effect: 'immediate' },
    'connection.endpoint': { labelKey: 'web:fixture.endpoint', effect: 'immediate' },
    tags: { labelKey: 'web:fixture.tags', effect: 'immediate' },
    secret: { labelKey: 'web:fixture.secret', effect: 'immediate', secret: true },
    mode: { labelKey: 'web:fixture.mode', effect: 'immediate', control: 'select', enumKeys: { safe: 'web:fixture.safe', fast: 'web:fixture.fast' } },
    identity: { labelKey: 'web:fixture.identity', effect: 'immediate', readOnly: true },
    workers: { labelKey: 'web:fixture.workers', effect: 'restart_required' },
  },
  order: ['label', 'connection', 'tags', 'secret', 'mode', 'identity', 'workers'],
};

export async function mockApi(page: Page, options: { miniapp?: boolean; signedOut?: boolean; fixture?: boolean; language?: LanguagePreference } = {}) {
  const state = {
    signedOut: options.signedOut ?? false,
    expired: false,
    conflict: false,
    storageFailure: false,
    language: options.language ?? 'en' as LanguagePreference,
    calls: [] as { path: string; method: string; body: Record<string, unknown> | undefined; headers: Record<string, string> }[],
    exchanges: 0,
    confirmations: 0,
    pendingSettings: undefined as Record<string, unknown> | undefined,
    descriptor: options.fixture ? extensionDescriptor : { ...coreSettingsMetadata, order: [...coreSettingsMetadata.order], schema: inputJsonSchema(coreSettingsSchema) } as SettingsDescriptor,
    snapshot: {
      revision: 1, requiresRestart: false,
      saved: options.fixture ? { label: 'Local', connection: { endpoint: 'local.test' }, tags: ['alpha'], secret: { has_value: true }, mode: 'safe', identity: 'fixed', workers: 1 } as Record<string, unknown> : { defaultLanguage: 'en' },
      effective: options.fixture ? { label: 'Local', connection: { endpoint: 'local.test' }, tags: ['alpha'], secret: { has_value: true }, mode: 'safe', identity: 'fixed', workers: 1 } as Record<string, unknown> : { defaultLanguage: 'en' },
    },
    groups: [{ id: -1001234567890, title: 'Engineering', authorizedBy: 42, authorizedAt: '2026-11-08T12:00:00.000Z', present: true }],
  };
  const failures: string[] = [];
  page.on('pageerror', (error) => failures.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) failures.push(message.text()); });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === 'telegram.org' && url.pathname === '/js/telegram-web-app.js') {
      await route.fulfill({ contentType: 'text/javascript', body: options.miniapp ? `
        const events = {}; let back;
        window.__tg = { events, backVisible: false, ready: 0, expanded: 0, trigger: name => events[name]?.(), back: () => back?.() };
        window.Telegram = { WebApp: {
          initData: 'signed-test-init-data', colorScheme: 'dark',
          themeParams: { bg_color: '#ff00ff', secondary_bg_color: '#00ffff', text_color: '#0000ff', hint_color: '#ff0000', link_color: '#00ff00' },
          safeAreaInset: {top: 20, bottom: 12, left: 0, right: 0}, contentSafeAreaInset: {top: 8, bottom: 0, left: 0, right: 0},
          ready() { window.__tg.ready++ }, expand() { window.__tg.expanded++ },
          onEvent(name, fn) { events[name] = fn }, offEvent(name) { delete events[name] },
          BackButton: {show() {window.__tg.backVisible=true}, hide() {window.__tg.backVisible=false}, onClick(fn) {back=fn}, offClick() {back=undefined}}
        }};
      ` : '' }); return;
    }
    if (url.origin !== 'http://127.0.0.1:4173') { await route.abort(); return; }
    if (!url.pathname.startsWith('/api/') && !url.pathname.startsWith('/auth/')) { await route.continue(); return; }
    const request = route.request();
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : undefined;
    const path = url.pathname;
    const headers = request.headers();
    state.calls.push({ path, method: request.method(), body, headers });
    const fail = (code: string, status: number) => route.fulfill({ status, json: { status: 'rejected', invocationId: 'test', error: { code } } });
    const success = (data: unknown) => route.fulfill({ json: { status: 'succeeded', invocationId: 'test', data } });
    if (path === '/auth/miniapp') {
      state.exchanges += 1;
      expect(body).toEqual({ initData: 'signed-test-init-data' });
      await route.fulfill({ json: { token: 'test-memory-bearer', expiresAt: new Date(Date.now() + 3_600_000).toISOString() } }); return;
    }
    if (path === '/auth/login') { await route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>OIDC test redirect</title>' }); return; }
    if (state.expired || state.signedOut) { await fail(state.expired ? 'AUTH_EXPIRED' : 'UNAUTHORIZED', 401); return; }
    if (options.miniapp) expect(headers.authorization).toBe('Bearer test-memory-bearer');
    if (request.method() !== 'GET' && !options.miniapp) expect(headers['x-csrf-token']).toBe('test-csrf');
    if (path === '/auth/logout') { state.signedOut = true; await route.fulfill({ status: 204 }); return; }
    if (path === '/api/me') {
      await route.fulfill({ json: { user: { id: 42, name: 'Misaka Operator' }, language: state.language, resolvedLanguage: state.language === 'auto' ? 'en' : state.language, csrfToken: options.miniapp ? null : 'test-csrf', expiresAt: new Date(Date.now() + 3_600_000).toISOString(), method: options.miniapp ? 'miniapp' : 'oidc' } }); return;
    }
    if (path === '/api/status') { await success({ uptimeSeconds: 7261, updateCount: 1482, authorizedGroupCount: state.groups.length, polling: 'failed', http: 'running', lastApiError: { code: 'UNAVAILABLE', at: '2026-11-08T12:00:00.000Z' } }); return; }
    if (path === '/api/modules') { await success(options.fixture ? [{ id: 'fixture', nameKey: 'web:fixture.title', descriptionKey: 'web:fixture.description', schema_version: 1, configurable: true }] : []); return; }
    if (path.endsWith('/schema')) { await success(state.descriptor); return; }
    if (path === '/api/settings/core' || path === '/api/modules/fixture/config') {
      if (request.method() === 'PUT') {
        if (state.conflict) { await fail('CONFLICT', 409); return; }
        if (state.storageFailure) { await fail('STORAGE_ERROR', 500); return; }
        expect(body?.revision).toBe(state.snapshot.revision);
        const settings = body?.settings as Record<string, unknown>;
        const secret = settings.secret as { operation: string; value?: string } | undefined;
        if (secret?.operation === 'clear') {
          state.pendingSettings = settings;
          await route.fulfill({ json: { status: 'pending_confirmation', invocationId: 'test', confirmation: { token: 'a'.repeat(40), actionId: 'fixture.configure', expiresAt: new Date(Date.now() + 60_000).toISOString(), target: 'fixture' } } }); return;
        }
        state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1, saved: { ...state.snapshot.saved, ...settings }, requiresRestart: options.fixture === true && settings.workers !== state.snapshot.effective.workers };
        if (secret) state.snapshot.saved.secret = { has_value: secret.operation === 'replace' };
        if (!options.fixture) state.snapshot.effective = { ...state.snapshot.saved };
      }
      await success(state.snapshot); return;
    }
    if (path === '/api/preferences') {
      if (body) state.language = body.language as LanguagePreference;
      await success({ language: state.language, resolvedLanguage: state.language === 'auto' ? 'en' : state.language, menuSynced: true }); return;
    }
    if (path === '/api/groups') {
      if (body) { state.groups.push({ id: body.chatId as number, title: 'New group', authorizedBy: 42, authorizedAt: new Date().toISOString(), present: true }); await success({ chatId: body.chatId, revision: 2, changed: true, notificationSent: true, left: false }); return; }
      await success({ items: state.groups, page: 0, pageSize: 10, total: state.groups.length, revision: 1 }); return;
    }
    if (path === '/api/groups/revoke') { await route.fulfill({ json: { status: 'pending_confirmation', invocationId: 'test', confirmation: { token: 'a'.repeat(40), actionId: 'groups.revoke', expiresAt: new Date(Date.now() + 60_000).toISOString(), target: String(body?.chatId) } } }); return; }
    if (path === '/api/confirm') {
      state.confirmations += 1; expect(body).toEqual({ token: 'a'.repeat(40) });
      if (state.pendingSettings) {
        state.snapshot = { ...state.snapshot, revision: state.snapshot.revision + 1, saved: { ...state.snapshot.saved, ...state.pendingSettings, secret: { has_value: false } } };
        state.pendingSettings = undefined; await success(state.snapshot); return;
      }
      state.groups = [];
      await success({ chatId: -1001234567890, revision: 2, changed: true, notificationSent: false, left: false }); return;
    }
    await fail('NOT_FOUND', 404);
  });
  return { state, assertClean: () => expect(failures).toEqual([]) };
}
