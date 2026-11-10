import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FEED_MAX_IMAGES, FEED_MAX_IMAGE_BYTES, FEED_MAX_IMAGE_POSITIONS, FeedFetchError, parseFeed, type FeedEntry, type FeedFetcher, type FeedResponse } from '../src/modules/rss-feed.js';
import { RSS_IMAGES_PER_MESSAGE, RssDeliveryError, RssService, type RssOptions, type RssTarget } from '../src/modules/rss.js';
import { clipFeedContentFormat, isValidFeedContentFormat, type FeedContentFormat } from '../src/modules/rss-format.js';
import { JSON_DOCUMENT_MAX_BYTES } from '../src/storage.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
const target: RssTarget = { chatId: 1, kind: 'private' };
const url = 'https://feeds.example.com/rss';
function entry(index: number): FeedEntry {
  return { id: createHash('sha256').update(String(index)).digest('hex'), title: `Article ${index}`, content: `Body ${index}`, url: `https://feeds.example.com/${index}` };
}
function picturedEntry(index: number, count: number, urlLength = 0): FeedEntry {
  return { ...entry(index), images: Array.from({ length: count }, (_, image) => `https://images.example.com/${index}/${image}.jpg`.padEnd(urlLength, 'x')) };
}
function formattedEntry(index: number): FeedEntry {
  return { ...entry(index), content: 'Head\n  code\nA\tB\nquote', contentFormat: { version: 1, blocks: [
    { type: 'heading', offset: 0, length: 4, spans: [{ offset: 0, length: 4, type: 'bold' }] },
    { type: 'pre', offset: 5, length: 6, language: 'ts' },
    { type: 'table', offset: 12, length: 3, cells: [[{ offset: 12, length: 1, header: true }, { offset: 14, length: 1, align: 'right' }]] },
    { type: 'blockquote', offset: 16, length: 5, blocks: [{ type: 'paragraph', offset: 16, length: 5,
      spans: [{ offset: 16, length: 5, type: 'italic' }],
    }] },
  ] } };
}
async function fixture() {
  let now = 1_000_000;
  let response: FeedResponse = { finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] }, etag: '"v1"' };
  const fetcher = vi.fn<FeedFetcher>(async () => structuredClone(response));
  const send = vi.fn<RssOptions['send']>(async () => {});
  const f = await coreFixture({ rss: { now: () => now, fetcher, send } });
  cleanup.push(f.close);
  return { ...f, fetcher, send, setResponse: (value: FeedResponse) => { response = value; },
    items: (...indices: number[]) => { response = { finalUrl: url, notModified: false, feed: { title: 'Feed', entries: indices.map(entry) }, etag: `"${indices.join('-')}"` }; },
    advance: (ms = 3000) => { now += ms; },
    poll: async () => { now = Math.max(now, f.rss.snapshot().sources[0]!.nextCheckAt); await f.rss.runOnce(); },
  };
}

describe('persistent RSS subscriptions and delivery', () => {
  it('adapts each feed interval within its bounds and honors a longer upstream retry delay', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    expect(f.rss.snapshot().sources[0]!.intervalSeconds).toBe(300);
    await f.poll();
    expect(f.rss.snapshot().sources[0]!.intervalSeconds).toBe(390);
    f.items(1); await f.poll();
    expect(f.rss.snapshot().sources[0]!.intervalSeconds).toBe(273);
    await f.rss.runOnce();
    f.items();
    for (let i = 0; i < 15; i++) await f.poll();
    expect(f.rss.snapshot().sources[0]!.intervalSeconds).toBe(3600);
    for (let i = 2; i < 17; i++) { f.items(i); await f.poll(); await f.rss.runOnce(); }
    expect(f.rss.snapshot().sources[0]!.intervalSeconds).toBe(60);
    f.fetcher.mockRejectedValueOnce(new FeedFetchError('HTTP_ERROR', 429, 7_200_000));
    await f.poll();
    const source = f.rss.snapshot().sources[0]!;
    expect(source.intervalSeconds).toBe(300);
    expect(source.nextCheckAt - source.lastCheckAt!).toBe(7_200_000);
  });
  it('drains a fifty-item burst individually rather than flooding or collapsing it', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(...Array.from({ length: 50 }, (_, index) => 50 - index));
    await f.poll();
    expect(f.rss.snapshot().queue).toHaveLength(50);
    await f.rss.runOnce();
    const first = f.rss.snapshot().lastSent['1']!;
    for (let sent = 1; sent < 50; sent++) {
      f.advance(2999); await f.rss.runOnce();
      expect(f.send).toHaveBeenCalledTimes(sent);
      f.advance(1); await f.rss.runOnce();
      expect(f.send).toHaveBeenCalledTimes(sent + 1);
    }
    expect(f.rss.snapshot().lastSent['1']! - first).toBe(147_000);
    expect(f.rss.snapshot().queue).toEqual([]);
  });
  it('shares the three-second limit across topics while enforcing the global RSS send interval', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    await f.rss.add({ ...target, threadId: 9 }, { url }, 'en');
    await f.rss.add({ kind: 'private', chatId: 2 }, { url }, 'en');
    f.items(1); await f.poll();
    expect(f.rss.snapshot().queue).toHaveLength(3);
    await f.rss.runOnce();
    f.advance(99); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(1); await f.rss.runOnce();
    expect(f.send.mock.calls[1]![0]).toEqual({ kind: 'private', chatId: 2 });
    f.advance(2899); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(1); await f.rss.runOnce();
    expect(f.send.mock.calls[2]![0]).toEqual({ ...target, threadId: 9 });
  });
  it('accepts empty feeds, seeds existing items, and never floods new subscribers with history', async () => {
    const f = await fixture();
    f.items(3, 2, 1);
    const first = await f.rss.add(target, { url }, 'en');
    expect(f.rss.list(target).items[0]).toMatchObject({ id: first.id, silent: true, paused: false });
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(await f.rss.add(target, { url }, 'en')).toEqual({ id: first.id, changed: false });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    f.items(4, 3, 2, 1);
    await f.rss.add({ chatId: 10, kind: 'private' }, { url, title: 'My title' }, 'ja');
    expect(f.rss.snapshot().queue).toHaveLength(1);
    expect(f.rss.snapshot().queue[0]!.subscriptionId).toBe(first.id);
    expect(f.rss.list(target).items[0]!.title).toBe('Feed');
    expect(f.rss.list({ chatId: 10, kind: 'private' }).items[0]!.title).toBe('My title');
  });
  it('queues more than five discoveries in order and persists dedupe across restarts', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(8, 7, 6, 5, 4, 3, 2, 1);
    await f.poll();
    expect(f.rss.snapshot().queue).toHaveLength(8);
    for (let i = 0; i < 8; i++) { await f.rss.runOnce(); f.advance(); }
    expect(f.send).toHaveBeenCalledTimes(8);
    expect(f.send.mock.calls.map(call => (call as unknown[])[2])).toEqual(Array.from({ length: 8 }, (_, index) => ({ kind: 'entry', entry: entry(index + 1) })));
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot().sources[0]!.seen).toHaveLength(8);
    expect(reloaded.snapshot().queue).toEqual([]);
    await f.poll();
    expect(f.rss.snapshot().queue).toEqual([]);
  });
  it.each([1, 50, 51, 101])('delivers %i images one acknowledged page per three-second chat quota', async count => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'ja');
    const article = { ...picturedEntry(1, count), animationIndices: count > 1 ? [0, count - 1] : [0], imagePositions: [
      { offset: 0, imageIndex: count - 1 }, { offset: 3, imageIndex: 0 }, { offset: 3, imageIndex: 0 }, { offset: 6, imageIndex: count - 1 },
    ] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    const total = Math.ceil(count / RSS_IMAGES_PER_MESSAGE);
    expect(RSS_IMAGES_PER_MESSAGE).toBe(50);
    const initial = f.rss.snapshot();
    const job = initial.queue[0]!;
    expect(job).toMatchObject({ payload: { kind: 'entry-ref' }, page: 0 });
    if (job.payload.kind !== 'entry-ref') throw new Error('Expected shared images');
    expect(initial.entries?.[job.payload.entryId]).toEqual(article);
    for (let page = 0; page < total; page++) {
      if (page) {
        await f.rss.update(target, { id: sub.id, revision: page - 1, silent: false, title: 'Updated feed' });
        f.advance(2999); await f.rss.runOnce();
        expect(f.send).toHaveBeenCalledTimes(page);
        f.advance(1);
      }
      await f.rss.runOnce();
      expect(f.send).toHaveBeenCalledTimes(page + 1);
      expect(f.send.mock.calls[page]).toEqual([target, page ? 'Updated feed' : 'Feed', {
        kind: 'entry', entry: article,
        ...(total > 1 ? { part: { index: page + 1, total } } : {}),
      }, 'ja', !page, expect.any(AbortSignal)]);
      const payload = f.send.mock.calls[page]![2];
      if (payload.kind !== 'entry') throw new Error('Expected entry manifest');
      expect(Object.isFrozen(payload.entry)).toBe(true);
      expect(Object.isFrozen(payload.entry.images)).toBe(true);
      expect(Object.isFrozen(payload.entry.animationIndices)).toBe(true);
      expect(Object.isFrozen(payload.entry.imagePositions)).toBe(true);
      if (page + 1 < total) {
        expect(f.rss.snapshot().queue).toEqual([{ ...job, state: 'queued', page: page + 1 }]);
        expect(f.rss.snapshot().entries).toEqual(initial.entries);
      }
    }
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
  });
  it('retries only a rate-limited later image page without advancing its cursor', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article = { ...picturedEntry(1, 101), animationIndices: [50, 100], imagePositions: [{ offset: 1, imageIndex: 100 }, { offset: 5, imageIndex: 50 }] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.runOnce();
    f.advance(); f.send.mockRejectedValueOnce(new RssDeliveryError('RATE_LIMITED', 20_000));
    await f.rss.runOnce();
    expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'queued', page: 1 });
    f.advance(19_999); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(1); await f.rss.runOnce();
    expect(f.send.mock.calls[2]![2]).toEqual(f.send.mock.calls[1]![2]);
    expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'queued', page: 2 });
    f.advance(); await f.rss.runOnce();
    expect(f.send.mock.calls.map(call => call[2].kind === 'entry' ? call[2].part?.index : undefined)).toEqual([1, 2, 2, 3]);
    for (const call of f.send.mock.calls) expect(call[2]).toMatchObject({ kind: 'entry', entry: article });
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
  });
  it('resumes only unacknowledged image pages after restart', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article = { ...picturedEntry(1, 101), animationIndices: [50, 100], imagePositions: [{ offset: 0, imageIndex: 100 }, { offset: 6, imageIndex: 50 }] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.runOnce(); await f.rss.stop();
    const state = f.rss.snapshot();
    let now = state.lastSent['1']! + 2999;
    const reloaded = new RssService(f.storage, { now: () => now, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    await reloaded.runOnce(); expect(f.send).toHaveBeenCalledTimes(1);
    now += 1; await reloaded.runOnce();
    now += 3000; await reloaded.runOnce();
    expect(f.send.mock.calls.map(call => call[2].kind === 'entry' ? call[2].part?.index : undefined)).toEqual([1, 2, 3]);
    for (const call of f.send.mock.calls) expect(call[2]).toMatchObject({ kind: 'entry', entry: article });
    expect(reloaded.snapshot().queue).toEqual([]);
    expect(reloaded.snapshot().entries).toBeUndefined();
  });
  it.each(['sending', 'UNKNOWN'] as const)('keeps a later %s page uncertain and retains its shared images across restart', async failure => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    if (failure === 'UNKNOWN') {
      f.advance(); f.send.mockRejectedValueOnce(new RssDeliveryError('UNKNOWN'));
      await f.rss.runOnce();
    }
    await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    if (failure === 'sending') {
      state.queue[0]!.state = 'sending';
      await writeFile(join(f.directory, 'rss.json'), JSON.stringify(state));
    }
    const reloaded = new RssService(f.storage, { now: () => state.lastSent['1']! + 3000, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize(); await reloaded.runOnce();
    expect(reloaded.snapshot().queue[0]).toMatchObject({ state: 'uncertain', page: 1 });
    expect(reloaded.snapshot().entries).toEqual(state.entries);
    expect(reloaded.list(target).items[0]).toMatchObject({ pending: 0, uncertain: 1, deliveryError: 'UNKNOWN' });
    expect(f.send).toHaveBeenCalledTimes(failure === 'sending' ? 1 : 2);
  });
  it('does not advance or replay a page when its successful-send checkpoint cannot commit', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    f.send.mockImplementationOnce(async () => {
      expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'sending', page: 1 });
      f.storage.options.beforeCommit = async () => { throw new Error('test write failure'); };
    });
    f.advance(); await expect(f.rss.runOnce()).rejects.toThrow('STORAGE_ERROR');
    delete f.storage.options.beforeCommit;
    await f.rss.stop();
    const state = f.rss.snapshot();
    expect(state.queue[0]).toMatchObject({ state: 'sending', page: 1 });
    const reloaded = new RssService(f.storage, { now: () => state.lastSent['1']! + 3000, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize(); await reloaded.runOnce();
    expect(reloaded.snapshot().queue[0]).toMatchObject({ state: 'uncertain', page: 1 });
    expect(reloaded.snapshot().entries).toEqual(state.entries);
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])('reloads and sends an unchanged legacy inline job (image: %s)', async withImage => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(1); await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const payload = { kind: 'entry' as const, entry: { ...entry(1), ...(withImage ? { image: 'https://images.example.com/legacy.gif' } : {}) } };
    state.queue[0]!.payload = payload;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { now: () => state.sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(reloaded.snapshot().queue[0]).not.toHaveProperty('page');
    await reloaded.runOnce();
    expect(f.send.mock.calls[0]![2]).toEqual(payload);
    const sent = f.send.mock.calls[0]![2];
    if (sent.kind !== 'entry') throw new Error('Expected legacy entry');
    expect(sent.entry).not.toHaveProperty('animationIndices');
    expect(sent.entry).not.toHaveProperty('imagePositions');
    expect(sent.entry).not.toHaveProperty('contentFormat');
    expect(reloaded.snapshot().queue).toEqual([]);
    expect(reloaded.snapshot().entries).toBeUndefined();
  });
  it('preserves old shared GIF manifests without inventing animation flags or positions', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article = picturedEntry(1, 51);
    article.images![50] = 'https://images.example.com/legacy.gif';
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = f.rss.snapshot();
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    let now = state.sources[0]!.lastCheckAt!;
    const reloaded = new RssService(f.storage, { now: () => now, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toStrictEqual(JSON.parse(serialized));
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await reloaded.runOnce(); now += 3000; await reloaded.runOnce();
    for (const [index, call] of f.send.mock.calls.entries()) {
      expect(call[2]).toStrictEqual({ kind: 'entry', entry: article, part: { index: index + 1, total: 2 } });
      if (call[2].kind !== 'entry') throw new Error('Expected old shared entry');
      expect(call[2].entry).not.toHaveProperty('animationIndices');
      expect(call[2].entry).not.toHaveProperty('imagePositions');
      expect(call[2].entry).not.toHaveProperty('contentFormat');
    }
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it.each(['legacy image', 'images'] as const)('roundtrips annotations against the %s manifest at valid UTF16 boundaries', async manifest => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const imageIndex = manifest === 'legacy image' ? 0 : 1;
    const article: FeedEntry = { ...entry(1), content: 'A\uD83D\uDE00B',
      ...(manifest === 'legacy image' ? { image: 'https://images.example.com/one.gif' }
        : { images: ['https://images.example.com/one.jpg', 'https://images.example.com/two.gif'] }),
      animationIndices: [imageIndex], imagePositions: [0, 1, 3, 3, 4].map(offset => ({ offset, imageIndex })),
    };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = f.rss.snapshot();
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    const reloaded = new RssService(f.storage, { now: () => state.sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toStrictEqual(JSON.parse(serialized));
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await reloaded.runOnce();
    expect(f.send.mock.calls[0]![2]).toStrictEqual({ kind: 'entry', entry: article });
  });
  it('preserves explicit empty metadata for an image-only entry rather than inferring locations or animation', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article: FeedEntry = { ...entry(1), content: '', images: ['https://images.example.com/one.gif'], animationIndices: [], imagePositions: [] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    expect(Object.values(f.rss.snapshot().entries!)).toStrictEqual([article]);
    await f.rss.runOnce();
    expect(f.send.mock.calls[0]![2]).toStrictEqual({ kind: 'entry', entry: article });
  });
  it.each([false, true])('filters image positions beyond the retained prefix without relocating them (surrogate at cut: %s)', async surrogate => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const content = surrogate ? 'x'.repeat(7996) + '\uD83D\uDE00' + 'x'.repeat(1000) : 'x'.repeat(9000);
    const prefixLength = surrogate ? 7996 : 7997;
    const article: FeedEntry = { ...picturedEntry(1, 3), content, animationIndices: [0, 2], imagePositions: [
      { offset: 0, imageIndex: 2 }, { offset: prefixLength, imageIndex: 1 }, { offset: 7998, imageIndex: 0 }, { offset: content.length, imageIndex: 2 },
    ], contentLinks: Array.from({ length: 64 }, (_, index) => ({ offset: index * 2, length: 1,
      url: `https://example.com/${index}/`.padEnd(2048, 'x'),
    })) };
    const expected = { ...article, content: 'x'.repeat(prefixLength) + '...',
      imagePositions: article.imagePositions!.slice(0, 2), contentLinks: article.contentLinks!.slice(0, 1),
    };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    expect(Object.values(f.rss.snapshot().entries!)).toStrictEqual([expected]);
    await f.rss.stop();
    const state = f.rss.snapshot();
    const reloaded = new RssService(f.storage, { now: () => state.sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toStrictEqual(JSON.parse(JSON.stringify(state)));
    await reloaded.runOnce();
    expect(f.send.mock.calls[0]![2]).toStrictEqual({ kind: 'entry', entry: expected });
  });
  it('shares all 1000 large image URLs across 128 subscribers and resolves them after reload', async () => {
    const f = await fixture();
    for (let chatId = 1; chatId <= 128; chatId++) await f.rss.add({ ...target, chatId }, { url }, 'en');
    const full = f.rss.snapshot();
    await expect(f.rss.add({ ...target, chatId: 129 }, { url }, 'en')).rejects.toThrow('CAPACITY');
    expect(await f.rss.add(target, { url }, 'en')).toEqual({ id: full.subscriptions[0]!.id, changed: false });
    expect(f.rss.snapshot()).toBe(full);
    expect(f.fetcher).toHaveBeenCalledTimes(128);
    const article = { ...picturedEntry(1, FEED_MAX_IMAGES, 1024),
      animationIndices: Array.from({ length: FEED_MAX_IMAGES }, (_, index) => index),
      imagePositions: Array.from({ length: FEED_MAX_IMAGE_POSITIONS }, (_, imageIndex) => ({ offset: Math.floor(imageIndex / 200), imageIndex })),
    };
    expect(article.images).toHaveLength(1000);
    expect(article.imagePositions).toHaveLength(1000);
    expect(Buffer.byteLength(JSON.stringify(article.images))).toBeLessThan(FEED_MAX_IMAGE_BYTES);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = f.rss.snapshot();
    expect(state.queue).toHaveLength(128);
    expect(Object.values(state.entries!)).toEqual([article]);
    for (const job of state.queue) {
      expect(job.payload.kind).toBe('entry-ref');
      if (job.payload.kind !== 'entry-ref') continue;
      expect(state.entries![job.payload.entryId]).toEqual(article);
      expect(job.page).toBe(0);
    }
    expect(Buffer.byteLength(JSON.stringify(state.queue))).toBeLessThan(40 * 1024);
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    expect(serialized).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_DOCUMENT_MAX_BYTES);
    let now = state.sources[0]!.lastCheckAt!;
    const reloaded = new RssService(f.storage, { now: () => now, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize(); expect(reloaded.snapshot()).toEqual(state);
    await reloaded.runOnce();
    now += 99; await reloaded.runOnce(); expect(f.send).toHaveBeenCalledTimes(1);
    now += 1; await reloaded.runOnce();
    expect(f.send.mock.calls.map(call => call[0].chatId)).toEqual([1, 2]);
    for (const call of f.send.mock.calls) expect(call[2]).toEqual({ kind: 'entry', entry: article, part: { index: 1, total: 20 } });
    expect(Object.values(reloaded.snapshot().entries!)).toEqual([article]);
  });
  it.each(['paused', 'revoked'] as const)('counts %s subscriptions toward the per-source limit', async inactive => {
    const f = await fixture();
    for (let chatId = 1; chatId <= 127; chatId++) await f.rss.add({ ...target, chatId }, { url }, 'en');
    const lastTarget: RssTarget = inactive === 'paused' ? { ...target, chatId: 128 } : { kind: 'group', chatId: -100 };
    if (inactive === 'revoked') await f.access.authorize(-100, 'Group', 1, 0);
    const last = await f.rss.add(lastTarget, { url }, 'en');
    if (inactive === 'paused') await f.rss.update(lastTarget, { id: last.id, revision: 0, paused: true });
    else await f.access.revoke(-100, 1, f.access.snapshot().revision);
    const state = f.rss.snapshot();
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    await expect(f.rss.add({ ...target, chatId: 129 }, { url }, 'en')).rejects.toThrow('CAPACITY');
    expect(await f.rss.add(target, { url }, 'en')).toEqual({ id: state.subscriptions[0]!.id, changed: false });
    expect(f.fetcher).toHaveBeenCalledTimes(128);
    expect(f.rss.snapshot()).toBe(state);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await expect(f.rss.add(target, { url: `${url}/other` }, 'en')).resolves.toMatchObject({ changed: true });
    expect(f.rss.snapshot().subscriptions).toHaveLength(129);
    expect(f.rss.snapshot().sources).toHaveLength(2);
  });
  it('keeps legacy sources with 129 subscribers intact and can dispatch after one subscriber pauses', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const subscription = state.subscriptions[0]!;
    state.subscriptions = Array.from({ length: 129 }, (_, index) => ({ ...subscription,
      id: index.toString(16).padStart(12, '0'), target: { ...target, chatId: index + 1 },
    }));
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    let now = state.sources[0]!.nextCheckAt;
    const reloaded = new RssService(f.storage, { now: () => now, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await expect(reloaded.add({ ...target, chatId: 130 }, { url }, 'en')).rejects.toThrow('CAPACITY');
    expect(await reloaded.add(target, { url }, 'en')).toEqual({ id: state.subscriptions[0]!.id, changed: false });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const article = picturedEntry(1, 51);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await reloaded.runOnce();
    expect(reloaded.snapshot().subscriptions).toEqual(state.subscriptions);
    expect(reloaded.snapshot().queue).toEqual([]);
    expect(reloaded.snapshot().sources[0]!.seen).toEqual([]);
    expect(reloaded.snapshot().sources[0]!.etag).toBeUndefined();
    const excess = state.subscriptions[128]!;
    await reloaded.update(excess.target, { id: excess.id, revision: 0, paused: true });
    now = reloaded.snapshot().sources[0]!.nextCheckAt;
    await reloaded.runOnce();
    expect(reloaded.snapshot().subscriptions).toHaveLength(129);
    expect(reloaded.snapshot().queue).toHaveLength(128);
    expect(reloaded.snapshot().queue.every(job => job.subscriptionId !== excess.id)).toBe(true);
    expect(reloaded.snapshot().sources[0]!.seen).toEqual([article.id]);
    expect(Object.values(reloaded.snapshot().entries!)).toEqual([article]);
    await reloaded.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('backpressures on serialized document bytes without dropping images or marking rejected entries seen', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const articles = Array.from({ length: 10 }, (_, index) => picturedEntry(10 - index, 1000, 1024));
    f.setResponse({ finalUrl: url, notModified: false, etag: 'full-batch', lastModified: 'full-batch', feed: { title: 'Feed', entries: articles } });
    await f.poll();
    const state = f.rss.snapshot();
    expect(state.queue).toHaveLength(7);
    expect(Object.values(state.entries!)).toEqual(articles.slice(3).reverse());
    expect(state.sources[0]!.seen).toEqual(articles.slice(3).map(article => article.id));
    expect(state.sources[0]).toMatchObject({ etag: undefined, lastModified: undefined, intervalSeconds: 60 });
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    expect(serialized).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_DOCUMENT_MAX_BYTES - 256 * 1024);
    await f.rss.stop();
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize(); expect(reloaded.snapshot()).toEqual(state);
  });
  it('collects shared image payloads only after their last subscriber cancels or pauses', async () => {
    const f = await fixture();
    const first = await f.rss.add(target, { url }, 'en');
    const secondTarget = { ...target, chatId: 2 };
    const second = await f.rss.add(secondTarget, { url }, 'ja');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    const entries = f.rss.snapshot().entries;
    await f.rss.remove(target, first.id, 0);
    expect(f.rss.snapshot().queue).toHaveLength(1);
    expect(f.rss.snapshot().entries).toEqual(entries);
    await f.rss.update(secondTarget, { id: second.id, revision: 0, paused: true });
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
    f.advance(); await f.rss.runOnce(); expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('retains uncertain shared images while collecting other work after a blocked send', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(2, 51), picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    f.advance(); f.send.mockRejectedValueOnce(new RssDeliveryError('BLOCKED')); await f.rss.runOnce();
    expect(f.rss.snapshot().queue).toHaveLength(1);
    expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'uncertain', page: 1 });
    expect(Object.values(f.rss.snapshot().entries!)).toEqual([picturedEntry(1, 101)]);
    expect(f.rss.list(target).items[0]).toMatchObject({ paused: true, revision: 1, deliveryError: 'BLOCKED' });
    await f.rss.remove(target, sub.id, 1);
    expect(f.rss.snapshot().entries).toBeUndefined();
  });
  it.each(['missing entry', 'past last page', 'too many images', 'too many bytes', 'unsafe image', 'duplicate image'] as const)(
    'rejects persisted %s without changing the stored document', async invalid => {
      const f = await fixture();
      await f.rss.add(target, { url }, 'en');
      f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(1, 51)] } });
      await f.poll(); await f.rss.stop();
      const state = structuredClone(f.rss.snapshot());
      const article = Object.values(state.entries!)[0]!;
      if (invalid === 'missing entry') delete state.entries;
      if (invalid === 'past last page') state.queue[0]!.page = 2;
      if (invalid === 'too many images') article.images = picturedEntry(1, 1001).images;
      if (invalid === 'too many bytes') article.images = picturedEntry(1, 512, 2048).images;
      if (invalid === 'unsafe image') article.images![0] = 'http://127.0.0.1/private.jpg';
      if (invalid === 'duplicate image') article.images![1] = article.images![0]!;
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      await writeFile(join(f.directory, 'rss.json'), serialized);
      const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
      cleanup.push(() => reloaded.stop());
      await expect(reloaded.initialize()).rejects.toThrow('STORAGE_ERROR');
      expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
      expect(f.send).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['unsorted animation indexes', { animationIndices: [1, 0] }],
    ['duplicate animation index', { animationIndices: [0, 0] }],
    ['negative animation index', { animationIndices: [-1] }],
    ['fractional animation index', { animationIndices: [0.5] }],
    ['coerced animation index', { animationIndices: ['0'] }],
    ['missing animation image', { animationIndices: [2] }],
    ['out-of-bound animation index', { animationIndices: [1000] }],
    ['too many animation indexes', { animationIndices: Array.from({ length: 1001 }, () => 0) }],
    ['animation without manifest', { images: undefined, animationIndices: [0] }],
    ['position without manifest', { images: undefined, imagePositions: [{ offset: 0, imageIndex: 0 }] }],
    ['missing position image', { imagePositions: [{ offset: 0, imageIndex: 2 }] }],
    ['negative position image', { imagePositions: [{ offset: 0, imageIndex: -1 }] }],
    ['fractional position image', { imagePositions: [{ offset: 0, imageIndex: 0.5 }] }],
    ['coerced position image', { imagePositions: [{ offset: 0, imageIndex: '0' }] }],
    ['position beyond content', { imagePositions: [{ offset: 5, imageIndex: 0 }] }],
    ['position inside surrogate pair', { imagePositions: [{ offset: 2, imageIndex: 0 }] }],
    ['negative position', { imagePositions: [{ offset: -1, imageIndex: 0 }] }],
    ['fractional position', { imagePositions: [{ offset: 0.5, imageIndex: 0 }] }],
    ['coerced position', { imagePositions: [{ offset: '0', imageIndex: 0 }] }],
    ['unsorted positions', { imagePositions: [{ offset: 3, imageIndex: 0 }, { offset: 1, imageIndex: 1 }] }],
    ['too many positions', { imagePositions: Array.from({ length: 1001 }, () => ({ offset: 0, imageIndex: 0 })) }],
    ['unknown position field', { imagePositions: [{ offset: 0, imageIndex: 0, extra: true }] }],
    ['missing position field', { imagePositions: [{ offset: 0 }] }],
  ])('rejects persisted %s without repairing or overwriting the document', async (_label, invalid) => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article: FeedEntry = { ...picturedEntry(1, 2), content: 'A\uD83D\uDE00B', animationIndices: [], imagePositions: [] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    Object.assign(Object.values(state.entries!)[0]!, invalid);
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await expect(reloaded.initialize()).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('keeps per-topic settings and config revisions independent of polling revisions', async () => {
    const f = await fixture();
    const first = await f.rss.add({ ...target, threadId: 10 }, { url }, 'zh-CN');
    await f.rss.add({ ...target, threadId: 11 }, { url }, 'en');
    f.items(1); await f.poll();
    await expect(f.rss.update({ ...target, threadId: 10 }, { id: first.id, revision: 0, silent: false })).resolves.toMatchObject({ changed: true });
    expect(f.rss.list({ ...target, threadId: 11 }).items[0]!.silent).toBe(true);
    await expect(f.rss.update({ ...target, threadId: 10 }, { id: first.id, revision: 0, paused: true })).rejects.toThrow('CONFLICT');
    await expect(f.rss.remove({ ...target, threadId: 11 }, first.id, 1)).rejects.toThrow('NOT_FOUND');
    expect(f.rss.list(target).total).toBe(0);
  });
  it('persists bounded link ranges and still reloads queued entries without link metadata', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const linked = { ...entry(2), content: 'x'.repeat(7988) + 'download this article' + 'y'.repeat(1000), contentLinks: [
      { offset: 7988, length: 21, url: 'https://example.com/article#section' },
      { offset: 8100, length: 5, url: 'https://example.com/later' },
    ] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [linked, entry(1)] } });
    await f.poll();
    const jobs = f.rss.snapshot().queue;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]!.payload).toEqual({ kind: 'entry', entry: entry(1) });
    expect(jobs[1]!.payload).toMatchObject({ kind: 'entry', entry: {
      content: 'x'.repeat(7988) + 'download ' + '...',
      contentLinks: [{ offset: 7988, length: 9, url: 'https://example.com/article#section' }],
    } });
    await f.rss.stop();
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot().queue).toEqual(jobs);
    const oldPayload = reloaded.snapshot().queue[0]!.payload;
    if (oldPayload.kind === 'entry') expect(oldPayload.entry).not.toHaveProperty('contentLinks');
  });
  it('keeps a 128-subscriber long-link burst reloadable without changing destinations or excess labels', async () => {
    const f = await fixture();
    for (let chatId = 1; chatId <= 128; chatId++) await f.rss.add({ ...target, chatId }, { url }, 'en');
    const destinations = Array.from({ length: 64 }, (_, index) => `https://example.com/${index}/`.padEnd(2048, 'x'));
    const body = destinations.map(destination => `<a href="${destination}">example.com</a>`).join(' ');
    const feed = parseFeed(`<rss><channel><title>Feed</title><item><guid>long-links</guid><description><![CDATA[${body}]]></description></item></channel></rss>`, url);
    expect(feed.entries[0]!.contentLinks).toHaveLength(64);
    f.setResponse({ finalUrl: url, notModified: false, feed });
    await f.poll();
    const state = f.rss.snapshot();
    expect(state.queue).toHaveLength(128);
    for (const job of state.queue) {
      expect(job.payload.kind).toBe('entry');
      if (job.payload.kind !== 'entry') continue;
      expect(job.payload.entry.content).toBe(feed.entries[0]!.content);
      expect(job.payload.entry.contentLinks).toEqual(feed.entries[0]!.contentLinks!.slice(0, 1));
      expect(Buffer.byteLength(JSON.stringify(job.payload.entry.contentLinks))).toBeLessThanOrEqual(4 * 1024);
    }
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    expect(serialized).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect((await stat(join(f.directory, 'rss.json'))).size).toBe(Buffer.byteLength(serialized));
    expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_DOCUMENT_MAX_BYTES);
    await f.rss.stop();
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
  });
  it('fits a saturated RSS document including escaped metadata and pretty-JSON overhead', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const escapedUrl = 'https://example.com/?'.padEnd(2048, '\\');
    const contentLinks = Array.from({ length: 64 }, (_, index) => ({ offset: index * 2, length: 1,
      url: `https://example.com/${index}/`.padEnd(28, 'x'),
    }));
    // Fill the byte budget with 64 links to maximize pretty-print indentation overhead.
    contentLinks[0]!.url += 'x'.repeat(4 * 1024 - 1 - Buffer.byteLength(JSON.stringify(contentLinks)));
    const large = { ...entry(1), title: '\ufffd'.repeat(256), url: escapedUrl, image: escapedUrl,
      publishedAt: '9999-12-31T23:59:59.999Z', content: '\ufffd'.repeat(8000), contentLinks,
    };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [large] } });
    await f.poll();
    await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const source = state.sources[0]!; const subscription = state.subscriptions[0]!; const job = state.queue[0]!;
    if (job.payload.kind === 'entry') expect(job.payload.entry.contentLinks).toEqual(contentLinks);
    state.revision = Number.MAX_SAFE_INTEGER;
    state.sources = Array.from({ length: 64 }, (_, index) => ({ ...source, id: index.toString(16).padStart(24, '0'),
      url: escapedUrl, title: '\ufffd'.repeat(128), seen: Array.from({ length: 300 }, (_, item) => item.toString(16).padStart(64, '0')),
      etag: '\u0000'.repeat(1024), lastModified: '\u0000'.repeat(256), intervalSeconds: 3600,
      nextCheckAt: Number.MAX_VALUE, lastCheckAt: Number.MAX_VALUE, lastSuccessAt: Number.MAX_VALUE,
      failures: Number.MAX_SAFE_INTEGER, totalChecks: Number.MAX_SAFE_INTEGER, totalFailures: Number.MAX_SAFE_INTEGER,
    }));
    state.subscriptions = Array.from({ length: 512 }, (_, index) => ({ ...subscription,
      id: index.toString(16).padStart(12, '0'), revision: Number.MAX_SAFE_INTEGER, sourceId: state.sources[index % 64]!.id,
      target: { ...target, chatId: Number.MAX_SAFE_INTEGER - index, threadId: Number.MAX_SAFE_INTEGER }, title: '\u0000'.repeat(128),
    }));
    state.queue = Array.from({ length: 128 }, (_, index) => ({ ...job, id: index.toString(16).padStart(24, '0'),
      subscriptionId: state.subscriptions[index]!.id, nextAttemptAt: Number.MAX_VALUE,
    }));
    state.lastSent = Object.fromEntries(state.subscriptions.map(value => [String(value.target.chatId), Number.MAX_VALUE]));
    state.nextSendAt = Number.MAX_VALUE;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_DOCUMENT_MAX_BYTES);
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    expect((await stat(join(f.directory, 'rss.json'))).size).toBe(Buffer.byteLength(serialized));
  });
  it('does not apply the new link byte budget to already persisted queue entries', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(1); await f.poll();
    await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const oldEntry = { ...entry(1), content: 'x '.repeat(64), contentLinks: Array.from({ length: 64 }, (_, index) => ({
      offset: index * 2, length: 1, url: `https://example.com/${index}/`.padEnd(2048, 'x'),
    })) };
    state.queue[0]!.payload = { kind: 'entry', entry: oldEntry };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
  });
  it('applies notification changes to queued deliveries and removes pending work on unsubscribe', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.items(2, 1); await f.poll();
    await f.rss.update(target, { id: sub.id, revision: 0, silent: false });
    await f.rss.runOnce();
    expect(f.send.mock.calls[0]).toEqual([target, 'Feed', { kind: 'entry', entry: entry(1) }, 'en', false, expect.any(AbortSignal)]);
    await f.rss.remove(target, sub.id, 1);
    f.advance(100_000); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.rss.snapshot()).toMatchObject({ sources: [], subscriptions: [], queue: [], lastSent: {} });
  });
  it('pauses delivery and does not leak notifications to revoked groups', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const group: RssTarget = { kind: 'group', chatId: -100, threadId: 9 };
    const sub = await f.rss.add(group, { url }, 'en');
    f.items(1); await f.poll();
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    await f.rss.runOnce();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.rss.snapshot().queue).toEqual([]);
    await expect(f.rss.remove(group, sub.id, 0)).rejects.toThrow('FORBIDDEN');
  });
  it('discards remaining image pages and their cache after group allowlisting is revoked', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const group: RssTarget = { kind: 'group', chatId: -100, threadId: 9 };
    await f.rss.add(group, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(2, 51), picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    expect(f.rss.snapshot().queue[0]).toMatchObject({ page: 1 });
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    f.advance(); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
  });
  it('records blocked feeds with backoff and emits one failure/recovery notice', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.fetcher.mockRejectedValue(new FeedFetchError('BLOCKED', 403));
    for (let i = 0; i < 5; i++) await f.poll();
    expect(f.rss.list(target).items[0]).toMatchObject({ lastError: 'BLOCKED', failures: 5, totalFailures: 5, intervalSeconds: 3600 });
    expect(f.rss.snapshot().queue).toHaveLength(1);
    await f.rss.runOnce();
    expect(f.send.mock.calls[0]?.[2]).toEqual({ kind: 'health', recovered: false, error: 'BLOCKED' });
    await f.poll(); expect(f.rss.snapshot().queue).toEqual([]);
    f.fetcher.mockResolvedValue({ finalUrl: url, notModified: true });
    await f.poll(); await f.rss.runOnce();
    expect(f.send.mock.calls[1]?.[2]).toEqual({ kind: 'health', recovered: true, error: null });
    expect(f.rss.list(target).items[0]!.failures).toBe(0);
  });
  it('does not save a blocked or unsafe new feed and exposes only classified errors', async () => {
    const f = await fixture();
    f.fetcher.mockRejectedValue(new FeedFetchError('BLOCKED', 403));
    await expect(f.rss.add(target, { url }, 'en')).rejects.toMatchObject({ code: 'UNAVAILABLE', fields: ['rss.BLOCKED'] });
    await expect(f.rss.add(target, { url: 'http://127.0.0.1' }, 'en')).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['rss.UNSAFE_URL'] });
    expect(f.rss.snapshot().sources).toEqual([]);
    expect(f.rss.snapshot().subscriptions).toEqual([]);
  });
  it('honors Telegram Retry-After globally and never retries ambiguous sends', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(1); await f.poll();
    f.send.mockRejectedValueOnce(new RssDeliveryError('RATE_LIMITED', 20_000));
    await f.rss.runOnce();
    await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    f.advance(20_000);
    f.send.mockRejectedValueOnce(new RssDeliveryError('UNKNOWN'));
    await f.rss.runOnce();
    expect(f.rss.list(target).items[0]).toMatchObject({ uncertain: 1, deliveryError: 'UNKNOWN' });
    f.advance(20_000); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(2);
  });
  it('recovers a persisted in-flight send as uncertain rather than delivering it again', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(1); await f.poll();
    const state = structuredClone(f.rss.snapshot());
    state.queue[0]!.state = 'sending';
    await writeFile(join(f.directory, 'rss.json'), JSON.stringify(state), { mode: 0o600 });
    const reloaded = new RssService(f.storage, { now: () => state.sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    await reloaded.runOnce();
    expect(reloaded.list(target).items[0]).toMatchObject({ pending: 0, uncertain: 1, deliveryError: 'UNKNOWN' });
    expect(f.send).not.toHaveBeenCalled();
  });
  it('drains an in-flight delivery before completing unsubscribe and sends nothing afterwards', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(2, 51), picturedEntry(1, 101)] } });
    await f.poll();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.send.mockImplementationOnce(async () => { started.resolve(); await release.promise; });
    const sending = f.rss.runOnce();
    await started.promise;
    let removed = false;
    const removing = f.rss.remove(target, sub.id, 0).then(() => { removed = true; });
    await Promise.resolve();
    expect(removed).toBe(false);
    release.resolve();
    await sending; await removing;
    f.advance(600_000); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
  });
  it('bounds queue growth without marking unqueued entries seen or hiding them behind a 304', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(...Array.from({ length: 140 }, (_, index) => 140 - index));
    await f.poll();
    expect(f.rss.snapshot().queue).toHaveLength(128);
    expect(f.rss.snapshot().sources[0]!.seen).toHaveLength(128);
    expect(f.rss.snapshot().sources[0]!.etag).toBeUndefined();
    await f.rss.runOnce();
    f.advance(60_000); await f.poll();
    expect(f.rss.snapshot().queue.length).toBeLessThanOrEqual(128);
    expect(f.rss.snapshot().sources[0]!.seen.length).toBeLessThan(140);
  });
  it('stops its timer, aborts pending retrieval and leaves no active scheduler', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.fetcher.mockImplementationOnce((_url, _validators, signal) => new Promise((_resolve, reject) => {
      if (signal.aborted) { reject(new FeedFetchError('TIMEOUT')); return; }
      signal.addEventListener('abort', () => reject(new FeedFetchError('TIMEOUT')), { once: true });
    }));
    const pending = f.poll();
    const caught = pending.catch(() => undefined);
    await Promise.resolve(); await Promise.resolve();
    await f.rss.stop(); await caught;
    await expect(f.rss.runOnce()).rejects.toThrow('CANCELLED');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('aborts an in-flight image page without advancing its acknowledged cursor or collecting its cache', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [picturedEntry(1, 101)] } });
    await f.poll(); await f.rss.runOnce();
    const entries = f.rss.snapshot().entries;
    const started = Promise.withResolvers<void>();
    f.send.mockImplementationOnce((_target, _title, _payload, _language, _silent, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled send')), { once: true });
      started.resolve();
    }));
    f.advance(); const sending = f.rss.runOnce();
    await started.promise; await f.rss.stop(); await sending;
    expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'uncertain', page: 1 });
    expect(f.rss.snapshot().entries).toEqual(entries);
    expect(f.send).toHaveBeenCalledTimes(2);
    await expect(f.rss.runOnce()).rejects.toThrow('CANCELLED');
  });
});

describe('persistent RSS structured content', () => {
  it.each([0, 51])('persists and freezes structured content unchanged across restart and %i-image paging', async count => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'ja');
    const article = { ...formattedEntry(1), ...(count ? { images: picturedEntry(1, count).images, animationIndices: [50] } : {}) };
    if (count) {
      article.imagePositions = [{ offset: 5, imageIndex: 50 }, { offset: 11, imageIndex: 0 }];
      Object.assign(article.contentFormat!.blocks[1]!, { images: [0, 1] });
    }
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = f.rss.snapshot(); const [key, stored] = Object.entries(state.entries!)[0]!;
    expect(stored).toEqual(article);
    expect(key).toBe(createHash('sha256').update(JSON.stringify(stored)).digest('hex'));
    expect(key).not.toBe(article.id);
    expect(state.queue[0]).toMatchObject({ payload: { kind: 'entry-ref', entryId: key }, page: 0 });
    expect(Object.isFrozen(stored.contentFormat)).toBe(true);
    expect(Object.isFrozen(stored.contentFormat!.blocks)).toBe(true);
    expect(Object.isFrozen(stored.contentFormat!.blocks[0])).toBe(true);
    const heading = stored.contentFormat!.blocks[0]!;
    if (heading.type !== 'heading') throw new Error('Expected heading');
    expect(Object.isFrozen(heading.spans)).toBe(true);
    expect(Object.isFrozen(heading.spans![0])).toBe(true);
    const table = stored.contentFormat!.blocks[2]!;
    if (table.type !== 'table') throw new Error('Expected table');
    expect(Object.isFrozen(table.cells[0]![0])).toBe(true);
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    let now = state.sources[0]!.lastCheckAt!;
    const reloaded = new RssService(f.storage, { now: () => now, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await reloaded.runOnce();
    if (count) { now += 3000; await reloaded.runOnce(); }
    for (const [index, call] of f.send.mock.calls.entries()) expect(call[2]).toEqual({ kind: 'entry', entry: article,
      ...(count ? { part: { index: index + 1, total: 2 } } : {}),
    });
    expect(reloaded.snapshot().entries).toBeUndefined();
    expect(reloaded.snapshot().queue).toEqual([]);
  });

  it('does not rehash existing cache keys or rewrite valid formatted jobs during loading', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [formattedEntry(1)] } });
    await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const oldKey = 'f'.repeat(64); const article = Object.values(state.entries!)[0]!;
    state.entries = { [oldKey]: article };
    state.queue[0]!.payload = { kind: 'entry-ref', entryId: oldKey };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(reloaded.snapshot()).toEqual(state);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
  });

  it.each(['pre', 'table', 'paragraph'] as const)('clips a formatted %s with links and image ownership before the storage ellipsis', async type => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const content = 'x'.repeat(7996) + '\uD83D\uDE00' + 'x'.repeat(1000);
    const spans = [{ offset: 7900, length: 200, type: 'bold' as const }];
    const text = { offset: 0, length: content.length, images: [0, 1, 2, 3] };
    const contentFormat: FeedContentFormat = { version: 1, blocks: [type === 'table' ? { type, offset: 0, length: content.length,
      cells: [[{ ...text, spans, header: true }]],
    } : type === 'paragraph' ? { ...text, type, spans } : { ...text, type, language: 'ts' }] };
    const article: FeedEntry = { ...picturedEntry(1, 2), content, contentFormat, animationIndices: [1],
      imagePositions: [0, 7996, 7998, content.length].map(offset => ({ offset, imageIndex: 1 })),
      contentLinks: [{ offset: 7990, length: 20, url: 'https://example.com/link' }],
    };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    const stored = Object.values(f.rss.snapshot().entries!)[0]!;
    expect(stored).toEqual({ ...article, content: 'x'.repeat(7996) + '...', imagePositions: article.imagePositions!.slice(0, 2),
      contentLinks: [{ ...article.contentLinks![0]!, length: 6 }],
      contentFormat: clipFeedContentFormat(contentFormat, content, article.imagePositions!, 7996),
    });
    expect(stored.id).toBe(article.id);
    expect(isValidFeedContentFormat(stored.contentFormat!, stored.content.slice(0, -3), stored.imagePositions)).toBe(true);
    expect(stored.images).toEqual(article.images);
    expect(stored.animationIndices).toEqual(article.animationIndices);
  });

  it('admits and reloads an exact native-budget format after clipping adds the uncovered ellipsis', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article: FeedEntry = { ...entry(1), content: 'x'.repeat(10_000), contentFormat: { version: 1,
      blocks: [64, 64, 64, 64, 64, 64, 1].map((rows, index) => {
        const offset = index * 1000; const length = index === 6 ? 4000 : 1000;
        return { type: 'table', offset, length, cells: Array.from({ length: rows }, (_, row) => [{
          offset: row ? offset + length : offset, length: row ? 0 : length,
        }]) };
      }),
    } };
    expect(isValidFeedContentFormat(article.contentFormat!, article.content)).toBe(true);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const stored = Object.values(f.rss.snapshot().entries!)[0]!;
    expect(stored.content).toBe('x'.repeat(7997) + '...');
    expect(stored.contentFormat!.blocks).toHaveLength(7);
    expect(stored.contentFormat!.blocks[6]).toMatchObject({ offset: 6000, length: 1997 });
    expect(isValidFeedContentFormat(stored.contentFormat!, stored.content)).toBe(true);
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    const reloaded = new RssService(f.storage, { now: () => f.rss.snapshot().sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await reloaded.runOnce();
    expect(f.send.mock.calls[0]![2]).toEqual({ kind: 'entry', entry: stored });
  });

  it.each(['inline', 'shared'] as const)('rejects a persisted %s format over the native expansion budget without rewriting bytes or keys', async kind => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.items(1); await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const article = { ...entry(1), contentFormat: { version: 1 as const,
      blocks: Array.from({ length: 8 }, () => ({ type: 'table' as const, offset: 0, length: 0,
        cells: Array.from({ length: 64 }, () => [{ offset: 0, length: 0 }]),
      })),
    } };
    expect(isValidFeedContentFormat(article.contentFormat, article.content)).toBe(false);
    if (kind === 'shared') {
      const oldKey = 'f'.repeat(64);
      state.entries = { [oldKey]: article };
      state.queue[0]!.payload = { kind: 'entry-ref', entryId: oldKey };
      state.queue[0]!.page = 0;
    } else state.queue[0]!.payload = { kind: 'entry', entry: article };
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await expect(reloaded.initialize()).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('rejects oversized fresh native expansion before queueing or marking entries seen', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article: FeedEntry = { ...entry(1), contentFormat: { version: 1,
      blocks: Array.from({ length: 8 }, () => ({ type: 'table', offset: 0, length: 0,
        cells: Array.from({ length: 64 }, () => [{ offset: 0, length: 0 }]),
      })),
    } };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await expect(f.poll()).resolves.toBeUndefined();
    expect(f.rss.snapshot().sources[0]).toMatchObject({ seen: [], lastError: 'INVALID_FEED', failures: 1 });
    expect(f.rss.snapshot().queue).toEqual([]);
    expect(f.rss.snapshot().entries).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    null, { version: 2, blocks: [] }, { version: 1, blocks: [], extra: true },
    { version: 1, blocks: [{ type: 'paragraph', offset: 0, length: 22 }] },
    { version: 1, blocks: [{ type: 'pre', offset: 0, length: 2, images: [0] }] },
    { version: 1, blocks: [{ type: 'pre', offset: 0, length: 2, language: '/bin/sh' }] },
    { version: 1, blocks: [{ type: 'table', offset: 0, length: 4, cells: [[{ offset: 0, length: 3 }, { offset: 1, length: 2 }]] }] },
    { version: 1, blocks: [{ type: 'table', offset: 0, length: 4, cells: [[{ offset: 1, length: 2 }]] }] },
    { version: 1, blocks: [{ type: 'paragraph', offset: 0, length: 2, spans: [{ offset: 0, length: 1, type: 'url' }] }] },
  ])('fails loading malformed present format without changing any recorded bytes: %j', async invalid => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [formattedEntry(1)] } });
    await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    Object.assign(Object.values(state.entries!)[0]!, { contentFormat: invalid });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await expect(reloaded.initialize()).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('classifies malformed fresh formats inside the fetch failure path and can recover on the next poll', async () => {
    const f = await fixture();
    const malformed = { ...formattedEntry(1), contentFormat: { version: 2, blocks: [] } } as unknown as FeedEntry;
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [malformed] } });
    await expect(f.rss.add(target, { url }, 'en')).rejects.toMatchObject({ code: 'UNAVAILABLE', fields: ['rss.INVALID_FEED'] });
    expect(f.rss.snapshot().sources).toEqual([]);
    f.items(); await f.rss.add(target, { url }, 'en');
    const seen = f.rss.snapshot().sources[0]!.seen;
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [formattedEntry(2), malformed] } });
    await expect(f.poll()).resolves.toBeUndefined();
    expect(f.rss.snapshot().sources[0]).toMatchObject({ failures: 1, lastError: 'INVALID_FEED', seen });
    expect(f.rss.snapshot().queue).toEqual([]);
    await expect(f.rss.add({ ...target, chatId: 2 }, { url }, 'en')).rejects.toMatchObject({ code: 'UNAVAILABLE', fields: ['rss.INVALID_FEED'] });
    expect(f.rss.snapshot().subscriptions).toHaveLength(1);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [formattedEntry(2)] } });
    await f.poll(); await f.rss.runOnce();
    expect(f.rss.snapshot().sources[0]).toMatchObject({ failures: 0, lastError: null });
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('enforces the persisted 8000 UTF16-unit bound rather than only the Zod codepoint count', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const article = formattedEntry(1);
    article.content = '\uD83D\uDE00'.repeat(4000);
    article.contentFormat = { version: 1, blocks: [{ type: 'pre', offset: 0, length: 8000 }] };
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll(); await f.rss.stop();
    const state = structuredClone(f.rss.snapshot());
    const persisted = Object.values(state.entries!)[0]!;
    expect(persisted.content).toHaveLength(8000);
    persisted.content += '\uD83D\uDE00';
    persisted.contentFormat!.blocks[0]!.length = 8002;
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await writeFile(join(f.directory, 'rss.json'), serialized);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await expect(reloaded.initialize()).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
  });

  it('shares one imageless formatted snapshot among all 128 subscribers and preserves per-subscription cancellation', async () => {
    const f = await fixture();
    for (let chatId = 1; chatId <= 128; chatId++) await f.rss.add({ ...target, chatId }, { url }, 'en');
    const article = formattedEntry(1);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    const state = f.rss.snapshot();
    expect(state.queue).toHaveLength(128);
    expect(Object.values(state.entries!)).toEqual([article]);
    expect(state.queue.every(job => job.payload.kind === 'entry-ref' && job.page === 0)).toBe(true);
    await f.rss.update(target, { id: state.subscriptions[0]!.id, revision: 0, paused: true });
    expect(f.rss.snapshot().queue).toHaveLength(127);
    expect(f.rss.snapshot().entries).toEqual(state.entries);
    await f.rss.stop();
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    const reloaded = new RssService(f.storage, { now: () => state.sources[0]!.lastCheckAt!, allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    await reloaded.runOnce();
    expect(f.send.mock.calls[0]![0].chatId).toBe(2);
    expect(f.send.mock.calls[0]![2]).toEqual({ kind: 'entry', entry: article });
  });

  it('uses actual pretty JSON admission bytes for large nested styles rather than the compact metadata budget', async () => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const contentFormat: FeedContentFormat = { version: 1, blocks: [{ type: 'blockquote', offset: 0, length: 8000, blocks: [
      { type: 'blockquote', offset: 0, length: 8000, blocks: [{ type: 'blockquote', offset: 0, length: 8000, blocks: [
        { type: 'paragraph', offset: 0, length: 8000, spans: Array.from({ length: 1024 }, (_, offset) => ({ offset, length: 1, type: 'bold' })) },
      ] }] },
    ] }] };
    const articles = Array.from({ length: 60 }, (_, index) => ({ ...entry(60 - index), content: 'x'.repeat(8000), contentFormat }));
    expect(isValidFeedContentFormat(contentFormat, articles[0]!.content)).toBe(true);
    f.setResponse({ finalUrl: url, notModified: false, etag: 'full-batch', lastModified: 'full-batch', feed: { title: 'Feed', entries: articles } });
    await f.poll(); await f.rss.stop();
    const state = f.rss.snapshot(); const accepted = state.queue.length;
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(60);
    expect(Object.values(state.entries!)).toEqual(articles.slice(60 - accepted).reverse());
    expect(state.sources[0]).toMatchObject({ etag: undefined, lastModified: undefined, intervalSeconds: 60,
      seen: articles.slice(60 - accepted).map(article => article.id),
    });
    const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    expect(serialized).toBe(`${JSON.stringify(state, null, 2)}\n`);
    expect(Buffer.byteLength(serialized)).toBeLessThan(JSON_DOCUMENT_MAX_BYTES - 256 * 1024);
    const candidate = structuredClone(state);
    candidate.entries![articles[59 - accepted]!.id] = articles[59 - accepted]!;
    candidate.queue.push({ ...candidate.queue[0]!, payload: { kind: 'entry-ref', entryId: articles[59 - accepted]!.id } });
    expect(Buffer.byteLength(JSON.stringify(candidate))).toBeLessThan(JSON_DOCUMENT_MAX_BYTES - 256 * 1024);
    expect(Buffer.byteLength(JSON.stringify(candidate, null, 2)) + 1).toBeGreaterThan(JSON_DOCUMENT_MAX_BYTES - 256 * 1024);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize(); expect(reloaded.snapshot()).toEqual(state);
  });

  it('retains an aborted formatted page as uncertain until explicitly cancelled', async () => {
    const f = await fixture();
    const subscription = await f.rss.add(target, { url }, 'en');
    const article = formattedEntry(1);
    f.setResponse({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [article] } });
    await f.poll();
    const started = Promise.withResolvers<void>();
    f.send.mockImplementationOnce((_target, _title, _payload, _language, _silent, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('cancelled send')), { once: true });
      started.resolve();
    }));
    const sending = f.rss.runOnce();
    await started.promise; await f.rss.stop(); await sending;
    expect(f.rss.snapshot().queue[0]).toMatchObject({ state: 'uncertain', page: 0 });
    expect(Object.values(f.rss.snapshot().entries!)).toEqual([article]);
    const reloaded = new RssService(f.storage, { allowed: () => true, send: f.send, fetcher: f.fetcher });
    cleanup.push(() => reloaded.stop());
    await reloaded.initialize();
    await reloaded.remove(target, subscription.id, 0);
    expect(reloaded.snapshot().queue).toEqual([]);
    expect(reloaded.snapshot().entries).toBeUndefined();
    expect(f.send).toHaveBeenCalledTimes(1);
  });
});

describe('RSS shared Action authorization', () => {
  it('allows private self-service and real group admins, rejects foreign scope and AI', async () => {
    const groupAdmin = vi.fn(async () => true);
    const f = await coreFixture({ services: { groupAdmin }, rss: { fetcher: async () => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) } });
    cleanup.push(f.close);
    await f.access.authorize(-100, 'Allowed', 1, 0);
    const member = invocation({ actorId: 10, chat: { id: -100, type: 'supergroup' } });
    expect(await f.executor.execute(member, 'rss.add', { url })).toMatchObject({ status: 'succeeded' });
    expect(groupAdmin).toHaveBeenCalled();
    groupAdmin.mockResolvedValue(false);
    expect(await f.executor.execute(invocation({ actorId: 10, chat: { id: -100, type: 'supergroup' } }), 'rss.list', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(invocation({ actorId: 10, chat: { id: 10, type: 'private' } }), 'rss.list', {})).toMatchObject({ status: 'succeeded', data: { total: 0 } });
    expect(await f.executor.execute(invocation({ source: 'ai' }), 'rss.add', { url })).toMatchObject({ status: 'rejected' });
    expect(await f.executor.execute(invocation({ chat: { id: -200, type: 'supergroup' } }), 'rss.add', { url })).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
  });
});
