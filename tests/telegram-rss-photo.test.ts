import { fork } from 'node:child_process';
import { GrammyError, InputFile, type Bot } from 'grammy';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRssPhoto } from '../src/modules/rss-feed.js';
import { RSS_PHOTO_MAX_REPAIR_BYTES } from '../src/modules/rss-photo.js';
import type { RssPayload } from '../src/modules/rss.js';
import { ResourcePolicy } from '../src/resources.js';
import { createRssSender } from '../src/telegram/rss.js';

vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), fork: vi.fn((await original<typeof import('node:child_process')>()).fork) }));
vi.mock('../src/modules/rss-feed.js', async original => ({ ...await original<typeof import('../src/modules/rss-feed.js')>(), fetchRssPhoto: vi.fn() }));
afterEach(() => { vi.mocked(fork).mockReset(); vi.mocked(fetchRssPhoto).mockReset(); vi.restoreAllMocks(); });

const images = ['https://images.example.com/photo.jpg?b=2&a=1', 'https://images.example.com/other.png#original'];
const payload: RssPayload = { kind: 'entry', entry: {
  id: 'a'.repeat(64), title: '<b>Literal title</b>', content: 'Body @admin /help', images,
} };
const rejected = () => new GrammyError('Offline photo rejection', { ok: false, error_code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }, 'sendRichMessage', {});
function fixture(resources?: Pick<ResourcePolicy, 'tryAcquire'>) {
  const sendRichMessage = vi.fn<Bot['api']['sendRichMessage']>().mockResolvedValue({} as never);
  const bot = { api: { sendRichMessage } } as unknown as Bot;
  const send = createRssSender(bot, { resources });
  return { sendRichMessage, send: (input = payload, signal = new AbortController().signal) => send({ chatId: -100, kind: 'group', threadId: 9 }, '<b>Source @admin</b>', input, 'en', true, signal) };
}
const photo = () => sharp({ create: { width: 20, height: 10, channels: 3, background: '#204080' } }).png().toBuffer();

describe('RSS sender default photo repair', () => {
  it('does not fetch or start the codec when Telegram accepts original URLs', async () => {
    const f = fixture();
    await f.send();
    expect(f.sendRichMessage).toHaveBeenCalledOnce();
    expect(fetchRssPhoto).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
  });

  it('uploads repaired photos on definite rejection without qualification or preparer overrides', async () => {
    vi.mocked(fetchRssPhoto).mockResolvedValue(await photo());
    const f = fixture(); f.sendRichMessage.mockRejectedValueOnce(rejected());
    await f.send();
    expect(f.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(fetchRssPhoto).toHaveBeenCalledTimes(2);
    expect(fetchRssPhoto).toHaveBeenCalledWith(images[0], expect.any(AbortSignal), RSS_PHOTO_MAX_REPAIR_BYTES);
    expect(f.sendRichMessage.mock.calls[0]![1].blocks?.[0]).toMatchObject({ type: 'slideshow', blocks: images.map(media => ({ type: 'photo', photo: { media } })) });
    expect(f.sendRichMessage.mock.calls[1]![1].blocks?.[0]).toMatchObject({ type: 'slideshow', blocks: images.map(() => ({ type: 'photo', photo: { media: expect.any(InputFile) } })) });
  });

  it('repairs an ordinary JPEG after the wrong-web-content 400 response', async () => {
    const data = await sharp({ create: { width: 804, height: 350, channels: 3, background: '#204080' } }).jpeg().toBuffer();
    vi.mocked(fetchRssPhoto).mockResolvedValue(data);
    const f = fixture();
    f.sendRichMessage.mockRejectedValueOnce(new GrammyError('Offline photo rejection', {
      ok: false, error_code: 400, description: 'Bad Request: Wrong type of the web page content',
    }, 'sendRichMessage', {}));
    await f.send({ kind: 'entry', entry: { ...payload.entry, images: [images[0]!] } });
    expect(f.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(fetchRssPhoto).toHaveBeenCalledExactlyOnceWith(images[0], expect.any(AbortSignal), RSS_PHOTO_MAX_REPAIR_BYTES);
    expect(fork).toHaveBeenCalledOnce();
    expect(f.sendRichMessage.mock.calls[1]![1].blocks?.[0]).toMatchObject({ type: 'photo', photo: { media: expect.any(InputFile) } });
  });

  it('does not let invalid bytes or an animation poison a valid repaired photo', async () => {
    vi.mocked(fetchRssPhoto).mockResolvedValueOnce(Buffer.from('invalid image')).mockResolvedValueOnce(await photo());
    const f = fixture(); f.sendRichMessage.mockRejectedValueOnce(rejected());
    const animation = 'https://images.example.com/motion.gif';
    await f.send({ kind: 'entry', entry: { ...payload.entry, images: [...images, animation], animationIndices: [2] } });
    expect(fetchRssPhoto).toHaveBeenCalledTimes(2);
    expect(fork).toHaveBeenCalledOnce();
    expect(f.sendRichMessage).toHaveBeenCalledTimes(2);
    const uploaded = f.sendRichMessage.mock.calls[1]![1];
    expect(uploaded.blocks?.[0]).toMatchObject({ type: 'photo', photo: { media: expect.any(InputFile) } });
    expect(uploaded.blocks?.some(block => block.type === 'animation' || block.type === 'slideshow')).toBe(false);
    expect(uploaded.blocks).toContainEqual({ type: 'paragraph', text: [
      { type: 'url', text: 'Image 1', url: images[0] }, ' | ', { type: 'url', text: 'Animation 3', url: animation },
    ] });
    expect(uploaded.skip_entity_detection).toBe(true);
  });

  it('never sends a fallback after cancellation during the repaired upload', async () => {
    vi.mocked(fetchRssPhoto).mockResolvedValue(await photo());
    const f = fixture(); const controller = new AbortController();
    f.sendRichMessage.mockRejectedValueOnce(rejected()).mockImplementationOnce(async () => {
      controller.abort(); throw new Error('Cancelled after possible delivery');
    });
    await expect(f.send({ kind: 'entry', entry: { ...payload.entry, images: [images[0]!] } }, controller.signal)).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(f.sendRichMessage).toHaveBeenCalledTimes(2);
    expect(fetchRssPhoto).toHaveBeenCalledOnce();
  });

  it('shares the injected heavy lane and preserves literal original links while it is busy', async () => {
    const resources = new ResourcePolicy();
    const lease = resources.tryAcquire('heavy');
    expect(lease).toBeDefined();
    const f = fixture(resources); f.sendRichMessage.mockRejectedValueOnce(rejected());
    try {
      await f.send();
      expect(fetchRssPhoto).not.toHaveBeenCalled(); expect(fork).not.toHaveBeenCalled();
      const fallback = f.sendRichMessage.mock.calls[1]![1];
      expect(fallback.skip_entity_detection).toBe(true);
      expect(fallback.blocks).toContainEqual({ type: 'paragraph', text: [
        { type: 'url', text: 'Image 1', url: images[0] }, ' | ', { type: 'url', text: 'Image 2', url: images[1] },
      ] });
      expect(fallback.blocks).toContainEqual({ type: 'paragraph', text: { type: 'bold', text: '<b>Literal title</b>' } });
      expect(fallback.blocks?.some(block => block.type === 'photo' || block.type === 'slideshow')).toBe(false);
    } finally { lease?.release(); }
    vi.mocked(fetchRssPhoto).mockResolvedValue(await photo());
    f.sendRichMessage.mockRejectedValueOnce(rejected());
    await f.send();
    expect(fetchRssPhoto).toHaveBeenCalledTimes(2);
    expect(f.sendRichMessage.mock.calls[3]![1].blocks?.[0]).toMatchObject({ type: 'slideshow', blocks: images.map(() => ({ type: 'photo', photo: { media: expect.any(InputFile) } })) });
  });
});
