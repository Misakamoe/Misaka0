import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { confirmationSchema, emptyInputSchema, type ActionResult, type ConfirmationSubject } from '../shared/schemas/index.js';
import { aiToolCatalogSchema, type AiToolCatalog } from '../shared/schemas/ai-admin.js';
import { ActionExecutor, type ActionDefinition, type InvocationContext } from '../src/actions.js';
import { registerAiActions } from '../src/ai/actions.js';
import type { AiService } from '../src/ai/service.js';
import { AppError } from '../src/errors.js';
import { aliasMetadata } from '../src/modules/alias.js';
import { rssMetadata } from '../src/modules/rss.js';
import { rateMetadata } from '../src/modules/rate.js';
import { weatherMetadata } from '../src/modules/weather.js';
import { stickerMetadata } from '../src/modules/sticker.js';
import { subconvMetadata } from '../src/modules/subconv.js';
import { relayMetadata } from '../src/modules/metadata.js';
import { modules } from '../src/modules/index.js';
import { coreFixture, invocation } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); }
});
async function fixture(options: Parameters<typeof coreFixture>[0] = {}) {
  const result = await coreFixture(options); cleanups.push(result.close); return result;
}
function data<T>(result: ActionResult<T>): T {
  expect(result.status).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
  return result.data;
}
function token(result: ActionResult): string {
  expect(result.status).toBe('pending_confirmation');
  if (result.status !== 'pending_confirmation') throw new Error(JSON.stringify(result));
  return result.confirmation.token;
}
const fixturePolicy = {
  permission: 'any', scopes: ['private', 'group'], sources: ['telegram', 'http', 'ai'],
  aiVisible: true, effect: 'read', timeoutMs: 1000,
} as const;

describe('shared Action execution and trusted context', () => {
  it('produces the same safe core DTO for Telegram, HTTP and a simulated AI adapter', async () => {
    const f = await fixture({ services: { aiEnabled: true } });
    const telegram = data(await f.executor.execute(invocation(), 'core.info', {}));
    const http = data(await f.executor.execute(invocation({ source: 'http' }), 'core.info', {}));
    const ai = data(await f.executor.executeTool(invocation(), 'core.info', {}));
    expect(http).toEqual(telegram);
    expect(ai).toEqual(telegram);
    expect(ai).toEqual({ runtime: 'grammy', version: '0.1.0', moduleCount: modules.length, aiAvailable: true });
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
    expect(data(await f.executor.execute(invocation(), 'modules.list', {}))).toEqual([aliasMetadata, rssMetadata, rateMetadata, weatherMetadata, stickerMetadata, subconvMetadata, relayMetadata]);
  });

  it('rejects unregistered/archived actions and AI sources without disabling human entry points', async () => {
    const f = await fixture();
    expect(await f.executor.discoverTools(invocation())).toEqual([]);
    expect(await f.executor.executeTool(invocation(), 'core.info', {})).toMatchObject({ status: 'rejected', error: { code: 'AI_DISABLED' } });
    expect(await f.executor.execute(invocation(), 'core.info', {})).toMatchObject({ status: 'succeeded' });
    for (const id of ['reminder.create', 'ai.chat', 'echo', 'alias.hug', 'alias.action', 'modules.legacy.enable', '../../bot.py']) {
      expect(await f.executor.execute(invocation(), id, {})).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    }
  });

  it('rejects copied contexts, actor/source spoofing, coercion and missing parameters', async () => {
    const f = await fixture();
    const forged = { ...invocation() } as InvocationContext;
    expect(await f.executor.execute(forged, 'core.info', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    for (const input of [{ actorId: 1 }, { source: 'telegram' }, { role: 'superadmin' }, { confirmed: true }, { language: 'en', actorId: 1 }]) {
      expect(await f.executor.execute(invocation(), 'preferences.set', input)).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    }
    expect(await f.executor.execute(invocation(), 'groups.authorize', { chatId: '-100', revision: 0 })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await f.executor.execute(invocation(), 'groups.authorize', { chatId: -100 })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(() => invocation({ actorId: 0 })).toThrow();
    expect(() => invocation({ actorId: 3, chat: { id: 1, type: 'private' } })).toThrow();
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
  });

  it('enforces admission before all actions, including superadmin reads in unauthorized groups', async () => {
    const f = await fixture();
    const groupAdmin = invocation({ chat: { id: -100, type: 'supergroup' } });
    expect(await f.executor.execute(groupAdmin, 'core.info', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(groupAdmin, 'groups.authorize', { chatId: -200, revision: 0 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(invocation({ actorId: 3, chat: { id: -100, type: 'supergroup' } }), 'groups.authorize', { chatId: -100, revision: 0 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(groupAdmin, 'groups.authorize', { chatId: -100, revision: 0 })).toMatchObject({ status: 'succeeded' });
    expect(f.access.isAllowed(-100)).toBe(true);
    expect(await f.executor.execute(groupAdmin, 'core.info', {})).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.execute(groupAdmin, 'core.status', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(groupAdmin, 'groups.list', { page: 0 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('exposes target versions only through authenticated private group administration', async () => {
    const f = await fixture();
    expect(data(await f.executor.execute(invocation({ source: 'http' }), 'groups.state', { chatId: -100 })))
      .toEqual({ chatId: -100, revision: 0, groupRevision: 0 });
    for (const context of [invocation({ actorId: 3, chat: { id: 3, type: 'private' } }), invocation({ chat: { id: -100, type: 'group' } })]) {
      expect(await f.executor.execute(context, 'groups.state', { chatId: -100 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    expect(await f.executor.execute(invocation(), 'groups.state', { chatId: '-100' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(await f.executor.execute(invocation(), 'groups.state', { chatId: -100, actorId: 1 })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
  });

  it('rechecks actual Telegram group-admin status and fails closed on lookup errors', async () => {
    const groupAdmin = vi.fn(async () => false);
    const f = await fixture({ services: { aiEnabled: true, groupAdmin } });
    f.executor.register({ ...fixturePolicy, id: 'fixture.group_admin', input: emptyInputSchema, output: z.boolean(), permission: 'group_admin', execute: () => true });
    await f.access.authorize(-100, 'Group', 1, 0);
    const context = invocation({ actorId: 3, chat: { id: -100, type: 'group' } });
    expect(await f.executor.execute(context, 'fixture.group_admin', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect((await f.executor.discoverTools(context)).map(tool => tool.id)).not.toContain('fixture.group_admin');
    groupAdmin.mockResolvedValue(true);
    expect(await f.executor.execute(context, 'fixture.group_admin', {})).toMatchObject({ status: 'succeeded' });
    groupAdmin.mockRejectedValue(new Error('sensitive Telegram error'));
    expect(await f.executor.execute(invocation({ actorId: 3, chat: { id: -100, type: 'group' } }), 'fixture.group_admin', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(invocation(), 'fixture.group_admin', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('exposes the exact native tool catalog without exposing core administration or bypassing permissions', async () => {
    const f = await fixture({ services: { aiEnabled: true } });
    expect((await f.executor.discoverTools(invocation())).map(tool => tool.id)).toEqual([
      'core.info', 'modules.list', 'alias.list', 'alias.add', 'alias.remove',
      'rss.list', 'rss.get', 'rss.add', 'rss.update', 'rss.remove', 'rate.convert', 'rate.currencies',
      'weather.search', 'weather.query', 'weather.default.get', 'weather.default.set',
      'sticker.sources', 'sticker.inspect', 'sticker.convert', 'sticker.cancel',
      'subconv.settings.get', 'subconv.options.set', 'subconv.sources', 'subconv.generate_owned',
    ]);
    expect(await f.executor.executeTool(invocation(), 'groups.authorize', { chatId: -100, revision: 0 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(await f.executor.executeTool(invocation(), 'core.settings.update', { revision: 0, settings: { defaultLanguage: 'en' } })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    for (const [id, input] of [
      ['alias.list', {}],
      ['alias.add', { command: 'help', alias: 'custom', revision: 0 }],
      ['alias.remove', { command: 'help', alias: '\u5e2e\u52a9', revision: 0 }],
    ] as const) {
      expect(await f.executor.executeTool(invocation(), id, input)).toMatchObject({ status: id === 'alias.list' ? 'succeeded' : 'pending_confirmation' });
      expect(await f.executor.execute(invocation({ actorId: 3, chat: { id: 3, type: 'private' } }), id, input))
        .toMatchObject({ error: { code: 'FORBIDDEN' } });
      expect(await f.executor.execute(invocation({ chat: { id: -100, type: 'supergroup' } }), id, input))
        .toMatchObject({ error: { code: 'FORBIDDEN' } });
    }
    for (const [id, input] of [
      ['subconv.settings.set', { revision: 0, settings: f.subconv.settings(invocation()).settings }],
      ['subconv.settings.reset', { revision: 0 }],
      ['subconv.generate', { revision: 0, source: 'https://subscription.example/sub', customParams: [] }],
    ] as const) {
      expect(await f.executor.executeTool(invocation(), id, input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    }
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.access.count()).toBe(0);
    expect(f.configuration.settings().effective.defaultLanguage).toBe('zh-CN');
  });

  it('deduplicates in-flight side effects, detects changed input, and scopes IDs across actors/actions', async () => {
    const f = await fixture();
    const context = invocation({ invocationId: 'test.same' });
    const [first, duplicate] = await Promise.all([
      f.executor.execute(context, 'groups.authorize', { chatId: -100, revision: 0 }),
      f.executor.execute(context, 'groups.authorize', { chatId: -100, revision: 0 }),
    ]);
    expect(first.status).toBe('succeeded');
    expect(duplicate).toMatchObject({ status: 'succeeded', replayed: true });
    expect(f.effects.describeGroup).toHaveBeenCalledTimes(1);
    expect(f.effects.notifyGroup).toHaveBeenCalledTimes(1);
    expect(await f.executor.execute(context, 'groups.authorize', { chatId: -200, revision: 1 })).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await f.executor.execute(context, 'core.info', {})).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.execute(invocation({ actorId: 2, chat: { id: 2, type: 'private' }, invocationId: 'test.same' }), 'groups.authorize', { chatId: -200, revision: 1 })).toMatchObject({ status: 'succeeded' });
  });

  it('serializes HTTP/Telegram configuration edits and returns a retryable menu-sync warning without rollback', async () => {
    const f = await fixture();
    const results = await Promise.all([
      f.executor.execute(invocation(), 'core.settings.update', { revision: 0, settings: { defaultLanguage: 'en' } }),
      f.executor.execute(invocation({ source: 'http' }), 'core.settings.update', { revision: 0, settings: { defaultLanguage: 'zh-CN' } }),
    ]);
    expect(results.filter(result => result.status === 'succeeded')).toHaveLength(1);
    expect(results.find(result => result.status !== 'succeeded')).toMatchObject({ error: { code: 'CONFLICT' } });
    f.effects.syncPrivateMenu.mockResolvedValue(false);
    expect(data(await f.executor.execute(invocation(), 'preferences.set', { language: 'en' }))).toMatchObject({ language: 'en', menuSynced: false });
    expect(f.configuration.getPreference(1).language).toBe('en');
  });

  it('limits dedupe/approval memory instead of evicting in-flight or still-valid operation identities', async () => {
    const f = await fixture({ services: { capacity: 1 } });
    expect(await f.executor.execute(invocation(), 'core.info', {})).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.execute(invocation(), 'core.info', {})).toMatchObject({ error: { code: 'CAPACITY' } });
    token(await f.executor.prepare(invocation(), 'groups.authorize', { chatId: -100, revision: 0 }));
    expect(await f.executor.prepare(invocation(), 'groups.authorize', { chatId: -200, revision: 0 })).toMatchObject({ error: { code: 'CAPACITY' } });
  });
});

describe('authoritative AI tool catalog', () => {
  it('requires a trusted HTTP private configured-superadmin context for both entry points', async () => {
    const f = await fixture({ services: { aiEnabled: true } });
    registerAiActions(f.executor, {} as AiService);
    const admin = invocation({ source: 'http' });
    const catalog = f.executor.listAiToolCatalog(admin);
    expect(data(await f.executor.execute<AiToolCatalog>(admin, 'ai.admin.tools', {}))).toEqual(catalog);
    for (const context of [
      undefined, { ...admin }, invocation(), invocation({ source: 'ai' }),
      invocation({ source: 'http', actorId: 3, chat: { id: 3, type: 'private' } }),
      invocation({ source: 'http', chat: { id: -100, type: 'group' } }),
      invocation({ source: 'http', chat: { id: -100, type: 'supergroup', threadId: 7 } }),
    ]) {
      expect(() => f.executor.listAiToolCatalog(context as InvocationContext)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
      expect(await f.executor.execute(context as InvocationContext, 'ai.admin.tools', {}))
        .toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    }
    for (const input of [{ actorId: 1 }, { source: 'http' }, { scope: 'private' }, { tools: [] }, { confirmed: true }]) {
      expect(await f.executor.execute(admin, 'ai.admin.tools', input)).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    }
    expect(f.executor['registry'].get('ai.admin.tools')).toMatchObject({
      sources: ['http'], scopes: ['private'], permission: 'superadmin', aiVisible: false, effect: 'read',
    });
    vi.spyOn(f.access, 'isAdmin').mockReturnValue(false);
    expect(() => f.executor.listAiToolCatalog(admin)).toThrow(expect.objectContaining({ code: 'FORBIDDEN' }));
  });

  it('lists only explicit AI flags without evaluating grants, allowlisting, callbacks or handlers', async () => {
    const groupAdmin = vi.fn(async () => { throw new Error('Unexpected Telegram lookup'); });
    const f = await fixture({ services: { aiEnabled: false, groupAdmin } });
    const available = vi.fn(() => false);
    const authorize = vi.fn(() => { throw new AppError('FORBIDDEN'); });
    const approvalExempt = vi.fn(() => true);
    f.services.aiPolicy = { available, authorize, approvalExempt };
    const discover = vi.spyOn(f.executor, 'discoverTools');
    const isAllowed = vi.spyOn(f.access, 'isAllowed');
    const execute = vi.fn(() => true);
    const confirmation = vi.fn(() => { throw new Error('Unexpected confirmation callback'); });
    const confirmationSubject = vi.fn(() => { throw new Error('Unexpected subject callback'); });
    const target = vi.fn(() => { throw new Error('Unexpected target callback'); });
    const modelOutput = vi.fn(() => { throw new Error('Unexpected model projection'); });
    const definition = { ...fixturePolicy, input: emptyInputSchema.describe('PRIVATE_SCHEMA_SENTINEL'),
      output: z.boolean(), aiDescription: 'PRIVATE_DESCRIPTION_SENTINEL', execute };
    f.executor.register({ ...definition, id: 'fixture.group', scopes: ['group'], permission: 'group_admin',
      confirmation, confirmationSubject, target, aiOutput: z.boolean(), modelOutput });
    f.executor.register({ ...definition, id: 'fixture.hidden', aiVisible: false });
    f.executor.register({ ...definition, id: 'fixture.implicit', aiVisible: undefined as unknown as boolean });
    f.executor.register({ ...definition, id: 'fixture.human', sources: ['telegram', 'http'] });
    const handlers = [...f.executor['registry'].values()].map(action => vi.spyOn(action, 'execute'));
    const admin = invocation({ source: 'http' });
    const catalog = f.executor.listAiToolCatalog(admin);
    const ids = catalog.items.map(item => item.id);
    expect(ids).toEqual([...ids].sort());
    expect(catalog.items).toContainEqual({ id: 'fixture.group', group: 'other', effect: 'read',
      scopes: ['group'], permission: 'group_admin', approval: 'conditional' });
    expect(catalog.items).toContainEqual({ id: 'alias.add', group: 'alias', effect: 'permission',
      scopes: ['private'], permission: 'superadmin', approval: 'required' });
    for (const id of ['fixture.hidden', 'fixture.implicit', 'fixture.human', 'core.status', 'core.settings.get',
      'groups.authorize', 'preferences.get', 'subconv.settings.set']) expect(ids).not.toContain(id);
    expect(JSON.stringify(catalog)).not.toContain('PRIVATE_');
    expect(f.access.count()).toBe(0);
    expect(f.aliases.snapshot().revision).toBe(0);
    for (const callback of [available, authorize, approvalExempt, discover, isAllowed, groupAdmin, execute, confirmation, confirmationSubject, target,
      modelOutput, ...handlers, ...Object.values(f.effects)]) expect(callback).not.toHaveBeenCalled();
    const groupTool = catalog.items.find(item => item.id === 'fixture.group')!;
    groupTool.scopes.push('private');
    expect(f.executor.listAiToolCatalog(admin).items.find(item => item.id === 'fixture.group')!.scopes).toEqual(['group']);
  });

  it('reads late registrations and assigns canonical groups and static approval hints', async () => {
    const f = await fixture();
    const admin = invocation({ source: 'http' });
    const before = f.executor.listAiToolCatalog(admin);
    const groups = {
      'core.future': 'core', 'modules.future': 'core', 'alias.future': 'alias', 'rss.future': 'rss',
      'rate.future': 'rate', 'weather.future': 'weather', 'sticker.future': 'sticker', 'subconv.future': 'subconv',
      'ai.search': 'search', 'ai.fetch': 'search', 'ai.memory.future': 'memory', 'ai.automations.future': 'automation',
      'ai.automation.future': 'automation', 'ai.jobs.future': 'automation', 'ai.skills.future': 'skills',
      'ai.mcp.stdio.future': 'local', 'ai.sandbox.local.future': 'local', 'ai.mcp.future': 'mcp', 'ai.sandbox.future': 'sandbox',
      'ai.future': 'ai', 'ai.search.future': 'ai', 'fixture.future': 'other', core: 'other', ai: 'other',
    };
    for (const id of Object.keys(groups).reverse()) {
      f.executor.register({ ...fixturePolicy, id, input: emptyInputSchema, output: z.boolean(), execute: () => true });
    }
    const confirmation = vi.fn(() => { throw new Error('Must not run callback'); });
    for (const effect of ['read', 'personal_write', 'write', 'destructive', 'permission'] as const) {
      for (const callback of [false, true]) f.executor.register({ ...fixturePolicy, id: `fixture.${effect}.${callback}`, effect,
        input: emptyInputSchema, output: z.boolean(), execute: () => true, ...(callback ? { confirmation } : {}) });
    }
    const catalog = f.executor.listAiToolCatalog(admin);
    expect(catalog.items).toHaveLength(before.items.length + Object.keys(groups).length + 10);
    expect(catalog.items.map(item => item.id)).toEqual(catalog.items.map(item => item.id).sort());
    for (const [id, group] of Object.entries(groups)) expect(catalog.items.find(item => item.id === id)?.group).toBe(group);
    for (const item of catalog.items.filter(item => item.id.startsWith('fixture.') && item.id !== 'fixture.future')) {
      expect(item.approval).toBe(['write', 'destructive', 'permission'].includes(item.effect) ? 'required'
        : item.effect === 'personal_write' || item.id.endsWith('.true') ? 'conditional' : 'none');
    }
    expect(confirmation).not.toHaveBeenCalled();
  });

  it('has a strict, unique, bounded serializable DTO with no schema or private metadata fields', () => {
    const item = { id: 'core.info', group: 'core', effect: 'read', scopes: ['private', 'group'], permission: 'any', approval: 'none' };
    expect(aiToolCatalogSchema.parse({ items: [item] })).toEqual({ items: [item] });
    const budget = Array.from({ length: 256 }, (_, index) => ({ ...item, id: `tool.${index}`.padEnd(64, 'x'),
      group: 'g'.repeat(32), effect: 'personal_write', permission: 'chat_manager', approval: 'conditional' }));
    expect(aiToolCatalogSchema.safeParse({ items: budget }).success).toBe(true);
    expect(Buffer.byteLength(JSON.stringify({ items: budget }))).toBeLessThan(65_536);
    for (const invalid of [
      {}, { items: [item], settings: {} }, { items: [item, item] }, { items: [...budget, { ...item, id: 'tool.overflow' }] },
      ...[{ id: 'x' }, { id: 'x'.repeat(65) }, { id: 'Bad.Id' }, { id: 'bad/id' }, { id: 'bad.\u4e2d' },
        { group: '' }, { group: 'g'.repeat(33) }, { group: 'bad group' }, { effect: 'unknown' }, { permission: 'admin' },
        { approval: 'always' }, { scopes: [] }, { scopes: ['private', 'private'] }, { scopes: ['supergroup'] },
        { scopes: ['private', 'group', 'private'] }, { scopes: 'private' }, { description: 'private' },
        { inputSchema: {} }, { outputSchema: {} }, { credentialRef: 'private' }, { metadata: {} },
      ].map(change => ({ items: [{ ...item, ...change }] })),
    ]) expect(aiToolCatalogSchema.safeParse(invalid).success).toBe(false);
    expect(z.toJSONSchema(aiToolCatalogSchema, { target: 'draft-7' })).toMatchObject({
      type: 'object', additionalProperties: false, properties: { items: { maxItems: 256, items: { additionalProperties: false } } },
    });
  });

  it('fails closed on invalid registry metadata, duplicate IDs or catalog capacity overflow', async () => {
    const f = await fixture();
    const admin = invocation({ source: 'http' });
    const definition: ActionDefinition<Record<string, never>, boolean> = { ...fixturePolicy, id: 'fixture.mutable',
      input: emptyInputSchema, output: z.boolean(), execute: () => true };
    f.executor.register(definition);
    expect(() => f.executor.register(definition)).toThrow(expect.objectContaining({ code: 'INVALID_INPUT' }));
    definition.id = 'core.info';
    expect(() => f.executor.listAiToolCatalog(admin)).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    definition.id = 'fixture.mutable'; definition.scopes = [];
    expect(() => f.executor.listAiToolCatalog(admin)).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    definition.scopes = ['private'];
    const count = f.executor.listAiToolCatalog(admin).items.length;
    for (let index = count; index < 256; index++) f.executor.register({ ...definition, id: `fixture.capacity.${index}` });
    expect(f.executor.listAiToolCatalog(admin).items).toHaveLength(256);
    f.executor.register({ ...definition, id: 'fixture.overflow' });
    expect(() => f.executor.listAiToolCatalog(admin)).toThrow(expect.objectContaining({ code: 'CAPACITY' }));
  });
});

describe('server-owned confirmation subjects', () => {
  it('keeps old confirmations valid and accepts only strict bounded subject metadata', () => {
    const confirmation = { token: 'a'.repeat(40), actionId: 'rss.remove', target: 'user:1', expiresAt: new Date().toISOString() };
    expect(confirmationSchema.parse(confirmation)).toEqual(confirmation);
    const subject = { kind: 'rss', id: 'abcdef123456', title: '' };
    expect(confirmationSchema.parse({ ...confirmation, subject })).toEqual({ ...confirmation, subject });
    for (const invalid of [null, {}, { ...subject, kind: 'user' }, { ...subject, id: 'ABCDEF123456' },
      { ...subject, id: 'abcdef12345' }, { ...subject, title: 'x'.repeat(129) }, { ...subject, url: 'https://private.example/' }]) {
      expect(confirmationSchema.safeParse({ ...confirmation, subject: invalid }).success).toBe(false);
    }
  });

  it('detaches callback metadata, returned approvals, replay receipts and normalized pending inputs', async () => {
    const f = await fixture();
    const subject: ConfirmationSubject = { kind: 'rss', id: 'abcdef123456', title: 'Current title' };
    const input = { values: ['  normalized  '] };
    const execute = vi.fn((value: typeof input) => value);
    const confirmationSubject = vi.fn(() => subject);
    f.executor.register({ ...fixturePolicy, id: 'fixture.subject', effect: 'write',
      input: z.strictObject({ values: z.array(z.string().trim()) }), output: z.strictObject({ values: z.array(z.string()) }),
      confirmationSubject, execute });
    const context = invocation();
    const result = await f.executor.execute(context, 'fixture.subject', input);
    const approval = token(result);
    if (result.status !== 'pending_confirmation') throw new Error('missing approval');
    const expected = structuredClone(result.confirmation);
    input.values[0] = 'Changed caller input'; subject.title = 'Changed callback object';
    result.confirmation.subject!.title = 'Changed receipt';
    const pending = f.executor.pending(context, approval);
    expect(pending).toEqual(expected);
    pending.subject!.id = '000000000000';
    const details = f.executor.pendingDetails(context, approval);
    expect(details).toEqual({ confirmation: expected, input: { values: ['normalized'] } });
    details.confirmation.subject!.title = 'Changed details';
    (details.input as typeof input).values.push('Changed pending input');
    const replay = await f.executor.execute(context, 'fixture.subject', { values: ['normalized'] });
    expect(replay).toMatchObject({ status: 'pending_confirmation', confirmation: expected });
    if (replay.status !== 'pending_confirmation') throw new Error('missing replay');
    replay.confirmation.subject!.title = 'Changed replay';
    expect(await f.executor.execute(context, 'fixture.subject', { values: ['normalized'] }))
      .toMatchObject({ status: 'pending_confirmation', confirmation: expected });
    expect(f.executor.pendingDetails(context, approval)).toEqual({ confirmation: expected, input: { values: ['normalized'] } });
    expect(confirmationSubject).toHaveBeenCalledOnce();
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ status: 'succeeded', data: { values: ['normalized'] } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('rejects invalid or asynchronous callback output before retaining an approval', async () => {
    const f = await fixture();
    const valid = { kind: 'rss', id: 'abcdef123456', title: 'Current title' };
    for (const [index, subject] of [undefined, null, { ...valid, title: 'x'.repeat(129) },
      { ...valid, url: 'https://private.example/' }, Promise.resolve(valid)].entries()) {
      f.executor.register({ ...fixturePolicy, id: `fixture.bad_subject.${index}`, effect: 'write', input: emptyInputSchema,
        output: z.boolean(), execute: () => true, confirmationSubject: () => subject as ConfirmationSubject });
      expect(await f.executor.prepare(invocation(), `fixture.bad_subject.${index}`, {}))
        .toMatchObject({ status: 'rejected', error: { code: 'INVALID_OUTPUT' } });
    }
    expect(f.executor['approvals'].size).toBe(0); expect(f.executor['approvalBytes']).toBe(0);
  });

  it('counts subject metadata in the retained approval byte budget and reclaims it on confirmation', async () => {
    const f = await fixture();
    const input = { payload: 'x'.repeat(256_000) };
    f.executor.register({ ...fixturePolicy, id: 'fixture.subject_budget', input: z.strictObject({ payload: z.string() }),
      output: z.boolean(), execute: () => true, confirmationSubject: () => ({ kind: 'rss', id: 'abcdef123456', title: 'x'.repeat(128) }) });
    const result = await f.executor.prepare(invocation(), 'fixture.subject_budget', input);
    const approval = token(result);
    if (result.status !== 'pending_confirmation') throw new Error('missing approval');
    const bytes = Buffer.byteLength(JSON.stringify(input)) + Buffer.byteLength(JSON.stringify(result.confirmation)) + 1024;
    expect(f.executor['approvalBytes']).toBe(bytes);
    const count = Math.floor(1024 * 1024 / bytes);
    for (let index = 1; index < count; index++) token(await f.executor.prepare(invocation(), 'fixture.subject_budget', input));
    expect(await f.executor.prepare(invocation(), 'fixture.subject_budget', input)).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(f.executor['approvalBytes']).toBe(count * bytes);
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ status: 'succeeded' });
    expect(f.executor['approvalBytes']).toBe((count - 1) * bytes);
    token(await f.executor.prepare(invocation(), 'fixture.subject_budget', input));
  });
});

describe('idle Action cache reclamation', () => {
  it('releases expired DTOs and approval inputs at their own TTLs without later requests', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    expect(vi.getTimerCount()).toBe(0);
    const input = { payload: 'x'.repeat(65_536) };
    const execute = vi.fn((value: typeof input) => value);
    f.executor.register({ ...fixturePolicy, id: 'fixture.idle', input: z.strictObject({ payload: z.string() }),
      output: z.strictObject({ payload: z.string() }), execute });
    const context = invocation();
    expect(await f.executor.execute(context, 'fixture.idle', input)).toMatchObject({ status: 'succeeded', data: input });
    const retainedBytes = f.executor['retainedBytes'];
    expect(retainedBytes).toBeGreaterThan(65_536);
    expect(vi.getTimerCount()).toBe(1);
    expect(f.executor['expiryTimer']?.hasRef()).toBe(false);

    await vi.advanceTimersByTimeAsync(300_000);
    token(await f.executor.prepare(invocation(), 'fixture.idle', input));
    const approvalBytes = f.executor['approvalBytes'];
    expect(approvalBytes).toBeGreaterThan(65_536);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(await f.executor.execute(context, 'fixture.idle', input)).toMatchObject({ status: 'succeeded', replayed: true, data: input });
    expect(execute).toHaveBeenCalledOnce();
    expect(f.executor['retainedBytes']).toBe(retainedBytes);

    await vi.advanceTimersByTimeAsync(1);
    expect(f.executor['executions'].size).toBe(0);
    expect(f.executor['retainedBytes']).toBe(0);
    expect(f.executor['approvals'].size).toBe(1);
    expect(f.executor['approvalBytes']).toBe(approvalBytes);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(f.executor['approvals'].size).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.executor['approvals'].size).toBe(0);
    expect(f.executor['approvalBytes']).toBe(0);
    expect(f.executor['expiryTimer']).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('preserves pending receipt replay and one-time confirmation just before expiry', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const execute = vi.fn(() => true);
    f.executor.register({ ...fixturePolicy, id: 'fixture.idle_approval', input: emptyInputSchema, output: z.boolean(), effect: 'write', execute });
    const context = invocation();
    const result = await f.executor.execute(context, 'fixture.idle_approval', {});
    const approval = token(result);
    const approvalBytes = f.executor['approvalBytes'];
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(599_999);
    expect(await f.executor.execute(context, 'fixture.idle_approval', {})).toEqual(result);
    expect(f.executor['approvalBytes']).toBe(approvalBytes);
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ status: 'succeeded' });
    expect(f.executor['approvals'].size).toBe(0);
    expect(f.executor['approvalBytes']).toBe(0);
    expect(f.executor['executions'].size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.executor['executions'].size).toBe(0);
    expect(f.executor['retainedBytes']).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([0, -10_000])('rechecks an independently frozen or rewound injected clock (shift: %s)', async shift => {
    vi.useFakeTimers();
    let now = 20_000;
    const f = await fixture({ services: { now: () => now } });
    await f.executor.execute(invocation(), 'core.info', {});
    token(await f.executor.prepare(invocation(), 'core.info', {}));
    const retainedBytes = f.executor['retainedBytes'];
    const approvalBytes = f.executor['approvalBytes'];
    now += shift;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.executor['executions'].size).toBe(1);
    expect(f.executor['approvals'].size).toBe(1);
    expect(f.executor['retainedBytes']).toBe(retainedBytes);
    expect(f.executor['approvalBytes']).toBe(approvalBytes);
    expect(f.executor['expiryTimer']?.hasRef()).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    now = 619_999;
    await vi.advanceTimersByTimeAsync(600_000 - shift);
    expect(f.executor['executions'].size).toBe(1);
    expect(f.executor['approvals'].size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    now++;
    await vi.advanceTimersByTimeAsync(1);
    expect(f.executor['executions'].size).toBe(0);
    expect(f.executor['approvals'].size).toBe(0);
    expect(f.executor['retainedBytes']).toBe(0);
    expect(f.executor['approvalBytes']).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains active identities through timeout and cleanup, then starts the full replay TTL', async () => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const execute = vi.fn(async () => { entered.resolve(); await finish.promise; return true; });
    f.executor.register({ ...fixturePolicy, id: 'fixture.idle_active', input: emptyInputSchema, output: z.boolean(), effect: 'personal_write', execute });
    const context = invocation();
    let settled = false;
    const operation = f.executor.execute(context, 'fixture.idle_active', {}).then(result => { settled = true; return result; });
    try {
      await entered.promise;
      const reservedBytes = f.executor['retainedBytes'];
      expect(f.executor['expiryTimer']).toBeUndefined();
      expect(vi.getTimerCount()).toBe(1); // Only the running Action deadline.
      await f.executor.execute(invocation(), 'core.info', {});
      token(await f.executor.prepare(invocation(), 'core.info', {}));
      expect(vi.getTimerCount()).toBe(2);
      await vi.advanceTimersByTimeAsync(600_001);
      expect(settled).toBe(false);
      expect(f.executor['executions'].size).toBe(1);
      expect([...f.executor['executions'].values()][0]?.active).toBe(true);
      expect(f.executor['retainedBytes']).toBe(reservedBytes);
      expect(f.executor['approvals'].size).toBe(0);
      expect(f.executor['approvalBytes']).toBe(0);
      expect(f.executor['runningTasks'].size).toBe(1);
      expect(f.executor['expiryTimer']).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);

      const duplicate = f.executor.execute(context, 'fixture.idle_active', {});
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe(false);
      expect(execute).toHaveBeenCalledOnce();
      finish.resolve();
      const result = await operation;
      expect(result).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
      expect(await duplicate).toEqual(result);
      expect([...f.executor['executions'].values()][0]?.active).toBe(false);
      expect(f.executor['retainedBytes']).toBeLessThan(reservedBytes);
      expect(f.executor['runningTasks'].size).toBe(0);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(599_999);
      expect(f.executor['executions'].size).toBe(1);
      expect(await f.executor.execute(context, 'fixture.idle_active', {})).toEqual(result);
      expect(execute).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(f.executor['executions'].size).toBe(0);
      expect(f.executor['retainedBytes']).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { finish.resolve(); }
  });

  it.each(['execute', 'confirm'] as const)('clears expiry scheduling on close without preempting awaited %s cleanup', async method => {
    vi.useFakeTimers();
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    f.executor.register({ ...fixturePolicy, id: 'fixture.idle_close', input: emptyInputSchema, output: z.boolean(), effect: 'personal_write',
      execute: async (_input, context) => {
        context.signal.addEventListener('abort', () => aborted.resolve(), { once: true });
        entered.resolve(); await finish.promise; return true;
      } });
    const operation = method === 'execute' ? f.executor.execute(invocation(), 'fixture.idle_close', {})
      : f.executor.confirm(invocation(), token(await f.executor.prepare(invocation(), 'fixture.idle_close', {})));
    try {
      await entered.promise;
      expect(f.executor['approvals'].size).toBe(0);
      expect(f.executor['approvalBytes']).toBe(0);
      expect(f.executor['expiryTimer']).toBeUndefined();
      await f.executor.execute(invocation(), 'core.info', {});
      token(await f.executor.prepare(invocation(), 'core.info', {}));
      expect(vi.getTimerCount()).toBe(2);
      const retainedBytes = f.executor['retainedBytes'];
      let closed = false;
      const closing = f.executor.close().then(() => { closed = true; });
      await aborted.promise;
      expect(f.executor['expiryTimer']).toBeUndefined();
      expect(f.executor['approvals'].size).toBe(0);
      expect(f.executor['approvalBytes']).toBe(0);
      await vi.advanceTimersByTimeAsync(600_001);
      expect(closed).toBe(false);
      expect(f.executor['runningTasks'].size).toBe(1);
      expect(f.executor['retainedBytes']).toBe(retainedBytes);
      expect(vi.getTimerCount()).toBe(0);
      finish.resolve();
      await closing;
      expect(await operation).toMatchObject({ error: { code: 'OUTCOME_UNKNOWN' } });
      expect(f.executor['runningTasks'].size).toBe(0);
      expect(f.executor['executions'].size).toBe(0);
      expect(f.executor['retainedBytes']).toBe(0);
      expect(f.executor['expiryTimer']).toBeUndefined();
      expect(await f.executor.execute(invocation(), 'core.info', {})).toMatchObject({ error: { code: 'CANCELLED' } });
      expect(vi.getTimerCount()).toBe(0);
    } finally { finish.resolve(); }
  });
});

describe('approval binding and effects', () => {
  it('preserves AI provenance and a validated safe projection when a human confirms', async () => {
    const f = await fixture({ services: { aiEnabled: true } });
    const observed: InvocationContext[] = [];
    f.executor.register({ ...fixturePolicy, id: 'fixture.ai_only', sources: ['ai'], input: emptyInputSchema,
      output: z.strictObject({ secret: z.string(), delivered: z.boolean() }), aiOutput: z.strictObject({ delivered: z.boolean() }),
      modelOutput: output => ({ delivered: output.delivered }), effect: 'permission', execute: (_input, context) => {
        observed.push(context); return { secret: 'OWNER_ONLY_RESULT', delivered: true };
      } });
    const context = invocation({ aiRunId: 'run-1', aiGrantId: 'grant-1', aiSettingsRevision: 7 });
    const approval = token(await f.executor.executeTool(context, 'fixture.ai_only', {}));
    expect(await f.executor.confirm(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), approval))
      .toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    const result = await f.executor.confirm(invocation(), approval);
    expect(result).toMatchObject({ status: 'succeeded', data: { delivered: true } });
    expect(JSON.stringify(result)).not.toContain('OWNER_ONLY_RESULT');
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ source: 'ai', actorId: 1, aiRunId: 'run-1', aiGrantId: 'grant-1', aiSettingsRevision: 7 });
    expect(f.audit.mock.calls.at(-1)?.[0]).toMatchObject({ source: 'ai', actionId: 'fixture.ai_only' });
  });

  it('rechecks current AI grants at approval instead of using human permissions as a bypass', async () => {
    const f = await fixture();
    let allowed = true;
    f.services.aiPolicy = { available: () => true, authorize: () => { if (!allowed) throw new AppError('FORBIDDEN'); } };
    const execute = vi.fn(() => true);
    f.executor.register({ ...fixturePolicy, id: 'fixture.granted', input: emptyInputSchema, output: z.boolean(), effect: 'write', execute });
    const approval = token(await f.executor.executeTool(invocation({ aiRunId: 'run-1' }), 'fixture.granted', {}));
    allowed = false;
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])('compares the scoped AI approval policy key with original provenance (changed: %s)', async changed => {
    const f = await fixture({ services: { aiEnabled: true } });
    let key = 'policy-a';
    const approvalPolicyKey = vi.fn(() => key);
    const policyRevision = vi.fn(() => 999);
    f.services.ai = { approvalPolicyKey, policyRevision } as unknown as AiService;
    const execute = vi.fn(() => true);
    f.executor.register({ ...fixturePolicy, id: 'fixture.policy_key', input: emptyInputSchema, output: z.boolean(), effect: 'write', execute });
    const approval = token(await f.executor.executeTool(invocation({ aiRunId: 'run-1', aiGrantId: 'grant-1', aiSettingsRevision: 7 }), 'fixture.policy_key', {}));
    if (changed) key = 'policy-b';
    const result = await f.executor.confirm(invocation(), approval);
    expect(result).toMatchObject(changed ? { error: { code: 'CONFIRMATION_EXPIRED' } } : { status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(changed ? 0 : 1);
    expect(approvalPolicyKey).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai', aiRunId: 'run-1', aiGrantId: 'grant-1', aiSettingsRevision: 7 }), 'fixture.policy_key');
    expect(policyRevision).not.toHaveBeenCalled();
  });

  it('reserves bounded receipt capacity for controls without evicting ordinary replay records', async () => {
    const f = await fixture();
    const executor = new ActionExecutor({ ...f.services, byteCapacity: 1_100_000 });
    const execute = vi.fn(() => 'x'.repeat(220_000));
    executor.register({ ...fixturePolicy, id: 'fixture.large_result', input: emptyInputSchema, output: z.string().max(220_000), execute });
    for (let index = 0; index < 3; index++) expect(await executor.execute(invocation(), 'fixture.large_result', {})).toMatchObject({ status: 'succeeded' });
    expect(await executor.execute(invocation(), 'fixture.large_result', {})).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(await executor.execute(invocation(), 'core.status', {})).toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledTimes(3);
    await executor.close();
  });

  it('bounds retained bytes before work and keeps prior replay protection intact', async () => {
    const f = await fixture();
    const executor = new ActionExecutor({ ...f.services, byteCapacity: 270_000 });
    const context = invocation({ invocationId: 'retained-large' });
    const execute = vi.fn(() => 'x'.repeat(16_384));
    executor.register({ ...fixturePolicy, id: 'fixture.retained', input: emptyInputSchema, output: z.string().max(16_384), execute });
    expect(await executor.execute(context, 'fixture.retained', {})).toMatchObject({ status: 'succeeded' });
    expect(await executor.execute(invocation(), 'fixture.retained', {})).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(await executor.execute(context, 'fixture.retained', {})).toMatchObject({ status: 'succeeded', replayed: true });
    expect(execute).toHaveBeenCalledOnce();
    await executor.close();
  });

  it.each(['revoke', 'regrant', 'accessRevision', 'settingsRevision', 'expiry'] as const)('rechecks only relevant %s after an asynchronous permission lookup before consuming an effect', async change => {
    let now = Date.now();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<boolean>();
    const groupAdmin = vi.fn(async () => true);
    const f = await fixture({ services: { now: () => now, groupAdmin } });
    const execute = vi.fn(() => true);
    f.executor.register({ ...fixturePolicy, id: 'fixture.async_approval', input: emptyInputSchema, output: z.boolean(),
      permission: 'group_admin', effect: 'destructive', target: (_input, context) => ({ kind: 'chat', id: context.chat.id }), execute });
    await f.access.authorize(-100, 'Group', 1, 0);
    const context = invocation({ actorId: 3, chat: { id: -100, type: 'group' } });
    const approval = token(await f.executor.prepare(context, 'fixture.async_approval', {}));
    groupAdmin.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const confirming = f.executor.confirm(context, approval);
    await entered.promise;
    expect(await f.executor.confirm(context, approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    if (change === 'revoke') await f.access.revoke(-100, 1, 1);
    if (change === 'regrant') {
      await f.access.revoke(-100, 1, 1);
      await f.access.authorize(-100, 'Group', 1, 2);
    }
    if (change === 'accessRevision') await f.access.authorize(-200, 'Other', 1, 1);
    if (change === 'settingsRevision') await f.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
    if (change === 'expiry') now += 600_001;
    release.resolve(true);
    if (change === 'accessRevision' || change === 'settingsRevision') {
      expect(await confirming).toMatchObject({ status: 'succeeded' });
      expect(execute).toHaveBeenCalledOnce();
    } else {
      expect(await confirming).toMatchObject({ status: 'rejected', error: { code: change === 'revoke' ? 'FORBIDDEN' : 'CONFIRMATION_EXPIRED' } });
      expect(execute).not.toHaveBeenCalled();
    }
  });

  it('binds canonical parameters, user, source, chat/thread and one-time consumption', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const input = { chatId: -100, revision: 1 };
    const confirmation = token(await f.executor.execute(invocation(), 'groups.revoke', input));
    input.chatId = -200;
    expect(f.access.isAllowed(-100)).toBe(true);
    expect(await f.executor.confirm(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(await f.executor.confirm(invocation({ source: 'http' }), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(await f.executor.confirm(invocation({ botId: 54321 }), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(await f.executor.confirm(invocation({ chat: { id: 1, type: 'private', threadId: 8 } }), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    const results = await Promise.all([f.executor.confirm(invocation(), confirmation), f.executor.confirm(invocation(), confirmation)]);
    expect(results.filter(result => result.status === 'succeeded')).toHaveLength(1);
    expect(results.find(result => result.status === 'succeeded')).toMatchObject({ data: { chatId: -100, changed: true } });
    expect(results.find(result => result.status !== 'succeeded')).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(f.access.count()).toBe(0);
    expect(f.effects.leaveGroup).toHaveBeenCalledTimes(1);
  });

  it('invalidates approvals after TTL, target authorization changes or application restart', async () => {
    let now = Date.now();
    const f = await fixture({ services: { now: () => now } });
    let confirmation = token(await f.executor.prepare(invocation(), 'groups.authorize', { chatId: -100, revision: 0 }));
    now += 600_001;
    expect(await f.executor.confirm(invocation(), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    confirmation = token(await f.executor.prepare(invocation(), 'groups.authorize', { chatId: -100, revision: 0 }));
    await f.access.authorize(-100, 'Target group', 2, 0);
    expect(await f.executor.confirm(invocation(), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    confirmation = token(await f.executor.prepare(invocation(), 'groups.authorize', { chatId: -100, revision: 1 }));
    const next = new ActionExecutor(f.services);
    expect(await next.confirm(invocation(), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    await next.close();
  });

  it('keeps unrelated approvals after a default-language edit but rejects a stale settings approval', async () => {
    const f = await fixture();
    const group = token(await f.executor.prepare(invocation(), 'groups.authorize', f.access.state(-100)));
    const settings = token(await f.executor.prepare(invocation(), 'core.settings.update', { revision: 0, settings: { defaultLanguage: 'ja' } }));
    await f.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
    expect(await f.executor.confirm(invocation(), group)).toMatchObject({ status: 'succeeded', data: { chatId: -100 } });
    expect(f.effects.notifyGroup).toHaveBeenCalledWith(-100, 'authorized', 'en', expect.any(AbortSignal));
    expect(await f.executor.confirm(invocation(), settings)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
  });

  it('commits two independently invited groups and preserves private owner approvals through unrelated bookkeeping', async () => {
    const f = await fixture();
    const event = { chatId: -100, title: 'Group', actorId: 3, isMember: true, wasMember: false, updateId: 10, at: '2026-11-08T00:00:00.000Z' };
    await f.access.membership(event);
    const first = token(await f.executor.prepare(invocation(), 'groups.authorize', f.access.state(-100)));
    const execute = vi.fn(() => true);
    f.executor.register({ ...fixturePolicy, id: 'fixture.owner_write', input: emptyInputSchema, output: z.boolean(), effect: 'write', execute });
    const personal = token(await f.executor.prepare(invocation(), 'fixture.owner_write', {}));
    await f.access.membership({ ...event, chatId: -200, updateId: 11 });
    const second = token(await f.executor.prepare(invocation(), 'groups.authorize', f.access.state(-200)));
    await f.access.membership({ ...event, chatId: -200, updateId: 12, wasMember: true });
    expect(await f.executor.confirm(invocation(), first)).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.confirm(invocation(), second)).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.confirm(invocation(), personal)).toMatchObject({ status: 'succeeded' });
    expect(execute).toHaveBeenCalledOnce();
    expect(f.access.count()).toBe(2);
    expect(f.effects.notifyGroup).toHaveBeenCalledTimes(2);
  });

  it('invalidates target revoke/regrant approvals even when every visible group field repeats', async () => {
    const f = await fixture();
    const event = { chatId: -100, title: 'Group', actorId: 1, isMember: true, wasMember: false, updateId: 10, at: '2026-11-08T00:00:00.000Z' };
    await f.access.membership(event);
    const original = f.access.snapshot().groups['-100'];
    const approval = token(await f.executor.execute(invocation(), 'groups.revoke', f.access.state(-100)));
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    await f.access.membership({ ...event, updateId: 11 });
    expect(f.access.snapshot().groups['-100']).toEqual(original);
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(f.effects.notifyGroup).not.toHaveBeenCalled();
    expect(f.effects.leaveGroup).not.toHaveBeenCalled();
  });

  it('invalidates approvals for both sides of a target group migration', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const source = token(await f.executor.execute(invocation(), 'groups.revoke', f.access.state(-100)));
    const target = token(await f.executor.prepare(invocation(), 'groups.authorize', f.access.state(-200)));
    await f.access.migrate(-100, -200, 20);
    for (const approval of [source, target]) expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
  });

  it.each([false, true])('rejects a stale %s scoped edit at the real storage commit without effects or replay', async scoped => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let block = false;
    const f = await fixture({ storage: { beforeCommit: async filename => {
      if (block && filename === 'access.json') { entered.resolve(); await release.promise; }
    } } });
    const input = scoped ? f.access.state(-100) : { chatId: -100, revision: 0 };
    const approval = token(await f.executor.prepare(invocation(), 'groups.authorize', input));
    block = true;
    const competing = f.access.membership({ chatId: -100, title: 'Group', actorId: 3, isMember: false, wasMember: true, updateId: 10, at: '2026-11-08T00:00:00.000Z' });
    await entered.promise;
    const confirming = f.executor.confirm(invocation(), approval);
    try { await vi.waitFor(() => expect(f.effects.describeGroup).toHaveBeenCalledOnce()); }
    finally { release.resolve(); }
    await competing;
    expect(await confirming).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.access.isAllowed(-100)).toBe(false);
    expect(f.effects.notifyGroup).not.toHaveBeenCalled();
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
  });

  it('rechecks superadmin qualification at confirmation and retains denial after notification/leave failure', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const confirmation = token(await f.executor.execute(invocation(), 'groups.revoke', { chatId: -100, revision: 1 }));
    const check = vi.spyOn(f.access, 'isAdmin').mockReturnValue(false);
    expect(await f.executor.confirm(invocation(), confirmation)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    check.mockRestore();
    f.effects.notifyGroup.mockResolvedValue(false);
    f.effects.leaveGroup.mockResolvedValue(false);
    expect(data(await f.executor.confirm(invocation(), confirmation))).toMatchObject({ changed: true, notificationSent: false, left: false });
    expect(f.access.isAllowed(-100)).toBe(false);
  });

  it('does not perform external effects if the authorization/revocation write fails', async () => {
    let fail = false;
    const f = await fixture({ storage: { beforeCommit: async () => { if (fail) throw new Error('disk unavailable'); } } });
    await f.access.authorize(-100, 'Group', 1, 0);
    const confirmation = token(await f.executor.execute(invocation(), 'groups.revoke', { chatId: -100, revision: 1 }));
    fail = true;
    expect(await f.executor.confirm(invocation(), confirmation)).toMatchObject({ error: { code: 'STORAGE_ERROR' } });
    expect(f.access.isAllowed(-100)).toBe(true);
    expect(f.effects.notifyGroup).not.toHaveBeenCalled();
    expect(f.effects.leaveGroup).not.toHaveBeenCalled();
  });

  it('permits a low-risk self operation, but high-risk AI effects need a separate human confirmation', async () => {
    const f = await fixture({ services: { aiEnabled: true } });
    const called = vi.fn(() => ({ id: 'fixture-1' }));
    f.executor.register({ ...fixturePolicy, id: 'fixture.personal', input: z.strictObject({ userId: z.number().int().positive() }), output: z.strictObject({ id: z.string() }),
      permission: 'self', effect: 'personal_write', target: input => ({ kind: 'user', id: input.userId }), execute: called });
    expect(await f.executor.executeTool(invocation(), 'fixture.personal', { userId: 1 })).toMatchObject({ status: 'succeeded', data: { id: 'fixture-1' } });
    expect(await f.executor.executeTool(invocation(), 'fixture.personal', { userId: 2 })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    f.executor.register({ ...fixturePolicy, id: 'fixture.publish', input: emptyInputSchema, output: z.strictObject({ id: z.string() }), effect: 'write', execute: called });
    const confirmation = token(await f.executor.executeTool(invocation(), 'fixture.publish', {}));
    expect(called).toHaveBeenCalledTimes(1);
    expect(await f.executor.confirm(invocation({ source: 'ai' }), confirmation)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(await f.executor.confirm(invocation(), confirmation)).toMatchObject({ status: 'succeeded' });
    expect(called).toHaveBeenCalledTimes(2);
  });
});

describe('deadlines, real cancellation and safe receipts', () => {
  it('rejects already cancelled/expired requests without executing side effects', async () => {
    const f = await fixture();
    const controller = new AbortController(); controller.abort();
    expect(await f.executor.execute(invocation({ signal: controller.signal }), 'groups.authorize', { chatId: -100, revision: 0 })).toMatchObject({ error: { code: 'CANCELLED' } });
    expect(await f.executor.execute(invocation({ deadline: Date.now() - 1 }), 'core.info', {})).toMatchObject({ error: { code: 'TIMEOUT' } });
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
  });

  it.each(['read', 'personal_write'] as const)('cancels actual %s work, waits its cleanup, and accurately classifies uncertain writes', async effect => {
    const f = await fixture();
    let cleaned = false;
    f.executor.register({ ...fixturePolicy, id: 'fixture.slow', input: emptyInputSchema, output: z.boolean(), effect, timeoutMs: 10,
      execute: async (_input, context) => {
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        await Promise.resolve();
        cleaned = true;
        return true;
      },
    });
    expect(await f.executor.execute(invocation(), 'fixture.slow', {})).toMatchObject({ status: 'failed', error: { code: effect === 'read' ? 'TIMEOUT' : 'OUTCOME_UNKNOWN' } });
    expect(cleaned).toBe(true);
  });

  it('does not confuse a timed-out promise with cancellation of an uncooperative operation', async () => {
    const f = await fixture();
    const aborted = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let settled = false;
    f.executor.register({ ...fixturePolicy, id: 'fixture.uncooperative', input: emptyInputSchema, output: z.boolean(), effect: 'personal_write', timeoutMs: 10,
      execute: async (_input, context) => { context.signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await finish.promise; return true; },
    });
    const operation = f.executor.execute(invocation(), 'fixture.uncooperative', {}).then(result => { settled = true; return result; });
    await aborted.promise;
    expect(settled).toBe(false);
    finish.resolve();
    expect(await operation).toMatchObject({ error: { code: 'OUTCOME_UNKNOWN' } });
  });

  it('never retries a consumed approval after an unknown write outcome', async () => {
    const f = await fixture();
    const execute = vi.fn(async (_input: unknown, context: InvocationContext) => {
      await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
      return true;
    });
    f.executor.register({ ...fixturePolicy, id: 'fixture.unknown_approval', input: emptyInputSchema, output: z.boolean(), effect: 'write', timeoutMs: 10, execute });
    const approval = token(await f.executor.execute(invocation(), 'fixture.unknown_approval', {}));
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'OUTCOME_UNKNOWN' } });
    expect(await f.executor.confirm(invocation(), approval)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
    expect(execute).toHaveBeenCalledOnce();
  });

  it('closing aborts and drains confirmations too, not just regular execute receipts', async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    let cleaned = false;
    f.executor.register({ ...fixturePolicy, id: 'fixture.confirmation', input: emptyInputSchema, output: z.boolean(), effect: 'destructive',
      execute: async (_input, context) => {
        entered.resolve();
        await new Promise<void>(resolve => context.signal.addEventListener('abort', () => resolve(), { once: true }));
        cleaned = true; return true;
      },
    });
    const confirmation = token(await f.executor.execute(invocation(), 'fixture.confirmation', {}));
    const result = f.executor.confirm(invocation(), confirmation);
    await entered.promise;
    await f.executor.close();
    expect(cleaned).toBe(true);
    expect(await result).toMatchObject({ error: { code: 'OUTCOME_UNKNOWN' } });
    expect(await f.executor.execute(invocation(), 'core.info', {})).toMatchObject({ error: { code: 'CANCELLED' } });
  });

  it('validates output/serializability and never includes unsafe inputs or raw exceptions in receipts/audit', async () => {
    const f = await fixture();
    const secret = 'PRIVATE_INPUT_DO_NOT_LOG';
    f.executor.register({ ...fixturePolicy, id: 'fixture.invalid', input: z.strictObject({ value: z.string() }), output: z.strictObject({ ok: z.boolean() }),
      execute: (() => ({ secret })) as unknown as ActionDefinition<{ value: string }, { ok: boolean }>['execute'] });
    const invalid = await f.executor.execute(invocation(), 'fixture.invalid', { value: secret });
    expect(invalid).toMatchObject({ error: { code: 'INVALID_OUTPUT' } });
    f.executor.register({ ...fixturePolicy, id: 'fixture.throws', input: emptyInputSchema, output: z.boolean(), execute: () => { throw new Error(secret); } });
    const failure = await f.executor.execute(invocation(), 'fixture.throws', {});
    expect(failure).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify([invalid, failure, f.audit.mock.calls])).not.toContain(secret);
    expect(() => f.executor.register({ ...fixturePolicy, id: 'fixture.loose', input: z.object({}), output: z.boolean(), execute: () => true })).toThrow();
  });
});
