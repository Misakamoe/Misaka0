import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { automationDefinitionSchema, type AutomationDefinition, type AutomationView } from '../shared/schemas/ai-automation.js';
import { aiDefaults, aiSettingsSchema } from '../shared/schemas/ai.js';
import type { ActionResult } from '../shared/schemas/index.js';
import { ActionExecutor, createInvocation, type InvocationContext } from '../src/actions.js';
import { AiAutomations, type AiAutomationsOptions } from '../src/ai/automation-service.js';
import { aiScope, selectAi } from '../src/ai/policy.js';
import { AiStore } from '../src/ai/store.js';
import { AppError } from '../src/errors.js';
import { coreFixture, invocation } from './support/core.js';

const now = Date.parse('2026-11-11T00:00:00Z');
const masterKey = Buffer.alloc(32, 0x45);
const cleanups: (() => Promise<void>)[] = [];
const releases: (() => void)[] = [];
const alice = () => invocation({ actorId: 3, chat: { id: 3, type: 'private' } });
const group = (actorId = 3, threadId = 7) => invocation({ actorId, chat: { id: -100, type: 'supergroup', threadId } });
function definition(overrides: Partial<AutomationDefinition> = {}): AutomationDefinition {
  return automationDefinitionSchema.parse({ title: 'Private automation title', instruction: 'PRIVATE_AUTOMATION_INSTRUCTION',
    trigger: { kind: 'interval', startAt: '2026-11-11T00:05:00Z', minutes: 5, timeZone: 'UTC' }, tools: ['fixture.write'],
    expiresAt: '2026-11-12T00:00:00Z', maxRuns: 3, maxInputTokens: 1000, maxOutputTokens: 200, maxCostMicros: 100,
    ...overrides });
}
function data<T>(result: ActionResult<T>): T {
  expect(result.status, JSON.stringify(result)).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error('Expected successful test Action');
  return result.data;
}
function gate() {
  const deferred = Promise.withResolvers<'completed' | 'unknown'>();
  releases.push(() => deferred.resolve('unknown'));
  return deferred;
}
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

async function fixture() {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(now);
  const core = await coreFixture({
    rss: { fetcher: async () => { throw new Error('Unexpected network'); } },
    rate: { json: async () => { throw new Error('Unexpected network'); } },
    weather: { json: async () => { throw new Error('Unexpected network'); } },
  });
  await core.access.authorize(-100, 'test group', 1, 0);
  const store = await AiStore.open({ directory: core.directory, masterKey });
  store.updateSettings(aiSettingsSchema.parse({ ...aiDefaults(), enabled: true,
    providers: [{ id: 'mock', protocol: 'openai-responses', baseUrl: 'https://example.invalid/v1', allowedOrigins: ['https://example.invalid'], credentialRef: 'env:MOCK', enabled: true }],
    presets: [{ id: 'fixed', providerId: 'mock', model: 'mock', tools: ['fixture.write', 'fixture.other'], inputCapabilities: ['text'], outputCapabilities: ['text'],
      budget: { maxInputTokens: 2000, maxOutputTokens: 400, maxToolCalls: 4, maxDurationMs: 600_000, maxCostMicros: 200 } }],
    grants: [{ id: 'private3', kind: 'private', subjectId: 3, presetId: 'fixed' }, { id: 'group100', kind: 'group', subjectId: -100, presetId: 'fixed' }],
  }), 0);
  const f = { core, store, executor: undefined as unknown as ActionExecutor, automations: undefined as unknown as AiAutomations,
    run: vi.fn<AiAutomationsOptions['run']>(async () => 'completed'),
    isMember: vi.fn<AiAutomationsOptions['isMember']>(async () => true), stopRun: vi.fn<AiAutomationsOptions['stopRun']>(async () => {}),
    onError: vi.fn(), native: vi.fn(() => true),
  };
  const attach = () => {
    const select = (context: InvocationContext) => selectAi(context, f.store.getSettings(), core.access, Date.now());
    f.automations = new AiAutomations({ store: f.store, select, isMember: f.isMember, run: f.run, stopRun: f.stopRun, onError: f.onError });
    f.executor = new ActionExecutor({ ...core.services, aiPolicy: { available: () => true,
      authorize: context => { select(context); }, approvalExempt: (context, id) => f.automations.authorizeTool(context, id) } });
    f.automations.register(f.executor);
    f.executor.register({ id: 'fixture.write', input: z.strictObject({}), output: z.boolean(), scopes: ['private', 'group'],
      sources: ['telegram', 'ai'], permission: 'self', aiVisible: true, aiDescription: 'test write', effect: 'write', timeoutMs: 1000, execute: f.native });
  };
  attach();
  cleanups.push(async () => { await f.automations.stop(); await f.executor.close(); f.store.close(); core.subconv.stop(); await core.close(); });
  return { ...f, get store() { return f.store; }, get executor() { return f.executor; }, get automations() { return f.automations; },
    restart: async () => { await f.automations.stop(); await f.executor.close(); f.store.close(); f.store = await AiStore.open({ directory: core.directory, masterKey }); attach(); f.automations.start(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function confirm<T>(f: Fixture, context: InvocationContext, action: string, input: unknown): Promise<T> {
  const pending = await f.executor.execute(context, action, input);
  expect(pending.status).toBe('pending_confirmation');
  if (pending.status !== 'pending_confirmation') throw new Error('Expected confirmation');
  return data(await f.executor.confirm<T>(context, pending.confirmation.token));
}
async function create(f: Fixture, context = alice(), value = definition()): Promise<AutomationView> {
  return confirm(f, context, 'ai.automations.create', { definition: value });
}
async function list(f: Fixture, context = alice(), page?: number) {
  return data(await f.executor.execute<{ items: AutomationView[]; nextCursor: number | null }>(context, 'ai.automations.list', page === undefined ? {} : { page }));
}

describe('persistent automation Actions and standing authority', () => {
  it('keeps unrelated policy edits valid across restart but never restores revoked standing authority', async () => {
    const f = await fixture();
    const job = await create(f);
    const original = f.store.getSettings();
    f.store.updateSettings({ ...original.settings, deniedUserIds: [9] }, original.revision);
    f.store.changeCredential('instance', { operation: 'replace', ref: 'vault:unrelated', value: 'isolated-test-secret' }, original.revision + 1);
    await f.restart(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).toHaveBeenCalledOnce();
    expect((await list(f)).items[0]).toMatchObject({ id: job.id, state: 'active', completedRuns: 1 });
    const before = f.store.getSettings();
    f.store.updateSettings({ ...before.settings, grants: before.settings.grants.filter(grant => grant.subjectId !== 3) }, before.revision);
    f.store.updateSettings(before.settings, before.revision + 1);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).toHaveBeenCalledOnce();
    expect((await list(f)).items[0]).toMatchObject({ id: job.id, state: 'paused', completedRuns: 1 });
  });

  it('pauses only affected jobs on explicit invalidation and treats missing policy keys conservatively', async () => {
    const f = await fixture(); const privateJob = await create(f); const groupJob = await create(f, group());
    const original = f.store.getSettings();
    f.store.updateSettings({ ...original.settings, grants: original.settings.grants.filter(grant => grant.kind !== 'private') }, original.revision);
    await f.automations.invalidatePolicy();
    expect((await list(f)).items[0]).toMatchObject({ id: privateJob.id, state: 'paused' });
    expect((await list(f, group())).items[0]).toMatchObject({ id: groupJob.id, state: 'active' });
    const row = f.store.recordGet(aiScope(group()), 'automation', groupJob.id)!;
    const payload = { ...row.payload as Record<string, never> }; delete payload.policyKey;
    f.store.recordPut(aiScope(group()), 'automation', { id: row.id, expectedRevision: row.revision, payload, state: 'active', dueAt: row.dueAt! });
    const current = f.store.getSettings();
    f.store.updateSettings({ ...current.settings, deniedUserIds: [9] }, current.revision);
    await f.automations.invalidatePolicy();
    expect((await list(f, group())).items[0]).toMatchObject({ id: groupJob.id, state: 'paused' });
    expect(f.run).not.toHaveBeenCalled();
  });

  it('requires real one-time human confirmation and persists only normalized own-scope definitions', async () => {
    const f = await fixture();
    const context = group();
    const pending = await f.executor.execute(context, 'ai.automations.create', { definition: { ...definition(), title: '  normalized  ' } });
    expect(pending.status).toBe('pending_confirmation');
    expect((await list(f, context)).items).toEqual([]);
    if (pending.status !== 'pending_confirmation') throw new Error();
    expect(await f.executor.confirm(group(4), pending.confirmation.token)).toMatchObject({ status: 'rejected' });
    const created = data(await f.executor.confirm<AutomationView>(context, pending.confirmation.token));
    expect(created).toMatchObject({ title: 'normalized', state: 'active', target: 'group:-100/topic:7', maxCostMicros: 100 });
    expect(await f.executor.confirm(context, pending.confirmation.token)).toMatchObject({ status: 'rejected' });
    expect((await list(f, group(4))).items).toEqual([]);
    expect((await list(f, group(3, 8))).items).toEqual([]);
    const record = f.store.recordGet(aiScope(context), 'automation', created.id)!;
    expect(record.payload).toMatchObject({ version: 1, actor: { actorId: 3, botId: 12345, language: 'en', chat: { id: -100, threadId: 7 } },
      grantId: 'group100', policyRevision: 1, presetId: 'fixed' });
    expect(JSON.stringify(record.payload)).not.toContain(pending.confirmation.token);
    expect(JSON.stringify(f.store.safeStatus())).not.toContain('PRIVATE_AUTOMATION');
    await f.restart();
    expect((await list(f, context)).items).toEqual([created]);
    expect((await readFile(join(f.core.directory, 'ai.sqlite'))).includes(Buffer.from('PRIVATE_AUTOMATION'))).toBe(false);
  });

  it('filters group listings by creator before paging and denies cross-owner mutations even for admins', async () => {
    const f = await fixture();
    const own: string[] = [];
    for (let i = 0; i < 11; i++) {
      await create(f, group(4), definition({ title: `other ${i}` }));
      own.push((await create(f, group(3), definition({ title: `own ${i}` }))).id);
    }
    const page = await list(f, group(3));
    expect(page.items.map(item => item.id)).toEqual(own.slice(0, 10));
    expect((await list(f, group(3), page.nextCursor!)).items.map(item => item.id)).toEqual(own.slice(10));
    for (const actorId of [1, 4]) {
      expect(await f.executor.execute(group(actorId), 'ai.automations.pause', { id: own[0], revision: 0 })).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
      const pending = await f.executor.execute(group(actorId), 'ai.automations.remove', { id: own[0], revision: 0 });
      if (pending.status !== 'pending_confirmation') throw new Error();
      expect(await f.executor.confirm(group(actorId), pending.confirmation.token)).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    }
    expect((await list(f, group(3))).items).toHaveLength(10);
  });

  it('rejects unknown caller authority, new tools and oversized standing budgets', async () => {
    const f = await fixture();
    expect(await f.executor.execute(alice(), 'ai.automations.create', { definition: definition(), approved: true })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    const ai = createInvocation({ ...alice(), source: 'ai', aiRunId: 'run' });
    expect(await f.executor.execute(ai, 'ai.automations.create', { definition: definition() })).toMatchObject({ status: 'rejected' });
    for (const value of [definition({ tools: ['ungranted.tool'] }), definition({ maxCostMicros: 201 }), definition({ maxInputTokens: 2001 }), definition({ maxOutputTokens: 401 })]) {
      const pending = await f.executor.execute(alice(), 'ai.automations.create', { definition: value });
      if (pending.status !== 'pending_confirmation') throw new Error();
      expect(await f.executor.confirm(alice(), pending.confirmation.token)).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    }
    expect((await list(f)).items).toEqual([]);
  });

  it('claims once before the model, completes one-shot jobs and never retries the same occurrence', async () => {
    const f = await fixture();
    const job = await create(f, alice(), definition({ trigger: { kind: 'once', at: '2026-11-11T00:05:00Z', timeZone: 'UTC' } }));
    f.run.mockImplementation(async (context, input, automation) => {
      expect(context).toMatchObject({ actorId: 3, botId: 12345, source: 'ai', automationId: job.id, aiGrantId: 'private3', aiSettingsRevision: 1 });
      expect(input).toEqual({ text: definition().instruction, attachments: [] });
      expect(automation).toMatchObject({ id: job.id, allowedTools: ['fixture.write'], maxInputTokens: 1000, maxOutputTokens: 200, maxCostMicros: 100 });
      expect(f.store.recordGet(aiScope(context), 'outbox', automation.occurrenceId)?.state).toBe('automation-claimed');
      expect(f.store.recordGet(aiScope(context), 'automation', job.id)?.state).toBe('working');
      return 'completed';
    });
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).toHaveBeenCalledOnce();
    expect((await list(f)).items[0]).toMatchObject({ state: 'completed', completedRuns: 1, nextAt: null });
    await f.restart(); await vi.advanceTimersByTimeAsync(600_000);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it('checks fresh membership for every run even for configured superadmins and preserves failed jobs', async () => {
    const f = await fixture();
    const context = group(1);
    expect(f.core.access.isAdmin(1)).toBe(true);
    const job = await create(f, context);
    expect(f.isMember).toHaveBeenCalledWith(-100, 1, expect.any(AbortSignal));
    f.isMember.mockResolvedValue(false);
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.isMember).toHaveBeenCalledTimes(2);
    expect((await list(f, group(1))).items[0]).toMatchObject({ id: job.id, state: 'paused', completedRuns: 0 });
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-paused' }).items).toHaveLength(1);
  });

  it.each(['revision', 'deny', 'allowlist'] as const)('rechecks current %s authorization before invoking the model', async change => {
    const f = await fixture();
    await create(f, group());
    if (change === 'allowlist') await f.core.access.revoke(-100, 1, f.core.access.snapshot().revision);
    else {
      const snapshot = f.store.getSettings();
      f.store.updateSettings({ ...snapshot.settings, ...(change === 'deny' ? { deniedUserIds: [3] } : { limits: { ...snapshot.settings.limits, dailyCostMicros: 2 } }) }, snapshot.revision);
    }
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.store.recordList(aiScope(group()), 'automation').items[0]?.state).toBe('paused');
  });

  it('permits only the current creator/run/tool subset and revokes pause authority before drain', async () => {
    const f = await fixture();
    const job = await create(f, group());
    const deferred = gate();
    let runContext: InvocationContext | undefined;
    f.run.mockImplementation(async context => { runContext = createInvocation({ ...context, aiRunId: 'root-run' }); return deferred.promise; });
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.automations.authorizeTool(runContext!, 'fixture.write')).toBe(true);
    expect(f.automations.authorizeTool(runContext!, 'fixture.other')).toBe(false);
    expect(f.automations.authorizeTool(createInvocation({ ...runContext!, actorId: 4 }), 'fixture.write')).toBe(false);
    expect(f.automations.authorizeTool(createInvocation({ ...runContext!, chat: { ...runContext!.chat, threadId: 8 } }), 'fixture.write')).toBe(false);
    expect(await f.executor.executeTool(runContext!, 'fixture.write', {})).toMatchObject({ status: 'succeeded' });
    expect(f.native).toHaveBeenCalledOnce();
    const current = (await list(f, group())).items[0]!;
    let finished = false;
    const pausing = f.executor.execute(group(), 'ai.automations.pause', { id: job.id, revision: current.revision }).then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.automations.authorizeTool(runContext!, 'fixture.write')).toBe(false);
    expect(runContext!.signal.aborted).toBe(true);
    expect(f.stopRun).toHaveBeenCalledWith(job.id, aiScope(group()));
    expect(finished).toBe(false);
    deferred.resolve('completed');
    expect(data(await pausing)).toMatchObject({ state: 'paused' });
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-unknown' }).items).toHaveLength(1);
    expect((await list(f, group())).items[0]?.state).toBe('paused');
  });

  it('confirmed updates invalidate old runs before abort and require the current revision', async () => {
    const f = await fixture();
    const job = await create(f);
    const deferred = gate();
    let context: InvocationContext | undefined;
    f.run.mockImplementation(async value => { context = createInvocation({ ...value, aiRunId: 'root-run' }); return deferred.promise; });
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    const current = (await list(f)).items[0]!;
    const update = confirm<AutomationView>(f, alice(), 'ai.automations.update', { id: job.id, revision: current.revision, definition: definition({ title: 'Updated', tools: [] }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.automations.authorizeTool(context!, 'fixture.write')).toBe(false);
    deferred.resolve('unknown');
    const updated = await update;
    expect(updated).toMatchObject({ title: 'Updated', state: 'active', tools: [], completedRuns: 0 });
    expect(updated.revision).toBeGreaterThan(current.revision);
    expect(await f.executor.execute(alice(), 'ai.automations.pause', { id: job.id, revision: current.revision })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  });

  it('skips missed intervals without catch-up bursts and honors completed-run limits', async () => {
    const f = await fixture();
    await create(f, alice(), definition({ maxRuns: 2 }));
    vi.setSystemTime(now + 19 * 60_000);
    f.automations.start(); await vi.advanceTimersByTimeAsync(0);
    expect(f.run).not.toHaveBeenCalled();
    expect((await list(f)).items[0]?.nextAt).toBe('2026-11-11T00:20:00.000Z');
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect((await list(f)).items[0]).toMatchObject({ state: 'completed', completedRuns: 2 });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('freezes unknown outcomes and expired jobs without deleting definitions or claims', async () => {
    const f = await fixture();
    const job = await create(f);
    f.run.mockResolvedValue('unknown');
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect((await list(f)).items[0]).toMatchObject({ id: job.id, state: 'unknown', nextAt: null });
    await f.restart(); await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-unknown' }).items).toHaveLength(1);
  });

  it.each(['active', 'working'] as const)('recovers crash-after-claim from %s as unknown without replay', async state => {
    const f = await fixture();
    const created = await create(f);
    const scope = aiScope(alice());
    const record = f.store.recordGet(scope, 'automation', created.id)!;
    const id = createHash('sha256').update(`${created.id}:${now + 300_000}`).digest('hex');
    f.store.recordCreate(scope, 'outbox', id, { payload: { version: 1, automationId: created.id, generation: 0, dueAt: now + 300_000 }, state: 'automation-claimed' });
    if (state === 'working') f.store.recordPut(scope, 'automation', { id: record.id, expectedRevision: record.revision, payload: { ...record.payload as object, occurrenceId: id }, state });
    await f.restart(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).not.toHaveBeenCalled();
    expect((await list(f)).items[0]).toMatchObject({ state: 'unknown', completedRuns: 0 });
    expect(f.store.recordGet(scope, 'outbox', id)?.state).toBe('automation-unknown');
  });

  it('persists event IDs across restart, deduplicates claims, and coalesces within cooldown', async () => {
    const f = await fixture();
    const value = definition({ trigger: { kind: 'event', event: 'weather.queried', cooldownMinutes: 5, timeZone: 'UTC' } });
    const job = await create(f, group(), value);
    f.automations.start();
    f.automations.emit('weather.queried', 'first', aiScope(group()));
    await f.restart(); await vi.advanceTimersByTimeAsync(0);
    expect(f.run).toHaveBeenCalledOnce();
    const firstId = createHash('sha256').update(`${job.id}:weather.queried:first`).digest('hex');
    expect(f.run.mock.calls[0]![2].occurrenceId).toBe(firstId);
    f.automations.emit('weather.queried', 'first', aiScope(group()));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.run).toHaveBeenCalledOnce();
    f.automations.emit('weather.queried', 'second', aiScope(group()));
    await vi.advanceTimersByTimeAsync(0);
    f.automations.emit('weather.queried', 'latest', aiScope(group()));
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-event' }).items).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(f.run).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledTimes(2);
    expect(f.run.mock.calls[1]![2].occurrenceId).toBe(createHash('sha256').update(`${job.id}:weather.queried:latest`).digest('hex'));
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-event' }).items).toEqual([]);
  });

  it('bounds the persistent event queue at eight scopes and never accepts event payloads or wrong topics', async () => {
    const f = await fixture();
    await create(f, group(), definition({ trigger: { kind: 'event', event: 'rss.delivered', cooldownMinutes: 5, timeZone: 'UTC' } }));
    f.automations.start();
    for (let topic = 10; topic < 18; topic++) f.automations.emit('rss.delivered', `event:${topic}`, aiScope(group(3, topic)));
    expect(() => f.automations.emit('rss.delivered', 'overflow', aiScope(group()))).toThrow('CAPACITY');
    expect(() => f.automations.emit('unknown' as never, 'id', aiScope(group()))).toThrow('INVALID_INPUT');
    expect(() => f.automations.emit('rss.delivered', { text: 'untrusted payload' } as never, aiScope(group()))).toThrow('INVALID_INPUT');
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-event' }).items).toHaveLength(8);
    await vi.advanceTimersByTimeAsync(10);
    expect(f.run).not.toHaveBeenCalled();
    expect(f.store.recordScanScheduled('outbox', { state: 'automation-event' }).items).toEqual([]);
  });

  it('runs only one occurrence at a time and stop revokes before draining actual work', async () => {
    const f = await fixture();
    await create(f); await create(f);
    const deferred = gate();
    f.run.mockImplementationOnce(async () => deferred.promise);
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.run).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = f.automations.stop().then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(stopped).toBe(false);
    expect(f.run.mock.calls[0]![3].aborted).toBe(true);
    expect(f.store.recordList(aiScope(alice()), 'automation').items[0]?.state).toBe('unknown');
    deferred.resolve('unknown'); await stopping;
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.onError).not.toHaveBeenCalled();
  });

  it('treats thrown uncertain run outcomes as unknown, never a retryable failure', async () => {
    const f = await fixture(); await create(f);
    f.run.mockRejectedValue(new AppError('OUTCOME_UNKNOWN'));
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect((await list(f)).items[0]?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(f.run).toHaveBeenCalledOnce();
  });

  it.each(['rss.delivered', 'rate.converted', 'weather.queried'] as const)('runs only the registered scoped %s hook', async event => {
    const f = await fixture();
    await create(f, group(), definition({ trigger: { kind: 'event', event, cooldownMinutes: 5, timeZone: 'Asia/Tokyo' }, maxRuns: 1 }));
    f.automations.start();
    f.automations.emit(event, 'wrong-topic', aiScope(group(3, 8)));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).not.toHaveBeenCalled();
    f.automations.emit(event, 'actual-event', aiScope(group()));
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledOnce();
    expect((await list(f, group())).items[0]).toMatchObject({ state: 'completed', completedRuns: 1, nextAt: null });
  });

  it('completes expired event grants without an event and keeps owner pause/remove available while AI is disabled', async () => {
    const f = await fixture();
    await create(f, alice(), definition({ trigger: { kind: 'event', event: 'rss.delivered', cooldownMinutes: 5, timeZone: 'UTC' }, expiresAt: '2026-11-11T00:01:00Z' }));
    f.automations.start(); await vi.advanceTimersByTimeAsync(60_000);
    expect(f.run).not.toHaveBeenCalled();
    const expired = (await list(f)).items[0]!;
    expect(expired.state).toBe('completed');
    const snapshot = f.store.getSettings(); f.store.updateSettings({ ...snapshot.settings, enabled: false }, snapshot.revision);
    const paused = data(await f.executor.execute<AutomationView>(alice(), 'ai.automations.pause', { id: expired.id, revision: expired.revision }));
    expect(paused.state).toBe('paused');
    expect(await confirm(f, alice(), 'ai.automations.remove', { id: paused.id, revision: paused.revision })).toEqual({ removed: true });
    expect((await list(f)).items).toEqual([]);
  });

  it('denies standing tools immediately after policy changes and after grant expiry', async () => {
    const f = await fixture();
    await create(f, group(), definition({ expiresAt: '2026-11-11T00:06:00Z' }));
    const deferred = gate();
    let context: InvocationContext | undefined;
    f.run.mockImplementation(async value => { context = createInvocation({ ...value, aiRunId: 'root-run' }); return deferred.promise; });
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    expect(f.automations.authorizeTool(context!, 'fixture.write')).toBe(true);
    const snapshot = f.store.getSettings();
    f.store.updateSettings({ ...snapshot.settings, deniedUserIds: [3] }, snapshot.revision);
    expect(f.automations.authorizeTool(context!, 'fixture.write')).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(context!.signal.aborted).toBe(true);
    expect(f.automations.authorizeTool(context!, 'fixture.write')).toBe(false);
    deferred.resolve('unknown'); await vi.advanceTimersByTimeAsync(0);
    expect((await list(f, group())).items[0]?.state).toBe('unknown');
  });

  it('does not release pause until actual work drains even when the root stop hook fails', async () => {
    const f = await fixture(); const created = await create(f);
    const deferred = gate();
    f.run.mockImplementation(async () => deferred.promise);
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    f.stopRun.mockRejectedValueOnce(new Error('mock stop failure'));
    const working = (await list(f)).items[0]!;
    let finished = false;
    const pausing = f.executor.execute(alice(), 'ai.automations.pause', { id: created.id, revision: working.revision }).then(result => { finished = true; return result; });
    await vi.advanceTimersByTimeAsync(0);
    expect(finished).toBe(false);
    expect(f.store.recordGet(aiScope(alice()), 'automation', created.id)?.state).toBe('paused');
    deferred.resolve('unknown');
    expect(await pausing).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(finished).toBe(true);
  });

  it('still aborts and drains shutdown when persisting the frozen state fails', async () => {
    const f = await fixture(); await create(f);
    const deferred = gate();
    let context: InvocationContext | undefined;
    f.run.mockImplementation(async value => { context = createInvocation({ ...value, aiRunId: 'root-run' }); return deferred.promise; });
    f.automations.start(); await vi.advanceTimersByTimeAsync(300_000);
    vi.spyOn(f.store, 'recordPut').mockImplementationOnce(() => { throw new AppError('STORAGE_ERROR'); });
    let finished = false;
    const stopping = f.automations.stop().catch(error => { finished = true; return error; });
    await vi.advanceTimersByTimeAsync(0);
    expect(context!.signal.aborted).toBe(true);
    expect(f.automations.authorizeTool(context!, 'fixture.write')).toBe(false);
    expect(finished).toBe(false);
    deferred.resolve('unknown');
    expect(await stopping).toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(f.store.recordList(aiScope(alice()), 'automation').items[0]?.state).toBe('unknown');
  });
});
