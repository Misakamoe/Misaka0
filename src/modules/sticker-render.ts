import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import sharp, { type Sharp } from 'sharp';
import type { StickerConversionRequest, ConvertedSticker } from './sticker-media.js';

export interface RenderJob {
  request: StickerConversionRequest;
  maxOutputBytes: number;
  video?: { width: number; height: number; count: number };
}
export type RenderReply = { ok: true; result: ConvertedSticker } | { ok: false; code: 'INVALID_INPUT' | 'CAPACITY' | 'UNAVAILABLE' | 'TIMEOUT' };

const invalid = (): never => { throw new Error('INVALID_INPUT'); };
const dimension = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0 && Number(value) <= 512;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function lottie(data: Buffer) {
  const json: unknown = JSON.parse(gunzipSync(data, { maxOutputLength: 2 * 1024 * 1024 }).toString('utf8'));
  if (!object(json) || !dimension(json.w) || !dimension(json.h) || typeof json.fr !== 'number'
    || !(json.fr > 0 && json.fr <= 60) || typeof json.ip !== 'number' || typeof json.op !== 'number'
    || json.ip < 0 || !Array.isArray(json.layers)) return invalid();
  const assetList = Object.hasOwn(json, 'assets') ? json.assets : [];
  if (!Array.isArray(assetList)) return invalid();
  const duration = (json.op - json.ip) / json.fr;
  if (!(duration > 0 && duration <= 3.005)) return invalid();
  const pending: { value: unknown; depth: number }[] = [{ value: json, depth: 0 }];
  let nodes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop()!;
    if (++nodes > 50_000 || depth > 32) return invalid();
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > 100_000)) return invalid();
    if (typeof value === 'string' && value.length > 4096) return invalid();
    if (Array.isArray(value)) {
      if (value.length > 4096) return invalid();
      for (const child of value) pending.push({ value: child, depth: depth + 1 });
    } else if (object(value)) {
      for (const [key, child] of Object.entries(value)) {
        if (['__proto__', 'constructor', 'prototype', 'expression', 'expressions', 'exp'].includes(key)
          || key === 'x' && typeof child === 'string' || key === 'ddd' && child !== 0
          || ['fonts', 'chars', 'audio'].includes(key)
          || key === 'ef' && (!Array.isArray(child) || child.length !== 0)) return invalid();
        pending.push({ value: child, depth: depth + 1 });
      }
    }
  }
  const assets = new Map<string, unknown[]>();
  for (const asset of assetList) {
    if (!object(asset) || typeof asset.id !== 'string' || !Array.isArray(asset.layers)
      || ['p', 'u', 'src', 'url'].some(key => key in asset) || assets.has(asset.id)) return invalid();
    assets.set(asset.id, asset.layers);
  }
  let layers = 0;
  let shapes = 0;
  const traversedAssets = new Set<string>();
  const shapeTypes = new Set(['gr', 'sh', 'rc', 'el', 'sr', 'fl', 'st', 'gf', 'gs', 'tr', 'tm', 'rd', 'mm']);
  function checkShapes(list: unknown[], depth: number) {
    if (depth > 16) return invalid();
    for (const shape of list) {
      if (!object(shape) || typeof shape.ty !== 'string' || !shapeTypes.has(shape.ty) || ++shapes > 2048) return invalid();
      // Repeaters and unbounded procedural geometry are excluded from the supported vector subset.
      if (shape.ty === 'sr' && (!object(shape.pt) || shape.pt.a !== 0 || typeof shape.pt.k !== 'number' || shape.pt.k < 2 || shape.pt.k > 128)) return invalid();
      if (['gf', 'gs'].includes(shape.ty) && (!object(shape.g) || !Number.isInteger(shape.g.p) || Number(shape.g.p) < 1 || Number(shape.g.p) > 32)) return invalid();
      if (shape.ty === 'gr') {
        if (!Array.isArray(shape.it)) return invalid();
        checkShapes(shape.it, depth + 1);
      }
    }
  }
  function checkLayers(list: unknown[], path: Set<string>) {
    if (path.size > 16 || list.length > 512) return invalid();
    const ids = new Map<number, Record<string, unknown>>();
    for (const layer of list) {
      if (!object(layer)) return invalid();
      if (layer.ind !== undefined) {
        if (!Number.isSafeInteger(layer.ind) || ids.has(Number(layer.ind))) return invalid();
        ids.set(Number(layer.ind), layer);
      }
    }
    for (const layer of list as Record<string, unknown>[]) {
      const visited = new Set<Record<string, unknown>>([layer]);
      let parent = layer.parent;
      while (parent !== undefined) {
        if (typeof parent !== 'number' || !ids.has(parent)) return invalid();
        const ancestor = ids.get(parent)!;
        if (visited.has(ancestor)) return invalid();
        visited.add(ancestor);
        parent = ancestor.parent;
      }
    }
    for (const layer of list) {
      if (!object(layer) || typeof layer.ty !== 'number' || ![0, 3, 4].includes(layer.ty) || ++layers > 512) return invalid();
      if (layer.ty === 4) {
        if (!Array.isArray(layer.shapes)) return invalid();
        checkShapes(layer.shapes, 0);
      } else if (layer.ty === 0) {
        if (typeof layer.refId !== 'string' || path.has(layer.refId) || !assets.has(layer.refId)) return invalid();
        // Record coverage for the unused-asset pass, but still expand and count every instance.
        traversedAssets.add(layer.refId);
        checkLayers(assets.get(layer.refId)!, new Set([...path, layer.refId]));
      }
    }
  }
  checkLayers(json.layers, new Set());
  // Start unused graphs at their roots, independent of declaration order. Remaining components may be cyclic.
  const referencedAssets = new Set<string>();
  for (const list of assets.values()) for (const layer of list) {
    if (object(layer) && layer.ty === 0 && typeof layer.refId === 'string') referencedAssets.add(layer.refId);
  }
  const unusedRoots = [...assets].filter(([id]) => !referencedAssets.has(id));
  for (const [id, list] of [...unusedRoots, ...assets]) {
    if (traversedAssets.has(id)) continue;
    traversedAssets.add(id);
    checkLayers(list, new Set([id]));
  }
  return { json, width: json.w, height: json.h, fps: json.fr, duration };
}

function staticFormat(data: Buffer): 'png' | 'webp' | 'jpeg' {
  if (data[0] === 255 && data[1] === 216 && data[2] === 255) return 'jpeg';
  const png = data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = data.toString('latin1', 0, 4) === 'RIFF' && data.toString('latin1', 8, 12) === 'WEBP';
  if (!png && !webp || webp && data.readUInt32LE(4) + 8 !== data.length) return invalid();
  for (let offset = png ? 8 : 12; offset < data.length;) {
    if (offset + 8 > data.length) return invalid();
    const length = png ? data.readUInt32BE(offset) : data.readUInt32LE(offset + 4);
    const type = data.toString('latin1', offset + (png ? 4 : 0), offset + (png ? 8 : 4));
    const end = offset + 8 + length + (png ? 4 : length % 2);
    if (end > data.length || ['acTL', 'ANIM', 'ANMF'].includes(type)
      || type === 'VP8X' && length > 0 && (data[offset + 8]! & 2) !== 0) return invalid();
    offset = end;
  }
  return png ? 'png' : 'webp';
}

// Encode independent full canvases. Each frame gets its own palette: equal dimensions
// do not imply equal colours. Disposal-to-background prevents transparent ghosting.
export async function encodeGif(frames: AsyncIterable<{ pixels: Uint8Array; delay: number }>, width: number, height: number, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  const add = (data: Buffer) => {
    bytes += data.length;
    if (bytes > maxBytes) throw new Error('CAPACITY');
    chunks.push(data);
  };
  const header = Buffer.alloc(13);
  header.write('GIF89a'); header.writeUInt16LE(width, 6); header.writeUInt16LE(height, 8);
  add(header);
  add(Buffer.from([33, 255, 11, ...Buffer.from('NETSCAPE2.0'), 3, 1, 0, 0, 0]));
  for await (const { pixels, delay } of frames) {
    const image = sharp(pixels, { raw: { width, height, channels: 4 }, limitInputPixels: 262144 });
    let frame: Buffer;
    // Explicit quality reduction: at most 128 colours/frame, no dithering, GIF's
    // binary alpha. Reserve an unused transparent index even on opaque frames so
    // disposal-to-background can clear them before the next transparent canvas.
    try { frame = await image.gif({ colours: 128, dither: 0, effort: 3 }).toBuffer(); }
    finally { image.destroy(); }
    if (frame.toString('ascii', 0, 3) !== 'GIF' || frame.readUInt16LE(6) !== width || frame.readUInt16LE(8) !== height) return invalid();
    let offset = 13;
    let palette: Buffer | undefined;
    let paletteBits = frame[10]! & 7;
    if (frame[10]! & 128) { const end = offset + 3 * (2 << paletteBits); palette = frame.subarray(offset, end); offset = end; }
    let transparency = 0;
    let transparentIndex = 0;
    while (frame[offset] === 33) {
      const label = frame[offset + 1];
      offset += 2;
      if (label === 249) { transparency = frame[offset + 1]! & 1; transparentIndex = frame[offset + 4]!; }
      while (frame[offset]) offset += frame[offset]! + 1;
      offset++;
    }
    if (frame[offset] !== 44 || frame[offset + 9]! & 64) return invalid();
    const descriptor = Buffer.from(frame.subarray(offset, offset + 10));
    offset += 10;
    if (descriptor[9]! & 128) {
      paletteBits = descriptor[9]! & 7;
      const end = offset + 3 * (2 << paletteBits); palette = frame.subarray(offset, end); offset = end;
    }
    if (!palette || frame.at(-1) !== 59) return invalid();
    if (!transparency) {
      // libvips may pad the colour table to 256 even for 128-colour output.
      // Find a genuinely unused index by walking LZW, never guessing from RGBs.
      const used = new Uint8Array(256);
      const prefix = new Uint16Array(4096);
      const suffix = new Uint8Array(4096);
      const minimum = frame[offset]!;
      if (minimum < 2 || minimum > 8) return invalid();
      const clear = 1 << minimum;
      let bits = minimum + 1; let next = clear + 2; let previous = -1;
      let position = offset + 1; let remaining = 0; let packed = 0; let available = 0; let decoded = 0;
      const byte = () => {
        if (!remaining) remaining = frame[position++]!;
        if (!remaining || position >= frame.length) return invalid();
        remaining--; return frame[position++]!;
      };
      for (;;) {
        while (available < bits) { packed |= byte() << available; available += 8; }
        const code = packed & ((1 << bits) - 1); packed >>>= bits; available -= bits;
        if (code === clear) { bits = minimum + 1; next = clear + 2; previous = -1; continue; }
        if (code === clear + 1) break;
        if (code > next || code === next && previous < 0) return invalid();
        let entry = code === next ? previous : code;
        let length = code === next ? 2 : 1;
        while (entry >= clear) {
          if (entry >= next || ++length > 4096) return invalid();
          used[suffix[entry]!] = 1; entry = prefix[entry]!;
        }
        used[entry] = 1; decoded += length;
        if (decoded > width * height) return invalid();
        if (previous >= 0 && next < 4096) {
          prefix[next] = previous; suffix[next] = entry; next++;
          if (next === 1 << bits && bits < 12) bits++;
        }
        previous = code;
      }
      if (decoded !== width * height) return invalid();
      transparentIndex = used.findIndex((value, index) => !value && index < palette!.length / 3);
      if (transparentIndex < 0) {
        if (paletteBits >= 7) return invalid();
        transparentIndex = palette.length / 3;
        const expanded = Buffer.alloc(palette.length * 2);
        palette.copy(expanded); palette = expanded; paletteBits++;
      }
      transparency = 1;
    }
    descriptor[9] = 128 | paletteBits;
    const control = Buffer.from([33, 249, 4, 8 | transparency, 0, 0, transparentIndex, 0]);
    control.writeUInt16LE(Math.max(1, Math.round(delay / 10)), 4);
    add(control); add(descriptor); add(palette); add(frame.subarray(offset, -1));
  }
  add(Buffer.from([59]));
  return Buffer.concat(chunks, bytes);
}

export async function convert(job: RenderJob, videoFrames?: AsyncIterable<Uint8Array>): Promise<ConvertedSticker> {
  const { request } = job;
  const source = Buffer.from(request.data.buffer, request.data.byteOffset, request.data.byteLength);
  let image: Sharp;
  let width = request.width;
  let height = request.height;
  if (request.kind === 'static') {
    const format = staticFormat(source);
    image = sharp(source, { limitInputPixels: 262144, failOn: 'warning', sequentialRead: true }).timeout({ seconds: 12 });
    const metadata = await image.metadata();
    if (metadata.format !== format || !dimension(metadata.width) || !dimension(metadata.height)
      || (metadata.pages ?? 1) !== 1 || (metadata.delay?.length ?? 0) > 1) return invalid();
    image = image.autoOrient().resize({ width, height, fit: 'inside', withoutEnlargement: true });
  } else {
    let pixels: Buffer;
    if (request.kind === 'animated') {
      const animation = lottie(source);
      const ratio = Math.min(width / animation.width, height / animation.height, 1);
      width = Math.max(1, Math.round(animation.width * ratio));
      height = Math.max(1, Math.round(animation.height * ratio));
      // Only an in-memory URL is allowed, including if the renderer changes its asset-loading behavior.
      const fetchLocal = globalThis.fetch;
      globalThis.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith('blob:nodedata:')) throw new Error('INVALID_INPUT');
        return fetchLocal(input, init);
      };
      const { DotLottie } = await import('@lottiefiles/dotlottie-web');
      try {
        const wasm = await readFile(new URL(import.meta.resolve('@lottiefiles/dotlottie-web/dotlottie-player.wasm')));
        const url = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
        try { DotLottie.setWasmUrl(url); await DotLottie.preload(); }
        finally { URL.revokeObjectURL(url); }
      } catch { throw new Error('UNAVAILABLE'); }
      const player = new DotLottie({
        data: animation.json, canvas: { width, height }, autoplay: false, useFrameInterpolation: false,
        assetResolver: () => undefined,
        renderConfig: { autoResize: false, freezeOnOffscreen: false, devicePixelRatio: 1 },
      });
      try {
        await new Promise<void>((resolve, reject) => {
          player.addEventListener('load', () => resolve());
          player.addEventListener('loadError', () => reject(new Error('INVALID_INPUT')));
        });
        if (!Number.isFinite(player.totalFrames) || player.totalFrames <= 0 || player.totalFrames > 181
          || Math.abs(player.duration - animation.duration) > 0.02) return invalid();
        const fps = Math.min(animation.fps, 30);
        const count = request.format === 'png' ? 1 : Math.max(1, Math.min(90, Math.ceil(Math.min(animation.duration, 3) * fps - 1e-6)));
        async function* frames() {
          for (let i = 0; i < count; i++) {
            player.setFrame(Math.min(player.totalFrames - 1, i * animation.fps / fps));
            const buffer = player.buffer;
            if (!buffer || buffer.length !== width * height * 4) return invalid();
            yield { pixels: buffer, delay: Math.max(10, (Math.round(Math.min(animation.duration, (i + 1) / fps) * 100) - Math.round(i / fps * 100)) * 10) };
          }
        }
        if (request.format === 'gif') return { data: await encodeGif(frames(), width, height, job.maxOutputBytes), format: 'gif', width, height };
        player.setFrame(0);
        if (!player.buffer || player.buffer.length !== width * height * 4) return invalid();
        pixels = Buffer.from(player.buffer);
      } finally { player.destroy(); }
    } else {
      const video = job.video;
      if (!video || !videoFrames || !dimension(video.width) || !dimension(video.height) || !Number.isInteger(video.count)
        || video.count < 1 || video.count > 90) return invalid();
      width = video.width;
      height = video.height;
      let count = 0;
      const incoming = videoFrames;
      async function* frames() {
        for await (const frame of incoming) {
          if (frame.length !== width * height * 4 || ++count > video!.count) return invalid();
          yield { pixels: frame, delay: (Math.round(count * 100 / 30) - Math.round((count - 1) * 100 / 30)) * 10 };
        }
        if (count !== video!.count) return invalid();
      }
      if (request.format === 'gif') return { data: await encodeGif(frames(), width, height, job.maxOutputBytes), format: 'gif', width, height };
      pixels = Buffer.alloc(0);
      for await (const frame of frames()) pixels = Buffer.from(frame.pixels.buffer, frame.pixels.byteOffset, frame.pixels.byteLength);
      if (count !== 1) return invalid();
    }
    image = sharp(pixels, { raw: { width, height, channels: 4 }, limitInputPixels: 262144 });
  }
  try {
    image.timeout({ seconds: 12 }).toColourspace('srgb');
    if (request.format === 'jpg' || request.media && request.format !== 'gif') image.flatten({ background: '#ffffff' });
    if (request.media && request.format !== 'gif') {
      // Resolve orientation/resizing first; padding must not stretch the content or guess its dimensions.
      const content = await image.raw().toBuffer({ resolveWithObject: true });
      image.destroy();
      const { width: contentWidth, height: contentHeight, channels } = content.info;
      const horizontal = Math.max(0, Math.ceil(contentHeight / 20) - contentWidth);
      const vertical = Math.max(0, Math.ceil(contentWidth / 20) - contentHeight);
      image = sharp(content.data, { raw: { width: contentWidth, height: contentHeight, channels }, limitInputPixels: 262144 })
        .timeout({ seconds: 12 }).extend({
          left: Math.floor(horizontal / 2), right: Math.ceil(horizontal / 2),
          top: Math.floor(vertical / 2), bottom: Math.ceil(vertical / 2), background: '#ffffff',
        });
    }
    if (request.format === 'jpg') image.jpeg({ quality: 90 });
    else if (request.format === 'png') image.png();
    else if (request.format === 'webp') image.webp({ lossless: true, effort: 3 });
    else return invalid();
    const output = await image.toBuffer({ resolveWithObject: true });
    width = output.info.width;
    height = output.info.pageHeight ?? output.info.height;
    if (!dimension(width) || !dimension(height) || !output.data.length) return invalid();
    if (output.data.length > job.maxOutputBytes) throw new Error('CAPACITY');
    return { data: output.data, format: request.format, width, height };
  } finally { image.destroy(); }
}
