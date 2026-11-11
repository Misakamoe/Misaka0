import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { emptyInputSchema, type ActionResult } from '../shared/schemas/index.js';
import { ActionExecutor, type ActionDefinition, type InvocationContext } from '../src/actions.js';
import type { AiService } from '../src/ai/service.js';
import { AppError } from '../src/errors.js';
import { aliasMetadata } from '../src/modules/alias.js';
import { rssMetadata } from '../src/modules/rss.js';
import { rateMetadata } from '../src/modules/rate.js';
import { weatherMetadata } from '../src/modules/weather.js';
import { stickerMetadata } from '../src/modules/sticker.js';
import { subconvMetadata } from '../src/modules/subconv.js';
import { coreFixture, invocation } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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
    expect(ai).toEqual({ runtime: 'grammy', version: '0.1.0', moduleCount: 6, aiAvailable: true });
    expect(f.effects.describeGroup).not.toHaveBeenCalled();
    expect(data(await f.executor.execute(invocation(), 'modules.list', {}))).toEqual([aliasMetadata, rssMetadata, rateMetadata, weatherMetadata, stickerMetadata, subconvMetadata]);
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
