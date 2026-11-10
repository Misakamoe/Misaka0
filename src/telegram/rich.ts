import type { InlineKeyboardMarkup, InputRichBlockButtons, InputRichBlockParagraph, MessageEntity, RichMessageButton, RichText } from 'grammy/types';
import { AppError } from '../errors.js';

// Use only on trusted command labels or UI copy, never arbitrary user text.
export function commandEntities(text: string, offset = 0): MessageEntity[] {
  return Array.from(text.matchAll(/\/[\p{L}\p{N}\p{M}_]+/gu), match => ({
    type: 'bot_command', offset: offset + match.index, length: match[0].length,
  }));
}

// Convert only ordinary controls. Preserve an entire special keyboard instead of changing its semantics.
export function richButtonRows(keyboard: InlineKeyboardMarkup): RichMessageButton[][] | undefined {
  if (keyboard.force_reply !== undefined) return undefined;
  const rows: RichMessageButton[][] = [];
  for (const row of keyboard.inline_keyboard) {
    if (row.length > 8) return undefined;
    const buttons: RichMessageButton[] = [];
    for (const button of row) {
      if (button.icon_custom_emoji_id !== undefined) return undefined;
      if (!('callback_data' in button || 'url' in button || 'disabled' in button || 'copy_text' in button)) return undefined;
      buttons.push({ ...button });
    }
    if (buttons.length) rows.push(buttons);
  }
  return rows;
}

// Compose native inline objects; dynamic text is never parsed as Markdown/HTML.
export function panelContent(text: string, entities: readonly MessageEntity[] = [], buttonRows: readonly (readonly RichMessageButton[])[] = [], buttonRowLabels: Readonly<Record<number, RichText>> = {}) {
  const ranges = [...entities];
  let start = 0;
  for (const paragraph of text.split('\n\n')) {
    const length = paragraph.indexOf('\n') < 0 ? paragraph.length : paragraph.indexOf('\n');
    if (length && !ranges.some(range => range.offset < start + length && range.offset + range.length > start)) {
      ranges.push({ type: 'bold', offset: start, length });
    }
    start += paragraph.length + 2;
  }
  ranges.sort((left, right) => left.offset - right.offset);
  const content: RichText[] = [];
  let cursor = 0;
  for (const entity of ranges) {
    if (!Number.isSafeInteger(entity.offset) || !Number.isSafeInteger(entity.length) || entity.offset < cursor
      || entity.length < 1 || entity.offset + entity.length > text.length) throw new AppError('INVALID_OUTPUT');
    if (entity.offset > cursor) content.push(text.slice(cursor, entity.offset));
    const value = text.slice(entity.offset, entity.offset + entity.length);
    switch (entity.type) {
      case 'bold': case 'italic': case 'code': content.push({ type: entity.type, text: value }); break;
      case 'bot_command': content.push({ type: 'bot_command', text: value, bot_command: value.slice(1) }); break;
      case 'date_time': content.push({ type: 'date_time', text: value, unix_time: entity.unix_time, date_time_format: entity.date_time_format }); break;
      default: throw new AppError('INVALID_OUTPUT');
    }
    cursor = entity.offset + entity.length;
  }
  if (cursor < text.length) content.push(text.slice(cursor));
  // Telegram rebuilds command entities from text, even when explicit objects are supplied.
  // Only trusted command UI opts in; panels containing arbitrary user text keep detection off.
  const blocks: [InputRichBlockParagraph, ...(InputRichBlockParagraph | InputRichBlockButtons)[]] = [
    { type: 'paragraph', text: content },
    ...buttonRows.flatMap((row, index): (InputRichBlockParagraph | InputRichBlockButtons)[] => {
      if (!row.length) return [];
      if (row.length > 8) throw new AppError('INVALID_OUTPUT');
      const label = buttonRowLabels[index];
      return [
        ...(label ? [{ type: 'paragraph' as const, text: label }] : []),
        // Omitting align requests equal-width stretch; explicit alignment uses natural button widths.
        { type: 'buttons', buttons: [...row] },
      ];
    }),
  ];
  return { blocks, skip_entity_detection: !entities.some(entity => entity.type === 'bot_command') };
}
