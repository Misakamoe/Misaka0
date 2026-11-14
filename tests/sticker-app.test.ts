import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Bot } from 'grammy';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { StickerSources } from '../shared/schemas/ai-native.js';
import type { StickerKind } from '../shared/schemas/sticker.js';
import { createApplication } from '../src/app.js';
import type { StartupConfig } from '../src/config.js';
import type { StickerTransport } from '../src/modules/sticker.js';
import { defaultResourcePolicy, ResourcePolicy } from '../src/resources.js';
import { invocation } from './support/core.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(resources?: ResourcePolicy) {
  const directory = await mkdtemp(join(tmpdir(), 'misaka-sticker-app-'));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const config: StartupConfig = {
    botToken: '12345:OFFLINE_STICKER_TEST_TOKEN', adminIds: [1], dataDir: directory, logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
    web: { enabled: false, host: '127.0.0.1', port: 0 },
  };
  const pixels = Buffer.alloc(32 * 32 * 4, 255);
  const video = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
    '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '32x32', '-framerate', '2', '-i', 'pipe:0',
    '-an', '-threads', '1', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8',
    '-auto-alt-ref', '0', '-lag-in-frames', '0', '-pix_fmt', 'yuva420p', '-f', 'webm', 'pipe:1',
  ], { input: Buffer.concat([pixels, pixels]), env: {}, shell: false, timeout: 5000, maxBuffer: 1024 * 1024 });
  expect(video.status, 'Offline VP9 fixture encoder must be available').toBe(0);
  const originals = {
    static: await sharp(pixels, { raw: { width: 32, height: 32, channels: 4 } }).webp().toBuffer(),
    animated: gzipSync(JSON.stringify({ v: '5.7.4', fr: 2, ip: 0, op: 2, w: 32, h: 32, ddd: 0, layers: [] })),
    video: video.stdout,
  };
  const network = vi.fn(() => { throw new Error('Live transport forbidden'); });
  const bot = new Bot(config.botToken, { client: { fetch: network } });
  let sequence = 100;
  bot.api.config.use(async (_previous, method, payload) => {
    const result = method === 'getMe' ? { id: 12345, is_bot: true, first_name: 'Offline', username: 'offline_bot' }
      : method === 'sendRichMessage' ? { message_id: ++sequence, date: 1, chat: { id: (payload as { chat_id: number }).chat_id, type: 'private' } }
        : true;
    return { ok: true, result } as never;
  });
  const transport = {
    download: vi.fn<StickerTransport['download']>(async file => originals[file.kind]),
    getSet: vi.fn<StickerTransport['getSet']>(async () => { throw new Error('Unexpected pack lookup'); }),
    send: vi.fn<StickerTransport['send']>(async () => ++sequence),
  };
  const runnerTask = Promise.withResolvers<void>();
  const app = createApplication(config, { bot, stickerTransport: transport, resources,
    runnerFactory: () => ({ start: () => {}, stop: async () => { runnerTask.resolve(); },
      size: () => 0, isRunning: () => true, task: () => runnerTask.promise }),
  });
  cleanups.push(() => app.stop());
  await app.start();
  const context = () => invocation({ actorId: 10, chat: { id: 10, type: 'private' } });
  const capture = async (kind: StickerKind) => {
    const messageId = ++sequence;
    await bot.handleUpdate({ update_id: messageId, message: { message_id: messageId, date: 1,
      chat: { id: 10, type: 'private', first_name: 'Owner' }, from: { id: 10, is_bot: false, first_name: 'Owner', language_code: 'en' },
      sticker: { file_id: `file_${kind}`, file_unique_id: `unique_${kind}`, type: 'regular', width: 32, height: 32,
        is_animated: kind === 'animated', is_video: kind === 'video' },
    } });
    const sources = await app.executor.execute<StickerSources>(context(), 'sticker.sources', {});
    expect(sources.status).toBe('succeeded');
    if (sources.status !== 'succeeded') throw new Error('Missing captured sticker');
    expect(transport.download).not.toHaveBeenCalled();
    return sources.data.items.find(item => item.sourceKind === kind)!.source;
  };
  return { app, transport, originals, network, capture,
    convert: (source: string, format: 'png' | 'jpg' | 'webp' | 'gif' | 'original') => app.executor.execute(context(), 'sticker.convert', { source, format, delivery: 'file' }),
  };
}

describe('production sticker application wiring', () => {
  it('converts static, TGS and WEBM through default lazy service and real Actions without qualification overrides', async () => {
    const f = await fixture();
    const sources = { static: await f.capture('static'), animated: await f.capture('animated'), video: await f.capture('video') };
    // Application work shares its own lane, not the standalone library lane.
    expect(defaultResourcePolicy.heavyBytes).toBeUndefined();
    const libraryLane = defaultResourcePolicy.tryAcquire('heavy')!;
    try {
      for (const kind of ['static', 'animated', 'video'] as const) {
        for (const format of kind === 'static' ? ['png', 'jpg', 'webp'] as const : ['png', 'gif'] as const) {
          expect(await f.convert(sources[kind], format)).toMatchObject({ status: 'succeeded', data: { format, delivery: 'document', count: 1 } });
          const delivered = f.transport.send.mock.calls.at(-1)![1];
          expect(Buffer.isBuffer(delivered.data)).toBe(true);
          const metadata = await sharp(delivered.data as Buffer).metadata();
          expect(metadata).toMatchObject({ format: format === 'jpg' ? 'jpeg' : format, width: 32, height: 32 });
          if (format === 'gif') expect(metadata.pages).toBe(kind === 'animated' ? 2 : 30);
        }
      }
    } finally { libraryLane.release(); }
    expect(f.transport.send).toHaveBeenCalledTimes(7);
    expect(f.network).not.toHaveBeenCalled();
  });

  it('shares the exact injected application heavy lane and recovers after contention', async () => {
    const resources = new ResourcePolicy({ heavyBytes: 96 * 1024 * 1024 });
    const f = await fixture(resources);
    const source = await f.capture('static');
    const heavy = resources.tryAcquire('heavy', 64 * 1024 * 1024)!;
    expect(heavy).toBeDefined();
    try {
      expect(await f.convert(source, 'png')).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
      expect(f.transport.send).not.toHaveBeenCalled();
      expect(await f.convert(source, 'original')).toMatchObject({ status: 'succeeded', data: { format: 'webp' } });
      expect(f.transport.send.mock.calls.at(-1)![1].data).toBe(f.originals.static);
    } finally { heavy.release(); }
    expect(await f.convert(source, 'png')).toMatchObject({ status: 'succeeded', data: { format: 'png' } });
    const available = resources.tryAcquire('heavy', 96 * 1024 * 1024);
    expect(available).toBeDefined();
    available?.release();
  });

  it('rejects an undersized application budget for all codecs while preserving original downloads', async () => {
    const f = await fixture(new ResourcePolicy({ heavyBytes: 96 * 1024 * 1024 - 1 }));
    const sources = { static: await f.capture('static'), animated: await f.capture('animated'), video: await f.capture('video') };
    for (const kind of ['static', 'animated', 'video'] as const) {
      expect(await f.convert(sources[kind], 'png')).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
      expect(await f.convert(sources[kind], 'original')).toMatchObject({ status: 'succeeded' });
      expect(f.transport.send.mock.calls.at(-1)![1].data).toBe(f.originals[kind]);
    }
    expect(f.transport.send).toHaveBeenCalledTimes(3);
  });
});
