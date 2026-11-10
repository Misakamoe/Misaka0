import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { localeSchema, revisionSchema, type Locale, type ModuleMetadata } from '../../shared/schemas/index.js';
import {
  rssAddInputSchema, rssErrorSchema, rssIdSchema, rssListInputSchema, rssListSchema, rssMutationSchema,
  rssRemoveInputSchema, rssSubscriptionSchema, rssUpdateInputSchema, type RssList, type RssUpdate,
} from '../../shared/schemas/rss.js';
import type { ActionExecutor, InvocationContext } from '../actions.js';
import { AppError, throwIfAborted } from '../errors.js';
import { AsyncMutex, JSON_DOCUMENT_MAX_BYTES, JsonDocument, type JsonStorage } from '../storage.js';
import { FEED_MAX_IMAGES, FEED_MAX_IMAGE_BYTES, FEED_MAX_IMAGE_POSITIONS, FEED_MAX_LINKS, FeedFetchError, contentLinkUrl, fetchFeed, normalizeFeedUrl, type FeedEntry, type FeedFetcher, type FeedResponse } from './rss-feed.js';
import { clipFeedContentFormat, feedContentFormatSchema, isValidFeedContentFormat } from './rss-format.js';

export const rssMetadata: ModuleMetadata = {
  id: 'rss', nameKey: 'web:rss.name', descriptionKey: 'web:rss.description', schema_version: 1, configurable: false,
};
export interface RssTarget { chatId: number; kind: 'private' | 'group'; threadId?: number }
export const RSS_IMAGES_PER_MESSAGE = 50;
const RSS_MAX_LINK_BYTES = 4 * 1024;
const RSS_DOCUMENT_HEADROOM = 256 * 1024;
const targetSchema = z.strictObject({
  chatId: z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER).refine(id => id !== 0),
  kind: z.enum(['private', 'group']), threadId: z.number().int().positive().optional(),
}).refine(target => target.kind === 'private' ? target.chatId > 0 : target.chatId < 0);
const entrySchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{64}$/), title: z.string().max(256), url: z.string().max(2048).optional(),
  content: z.string().max(8000).refine(value => value.length <= 8000), publishedAt: z.iso.datetime().optional(), image: z.string().max(2048).optional(),
  images: z.array(z.string().max(2048).refine(value => contentLinkUrl(value) !== undefined)).max(FEED_MAX_IMAGES)
    .refine(images => new Set(images).size === images.length && Buffer.byteLength(JSON.stringify(images)) <= FEED_MAX_IMAGE_BYTES).optional(),
  animationIndices: z.array(z.number().int().min(0).max(FEED_MAX_IMAGES - 1)).max(FEED_MAX_IMAGES).optional(),
  imagePositions: z.array(z.strictObject({ offset: z.number().int().min(0).max(8000),
    imageIndex: z.number().int().min(0).max(FEED_MAX_IMAGES - 1),
  })).max(FEED_MAX_IMAGE_POSITIONS).optional(),
  contentLinks: z.array(z.strictObject({ offset: z.number().int().min(0).max(8000), length: z.number().int().positive().max(8000),
    url: z.string().max(2048).refine(value => contentLinkUrl(value) !== undefined),
  })).max(FEED_MAX_LINKS).optional(),
  contentFormat: feedContentFormatSchema.optional(),
}).refine(entry => (entry.contentLinks ?? []).every((span, index, spans) => span.offset + span.length <= entry.content.length
  && (index === 0 || spans[index - 1]!.offset + spans[index - 1]!.length <= span.offset)), 'Invalid RSS link ranges')
  .refine(entry => {
    const images = entry.images?.length ?? (entry.image ? 1 : 0);
    return (entry.animationIndices ?? []).every((imageIndex, index, indices) => imageIndex < images && (index === 0 || indices[index - 1]! < imageIndex))
      && (entry.imagePositions ?? []).every((position, index, positions) => position.imageIndex < images && position.offset <= entry.content.length
        && (index === 0 || positions[index - 1]!.offset <= position.offset)
        && !/^[\uD800-\uDBFF][\uDC00-\uDFFF]$/.test(entry.content.slice(position.offset - 1, position.offset + 1)));
  }, 'Invalid RSS image metadata')
  .refine(entry => entry.contentFormat === undefined || isValidFeedContentFormat(entry.contentFormat, entry.content, entry.imagePositions), 'Invalid RSS content format');
const entryPayloadSchema = z.strictObject({ kind: z.literal('entry'), entry: entrySchema });
const healthPayloadSchema = z.strictObject({ kind: z.literal('health'), recovered: z.boolean(), error: rssErrorSchema.nullable() });
export type RssPayload = (z.infer<typeof entryPayloadSchema> & { part?: { index: number; total: number } }) | z.infer<typeof healthPayloadSchema>;
const sourceSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{24}$/), url: z.string().max(2048), title: z.string().max(128),
  seen: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(300), etag: z.string().max(1024).optional(), lastModified: z.string().max(256).optional(),
  nextCheckAt: z.number().nonnegative(), intervalSeconds: z.number().int().min(60).max(3600),
  lastCheckAt: z.number().nonnegative().nullable(), lastSuccessAt: z.number().nonnegative().nullable(),
  failures: z.number().int().nonnegative(), totalChecks: z.number().int().nonnegative(), totalFailures: z.number().int().nonnegative(),
  lastError: rssErrorSchema.nullable(), warned: z.boolean(),
});
const subscriptionSchema = z.strictObject({
  id: rssIdSchema, revision: revisionSchema, sourceId: sourceSchema.shape.id, target: targetSchema,
  title: z.string().max(128).optional(), silent: z.boolean(), paused: z.boolean(), language: localeSchema,
  deliveryError: z.enum(['BLOCKED', 'REJECTED', 'UNKNOWN']).nullable(),
});
const queueSchema = z.strictObject({
  id: z.string().regex(/^[a-f0-9]{24}$/), subscriptionId: rssIdSchema,
  payload: z.discriminatedUnion('kind', [entryPayloadSchema, healthPayloadSchema,
    z.strictObject({ kind: z.literal('entry-ref'), entryId: entrySchema.shape.id }),
  ]),
  state: z.enum(['queued', 'sending', 'uncertain']), nextAttemptAt: z.number().nonnegative(),
  // Count acknowledged pages only; a sending or uncertain page has not advanced this cursor.
  page: z.number().int().min(0).max(Math.ceil(FEED_MAX_IMAGES / RSS_IMAGES_PER_MESSAGE) - 1).optional(),
});
const documentSchema = z.strictObject({
  schema_version: z.literal(1), revision: revisionSchema,
  sources: z.array(sourceSchema).max(64), subscriptions: z.array(subscriptionSchema).max(512), queue: z.array(queueSchema).max(128),
  entries: z.record(entrySchema.shape.id, entrySchema).refine(entries => Object.keys(entries).length <= 128).optional(),
  lastSent: z.record(z.string().regex(/^-?[1-9]\d*$/), z.number().nonnegative()),
  nextSendAt: z.number().nonnegative(),
}).superRefine((value, context) => {
  const sources = new Set(value.sources.map(source => source.id));
  const subscriptions = new Set(value.subscriptions.map(subscription => subscription.id));
  if (sources.size !== value.sources.length || subscriptions.size !== value.subscriptions.length
    || value.subscriptions.some(subscription => !sources.has(subscription.sourceId))
    || value.queue.some(item => !subscriptions.has(item.subscriptionId))) context.addIssue({ code: 'custom', message: 'Invalid RSS references' });
  for (const job of value.queue) {
    const entry = job.payload.kind === 'entry-ref' ? value.entries?.[job.payload.entryId] : job.payload.kind === 'entry' ? job.payload.entry : undefined;
    if (job.payload.kind === 'entry-ref' && !entry || (job.page ?? 0) >= Math.max(1, Math.ceil((entry?.images?.length ?? 0) / RSS_IMAGES_PER_MESSAGE))) {
      context.addIssue({ code: 'custom', message: 'Invalid RSS page reference' });
    }
  }
});
type RssDocument = z.infer<typeof documentSchema>;
type Subscription = z.infer<typeof subscriptionSchema>;
type Source = z.infer<typeof sourceSchema>;
export class RssDeliveryError extends Error {
  constructor(readonly code: 'RATE_LIMITED' | 'BLOCKED' | 'REJECTED' | 'UNKNOWN', readonly retryAfterMs = 60_000) { super(code); }
}
export interface RssOptions {
  allowed: (target: RssTarget) => boolean;
  send: (target: RssTarget, title: string, payload: RssPayload, language: Locale, silent: boolean, signal: AbortSignal) => Promise<void>;
  fetcher?: FeedFetcher;
  now?: () => number;
  onError?: (error: unknown) => void;
}
function sameTarget(left: RssTarget, right: RssTarget): boolean {
  return left.chatId === right.chatId && left.kind === right.kind && (left.threadId ?? 0) === (right.threadId ?? 0);
}
function boundedEntry(entry: FeedEntry): z.infer<typeof entrySchema> {
  const prefix = entry.content.length <= 8000 ? entry.content : entry.content.slice(0, 7997).replace(/[\uD800-\uDBFF]$/, '');
  if (entry.contentFormat !== undefined && !isValidFeedContentFormat(entry.contentFormat, entry.content, entry.imagePositions)) throw new FeedFetchError('INVALID_FEED');
  const bounded = entrySchema.parse({ ...entry, content: prefix + (prefix.length < entry.content.length ? '...' : ''),
    ...(entry.contentLinks ? { contentLinks: entry.contentLinks.filter(span => span.offset < prefix.length)
      .map(span => ({ ...span, length: Math.min(span.length, prefix.length - span.offset) })) } : {}),
    ...(entry.imagePositions ? { imagePositions: entry.imagePositions.filter(position => position.offset <= prefix.length) } : {}),
    ...(entry.contentFormat ? { contentFormat: clipFeedContentFormat(entry.contentFormat, entry.content, entry.imagePositions ?? [], prefix.length) } : {}),
  });
  // Budget new compact JSON metadata only; existing queued entries still load unchanged.
  let linkBytes = 2;
  if (bounded.contentLinks) bounded.contentLinks = bounded.contentLinks.filter(span => {
    const bytes = Buffer.byteLength(JSON.stringify(span)) + 1;
    if (linkBytes + bytes > RSS_MAX_LINK_BYTES) return false;
    linkBytes += bytes;
    return true;
  });
  return bounded;
}
function boundedResponse(response: FeedResponse): FeedResponse {
  try {
    return response.feed ? { ...response, feed: { ...response.feed, entries: response.feed.entries.map(boundedEntry) } } : response;
  } catch (error) {
    if (error instanceof z.ZodError || error instanceof RangeError) throw new FeedFetchError('INVALID_FEED');
    throw error;
  }
}
function collectEntries(state: RssDocument): void {
  if (!state.entries) return;
  const referenced = new Set(state.queue.flatMap(job => job.payload.kind === 'entry-ref' ? [job.payload.entryId] : []));
  for (const id of Object.keys(state.entries)) if (!referenced.has(id)) delete state.entries[id];
  if (!Object.keys(state.entries).length) delete state.entries;
}

export class RssService {
  private readonly file: JsonDocument<RssDocument>;
  private readonly lock = new AsyncMutex();
  private readonly abort = new AbortController();
  private readonly now: () => number;
  private readonly fetcher: FeedFetcher;
  private timer?: ReturnType<typeof setTimeout>;
  private task?: Promise<void>;
  private started = false;
  private closed = false;

  constructor(storage: JsonStorage, private readonly options: RssOptions) {
    this.file = new JsonDocument(storage, 'rss.json', documentSchema);
    this.now = options.now ?? Date.now;
    this.fetcher = options.fetcher ?? fetchFeed;
  }
  async initialize(): Promise<void> {
    await this.file.load({ schema_version: 1, revision: 0, sources: [], subscriptions: [], queue: [], lastSent: {}, nextSendAt: 0 });
    // A process crash after sending cannot safely be retried without Telegram idempotency keys.
    await this.file.update(state => {
      for (const job of state.queue) if (job.state === 'sending') {
        job.state = 'uncertain';
        state.subscriptions.find(subscription => subscription.id === job.subscriptionId)!.deliveryError = 'UNKNOWN';
      }
      collectEntries(state);
    });
  }
  snapshot(): RssDocument { return this.file.snapshot(); }
  private assertTarget(target: RssTarget): void {
    if (this.closed) throw new AppError('CANCELLED');
    if (!targetSchema.safeParse(target).success || !this.options.allowed(target)) throw new AppError('FORBIDDEN');
  }
  list(target: RssTarget, page = 0): RssList {
    this.assertTarget(target);
    rssListInputSchema.parse({ page });
    const state = this.snapshot();
    const subscriptions = state.subscriptions.filter(subscription => sameTarget(subscription.target, target));
    const selected = Math.max(0, Math.min(page, Math.ceil(subscriptions.length / 5) - 1));
    return { total: subscriptions.length, page: selected, pageSize: 5, items: subscriptions.slice(selected * 5, selected * 5 + 5).map(subscription => {
      const source = state.sources.find(source => source.id === subscription.sourceId)!;
      const jobs = state.queue.filter(job => job.subscriptionId === subscription.id);
      return { id: subscription.id, revision: subscription.revision, title: subscription.title ?? source.title, url: source.url,
        silent: subscription.silent, paused: subscription.paused, intervalSeconds: source.intervalSeconds,
        lastCheckAt: source.lastCheckAt, lastSuccessAt: source.lastSuccessAt, failures: source.failures, totalChecks: source.totalChecks,
        totalFailures: source.totalFailures, lastError: source.lastError, pending: jobs.filter(job => job.state !== 'uncertain').length,
        uncertain: jobs.filter(job => job.state === 'uncertain').length, deliveryError: subscription.deliveryError };
    }) };
  }
  get(target: RssTarget, id: string) {
    this.assertTarget(target);
    rssIdSchema.parse(id);
    const subscriptions = this.snapshot().subscriptions.filter(subscription => sameTarget(subscription.target, target));
    const index = subscriptions.findIndex(subscription => subscription.id === id);
    if (index < 0) throw new AppError('NOT_FOUND');
    return this.list(target, Math.floor(index / 5)).items.find(subscription => subscription.id === id)!;
  }
  async add(target: RssTarget, raw: z.input<typeof rssAddInputSchema>, language: Locale, signal?: AbortSignal) {
    this.assertTarget(target);
    const input = rssAddInputSchema.parse(raw);
    let url: string;
    try { url = normalizeFeedUrl(input.url); } catch { throw new AppError('INVALID_INPUT', ['rss.UNSAFE_URL']); }
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    try { return await this.lock.run(async () => {
      this.assertTarget(target);
      const sourceId = createHash('sha256').update(url).digest('hex').slice(0, 24);
      const current = this.snapshot();
      const existing = current.subscriptions.find(subscription => subscription.sourceId === sourceId && sameTarget(subscription.target, target));
      if (existing) return { id: existing.id, changed: false };
      if (current.subscriptions.length >= 512 || current.subscriptions.filter(subscription => sameTarget(subscription.target, target)).length >= 20
        || current.subscriptions.filter(subscription => subscription.sourceId === sourceId).length >= 128
        || current.sources.length >= 64 && !current.sources.some(source => source.id === sourceId)) throw new AppError('CAPACITY');
      let response: FeedResponse;
      try { response = boundedResponse(await this.fetcher(url, {}, combined)); }
      catch (error) { throwIfAborted(combined); throw new AppError('UNAVAILABLE', [`rss.${error instanceof FeedFetchError ? error.code : 'NETWORK'}`]); }
      if (!response.feed || response.notModified) throw new AppError('UNAVAILABLE', ['rss.INVALID_FEED']);
      let id: string;
      do { id = randomBytes(6).toString('hex'); } while (current.subscriptions.some(subscription => subscription.id === id));
      await this.file.update(state => {
        this.assertTarget(target);
        const source = state.sources.find(source => source.id === sourceId);
        if (source) {
          // Flush discoveries for existing subscribers before adding a new subscriber's baseline.
          if (!this.acceptFeed(state, source, response, true)) throw new AppError('CAPACITY');
        } else {
          state.sources.push({ id: sourceId, url, title: response.feed!.title, seen: response.feed!.entries.map(entry => entry.id).slice(0, 300),
            etag: response.etag, lastModified: response.lastModified, nextCheckAt: this.now() + 300_000, intervalSeconds: 300,
            lastCheckAt: this.now(), lastSuccessAt: this.now(), failures: 0, totalChecks: 1, totalFailures: 0, lastError: null, warned: false });
        }
        state.subscriptions.push({ id, revision: 0, sourceId, target, language, title: input.title, silent: input.silent, paused: false, deliveryError: null });
      }, { signal: combined });
      return { id, changed: true };
    }, combined); } finally { this.arm(); }
  }
  async update(target: RssTarget, input: RssUpdate, signal?: AbortSignal) {
    this.assertTarget(target);
    rssUpdateInputSchema.parse(input);
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    try { return await this.lock.run(async () => {
      const result = await this.file.update(state => {
        this.assertTarget(target);
        const subscription = this.owned(state, target, input.id, input.revision);
        if (input.silent !== undefined) subscription.silent = input.silent;
        if (input.paused !== undefined) {
          subscription.paused = input.paused;
          if (input.paused) {
            state.queue = state.queue.filter(job => job.subscriptionId !== input.id);
            collectEntries(state);
          } else subscription.deliveryError = null;
        }
        if (input.title !== undefined) subscription.title = input.title ?? undefined;
        subscription.revision += 1;
      }, { signal: combined });
      return { id: input.id, changed: result.changed };
    }, combined); } finally { this.arm(); }
  }
  async remove(target: RssTarget, id: string, revision: number, signal?: AbortSignal) {
    this.assertTarget(target);
    rssRemoveInputSchema.parse({ id, revision });
    const combined = AbortSignal.any([this.abort.signal, ...(signal ? [signal] : [])]);
    try { return await this.lock.run(async () => {
      await this.file.update(state => {
        this.assertTarget(target);
        this.owned(state, target, id, revision);
        state.subscriptions = state.subscriptions.filter(subscription => subscription.id !== id);
        state.queue = state.queue.filter(job => job.subscriptionId !== id);
        collectEntries(state);
        state.sources = state.sources.filter(source => state.subscriptions.some(subscription => subscription.sourceId === source.id));
        if (!state.subscriptions.some(subscription => subscription.target.chatId === target.chatId)) delete state.lastSent[String(target.chatId)];
      }, { signal: combined });
      return { id, changed: true };
    }, combined); } finally { this.arm(); }
  }
  private owned(state: RssDocument, target: RssTarget, id: string, revision: number): Subscription {
    const subscription = state.subscriptions.find(subscription => subscription.id === id && sameTarget(subscription.target, target));
    if (!subscription) throw new AppError('NOT_FOUND');
    if (subscription.revision !== revision) throw new AppError('CONFLICT');
    return subscription;
  }
  private active(state: RssDocument, sourceId: string): Subscription[] {
    return state.subscriptions.filter(subscription => subscription.sourceId === sourceId && !subscription.paused && this.options.allowed(subscription.target));
  }
  private enqueue(state: RssDocument, subscriptions: Subscription[], payload: RssPayload): boolean {
    if (!subscriptions.length) return true;
    if (state.queue.length + subscriptions.length > 128) return false;
    const previousLength = state.queue.length;
    let stored: z.infer<typeof queueSchema>['payload'] = payload;
    if (payload.kind === 'entry' && (payload.entry.images?.length || payload.entry.contentFormat)) {
      const entryId = createHash('sha256').update(JSON.stringify(payload.entry)).digest('hex');
      (state.entries ??= {})[entryId] = payload.entry;
      stored = { kind: 'entry-ref', entryId };
    }
    for (const subscription of subscriptions) state.queue.push({ id: randomBytes(12).toString('hex'), subscriptionId: subscription.id,
      payload: stored, state: 'queued', nextAttemptAt: this.now(), ...(stored.kind === 'entry-ref' ? { page: 0 } : {}) });
    // Match JsonDocument's pretty JSON format, reserving space for source bookkeeping and delivery progress.
    if (Buffer.byteLength(JSON.stringify(state, null, 2)) + 1 > JSON_DOCUMENT_MAX_BYTES - RSS_DOCUMENT_HEADROOM) {
      state.queue.splice(previousLength);
      collectEntries(state);
      return false;
    }
    return true;
  }
  private acceptFeed(state: RssDocument, source: Source, response: FeedResponse, adding = false): boolean {
    const subscriptions = this.active(state, source.id);
    const entries = response.feed?.entries ?? [];
    const unseen = entries.filter(entry => !source.seen.includes(entry.id)).reverse();
    const accepted: string[] = [];
    let complete = true;
    for (const entry of unseen) {
      if (!this.enqueue(state, subscriptions, { kind: 'entry', entry })) { complete = false; break; }
      accepted.push(entry.id);
    }
    if (adding && !complete) return false;
    source.seen = [...new Set([...accepted.reverse(), ...source.seen])].slice(0, 300);
    if (response.feed) source.title = response.feed.title;
    // Do not cache a partial batch: a 304 would hide entries still waiting for queue capacity.
    source.etag = complete ? response.etag ?? (response.notModified ? source.etag : undefined) : undefined;
    source.lastModified = complete ? response.lastModified ?? (response.notModified ? source.lastModified : undefined) : undefined;
    source.totalChecks += 1; source.failures = 0; source.lastError = null;
    source.lastCheckAt = source.lastSuccessAt = this.now();
    if (source.warned && this.enqueue(state, subscriptions, { kind: 'health', recovered: true, error: null })) source.warned = false;
    source.intervalSeconds = !complete ? 60 : unseen.length ? Math.max(60, Math.floor(source.intervalSeconds * 0.7)) : Math.min(3600, Math.ceil(source.intervalSeconds * 1.3));
    source.nextCheckAt = this.now() + source.intervalSeconds * 1000;
    return complete;
  }
  start(): void {
    if (this.closed) throw new AppError('CANCELLED');
    this.started = true; this.arm();
  }
  private due(): { kind: 'delivery' | 'source'; id: string; at: number } | undefined {
    const state = this.snapshot();
    let next: { kind: 'delivery' | 'source'; id: string; at: number } | undefined;
    for (const job of state.queue) if (job.state === 'queued') {
      const subscription = state.subscriptions.find(subscription => subscription.id === job.subscriptionId)!;
      const at = Math.max(job.nextAttemptAt, state.nextSendAt, (state.lastSent[String(subscription.target.chatId)] ?? 0) + 3000);
      if (!next || at < next.at) next = { kind: 'delivery', id: job.id, at };
    }
    for (const source of state.sources) if (this.active(state, source.id).length && (!next || source.nextCheckAt < next.at)) {
      next = { kind: 'source', id: source.id, at: source.nextCheckAt };
    }
    return next;
  }
  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.started || this.closed || this.task) return;
    const next = this.due();
    if (next) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.runOnce().catch(error => { this.started = false; if (this.timer) clearTimeout(this.timer); this.options.onError?.(error); });
      }, Math.max(0, Math.min(2_147_483_647, next.at - this.now())));
      this.timer.unref();
    }
  }
  runOnce(): Promise<void> {
    if (this.closed) return Promise.reject(new AppError('CANCELLED'));
    if (this.task) return this.task;
    this.task = this.lock.run(async () => {
      const next = this.due();
      if (!next || next.at > this.now()) return;
      if (next.kind === 'delivery') { await this.deliver(next.id); return; }
      const source = this.snapshot().sources.find(source => source.id === next.id)!;
      let response: FeedResponse;
      try {
        response = boundedResponse(await this.fetcher(source.url, { etag: source.etag, lastModified: source.lastModified }, this.abort.signal));
        if (!response.notModified && !response.feed) throw new FeedFetchError('INVALID_FEED');
      }
      catch (error) {
        throwIfAborted(this.abort.signal);
        await this.file.update(state => {
          const source = state.sources.find(source => source.id === next.id)!;
          source.lastCheckAt = this.now(); source.failures += 1; source.totalChecks += 1; source.totalFailures += 1;
          source.lastError = error instanceof FeedFetchError ? error.code : 'NETWORK';
          source.intervalSeconds = Math.min(3600, Math.max(300, source.intervalSeconds * 2));
          source.nextCheckAt = this.now() + Math.max(source.intervalSeconds * 1000, error instanceof FeedFetchError ? error.retryAfterMs ?? 0 : 0);
          if (source.failures >= 5 && !source.warned && this.enqueue(state, this.active(state, source.id), { kind: 'health', recovered: false, error: source.lastError })) source.warned = true;
        });
        return;
      }
      await this.file.update(state => { this.acceptFeed(state, state.sources.find(source => source.id === next.id)!, response); }, { signal: this.abort.signal });
    }, this.abort.signal).finally(() => { this.task = undefined; this.arm(); });
    return this.task;
  }
  private async deliver(id: string): Promise<void> {
    const state = this.snapshot();
    const job = state.queue.find(job => job.id === id)!;
    const subscription = state.subscriptions.find(subscription => subscription.id === job.subscriptionId)!;
    if (subscription.paused || !this.options.allowed(subscription.target)) {
      await this.file.update(state => {
        state.queue = state.queue.filter(item => item.subscriptionId !== subscription.id || item.state === 'uncertain');
        collectEntries(state);
      });
      return;
    }
    let payload: RssPayload = job.payload.kind === 'entry-ref' ? { kind: 'entry', entry: state.entries![job.payload.entryId]! } : job.payload;
    const page = job.page ?? 0;
    const total = payload.kind === 'entry' ? Math.max(1, Math.ceil((payload.entry.images?.length ?? 0) / RSS_IMAGES_PER_MESSAGE)) : 1;
    if (payload.kind === 'entry' && total > 1) payload = { ...payload, part: { index: page + 1, total } };
    const source = state.sources.find(source => source.id === subscription.sourceId)!;
    await this.file.update(state => {
      state.queue.find(item => item.id === id)!.state = 'sending';
      state.lastSent[String(subscription.target.chatId)] = this.now();
      state.nextSendAt = this.now() + 100;
    }, { signal: this.abort.signal });
    try {
      if (!this.options.allowed(subscription.target)) throw new RssDeliveryError('BLOCKED');
      await this.options.send(subscription.target, subscription.title ?? source.title, payload, subscription.language, subscription.silent, this.abort.signal);
    } catch (error) {
      await this.file.update(state => {
        const item = state.queue.find(item => item.id === id)!;
        const subscription = state.subscriptions.find(subscription => subscription.id === item.subscriptionId)!;
        if (error instanceof RssDeliveryError && error.code === 'RATE_LIMITED' && !this.abort.signal.aborted) {
          item.state = 'queued'; item.nextAttemptAt = this.now() + Math.min(86_400_000, Math.max(1000, error.retryAfterMs));
          state.nextSendAt = item.nextAttemptAt;
        } else {
          item.state = 'uncertain';
          subscription.deliveryError = error instanceof RssDeliveryError && error.code !== 'RATE_LIMITED' ? error.code : 'UNKNOWN';
          if (subscription.deliveryError === 'BLOCKED') {
            subscription.paused = true; subscription.revision += 1;
            state.queue = state.queue.filter(item => item.subscriptionId !== subscription.id || item.state === 'uncertain');
            collectEntries(state);
          }
        }
      });
      return;
    }
    await this.file.update(state => {
      if (page + 1 < total) {
        const item = state.queue.find(item => item.id === id)!;
        item.page = page + 1;
        item.state = 'queued';
      } else state.queue = state.queue.filter(item => item.id !== id);
      collectEntries(state);
      state.subscriptions.find(item => item.id === subscription.id)!.deliveryError = null;
    });
  }
  async stop(): Promise<void> {
    this.closed = true; this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abort.abort();
    await this.task?.catch(() => undefined);
    await this.lock.drain();
  }
}

export function registerRssActions(executor: Pick<ActionExecutor, 'register'>, service: RssService): void {
  const common = { permission: 'chat_manager', scopes: ['private', 'group'], sources: ['telegram', 'http'], aiVisible: false, timeoutMs: 30_000 } as const;
  const target = (context: InvocationContext): RssTarget => ({ chatId: context.chat.id, kind: context.chat.type === 'private' ? 'private' : 'group', threadId: context.chat.threadId });
  executor.register({ ...common, id: 'rss.list', input: rssListInputSchema, output: rssListSchema, effect: 'read', execute: (input, context) => service.list(target(context), input.page) });
  executor.register({ ...common, id: 'rss.get', input: rssRemoveInputSchema.pick({ id: true }), output: rssSubscriptionSchema, effect: 'read', execute: (input, context) => service.get(target(context), input.id) });
  executor.register({ ...common, id: 'rss.add', input: rssAddInputSchema, output: rssMutationSchema, effect: 'permission', execute: (input, context) => service.add(target(context), input, context.language, context.signal) });
  executor.register({ ...common, id: 'rss.update', input: rssUpdateInputSchema, output: rssMutationSchema, effect: 'permission', execute: (input, context) => service.update(target(context), input, context.signal) });
  executor.register({ ...common, id: 'rss.remove', input: rssRemoveInputSchema, output: rssMutationSchema, effect: 'permission', execute: (input, context) => service.remove(target(context), input.id, input.revision, context.signal) });
}
