import { fork, spawn, ChildProcess } from 'node:child_process';
import { EventEmitter, getEventListeners } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStickerConverter as createQualifiedConverter, type StickerConversionRequest } from '../src/modules/sticker-media.js';
import { ResourcePolicy } from '../src/resources.js';
import { encodeGif } from '../src/modules/sticker-render.js';

const resources = new ResourcePolicy({ heavyBytes: 96 * 1024 * 1024 });
const createStickerConverter = (options: Parameters<typeof createQualifiedConverter>[0] = {}) => createQualifiedConverter({ qualified: true, resources, ...options });
const convertSticker = createStickerConverter();

vi.mock('node:child_process', async importOriginal => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn), fork: vi.fn(original.fork) };
});

const signal = () => new AbortController().signal;
const sourceImage = (format: 'png' | 'webp' = 'png', width = 32, height = 16) => {
  const image = sharp({ create: { width, height, channels: 4, background: { r: 255, g: 128, b: 64, alpha: 0.5 } } });
  return (format === 'webp' ? image.webp({ lossless: true }) : image.png()).toBuffer();
};
const request = (data: Buffer, extra: Partial<StickerConversionRequest> = {}): StickerConversionRequest => ({
  data, kind: 'static', format: 'png', media: false, width: 32, height: 32, ...extra,
});
function animation(overrides: Record<string, unknown> = {}) {
  const rectangle = (ind: number, position: number[], color: number[], opacity: number, moving = false) => ({
    ty: 4, ind, sr: 1, ip: 0, op: 180, st: 0,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 },
      p: moving ? { a: 1, k: [{ t: 0, s: position, h: 1 }, { t: 1, s: [24, 8, 0] }] } : { a: 0, k: position },
      a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    },
    shapes: [
      { ty: 'rc', d: 1, s: { a: 0, k: [8, 8] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: 'fl', c: { a: 0, k: [...color, 1] }, o: { a: 0, k: opacity }, r: 1 },
    ],
  });
  return {
    v: '5.7.4', fr: 2, ip: 0, op: 2, w: 32, h: 32, ddd: 0, assets: [],
    layers: [rectangle(1, [8, 8, 0], [1, 0, 0], 100, true), rectangle(2, [8, 24, 0], [1, 0.5, 0.25], 50)],
    ...overrides,
  };
}
function precompositionAnimation(rootInstances = 2, references = 8, shapePairs = 48) {
  const leaf = animation().layers[0]!;
  const pair = leaf.shapes;
  leaf.shapes = Array.from({ length: shapePairs }, () => structuredClone(pair)).flat();
  const reference = (ind: number, refId: string) => ({
    ty: 0, ind, refId, ip: 0, op: 2, st: 0, sr: 1, w: 32, h: 32,
    ks: {
      o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] },
      a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] },
    },
  });
  return {
    ...animation(),
    layers: Array.from({ length: rootInstances }, (_, i) => reference(i + 1, 'branch')),
    // Child-first order also exercises unused-graph root selection independent of asset order.
    assets: [
      { id: 'leaf', layers: [leaf] },
      { id: 'branch', layers: Array.from({ length: references }, (_, i) => reference(i + 1, 'leaf')) },
    ],
  };
}
const tgs = (value: unknown = animation()) => gzipSync(JSON.stringify(value));
const pixel = (data: Buffer, width: number, x: number, y: number) => [...data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4)];

// Local, generated VP9 WebM; no credentials, fixtures from external sources, or filesystem output.
async function webm(options: { fps?: number; count?: number; width?: number; height?: number; alpha?: boolean } = {}) {
  const { fps = 2, count = 2, width = 32, height = 32, alpha = true } = options;
  const frames = Buffer.alloc(width * height * 4 * count);
  for (let frame = 0; frame < count; frame++) {
    for (let y = 4; y < Math.min(height, 12); y++) for (let x = frame % 2 ? 20 : 4; x < Math.min(width, frame % 2 ? 28 : 12); x++) {
      const offset = ((frame * height + y) * width + x) * 4;
      frames[offset] = 255;
      frames[offset + 3] = 255;
    }
    if (!alpha) for (let i = frame * width * height * 4 + 3; i < (frame + 1) * width * height * 4; i += 4) frames[i] = 255;
  }
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
      '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', `${width}x${height}`, '-framerate', String(fps), '-i', 'pipe:0',
      '-an', '-threads', '1', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8',
      '-auto-alt-ref', '0', '-lag-in-frames', '0', '-pix_fmt', alpha ? 'yuva420p' : 'yuv420p', '-f', 'webm', 'pipe:1',
    ], { shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    child.on('error', reject);
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.resume();
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error('Local VP9 fixture encoder unavailable'));
      else resolve(Buffer.concat(chunks));
    });
    child.stdin.end(frames);
  });
}

afterEach(() => { vi.mocked(spawn).mockReset(); vi.mocked(fork).mockReset(); vi.restoreAllMocks(); vi.useRealTimers(); });

describe('static sticker conversion', () => {
  it.each(['png', 'webp'] as const)('converts real %s to transparent PNG and lossless WebP, respecting aspect', async format => {
    const source = await sourceImage(format);
    for (const output of ['png', 'webp'] as const) {
      const result = await convertSticker(request(source, { format: output, width: 16, height: 16 }), signal());
      expect(result).toMatchObject({ format: output, width: 16, height: 8 });
      expect(await sharp(result.data).metadata()).toMatchObject({ format: output, width: 16, height: 8, hasAlpha: true });
      const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
      const color = pixel(raw, 16, 4, 4);
      expect(color[3]).toBe(128);
      // libvips premultiply/resize/unpremultiply can round a colour channel by one.
      for (const [index, expected] of [255, 128, 64].entries()) expect(Math.abs(color[index]! - expected)).toBeLessThanOrEqual(1);
    }
  });

  it('flattens JPEG and media photos onto white, but does not flatten GIF', async () => {
    const source = await sharp({ create: { width: 8, height: 8, channels: 4, background: '#00000000' } }).png().toBuffer();
    for (const extra of [{ format: 'jpg' }, { format: 'png', media: true }] as const) {
      const result = await convertSticker(request(source, extra), signal());
      const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
      expect(pixel(raw, 8, 0, 0)).toEqual([255, 255, 255, 255]);
    }
  });

  it.each([[512, 1], [1, 512]])('pads a %ix%i photo canvas without stretching its content or changing file outputs', async (width, height) => {
    const source = await sourceImage('png', width, height);
    for (const format of ['png', 'jpg'] as const) {
      const result = await convertSticker(request(source, { width, height, format, media: true }), signal());
      expect([result.width, result.height]).toEqual(width > height ? [512, 26] : [26, 512]);
      const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
      expect(pixel(raw, result.width, 0, 0).every(value => value >= 250)).toBe(true);
      if (format === 'png') {
        let coloured = 0;
        for (let i = 0; i < raw.length; i += 4) if (raw[i + 1]! < 250) coloured++;
        expect(coloured).toBe(512);
        expect(pixel(raw, result.width, width > height ? 256 : 12, height > width ? 256 : 12)[3]).toBe(255);
      }
    }
    for (const format of ['png', 'webp'] as const) {
      const result = await convertSticker(request(source, { width, height, format }), signal());
      expect([result.width, result.height]).toEqual([width, height]);
      expect(pixel(await sharp(result.data).ensureAlpha().raw().toBuffer(), width, 0, 0)[3]).toBe(128);
    }
  });

  it('rejects animated WebP, APNG, oversized dimensions, and unsupported container formats', async () => {
    const animated = await sharp(Buffer.from([255, 0, 0, 0, 0, 255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).webp().toBuffer();
    const png = await sourceImage();
    const chunk = Buffer.alloc(20);
    chunk.writeUInt32BE(8); chunk.write('acTL', 4); chunk.writeUInt32BE(2, 8);
    const apng = Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
    for (const data of [animated, apng, await sourceImage('png', 513, 1), Buffer.from('<svg/>'), Buffer.from('GIF89a'), png.subarray(0, 40)]) {
      await expect(convertSticker(request(data), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});

describe('offline vector TGS rendering', () => {
  it('renders the actual first frame with straight alpha and no network access', async () => {
    const result = await convertSticker(request(tgs(), { kind: 'animated' }), signal());
    const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 32, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(raw, 32, 24, 8)).toEqual([0, 0, 0, 0]);
    expect(pixel(raw, 32, 8, 24)).toEqual([255, 128, 64, 127]);
  });

  it('accepts vector-only Lottie with an omitted assets array', async () => {
    const { assets: _assets, ...withoutAssets } = animation();
    for (const format of ['png', 'gif'] as const) {
      const result = await convertSticker(request(tgs(withoutAssets), { kind: 'animated', format }), signal());
      const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
      expect(pixel(raw, 32, 8, 8)).toEqual([255, 0, 0, 255]);
      if (format === 'gif') expect((await sharp(result.data).metadata()).pages).toBe(2);
    }
  });

  it('pads a thin first-frame media PNG but preserves the PNG file and GIF canvas', async () => {
    const thin = animation({ w: 512, h: 1 });
    thin.layers.splice(1);
    thin.layers[0]!.ks.p = { a: 0, k: [8, 0.5, 0] };
    thin.layers[0]!.shapes[0]!.s = { a: 0, k: [8, 1] };
    const data = tgs(thin);
    const photo = await convertSticker(request(data, { kind: 'animated', width: 512, height: 1, media: true }), signal());
    expect([photo.width, photo.height]).toEqual([512, 26]);
    const raw = await sharp(photo.data).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 512, 8, 12)).toEqual([255, 0, 0, 255]);
    expect(pixel(raw, 512, 8, 11)).toEqual([255, 255, 255, 255]);
    for (const format of ['png', 'gif'] as const) {
      const file = await convertSticker(request(data, { kind: 'animated', width: 512, height: 1, format, media: format === 'gif' }), signal());
      expect([file.width, file.height]).toEqual([512, 1]);
      expect(pixel(await sharp(file.data).ensureAlpha().raw().toBuffer(), 512, 0, 0)[3]).toBe(0);
    }
  });

  it('encodes the full animation, preserving movement, timing and transparent background', async () => {
    const result = await convertSticker(request(tgs(), { kind: 'animated', format: 'gif', media: true }), signal());
    const metadata = await sharp(result.data, { animated: true }).metadata();
    expect(metadata).toMatchObject({ pages: 2, pageHeight: 32, delay: [500, 500], loop: 0 });
    const raw = await sharp(result.data, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 32, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(raw, 32, 8, 40)).toEqual([0, 0, 0, 0]);
    expect(pixel(raw, 32, 24, 40)).toEqual([255, 0, 0, 255]);
    expect(pixel(raw, 32, 0, 32)[3]).toBe(0);
  });

  it('samples 60fps down to 90 frames at 30fps without losing 3-second timing', async () => {
    const result = await convertSticker(request(tgs(animation({ fr: 60, op: 180 })), { kind: 'animated', format: 'gif' }), signal());
    const metadata = await sharp(result.data, { animated: true }).metadata();
    expect(metadata.pages).toBe(90);
    expect(metadata.delay?.reduce((sum, value) => sum + value, 0)).toBe(3000);
    expect(Math.max(...metadata.delay!)).toBe(40);
  });

  it.each(['png', 'gif'] as const)('renders valid repeated precompositions as %s without counting asset declarations again', async format => {
    // Root expansion: 2 * 8 * (48 * 2) = 1536 shapes; root plus asset declarations = 2400.
    const result = await convertSticker(request(tgs(precompositionAnimation()), { kind: 'animated', format }), signal());
    const raw = await sharp(result.data, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 32, 8, 8)).toEqual([255, 0, 0, 255]);
    expect(pixel(raw, 32, 24, 8)[3]).toBe(0);
    if (format === 'gif') {
      expect((await sharp(result.data).metadata()).pages).toBe(2);
      expect(pixel(raw, 32, 8, 40)[3]).toBe(0);
      expect(pixel(raw, 32, 24, 40)).toEqual([255, 0, 0, 255]);
    }
  });

  it('still counts every real precomposition instance against the shape budget', async () => {
    // The same small declarations now expand to 3 * 8 * 96 = 2304 shapes, beyond 2048.
    for (const format of ['png', 'gif'] as const) {
      await expect(convertSticker(request(tgs(precompositionAnimation(3)), { kind: 'animated', format }), signal()))
        .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('validates unused precomposition graphs from their roots without extra child top-level counts', async () => {
    // Visible root: 4 shapes; unused branch: 3 * 576 = 1728. Counting its child again exceeds 2048.
    const unused = precompositionAnimation(0, 3, 288);
    const data = tgs({ ...unused, layers: animation().layers });
    const result = await convertSticker(request(data, { kind: 'animated' }), signal());
    expect(pixel(await sharp(result.data).ensureAlpha().raw().toBuffer(), 32, 8, 8)).toEqual([255, 0, 0, 255]);
  });

  it.each([
    [{ id: 'unused', layers: [{ ty: 2, refId: 'image' }] }],
    [{ id: 'unused', layers: [{ ty: 0, refId: 'missing' }] }],
    [{ id: 'unused', layers: [{ ty: 0, refId: 'unused' }] }],
    [{ id: 'a', layers: [{ ty: 0, refId: 'b' }] }, { id: 'b', layers: [{ ty: 0, refId: 'a' }] }],
  ])('rejects unsupported, missing or cyclic unused precompositions %j', async (...assets) => {
    await expect(convertSticker(request(tgs(animation({ assets })), { kind: 'animated' }), signal()))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    { fr: 61 }, { fr: 0 }, { op: 7 }, { op: 0 }, { w: 513 }, { w: 0 },
    { assets: null }, { assets: {} }, { assets: 'invalid' },
    { assets: [{ id: 'remote', p: 'secret.png', u: 'https://private.invalid/' }] },
    { assets: [{ id: 'image', p: 'data:image/png;base64,AA==' }] },
    { expression: 'fetch("https://private.invalid")' }, { extra: { a: 0, x: 'time * 2' } },
    { layers: [{ ty: 2, refId: 'image' }] }, { layers: [{ ty: '4', shapes: [] }] },
    { layers: [{ ty: 4, shapes: [{ ty: 'rp', c: { a: 0, k: 100000 } }] }] },
    { layers: [{ ty: 0, refId: 'cycle' }], assets: [{ id: 'cycle', layers: [{ ty: 0, refId: 'cycle' }] }] },
    { layers: [{ ty: 3, ind: 1, parent: 2 }, { ty: 3, ind: 2, parent: 1 }] },
  ])('rejects unsafe animation metadata/content %j', async override => {
    await expect(convertSticker(request(tgs(animation(override)), { kind: 'animated' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('rejects gzip expansion, excessive nesting/nodes and invalid compressed data', async () => {
    let deep: unknown = 0;
    for (let i = 0; i < 40; i++) deep = { nested: deep };
    const many = Array.from({ length: 4096 }, () => Array.from({ length: 16 }, () => 1));
    for (const data of [gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1, 32)), tgs(animation({ deep })), tgs(animation({ many })), Buffer.from('not gzip')]) {
      await expect(convertSticker(request(data, { kind: 'animated' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });
});

describe('VP9 video conversion', () => {
  it('checks the complete envelope but deliberately ignores corrupt later codec payloads for PNG only', async () => {
    const data = await webm();
    const blocks: [number, number][] = [];
    function scan(start: number, end: number) {
      const vint = (offset: number, id = false) => {
        let size = 1;
        while (!(data[offset]! & (128 >> (size - 1)))) size++;
        let value = id ? data[offset]! : data[offset]! & (255 >> size);
        for (let i = 1; i < size; i++) value = value * 256 + data[offset + i]!;
        return { size, value };
      };
      while (start < end) {
        const id = vint(start, true); const length = vint(start + id.size);
        const content = start + id.size + length.size;
        const next = Math.min(end, content + length.value);
        if ([0x18538067, 0x1f43b675, 0xa0].includes(id.value)) scan(content, next);
        if ([0xa1, 0xa3].includes(id.value)) blocks.push([content + 4, next]);
        start = next;
      }
    }
    scan(0, data.length);
    expect(blocks).toHaveLength(2);
    const late = Buffer.from(data); late.fill(0, ...blocks[1]!);
    await expect(convertSticker(request(late, { kind: 'video' }), signal())).resolves.toMatchObject({ format: 'png' });
    await expect(convertSticker(request(late, { kind: 'video', format: 'gif' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const early = Buffer.from(data); early.fill(0, ...blocks[0]!);
    await expect(convertSticker(request(early, { kind: 'video' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('decodes real VP9 alpha into an actual first-frame PNG', async () => {
    const result = await convertSticker(request(await webm(), { kind: 'video' }), signal());
    const raw = await sharp(result.data).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 32, 8, 8)[0]).toBeGreaterThan(240);
    expect(pixel(raw, 32, 8, 8)[3]).toBe(255);
    expect(pixel(raw, 32, 0, 0)[3]).toBe(0);
    expect(pixel(raw, 32, 24, 8)[3]).toBe(0);
  });

  it('converts the whole VP9 animation to GIF with transparent frames and original aspect', async () => {
    const result = await convertSticker(request(await webm({ width: 32, height: 16 }), { kind: 'video', format: 'gif', width: 16, height: 16 }), signal());
    expect(result).toMatchObject({ width: 16, height: 8 });
    const metadata = await sharp(result.data, { animated: true }).metadata();
    expect(metadata.pages).toBe(30);
    expect(metadata.delay?.reduce((a, b) => a + b, 0)).toBe(1000);
    const raw = await sharp(result.data, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(pixel(raw, 16, 4, 4)[3]).toBe(255);
    expect(pixel(raw, 16, 4, 29 * 8 + 4)[3]).toBe(0);
    expect(pixel(raw, 16, 12, 29 * 8 + 4)[3]).toBe(255);
  });

  it('rejects excessive duration, fps and dimensions even for PNG first-frame requests', async () => {
    for (const options of [{ fps: 2, count: 7 }, { fps: 61, count: 2 }, { width: 514, height: 2 }]) {
      const data = await webm(options);
      await expect(convertSticker(request(data, { kind: 'video' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('rejects malformed/truncated/unsupported videos with sanitized errors', async () => {
    const valid = await webm();
    const vp8 = Buffer.from(valid);
    vp8.write('V_VP8', vp8.indexOf('V_VP9'));
    for (const data of [Buffer.from('https://private.invalid/video.webm'), valid.subarray(0, valid.length - 20), vp8]) {
      await expect(convertSticker(request(data, { kind: 'video' }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT', message: 'INVALID_INPUT' });
    }
  });

  it('validates the complete 3-second 60fps source and emits exactly 90 GIF frames', async () => {
    const result = await convertSticker(request(await webm({ fps: 60, count: 180 }), { kind: 'video', format: 'gif' }), signal());
    const metadata = await sharp(result.data, { animated: true }).metadata();
    expect(metadata.pages).toBe(90);
    expect(metadata.delay?.reduce((a, b) => a + b, 0)).toBe(3000);
  });

  it('uses fixed safe decoder flags and waits for SIGKILL close on cancellation', async () => {
    const data = await webm();
    const fake = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
    });
    const spawned = vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);
    spawned.mockClear();
    const controller = new AbortController();
    const task = convertSticker(request(data, { kind: 'video' }), controller.signal);
    const checked = expect(task).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' });
    await vi.waitFor(() => expect(spawned).toHaveBeenCalled());
    const [, args, options] = spawned.mock.calls[0]!;
    expect(options).toMatchObject({ shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
    expect(args).toEqual(expect.arrayContaining(['-protocol_whitelist', 'pipe', '-f', 'matroska', '-c:v', 'libvpx-vp9',
      '-max_pixels', '262144', '-threads', '1', '-map', '0:v:0', '-an', '-sn', '-dn', '-frames:v', '1', 'pipe:0', 'pipe:1']));
    expect(args?.join(' ')).not.toContain('fps=');
    let settled = false;
    void task.then(() => { settled = true; }, () => { settled = true; });
    controller.abort(new Error('private reason'));
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
    await Promise.resolve();
    expect(settled).toBe(false);
    fake.emit('close', null, 'SIGKILL');
    fake.stdout.end();
    await checked;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
  });

  it('rejects an extra decoded frame and never exposes decoder diagnostics', async () => {
    const data = await webm();
    for (const mode of ['extra-frame', 'missing-decoder', 'bad-video'] as const) {
      const fake = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(() => true),
      });
      const mocked = vi.mocked(spawn).mockReturnValue(fake as unknown as ChildProcess);
      const task = convertSticker(request(data, { kind: 'video' }), signal());
      const code = mode === 'missing-decoder' ? 'UNAVAILABLE' : 'INVALID_INPUT';
      const checked = expect(task).rejects.toMatchObject({ code, message: code });
      await vi.waitFor(() => expect(mocked).toHaveBeenCalled());
      if (mode === 'extra-frame') {
        fake.stdout.end(Buffer.alloc(32 * 32 * 4 * 2));
        await vi.waitFor(() => expect(fake.kill).toHaveBeenCalledWith('SIGKILL'));
      } else fake.stderr.emit('data', Buffer.from(mode === 'missing-decoder' ? "Unknown decoder 'libvpx-vp9'" : 'secretfilename.webm malformed packet'));
      fake.emit('close', 1);
      fake.stdout.end();
      await checked;
      mocked.mockReset();
    }
  });
});

describe('conversion budgets and cleanup', () => {
  it('clears opaque canvases before later transparent frames, including high-entropy palettes', async () => {
    const originals: Buffer[] = [];
    let seed = 123456;
    async function* frames() {
      const pixels = Buffer.alloc(64 * 64 * 4);
      for (let frame = 0; frame < 3; frame++) {
        for (let i = 0; i < 4096; i++) {
          for (let channel = 0; channel < 3; channel++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; pixels[i * 4 + channel] = seed >>> 24; }
          pixels[i * 4 + 3] = frame === 1 && i % 2 === 0 ? 0 : 255;
        }
        originals.push(Buffer.from(pixels));
        yield { pixels, delay: [40, 30, 30][frame]! };
      }
    }
    const gif = await encodeGif(frames(), 64, 64, 1024 * 1024);
    const raw = await sharp(gif, { animated: true }).ensureAlpha().raw().toBuffer();
    expect(await sharp(gif).metadata()).toMatchObject({ pages: 3, delay: [40, 30, 30] });
    let error = 0; let channels = 0;
    for (let frame = 0; frame < 3; frame++) for (let i = 0; i < 4096; i++) {
      const offset = (frame * 4096 + i) * 4; const original = originals[frame]!;
      expect(raw[offset + 3]).toBe(original[i * 4 + 3]);
      if (raw[offset + 3]) for (let channel = 0; channel < 3; channel++) { error += Math.abs(raw[offset + channel]! - original[i * 4 + channel]!); channels++; }
    }
    expect(error / channels).toBeLessThan(25);
  });

  it('incrementally encodes high-entropy changing palettes, alpha and exact centisecond timing', async () => {
    const pixels = Buffer.alloc(64 * 64 * 4);
    async function* frames() {
      for (let frame = 0; frame < 3; frame++) {
        for (let i = 0; i < 4096; i++) {
          pixels[i * 4] = frame === 0 ? i % 256 : 0;
          pixels[i * 4 + 1] = frame === 1 ? i % 256 : 0;
          pixels[i * 4 + 2] = frame === 2 ? i % 256 : 0;
          pixels[i * 4 + 3] = (i + frame) % 5 ? 255 : 0;
        }
        yield { pixels, delay: [30, 40, 30][frame]! };
      }
    }
    const gif = await encodeGif(frames(), 64, 64, 1024 * 1024);
    expect(await sharp(gif).metadata()).toMatchObject({ pages: 3, delay: [30, 40, 30], loop: 0 });
    const raw = await sharp(gif, { animated: true }).ensureAlpha().raw().toBuffer();
    for (let frame = 0; frame < 3; frame++) for (let i = 0; i < 4096; i++) {
      const offset = (frame * 4096 + i) * 4;
      expect(raw[offset + 3]).toBe((i + frame) % 5 ? 255 : 0);
      if (raw[offset + 3]) expect(Math.abs(raw[offset + frame]! - i % 256)).toBeLessThanOrEqual(2);
    }
    await expect(encodeGif(frames(), 64, 64, 32)).rejects.toThrow('CAPACITY');
  });

  it('allows only minimum short-side padding beyond requested photo dimensions', async () => {
    const emit = EventEmitter.prototype.emit;
    const source = await sourceImage('png', 512, 1);
    for (const dimensions of [{ width: 512, height: 27 }, { width: 513, height: 26 }, { width: 512, height: 25 }]) {
      const changed = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (this: ChildProcess, event: string, ...args: unknown[]) {
        const reply = args[0] as { ok?: boolean; result?: object } | undefined;
        if (event === 'message' && reply?.ok) Object.assign(reply.result!, dimensions);
        return emit.call(this, event, ...args);
      });
      await expect(convertSticker(request(source, { width: 512, height: 1, media: true }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      changed.mockRestore();
    }
    const changed = vi.spyOn(ChildProcess.prototype, 'emit').mockImplementation(function (this: ChildProcess, event: string, ...args: unknown[]) {
      const reply = args[0] as { ok?: boolean; result?: object } | undefined;
      if (event === 'message' && reply?.ok) Object.assign(reply.result!, { width: 512, height: 26 });
      return emit.call(this, event, ...args);
    });
    await expect(convertSticker(request(source, { width: 512, height: 1 }), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    changed.mockRestore();
  });

  it('does not disable the parent Sharp cache or tune its default concurrency', async () => {
    const before = sharp.cache();
    const concurrency = sharp.concurrency();
    expect(before.memory.max).toBeGreaterThan(0);
    await convertSticker(request(await sourceImage()), signal());
    await convertSticker(request(tgs(), { kind: 'animated' }), signal());
    const after = sharp.cache();
    expect([after.memory.max, after.files.max, after.items.max]).toEqual([before.memory.max, before.files.max, before.items.max]);
    expect(sharp.concurrency()).toBe(concurrency);
  });

  it('rejects incompatible output formats and source/dimension limits before work', async () => {
    for (const extra of [
      { kind: 'static', format: 'gif' }, { kind: 'animated', format: 'jpg' }, { kind: 'video', format: 'webp' },
      { format: 'original' }, { width: 513 }, { height: 0 }, { width: 1.5 }, { data: Buffer.alloc(0) },
      { data: Buffer.alloc(8 * 1024 * 1024 + 1) },
    ]) {
      await expect(convertSticker(request(Buffer.from('x'), extra as Partial<StickerConversionRequest>), signal())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
  });

  it('enforces an injected smaller output budget', async () => {
    await expect(createStickerConverter({ maxOutputBytes: 32 })(request(await sourceImage()), signal())).rejects.toMatchObject({ code: 'CAPACITY' });
  });

  it('honors pre-abort and a hard worker deadline', async () => {
    const controller = new AbortController(); controller.abort(new Error('private reason'));
    await expect(convertSticker(request(tgs(), { kind: 'animated' }), controller.signal)).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' });
    const timed = signal();
    await expect(createStickerConverter({ timeoutMs: 1 })(request(tgs(), { kind: 'animated' }), timed)).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(getEventListeners(timed, 'abort')).toHaveLength(0);
  });

  it('does not settle cancellation or admit the next job until child close', async () => {
    const fake = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(), send: vi.fn((_message, callback) => callback()),
    });
    vi.mocked(fork).mockReturnValueOnce(fake as unknown as ChildProcess);
    const controller = new AbortController();
    let settled = false;
    const task = convertSticker(request(tgs(), { kind: 'animated', format: 'gif' }), controller.signal);
    const checked = expect(task).rejects.toMatchObject({ code: 'CANCELLED' });
    void task.then(() => { settled = true; }, () => { settled = true; });
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(fake.kill).toHaveBeenCalledWith('SIGKILL');
    await expect(convertSticker(request(tgs(), { kind: 'animated' }), signal())).rejects.toMatchObject({ code: 'CAPACITY' });
    fake.emit('close', null);
    await checked;
    expect(getEventListeners(controller.signal, 'abort')).toHaveLength(0);
    await expect(convertSticker(request(await sourceImage()), signal())).resolves.toHaveProperty('data');
  });

  it('defaults to unavailable until explicitly qualified and starts only the fixed clean-environment child', async () => {
    await expect(createQualifiedConverter()(request(tgs(), { kind: 'animated' }), signal())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(fork).not.toHaveBeenCalled();
    await convertSticker(request(await sourceImage()), signal());
    expect(vi.mocked(fork).mock.calls[0]?.[0].toString()).toMatch(/\/sticker-worker\.ts$/);
    expect(vi.mocked(fork).mock.calls[0]?.[2]).toMatchObject({ env: {}, serialization: 'advanced', execArgv: ['--max-old-space-size=64', '--max-semi-space-size=2'] });
  });
});
