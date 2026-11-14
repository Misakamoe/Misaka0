import { describe, expect, it } from 'vitest';
import { InlineKeyboard } from 'grammy';
import type { Message, MessageEntity, RichMessageButton } from 'grammy/types';
import { commandEntities, panelContent, richButtonRows } from '../src/telegram/rich.js';
import { helpMarkdown } from '../src/telegram/commands.js';
import { modules } from '../src/modules/index.js';
import { buttonRows, callbacks, liveCallbacks, recordContent, richText, telegramMessage } from './support/telegram.js';

describe('literal native panel content', () => {
  it('converts ordinary keyboard rows without changing labels, callbacks, styles or copy text', () => {
    const keyboard = new InlineKeyboard().disabled('Personal settings').row()
      .text('English', 'lang:en').primary().text('Remove', 'remove').danger().row()
      .url('Website', 'https://example.com').row().copyText('Copy', 'literal copied text');
    const rows = richButtonRows(keyboard);
    expect(rows).toEqual(keyboard.inline_keyboard);
    expect(rows).not.toBe(keyboard.inline_keyboard);
    expect(rows?.[1]?.[0]).not.toBe(keyboard.inline_keyboard[1]?.[0]);
    expect(panelContent('Settings', [], rows).blocks.slice(1)).toEqual(rows?.map(buttons => ({ type: 'buttons', buttons })));
  });

  it.each([
    { text: 'App', web_app: { url: 'https://example.com/app' } },
    { text: 'Login', login_url: { url: 'https://example.com/login', bot_username: 'another_bot' } },
    { text: 'Inline', switch_inline_query: 'query' },
    { text: 'This chat', switch_inline_query_current_chat: 'query' },
    { text: 'Choose chat', switch_inline_query_chosen_chat: { query: 'query' } },
    { text: 'Game', callback_game: {} },
    { text: 'Pay', pay: true },
    { text: 'Icon', callback_data: 'icon', icon_custom_emoji_id: '123' },
  ])('leaves the whole special keyboard external for $text rather than converting only some rows', special => {
    const keyboard = { inline_keyboard: [[{ text: 'Ordinary', callback_data: 'ordinary' }], [special]] };
    const before = structuredClone(keyboard);
    expect(richButtonRows(keyboard)).toBeUndefined();
    expect(keyboard).toEqual(before);
  });

  it('preserves force-reply metadata and oversized rows instead of dropping or splitting them', () => {
    const row = [{ text: 'Reply', callback_data: 'reply' }];
    for (const force_reply of [false, true]) expect(richButtonRows({ inline_keyboard: [row], force_reply })).toBeUndefined();
    expect(richButtonRows({ inline_keyboard: [Array.from({ length: 9 }, (_, index) => ({ text: String(index), callback_data: String(index) }))] })).toBeUndefined();
    expect(richButtonRows({ inline_keyboard: [[], row, []] })).toEqual([row]);
    expect(richButtonRows({ inline_keyboard: [[]] })).toEqual([]);
  });

  it('uses default full-width button rows while preserving paragraph zero and body text', () => {
    const text = 'Sticker conversion\nStatic sticker';
    const rows: RichMessageButton[][] = [
      [{ text: 'Image / Animation', callback_data: 'mk:ui:k:example:0:stmode:media', style: 'primary' },
        { text: 'File', callback_data: 'mk:ui:k:example:0:stmode:file' }],
      [{ text: 'Sticker pack', url: 'https://t.me/addstickers/Example_pack' }],
    ];
    const original = structuredClone(rows);
    const content = panelContent(text, [], [[], ...rows, []]);
    expect(content.blocks).toEqual([
      panelContent(text).blocks[0],
      ...rows.map(buttons => ({ type: 'buttons', buttons })),
    ]);
    expect(content.blocks[0].text).toEqual(panelContent(text).blocks[0].text);
    expect(richText(content)).toBe(text);
    expect(JSON.stringify(content)).not.toMatch(/"size":|"type":"(?:heading|button)"/);
    expect(rows).toEqual(original);
    expect(panelContent(text, [], [[], []])).toEqual(panelContent(text));
  });

  it('accepts eight buttons in a row and rejects more instead of sending an invalid block', () => {
    const row = Array.from({ length: 8 }, (_, index) => ({ text: String(index), callback_data: `pick:${index}` }));
    expect(panelContent('Options', [], [row]).blocks[1]).toEqual({ type: 'buttons', buttons: row });
    expect(() => panelContent('Options', [], [[...row, { text: 'Extra', callback_data: 'pick:8' }]]))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it('places a literal label immediately before its nonempty button row', () => {
    const modes = [{ text: 'Send media', callback_data: 'mode:media' }];
    const formats = [{ text: 'PNG', callback_data: 'format:png' }, { text: 'JPG', callback_data: 'format:jpg' }];
    const content = panelContent('Sticker conversion', [], [modes, [], formats], { 1: 'Hidden:', 2: 'Format:' });
    expect(content.blocks).toEqual([
      panelContent('Sticker conversion').blocks[0],
      { type: 'buttons', buttons: modes },
      { type: 'paragraph', text: 'Format:' },
      { type: 'buttons', buttons: formats },
    ]);
    expect(JSON.stringify(content)).not.toContain('Hidden:');
    expect(JSON.stringify(content)).not.toMatch(/"type":"(?:heading|button)"/);
  });

  it('preserves a native marked label directly before the final format row', () => {
    const rows = [
      [{ text: 'As media', callback_data: 'mode:media' }],
      [{ text: 'Original file', callback_data: 'original' }],
      [{ text: 'PNG', callback_data: 'format:png' }, { text: 'JPG', callback_data: 'format:jpg' }],
    ];
    const label = [{ type: 'marked' as const, text: 'Choose format' }, ':'];
    const content = panelContent('Sticker conversion', [], rows, { 2: label });
    expect(content.blocks.slice(-2)).toEqual([
      { type: 'paragraph', text: label },
      { type: 'buttons', buttons: rows[2] },
    ]);
    expect(richText(content)).toBe('Sticker conversion\n\nChoose format:');
  });

  it('omits alignment for mixed button types and unequal labels, including single-button rows', () => {
    const rows: RichMessageButton[][] = [
      [{ text: 'Short', url: 'https://example.com/' }, { text: 'A much longer callback label', callback_data: 'choose' }],
      [{ text: 'Open', callback_data: 'open', style: 'primary' }],
    ];
    const content = panelContent('Default stretched controls', [], rows);
    expect(content.blocks.slice(1)).toEqual(rows.map(buttons => ({ type: 'buttons', buttons })));
    for (const block of content.blocks.slice(1)) expect(block).not.toHaveProperty('align');
  });

  it('records rich payloads without synthetic server fields and extracts both button representations', () => {
    const message = { message_id: 42, date: 100, chat: { id: 10, type: 'private', first_name: 'User' },
      text: 'Old body', entities: [{ type: 'bold', offset: 0, length: 3 }] } as Message;
    const native = { text: ['Convert'], callback_data: 'mk:ui:k:example:0:stformat:png' };
    const payload = { rich_message: panelContent('Body only', [], [[native]]) };
    const original = structuredClone(payload);
    recordContent(message, payload);
    expect(message.rich_message).toEqual(original.rich_message);
    expect(message.rich_message).not.toBe(payload.rich_message);
    expect(message).not.toHaveProperty('text');
    expect(message).not.toHaveProperty('entities');
    expect(message).not.toHaveProperty('reply_markup');
    expect(richText(message)).toBe('Body only');
    expect(buttonRows(message)).toEqual([[native]]);
    const legacy = { text: 'Reopen', callback_data: 'mk:open:k:10' };
    message.reply_markup = { inline_keyboard: [[legacy]] };
    expect(buttonRows(message)).toEqual([[native], [legacy]]);
    expect(callbacks(message)).toEqual([native.callback_data, legacy.callback_data]);
    expect(liveCallbacks(message)).toEqual([native.callback_data]);
    const incoming = telegramMessage(message);
    expect(incoming).toEqual(message);
    expect(incoming.rich_message).not.toBe(message.rich_message);
    expect(payload).toEqual(original);
    recordContent(message, { text: 'Plain body', entities: [] });
    expect(message).not.toHaveProperty('rich_message');
    expect(richText(message)).toBe('Plain body');
  });

  it('keeps hostile HTML, Markdown, URLs and command mentions literal without entity detection', () => {
    const hostile = '<b>name</b> **bold** [click](https://evil.test) @admin /help # title';
    const text = `Groups\n${hostile}\n\nNext section\n${hostile}`;
    const content = panelContent(text);
    expect(content).toEqual({ blocks: [{ type: 'paragraph', text: [
      { type: 'bold', text: 'Groups' }, `\n${hostile}\n\n`, { type: 'bold', text: 'Next section' }, `\n${hostile}`,
    ] }], skip_entity_detection: true });
    expect(richText(content)).toBe(text);
    expect(content).not.toHaveProperty('markdown');
    expect(content.blocks.every(block => block.type === 'paragraph')).toBe(true);
  });

  it('maps sorted UTF-16 ranges to literal code, emphasis and native date/time', () => {
    const text = 'Header\n\u{1f680} command at 2026-11-08';
    const entities: MessageEntity[] = [
      { type: 'date_time', offset: 21, length: 10, unix_time: 1794096000, date_time_format: 'Dt' },
      { type: 'code', offset: 7, length: 2 },
      { type: 'italic', offset: 10, length: 7 },
    ];
    const before = structuredClone(entities);
    const content = panelContent(text, entities);
    expect(content.blocks[0]!.text).toEqual([
      { type: 'bold', text: 'Header' }, '\n', { type: 'code', text: '\u{1f680}' }, ' ',
      { type: 'italic', text: 'command' }, ' at ',
      { type: 'date_time', text: '2026-11-08', unix_time: 1794096000, date_time_format: 'Dt' },
    ]);
    expect(richText(content)).toBe(text);
    expect(entities).toEqual(before);
  });

  it('does not overlap a controlled first-line code range with automatic bold', () => {
    expect(panelContent('/help', [{ type: 'code', offset: 0, length: 5 }])).toEqual({
      blocks: [{ type: 'paragraph', text: [{ type: 'code', text: '/help' }] }], skip_entity_detection: true,
    });
  });

  it('opts trusted command labels into detection while code protects embedded arbitrary text', () => {
    const heading = 'Commands\n\u{1f680} ';
    const label = '/help (/帮助, /幫助, /ヘルプ, /e\u0301)';
    const untrusted = '\n\nGroup name\n/help @admin https://evil.test';
    const text = heading + label + untrusted;
    const commands = commandEntities(label, heading.length);
    expect(commands.map(entity => text.slice(entity.offset, entity.offset + entity.length)))
      .toEqual(['/help', '/帮助', '/幫助', '/ヘルプ', '/e\u0301']);
    const literal = '/help @admin https://evil.test';
    const content = panelContent(text, [...commands, { type: 'code', offset: text.lastIndexOf(literal), length: literal.length }]);
    const parts = content.blocks[0]!.text;
    if (!Array.isArray(parts)) throw new Error('Expected structured paragraph text');
    expect(parts).toEqual(expect.arrayContaining(['/help', '/帮助', '/幫助', '/ヘルプ', '/e\u0301'].map(command => ({
      type: 'bot_command', text: command, bot_command: command.slice(1),
    }))));
    expect(parts.filter(part => typeof part === 'object' && 'type' in part && part.type === 'bot_command')).toHaveLength(5);
    expect(parts).toContainEqual({ type: 'code', text: literal });
    expect(content.skip_entity_detection).toBe(false);
    expect(richText(content)).toBe(text);
  });

  it('does not turn a clickable first-line command into bold or code', () => {
    expect(panelContent('/help', commandEntities('/help'))).toEqual({
      blocks: [{ type: 'paragraph', text: [{ type: 'bot_command', text: '/help', bot_command: 'help' }] }],
      skip_entity_detection: false,
    });
  });

  it('preserves blank lines and empty content without adding headings', () => {
    for (const text of ['', '\n\n', 'One\n\n\nTwo\n']) {
      const content = panelContent(text);
      expect(richText(content)).toBe(text);
      expect(content.blocks.every(block => block.type === 'paragraph')).toBe(true);
    }
  });

  it.each([
    { offset: -1, length: 1 }, { offset: 0.5, length: 1 }, { offset: 0, length: 0 },
    { offset: 0, length: -1 }, { offset: 0, length: 1.5 }, { offset: 4, length: 2 },
    { offset: NaN, length: 1 }, { offset: 0, length: Infinity },
    { offset: Number.MAX_SAFE_INTEGER + 1, length: 1 },
  ])('rejects invalid entity range $offset/$length', range => {
    expect(() => panelContent('hello', [{ type: 'code', ...range }])).toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it('rejects overlapping ranges and unsupported entities instead of parsing dynamic markup', () => {
    expect(() => panelContent('hello', [{ type: 'bold', offset: 0, length: 3 }, { type: 'code', offset: 2, length: 2 }]))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
    expect(() => panelContent('hello', [{ type: 'text_link', offset: 0, length: 5, url: 'https://evil.test' }]))
      .toThrow(expect.objectContaining({ code: 'INVALID_OUTPUT' }));
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('uses normal-size bold help titles in %s for every role/scope', language => {
    for (const admin of [false, true]) for (const privateChat of [false, true]) {
      const markdown = helpMarkdown(language, admin, privateChat);
      expect(markdown).not.toMatch(/^#{1,6}\s/m);
      expect(markdown).not.toContain('```');
      expect(markdown).toMatch(/\*\*[^*\n]+\*\*/);
      expect(markdown).not.toContain('{{count}}');
      expect(markdown).toMatch(new RegExp(`[：:]\\s*${modules.length}(?:\\n|$)`));
    }
  });
});
