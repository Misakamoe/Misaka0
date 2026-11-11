import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  stickerConvertInputSchema, stickerKindSchema,
  stickerSetNameSchema, stickerSourceSchema,
  type StickerConvertInput, type StickerFormat, type StickerKind, type StickerResult, type StickerView,
} from '../../shared/schemas/sticker.js';
import type { InvocationContext } from '../actions.js';
import type { StickerSources } from '../../shared/schemas/ai-native.js';
import { AppError, throwIfAborted } from '../errors.js';
import type { StickerConverter } from './sticker-media.js';
import { withStickerZip, type StickerZipFile } from './sticker-zip.js';
import { defaultResourcePolicy, type ResourcePolicy } from '../resources.js';

export { stickerMetadata } from './metadata.js';
export { registerStickerActions } from './module-actions.js';

export interface StickerFile {
  fileId: string;
  uniqueId: string;
  kind: StickerKind;
  width: number;
  height: number;
  fileSize?: number;
  emoji?: string;
  setName?: string;
  setType?: 'regular' | 'mask' | 'custom_emoji';
}
export type StickerCapture = { kind: 'single'; sticker: StickerFile } | { kind: 'pack'; name: string };
export interface StickerTransport {
  download(file: StickerFile, signal: AbortSignal, maxBytes: number): Promise<Buffer>;
  getSet(name: string, signal: AbortSignal): Promise<{ name: string; title: string; stickers: StickerFile[] }>;
  send(target: { chatId: number; threadId?: number; replyTo: number },
    result: { data: Buffer | StickerZipFile; filename: string; delivery: 'photo' | 'animation' | 'document' }, signal: AbortSignal): Promise<number>;
}

const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_PACK_BYTES = 20 * 1024 * 1024;
const MAX_SINGLE_RESULT_BYTES = 10 * 1024 * 1024;
const SOURCE_TTL = 600_000;
const dimensionSchema = z.number().int().min(1).max(512);
const boundedText = (max: number) => z.string().max(max).refine(value => value.length <= max && !/\p{Cc}/u.test(value));
const fileSchema = z.strictObject({
  fileId: z.string().regex(/^[A-Za-z0-9_-]{1,512}$/), uniqueId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
  kind: stickerKindSchema, width: dimensionSchema, height: dimensionSchema,
  fileSize: z.number().int().min(1).max(MAX_FILE_BYTES).optional(), emoji: boundedText(64).optional(),
  setName: stickerSetNameSchema.optional(), setType: z.enum(['regular', 'mask', 'custom_emoji']).optional(),
});
const captureSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('single'), sticker: fileSchema }),
  z.strictObject({ kind: z.literal('pack'), name: stickerSetNameSchema }),
]);
const setSchema = z.strictObject({ name: stickerSetNameSchema, title: boundedText(128), stickers: z.array(fileSchema).min(1).max(120) });
type StickerSet = z.infer<typeof setSchema>;
interface Source {
  scope: string;
  owner: string;
  capture: StickerCapture;
  target: { chatId: number; threadId?: number; replyTo: number };
  expires: number;
  set?: StickerSet;
}
interface Job { source: string; owner: string; controller: AbortController; promise: Promise<unknown> }

function formats(kind: StickerKind): StickerFormat[] {
  return kind === 'static' ? ['original', 'png', 'jpg', 'webp'] : ['original', 'png', 'gif'];
}

function originalFormat(data: Buffer, kind: StickerKind): StickerResult['format'] {
  if (kind === 'static') {
    if (data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
    if (data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP'
      && data.readUInt32LE(4) === data.length - 8) return 'webp';
  } else if (kind === 'animated' && data.length >= 3 && data[0] === 31 && data[1] === 139 && data[2] === 8) return 'tgs';
  else if (kind === 'video' && data.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163]))) return 'webm';
  throw new AppError('INVALID_INPUT');
}

export class StickerService {
  private readonly transport: StickerTransport;
  private readonly converter: StickerConverter;
  private mediaModule: Promise<typeof import('./sticker-media.js')> | undefined;
  private readonly now: () => number;
  private readonly capacity: number;
  private readonly tempDirectory: string | undefined;
  private readonly resources: Pick<ResourcePolicy, 'tryAcquire'>;
  private readonly sources = new Map<string, Source>();
  private readonly jobs = new Map<string, Job>();
  private closed = false;

  constructor(options: { transport: StickerTransport; convert?: StickerConverter; now?: () => number; capacity?: number; tempDirectory?: string; resources?: Pick<ResourcePolicy, 'tryAcquire'> }) {
    this.transport = options.transport;
    this.converter = options.convert ?? (async (request, signal) => {
      throwIfAborted(signal);
      const media = await (this.mediaModule ??= import('./sticker-media.js'));
      throwIfAborted(signal);
      return media.convertSticker(request, signal);
    });
    this.now = options.now ?? Date.now;
    this.capacity = options.capacity ?? 200;
    this.tempDirectory = options.tempDirectory;
    this.resources = options.resources ?? defaultResourcePolicy;
    if (!Number.isSafeInteger(this.capacity) || this.capacity < 1 || this.capacity > 200) throw new AppError('INVALID_INPUT');
  }

  capture(context: InvocationContext, source: StickerCapture, sourceMessageId: number): string {
    if (context.source !== 'telegram') throw new AppError('FORBIDDEN');
    const scope = this.scope(context);
    this.prune();
    const parsed = captureSchema.safeParse(source);
    if (!parsed.success || !Number.isSafeInteger(sourceMessageId) || sourceMessageId < 1) throw new AppError('INVALID_INPUT');
    for (const [reference, existing] of this.sources) {
      if (existing.scope === scope && existing.target.replyTo === sourceMessageId
        && JSON.stringify(existing.capture) === JSON.stringify(parsed.data)) return reference;
    }
    const owner = `${context.botId}:${context.actorId}`;
    if (this.sources.size >= this.capacity || [...this.sources.values()].filter(item => item.owner === owner).length >= 8) throw new AppError('CAPACITY');
    let reference: string;
    do { reference = randomBytes(12).toString('hex'); } while (this.sources.has(reference));
    this.sources.set(reference, {
      scope, owner, capture: parsed.data, expires: this.now() + SOURCE_TTL,
      target: { chatId: context.chat.id, ...(context.chat.threadId === undefined ? {} : { threadId: context.chat.threadId }), replyTo: sourceMessageId },
    });
    return reference;
  }

  listSources(context: InvocationContext): StickerSources {
    const scope = this.scope(context);
    this.prune();
    return { items: [...this.sources.entries()].filter(([, source]) => source.scope === scope).slice(-8).reverse()
      .map(([reference, source]) => ({ source: reference, kind: source.capture.kind,
        ...(source.capture.kind === 'single' ? { sourceKind: source.capture.sticker.kind } : {}),
        expiresAt: new Date(source.expires).toISOString(),
      })) };
  }

  async agentFile(context: InvocationContext, reference: string): Promise<{ file: StickerFile; format: StickerResult['format']; size: number }> {
    const source = this.source(context, reference);
    if (context.source !== 'ai' || !context.aiRunId || source.capture.kind !== 'single') throw new AppError('FORBIDDEN');
    const file = source.capture.sticker;
    if (file.fileSize !== undefined && file.fileSize > 1_048_576) throw new AppError('CAPACITY');
    const data = await this.transport.download(file, context.signal, 1_048_576);
    this.source(context, reference);
    if (!data.length || data.length > 1_048_576) throw new AppError('CAPACITY');
    return { file: structuredClone(file), format: originalFormat(data, file.kind), size: data.length };
  }

  release(context: InvocationContext, sourceRef: string): void {
    const scope = this.scope(context);
    this.prune();
    if (this.sources.get(sourceRef)?.scope === scope) this.remove(sourceRef);
  }

  async inspect(context: InvocationContext, sourceRef: string): Promise<StickerView> {
    const source = this.source(context, sourceRef);
    if (source.capture.kind === 'pack' && !source.set) {
      await this.run(context, sourceRef, signal => this.resolveSet(source, sourceRef, signal));
      this.source(context, sourceRef);
    }
    const base = { source: sourceRef, expiresAt: new Date(source.expires).toISOString() };
    if (source.capture.kind === 'single') {
      const sticker = source.capture.sticker;
      return { ...base, kind: 'single', sourceKind: sticker.kind, width: sticker.width, height: sticker.height,
        ...(sticker.emoji === undefined ? {} : { emoji: sticker.emoji }), ...(sticker.setName === undefined ? {} : { setName: sticker.setName }),
        ...(sticker.setType === undefined ? {} : { setType: sticker.setType }),
        count: 1, formats: formats(sticker.kind) };
    }
    const setType = source.set!.stickers[0]!.setType;
    return { ...base, kind: 'pack', setName: source.set!.name, ...(setType === undefined ? {} : { setType }),
      title: source.set!.title, count: source.set!.stickers.length, formats: ['original'] };
  }

  async convert(context: InvocationContext, raw: StickerConvertInput): Promise<StickerResult> {
    const parsed = stickerConvertInputSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('INVALID_INPUT');
    const input = parsed.data;
    const source = this.source(context, input.source);
    if (source.capture.kind === 'pack' ? input.format !== 'original' || input.delivery !== 'file'
      : !formats(source.capture.sticker.kind).includes(input.format)
        || (input.format === 'original' || input.format === 'webp') && input.delivery !== 'file') throw new AppError('INVALID_INPUT');
    return this.run(context, input.source, async signal => {
      const send = async (data: Buffer | StickerZipFile, format: StickerResult['format'], count: number, delivery: StickerResult['delivery']): Promise<StickerResult> => {
        this.check(source, input.source, signal);
        let messageId: number;
        try {
          messageId = await this.transport.send({ ...source.target }, { data, filename: `${format === 'zip' ? 'stickers' : 'sticker'}.${format}`, delivery }, signal);
          if (signal.aborted || !Number.isSafeInteger(messageId) || messageId < 1) throw new AppError('OUTCOME_UNKNOWN');
        } catch (error) {
          if (error instanceof AppError && ['FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'RATE_LIMITED', 'CAPACITY', 'UNAVAILABLE'].includes(error.code)) throw new AppError(error.code);
          throw new AppError('OUTCOME_UNKNOWN');
        }
        return { format, delivery, bytes: Buffer.isBuffer(data) ? data.length : data.size, count, messageId };
      };
      let data: Buffer;
      let format: StickerResult['format'];
      let delivery: StickerResult['delivery'] = 'document';
      if (source.capture.kind === 'pack') {
        if (!this.tempDirectory) throw new AppError('UNAVAILABLE');
        const lease = this.resources.tryAcquire('heavy', 48 * 1024 * 1024);
        if (!lease) throw new AppError('CAPACITY');
        try {
          const set = await this.resolveSet(source, input.source, signal);
          const entries = async function* (service: StickerService) {
            let bytes = 0;
            for (const [index, file] of set.stickers.entries()) {
              service.check(source, input.source, signal);
              const original = await service.download(file, signal, Math.min(MAX_FILE_BYTES, MAX_PACK_BYTES - bytes));
              service.check(source, input.source, signal);
              bytes += original.length;
              yield { name: `${String(index + 1).padStart(3, '0')}.${originalFormat(original, file.kind)}`, data: original };
            }
          };
          return await withStickerZip(this.tempDirectory, entries(this), signal, file => send(file, 'zip', set.stickers.length, 'document'));
        } finally {
          lease.release();
        }
      } else {
        const file = source.capture.sticker;
        const original = await this.download(file, signal, MAX_FILE_BYTES);
        this.check(source, input.source, signal);
        const extension = originalFormat(original, file.kind);
        if (input.format === 'original') { data = original; format = extension; }
        else {
          // Dynamic PNG conversion is a first-frame request, not an animation export.
          const converted = await this.converter({ data: original, kind: file.kind, format: input.format,
            media: input.delivery === 'media', width: file.width, height: file.height }, signal);
          this.check(source, input.source, signal);
          if (converted.format !== input.format || !dimensionSchema.safeParse(converted.width).success
            || !dimensionSchema.safeParse(converted.height).success) throw new AppError('INVALID_OUTPUT');
          data = converted.data; format = converted.format;
          if (input.delivery === 'media') delivery = input.format === 'gif' ? 'animation' : 'photo';
        }
      }
      if (!Buffer.isBuffer(data) || data.length < 1 || data.length > MAX_SINGLE_RESULT_BYTES) throw new AppError('CAPACITY');
      return send(data, format, 1, delivery);
    });
  }

  async cancel(context: InvocationContext, sourceRef?: string): Promise<{ cancelled: boolean }> {
    const job = this.jobs.get(this.scope(context));
    if (!job || sourceRef !== undefined && job.source !== sourceRef) return { cancelled: false };
    job.controller.abort();
    await Promise.allSettled([job.promise]);
    return { cancelled: true };
  }

  async stop(): Promise<void> {
    this.closed = true;
    this.sources.clear();
    for (const job of this.jobs.values()) job.controller.abort();
    await Promise.allSettled([...this.jobs.values()].map(job => job.promise));
  }

  private scope(context: InvocationContext): string {
    if ((context.source !== 'telegram' && !(context.source === 'ai' && context.aiRunId)) || context.chat.type !== 'private' || context.chat.id !== context.actorId
      || context.dataScope.kind !== 'user' || context.dataScope.id !== context.actorId) throw new AppError('FORBIDDEN');
    if (this.closed) throw new AppError('CANCELLED');
    throwIfAborted(context.signal);
    return `${context.botId}:${context.actorId}:${context.chat.id}:${context.chat.threadId ?? 0}`;
  }

  private source(context: InvocationContext, reference: string): Source {
    const scope = this.scope(context);
    this.prune();
    const source = this.sources.get(reference);
    if (!stickerSourceSchema.safeParse(reference).success || !source || source.scope !== scope) throw new AppError('NOT_FOUND');
    return source;
  }

  private remove(reference: string): void {
    const source = this.sources.get(reference);
    this.sources.delete(reference);
    const job = source && this.jobs.get(source.scope);
    if (job?.source === reference) job.controller.abort();
  }

  private prune(): void {
    for (const [reference, source] of this.sources) if (source.expires <= this.now()) this.remove(reference);
  }

  private check(source: Source, reference: string, signal: AbortSignal): void {
    throwIfAborted(signal);
    if (this.closed || this.sources.get(reference) !== source || source.expires <= this.now()) throw new AppError('CANCELLED');
  }

  private run<T>(context: InvocationContext, source: string, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const scope = this.scope(context);
    const owner = `${context.botId}:${context.actorId}`;
    if (this.jobs.size >= 2 || [...this.jobs.values()].some(job => job.owner === owner)) throw new AppError('CAPACITY');
    const controller = new AbortController();
    const abort = () => controller.abort();
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) controller.abort();
    const promise = Promise.resolve().then(() => {
      throwIfAborted(controller.signal);
      return operation(controller.signal);
    }).catch((error: unknown) => {
      if (error instanceof AppError && error.code === 'OUTCOME_UNKNOWN') throw new AppError('OUTCOME_UNKNOWN');
      throwIfAborted(controller.signal);
      throw new AppError(error instanceof AppError ? error.code : 'UNAVAILABLE');
    }).finally(() => {
      context.signal.removeEventListener('abort', abort);
      this.jobs.delete(scope);
    });
    this.jobs.set(scope, { source, owner, controller, promise });
    return promise;
  }

  private async resolveSet(source: Source, reference: string, signal: AbortSignal): Promise<StickerSet> {
    this.check(source, reference, signal);
    if (source.set) return source.set;
    if (source.capture.kind !== 'pack') throw new AppError('INVALID_INPUT');
    const result = await this.transport.getSet(source.capture.name, signal);
    this.check(source, reference, signal);
    if (Array.isArray(result?.stickers) && result.stickers.length > 120) throw new AppError('CAPACITY');
    const parsed = setSchema.safeParse(result);
    if (!parsed.success || parsed.data.name.toLowerCase() !== source.capture.name.toLowerCase()) throw new AppError('UNAVAILABLE');
    source.set = parsed.data;
    return source.set;
  }

  private async download(file: StickerFile, signal: AbortSignal, maxBytes: number): Promise<Buffer> {
    throwIfAborted(signal);
    if (maxBytes < 1 || (file.fileSize ?? 0) > maxBytes) throw new AppError('CAPACITY');
    const data = await this.transport.download({ ...file }, signal, maxBytes);
    throwIfAborted(signal);
    if (!Buffer.isBuffer(data) || !data.length) throw new AppError('INVALID_INPUT');
    if (data.length > maxBytes) throw new AppError('CAPACITY');
    return data;
  }
}
