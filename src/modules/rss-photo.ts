import sharp, { type Sharp } from 'sharp';
import { fetchRssPhoto, RSS_PHOTO_MAX_SOURCE_BYTES, type RssPhotoFetcher } from './rss-feed.js';

export const RSS_PHOTO_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const RSS_PHOTO_MAX_INPUT_PIXELS = 50_000_000;
export const RSS_PHOTO_MAX_DIMENSION = 2560;
export const RSS_PHOTO_TIMEOUT_MS = 10_000;
export type RssPhotoPreparer = (url: string, signal: AbortSignal, maxSourceBytes?: number) => Promise<{ data: Buffer; sourceBytes: number }>;

function photoFormat(data: Buffer): 'jpeg' | 'png' | 'webp' {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'jpeg';
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP';
  if (!png && !webp) throw new Error('RSS_PHOTO_INVALID');
  // Some decoders expose only the first frame, so reject animation at the container boundary too.
  for (let offset = png ? 8 : 12; offset < data.length;) {
    if (offset + 8 > data.length) throw new Error('RSS_PHOTO_INVALID');
    const length = png ? data.readUInt32BE(offset) : data.readUInt32LE(offset + 4);
    const type = data.toString('latin1', offset + (png ? 4 : 0), offset + (png ? 8 : 4));
    const end = offset + 8 + length + (png ? 4 : length % 2);
    if (end > data.length || type === 'acTL' || type === 'ANIM' || type === 'ANMF'
      || type === 'VP8X' && length > 0 && (data[offset + 8]! & 2) !== 0) throw new Error('RSS_PHOTO_INVALID');
    offset = end;
  }
  return png ? 'png' : 'webp';
}

function validDimensions(width: number, height: number): boolean {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) && width > 0 && height > 0
    && Math.max(width, height) / Math.min(width, height) <= 20;
}

export function createRssPhotoPreparer(fetcher: RssPhotoFetcher = fetchRssPhoto): RssPhotoPreparer {
  return async (url, signal, maxSourceBytes = RSS_PHOTO_MAX_SOURCE_BYTES) => {
    if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) throw new Error('RSS_PHOTO_INVALID');
    const maxBytes = Math.min(maxSourceBytes, RSS_PHOTO_MAX_SOURCE_BYTES);
    let image: Sharp | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const interrupted = Promise.withResolvers<never>();
    const abort = () => { image?.destroy(); interrupted.reject(new Error('RSS_PHOTO_ABORTED')); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      const source = await Promise.race([Promise.resolve().then(() => {
        if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
        return fetcher(url, signal, maxBytes);
      }), interrupted.promise]);
      if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
      if (!Buffer.isBuffer(source) || !source.length || source.length > maxBytes) throw new Error('RSS_PHOTO_INVALID');
      const format = photoFormat(source);
      image = sharp(source, { limitInputPixels: RSS_PHOTO_MAX_INPUT_PIXELS, failOn: 'warning', unlimited: false, sequentialRead: true })
        .timeout({ seconds: RSS_PHOTO_TIMEOUT_MS / 1000 });
      timer = setTimeout(() => {
        timedOut = true;
        image?.destroy();
        interrupted.reject(new Error('RSS_PHOTO_TIMEOUT'));
      }, RSS_PHOTO_TIMEOUT_MS);
      const metadata = await Promise.race([image.metadata(), interrupted.promise]);
      if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
      if (metadata.format !== format || !validDimensions(metadata.width, metadata.height)
        || metadata.width * metadata.height > RSS_PHOTO_MAX_INPUT_PIXELS
        || metadata.pages !== undefined && metadata.pages !== 1
        || metadata.pageHeight !== undefined && metadata.pageHeight !== metadata.height
        || (metadata.delay?.length ?? 0) > 1) throw new Error('RSS_PHOTO_INVALID');
      // The native timeout bounds libvips evaluation even after a caller abort destroys the JS stream.
      const { data, info } = await Promise.race([
        image.autoOrient().resize({ width: RSS_PHOTO_MAX_DIMENSION, height: RSS_PHOTO_MAX_DIMENSION, fit: 'inside', withoutEnlargement: true })
          .flatten({ background: '#ffffff' }).toColourspace('srgb').jpeg({ quality: 85 }).toBuffer({ resolveWithObject: true }),
        interrupted.promise,
      ]);
      if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
      if (!data.length || data.length > RSS_PHOTO_MAX_OUTPUT_BYTES || info.format !== 'jpeg'
        || !validDimensions(info.width, info.height) || info.width + info.height > 10_000
        || info.width > RSS_PHOTO_MAX_DIMENSION || info.height > RSS_PHOTO_MAX_DIMENSION) throw new Error('RSS_PHOTO_INVALID');
      return { data, sourceBytes: source.length };
    } catch {
      throw new Error(signal.aborted ? 'RSS_PHOTO_ABORTED' : timedOut ? 'RSS_PHOTO_TIMEOUT' : 'RSS_PHOTO_INVALID');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      image?.destroy();
    }
  };
}

export const prepareRssPhoto = createRssPhotoPreparer();
