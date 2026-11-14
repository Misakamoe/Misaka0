import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { relayCancelResultSchema, relaySourceInputSchema } from '../shared/schemas/relay.js';
import { createInvocation, type InvocationContext, type InvocationInput } from '../src/actions.js';
import { RelayService, RelayTransportError, registerRelayActions, type RelayCapture, type RelayTransport } from '../src/modules/relay.js';
import { JsonStorage, type StorageOptions } from '../src/storage.js';
import { coreFixture } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const context = (actorId = 10, threadId?: number, overrides: Partial<InvocationInput> = {}) => createInvocation({
  actorId, botId: 12345, source: 'telegram', chat: { id: actorId, type: 'private', ...(threadId === undefined ? {} : { threadId }) }, language: 'en', ...overrides,
});
async function fixture(storageOptions: StorageOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'misaka-relay-'));
  const storage = new JsonStorage(directory, storageOptions); await storage.initialize();
  const admins = new Set([1, 2]); let now = 1_800_000_000_000; let messageId = 10_000;
  const transport = { notify: vi.fn<RelayTransport['notify']>(async () => ++messageId), copy: vi.fn<RelayTransport['copy']>(async () => ++messageId) };
  const options = { isAdmin: (id: number) => admins.has(id), now: () => now, transport };
  const service = new RelayService(storage, options); await service.initialize();
  cleanup.push(async () => { await service.stop(); await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const owner = context(2, 7); const visitor = context(10, 9);
  const capture = (ctx = visitor, id = 1, replyToMessageId?: number, overrides: Partial<RelayCapture> = {}) => service.capture(ctx, {
    messageId: id, sentAt: now, name: `Visitor ${ctx.actorId}`,
    ...(replyToMessageId === undefined ? {} : { replyToMessageId }), ...overrides,
  });
  const enable = () => service.configure(owner, { enabled: true, revision: service.settings(owner).revision });
  const request = (ctx = visitor, id = 1) => service.request(ctx, capture(ctx, id));
  const accept = async (ctx = visitor) => {
    const pending = await request(ctx); return service.change(owner, 'accept', { id: pending.id, revision: pending.revision });
  };
  const restart = async () => {
    await service.stop(); const restored = new RelayService(storage, options); await restored.initialize(); cleanup.push(() => restored.stop()); return restored;
  };
  return { directory, storage, admins, transport, options, service, owner, visitor, capture, enable, request, accept, restart,
    advance: (duration: number) => { now += duration; }, now: () => now,
    disk: async () => JSON.parse(await readFile(join(directory, 'relay.json'), 'utf8')) as Record<string, unknown>,
  };
}

describe('private relay ownership and contracts', () => {
  it('starts disabled and binds only the enabling admin, bot and true private topic', async () => {
    const f = await fixture();
    expect(f.service.settings(f.owner)).toEqual({ enabled: false, ownerBound: false, revision: 0 });
    expect(f.service.status(f.visitor)).toEqual({ available: false, contact: null });
    await expect(f.request()).rejects.toThrow('UNAVAILABLE');
    await expect(f.service.configure(f.visitor, { enabled: true, revision: 0 })).rejects.toThrow('FORBIDDEN');
    expect(await f.enable()).toEqual({ enabled: true, ownerBound: true, revision: 1 });
    for (const caller of [context(1), context(2), context(2, 8), context(2, 7, { botId: 999 })]) {
      expect(() => f.service.settings(caller)).toThrow('FORBIDDEN');
      expect(() => f.service.list(caller)).toThrow('FORBIDDEN');
      await expect(f.service.configure(caller, { enabled: false, revision: 1 })).rejects.toThrow('FORBIDDEN');
    }
    await expect(f.service.configure(f.owner, { enabled: false, revision: 0 })).rejects.toThrow('CONFLICT');
    await f.service.configure(f.owner, { enabled: false, revision: 1 });
    await expect(f.service.configure(context(1), { enabled: true, revision: 2 })).rejects.toThrow('FORBIDDEN');
    await expect(f.service.request(f.owner, f.capture(f.owner))).rejects.toThrow('UNAVAILABLE');
    await f.enable();
    await expect(f.service.request(context(2), f.capture(context(2)))).rejects.toThrow('FORBIDDEN');
    expect(f.transport.notify).not.toHaveBeenCalled();
  });
  it('denies group, HTTP, AI, mismatched private chat and removed owner access', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    for (const caller of [context(10, 9, { source: 'http' }), context(10, 9, { source: 'ai' }),
      context(10, undefined, { chat: { id: -100, type: 'supergroup' } }),
      { ...f.visitor, chat: { id: 11, type: 'private' } } as InvocationContext]) {
      expect(() => f.service.capture(caller, { messageId: 2, sentAt: f.now(), name: 'Name' })).toThrow('FORBIDDEN');
      expect(() => f.service.status(caller)).toThrow('FORBIDDEN');
    }
    f.admins.delete(2);
    expect(f.service.status(f.visitor)).toMatchObject({ available: false, contact: { routingActive: false } });
    expect(f.service.classify(f.visitor)).toBe('blocked');
    expect(() => f.service.list(f.owner)).toThrow('FORBIDDEN');
    expect(() => f.service.list(context(1))).toThrow('FORBIDDEN');
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('UNAVAILABLE');
    const before = f.transport.notify.mock.calls.length;
    const contact = f.service.status(f.visitor).contact!;
    expect(await f.service.change(f.visitor, 'close', { id: contact.id, revision: contact.revision })).toMatchObject({ status: 'closed' });
    expect(f.transport.notify).toHaveBeenCalledTimes(before);
  });
  it('keeps visitors and contacts private, and allows only exact-scope owner management', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    const own = f.service.status(f.visitor);
    expect(Object.keys(own)).toEqual(['available', 'contact']);
    expect(Object.keys(own.contact!)).toEqual(['id', 'revision', 'status', 'createdAt', 'updatedAt', 'routingActive']);
    for (const caller of [context(11, 9), context(10), context(10, 8), context(10, 9, { botId: 999 })]) {
      expect(f.service.status(caller).contact).toBeNull();
      expect(() => f.service.get(caller, pending.id)).toThrow('FORBIDDEN');
      await expect(f.service.change(caller, 'close', { id: pending.id, revision: pending.revision })).rejects.toThrow('FORBIDDEN');
    }
    expect(f.service.get(f.owner, pending.id)).toMatchObject({ visitor: { id: 10, name: 'Visitor 10' } });
    expect(f.service.list(f.owner)).toMatchObject({ items: [{ id: pending.id }], page: 0, totalPages: 1 });
    expect(f.transport.notify.mock.calls[0]).toMatchObject([{ botId: 12345, chatId: 2, threadId: 7 },
      { kind: 'request', contactId: pending.id, visitor: { id: 10, name: 'Visitor 10' } }, expect.any(AbortSignal)]);
    expect((await stat(join(f.directory, 'relay.json'))).mode & 0o777).toBe(0o600);
  });
  it('registers strict Telegram-only, private, non-AI actions through the executor', async () => {
    const core = await coreFixture(); cleanup.push(core.close);
    const service = new RelayService(core.storage, { isAdmin: id => core.access.isAdmin(id),
      transport: { notify: async () => 100, copy: async () => 101 } });
    await service.initialize(); cleanup.push(() => service.stop()); registerRelayActions(core.executor, service);
    const owner = context(2, 7);
    expect(await core.executor.execute(owner, 'relay.settings.set', { revision: 0, enabled: true })).toMatchObject({ status: 'succeeded' });
    for (const caller of [context(2, 7, { source: 'ai' }), context(2, 7, { source: 'http' }),
      context(2, undefined, { chat: { id: -100, type: 'supergroup' } })]) {
      expect(await core.executor.execute(caller, 'relay.settings.get', {})).toMatchObject({ status: 'rejected' });
      expect(await core.executor.execute(caller, 'relay.send', { source: 'a'.repeat(24) })).toMatchObject({ status: 'rejected' });
      expect(await core.executor.execute(caller, 'relay.cancel', {})).toMatchObject({ status: 'rejected' });
    }
    const visitor = context(10, 9);
    const source = service.capture(visitor, { messageId: 1, sentAt: Date.now(), name: 'Literal <name>', username: 'visitor_test' });
    expect(await core.executor.execute(visitor, 'relay.contact.request', { source, ownerId: 2 })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(await core.executor.execute(visitor, 'relay.contact.request', { source })).toMatchObject({ status: 'succeeded', data: { status: 'pending' } });
    for (const field of ['messageId', 'replyToMessageId', 'name', 'username', 'role', 'scope', 'chatId', 'languageHint']) {
      expect(relaySourceInputSchema.safeParse({ source, [field]: 1 }).success).toBe(false);
    }
    expect(z.toJSONSchema(relaySourceInputSchema, { target: 'draft-7' }).additionalProperties).toBe(false);
    expect(await core.executor.execute(visitor, 'relay.contacts.list', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(await core.executor.execute(visitor, 'relay.cancel', { actorId: 2 })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(await core.executor.execute(visitor, 'relay.cancel', {})).toMatchObject({ status: 'succeeded', data: true });
    expect(z.toJSONSchema(relayCancelResultSchema, { target: 'draft-7' }).type).toBe('boolean');
  });
});

describe('relay consent and temporary routing', () => {
  it('expires after idle time rather than interrupting an ongoing conversation', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    f.advance(9 * 60_000);
    await f.service.send(f.visitor, f.capture(f.visitor, 2));
    f.advance(9 * 60_000);
    expect(f.service.classify(f.visitor)).toBe('active');
    const copy = f.transport.copy.getMockImplementation()!;
    f.transport.copy.mockImplementation(async (...args) => { f.service.suspend(f.visitor); return copy(...args); });
    await f.service.send(f.visitor, f.capture(f.visitor, 3));
    expect(f.service.classify(f.visitor)).toBe('none');
    const contact = f.service.status(f.visitor).contact!;
    await f.service.resume(f.visitor, { id: contact.id, revision: contact.revision });
    f.advance(10 * 60_000 + 1);
    expect(f.service.classify(f.visitor)).toBe('blocked');
  });

  it('deduplicates concurrent pending requests and enforces consent, revisions and cooldown', async () => {
    const f = await fixture(); await f.enable();
    const [pending, duplicate] = await Promise.all([f.request(), f.request()]);
    expect(duplicate).toEqual(pending); expect(f.transport.notify).toHaveBeenCalledTimes(1);
    expect(await f.request(f.visitor, 2)).toEqual(pending); expect(f.transport.notify).toHaveBeenCalledTimes(1);
    await expect(f.service.request(context(10, 8), f.capture(context(10, 8), 3))).rejects.toThrow('FORBIDDEN');
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 4))).rejects.toThrow('FORBIDDEN');
    await expect(f.service.change(f.visitor, 'accept', { id: pending.id, revision: pending.revision })).rejects.toThrow('FORBIDDEN');
    await expect(f.service.change(f.owner, 'accept', { ...pending, revision: 0 })).rejects.toThrow('INVALID_INPUT');
    await expect(f.service.change(f.owner, 'accept', { id: pending.id, revision: 0 })).rejects.toThrow('CONFLICT');
    const declined = await f.service.change(f.owner, 'decline', { id: pending.id, revision: pending.revision });
    expect(declined.status).toBe('declined');
    await expect(f.request(f.visitor, 5)).rejects.toThrow('RATE_LIMITED');
    f.advance(60_001);
    const renewed = await f.request(f.visitor, 6);
    expect(renewed).toMatchObject({ id: pending.id, revision: declined.revision + 1, status: 'pending' });
    await expect(f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision })).rejects.toThrow('CONFLICT');
    const accepted = await f.service.change(f.owner, 'accept', { id: renewed.id, revision: renewed.revision });
    expect(accepted.status).toBe('accepted'); expect(f.service.classify(f.visitor)).toBe('active');
    const closed = await f.service.change(f.visitor, 'close', { id: accepted.id, revision: accepted.revision });
    expect(closed.status).toBe('closed'); expect(f.service.classify(f.visitor)).toBe('none');
    expect(f.transport.notify.mock.calls.at(-1)?.[0]).toMatchObject({ chatId: 2, threadId: 7 });
  });
  it('allows owner close and durable owner-only blocks, never visitor unblock-by-close', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    const closed = await f.service.change(f.owner, 'close', { id: pending.id, revision: pending.revision });
    const blocked = await f.service.change(f.owner, 'block', { id: closed.id, revision: closed.revision });
    expect(blocked.status).toBe('blocked');
    await expect(f.service.change(f.visitor, 'block', { id: blocked.id, revision: blocked.revision })).rejects.toThrow('FORBIDDEN');
    await expect(f.service.change(f.visitor, 'close', { id: blocked.id, revision: blocked.revision })).rejects.toThrow('FORBIDDEN');
    f.advance(31 * 86_400_000);
    await expect(f.request(f.visitor, 2)).rejects.toThrow('FORBIDDEN');
    const restored = await f.restart();
    expect(restored.status(f.visitor).contact?.status).toBe('blocked');
  });
  it('suspends plain forwarding but keeps explicit replies and permits only explicit scoped resume', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    expect(f.service.classify(f.visitor)).toBe('active');
    const notice = await f.transport.notify.mock.results[1]!.value;
    f.service.suspend(context(10, 8)); expect(f.service.classify(f.visitor)).toBe('active');
    f.service.suspend(f.visitor); expect(f.service.classify(f.visitor)).toBe('none');
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('FORBIDDEN');
    expect(f.service.classify(f.visitor, notice)).toBe('reply');
    expect(await f.service.send(f.visitor, f.capture(f.visitor, 3, notice))).toMatchObject({ delivered: true });
    await expect(f.service.resume(f.owner, { id: accepted.id, revision: accepted.revision })).rejects.toThrow('FORBIDDEN');
    await expect(f.service.resume(f.visitor, { id: accepted.id, revision: 0 })).rejects.toThrow('CONFLICT');
    expect(await f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision })).toMatchObject({ routingActive: true });
    f.advance(600_001); expect(f.service.classify(f.visitor)).toBe('blocked');
    expect(f.service.classify(f.visitor, notice)).toBe('reply');
    expect(await f.service.resume(context(10, 9), { id: accepted.id, revision: accepted.revision })).toMatchObject({ routingActive: true });
    const restored = await f.restart();
    expect(restored.classify(f.visitor)).toBe('blocked');
    expect(restored.classify(f.visitor, notice)).toBe('reply');
    expect(await restored.resume(context(10, 9), { id: accepted.id, revision: accepted.revision })).toMatchObject({ routingActive: true });
  });
  it('does not reactivate after another prompt during acceptance or acceptance after restart', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<number>();
    f.transport.notify.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const accept = f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    await entered.promise; f.service.suspend(f.visitor); release.resolve(40_000); await accept;
    expect(f.service.classify(f.visitor)).toBe('none');
    const other = context(11, 9); const otherPending = await f.request(other);
    const restored = await f.restart();
    expect(restored.classify(other)).toBe('blocked');
    await restored.change(f.owner, 'accept', { id: otherPending.id, revision: otherPending.revision });
    expect(restored.classify(other)).toBe('blocked');
  });
  it('persists scoped resume consumption without reactivating duplicates after cancellation or restart', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const input = { id: accepted.id, revision: accepted.revision };
    await f.service.resume(f.visitor, input); await f.service.cancel(f.visitor);
    expect(await f.service.resume(f.visitor, input)).toMatchObject({ routingActive: false });
    const restored = await f.restart();
    expect(await restored.resume(f.visitor, input)).toMatchObject({ routingActive: false });
    for (const caller of [context(11, 9), context(10, 8), context(10, 9, { botId: 999 }), f.owner]) {
      await expect(restored.resume(caller, input)).rejects.toThrow('FORBIDDEN');
    }
    expect(await restored.resume(context(10, 9), input)).toMatchObject({ routingActive: true });
  });
  it('does not resume when consumption cannot be saved or when cancelled during its write', async () => {
    let fail = false; let hold = false;
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture({ beforeCommit: async () => {
      if (fail) throw new Error('Offline storage failure');
      if (hold) { entered.resolve(); await release.promise; }
    } });
    await f.enable(); const accepted = await f.accept(); await f.service.cancel(f.visitor);
    const input = { id: accepted.id, revision: accepted.revision }; fail = true;
    await expect(f.service.resume(f.visitor, input)).rejects.toThrow('STORAGE_ERROR');
    expect(f.service.status(f.visitor).contact?.routingActive).toBe(false);
    fail = false; hold = true;
    const resuming = f.service.resume(context(10, 9), input); const assertion = expect(resuming).rejects.toThrow('CANCELLED');
    await entered.promise; const cancelling = f.service.cancel(f.visitor); release.resolve();
    await assertion; await cancelling;
    expect(f.service.status(f.visitor).contact?.routingActive).toBe(false);
  });
  it('honors routing suspension even before a queued request has committed its new contact', async () => {
    let blocked = false; const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture({ beforeCommit: async () => { if (blocked) { entered.resolve(); await release.promise; } } });
    await f.enable(); blocked = true;
    const request = f.request(); await entered.promise;
    f.service.suspend(f.visitor); release.resolve(); const pending = await request;
    await f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    expect(f.service.classify(f.visitor)).toBe('none');
  });
  it('disable clears temporary modes without transferring the owner or deleting contacts', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    await f.service.configure(f.owner, { enabled: false, revision: 1 });
    expect(f.service.status(f.visitor)).toMatchObject({ available: false, contact: { id: accepted.id, status: 'accepted', routingActive: false } });
    await f.enable(); expect(f.service.classify(f.visitor)).toBe('blocked');
    await f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision }); expect(f.service.classify(f.visitor)).toBe('active');
  });
  it('reserves pending contact messages before acceptance, after expiry and across restart', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    expect(f.service.classify(f.visitor)).toBe('blocked');
    expect(f.service.classify(f.visitor, 90_000)).toBe('blocked');
    expect(f.service.classify(context(10, 8))).toBe('none');
    f.advance(600_001); expect(f.service.classify(f.visitor)).toBe('blocked');
    await f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    expect(f.service.classify(f.visitor)).toBe('blocked');
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('FORBIDDEN');
    const restored = await f.restart(); expect(restored.classify(f.visitor)).toBe('blocked');
    expect(restored.status(f.visitor).contact?.routingActive).toBe(false);
  });
  it('does not promote a pending claim that expires during its acceptance notification', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<number>();
    f.transport.notify.mockImplementationOnce(async () => { entered.resolve(); return release.promise; });
    const accepting = f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    await entered.promise; f.advance(600_001); release.resolve(40_000); await accepting;
    expect(f.service.classify(f.visitor)).toBe('blocked');
  });
  it('keeps an explicit suspension across pruning but forgets it on restart without resuming relay', async () => {
    const f = await fixture(); await f.enable(); await f.accept(); f.service.suspend(f.visitor);
    f.advance(600_001); await f.request(context(11, 9));
    expect(f.service.classify(f.visitor)).toBe('none');
    expect(f.service.classify(f.visitor, 90_000)).toBe('none');
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2, 90_000))).rejects.toThrow('FORBIDDEN');
    await f.service.configure(f.owner, { enabled: false, revision: 1 }); await f.enable();
    expect(f.service.classify(f.visitor)).toBe('none');
    const restored = await f.restart(); expect(restored.classify(f.visitor)).toBe('blocked');
    expect(f.transport.copy).not.toHaveBeenCalled();
  });
  it.each(['accept', 'decline', 'close', 'block'] as const)('uses the persisted visitor language hint for %s notifications', async operation => {
    const f = await fixture(); await f.enable();
    const visitor = context(10, 9, { language: 'ja' }); const pending = await f.request(visitor);
    expect(f.transport.notify.mock.calls[0]?.[0].languageHint).toBeUndefined();
    const restored = await f.restart(); await restored.change(f.owner, operation, { id: pending.id, revision: pending.revision });
    expect(f.transport.notify.mock.calls.at(-1)?.[0]).toMatchObject({ chatId: 10, threadId: 9, languageHint: 'ja' });
  });
  it('does not use the visitor language hint for owner notifications', async () => {
    const f = await fixture(); await f.enable(); const visitor = context(10, 9, { language: 'zh-TW' });
    const accepted = await f.accept(visitor);
    await f.service.change(visitor, 'close', { id: accepted.id, revision: accepted.revision });
    expect(f.transport.notify.mock.calls.at(-1)?.[0]).toEqual({ botId: 12345, chatId: 2, threadId: 7 });
  });
});

describe('relay exact message routing and delivery', () => {
  it('maps both source and destination IDs and never uses a last-contact owner target', async () => {
    const f = await fixture(); await f.enable(); const first = await f.accept();
    const firstHeader = await f.transport.notify.mock.results[0]!.value;
    const second = await f.accept(context(11, 9));
    const secondHeader = await f.transport.notify.mock.results[2]!.value;
    expect(f.service.classify(f.owner)).toBe('blocked');
    f.service.suspend(f.owner); expect(f.service.classify(f.owner)).toBe('none');
    f.service.focus(f.owner); expect(f.service.classify(f.owner)).toBe('blocked');
    await expect(f.service.send(f.owner, f.capture(f.owner, 100))).rejects.toThrow('FORBIDDEN');
    expect(await f.service.send(f.owner, f.capture(f.owner, 101, firstHeader))).toMatchObject({ id: first.id });
    expect(f.transport.copy.mock.calls.at(-1)?.[1]).toEqual({ botId: 12345, chatId: 10, threadId: 9, replyTo: 1 });
    const delivered = await f.transport.copy.mock.results.at(-1)!.value;
    expect(f.service.classify(f.owner, 101)).toBe('reply');
    expect(f.service.classify(f.visitor, delivered)).toBe('reply');
    expect(await f.service.send(f.owner, f.capture(f.owner, 102, secondHeader))).toMatchObject({ id: second.id });
    expect(f.transport.copy.mock.calls.at(-1)?.[1].chatId).toBe(11);
    f.service.suspend(f.visitor);
    expect(await f.service.send(f.visitor, f.capture(f.visitor, 2, delivered))).toMatchObject({ id: first.id });
    expect(f.transport.copy.mock.calls.at(-1)?.[1]).toEqual({ botId: 12345, chatId: 2, threadId: 7, replyTo: 101,
      contact: { id: first.id, name: 'Visitor 10' } });
    expect(f.service.classify(context(11, 9), delivered)).toBe('blocked');
    await expect(f.service.send(context(11, 9), f.capture(context(11, 9), 2, delivered))).rejects.toThrow('FORBIDDEN');
    await expect(f.service.send(context(2, 8), f.capture(context(2, 8), 103, firstHeader))).rejects.toThrow('FORBIDDEN');
    await expect(f.service.send(context(2, 7, { botId: 999 }), f.capture(context(2, 7, { botId: 999 }), 104, firstHeader))).rejects.toThrow('FORBIDDEN');
    await f.service.change(f.owner, 'close', { id: first.id, revision: first.revision });
    expect(f.service.classify(f.owner, firstHeader)).toBe('blocked');
    await expect(f.service.send(f.owner, f.capture(f.owner, 105, firstHeader))).rejects.toThrow('FORBIDDEN');
  });
  it('binds opaque captures to all scopes, rejects changed capture content and expires them', async () => {
    const f = await fixture(); await f.enable(); await f.accept(); const source = f.capture(f.visitor, 2);
    expect(source).toMatch(/^[a-f0-9]{24}$/); expect(f.capture(f.visitor, 2)).toBe(source);
    expect(() => f.capture(f.visitor, 2, 55)).toThrow('CONFLICT');
    for (const caller of [context(11, 9), context(10, 8), context(10, 9, { botId: 999 })]) {
      await expect(f.service.send(caller, source)).rejects.toThrow('FORBIDDEN');
    }
    expect(() => f.capture(f.visitor, 3, undefined, { sentAt: f.now() - 300_001 })).toThrow('INVALID_INPUT');
    expect(() => f.capture(f.visitor, 3, undefined, { sentAt: f.now() + 60_001 })).toThrow('INVALID_INPUT');
    f.advance(120_001); await expect(f.service.send(f.visitor, source)).rejects.toThrow('NOT_FOUND');
    expect(f.transport.copy).not.toHaveBeenCalled();
  });
  it('persists attempts before effects and deduplicates acknowledged copies across restart', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    f.transport.copy.mockImplementationOnce(async () => {
      const state = await f.disk(); expect(state.attempts).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'attempted' })])); return 80_000;
    });
    const source = f.capture(f.visitor, 2);
    expect(await f.service.send(f.visitor, source)).toMatchObject({ replayed: false });
    expect(await f.service.send(f.visitor, source)).toMatchObject({ replayed: true });
    const restored = await f.restart();
    await restored.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    const recaptured = restored.capture(f.visitor, { messageId: 2, sentAt: f.now(), name: 'Visitor 10' });
    expect(await restored.send(f.visitor, recaptured)).toMatchObject({ replayed: true });
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
    expect(restored.ownsMessage(f.visitor, 2)).toBe(true);
    for (const caller of [context(11, 9), context(10, 8), context(10, 9, { botId: 999 }), f.owner]) {
      expect(restored.ownsMessage(caller, 2)).toBe(false);
    }
    const state = await f.disk();
    expect(JSON.stringify(state)).not.toMatch(/caption|file_id|token|sourceRef|body|binary/);
    expect(state.mappings).toEqual(expect.arrayContaining([
      expect.objectContaining({ messageId: 2, peerMessageId: 80_000 }), expect.objectContaining({ messageId: 80_000, peerMessageId: 2 }),
    ]));
  });
  it.each([[400, 'INVALID_INPUT'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [429, 'RATE_LIMITED']] as const)(
    'records definite %s failures without retries', async (status, code) => {
      const f = await fixture(); await f.enable(); await f.accept();
      f.transport.copy.mockRejectedValueOnce(new RelayTransportError(status)); const source = f.capture(f.visitor, 2);
      await expect(f.service.send(f.visitor, source)).rejects.toThrow(code);
      await expect(f.service.send(f.visitor, source)).rejects.toThrow(code);
      expect(f.transport.copy).toHaveBeenCalledTimes(1);
      expect((await f.disk()).attempts).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'failed', error: code })]));
    });
  it.each([new Error('socket lost'), new RelayTransportError(500), new DOMException('aborted', 'AbortError')])(
    'never blindly replays an uncertain external copy: %s', async error => {
      const f = await fixture(); await f.enable(); const accepted = await f.accept();
      f.transport.copy.mockRejectedValueOnce(error); const source = f.capture(f.visitor, 2);
      await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN');
      await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN');
      const restored = await f.restart(); await restored.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
      const recaptured = restored.capture(f.visitor, { messageId: 2, sentAt: f.now(), name: 'Visitor 10' });
      await expect(restored.send(f.visitor, recaptured)).rejects.toThrow('OUTCOME_UNKNOWN');
      expect(f.transport.copy).toHaveBeenCalledTimes(1);
    });
  it('persists ambiguous request and acceptance notifications without replaying them', async () => {
    const f = await fixture(); await f.enable(); f.transport.notify.mockRejectedValueOnce(new Error('uncertain request'));
    await expect(f.request()).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(f.request(f.visitor, 2)).rejects.toThrow('OUTCOME_UNKNOWN');
    const pending = f.service.status(f.visitor).contact!;
    f.transport.notify.mockRejectedValueOnce(new Error('uncertain acceptance'));
    const mutation = { id: pending.id, revision: pending.revision };
    await expect(f.service.change(f.owner, 'accept', mutation)).rejects.toThrow('OUTCOME_UNKNOWN');
    await expect(f.service.change(f.owner, 'accept', mutation)).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.service.status(f.visitor).contact?.status).toBe('accepted');
    expect(f.transport.notify).toHaveBeenCalledTimes(2);
    const restored = await f.restart();
    await expect(restored.change(f.owner, 'accept', mutation)).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.notify).toHaveBeenCalledTimes(2);
  });
  it('retains definite copy failures after restart and rejects malformed acknowledgements as uncertain', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    f.transport.copy.mockRejectedValueOnce(new RelayTransportError(403));
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('FORBIDDEN');
    f.transport.copy.mockResolvedValueOnce(0);
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 3))).rejects.toThrow('OUTCOME_UNKNOWN');
    const restored = await f.restart(); await restored.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    for (const [messageId, code] of [[2, 'FORBIDDEN'], [3, 'OUTCOME_UNKNOWN']] as const) {
      const source = restored.capture(f.visitor, { messageId, sentAt: f.now(), name: 'Visitor 10' });
      await expect(restored.send(f.visitor, source)).rejects.toThrow(code);
    }
    expect(f.transport.copy).toHaveBeenCalledTimes(2);
  });
  it('records request notification rejection and does not resend it after restart', async () => {
    const f = await fixture(); await f.enable(); f.transport.notify.mockRejectedValueOnce(new RelayTransportError(403));
    await expect(f.request()).rejects.toThrow('FORBIDDEN');
    const restored = await f.restart();
    const source = restored.capture(f.visitor, { messageId: 2, sentAt: f.now(), name: 'Visitor 10' });
    await expect(restored.request(f.visitor, source)).rejects.toThrow('FORBIDDEN');
    expect(f.transport.notify).toHaveBeenCalledTimes(1);
    expect(restored.status(f.visitor).contact?.status).toBe('pending');
  });
  it('does not overwrite an existing per-message mapping with a conflicting acknowledgement', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const header = await f.transport.notify.mock.results[0]!.value;
    f.transport.copy.mockResolvedValueOnce(header);
    const before = (await f.disk()).mappings;
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('OUTCOME_UNKNOWN');
    expect((await f.disk()).mappings).toEqual(before);
  });
});

describe('relay durable failures and bounded lifetimes', () => {
  it('preserves state on pre-send storage failure and never performs the external send', async () => {
    let fail = false;
    const f = await fixture({ beforeCommit: async () => { if (fail) throw new Error('disk failure'); } });
    await f.enable(); await f.accept(); const before = await readFile(join(f.directory, 'relay.json'), 'utf8'); fail = true;
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('STORAGE_ERROR');
    expect(f.transport.copy).not.toHaveBeenCalled(); expect(await readFile(join(f.directory, 'relay.json'), 'utf8')).toBe(before);
    expect(f.service.status(f.visitor).contact?.status).toBe('accepted');
  });
  it('returns OUTCOME_UNKNOWN on acknowledgement-write failure while preserving the attempt marker', async () => {
    let fail = false;
    const f = await fixture({ beforeCommit: async () => { if (fail) throw new Error('ack disk failure'); } });
    await f.enable(); const accepted = await f.accept();
    f.transport.copy.mockImplementationOnce(async () => { fail = true; return 88_888; }); const source = f.capture(f.visitor, 2);
    await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN'); fail = false;
    await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
    const restored = await f.restart(); await restored.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    await expect(restored.send(f.visitor, restored.capture(f.visitor, { messageId: 2, sentAt: f.now(), name: 'Visitor 10' }))).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
  });
  it.each(['{"schema_version":99,"revision":0}', '{broken json', '{"schema_version":1,"revision":0,"enabled":true}'])(
    'refuses corrupt or unknown-version data without resetting its bytes', async content => {
      const f = await fixture(); await f.service.stop();
      await writeFile(join(f.directory, 'relay.json'), content);
      const restored = new RelayService(f.storage, f.options); cleanup.push(() => restored.stop());
      await expect(restored.initialize()).rejects.toThrow('STORAGE_ERROR');
      expect(await readFile(join(f.directory, 'relay.json'), 'utf8')).toBe(content);
    });
  it('bounds captures and rate limits messages before transport work', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    for (let id = 2; id <= 21; id++) await f.service.send(f.visitor, f.capture(f.visitor, id));
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 22))).rejects.toThrow('RATE_LIMITED');
    expect(f.transport.copy).toHaveBeenCalledTimes(20);
    for (let id = 23; id <= 64; id++) f.capture(f.visitor, id);
    expect(() => f.capture(f.visitor, 65)).toThrow('CAPACITY');
    f.advance(120_001); expect(f.capture(f.visitor, 65)).toMatch(/^[a-f0-9]{24}$/);
  });
  it.each(['attempts', 'mappings', 'contacts'] as const)('fails closed at the persisted %s bound before any external effect', async collection => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const state = await f.disk(); await f.service.stop();
    if (collection === 'attempts') state.attempts = Array.from({ length: 2_048 }, (_, i) => ({
      key: `fixture:${i}`, contactId: accepted.id, status: 'attempted', expires: f.now() + 100_000,
    }));
    if (collection === 'mappings') state.mappings = Array.from({ length: 4_096 }, (_, i) => ({
      contactId: accepted.id, scope: { botId: 12345, userId: 10, chatId: 10, threadId: 9 }, messageId: 20_000 + i, expires: f.now() + 100_000,
    }));
    if (collection === 'contacts') {
      const original = (state.contacts as Record<string, unknown>[])[0]!;
      state.contacts = [original, ...Array.from({ length: 255 }, (_, i) => ({ ...original,
        id: i.toString(16).padStart(24, '0'), visitor: { botId: 12345, userId: 1_000 + i, chatId: 1_000 + i, threadId: 9 },
      }))];
    }
    const bytes = JSON.stringify(state); await writeFile(join(f.directory, 'relay.json'), bytes);
    const restored = new RelayService(f.storage, f.options); await restored.initialize(); cleanup.push(() => restored.stop());
    if (collection === 'contacts') {
      const other = context(99, 9);
      const source = restored.capture(other, { messageId: 1, sentAt: f.now(), name: 'Other visitor' });
      await expect(restored.request(other, source)).rejects.toThrow('CAPACITY');
    } else {
      const replyToMessageId = collection === 'mappings' ? 20_000 : await f.transport.notify.mock.results[1]!.value;
      const source = restored.capture(f.visitor, { messageId: 2, replyToMessageId, sentAt: f.now(), name: 'Visitor 10' });
      await expect(restored.send(f.visitor, source)).rejects.toThrow('CAPACITY');
    }
    expect(f.transport.copy).not.toHaveBeenCalled(); expect(f.transport.notify).toHaveBeenCalledTimes(2);
    expect(await readFile(join(f.directory, 'relay.json'), 'utf8')).toBe(bytes);
  });
  it('prunes terminal contact metadata after its retention TTL but preserves blocked contacts', async () => {
    const f = await fixture(); await f.enable(); const first = await f.request();
    await f.service.change(f.owner, 'close', { id: first.id, revision: first.revision });
    const second = await f.request(context(11, 9));
    await f.service.change(f.owner, 'block', { id: second.id, revision: second.revision });
    f.advance(31 * 86_400_000); await f.request(context(12, 9));
    expect(f.service.status(f.visitor).contact).toBeNull();
    expect(f.service.status(context(11, 9)).contact?.status).toBe('blocked');
    expect(f.service.list(f.owner).items).toHaveLength(2);
  });
  it('expires reply mappings and rejects old updates even after dedupe metadata is pruned', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const header = await f.transport.notify.mock.results[0]!.value;
    await f.service.send(f.visitor, f.capture(f.visitor, 2)); const oldDate = f.now();
    f.advance(7 * 86_400_000 + 1);
    expect(f.service.classify(f.owner, header)).toBe('blocked');
    await expect(f.service.send(f.owner, f.capture(f.owner, 100, header))).rejects.toThrow('FORBIDDEN');
    expect(() => f.capture(f.visitor, 2, undefined, { sentAt: oldDate })).toThrow('INVALID_INPUT');
    await f.request(context(11, 9));
    await f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    await expect(f.service.send(f.visitor, f.capture(f.visitor, 2))).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
  });
  it('aborts and drains actual sends and their durable acknowledgement before stop resolves', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<number>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => { entered.resolve(signal); return release.promise; });
    const sending = f.service.send(f.visitor, f.capture(f.visitor, 2)); const assertion = expect(sending).rejects.toThrow('OUTCOME_UNKNOWN');
    const signal = await entered.promise; let stopped = false;
    const stop = f.service.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(signal.aborted).toBe(true); expect(stopped).toBe(false);
    release.resolve(99_999); await assertion; await stop;
    expect((await f.disk()).mappings).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: 99_999 })]));
    await expect(f.service.resume(f.visitor, { id: 'a'.repeat(24), revision: 0 })).rejects.toThrow('CANCELLED');
  });
  it('cancels queued work before any send and retains an in-flight uncertain attempt', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.transport.copy.mockImplementationOnce(async () => { entered.resolve(); await release.promise; throw new Error('aborted network'); });
    const first = f.service.send(f.visitor, f.capture(f.visitor, 2)); const firstAssertion = expect(first).rejects.toThrow('OUTCOME_UNKNOWN');
    await entered.promise;
    const second = f.service.send(f.visitor, f.capture(f.visitor, 3)); const secondAssertion = expect(second).rejects.toThrow('CANCELLED');
    const stop = f.service.stop(); release.resolve(); await firstAssertion; await secondAssertion; await stop;
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
  });
  it('propagates caller abort without stopping other callers or retrying their uncertain send', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const controller = new AbortController(); const caller = context(10, 9, { signal: controller.signal });
    const entered = Promise.withResolvers<AbortSignal>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => {
      entered.resolve(signal);
      await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return 88_888;
    });
    const source = f.capture(f.visitor, 2);
    const sending = f.service.send(caller, source); const assertion = expect(sending).rejects.toThrow('OUTCOME_UNKNOWN');
    const signal = await entered.promise; controller.abort(); await assertion; expect(signal.aborted).toBe(true);
    await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(await f.service.send(f.visitor, f.capture(f.visitor, 3))).toMatchObject({ delivered: true });
    expect(f.transport.copy).toHaveBeenCalledTimes(2);
  });
});

describe('scoped relay cancellation', () => {
  it('pauses an accepted or pending routing claim without closing or changing persisted contacts', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const bytes = await readFile(join(f.directory, 'relay.json'), 'utf8');
    expect(await f.service.cancel(f.visitor)).toBe(true);
    expect(f.service.classify(f.visitor)).toBe('none');
    expect(f.service.status(f.visitor).contact).toMatchObject({ id: accepted.id, revision: accepted.revision, status: 'accepted', routingActive: false });
    expect(await f.service.cancel(f.visitor)).toBe(false);
    expect(await readFile(join(f.directory, 'relay.json'), 'utf8')).toBe(bytes);
    const other = context(11, 9); const pending = await f.request(other);
    expect(await f.service.cancel(other)).toBe(true);
    await f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    expect(f.service.classify(other)).toBe('none');
  });
  it('aborts and drains only the exact scope, preserving uncertain sends without retry', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept(); const other = context(11, 9); await f.accept(other);
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<void>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => {
      entered.resolve(signal); await release.promise; throw new Error('aborted network');
    });
    const source = f.capture(f.visitor, 2);
    const sending = f.service.send(f.visitor, source); const sentAssertion = expect(sending).rejects.toThrow('OUTCOME_UNKNOWN');
    const signal = await entered.promise;
    for (const caller of [context(12, 9), context(10, 8), context(10, 9, { botId: 999 }), f.owner]) {
      expect(await f.service.cancel(caller)).toBe(false); expect(signal.aborted).toBe(false);
    }
    const queued = f.service.send(f.visitor, f.capture(f.visitor, 3)); const queuedAssertion = expect(queued).rejects.toThrow('CANCELLED');
    const otherSend = f.service.send(other, f.capture(other, 2)); let cancelled = false;
    const cancel = f.service.cancel(f.visitor).then(result => { cancelled = true; return result; });
    await queuedAssertion; expect(signal.aborted).toBe(true); expect(cancelled).toBe(false);
    expect(f.service.classify(f.visitor)).toBe('none'); expect(f.service.classify(other)).toBe('active');
    release.resolve(); await sentAssertion; expect(await cancel).toBe(true);
    expect(await otherSend).toMatchObject({ delivered: true });
    expect(f.transport.copy).toHaveBeenCalledTimes(2);
    expect(f.service.status(f.visitor).contact).toMatchObject({ status: 'accepted', revision: accepted.revision });
    await f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    await expect(f.service.send(f.visitor, source)).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.copy).toHaveBeenCalledTimes(2);
  });
  it('cancels queued work without waiting for or aborting a foreign in-flight copy', async () => {
    const f = await fixture(); await f.enable(); await f.accept(); const other = context(11, 9); await f.accept(other);
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<number>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => { entered.resolve(signal); return release.promise; });
    const sending = f.service.send(other, f.capture(other, 2)); const signal = await entered.promise;
    const queued = f.service.send(f.visitor, f.capture(f.visitor, 2)); const assertion = expect(queued).rejects.toThrow('CANCELLED');
    expect(await f.service.cancel(f.visitor)).toBe(true); await assertion;
    expect(signal.aborted).toBe(false); expect(f.transport.copy).toHaveBeenCalledTimes(1);
    release.resolve(40_000); expect(await sending).toMatchObject({ delivered: true });
    expect((await f.disk()).attempts).not.toEqual(expect.arrayContaining([expect.objectContaining({ key: 'copy:12345:10:10:9:2' })]));
  });
  it('keeps cancellation available at task capacity while retaining bounded cancelled queue slots', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept(); const other = context(11, 9); await f.accept(other);
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<number>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => { entered.resolve(signal); return release.promise; });
    const sending = f.service.send(other, f.capture(other, 2)); const signal = await entered.promise;
    const queued = Array.from({ length: 31 }, (_, index) => {
      const task = f.service.send(f.visitor, f.capture(f.visitor, index + 2)); return expect(task).rejects.toThrow('CANCELLED');
    });
    await expect(f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision })).rejects.toThrow('CAPACITY');
    expect(await f.service.cancel(f.visitor)).toBe(true); await Promise.all(queued);
    expect(await f.service.cancel(f.visitor)).toBe(false); expect(signal.aborted).toBe(false);
    await expect(f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision })).rejects.toThrow('CAPACITY');
    release.resolve(40_000); await sending;
    await f.service.stop(); expect(f.transport.copy).toHaveBeenCalledTimes(1);
  });
  it('awaits acknowledgement persistence after cancelling a copy that still returns a message ID', async () => {
    let holdAck = false; const ackEntered = Promise.withResolvers<void>(); const ackRelease = Promise.withResolvers<void>();
    const f = await fixture({ beforeCommit: async () => { if (holdAck) { ackEntered.resolve(); await ackRelease.promise; } } });
    await f.enable(); const accepted = await f.accept();
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<void>();
    f.transport.copy.mockImplementationOnce(async (_source, _target, signal) => { entered.resolve(signal); await release.promise; holdAck = true; return 50_000; });
    const source = f.capture(f.visitor, 2); const sending = f.service.send(f.visitor, source);
    const assertion = expect(sending).rejects.toThrow('OUTCOME_UNKNOWN'); const signal = await entered.promise;
    let cancelled = false; const cancel = f.service.cancel(f.visitor).then(result => { cancelled = true; return result; });
    release.resolve(); await ackEntered.promise; expect(signal.aborted).toBe(true); expect(cancelled).toBe(false);
    ackRelease.resolve(); await assertion; expect(await cancel).toBe(true); holdAck = false;
    expect((await f.disk()).mappings).toEqual(expect.arrayContaining([expect.objectContaining({ messageId: 50_000 })]));
    await f.service.resume(f.visitor, { id: accepted.id, revision: accepted.revision });
    expect(await f.service.send(f.visitor, source)).toMatchObject({ delivered: true, replayed: true });
    expect(f.transport.copy).toHaveBeenCalledTimes(1);
  });
  it('cancels a request before its first commit without notifying or claiming rollback of a send', async () => {
    let hold = false; const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture({ beforeCommit: async () => { if (hold) { entered.resolve(); await release.promise; } } });
    await f.enable(); const bytes = await readFile(join(f.directory, 'relay.json'), 'utf8'); hold = true;
    const request = f.request(); const assertion = expect(request).rejects.toThrow('CANCELLED'); await entered.promise;
    const cancel = f.service.cancel(f.visitor); release.resolve(); await assertion; expect(await cancel).toBe(true);
    expect(f.transport.notify).not.toHaveBeenCalled(); expect(f.service.status(f.visitor).contact).toBeNull();
    expect(await readFile(join(f.directory, 'relay.json'), 'utf8')).toBe(bytes);
  });
  it('pauses a visitor during owner acceptance without cancelling the owner notification or promoting its claim', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<number>();
    f.transport.notify.mockImplementationOnce(async (_target, _notice, signal) => { entered.resolve(signal); return release.promise; });
    const accepting = f.service.change(f.owner, 'accept', { id: pending.id, revision: pending.revision });
    const signal = await entered.promise; expect(await f.service.cancel(f.visitor)).toBe(true);
    expect(signal.aborted).toBe(false); release.resolve(40_000); expect(await accepting).toMatchObject({ status: 'accepted' });
    expect(f.service.classify(f.visitor)).toBe('none');
  });
});
