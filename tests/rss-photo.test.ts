import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRssPhotoPreparer, inspectRssPhoto, RSS_PHOTO_MAX_INPUT_PIXELS, RSS_PHOTO_MAX_REPAIR_BYTES } from '../src/modules/rss-photo.js';
import { ResourcePolicy } from '../src/resources.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: vi.fn((await original<typeof import('node:child_process')>()).fork) }));
const url = 'https://images.example.com/photo.jpg?private=never-echo';
const signal = () => new AbortController().signal;
const resources = new ResourcePolicy({ heavyBytes: 64 * 1024 * 1024 });
const fixture = (format: 'jpeg' | 'png' | 'webp' = 'jpeg', width = 60, height = 40) => sharp({
  create: { width, height, channels: 3, background: { r: 20, g: 40, b: 80 } },
}).toFormat(format).toBuffer();
const prepare = async (source: Buffer, caller = signal(), maxBytes?: number) => createRssPhotoPreparer(async () => source, { qualified: true, resources })(url, caller, maxBytes);
afterEach(() => { vi.mocked(fork).mockReset(); vi.restoreAllMocks(); });

describe('qualified RSS photo repair', () => {
  it('defaults to explicit unavailable without downloading or starting native code', async () => {
    const fetcher = vi.fn();
    await expect(createRssPhotoPreparer(fetcher)(url, signal())).rejects.toThrow('RSS_PHOTO_UNAVAILABLE');
    expect(fetcher).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
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

  it.each(['jpeg', 'png', 'webp'] as const)('rejects oversize %s envelope before forking or any native decode', async format => {
    const source = await fixture(format, 1100, 1000);
    vi.mocked(fork).mockClear();
    expect(() => inspectRssPhoto(source)).toThrow('RSS_PHOTO_INVALID');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(fork).not.toHaveBeenCalled();
    expect(RSS_PHOTO_MAX_INPUT_PIXELS).toBe(1_048_576);
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
    const run = createRssPhotoPreparer(fetcher, { qualified: true, resources });
    await run(url, signal(), 20 * 1024 * 1024);
    expect(fetcher.mock.calls[0]).toEqual([url, expect.any(AbortSignal), RSS_PHOTO_MAX_REPAIR_BYTES]);
    await expect(prepare(source, signal(), source.length - 1)).rejects.toThrow('RSS_PHOTO_INVALID');
    await expect(prepare(Buffer.alloc(RSS_PHOTO_MAX_REPAIR_BYTES + 1))).rejects.toThrow('RSS_PHOTO_INVALID');
  });

  it('holds the lane until an aborted fetch actually drains, then admits the next job', async () => {
    const gate = Promise.withResolvers<Buffer>(); const controller = new AbortController();
    const running = createRssPhotoPreparer(() => gate.promise, { qualified: true, resources })(url, controller.signal);
    const checked = expect(running).rejects.toThrow('RSS_PHOTO_ABORTED');
    controller.abort();
    await expect(prepare(await fixture())).rejects.toThrow('RSS_PHOTO_UNAVAILABLE');
    gate.resolve(await fixture()); await checked;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(prepare(await fixture())).resolves.toHaveProperty('data');
  });

  it.each(['abort', 'timeout'] as const)('releases %s only after actual child close and permits the next job', async mode => {
    const source = await fixture(); const controller = new AbortController();
    const fake = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn() });
    vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
    const run = createRssPhotoPreparer(async () => source, { qualified: true, resources, timeoutMs: mode === 'timeout' ? 20 : 1000 });
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
    await expect(createRssPhotoPreparer(async () => { throw new Error(url); }, { qualified: true, resources })(url, signal())).rejects.toThrow(/^RSS_PHOTO_INVALID$/);
  });
});
