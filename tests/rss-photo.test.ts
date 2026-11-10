import { getEventListeners } from 'node:events';
import sharp, { type Metadata, type Sharp } from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RSS_PHOTO_MAX_SOURCE_BYTES, type RssPhotoFetcher } from '../src/modules/rss-feed.js';
import { createRssPhotoPreparer, RSS_PHOTO_MAX_DIMENSION, RSS_PHOTO_MAX_INPUT_PIXELS, RSS_PHOTO_MAX_OUTPUT_BYTES, RSS_PHOTO_TIMEOUT_MS } from '../src/modules/rss-photo.js';

const url = 'https://images.example.com/photo.jpg?private=never-echo';
const signal = () => new AbortController().signal;
const fixture = (format: 'jpeg' | 'png' | 'webp' = 'jpeg', width = 60, height = 40) => sharp({
  create: { width, height, channels: 3, background: { r: 20, g: 40, b: 80 } },
}).toFormat(format).toBuffer();
function prepare(source: Buffer, callerSignal = signal(), maxBytes?: number) {
  return createRssPhotoPreparer(async () => source)(url, callerSignal, maxBytes);
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('RSS photo preparation', () => {
  it.each(['jpeg', 'png', 'webp'] as const)('converts %s to a bounded opaque JPEG without enlarging or mutating the original', async format => {
    const source = await fixture(format);
    const original = Buffer.from(source);
    const controller = new AbortController();
    const fetcher = vi.fn<RssPhotoFetcher>(async () => source);
    const result = await createRssPhotoPreparer(fetcher)(url, controller.signal);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, controller.signal, RSS_PHOTO_MAX_SOURCE_BYTES);
    expect(result.sourceBytes).toBe(source.length);
    expect(result.data).not.toBe(source);
    expect(result.data.length).toBeLessThanOrEqual(RSS_PHOTO_MAX_OUTPUT_BYTES);
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'jpeg', width: 60, height: 40, hasAlpha: false, channels: 3 });
    expect(source).toEqual(original);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('admits NASA-like metadata and resizes inside 2560 without decoding a huge fixture', async () => {
    const source = await fixture('jpeg', 300, 200);
    const metadata = await sharp(source).metadata();
    vi.spyOn(sharp.prototype, 'metadata').mockResolvedValueOnce({ ...metadata, width: 7837, height: 5225 });
    const resize = vi.spyOn(sharp.prototype, 'resize');
    const result = await prepare(source);
    expect(resize).toHaveBeenCalledWith({ width: 2560, height: 2560, fit: 'inside', withoutEnlargement: true });
    expect(await sharp(result.data).metadata()).toMatchObject({ width: 300, height: 200 });
    // A long but narrow real fixture exercises actual shrinking with a small decoded allocation.
    const resized = await prepare(await fixture('jpeg', 6000, 300));
    const actual = await sharp(resized.data).metadata();
    expect([actual.width, actual.height]).toEqual([2560, 128]);
    expect(actual.width / actual.height).toBe(20);
    expect(actual.width + actual.height).toBeLessThanOrEqual(10_000);
  });

  it('preserves a non-integer aspect ratio when resizing a real image', async () => {
    const result = await prepare(await fixture('jpeg', 3000, 2000));
    const metadata = await sharp(result.data).metadata();
    expect([metadata.width, metadata.height]).toEqual([2560, 1707]);
    expect(Math.abs(metadata.height - metadata.width * 2 / 3)).toBeLessThan(0.5);
  });

  it('auto-orients before resizing and strips EXIF, XMP and ICC metadata', async () => {
    const source = await sharp(await fixture()).withMetadata({ orientation: 6 })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/">fixture</x:xmpmeta>').toBuffer();
    const before = await sharp(source).metadata();
    expect(before.orientation).toBe(6);
    const result = await prepare(source);
    const after = await sharp(result.data).metadata();
    expect([after.width, after.height]).toEqual([40, 60]);
    expect(after.width / after.height).toBe(2 / 3);
    for (const field of ['orientation', 'exif', 'xmp', 'icc']) expect(after).not.toHaveProperty(field);
  });

  it('rotates actual pixels according to EXIF rather than just removing the orientation tag', async () => {
    const pixels = Buffer.alloc(40 * 20 * 3);
    for (let y = 0; y < 20; y++) for (let x = 0; x < 40; x++) pixels[(y * 40 + x) * 3 + (x < 20 ? 0 : 2)] = 255;
    const source = await sharp(pixels, { raw: { width: 40, height: 20, channels: 3 } }).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const result = await prepare(source);
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    expect([info.width, info.height]).toEqual([20, 40]);
    expect(data[(5 * 20 + 10) * 3]).toBeGreaterThan(240);
    expect(data[(35 * 20 + 10) * 3 + 2]).toBeGreaterThan(240);
  });

  it('flattens transparency onto opaque white rather than black', async () => {
    const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const result = await prepare(source);
    const { data, info } = await sharp(result.data).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    expect([...data]).toEqual(Array.from({ length: 8 * 8 * 3 }, () => 255));
  });

  it.each([
    ['GIF', Buffer.from('GIF89a')], ['SVG', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')],
    ['HTML', Buffer.from('<html>not an image</html>')], ['video', Buffer.from('0000ftypmp42')],
    ['TIFF', Buffer.from([73, 73, 42, 0])], ['empty', Buffer.alloc(0)],
    ['non-ASCII pseudo-WebP', Buffer.from([0xd2, 73, 70, 70, 4, 0, 0, 0, 87, 69, 66, 80])],
  ])('rejects %s before invoking Sharp', async (_name, source) => {
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('rejects real animated WebP and GIF without flattening a first frame', async () => {
    const pixels = Buffer.from([255, 0, 0, 0, 0, 255]);
    for (const format of ['webp', 'gif'] as const) {
      const source = await sharp(pixels, { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).toFormat(format).toBuffer();
      expect((await sharp(source).metadata()).pages).toBe(2);
      const metadata = vi.spyOn(sharp.prototype, 'metadata');
      await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
      expect(metadata).not.toHaveBeenCalled();
      metadata.mockRestore();
    }
  });

  it('rejects APNG animation chunks even if a decoder would expose only the first page', async () => {
    const png = await fixture('png');
    const animation = Buffer.alloc(20);
    animation.writeUInt32BE(8, 0);
    animation.write('acTL', 4, 'ascii');
    animation.writeUInt32BE(2, 8);
    const source = Buffer.concat([png.subarray(0, 33), animation, png.subarray(33)]);
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(metadata).not.toHaveBeenCalled();
  });

  it.each([
    { pages: 2 }, { delay: [100, 100] }, { pageHeight: 20 }, { format: 'gif' },
    { width: 0 }, { height: -1 }, { width: Number.NaN }, { height: 1.5 },
    { width: 201, height: 10 }, { width: 10, height: 201 }, { width: 10_000, height: 5001 },
  ])('rejects unsafe metadata before decoding: %j', async invalid => {
    const source = await fixture();
    const metadata = await sharp(source).metadata();
    vi.spyOn(sharp.prototype, 'metadata').mockResolvedValueOnce({ ...metadata, ...invalid } as Metadata);
    const output = vi.spyOn(sharp.prototype, 'toBuffer');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(output).not.toHaveBeenCalled();
  });

  it('sets the native pixel/failure/timeout limits and rejects truncated JPEG data', async () => {
    const source = await fixture();
    const metadata = sharp.prototype.metadata;
    const options: unknown[] = [];
    vi.spyOn(sharp.prototype, 'metadata').mockImplementation(function (this: Sharp) {
      options.push((this as unknown as { options: unknown }).options);
      return metadata.call(this);
    });
    const timeout = vi.spyOn(sharp.prototype, 'timeout');
    await expect(prepare(source.subarray(0, source.length - 30))).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(options[0]).toMatchObject({ input: { limitInputPixels: RSS_PHOTO_MAX_INPUT_PIXELS, failOn: 'warning', unlimited: false } });
    expect(timeout).toHaveBeenCalledWith({ seconds: 10 });
  });

  it('rejects excessive SOF pixel dimensions in the native decoder without allocating those pixels', async () => {
    const source = await fixture();
    const sof = source.indexOf(Buffer.from([0xff, 0xc0]));
    expect(sof).toBeGreaterThan(0);
    source.writeUInt16BE(6000, sof + 5);
    source.writeUInt16BE(10_000, sof + 7);
    const output = vi.spyOn(sharp.prototype, 'toBuffer');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(output).not.toHaveBeenCalled();
  });

  it.each(['png', 'webp'] as const)('rejects malformed %s container lengths before decoding', async format => {
    const source = await fixture(format);
    if (format === 'png') source.writeUInt32BE(0xffffffff, 8);
    else source.writeUInt32LE(0xffffffff, 16);
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('honors a smaller source budget and rejects an oversized injected fetcher response', async () => {
    const source = await fixture();
    const fetcher = vi.fn<RssPhotoFetcher>(async () => source);
    const callerSignal = signal();
    await expect(createRssPhotoPreparer(fetcher)(url, callerSignal, source.length - 1)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, callerSignal, source.length - 1);
    await expect(prepare(source, signal(), source.length)).resolves.toMatchObject({ sourceBytes: source.length });
    const tooLarge = Buffer.alloc(RSS_PHOTO_MAX_SOURCE_BYTES + 1);
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    await expect(prepare(tooLarge)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(metadata).not.toHaveBeenCalled();
  });

  it('never raises the source cap and rejects invalid caller budgets before fetching', async () => {
    const source = await fixture();
    const fetcher = vi.fn<RssPhotoFetcher>(async () => source);
    const callerSignal = signal();
    const run = createRssPhotoPreparer(fetcher);
    await run(url, callerSignal, RSS_PHOTO_MAX_SOURCE_BYTES * 2);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(url, callerSignal, RSS_PHOTO_MAX_SOURCE_BYTES);
    fetcher.mockClear();
    for (const max of [0, -1, 1.5, Number.NaN, Infinity]) await expect(run(url, callerSignal, max)).rejects.toThrow('RSS_PHOTO_INVALID');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    { width: 5001, height: 5000 }, { width: RSS_PHOTO_MAX_DIMENSION + 1, height: 200 },
    { width: 201, height: 10 }, { width: 0, height: 20 }, { format: 'png' },
  ])('validates encoded output dimensions and format: %j', async invalid => {
    const source = await fixture();
    vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValueOnce({
      data: source, info: { width: 60, height: 40, format: 'jpeg', ...invalid },
    } as never);
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
  });

  it('rejects oversized encoded output', async () => {
    const source = await fixture();
    vi.spyOn(sharp.prototype, 'toBuffer').mockResolvedValueOnce({
      data: Buffer.alloc(RSS_PHOTO_MAX_OUTPUT_BYTES + 1), info: { width: 60, height: 40, format: 'jpeg' },
    } as never);
    await expect(prepare(source)).rejects.toThrow('RSS_PHOTO_INVALID');
  });

  it('aborts before fetching and immediately after download without invoking Sharp', async () => {
    const source = await fixture();
    const controller = new AbortController();
    controller.abort(new Error(url));
    const fetcher = vi.fn<RssPhotoFetcher>(async () => source);
    await expect(createRssPhotoPreparer(fetcher)(url, controller.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(fetcher).not.toHaveBeenCalled();
    const during = new AbortController();
    const metadata = vi.spyOn(sharp.prototype, 'metadata');
    await expect(createRssPhotoPreparer(async () => { during.abort(new Error(url)); return source; })(url, during.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(metadata).not.toHaveBeenCalled();
    expect(getEventListeners(during.signal, 'abort')).toHaveLength(0);
  });

  it('aborts a fetcher that ignores cancellation and cleans its listener', async () => {
    const controller = new AbortController();
    const pending = createRssPhotoPreparer(() => new Promise(() => {}))(url, controller.signal);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(1);
    controller.abort();
    await expect(pending).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('handles a synchronous fetcher abort and throw without an unhandled cancellation rejection', async () => {
    const controller = new AbortController();
    await expect(createRssPhotoPreparer(() => { controller.abort(); throw new Error(url); })(url, controller.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it.each(['metadata', 'toBuffer'] as const)('bounds a stalled Sharp %s operation and cleans timer/listener/stream', async method => {
    const source = await fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(sharp.prototype, method).mockImplementationOnce(() => { entered.resolve(); return new Promise(() => {}); });
    const destroy = vi.spyOn(sharp.prototype, 'destroy');
    vi.useFakeTimers();
    const pending = prepare(source, controller.signal);
    const assertion = expect(pending).rejects.toThrow('RSS_PHOTO_TIMEOUT');
    await entered.promise;
    await vi.advanceTimersByTimeAsync(RSS_PHOTO_TIMEOUT_MS);
    await assertion;
    expect(destroy).toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['metadata', 'toBuffer'] as const)('cleans up on caller abort during Sharp %s', async method => {
    const source = await fixture();
    const controller = new AbortController();
    const entered = Promise.withResolvers<void>();
    vi.spyOn(sharp.prototype, method).mockImplementationOnce(() => { entered.resolve(); return new Promise(() => {}); });
    const destroy = vi.spyOn(sharp.prototype, 'destroy');
    vi.useFakeTimers();
    const pending = prepare(source, controller.signal);
    await entered.promise;
    controller.abort(new Error(url));
    await expect(pending).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(destroy).toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not return a completed output if the caller aborted during encoding', async () => {
    const source = await fixture();
    const controller = new AbortController();
    vi.spyOn(sharp.prototype, 'toBuffer').mockImplementationOnce(async () => {
      controller.abort();
      return { data: source, info: { width: 60, height: 40, format: 'jpeg' } } as never;
    });
    await expect(prepare(source, controller.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('aborts between metadata and encoding, and cleans up after a decoder error', async () => {
    const source = await fixture();
    const metadata = await sharp(source).metadata();
    const controller = new AbortController();
    vi.spyOn(sharp.prototype, 'metadata').mockImplementationOnce(async () => { controller.abort(); return metadata; });
    const output = vi.spyOn(sharp.prototype, 'toBuffer');
    await expect(prepare(source, controller.signal)).rejects.toThrow('RSS_PHOTO_ABORTED');
    expect(output).not.toHaveBeenCalled();
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    const next = new AbortController();
    output.mockRejectedValueOnce(new Error(`decoder disclosed ${url}`));
    await expect(prepare(source, next.signal)).rejects.toThrow(/^RSS_PHOTO_INVALID$/);
    expect(getEventListeners(next.signal, 'abort')).toHaveLength(0);
  });

  it('does not leak arbitrary fetch errors or leave abort listeners on failure', async () => {
    const controller = new AbortController();
    await expect(createRssPhotoPreparer(async () => { throw new Error(url); })(url, controller.signal)).rejects.toThrow(/^RSS_PHOTO_INVALID$/);
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });
});
