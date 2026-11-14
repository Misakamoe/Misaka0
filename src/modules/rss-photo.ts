import { fork } from 'node:child_process';
import { Parser } from 'htmlparser2';
import { XMLValidator } from 'fast-xml-parser';
import { defaultResourcePolicy, type ResourcePolicy } from '../resources.js';
import { RSS_PHOTO_MAX_SOURCE_BYTES, type RssPhotoFetcher } from './rss-contract.js';

export const RSS_PHOTO_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;
export const RSS_PHOTO_MAX_INPUT_PIXELS = 20_000_000;
export const RSS_PHOTO_MAX_DIMENSION = 1280;
export const RSS_PHOTO_MAX_REPAIR_BYTES = 8 * 1024 * 1024;
export const RSS_PHOTO_TIMEOUT_MS = 10_000;
export type RssPhotoPreparer = (url: string, signal: AbortSignal, maxSourceBytes?: number) => Promise<{ data: Buffer; sourceBytes: number }>;
type PhotoFormat = 'jpeg' | 'png' | 'webp' | 'avif' | 'svg';

export function inspectRssPhoto(data: Buffer): { format: PhotoFormat; width: number; height: number } {
  const { format, width, height } = inspectPhotoInput(data);
  return { format, width, height };
}

function inspectPhotoInput(data: Buffer): { source: Buffer; format: PhotoFormat; width: number; height: number } {
  const admit = (format: PhotoFormat, width: number, height: number, source = data) => {
    if (!validDimensions(width, height) || width * height > RSS_PHOTO_MAX_INPUT_PIXELS) throw new Error('RSS_PHOTO_INVALID');
    return { source, format, width, height };
  };
  if (data.subarray(0, 256).toString('utf8').trimStart().startsWith('<')) {
    const svg = svgPhotoInput(data);
    return admit('svg', svg.width, svg.height, svg.source);
  }
  if (data.toString('latin1', 4, 8) === 'ftyp') {
    let avif = false; let boxes = 0;
    let dimensions: { width: number; height: number } | undefined;
    const walk = (from: number, to: number, container: 'file' | 'meta' | 'iprp' | 'ipco'): void => {
      for (let offset = from; offset < to;) {
        if (++boxes > 4096 || offset + 8 > to) throw new Error('RSS_PHOTO_INVALID');
        let size = data.readUInt32BE(offset); let header = 8;
        if (size === 1) {
          if (offset + 16 > to) throw new Error('RSS_PHOTO_INVALID');
          size = Number(data.readBigUInt64BE(offset + 8)); header = 16;
        } else if (size === 0) size = to - offset;
        if (!Number.isSafeInteger(size) || size < header || size > to - offset) throw new Error('RSS_PHOTO_INVALID');
        const type = data.toString('latin1', offset + 4, offset + 8);
        const start = offset + header; const end = offset + size;
        if (type === 'ftyp' && container === 'file') {
          if (offset !== 0 || end - start < 8 || end - start > 1024 || (end - start) % 4 !== 0) throw new Error('RSS_PHOTO_INVALID');
          const brands = [data.toString('latin1', start, start + 4)];
          for (let at = start + 8; at < end; at += 4) brands.push(data.toString('latin1', at, at + 4));
          if (!brands.includes('avif') || brands.includes('avis') || brands.includes('msf1')) throw new Error('RSS_PHOTO_INVALID');
          avif = true;
        } else if (type === 'moov' && container === 'file') throw new Error('RSS_PHOTO_INVALID');
        else if (type === 'meta' && container === 'file') {
          if (start + 4 > end || data.readUInt32BE(start) !== 0) throw new Error('RSS_PHOTO_INVALID');
          walk(start + 4, end, 'meta');
        } else if (type === 'iprp' && container === 'meta') walk(start, end, 'iprp');
        else if (type === 'ipco' && container === 'iprp') walk(start, end, 'ipco');
        else if (type === 'ispe' && container === 'ipco') {
          if (end - start !== 12 || data.readUInt32BE(start) !== 0) throw new Error('RSS_PHOTO_INVALID');
          const current = admit('avif', data.readUInt32BE(start + 4), data.readUInt32BE(start + 8));
          // Bound every coded tile/auxiliary extent, not only the primary image's dimensions.
          if (!dimensions || current.width * current.height > dimensions.width * dimensions.height) dimensions = current;
        }
        offset = end;
      }
    };
    walk(0, data.length, 'file');
    if (!avif || !dimensions) throw new Error('RSS_PHOTO_INVALID');
    return admit('avif', dimensions.width, dimensions.height);
  }
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

function svgPhotoInput(data: Buffer): { source: Buffer; width: number; height: number } {
  if (data.length > 1024 * 1024) throw new Error('RSS_PHOTO_INVALID');
  const original = new TextDecoder('utf-8', { fatal: true }).decode(data);
  const declaration = /^\s*<\?xml\s+[^?]*\?>/.exec(original)?.[0] ?? '';
  const encoding = /\bencoding\s*=\s*['"]([^'"]+)['"]/.exec(declaration)?.[1];
  const xml = original.slice(declaration.length);
  if (encoding && encoding.toLowerCase() !== 'utf-8' || /<\?|<!\s*(?:DOCTYPE|ENTITY)/i.test(xml)) throw new Error('RSS_PHOTO_INVALID');
  const tags = new Set(['svg', 'g', 'defs', 'title', 'desc', 'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
    'text', 'tspan', 'linearGradient', 'radialGradient', 'stop']);
  const presentation = new Set(['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
    'stroke-miterlimit', 'stroke-dasharray', 'stroke-dashoffset', 'opacity', 'color', 'stop-color', 'stop-opacity', 'font-family',
    'font-size', 'font-style', 'font-weight', 'font-variant', 'text-anchor', 'dominant-baseline', 'alignment-baseline', 'baseline-shift',
    'letter-spacing', 'word-spacing', 'vector-effect', 'text-rendering', 'shape-rendering', 'paint-order', 'visibility', 'display']);
  const allowed = new Set(['id', 'class', 'version', 'xml:space', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y',
    'x1', 'y1', 'x2', 'y2', 'cx', 'cy', 'r', 'rx', 'ry', 'd', 'points', 'transform', 'gradientUnits', 'gradientTransform', 'spreadMethod',
    'offset', 'textLength', 'lengthAdjust', 'dx', 'dy', 'rotate', ...presentation]);
  const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const parts: string[] = [];
  let depth = 0; let nodes = 0; let roots = 0; let ignoredDepth = 0;
  let width = 0; let height = 0;
  let seen = new Set<string>();
  // Canonicalize a small SVG subset; no stylesheets, embedded images or recursive references reach the decoder.
  const parser = new Parser({
    onopentagname() { seen = new Set(); },
    onattribute(name) {
      if (seen.has(name) || seen.size >= 64) throw new Error('RSS_PHOTO_INVALID');
      seen.add(name);
    },
    onopentag(name, attributes) {
      if (++depth > 32 || ++nodes > 4096) throw new Error('RSS_PHOTO_INVALID');
      if (ignoredDepth) return;
      if (name === 'metadata' && depth > 1) { ignoredDepth = depth; return; }
      if (!tags.has(name) || depth === 1 && (name !== 'svg' || ++roots !== 1) || depth > 1 && name === 'svg') throw new Error('RSS_PHOTO_INVALID');
      const style = attributes.style;
      delete attributes.style;
      if (style !== undefined) {
        if (style.length > 65536 || /[\\{}@!]|\/\*/.test(style)) throw new Error('RSS_PHOTO_INVALID');
        for (const declaration of style.split(';').filter(value => value.trim())) {
          const colon = declaration.indexOf(':');
          const property = declaration.slice(0, colon).trim().toLowerCase(); const value = declaration.slice(colon + 1).trim();
          if (colon < 1 || !presentation.has(property) || !value) throw new Error('RSS_PHOTO_INVALID');
          attributes[property] = value;
        }
      }
      for (const [key, value] of Object.entries(attributes)) {
        if (key === 'xmlns' || key === 'xmlns:xlink') {
          if (depth !== 1 || value !== (key === 'xmlns' ? 'http://www.w3.org/2000/svg' : 'http://www.w3.org/1999/xlink')) throw new Error('RSS_PHOTO_INVALID');
          continue;
        }
        if (!allowed.has(key) || value.length > 65536 || /\\|\/\*/.test(value)
          || /url\s*\(/i.test(value) && !/^url\(\s*(['"]?)#[A-Za-z_][A-Za-z0-9_.:-]{0,127}\1\s*\)$/i.test(value)) throw new Error('RSS_PHOTO_INVALID');
      }
      if (depth === 1) {
        const viewBox = attributes.viewBox?.trim().split(/[\s,]+/).map(Number);
        if (viewBox && (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0)) throw new Error('RSS_PHOTO_INVALID');
        const length = (value: string | undefined): number | undefined => {
          if (value === undefined || value === '100%' && viewBox) return undefined;
          if (!/^(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?(?:px)?$/i.test(value.trim())) throw new Error('RSS_PHOTO_INVALID');
          const result = Number(value.trim().replace(/px$/i, ''));
          if (!Number.isFinite(result) || result <= 0) throw new Error('RSS_PHOTO_INVALID');
          return result;
        };
        const explicitWidth = length(attributes.width); const explicitHeight = length(attributes.height);
        width = Math.ceil(explicitWidth ?? (viewBox ? explicitHeight === undefined ? viewBox[2]! : explicitHeight * viewBox[2]! / viewBox[3]! : 0));
        height = Math.ceil(explicitHeight ?? (viewBox ? explicitWidth === undefined ? viewBox[3]! : explicitWidth * viewBox[3]! / viewBox[2]! : 0));
        if (!validDimensions(width, height) || width * height > RSS_PHOTO_MAX_INPUT_PIXELS) throw new Error('RSS_PHOTO_INVALID');
        attributes.xmlns = 'http://www.w3.org/2000/svg';
        attributes.width = String(width); attributes.height = String(height);
        if (viewBox) attributes.viewBox = viewBox.join(' ');
      }
      parts.push(`<${name}${Object.entries(attributes).map(([key, value]) => ` ${key}="${escape(value)}"`).join('')}>`);
    },
    onclosetag(name) {
      if (ignoredDepth) { if (depth === ignoredDepth) ignoredDepth = 0; }
      else parts.push(`</${name}>`);
      depth--;
    },
    ontext(value) {
      if (!depth && value.trim()) throw new Error('RSS_PHOTO_INVALID');
      if (!ignoredDepth && depth) parts.push(escape(value));
    },
    onprocessinginstruction() { throw new Error('RSS_PHOTO_INVALID'); },
  }, { xmlMode: true, decodeEntities: true });
  parser.end(xml);
  if (depth !== 0 || roots !== 1 || XMLValidator.validate(original) !== true) throw new Error('RSS_PHOTO_INVALID');
  const source = Buffer.from(parts.join(''));
  if (source.length > 2 * 1024 * 1024) throw new Error('RSS_PHOTO_INVALID');
  return { source, width, height };
}

let fetchModule: Promise<typeof import('./rss-feed.js')> | undefined;
const fetchRssPhoto: RssPhotoFetcher = async (...args) => (await (fetchModule ??= import('./rss-feed.js'))).fetchRssPhoto(...args);

export function createRssPhotoPreparer(fetcher: RssPhotoFetcher = fetchRssPhoto, options: { resources?: Pick<ResourcePolicy, 'tryAcquire'>; timeoutMs?: number } = {}): RssPhotoPreparer {
  const timeoutMs = Math.min(options.timeoutMs ?? RSS_PHOTO_TIMEOUT_MS, RSS_PHOTO_TIMEOUT_MS);
  const resources = options.resources ?? defaultResourcePolicy;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error('RSS_PHOTO_INVALID');
  return async (url, signal, maxSourceBytes = RSS_PHOTO_MAX_SOURCE_BYTES) => {
    if (signal.aborted) throw new Error('RSS_PHOTO_ABORTED');
    if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes <= 0) throw new Error('RSS_PHOTO_INVALID');
    let lease = resources.tryAcquire('heavy', 64 * 1024 * 1024);
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
      const admitted = inspectPhotoInput(source);
      // Re-admit synchronously before native work; this estimate is not an OS memory cap.
      const workingBytes = Math.max(64 * 1024 * 1024,
        32 * 1024 * 1024 + admitted.width * admitted.height * (admitted.format === 'avif' ? 32 : admitted.format === 'svg' ? 16 : 8)
        + source.length + admitted.source.length);
      lease.release();
      lease = undefined;
      lease = resources.tryAcquire('heavy', workingBytes);
      if (!lease) throw new Error('RSS_PHOTO_UNAVAILABLE');
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
        else child.send({ ...admitted, maxPixels: RSS_PHOTO_MAX_INPUT_PIXELS, maxDimension: RSS_PHOTO_MAX_DIMENSION }, error => { if (error) { failed = true; stop(); } });
      });
      return { data, sourceBytes: source.length };
    } catch {
      throw new Error(signal.aborted ? 'RSS_PHOTO_ABORTED' : controller.signal.reason === 'TIMEOUT' ? 'RSS_PHOTO_TIMEOUT'
        : !lease ? 'RSS_PHOTO_UNAVAILABLE' : 'RSS_PHOTO_INVALID');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      lease?.release();
    }
  };
}

export const prepareRssPhoto = createRssPhotoPreparer();
