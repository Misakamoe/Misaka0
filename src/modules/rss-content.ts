import { Parser } from 'htmlparser2';
import type { FeedLink } from './rss-feed.js';
import {
  FEED_FORMAT_MAX_BLOCKS, FEED_FORMAT_MAX_BYTES, FEED_FORMAT_MAX_DEPTH, FEED_FORMAT_MAX_SPANS,
  FEED_FORMAT_MAX_TABLE_CELLS, FEED_FORMAT_MAX_TABLE_COLUMNS, FEED_FORMAT_MAX_TABLE_ROWS,
  isValidFeedContentFormat,
  type FeedContentBlock, type FeedContentFormat, type FeedImagePosition, type FeedStyle, type FeedStyleSpan, type FeedTableCell,
} from './rss-format.js';

interface Anchor { url?: string }
interface Element {
  name: string; children: Node[]; anchor?: Anchor; imageIndex?: number; language?: string;
  align?: 'left' | 'center' | 'right'; unsupportedSpan?: boolean; unsupportedList?: boolean; start?: number;
}
type Node = string | Element;
interface Context { styles: FeedStyle[]; anchor?: Anchor }
type Token = { text: string; context: Context } | { imageIndex: number };
type DraftBlock =
  | { type: 'paragraph' | 'heading' | 'pre'; tokens: Token[]; language?: string }
  | { type: 'table'; cells: { tokens: Token[]; header?: true; align?: 'left' | 'center' | 'right' }[][] }
  | { type: 'list'; items: DraftBlock[][]; ordered?: true; start?: number }
  | { type: 'blockquote'; blocks: DraftBlock[] }
  | { type: 'divider' };

const suppressed = new Set(['script', 'style', 'template', 'iframe', 'object', 'noscript']);
const styles = new Map<string, FeedStyle>([
  ['b', 'bold'], ['strong', 'bold'], ['i', 'italic'], ['em', 'italic'], ['u', 'underline'], ['ins', 'underline'],
  ['s', 'strikethrough'], ['strike', 'strikethrough'], ['del', 'strikethrough'], ['code', 'code'], ['mark', 'marked'],
]);
const structural = new Set(['p', 'div', 'section', 'article', 'header', 'footer', 'main', 'figure', 'figcaption',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'pre', 'table', 'ul', 'ol', 'li', 'blockquote', 'hr']);
const cleanText = (text: string) => text.replace(/\p{Cc}/gu, character => character === '\n' || character === '\t' ? character : '')
  .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
const truncate = (text: string, limit: number) => text.slice(0, Math.max(0, limit)).replace(/[\uD800-\uDBFF]$/, '');
class UnsupportedFormat extends Error {}
export class FeedContentParseError extends Error {
  constructor(readonly code: 'INVALID_FEED' | 'TOO_LARGE') { super(code); }
}

interface FormattedContentOptions {
  limit: number;
  resolveLink: (value: string) => string | undefined;
  findLinks: (content: string, anchors: readonly { offset: number; length: number; url?: string }[]) => FeedLink[];
  image: (source: string, gif: boolean, originalImage: boolean) => number | undefined;
  isGif: (source: string, mime?: string) => boolean;
}

/** Builds only our bounded DTO. No source tag, attribute, or executable Telegram entity is returned. */
export function parseFormattedContent(html: string, options: FormattedContentOptions): {
  content: string; contentLinks: FeedLink[]; imagePositions: FeedImagePosition[]; contentFormat: FeedContentFormat;
} | undefined {
  if (!Number.isSafeInteger(options.limit) || options.limit < 0) return;
  const root: Element = { name: '', children: [] };
  const stack = [root];
  let tags = 0; let ignored = 0; let meaningful = false;
  // Parse the entire bounded source, even after the eventual text limit, to retain all safe media.
  new Parser({
    onopentag(rawName, attributes) {
      const name = rawName.split(':').at(-1)!;
      if (++tags > 20_000 || stack.length > 48) throw new FeedContentParseError('INVALID_FEED');
      const node: Element = { name, children: [] };
      if (suppressed.has(name)) ignored += 1;
      if (!ignored) {
        stack.at(-1)!.children.push(node);
        meaningful ||= styles.has(name) || /^(?:h[1-6]|pre|table|ul|ol|blockquote|hr)$/.test(name);
        if (name === 'a') node.anchor = { url: attributes.href === undefined ? undefined : options.resolveLink(attributes.href) };
        if (attributes.src) {
          const gif = options.isGif(attributes.src, attributes.type);
          if (name === 'img' || gif && (name === 'video' || name === 'source')) node.imageIndex = options.image(attributes.src, gif, name === 'img');
        }
        if (name === 'pre' || name === 'code') {
          node.language = attributes.class?.split(/\s+/).map(value => /^(?:language|lang)-([A-Za-z0-9][A-Za-z0-9_+.-]{0,31})$/.exec(value)?.[1]).find(Boolean);
        }
        if (name === 'td' || name === 'th') {
          node.unsupportedSpan = ['rowspan', 'colspan'].some(key => attributes[key] !== undefined && attributes[key] !== '1');
          const align = attributes.align?.toLowerCase() ?? /(?:^|;)\s*text-align\s*:\s*(left|center|right)\s*(?:;|$)/i.exec(attributes.style ?? '')?.[1]?.toLowerCase();
          if (align === 'left' || align === 'center' || align === 'right') node.align = align;
        }
        if (name === 'ol') {
          node.unsupportedList = attributes.reversed !== undefined;
          if (attributes.start !== undefined) {
            const start = Number(attributes.start);
            if (/^-?\d{1,7}$/.test(attributes.start) && Math.abs(start) <= 1_000_000) node.start = start;
            else node.unsupportedList = true;
          }
        }
        if (name === 'li' && attributes.value !== undefined) node.unsupportedList = true;
      }
      stack.push(node);
    },
    onclosetag(rawName) {
      if (suppressed.has(rawName.split(':').at(-1)!)) ignored = Math.max(0, ignored - 1);
      stack.pop();
    },
    ontext(text) { if (!ignored) stack.at(-1)!.children.push(cleanText(text)); },
  }, { decodeEntities: true, recognizeCDATA: true, recognizeSelfClosing: true }).end(html);
  if (!meaningful) return;

  try {
    let blockCount = 0;
    const counted = <T extends DraftBlock>(block: T, depth: number): T => {
      if (++blockCount > FEED_FORMAT_MAX_BLOCKS || depth > FEED_FORMAT_MAX_DEPTH) throw new UnsupportedFormat();
      return block;
    };
    const contextFor = (node: Element, context: Context): Context => {
      const style = styles.get(node.name);
      return { styles: style && !context.styles.includes(style) ? [...context.styles, style] : context.styles,
        anchor: node.anchor ?? context.anchor };
    };
    const inline = (nodes: Node[], context: Context, pre = false): Token[] => nodes.flatMap((node): Token[] => {
      if (typeof node === 'string') return [{ text: node, context }];
      if (!pre && structural.has(node.name) && !['p', 'div'].includes(node.name)) throw new UnsupportedFormat();
      const next = contextFor(node, context);
      const tokens = inline(node.children, next, pre);
      if (node.imageIndex !== undefined) tokens.unshift({ imageIndex: node.imageIndex });
      if (node.name === 'br') tokens.push({ text: '\n', context });
      if (!pre && ['p', 'div'].includes(node.name)) return [{ text: '\n', context }, ...tokens, { text: '\n', context }];
      return tokens;
    });
    const flow = (nodes: Node[], depth: number, context: Context): DraftBlock[] => {
      const blocks: DraftBlock[] = []; let tokens: Token[] = [];
      const flush = () => {
        if (tokens.some(token => 'imageIndex' in token || token.text.trim())) blocks.push(counted({ type: 'paragraph', tokens }, depth));
        tokens = [];
      };
      const visit = (node: Node, context: Context) => {
        if (typeof node === 'string') { tokens.push({ text: node, context }); return; }
        const next = contextFor(node, context);
        if (node.imageIndex !== undefined) tokens.push({ imageIndex: node.imageIndex });
        if (node.name === 'br') { tokens.push({ text: '\n', context }); return; }
        if (!structural.has(node.name)) { node.children.forEach(child => visit(child, next)); return; }
        flush();
        if (/^h[1-6]$/.test(node.name)) blocks.push(counted({ type: 'heading', tokens: inline(node.children, next) }, depth));
        else if (node.name === 'pre') {
          const code = node.children.find((child): child is Element => typeof child !== 'string' && child.name === 'code');
          blocks.push(counted({ type: 'pre', tokens: inline(node.children, next, true), language: node.language ?? code?.language }, depth));
        } else if (node.name === 'hr') blocks.push(counted({ type: 'divider' }, depth));
        else if (node.name === 'blockquote') blocks.push(counted({ type: 'blockquote', blocks: flow(node.children, depth + 1, next) }, depth));
        else if (node.name === 'ul' || node.name === 'ol') {
          if (node.unsupportedList) throw new UnsupportedFormat();
          const items: DraftBlock[][] = [];
          for (const child of node.children) {
            if (typeof child === 'string' && !child.trim()) continue;
            if (typeof child === 'string' || child.name !== 'li' || child.unsupportedList) throw new UnsupportedFormat();
            const children = flow(child.children, depth + 1, contextFor(child, next));
            items.push(children.length ? children : [counted({ type: 'paragraph', tokens: [] }, depth + 1)]);
          }
          blocks.push(counted({ type: 'list', items, ...(node.name === 'ol' ? { ordered: true, ...(node.start !== undefined ? { start: node.start } : {}) } : {}) }, depth));
        } else if (node.name === 'table') {
          const rows: Element[] = [];
          const collectRows = (children: Node[]) => {
            for (const child of children) {
              if (typeof child === 'string' && !child.trim()) continue;
              if (typeof child === 'string') throw new UnsupportedFormat();
              if (child.name === 'tr') rows.push(child);
              else if (['thead', 'tbody', 'tfoot'].includes(child.name)) collectRows(child.children);
              else throw new UnsupportedFormat();
            }
          };
          collectRows(node.children);
          if (!rows.length || rows.length > FEED_FORMAT_MAX_TABLE_ROWS) throw new UnsupportedFormat();
          const cells = rows.map(row => row.children.flatMap(child => {
            if (typeof child === 'string' && !child.trim()) return [];
            if (typeof child === 'string' || !['td', 'th'].includes(child.name) || child.unsupportedSpan) throw new UnsupportedFormat();
            return [{ tokens: inline(child.children, contextFor(child, next)), ...(child.name === 'th' ? { header: true as const } : {}),
              ...(child.align ? { align: child.align } : {}) }];
          }));
          const columns = Math.max(...cells.map(row => row.length));
          if (!columns || columns > FEED_FORMAT_MAX_TABLE_COLUMNS || columns * cells.length > FEED_FORMAT_MAX_TABLE_CELLS) throw new UnsupportedFormat();
          for (const row of cells) while (row.length < columns) row.push({ tokens: [] });
          blocks.push(counted({ type: 'table', cells }, depth));
        } else node.children.forEach(child => visit(child, next));
        flush();
      };
      nodes.forEach(node => visit(node, context)); flush();
      return blocks;
    };
    const drafts = flow(root.children, 1, { styles: [] });
    let content = ''; let full = false; let spanCount = 0;
    const imagePositions: FeedImagePosition[] = [];
    const anchors: { offset: number; length: number; url?: string }[] = [];
    const blocked: Anchor = {};
    const append = (text: string) => {
      const value = truncate(text, options.limit - content.length);
      content += value;
      if (value.length < text.length) full = true;
    };
    const leaf = (tokens: Token[], pre = false) => {
      const offset = content.length; const anchorStart = anchors.length; let whitespace = ''; let whitespaceStyles: FeedStyle[] = [];
      const spans: FeedStyleSpan[] = []; const images: number[] = [];
      let previous: { key: Anchor; span: (typeof anchors)[number] } | undefined;
      const write = (text: string, gap: string, context: Context) => {
        if (full) return;
        const value = truncate(text, options.limit - content.length - gap.length);
        const cut = value.length < text.length;
        if (!value) {
          if (text) {
            full = true;
            // A style boundary can coincide exactly with the cap in the middle of an authority.
            if (!gap) {
              const tail = /\S+$/.exec(content)?.[0];
              if (tail) anchors.push({ offset: content.length - tail.length, length: tail.length });
            }
          }
          return;
        }
        const before = content.length; const start = before + gap.length;
        content += gap + value; full ||= cut;
        if (!pre) for (const type of context.styles) {
          const last = spans.findLast(span => span.type === type);
          if (last && last.offset + last.length === before && (!gap || whitespaceStyles.includes(type))) last.length = content.length - last.offset;
          else {
            if (++spanCount > FEED_FORMAT_MAX_SPANS) throw new UnsupportedFormat();
            spans.push({ offset: start, length: value.length, type });
          }
        }
        const key = pre || context.styles.includes('code') ? blocked : context.anchor ?? (cut ? blocked : undefined);
        if (key) {
          if (previous?.key === key && previous.span.offset + previous.span.length === before) previous.span.length = content.length - previous.span.offset;
          else {
            const span = { offset: start, length: value.length, ...(key.url ? { url: key.url } : {}) };
            anchors.push(span); previous = { key, span };
          }
        } else previous = undefined;
      };
      for (const token of tokens) {
        if (full) break;
        if ('imageIndex' in token) {
          if (imagePositions.length >= 1000) throw new FeedContentParseError('TOO_LARGE');
          images.push(imagePositions.length);
          imagePositions.push({ offset: content.length, imageIndex: token.imageIndex });
        } else if (pre) write(token.text, '', token.context);
        else for (const [part] of token.text.matchAll(/[ \t]+|\n|[^ \t\n]+/g)) {
          if (full) break;
          if (part === '\n' || /^[ \t]+$/.test(part)) {
            whitespaceStyles = whitespace ? whitespaceStyles.filter(type => token.context.styles.includes(type)) : token.context.styles;
            if (part === '\n') whitespace = '\n'.repeat(Math.min(2, (whitespace.startsWith('\n') ? whitespace.length : 0) + 1));
            else whitespace ||= ' ';
            continue;
          }
          const word = content.length === offset ? part.trimStart() : part;
          if (word) { write(word, content.length > offset ? whitespace : '', token.context); whitespace = ''; }
        }
      }
      // Non-code trailing Unicode spaces follow the legacy cleansing rule without moving an occurrence into a surrogate pair.
      if (!pre) {
        content = content.slice(0, offset) + content.slice(offset).trimEnd();
        for (const image of images) imagePositions[image]!.offset = Math.min(imagePositions[image]!.offset, content.length);
        for (const span of spans) span.length = Math.max(0, Math.min(span.length, content.length - span.offset));
        for (const span of anchors.slice(anchorStart)) span.length = Math.max(0, Math.min(span.length, content.length - span.offset));
      }
      return { offset, length: content.length - offset, ...(spans.some(span => span.length) ? { spans: spans.filter(span => span.length) } : {}),
        ...(images.length ? { images } : {}) };
    };
    const project = (drafts: DraftBlock[]): FeedContentBlock[] => {
      const blocks: FeedContentBlock[] = [];
      for (const draft of drafts) {
        if (full) break;
        if (blocks.length && content.length) append('\n\n');
        if (full) break;
        const offset = content.length;
        if (draft.type === 'paragraph' || draft.type === 'heading' || draft.type === 'pre') {
          const range = leaf(draft.tokens, draft.type === 'pre');
          if (draft.type === 'pre') blocks.push({ type: 'pre', offset: range.offset, length: range.length,
            ...(draft.language ? { language: draft.language } : {}), ...(range.images ? { images: range.images } : {}) });
          else blocks.push({ type: draft.type, ...range });
        } else if (draft.type === 'divider') blocks.push({ type: 'divider', offset, length: 0 });
        else if (draft.type === 'blockquote') {
          const children = project(draft.blocks);
          blocks.push({ type: 'blockquote', offset, length: content.length - offset, blocks: children });
        } else if (draft.type === 'list') {
          const items: FeedContentBlock[][] = [];
          for (const item of draft.items) {
            if (full) break;
            if (items.length && content.length > offset) append('\n');
            if (full) break;
            items.push(project(item));
          }
          blocks.push({ type: 'list', offset, length: content.length - offset, items,
            ...(draft.ordered ? { ordered: true, ...(draft.start !== undefined ? { start: draft.start } : {}) } : {}) });
        } else if (draft.type === 'table') {
          const cells: FeedTableCell[][] = [];
          for (const row of draft.cells) {
            if (full) break;
            if (cells.length) append('\n');
            if (full) break;
            const result: FeedTableCell[] = [];
            for (const cell of row) {
              if (result.length && !full) append('\t');
              const range = leaf(full ? [] : cell.tokens);
              result.push({ ...range, ...(cell.header ? { header: cell.header } : {}), ...(cell.align ? { align: cell.align } : {}) });
            }
            cells.push(result);
          }
          blocks.push({ type: 'table', offset, length: content.length - offset, cells });
        }
      }
      return blocks;
    };
    const contentFormat: FeedContentFormat = { version: 1, blocks: project(drafts) };
    const hasFormat = (blocks: FeedContentBlock[]): boolean => blocks.some(block => block.type !== 'paragraph' || !!block.spans?.length);
    if (!hasFormat(contentFormat.blocks) || Buffer.byteLength(JSON.stringify(contentFormat)) > FEED_FORMAT_MAX_BYTES
      || !isValidFeedContentFormat(contentFormat, content, imagePositions)) return;
    const boundedAnchors = anchors.map(span => ({ ...span, length: Math.min(span.length, content.length - span.offset) })).filter(span => span.length > 0);
    return { content, contentLinks: options.findLinks(content, boundedAnchors), imagePositions, contentFormat };
  } catch (error) { if (!(error instanceof UnsupportedFormat)) throw error; return; }
}
