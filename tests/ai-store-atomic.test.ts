import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { aiCapturedArtifactSchema, aiDefaults, type AiCapturedArtifact, type AiCredentialChange, type AiScope } from '../shared/schemas/ai.js';
import { AiStore } from '../src/ai/store.js';
import { AiVault } from '../src/ai/vault.js';

const masterKey = Buffer.alloc(32, 0x37);
const alice: AiScope = { botId: 10, chatId: 1, ownerId: 1 };
const bob: AiScope = { botId: 10, chatId: 2, ownerId: 2 };
const group: AiScope = { botId: 10, chatId: -20, threadId: 5 };
const directories: string[] = [];
const stores: AiStore[] = [];
async function fixture(directory?: string): Promise<{ store: AiStore; directory: string }> {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), 'misaka-ai-store-atomic-'));
    directories.push(directory);
  }
  const store = await AiStore.open({ directory, masterKey });
  stores.push(store);
  return { store, directory };
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});

describe('atomic credential changes', () => {
  it('commits encrypted replacement/delete and policy revision together without returning secrets', async () => {
    const { store, directory } = await fixture();
    const vault = new AiVault(store);
    const replaced = store.changeCredential('instance', { operation: 'replace', ref: 'vault:mock', value: 'MOCK_ROTATION_PRIVATE_VALUE' }, 0);
    expect(replaced).toEqual({ revision: 1, settings: aiDefaults() });
    expect(vault.state('instance', 'vault:mock')).toEqual({ ref: 'vault:mock', source: 'vault', hasValue: true });
    expect(vault.resolve('instance', 'vault:mock')).toBe('MOCK_ROTATION_PRIVATE_VALUE');
    expect(JSON.stringify(replaced)).not.toContain('MOCK_ROTATION_PRIVATE_VALUE');
    expect(() => store.updateSettings({ ...aiDefaults(), enabled: true }, 0)).toThrow('CONFLICT');
    store.close();
    expect((await readFile(join(directory, 'ai.sqlite'))).includes(Buffer.from('MOCK_ROTATION_PRIVATE_VALUE'))).toBe(false);
    const { store: reopened } = await fixture(directory);
    expect(reopened.getSettings().revision).toBe(1);
    const deleted = reopened.changeCredential('instance', { operation: 'delete', ref: 'vault:mock' }, 1);
    expect(deleted).toEqual({ revision: 2, settings: aiDefaults() });
    expect(reopened.credentialGet('instance', 'vault:mock')).toBeUndefined();
    reopened.close();
    const final = await fixture(directory);
    expect(final.store.getSettings().revision).toBe(2);
    expect(final.store.credentialGet('instance', 'vault:mock')).toBeUndefined();
  });

  it('rejects stale simultaneous writes before changing any credential', async () => {
    const { store } = await fixture();
    const outcomes = await Promise.allSettled(['first', 'second'].map(value => Promise.resolve().then(() =>
      store.changeCredential('instance', { operation: 'replace', ref: 'vault:mock', value }, 0))));
    expect(outcomes[0]).toMatchObject({ status: 'fulfilled', value: { revision: 1 } });
    expect(outcomes[1]).toMatchObject({ status: 'rejected', reason: { code: 'CONFLICT' } });
    expect(store.credentialGet('instance', 'vault:mock')).toBe('first');
    store.updateSettings({ ...aiDefaults(), deniedUserIds: [2] }, 1);
    expect(() => store.changeCredential('instance', { operation: 'delete', ref: 'vault:mock' }, 1)).toThrow('CONFLICT');
    expect(() => store.changeCredential('other-owner', { operation: 'replace', ref: 'vault:mock', value: 'different' }, 1)).toThrow('CONFLICT');
    expect(store.credentialGet('instance', 'vault:mock')).toBe('first');
    expect(store.credentialGet('other-owner', 'vault:mock')).toBeUndefined();
    expect(store.getSettings()).toEqual({ revision: 2, settings: { ...aiDefaults(), deniedUserIds: [2] } });
  });

  it('invalidates authority for identical replacement and absent deletion without exposing equality', async () => {
    const { store } = await fixture();
    const change = { operation: 'replace' as const, ref: 'vault:mock', value: 'same-mock-value' };
    expect(store.changeCredential('instance', change, 0).revision).toBe(1);
    expect(store.changeCredential('instance', change, 1).revision).toBe(2);
    expect(() => store.changeCredential('instance', change, 1)).toThrow('CONFLICT');
    expect(store.changeCredential('instance', { operation: 'delete', ref: 'vault:absent' }, 2).revision).toBe(3);
    expect(store.changeCredential('other-owner', { operation: 'delete', ref: 'vault:mock' }, 3).revision).toBe(4);
    expect(store.credentialGet('instance', 'vault:mock')).toBe('same-mock-value');
    expect(store.changeCredential('instance', { operation: 'delete', ref: 'vault:mock' }, 4).revision).toBe(5);
    expect(store.changeCredential('instance', { operation: 'delete', ref: 'vault:mock' }, 5).revision).toBe(6);
    expect(store.getSettings().settings).toEqual(aiDefaults());
  });

  it.each(['create', 'replace', 'delete'] as const)('rolls back %s when the policy revision write fails', async operation => {
    const { store, directory } = await fixture();
    if (operation !== 'create') store.changeCredential('instance', { operation: 'replace', ref: 'vault:mock', value: 'preserved-mock-value' }, 0);
    const before = store.getSettings();
    store.close();
    const db = new DatabaseSync(join(directory, 'ai.sqlite'));
    db.exec("CREATE TRIGGER reject_revision BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'mock revision write failure'); END");
    db.close();
    const { store: failing } = await fixture(directory);
    const change: AiCredentialChange = operation === 'delete' ? { operation, ref: 'vault:mock' }
      : { operation: 'replace', ref: 'vault:mock', value: 'must-not-persist' };
    expect(() => failing.changeCredential('instance', change, before.revision)).toThrow('STORAGE_ERROR');
    expect(failing.getSettings()).toEqual(before);
    expect(failing.credentialGet('instance', 'vault:mock')).toBe(operation === 'create' ? undefined : 'preserved-mock-value');
    failing.close();
    const final = await fixture(directory);
    expect(final.store.getSettings()).toEqual(before);
    expect(final.store.credentialGet('instance', 'vault:mock')).toBe(operation === 'create' ? undefined : 'preserved-mock-value');
  });

  it('rejects environment refs and invalid/masked values with no revision or data changes', async () => {
    const { store } = await fixture();
    const vault = new AiVault(store, { MOCK_KEY: 'fixed-environment-value' });
    const invalid: unknown[] = [
      { operation: 'replace', ref: 'env:MOCK_KEY', value: 'new-value' }, { operation: 'delete', ref: 'env:MOCK_KEY' },
      { operation: 'replace', ref: 'vault:mock', value: '' }, { operation: 'replace', ref: 'vault:mock', value: '***' },
      { operation: 'replace', ref: 'vault:mock', value: '\u2022\u2022' }, { operation: 'replace', ref: 'vault:mock', value: 'line\nbreak' },
      { operation: 'replace', ref: 'vault:mock', value: '\u{1f600}'.repeat(8193) },
      { operation: 'replace', ref: 'vault:mock', value: 'new-value', actorId: 1 }, { operation: 'delete', ref: 'vault:mock', value: 'unexpected' },
    ];
    for (const change of invalid) expect(() => store.changeCredential('instance', change as AiCredentialChange, 0)).toThrow('INVALID_INPUT');
    for (const value of ['', '***', '\u2022\u2022', 'line\nbreak', '\u{1f600}'.repeat(8193)]) {
      expect(() => vault.replace('instance', 'vault:mock', value)).toThrow('INVALID_INPUT');
    }
    expect(vault.resolve('instance', 'env:MOCK_KEY')).toBe('fixed-environment-value');
    expect(store.getSettings()).toEqual({ revision: 0, settings: aiDefaults() });
    expect(store.credentialGet('instance', 'vault:mock')).toBeUndefined();
  });
});

function captured(actorId = 1): AiCapturedArtifact {
  return { transport: 'telegram', actorId, expires: 1_794_335_000_000,
    file: { fileId: 'PRIVATE_CAPTURE_FILE_ID', uniqueId: 'PRIVATE_CAPTURE_UNIQUE_ID', kind: 'document', mimeType: 'text/plain', name: 'private.txt', size: 128 } };
}

describe('encrypted pre-download artifacts', () => {
  it('accepts strictly bounded capture metadata without fabricating download hashes', () => {
    const input = captured();
    expect(aiCapturedArtifactSchema.parse(input)).toEqual(input);
    const maximum = { ...input, file: { ...input.file, fileId: 'x'.repeat(512), uniqueId: 'x'.repeat(256), name: 'x'.repeat(128), size: 1_048_576 } };
    expect(aiCapturedArtifactSchema.safeParse(maximum).success).toBe(true);
    for (const field of ['fileId', 'uniqueId', 'name'] as const) {
      expect(aiCapturedArtifactSchema.safeParse({ ...maximum, file: { ...maximum.file, [field]: maximum.file[field] + 'x' } }).success).toBe(false);
    }
    for (const size of [0, -1, 1.5, 1_048_577, '128']) expect(aiCapturedArtifactSchema.safeParse({ ...input, file: { ...input.file, size } }).success).toBe(false);
    for (const invalid of [{ ...input, transport: 'http' }, { ...input, actorId: 0 }, { ...input, expires: -1 },
      { ...input, sha256: '0'.repeat(64) }, { ...input, file: { ...input.file, url: 'https://example.invalid/token' } },
      { ...input, file: { ...input.file, name: '\u{1f600}'.repeat(65) } }, { ...input, file: { ...input.file, kind: 'video' } },
      { ...input, file: { ...input.file, bytes: Buffer.from('binary') } }]) expect(aiCapturedArtifactSchema.safeParse(invalid).success).toBe(false);
  });

  it('encrypts captures, isolates owners/topics, and supports revisioned finalization', async () => {
    const { store, directory } = await fixture();
    const record = store.recordPut(alice, 'artifact', { payload: captured(), state: 'captured' });
    const shared = store.recordCreate(group, 'artifact', 'group-capture', { payload: captured(2), state: 'captured' });
    expect(record.payload).toEqual(captured());
    expect(store.recordGet(bob, 'artifact', record.id)).toBeUndefined();
    expect(store.recordGet({ ...alice, threadId: 1 }, 'artifact', record.id)).toBeUndefined();
    expect(store.recordGet({ ...group, threadId: 6 }, 'artifact', shared.id)).toBeUndefined();
    expect(() => store.recordPut(alice, 'artifact', { payload: captured(2) })).toThrow('FORBIDDEN');
    expect(() => store.recordCreate(alice, 'artifact', 'forged', { payload: captured(2) })).toThrow('FORBIDDEN');
    expect(JSON.stringify(store.safeStatus())).not.toMatch(/PRIVATE_CAPTURE|fileId|mimeType/);
    store.close();
    const bytes = await readFile(join(directory, 'ai.sqlite'));
    expect(bytes.includes(Buffer.from('PRIVATE_CAPTURE'))).toBe(false);
    const { store: reopened } = await fixture(directory);
    expect(reopened.recordGet(alice, 'artifact', record.id)).toEqual(record);
    expect(reopened.recordGet(group, 'artifact', shared.id)).toEqual(shared);
    const finalized = { filename: 'private.txt', mimeType: 'text/plain', bytes: 128, sha256: '1'.repeat(64), storageRef: 'validated-file' };
    expect(reopened.recordPut(alice, 'artifact', { id: record.id, expectedRevision: record.revision, payload: finalized, state: 'ready' }).payload).toEqual(finalized);
    expect(() => reopened.recordPut(alice, 'artifact', { id: record.id, expectedRevision: record.revision, payload: captured() })).toThrow('CONFLICT');
    expect(() => reopened.recordPut(alice, 'artifact', { payload: { file: captured().file, actorId: 1, expires: captured().expires } })).toThrow('INVALID_INPUT');
    expect(() => reopened.recordPut(alice, 'artifact', { payload: { data: 'binary-encoded-as-text' } })).toThrow('INVALID_INPUT');
    expect(() => reopened.recordPut(alice, 'summary', { payload: { text: 'missing conversation' } })).toThrow('INVALID_INPUT');
  });
});

describe('indexed pending conversation guard', () => {
  it('finds a target run beyond the first page without loading other continuations', async () => {
    const { store } = await fixture();
    const earlier = store.conversationNew(group);
    for (let index = 0; index < 51; index++) store.runCreate(group, { conversationId: earlier.id, actorId: 1, presetId: 'fixed', settingsRevision: 0 });
    const target = store.conversationNew(group);
    const run = store.runCreate(group, { conversationId: target.id, actorId: 2, presetId: 'fixed', settingsRevision: 0 });
    expect(store.runListPending(group, { limit: 50 }).items.some(item => item.id === run.id)).toBe(false);
    expect(store.hasPendingRun(group, target.id)).toBe(true);
    for (const scope of [alice, bob, { ...group, threadId: 6 }, { ...group, botId: 11 }]) expect(store.hasPendingRun(scope, target.id)).toBe(false);
    expect(() => store.conversationClear(group, target.id, 0)).toThrow('CONFLICT');
    expect(() => store.conversationDelete(group, target.id, 0)).toThrow('CONFLICT');
    store.runUpdate(group, run.id, { revision: 0, state: 'running', continuation: null });
    expect(store.hasPendingRun(group, target.id)).toBe(true);
    store.runUpdate(group, run.id, { revision: 1, state: 'waiting-approval', continuation: null });
    expect(store.hasPendingRun(group, target.id)).toBe(true);
    store.runUpdate(group, run.id, { revision: 2, state: 'cancelled', continuation: null });
    expect(store.hasPendingRun(group, target.id)).toBe(false);
    expect(store.hasPendingRun(group, 'nonexistent')).toBe(false);
  });

  it('retains unknown outcomes and ignores terminal outcomes using the parent index', async () => {
    const { store, directory } = await fixture();
    const conversation = store.conversationNew(alice);
    for (const state of ['completed', 'failed', 'cancelled'] as const) {
      const run = store.runCreate(alice, { conversationId: conversation.id, actorId: 1, presetId: 'fixed', settingsRevision: 0 });
      store.runUpdate(alice, run.id, { revision: 0, state: 'running', continuation: null });
      store.runUpdate(alice, run.id, { revision: 1, state, continuation: null });
      expect(store.hasPendingRun(alice, conversation.id)).toBe(false);
    }
    const unknown = store.runCreate(alice, { conversationId: conversation.id, actorId: 1, presetId: 'fixed', settingsRevision: 0 });
    store.runUpdate(alice, unknown.id, { revision: 0, state: 'running', continuation: null });
    store.runUpdate(alice, unknown.id, { revision: 1, state: 'unknown', continuation: null });
    expect(store.hasPendingRun(alice, conversation.id)).toBe(true);
    store.close();
    const db = new DatabaseSync(join(directory, 'ai.sqlite'));
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM entries WHERE scope=? AND kind='run' AND parent=? AND state IN ('queued','running','waiting-approval','unknown') LIMIT 1")
      .all(JSON.stringify([10, 1, 0, 1]), conversation.id);
    expect(plan.some(row => typeof row.detail === 'string' && row.detail.includes('entries_parent'))).toBe(true);
    db.close();
    const { store: reopened } = await fixture(directory);
    expect(reopened.hasPendingRun(alice, conversation.id)).toBe(true);
  });
});
