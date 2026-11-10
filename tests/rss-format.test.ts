import { describe, expect, it } from 'vitest';
import {
  FEED_FORMAT_MAX_BYTES, FEED_FORMAT_MAX_NATIVE_BLOCKS, clipFeedContentFormat, feedContentFormatSchema, isValidFeedContentFormat,
  type FeedContentBlock, type FeedContentFormat, type FeedImagePosition, type FeedStyle,
} from '../src/modules/rss-format.js';

const format = (...blocks: FeedContentBlock[]): FeedContentFormat => ({ version: 1, blocks });
const paragraph = (offset = 0, length = 4) => ({ type: 'paragraph' as const, offset, length });
const tables = (rows: number[], length = 0): FeedContentBlock[] => rows.map((count, index) => ({ type: 'table', offset: index * length, length,
  cells: Array.from({ length: count }, (_, row) => [{ offset: (index + (row ? 1 : 0)) * length, length: row ? 0 : length }]),
}));

describe('RSS structured-content contract', () => {
  it('accepts all block kinds, overlapping inline styles and safe language labels without rewriting', () => {
    const styles: FeedStyle[] = ['bold', 'italic', 'underline', 'strikethrough', 'code', 'marked'];
    const value = format({ type: 'heading', offset: 0, length: 4, spans: styles.map(type => ({ type, offset: 0, length: 4 })) },
      { type: 'pre', offset: 4, length: 4, language: 'c++' },
      { type: 'table', offset: 8, length: 4, cells: [[{ offset: 8, length: 2, header: true, align: 'center' }, { offset: 10, length: 2 }]] },
      { type: 'list', offset: 12, length: 4, ordered: true, start: -2, items: [[paragraph(12, 4)]] },
      { type: 'blockquote', offset: 16, length: 4, blocks: [paragraph(16, 4)] }, { type: 'divider', offset: 20, length: 0 });
    expect(feedContentFormatSchema.parse(value)).toStrictEqual(value);
    expect(isValidFeedContentFormat(value, 'x'.repeat(20))).toBe(true);
  });

  it.each([
    { version: 2, blocks: [] }, { version: '1', blocks: [] }, { version: 1, blocks: [], extra: true },
    format({ ...paragraph(), type: 'html' } as unknown as FeedContentBlock),
    format({ ...paragraph(), offset: -1 }), format({ ...paragraph(), length: 0.5 }),
    format({ ...paragraph(), offset: Infinity }), format({ ...paragraph(), length: 12_001 }),
    format({ ...paragraph(), url: 'https://example.com' } as FeedContentBlock),
    format({ ...paragraph(), text: 'native SDK object' } as FeedContentBlock),
    format({ type: 'paragraph', offset: 0, length: 4, spans: [{ offset: 0, length: 1, type: 'link' as FeedStyle }] }),
    format({ type: 'paragraph', offset: 0, length: 4, spans: [{ offset: 0, length: 0, type: 'bold' }] }),
    format({ type: 'pre', offset: 0, length: 4, language: '../../bin/sh' }),
    format({ type: 'pre', offset: 0, length: 4, language: 'https://example.com' }),
    format({ type: 'pre', offset: 0, length: 4, language: 'x'.repeat(65) }),
    format({ type: 'list', offset: 0, length: 4, start: 1, items: [[paragraph()]] }),
    format({ type: 'list', offset: 0, length: 4, ordered: true, start: 1_000_001, items: [[paragraph()]] }),
    format({ type: 'list', offset: 0, length: 4, items: [[]] }),
    format({ type: 'blockquote', offset: 0, length: 4, blocks: [] }),
    format({ type: 'table', offset: 0, length: 4, cells: [[]] }),
    format({ type: 'table', offset: 0, length: 4, cells: [[{ offset: 0, length: 0, header: false }]] } as unknown as FeedContentBlock),
    format({ type: 'divider', offset: 0, length: 1 } as unknown as FeedContentBlock),
  ])('rejects unknown fields, versions, styles and noncanonical structure: %j', value => {
    expect(feedContentFormatSchema.safeParse(value).success).toBe(false);
    expect(isValidFeedContentFormat(value as FeedContentFormat, 'text')).toBe(false);
  });

  it('bounds total blocks, total styles and depth before deep descent or array expansion', () => {
    let block: FeedContentBlock = paragraph();
    for (let depth = 1; depth < 4; depth++) block = { type: 'blockquote', offset: 0, length: 4, blocks: [block] };
    expect(isValidFeedContentFormat(format(block), 'text')).toBe(true);
    block = { type: 'blockquote', offset: 0, length: 4, blocks: [block] };
    expect(feedContentFormatSchema.safeParse(format(block)).success).toBe(false);
    for (let depth = 0; depth < 10_000; depth++) block = { type: 'blockquote', offset: 0, length: 4, blocks: [block] };
    expect(() => feedContentFormatSchema.safeParse(format(block))).not.toThrow();
    expect(feedContentFormatSchema.safeParse(format(block)).success).toBe(false);
    expect(feedContentFormatSchema.safeParse(format(...Array.from({ length: 128 }, () => paragraph(0, 0)))).success).toBe(true);
    expect(feedContentFormatSchema.safeParse(format({ type: 'blockquote', offset: 0, length: 4,
      blocks: Array.from({ length: 128 }, () => paragraph(0, 0)),
    })).success).toBe(false);
    expect(feedContentFormatSchema.safeParse({ version: 1, blocks: Array.from({ length: 100_000 }, () => paragraph()) }).success).toBe(false);
    const spans = Array.from({ length: 512 }, () => ({ offset: 0, length: 1, type: 'bold' as const }));
    const styled = format({ type: 'paragraph', offset: 0, length: 1, spans }, { type: 'paragraph', offset: 1, length: 1,
      spans: spans.map(span => ({ ...span, offset: 1 })),
    });
    expect(isValidFeedContentFormat(styled, 'xx')).toBe(true);
    styled.blocks.push({ type: 'paragraph', offset: 2, length: 1, spans: [{ offset: 2, length: 1, type: 'bold' }] });
    expect(feedContentFormatSchema.safeParse(styled).success).toBe(false);
    const cyclic = format(); cyclic.blocks.push({ type: 'blockquote', offset: 0, length: 0, blocks: cyclic.blocks });
    expect(feedContentFormatSchema.safeParse(cyclic).success).toBe(false);
    expect(feedContentFormatSchema.safeParse(Object.create({ version: 1, blocks: [block] })).success).toBe(false);
  });

  it('enforces compact serialized metadata bytes including cells and escaped data', () => {
    const large = format({ type: 'table', offset: 0, length: 12_000, cells: Array.from({ length: 32 }, () => Array.from({ length: 16 }, () => ({
      offset: 11_999, length: 1, spans: [{ offset: 11_999, length: 1, type: 'strikethrough' as const }, { offset: 11_999, length: 1, type: 'underline' as const }],
    }))) });
    expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(FEED_FORMAT_MAX_BYTES);
    expect(feedContentFormatSchema.safeParse(large).success).toBe(false);
    expect(feedContentFormatSchema.safeParse({ version: 1, blocks: [], extra: '\u0000'.repeat(FEED_FORMAT_MAX_BYTES) }).success).toBe(false);
  });

  it('budgets padded table area rather than only explicitly stored cells', () => {
    const table = (rows: number, columns: number): FeedContentBlock => ({ type: 'table', offset: 0, length: 0,
      cells: Array.from({ length: rows }, () => Array.from({ length: columns }, () => ({ offset: 0, length: 0, header: true }))),
    });
    expect(isValidFeedContentFormat(format(table(32, 16)), '')).toBe(true);
    expect(isValidFeedContentFormat(format(table(64, 8)), '')).toBe(true);
    expect(feedContentFormatSchema.safeParse(format(table(33, 16))).success).toBe(false);
    expect(feedContentFormatSchema.safeParse(format(table(65, 1))).success).toBe(false);
    expect(feedContentFormatSchema.safeParse(format(table(1, 17))).success).toBe(false);
    const sparse = table(64, 1);
    if (sparse.type !== 'table') throw new Error('Expected table');
    sparse.cells[0] = Array.from({ length: 16 }, () => ({ offset: 0, length: 0 }));
    expect(sparse.cells.flat()).toHaveLength(79);
    expect(feedContentFormatSchema.safeParse(format(sparse)).success).toBe(false);
  });

  it.each(['root', 'quote', 'quote-list'] as const)('accepts exactly 400 native expansion units and rejects 401 across a %s group', group => {
    const wrap = (last: number): FeedContentFormat => {
      const rows = group === 'root' ? [64, 64, 64, 64, 64, 64, last]
        : group === 'quote' ? [64, 64, 64, 64, 64, 61, last] : [64, 64, 64, 64, 64, 57, last];
      let blocks = tables(rows);
      if (group === 'quote-list') blocks = [{ type: 'list', offset: 0, length: 0, items: [blocks] }];
      if (group !== 'root') blocks = [{ type: 'blockquote', offset: 0, length: 0, blocks }];
      return format(...blocks);
    };
    expect(FEED_FORMAT_MAX_NATIVE_BLOCKS).toBe(400);
    const exact = wrap(1);
    expect(Buffer.byteLength(JSON.stringify(exact))).toBeLessThan(FEED_FORMAT_MAX_BYTES);
    expect(feedContentFormatSchema.safeParse(exact).success).toBe(true);
    expect(isValidFeedContentFormat(exact, '')).toBe(true);
    expect(feedContentFormatSchema.safeParse(wrap(2)).success).toBe(false);
    expect(isValidFeedContentFormat(wrap(2), '')).toBe(false);
  });

  it('rejects aggregate table rows even when each table and the metadata size are well below their limits', () => {
    const value = format(...tables(Array.from({ length: 8 }, () => 64)));
    expect(value.blocks).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(FEED_FORMAT_MAX_BYTES);
    expect(feedContentFormatSchema.safeParse(value).success).toBe(false);
    expect(isValidFeedContentFormat(value, '')).toBe(false);
  });

  it('charges list items, their own possible gaps, and one marker paragraph per image-bearing pre', () => {
    // 99 items cost 399: list + items + paragraph children + root/item gap reservations.
    const items: FeedContentBlock[][] = Array.from({ length: 99 }, () => [paragraph(0, 0)]);
    const value = format({ type: 'list', offset: 0, length: 0, items });
    expect(isValidFeedContentFormat(value, '')).toBe(true);
    items[0] = [{ type: 'pre', offset: 0, length: 0, images: [0] }];
    expect(isValidFeedContentFormat(value, '', [{ offset: 0, imageIndex: 0 }])).toBe(true);
    items[1] = [{ type: 'pre', offset: 0, length: 0, images: [1] }];
    expect(feedContentFormatSchema.safeParse(value).success).toBe(false);
    expect(isValidFeedContentFormat(value, '', [{ offset: 0, imageIndex: 0 }, { offset: 0, imageIndex: 0 }])).toBe(false);
  });

  it('does not charge table cells, styles, or individual image markers as native blocks', () => {
    const positions = Array.from({ length: 1000 }, () => ({ offset: 0, imageIndex: 0 }));
    expect(isValidFeedContentFormat(format({ type: 'pre', offset: 0, length: 0, images: positions.map((_, index) => index) }), '', positions)).toBe(true);
    const value = format({ type: 'table', offset: 0, length: 0, cells: Array.from({ length: 64 }, () =>
      Array.from({ length: 8 }, () => ({ offset: 0, length: 0 }))) });
    expect(isValidFeedContentFormat(value, '')).toBe(true);
    const styled = format({ type: 'paragraph', offset: 0, length: 1,
      spans: Array.from({ length: 1024 }, () => ({ offset: 0, length: 1, type: 'bold' })),
      images: positions.map((_, index) => index),
    });
    expect(isValidFeedContentFormat(styled, 'x', positions)).toBe(true);
  });

  it.each([
    format(paragraph(0, 5)), format(paragraph(2, 1)), format(paragraph(0, 2)),
    format(paragraph(1, 3), paragraph(3, 1)), format(paragraph(3, 1), paragraph(0, 1)),
    format({ type: 'blockquote', offset: 1, length: 2, blocks: [paragraph(0, 1)] }),
    format({ type: 'list', offset: 0, length: 4, items: [[paragraph(3, 1)], [paragraph(0, 1)]] }),
    format({ type: 'table', offset: 0, length: 4, cells: [[{ offset: 0, length: 3 }, { offset: 1, length: 2 }]] }),
    format({ type: 'table', offset: 0, length: 4, cells: [[{ offset: 0, length: 1 }], [{ offset: 0, length: 1 }]] }),
    format({ type: 'table', offset: 1, length: 2, cells: [[{ offset: 0, length: 1 }]] }),
    format({ type: 'table', offset: 0, length: 4, cells: [[{ offset: 0, length: 2 }]] }),
    format({ type: 'paragraph', offset: 1, length: 2, spans: [{ offset: 0, length: 1, type: 'bold' }] }),
    format({ type: 'paragraph', offset: 0, length: 4, spans: [{ offset: 1, length: 1, type: 'bold' }] }),
    format({ type: 'paragraph', offset: 0, length: 4, spans: [{ offset: 2, length: 1, type: 'bold' }] }),
  ])('rejects out-of-range, overlapping, noncontained and surrogate-splitting ranges: %j', value => {
    expect(isValidFeedContentFormat(value, 'A\uD83D\uDE00B')).toBe(false);
  });

  it('assigns adjacent empty cells and duplicate positions to exactly one occurrence owner', () => {
    const positions = [{ offset: 0, imageIndex: 2 }, { offset: 0, imageIndex: 2 }, { offset: 1, imageIndex: 0 }];
    const value = format({ type: 'table', offset: 0, length: 1, cells: [[
      { offset: 0, length: 0, header: true, images: [0] }, { offset: 0, length: 0, images: [1] }, { offset: 0, length: 1, images: [2] },
    ]] });
    expect(isValidFeedContentFormat(value, 'x', positions)).toBe(true);
    for (const images of [[0, 0, 1, 2], [1, 0, 2], [0, 2], [0, 1, 3], [0, 1]]) {
      expect(isValidFeedContentFormat(format({ type: 'pre', offset: 0, length: 1, images }), 'x', positions)).toBe(false);
    }
    expect(isValidFeedContentFormat(format({ type: 'pre', offset: 1, length: 0, images: [0, 1, 2] }), 'x', positions)).toBe(false);
    expect(isValidFeedContentFormat(format(paragraph(0, 1)), 'x', positions)).toBe(false);
    expect(isValidFeedContentFormat(value, 'x')).toBe(false);
  });

  it('allows whitespace table separators but never hides nonwhitespace outside its cells', () => {
    const table = format({ type: 'table', offset: 0, length: 5, cells: [[{ offset: 1, length: 1 }, { offset: 3, length: 1 }]] });
    expect(isValidFeedContentFormat(table, '\nA\tB\n')).toBe(true);
    for (const content of ['!A\tB\n', '\nA!B\n', '\nA\tB!']) expect(isValidFeedContentFormat(table, content)).toBe(false);
    expect(isValidFeedContentFormat(format({ type: 'table', offset: 0, length: 1, cells: [[{ offset: 0, length: 0 }]] }), 'x')).toBe(false);
    expect(isValidFeedContentFormat(format(paragraph(1, 1)), '!A!')).toBe(true);
  });

  it('retains the full 1000-occurrence budget and rejects invalid position ordering or boundaries', () => {
    const positions = Array.from({ length: 1000 }, (_, index) => ({ offset: Math.floor(index / 250), imageIndex: 999 - index }));
    const value = format({ type: 'paragraph', offset: 0, length: 4, images: positions.map((_, index) => index) });
    expect(isValidFeedContentFormat(value, 'text', positions)).toBe(true);
    expect(isValidFeedContentFormat(value, 'text', [...positions, { offset: 4, imageIndex: 0 }])).toBe(false);
    const one = format({ type: 'pre', offset: 0, length: 4, images: [0] });
    for (const position of [{ offset: 2, imageIndex: 0 }, { offset: 5, imageIndex: 0 }, { offset: -1, imageIndex: 0 },
      { offset: 0.5, imageIndex: 0 }, { offset: 0, imageIndex: 1000 }, { offset: 0, imageIndex: -1 }]) {
      expect(isValidFeedContentFormat(one, 'A\uD83D\uDE00B', [position])).toBe(false);
    }
    expect(isValidFeedContentFormat(value, 'text', positions.toReversed())).toBe(false);
  });
});

describe('RSS structured prefix clipping', () => {
  const content = 'A\uD83D\uDE00B\n  x\n\ty \nHead\tBod\nmore!';
  const positions: FeedImagePosition[] = [0, 4, 4, 10, 13, 17, 17, 21, 27].map(offset => ({ offset, imageIndex: 0 }));
  const value = format({ type: 'heading', offset: 0, length: 4, images: [0, 1], spans: [{ offset: 0, length: 4, type: 'bold' }] },
    { type: 'pre', offset: 4, length: 9, language: 'ts', images: [2, 3, 4] },
    { type: 'table', offset: 13, length: 14, cells: [[
      { offset: 13, length: 4, header: true, spans: [{ offset: 13, length: 4, type: 'marked' }], images: [5] },
      { offset: 17, length: 0, header: true, images: [6] }, { offset: 17, length: 4, images: [7] },
    ], [{ offset: 22, length: 5, images: [8] }]] });

  it('clips pre, tables, styles and images atomically at every UTF16 boundary without owning the ellipsis', () => {
    expect(content).toHaveLength(27);
    expect(isValidFeedContentFormat(value, content, positions)).toBe(true);
    const original = structuredClone(value);
    for (let limit = 0; limit <= content.length + 1; limit++) {
      const end = limit === 2 ? 1 : Math.min(limit, content.length);
      const clipped = clipFeedContentFormat(value, content, positions, limit);
      const retained = positions.filter(position => position.offset <= end);
      expect(isValidFeedContentFormat(clipped, content.slice(0, end), retained), `prefix ${limit}`).toBe(true);
      expect(isValidFeedContentFormat(clipped, content.slice(0, end) + '...', retained), `ellipsis ${limit}`).toBe(true);
      expect(clipped.blocks.every(block => block.offset + block.length <= end)).toBe(true);
    }
    expect(value).toStrictEqual(original);
  });

  it('preserves clipped table headers and zero-length image owners with unchanged occurrence indexes', () => {
    const clipped = clipFeedContentFormat(value, content, positions, 17);
    expect(clipped.blocks[2]).toEqual({ type: 'table', offset: 13, length: 4, cells: [[
      { offset: 13, length: 4, header: true, spans: [{ offset: 13, length: 4, type: 'marked' }], images: [5] },
      { offset: 17, length: 0, header: true, images: [6] }, { offset: 17, length: 0, images: [] },
    ]] });
    expect(clipFeedContentFormat(value, content, positions, 4).blocks[1]).toEqual({ type: 'pre', offset: 4, length: 0, language: 'ts', images: [2] });
    const pre = clipFeedContentFormat(value, content, positions, 10).blocks[1]!;
    expect(content.slice(pre.offset, pre.offset + pre.length)).toBe('\n  x\n\t');
  });

  it('clips nested lists and quotes while removing unreachable blank containers', () => {
    const nested = format({ type: 'blockquote', offset: 0, length: 8, blocks: [
      { type: 'list', offset: 0, length: 8, ordered: true, start: 3, items: [[paragraph(4, 2)], [paragraph(7, 1)]] },
    ] });
    expect(clipFeedContentFormat(nested, 'x'.repeat(8), [], 2)).toEqual(format());
    const clipped = clipFeedContentFormat(nested, 'x'.repeat(8), [], 5);
    expect(clipped).toEqual(format({ type: 'blockquote', offset: 0, length: 5, blocks: [
      { type: 'list', offset: 0, length: 5, ordered: true, start: 3, items: [[paragraph(4, 1)]] },
    ] }));
    expect(isValidFeedContentFormat(clipped, 'xxxxx...')).toBe(true);
  });

  it('keeps a format at the native budget valid when clipping creates an uncovered ellipsis tail', () => {
    const value = format(...tables([64, 64, 64, 64, 64, 64, 1], 1000));
    const content = 'x'.repeat(7000);
    expect(isValidFeedContentFormat(value, content)).toBe(true);
    for (const limit of [0, 1, 999, 1000, 1001, 5999, 6000, 6999]) {
      const clipped = clipFeedContentFormat(value, content, [], limit);
      expect(feedContentFormatSchema.safeParse(clipped).success).toBe(true);
      expect(isValidFeedContentFormat(clipped, content.slice(0, limit) + '...')).toBe(true);
      expect(clipped.blocks.every(block => block.offset + block.length <= limit)).toBe(true);
    }
    expect(clipFeedContentFormat(value, content, [], 6999).blocks).toHaveLength(7);
  });

  it('rejects invalid metadata before truncation could hide it', () => {
    expect(() => clipFeedContentFormat(format(paragraph(0, 10)), 'text', [], 1)).toThrow(RangeError);
    for (const limit of [-1, NaN, Infinity, 0.5]) expect(() => clipFeedContentFormat(format(paragraph()), 'text', [], limit)).toThrow(RangeError);
  });
});
