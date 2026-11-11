import sharp from 'sharp';
import type { RenderJob, RenderReply } from './sticker-render.js';

// Fixed codec entry point, not a general script executor or a security sandbox.
// Native/WASM residency dies with this process. These knobs are not an RSS cap.
sharp.cache(false);
sharp.concurrency(1);
const send = (message: unknown) => new Promise<void>((resolve, reject) => {
  process.send!(message, error => error ? reject(error) : resolve());
});

process.once('message', (job: RenderJob) => {
  const frames = async function* () {
    for (;;) {
      const next = new Promise<{ frame?: Uint8Array; end?: boolean }>(resolve => process.once('message', resolve));
      await send({ ready: true });
      const message = await next;
      if (message.end) return;
      if (!(message.frame instanceof Uint8Array)) throw new Error('INVALID_INPUT');
      yield message.frame;
    }
  };
  void import(new URL(import.meta.url.endsWith('.ts') ? './sticker-render.ts' : './sticker-render.js', import.meta.url).href)
    .then(async ({ convert }: typeof import('./sticker-render.js')) => convert(job, job.video ? frames() : undefined))
    .then(result => send({ ok: true, result } satisfies RenderReply))
    .catch(async (error: unknown) => {
      const message = error instanceof Error ? error.message : '';
      const code = message === 'CAPACITY' || message === 'UNAVAILABLE' ? message : /timeout/i.test(message) ? 'TIMEOUT' : 'INVALID_INPUT';
      await send({ ok: false, code } satisfies RenderReply);
    }).finally(() => process.exit());
});
