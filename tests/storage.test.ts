import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AccessService } from '../src/access.js';
import { ConfigurationService } from '../src/configuration.js';
import { JSON_DOCUMENT_MAX_BYTES, JsonDocument, JsonStorage } from '../src/storage.js';
import { AliasService } from '../src/modules/alias.js';
import { commands } from '../src/telegram/commands.js';
import { coreFixture } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture(options: Parameters<typeof coreFixture>[0] = {}) {
  const result = await coreFixture(options); cleanups.push(result.close); return result;
}

describe('atomic versioned storage', () => {
  it('starts with native defaults, restricts all seven files, and restores durable data without sessions', async () => {
    const f = await fixture();
    expect(f.access.count()).toBe(0);
    expect(f.configuration.settings().effective.defaultLanguage).toBe('zh-CN');
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.configuration.setPreference(10, 'en');
    await f.aliases.add('help', 'assistance', 0);
    const nextStorage = new JsonStorage(f.directory);
    const nextAccess = new AccessService(nextStorage, [1]);
    const nextConfiguration = new ConfigurationService(nextStorage);
    const nextAliases = new AliasService(nextStorage, commands.map(command => command.name));
    await nextStorage.initialize(); await nextAccess.initialize(); await nextConfiguration.initialize(); await nextAliases.initialize();
    expect(nextAccess.isAllowed(-100)).toBe(true);
    expect(nextConfiguration.getPreference(10).language).toBe('en');
    expect(nextAliases.snapshot()).toEqual(f.aliases.snapshot());
    expect(nextAliases.resolve('assistance')).toBe('help');
    expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
    for (const name of ['access.json', 'aliases.json', 'settings.json', 'preferences.json', 'rates.json', 'rss.json', 'subconv.json', 'weather.json']) expect((await stat(join(f.directory, name))).mode & 0o777).toBe(0o600);
    expect(await readdir(f.directory)).toEqual(['access.json', 'aliases.json', 'preferences.json', 'rates.json', 'rss.json', 'settings.json', 'subconv.json', 'weather.json']);
    await nextStorage.close();
  });

  it('serializes concurrent user-local updates and rejects stale whole-configuration revisions', async () => {
    const f = await fixture();
    await Promise.all(Array.from({ length: 30 }, (_, index) => f.configuration.setPreference(index + 1, index % 2 ? 'en' : 'zh-CN')));
    for (let i = 0; i < 30; i++) expect(f.configuration.getPreference(i + 1).language).toBe(i % 2 ? 'en' : 'zh-CN');
    const results = await Promise.allSettled([
      f.configuration.updateSettings({ defaultLanguage: 'en' }, 0),
      f.configuration.updateSettings({ defaultLanguage: 'zh-CN' }, 0),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([{ status: 'rejected', reason: expect.objectContaining({ code: 'CONFLICT' }) }]);
    expect(f.configuration.settings().revision).toBe(1);
  });

  it('does not create ordinary user records and auto removes only the authenticated user preference', async () => {
    const f = await fixture();
    const before = await readFile(join(f.directory, 'preferences.json'), 'utf8');
    f.configuration.resolveLanguage(100, 'en-US');
    expect(await readFile(join(f.directory, 'preferences.json'), 'utf8')).toBe(before);
    await f.configuration.setPreference(100, 'en');
    await f.configuration.setPreference(200, 'zh-CN');
    await f.configuration.setPreference(100, 'auto');
    const document = JSON.parse(await readFile(join(f.directory, 'preferences.json'), 'utf8'));
    expect(document.users).toEqual({ '200': { language: 'zh-CN' } });
  });

  it('publishes no in-memory authorization after disk failure and removes only its temporary file', async () => {
    let fail = false;
    const f = await fixture({ storage: { beforeCommit: async filename => { if (fail && filename === 'access.json') throw new Error('secret disk error'); } } });
    const before = await readFile(join(f.directory, 'access.json'), 'utf8');
    fail = true;
    await expect(f.access.authorize(-100, 'Group', 1, 0)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(f.access.isAllowed(-100)).toBe(false);
    expect(f.access.snapshot().revision).toBe(0);
    expect(await readFile(join(f.directory, 'access.json'), 'utf8')).toBe(before);
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('cancels before atomic replacement and drains the actual write rather than dropping a promise', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let hold = false;
    const f = await fixture({ storage: { beforeCommit: async () => { if (hold) { entered.resolve(); await release.promise; } } } });
    hold = true;
    const controller = new AbortController();
    const write = f.access.authorize(-100, 'Group', 1, 0, controller.signal);
    await entered.promise;
    controller.abort();
    release.resolve();
    await expect(write).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.access.count()).toBe(0);
    expect(JSON.parse(await readFile(join(f.directory, 'access.json'), 'utf8')).groups).toEqual({});
    expect((await readdir(f.directory)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('bounds exact pretty-JSON UTF-8 bytes and preserves disk and snapshot on oversize rejection', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'misaka-storage-size-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const beforeCommit = vi.fn(async () => {});
    const storage = new JsonStorage(directory, { beforeCommit });
    cleanups.push(() => storage.close());
    await storage.initialize();
    const schema = z.strictObject({ schema_version: z.literal(1), revision: z.number().int().nonnegative(), value: z.string() });
    const document = new JsonDocument(storage, 'settings.json', schema);
    await document.load({ schema_version: 1, revision: 0, value: 'original' });
    const overhead = Buffer.byteLength(`${JSON.stringify({ schema_version: 1, revision: 1, value: '' }, null, 2)}\n`);
    const available = JSON_DOCUMENT_MAX_BYTES - overhead;
    const value = '\ufffd'.repeat(Math.floor(available / 3)) + 'x'.repeat(available % 3);
    await document.update(candidate => { candidate.value = value; });
    const snapshot = document.snapshot();
    const bytes = await readFile(join(directory, 'settings.json'));
    expect(bytes.length).toBe(JSON_DOCUMENT_MAX_BYTES);
    expect(bytes.toString('utf8')).toBe(`${JSON.stringify(snapshot, null, 2)}\n`);
    const reloaded = new JsonDocument(storage, 'settings.json', schema);
    await reloaded.load({ schema_version: 1, revision: 0, value: '' });
    expect(reloaded.snapshot()).toEqual(snapshot);
    beforeCommit.mockClear();
    expect(Buffer.byteLength(JSON.stringify({ ...snapshot, revision: 2, value: value + 'x' }))).toBeLessThan(JSON_DOCUMENT_MAX_BYTES);
    await expect(document.update(candidate => { candidate.value += 'x'; })).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(beforeCommit).not.toHaveBeenCalled();
    expect(document.snapshot()).toBe(snapshot);
    expect(await readFile(join(directory, 'settings.json'))).toEqual(bytes);
    expect(await readdir(directory)).toEqual(['settings.json']);
    await document.update(candidate => { candidate.value = 'recovered'; });
    expect(document.snapshot()).toEqual({ schema_version: 1, revision: 2, value: 'recovered' });
  });

  it.each(['{"schema_version":9,"revision":0,"groups":{}}', 'not json', '{"schema_version":1,"revision":0,"groups":[]}'])('retains corrupt/unknown-version original %s', async contents => {
    const directory = await mkdtemp(join(tmpdir(), 'misaka-corrupt-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'access.json');
    await writeFile(path, contents);
    const storage = new JsonStorage(directory);
    await storage.initialize();
    await expect(new AccessService(storage, [1]).initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(await readFile(path, 'utf8')).toBe(contents);
  });

  it('refuses symlink state files and paths that cannot be directories', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'misaka-storage-path-'));
    cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const sentinel = join(directory, 'untouched');
    await writeFile(sentinel, 'private old data');
    await expect(new JsonStorage(sentinel).initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await mkdir(join(directory, 'state'));
    await symlink(sentinel, join(directory, 'state/access.json'));
    const storage = new JsonStorage(join(directory, 'state'));
    await storage.initialize();
    await expect(new AccessService(storage, [1]).initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(await readFile(sentinel, 'utf8')).toBe('private old data');
  });

  it('exposes immutable snapshots and refuses writes after close', async () => {
    const f = await fixture();
    expect(() => { f.access.snapshot().revision = 9; }).toThrow();
    await f.storage.close();
    await expect(f.access.authorize(-100, 'Group', 1, 0)).rejects.toMatchObject({ code: 'CANCELLED' });
  });
});

describe('system membership and migration', () => {
  const joinEvent = { chatId: -100, title: 'Example', actorId: 10, isMember: true, wasMember: false, updateId: 10, at: '2026-11-08T00:00:00.000Z' };

  it('waits once for an ordinary invite, does not turn Telegram administrators into superadmins', async () => {
    const f = await fixture();
    expect(await f.access.membership(joinEvent)).toMatchObject({ kind: 'waiting', changed: true });
    expect(await f.access.membership(joinEvent)).toMatchObject({ kind: 'duplicate', changed: false });
    expect(f.access.count()).toBe(0);
    await f.access.membership({ ...joinEvent, actorId: 1, updateId: 11, wasMember: true });
    expect(f.access.count()).toBe(0);
  });

  it('automatically authorizes a human configured superadmin invite without refreshing duplicate grants', async () => {
    const f = await fixture();
    expect(await f.access.membership({ ...joinEvent, actorId: 1 })).toMatchObject({ kind: 'authorized', changed: true });
    const original = f.access.snapshot().groups['-100'];
    await f.access.membership({ ...joinEvent, actorId: 1, at: '2026-11-09T00:00:00.000Z' });
    expect(f.access.snapshot().groups['-100']).toEqual(original);
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    await f.access.membership({ ...joinEvent, actorId: 1 });
    expect(f.access.count()).toBe(0);
    await f.access.membership({ ...joinEvent, actorId: 1, actorIsBot: true, chatId: -200, updateId: 12 });
    expect(f.access.isAllowed(-200)).toBe(false);
  });

  it('preserves grant identity through migration, handles leaving, and never resurrects revoked permissions', async () => {
    const f = await fixture();
    await f.access.membership({ ...joinEvent, actorId: 1 });
    const original = f.access.snapshot().groups['-100'];
    expect(await f.access.migrate(-100, -200, 20)).toBe(true);
    expect(f.access.isAllowed(-100)).toBe(false);
    expect(f.access.snapshot().groups['-200']).toEqual({ ...original, id: -200 });
    await f.access.membership({ ...joinEvent, isMember: false, wasMember: true, updateId: 21 });
    expect(f.access.isAllowed(-200)).toBe(true);
    await f.access.revoke(-200, 1, f.access.snapshot().revision);
    expect(await f.access.migrate(-100, -200, 22)).toBe(false);
    expect(f.access.count()).toBe(0);
    await f.access.membership({ ...joinEvent, actorId: 1, chatId: -300, updateId: 23 });
    await f.access.membership({ ...joinEvent, chatId: -300, isMember: false, wasMember: true, updateId: 24 });
    expect(f.access.count()).toBe(0);
  });
});
