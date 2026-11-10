import { Bot, InputFile } from 'grammy';
import type { RichText } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RSS_PHOTO_MAX_SOURCE_BYTES, parseFeed, type FeedEntry } from '../src/modules/rss-feed.js';
import { clipFeedContentFormat, type FeedContentFormat } from '../src/modules/rss-format.js';
import type { RssPhotoPreparer } from '../src/modules/rss-photo.js';
import { RSS_IMAGES_PER_MESSAGE, type RssPayload } from '../src/modules/rss.js';
import { createRssSender } from '../src/telegram/rss.js';

const target = { chatId: -100, kind: 'group', threadId: 9 } as const;
const payload: Extract<RssPayload, { kind: 'entry' }> = { kind: 'entry', entry: {
  id: 'a'.repeat(64), title: '/help <script>Title</script>', content: '<b>literal</b> @admin ' + 'content '.repeat(100),
  url: 'https://news.example.com/article', publishedAt: '2026-11-09T00:00:00.000Z',
} };
afterEach(() => vi.unstubAllEnvs());
function fixture() {
  const bot = new Bot('123456:OFFLINE_TEST_TOKEN', { botInfo: {
    id: 123456, is_bot: true, username: 'offline_bot', first_name: 'Offline',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
    can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false,
    can_manage_bots: false, supports_join_request_queries: false,
  } });
  const calls: { method: string; body: Record<string, unknown> }[] = [];
  const rawCalls: typeof calls = [];
  let failure: number | 'network' | undefined;
  let failureDescription = 'Offline test failure';
  let remaining = 0;
  bot.api.config.use(async (_previous, method, body) => {
    rawCalls.push({ method, body: body as Record<string, unknown> });
    calls.push({ method, body: structuredClone(body) as Record<string, unknown> });
    if (remaining-- > 0) {
      if (failure === 'network') throw new Error('Connection lost after possible delivery');
      return { ok: false, error_code: failure, description: failureDescription, parameters: { retry_after: 15 } } as never;
    }
    return { ok: true, result: true } as never;
  });
  const health = { recordApiError: vi.fn() };
  const prepare = vi.fn<RssPhotoPreparer>().mockRejectedValue(new Error('OFFLINE_UNPREPARED_PHOTO'));
  return { calls, rawCalls, health, prepare, send: createRssSender(bot, health, prepare),
    fail: (code: number | 'network', count = 1, description = 'Offline test failure') => { failure = code; remaining = count; failureDescription = description; },
  };
}
function plainText(text: RichText): string {
  if (typeof text === 'string') return text;
  if (Array.isArray(text)) return text.map(plainText).join('');
  return 'text' in text ? plainText(text.text) : '';
}
function messageBlocks(f: ReturnType<typeof fixture>, call = 0) {
  return (f.calls[call]!.body.rich_message as Parameters<Bot['api']['sendRichMessage']>[1]).blocks!;
}
function blockText(blocks: ReturnType<typeof messageBlocks>): string {
  return blocks.map(block => {
    if (block.type === 'table') return block.cells.map(row => row.map(cell => plainText(cell.text ?? '')).join('\t')).join('\n');
    if (block.type === 'list') return block.items.map(item => blockText(item.blocks)).join('\n');
    if ('blocks' in block) return blockText(block.blocks);
    return 'text' in block ? plainText(block.text) : '';
  }).join('\n');
}
function nativeBlockCount(blocks: ReturnType<typeof messageBlocks>): number {
  return blocks.reduce((count, block) => count + 1 + (block.type === 'table' ? block.cells.length
    : block.type === 'list' ? block.items.length + block.items.reduce((total, item) => total + nativeBlockCount(item.blocks), 0)
      : 'blocks' in block ? nativeBlockCount(block.blocks) : 0), 0);
}
function nodes(value: unknown, type: string): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(child => nodes(child, type));
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return [];
  const object = value as Record<string, unknown>;
  return [...(object.type === type ? [object] : []), ...Object.values(object).flatMap(child => nodes(child, type))];
}

describe('RSS Telegram publishing', () => {
  it.each([5, 8])('keeps %s large tables and a full gallery within the native 500-block limit', async tables => {
    const html = (`<table>${'<tr><td>x</td></tr>'.repeat(64)}</table>`).repeat(tables);
    const parsed = parseFeed(`<rss><channel><item><description><![CDATA[${html}]]></description></item></channel></rss>`, 'https://example.com/feed').entries[0]!;
    expect(Boolean(parsed.contentFormat)).toBe(tables === 5);
    const entry: FeedEntry = { ...parsed, images: Array.from({ length: 50 }, (_, index) => `https://example.com/${index}.jpg`), imagePositions: [] };
    const f = fixture();
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const blocks = messageBlocks(f);
    expect(nativeBlockCount(blocks)).toBeLessThanOrEqual(500);
    expect(nodes(blocks, 'table')).toHaveLength(tables === 5 ? tables : 0);
    expect(f.calls).toHaveLength(1);
  });

  it.each([false, true])('renders source code, tables and common formatting natively (folded=%s)', async folded => {
    const code = 'const value = "<script>literal</script>";\n\tprint(value);\n\n';
    const encoded = code.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const html = '<h2>Example</h2><p><strong>Bold <em>and italic</em></strong> '
      + '<code>https://code.example.com/</code> <a href="https://link.example.com/#part"><strong>linked</strong></a></p>'
      + `<pre><code class="language-zig">${encoded}</code></pre>`
      + '<table><thead><tr><th>Name</th><th>Value</th></tr></thead><tbody><tr><td>one</td><td><em>42</em></td></tr></tbody></table>'
      + '<ol start="3"><li>first</li><li>second</li></ol><blockquote><p>quoted</p></blockquote><hr>'
      + (folded ? `<p>${'padding '.repeat(50)}</p>` : '');
    const entry = parseFeed(`<rss><channel><item><title>Article</title><description><![CDATA[${html}]]></description></item></channel></rss>`, 'https://example.com/feed').entries[0]!;
    expect(entry.contentFormat?.version).toBe(1);
    const f = fixture();
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const top = messageBlocks(f); const details = top.find(block => block.type === 'details');
    expect(Boolean(details)).toBe(folded);
    const body = details?.blocks ?? top.slice(1, -1);
    expect(body).toContainEqual({ type: 'pre', text: code, language: 'zig' });
    expect(body).toContainEqual({ type: 'paragraph', text: { type: 'bold', text: 'Example' } });
    const table = body.find(block => block.type === 'table');
    if (!table) throw new Error('Missing native table');
    expect(table).toMatchObject({ is_bordered: true, is_compact: true });
    expect(table.cells.map(row => row.map(cell => plainText(cell.text ?? '')))).toEqual([['Name', 'Value'], ['one', '42']]);
    expect(table.cells[0]?.every(cell => cell.is_header && cell.align === 'left' && cell.valign === 'top')).toBe(true);
    expect(nodes(body, 'italic').length).toBeGreaterThan(0);
    expect(nodes(body, 'url').map(node => node.url)).toEqual(['https://link.example.com/#part']);
    expect(nodes(body, 'code').map(node => plainText(node.text as RichText))).toContain('https://code.example.com/');
    expect(body).toContainEqual({ type: 'list', items: [
      { type: '1', value: 3, blocks: [{ type: 'paragraph', text: 'first' }] },
      { type: '1', value: 4, blocks: [{ type: 'paragraph', text: 'second' }] },
    ] });
    expect(body).toContainEqual({ type: 'blockquote', blocks: [{ type: 'paragraph', text: 'quoted' }] });
    expect(body).toContainEqual({ type: 'divider' });
    expect(nodes(body, 'button')).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ skip_entity_detection: true });
  });

  it('keeps repeated zero-offset image occurrences in their own empty table cells', async () => {
    const f = fixture(); const images = ['https://example.com/one.jpg', 'https://example.com/two.gif'];
    const entry: FeedEntry = { ...payload.entry, content: '', contentLinks: [], images, animationIndices: [1],
      imagePositions: [{ offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 1 }, { offset: 0, imageIndex: 0 }],
      contentFormat: { version: 1, blocks: [{ type: 'table', offset: 0, length: 0, cells: [[
        { offset: 0, length: 0, images: [0, 1] }, { offset: 0, length: 0, images: [2] },
      ]] }] },
    };
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const table = messageBlocks(f).find(block => block.type === 'table');
    if (!table) throw new Error('Missing native table');
    expect(table.cells[0]?.map(cell => plainText(cell.text ?? ''))).toEqual(['[Image 1] [Animation 2]', '[Image 1]']);
    expect(nodes(table, 'url').map(node => node.url)).toEqual([images[0], images[1], images[0]]);
    expect(JSON.stringify(messageBlocks(f))).not.toContain('Additional images:');
  });

  it('keeps a styled image marker outside the enclosing article link', async () => {
    const f = fixture(); const image = 'https://example.com/photo.jpg'; const article = 'https://example.com/article';
    const entry: FeedEntry = { ...payload.entry, content: 'AB', contentLinks: [{ offset: 0, length: 2, url: article }],
      images: [image], imagePositions: [{ offset: 1, imageIndex: 0 }],
      contentFormat: { version: 1, blocks: [{ type: 'paragraph', offset: 0, length: 2, images: [0], spans: [{ type: 'bold', offset: 0, length: 2 }] }] },
    };
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const body = messageBlocks(f)[2]!;
    expect(blockText([body])).toBe('A [Image 1] B');
    expect(nodes(body, 'url').map(node => node.url)).toEqual([article, image, article]);
    expect(nodes(body, 'url').filter(node => node.url === article).every(node => !plainText(node.text as RichText).includes('[Image'))).toBe(true);
  });

  it('keeps code URLs literal in the preview and moves actual code images outside pre', async () => {
    const f = fixture(); const url = 'https://example.com/literal'; const image = 'https://example.com/image.jpg';
    const content = url + '\n' + 'code '.repeat(55);
    const entry: FeedEntry = { ...payload.entry, content, contentLinks: [{ offset: 0, length: url.length, url }], images: [image],
      imagePositions: [{ offset: url.length, imageIndex: 0 }],
      contentFormat: { version: 1, blocks: [{ type: 'pre', offset: 0, length: content.length, language: 'text', images: [0] }] },
    };
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const top = messageBlocks(f); const details = top.find(block => block.type === 'details');
    expect(details?.blocks).toEqual([
      { type: 'pre', text: content, language: 'text' },
      { type: 'paragraph', text: [{ type: 'url', text: '[Image 1]', url: image }] },
    ]);
    expect(nodes(top[2], 'url')).toEqual([]);
    expect(nodes(details, 'url').map(node => node.url)).toEqual([image]);
  });

  it('renders the truncated ellipsis as ordinary text outside the code block', async () => {
    const f = fixture(); const content = 'line = "' + 'x'.repeat(8200) + '"\n'; const limit = 7997;
    const format: FeedContentFormat = { version: 1, blocks: [{ type: 'pre', offset: 0, length: content.length, language: 'text' }] };
    const entry: FeedEntry = { ...payload.entry, content: content.slice(0, limit) + '...', contentLinks: [],
      contentFormat: clipFeedContentFormat(format, content, [], limit),
    };
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const details = messageBlocks(f).find(block => block.type === 'details');
    expect(details?.blocks).toEqual([
      { type: 'pre', text: content.slice(0, limit), language: 'text' },
      { type: 'paragraph', text: '...' },
    ]);
  });

  it('keeps formatted content and global image numbering on the first media page only', async () => {
    const images = Array.from({ length: 51 }, (_, index) => `https://example.com/${index}.${index === 50 ? 'gif' : 'jpg'}`);
    const entry: FeedEntry = { ...payload.entry, content: 'AB', contentLinks: [], images, animationIndices: [50],
      imagePositions: [{ offset: 1, imageIndex: 50 }],
      contentFormat: { version: 1, blocks: [{ type: 'pre', offset: 0, length: 2, images: [0] }] },
    };
    const first = fixture(); const second = fixture();
    await first.send(target, 'Feed', { kind: 'entry', entry, part: { index: 1, total: 2 } }, 'en', true, new AbortController().signal);
    expect(nodes(messageBlocks(first), 'pre')).toEqual([{ type: 'pre', text: 'AB' }]);
    expect(nodes(messageBlocks(first), 'url')).toContainEqual({ type: 'url', text: '[Animation 51]', url: images[50] });
    await second.send(target, 'Feed', { kind: 'entry', entry, part: { index: 2, total: 2 } }, 'en', true, new AbortController().signal);
    expect(nodes(messageBlocks(second), 'pre')).toEqual([]);
    expect(nodes(messageBlocks(second), 'url').some(node => node.text === '[Animation 51]')).toBe(false);
    expect(messageBlocks(second)[0]).toMatchObject({ type: 'animation', animation: { media: images[50] } });
  });

  it('retains native code and tables when rejected media falls back to original links', async () => {
    const f = fixture(); f.fail(400);
    const entry = parseFeed('<rss><channel><item><description><![CDATA[<pre>literal</pre><table><tr><th>A</th></tr><tr><td>B</td></tr></table><img src="https://example.com/photo.jpg">]]></description></item></channel></rss>', 'https://example.com/feed').entries[0]!;
    expect(entry.contentFormat).toBeDefined();
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    expect(nodes(messageBlocks(f, 1), 'pre')).toEqual(nodes(messageBlocks(f), 'pre'));
    expect(nodes(messageBlocks(f, 1), 'table')).toEqual(nodes(messageBlocks(f), 'table'));
    expect(nodes(messageBlocks(f, 1), 'photo')).toEqual([]);
  });

  it.each([
    { version: 2, blocks: [] },
    { version: 1, blocks: [{ type: 'buttons', buttons: [] }] },
    { version: 1, blocks: [{ type: 'pre', offset: 0, length: 1, language: '../unsafe' }] },
    { version: 1, blocks: [{ type: 'paragraph', offset: 1, length: 1 }] },
  ])('rejects invalid or unsupported persisted format before delivery: %j', async format => {
    const f = fixture();
    const entry: FeedEntry = { ...payload.entry, content: '\u{1f680}', contentFormat: format as FeedContentFormat };
    await expect(f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: 'REJECTED' });
    expect(f.calls).toHaveLength(0);
  });

  it.each([['zh-CN', '阅读全文'], ['zh-TW', '閱讀全文'], ['en', 'Read full text'], ['ja', '全文を読む']] as const)('publishes silently with collapsed content in %s and no automatic entities', async (language, readLabel) => {
    const f = fixture();
    await f.send(target, 'Source @admin', payload, language, true, new AbortController().signal);
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ method: 'sendRichMessage', body: {
      chat_id: -100, message_thread_id: 9, disable_notification: true,
      rich_message: { skip_entity_detection: true, blocks: expect.arrayContaining([
        { type: 'paragraph', text: { type: 'bold', text: payload.entry.title } },
        { type: 'details', summary: { type: 'marked', text: { type: 'bold', text: readLabel } }, blocks: [{ type: 'paragraph', text: payload.entry.content }] },
        { type: 'blockquote', blocks: [{ type: 'paragraph', text: [
          new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(payload.entry.publishedAt!)), '\n',
          expect.stringContaining('Source @admin'), ' ',
          { type: 'button', button: { text: expect.any(String), url: payload.entry.url, style: 'primary' } },
        ] }] },
      ]) },
    } });
    expect(f.calls[0]!.body).not.toHaveProperty('reply_markup');
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"date_time"');
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"pullquote"');
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"footer"');
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('telegra.ph');
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"heading"');
  });
  it('keeps HTML links, bare domains and following Chinese text as separate native nodes', async () => {
    const f = fixture();
    const entry = parseFeed('<rss><channel><item><title>Keep this title</title><link>https://news.example.com/article</link><description><![CDATA[前example.com后 <a href="https://example.com/download#section">下载</a>之后普通文字]]></description></item></channel></rss>', 'https://news.example.com/feed').entries[0]!;
    await f.send(target, '<b>@all /help example.org</b>', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toEqual({ skip_entity_detection: true, blocks: [
      { type: 'paragraph', text: { type: 'bold', text: 'Keep this title' } },
      { type: 'paragraph', text: ['前', { type: 'url', text: 'example.com', url: 'https://example.com/' }, '后 ',
        { type: 'url', text: '下载', url: 'https://example.com/download#section' }, '之后普通文字'] },
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: ['Source: <b>@all /help example.org</b>', ' ',
        { type: 'button', button: { text: 'Open original', url: entry.url, style: 'primary' } }] }] },
    ] });
  });
  it.each([
    ['Asia/Taipei', '2026-11-09T18:15:00.000Z'],
    ['America/New_York', '2026-01-09T02:15:00.000Z'],
    ['America/New_York', '2026-07-09T02:15:00.000Z'],
    ['Europe/London', '2026-07-09T23:15:00.000Z'],
  ])('formats the plain attribution time using the bot timezone %s at %s', async (timeZone, publishedAt) => {
    vi.stubEnv('TZ', timeZone);
    const f = fixture();
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, publishedAt } }, 'en', true, new AbortController().signal);
    const localTime = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone }).format(new Date(publishedAt));
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([
      { type: 'blockquote', blocks: [{ type: 'paragraph', text: [localTime, '\n', 'Source: Feed', ' ', { type: 'button', button: { text: 'Open original', url: payload.entry.url, style: 'primary' } }] }] },
    ]) });
    expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"date_time"');
    expect(localTime).not.toBe(new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(publishedAt)));
  });
  it('clips preview link labels without changing their destinations or linking the ellipsis', async () => {
    const f = fixture();
    const prefix = 'x '.repeat(55); const url = 'https://example.com/a-long-article#section';
    const following = '后面的文字'.repeat(25);
    const entry = { ...payload.entry, content: prefix + url + following };
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([
      { type: 'paragraph', text: [[prefix, { type: 'url', text: 'https:/', url }], '...'] },
      { type: 'details', summary: expect.any(Object), blocks: [{ type: 'paragraph', text: [prefix, { type: 'url', text: url, url }, following] }] },
    ]) });
  });
  it.each([119, 120, 121, 200, 240, 241])('allows twice the 120-character preview before folding %s characters', async length => {
    const f = fixture();
    const content = '文'.repeat(length);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, content } }, 'en', true, new AbortController().signal);
    const { blocks } = f.calls[0]!.body.rich_message as { blocks: { type: string; text?: unknown }[] };
    if (length <= 240) {
      expect(blocks[1]).toEqual({ type: 'paragraph', text: content });
      expect(blocks.some(block => block.type === 'details')).toBe(false);
    } else {
      expect(blocks[1]).toEqual({ type: 'paragraph', text: ['文'.repeat(117), '...'] });
      expect(blocks.find(block => block.type === 'details')).toMatchObject({ blocks: [{ type: 'paragraph', text: content }] });
    }
  });
  it('does not split a surrogate pair at the shorter preview boundary', async () => {
    const f = fixture();
    const content = 'x'.repeat(116) + '😀' + 'y'.repeat(160);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, content } }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([
      { type: 'paragraph', text: ['x'.repeat(116), '...'] },
      { type: 'details', summary: expect.any(Object), blocks: [{ type: 'paragraph', text: content }] },
    ]) });
  });
  it.each([['', ''], [' ', ' '], ['   ', ' ']])('preserves the feed spacing %j at a link boundary', async (sourceSpace, renderedSpace) => {
    const f = fixture();
    const entry = parseFeed(`<rss><channel><item><description><![CDATA[example.com${sourceSpace}后面的文字]]></description></item></channel></rss>`, 'https://news.example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([
      { type: 'paragraph', text: [{ type: 'url', text: 'example.com', url: 'https://example.com/' }, renderedSpace + '后面的文字'] },
    ]) });
  });
  it('never re-linkifies an explicitly rejected HTML anchor', async () => {
    const f = fixture();
    const entry = parseFeed('<rss><channel><item><description><![CDATA[<a href="javascript:alert(1)">example.com</a>]]></description></item></channel></rss>', 'https://news.example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([{ type: 'paragraph', text: 'example.com' }]) });
    expect(JSON.stringify(f.calls)).not.toContain('"type":"url"');
  });
  it('revalidates persisted destinations and keeps unsafe links literal', async () => {
    const f = fixture();
    await f.send(target, 'Feed', { kind: 'entry', entry: { ...payload.entry, content: 'example.com after', contentLinks: [{ offset: 0, length: 11, url: 'http://127.0.0.1/' }] } }, 'en', true, new AbortController().signal);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([{ type: 'paragraph', text: 'example.com after' }]) });
    expect(JSON.stringify(f.calls)).not.toContain('127.0.0.1');
  });
  it('uses normal notification only when explicitly configured, without muting the chat', async () => {
    const f = fixture();
    await f.send(target, 'Feed', payload, 'en', false, new AbortController().signal);
    expect(f.calls[0]!.body.disable_notification).toBe(false);
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessage']);
  });
  it('falls back to original image links only after a definite rejection and preserves silence', async () => {
    const f = fixture(); f.fail(400);
    await f.send(target, 'Feed', { kind: 'entry', entry: { ...payload.entry, image: 'https://news.example.com/image.jpg' } }, 'en', true, new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.body.rich_message).toMatchObject({ blocks: [
      { type: 'photo', photo: { type: 'photo', media: 'https://news.example.com/image.jpg' } },
      { type: 'paragraph', text: { type: 'bold', text: payload.entry.title } },
      expect.any(Object), expect.any(Object), expect.any(Object),
    ] });
    const fallback = f.calls[1]!.body.rich_message as { blocks: unknown[] };
    expect(fallback.blocks[0]).toEqual({ type: 'paragraph', text: { type: 'bold', text: payload.entry.title } });
    expect(fallback.blocks).toContainEqual({ type: 'paragraph', text: [{ type: 'url', text: 'Image 1', url: 'https://news.example.com/image.jpg' }] });
    expect(fallback.blocks).toContainEqual({ type: 'blockquote', blocks: [{ type: 'paragraph', text: expect.arrayContaining([
      'Source: Feed', { type: 'button', button: { text: 'Open original', url: payload.entry.url, style: 'primary' } },
    ]) }] });
    expect(JSON.stringify(f.calls[0]!.body)).toContain('"type":"photo"');
    expect(JSON.stringify(f.calls[1]!.body)).not.toContain('"type":"photo"');
    expect(f.calls.every(call => call.body.disable_notification === true)).toBe(true);
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each(['Bad Request: failed to get HTTP URL content', 'Bad Request: PHOTO_INVALID_DIMENSIONS', 'Bad Request: file is too big'])('repairs a static image after %s and uploads it without changing original links', async description => {
    const f = fixture(); f.fail(400, 1, description);
    const url = 'https://images.example.com/original.jpg?signature=keep';
    f.prepare.mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 6_604_333 });
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, content: 'AB', images: [url], imagePositions: [{ offset: 1, imageIndex: 0 }] } }, 'en', true, new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    expect(f.prepare).toHaveBeenCalledWith(url, expect.any(AbortSignal), RSS_PHOTO_MAX_SOURCE_BYTES);
    const uploaded = (f.rawCalls[1]!.body.rich_message as Parameters<Bot['api']['sendRichMessage']>[1]).blocks!;
    expect(uploaded[0]).toMatchObject({ type: 'photo', photo: { media: expect.any(InputFile) } });
    expect(JSON.stringify(messageBlocks(f, 1))).toContain(url);
    expect(JSON.stringify(messageBlocks(f, 1))).toContain('[Image 1]');
    expect(JSON.stringify(messageBlocks(f, 1))).not.toContain('Images could not be embedded');
    expect(f.calls.every(call => call.body.disable_notification === true)).toBe(true);
  });
  it('repairs only static media in a mixed slideshow, leaving animations intact', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    const images = ['https://example.com/photo.jpg', 'https://example.com/motion.gif'];
    f.prepare.mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 1024 });
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images, animationIndices: [1] } }, 'en', true, new AbortController().signal);
    expect(f.prepare.mock.calls.map(call => call[0])).toEqual([images[0]]);
    const uploaded = (f.rawCalls[1]!.body.rich_message as Parameters<Bot['api']['sendRichMessage']>[1]).blocks!;
    expect(uploaded[0]).toMatchObject({ type: 'slideshow', blocks: [
      { type: 'photo', photo: { media: expect.any(InputFile) } },
      { type: 'animation', animation: { type: 'animation', media: images[1] } },
    ] });
  });
  it('keeps original links when preparation fails or the prepared upload is definitely rejected', async () => {
    for (const repaired of [false, true]) {
      const f = fixture(); f.fail(400, repaired ? 2 : 1, 'Bad Request: PHOTO_INVALID_DIMENSIONS');
      const image = 'https://example.com/too-large.jpg';
      if (repaired) f.prepare.mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 1024 });
      await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, image } }, 'en', true, new AbortController().signal);
      expect(f.calls).toHaveLength(repaired ? 3 : 2);
      expect(messageBlocks(f, f.calls.length - 1)).toContainEqual({ type: 'paragraph', text: [{ type: 'url', text: 'Image 1', url: image }] });
      expect(JSON.stringify(messageBlocks(f, f.calls.length - 1))).not.toContain('"type":"photo"');
    }
  });
  it.each([['network', 'UNKNOWN'], [429, 'RATE_LIMITED'], [403, 'BLOCKED']] as const)('does not resend after an uploaded-photo %s outcome', async (code, expected) => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockImplementation(async () => { f.fail(code); return { data: Buffer.from('prepared-jpeg'), sourceBytes: 1024 }; });
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, image: 'https://example.com/photo.jpg' } }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: expected });
    expect(f.calls).toHaveLength(2);
  });
  it('makes no further Telegram request after cancellation during photo preparation', async () => {
    const f = fixture(); const controller = new AbortController();
    f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockImplementation(async () => { controller.abort(); throw new Error('aborted'); });
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, image: 'https://example.com/photo.jpg' } }, 'en', true, controller.signal)).rejects.toMatchObject({ code: 'UNKNOWN' });
    expect(f.calls).toHaveLength(1);
  });
  it('keeps byte reservations for failed preparations instead of retrying an unbounded set', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    const images = Array.from({ length: 3 }, (_, index) => `https://example.com/${index}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal);
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls.map(call => call[2])).toEqual([RSS_PHOTO_MAX_SOURCE_BYTES, RSS_PHOTO_MAX_SOURCE_BYTES]);
    expect(f.calls).toHaveLength(2);
    for (const image of images) expect(JSON.stringify(messageBlocks(f, 1))).toContain(image);
  });
  it('refunds unused preparation allowance for small successful photos', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 1024 });
    const images = Array.from({ length: 4 }, (_, index) => `https://example.com/${index}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal);
    expect(f.prepare).toHaveBeenCalledTimes(4);
    expect(f.calls).toHaveLength(2);
  });
  it('conservatively shrinks allowance after a failed download and successful preparations', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockRejectedValueOnce(new Error('partial download failed'))
      .mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 5 * 1024 * 1024 });
    const images = Array.from({ length: 6 }, (_, index) => `https://example.com/${index}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal);
    expect(f.prepare.mock.calls.map(call => call[2])).toEqual([20, 20, 15, 10, 5].map(size => size * 1024 * 1024));
    expect(f.calls).toHaveLength(2);
  });
  it('limits attached preview bytes without discarding unprepared original media', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockResolvedValue({ data: Buffer.alloc(10 * 1024 * 1024), sourceBytes: 1024 });
    const images = ['https://example.com/one.jpg', 'https://example.com/two.jpg', 'https://example.com/three.jpg'];
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal);
    const uploaded = (f.rawCalls[1]!.body.rich_message as Parameters<Bot['api']['sendRichMessage']>[1]).blocks!;
    expect(uploaded[0]).toMatchObject({ type: 'slideshow', blocks: [
      { type: 'photo', photo: { media: expect.any(InputFile) } },
      { type: 'photo', photo: { media: expect.any(InputFile) } },
      { type: 'photo', photo: { media: images[2] } },
    ] });
    expect(f.calls).toHaveLength(2);
  });
  it('repairs only the selected later page while keeping global media numbering', async () => {
    const f = fixture(); f.fail(400, 1, 'Bad Request: failed to get HTTP URL content');
    f.prepare.mockResolvedValue({ data: Buffer.from('prepared-jpeg'), sourceBytes: 1024 });
    const images = Array.from({ length: 51 }, (_, index) => `https://example.com/${index + 1}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images }, part: { index: 2, total: 2 } }, 'en', true, new AbortController().signal);
    expect(f.prepare.mock.calls.map(call => call[0])).toEqual([images[50]]);
    expect(messageBlocks(f, 1)).toContainEqual({ type: 'paragraph', text: 'Images, part 2/2' });
    expect(JSON.stringify(messageBlocks(f, 1))).not.toContain('content content');
    expect(f.calls).toHaveLength(2);
  });
  it.each([400, 403, 429] as const)('does not prepare animation-only media after %s', async code => {
    const f = fixture(); f.fail(code, 1, 'Bad Request: failed to get HTTP URL content');
    const task = f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, image: 'https://example.com/motion.gif' } }, 'en', true, new AbortController().signal);
    if (code === 400) await task; else await expect(task).rejects.toMatchObject({ code: code === 403 ? 'BLOCKED' : 'RATE_LIMITED' });
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it.each([undefined, 'javascript:alert(1)', 'http://127.0.0.1/'])('does not embed an original button for %s', url => {
    const f = fixture();
    return f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, url } }, 'en', true, new AbortController().signal).then(() => {
      expect(JSON.stringify(f.calls[0]!.body)).not.toContain('"type":"button"');
      expect(f.calls[0]!.body).not.toHaveProperty('reply_markup');
    });
  });
  it('publishes all safe image candidates as a slideshow without HTML display dimensions', async () => {
    const f = fixture();
    const entry = parseFeed('<rss><channel><item><description><![CDATA[<img src="http://127.0.0.1/private.jpg"/><img src="https://example.com/first.jpg" width="80" height="40"/><img src="https://example.com/second.jpg"/>正文]]></description></item></channel></rss>', 'https://example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const { blocks } = f.calls[0]!.body.rich_message as { blocks: { type: string }[] };
    expect(blocks[0]).toEqual({ type: 'slideshow', blocks: [
      { type: 'photo', photo: { type: 'photo', media: 'https://example.com/first.jpg' } },
      { type: 'photo', photo: { type: 'photo', media: 'https://example.com/second.jpg' } },
    ] });
    expect(entry.content).toBe('正文');
    expect(JSON.stringify(f.calls)).not.toContain('127.0.0.1');
  });
  it.each([1, 2, 10, 50])('includes all %s photos in one message with the title below the media', async count => {
    const f = fixture();
    const images = Array.from({ length: count }, (_, index) => `https://example.com/image-${index}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal);
    expect(f.calls).toHaveLength(1);
    const { blocks } = f.calls[0]!.body.rich_message as { blocks: unknown[] };
    const photos = images.map(image => ({ type: 'photo', photo: { type: 'photo', media: image } }));
    expect(blocks[0]).toEqual(count === 1 ? photos[0] : { type: 'slideshow', blocks: photos });
    expect(blocks[1]).toEqual({ type: 'paragraph', text: { type: 'bold', text: payload.entry.title } });
  });
  it('refuses an unsplit batch over the shared 50-media limit instead of truncating', async () => {
    const f = fixture();
    expect(RSS_IMAGES_PER_MESSAGE).toBe(50);
    const images = Array.from({ length: 51 }, (_, index) => `https://example.com/image-${index}.jpg`);
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images } }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: 'REJECTED' });
    expect(f.calls).toEqual([]);
  });
  it('omits repeated body text on later image pages but keeps the title, source and part number', async () => {
    const f = fixture();
    const images = Array.from({ length: 52 }, (_, index) => `https://example.com/image-${index + 1}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images }, part: { index: 2, total: 2 } }, 'en', true, new AbortController().signal);
    const { blocks } = f.calls[0]!.body.rich_message as { blocks: { type: string }[] };
    expect(blocks[1]).toEqual({ type: 'paragraph', text: { type: 'bold', text: payload.entry.title } });
    expect(blocks[2]).toEqual({ type: 'paragraph', text: 'Images, part 2/2' });
    expect(blocks.at(-1)).toMatchObject({ type: 'blockquote' });
    expect(blocks.some(block => block.type === 'details')).toBe(false);
    expect(JSON.stringify(blocks)).not.toContain('content content');
  });
  it('retains every original image URL and global numbering when a later gallery is rejected', async () => {
    const f = fixture(); f.fail(400);
    const images = Array.from({ length: 52 }, (_, index) => `https://example.com/image-${index + 1}.jpg`);
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images }, part: { index: 2, total: 2 } }, 'en', true, new AbortController().signal);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1]!.body.rich_message).toMatchObject({ blocks: expect.arrayContaining([
      { type: 'paragraph', text: 'Images could not be embedded. Open the original images below:' },
      { type: 'paragraph', text: [{ type: 'url', text: 'Image 51', url: images[50] }, ' | ', { type: 'url', text: 'Image 52', url: images[51] }] },
    ]) });
    expect(JSON.stringify(f.calls[1]!.body)).not.toContain('"type":"slideshow"');
    expect(JSON.stringify(f.calls[1]!.body)).not.toContain('"type":"photo"');
  });
  it.each([['network', 'UNKNOWN'], [429, 'RATE_LIMITED'], [403, 'BLOCKED']] as const)('never retries a gallery after %s', async (code, expected) => {
    const f = fixture(); f.fail(code);
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images: ['https://example.com/1.jpg', 'https://example.com/2.jpg'] } }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: expected });
    expect(f.calls).toHaveLength(1);
  });
  it('rejects an unsafe persisted image URL before attempting delivery', async () => {
    const f = fixture();
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images: ['https://example.com/1.jpg', 'http://127.0.0.1/private.jpg'] } }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: 'REJECTED' });
    expect(f.calls).toEqual([]);
  });
  it('renders GIFs and MIME-identified animations natively alongside ordinary images', async () => {
    const f = fixture();
    const images = ['https://example.com/photo.jpg', 'https://example.com/motion.GIF?sig=1', 'https://example.com/animation'];
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images, animationIndices: [1, 2] } }, 'en', true, new AbortController().signal);
    expect(messageBlocks(f)[0]).toEqual({ type: 'slideshow', blocks: [
      { type: 'photo', photo: { type: 'photo', media: images[0] } },
      { type: 'animation', animation: { type: 'animation', media: images[1] } },
      { type: 'animation', animation: { type: 'animation', media: images[2] } },
    ] });
  });
  it('supports legacy queued GIF URLs without inventing image positions', async () => {
    const f = fixture();
    const image = 'https://example.com/motion.gif?signature=original';
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, image } }, 'en', true, new AbortController().signal);
    expect(messageBlocks(f)[0]).toEqual({ type: 'animation', animation: { type: 'animation', media: image } });
    expect(JSON.stringify(messageBlocks(f))).not.toContain('[Animation');
    expect(JSON.stringify(messageBlocks(f))).not.toContain('Additional images:');
  });
  it.each([
    ['zh-CN', '[图2]', '[动图3]', '附图：'],
    ['zh-TW', '[圖2]', '[動圖3]', '附圖：'],
    ['en', '[Image 2]', '[Animation 3]', 'Additional images:'],
    ['ja', '[画像2]', '[アニメーション3]', '追加画像：'],
  ] as const)('inserts %s body image markers in original order and separates metadata-only images', async (language, photoLabel, animationLabel, attachedLabel) => {
    const f = fixture();
    const entry = parseFeed('<rss xmlns:media="urn:media"><channel><item><title>Article</title><media:thumbnail url="https://example.com/cover.jpg"/><description><![CDATA[A<img src="https://example.com/photo.jpg"/>B<img src="https://example.com/motion.gif"/>C]]></description></item></channel></rss>', 'https://example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, language, true, new AbortController().signal);
    const body = messageBlocks(f)[2];
    expect(body?.type).toBe('paragraph');
    if (body?.type !== 'paragraph') throw new Error('Missing body');
    expect(plainText(body.text)).toBe(`A ${photoLabel} B ${animationLabel} C`);
    expect(body.text).toEqual(expect.arrayContaining([
      { type: 'url', text: photoLabel, url: 'https://example.com/photo.jpg' },
      { type: 'url', text: animationLabel, url: 'https://example.com/motion.gif' },
    ]));
    const attached = messageBlocks(f)[3];
    expect(attached?.type).toBe('paragraph');
    if (attached?.type !== 'paragraph') throw new Error('Missing attachments');
    expect(plainText(attached.text)).toContain(attachedLabel);
    expect(JSON.stringify(attached.text)).toContain('https://example.com/cover.jpg');
    expect(JSON.stringify(body.text)).not.toContain('https://example.com/cover.jpg');
  });
  it('preserves every repeated occurrence without duplicating the image attachment', async () => {
    const f = fixture();
    const entry = parseFeed('<rss><channel><item><description><![CDATA[A<img src="https://example.com/one.jpg"/>B<img src="https://example.com/one.jpg"/>C]]></description></item></channel></rss>', 'https://example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(messageBlocks(f)[0]?.type).toBe('photo');
    const body = messageBlocks(f)[2];
    if (body?.type !== 'paragraph') throw new Error('Missing body');
    expect(plainText(body.text)).toBe('A [Image 1] B [Image 1] C');
  });
  it('does not redirect an image marker to an enclosing article hyperlink', async () => {
    const f = fixture();
    const entry = parseFeed('<rss><channel><item><description><![CDATA[<a href="https://example.com/article">before<img src="https://example.com/photo.jpg"/>after</a>]]></description></item></channel></rss>', 'https://example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    expect(messageBlocks(f)[2]).toEqual({ type: 'paragraph', text: [
      { type: 'url', text: 'before', url: 'https://example.com/article' }, ' ',
      { type: 'url', text: '[Image 1]', url: 'https://example.com/photo.jpg' }, ' ',
      { type: 'url', text: 'after', url: 'https://example.com/article' },
    ] });
  });
  it('keeps image annotations in the full text rather than expanding the short preview', async () => {
    const f = fixture();
    const entry = parseFeed(`<rss><channel><item><description><![CDATA[${'x'.repeat(20)}<img src="https://example.com/photo.jpg"/>${'y'.repeat(300)}]]></description></item></channel></rss>`, 'https://example.com/feed').entries[0]!;
    await f.send(target, 'Feed', { kind: 'entry', entry }, 'en', true, new AbortController().signal);
    const blocks = messageBlocks(f); const preview = blocks[2];
    if (preview?.type !== 'paragraph') throw new Error('Missing preview');
    expect(plainText(preview.text)).toHaveLength(120);
    expect(plainText(preview.text)).not.toContain('[Image');
    const details = blocks.find(block => block.type === 'details');
    if (!details || details.blocks[0]?.type !== 'paragraph') throw new Error('Missing full body');
    expect(plainText(details.blocks[0].text)).toBe('x'.repeat(20) + ' [Image 1] ' + 'y'.repeat(300));
  });
  it('keeps global media indexes when full text references an animation beyond the first 50 attachments', async () => {
    const images = Array.from({ length: 51 }, (_, index) => `https://example.com/${index + 1}.${index === 50 ? 'gif' : 'jpg'}`);
    const entry = { ...payload.entry, content: 'AB', images, animationIndices: [50], imagePositions: [{ offset: 1, imageIndex: 50 }] };
    const first = fixture(); const second = fixture();
    await first.send(target, 'Feed', { kind: 'entry', entry, part: { index: 1, total: 2 } }, 'en', true, new AbortController().signal);
    expect(messageBlocks(first)[0]).toMatchObject({ type: 'slideshow', blocks: expect.arrayContaining([
      { type: 'photo', photo: { type: 'photo', media: images[49] } },
    ]) });
    expect(JSON.stringify(messageBlocks(first))).toContain('"text":"[Animation 51]"');
    expect(JSON.stringify(messageBlocks(first))).toContain(images[50]);
    expect(JSON.stringify(messageBlocks(first))).not.toContain('"type":"animation"');
    await second.send(target, 'Feed', { kind: 'entry', entry, part: { index: 2, total: 2 } }, 'en', true, new AbortController().signal);
    expect(messageBlocks(second)[0]).toEqual({ type: 'animation', animation: { type: 'animation', media: images[50] } });
    expect(JSON.stringify(messageBlocks(second))).not.toContain('[Animation 51]');
    expect(JSON.stringify(messageBlocks(second))).not.toContain('"text":"AB"');
  });
  it.each([false, true])('bounds maximum-size text with repeated markers and additional images (formatted=%s)', async formatted => {
    const f = fixture();
    const images = Array.from({ length: 1000 }, (_, index) => `https://example.com/${index}.jpg`);
    const entry: FeedEntry = { ...payload.entry, content: '文'.repeat(8000), images, animationIndices: [999],
      imagePositions: Array.from({ length: 1000 }, () => ({ offset: 4000, imageIndex: 999 })),
      ...(formatted ? { contentFormat: { version: 1 as const, blocks: [{ type: 'pre' as const, offset: 0, length: 8000,
        images: Array.from({ length: 1000 }, (_, index) => index) }] } } : {}),
    };
    await f.send(target, 'Feed', { kind: 'entry', entry, part: { index: 1, total: 20 } }, 'en', true, new AbortController().signal);
    const details = messageBlocks(f).find(block => block.type === 'details');
    if (!details) throw new Error('Missing full body');
    const text = blockText(details.blocks);
    expect(text.length).toBeLessThan(32768 - 1000);
    expect(text.match(/\[Animation 1000\]/g)).toHaveLength(1000);
  });
  it('uses original animation links on definite rejection, without degrading into a static photo', async () => {
    const f = fixture(); f.fail(400);
    const images = ['https://example.com/motion.gif'];
    await f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images, animationIndices: [0] } }, 'en', true, new AbortController().signal);
    expect(messageBlocks(f)[0]?.type).toBe('animation');
    expect(messageBlocks(f, 1)).toContainEqual({ type: 'paragraph', text: [{ type: 'url', text: 'Animation 1', url: images[0] }] });
    expect(JSON.stringify(messageBlocks(f, 1))).not.toContain('"type":"photo"');
    expect(JSON.stringify(messageBlocks(f, 1))).not.toContain('"type":"animation"');
  });
  it.each([{ index: 0, total: 2 }, { index: 3, total: 2 }, { index: 1, total: 3 }])('rejects inconsistent page metadata %j before delivery', async part => {
    const f = fixture(); const images = Array.from({ length: 51 }, (_, index) => `https://example.com/${index}.jpg`);
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, images }, part }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: 'REJECTED' });
    expect(f.calls).toEqual([]);
  });
  it('rejects a marker inside a UTF-16 surrogate pair', async () => {
    const f = fixture();
    await expect(f.send(target, 'Feed', { ...payload, entry: { ...payload.entry, content: '😀 text', images: ['https://example.com/one.jpg'], imagePositions: [{ offset: 1, imageIndex: 0 }] } }, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: 'REJECTED' });
    expect(f.calls).toEqual([]);
  });
  it.each([['network', 'UNKNOWN'], [429, 'RATE_LIMITED'], [403, 'BLOCKED'], [400, 'REJECTED']] as const)('classifies %s without blind retry', async (code, expected) => {
    const f = fixture(); f.fail(code);
    await expect(f.send(target, 'Feed', payload, 'en', true, new AbortController().signal)).rejects.toMatchObject({ code: expected });
    expect(f.calls).toHaveLength(1);
    expect(f.health.recordApiError).toHaveBeenCalledOnce();
  });
  it('sends failure and recovery notifications through the same per-subscription silent option', async () => {
    const f = fixture();
    await f.send(target, 'Feed', { kind: 'health', recovered: false, error: 'BLOCKED' }, 'en', true, new AbortController().signal);
    await f.send(target, 'Feed', { kind: 'health', recovered: true, error: null }, 'en', true, new AbortController().signal);
    expect(f.calls.every(call => call.body.disable_notification === true)).toBe(true);
    expect(JSON.stringify(f.calls)).toContain('recovered');
  });
});
