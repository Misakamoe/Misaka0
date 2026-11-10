import { spawn } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { AppError } from '../errors.js';
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
function inspectVideo(data: Buffer): { width: number; height: number; duration: number } {
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
      timestamps.push({ time: (time + data.readInt16BE(start)) * scale, duration });
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
  return { width, height, duration: Math.max(duration, declaredDuration) };
}

async function decodeVideo(request: StickerConversionRequest, signal: AbortSignal): Promise<RenderJob['video']> {
  const source = inspectVideo(request.data);
  const ratio = Math.min(request.width / source.width, request.height / source.height, 1);
  const width = Math.max(1, Math.round(source.width * ratio));
  const height = Math.max(1, Math.round(source.height * ratio));
  const frameBytes = width * height * 4;
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-xerror', '-filter_threads', '1',
    '-protocol_whitelist', 'pipe', '-f', 'matroska', '-c:v', 'libvpx-vp9', '-threads', '1',
    '-max_pixels', '262144', '-probesize', '8388608', '-analyzeduration', '4000000', '-i', 'pipe:0',
    '-map', '0:v:0', '-an', '-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1',
    '-vf', `fps=30,scale=${width}:${height}:flags=bicubic,setsar=1`,
    '-t', '3.05', '-frames:v', '91', '-threads', '1', '-c:v', 'rawvideo',
    '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1',
  ];
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let stderrBytes = 0;
    let unavailable = false;
    let failure: AppError | undefined;
    const stop = (error: AppError) => { failure ??= error; child.kill('SIGKILL'); };
    const abort = () => stop(new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    child.on('error', () => { failure ??= new AppError('UNAVAILABLE'); });
    child.stdin.on('error', () => { /* EPIPE is resolved by the child's close status. */ });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > frameBytes * 90) stop(new AppError('INVALID_INPUT'));
      else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      // Inspect only installation errors; no decoder text, metadata, or filenames escape this process.
      unavailable ||= /Unknown decoder|Unknown encoder|Decoder .* not found|Error loading shared libraries/i.test(chunk.toString('utf8'));
      if (stderrBytes > 64 * 1024) stop(new AppError('INVALID_INPUT'));
    });
    child.on('close', code => {
      signal.removeEventListener('abort', abort);
      if (failure) reject(failure);
      else if (code !== 0 || !bytes || bytes % frameBytes || Math.abs(bytes / frameBytes / 30 - source.duration) > 1 / 30 + 0.005) {
        reject(new AppError(unavailable ? 'UNAVAILABLE' : 'INVALID_INPUT'));
      }
      else {
        const pixels = new Uint8Array(bytes);
        let offset = 0;
        for (const chunk of chunks) { pixels.set(chunk, offset); offset += chunk.length; }
        chunks.length = 0;
        resolve({ pixels, width, height, count: bytes / frameBytes });
      }
    });
    if (signal.aborted) abort();
    else child.stdin.end(request.data);
  });
}

async function render(job: RenderJob, signal: AbortSignal): Promise<ConvertedSticker> {
  if (signal.aborted) throw new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './sticker-render.ts' : './sticker-render.js', import.meta.url), {
    workerData: job,
    // Native TS stripping works in dev/tests; production runs the emitted .js, without tsx/loaders.
    execArgv: [],
    env: {},
    resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
    stdout: true, stderr: true,
    transferList: job.video ? [job.video.pixels.buffer as ArrayBuffer] : [],
  });
  worker.stdout.resume();
  worker.stderr.resume();
  let abort: () => void = () => {};
  try {
    return await new Promise<ConvertedSticker>((resolve, reject) => {
      abort = () => reject(new AppError(signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED'));
      signal.addEventListener('abort', abort, { once: true });
      worker.once('error', (error: NodeJS.ErrnoException) => reject(new AppError(error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'CAPACITY' : 'UNAVAILABLE')));
      worker.once('exit', () => reject(new AppError('UNAVAILABLE')));
      worker.once('message', (reply: RenderReply) => {
        if (!reply.ok) {
          reject(new AppError(reply.code === 'CAPACITY' || reply.code === 'UNAVAILABLE' || reply.code === 'TIMEOUT' ? reply.code : 'INVALID_INPUT'));
          return;
        }
        const result = reply.result;
        const photo = job.request.media && job.request.format !== 'gif';
        // Only the minimum white short-side padding may exceed the requested content bounds.
        const widthFits = result.width <= job.request.width || photo
          && result.width === Math.ceil(result.height / 20) && result.height <= job.request.height;
        const heightFits = result.height <= job.request.height || photo
          && result.height === Math.ceil(result.width / 20) && result.width <= job.request.width;
        if (!(result.data instanceof Uint8Array) || !result.data.length || result.data.length > job.maxOutputBytes
          || result.format !== job.request.format || !validDimension(result.width) || !validDimension(result.height)
          || !widthFits || !heightFits || photo && Math.max(result.width, result.height) / Math.min(result.width, result.height) > 20) {
          reject(new AppError('INVALID_INPUT')); return;
        }
        resolve({ ...result, data: Buffer.from(result.data) });
      });
      if (signal.aborted) abort();
    });
  } finally {
    signal.removeEventListener('abort', abort);
    // Worker termination waits for its native work/environment to actually finish, not just JS rejection.
    await worker.terminate();
  }
}

export function createStickerConverter(options: { timeoutMs?: number; maxOutputBytes?: number } = {}): StickerConverter {
  const timeoutMs = Math.min(options.timeoutMs ?? DEADLINE_MS, DEADLINE_MS);
  const maxOutputBytes = Math.min(options.maxOutputBytes ?? MAX_OUTPUT, MAX_OUTPUT);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new AppError('INVALID_INPUT');
  return async (request, caller) => {
    if (caller.aborted) throw new AppError('CANCELLED');
    if (!request || !Buffer.isBuffer(request.data) || !request.data.length || request.data.length > MAX_SOURCE
      || !validDimension(request.width) || !validDimension(request.height) || typeof request.media !== 'boolean'
      || !(['static', 'animated', 'video'] as const).includes(request.kind)
      || !(request.kind === 'static' ? ['png', 'jpg', 'webp'] : ['png', 'gif']).includes(request.format)) throw new AppError('INVALID_INPUT');
    const controller = new AbortController();
    const abort = () => controller.abort('CANCELLED');
    const timer = setTimeout(() => controller.abort('TIMEOUT'), timeoutMs);
    caller.addEventListener('abort', abort, { once: true });
    try {
      if (caller.aborted) abort();
      const video = request.kind === 'video' ? await decodeVideo(request, controller.signal) : undefined;
      const result = await render({ request: video ? { ...request, data: Buffer.alloc(0) } : request, video, maxOutputBytes }, controller.signal);
      if (controller.signal.aborted) throw new AppError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      return result;
    } catch (error) {
      if (controller.signal.aborted) throw new AppError(controller.signal.reason === 'TIMEOUT' ? 'TIMEOUT' : 'CANCELLED');
      throw error instanceof AppError ? error : new AppError('UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      caller.removeEventListener('abort', abort);
    }
  };
}

export const convertSticker: StickerConverter = createStickerConverter();
