import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot, InputFile } from 'grammy';
import type { Sticker } from 'grammy/types';
import { createStickerTransport, stickerSetName, telegramStickerFile } from '../src/telegram/sticker.js';
import type { StickerFile } from '../src/modules/sticker.js';

const token = '12345:TEST_ONLY_NOT_A_REAL_TOKEN';
const bytes = Buffer.from('offline sticker bytes');
const file: StickerFile = { fileId: 'file_id', uniqueId: 'unique_id', kind: 'static', width: 32, height: 32, fileSize: bytes.length };
const input: Sticker = { file_id: file.fileId, file_unique_id: file.uniqueId, type: 'regular', width: 32, height: 32,
  is_animated: false, is_video: false, file_size: bytes.length, set_name: 'Safe_Pack', emoji: 'x' };
const target = { chatId: 1, threadId: 7, replyTo: 12 };

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const bot = new Bot(token, { client: { fetch: vi.fn(() => { throw new Error('Unexpected live Telegram call'); }) } });
  const calls: { method: string; payload: Record<string, unknown>; signal?: AbortSignal }[] = [];
  const info: Record<string, unknown> = { file_id: file.fileId, file_unique_id: file.uniqueId, file_path: 'stickers/file_1.webp', file_size: bytes.length };
  let failure: number | undefined;
  let thrown: Error | undefined;
  let onCall: (() => void) | undefined;
  bot.api.config.use(async (_previous, method, payload, signal) => {
    calls.push({ method, payload: payload as Record<string, unknown>, signal: signal as unknown as AbortSignal });
    onCall?.();
    if (thrown) throw thrown;
    if (failure) return { ok: false, error_code: failure, description: `secret ${token}` };
    return { ok: true, result: method === 'getFile' ? info : method === 'getStickerSet'
      ? { name: 'Safe_Pack', title: '<b>Literal title</b>', sticker_type: 'regular', stickers: [input] } : { message_id: 99 } } as never;
  });
  const fetcher = vi.fn<typeof fetch>(async () => new Response(Uint8Array.from(bytes), { headers: { 'content-length': String(bytes.length) } }));
  const transport = createStickerTransport(bot, token, fetcher);
  return { bot, transport, calls, info, fetcher,
    fail: (code: number) => { failure = code; },
    throw: (error: Error) => { thrown = error; },
    onCall: (callback: () => void) => { onCall = callback; },
  };
}

describe('Telegram sticker references and links', () => {
  it('keeps trusted received type metadata instead of guessing from file paths', () => {
    expect(telegramStickerFile(input)).toMatchObject({ ...file, setName: 'Safe_Pack', setType: 'regular', emoji: 'x' });
    expect(telegramStickerFile({ ...input, is_animated: true }).kind).toBe('animated');
    expect(telegramStickerFile({ ...input, is_video: true }).kind).toBe('video');
    expect(() => telegramStickerFile({ ...input, is_animated: true, is_video: true })).toThrow('INVALID_INPUT');
  });
  it.each(['https://t.me/addstickers/Safe_Pack', 'https://telegram.me/addstickers/Safe_Pack/', 'https://t.me/addemoji/Safe_Pack', 'Safe_Pack'])('parses only a pack name from %s', value => {
    expect(stickerSetName(value)).toBe('Safe_Pack');
  });
  it.each(['https://evil.test/addstickers/Safe_Pack', 'https://t.me@evil.test/addstickers/Safe_Pack',
    'https://user:password@t.me/addstickers/Safe_Pack', 'http://t.me/addstickers/Safe_Pack',
    'https://t.me:8443/addstickers/Safe_Pack', 'https://t.me/addstickers/%53afe_Pack',
    'https://t.me/addstickers/Safe_Pack?url=http://127.0.0.1', 'https://t.me/addstickers/Safe_Pack#fragment',
    'file:///tmp/sticker', 'https://t.me/addstickers/../Safe_Pack', 'Safe/Pack', '__'.repeat(33)])('rejects an unsupported link/name %s', value => {
    expect(stickerSetName(value)).toBeUndefined();
  });
  it('does not treat every ordinary word as an automatic pack request', () => {
    expect(stickerSetName('hello', false)).toBeUndefined();
    expect(stickerSetName('https://t.me/addstickers/Safe_Pack', false)).toBe('Safe_Pack');
  });
});

describe('bounded official-host sticker download', () => {
  it('downloads only the getFile path, with no redirects, credentials or compression', async () => {
    const f = fixture();
    expect(await f.transport.download(file, new AbortController().signal, bytes.length)).toEqual(bytes);
    expect(f.calls).toMatchObject([{ method: 'getFile', payload: { file_id: 'file_id' } }]);
    expect(f.fetcher).toHaveBeenCalledWith(`https://api.telegram.org/file/bot${token}/stickers/file_1.webp`,
      expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', headers: { 'Accept-Encoding': 'identity' }, signal: expect.any(AbortSignal) }));
  });
  it.each(['../private', '/stickers/file.webp', 'https://evil.test/file.webp', 'stickers/../private',
    'stickers/%2e%2e/file.webp', 'stickers/file.webp?token=x', 'stickers\\file.webp', 'stickers/file.webp#fragment'])('rejects an unsafe getFile path %s before fetching', async path => {
    const f = fixture(); f.info.file_path = path;
    await expect(f.transport.download(file, new AbortController().signal, bytes.length)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it('applies byte limits before requesting a known oversized source', async () => {
    const f = fixture();
    await expect(f.transport.download(file, new AbortController().signal, bytes.length - 1)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.calls).toHaveLength(0); expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each([['content-length', String(bytes.length + 1)], ['content-length', 'invalid'], ['content-encoding', 'gzip']] as const)('cancels a rejected %s response without reading its body', async (name, value) => {
    const f = fixture(); const cancel = vi.fn();
    f.fetcher.mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { [name]: value } }));
    await expect(f.transport.download(file, new AbortController().signal, bytes.length)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects and closes oversized chunked responses even without Content-Length', async () => {
    const f = fixture(); delete f.info.file_size;
    const cancel = vi.fn();
    f.fetcher.mockResolvedValue(new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(bytes.length + 1)); }, cancel })));
    await expect(f.transport.download({ ...file, fileSize: undefined }, new AbortController().signal, bytes.length)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('rejects truncated bytes instead of uploading incomplete originals', async () => {
    const f = fixture(); f.fetcher.mockResolvedValue(new Response(Uint8Array.from(bytes.subarray(1))));
    await expect(f.transport.download(file, new AbortController().signal, bytes.length)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
  it('cancels a blocked body read and releases the stream', async () => {
    const f = fixture(); const controller = new AbortController(); const cancel = vi.fn();
    const entered = Promise.withResolvers<void>();
    f.fetcher.mockResolvedValue(new Response(new ReadableStream({ pull() { entered.resolve(); }, cancel }, { highWaterMark: 0 })));
    const pending = f.transport.download(file, controller.signal, bytes.length);
    await entered.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('destroys a response arriving after cancellation without leaking its token URL', async () => {
    const f = fixture(); const controller = new AbortController(); const cancel = vi.fn();
    const entered = Promise.withResolvers<void>(); const response = Promise.withResolvers<Response>();
    f.fetcher.mockImplementation(() => { entered.resolve(); return response.promise; });
    const pending = f.transport.download(file, controller.signal, bytes.length);
    await entered.promise; controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', message: 'CANCELLED' });
    response.resolve(new Response(new ReadableStream({ cancel })));
    await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  });
  it('sanitizes upstream exceptions that contain credential-bearing URLs', async () => {
    const f = fixture(); f.fetcher.mockRejectedValue(new Error(`failed https://api.telegram.org/file/bot${token}/private`));
    await expect(f.transport.download(file, new AbortController().signal, bytes.length)).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'UNAVAILABLE' });
  });
  it('uses getStickerSet only and retains literal titles and source kinds', async () => {
    const f = fixture();
    expect(await f.transport.getSet('Safe_Pack', new AbortController().signal)).toEqual({ name: 'Safe_Pack', title: '<b>Literal title</b>', stickers: [telegramStickerFile(input)] });
    expect(f.calls.map(call => call.method)).toEqual(['getStickerSet']);
    expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('single-attempt sticker output', () => {
  it.each([['photo', 'sendPhoto', 'photo'], ['animation', 'sendAnimation', 'animation'], ['document', 'sendDocument', 'document']] as const)('sends %s through the selected API only', async (delivery, method, field) => {
    const f = fixture();
    expect(await f.transport.send(target, { data: bytes, filename: 'sticker.gif', delivery }, new AbortController().signal)).toBe(99);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method, payload: { chat_id: 1, message_thread_id: 7,
      reply_parameters: { message_id: 12, allow_sending_without_reply: true }, [field]: expect.any(InputFile) } });
    if (delivery === 'document') expect(f.calls[0]!.payload.disable_content_type_detection).toBe(true);
  });
  it.each([[400, 'INVALID_INPUT'], [403, 'FORBIDDEN'], [429, 'CAPACITY'], [500, 'OUTCOME_UNKNOWN']] as const)('classifies API %i without fallback or repeated uploads', async (status, code) => {
    const f = fixture(); f.fail(status);
    await expect(f.transport.send(target, { data: bytes, filename: 'sticker.png', delivery: 'photo' }, new AbortController().signal)).rejects.toMatchObject({ code, message: code });
    expect(f.calls).toHaveLength(1);
  });
  it('does not start a cancelled upload', async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    await expect(f.transport.send(target, { data: bytes, filename: 'sticker.png', delivery: 'photo' }, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(f.calls).toHaveLength(0);
  });
  it('reports cancellation during upload as uncertain rather than sending another format', async () => {
    const f = fixture(); const controller = new AbortController();
    f.onCall(() => controller.abort()); f.throw(new Error(`uncertain private URL ${token}`));
    await expect(f.transport.send(target, { data: bytes, filename: 'sticker.gif', delivery: 'animation' }, controller.signal)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN', message: 'OUTCOME_UNKNOWN' });
    expect(f.calls).toHaveLength(1);
  });
});
