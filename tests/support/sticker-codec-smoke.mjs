// Run against a compiled tree in an isolated, offline container at its real resource limits.
// This measures representative fixed codecs, not arbitrary-script qualification.
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { clearInterval, setInterval } from 'node:timers';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const MiB = 1024 * 1024;
const script = fileURLToPath(import.meta.url);

if (process.argv[2] === '--fixtures') {
  // Fixture encoding lives outside the app so Sharp does not remain in its heap.
  const { default: sharp } = await import('sharp');
  sharp.cache(false); sharp.concurrency(1);
  const pixels = Buffer.alloc(512 * 512 * 4);
  let seed = 123456;
  for (let i = 0; i < pixels.length; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    pixels[i] = i % 4 === 3 ? 255 : seed >>> 24;
  }
  const image = await sharp(pixels, { raw: { width: 512, height: 512, channels: 4 } }).png().toBuffer();
  const tgs = gzipSync(JSON.stringify({ v: '5.7.4', fr: 60, ip: 0, op: 180, w: 512, h: 512, ddd: 0, assets: [], layers: [{
    ty: 4, ind: 1, sr: 1, ip: 0, op: 180, st: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [256, 256, 0] },
      a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [256, 256] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 50 }, r: 1 }],
  }] }));
  const video = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
    '-f', 'lavfi', '-i', 'color=c=red@0.5:s=512x512:r=60:d=3,format=yuva420p',
    '-an', '-threads', '1', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8',
    '-auto-alt-ref', '0', '-lag-in-frames', '0', '-pix_fmt', 'yuva420p', '-f', 'webm', 'pipe:1',
  ], { env: {}, shell: false, timeout: 20_000, maxBuffer: 8 * MiB });
  console.log(JSON.stringify({ static: image.toString('base64'), animated: tgs.toString('base64'), video: video.toString('base64') }));
} else {
  const cgroup = async () => {
    const names = ['memory.max', 'memory.swap.max', 'memory.peak', 'memory.current', 'memory.events', 'cpu.max', 'cpu.stat', 'pids.max'];
    const values = Object.fromEntries(await Promise.all(names.map(async name => [name, (await readFile(`/sys/fs/cgroup/${name}`, 'utf8')).trim()])));
    const stat = (await readFile('/sys/fs/cgroup/memory.stat', 'utf8')).trim().split('\n').map(line => line.split(' '));
    return { ...values, memoryStat: Object.fromEntries(stat.filter(([key]) => ['anon', 'file', 'kernel', 'shmem'].includes(key)).map(([key, value]) => [key, Number(value)])) };
  };
  const initial = await cgroup();
  if (process.argv.includes('--require-low-memory')) {
    assert.equal(initial['memory.max'], String(256 * MiB));
    assert.equal(initial['memory.swap.max'], '0');
    assert.equal(initial['cpu.max'], '100000 100000');
  }
  assert.equal(initial['pids.max'], '64');
  const encoded = JSON.parse(execFileSync(process.execPath, ['--max-old-space-size=64', '--max-semi-space-size=2', script, '--fixtures'],
    { env: {}, shell: false, timeout: 30_000, maxBuffer: 8 * MiB }).toString('utf8'));
  const originals = Object.fromEntries(Object.entries(encoded).map(([kind, value]) => [kind, Buffer.from(value, 'base64')]));
  const { Bot } = await import('grammy');
  const { createApplication } = await import('../../dist/src/app.js');
  const { createInvocation } = await import('../../dist/src/actions.js');
  const { ResourcePolicy } = await import('../../dist/src/resources.js');
  const directory = await mkdtemp('/tmp/sticker-codec-smoke-');
  const token = '12345:OFFLINE_STICKER_SMOKE_TOKEN';
  const bot = new Bot(token, { client: { fetch: () => { throw new Error('Live Telegram forbidden'); } } });
  let sequence = 100;
  bot.api.config.use(async (_previous, method, payload) => ({ ok: true, result: method === 'getMe'
    ? { id: 12345, is_bot: true, first_name: 'Offline', username: 'offline_bot' }
    : method === 'sendRichMessage' ? { message_id: ++sequence, date: 1, chat: { id: payload.chat_id, type: 'private' } } : true }));
  const runnerTask = Promise.withResolvers();
  let sent;
  const transport = {
    download: async file => originals[file.kind],
    getSet: async () => { throw new Error('Unexpected pack lookup'); },
    send: async (_target, output) => { sent = output; return ++sequence; },
  };
  // Observe the real policy without changing it or injecting a converter.
  const policies = new Set();
  const acquire = ResourcePolicy.prototype.tryAcquire;
  ResourcePolicy.prototype.tryAcquire = function (kind, bytes) {
    if (kind === 'heavy') policies.add(this);
    return acquire.call(this, kind, bytes);
  };
  const app = createApplication({ botToken: token, adminIds: [1], dataDir: directory, logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 0 },
  }, { bot, stickerTransport: transport, runnerFactory: () => ({ start() {}, stop: async () => { runnerTask.resolve(); },
    size: () => 0, isRunning: () => true, task: () => runnerTask.promise }) });
  const reports = [];
  let sampled = { parentRssPeakBytes: 0, childrenRssPeakBytes: 0, cgroupAnonPeakBytes: 0, cgroupFilePeakBytes: 0 };
  let sampling;
  let sampleFailure;
  const sample = async () => {
    const current = sampled;
    current.parentRssPeakBytes = Math.max(current.parentRssPeakBytes, process.memoryUsage.rss());
    const children = (await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
    const rss = await Promise.all(children.slice(0, 8).map(async pid => {
      try { return Number((await readFile(`/proc/${pid}/status`, 'utf8')).match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024; }
      catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
    }));
    current.childrenRssPeakBytes = Math.max(current.childrenRssPeakBytes, rss.reduce((sum, value) => sum + value, 0));
    const usage = await cgroup();
    current.cgroupAnonPeakBytes = Math.max(current.cgroupAnonPeakBytes, usage.memoryStat.anon);
    current.cgroupFilePeakBytes = Math.max(current.cgroupFilePeakBytes, usage.memoryStat.file);
  };
  const monitor = setInterval(() => {
    sampling ??= sample().catch(error => { sampleFailure ??= error; }).finally(() => { sampling = undefined; });
  }, 50);
  const context = () => createInvocation({ actorId: 10, source: 'telegram', botId: 12345, chat: { id: 10, type: 'private' }, language: 'en' });
  const convert = (source, format) => app.executor.execute(context(), 'sticker.convert', { source, format, delivery: 'file' });
  try {
    await app.start();
    const baseline = await cgroup();
    for (const kind of ['static', 'animated', 'video']) {
      const id = ++sequence;
      await bot.handleUpdate({ update_id: id, message: { message_id: id, date: 1,
        chat: { id: 10, type: 'private', first_name: 'Owner' }, from: { id: 10, is_bot: false, first_name: 'Owner', language_code: 'en' },
        sticker: { file_id: `file_${kind}`, file_unique_id: `unique_${kind}`, type: 'regular', width: 512, height: 512,
          is_animated: kind === 'animated', is_video: kind === 'video' },
      } });
      const sources = await app.executor.execute(context(), 'sticker.sources', {});
      assert.equal(sources.status, 'succeeded');
      const source = sources.data.items.find(item => item.sourceKind === kind).source;
      for (const format of kind === 'static' ? ['png', 'jpg', 'webp'] : ['png', 'gif']) {
        await sampling;
        sampled = { parentRssPeakBytes: 0, childrenRssPeakBytes: 0, cgroupAnonPeakBytes: 0, cgroupFilePeakBytes: 0 };
        const start = performance.now();
        const result = await convert(source, format);
        assert.equal(result.status, 'succeeded', `${kind}/${format}: ${JSON.stringify(result)}`);
        assert.ok(Buffer.isBuffer(sent.data) && sent.data.length > 0 && sent.data.length <= 10 * MiB);
        assert.equal(policies.size, 1);
        assert.equal([...policies][0].heavyBytes, undefined);
        sent = undefined;
        assert.equal((await readFile(`/proc/self/task/${process.pid}/children`, 'utf8')).trim(), '', 'Codec children must exit before the Action completes');
        await sampling;
        await sample();
        reports.push({ kind, format, sourceBytes: originals[kind].length, outputBytes: result.data.bytes, remainingChildren: 0,
          durationMs: Math.round(performance.now() - start), sampled, cgroup: await cgroup() });
      }
      const busy = [...policies][0].tryAcquire('heavy', 64 * MiB);
      assert.ok(busy);
      try {
        const rejected = await convert(source, 'png');
        assert.equal(rejected.status, 'failed'); assert.equal(rejected.error.code, 'CAPACITY');
        assert.equal((await convert(source, 'original')).status, 'succeeded');
        assert.equal(sent.data, originals[kind]);
      } finally { busy.release(); }
    }
    if (sampleFailure) throw sampleFailure;
    const final = await cgroup();
    const summary = { kind: 'offline-fixed-codec-smoke', certification: false,
      memoryLimitBytes: final['memory.max'], cpuQuota: final['cpu.max'], chargedPeakBytes: Number(final['memory.peak']),
      baselineAnonymousBytes: baseline.memoryStat.anon, finalAnonymousBytes: final.memoryStat.anon,
      sampledAnonymousPeakBytes: Math.max(...reports.map(report => report.sampled.cgroupAnonPeakBytes)),
      memoryEvents: final['memory.events'],
      conversions: reports.map(report => ({ kind: report.kind, format: report.format, bytes: report.outputBytes,
        durationMs: report.durationMs, remainingChildren: report.remainingChildren })),
    };
    console.log(JSON.stringify(process.argv.includes('--summary') ? summary : { kind: 'offline-fixed-codec-smoke', certification: false,
      coverage: '512px static noise; simple 512px TGS and VP9 alpha, 3s/60fps; Actions, contention, originals',
      sampling: '50ms; child RSS sums may double-count shared pages and miss short-lived peaks; kernel memory.peak includes fixture generation and charged filesystem cache',
      initial, baseline, reports, final }, null, 2));
  } finally {
    clearInterval(monitor);
    await sampling;
    ResourcePolicy.prototype.tryAcquire = acquire;
    await app.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
