import { unzipSync } from 'fflate';
import { mkdtempSync } from 'node:fs';
import { readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { moduleMetadataSchema, type ActionResult } from '../shared/schemas/index.js';
import { stickerResultSchema, stickerViewSchema, type StickerConvertInput, type StickerKind } from '../shared/schemas/sticker.js';
import type { ActionDefinition, ActionExecutor, InvocationContext } from '../src/actions.js';
import { AppError } from '../src/errors.js';
import { registerStickerActions, StickerService, stickerMetadata, type StickerCapture, type StickerFile, type StickerTransport } from '../src/modules/sticker.js';
import type { StickerConverter } from '../src/modules/sticker-media.js';
import { coreFixture, invocation } from './support/core.js';
import { ResourcePolicy } from '../src/resources.js';

const MiB = 1024 * 1024;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const webp = Buffer.from([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);
const tgs = Buffer.from([31, 139, 8, 0, 1, 2, 3]);
const webm = Buffer.from([26, 69, 223, 163, 1, 2, 3]);
const originals = { static: webp, animated: tgs, video: webm };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function file(kind: StickerKind = 'static', overrides: Partial<StickerFile> = {}): StickerFile {
  return { fileId: `file_${kind}`, uniqueId: `unique_${kind}`, kind, width: 512, height: 256, ...overrides };
}
function user(id = 1, threadId?: number): InvocationContext {
  return invocation({ actorId: id, chat: { id, type: 'private', ...(threadId === undefined ? {} : { threadId }) } });
}
function fixture(options: Partial<Pick<ConstructorParameters<typeof StickerService>[0], 'now' | 'capacity'>> = {}) {
  const tempDirectory = mkdtempSync(join(process.cwd(), '.kilo', 'sticker-service-test-'));
  cleanups.push(() => rm(tempDirectory, { recursive: true, force: true }));
  const sentData: Buffer[] = [];
  const transport = {
    download: vi.fn<StickerTransport['download']>(async sticker => Buffer.from(originals[sticker.kind])),
    getSet: vi.fn<StickerTransport['getSet']>(async name => ({ name, title: 'A pack', stickers: [file()] })),
    send: vi.fn<StickerTransport['send']>(async (_target, result) => {
      sentData.push(Buffer.isBuffer(result.data) ? result.data : await readFile(result.data.path));
      return 99;
    }),
  };
  const converter = vi.fn<StickerConverter>(async request => ({ data: Buffer.from(`converted_${request.format}`),
    format: request.format, width: request.width, height: request.height }));
  const service = new StickerService({ transport, convert: converter, tempDirectory, resources: new ResourcePolicy({ heavyBytes: 48 * MiB }), ...options });
  cleanups.push(() => service.stop());
  let nextMessageId = 12;
  let nextPackMessageId = 34;
  return { service, transport, converter, sentData, tempDirectory,
    capture: (context = user(), kind: StickerKind = 'static', messageId = nextMessageId++) => service.capture(context, { kind: 'single', sticker: file(kind) }, messageId),
    pack: (context = user()) => service.capture(context, { kind: 'pack', name: 'Example_pack' }, nextPackMessageId++),
  };
}
function input(source: string, format: StickerConvertInput['format'] = 'original', delivery: StickerConvertInput['delivery'] = 'file'): StickerConvertInput {
  return { source, format, delivery };
}
function success<T>(result: ActionResult<T>): T {
  expect(result.status).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error('Expected successful Action');
  return result.data;
}
async function actionFixture() {
  const f = fixture();
  const core = await coreFixture({ services: { aiEnabled: true } });
  cleanups.push(core.close);
  // Use a test namespace so production registration can be wired independently by the parent.
  const register: Pick<ActionExecutor, 'register'> = { register: definition => core.executor.register({ ...definition, id: `fixture.${definition.id}` }) };
  registerStickerActions(register, f.service);
  return { ...f, core, execute: (context: InvocationContext, id: string, value: unknown) => core.executor.execute(context, `fixture.sticker.${id}`, value) };
}

describe('scoped ephemeral sticker sources', () => {
  it.each(['static', 'animated', 'video'] as const)('inspects %s metadata without downloading or exposing identifiers', async kind => {
    const f = fixture();
    const source = f.service.capture(user(), { kind: 'single', sticker: file(kind, { emoji: '\u2764\ufe0f', setName: 'Example_pack' }) }, 12);
    expect(source).toMatch(/^[a-f0-9]{24}$/);
    const view = await f.service.inspect(user(), source);
    expect(view).toMatchObject({ source, kind: 'single', sourceKind: kind, count: 1, width: 512, height: 256,
      formats: kind === 'static' ? ['original', 'png', 'jpg', 'webp'] : ['original', 'png', 'gif'] });
    expect(stickerViewSchema.safeParse(view).success).toBe(true);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    expect(JSON.stringify(view)).not.toMatch(/fileId|uniqueId|file_static|file_animated|file_video/);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.transport.getSet).not.toHaveBeenCalled();
  });

  it('binds references to bot, user, private chat and exact topic without binding to invocation ID', async () => {
    const f = fixture();
    const context = user(1, 7);
    const source = f.capture(context);
    for (const other of [invocation({ botId: 54321, chat: context.chat }), user(2, 7), user(1), user(1, 8)]) {
      await expect(f.service.inspect(other, source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(f.service.convert(other, input(source))).rejects.toMatchObject({ code: 'NOT_FOUND' });
      f.service.release(other, source);
    }
    for (const other of [invocation({ source: 'http' }), invocation({ source: 'ai' }), invocation({ chat: { id: -10, type: 'group' } })]) {
      expect(() => f.capture(other)).toThrow('FORBIDDEN');
      await expect(f.service.inspect(other, source)).rejects.toMatchObject({ code: 'FORBIDDEN' });
      await expect(f.service.cancel(other)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(await f.service.inspect(user(1, 7), source)).toMatchObject({ source });
    expect(f.transport.download).not.toHaveBeenCalled();
  });

  it('rejects raw IDs, paths and URLs as source references', async () => {
    const f = fixture(); f.capture();
    for (const source of ['file_static', '/tmp/sticker.webp', '../data', 'https://example.com/sticker.webp', 'a'.repeat(24)]) {
      await expect(f.service.inspect(user(), source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(f.service.convert(user(), input(source))).rejects.toMatchObject({ code: /^[A-Z_]+$/ });
    }
    expect(f.transport.download).not.toHaveBeenCalled();
  });

  it('expires at ten minutes without extending expiry on read and frees capacity', async () => {
    let now = Date.now();
    const f = fixture({ now: () => now, capacity: 1 });
    const source = f.capture();
    const expiresAt = new Date(now + 600_000).toISOString();
    now += 599_999;
    expect(await f.service.inspect(user(), source)).toMatchObject({ expiresAt });
    expect(() => f.capture()).toThrow('CAPACITY');
    now += 1;
    await expect(f.service.inspect(user(), source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(f.capture()).not.toBe(source);
  });

  it('caps sources globally and per owner across topics without evicting valid references', async () => {
    const f = fixture({ capacity: 9 });
    const first = f.capture();
    for (let i = 1; i < 8; i++) f.capture(user(1, i));
    expect(() => f.capture(user(1, 9))).toThrow('CAPACITY');
    const other = f.capture(user(2));
    expect(() => f.capture(user(3))).toThrow('CAPACITY');
    expect(await f.service.inspect(user(), first)).toMatchObject({ source: first });
    f.service.release(user(2), other);
    f.capture(user(3));
    const full = fixture();
    for (let i = 1; i <= 200; i++) full.capture(user(i));
    expect(() => full.capture(user(201))).toThrow('CAPACITY');
    expect(() => fixture({ capacity: 201 })).toThrow('INVALID_INPUT');
  });

  it('copies captured metadata and permanently releases sources', async () => {
    const f = fixture();
    const sticker = file();
    const source = f.service.capture(user(), { kind: 'single', sticker }, 12);
    sticker.fileId = 'changed'; sticker.width = 1;
    await f.service.convert(user(), input(source));
    expect(f.transport.download.mock.calls[0]?.[0]).toMatchObject({ fileId: 'file_static', width: 512 });
    f.service.release(user(), source);
    f.service.release(user(), source);
    await expect(f.service.inspect(user(), source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reuses only identical captures of the same scoped message, without refreshing TTL or consuming capacity', async () => {
    let now = Date.now(); const f = fixture({ now: () => now, capacity: 1 });
    const source = f.capture(user(), 'static', 100);
    const before = await f.service.inspect(user(), source);
    now += 500_000;
    expect(f.capture(user(), 'static', 100)).toBe(source);
    expect(await f.service.inspect(user(), source)).toEqual(before);
    expect(() => f.capture(user(), 'static', 101)).toThrow('CAPACITY');
    expect(() => f.capture(user(), 'animated', 100)).toThrow('CAPACITY');
    expect(() => f.capture(user(2), 'static', 100)).toThrow('CAPACITY');
    now += 100_000;
    expect(f.capture(user(), 'static', 100)).not.toBe(source);
  });

  it.each([
    { fileId: '' }, { fileId: 'https://example.com/a' }, { fileId: '../path' }, { fileId: 'valid\n' }, { fileId: 'a'.repeat(513) },
    { uniqueId: 'a'.repeat(129) }, { uniqueId: 'with space' }, { width: 513 }, { height: 0 }, { width: 2.5 },
    { fileSize: 8 * MiB + 1 }, { fileSize: -1 }, { emoji: 'a'.repeat(65) }, { emoji: '\n' },
    { setName: '../name' }, { setName: 'a'.repeat(65) }, { setType: 'unknown' }, { url: 'https://example.com' }, { kind: 'photo' },
  ])('rejects malformed capture metadata %j', overrides => {
    const f = fixture();
    expect(() => f.service.capture(user(), { kind: 'single', sticker: { ...file(), ...overrides } } as StickerCapture, 12)).toThrow('INVALID_INPUT');
    expect(f.transport.download).not.toHaveBeenCalled();
  });

  it('rejects unknown capture fields, unsafe pack names and invalid source message IDs', () => {
    const f = fixture();
    for (const source of [{ kind: 'pack', name: '../x' }, { kind: 'pack', name: 'Pack', url: 'https://example.com' },
      { kind: 'single', sticker: file(), chatId: 3 }]) {
      expect(() => f.service.capture(user(), source as StickerCapture, 12)).toThrow('INVALID_INPUT');
    }
    for (const messageId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => f.capture(user(), 'static', messageId)).toThrow('INVALID_INPUT');
    }
  });
});

describe('single sticker conversion and delivery', () => {
  it.each([
    ['static', 'png', 'media', 'photo'], ['static', 'jpg', 'media', 'photo'], ['static', 'webp', 'file', 'document'],
    ['static', 'png', 'file', 'document'], ['static', 'jpg', 'file', 'document'],
    ['animated', 'png', 'media', 'photo'], ['animated', 'gif', 'media', 'animation'], ['animated', 'gif', 'file', 'document'],
    ['video', 'png', 'file', 'document'], ['video', 'gif', 'media', 'animation'], ['video', 'gif', 'file', 'document'],
  ] as const)('dispatches %s -> %s/%s as %s inside the same operation', async (kind, format, mode, delivery) => {
    const f = fixture();
    const context = user(4, 17);
    const source = f.capture(context, kind, 678);
    const result = await f.service.convert(context, input(source, format, mode));
    expect(f.converter).toHaveBeenCalledExactlyOnceWith({ data: originals[kind], kind, format, media: mode === 'media', width: 512, height: 256 }, expect.any(AbortSignal));
    expect(f.transport.send).toHaveBeenCalledExactlyOnceWith({ chatId: 4, threadId: 17, replyTo: 678 },
      { data: Buffer.from(`converted_${format}`), filename: `sticker.${format}`, delivery }, expect.any(AbortSignal));
    expect(result).toEqual({ format, delivery, bytes: Buffer.byteLength(`converted_${format}`), count: 1, messageId: 99 });
    expect(stickerResultSchema.safeParse(result).success).toBe(true);
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each([['static', webp, 'webp'], ['static', png, 'png'], ['animated', tgs, 'tgs'], ['video', webm, 'webm']] as const)(
    'preserves original %s bytes and selects %s extension without running a converter', async (kind, original, extension) => {
      const f = fixture(); f.transport.download.mockResolvedValue(original);
      const result = await f.service.convert(user(), input(f.capture(user(), kind)));
      expect(result).toMatchObject({ format: extension, delivery: 'document', bytes: original.length });
      expect(f.transport.send.mock.calls[0]?.[1]).toEqual({ data: original, filename: `sticker.${extension}`, delivery: 'document' });
      expect(f.transport.send.mock.calls[0]?.[1].data).toBe(original);
      expect(f.transport.send.mock.calls[0]?.[0]).toEqual({ chatId: 1, replyTo: 12 });
      expect(f.converter).not.toHaveBeenCalled();
    });

  it.each([
    ['static', 'gif', 'file'], ['static', 'original', 'media'], ['static', 'webp', 'media'],
    ['animated', 'webp', 'file'], ['animated', 'jpg', 'file'], ['video', 'jpg', 'media'], ['video', 'original', 'media'],
  ] as const)('rejects unsupported %s/%s/%s before downloading', async (kind, format, delivery) => {
    const f = fixture();
    await expect(f.service.convert(user(), input(f.capture(user(), kind), format, delivery))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('uses actual per-file bytes, rejects invalid originals and enforces output bounds', async () => {
    const f = fixture(); const source = f.capture();
    f.transport.download.mockResolvedValueOnce(Buffer.alloc(8 * MiB + 1));
    await expect(f.service.convert(user(), input(source))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download.mock.calls[0]?.[2]).toBe(8 * MiB);
    for (const invalid of [Buffer.alloc(0), Buffer.from('<svg>'), Buffer.from('https://example.com/image.webp')]) {
      f.transport.download.mockResolvedValueOnce(invalid);
      await expect(f.service.convert(user(), input(source))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    f.converter.mockResolvedValueOnce({ data: Buffer.alloc(10 * MiB + 1), format: 'png', width: 512, height: 256 });
    await expect(f.service.convert(user(), input(source, 'png'))).rejects.toMatchObject({ code: 'CAPACITY' });
    f.converter.mockResolvedValueOnce({ data: png, format: 'jpg', width: 512, height: 256 });
    await expect(f.service.convert(user(), input(source, 'png'))).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    f.converter.mockResolvedValueOnce({ data: png, format: 'png', width: 513, height: 256 });
    await expect(f.service.convert(user(), input(source, 'png'))).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each([['static', 'png', 'media'], ['animated', 'gif', 'file']] as const)(
    'accepts exactly 10MiB but not one byte more for single %s/%s/%s output', async (kind, format, delivery) => {
      const f = fixture(); const source = f.capture(user(), kind);
      const data = Buffer.alloc(10 * MiB);
      f.converter.mockResolvedValueOnce({ data, format, width: 512, height: 256 });
      expect(await f.service.convert(user(), input(source, format, delivery))).toMatchObject({ format, bytes: 10 * MiB, count: 1 });
      expect(f.transport.send.mock.calls[0]?.[1].data).toBe(data);
      f.converter.mockResolvedValueOnce({ data: Buffer.alloc(10 * MiB + 1), format, width: 512, height: 256 });
      await expect(f.service.convert(user(), input(source, format, delivery))).rejects.toMatchObject({ code: 'CAPACITY' });
      expect(f.transport.send).toHaveBeenCalledTimes(1);
    });

  it('prevents an expired source from sending after a slow converter finishes', async () => {
    let now = Date.now(); const f = fixture({ now: () => now });
    f.converter.mockImplementationOnce(async request => {
      now += 600_000;
      return { data: png, format: request.format, width: 512, height: 256 };
    });
    await expect(f.service.convert(user(), input(f.capture(), 'png'))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.transport.send).not.toHaveBeenCalled();
  });
});

describe('bounded original sticker packs', () => {
  it('rejects a malformed last original and removes the partial spool without any send', async () => {
    const f = fixture();
    f.transport.getSet.mockResolvedValue({ name: 'Example_pack', title: 'late failure', stickers: [file(), file()] });
    f.transport.download.mockResolvedValueOnce(webp).mockResolvedValueOnce(Buffer.from('invalid final original'));
    await expect(f.service.convert(user(), input(f.pack()))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(await readdir(f.tempDirectory)).toEqual([]);
  });

  it('resolves only within inspection, caches a copied set and preserves every mixed original in a safe ZIP', async () => {
    const f = fixture();
    const set = { name: 'Example_pack', title: '../untrusted <pack>', stickers: [file('static', { setType: 'custom_emoji' }), file('animated'), file('video'), file('static', { fileId: 'png_static' })] };
    f.transport.getSet.mockResolvedValue(set);
    f.transport.download.mockImplementation(async sticker => sticker.fileId === 'png_static' ? png : originals[sticker.kind]);
    const context = user(1, 77); const source = f.pack(context);
    expect(f.transport.getSet).not.toHaveBeenCalled();
    const view = await f.service.inspect(context, source);
    expect(view).toMatchObject({ kind: 'pack', count: 4, setName: 'Example_pack', setType: 'custom_emoji', title: '../untrusted <pack>', formats: ['original'] });
    expect(stickerViewSchema.safeParse(view).success).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/fileId|file_static|uniqueId/);
    set.stickers.splice(0); set.title = 'changed';
    expect(await f.service.inspect(context, source)).toEqual(view);
    const result = await f.service.convert(context, input(source));
    expect(result).toMatchObject({ format: 'zip', delivery: 'document', count: 4, messageId: 99 });
    expect(f.transport.getSet).toHaveBeenCalledTimes(1);
    expect(f.transport.download).toHaveBeenCalledTimes(4);
    expect(f.converter).not.toHaveBeenCalled();
    const sent = f.transport.send.mock.calls[0]!;
    expect(sent[0]).toEqual({ chatId: 1, threadId: 77, replyTo: 34 });
    expect(sent[1].filename).toBe('stickers.zip');
    expect(f.sentData[0]!.length).toBe(result.bytes);
    expect(result.bytes).toBeLessThanOrEqual(21 * MiB);
    const entries = unzipSync(f.sentData[0]!);
    expect(Object.keys(entries)).toEqual(['001.webp', '002.tgs', '003.webm', '004.png']);
    expect(Object.values(entries).map(value => Buffer.from(value))).toEqual([webp, tgs, webm, png]);
    expect(Buffer.isBuffer(sent[1].data)).toBe(false);
    expect(await readdir(f.tempDirectory)).toEqual([]);
  });

  it('supports direct original conversion without a prior inspection and rejects other pack choices', async () => {
    const f = fixture(); const source = f.pack();
    for (const value of [input(source, 'png'), input(source, 'original', 'media')]) {
      await expect(f.service.convert(user(), value)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    }
    expect(f.transport.getSet).not.toHaveBeenCalled();
    await f.service.convert(user(), input(source));
    expect(f.transport.getSet).toHaveBeenCalledTimes(1);
  });

  it('accepts all 120 entries and rejects oversize sets rather than truncating', async () => {
    const f = fixture();
    f.transport.getSet.mockResolvedValueOnce({ name: 'Example_pack', title: 'full', stickers: Array.from({ length: 120 }, () => file()) });
    const result = await f.service.convert(user(), input(f.pack()));
    expect(result.count).toBe(120);
    expect(Object.keys(unzipSync(f.sentData[0]!))).toHaveLength(120);
    expect(Object.keys(unzipSync(f.sentData[0]!)).at(-1)).toBe('120.webp');
    f.transport.getSet.mockResolvedValueOnce({ name: 'Example_pack', title: 'too large', stickers: Array.from({ length: 121 }, () => file()) });
    await expect(f.service.inspect(user(), f.pack())).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'Other_pack', title: 'pack', stickers: [file()] }, { name: 'Example_pack', title: 'x'.repeat(129), stickers: [file()] },
    { name: 'Example_pack', title: 'pack', stickers: [] }, { name: 'Example_pack', title: 'pack', stickers: [file('static', { width: 513 })] },
    { name: 'Example_pack', title: 'pack', stickers: [file('static', { fileSize: 8 * MiB + 1 })] },
  ])('rejects invalid remote set metadata %j', async set => {
    const f = fixture(); f.transport.getSet.mockResolvedValue(set);
    await expect(f.service.inspect(user(), f.pack())).rejects.toMatchObject({ code: 'UNAVAILABLE' });
    expect(f.transport.download).not.toHaveBeenCalled();
  });

  it('downloads sequentially and grants only the remaining actual aggregate budget', async () => {
    const f = fixture();
    f.transport.getSet.mockResolvedValue({ name: 'Example_pack', title: 'bounded', stickers: [file('animated'), file('video'), file()] });
    const large = [Buffer.concat([tgs, Buffer.alloc(8 * MiB - tgs.length)]), Buffer.concat([webm, Buffer.alloc(8 * MiB - webm.length)]),
      Buffer.concat([png, Buffer.alloc(4 * MiB - png.length)])];
    let active = 0;
    f.transport.download.mockImplementation(async () => {
      active++;
      expect(active).toBe(1);
      await Promise.resolve(); active--;
      return large[f.transport.download.mock.calls.length - 1]!;
    });
    const result = await f.service.convert(user(), input(f.pack()));
    expect(f.transport.download.mock.calls.map(call => call[2])).toEqual([8 * MiB, 8 * MiB, 4 * MiB]);
    expect(result.bytes).toBeGreaterThan(20 * MiB);
    expect(result.bytes).toBeLessThanOrEqual(21 * MiB);
    expect(Object.values(unzipSync(f.sentData[0]!)).map(value => Buffer.from(value))).toEqual(large);
  });

  it('rejects a lying downloader beyond remaining bytes and never sends partial packs', async () => {
    const f = fixture();
    f.transport.getSet.mockResolvedValue({ name: 'Example_pack', title: 'bounded', stickers: Array.from({ length: 3 }, () => file('animated', { fileSize: 1 })) });
    f.transport.download.mockImplementation(async () => Buffer.concat([tgs, Buffer.alloc(8 * MiB - tgs.length)]));
    await expect(f.service.convert(user(), input(f.pack()))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download.mock.calls.map(call => call[2])).toEqual([8 * MiB, 8 * MiB, 4 * MiB]);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('does not start a download with zero budget or metadata exceeding the remaining allowance', async () => {
    const f = fixture();
    f.transport.getSet.mockResolvedValue({ name: 'Example_pack', title: 'bounded', stickers: [file('animated'), file('animated'), file('animated', { fileSize: 5 * MiB })] });
    f.transport.download.mockImplementation(async () => Buffer.concat([tgs, Buffer.alloc(8 * MiB - tgs.length)]));
    await expect(f.service.convert(user(), input(f.pack()))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download).toHaveBeenCalledTimes(2);
    expect(f.transport.send).not.toHaveBeenCalled();
    f.transport.download.mockClear();
    f.transport.getSet.mockResolvedValueOnce({ name: 'Example_pack', title: 'full budget', stickers: Array.from({ length: 4 }, () => file('animated')) });
    f.transport.download.mockImplementation(async (_file, _signal, maxBytes) => Buffer.concat([tgs, Buffer.alloc(maxBytes - tgs.length)]));
    await expect(f.service.convert(user(), input(f.pack()))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download.mock.calls.map(call => call[2])).toEqual([8 * MiB, 8 * MiB, 4 * MiB]);
    expect(f.transport.send).not.toHaveBeenCalled();
  });
});

describe('sticker concurrency and actual cancellation', () => {
  it('permits one active job per person across topics and two users globally with no waiting queue', async () => {
    const f = fixture(); const entered = Promise.withResolvers<void>(); const finish = Promise.withResolvers<void>();
    f.transport.download.mockImplementation(async sticker => {
      if (f.transport.download.mock.calls.length === 2) entered.resolve();
      await finish.promise;
      return originals[sticker.kind];
    });
    const first = f.service.convert(user(), input(f.capture()));
    await expect(f.service.convert(user(1, 8), input(f.capture(user(1, 8))))).rejects.toMatchObject({ code: 'CAPACITY' });
    await expect(f.service.inspect(user(1, 9), f.pack(user(1, 9)))).rejects.toMatchObject({ code: 'CAPACITY' });
    const second = f.service.convert(user(2), input(f.capture(user(2))));
    await entered.promise;
    await expect(f.service.convert(user(), input(f.capture()))).rejects.toMatchObject({ code: 'CAPACITY' });
    await expect(f.service.convert(user(3), input(f.capture(user(3))))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download).toHaveBeenCalledTimes(2);
    finish.resolve(); await Promise.all([first, second]);
    await expect(f.service.convert(user(3), input(f.capture(user(3))))).resolves.toMatchObject({ messageId: 99 });
  });

  it('cancels only the exact scope and does not free the slot until the real converter drains', async () => {
    const f = fixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = Promise.withResolvers<void>();
    f.converter.mockImplementationOnce(async (request, signal) => {
      entered.resolve(signal); await finish.promise;
      return { data: png, format: request.format, width: 512, height: 256 };
    });
    const context = user(1, 7); const source = f.capture(context);
    const running = f.service.convert(context, input(source, 'png'));
    const rejected = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const signal = await entered.promise;
    expect(await f.service.cancel(user(1, 8))).toEqual({ cancelled: false });
    expect(await f.service.cancel(user(2, 7))).toEqual({ cancelled: false });
    expect(signal.aborted).toBe(false);
    let drained = false;
    const cancellation = f.service.cancel(context).then(result => { drained = true; return result; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(drained).toBe(false);
    await expect(f.service.convert(context, input(source))).rejects.toMatchObject({ code: 'CAPACITY' });
    const nextContext = user(1, 8); const nextSource = f.capture(nextContext);
    await expect(f.service.convert(nextContext, input(nextSource))).rejects.toMatchObject({ code: 'CAPACITY' });
    finish.resolve();
    expect(await cancellation).toEqual({ cancelled: true });
    await rejected;
    expect(await f.service.cancel(context)).toEqual({ cancelled: false });
    expect(f.transport.send).not.toHaveBeenCalled();
    await f.service.convert(nextContext, input(nextSource));
  });

  it('release aborts only the job for that source and cannot be used by another owner', async () => {
    const f = fixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = Promise.withResolvers<void>();
    f.transport.download.mockImplementationOnce(async (_file, signal) => { entered.resolve(signal); await finish.promise; return webp; });
    const source = f.capture(); const other = f.capture();
    const running = f.service.convert(user(), input(source));
    const rejected = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const signal = await entered.promise;
    f.service.release(user(2), source); f.service.release(user(), other);
    expect(signal.aborted).toBe(false);
    f.service.release(user(), source);
    expect(signal.aborted).toBe(true);
    const nextContext = user(1, 8); const nextSource = f.capture(nextContext);
    await expect(f.service.convert(nextContext, input(nextSource))).rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    finish.resolve(); await rejected;
    expect(f.transport.send).not.toHaveBeenCalled();
    await expect(f.service.inspect(user(), source)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(f.service.convert(nextContext, input(nextSource))).resolves.toMatchObject({ messageId: 99 });
  });

  it.each(['direct', 'action'] as const)('binds %s source cancellation to the matching job and waits for its cleanup', async entry => {
    const f = await actionFixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = Promise.withResolvers<void>();
    cleanups.push(async () => { finish.resolve(); });
    f.converter.mockImplementationOnce(async (request, signal) => {
      entered.resolve(signal); await finish.promise;
      return { data: png, format: request.format, width: 512, height: 256 };
    });
    const context = user(1, 7); const source = f.capture(context); const otherSource = f.capture(context);
    const running = f.service.convert(context, input(source, 'png'));
    const rejected = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const signal = await entered.promise;
    const cancel = async (owner: InvocationContext, reference: string) => entry === 'direct'
      ? f.service.cancel(owner, reference) : success(await f.execute(owner, 'cancel', { source: reference }));
    expect(await cancel(user(1, 7), otherSource)).toEqual({ cancelled: false });
    f.service.release(context, otherSource);
    expect(await cancel(user(1, 7), otherSource)).toEqual({ cancelled: false });
    for (const foreign of [user(2, 7), user(1, 8), invocation({ botId: 54321, chat: context.chat })]) {
      expect(await cancel(foreign, source)).toEqual({ cancelled: false });
    }
    expect(signal.aborted).toBe(false);
    let drained = false;
    const cancellation = cancel(user(1, 7), source).then(result => { drained = true; return result; });
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 1_000, interval: 5 });
    expect(drained).toBe(false);
    expect(f.transport.send).not.toHaveBeenCalled();
    finish.resolve();
    expect(await cancellation).toEqual({ cancelled: true });
    await rejected;
    expect(await cancel(user(1, 7), source)).toEqual({ cancelled: false });
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['download', 'getSet'] as const)('stop aborts and drains actual %s work before resolving', async stage => {
    const f = fixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = Promise.withResolvers<void>();
    if (stage === 'download') f.transport.download.mockImplementationOnce(async (_file, signal) => { entered.resolve(signal); await finish.promise; return webp; });
    else f.transport.getSet.mockImplementationOnce(async (name, signal) => { entered.resolve(signal); await finish.promise; return { name, title: 'pack', stickers: [file()] }; });
    const source = stage === 'download' ? f.capture() : f.pack();
    const running = stage === 'download' ? f.service.convert(user(), input(source)) : f.service.inspect(user(), source);
    const rejected = expect(running).rejects.toMatchObject({ code: 'CANCELLED' });
    const signal = await entered.promise;
    let stopped = false;
    const stopping = f.service.stop().then(() => { stopped = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(stopped).toBe(false);
    expect(() => f.capture()).toThrow('CANCELLED');
    finish.resolve(); await stopping; await rejected;
    expect(f.transport.send).not.toHaveBeenCalled();
    await f.service.stop();
  });

  it('forwards invocation abort and keeps uploads uncertain until actual completion', async () => {
    const f = fixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = Promise.withResolvers<void>();
    f.transport.send.mockImplementationOnce(async (_target, _result, signal) => { entered.resolve(signal); await finish.promise; return 123; });
    const controller = new AbortController(); const context = invocation({ signal: controller.signal });
    let settled = false;
    const running = f.service.convert(context, input(f.capture(context))).finally(() => { settled = true; });
    const rejected = expect(running).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    const signal = await entered.promise;
    controller.abort(); expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(settled).toBe(false);
    finish.resolve(); await rejected;
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });

  it('rejects already aborted work without calling ports', async () => {
    const f = fixture(); const source = f.capture(); const controller = new AbortController(); controller.abort();
    const context = invocation({ signal: controller.signal });
    await expect(f.service.convert(context, input(source))).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(() => f.capture(context)).toThrow('CANCELLED');
    expect(f.transport.download).not.toHaveBeenCalled();
  });
});

describe('sticker Action policies, deduplication and redaction', () => {
  it('registers four strict private self Actions for native or owned AI sources, with no extra confirmation', () => {
    const f = fixture(); const actions: ActionDefinition<unknown, unknown>[] = [];
    registerStickerActions({ register: action => actions.push(action as ActionDefinition<unknown, unknown>) }, f.service);
    expect(actions.map(action => [action.id, action.effect])).toEqual([['sticker.sources', 'read'], ['sticker.inspect', 'read'], ['sticker.convert', 'personal_write'], ['sticker.cancel', 'personal_write']]);
    for (const action of actions) {
      expect(action).toMatchObject({ permission: 'self', scopes: ['private'], sources: ['telegram', 'ai'], aiVisible: true, timeoutMs: 60_000 });
      expect(action.confirmation).toBeUndefined();
      expect(action.input.safeParse({ actorId: 1 }).success).toBe(false);
    }
    const cancel = actions.find(action => action.id === 'sticker.cancel')!;
    expect(cancel.input.safeParse({}).success).toBe(true);
    expect(cancel.input.safeParse({ source: 'a'.repeat(24) }).success).toBe(true);
    expect(cancel.input.safeParse({ source: 'file_static' }).success).toBe(false);
    expect(cancel.input.safeParse({ source: 'a'.repeat(24), actorId: 1 }).success).toBe(false);
    expect(moduleMetadataSchema.safeParse(stickerMetadata).success).toBe(true);
  });

  it('enforces real executor policy and rejects forged identities or raw file parameters', async () => {
    const f = await actionFixture(); const source = f.capture();
    for (const context of [invocation({ source: 'http' }), invocation({ chat: { id: -1, type: 'group' } }), { ...user() }]) {
      expect(await f.execute(context, 'convert', input(source))).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    }
    // AI is now an admitted source, but the service still refuses an unbound run.
    expect(await f.execute(invocation({ source: 'ai' }), 'convert', input(source)))
      .toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    for (const raw of [{ ...input(source), actorId: 2 }, { ...input(source), chatId: 2 }, { ...input(source), fileId: 'file_static' },
      { ...input(source), source: 'https://example.com/file' }, { ...input(source), confirmed: true }]) {
      expect(await f.execute(user(), 'convert', raw)).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    }
    expect((await f.core.executor.discoverTools(user())).filter(tool => tool.id.startsWith('fixture.sticker.')).map(tool => tool.id))
      .toEqual(['fixture.sticker.sources', 'fixture.sticker.inspect', 'fixture.sticker.convert', 'fixture.sticker.cancel']);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('allows an ordinary owner AI run to use only references captured in its actual private topic', async () => {
    const f = await actionFixture(); const human = user(3, 7); const source = f.capture(human);
    const context = invocation({ actorId: 3, chat: human.chat, source: 'ai', aiRunId: 'sticker-run' });
    expect(() => f.capture(context)).toThrow('FORBIDDEN');
    expect(success(await f.execute(context, 'sources', {}))).toMatchObject({ items: [{ source, kind: 'single', sourceKind: 'static' }] });
    for (const other of [invocation({ actorId: 4, chat: { id: 4, type: 'private', threadId: 7 }, source: 'ai', aiRunId: 'other-run' }),
      invocation({ actorId: 3, chat: { id: 3, type: 'private', threadId: 8 }, source: 'ai', aiRunId: 'other-topic-run' })]) {
      expect(await f.execute(other, 'convert', input(source))).toMatchObject({ status: 'failed', error: { code: 'NOT_FOUND' } });
    }
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(await f.execute(context, 'convert', input(source))).toMatchObject({ status: 'succeeded', data: { format: 'webp', delivery: 'document', messageId: 99 } });
    expect(f.transport.send).toHaveBeenCalledWith(expect.objectContaining({ chatId: 3, threadId: 7 }), expect.anything(), expect.any(AbortSignal));
    expect(f.core.audit.mock.calls.at(-1)![0]).toMatchObject({ actorId: 3, source: 'ai', actionId: 'fixture.sticker.convert', outcome: 'succeeded' });
  });

  it('deduplicates download/conversion/delivery together and replays only serializable receipts after UI failure', async () => {
    const f = await actionFixture(); const source = f.capture();
    const context = invocation({ invocationId: 'sticker.same' });
    const value = input(source, 'png', 'media');
    const [first, duplicate] = await Promise.all([f.execute(context, 'convert', value), f.execute(context, 'convert', value)]);
    expect(success(first)).toMatchObject({ format: 'png', delivery: 'photo', count: 1, messageId: 99 });
    expect(duplicate).toMatchObject({ status: 'succeeded', replayed: true });
    const failedUi = vi.fn(async () => { throw new Error('UI edit failed after delivery'); });
    await expect(failedUi()).rejects.toThrow();
    expect(await f.execute(context, 'convert', value)).toMatchObject({ status: 'succeeded', replayed: true });
    expect(await f.execute(context, 'convert', input(source, 'jpg'))).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    expect(f.converter).toHaveBeenCalledTimes(1);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(JSON.stringify(first))).toEqual(first);
    expect(JSON.stringify([first, f.core.audit.mock.calls])).not.toMatch(/file_static|unique_static|converted_png|data.*Buffer/);
    expect(success(await f.execute(user(), 'inspect', { source }))).toMatchObject({ kind: 'single' });
    expect(success(await f.execute(user(), 'cancel', {}))).toEqual({ cancelled: false });
  });

  it.each(['download', 'convert', 'send'] as const)('redacts %s exceptions and never retries', async stage => {
    const f = await actionFixture(); const secret = 'SENSITIVE_FILE_ID_AND_TOKEN';
    const error = new Error(secret);
    if (stage === 'download') f.transport.download.mockRejectedValue(error);
    else if (stage === 'convert') f.converter.mockRejectedValue(error);
    else f.transport.send.mockRejectedValue(error);
    const context = invocation({ invocationId: `sticker.error.${stage}` });
    const value = input(f.capture(), 'png');
    const result = await f.execute(context, 'convert', value);
    expect(result).toMatchObject({ status: 'failed', error: { code: stage === 'send' ? 'OUTCOME_UNKNOWN' : 'UNAVAILABLE' } });
    expect(await f.execute(context, 'convert', value)).toEqual(result);
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    expect(f.transport.send).toHaveBeenCalledTimes(stage === 'send' ? 1 : 0);
    expect(JSON.stringify([result, f.core.audit.mock.calls])).not.toContain(secret);
  });

  it('preserves definite safe port errors without their fields and treats malformed upload acknowledgements as uncertain', async () => {
    const f = fixture(); const source = f.capture();
    f.transport.send.mockRejectedValueOnce(new AppError('RATE_LIMITED', ['SECRET_TOKEN']));
    await expect(f.service.convert(user(), input(source))).rejects.toEqual(new AppError('RATE_LIMITED'));
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    f.transport.send.mockResolvedValueOnce(0);
    await expect(f.service.convert(user(), input(source))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    f.transport.send.mockRejectedValueOnce(new AppError('TIMEOUT', ['SECRET_TOKEN']));
    await expect(f.service.convert(user(), input(source))).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    expect(f.transport.send).toHaveBeenCalledTimes(3);
  });

  it('retains a definite Telegram capacity rejection and deduplicates it without retrying delivery', async () => {
    const f = await actionFixture();
    f.transport.send.mockRejectedValue(new AppError('CAPACITY', ['SECRET_TELEGRAM_RESPONSE']));
    const context = invocation({ invocationId: 'sticker.capacity' }); const value = input(f.capture());
    const result = await f.execute(context, 'convert', value);
    expect(result).toEqual({ status: 'failed', invocationId: context.invocationId, error: { code: 'CAPACITY' } });
    expect(await f.execute(context, 'convert', value)).toEqual(result);
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.core.audit.mock.calls)).not.toContain('SECRET_TELEGRAM_RESPONSE');
  });
});
