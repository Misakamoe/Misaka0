import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough, Readable } from 'node:stream';
import { GrammyError, InputFile, type Bot } from 'grammy';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRssPhotoFetcher, fetchRssPhoto, type FeedTransport } from '../src/modules/rss-feed.js';
import { createRssPhotoPreparer, inspectRssPhoto, prepareRssPhoto, RSS_PHOTO_MAX_INPUT_PIXELS, RSS_PHOTO_MAX_REPAIR_BYTES } from '../src/modules/rss-photo.js';
import { ResourcePolicy } from '../src/resources.js';
import { createRssSender } from '../src/telegram/rss.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: vi.fn((await original<typeof import('node:child_process')>()).fork) }));
vi.mock('../src/modules/rss-feed.js', async original => ({ ...await original<typeof import('../src/modules/rss-feed.js')>(), fetchRssPhoto: vi.fn() }));
const url = 'https://images.example.com/photo.jpg?private=never-echo';
const signal = () => new AbortController().signal;
const resources = new ResourcePolicy();
const fixture = (format: 'jpeg' | 'png' | 'webp' = 'jpeg', width = 60, height = 40) => sharp({
  create: { width, height, channels: 3, background: { r: 20, g: 40, b: 80 } },
}).toFormat(format).toBuffer();
const prepare = async (source: Buffer, caller = signal(), maxBytes?: number) => createRssPhotoPreparer(async () => source, { resources })(url, caller, maxBytes);
afterEach(() => { vi.mocked(fork).mockReset(); vi.mocked(fetchRssPhoto).mockReset(); vi.restoreAllMocks(); });

describe('RSS photo repair', () => {
  it('repairs through the factory and exported defaults without policy overrides', async () => {
    const source = await fixture();
    vi.mocked(fetchRssPhoto).mockResolvedValue(source);
    for (const run of [createRssPhotoPreparer(), prepareRssPhoto]) {
      const result = await run(url, signal());
      expect(result.sourceBytes).toBe(source.length);
      expect(await sharp(result.data).metadata()).toMatchObject({ width: 60, height: 40, format: 'jpeg' });
    }
    expect(fetchRssPhoto).toHaveBeenCalledTimes(2);
    expect(fork).toHaveBeenCalledTimes(2);
  });

  it('uses the injected shared heavy lane without a separate default allowance', async () => {
    const fetcher = vi.fn(async () => fixture());
    const run = createRssPhotoPreparer(fetcher, { resources });
    const lease = resources.tryAcquire('heavy');
    expect(lease).toBeDefined();
    try {
      await expect(run(url, signal())).rejects.toThrow('RSS_PHOTO_UNAVAILABLE');
      expect(fetcher).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
    } finally { lease?.release(); }
    await expect(run(url, signal())).resolves.toHaveProperty('data');
  });

  it('still enforces an explicit deployment byte budget before fetching', async () => {
    const fetcher = vi.fn();
    const run = createRssPhotoPreparer(fetcher, { resources: new ResourcePolicy({ heavyBytes: 64 * 1024 * 1024 - 1 }) });
    await expect(run(url, signal())).rejects.toThrow('RSS_PHOTO_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
  });

  it('downscales a 4220px WebP negotiated from a JPG URL after a definite Telegram rejection', async () => {
    const source = await fixture('webp', 4220, 4220);
    const body = Readable.from([source]);
    const transport = vi.fn<FeedTransport>(async () => ({ status: 200, headers: {
      'content-type': 'image/webp', 'content-length': String(source.length), vary: 'Accept',
    }, body }));
    vi.mocked(fetchRssPhoto).mockImplementation(createRssPhotoFetcher({
      lookup: async () => [{ address: '192.0.66.108', family: 4 }], transport,
    }));
    const acquire = vi.spyOn(resources, 'tryAcquire');
    const sendRichMessage = vi.fn<Bot['api']['sendRichMessage']>().mockResolvedValue({} as never)
      .mockRejectedValueOnce(new GrammyError('Offline rejection', {
        ok: false, error_code: 400, description: 'Bad Request: failed to get HTTP URL content',
      }, 'sendRichMessage', {}));
    const send = createRssSender({ api: { sendRichMessage } } as unknown as Bot, { resources });
    await send({ chatId: -100, kind: 'group', threadId: 9 }, 'NASA', { kind: 'entry', entry: {
      id: 'a'.repeat(64), title: 'Photo', content: 'AB', images: [url], imagePositions: [{ offset: 1, imageIndex: 0 }],
    } }, 'en', true, signal());
    expect(sendRichMessage).toHaveBeenCalledTimes(2);
    expect(fetchRssPhoto).toHaveBeenCalledWith(url, expect.any(AbortSignal), 8 * 1024 * 1024);
    expect(transport.mock.calls[0]![0].href).toBe(url);
    expect(transport.mock.calls[0]![1]).toMatchObject({ addresses: [{ address: '192.0.66.108', family: 4 }], headers: {
      'accept-encoding': 'identity', accept: 'image/jpeg, image/png, image/webp, application/octet-stream;q=0.5',
    } });
    expect(body.destroyed).toBe(true);
    expect(acquire.mock.calls).toEqual([
      ['heavy', 64 * 1024 * 1024], ['heavy', 32 * 1024 * 1024 + 4220 * 4220 * 8 + source.length * 2],
    ]);
    expect(fork).toHaveBeenCalledOnce();
    expect(fork).toHaveBeenCalledWith(expect.any(URL), [], expect.objectContaining({
      execArgv: ['--max-old-space-size=32', '--max-semi-space-size=2'], env: {},
    }));
    const uploaded = sendRichMessage.mock.calls[1]![1].blocks![0]!;
    expect(uploaded.type).toBe('photo');
    if (uploaded.type !== 'photo' || !(uploaded.photo.media instanceof InputFile)) throw new Error('MISSING_UPLOAD');
    const data = await uploaded.photo.media.toRaw();
    if (!(data instanceof Uint8Array)) throw new Error('MISSING_BYTES');
    expect(await sharp(data).metadata()).toMatchObject({ format: 'jpeg', width: 1280, height: 1280 });
    expect(data.length).toBeLessThan(10 * 1024 * 1024);
    expect(sendRichMessage.mock.calls[1]![1].blocks).toContainEqual({ type: 'paragraph', text: [
      'A', ' ', { type: 'url', text: '[Image 1]', url }, ' ', 'B',
    ] });
    const child = vi.mocked(fork).mock.results[0]!.value as ChildProcess;
    expect(child.exitCode).toBe(0); expect(child.connected).toBe(false);
    const lease = resources.tryAcquire('heavy'); expect(lease).toBeDefined(); lease?.release();
  });

  it('rejects large native work on an explicit budget, releases admission, and still repairs small images', async () => {
    const source = await fixture('jpeg', 4220, 4220);
    const policy = new ResourcePolicy({ heavyBytes: 64 * 1024 * 1024 });
    const acquire = vi.spyOn(policy, 'tryAcquire');
    const fetcher = vi.fn(async () => source);
    const controller = new AbortController();
    const run = createRssPhotoPreparer(fetcher, { resources: policy });
    await expect(run(url, controller.signal)).rejects.toThrow(/^RSS_PHOTO_UNAVAILABLE$/);
    expect(fetcher).toHaveBeenCalledOnce(); expect(fork).not.toHaveBeenCalled();
    expect(acquire.mock.calls).toEqual([
      ['heavy', 64 * 1024 * 1024], ['heavy', 32 * 1024 * 1024 + 4220 * 4220 * 8 + source.length * 2],
    ]);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    acquire.mockClear(); fetcher.mockResolvedValue(await fixture());
    await expect(run(url, signal())).resolves.toHaveProperty('data');
    expect(acquire.mock.calls).toEqual([['heavy', 64 * 1024 * 1024], ['heavy', 64 * 1024 * 1024]]);
    expect(fork).toHaveBeenCalledOnce();
  });

  it('reacquires the heavy lane without allowing a queued competitor between fetch and native work', async () => {
    const source = await fixture();
    const policy = new ResourcePolicy();
    const competitor = vi.fn();
    let reservations = 0;
    const shared: Pick<ResourcePolicy, 'tryAcquire'> = { tryAcquire(kind, bytes) {
      const lease = policy.tryAcquire(kind, bytes);
      if (++reservations !== 1 || !lease) return lease;
      return { release() {
        lease.release();
        queueMicrotask(() => {
          const competing = policy.tryAcquire('heavy');
          competitor(competing); competing?.release();
        });
      } };
    } };
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn() });
    vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
    const task = createRssPhotoPreparer(async () => source, { resources: shared })(url, signal());
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    expect(competitor).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(policy.tryAcquire('heavy')).toBeUndefined();
    fake.emit('message', { data: source, width: 60, height: 40 }); fake.emit('close', 0);
    await expect(task).resolves.toEqual({ data: source, sourceBytes: source.length });
    const lease = policy.tryAcquire('heavy'); expect(lease).toBeDefined(); lease?.release();
  });

  it.each(['jpeg', 'png', 'webp'] as const)('repairs small %s in a reaped child without changing original or parent Sharp settings', async format => {
    const source = await fixture(format); const copy = Buffer.from(source);
    const before = sharp.cache(); const concurrency = sharp.concurrency();
    const result = await prepare(source);
    expect(result.sourceBytes).toBe(source.length);
    expect(source).toEqual(copy);
    expect(await sharp(result.data).metadata()).toMatchObject({ width: 60, height: 40, format: 'jpeg', hasAlpha: false });
    expect(sharp.cache().memory.max).toBe(before.memory.max); expect(sharp.concurrency()).toBe(concurrency);
  });

  it('orients actual pixels and removes private metadata', async () => {
    const pixels = Buffer.alloc(40 * 20 * 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) pixels[(y * 40 + x) * 3 + (x < 20 ? 0 : 2)] = 255;
    const source = await sharp(pixels, { raw: { width: 40, height: 20, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await prepare(source);
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 40]);
    expect(data[(5 * 20 + 10) * 3]).toBeGreaterThan(240);
    expect(data[(35 * 20 + 10) * 3 + 2]).toBeGreaterThan(240);
    expect(await sharp(result.data).metadata()).not.toHaveProperty('exif');
  });

  it('flattens transparency on white and shrinks admitted narrow images without stretching', async () => {
    const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00000000' } }).png().toBuffer();
    expect([...(await sharp((await prepare(source)).data).raw().toBuffer())]).toEqual(Array(8 * 8 * 3).fill(255));
    expect(await sharp((await prepare(await fixture('jpeg', 2000, 100))).data).metadata()).toMatchObject({ width: 1280, height: 64 });
  });

  it.each(['jpeg', 'png', 'webp'] as const)('admits exactly 20MP and rejects larger %s headers before forking', async format => {
    const source = await fixture(format);
    const dimensions = (height: number) => {
      if (format === 'jpeg') {
        const sof = source.indexOf(Buffer.from([255, 192]));
        source.writeUInt16BE(height, sof + 5); source.writeUInt16BE(5000, sof + 7);
      } else if (format === 'png') {
        source.writeUInt32BE(5000, 16); source.writeUInt32BE(height, 20);
      } else {
        const vp8 = source.indexOf('VP8 ');
        expect(vp8).toBeGreaterThanOrEqual(12);
        source.writeUInt16LE(5000, vp8 + 14); source.writeUInt16LE(height, vp8 + 16);
      }
    };
    dimensions(4000);
    expect(inspectRssPhoto(source)).toEqual({ format, width: 5000, height: 4000 });
    dimensions(4001);
    vi.mocked(fork).mockClear();
    expect(() => inspectRssPhoto(source)).toThrow('RSS_PHOTO_INVALID');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(fork).not.toHaveBeenCalled();
    expect(RSS_PHOTO_MAX_INPUT_PIXELS).toBe(20_000_000);
  });

  it('rejects forged 50 MP JPEG dimensions from headers, not a decoder metadata promise', async () => {
    const source = await fixture(); const sof = source.indexOf(Buffer.from([255, 192]));
    source.writeUInt16BE(5000, sof + 5); source.writeUInt16BE(10_000, sof + 7);
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(fork).not.toHaveBeenCalled();
  });

  it('rejects animations, foreign formats, truncation and excessive aspect ratios', async () => {
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp().toBuffer();
    const source = await fixture();
    for (const bad of [animated, Buffer.from('<svg/>'), Buffer.from('GIF89a'), source.subarray(0, source.length - 30), await fixture('png', 201, 10)]) {
      await expect(prepare(bad)).rejects.toThrow('RSS_PHOTO_INVALID');
    }
  });

  it('caps compressed input before IPC and honors lower caller budgets', async () => {
    const source = await fixture(); const fetcher = vi.fn(async () => source);
    const run = createRssPhotoPreparer(fetcher, { resources });
    await run(url, signal(), 20 * 1024 * 1024);
    expect(fetcher.mock.calls[0]).toEqual([url, expect.any(AbortSignal), RSS_PHOTO_MAX_REPAIR_BYTES]);
    await expect(prepare(source, signal(), source.length - 1)).rejects.toThrow('RSS_PHOTO_INVALID');
    await expect(prepare(Buffer.alloc(RSS_PHOTO_MAX_REPAIR_BYTES + 1))).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(RSS_PHOTO_MAX_REPAIR_BYTES).toBe(8 * 1024 * 1024);
    await run(url, signal(), source.length);
    expect(fetcher.mock.lastCall).toEqual([url, expect.any(AbortSignal), source.length]);
  });

  it('accepts JPEG transfers near and exactly at 8MiB and rejects declared or actual overruns before fork', async () => {
    const jpeg = await fixture();
    for (const size of [7_995_149, RSS_PHOTO_MAX_REPAIR_BYTES]) {
      const source = Buffer.alloc(size); jpeg.copy(source);
      const body = Readable.from([source]);
      const transport = vi.fn<FeedTransport>(async () => ({ status: 200, headers: {
        'content-type': 'image/jpeg', 'content-length': String(size),
      }, body }));
      const fetcher = createRssPhotoFetcher({ lookup: async () => [{ address: '192.0.66.108', family: 4 }], transport });
      // Test transfer/admission boundaries independently of the synthetic JPEG padding.
      const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn() });
      vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
      const task = createRssPhotoPreparer(fetcher, { resources })(url, signal());
      await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
      expect(fake.send.mock.calls[0]![0]).toMatchObject({ source, format: 'jpeg', maxPixels: 20_000_000, maxDimension: 1280 });
      fake.emit('message', { data: jpeg, width: 60, height: 40 }); fake.emit('close', 0);
      await expect(task).resolves.toEqual({ data: jpeg, sourceBytes: size });
      expect(body.destroyed).toBe(true);
    }
    vi.mocked(fork).mockClear();
    for (const declared of [true, false]) {
      const body = declared ? new Readable({ read: vi.fn() }) : Readable.from([Buffer.alloc(RSS_PHOTO_MAX_REPAIR_BYTES), Buffer.from([1])]);
      const fetcher = createRssPhotoFetcher({ lookup: async () => [{ address: '192.0.66.108', family: 4 }], transport: async () => ({
        status: 200, headers: { 'content-type': 'image/jpeg', ...(declared ? { 'content-length': String(RSS_PHOTO_MAX_REPAIR_BYTES + 1) } : {}) }, body,
      }) });
      await expect(createRssPhotoPreparer(fetcher, { resources })(url, signal())).rejects.toThrow('RSS_PHOTO_INVALID');
      expect(body.destroyed).toBe(true);
    }
    expect(fork).not.toHaveBeenCalled();
  });

  it('holds the lane until an aborted fetch actually drains, then admits the next job', async () => {
    const gate = Promise.withResolvers<Buffer>(); const controller = new AbortController();
    const running = createRssPhotoPreparer(() => gate.promise, { resources })(url, controller.signal);
    const checked = expect(running).rejects.toThrow('RSS_PHOTO_ABORTED');
    controller.abort();
    await expect(prepare(await fixture())).rejects.toThrow('RSS_PHOTO_UNAVAILABLE');
    gate.resolve(await fixture()); await checked;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(prepare(await fixture())).resolves.toHaveProperty('data');
  });

  it('keeps successful output pending and the lane held until child close, not exit', async () => {
    const source = await fixture(); const controller = new AbortController();
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn() });
    vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
    let settled = false;
    const task = prepare(source, controller.signal).finally(() => { settled = true; });
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    fake.emit('message', { data: source, width: 60, height: 40 });
    fake.emit('exit', 0);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(resources.tryAcquire('heavy')).toBeUndefined();
    fake.emit('close', 0);
    await expect(task).resolves.toEqual({ data: source, sourceBytes: source.length });
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(prepare(source)).resolves.toHaveProperty('data');
  });

  it.each(['abort', 'timeout'] as const)('releases %s only after actual child close and permits the next job', async mode => {
    const source = await fixture(); const controller = new AbortController();
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn() });
    vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
    const run = createRssPhotoPreparer(async () => source, { resources, timeoutMs: mode === 'timeout' ? 20 : 1000 });
    let settled = false;
    const task = run(url, controller.signal).finally(() => { settled = true; });
    const checked = expect(task).rejects.toThrow(mode === 'timeout' ? 'RSS_PHOTO_TIMEOUT' : 'RSS_PHOTO_ABORTED');
    await vi.waitFor(() => expect(fake.send).toHaveBeenCalled());
    if (mode === 'abort') controller.abort();
    await vi.waitFor(() => expect(fake.kill).toHaveBeenCalledWith('SIGKILL'));
    expect(settled).toBe(false);
    expect(resources.tryAcquire('heavy')).toBeUndefined();
    fake.emit('close', null); await checked;
    await expect(prepare(source)).resolves.toHaveProperty('data');
  });

  it('redacts fetch errors and rejects pre-aborted requests', async () => {
    const controller = new AbortController(); controller.abort();
    await expect(prepare(await fixture(), controller.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    await expect(createRssPhotoPreparer(async () => { throw new Error(url); }, { resources })(url, signal())).rejects.toThrow(/^RSS_PHOTO_INVALID$/);
  });
});
