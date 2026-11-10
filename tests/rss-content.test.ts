import { describe, expect, it } from 'vitest';
import { FeedContentParseError, parseFormattedContent } from '../src/modules/rss-content.js';
import { contentLinkUrl, findFeedLinks, isGifImageUrl, parseFeed } from '../src/modules/rss-feed.js';
import { clipFeedContentFormat, isValidFeedContentFormat, type FeedContentBlock, type FeedTextRange } from '../src/modules/rss-format.js';

function parse(html: string, limit = 12_000, initialImages: string[] = []) {
  const images = [...initialImages]; const animations = new Set<number>();
  const result = parseFormattedContent(html, {
    limit, resolveLink: source => contentLinkUrl(source, 'https://example.com/article'), findLinks: findFeedLinks,
    isGif: (source, mime) => mime?.split(';')[0]?.toLowerCase() === 'image/gif' || isGifImageUrl(contentLinkUrl(source, 'https://example.com/article') ?? ''),
    image: (source, gif) => {
      const url = contentLinkUrl(source, 'https://example.com/article');
      if (!url) return;
      let index = images.indexOf(url);
      if (index < 0) { index = images.length; images.push(url); }
      if (gif) animations.add(index);
      return index;
    },
  });
  if (result) expect(isValidFeedContentFormat(result.contentFormat, result.content, result.imagePositions)).toBe(true);
  return { result, images, animations: [...animations] };
}
function leaves(blocks: FeedContentBlock[]): FeedTextRange[] {
  return blocks.flatMap((block): FeedTextRange[] => block.type === 'table' ? block.cells.flat() : block.type === 'list' ? leaves(block.items.flat())
    : block.type === 'blockquote' ? leaves(block.blocks) : block.type === 'divider' ? [] : [block]);
}

describe('Safe structured RSS HTML content', () => {
  it.each(['Plain text', '<p>Only</p><p>paragraphs</p>', '<p><a href="/link">link</a><img src="/one.jpg"></p>', '<strong></strong>Plain'])('does not inflate plain projections: %s', html => {
    expect(parse(html).result).toBeUndefined();
  });

  it('preserves a representative Egg article with Zig/text/bash code and three real HTML tables', () => {
    const sources = [
      ['zig', 'const std = @import("std");\n\npub fn main() void {\n\tstd.debug.print("Egg <ok> & safe", .{});\n}\n'],
      ['text', '  first column\tsecond\n\n  trailing spaces  \n'],
      ['text', 'error: literal diagnostic https://example.com\n'],
      ['zig', 'const path = line[4..];\n    print(path);\n'],
      ['text', '  error: borrow is still used\n'],
      ['bash', '  # literal commands, never executed\n\tprintf "%s\\n" "https://example.com"\n'],
    ];
    const html = '<h1>Egg compiler notes</h1><p><strong>Fast</strong> and <em>small</em>.</p>' + sources.map(([language, code], index) =>
      `<h2>Part ${index + 1}</h2><pre><code class="language-${language}">${code!.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</code></pre>` +
      (index % 2 === 0 ? '<table><thead><tr><th>Compiler</th><th align="right">Time</th></tr></thead><tbody><tr><td>Egg</td><td>1ms</td></tr></tbody></table>' : '')).join('') +
      '<ul><li>Build</li><li>Measure</li></ul>';
    const result = parse(html).result!;
    expect(result).toBeDefined();
    const code = result.contentFormat.blocks.filter(block => block.type === 'pre');
    expect(code.map(block => block.language)).toEqual(['zig', 'text', 'text', 'zig', 'text', 'bash']);
    expect(code.map(block => result.content.slice(block.offset, block.offset + block.length))).toEqual(sources.map(([, code]) => code));
    const tables = result.contentFormat.blocks.filter(block => block.type === 'table');
    expect(tables).toHaveLength(3);
    for (const table of tables) {
      expect(result.content.slice(table.offset, table.offset + table.length)).toBe('Compiler\tTime\nEgg\t1ms');
      expect(table.cells[0]![1]).toMatchObject({ header: true, align: 'right' });
    }
    expect(result.contentLinks).toEqual([]);
    const entry = parseFeed(`<rss><channel><item><guid>egg-fixture</guid><description><![CDATA[${html}]]></description></item></channel></rss>`, 'https://example.com/article').entries[0]!;
    expect(entry).toMatchObject({ content: result.content, contentLinks: [], contentFormat: result.contentFormat });
  });

  it('retains nested lists/quotes, ordinary heading text and all six inline styles with absolute UTF-16 ranges', () => {
    const result = parse('<h6>Small heading</h6><blockquote><p>\u{1f600}<b>bold <em>both</em></b> <u>under</u> <s>gone</s> <code>example.com</code> <mark>marked</mark></p>' +
      '<ol start="3"><li>first<ul><li>nested</li></ul></li><li>last</li></ol></blockquote><hr>').result!;
    expect(result.contentFormat.blocks.map(block => block.type)).toEqual(['heading', 'blockquote', 'divider']);
    const quote = result.contentFormat.blocks[1]!;
    if (quote.type !== 'blockquote') throw new Error();
    const paragraph = quote.blocks[0]!;
    if (paragraph.type !== 'paragraph') throw new Error();
    expect(paragraph.spans!.map(span => [span.type, result.content.slice(span.offset, span.offset + span.length)])).toEqual([
      ['bold', 'bold both'], ['italic', 'both'], ['underline', 'under'], ['strikethrough', 'gone'], ['code', 'example.com'], ['marked', 'marked'],
    ]);
    expect(quote.blocks[1]).toMatchObject({ type: 'list', ordered: true, start: 3 });
    expect(result.contentLinks).toEqual([]);
  });

  it('pads ragged table rows and retains empty cells, alignment and independent image occurrences', () => {
    const result = parse('<table><tr><th align="center"><img src="/repeat.jpg"><img src="/repeat.jpg"></th><th></th><th style="text-align: right; color:red">H</th></tr>' +
      '<tr><td><img src="/repeat.jpg"></td><td align="left"></td></tr></table>', 12_000, ['https://example.com/metadata.jpg']).result!;
    const table = result.contentFormat.blocks[0]!;
    if (table.type !== 'table') throw new Error();
    expect(result.content).toBe('\t\tH\n\t\t');
    expect(table.cells.map(row => row.length)).toEqual([3, 3]);
    expect(table.cells[0]![0]).toEqual({ offset: 0, length: 0, header: true, align: 'center', images: [0, 1] });
    expect(table.cells[0]![1]).toEqual({ offset: 1, length: 0, header: true });
    expect(table.cells[1]![0]).toEqual({ offset: 4, length: 0, images: [2] });
    expect(table.cells[1]![2]).toEqual({ offset: 6, length: 0 });
    expect(result.imagePositions).toEqual([{ offset: 0, imageIndex: 1 }, { offset: 0, imageIndex: 1 }, { offset: 4, imageIndex: 1 }]);
    expect(leaves(result.contentFormat.blocks).flatMap(leaf => leaf.images ?? [])).toEqual([0, 1, 2]);
  });

  it('keeps independent zero-offset ownership for adjacent empty leaves and cells', () => {
    const result = parse('<pre><img src="/same.jpg"><img src="/same.jpg"></pre><p><img src="/same.jpg"></p><table><tr><td><img src="/same.jpg"></td><td></td></tr></table>').result!;
    expect(result.imagePositions).toEqual(Array.from({ length: 4 }, () => ({ offset: 0, imageIndex: 0 })));
    expect(leaves(result.contentFormat.blocks).map(leaf => leaf.images ?? [])).toEqual([[0, 1], [2], [3], []]);
  });

  it.each([-1_000_000, -1, 0, 1, 1_000_000])('preserves bounded ordered-list start %i and empty items', start => {
    const result = parse(`<ol start="${start}"><li></li><li>item</li></ol>`).result!;
    expect(result.contentFormat.blocks[0]).toMatchObject({ type: 'list', ordered: true, start, items: [[{ type: 'paragraph', offset: 0, length: 0 }], [{ type: 'paragraph', offset: 0, length: 4 }]] });
  });

  it('owns real pre images once without treating escaped image tags or code URLs as media/links', () => {
    const { result, images } = parse('<pre><code class="language-zig">  &lt;img src="/literal.jpg"&gt;\n<img src="/actual.jpg">\thttps://example.com\n</code></pre>');
    expect(images).toEqual(['https://example.com/actual.jpg']);
    expect(result!.content).toBe('  <img src="/literal.jpg">\n\thttps://example.com\n');
    expect(result!.contentLinks).toEqual([]);
    expect(result!.imagePositions).toEqual([{ offset: '  <img src="/literal.jpg">\n'.length, imageIndex: 0 }]);
    expect(result!.contentFormat.blocks[0]).toMatchObject({ type: 'pre', language: 'zig', images: [0] });
  });

  it('links complete canonical text across style boundaries, never partial hosts or rejected labels', () => {
    const result = parse('<p>https://exa<strong>mple.com</strong>/whole <a href="/target#part">whole <em>styled</em> label</a> ' +
      '<a href="tg://user?id=1"><b>example.com</b></a> <a href="javascript:alert(1)">https://safe.example.com</a> ' +
      '<code>https://code.example.com</code> https://good.<b>com</b>%2Fevil.com/a</p>').result!;
    expect(result.contentLinks.map(link => [result.content.slice(link.offset, link.offset + link.length), link.url])).toEqual([
      ['https://example.com/whole', 'https://example.com/whole'], ['whole styled label', 'https://example.com/target#part'],
    ]);
  });

  it.each(['https://例子<b>example.com</b>/a', 'https://user:<b>password</b>@example.com/a', 'https://example.<b>com</b>:8080/a', 'example.com<b>after</b>',
    '中文.<b>example.com</b>', 'https://example.com<b>\\evil.com</b>/a'])('does not link a malformed styled authority: %s', html => {
    expect(parse(html).result!.contentLinks).toEqual([]);
  });

  it('keeps CJK/IDN link boundaries and caps links across the full canonical text', () => {
    const result = parse('<b>前</b>https://bücher.de/page后文 ' + '<em>example.com</em> '.repeat(90)).result!;
    expect(result.contentLinks).toHaveLength(64);
    expect(result.contentLinks[0]).toEqual({ offset: 1, length: 22, url: 'https://xn--bcher-kva.de/page' });
  });

  it('does not link a clipped authority when the cut is exactly at a style boundary', () => {
    const prefix = 'https://example.com';
    expect(parse(`<b>${prefix}</b>after`, prefix.length).result!.contentLinks).toEqual([]);
    expect(parse(`<b>${prefix}after</b>`, prefix.length).result!.contentLinks).toEqual([]);
    expect(parse(`<b>${prefix}</b> after`, prefix.length).result!.contentLinks).toEqual([{ offset: 0, length: prefix.length, url: prefix + '/' }]);
    expect(parse(`<a href="/explicit"><b>${prefix}</b>after</a>`, prefix.length).result!.contentLinks).toEqual([{ offset: 0, length: prefix.length, url: 'https://example.com/explicit' }]);
  });

  it('suppresses executable subtrees and strips all attributes except bounded safe hints', () => {
    const hidden = ['script', 'style', 'template', 'iframe', 'object', 'noscript'].map(tag => `<${tag}><img src="/hidden.jpg">secret</${tag}>`).join('');
    const result = parse(`<p>${hidden}<b onclick="callback" data-action="confirm" style="color:red">/start @admin</b>` +
      '<a href="tg://user?id=1">mention</a><custom callback_data="evil">literal</custom></p>' +
      '<pre class="language-bash;callback">&lt;button callback_data="evil"&gt;literal&lt;/button&gt;\u0000\u202e\n</pre>').result!;
    expect(result.content).toBe('/start @adminmentionliteral\n\n<button callback_data="evil">literal</button>\n');
    expect(result.contentLinks).toEqual([]);
    expect(result.imagePositions).toEqual([]);
    expect(JSON.stringify(result.contentFormat)).not.toMatch(/callback|onclick|data-action|style|language/);
  });

  it.each(['language-zig', 'ignored lang-text other', 'language-C++', 'language-' + 'a'.repeat(32), 'language-' + 'a'.repeat(33)])('sanitizes ASCII language classes: %s', hint => {
    const result = parse(`<pre><code class="${hint}">x\n</code></pre>`).result!;
    expect(result.contentFormat.blocks[0]).toMatchObject({ type: 'pre' });
    const block = result.contentFormat.blocks[0]!;
    if (block.type !== 'pre') throw new Error();
    expect(block.language).toBe(hint.length > 41 ? undefined : hint.includes('lang-text') ? 'text' : hint.slice(9));
  });

  it('preserves exact code whitespace and all media beyond truncation, excluding their false positions', () => {
    const { result, images, animations } = parse('<pre>\t' + 'x'.repeat(11_998) + '\u{1f600}<img src="/late.gif"></pre><img src="/last.jpg">');
    expect(result!.content).toBe('\t' + 'x'.repeat(11_998));
    expect(result!.contentFormat.blocks[0]).toMatchObject({ type: 'pre', length: 11_999 });
    expect(result!.imagePositions).toEqual([]);
    expect(images).toEqual(['https://example.com/late.gif', 'https://example.com/last.jpg']);
    expect(animations).toEqual([0]);
    const exact = parse('<pre>' + 'x'.repeat(11_999) + '\n<img src="/exact.jpg">more<img src="/late.jpg"></pre>').result!;
    expect(exact.content).toBe('x'.repeat(11_999) + '\n');
    expect(exact.imagePositions).toEqual([{ offset: 12_000, imageIndex: 0 }]);
  });

  it('clips 12k format to 8k with surrogate-safe boundaries and exact image ownership', () => {
    const result = parse('<pre>' + ' '.repeat(7998) + 'x<img src="/before.jpg">\u{1f600}<img src="/after.jpg">\nend</pre>').result!;
    const format = clipFeedContentFormat(result.contentFormat, result.content, result.imagePositions, 8000);
    const content = result.content.slice(0, 7999);
    const positions = result.imagePositions.filter(position => position.offset <= content.length);
    expect(isValidFeedContentFormat(format, content, positions)).toBe(true);
    expect(format.blocks[0]).toEqual({ type: 'pre', offset: 0, length: 7999, images: [0] });
    const table = parse('<pre>' + 'x'.repeat(7995) + '</pre><table><tr><td><img src="/a.jpg"></td><td><img src="/a.jpg"></td><td>\u{1f600}</td></tr></table>').result!;
    const clipped = clipFeedContentFormat(table.contentFormat, table.content, table.imagePositions, 8000);
    expect(isValidFeedContentFormat(clipped, table.content.slice(0, 7999), table.imagePositions)).toBe(true);
  });

  it('keeps a thousand occurrence positions on one pre independent of format/style limits', () => {
    const result = parse('<pre>' + '<img src="/same.jpg">'.repeat(1000) + 'x</pre>').result!;
    expect(result.imagePositions).toHaveLength(1000);
    expect(result.contentFormat.blocks[0]).toMatchObject({ images: Array.from({ length: 1000 }, (_, index) => index) });
    expect(() => parse('<pre>' + '<img src="/same.jpg">'.repeat(1001) + '</pre>')).toThrow(new FeedContentParseError('TOO_LARGE'));
  });

  it.each([
    '<table><tr><td colspan="2">wide</td></tr></table>',
    '<table><tr><td rowspan="2">tall</td></tr></table>',
    '<table><tr><td><table><tr><td>nested</td></tr></table></td></tr></table>',
    '<table>' + '<tr><td>x</td></tr>'.repeat(65) + '</table>',
    '<table><tr>' + '<td>x</td>'.repeat(17) + '</tr></table>',
    '<table>' + ('<tr>' + '<td>x</td>'.repeat(16) + '</tr>').repeat(33) + '</table>',
    '<ol reversed><li>reversed numbering</li></ol>',
    '<ol start="1000001"><li>excess numbering</li></ol>',
    '<ol><li value="5">overridden numbering</li></ol>',
    '<blockquote>'.repeat(4) + '<p>x</p>' + '</blockquote>'.repeat(4),
    '<h1>x</h1>'.repeat(129),
    '<b>x</b> '.repeat(1025),
  ])('falls back atomically for unsupported or over-budget structures', html => {
    expect(parse(html).result).toBeUndefined();
  });

  it('enforces compact metadata bytes separately from the style count', () => {
    const table = '<table>' + ('<tr>' + '<th align="center"><b>x</b><i>y</i></th>'.repeat(16) + '</tr>').repeat(32) + '</table>';
    expect(parse(table).result).toBeUndefined();
    expect(parse('<table>' + '<tr><td>x</td></tr>'.repeat(64) + '</table>').result).toBeDefined();
    expect(parse('<table>' + ('<tr>' + '<td>x</td>'.repeat(16) + '</tr>').repeat(32) + '</table>').result).toBeDefined();
    expect(parse('<h1>x</h1>'.repeat(128)).result!.contentFormat.blocks).toHaveLength(128);
    expect(leaves(parse('<b>x</b> '.repeat(1024)).result!.contentFormat.blocks)[0]!.spans).toHaveLength(1024);
  });

  it.each([50, 64])('bounds aggregate native rows across individually valid %i-row tables', rows => {
    const table = '<table>' + '<tr><td>x</td></tr>'.repeat(rows) + '</table>';
    const single = parse(table).result!;
    expect(single.contentFormat.blocks).toHaveLength(1);
    expect(single.contentFormat.blocks[0]).toMatchObject({ type: 'table', cells: expect.any(Array) });
    expect(parse(table.repeat(4)).result!.contentFormat.blocks).toHaveLength(4);
    expect(parse(table.repeat(8)).result).toBeUndefined();
  });

  it('does not stop security token/depth guards or media scanning after a format fallback', () => {
    const { result, images } = parse('<table><tr><td colspan="2">unsupported</td></tr></table><img src="/still-collected.jpg">');
    expect(result).toBeUndefined();
    expect(images).toEqual(['https://example.com/still-collected.jpg']);
    expect(() => parse('<b>x</b>' + '<br>'.repeat(20_000))).toThrow(new FeedContentParseError('INVALID_FEED'));
    expect(() => parse('<section>'.repeat(49) + '<b>x</b>' + '</section>'.repeat(49))).toThrow(new FeedContentParseError('INVALID_FEED'));
    expect(parse('<pre>x</pre>' + '<br>'.repeat(19_999)).result).toBeDefined();
    expect(parse('<section>'.repeat(47) + '<pre>x</pre>' + '</section>'.repeat(47)).result).toBeDefined();
  });
});
