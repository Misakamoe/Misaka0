import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  aiDefaults, aiConversationNewInputSchema, aiProviderSchema, aiSafeStatusSchema, aiScopeSchema,
  aiSettingsSchema, aiSettingsSnapshotSchema, type AiScope,
} from '../shared/schemas/ai.js';
import { AiStore, type AiStoreOptions, type AiUsageAmount } from '../src/ai/store.js';
import { AiCipher, AiVault, parseAiMasterKey } from '../src/ai/vault.js';

const masterKey = Buffer.alloc(32, 0x29);
const alice: AiScope = { botId: 100, chatId: 1, ownerId: 1 };
const bob: AiScope = { botId: 100, chatId: 2, ownerId: 2 };
const group: AiScope = { botId: 100, chatId: -20, threadId: 5 };
const directories: string[] = [];
const stores: AiStore[] = [];
async function directory(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), 'misaka-ai-store-'));
  directories.push(value);
  return value;
}
async function fixture(options: Partial<AiStoreOptions> = {}): Promise<{ store: AiStore; directory: string }> {
  const dir = options.directory ?? await directory();
  const store = await AiStore.open({ directory: dir, masterKey, ...options });
  stores.push(store);
  return { store, directory: dir };
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});

describe('strict AI contracts', () => {
  it('defaults to disabled with no providers/grants and exports Draft 7 schemas', () => {
    expect(aiSettingsSchema.parse(aiDefaults())).toEqual(aiDefaults());
    expect(aiDefaults().enabled).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), masterKey: 'not-a-setting' }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), enabled: 'false' }).success).toBe(false);
    expect(z.toJSONSchema(aiSettingsSchema, { target: 'draft-7' }).additionalProperties).toBe(false);
    expect(z.toJSONSchema(aiSettingsSnapshotSchema, { target: 'draft-7' }).type).toBe('object');
    expect(aiConversationNewInputSchema.safeParse({ title: 'x', ownerId: 2 }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), limits: { ...aiDefaults().limits, maxConcurrentRuns: 2 } }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), limits: { ...aiDefaults().limits, maxQueuedRuns: 9 } }).success).toBe(false);
  });

  it.each(['https://user:secret@example.com', 'http://example.com', 'https://example.com?a=token', 'https://example.com#token', 'not a URL'])('rejects unsafe endpoint %s without throwing', baseUrl => {
    expect(aiProviderSchema.safeParse({ id: 'p', protocol: 'openai-responses', baseUrl, allowedOrigins: ['https://example.com'], credentialRef: 'env:MOCK_KEY', enabled: false }).success).toBe(false);
  });

  it('requires explicit origin match, resolvable presets and unambiguous admission grants', () => {
    const provider = { id: 'p', protocol: 'openai-responses' as const, baseUrl: 'https://example.com/v1', allowedOrigins: ['https://example.com'], credentialRef: 'vault:mock', enabled: true };
    expect(aiProviderSchema.safeParse(provider).success).toBe(true);
    expect(aiProviderSchema.safeParse({ ...provider, allowedOrigins: ['https://other.example'] }).success).toBe(false);
    expect(aiProviderSchema.safeParse({ ...provider, allowedOrigins: ['bad-origin'] }).success).toBe(false);
    const preset = { id: 'chat', providerId: 'p', model: 'fixed-model', tools: ['weather.query'], inputCapabilities: ['text' as const], outputCapabilities: ['text' as const],
      budget: { maxInputTokens: 1000, maxOutputTokens: 100, maxToolCalls: 2, maxDurationMs: 30_000, maxCostMicros: 1000 } };
    const grant = { id: 'alice', kind: 'private' as const, subjectId: 1, presetId: 'chat' };
    const settings = { ...aiDefaults(), providers: [provider], presets: [preset], grants: [grant], deniedUserIds: [2] };
    expect(aiSettingsSchema.safeParse(settings).success).toBe(true);
    expect(aiSettingsSchema.safeParse({ ...settings, providers: [] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...settings, grants: [grant, { ...grant, id: 'duplicate' }] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...settings, grants: [{ ...grant, kind: 'group' }] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...settings, providers: [{ ...provider, apiKey: 'forbidden' }] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...settings, presets: [{ ...preset, imageGeneration: { model: 'image-fixed', outputFormat: 'png' } }] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...settings, presets: [{ ...preset, outputCapabilities: ['text', 'image'], imageGeneration: { model: 'image-fixed', outputFormat: 'png' },
      pricing: { currency: 'CNY', inputMicrosPerMillion: 1000, outputMicrosPerMillion: 2000 } }] }).success).toBe(true);
    expect(aiSettingsSchema.safeParse({ ...settings, presets: [{ ...preset, audioVoice: 'Puck' }] }).success).toBe(false);
  });

  it.each([
    { botId: 100, chatId: 1 }, { botId: 100, chatId: 1, ownerId: 2 },
    { botId: 100, chatId: -20, ownerId: 1 }, { botId: 100, chatId: 0 },
    { botId: 100, chatId: 1, ownerId: 1, threadId: 0 },
  ])('rejects ambiguous trusted scope %j', scope => {
    expect(aiScopeSchema.safeParse(scope).success).toBe(false);
  });
});

describe('encrypted SQLite store', () => {
  it('preserves unrelated files, persists settings and keeps management status content-free', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'unrelated.json'), '{"preserve":true}');
    const { store } = await fixture({ directory: dir });
    const initial = store.getSettings();
    expect(initial).toEqual({ revision: 0, settings: aiDefaults() });
    const settings = { ...initial.settings, deniedUserIds: [123] };
    expect(store.updateSettings(settings, 0).revision).toBe(1);
    expect(store.updateSettings(settings, 1).revision).toBe(1);
    expect(() => store.updateSettings(initial.settings, 0)).toThrow('CONFLICT');
    const conversation = store.conversationNew(alice, { title: 'PRIVATE_TITLE_SENTINEL' });
    store.turnAppend(alice, conversation.id, [{ actorId: 1, role: 'user', content: 'PRIVATE_TURN_SENTINEL' }]);
    store.memoryPut(alice, { text: 'PRIVATE_MEMORY_SENTINEL' });
    const snapshot = store.safeStatus();
    expect(snapshot).toMatchObject({ available: true, schemaVersion: 1, conversations: 1, turns: 1, memories: 1 });
    expect(aiSafeStatusSchema.parse(snapshot)).toEqual(snapshot);
    expect(JSON.stringify(snapshot)).not.toMatch(/PRIVATE_|ownerId|content|title/);
    expect(JSON.stringify(store)).toBe('{}');
    store.close();
    const bytes = await readFile(join(dir, 'ai.sqlite'));
    expect(bytes.includes(Buffer.from('PRIVATE_'))).toBe(false);
    expect((await stat(join(dir, 'ai.sqlite'))).mode & 0o777).toBe(0o600);
    const reopened = await fixture({ directory: dir });
    expect(reopened.store.getSettings()).toEqual({ revision: 1, settings });
    expect(reopened.store.conversationGet(alice, conversation.id)?.title).toBe('PRIVATE_TITLE_SENTINEL');
    expect(await readFile(join(dir, 'unrelated.json'), 'utf8')).toBe('{"preserve":true}');
  });

  it('enforces owner, bot, group and topic boundaries in reads and all destructive controls', async () => {
    const { store } = await fixture();
    const conversation = store.conversationNew(alice, { title: 'owned' });
    const turn = store.turnAppend(alice, conversation.id, [{ actorId: 1, role: 'user', content: 'private' }])[0]!;
    for (const scope of [bob, group, { ...alice, botId: 101 }, { ...alice, threadId: 3 }]) {
      expect(store.conversationGet(scope, conversation.id)).toBeUndefined();
      expect(store.conversationList(scope).items).toEqual([]);
      expect(() => store.conversationHistory(scope, conversation.id)).toThrow('NOT_FOUND');
      expect(() => store.conversationExport(scope, conversation.id)).toThrow('NOT_FOUND');
      expect(() => store.conversationRename(scope, conversation.id, 'stolen', 0)).toThrow('NOT_FOUND');
      expect(() => store.conversationClear(scope, conversation.id, 0)).toThrow('NOT_FOUND');
      expect(() => store.conversationDelete(scope, conversation.id, 0)).toThrow('NOT_FOUND');
      expect(() => store.turnAppend(scope, conversation.id, [{ actorId: scope.ownerId ?? 2, role: 'user', content: 'injected' }])).toThrow('NOT_FOUND');
    }
    expect(store.conversationHistory(alice, conversation.id).items).toEqual([turn]);
    expect(() => store.turnAppend(alice, conversation.id, [{ actorId: 2, role: 'user', content: 'forged' }])).toThrow('FORBIDDEN');
    const shared = store.conversationNew(group);
    store.turnAppend(group, shared.id, [{ actorId: 1, role: 'user', content: 'first' }, { actorId: 2, role: 'user', content: 'second' }]);
    expect(store.conversationHistory(group, shared.id).items.map(item => item.actorId)).toEqual([1, 2]);
    expect(store.conversationGet({ ...group, threadId: 6 }, shared.id)).toBeUndefined();
  });

  it('pages on disk with stable cursors, exports bounded pages and does not delete old history', async () => {
    const { store } = await fixture();
    const c = store.conversationNew(alice);
    for (let i = 0; i < 7; i++) store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: `turn-${i}` }]);
    const page = store.conversationHistory(alice, c.id, { limit: 3 });
    expect(page.items.map(item => item.content)).toEqual(['turn-0', 'turn-1', 'turn-2']);
    const second = store.conversationExport(alice, c.id, { after: page.nextCursor!, limit: 3 });
    expect(second.items.map(item => item.content)).toEqual(['turn-3', 'turn-4', 'turn-5']);
    const last = store.conversationHistory(alice, c.id, { after: second.nextCursor!, limit: 3 });
    expect(last.items.map(item => item.content)).toEqual(['turn-6']);
    expect(last.nextCursor).toBeNull();
    expect(() => store.conversationHistory(alice, c.id, { limit: 51 })).toThrow('INVALID_INPUT');
    expect(() => store.conversationList(alice, { after: -1 })).toThrow('INVALID_INPUT');
    expect(store.safeStatus().turns).toBe(7);
    expect(store.conversationRecent(alice, c.id, 2).map(item => item.content)).toEqual(['turn-5', 'turn-6']);
    expect(() => store.conversationRecent(bob, c.id, 2)).toThrow('NOT_FOUND');
    expect(() => store.conversationRecent(alice, c.id, 51)).toThrow('INVALID_INPUT');
  });

  it('revision checks rename/clear/delete and clears summaries without deleting explicit memory', async () => {
    const { store } = await fixture();
    const c = store.conversationNew(alice);
    const renamed = store.conversationRename(alice, c.id, 'renamed', c.revision);
    expect(() => store.conversationClear(alice, c.id, c.revision)).toThrow('CONFLICT');
    store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: 'clear this' }]);
    store.recordPut(alice, 'summary', { conversationId: c.id, payload: { text: 'clear summary' } });
    store.memoryPut(alice, { text: 'keep memory' });
    const cleared = store.conversationClear(alice, c.id, renamed.revision);
    expect(cleared.title).toBe('renamed');
    expect(store.conversationHistory(alice, c.id).items).toEqual([]);
    expect(store.recordList(alice, 'summary').items).toEqual([]);
    expect(store.memoryList(alice).items).toHaveLength(1);
    expect(() => store.conversationDelete(alice, c.id, renamed.revision)).toThrow('CONFLICT');
    expect(store.conversationDelete(alice, c.id, cleared.revision)).toBe(true);
    expect(store.conversationGet(alice, c.id)).toBeUndefined();
  });

  it('rolls back oversized batches and rejects capacity without evicting histories', async () => {
    const { store } = await fixture();
    const settings = aiDefaults();
    settings.limits.maxConversationsPerScope = 1;
    settings.limits.maxTurnsPerConversation = 2;
    store.updateSettings(settings, 0);
    const c = store.conversationNew(alice);
    expect(() => store.conversationNew(alice)).toThrow('CAPACITY');
    store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: 'preserve' }]);
    expect(() => store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: 'a' }, { actorId: 1, role: 'user', content: 'b' }])).toThrow('CAPACITY');
    expect(store.conversationHistory(alice, c.id).items.map(item => item.content)).toEqual(['preserve']);
    expect(() => store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: 'a'.repeat(32_769) }])).toThrow('INVALID_INPUT');
  });

  it('rolls back the entire checkpoint if a later turn fails inside the transaction', async () => {
    let writes = 0;
    let failAt = Infinity;
    const { store } = await fixture({ now: () => { if (++writes === failAt) throw new Error('mock clock failure'); return 1_794_000_000_000; } });
    const c = store.conversationNew(alice);
    failAt = writes + 2;
    expect(() => store.turnAppend(alice, c.id, [
      { actorId: 1, role: 'user', content: 'must also roll back' },
      { actorId: 1, role: 'assistant', content: 'fails before commit' },
    ])).toThrow('STORAGE_ERROR');
    expect(store.conversationHistory(alice, c.id).items).toEqual([]);
    failAt = Infinity;
    store.turnAppend(alice, c.id, [{ actorId: 1, role: 'user', content: 'later valid write' }]);
    expect(store.conversationHistory(alice, c.id).items).toHaveLength(1);
  });

  it('fails at the SQLite disk quota without evicting rows, then permits explicit deletion', async () => {
    const { store, directory } = await fixture({ maxStorageBytes: 1_048_576 });
    const records = [];
    let full = false;
    for (let i = 0; i < 30; i++) {
      try { records.push(store.recordPut(alice, 'outbox', { payload: 'x'.repeat(60_000) })); }
      catch (error) { expect(error).toMatchObject({ code: 'CAPACITY' }); full = true; break; }
    }
    expect(full).toBe(true);
    expect(records.length).toBeGreaterThan(0);
    expect(store.safeStatus().records).toBe(records.length);
    expect(store.safeStatus().storageBytes).toBeLessThanOrEqual(1_048_576);
    const first = records[0]!;
    expect(store.recordGet(alice, 'outbox', first.id)).toEqual(first);
    store.recordDelete(alice, 'outbox', first.id);
    store.recordPut(alice, 'outbox', { payload: 'replacement' });
    store.close();
    const { store: reopened } = await fixture({ directory, maxStorageBytes: 1_048_576 });
    expect(reopened.safeStatus().records).toBe(records.length);
  });

  it('keeps explicit memory personal across private topics, revisioned and out of groups', async () => {
    const { store } = await fixture();
    const memory = store.memoryPut({ ...alice, threadId: 10 }, { text: 'explicitly remember' });
    expect(store.memoryGet(alice, memory.id)).toEqual(memory);
    expect(store.memoryList(bob).items).toEqual([]);
    expect(store.memoryGet(bob, memory.id)).toBeUndefined();
    expect(store.memoryDelete(bob, memory.id)).toBe(false);
    expect(() => store.memoryList(group)).toThrow('FORBIDDEN');
    expect(() => store.memoryPut(group, { text: 'not personal' })).toThrow('FORBIDDEN');
    expect(() => store.memoryPut(alice, { id: memory.id, text: 'changed' })).toThrow('CONFLICT');
    const updated = store.memoryPut(alice, { id: memory.id, text: 'corrected', expectedRevision: memory.revision });
    expect(updated.revision).toBe(1);
    expect(() => store.memoryDelete(alice, memory.id, 0)).toThrow('CONFLICT');
    expect(store.memoryDelete(alice, memory.id, 1)).toBe(true);
  });

  it('persists small scoped continuations and freezes unknown runs against retry', async () => {
    const { store, directory } = await fixture();
    const c = store.conversationNew(group);
    const run = store.runCreate(group, { conversationId: c.id, actorId: 2, presetId: 'fixed', settingsRevision: 0, continuation: { cursor: 'SECRET_CONTINUATION' } });
    expect(store.runGet({ ...group, threadId: 6 }, run.id)).toBeUndefined();
    expect(store.runListPending(alice).items).toEqual([]);
    expect(() => store.conversationClear(group, c.id, 0)).toThrow('CONFLICT');
    const running = store.runUpdate(group, run.id, { revision: 0, state: 'running', continuation: { cursor: 'SECRET_CONTINUATION' } });
    expect(() => store.runUpdate(group, run.id, { revision: 0, state: 'completed', continuation: null })).toThrow('CONFLICT');
    const uncertain = store.runUpdate(group, run.id, { revision: running.revision, state: 'unknown', continuation: { outcome: 'unknown' } });
    expect(() => store.runUpdate(group, run.id, { revision: uncertain.revision, state: 'running', continuation: null })).toThrow('CONFLICT');
    expect(() => store.runCreate(group, { conversationId: c.id, actorId: 2, presetId: 'fixed', settingsRevision: 0, continuation: 'x'.repeat(65_537) })).toThrow('CAPACITY');
    store.close();
    const { store: reopened } = await fixture({ directory });
    expect(reopened.runListPending(group).items).toEqual([uncertain]);
    reopened.runUpdate(group, run.id, { revision: uncertain.revision, state: 'cancelled', continuation: null });
    expect(reopened.runListPending(group).items).toEqual([]);
    expect(reopened.conversationDelete(group, c.id, 0)).toBe(true);
    expect(reopened.runGet(group, run.id)).toBeUndefined();
  });

  it('stores scoped generic extension records with due paging and rejects invalid JSON/binaries', async () => {
    const { store } = await fixture();
    const a = store.recordPut(alice, 'automation', { payload: { instructions: 'private schedule' }, state: 'active', dueAt: '2026-11-11T00:00:00.000Z' });
    store.recordPut(alice, 'automation', { payload: { instructions: 'later' }, state: 'active', dueAt: '2026-11-12T00:00:00.000Z' });
    expect(store.recordList(alice, 'automation', { state: 'active', dueBefore: '2026-11-11T12:00:00.000Z' }).items).toEqual([a]);
    expect(store.recordGet(bob, 'automation', a.id)).toBeUndefined();
    expect(store.recordDelete(bob, 'automation', a.id)).toBe(false);
    expect(() => store.recordPut(bob, 'automation', { id: a.id, expectedRevision: 0, payload: null })).toThrow('NOT_FOUND');
    const changed = store.recordPut(alice, 'automation', { id: a.id, expectedRevision: 0, payload: { instructions: 'corrected' }, state: 'paused' });
    expect(changed.revision).toBe(1);
    expect(() => store.recordDelete(alice, 'automation', a.id, 0)).toThrow('CONFLICT');
    expect(store.recordDelete(alice, 'automation', a.id, 1)).toBe(true);
    for (const payload of [Buffer.from('binary'), new Date(), { x: undefined }, { x: Infinity }]) {
      expect(() => store.recordPut(alice, 'artifact', { payload: payload as never })).toThrow('INVALID_INPUT');
    }
    const cycle: Record<string, unknown> = {}; cycle.self = cycle;
    expect(() => store.recordPut(alice, 'artifact', { payload: cycle as never })).toThrow('INVALID_INPUT');
    expect(() => store.recordPut(alice, 'outbox', { payload: 'x'.repeat(65_537) })).toThrow('CAPACITY');
    expect(() => store.recordPut(alice, 'outbox', { payload: Array.from({ length: 20 }, () => 'x'.repeat(60_000)) })).toThrow('CAPACITY');
    expect(() => store.recordPut(alice, 'artifact', { payload: { data: 'base64-is-not-metadata' } })).toThrow('INVALID_INPUT');
    const artifact = store.recordPut(alice, 'artifact', { payload: { filename: 'private.txt', mimeType: 'text/plain', bytes: 20, sha256: '0'.repeat(64), storageRef: 'opaque-file-1' } });
    expect(store.recordGet(alice, 'artifact', artifact.id)).toEqual(artifact);
    expect(store.recordGet(group, 'artifact', artifact.id)).toBeUndefined();
  });

  it('reserves atomically and idempotently; uncertain billing remains reserved after restart', async () => {
    const { store, directory } = await fixture();
    const amount: AiUsageAmount = { inputTokens: 20, outputTokens: 10, costMicros: 60 };
    const request = { id: 'reservation-1', actorId: 1, period: '2026-11-11', amount, limitCostMicros: 100 };
    const reserved = store.usageReserve(alice, request);
    expect(store.usageReserve(alice, request)).toEqual(reserved);
    expect(() => store.usageReserve(alice, { ...request, amount: { ...amount, costMicros: 1 } })).toThrow('CONFLICT');
    expect(() => store.usageReserve(alice, { ...request, id: 'reservation-2' })).toThrow('CAPACITY');
    expect(() => store.usageSettle(bob, reserved.id, null)).toThrow('NOT_FOUND');
    const unknown = store.usageSettle(alice, reserved.id, null);
    expect(unknown.state).toBe('unknown');
    expect(store.safeStatus().reservedCostMicros).toBe(60);
    store.close();
    const { store: reopened } = await fixture({ directory });
    expect(() => reopened.usageReserve(alice, { ...request, id: 'reservation-2' })).toThrow('CAPACITY');
    reopened.usageSettle(alice, reserved.id, { ...amount, costMicros: 20 });
    reopened.usageReserve(alice, { ...request, id: 'reservation-2' });
    expect(reopened.safeStatus()).toMatchObject({ reservedCostMicros: 60, settledCostMicros: 20 });
    expect(() => reopened.usageSettle(alice, reserved.id, null)).toThrow('CONFLICT');
    expect(reopened.usageSettle(alice, reserved.id, { ...amount, costMicros: 20 }).state).toBe('settled');
  });

  it('does not multiply the instance daily budget across users or topics', async () => {
    const { store } = await fixture();
    const settings = aiDefaults(); settings.limits.dailyCostMicros = 100;
    store.updateSettings(settings, 0);
    const amount = { inputTokens: 1, outputTokens: 1, costMicros: 60 };
    const first = store.usageReserve(alice, { id: 'a', actorId: 1, period: '2026-11-11', amount, limitCostMicros: 100 });
    store.usageSettle(alice, first.id, null);
    for (const scope of [bob, group, { ...group, threadId: 6 }]) {
      expect(() => store.usageReserve(scope, { id: 'b', actorId: 2, period: '2026-11-11', amount, limitCostMicros: 100 })).toThrow('CAPACITY');
    }
    store.usageSettle(alice, first.id, { ...amount, costMicros: 20 });
    expect(store.usageReserve(bob, { id: 'b', actorId: 2, period: '2026-11-11', amount, limitCostMicros: 100 }).state).toBe('reserved');
    expect(store.safeStatus()).toMatchObject({ reservedCostMicros: 60, settledCostMicros: 20 });
  });

  it('recovers bounded pending runs with authoritative stored audience and intact native continuation', async () => {
    const { store, directory } = await fixture();
    const a = store.conversationNew({ ...alice, threadId: 3 });
    const g = store.conversationNew(group);
    const aRun = store.runCreate({ ...alice, threadId: 3 }, { conversationId: a.id, actorId: 1, presetId: 'chat', settingsRevision: 0, continuation: { signature: 'x'.repeat(48_000) } });
    const gRun = store.runCreate(group, { conversationId: g.id, actorId: 2, presetId: 'chat', settingsRevision: 0 });
    store.close();
    const { store: reopened } = await fixture({ directory });
    const first = reopened.runScanPending({ limit: 1 });
    expect(first.items).toEqual([{ scope: { ...alice, threadId: 3 }, run: aRun }]);
    expect(reopened.runScanPending({ after: first.nextCursor!, limit: 1 })).toEqual({ items: [{ scope: group, run: gRun }], nextCursor: null });
    expect(reopened.runListPending(bob).items).toEqual([]);
    expect(JSON.stringify(reopened.safeStatus())).not.toContain('signature');
  });

  it('claims deterministic scoped records once and pages only scheduler-owned kinds', async () => {
    const { store } = await fixture();
    const dueAt = '2026-11-11T00:00:00.000Z';
    const later = '2026-11-12T00:00:00.000Z';
    const first = store.recordCreate(alice, 'outbox', 'occurrence-1', { payload: { instructions: 'private work' }, state: 'pending', dueAt });
    expect(() => store.recordCreate(alice, 'outbox', 'occurrence-1', { payload: null, state: 'pending', dueAt })).toThrow('CONFLICT');
    const other = store.recordCreate(group, 'outbox', 'occurrence-1', { payload: { instructions: 'shared work' }, state: 'pending', dueAt: later });
    expect(store.recordNearestDue('outbox', 'pending')).toBe(dueAt);
    expect(store.recordScanScheduled('outbox', { dueBefore: dueAt, state: 'pending' }).items).toEqual([{ scope: alice, record: first }]);
    const page = store.recordScanScheduled('outbox', { limit: 1 });
    expect(page.items).toEqual([{ scope: alice, record: first }]);
    expect(store.recordScanScheduled('outbox', { after: page.nextCursor!, limit: 1 })).toEqual({ items: [{ scope: group, record: other }], nextCursor: null });
    expect(() => store.recordScanScheduled('memory' as never)).toThrow('INVALID_INPUT');
    expect(store.recordNearestDue('automation', 'pending')).toBeNull();
    expect(store.recordGet(bob, 'outbox', first.id)).toBeUndefined();
  });

  it('admits only one connection and closes idempotently without retaining readable key material', async () => {
    const { store, directory } = await fixture();
    await expect(AiStore.open({ directory, masterKey })).rejects.toThrow('STORAGE_ERROR');
    expect(store.getSettings().revision).toBe(0);
    store.close(); store.close();
    expect(() => store.safeStatus()).toThrow('CANCELLED');
    await fixture({ directory });
  });

  it('fails without keys before creating a database and never overwrites existing data on a wrong key', async () => {
    const dir = await directory();
    await expect(AiStore.open({ directory: dir, masterKey: undefined as never })).rejects.toThrow('STORAGE_ERROR');
    expect(await readdir(dir)).toEqual([]);
    const { store } = await fixture({ directory: dir });
    store.conversationNew(alice, { title: 'preserve with original key' });
    store.close();
    const before = await readFile(join(dir, 'ai.sqlite'));
    await expect(AiStore.open({ directory: dir, masterKey: Buffer.alloc(32, 9) })).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(dir, 'ai.sqlite'))).toEqual(before);
    const reopened = await fixture({ directory: dir });
    expect(reopened.store.conversationList(alice).items[0]?.title).toBe('preserve with original key');
  });

  it.each(['schema', 'ciphertext', 'scope', 'purpose', 'amount'])('fails on %s corruption without reset or plaintext fallback', async corruption => {
    const { store, directory } = await fixture();
    store.conversationNew(alice, { title: 'must survive corruption diagnosis' });
    store.close();
    const db = new DatabaseSync(join(directory, 'ai.sqlite'));
    if (corruption === 'schema') db.exec('PRAGMA user_version=99');
    if (corruption === 'ciphertext') db.exec("UPDATE entries SET ciphertext='plain secret' WHERE kind='conversation'");
    if (corruption === 'scope') db.prepare('UPDATE entries SET scope=?').run(JSON.stringify([100, 2, 0, 2]));
    if (corruption === 'purpose') db.exec("UPDATE entries SET kind='memory'");
    if (corruption === 'amount') db.exec('UPDATE entries SET amount=1');
    db.close();
    const before = await readFile(join(directory, 'ai.sqlite'));
    await expect(AiStore.open({ directory, masterKey })).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(directory, 'ai.sqlite'))).toEqual(before);
  });

  it('refuses non-databases and symlink destinations without changing their bytes', async () => {
    const dir = await directory();
    await writeFile(join(dir, 'ai.sqlite'), 'not-a-database');
    await expect(AiStore.open({ directory: dir, masterKey })).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(dir, 'ai.sqlite'), 'utf8')).toBe('not-a-database');
    const other = await directory();
    await symlink(join(dir, 'ai.sqlite'), join(other, 'ai.sqlite'));
    await expect(AiStore.open({ directory: other, masterKey })).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(dir, 'ai.sqlite'), 'utf8')).toBe('not-a-database');
  });
});

describe('authenticated write-only vault', () => {
  it('uses versioned random authenticated encryption bound to owner and purpose', () => {
    const cipher = new AiCipher(masterKey);
    const encrypted = cipher.seal('mock-secret', 'owner:1', 'provider:test');
    expect(encrypted).toMatch(/^v1\./);
    expect(cipher.seal('mock-secret', 'owner:1', 'provider:test')).not.toBe(encrypted);
    expect(cipher.open(encrypted, 'owner:1', 'provider:test')).toBe('mock-secret');
    expect(() => cipher.open(encrypted, 'owner:2', 'provider:test')).toThrow('STORAGE_ERROR');
    expect(() => cipher.open(encrypted, 'owner:1', 'memory')).toThrow('STORAGE_ERROR');
    expect(() => cipher.open(encrypted.replace('v1.', 'v2.'), 'owner:1', 'provider:test')).toThrow('STORAGE_ERROR');
    expect(() => cipher.open('mock-secret', 'owner:1', 'provider:test')).toThrow('STORAGE_ERROR');
    expect(parseAiMasterKey(masterKey.toString('hex'))).toEqual(masterKey);
    expect(parseAiMasterKey(masterKey.toString('hex').toUpperCase())).toEqual(masterKey);
    expect(() => parseAiMasterKey(masterKey.toString('base64'))).toThrow('STORAGE_ERROR');
    expect(() => parseAiMasterKey('invalid')).toThrow('STORAGE_ERROR');
    cipher.close();
    expect(() => cipher.open(encrypted, 'owner:1', 'provider:test')).toThrow('STORAGE_ERROR');
    expect(masterKey.every(byte => byte === 0x29)).toBe(true);
  });

  it('resolves only explicit environment mappings and encrypts owner-bound replacement/delete', async () => {
    const { store, directory } = await fixture();
    const vault = new AiVault(store, { MOCK_KEY: () => 'environment-mock-value' });
    expect(vault.state('bot:100', 'env:MOCK_KEY')).toEqual({ ref: 'env:MOCK_KEY', source: 'environment', hasValue: true });
    expect(vault.resolve('bot:100', 'env:MOCK_KEY')).toBe('environment-mock-value');
    expect(() => vault.resolve('bot:100', 'env:PATH')).toThrow('UNAVAILABLE');
    expect(() => vault.replace('bot:100', 'env:MOCK_KEY', 'no')).toThrow('INVALID_INPUT');
    expect(() => vault.delete('bot:100', 'env:MOCK_KEY')).toThrow('INVALID_INPUT');
    expect(() => vault.replace('bot:100', 'vault:test', '****')).toThrow('INVALID_INPUT');
    const result = vault.replace('bot:100', 'vault:test', 'PRIVATE_CREDENTIAL_SENTINEL');
    expect(result).toEqual({ ref: 'vault:test', source: 'vault', hasValue: true });
    expect(JSON.stringify(vault)).toBe('{}');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_');
    expect(vault.state('bot:101', 'vault:test').hasValue).toBe(false);
    vault.replace('bot:101', 'vault:test', 'independent-credential');
    expect(vault.resolve('bot:100', 'vault:test')).toBe('PRIVATE_CREDENTIAL_SENTINEL');
    expect(vault.resolve('bot:101', 'vault:test')).toBe('independent-credential');
    store.close();
    expect((await readFile(join(directory, 'ai.sqlite'))).includes(Buffer.from('PRIVATE_CREDENTIAL_SENTINEL'))).toBe(false);
    const reopened = await fixture({ directory });
    const reloaded = new AiVault(reopened.store);
    expect(reloaded.resolve('bot:100', 'vault:test')).toBe('PRIVATE_CREDENTIAL_SENTINEL');
    expect(reloaded.delete('bot:100', 'vault:test').hasValue).toBe(false);
    expect(() => reloaded.resolve('bot:100', 'vault:test')).toThrow('UNAVAILABLE');
    expect(reloaded.resolve('bot:101', 'vault:test')).toBe('independent-credential');
  });
});
