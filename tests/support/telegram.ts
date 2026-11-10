import type { InlineKeyboardButton, Message, RichMessageButton } from 'grammy/types';

// Project body text only; button labels are not part of a message's body.
export function richText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(richText).join('');
  if (value && typeof value === 'object') {
    if ('rich_message' in value && value.rich_message) return richText(value.rich_message);
    if ('type' in value && (value.type === 'buttons' || value.type === 'button')) return '';
    if ('blocks' in value && Array.isArray(value.blocks)) return value.blocks
      .filter(block => block?.type !== 'buttons').map(richText).join('\n\n');
    if ('text' in value) return richText(value.text);
    if ('markdown' in value) return richText(value.markdown);
  }
  return '';
}

export function recordContent(message: Message, payload: Record<string, unknown>): void {
  if (payload.rich_message) {
    Object.assign(message, { rich_message: structuredClone(payload.rich_message) });
    delete message.text;
    delete message.entities;
  } else {
    delete message.rich_message;
    Object.assign(message, { text: payload.text, entities: payload.entities });
  }
}

export function telegramMessage(message: Message): Message {
  const result = structuredClone(message);
  if (result.rich_message) {
    delete result.text;
    delete result.entities;
  }
  return result;
}

export function liveCallbacks(message: Message): string[] {
  return callbacks(message).filter(data => data.startsWith('mk:ui:'));
}

export function buttonRows(message: Message): (RichMessageButton | InlineKeyboardButton)[][] {
  const native = message.rich_message?.blocks.flatMap(block => block.type === 'buttons' ? [block.buttons] : []) ?? [];
  return [...native, ...message.reply_markup?.inline_keyboard ?? []];
}

export function callbacks(message: Message): string[] {
  return buttonRows(message).flatMap(row => row.flatMap(button => 'callback_data' in button ? [button.callback_data] : []));
}
