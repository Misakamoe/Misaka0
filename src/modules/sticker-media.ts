import { fork, spawn } from 'node:child_process';
import { AppError } from '../errors.js';
import { defaultResourcePolicy, type ResourcePolicy } from '../resources.js';
import type { StickerFormat, StickerKind } from '../../shared/schemas/sticker.js';
import type { RenderJob, RenderReply } from './sticker-render.js';

export interface StickerConversionRequest {
  data: Buffer;
  kind: StickerKind;
  format: Exclude<StickerFormat, 'original'>;
  media: boolean;
  width: number;
  height: number;
}
export interface ConvertedSticker {
  data: Buffer;
  format: Exclude<StickerFormat, 'original'>;
  width: number;
  height: number;
}
export type StickerConverter = (request: StickerConversionRequest, signal: AbortSignal) => Promise<ConvertedSticker>;

const MAX_SOURCE = 8 * 1024 * 1024;
const MAX_OUTPUT = 10 * 1024 * 1024;
const DEADLINE_MS = 15_000;
const validDimension = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= 512;

// Read only the bounded WebM envelope. Never trust a duration tag alone, or use -t to silently trim it.
function inspectVideo(data: Buffer, firstFrame = false): { width: number; height: number; duration: number; firstFrame?: Buffer } {
  const invalid = (): never => { throw new AppError('INVALID_INPUT'); };
  let nodes = 0;
  function vint(offset: number, end: number, identifier = false) {
    const first = data[offset];
    if (offset >= end || !first) return invalid();
    let length = 1;
    while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
    if (length > (identifier ? 4 : 8) || offset + length > end) return invalid();
    let value = identifier ? first : first & (0xff >> length);
    let unknown = !identifier && value === (0xff >> length);
    for (let i = 1; i < length; i++) {
      const byte = data[offset + i]!;
      value = value * 256 + byte;
      unknown &&= byte === 255;
    }
    if (!unknown && !Number.isSafeInteger(value)) return invalid();
    return { value, length, unknown };
  }
  function elements(start: number, end: number) {
    const result: { id: number; start: number; end: number }[] = [];
    while (start < end) {
      if (++nodes > 10_000) return invalid();
      const id = vint(start, end, true);
      const size = vint(start + id.length, end);
      const content = start + id.length + size.length;
      if (size.unknown && id.value !== 0x18538067) return invalid();
      const next = size.unknown ? end : content + size.value;
      if (next > end || next < content) return invalid();
      result.push({ id: id.value, start: content, end: next });
      start = next;
    }
    return result;
  }
  type Element = ReturnType<typeof elements>[number];
  function uint(element: Element | undefined): number {
    if (!element || element.end - element.start < 1 || element.end - element.start > 8) return invalid();
    let value = 0;
    for (let i = element.start; i < element.end; i++) value = value * 256 + data[i]!;
    return Number.isSafeInteger(value) ? value : invalid();
  }
  const text = (element: Element | undefined) => element ? data.toString('utf8', element.start, element.end) : '';
  function one(list: Element[], id: number, required = true) {
    const found = list.filter(element => element.id === id);
    if (found.length > 1 || required && !found.length) return invalid();
    return found[0];
  }
  const root = elements(0, data.length);
  const header = one(root, 0x1a45dfa3)!;
  if (text(one(elements(header.start, header.end), 0x4282)) !== 'webm') return invalid();
  const segment = one(root, 0x18538067)!;
  const entries = elements(segment.start, segment.end);
  const info = one(entries, 0x1549a966)!;
  const infoFields = elements(info.start, info.end);
  const scaleField = one(infoFields, 0x2ad7b1, false);
  const scale = scaleField ? uint(scaleField) / 1e9 : 0.001;
  if (!(scale > 0 && scale <= 1)) return invalid();
  const durationField = one(infoFields, 0x4489, false);
  let declaredDuration = 0;
  if (durationField) {
    const size = durationField.end - durationField.start;
    declaredDuration = (size === 4 ? data.readFloatBE(durationField.start)
      : size === 8 ? data.readDoubleBE(durationField.start) : invalid()) * scale;
    if (!(declaredDuration > 0 && declaredDuration <= 3.005)) return invalid();
  }
  const tracks = one(entries, 0x1654ae6b)!;
  const videoTracks = elements(tracks.start, tracks.end).filter(element => element.id === 0xae)
    .map(element => elements(element.start, element.end)).filter(fields => uint(one(fields, 0x83)) === 1);
  if (videoTracks.length !== 1) return invalid();
  const track = videoTracks[0]!;
  if (text(one(track, 0x86)) !== 'V_VP9') return invalid();
  const trackNumber = uint(one(track, 0xd7));
  const video = one(track, 0xe0)!;
  const dimensions = elements(video.start, video.end);
  const width = uint(one(dimensions, 0xb0));
  const height = uint(one(dimensions, 0xba));
  if (!validDimension(width) || !validDimension(height)) return invalid();
  const defaultDuration = one(track, 0x23e383, false);
  const interval = defaultDuration ? uint(defaultDuration) / 1e9 : 0;
  if (defaultDuration && !(interval >= 1 / 60 - 1e-6 && interval <= 3.005)) return invalid();
  const timestamps: { time: number; duration: number }[] = [];
  let firstBlock: { field: Element; time: Element; timestamp: number } | undefined;
  for (const cluster of entries.filter(element => element.id === 0x1f43b675)) {
    const fields = elements(cluster.start, cluster.end);
    const time = uint(one(fields, 0xe7));
    for (const field of fields) {
      let block = field;
      let duration = interval;
      if (field.id === 0xa0) {
        const group = elements(field.start, field.end);
        block = one(group, 0xa1)!;
        const blockDuration = one(group, 0x9b, false);
        if (blockDuration) duration = uint(blockDuration) * scale;
      } else if (field.id !== 0xa3) continue;
      const number = vint(block.start, block.end);
      if (number.value !== trackNumber) continue;
      const start = block.start + number.length;
      // Lacing obscures the frame count and timing; Telegram VP9 stickers do not need it.
      if (start + 3 >= block.end || (data[start + 2]! & 6) !== 0 || timestamps.length >= 180) return invalid();
      const timestamp = (time + data.readInt16BE(start)) * scale;
      timestamps.push({ time: timestamp, duration });
      if (!firstBlock || timestamp < firstBlock.timestamp) firstBlock = { field, time: one(fields, 0xe7)!, timestamp };
    }
  }
  if (!timestamps.length) return invalid();
  timestamps.sort((a, b) => a.time - b.time);
  const first = timestamps[0]!.time;
  if (first < 0 || first > 0.05) return invalid();
  if (timestamps.some(frame => frame.duration < 0 || frame.time - first + frame.duration > 3.005)) return invalid();
  for (let i = 1; i < timestamps.length; i++) {
    if (timestamps[i]!.time - timestamps[i - 1]!.time < 1 / 60 - 0.0011) return invalid();
  }
  const last = timestamps.at(-1)!;
  const lastDuration = last.duration || (timestamps.length > 1
    ? last.time - timestamps.at(-2)!.time : declaredDuration);
  const duration = last.time - first + lastDuration;
  if (!(lastDuration > 0 && duration > 0 && duration <= 3.005)) return invalid();
  if (!firstFrame) return { width, height, duration: Math.max(duration, declaredDuration) };
  const wrap = (id: string, content: Buffer) => {
    const size = Buffer.alloc(8); size.writeBigUInt64BE(BigInt(content.length) | (1n << 56n));
    return Buffer.concat([Buffer.from(id, 'hex'), size, content]);
  };
  const copy = (element: Element) => wrap(element.id.toString(16), data.subarray(element.start, element.end));
  // ffmpeg may probe/prefetch codec packets even with -frames:v 1. Supply a
  // standalone first-block container only AFTER the entire original was inspected.
  // BlockGroup is preserved intact, including VP9 alpha BlockAdditions.
  const cluster = wrap('1f43b675', Buffer.concat([copy(firstBlock!.time), copy(firstBlock!.field)]));
  const single = Buffer.concat([copy(header), wrap('18538067', Buffer.concat([copy(info), copy(tracks), cluster]))]);
  return { width, height, duration: Math.max(duration, declaredDuration), firstFrame: single };
}

function videoJob(request: StickerConversionRequest): NonNullable<RenderJob['video']> {
  const source = inspectVideo(request.data);
  const ratio = Math.min(request.width / source.width, request.height / source.height, 1);
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  return { width, height, count: request.format === 'png' ? 1 : Math.round(source.duration * 30) };
}

async function decodeVideo(request: StickerConversionRequest, video: NonNullable<RenderJob['video']>, signal: AbortSignal, frame: (data: Buffer) => Promise<void>): Promise<void> {
  const { width, height } = video;
  const frameBytes = width * height * 4;
  // PNG validates the whole container above, but deliberately does NOT decode later
  // compressed payloads. Later corrupt codec packets are relevant only to GIF export.
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-filter_threads', '1',
    '-protocol_whitelist', 'pipe', '-f', 'matroska', '-c:v', 'libvpx-vp9', '-threads', '1',
    '-max_pixels', '262144', '-probesize', '8388608', '-analyzeduration', '4000000',
    ...(request.format === 'png' ? ['-nofind_stream_info'] : []), '-i', 'pipe:0',
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', `${request.format === 'gif' ? 'fps=30,' : ''}scale=${width}:${height}:flags=bicubic,setsar=1`,
    '-frames:v', request.format === 'png' ? '1' : '91', '-threads', '1', '-c:v', 'rawvideo',
    '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
  ];
  const child = spawn('ffmpeg', args, { shell: false, env: {}, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let failure: AppError | undefined;
  const stop = (error: AppError) => { failure ??= error; child.kill('SIGKILL'); };
  const abort = () => stop(new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
  const closed = new Promise<void>(resolve => child.once('close', code => {
    if (code !== 0) failure ??= new AppError('INVALID_INPUT');
    resolve();
  }));
  signal.addEventListener('abort', abort, { once: true });
  child.on('error', () => { failure ??= new AppError('UNAVAILABLE'); });
  child.stdin.on('error', () => { /* The close status decides whether an early first-frame EPIPE was expected. */ });
  let stderrBytes = 0;
  child.stderr.on('data', (chunk: Buffer) => {
    stderrBytes += chunk.length;
    if (/Unknown decoder|Unknown encoder|Decoder .* not found|Error loading shared libraries/i.test(chunk.toString('utf8'))) failure ??= new AppError('UNAVAILABLE');
    if (stderrBytes > 64 * 1024) stop(new AppError('INVALID_INPUT'));
  });
  try {
    if (signal.aborted) abort();
    else child.stdin.end(request.format === 'png' ? inspectVideo(request.data, true).firstFrame : request.data);
    const pixels = Buffer.allocUnsafe(frameBytes);
    let offset = 0;
    let count = 0;
    for await (const value of child.stdout) {
      const chunk = value as Buffer;
      for (let start = 0; start < chunk.length;) {
        const size = Math.min(frameBytes - offset, chunk.length - start);
        chunk.copy(pixels, offset, start, start + size); start += size; offset += size;
        if (offset === frameBytes) {
          if (++count > video.count) throw new AppError('INVALID_INPUT');
          await frame(pixels); // One IPC frame in flight; decoder pipe supplies backpressure.
          offset = 0;
        }
      }
    }
    if (offset || count !== video.count) failure ??= new AppError('INVALID_INPUT');
  } catch (error) {
    stop(error instanceof AppError ? error : new AppError('INVALID_INPUT'));
  } finally {
    await closed;
    signal.removeEventListener('abort', abort);
  }
  if (failure) throw failure;
}

async function render(job: RenderJob, source: StickerConversionRequest, signal: AbortSignal): Promise<ConvertedSticker> {
  if (signal.aborted) throw new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
  const worker = fork(new URL(import.meta.url.endsWith('.ts') ? './sticker-worker.ts' : './sticker-worker.js', import.meta.url), [], {
    execArgv: ['--max-old-space-size=64', '--max-semi-space-size=2'], env: {}, serialization: 'advanced',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  worker.stdout!.resume(); worker.stderr!.resume();
  let failure: AppError | undefined;
  let result: ConvertedSticker | undefined;
  let ready = Promise.withResolvers<void>();
  // A rejected ready promise is also observed while a non-video job is running.
  void ready.promise.catch(() => {});
  const stop = (error: AppError) => { failure ??= error; ready.reject(failure); worker.kill('SIGKILL'); };
  const abort = () => stop(new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
  const closed = new Promise<void>(resolve => worker.once('close', code => {
    if (code !== 0 || !result) failure ??= new AppError('UNAVAILABLE');
    ready.reject(failure ?? new AppError('UNAVAILABLE'));
    resolve();
  }));
  worker.on('error', () => stop(new AppError('UNAVAILABLE')));
  worker.on('message', (reply: RenderReply | { ready: true }) => {
    if ('ready' in reply) { ready.resolve(); return; }
    if (!reply.ok) { stop(new AppError(reply.code)); return; }
    result = reply.result;
  });
  const send = (message: unknown) => new Promise<void>((resolve, reject) => worker.send(message as object, error => error ? reject(error) : resolve()));
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    else {
      await send(job);
      if (job.video) {
        await ready.promise;
        await decodeVideo(source, job.video, signal, async pixels => {
          ready = Promise.withResolvers<void>();
          void ready.promise.catch(() => {});
          await send({ frame: pixels });
          await ready.promise;
        });
        await send({ end: true });
      }
    }
    await closed;
    if (failure) throw failure;
    const output = result!;
    const photo = job.request.media && job.request.format !== 'gif';
    const widthFits = output.width <= job.request.width || photo
      && output.width === Math.ceil(output.height / 20) && output.height <= job.request.height;
    const heightFits = output.height <= job.request.height || photo
      && output.height === Math.ceil(output.width / 20) && output.width <= job.request.width;
    if (!(output.data instanceof Uint8Array) || !output.data.length || output.data.length > job.maxOutputBytes
      || output.format !== job.request.format || !validDimension(output.width) || !validDimension(output.height)
      || !widthFits || !heightFits || photo && Math.max(output.width, output.height) / Math.min(output.width, output.height) > 20) throw new AppError('INVALID_INPUT');
    return { ...output, data: Buffer.from(output.data.buffer, output.data.byteOffset, output.data.byteLength) };
  } catch (error) {
    stop(error instanceof AppError ? error : new AppError('UNAVAILABLE'));
    throw failure;
  } finally {
    await closed;
    signal.removeEventListener('abort', abort);
  }
}


export function createStickerConverter(options: { timeoutMs?: number; maxOutputBytes?: number; resources?: Pick<ResourcePolicy, 'tryAcquire'> } = {}): StickerConverter {
  const timeoutMs = Math.min(options.timeoutMs ?? DEADLINE_MS, DEADLINE_MS);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? MAX_OUTPUT, MAX_OUTPUT);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new AppError('INVALID_INPUT');
  return async (request, caller) => {
    if (caller.aborted) throw new AppError('CANCELLED');
    if (!request || !Buffer.isBuffer(request.data) || !request.data.length || request.data.length > MAX_SOURCE
      || !validDimension(request.width) || !validDimension(request.height) || typeof request.media !== 'boolean'
      || !(['static', 'animated', 'video'] as const).includes(request.kind)
      || !(request.kind === 'static' ? ['png', 'jpg', 'webp'] : ['png', 'gif']).includes(request.format)) throw new AppError('INVALID_INPUT');
    // Fixed, validated codecs, not an arbitrary-script sandbox. Keep the full
    // admission estimate and reject under-budget/busy hosts before spawning.
    const lease = (options.resources ?? defaultResourcePolicy).tryAcquire('heavy', 96 * 1024 * 1024);
    if (!lease) throw new AppError('CAPACITY');
    const controller = new AbortController();
    const abort = () => controller.abort('CANCELLED');
    const timer = setTimeout(() => controller.abort('TIMEOUT'), timeoutMs);
    caller.addEventListener('abort', abort, { once: true });
    try {
      if (caller.aborted) abort();
      const video = request.kind === 'video' ? videoJob(request) : undefined;
      const result = await render({ request: video ? { ...request, data: Buffer.alloc(0) } : request, video, maxOutputBytes }, request, controller.signal);
      if (controller.signal.aborted) throw new AppError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new AppError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      throw error instanceof AppError ? error : new AppError('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      caller.removeEventListener('abort', abort);
      lease.release();
    }
  };
}

export const convertSticker: StickerConverter = createStickerConverter();
