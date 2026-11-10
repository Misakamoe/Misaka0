import { z } from 'zod';

export const FEED_FORMAT_MAX_BYTES = 64 * 1024;
export const FEED_FORMAT_MAX_BLOCKS = 128;
export const FEED_FORMAT_MAX_NATIVE_BLOCKS = 400;
export const FEED_FORMAT_MAX_SPANS = 1024;
export const FEED_FORMAT_MAX_DEPTH = 4;
export const FEED_FORMAT_MAX_TABLE_ROWS = 64;
export const FEED_FORMAT_MAX_TABLE_COLUMNS = 16;
export const FEED_FORMAT_MAX_TABLE_CELLS = 512;

export type FeedStyle = 'bold' | 'italic' | 'underline' | 'strikethrough' | 'code' | 'marked';
export interface FeedStyleSpan { offset: number; length: number; type: FeedStyle }
export interface FeedRange { offset: number; length: number }
export interface FeedImagePosition { offset: number; imageIndex: number }
export interface FeedTextRange extends FeedRange {
  spans?: FeedStyleSpan[];
  /** Occurrence indexes in imagePositions, not indexes in the image manifest. */
  images?: number[];
}
export interface FeedTableCell extends FeedTextRange {
  header?: true;
  align?: 'left' | 'center' | 'right';
}
export type FeedContentBlock =
  | (FeedTextRange & { type: 'paragraph' | 'heading' })
  | (FeedRange & { type: 'pre'; language?: string; images?: number[] })
  | (FeedRange & { type: 'table'; cells: FeedTableCell[][] })
  | (FeedRange & { type: 'list'; items: FeedContentBlock[][]; ordered?: true; start?: number })
  | (FeedRange & { type: 'blockquote'; blocks: FeedContentBlock[] })
  | { type: 'divider'; offset: number; length: 0 };
export interface FeedContentFormat { version: 1; blocks: FeedContentBlock[] }

const coordinate = z.number().int().min(0).max(12_000);
const range = { offset: coordinate, length: coordinate };
const images = z.array(z.number().int().min(0).max(999)).max(1000).optional();
const spans = z.array(z.strictObject({ ...range, length: coordinate.positive(),
  type: z.enum(['bold', 'italic', 'underline', 'strikethrough', 'code', 'marked']),
})).max(FEED_FORMAT_MAX_SPANS).optional();
const textRange = { ...range, images, spans };
const cellSchema = z.strictObject({ ...textRange, header: z.literal(true).optional(), align: z.enum(['left', 'center', 'right']).optional() });

function blockSchema(depth: number): z.ZodType<FeedContentBlock> {
  const children = z.array(depth < FEED_FORMAT_MAX_DEPTH ? blockSchema(depth + 1) : z.never()).max(FEED_FORMAT_MAX_BLOCKS);
  return z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('paragraph'), ...textRange }),
    z.strictObject({ type: z.literal('heading'), ...textRange }),
    z.strictObject({ type: z.literal('pre'), ...range, images, language: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/).optional() }),
    z.strictObject({ type: z.literal('table'), ...range,
      cells: z.array(z.array(cellSchema).min(1).max(FEED_FORMAT_MAX_TABLE_COLUMNS)).min(1).max(FEED_FORMAT_MAX_TABLE_ROWS),
    }),
    z.strictObject({ type: z.literal('list'), ...range, items: z.array(children.min(1)).min(1).max(FEED_FORMAT_MAX_BLOCKS),
      ordered: z.literal(true).optional(), start: z.number().int().min(-1_000_000).max(1_000_000).optional(),
    }),
    z.strictObject({ type: z.literal('blockquote'), ...range, blocks: children.min(1) }),
    z.strictObject({ type: z.literal('divider'), offset: coordinate, length: z.literal(0) }),
  ]);
}

// Reject excessive or cyclic input before Zod descends into arrays or recursive blocks.
function boundedMetadata(value: unknown): boolean {
  let bytes = 0;
  const visit = (value: unknown, depth: number): boolean => {
    if (depth > FEED_FORMAT_MAX_DEPTH * 3 + 4) return false;
    if (value === undefined) return true;
    if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
      if (typeof value === 'string' && value.length > FEED_FORMAT_MAX_BYTES || typeof value === 'number' && !Number.isFinite(value)) return false;
      bytes += Buffer.byteLength(JSON.stringify(value));
    } else if (Array.isArray(value)) {
      if (value.length > Math.max(FEED_FORMAT_MAX_SPANS, 1000)) return false;
      bytes += 2 + Math.max(0, value.length - 1);
      for (const child of value) if (bytes > FEED_FORMAT_MAX_BYTES || !visit(child, depth + 1)) return false;
    } else if (typeof value === 'object') {
      if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
      const keys = Object.keys(value);
      if (keys.length > 8) return false;
      bytes += 2;
      let count = 0;
      for (const key of keys) {
        const child: unknown = (value as Record<string, unknown>)[key];
        if (child === undefined) continue;
        if (key.length > FEED_FORMAT_MAX_BYTES) return false;
        bytes += Buffer.byteLength(JSON.stringify(key)) + 1 + (count++ ? 1 : 0);
        if (bytes > FEED_FORMAT_MAX_BYTES || !visit(child, depth + 1)) return false;
      }
    } else return false;
    return bytes <= FEED_FORMAT_MAX_BYTES;
  };
  return visit(value, 0);
}

export const feedContentFormatSchema: z.ZodType<FeedContentFormat> = z.unknown().refine(boundedMetadata, 'RSS format exceeds metadata bounds')
  .pipe(z.strictObject({ version: z.literal(1), blocks: z.array(blockSchema(1)).max(FEED_FORMAT_MAX_BLOCKS) }))
  .refine(format => {
    let blocks = 0; let styles = 0; let nativeBlocks = 0;
    const visit = (block: FeedContentBlock): boolean => {
      if (++blocks > FEED_FORMAT_MAX_BLOCKS) return false;
      nativeBlocks += 1;
      if ('spans' in block) styles += block.spans?.length ?? 0;
      if (block.type === 'table') {
        if (block.cells.length * Math.max(...block.cells.map(row => row.length)) > FEED_FORMAT_MAX_TABLE_CELLS) return false;
        nativeBlocks += block.cells.length;
        for (const row of block.cells) for (const cell of row) styles += cell.spans?.length ?? 0;
      }
      if (block.type === 'list') nativeBlocks += block.items.length;
      if (block.type === 'pre' && block.images?.length) nativeBlocks += 1;
      if (styles > FEED_FORMAT_MAX_SPANS || nativeBlocks > FEED_FORMAT_MAX_NATIVE_BLOCKS) return false;
      if (block.type === 'list') return (block.start === undefined || block.ordered === true) && block.items.every(visitGroup);
      return block.type !== 'blockquote' || visitGroup(block.blocks);
    };
    const visitGroup = (group: FeedContentBlock[]): boolean => {
      // Reserve every possible gap/tail paragraph, including a later clipping ellipsis.
      // The remaining 100 native blocks cover media and the message's surrounding UI.
      nativeBlocks += group.length + 1;
      return nativeBlocks <= FEED_FORMAT_MAX_NATIVE_BLOCKS && group.every(visit);
    };
    return visitGroup(format.blocks);
  }, 'RSS format exceeds block, style, table or native expansion bounds');

function boundary(content: string, offset: number): boolean {
  return !(/[\uD800-\uDBFF]/.test(content.charAt(offset - 1)) && /[\uDC00-\uDFFF]/.test(content.charAt(offset)));
}

export function isValidFeedContentFormat(format: FeedContentFormat, content: string, positions: readonly FeedImagePosition[] = []): boolean {
  if (!feedContentFormatSchema.safeParse(format).success || content.length > 12_000 || positions.length > 1000) return false;
  if (!positions.every((position, index) => Number.isInteger(position.offset) && position.offset >= 0 && position.offset <= content.length
    && Number.isInteger(position.imageIndex) && position.imageIndex >= 0 && position.imageIndex < 1000
    && (index === 0 || positions[index - 1]!.offset <= position.offset) && boundary(content, position.offset))) return false;
  const validRange = (range: FeedRange, parent: FeedRange): boolean => range.offset >= parent.offset
    && range.offset + range.length <= parent.offset + parent.length && boundary(content, range.offset) && boundary(content, range.offset + range.length);
  let occurrence = 0;
  const leaf = (range: FeedTextRange): boolean => (range.spans ?? []).every(span => validRange(span, range))
    && (range.images ?? []).every(index => index === occurrence++ && index < positions.length
      && positions[index]!.offset >= range.offset && positions[index]!.offset <= range.offset + range.length);
  const visit = (blocks: FeedContentBlock[], parent: FeedRange): boolean => {
    let end = parent.offset;
    for (const block of blocks) {
      if (block.offset < end || !validRange(block, parent)) return false;
      end = block.offset + block.length;
      if (block.type === 'list') { if (!visit(block.items.flat(), block)) return false; }
      else if (block.type === 'blockquote') { if (!visit(block.blocks, block)) return false; }
      else if (block.type === 'table') {
        let cellEnd = block.offset;
        for (const row of block.cells) for (const cell of row) {
          if (cell.offset < cellEnd || !validRange(cell, block) || /\S/.test(content.slice(cellEnd, cell.offset)) || !leaf(cell)) return false;
          cellEnd = cell.offset + cell.length;
        }
        if (/\S/.test(content.slice(cellEnd, end))) return false;
      } else if (block.type !== 'divider' && !leaf(block)) return false;
    }
    return true;
  };
  return visit(format.blocks, { offset: 0, length: content.length }) && occurrence === positions.length;
}

export function clipFeedContentFormat(format: FeedContentFormat, content: string, positions: readonly FeedImagePosition[], limit: number): FeedContentFormat {
  if (!Number.isInteger(limit) || limit < 0 || !isValidFeedContentFormat(format, content, positions)) throw new RangeError('Invalid RSS format clipping input');
  let end = Math.min(limit, content.length);
  if (!boundary(content, end)) end -= 1;
  const clipLeaf = <T extends FeedTextRange>(leaf: T): T => ({ ...leaf, length: Math.min(leaf.length, end - leaf.offset),
    ...(leaf.spans ? { spans: leaf.spans.filter(span => span.offset < end)
      .map(span => ({ ...span, length: Math.min(span.length, end - span.offset) })) } : {}),
    ...(leaf.images ? { images: leaf.images.filter(index => positions[index]!.offset <= end) } : {}),
  });
  const clip = (blocks: FeedContentBlock[]): FeedContentBlock[] => blocks.flatMap((block): FeedContentBlock[] => {
    if (block.offset > end) return [];
    const length = Math.min(block.length, end - block.offset);
    if (block.type === 'list') {
      const items = block.items.map(clip).filter(item => item.length);
      return items.length ? [{ ...block, length, items }] : [];
    }
    if (block.type === 'blockquote') {
      const children = clip(block.blocks);
      return children.length ? [{ ...block, length, blocks: children }] : [];
    }
    if (block.type === 'table') {
      // Keep original empty/header cells and the retained part of the last row; never synthesize ranges for padding.
      const cells = block.cells.map(row => row.filter(cell => cell.offset <= end).map(clipLeaf)).filter(row => row.length);
      return cells.length ? [{ ...block, length, cells }] : [];
    }
    if (block.type === 'divider') return [{ ...block }];
    const leaf = clipLeaf(block);
    return length || block.length === 0 || leaf.images?.length ? [leaf] : [];
  });
  return { version: 1, blocks: clip(format.blocks) };
}
