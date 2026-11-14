import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { rssAddInputSchema, rssKeywordFiltersSchema, rssSubscriptionSchema, rssUpdateInputSchema,
  RSS_MAX_KEYWORDS, RSS_MAX_KEYWORD_LENGTH, type RssKeywordFilters } from '../shared/schemas/rss.js';
import { inputJsonSchema } from '../shared/schemas/index.js';
import { FeedFetchError, parseFeed, type FeedEntry, type FeedFetcher, type FeedResponse } from '../src/modules/rss-feed.js';
import { RssDeliveryError, RssService, type RssOptions, type RssTarget } from '../src/modules/rss.js';
import { JSON_DOCUMENT_MAX_BYTES } from '../src/storage.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const target: RssTarget = { chatId: 1, kind: 'private' };
const url = 'https://feeds.example.com/rss';
const filters = (include: string[] = [], exclude: string[] = []): RssKeywordFilters => ({ include, exclude });
function entry(index: number, overrides: Partial<FeedEntry> = {}): FeedEntry {
  return { id: createHash('sha256').update(String(index)).digest('hex'), title: `Article ${index}`, content: `Body ${index}`, ...overrides };
}
function images(count = 1): string[] { return Array.from({ length: count }, (_, index) => `https://images.example.com/${index}.jpg`); }
async function fixture() {
  let now = 1_000_000;
  let response: FeedResponse = { finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } };
  const fetcher = vi.fn<FeedFetcher>(async () => structuredClone(response));
  const send = vi.fn<RssOptions['send']>(async () => {});
  const f = await coreFixture({ rss: { now: () => now, fetcher, send } });
  cleanup.push(f.close);
  return { ...f, send, fetcher,
    articles: (...entries: FeedEntry[]) => { response = { finalUrl: url, notModified: false, etag: 'new-etag', lastModified: 'new-date', feed: { title: 'Feed', entries } }; },
    advance: (ms = 3000) => { now += ms; },
    poll: async () => { now = Math.max(now, f.rss.snapshot().sources[0]!.nextCheckAt); await f.rss.runOnce(); },
    restore: async (state?: ReturnType<RssService['snapshot']>) => {
      await f.rss.stop();
      if (state) await writeFile(join(f.directory, 'rss.json'), `${JSON.stringify(state, null, 2)}\n`);
      const restored = new RssService(f.storage, { now: () => now, allowed: () => true, fetcher, send });
      cleanup.push(() => restored.stop());
      await restored.initialize();
      return restored;
    },
  };
}

const invalidFilters = [
  null, [], 'keyword', {}, { include: [] }, { exclude: [] }, { include: [], exclude: [], extra: true },
  { include: 'word', exclude: [] }, { include: [], exclude: null }, filters([1 as unknown as string]),
  filters(['']), filters(['   ']), filters(['\u3000']), filters(['bad\nword']), filters(['word\n']), filters(['\rword']),
  filters(['word\t']), filters(['wo\u0000rd']), filters(['word\u007f']), filters(['word\u0085']),
  filters(['word\u2028']), filters(['word\u2029']), filters(['wo\u200brd']), filters(['wo\u202erd']),
  filters(['x'.repeat(RSS_MAX_KEYWORD_LENGTH + 1)]), filters([], ['x'.repeat(RSS_MAX_KEYWORD_LENGTH + 1)]),
  filters(Array.from({ length: RSS_MAX_KEYWORDS + 1 }, () => 'word')),
  filters([], Array.from({ length: RSS_MAX_KEYWORDS + 1 }, () => 'word')),
];

describe('RSS keyword filter schemas', () => {
  it('exports bounded strict filters, trims keywords and keeps absent filters absent', () => {
    expect(RSS_MAX_KEYWORDS).toBe(20); expect(RSS_MAX_KEYWORD_LENGTH).toBe(64);
    expect(rssKeywordFiltersSchema.parse(filters(['  KeEp  ', '\u3000\u65b0\u805e\u3000'], ['  Hide ']))).toEqual(filters(['KeEp', '\u65b0\u805e'], ['Hide']));
    expect(rssKeywordFiltersSchema.parse(filters(Array.from({ length: 20 }, () => 'x'.repeat(64))))).toEqual(filters(Array.from({ length: 20 }, () => 'x'.repeat(64))));
    expect(rssAddInputSchema.parse({ url })).not.toHaveProperty('filters');
    expect(rssAddInputSchema.parse({ url, filters: filters() }).filters).toEqual(filters());
    expect(rssUpdateInputSchema.parse({ id: 'a'.repeat(12), revision: 0, filters: null }).filters).toBeNull();
    expect(rssUpdateInputSchema.safeParse({ id: 'a'.repeat(12), revision: 0 }).success).toBe(false);
    const schema = inputJsonSchema(rssKeywordFiltersSchema);
    expect(schema).toMatchObject({ additionalProperties: false, required: ['include', 'exclude'], properties: {
      include: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 64 } },
      exclude: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 64 } },
    } });
  });
  it.each(invalidFilters.map(value => [value]))('rejects malformed filters without coercion: %j', value => {
    expect(rssKeywordFiltersSchema.safeParse(value).success).toBe(false);
    expect(rssAddInputSchema.safeParse({ url, filters: value }).success).toBe(false);
    expect(rssUpdateInputSchema.safeParse({ id: 'a'.repeat(12), revision: 0, filters: value }).success).toBe(value === null);
  });
});

describe('RSS literal keyword matching', () => {
  it.each<{ name: string; filter?: RssKeywordFilters; article?: Partial<FeedEntry>; accepted: boolean }>([
    { name: 'absent filters', accepted: true },
    { name: 'empty arrays', filter: filters(), accepted: true },
    { name: 'empty include allows other entries', filter: filters([], ['missing']), accepted: true },
    { name: 'include any title term', filter: filters(['missing', 'article']), accepted: true },
    { name: 'include body term', filter: filters(['BODY']), accepted: true },
    { name: 'no include match', filter: filters(['missing']), accepted: false },
    { name: 'exclude any vetoes include', filter: filters(['article'], ['missing', 'body']), accepted: false },
    { name: 'exclude title vetoes body', filter: filters(['body'], ['ARTICLE']), accepted: false },
    { name: 'exclude-only veto', filter: filters([], ['body']), accepted: false },
    { name: 'NFKC text', filter: filters(['abc']), article: { title: '\uff21\uff22\uff23' }, accepted: true },
    { name: 'NFKC keyword', filter: filters(['\uff22\uff2f\uff24\uff39']), accepted: true },
    { name: 'NFKC combining marks', filter: filters(['caf\u00e9']), article: { content: 'CAFE\u0301' }, accepted: true },
    { name: 'CJK substring', filter: filters(['\u65b0\u805e']), article: { content: '\u4eca\u65e5\u306e\u65b0\u805e\u3067\u3059' }, accepted: true },
    { name: 'literal regex punctuation', filter: filters(['[a-z].*']), article: { content: 'literal [a-z].* value' }, accepted: true },
    { name: 'regex punctuation is not executed', filter: filters(['.*']), accepted: false },
    { name: 'expressions are not inferred', filter: filters(['article OR body']), accepted: false },
    { name: 'no title-body concatenation', filter: filters(['foobar', 'foo bar']), article: { title: 'foo', content: 'bar' }, accepted: false },
    { name: 'no cross-boundary exclude', filter: filters([], ['foobar', 'foo bar']), article: { title: 'foo', content: 'bar' }, accepted: true },
    { name: 'image-only include rejected', filter: filters(['images']), article: { title: '', content: '', images: images() }, accepted: false },
    { name: 'image-only excluded metadata ignored', filter: filters([], ['images']), article: { title: '', content: '', images: images() }, accepted: true },
    { name: 'image-only unfiltered', article: { title: '', content: '', images: images() }, accepted: true },
    { name: 'visible URL title', filter: filters(['visible.example']), article: { title: 'https://visible.example/article' }, accepted: true },
    { name: 'visible URL body', filter: filters(['visible.example']), article: { content: 'https://visible.example/article' }, accepted: true },
  ])('$name', async ({ filter, article, accepted }) => {
    const f = await fixture();
    await f.rss.add(target, { url, filters: filter }, 'en');
    f.articles(entry(1, article)); await f.poll();
    expect(f.rss.snapshot().queue).toHaveLength(accepted ? 1 : 0);
    expect(f.rss.snapshot().sources[0]!.seen).toEqual([entry(1).id]);
    await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(accepted ? 1 : 0);
  });

  it('matches sanitized visible labels, not hidden HTML, names, links, image or format metadata', async () => {
    const f = await fixture();
    const parsed = parseFeed('<rss><channel><title>Feed</title><item><guid>metadata</guid><title>Story</title>' +
      '<link>https://article.example.com/hidden</link><description><![CDATA[<p><a href="https://link.example.com/hidden" title="attributeSecret">Visible <b>label</b></a></p>' +
      '<pre><code class="language-bash">code text</code></pre><img src="https://image.example.com/hidden.jpg" alt="altSecret" title="titleSecret">' +
      '<script>scriptSecret</script><style>styleSecret</style><template>templateSecret</template>]]></description></item></channel></rss>', url);
    const article = parsed.entries[0]!;
    expect(article.content).toContain('Visible label');
    expect(article.contentLinks?.[0]!.url).toContain('link.example');
    expect(article.images?.[0]).toContain('image.example');
    expect(article.contentFormat).toBeDefined();
    const hidden = ['Feed', 'Custom subscription', 'feeds.example', 'article.example', 'link.example', 'image.example',
      'attributeSecret', 'altSecret', 'titleSecret', 'scriptSecret', 'styleSecret', 'templateSecret', 'bash'];
    const rejected = await f.rss.add(target, { url, title: 'Custom subscription', filters: filters(hidden) }, 'en');
    const other = { ...target, chatId: 2 };
    const accepted = await f.rss.add(other, { url, filters: filters(['visible label'], hidden) }, 'en');
    f.articles(article); await f.poll();
    expect(f.rss.snapshot().queue.map(job => job.subscriptionId)).toEqual([accepted.id]);
    expect(f.rss.get(target, rejected.id).pending).toBe(0);
    await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![2]).toMatchObject({ kind: 'entry', entry: { content: article.content } });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });

  it('matches the same 8000 UTF16-unit stored prefix at enqueue and delivery', async () => {
    const f = await fixture();
    await f.rss.add(target, { url, filters: filters(['late']) }, 'en');
    const other = { ...target, chatId: 2 };
    const sub = await f.rss.add(other, { url, filters: filters(['keep'], ['late']) }, 'en');
    const article = entry(1, { title: '', content: 'keep' + 'x'.repeat(7992) + '\uD83D\uDE00late', images: images() });
    f.articles(article); await f.poll();
    const state = f.rss.snapshot();
    expect(state.queue.map(job => job.subscriptionId)).toEqual([sub.id]);
    expect(Object.values(state.entries!)[0]!.content).toBe('keep' + 'x'.repeat(7992) + '...');
    await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.send.mock.calls[0]![2]).toEqual({ kind: 'entry', entry: Object.values(state.entries!)[0] });
  });
});

describe('RSS filter persistence and discovery', () => {
  it('keeps filters independent for topics sharing one feed and one entry blob', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const first: RssTarget = { kind: 'group', chatId: -100, threadId: 10 };
    const second = { ...first, threadId: 11 };
    const one = await f.rss.add(first, { url, filters: filters(['one']) }, 'en');
    const two = await f.rss.add(second, { url, filters: filters(['two']) }, 'ja');
    const all = await f.rss.add(target, { url }, 'en');
    f.articles(entry(2, { title: 'two', images: images() }), entry(1, { title: 'one' })); await f.poll();
    const state = f.rss.snapshot();
    expect(state.sources).toHaveLength(1);
    expect(state.queue.map(job => job.subscriptionId)).toEqual([one.id, all.id, two.id, all.id]);
    expect(Object.keys(state.entries!)).toHaveLength(1);
    expect(f.rss.get(first, one.id).filters).toEqual(filters(['one']));
    expect(f.rss.get(second, two.id).filters).toEqual(filters(['two']));
    expect(f.rss.get(target, all.id)).not.toHaveProperty('filters');
    await expect(f.rss.update(second, { id: one.id, revision: 0, filters: null })).rejects.toThrow('NOT_FOUND');
    await expect(f.rss.update(target, { id: one.id, revision: 0, filters: null })).rejects.toThrow('NOT_FOUND');
    expect(f.rss.snapshot()).toBe(state);
  });

  it('consumes filtered discoveries without queue or blobs and never backfills after clearing', async () => {
    const f = await fixture();
    const baseline = entry(0);
    f.articles(baseline);
    const sub = await f.rss.add(target, { url, filters: filters(['missing']) }, 'en');
    const sourceId = f.rss.snapshot().sources[0]!.id;
    const articles = Array.from({ length: 140 }, (_, index) => entry(140 - index, { images: images() }));
    f.articles(...articles, baseline); await f.poll();
    const state = f.rss.snapshot();
    expect(state.queue).toEqual([]); expect(state.entries).toBeUndefined();
    expect(state.sources[0]).toMatchObject({ id: sourceId, seen: [...articles, baseline].map(item => item.id),
      intervalSeconds: 210, etag: 'new-etag', lastModified: 'new-date', totalChecks: 2 });
    await f.rss.update(target, { id: sub.id, revision: 0, filters: null });
    expect(f.rss.snapshot().sources).toEqual(state.sources);
    expect(f.rss.get(target, sub.id)).not.toHaveProperty('filters');
    await f.poll();
    expect(f.rss.snapshot().queue).toEqual([]); expect(f.rss.snapshot().entries).toBeUndefined();
    expect(f.send).not.toHaveBeenCalled();
    expect(Buffer.byteLength(await readFile(join(f.directory, 'rss.json'), 'utf8'))).toBeLessThan(JSON_DOCUMENT_MAX_BYTES);
  });

  it('consumes a zero-recipient entry even when the queue has no free capacity', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url, filters: filters(['missing']) }, 'en');
    const state = structuredClone(f.rss.snapshot());
    state.sources[0]!.nextCheckAt = 0;
    state.queue = Array.from({ length: 128 }, (_, index) => ({ id: index.toString(16).padStart(24, '0'), subscriptionId: sub.id,
      payload: { kind: 'health', recovered: false, error: 'NETWORK' }, state: 'uncertain', nextAttemptAt: 0 }));
    f.articles(entry(1, { images: images() }));
    const restored = await f.restore(state); await restored.runOnce();
    expect(restored.snapshot().queue).toEqual(state.queue);
    expect(restored.snapshot().entries).toBeUndefined();
    expect(restored.snapshot().sources[0]).toMatchObject({ seen: [entry(1).id], etag: 'new-etag' });
  });

  it.each([undefined, filters(), filters([' Keep '], [' Hide '])])('reloads filters without migrating or rewriting version 1 files: %j', async filter => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url, filters: filter }, 'en');
    const before = await readFile(join(f.directory, 'rss.json'), 'utf8');
    const restored = await f.restore();
    expect(restored.snapshot().schema_version).toBe(1);
    expect(restored.snapshot()).toEqual(f.rss.snapshot());
    const view = restored.get(target, sub.id);
    expect(rssSubscriptionSchema.parse(view)).toEqual(view);
    if (filter) expect(view.filters).toEqual(rssKeywordFiltersSchema.parse(filter));
    else expect(view).not.toHaveProperty('filters');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(before);
  });

  it.each(invalidFilters.map(value => [value]))('rejects invalid saved filters without repairing bytes: %j', async value => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    const state = structuredClone(f.rss.snapshot());
    Object.assign(state.subscriptions[0]!, { filters: value });
    const serialized = `${JSON.stringify(state, null, 2)}\n`;
    await expect(f.restore(state)).rejects.toThrow('STORAGE_ERROR');
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('never filters failure and recovery health notices', async () => {
    const f = await fixture();
    await f.rss.add(target, { url, filters: filters(['missing'], ['network', 'Feed']) }, 'en');
    f.fetcher.mockRejectedValue(new FeedFetchError('NETWORK'));
    for (let index = 0; index < 5; index++) await f.poll();
    await f.rss.runOnce();
    f.fetcher.mockResolvedValue({ finalUrl: url, notModified: true });
    await f.poll(); await f.rss.runOnce();
    expect(f.send.mock.calls.map(call => call[2])).toEqual([
      { kind: 'health', recovered: false, error: 'NETWORK' }, { kind: 'health', recovered: true, error: null },
    ]);
  });
});

describe('RSS atomic filter updates and delivery guards', () => {
  it('prunes only rejected queued inline/shared jobs for the selected subscription', async () => {
    const f = await fixture();
    const one = await f.rss.add(target, { url }, 'en');
    const other = { ...target, chatId: 2 };
    const two = await f.rss.add(other, { url }, 'en');
    f.articles(entry(3, { title: 'keep', images: images(51) }), entry(2, { images: images() }), entry(1)); await f.poll();
    const state = structuredClone(f.rss.snapshot());
    const matching = state.queue.find(job => job.subscriptionId === one.id && job.payload.kind === 'entry-ref'
      && state.entries![job.payload.entryId]!.title === 'keep')!;
    matching.page = 1; matching.nextAttemptAt += 20_000;
    state.queue.push({ id: 'a'.repeat(24), subscriptionId: one.id, payload: { kind: 'health', recovered: false, error: 'NETWORK' }, state: 'queued', nextAttemptAt: 0 });
    const restored = await f.restore(state);
    const source = restored.snapshot().sources;
    const before = restored.snapshot();
    const committed = vi.fn(async () => { expect(restored.snapshot()).toBe(before); });
    f.storage.options.beforeCommit = committed;
    await restored.update(target, { id: one.id, revision: 0, filters: filters([' keep ']) });
    delete f.storage.options.beforeCommit;
    const after = restored.snapshot();
    expect(committed).toHaveBeenCalledTimes(1);
    expect(after.revision).toBe(before.revision + 1);
    expect(restored.get(target, one.id)).toMatchObject({ filters: filters(['keep']), revision: 1 });
    expect(after.queue).toEqual(before.queue.filter(job => job.subscriptionId === two.id || job.id === matching.id || job.payload.kind === 'health'));
    expect(after.entries).toEqual(before.entries); expect(after.sources).toEqual(source);
    await restored.update(other, { id: two.id, revision: 0, filters: filters(['keep']) });
    expect(Object.values(restored.snapshot().entries!).map(article => article.title)).toEqual(['keep']);
    expect(restored.snapshot().queue.find(job => job.id === matching.id)).toEqual(matching);
    const revised = restored.snapshot();
    await expect(restored.update(target, { id: one.id, revision: 0, filters: null })).rejects.toThrow('CONFLICT');
    expect(restored.snapshot()).toBe(revised);
  });

  it.each(['inline', 'shared'] as const)('rechecks restored queued %s work before sending or consuming quotas', async kind => {
    const f = await fixture();
    await f.rss.add(target, { url }, 'en');
    f.articles(entry(1, kind === 'shared' ? { images: images(51) } : {})); await f.poll();
    const state = structuredClone(f.rss.snapshot());
    state.subscriptions[0]!.filters = filters(['missing']);
    if (kind === 'shared') state.queue[0]!.page = 1;
    const restored = await f.restore(state);
    expect(restored.snapshot().queue).toEqual(state.queue);
    await restored.runOnce();
    expect(restored.snapshot().queue).toEqual([]); expect(restored.snapshot().entries).toBeUndefined();
    expect(restored.snapshot().lastSent).toEqual(state.lastSent); expect(restored.snapshot().nextSendAt).toBe(state.nextSendAt);
    expect(restored.snapshot().sources).toEqual(state.sources);
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(['succeeded', 'uncertain'] as const)('waits for an in-flight page (%s), preserving evidence while pruning remaining queued pages', async outcome => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.articles(entry(2, { images: images() }), entry(1, { images: images(101) })); await f.poll();
    const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.send.mockImplementationOnce(async () => {
      started.resolve(); await release.promise;
      if (outcome === 'uncertain') throw new RssDeliveryError('UNKNOWN');
    });
    const sending = f.rss.runOnce(); await started.promise;
    const during = f.rss.snapshot();
    expect(during.queue[0]).toMatchObject({ state: 'sending', page: 0 });
    let changed = false;
    const updating = f.rss.update(target, { id: sub.id, revision: 0, filters: filters(['missing']) }).then(() => { changed = true; });
    await Promise.resolve();
    expect(changed).toBe(false); expect(f.rss.snapshot()).toBe(during);
    release.resolve(); await sending; await updating;
    const after = f.rss.snapshot();
    expect(after.queue).toHaveLength(outcome === 'uncertain' ? 1 : 0);
    if (outcome === 'uncertain') {
      expect(after.queue[0]).toEqual({ ...during.queue[0], state: 'uncertain' });
      expect(Object.values(after.entries!)).toEqual([entry(1, { images: images(101) })]);
      expect(f.rss.get(target, sub.id).deliveryError).toBe('UNKNOWN');
    } else expect(after.entries).toBeUndefined();
    await f.rss.update(target, { id: sub.id, revision: 1, filters: null });
    f.advance(); await f.rss.runOnce();
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.rss.snapshot().queue).toEqual(after.queue);
  });

  it('retains sending evidence when the post-send checkpoint fails, even across a filter change', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.articles(entry(2), entry(1, { images: images(51) })); await f.poll();
    f.send.mockImplementationOnce(async () => { f.storage.options.beforeCommit = async () => { throw new Error('checkpoint failed'); }; });
    await expect(f.rss.runOnce()).rejects.toThrow('STORAGE_ERROR');
    delete f.storage.options.beforeCommit;
    const evidence = f.rss.snapshot().queue[0]!;
    expect(evidence.state).toBe('sending');
    await f.rss.update(target, { id: sub.id, revision: 0, filters: filters(['missing']) });
    expect(f.rss.snapshot().queue).toEqual([evidence]);
    expect(Object.values(f.rss.snapshot().entries!)).toEqual([entry(1, { images: images(51) })]);
    const restored = await f.restore();
    expect(restored.snapshot().queue).toEqual([{ ...evidence, state: 'uncertain' }]);
    await restored.runOnce(); expect(f.send).toHaveBeenCalledTimes(1);
  });

  it('preserves matching page cursors, IDs and retry deadlines through replacement and clear', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url }, 'en');
    f.articles(entry(1, { images: images(101) })); await f.poll(); await f.rss.runOnce();
    f.advance(); f.send.mockRejectedValueOnce(new RssDeliveryError('RATE_LIMITED', 20_000)); await f.rss.runOnce();
    const before = f.rss.snapshot();
    expect(before.queue[0]).toMatchObject({ page: 1, state: 'queued' });
    await f.rss.update(target, { id: sub.id, revision: 0, filters: filters(['body']) });
    await f.rss.update(target, { id: sub.id, revision: 1, filters: null });
    expect(f.rss.snapshot().queue).toEqual(before.queue); expect(f.rss.snapshot().entries).toEqual(before.entries);
    expect(f.rss.snapshot().lastSent).toEqual(before.lastSent); expect(f.rss.snapshot().nextSendAt).toBe(before.nextSendAt);
    f.advance(19_999); await f.rss.runOnce(); expect(f.send).toHaveBeenCalledTimes(2);
    f.advance(1); await f.rss.runOnce();
    expect(f.send.mock.calls[2]![2]).toEqual(f.send.mock.calls[1]![2]);
    expect(f.rss.snapshot().queue[0]).toMatchObject({ page: 2, state: 'queued' });
  });

  it.each(['failed', 'cancelled'] as const)('leaves filter, revision, queue and bytes intact after a %s atomic write', async failure => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url, filters: filters(['article']) }, 'en');
    f.articles(entry(2), entry(1, { images: images() })); await f.poll();
    const before = f.rss.snapshot(); const serialized = await readFile(join(f.directory, 'rss.json'), 'utf8');
    const abort = new AbortController();
    f.storage.options.beforeCommit = async () => {
      expect(f.rss.snapshot()).toBe(before);
      if (failure === 'cancelled') abort.abort();
      else throw new Error('write failed');
    };
    await expect(f.rss.update(target, { id: sub.id, revision: 0, filters: filters(['missing']) }, abort.signal))
      .rejects.toThrow(failure === 'cancelled' ? 'CANCELLED' : 'STORAGE_ERROR');
    delete f.storage.options.beforeCommit;
    expect(f.rss.snapshot()).toBe(before);
    expect(await readFile(join(f.directory, 'rss.json'), 'utf8')).toBe(serialized);
    expect(f.send).not.toHaveBeenCalled();
  });

  it('normalizes direct and Action writes identically without weakening validation or revisions', async () => {
    const f = await fixture();
    const sub = await f.rss.add(target, { url, filters: filters([' article '], [' missing ']) }, 'en');
    expect(f.rss.get(target, sub.id).filters).toEqual(filters(['article'], ['missing']));
    await f.rss.update(target, { id: sub.id, revision: 0, filters: filters([' BODY ']), title: '  Trimmed  ' });
    expect(f.rss.get(target, sub.id)).toMatchObject({ filters: filters(['BODY']), title: 'Trimmed' });
    expect(await f.executor.execute(invocation(), 'rss.update', { id: sub.id, revision: 1, filters: filters([' Keep '], [' Hide ']) }))
      .toMatchObject({ status: 'succeeded' });
    expect(f.rss.get(target, sub.id).filters).toEqual(filters(['Keep'], ['Hide']));
    const before = f.rss.snapshot();
    for (const invalid of invalidFilters.filter(value => value !== null)) {
      expect(await f.executor.execute(invocation(), 'rss.update', { id: sub.id, revision: 2, filters: invalid }))
        .toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    }
    expect(f.rss.snapshot()).toBe(before);
    expect(await f.executor.execute(invocation(), 'rss.update', { id: sub.id, revision: 1, filters: null }))
      .toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(await f.executor.execute(invocation(), 'rss.update', { id: sub.id, revision: 2, filters: null }))
      .toMatchObject({ status: 'succeeded' });
    expect(f.rss.get(target, sub.id)).not.toHaveProperty('filters');
  });
});
