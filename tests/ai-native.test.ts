import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { subconvDefaults } from '../shared/schemas/subconv.js';
import type { SubconvSources, StickerSources } from '../shared/schemas/ai-native.js';
import { ActionExecutor, type InvocationContext, type InvocationInput } from '../src/actions.js';
import { AppError } from '../src/errors.js';
import { SubconvService, type SubconvNativeDelivery } from '../src/modules/subconv.js';
import type { StickerTransport } from '../src/modules/sticker.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); });
const location = { id: 'city', name: 'City', label: 'City', latitude: 30, longitude: 120, country: 'CN', timezone: 'Asia/Shanghai' };
const secrets = ['source-secret', 'backend-secret', 'remote-secret', 'include-secret', 'exclude-secret', 'filename-secret', 'custom-secret', 'target-secret'];
const rawSource = 'https://subscription.example.com/feed?token=source-secret';
const privateSettings = () => ({ ...subconvDefaults(), backend: 'https://converter.example.com/custom?key=backend-secret', options: {
  ...subconvDefaults().options, remoteConfig: 'https://rules.example.com/config?token=remote-secret', include: 'include-secret',
  exclude: 'exclude-secret', filename: 'filename-secret',
} });
const human = (context: InvocationContext) => invocation({ actorId: context.actorId, botId: context.botId, chat: context.chat });
function safe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const secret of secrets) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('telegram-file-id');
}

async function fixture(options: { delivery?: SubconvNativeDelivery | null; now?: () => number } = {}) {
  const fetched = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
  const send = vi.fn<StickerTransport['send']>(async () => 77);
  const download = vi.fn(async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const base = await coreFixture({ rss: { fetcher: fetched }, sticker: { transport: { download, send, getSet: vi.fn() } },
    rate: { key: 'fixture-rate-key', json: async url => url.pathname.endsWith('/codes')
      ? { result: 'success', supported_codes: [['USD', 'US Dollar'], ['CNY', 'Yuan'], ['JPY', 'Yen']] }
      : { result: 'success', base_code: 'USD', time_last_update_unix: Math.floor(Date.now() / 1000), time_next_update_unix: Math.floor(Date.now() / 1000) + 3600, conversion_rates: { USD: 1, CNY: 7, JPY: 150 } } },
    weather: { qweatherHost: 'fixture.qweatherapi.com', qweatherKey: 'fixture-weather-key', json: async url => url.pathname.includes('lookup')
      ? { code: '200', location: [{ id: 'city', name: 'City', lat: '30', lon: '120', adm1: 'Region', adm2: 'City', country: 'CN', tz: 'Asia/Shanghai' }] }
      : { temperature: { value: 20 }, feelsLike: { value: 19 }, condition: { text: 'Sunny', code: 100 }, humidity: 0.4,
        wind: { speed: { value: 1 } }, metadata: { attributions: ['https://weather.example.com/'] } } },
  });
  await base.executor.close();
  const subconv = new SubconvService(base.storage, { now: options.now }); await subconv.initialize();
  const runs = new Map<string, InvocationContext>();
  const revoked = new Set<string>();
  let sequence = 0;
  const authorize = vi.fn((context: InvocationContext) => {
    const run = context.aiRunId && runs.get(context.aiRunId);
    if (!run || revoked.has(context.aiRunId!) || run.actorId !== context.actorId || run.botId !== context.botId
      || run.chat.id !== context.chat.id || run.chat.threadId !== context.chat.threadId) throw new AppError('FORBIDDEN');
  });
  const groupAdmin = vi.fn(async (_chatId: number, actorId: number) => actorId === 3);
  const observer = vi.fn();
  const delivery = options.delivery === null ? undefined : options.delivery ?? vi.fn<SubconvNativeDelivery>(async () => {});
  const executor = new ActionExecutor({ ...base.services, subconv, groupAdmin, onResult: observer,
    aiPolicy: { available: () => true, authorize }, ...(delivery ? { aiNativeDelivery: delivery } : {}),
  });
  const ai = (overrides: Partial<InvocationInput> = {}) => {
    const context = invocation({ source: 'ai', aiRunId: `native-run-${++sequence}`, ...overrides });
    runs.set(context.aiRunId!, context);
    return context;
  };
  cleanup.push(async () => { await executor.close(); subconv.stop(); await base.close(); });
  return { ...base, executor, subconv, ai, runs, revoked, authorize, groupAdmin, observer, delivery, fetched, send, download };
}

async function captureSubscription(f: Awaited<ReturnType<typeof fixture>>, context = f.ai(), source = rawSource) {
  const owner = human(context);
  const current = f.subconv.settings(owner);
  await f.subconv.update(owner, privateSettings(), current.revision);
  const revision = current.revision + 1;
  const generated = f.subconv.generate(owner, { revision, source, customParams: [{ name: 'token', value: 'custom-secret' }, { name: 'target', value: 'target-secret' }] });
  const sources = f.subconv.listSources(context);
  return { context, owner, revision, generated, sourceRef: sources.items[0]!.sourceRef };
}

describe('native AI discovery and business permissions', () => {
  it('exposes all safe native capabilities with strict schemas, not raw subconv configuration or generation', async () => {
    const f = await fixture();
    const tools = await f.executor.discoverTools(f.ai());
    expect(tools.map(tool => tool.id)).toEqual(expect.arrayContaining([
      'alias.list', 'alias.add', 'alias.remove', 'rss.list', 'rss.get', 'rss.add', 'rss.update', 'rss.remove',
      'rate.convert', 'rate.currencies', 'weather.search', 'weather.query', 'weather.default.get', 'weather.default.set',
      'sticker.sources', 'sticker.inspect', 'sticker.convert', 'sticker.cancel', 'subconv.settings.get', 'subconv.options.set', 'subconv.sources', 'subconv.generate_owned',
    ]));
    expect(tools.map(tool => tool.id)).not.toEqual(expect.arrayContaining(['subconv.settings.set']));
    expect(tools.some(tool => ['subconv.settings.set', 'subconv.settings.reset', 'subconv.generate'].includes(tool.id))).toBe(false);
    for (const tool of tools) { expect(tool.inputSchema.additionalProperties).toBe(false); expect(tool.description.length).toBeGreaterThan(8); }
    const settings = tools.find(tool => tool.id === 'subconv.settings.get')!;
    expect(settings.outputSchema.properties).toHaveProperty('configured');
    for (const key of ['backend', 'remoteConfig', 'include', 'exclude', 'filename', 'source', 'customParams', 'settings']) expect(settings.outputSchema.properties).not.toHaveProperty(key);
    const generate = tools.find(tool => tool.id === 'subconv.generate_owned')!;
    expect(Object.keys(generate.inputSchema.properties as object)).toEqual(['sourceRef', 'revision']);
    expect(Object.keys(generate.outputSchema.properties as object)).toEqual(['delivered', 'sourceCount']);
    expect(tools.find(tool => tool.id === 'subconv.options.set')!.inputSchema.properties).not.toHaveProperty('source');
  });

  it('retains actor-specific private defaults and working native currency/weather reads', async () => {
    const f = await fixture();
    const first = f.ai({ actorId: 3, chat: { id: 3, type: 'private' } });
    const second = f.ai({ actorId: 4, chat: { id: 4, type: 'private' } });
    expect(await f.executor.execute(first, 'weather.default.set', { location, revision: 0 })).toMatchObject({ status: 'succeeded', data: { revision: 1, location } });
    expect(await f.executor.execute(second, 'weather.default.get', {})).toMatchObject({ status: 'succeeded', data: { revision: 0, location: null } });
    expect(await f.executor.execute(first, 'rate.convert', { query: '10 USD CNY' })).toMatchObject({ status: 'succeeded', data: { kind: 'converted', result: '70' } });
    expect(await f.executor.execute(first, 'rate.currencies', { page: 0 })).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.execute(first, 'weather.search', { query: 'City' })).toMatchObject({ status: 'succeeded' });
    expect(await f.executor.execute(first, 'weather.query', { location, mode: 'current', days: 3 })).toMatchObject({ status: 'succeeded', data: { location } });
    expect(await f.executor.execute(first, 'weather.default.set', { location, revision: 1, actorId: 4 })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(f.authorize.mock.calls.some(([context]) => context.actorId === 3)).toBe(true);
    expect(f.authorize.mock.calls.some(([context]) => context.actorId === 4)).toBe(true);
  });

  it('keeps aliases private configured-superadministrator only and confirms AI mutations with original provenance', async () => {
    const f = await fixture();
    const ordinary = f.ai({ actorId: 3, chat: { id: 3, type: 'private' } });
    expect((await f.executor.discoverTools(ordinary)).some(tool => tool.id.startsWith('alias.'))).toBe(false);
    expect(await f.executor.execute(ordinary, 'alias.add', { command: 'help', alias: 'assist', revision: 0 })).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    const context = f.ai();
    const pending = await f.executor.execute(context, 'alias.add', { command: 'help', alias: 'assist', revision: 0 });
    expect(pending.status).toBe('pending_confirmation');
    expect(f.aliases.resolve('assist')).toBeUndefined();
    if (pending.status !== 'pending_confirmation') throw new Error('missing approval');
    expect(await f.executor.confirm(human(context), pending.confirmation.token)).toMatchObject({ status: 'succeeded', data: { changed: true, revision: 1 } });
    expect(f.aliases.resolve('assist')).toBe('help');
    expect(f.observer.mock.calls.at(-1)![0]).toMatchObject({ source: 'ai', actorId: 1, aiRunId: context.aiRunId });
    expect(await f.executor.confirm(human(context), pending.confirmation.token)).toMatchObject({ status: 'rejected', error: { code: 'CONFIRMATION_EXPIRED' } });
    const removeContext = f.ai();
    const remove = await f.executor.execute(removeContext, 'alias.remove', { command: 'help', alias: 'assist', revision: 1 });
    if (remove.status !== 'pending_confirmation') throw new Error('missing approval');
    f.revoked.add(removeContext.aiRunId!);
    expect(await f.executor.confirm(human(removeContext), remove.confirmation.token)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(f.aliases.resolve('assist')).toBe('help');
    const fresh = f.ai();
    const finalRemove = await f.executor.execute(fresh, 'alias.remove', { command: 'help', alias: 'assist', revision: 1 });
    if (finalRemove.status !== 'pending_confirmation') throw new Error('missing approval');
    expect(await f.executor.confirm(human(fresh), finalRemove.confirmation.token)).toMatchObject({ status: 'succeeded' });
    expect(f.aliases.resolve('assist')).toBeUndefined();
  });

  it('does not grant ordinary group actors RSS management and binds confirmed mutations to the actual topic', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const manager = f.ai({ actorId: 3, chat: { id: -100, type: 'supergroup', threadId: 7 } });
    const ordinary = f.ai({ actorId: 4, chat: manager.chat });
    const tools = await f.executor.discoverTools(ordinary);
    expect(tools.some(tool => /^(rss|alias|sticker|subconv)\./.test(tool.id) || tool.id.startsWith('weather.default.'))).toBe(false);
    expect(tools.some(tool => tool.id === 'rate.convert')).toBe(true);
    expect(await f.executor.execute(ordinary, 'rss.list', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    const pending = await f.executor.execute(manager, 'rss.add', { url: 'https://feeds.example.com/rss' });
    if (pending.status !== 'pending_confirmation') throw new Error('missing approval');
    expect(pending.confirmation.target).toBe('chat:-100'); expect(f.fetched).not.toHaveBeenCalled();
    expect(await f.executor.confirm(human(ordinary), pending.confirmation.token)).toMatchObject({ status: 'rejected' });
    expect(await f.executor.confirm(invocation({ actorId: 3, chat: { ...manager.chat, threadId: 8 } }), pending.confirmation.token)).toMatchObject({ status: 'rejected' });
    const result = await f.executor.confirm<{ id: string }>(human(manager), pending.confirmation.token);
    expect(result.status).toBe('succeeded'); expect(f.fetched).toHaveBeenCalledTimes(1);
    if (result.status !== 'succeeded') throw new Error('missing mutation');
    expect(await f.executor.execute(manager, 'rss.list', {})).toMatchObject({ status: 'succeeded', data: { total: 1 } });
    const otherTopic = f.ai({ actorId: 3, chat: { ...manager.chat, threadId: 8 } });
    expect(await f.executor.execute(otherTopic, 'rss.list', {})).toMatchObject({ status: 'succeeded', data: { total: 0 } });
    expect(await f.executor.execute(otherTopic, 'rss.get', { id: result.data.id })).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    expect(f.groupAdmin.mock.calls.some(([, actor]) => actor === 3)).toBe(true);
    expect(f.groupAdmin.mock.calls.some(([, actor]) => actor === 4)).toBe(true);
    expect(f.observer.mock.calls.find(([, id]) => id === 'rss.add')?.[0]).toMatchObject({ source: 'ai', actorId: 3, aiRunId: manager.aiRunId, chat: { threadId: 7 } });
    expect(await f.executor.execute(manager, 'rss.add', { url: 'https://feeds.example.com/other', threadId: 8 })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    const next = f.ai({ actorId: 3, chat: manager.chat });
    const update = await f.executor.execute(next, 'rss.update', { id: result.data.id, revision: 0, paused: true });
    if (update.status !== 'pending_confirmation') throw new Error('missing approval');
    expect(await f.executor.confirm(human(next), update.confirmation.token)).toMatchObject({ status: 'succeeded' });
    const remove = await f.executor.execute(f.ai({ actorId: 3, chat: manager.chat }), 'rss.remove', { id: result.data.id, revision: 1 });
    if (remove.status !== 'pending_confirmation') throw new Error('missing approval');
    f.groupAdmin.mockResolvedValue(false);
    expect(await f.executor.confirm(human(next), remove.confirmation.token)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(f.rss.get({ chatId: -100, threadId: 7, kind: 'group' }, result.data.id)).toMatchObject({ paused: true, revision: 1 });
  });
});

describe('owned native sticker references', () => {
  it('requires a real authorized run, preserves source identity, and exposes no Telegram IDs', async () => {
    const f = await fixture();
    const context = f.ai({ actorId: 3, chat: { id: 3, type: 'private', threadId: 5 } });
    const capture = { kind: 'single' as const, sticker: { fileId: 'telegram-file-id', uniqueId: 'unique', kind: 'static' as const, width: 1, height: 1 } };
    const reference = f.stickers.capture(human(context), capture, 12);
    expect(() => f.stickers.capture(context, capture, 13)).toThrow('FORBIDDEN');
    expect(() => f.stickers.listSources(invocation({ source: 'ai' }))).toThrow('FORBIDDEN');
    const list = await f.executor.execute<StickerSources>(context, 'sticker.sources', {});
    expect(list).toMatchObject({ status: 'succeeded', data: { items: [{ source: reference, kind: 'single', sourceKind: 'static' }] } });
    safe(list);
    expect(await f.executor.execute(context, 'sticker.inspect', { source: reference })).toMatchObject({ status: 'succeeded', data: { source: reference, count: 1 } });
    const result = await f.executor.execute(context, 'sticker.convert', { source: reference, format: 'original', delivery: 'file' });
    expect(result).toMatchObject({ status: 'succeeded', data: { format: 'png', delivery: 'document', messageId: 77 } }); safe(result);
    expect(f.send.mock.calls[0]![0]).toEqual({ chatId: 3, threadId: 5, replyTo: 12 });
    expect(await f.executor.execute(invocation({ source: 'ai' }), 'sticker.sources', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    const forgedRun = invocation({ source: 'ai', aiRunId: context.aiRunId, actorId: 4, chat: { id: 4, type: 'private' } });
    expect(await f.executor.execute(forgedRun, 'sticker.sources', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    for (const other of [f.ai({ actorId: 4, chat: { id: 4, type: 'private' } }), f.ai({ botId: 999, actorId: 3, chat: context.chat }), f.ai({ actorId: 3, chat: { ...context.chat, threadId: 6 } })]) {
      expect(await f.executor.execute(other, 'sticker.sources', {})).toMatchObject({ status: 'succeeded', data: { items: [] } });
      expect(await f.executor.execute(other, 'sticker.inspect', { source: reference })).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    }
    expect(await f.executor.execute(context, 'sticker.inspect', { source: reference, fileId: 'telegram-file-id' })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
  });
});

describe('private subscription handle delivery', () => {
  it('projects settings and options safely, preserves hidden fields, and excludes raw Actions from AI', async () => {
    const f = await fixture(); const capture = await captureSubscription(f);
    const result = await f.executor.execute(capture.context, 'subconv.settings.get', {});
    expect(result).toMatchObject({ status: 'succeeded', data: { revision: 1, configured: true, target: 'clash' } }); safe(result);
    const next = await f.executor.execute(capture.context, 'subconv.options.set', { revision: 1, options: { target: 'surge', sort: true } });
    expect(next).toMatchObject({ status: 'succeeded', data: { revision: 2, target: 'surge', sort: true } }); safe(next);
    const native = f.subconv.settings(capture.owner);
    expect(native.settings.backend).toBe(privateSettings().backend);
    for (const key of ['remoteConfig', 'include', 'exclude', 'filename'] as const) expect(native.settings.options[key]).toBe(privateSettings().options[key]);
    expect(await f.executor.execute(f.ai(), 'subconv.options.set', { revision: 1, options: { emoji: false } })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    for (const options of [{ remoteConfig: 'https://exfil.example.com/' }, { include: 'changed' }, { backend: 'https://exfil.example.com/' }, {}]) {
      expect(await f.executor.execute(f.ai(), 'subconv.options.set', { revision: 2, options })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    }
    for (const [id, input] of [
      ['subconv.settings.set', { revision: 2, settings: privateSettings() }], ['subconv.settings.reset', { revision: 2 }],
      ['subconv.generate', { revision: 2, source: rawSource, customParams: [] }],
    ] as const) expect(await f.executor.execute(f.ai(), id, input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(() => f.subconv.generate(capture.context, { revision: 2, source: rawSource, customParams: [] })).toThrow('FORBIDDEN');
    expect(await readFile(join(f.directory, 'subconv.json'), 'utf8')).not.toContain('source-secret');
  });

  it('delivers the captured URL only through the trusted same-owner callback, returning just a receipt', async () => {
    const deliver = vi.fn<SubconvNativeDelivery>(async () => {});
    const f = await fixture({ delivery: deliver });
    const capture = await captureSubscription(f, f.ai({ actorId: 3, chat: { id: 3, type: 'private', threadId: 4 } }));
    const sources = await f.executor.execute<SubconvSources>(capture.context, 'subconv.sources', {});
    expect(sources).toMatchObject({ status: 'succeeded', data: { items: [{ sourceRef: capture.sourceRef, sourceCount: 1 }] } }); safe(sources);
    expect(await f.executor.execute(f.ai({ actorId: 3, chat: capture.context.chat }), 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 0 })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(deliver).not.toHaveBeenCalled();
    const result = await f.executor.execute(capture.context, 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: capture.revision });
    expect(result).toMatchObject({ status: 'succeeded', data: { delivered: true, sourceCount: 1 } }); safe(result);
    expect(deliver).toHaveBeenCalledTimes(1);
    const [context, file] = deliver.mock.calls[0]!;
    expect(context).toMatchObject({ source: 'ai', aiRunId: capture.context.aiRunId, actorId: 3, botId: 12345, chat: { id: 3, threadId: 4 } });
    expect(file.name).toBe('subscription.txt'); expect(file.mimeType).toBe('text/plain');
    expect(Buffer.from(file.bytes).toString('utf8')).toBe(`${capture.generated.url}\n`);
    safe(f.observer.mock.calls.map(([, , result]) => result));
  });

  it('rejects foreign owner, bot, topic and missing-run handles without sending', async () => {
    const deliver = vi.fn<SubconvNativeDelivery>(async () => {});
    const f = await fixture({ delivery: deliver }); const capture = await captureSubscription(f);
    expect(() => f.subconv.settings(invocation({ source: 'ai' }))).toThrow('FORBIDDEN');
    for (const context of [f.ai({ actorId: 3, chat: { id: 3, type: 'private' } }), f.ai({ botId: 999 }), f.ai({ chat: { id: 1, type: 'private', threadId: 1 } })]) {
      expect(await f.executor.execute(context, 'subconv.sources', {})).toMatchObject({ status: 'succeeded', data: { items: [] } });
      expect(await f.executor.execute(context, 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 1 })).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    }
    expect(await f.executor.execute(invocation({ source: 'ai' }), 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 1 })).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(capture.context, 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 1, source: rawSource })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(deliver).not.toHaveBeenCalled();
  });

  it('fails closed without a trusted delivery callback', async () => {
    const f = await fixture({ delivery: null }); const capture = await captureSubscription(f);
    expect(await f.executor.execute(capture.context, 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 1 })).toMatchObject({ status: 'failed', error: { code: 'UNAVAILABLE' } });
  });

  it('drains an uncertain delivery and never includes transport errors or the generated URL in model receipts', async () => {
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const f = await fixture({ delivery: async () => { entered.resolve(); await release.promise; throw new Error(rawSource); } });
    const controller = new AbortController(); const capture = await captureSubscription(f, f.ai({ signal: controller.signal }));
    let settled = false;
    const task = f.executor.execute(capture.context, 'subconv.generate_owned', { sourceRef: capture.sourceRef, revision: 1 }).then(result => { settled = true; return result; });
    await entered.promise; controller.abort(); await Promise.resolve(); expect(settled).toBe(false);
    release.resolve(); const result = await task;
    expect(result).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } }); safe(result);
  });

  it('bounds handles per owner and globally without failing native generation, then reclaims all expired bytes', async () => {
    let now = Date.now();
    const f = await fixture({ now: () => now });
    for (let owner = 1; owner <= 17; owner++) {
      const context = f.ai({ actorId: owner, chat: { id: owner, type: 'private' } });
      await f.subconv.update(human(context), privateSettings(), 0);
      for (let item = 0; item < 9; item++) expect(f.subconv.generate(human(context), { revision: 1, source: `${rawSource}&item=${item}`, customParams: [] }).sourceCount).toBe(1);
      expect(f.subconv.listSources(context).items).toHaveLength(owner <= 16 ? 8 : 0);
      const topic = f.ai({ actorId: owner, chat: { id: owner, type: 'private', threadId: 1 } });
      f.subconv.generate(human(topic), { revision: 1, source: rawSource, customParams: [] });
      expect(f.subconv.listSources(topic).items).toHaveLength(0);
    }
    now += 600_000;
    const context = f.ai();
    expect(f.subconv.listSources(context).items).toHaveLength(0);
    f.subconv.generate(human(context), { revision: 1, source: rawSource, customParams: [] });
    expect(f.subconv.listSources(context).items).toHaveLength(1);
    f.subconv.stop(); expect(() => f.subconv.listSources(context)).toThrow('CANCELLED');
  });

  it('enforces the RAM byte budget before count capacity with large private custom inputs', async () => {
    const f = await fixture(); let retained = 0;
    for (let owner = 1; owner <= 5; owner++) {
      const context = f.ai({ actorId: owner, chat: { id: owner, type: 'private' } });
      await f.subconv.update(human(context), privateSettings(), 0);
      for (let item = 0; item < 8; item++) {
        const source = `https://example.com/${'x'.repeat(7900)}?i=${item}`;
        // A raw url override keeps final generated output bounded while retaining the original explicit input.
        f.subconv.generate(human(context), { revision: 1, source, customParams: [
          { name: 'url', value: rawSource }, ...Array.from({ length: 4 }, (_, i) => ({ name: `private${i}`, value: 'y'.repeat(1900) })),
        ] });
      }
      retained += f.subconv.listSources(context).items.length;
    }
    expect(retained).toBeGreaterThan(0); expect(retained).toBeLessThan(40);
  });

  it('expires private raw sources on one timer even without another operation and never persists them', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = await fixture(); const capture = await captureSubscription(f);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.subconv.listSources(f.ai()).items).toEqual([]);
    await expect(f.subconv.generateOwned(f.ai(), { sourceRef: capture.sourceRef, revision: 1 }, f.delivery)).rejects.toThrow('NOT_FOUND');
    const persisted = await readFile(join(f.directory, 'subconv.json'), 'utf8');
    for (const value of ['source-secret', 'custom-secret', 'target-secret', capture.sourceRef]) expect(persisted).not.toContain(value);
  });
});
