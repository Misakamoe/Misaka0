import { Bot, GrammyError, InputFile } from 'grammy';
import type { Sticker } from 'grammy/types';
import { stickerSetNameSchema } from '../../shared/schemas/sticker.js';
import { AppError, throwIfAborted } from '../errors.js';
import type { StickerFile, StickerTransport } from '../modules/sticker.js';
import { telegramSignal } from './effects.js';

export function telegramStickerFile(sticker: Sticker): StickerFile {
  if (sticker.is_animated && sticker.is_video) throw new AppError('INVALID_INPUT');
  return {
    fileId: sticker.file_id, uniqueId: sticker.file_unique_id,
    kind: sticker.is_animated ? 'animated' : sticker.is_video ? 'video' : 'static',
    width: sticker.width, height: sticker.height, fileSize: sticker.file_size,
    emoji: sticker.emoji, setName: sticker.set_name, setType: sticker.type,
  };
}

export function stickerSetName(input: string, allowName = true): string | undefined {
  const value = input.trim();
  if (allowName && stickerSetNameSchema.safeParse(value).success) return value;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !['t.me', 'telegram.me'].includes(url.hostname)
      || url.username || url.password || url.port || url.search || url.hash) return undefined;
    const match = /^\/add(?:stickers|emoji)\/([A-Za-z0-9_]{1,64})\/?$/.exec(url.pathname);
    return match?.[1];
  } catch { return undefined; }
}

export function createStickerTransport(bot: Bot, token: string, fetcher: typeof fetch = fetch): StickerTransport {
  async function read<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    try {
      const result = await operation();
      throwIfAborted(signal);
      return result;
    } catch (error) {
      throwIfAborted(signal);
      throw new AppError(error instanceof GrammyError && error.error_code === 400 ? 'NOT_FOUND'
        : error instanceof GrammyError && error.error_code === 429 ? 'CAPACITY' : 'UNAVAILABLE');
    }
  }

  return {
    async getSet(name, signal) {
      if (!stickerSetNameSchema.safeParse(name).success) throw new AppError('INVALID_INPUT');
      const set = await read(() => bot.api.getStickerSet(name, telegramSignal(signal)), signal);
      if (!set || !Array.isArray(set.stickers) || !set.stickers.length || set.stickers.length > 120) throw new AppError('INVALID_INPUT');
      return { name: set.name, title: set.title, stickers: set.stickers.map(telegramStickerFile) };
    },
    async download(file, signal, maxBytes) {
      throwIfAborted(signal);
      if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 8 * 1024 * 1024
        || file.fileSize !== undefined && file.fileSize > maxBytes) throw new AppError('INVALID_INPUT');
      const request = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
      const info = await read(() => bot.api.getFile(file.fileId, telegramSignal(request)), request);
      const path = info.file_path;
      // Only Telegram's relative file path is used. Never accept a caller URL or follow redirects with the token.
      if (!path || path.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(path)
        || info.file_size !== undefined && (!Number.isSafeInteger(info.file_size) || info.file_size < 1 || info.file_size > maxBytes)) throw new AppError('INVALID_INPUT');
      let response: Response | undefined;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      const interrupted = Promise.withResolvers<never>();
      const discard = () => { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined); };
      const abort = () => { discard(); interrupted.reject(new AppError(signal.aborted ? 'CANCELLED' : 'TIMEOUT')); };
      request.addEventListener('abort', abort, { once: true });
      try {
        throwIfAborted(request);
        const fetching = fetcher(`https://api.telegram.org/file/bot${token}/${path}`, {
          method: 'GET', redirect: 'error', credentials: 'omit', headers: { 'Accept-Encoding': 'identity' }, signal: request,
        }).then(result => {
          response = result;
          if (request.aborted) { void result.body?.cancel().catch(() => undefined); throw new AppError('CANCELLED'); }
          return result;
        });
        response = await Promise.race([fetching, interrupted.promise]);
        const length = response.headers.get('content-length');
        const encoding = response.headers.get('content-encoding');
        if (response.status !== 200 || !response.body || encoding && encoding !== 'identity'
          || length !== null && (!/^[0-9]+$/.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) < 1 || Number(length) > maxBytes)) throw new AppError('INVALID_INPUT');
        reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let bytes = 0;
        for (;;) {
          const part = await Promise.race([reader.read(), interrupted.promise]);
          throwIfAborted(request);
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > maxBytes) throw new AppError('INVALID_INPUT');
          chunks.push(Buffer.from(part.value));
        }
        if (!bytes || length !== null && bytes !== Number(length) || info.file_size !== undefined && bytes !== info.file_size) throw new AppError('INVALID_INPUT');
        return Buffer.concat(chunks, bytes);
      } catch (error) {
        if (signal.aborted) throw new AppError('CANCELLED');
        if (request.aborted) throw new AppError('TIMEOUT');
        throw error instanceof AppError ? error : new AppError('UNAVAILABLE');
      } finally {
        request.removeEventListener('abort', abort);
        discard();
        reader?.releaseLock();
      }
    },
    async send(target, result, signal) {
      throwIfAborted(signal);
      const file = new InputFile(result.data, result.filename);
      const options = {
        message_thread_id: target.threadId,
        reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true },
      };
      try {
        const sent = result.delivery === 'photo'
          ? await bot.api.sendPhoto(target.chatId, file, options, telegramSignal(signal))
          : result.delivery === 'animation'
            ? await bot.api.sendAnimation(target.chatId, file, options, telegramSignal(signal))
            : await bot.api.sendDocument(target.chatId, file, { ...options, disable_content_type_detection: true }, telegramSignal(signal));
        return sent.message_id;
      } catch (error) {
        // An upload may have arrived before cancellation or a lost response. Never send a fallback copy.
        if (error instanceof GrammyError && error.error_code < 500) {
          throw new AppError(error.error_code === 429 ? 'CAPACITY' : error.error_code === 403 ? 'FORBIDDEN' : 'INVALID_INPUT');
        }
        throw new AppError('OUTCOME_UNKNOWN');
      }
    },
  };
}
