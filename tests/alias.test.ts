import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  aliasMutationResultSchema, aliasMutationSchema, aliasNameSchema, aliasSnapshotSchema,
  canonicalCommandSchema, normalizeAliasName,
} from '../shared/schemas/alias.js';
import { inputJsonSchema, moduleMetadataSchema } from '../shared/schemas/index.js';
import { createInvocation, type ActionDefinition, type ActionExecutor } from '../src/actions.js';
import { aliasMetadata, AliasService, registerAliasActions } from '../src/modules/alias.js';
import { JsonStorage, type StorageOptions } from '../src/storage.js';
import { coreFixture, invocation as coreInvocation } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture(options: {
  commands?: readonly string[]; storage?: StorageOptions; contents?: string; initialize?: boolean;
} = {}) {
  const directory = await mkdtemp('/tmp/kilo/misaka-alias-');
  const storage = new JsonStorage(directory, options.storage);
  cleanups.push(async () => { await storage.close(); await rm(directory, { recursive: true, force: true }); });
  await storage.initialize();
  const path = join(directory, 'aliases.json');
  if (options.contents !== undefined) await writeFile(path, options.contents);
  const service = new AliasService(storage, options.commands ?? ['help', 'alias', 'stats', 'commands']);
  if (options.initialize !== false) await service.initialize();
  return { directory, path, storage, service };
}

const invocation = () => createInvocation({ actorId: 1, botId: 12345, source: 'telegram',
  chat: { id: 1, type: 'private' }, language: 'en' });

describe('alias schemas', () => {
  it.each([
    ['\u5e2e\u52a9', '\u5e2e\u52a9'], ['\u5e6b\u52a9', '\u5e6b\u52a9'],
    ['\u30d8\u30eb\u30d7', '\u30d8\u30eb\u30d7'], ['\uff8d\uff99\uff8c\uff9f', '\u30d8\u30eb\u30d7'],
    ['HELP_123', 'help_123'], ['\uff28\uff25\uff2c\uff30', 'help'], ['Cafe\u0301', 'caf\u00e9'],
    ['\u0130', 'i\u0307'], ['q\u0307', 'q\u0307'], ['\ud840\udc00', '\ud840\udc00'],
  ])('normalizes %s consistently', (input, expected) => {
    expect(normalizeAliasName(input)).toBe(expected);
    expect(aliasNameSchema.parse(input)).toBe(expected);
    expect(aliasNameSchema.parse(expected)).toBe(expected);
  });

  it.each([
    '', '/help', 'help@bot', 'two words', ' help', 'help ', 'help\n', 'help\t', 'help\u0000',
    '\uff0fhelp', 'help\uff20bot', '\u202ehelp', 'a\u2066b', '\u200bhelp', '\u034fhelp',
    '\ud83d\ude00', '\ud83d\udc69\u200d\ud83d\udcbb', '1\ufe0f\u20e3', '1\u20e3', '\u2139',
    '\ud83c\udde8\ud83c\uddf3', 'a\ufe0f', 'a\udb40\udc61', 'foo-bar', 'foo.bar', 'help(arg)',
    'a'.repeat(33), '\ud840\udc00'.repeat(17), '\ufb03'.repeat(11), '\u0130'.repeat(17),
    '\ud800', 12, null, {}, ['help'],
  ])('rejects malformed/non-string alias %j', input => {
    expect(aliasNameSchema.safeParse(input).success).toBe(false);
  });

  it('bounds UTF-16 units and permits supported combining marks/underscores', () => {
    expect(aliasNameSchema.parse('a'.repeat(32))).toHaveLength(32);
    expect(aliasNameSchema.parse('\ud840\udc00'.repeat(16))).toHaveLength(32);
    expect(aliasNameSchema.parse('_q\u0307')).toBe('_q\u0307');
    expect(canonicalCommandSchema.parse('\uff28ELP')).toBe('help');
    expect(canonicalCommandSchema.safeParse('\u5e2e\u52a9').success).toBe(false);
    expect(canonicalCommandSchema.safeParse('__proto__').success).toBe(false);
  });

  it('uses strict mutation/result/DTO contracts and JSON-schema-compatible action schemas', () => {
    expect(aliasMutationSchema.parse({ command: 'HELP', alias: 'FOO', revision: 0 }))
      .toEqual({ command: 'help', alias: 'foo', revision: 0 });
    const input = { command: 'help', alias: 'foo', revision: 0 };
    for (const extra of [{ args: ['x'] }, { permission: 'any' }, { arbitrary: true }]) {
      expect(aliasMutationSchema.safeParse({ ...input, ...extra }).success).toBe(false);
    }
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) {
      expect(aliasMutationSchema.safeParse({ ...input, revision }).success).toBe(false);
    }
    const result = { ...input, changed: true };
    expect(aliasMutationResultSchema.parse(result)).toEqual(result);
    expect(aliasMutationResultSchema.safeParse({ ...result, permission: 'any' }).success).toBe(false);
    expect(aliasMutationResultSchema.safeParse({ ...result, alias: 'FOO' }).success).toBe(false);
    const dto = { revision: 0, aliases: { help: ['foo'] } };
    expect(aliasSnapshotSchema.parse(dto)).toEqual(dto);
    expect(aliasSnapshotSchema.safeParse({ ...dto, schema_version: 1 }).success).toBe(false);
    expect(aliasSnapshotSchema.safeParse({ ...dto, permissions: {} }).success).toBe(false);
    expect(aliasSnapshotSchema.safeParse({ revision: 0, aliases: { help: ['foo', 'foo'] } }).success).toBe(false);
    expect(aliasSnapshotSchema.safeParse({ revision: 0, aliases: { help: ['foo'], stats: ['foo'] } }).success).toBe(false);
    expect(inputJsonSchema(aliasMutationSchema)).toMatchObject({ type: 'object', additionalProperties: false });
    expect(z.toJSONSchema(aliasSnapshotSchema)).toMatchObject({ type: 'object', additionalProperties: false });
    expect(z.toJSONSchema(aliasMutationResultSchema)).toMatchObject({ type: 'object', additionalProperties: false });
  });
});

describe('native command alias service', () => {
  it('publishes metadata and only canonical-dependent multilingual defaults', async () => {
    expect(moduleMetadataSchema.parse(aliasMetadata)).toEqual({ id: 'alias', nameKey: 'web:modules.aliasName',
      descriptionKey: 'web:modules.aliasDescription', schema_version: 1, configurable: false });
    const f = await fixture();
    expect(f.service.snapshot()).toEqual({ schema_version: 1, revision: 0, aliases: {
      help: ['\u5e2e\u52a9', '\u5e6b\u52a9', '\u30d8\u30eb\u30d7'],
      alias: ['\u522b\u540d', '\u5225\u540d', '\u30a8\u30a4\u30ea\u30a2\u30b9'],
    } });
    expect(f.service.resolve('\u5e2e\u52a9')).toBe('help');
    expect(f.service.resolve('\u5225\u540d')).toBe('alias');
    expect(f.service.resolve('help')).toBeUndefined();
    expect(f.service.resolve('unknown')).toBeUndefined();
    expect(f.service.resolve('toString')).toBeUndefined();
    expect(f.service.resolve('/help')).toBeUndefined();
    expect((await fixture({ commands: ['stats'] })).service.snapshot().aliases).toEqual({});
    expect((await fixture({ commands: ['help'] })).service.snapshot().aliases).toEqual({ help: f.service.forCommand('help') });
    expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(f.directory)).toEqual(['aliases.json']);
  });

  it('normalizes direct service requests and never resolves canonical names or chained aliases', async () => {
    const f = await fixture();
    expect(await f.service.add('\uff33TATS', '\uff33TATUS', 0))
      .toEqual({ command: 'stats', alias: 'status', changed: true, revision: 1 });
    expect(f.service.resolve('STATUS')).toBe('stats');
    expect(f.service.resolve('\uff33TATUS')).toBe('stats');
    expect(f.service.forCommand('STATS')).toEqual(['status']);
    expect(f.service.resolve('stats')).toBeUndefined();
    await expect(f.service.add('status', 'status2', 1)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['command'] });
    expect(await f.service.remove('STATS', 'STATUS', 1))
      .toEqual({ command: 'stats', alias: 'status', changed: true, revision: 2 });
    expect(f.service.resolve('status')).toBeUndefined();
    expect(f.service.snapshot().aliases).not.toHaveProperty('stats');
  });

  it('rejects all unknown/arbitrary targets and canonical shadows, including normalized ones', async () => {
    const f = await fixture();
    for (const command of ['missing', 'constructor', 'toString', '__proto__', 'help arg', 'help@bot', '/help', '\u5e2e\u52a9']) {
      await expect(f.service.add(command, 'custom', 0)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['command'] });
      await expect(f.service.remove(command, 'custom', 0)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['command'] });
    }
    for (const alias of ['help', 'STATS', '\uff28ELP', 'alias']) {
      await expect(f.service.add('help', alias, 0)).rejects.toMatchObject({ code: 'CONFLICT', fields: ['alias'] });
    }
    for (const alias of ['/foo', 'foo bar', '\u202efoo', '\ud83d\ude00', 'x'.repeat(33)]) {
      await expect(f.service.add('help', alias, 0)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['alias'] });
    }
    expect(f.service.snapshot().revision).toBe(0);
  });

  it('rejects invalid canonical registries without silently changing target identity', async () => {
    const f = await fixture();
    for (const command of ['HELP', '\uff28ELP', '/help', 'help arg', '__proto__', '\u5e2e\u52a9']) {
      expect(() => new AliasService(f.storage, [command])).toThrow(expect.objectContaining({ code: 'INVALID_INPUT', fields: ['command'] }));
    }
  });

  it('enforces optimistic revisions before idempotency and distinguishes collisions from stale data', async () => {
    const beforeCommit = vi.fn(async () => undefined);
    const f = await fixture({ storage: { beforeCommit } });
    beforeCommit.mockClear();
    await f.service.add('stats', 'status', 0);
    expect(await f.service.add('stats', 'STATUS', 1)).toEqual({ command: 'stats', alias: 'status', changed: false, revision: 1 });
    expect(beforeCommit).toHaveBeenCalledTimes(1);
    await expect(f.service.add('stats', 'status', 0)).rejects.toMatchObject({ code: 'CONFLICT', fields: undefined });
    await expect(f.service.add('help', 'status', 1)).rejects.toMatchObject({ code: 'CONFLICT', fields: ['alias'] });
    await expect(f.service.remove('help', 'status', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.remove('help', 'stats', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.remove('stats', 'absent', 1)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.remove('stats', 'status', 0)).rejects.toMatchObject({ code: 'CONFLICT', fields: undefined });
    await f.service.remove('stats', 'status', 1);
    await expect(f.service.remove('stats', 'status', 2)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(await f.service.add('help', 'status', 2)).toMatchObject({ changed: true, revision: 3 });
    expect(f.service.resolve('status')).toBe('help');
  });

  it('limits each command to eight aliases, including defaults, while keeping duplicate adds idempotent', async () => {
    const f = await fixture();
    for (let i = 0; i < 5; i++) await f.service.add('help', `custom_${i}`, i);
    expect(f.service.forCommand('help')).toHaveLength(8);
    await expect(f.service.add('help', 'overflow', 5)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['alias'] });
    expect(await f.service.add('help', 'custom_4', 5)).toMatchObject({ changed: false, revision: 5 });
    await f.service.remove('help', 'custom_4', 5);
    await f.service.add('help', 'replacement', 6);
    expect(f.service.forCommand('help')).toHaveLength(8);
  });

  it('does not mutate or write on reads, and does not expose mutable snapshots/lists', async () => {
    const beforeCommit = vi.fn(async () => undefined);
    const f = await fixture({ storage: { beforeCommit } });
    const before = await readFile(f.path, 'utf8');
    beforeCommit.mockClear();
    expect(f.service.forCommand('stats')).toEqual([]);
    expect(f.service.forCommand('constructor')).toEqual([]);
    expect(f.service.forCommand('bad command')).toEqual([]);
    expect(f.service.forCommand('__proto__')).toEqual([]);
    for (let i = 0; i < 20; i++) {
      f.service.resolve('\uff8d\uff99\uff8c\uff9f'); f.service.forCommand('HELP'); f.service.snapshot();
    }
    expect(() => { f.service.snapshot().aliases.help!.push('injected'); }).toThrow();
    expect(() => { (f.service.forCommand('help') as string[]).push('injected'); }).toThrow();
    expect(() => { f.service.snapshot().revision = 99; }).toThrow();
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(await readFile(f.path, 'utf8')).toBe(before);
  });

  it('safely supports prototype-like aliases and registered constructor commands', async () => {
    const f = await fixture({ commands: ['help', 'constructor'] });
    expect(f.service.forCommand('constructor')).toEqual([]);
    await f.service.add('constructor', '__proto__', 0);
    await f.service.add('help', 'toString', 1);
    expect(f.service.resolve('__proto__')).toBe('constructor');
    expect(f.service.resolve('toString')).toBe('help');
    expect(Object.getPrototypeOf(f.service.snapshot().aliases)).toBe(Object.prototype);
    expect(Object.hasOwn(f.service.snapshot().aliases, 'constructor')).toBe(true);
    expect(f.service.forCommand('constructor')).toEqual(['__proto__']);
    const reload = new AliasService(f.storage, ['help', 'constructor']);
    await reload.initialize();
    expect(reload.resolve('__proto__')).toBe('constructor');
    expect({}.constructor).toBe(Object);
  });

  it('restores only persisted mappings and never resurrects removed defaults on initialization', async () => {
    const f = await fixture();
    for (const alias of [...f.service.forCommand('help')]) {
      await f.service.remove('help', alias, f.service.snapshot().revision);
    }
    const revision = f.service.snapshot().revision;
    await f.service.initialize();
    expect(f.service.snapshot().revision).toBe(revision);
    const reload = new AliasService(f.storage, ['help', 'alias', 'stats', 'commands']);
    await reload.initialize();
    expect(reload.forCommand('help')).toEqual([]);
    expect(reload.snapshot()).toEqual(f.service.snapshot());
    expect(JSON.parse(await readFile(f.path, 'utf8'))).toEqual(f.service.snapshot());
    expect(JSON.parse(await readFile(f.path, 'utf8'))).not.toHaveProperty('permissions');
  });

  it('rejects malformed direct-call revisions and cannot overflow the safe revision range', async () => {
    const f = await fixture({ contents: JSON.stringify({ schema_version: 1, revision: Number.MAX_SAFE_INTEGER, aliases: { help: ['custom'] } }) });
    for (const revision of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', undefined]) {
      await expect(f.service.add('help', 'other', revision as number)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['revision'] });
    }
    await expect(f.service.add('help', 123 as unknown as string, Number.MAX_SAFE_INTEGER))
      .rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['alias'] });
    expect(await f.service.add('help', 'custom', Number.MAX_SAFE_INTEGER)).toMatchObject({ changed: false, revision: Number.MAX_SAFE_INTEGER });
    await expect(f.service.add('help', 'other', Number.MAX_SAFE_INTEGER)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.service.resolve('other')).toBeUndefined();
    expect(f.service.snapshot().revision).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe('alias persistence integrity and races', () => {
  it.each([
    'not json', '{"schema_version":9,"revision":0,"aliases":{}}',
    '{"schema_version":1,"revision":0,"aliases":[]}',
    '{"schema_version":1,"revision":0,"aliases":{"unknown":["foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["stats"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["foo","foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["foo"],"stats":["foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["UPPER"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["foo bar"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"help":["/foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"__proto__":["foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{"constructor":["foo"]}}',
    '{"schema_version":1,"revision":0,"aliases":{},"permissions":{"help":"any"}}',
    '{"schema_version":1,"revision":-1,"aliases":{}}',
    JSON.stringify({ schema_version: 1, revision: 0, aliases: { help: Array.from({ length: 9 }, (_, i) => `a${i}`) } }),
  ])('retains corrupt or unknown-version original bytes: %s', async contents => {
    const f = await fixture({ contents, initialize: false });
    await expect(f.service.initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(() => f.service.snapshot()).toThrow(expect.objectContaining({ code: 'STORAGE_ERROR' }));
    expect(await readFile(f.path, 'utf8')).toBe(contents);
    expect(await readdir(f.directory)).toEqual(['aliases.json']);
  });

  it.each(['add', 'remove'] as const)('does not publish %s or its reverse lookup when writes fail', async operation => {
    let fail = false;
    const f = await fixture({ storage: { beforeCommit: async () => { if (fail) throw new Error('disk full'); } } });
    const before = f.service.snapshot();
    const bytes = await readFile(f.path, 'utf8');
    fail = true;
    const alias = operation === 'add' ? 'custom' : '\u5e2e\u52a9';
    await expect(f.service[operation]('help', alias, 0)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(f.service.snapshot()).toBe(before);
    expect(f.service.resolve(alias)).toBe(operation === 'add' ? undefined : 'help');
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(await readdir(f.directory)).toEqual(['aliases.json']);
  });

  it('publishes only after write completion and rejects stale competing adds under the shared lock', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const f = await fixture({ storage: { beforeCommit: async () => { if (hold) { entered.resolve(); await release.promise; } } } });
    hold = true;
    const first = f.service.add('help', 'custom', 0);
    await entered.promise;
    expect(f.service.resolve('custom')).toBeUndefined();
    expect(f.service.snapshot().revision).toBe(0);
    const second = f.service.add('stats', 'CUSTOM', 0);
    const outcomes = Promise.allSettled([first, second]);
    release.resolve();
    expect(await outcomes).toEqual([
      { status: 'fulfilled', value: { command: 'help', alias: 'custom', changed: true, revision: 1 } },
      { status: 'rejected', reason: expect.objectContaining({ code: 'CONFLICT', fields: undefined }) },
    ]);
    expect(f.service.resolve('CUSTOM')).toBe('help');
    await expect(f.service.add('stats', 'custom', 1)).rejects.toMatchObject({ code: 'CONFLICT', fields: ['alias'] });
    expect(f.service.snapshot().revision).toBe(1);
  });

  it.each(['add', 'remove'] as const)('cancels an in-flight %s before replacement without changing memory or disk', async operation => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const f = await fixture({ storage: { beforeCommit: async () => { if (hold) { entered.resolve(); await release.promise; } } } });
    const before = f.service.snapshot();
    const bytes = await readFile(f.path, 'utf8');
    hold = true;
    const controller = new AbortController();
    const alias = operation === 'add' ? 'custom' : '\u5e2e\u52a9';
    const mutation = f.service[operation]('help', alias, 0, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve();
    await expect(mutation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.service.snapshot()).toBe(before);
    expect(f.service.resolve(alias)).toBe(operation === 'add' ? undefined : 'help');
    expect(await readFile(f.path, 'utf8')).toBe(bytes);
    expect(await readdir(f.directory)).toEqual(['aliases.json']);
  });

  it('honors cancellation while queued and before idempotent operations, and rejects writes after close', async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    const entered = Promise.withResolvers<void>();
    const locked = f.storage.lock.run(async () => { entered.resolve(); await release.promise; });
    await entered.promise;
    const controller = new AbortController();
    const mutation = f.service.add('stats', 'custom', 0, controller.signal);
    controller.abort();
    release.resolve();
    await locked;
    await expect(mutation).rejects.toMatchObject({ code: 'CANCELLED' });
    await expect(f.service.add('help', '\u5e2e\u52a9', 0, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.service.snapshot().revision).toBe(0);
    await f.storage.close();
    await expect(f.service.add('stats', 'custom', 0)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('alias action registration', () => {
  it('registers only private human superadmin actions with strict schemas and bounded timeouts', async () => {
    const f = await fixture();
    const actions: ActionDefinition<unknown, unknown>[] = [];
    const executor: Pick<ActionExecutor, 'register'> = { register: definition => { actions.push(definition as ActionDefinition<unknown, unknown>); } };
    registerAliasActions(executor, f.service);
    expect(actions.map(action => action.id)).toEqual(['alias.list', 'alias.add', 'alias.remove']);
    for (const action of actions) {
      expect(action).toMatchObject({ permission: 'superadmin', scopes: ['private'], sources: ['telegram', 'http'], aiVisible: false, timeoutMs: 15_000 });
      expect(action.confirmation).toBeUndefined();
      expect(inputJsonSchema(action.input)).toMatchObject({ additionalProperties: false });
      expect(z.toJSONSchema(action.output)).toMatchObject({ additionalProperties: false });
    }
    const [list, add, remove] = actions;
    expect(list!.effect).toBe('read');
    expect(list!.input.safeParse({ extra: true }).success).toBe(false);
    expect(list!.output.parse(await list!.execute({}, invocation())))
      .toEqual({ revision: 0, aliases: f.service.snapshot().aliases });
    expect(add!.effect).toBe('permission');
    expect(remove!.effect).toBe('permission');
    const input = add!.input.parse({ command: 'STATS', alias: 'STATUS', revision: 0 });
    expect(add!.output.parse(await add!.execute(input, invocation())))
      .toEqual({ command: 'stats', alias: 'status', revision: 1, changed: true });
    expect(remove!.output.parse(await remove!.execute({ command: 'stats', alias: 'status', revision: 1 }, invocation())))
      .toEqual({ command: 'stats', alias: 'status', revision: 2, changed: true });
    const context = invocation();
    const controller = new AbortController();
    controller.abort();
    await expect(add!.execute({ command: 'stats', alias: 'status', revision: 2 }, { ...context, signal: controller.signal }))
      .rejects.toMatchObject({ code: 'CANCELLED' });
  });

  it('enforces real executor superadmin/private/source policy before any alias handler runs', async () => {
    const f = await coreFixture({ services: { aiEnabled: true } });
    cleanups.push(f.close);
    await f.access.authorize(-100, 'Authorized test group', 1, 0);
    const contexts = [
      coreInvocation({ actorId: 3, chat: { id: 3, type: 'private' } }),
      coreInvocation({ actorId: 3, chat: { id: 3, type: 'private' }, source: 'http' }),
      coreInvocation({ chat: { id: -100, type: 'supergroup' } }),
      coreInvocation({ source: 'ai' }),
    ];
    for (const [id, input] of [
      ['alias.list', {}],
      ['alias.add', { command: 'help', alias: 'custom', revision: 0 }],
      ['alias.remove', { command: 'help', alias: '\u5e2e\u52a9', revision: 0 }],
    ] as const) {
      for (const context of contexts) {
        expect(await f.executor.execute(context, id, input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
      }
    }
    expect(await f.executor.execute(coreInvocation(), 'alias.list', {}))
      .toMatchObject({ status: 'succeeded', data: { revision: 0 } });
    expect((await f.executor.discoverTools(coreInvocation())).some(tool => tool.id.startsWith('alias.'))).toBe(false);
  });

  it('executes private HTTP/Telegram mutations directly with normalized responses and strict Action validation', async () => {
    const f = await coreFixture();
    cleanups.push(f.close);
    expect(await f.executor.execute(coreInvocation({ source: 'http' }), 'alias.add', { command: 'HELP', alias: '\uff26OO', revision: 0 }))
      .toMatchObject({ status: 'succeeded', data: { command: 'help', alias: 'foo', changed: true, revision: 1 } });
    expect(await f.executor.execute(coreInvocation(), 'alias.add', { command: 'help', alias: 'foo', revision: 1 }))
      .toMatchObject({ status: 'succeeded', data: { changed: false, revision: 1 } });
    expect(await f.executor.execute(coreInvocation(), 'alias.add', { command: 'help', alias: 'bad input', revision: 1 }))
      .toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT', fields: ['alias'] } });
    expect(await f.executor.execute(coreInvocation(), 'alias.add', { command: 'help', alias: 'x', revision: 1, permission: 'any' }))
      .toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(await f.executor.execute(coreInvocation(), 'alias.add', { command: 'foo', alias: 'x', revision: 1 }))
      .toMatchObject({ status: 'failed', error: { code: 'INVALID_INPUT', fields: ['command'] } });
    expect(await f.executor.execute(coreInvocation(), 'alias.remove', { command: 'help', alias: 'foo', revision: 1 }))
      .toMatchObject({ status: 'succeeded', data: { command: 'help', alias: 'foo', changed: true, revision: 2 } });
    const list = await f.executor.execute(coreInvocation(), 'alias.list', {});
    expect(list).toMatchObject({ status: 'succeeded', data: { revision: 2 } });
    if (list.status === 'succeeded') {
      expect(aliasSnapshotSchema.safeParse(list.data).success).toBe(true);
      expect(list.data).not.toHaveProperty('schema_version');
    }
  });
});
