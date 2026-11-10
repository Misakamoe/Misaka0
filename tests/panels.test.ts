import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelStore, type PanelBinding } from '../src/telegram/panels.js';

type Value = { kind: string; revision?: number; secret?: string };
const binding: PanelBinding = {
  key: '100:-200:300:4', botId: 100, chatId: -200, userId: 300, threadId: 4, language: 'en',
};
const callback = { ...binding, messageId: 42 };
const stores: PanelStore<Value>[] = [];
const releases: (() => void)[] = [];

function makeStore(options: Partial<ConstructorParameters<typeof PanelStore<Value>>[0]> = {}) {
  const store = new PanelStore<Value>({ onClose: async () => {}, ...options });
  stores.push(store);
  return store;
}

function deferred() {
  const result = Promise.withResolvers<void>();
  releases.push(result.resolve);
  return result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000);
});

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await Promise.all(stores.splice(0).map(store => store.stop()));
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});

describe('server-owned Telegram panels', () => {
  it('is idle until creation and uses opaque IDs, a ten-minute TTL, and one timer', () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    const first = store.create(binding, { kind: 'commands', secret: 'server-only' });
    const second = store.create(binding, { kind: 'settings' });
    expect(first.id).toMatch(/^[a-f0-9]{24}$/);
    expect(second.id).not.toBe(first.id);
    expect(first.id).not.toContain(binding.key);
    expect(first.expiresAt).toBe(601_000);
    expect(first.value.secret).toBe('server-only');
    expect(store.size).toBe(2);
    expect(vi.getTimerCount()).toBe(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid TTL/capacity %s', value => {
    expect(() => makeStore({ ttlMs: value })).toThrow('INVALID_INPUT');
    expect(() => makeStore({ capacity: value })).toThrow('INVALID_INPUT');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid expiration %s', expiresAt => {
    expect(() => makeStore().create(binding, { kind: 'settings' }, expiresAt)).toThrow('INVALID_INPUT');
  });

  it('snapshots immutable ownership but keeps server-only values mutable', async () => {
    const store = makeStore();
    const source = { ...binding };
    const panel = store.create(source, { kind: 'settings', revision: 1 });
    source.userId = 999;
    source.key = 'forged';
    expect(Object.isFrozen(panel.binding)).toBe(true);
    await store.attach(panel, 42);
    panel.value.revision = 2;
    expect(store.get(panel.id, callback)).toBe(panel);
    expect(store.get(panel.id, callback).value.revision).toBe(2);
    // A locale change does not transfer ownership or invalidate a message.
    expect(store.get(panel.id, { ...callback, language: 'zh-CN' })).toBe(panel);
  });

  it.each([
    { key: 'forged-owner' }, { botId: 101 }, { chatId: -201 }, { userId: 301 },
    { threadId: 5 }, { threadId: undefined }, { messageId: 43 },
  ])('rejects mismatched callback binding %j without consuming the panel', async mismatch => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    expect(() => store.get(panel.id, { ...callback, ...mismatch })).toThrow('FORBIDDEN');
    expect(store.get(panel.id, callback)).toBe(panel);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('cannot use an unattached message or an unknown/foreign panel object', async () => {
    const store = makeStore();
    const panel = store.create(binding, { kind: 'settings' });
    expect(() => store.get(panel.id, callback)).toThrow('FORBIDDEN');
    expect(() => store.get('0'.repeat(24), callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(() => store.render({ ...panel }, async () => {})).toThrow('FORBIDDEN');
    expect(() => makeStore().close(panel, 'used')).toThrow('FORBIDDEN');
    await expect(store.attach({ ...panel }, 42)).rejects.toThrow('FORBIDDEN');
  });
  it('only permits cross-owner reads when explicitly allowed, without changing ownership', async () => {
    const store = makeStore();
    const panel = store.create(binding, { kind: 'weather' });
    await store.attach(panel, 42);
    const other = { ...callback, userId: 301, key: '100:-200:301:4' };
    expect(() => store.get(panel.id, other)).toThrow('FORBIDDEN');
    expect(() => store.get(panel.id, other, () => false)).toThrow('FORBIDDEN');
    expect(store.get(panel.id, other, value => value.kind === 'weather')).toBe(panel);
    expect(panel.binding.userId).toBe(300);
    expect(store.get(panel.id, callback)).toBe(panel);
    expect(() => store.get(panel.id, { ...callback, key: 'forged-owner' }, () => true)).toThrow('FORBIDDEN');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(() => store.get(panel.id, other, () => true)).toThrow('CONFIRMATION_EXPIRED');
  });
  it.each([{ botId: 101 }, { chatId: -201 }, { threadId: 5 }, { threadId: undefined }, { messageId: 43 }])('never shares across a mismatched message namespace %j', async mismatch => {
    const store = makeStore();
    const panel = store.create(binding, { kind: 'weather' });
    await store.attach(panel, 42);
    const allow = vi.fn(() => true);
    expect(() => store.get(panel.id, { ...callback, key: '100:-200:301:4', userId: 301, ...mismatch }, allow)).toThrow('FORBIDDEN');
    expect(allow).not.toHaveBeenCalled();
  });

  it('protects live messages from unknown callback IDs within their bot/chat namespace', async () => {
    const store = makeStore({ ttlMs: 10 });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    expect(() => store.get('mk:ui:unknown:page:0', callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(store.hasMessage(100, -200, 42)).toBe(true);
    expect(store.hasMessage(101, -200, 42)).toBe(false);
    expect(store.hasMessage(100, -201, 42)).toBe(false);
    expect(store.hasMessage(100, -200, 43)).toBe(false);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.hasMessage(100, -200, 42)).toBe(false);
  });

  it('attaches idempotently but does not rebind to another message or duplicate a live message', async () => {
    const store = makeStore();
    const first = store.create(binding, { kind: 'settings' });
    const second = store.create(binding, { kind: 'commands' });
    await store.attach(first, 42);
    await store.attach(first, 42);
    await expect(store.attach(first, 43)).rejects.toThrow('FORBIDDEN');
    await expect(store.attach(second, 42)).rejects.toThrow('FORBIDDEN');
    await store.attach(second, 43);
    expect(store.get(first.id, callback)).toBe(first);
    expect(store.get(second.id, { ...callback, messageId: 43 })).toBe(second);
    const anotherBot = store.create({ ...binding, botId: 101, key: '101:-200:300:4' }, { kind: 'settings' });
    await store.attach(anotherBot, 42);
    expect(store.hasMessage(101, -200, 42)).toBe(true);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid message ID %s', async messageId => {
    const store = makeStore();
    const panel = store.create(binding, { kind: 'settings' });
    await expect(store.attach(panel, messageId)).rejects.toThrow('INVALID_INPUT');
    expect(panel.messageId).toBeUndefined();
  });

  it('expires without clicks and reschedules the single nearest-deadline timer', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 30, onClose });
    const later = store.create(binding, { kind: 'commands' });
    const earlier = store.create(binding, { kind: 'settings' }, 1_010);
    await store.attach(later, 42);
    await store.attach(earlier, 43);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(9);
    expect(onClose).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(earlier, 'expired');
    expect(store.size).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(20);
    expect(onClose).toHaveBeenLastCalledWith(later, 'expired');
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps explicitly read-only views usable without a deadline or timer', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'commands' }, null);
    await store.attach(panel, 42);
    expect(panel.expiresAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000);
    expect(store.get(panel.id, callback)).toBe(panel);
    expect(() => store.get(panel.id, { ...callback, userId: 301 })).toThrow('FORBIDDEN');
    expect(await store.render(panel, async () => {})).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    await store.close(panel, 'cancelled');
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'cancelled');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still expires forms beside a read-only view and removes the last deadline timer', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 10, onClose });
    const view = store.create(binding, { kind: 'commands' }, null);
    const form = store.create(binding, { kind: 'settings' });
    await store.attach(view, 42);
    await store.attach(form, 43);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.size).toBe(1);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(form, 'expired');
    expect(store.get(view.id, callback)).toBe(view);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rechecks a supplied clock even before the timer has fired', async () => {
    let now = 50;
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 10, now: () => now, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    now = 60;
    expect(() => store.get(panel.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    await store.close(panel, 'used');
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'expired');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles deadlines beyond the Node timer limit without a tight loop', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'settings' }, 1_000 + 2_147_483_647 + 10);
    await store.attach(panel, 42);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(store.get(panel.id, callback)).toBe(panel);
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'expired');
  });

  it.each(['expired', 'cancelled', 'replaced'] as const)('cleans a late-delivered message after %s without resurrection', async reason => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 10, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(10);
    else await store.close(panel, reason);
    expect(onClose).not.toHaveBeenCalled();
    expect(store.size).toBe(0);
    await store.attach(panel, 42);
    await store.attach(panel, 42);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, reason);
    expect(panel.messageId).toBe(42);
    expect(() => store.get(panel.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows an already-expired pending send without allocating a live entry or timer', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'settings' }, 999);
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await store.attach(panel, 42);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'expired');
  });

  it('invalidates synchronously and makes repeated close await the same cleanup', async () => {
    const started = deferred();
    const gate = deferred();
    const onClose = vi.fn(async () => { started.resolve(); await gate.promise; });
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    const closing = store.close(panel, 'used');
    expect(() => store.get(panel.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(store.hasMessage(100, -200, 42)).toBe(false);
    const repeated = store.close(panel, 'cancelled');
    expect(repeated).toBe(closing);
    let finished = false;
    void closing.then(() => { finished = true; });
    await started.promise;
    expect(finished).toBe(false);
    gate.resolve();
    await closing;
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'used');
  });

  it('closes all matching owned panels synchronously without crossing session or type boundaries', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const first = store.create(binding, { kind: 'settings' });
    const second = store.create(binding, { kind: 'settings' });
    const commands = store.create(binding, { kind: 'commands' });
    const other = store.create({ ...binding, key: '100:-200:301:4', userId: 301 }, { kind: 'settings' });
    await Promise.all([first, second, commands, other].map((panel, index) => store.attach(panel, 42 + index)));
    const closing = store.closeOwned(binding.key, 'replaced', panel => panel.value.kind === 'settings');
    expect(store.size).toBe(2);
    expect(() => store.get(first.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(() => store.get(second.id, { ...callback, messageId: 43 })).toThrow('CONFIRMATION_EXPIRED');
    await closing;
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(store.get(commands.id, { ...callback, messageId: 44 })).toBe(commands);
    expect(store.get(other.id, { ...other.binding, messageId: 45 })).toBe(other);
    await store.closeOwned(binding.key, 'cancelled');
    expect(store.size).toBe(1);
    expect(onClose).toHaveBeenLastCalledWith(commands, 'cancelled');
  });

  it('rejects capacity overflow without evicting live panels and releases capacity on close or expiry', async () => {
    const store = makeStore({ ttlMs: 10, capacity: 2 });
    const first = store.create(binding, { kind: 'settings' });
    const second = store.create(binding, { kind: 'commands' });
    expect(() => store.create(binding, { kind: 'third' })).toThrow('CAPACITY');
    expect(store.size).toBe(2);
    await store.attach(first, 42);
    expect(store.get(first.id, callback)).toBe(first);
    await store.close(second, 'cancelled');
    store.create(binding, { kind: 'replacement' });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(store.size).toBe(0);
    expect(() => store.create(binding, { kind: 'new' })).not.toThrow();
  });

  it('enforces the default capacity of 1000 with only one owned timer', () => {
    const store = makeStore();
    for (let index = 0; index < 1_000; index++) store.create(binding, { kind: 'commands' });
    expect(store.size).toBe(1_000);
    expect(vi.getTimerCount()).toBe(1);
    expect(() => store.create(binding, { kind: 'overflow' })).toThrow('CAPACITY');
  });

  it('bounds read-only views by replacing the least recently used view, never a live form', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ capacity: 3, onClose });
    const form = store.create(binding, { kind: 'settings' });
    const first = store.create(binding, { kind: 'commands' }, null);
    const second = store.create(binding, { kind: 'commands' }, null);
    await store.attach(form, 42);
    await store.attach(first, 43);
    await store.attach(second, 44);
    store.get(first.id, { ...callback, messageId: 43 });
    expect(() => store.get(second.id, { ...callback, messageId: 44, userId: 301 })).toThrow('FORBIDDEN');
    const next = store.create(binding, { kind: 'commands' }, null);
    await store.attach(next, 45);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(second, 'replaced');
    expect(() => store.get(second.id, { ...callback, messageId: 44 })).toThrow('CONFIRMATION_EXPIRED');
    expect(store.get(form.id, callback)).toBe(form);
    expect(store.get(first.id, { ...callback, messageId: 43 })).toBe(first);
    expect(store.get(next.id, { ...callback, messageId: 45 })).toBe(next);
    expect(store.size).toBe(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('makes room for approvals by evicting only read-only views', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ capacity: 2, onClose });
    const view = store.create(binding, { kind: 'commands' }, null);
    const form = store.create(binding, { kind: 'settings' });
    await store.attach(view, 42);
    await store.attach(form, 43);
    const approval = store.create(binding, { kind: 'approval' });
    await store.attach(approval, 44);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(view, 'replaced');
    expect(store.get(form.id, { ...callback, messageId: 43 })).toBe(form);
    expect(store.get(approval.id, { ...callback, messageId: 44 })).toBe(approval);
    expect(() => store.create(binding, { kind: 'commands' }, null)).toThrow('CAPACITY');
  });
});

describe('panel UI ordering and shutdown', () => {
  it('serializes edits per panel but does not block unrelated messages', async () => {
    const store = makeStore();
    const first = store.create(binding, { kind: 'settings' });
    const other = store.create(binding, { kind: 'commands' });
    const started = deferred();
    const gate = deferred();
    const events: string[] = [];
    const one = store.render(first, async () => { started.resolve(); await gate.promise; events.push('one'); });
    await started.promise;
    const two = store.render(first, async () => { events.push('two'); });
    expect(await store.render(other, async () => { events.push('other'); })).toBe(true);
    expect(events).toEqual(['other']);
    gate.resolve();
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(events).toEqual(['other', 'one', 'two']);
  });

  it.each(['expired', 'used', 'cancelled', 'replaced'] as const)('keeps the disabled %s update after an already-in-flight render', async reason => {
    const events: string[] = [];
    const onClose = vi.fn(async () => { events.push('disabled'); });
    const store = makeStore({ ttlMs: 10, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    const started = deferred();
    const gate = deferred();
    const rendering = store.render(panel, async () => { started.resolve(); await gate.promise; events.push('active'); });
    await started.promise;
    const skipped = vi.fn(async () => { events.push('must-not-render'); });
    const queued = store.render(panel, skipped);
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(10);
    else void store.close(panel, reason);
    expect(() => store.get(panel.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve();
    expect(await rendering).toBe(true);
    expect(await queued).toBe(false);
    await store.close(panel, reason);
    expect(events).toEqual(['active', 'disabled']);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, reason);
    expect(skipped).not.toHaveBeenCalled();
    expect(await store.render(panel, skipped)).toBe(false);
  });

  it('does not start a queued render if its clock expires before the timer runs', async () => {
    let now = 1_000;
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 10, now: () => now, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    const operation = vi.fn(async () => {});
    const rendered = store.render(panel, operation);
    now = 1_010;
    expect(await rendered).toBe(false);
    await store.close(panel, 'used');
    expect(operation).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'expired');
  });

  it('propagates render errors without poisoning later edits or final cleanup', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    await expect(store.render(panel, async () => { throw new Error('edit failed'); })).rejects.toThrow('edit failed');
    expect(await store.render(panel, async () => {})).toBe(true);
    await store.close(panel, 'cancelled');
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'cancelled');
  });

  it('swallows synchronous and asynchronous close-hook failures, including timer cleanup', async () => {
    const onClose = vi.fn()
      .mockImplementationOnce(() => { throw new Error('sync failure'); })
      .mockRejectedValueOnce(new Error('async failure'));
    const store = makeStore({ ttlMs: 10, onClose });
    const first = store.create(binding, { kind: 'settings' });
    const second = store.create(binding, { kind: 'commands' });
    await store.attach(first, 42);
    await store.attach(second, 43);
    await expect(store.close(first, 'used')).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);
    await expect(store.close(second, 'expired')).resolves.toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(2);
    await expect(store.stop()).resolves.toBeUndefined();
  });

  it('stops synchronously without starting cleanup and never resurrects a pending send', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ onClose });
    const attached = store.create(binding, { kind: 'settings' });
    const sending = store.create(binding, { kind: 'commands' });
    await store.attach(attached, 42);
    const stopping = store.stop();
    expect(store.stop()).toBe(stopping);
    expect(store.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => store.get(attached.id, callback)).toThrow('CONFIRMATION_EXPIRED');
    expect(() => store.create(binding, { kind: 'settings' })).toThrow('CONFIRMATION_EXPIRED');
    await stopping;
    await store.attach(sending, 43);
    await store.close(attached, 'expired');
    await store.closeOwned(binding.key, 'cancelled');
    expect(await store.render(attached, async () => { throw new Error('must not run'); })).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000_000);
    expect(onClose).not.toHaveBeenCalled();
    expect(sending.messageId).toBeUndefined();
    expect(store.hasMessage(100, -200, 42)).toBe(false);
  });

  it('waits for actual rendering but skips queued renders and not-yet-started expiry cleanup', async () => {
    const onClose = vi.fn(async () => {});
    const store = makeStore({ ttlMs: 10, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    const started = deferred();
    const gate = deferred();
    const rendering = store.render(panel, async () => { started.resolve(); await gate.promise; });
    await started.promise;
    const queued = store.render(panel, async () => { throw new Error('must not run'); });
    await vi.advanceTimersByTimeAsync(10);
    const stopping = store.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    gate.resolve();
    expect(await rendering).toBe(true);
    expect(await queued).toBe(false);
    await stopping;
    expect(stopped).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waits for already-started cleanup even when the panel was removed before stop', async () => {
    const started = deferred();
    const gate = deferred();
    const onClose = vi.fn(async () => { started.resolve(); await gate.promise; });
    const store = makeStore({ ttlMs: 10, onClose });
    const panel = store.create(binding, { kind: 'settings' });
    await store.attach(panel, 42);
    await vi.advanceTimersByTimeAsync(10);
    await started.promise;
    expect(store.size).toBe(0);
    const stopping = store.stop();
    let stopped = false;
    void stopping.then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    gate.resolve();
    await stopping;
    expect(stopped).toBe(true);
    expect(onClose).toHaveBeenCalledExactlyOnceWith(panel, 'expired');
  });
});
