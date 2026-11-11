import { fork } from 'node:child_process';
import { defaultResourcePolicy, type ResourcePolicy } from '../resources.js';
import { RSS_PHOTO_MAX_SOURCE_BYTES, type RssPhotoFetcher } from './rss-contract.js';

export const RSS_PHOTO_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const RSS_PHOTO_MAX_INPUT_PIXELS = 1_048_576;
export const RSS_PHOTO_MAX_DIMENSION = 1280;
export const RSS_PHOTO_MAX_REPAIR_BYTES = 2 * 1024 * 1024;
export const RSS_PHOTO_TIMEOUT_MS = 10_000;
export type RssPhotoPreparer = (url: string, signal: AbortSignal, maxSourceBytes?: number) => Promise<{ data: Buffer; sourceBytes: number }>;

export function inspectRssPhoto(data: Buffer): { format: 'jpeg' | 'png' | 'webp'; width: number; height: number } {
  const admit = (format: 'jpeg' | 'png' | 'webp', width: number, height: number) => {
    if (!validDimensions(width, height) || width * height > RSS_PHOTO_MAX_INPUT_PIXELS) throw new Error('RSS_PHOTO_INVALID');
    return { format, width, height };
  };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    for (let offset = 2; offset + 4 < data.length;) {
      if (data[offset++] !== 255) break;
      while (data[offset] === 255) offset++;
      const marker = data[offset++]!;
      if (marker === 0xda || marker === 0xd9) break;
      const length = data.readUInt16BE(offset);
      if (length < 2 || offset + length > data.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 8) return admit('jpeg', data.readUInt16BE(offset + 5), data.readUInt16BE(offset + 3));
      offset += length;
    }
    throw new Error('RSS_PHOTO_INVALID');
  }
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP';
  if (!png && !webp || webp && data.readUInt32LE(4) + 8 !== data.length) throw new Error('RSS_PHOTO_INVALID');
  let dimensions: { width: number; height: number } | undefined;
  // Some decoders expose only the first frame, so reject animation at the container boundary too.
  for (let offset = png ? 8 : 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('RSS_PHOTO_INVALID');
    const length = png ? data.readUInt32BE(offset) : data.readUInt32LE(offset + 4);
    const type = data.toString('latin1', offset + (png ? 4 : 0), offset + (png ? 8 : 4));
    const end = offset + 8 + length + (png ? 4 : length % 2);
    if (end > data.length || type === 'acTL' || type === 'ANIM' || type === 'ANMF'
      || type === 'VP8X' && length > 0 && (data[offset + 8]! & 2) !== 0) throw new Error('RSS_PHOTO_INVALID');
    const start = offset + 8;
    if (type === 'IHDR' && length === 13 && offset === 8) dimensions = { width: data.readUInt32BE(start), height: data.readUInt32BE(start + 4) };
    else if (type === 'VP8X' && length === 10) dimensions = { width: data.readUIntLE(start + 4, 3) + 1, height: data.readUIntLE(start + 7, 3) + 1 };
    else if (type === 'VP8 ' && length >= 10 && data.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42]))) {
      const current = { width: data.readUInt16LE(start + 6) & 16383, height: data.readUInt16LE(start + 8) & 16383 };
      admit('webp', current.width, current.height);
      dimensions ??= current;
    } else if (type === 'VP8L' && length >= 5 && data[start] === 47) {
      const bits = data.readUInt32LE(start + 1);
      const current = { width: (bits & 16383) + 1, height: ((bits >>> 14) & 16383) + 1 };
      admit('webp', current.width, current.height);
      dimensions ??= current;
    }
    offset = end;
  }
  if (!dimensions) throw new Error('RSS_PHOTO_INVALID');
  return admit(png ? 'png' : 'webp', dimensions.width, dimensions.height);
}

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Math.max(width, height) / Math.min(width, height) <= 20;
}

let fetchModule: Promise<typeof import('./rss-feed.js')> | undefined;
const fetchRssPhoto: RssPhotoFetcher = async (...args) => (await (fetchModule ??= import('./rss-feed.js'))).fetchRssPhoto(...args);

export function createRssPhotoPreparer(fetcher: RssPhotoFetcher = fetchRssPhoto, options: { qualified?: boolean; resources?: Pick<ResourcePolicy, 'tryAcquire'>; timeoutMs?: number } = {}): RssPhotoPreparer {
  const timeoutMs = Math.min(options.timeoutMs ?? RSS_PHOTO_TIMEOUT_MS, RSS_PHOTO_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('RSS_PHOTO_INVALID');
  return async (url, signal, maxSourceBytes = RSS_PHOTO_MAX_SOURCE_BYTES) => {
    if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) throw new Error('RSS_PHOTO_INVALID');
    if (!options.qualified) throw new Error('RSS_PHOTO_UNAVAILABLE');
    const lease = (options.resources ?? defaultResourcePolicy).tryAcquire('heavy', 64 * 1024 * 1024);
    if (!lease) throw new Error('RSS_PHOTO_UNAVAILABLE');
    const maxBytes = Math.min(maxSourceBytes, RSS_PHOTO_MAX_SOURCE_BYTES, RSS_PHOTO_MAX_REPAIR_BYTES);
    const controller = new AbortController();
    const abort = () => controller.abort('CANCELLED');
    const timer = setTimeout(() => controller.abort('TIMEOUT'), timeoutMs);
    signal.addEventListener('abort', abort, { once: true });
    try {
      // No race: even a misbehaving injected fetcher must drain before its lease is released.
      const source = await fetcher(url, controller.signal, maxBytes);
      if (controller.signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
      if (!Buffer.isBuffer(source) || !source.length || source.length > maxBytes) throw new Error('RSS_PHOTO_INVALID');
      const admitted = inspectRssPhoto(source);
      const data = await new Promise<Buffer>((resolve, reject) => {
        const child = fork(new URL(import.meta.url.endsWith('.ts') ? './rss-photo-worker.ts' : './rss-photo-worker.js', import.meta.url), [], {
          execArgv: ['--max-old-space-size=32', '--max-semi-space-size=2'], env: {}, serialization: 'advanced', stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        });
        let output: Buffer | undefined;
        let failed = false;
        const stop = () => child.kill('SIGKILL');
        controller.signal.addEventListener('abort', stop, { once: true });
        child.stdout!.resume(); child.stderr!.resume();
        child.on('error', () => { failed = true; });
        child.on('message', (reply: { data?: Uint8Array; width?: number; height?: number }) => {
          if (!(reply.data instanceof Uint8Array) || !reply.data.length || reply.data.length > RSS_PHOTO_MAX_OUTPUT_BYTES
            || !validDimensions(reply.width!, reply.height!) || reply.width! > RSS_PHOTO_MAX_DIMENSION || reply.height! > RSS_PHOTO_MAX_DIMENSION) { failed = true; stop(); }
          else output = Buffer.from(reply.data.buffer, reply.data.byteOffset, reply.data.byteLength);
        });
        child.once('close', code => {
          controller.signal.removeEventListener('abort', stop);
          if (failed || code !== 0 || !output || controller.signal.aborted) reject(new Error('RSS_PHOTO_INVALID'));
          else resolve(output);
        });
        if (controller.signal.aborted) stop();
        else child.send({ source, ...admitted, maxPixels: RSS_PHOTO_MAX_INPUT_PIXELS, maxDimension: RSS_PHOTO_MAX_DIMENSION }, error => { if (error) { failed = true; stop(); } });
      });
      return { data, sourceBytes: source.length };
    } catch {
      throw new Error(signal.aborted ? 'RSS_PHOTO_ABORTED' : controller.signal.reason === 'TIMEOUT' ? 'RSS_PHOTO_TIMEOUT' : 'RSS_PHOTO_INVALID');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lease.release();
    }
  };
}

export const prepareRssPhoto = createRssPhotoPreparer();
