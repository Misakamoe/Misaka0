import type { InputRichMessageWithoutUpload, RichText } from 'grammy/types';
import { parser, RuleType, type MarkdownToJSX } from 'markdown-to-jsx/markdown';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiOutputTextLimits } from '../shared/schemas/ai.js';
import { aiAnswerContent } from '../src/telegram/ai-rich.js';

vi.mock('markdown-to-jsx/markdown', async importOriginal => {
  const actual = await importOriginal<typeof import('markdown-to-jsx/markdown')>();
  return { ...actual, parser: vi.fn(actual.parser) };
});

afterEach(() => { vi.mocked(parser).mockClear(); vi.restoreAllMocks(); });

const paragraph = (text: RichText) => ({ type: 'paragraph' as const, text });
const literal = (text: string) => ({ blocks: [paragraph(text)], skip_entity_detection: true });

function objects(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(objects);
  const object = value as Record<string, unknown>;
  return [object, ...Object.values(object).flatMap(objects)];
}

function visible(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(visible).join('');
  if (!value || typeof value !== 'object') return '';
  const object = value as Record<string, unknown>;
  return visible(object.text ?? object.blocks ?? object.items ?? object.cells);
}

describe('AI-only native Markdown rendering', () => {
  it('uses only fixed parser options and the grammY input alias', () => {
    const text = '**answer**';
    const content: InputRichMessageWithoutUpload = aiAnswerContent(text);
    expect(content).toEqual({ blocks: [paragraph({ type: 'bold', text: 'answer' })], skip_entity_detection: true });
    expect(parser).toHaveBeenCalledExactlyOnceWith(text, {
      disableParsingRawHTML: true, disableAutoLink: true, disableFrontmatter: true,
      evalUnserializableExpressions: false, optimizeForStreaming: false, forceBlock: true,
    });
  });

  it('renders nested styles, normal-sized headings, paragraphs, and hard/soft breaks exactly', () => {
    const content = aiAnswerContent('# Title\n\n**bold _italic ~~strike ==mark==~~_** and `code`\n\nline  \nbreak\\\nhard\nsoft');
    expect(content).toEqual({ blocks: [
      paragraph({ type: 'bold', text: 'Title' }),
      paragraph([
        { type: 'bold', text: ['bold ', { type: 'italic', text: ['italic ',
          { type: 'strikethrough', text: ['strike ', { type: 'marked', text: 'mark' }] }] }] },
        ' and ', { type: 'code', text: 'code' },
      ]),
      paragraph('line\nbreak\nhard\nsoft'),
    ], skip_entity_detection: true });
  });

  it('maps every heading level and setext headings to bold paragraphs, never heading IDs', () => {
    for (let level = 1; level <= 6; level++) {
      expect(aiAnswerContent(`${'#'.repeat(level)} Heading`)).toEqual({
        blocks: [paragraph({ type: 'bold', text: 'Heading' })], skip_entity_detection: true,
      });
    }
    expect(aiAnswerContent('Heading\n=======')).toEqual({
      blocks: [paragraph({ type: 'bold', text: 'Heading' })], skip_entity_detection: true,
    });
  });

  it('renders tight nested lists with ordered decimal values starting at the parsed start', () => {
    expect(aiAnswerContent('3. first **bold**\n   - nested _italic_\n   - other\n9. second')).toEqual({
      blocks: [{ type: 'list', items: [
        { type: '1', value: 3, blocks: [paragraph(['first ', { type: 'bold', text: 'bold' }]),
          { type: 'list', items: [
            { blocks: [paragraph(['nested ', { type: 'italic', text: 'italic' }])] },
            { blocks: [paragraph('other')] },
          ] },
        ] },
        { type: '1', value: 4, blocks: [paragraph('second')] },
      ] }], skip_entity_detection: true,
    });
    expect(aiAnswerContent('- root\n\n  7. seven\n  9. eight')).toEqual({ blocks: [{ type: 'list', items: [
      { blocks: [paragraph('root'), { type: 'list', items: [
        { type: '1', value: 7, blocks: [paragraph('seven')] },
        { type: '1', value: 8, blocks: [paragraph('eight')] },
      ] }] },
    ] }], skip_entity_detection: true });
  });

  it('keeps loose list paragraphs and read-only task markers', () => {
    expect(aiAnswerContent('- one\n\n  paragraph\n\n- two')).toEqual({ blocks: [{ type: 'list', items: [
      { blocks: [paragraph('one'), paragraph('paragraph')] }, { blocks: [paragraph('two')] },
    ] }], skip_entity_detection: true });
    expect(aiAnswerContent('- [x] done\n- [ ] todo')).toEqual({ blocks: [{ type: 'list', items: [
      { blocks: [paragraph('[x] done')] }, { blocks: [paragraph('[ ] todo')] },
    ] }], skip_entity_detection: true });
  });

  it('renders nested blockquotes and lists without flattening', () => {
    expect(aiAnswerContent('> quote **bold**\n>\n> > nested\n>\n> - list')).toEqual({ blocks: [
      { type: 'blockquote', blocks: [paragraph(['quote ', { type: 'bold', text: 'bold' }]),
        { type: 'blockquote', blocks: [paragraph('nested')] },
        { type: 'list', items: [{ blocks: [paragraph('list')] }] },
      ] },
    ], skip_entity_detection: true });
  });

  it('renders GFM table cells, alignment, header flags, and inline formatting exactly', () => {
    expect(aiAnswerContent('| Left | Mid | Right |\n| :--- | :---: | ---: |\n| **a** | `b` | [c](http://localhost:8080/c) |\n| d | e | f |'))
      .toEqual({ blocks: [{ type: 'table', is_bordered: true, is_compact: true, cells: [
        [{ text: 'Left', align: 'left', valign: 'top', is_header: true }, { text: 'Mid', align: 'center', valign: 'top', is_header: true }, { text: 'Right', align: 'right', valign: 'top', is_header: true }],
        [{ text: { type: 'bold', text: 'a' }, align: 'left', valign: 'top' }, { text: { type: 'code', text: 'b' }, align: 'center', valign: 'top' },
          { text: { type: 'url', text: 'c', url: 'http://localhost:8080/c' }, align: 'right', valign: 'top' }],
        [{ text: 'd', align: 'left', valign: 'top' }, { text: 'e', align: 'center', valign: 'top' }, { text: 'f', align: 'right', valign: 'top' }],
      ] }], skip_entity_detection: true });
  });

  it('keeps code literal, including HTML entities, escapes, URLs, and Markdown syntax', () => {
    const code = '<b>&amp; **bold**</b>\n\t[x](https://example.test) @user /help \\path';
    expect(aiAnswerContent(`\`\`\`ts\n${code}\n\`\`\``)).toEqual({ blocks: [{ type: 'pre', text: code, language: 'ts' }], skip_entity_detection: true });
    expect(aiAnswerContent('    <b>&amp; **bold**</b>\n    \tline')).toEqual({
      blocks: [{ type: 'pre', text: '<b>&amp; **bold**</b>\n\tline' }], skip_entity_detection: true,
    });
    expect(aiAnswerContent('`<b>&amp; **bold** \\path</b>`')).toEqual({
      blocks: [paragraph({ type: 'code', text: '<b>&amp; **bold** \\path</b>' })], skip_entity_detection: true,
    });
  });

  it.each(['c++', 'C#', 'a'.repeat(64), 'a'.repeat(65), '_unsafe', '../path', 'x.y-z_9+'])('bounds the optional language hint %s', language => {
    const valid = /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(language);
    expect(aiAnswerContent(`\`\`\`${language}\ncode\n\`\`\``)).toEqual({
      blocks: [{ type: 'pre', text: 'code', ...(valid ? { language } : {}) }], skip_entity_detection: true,
    });
  });

  it.each([
    '<b>not parsed</b>', '<!-- not parsed -->', '<!-- unfinished',
    '<script>globalThis.aiRichExecuted = true</script>',
    '<Widget onClick={() => globalThis.aiRichExecuted = true} />',
    '<tg-button-row><tg-button type="callback_data" data="admin:delete">Run</tg-button></tg-button-row>',
    '<img src="https://example.test/a.png">', '<a name="admin">anchor</a>',
  ])('preserves raw HTML/JSX/comment source literally: %s', source => {
    expect(aiAnswerContent(source)).toEqual(literal(source));
    expect(globalThis).not.toHaveProperty('aiRichExecuted');
  });

  it('keeps HTML tags literal without disabling adjacent Markdown formatting', () => {
    expect(aiAnswerContent('<b>**formatted**</b> and **outside**')).toEqual({ blocks: [paragraph([
      '<b>', { type: 'bold', text: 'formatted' }, '</b> and ', { type: 'bold', text: 'outside' },
    ])], skip_entity_detection: true });
  });

  it('does not hide frontmatter', () => {
    expect(aiAnswerContent('---\nkey: value\n---')).toEqual({
      blocks: [{ type: 'divider' }, paragraph({ type: 'bold', text: 'key: value' })], skip_entity_detection: true,
    });
  });

  it('preserves escaped punctuation, Unicode, and text entities without double escaping', () => {
    const source = '\\*literal\\* \\[link\\] \\#tag \\_x\\_ &amp; **\u754c\u{1f680}e\u0301**';
    const content = aiAnswerContent(source);
    expect(visible(content)).toBe('*literal* [link] #tag _x_ & \u754c\u{1f680}e\u0301');
    expect(objects(content)).toContainEqual({ type: 'bold', text: '\u754c\u{1f680}e\u0301' });
  });

  it.each(['', '\n\n', ' \t\n', '**unfinished', '_unfinished', '~~unfinished', '==unfinished', '`unfinished',
    '[unfinished](https://example.test', '![unfinished](https://example.test', '```', '```js', '```js\n',
  ])('does not hide incomplete input: %j', source => {
    expect(aiAnswerContent(source)).toEqual(literal(source));
  });

  it('renders unfinished fences as literal code content without hiding the partial answer', () => {
    expect(aiAnswerContent('before\n\n```ts\n<partial>\n``')).toEqual({ blocks: [paragraph('before'),
      { type: 'pre', text: '<partial>\n``', language: 'ts' }], skip_entity_detection: true });
    expect(aiAnswerContent('~~~js\npartial')).toEqual({ blocks: [{ type: 'pre', text: 'partial', language: 'js' }], skip_entity_detection: true });
    expect(aiAnswerContent('> ```js\n> partial')).toEqual({ blocks: [{ type: 'blockquote', blocks: [
      { type: 'pre', text: 'partial', language: 'js' },
    ] }], skip_entity_detection: true });
    expect(aiAnswerContent('- ```js\n  partial')).toEqual({ blocks: [{ type: 'list', items: [{ blocks: [
      { type: 'pre', text: 'partial', language: 'js' },
    ] }] }], skip_entity_detection: true });
  });

  it('accepts closed tilde, longer fences, and fences nested in a quote', () => {
    expect(aiAnswerContent('~~~js\ncode\n~~~~')).toEqual({ blocks: [{ type: 'pre', text: 'code', language: 'js' }], skip_entity_detection: true });
    expect(aiAnswerContent('> ```js\n> code\n> ```')).toEqual({
      blocks: [{ type: 'blockquote', blocks: [{ type: 'pre', text: 'code', language: 'js' }] }], skip_entity_detection: true,
    });
  });
});

describe('AI rich presentation safety', () => {
  it.each(['https://example.test/a?q=1&b=2#part', 'http://localhost:8080/a', 'https://private.internal:9443/a',
    'http://127.0.0.1:3000/', 'https://[::1]:444/', 'HTTP://example.test:81/a',
  ])('permits inert absolute HTTP(S) presentation links: %s', url => {
    expect(aiAnswerContent(`[**label**](${url})`)).toEqual({ blocks: [paragraph({
      type: 'url', text: { type: 'bold', text: 'label' }, url,
    })], skip_entity_detection: true });
  });

  it.each(['javascript:alert(1)', 'data:text/html,bad', 'tg://user?id=123', 'mailto:user@example.test',
    'tel:12345', 'file:///etc/passwd', '//example.test/path', '/relative', '#anchor', 'https://',
    'https://user:password@example.test/a', 'https://user@example.test/a', 'https://@example.test/a',
    'https://example.test/a\u0001b', 'https://example.test/a\u007fb', 'https://example.test/a\u0085b',
    'https://example.test/a%0Ab', 'https://example.test/a%00b', 'https://example.test/a%7fb',
    'https://example.test/a\u200bb', 'https://example.test/a\\b', 'http:example.test',
  ])('does not emit a clickable unsafe/ambiguous target: %s', target => {
    const content = aiAnswerContent(`[label](${target})`);
    expect(visible(content)).toContain('label');
    expect(objects(content).some(node => node.type === 'url')).toBe(false);
    expect(content.skip_entity_detection).toBe(true);
  });

  it('rejects control whitespace before URL normalization can remove it', () => {
    for (const target of ['https://example.test/a\tb', 'https://example.test/a\nb', 'https://example.test/a\rb']) {
      const content = aiAnswerContent(`[label](<${target}>)`);
      expect(objects(content).some(node => node.type === 'url')).toBe(false);
      expect(visible(content)).toContain('label');
    }
  });

  it('checks the complete target length without truncating a URL', () => {
    const url = `https://example.test/${'a'.repeat(2027)}`;
    expect(url).toHaveLength(2048);
    expect(objects(aiAnswerContent(`[label](${url})`))).toContainEqual({ type: 'url', text: 'label', url });
    expect(objects(aiAnswerContent(`[label](${url}a)`)).some(node => node.type === 'url')).toBe(false);
  });

  it('does not auto-detect bare URLs, commands, mentions, email, phone numbers, or hashtags', () => {
    const source = '/help @admin https://example.test test@example.test +12345678901 #tag $USD 4242424242424242';
    expect(aiAnswerContent(source)).toEqual(literal(source));
    expect(aiAnswerContent(`**${source}**`)).toEqual({
      blocks: [paragraph({ type: 'bold', text: source })], skip_entity_detection: true,
    });
  });

  it('renders images as safe links/alt text only, never requests or media uploads', () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const content = aiAnswerContent('![**alt**](https://example.test/image.png) ![blocked](tg://emoji?id=123) ![](https://localhost:8080/image)');
    expect(content).toEqual({ blocks: [paragraph([
      { type: 'url', text: 'alt', url: 'https://example.test/image.png' }, ' blocked ',
      { type: 'url', text: 'https://localhost:8080/image', url: 'https://localhost:8080/image' },
    ])], skip_entity_detection: true });
    expect(fetch).not.toHaveBeenCalled();
    const allowed = new Set(['blocks', 'skip_entity_detection', 'type', 'text', 'url']);
    expect(objects(content).every(node => Object.keys(node).every(key => allowed.has(key)))).toBe(true);
    const source = '![](javascript:alert(1))';
    expect(aiAnswerContent(source)).toEqual(literal(source));
  });

  it('resolves ordinary reference links but preserves unsupported footnotes and alerts', () => {
    expect(aiAnswerContent('[label][ref]\n\n[ref]: https://localhost:8080/path')).toEqual({
      blocks: [paragraph({ type: 'url', text: 'label', url: 'https://localhost:8080/path' })], skip_entity_detection: true,
    });
    for (const source of ['text[^note]\n\n[^note]: **full** definition', '[^unused]: keep definition', '> [!NOTE]\n> keep note']) {
      expect(aiAnswerContent(source)).toEqual(literal(source));
    }
  });

  it('falls back to the whole source on unknown AST, unsupported inline styles, or parser failure', () => {
    const source = '**keep every byte**\n\n\u754c\u{1f680}\n';
    for (const node of [
      { type: 'future-syntax', text: 'not source' } as unknown as MarkdownToJSX.ASTNode,
      { type: RuleType.textFormatted, tag: 'unsupported', children: [{ type: RuleType.text, text: 'not source' }] } satisfies MarkdownToJSX.ASTNode,
    ]) {
      vi.mocked(parser).mockReturnValueOnce([node]);
      expect(aiAnswerContent(source)).toEqual(literal(source));
    }
    vi.mocked(parser).mockImplementationOnce(() => { throw new Error('parser failure'); });
    expect(aiAnswerContent(source)).toEqual(literal(source));
  });

  it('copies no arbitrary parser fields into native objects', () => {
    vi.mocked(parser).mockReturnValueOnce([{
      type: RuleType.codeBlock, text: 'literal code', lang: 'js', attrs: { key: 'ignored' },
      html: '<button>run</button>', callback_data: 'admin', entities: [],
    } as MarkdownToJSX.CodeBlockNode]);
    expect(aiAnswerContent('code')).toEqual({ blocks: [{ type: 'pre', text: 'literal code', language: 'js' }], skip_entity_detection: true });
  });
});

describe('AI rich bounds and lossless fallback', () => {
  it('validates source character and serialized-byte limits before parsing', () => {
    for (const source of ['a'.repeat(aiOutputTextLimits.characters + 1), '\u754c'.repeat(20_000), '\u0000'.repeat(10_000)]) {
      expect(() => aiAnswerContent(source)).toThrow(expect.objectContaining({ code: 'AI_OUTPUT_LIMIT' }));
    }
    expect(parser).not.toHaveBeenCalled();
    for (const source of ['a'.repeat(aiOutputTextLimits.characters), '\u754c'.repeat(19_999), '\u{1f680}'.repeat(aiOutputTextLimits.characters / 2 - 361)]) {
      expect(visible(aiAnswerContent(source))).toBe(source);
    }
  });

  it('reserves server block headroom and falls back instead of truncating many paragraphs', () => {
    const within = Array.from({ length: 480 }, (_, i) => `p${i}`).join('\n\n');
    expect(aiAnswerContent(within).blocks).toHaveLength(480);
    const over = `${within}\n\n**last \u754c\u{1f680}**\n`;
    expect(aiAnswerContent(over)).toEqual(literal(over));
  });

  it('counts nested list items as blocks as well as their paragraphs', () => {
    const within = '- item\n'.repeat(239);
    expect(aiAnswerContent(within).blocks[0]?.type).toBe('list');
    const over = `${within}- **last**\n`;
    expect(aiAnswerContent(over)).toEqual(literal(over));
  });

  it('bounds inline nodes, not only top-level blocks', () => {
    expect(aiAnswerContent('**x** '.repeat(100))).not.toEqual(literal('**x** '.repeat(100)));
    const source = '**x** '.repeat(1000) + '\u754c\u{1f680} END\n';
    expect(aiAnswerContent(source)).toEqual(literal(source));
  });

  it('bounds combined block/list/formatting nesting and preserves the original source', () => {
    expect(aiAnswerContent('> '.repeat(5) + '**nested**').blocks[0]?.type).toBe('blockquote');
    for (const source of ['> '.repeat(12) + '**nested**',
      Array.from({ length: 5 }, (_, i) => `${'  '.repeat(i)}- **_level ${i}_**`).join('\n'),
      '> '.repeat(1000) + 'last\n',
    ]) expect(aiAnswerContent(source)).toEqual(literal(source));
  });

  it('caps table columns at 20 and counts table rows against the block budget', () => {
    const table = (columns: number, rows: number) => `${'| H '.repeat(columns)}|\n${'| --- '.repeat(columns)}|\n${(`${'| cell '.repeat(columns)}|\n`).repeat(rows)}`;
    expect(aiAnswerContent(table(20, 1)).blocks[0]?.type).toBe('table');
    for (const source of [table(21, 1), table(1, 479)]) expect(aiAnswerContent(source)).toEqual(literal(source));
    expect(aiAnswerContent(table(1, 478)).blocks[0]?.type).toBe('table');
  });

  it('bounds serialized native bytes even when short references expand repeatedly', () => {
    const url = `https://example.test/${'a'.repeat(1950)}`;
    const source = `${'[x][r] '.repeat(80)}\n\n[r]: ${url}\n`;
    expect(source.length).toBeLessThan(aiOutputTextLimits.characters);
    expect(Buffer.byteLength(JSON.stringify(source))).toBeLessThan(aiOutputTextLimits.bytes);
    expect(Buffer.byteLength(JSON.stringify(Array.from({ length: 80 }, () => ({ type: 'url', text: 'x', url }))))).toBeGreaterThan(128 * 1024);
    expect(aiAnswerContent(source)).toEqual(literal(source));
    expect(objects(aiAnswerContent(`${'[x][r] '.repeat(40)}\n\n[r]: ${url}`)).filter(node => node.type === 'url')).toHaveLength(40);
  });

  it('bounds rendered characters when repeated empty-alt images expand to long URL labels', () => {
    const url = `https://example.test/${'a'.repeat(1930)}`;
    const source = `${'![][r] '.repeat(17)}\n\n[r]: ${url}`;
    expect(source.length).toBeLessThan(aiOutputTextLimits.characters);
    expect(url.length * 17).toBeGreaterThan(aiOutputTextLimits.characters);
    expect(Buffer.byteLength(JSON.stringify(Array.from({ length: 17 }, () => ({ type: 'url', text: url, url }))))).toBeLessThan(128 * 1024);
    expect(aiAnswerContent(source)).toEqual(literal(source));
    expect(objects(aiAnswerContent(`${'![][r] '.repeat(15)}\n\n[r]: ${url}`)).filter(node => node.type === 'url')).toHaveLength(15);
  });

  it('never caches mutable AST/output or retains prior answer content', () => {
    const first = aiAnswerContent('**first**');
    first.blocks.length = 0;
    expect(aiAnswerContent('**first**')).toEqual({ blocks: [paragraph({ type: 'bold', text: 'first' })], skip_entity_detection: true });
    expect(aiAnswerContent('second')).toEqual(literal('second'));
    expect(parser).toHaveBeenCalledTimes(3);
  });
});
