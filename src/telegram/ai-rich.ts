import type { InputRichMessageWithoutUpload, RichText } from 'grammy/types';
import { parser, RuleType, type MarkdownToJSX } from 'markdown-to-jsx/markdown';
import { aiOutputTextLimits } from '../../shared/schemas/ai.js';
import { AppError } from '../errors.js';

type Blocks = NonNullable<InputRichMessageWithoutUpload['blocks']>;
type AnswerContent = { blocks: Blocks; skip_entity_detection: true };

function linkUrl(target: string | null): string | undefined {
  if (!target || target.length > 2048 || !/^https?:\/\//i.test(target)
    || /[\p{Cc}\p{Cf}\s\\]/u.test(target) || /%(?:0[\da-f]|1[\da-f]|7f)/i.test(target)
    || /^https?:\/\/[^/?#]*@/i.test(target)) return;
  try {
    const url = new URL(target);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && url.hostname && !url.username && !url.password) return target;
  } catch { /* Invalid targets are displayed without a link. */ }
}

// Only AI-model output belongs here; panels and RSS have separate rendering policies.
export function aiAnswerContent(text: string): AnswerContent {
  if (typeof text !== 'string') throw new AppError('INVALID_OUTPUT');
  if (text.length > aiOutputTextLimits.characters || Buffer.byteLength(JSON.stringify(text)) > aiOutputTextLimits.bytes) {
    throw new AppError('AI_OUTPUT_LIMIT');
  }
  const literal: AnswerContent = { blocks: [{ type: 'paragraph', text }], skip_entity_detection: true };

  let nodes = 0;
  let blocks = 0;
  let characters = 0;
  const leaf = (value: string) => {
    // Reused image references can expand their visible URL labels beyond the source length.
    characters += value.length;
    if (characters > aiOutputTextLimits.characters) throw new Error('Expanded text fallback');
    return value;
  };
  const take = (depth: number, blockCount = 0) => {
    nodes++;
    blocks += blockCount;
    if (depth > 12 || nodes > 2048 || blocks > 480) throw new Error('Literal fallback');
  };
  const joined = (parts: RichText[]): RichText => {
    const result: RichText[] = [];
    const append = (part: RichText) => {
      if (Array.isArray(part)) { part.forEach(append); return; }
      const last = result.at(-1);
      if (typeof part === 'string' && typeof last === 'string') result[result.length - 1] = last + part;
      else result.push(part);
    };
    parts.forEach(append);
    return result.length === 1 ? result[0]! : result.length ? result : '';
  };
  const inline = (ast: MarkdownToJSX.ASTNode[], depth: number): RichText => joined(ast.map(node => {
    take(depth);
    switch (node.type) {
      case RuleType.text: return leaf(node.text);
      case RuleType.breakLine: return leaf('\n');
      case RuleType.codeInline:
        take(depth + 1);
        return { type: 'code', text: leaf(node.text) };
      case RuleType.gfmTask: return leaf(node.completed ? '[x]' : '[ ]');
      case RuleType.textFormatted: {
        const type = node.tag === 'strong' ? 'bold' : node.tag === 'em' ? 'italic'
          : node.tag === 'del' ? 'strikethrough' : node.tag === 'mark' ? 'marked' : undefined;
        if (!type) throw new Error('Unsupported style');
        return { type, text: inline(node.children, depth + 1) };
      }
      case RuleType.link: {
        const value = inline(node.children, depth + 1);
        const url = linkUrl(node.target);
        return url ? { type: 'url', text: value, url } : value;
      }
      case RuleType.image: {
        const value = leaf(node.alt || node.target || '');
        if (!value) throw new Error('Missing image text');
        const url = linkUrl(node.target);
        take(depth + 1);
        return url ? { type: 'url', text: value, url } : value;
      }
      default: throw new Error('Unsupported inline syntax');
    }
  }));
  const render = (ast: MarkdownToJSX.ASTNode[], depth: number): Blocks => {
    const result: Blocks = [];
    let pending: MarkdownToJSX.ASTNode[] = [];
    const flush = () => {
      if (!pending.length) return;
      take(depth, 1);
      result.push({ type: 'paragraph', text: inline(pending, depth + 1) });
      pending = [];
    };
    for (const node of ast) {
      switch (node.type) {
        case RuleType.paragraph: case RuleType.heading:
          flush();
          take(depth, 1);
          if (node.type === RuleType.heading) take(depth + 1);
          result.push({ type: 'paragraph', text: node.type === RuleType.heading
            ? { type: 'bold', text: inline(node.children, depth + 2) } : inline(node.children, depth + 1) });
          break;
        case RuleType.codeBlock:
          flush();
          if (!node.text) throw new Error('Empty code block');
          take(depth, 1);
          take(depth + 1);
          result.push({ type: 'pre', text: leaf(node.text),
            ...(node.lang && /^[A-Za-z0-9][A-Za-z0-9_+.-]{0,63}$/.test(node.lang) ? { language: node.lang } : {}) });
          break;
        case RuleType.breakThematic:
          flush();
          take(depth, 1);
          result.push({ type: 'divider' });
          break;
        case RuleType.blockQuote:
          flush();
          take(depth, 1);
          if (node.alert) throw new Error('Unsupported alert');
          result.push({ type: 'blockquote', blocks: render(node.children, depth + 1) });
          break;
        case RuleType.orderedList: case RuleType.unorderedList: {
          flush();
          take(depth, 1);
          const start = node.type === RuleType.orderedList ? node.start ?? 1 : undefined;
          if (start !== undefined && (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(start + node.items.length))) {
            throw new Error('Unsupported list numbering');
          }
          result.push({ type: 'list', items: node.items.map((item, index) => {
            take(depth + 1, 1);
            return { blocks: render(item, depth + 2), ...(start === undefined ? {} : { type: '1' as const, value: start + index }) };
          }) });
          break;
        }
        case RuleType.table: {
          flush();
          take(depth, 1);
          const columns = node.header.length;
          if (!columns || columns > 20) throw new Error('Unsupported table width');
          result.push({ type: 'table', is_bordered: true, is_compact: true,
            cells: [node.header, ...node.cells].map((row, rowIndex) => {
              take(depth + 1, 1);
              if (row.length > columns) throw new Error('Unsupported table width');
              return Array.from({ length: columns }, (_, column) => {
                take(depth + 2);
                return { text: inline(row[column] ?? [], depth + 3), align: node.align[column] ?? 'left', valign: 'top' as const,
                  ...(rowIndex === 0 ? { is_header: true as const } : {}) };
              });
            }) });
          break;
        }
        case RuleType.refCollection:
          take(depth);
          if (Object.keys(node.refs).some(key => key.startsWith('^'))) throw new Error('Unsupported footnotes');
          break;
        default: pending.push(node);
      }
    }
    flush();
    return result;
  };

  try {
    const ast = parser(text, {
      disableParsingRawHTML: true, disableAutoLink: true, disableFrontmatter: true,
      evalUnserializableExpressions: false, optimizeForStreaming: false, forceBlock: true,
    });
    const content: AnswerContent = { blocks: render(ast, 1), skip_entity_detection: true };
    if (!content.blocks.length || Buffer.byteLength(JSON.stringify(content)) > 128 * 1024) return literal;
    return content;
  } catch {
    return literal;
  }
}
