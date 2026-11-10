import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import sharp, { type Sharp } from 'sharp';
import { DotLottie } from '@lottiefiles/dotlottie-web';
import type { StickerConversionRequest, ConvertedSticker } from './sticker-media.js';

export interface RenderJob {
  request: StickerConversionRequest;
  maxOutputBytes: number;
  video?: { pixels: Uint8Array; width: number; height: number; count: number };
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

async function convert(job: RenderJob): Promise<ConvertedSticker> {
  const { request } = job;
  const source = Buffer.from(request.data);
  let image: Sharp;
  let width = request.width;
  let height = request.height;
  let delays: number[] = [];
  if (request.kind === 'static') {
    const format = staticFormat(source);
    image = sharp(source, { limitInputPixels: 262144, failOn: 'warning', sequentialRead: true }).timeout({ seconds: 12 });
    const metadata = await image.metadata();
    if (metadata.format !== format || !dimension(metadata.width) || !dimension(metadata.height)
      || (metadata.pages ?? 1) !== 1 || (metadata.delay?.length ?? 0) > 1) return invalid();
    image = image.autoOrient().resize({ width, height, fit: 'inside', withoutEnlargement: true });
  } else {
    let pixels: Buffer;
    let count: number;
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
        count = request.format === 'png' ? 1 : Math.max(1, Math.min(90, Math.ceil(Math.min(animation.duration, 3) * fps - 1e-6)));
        pixels = Buffer.alloc(width * height * 4 * count);
        for (let i = 0; i < count; i++) {
          player.setFrame(Math.min(player.totalFrames - 1, i * animation.fps / fps));
          const buffer = player.buffer;
          if (!buffer || buffer.length !== width * height * 4) return invalid();
          pixels.set(buffer, i * buffer.length);
          delays.push(Math.max(10, (Math.round(Math.min(animation.duration, (i + 1) / fps) * 100) - Math.round(i / fps * 100)) * 10));
        }
      } finally { player.destroy(); }
    } else {
      const video = job.video;
      if (!video || !dimension(video.width) || !dimension(video.height) || !Number.isInteger(video.count)
        || video.count < 1 || video.count > 90 || video.pixels.length !== video.width * video.height * 4 * video.count) return invalid();
      width = video.width;
      height = video.height;
      count = request.format === 'png' ? 1 : video.count;
      pixels = Buffer.from(video.pixels.buffer, video.pixels.byteOffset, width * height * 4 * count);
      delays = Array.from({ length: count }, (_, i) => (Math.round((i + 1) * 100 / 30) - Math.round(i * 100 / 30)) * 10);
    }
    image = sharp(pixels, { raw: { width, height: height * count, channels: 4, pageHeight: height }, limitInputPixels: 262144 * 90 });
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
    else image.gif({ delay: delays, loop: 0, effort: 3, colours: 256, dither: 0, keepDuplicateFrames: true });
    const output = await image.toBuffer({ resolveWithObject: true });
    width = output.info.width;
    height = output.info.pageHeight ?? output.info.height;
    if (!dimension(width) || !dimension(height) || !output.data.length) return invalid();
    if (output.data.length > job.maxOutputBytes) throw new Error('CAPACITY');
    return { data: output.data, format: request.format, width, height };
  } finally { image.destroy(); }
}

if (parentPort) {
  const port = parentPort;
  void convert(workerData as RenderJob).then(result => port.postMessage({ ok: true, result } satisfies RenderReply))
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      const code = message === 'CAPACITY' || message === 'UNAVAILABLE' ? message
        : /timeout/i.test(message) ? 'TIMEOUT' : 'INVALID_INPUT';
      port.postMessage({ ok: false, code } satisfies RenderReply);
    })
    .finally(() => port.close());
}
