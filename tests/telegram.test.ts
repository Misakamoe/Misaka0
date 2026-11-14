import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bot, Context } from 'grammy';
import type { Message, Update, UserFromGetMe } from 'grammy/types';
import type { ActionResult, GroupPage, LanguagePreference, Locale, Preference, SettingsSnapshot } from '../shared/schemas/index.js';
import type { ActionExecutor, InvocationContext } from '../src/actions.js';
import type { ConfigurationService } from '../src/configuration.js';
import type { AccessService } from '../src/access.js';
import type { StartupConfig } from '../src/config.js';
import { createTelegramAdapter, createTelegramEffects, sessionKey } from '../src/telegram/index.js';
import { commands, helpMarkdown, menuCommands } from '../src/telegram/commands.js';
import { aliasNameSchema } from '../shared/schemas/alias.js';
import { subconvDefaults } from '../shared/schemas/subconv.js';
import { normalizeLocale } from '../shared/locales/normalize.js';
import { translator } from '../src/i18n.js';
import { aliasMetadata } from '../src/modules/alias.js';
import { modules } from '../src/modules/index.js';
import { buttonRows, callbacks, liveCallbacks, recordContent, richText, telegramMessage } from './support/telegram.js';
import { offlineStickers } from './support/core.js';
import { SessionStore } from '../src/telegram/session.js';

const me: UserFromGetMe = {
  id: 12345, is_bot: true, first_name: 'Offline', username: 'offline_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false,
  has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
const token = 'a'.repeat(40);
const config: StartupConfig = {
  botToken: '12345:offline-test-token', adminIds: [1, 2], dataDir: '/tmp/kilo/offline', logLevel: 'silent',
  pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
  web: { enabled: true, host: '127.0.0.1', port: 8080, publicBaseUrl: 'https://example.test' },
};
let sequence = 0;
function message(text: string, options: { user?: number; chat?: number; thread?: number; language?: string; bot?: boolean } = {}): Update {
  const id = ++sequence;
  const chatId = options.chat ?? options.user ?? 1;
  return { update_id: id, message: {
    message_id: id, date: 100, from: { id: options.user ?? 1, first_name: '<b>Untrusted</b>', is_bot: options.bot ?? false, language_code: options.language ?? 'en' },
    chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'Private' } : { id: chatId, type: 'supergroup', title: '<script>unsafe</script>' },
    message_thread_id: options.thread, is_topic_message: options.thread !== undefined, text,
    ...(text.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: text.split(/\s/)[0]!.length }] } : {}),
  } };
}
function callback(data: string, options: Parameters<typeof message>[1] = {}, original?: Message): Update {
  const base = message('', options);
  return { update_id: base.update_id, callback_query: {
    id: `cb${base.update_id}`, from: base.message!.from!, chat_instance: 'instance', data, message: telegramMessage(original ?? base.message!),
  } };
}
function buttonData(message: Message, operation: string): string {
  const data = callbacks(message).find(data => data.endsWith(`:${operation}`));
  if (!data) throw new Error(`Missing ${operation} button: ${JSON.stringify(buttonRows(message))}`);
  return data;
}
function expectClosed(message: Message, route: 's' | 'c' | 'g' | 'a', userId = 1): void {
  const command = { s: 'settings', c: 'commands', g: 'listgroups', a: 'alias' }[route];
  expect(message.reply_markup?.inline_keyboard ?? []).toEqual([]);
  expect(buttonRows(message)).toEqual([[{
    text: expect.stringContaining(`/${command}`), callback_data: `mk:open:${route}:${userId}`,
  }]]);
  expect(message.rich_message?.blocks.at(-1)).toEqual({ type: 'buttons', buttons: buttonRows(message)[0] });
  expect(liveCallbacks(message)).toEqual([]);
}
function expectNativeCommands(rich: unknown, commands: string[]): void {
  expect(rich).toMatchObject({ blocks: expect.arrayContaining([{ type: 'paragraph', text: expect.any(Array) }]), skip_entity_detection: false });
  const inline = (rich as { blocks: { type: string; text?: (string | { type: string })[] }[] }).blocks.flatMap(block => block.type === 'paragraph' ? block.text ?? [] : []);
  expect(inline.filter(text => typeof text !== 'string' && text.type === 'bot_command'))
    .toEqual(commands.map(text => ({ type: 'bot_command', text, bot_command: text.slice(1) })));
  expect(inline.filter(text => typeof text !== 'string' && text.type === 'code')).toEqual([]);
}
function group(id: number, title = `Group ${id}`): GroupPage['items'][number] {
  return { id, title, authorizedBy: 1, authorizedAt: '2026-11-08T00:00:00.000Z', present: true, groupRevision: 1 };
}
type ApiRecord = { method: string; payload: Record<string, unknown>; signal: AbortSignal | undefined };
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function fixture() {
  const calls: ApiRecord[] = [];
  const messages: Message[] = [];
  const bot = new Bot(config.botToken, { botInfo: me, client: { fetch: vi.fn(() => { throw new Error('Network forbidden'); }) } });
  let fail: ((call: ApiRecord) => boolean) | undefined;
  let errorCode = 403;
  let errorDescription = 'sensitive-token-should-not-leak';
  let delay: ((call: ApiRecord) => Promise<void>) | undefined;
  bot.api.config.use(async (_previous, method, payload, signal) => {
    const record = { method, payload: structuredClone(payload) as Record<string, unknown>, signal: signal as unknown as AbortSignal | undefined };
    calls.push(record);
    await delay?.(record);
    if (fail?.(record)) return { ok: false, error_code: errorCode, description: errorDescription };
    let result: unknown = true;
    if (method === 'getChat') result = { id: -100, type: 'supergroup', title: '<b>Group</b>', accent_color_id: 1 };
    if (method === 'getChatMember') result = { user: me, status: 'member' };
    if (method === 'sendMessage' || method === 'sendRichMessage') {
      const chatId = Number(record.payload.chat_id);
      const sent = {
        message_id: ++sequence, date: 100, from: me,
        chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'Private' } : { id: chatId, type: 'supergroup', title: 'Group' },
        message_thread_id: record.payload.message_thread_id, is_topic_message: record.payload.message_thread_id !== undefined, text: record.payload.text,
        entities: record.payload.entities, reply_markup: record.payload.reply_markup,
      } as Message;
      recordContent(sent, record.payload);
      messages.push(sent);
      result = telegramMessage(sent);
    }
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') {
      const sent = messages.findLast(item => item.chat.id === record.payload.chat_id && item.message_id === record.payload.message_id);
      if (!sent) throw new Error('Attempted to edit an unrecorded Telegram message');
      if (method !== 'editMessageReplyMarkup') recordContent(sent, record.payload);
      Object.assign(sent, { reply_markup: record.payload.reply_markup });
      result = telegramMessage(sent);
    }
    return { ok: true, result: structuredClone(result) } as never;
  });
  const choices = new Map<number, LanguagePreference>();
  const settings: SettingsSnapshot = { revision: 0, saved: { defaultLanguage: 'zh-CN' }, effective: { defaultLanguage: 'zh-CN' }, requiresRestart: false };
  const resolveLanguage = (userId: number, hint?: string): Locale => {
    const choice = choices.get(userId);
    return choice && choice !== 'auto' ? choice : normalizeLocale(hint) ?? settings.effective.defaultLanguage;
  };
  const getPreference = (userId: number, hint?: string): Preference => ({ language: choices.get(userId) ?? 'auto', resolvedLanguage: resolveLanguage(userId, hint), menuSynced: true });
  const configuration = { resolveLanguage, getPreference, settings: () => structuredClone(settings) } as unknown as ConfigurationService;
  const allowed = new Set([-100]);
  const groups: GroupPage['items'] = [];
  const access = {
    isAdmin: vi.fn((id: number) => config.adminIds.includes(id)), isAllowed: vi.fn((id: number) => allowed.has(id)),
    snapshot: vi.fn(() => ({ revision: 3, groups: {} })), count: () => allowed.size,
    groupRevision: vi.fn(() => 1), state: vi.fn((chatId: number) => ({ chatId, revision: 3, groupRevision: 1 })),
    membership: vi.fn(async () => ({ kind: 'waiting', changed: true, chatId: -200, revision: 3, groupRevision: 1 })),
    migrate: vi.fn(async () => true),
  };
  const success = <T>(data: T): ActionResult<T> => ({ status: 'succeeded', invocationId: 'test', data });
  const execute = vi.fn(async (ctx: InvocationContext, id: string, input: unknown): Promise<ActionResult> => {
    switch (id) {
      case 'core.info': return success({ runtime: 'grammy', version: '0.1.0', moduleCount: 1, aiAvailable: false });
      case 'modules.list': return success([aliasMetadata]);
      case 'core.status': return success({ uptimeSeconds: 12, updateCount: 4, authorizedGroupCount: 1, polling: 'running', http: 'disabled', lastApiError: null });
      case 'preferences.get': return success(getPreference(ctx.actorId, ctx.languageHint));
      case 'preferences.set': {
        choices.set(ctx.actorId, (input as { language: LanguagePreference }).language);
        return success(getPreference(ctx.actorId, ctx.languageHint));
      }
      case 'core.settings.get': return success(structuredClone(settings));
      case 'subconv.settings.get': return success({ revision: 0, settings: subconvDefaults() });
      case 'core.settings.update': {
        const update = input as { revision: number; settings: { defaultLanguage: Locale } };
        if (update.revision !== settings.revision) return { status: 'rejected', invocationId: 'test', error: { code: 'CONFLICT' } };
        settings.revision++;
        settings.saved = settings.effective = { ...update.settings };
        return success(structuredClone(settings));
      }
      case 'groups.authorize': return success({ chatId: (input as { chatId: number }).chatId, revision: 4, changed: true, notificationSent: true, left: false });
      case 'groups.revoke': return { status: 'pending_confirmation', invocationId: 'test', confirmation: { token, actionId: id, target: String((input as { chatId: number }).chatId), expiresAt: new Date(Date.now() + 600_000).toISOString() } };
      case 'groups.list': {
        const page = (input as { page: number }).page;
        return success({ items: groups.slice(page * 10, (page + 1) * 10), page, pageSize: 10, total: groups.length, revision: 3 } satisfies GroupPage);
      }
      default: return { status: 'rejected', invocationId: 'test', error: { code: 'NOT_FOUND' } };
    }
  });
  const pending = vi.fn(() => ({ token, actionId: 'groups.revoke', target: '-100', expiresAt: new Date().toISOString() }));
  const confirm = vi.fn(async () => success({ chatId: -100, revision: 4, changed: true, notificationSent: false, left: false }));
  const prepare = vi.fn(async () => ({ status: 'pending_confirmation', invocationId: 'test', confirmation: { token, actionId: 'groups.authorize', target: '-200', expiresAt: new Date(Date.now() + 600_000).toISOString() } }));
  const aliases: Record<string, string[]> = { help: ['帮助', '幫助', 'ヘルプ'], alias: ['别名', '別名', 'エイリアス'] };
  const resolveAlias = vi.fn((name: string) => {
    const parsed = aliasNameSchema.safeParse(name);
    return parsed.success ? Object.entries(aliases).find(([, names]) => names.includes(parsed.data))?.[0] : undefined;
  });
  const aliasesFor = vi.fn((command: string) => aliases[command] ?? []);
  const executor = { execute, prepare, pending, confirm, resolveAlias, aliasesFor } as unknown as ActionExecutor;
  const health = { recordUpdate: vi.fn(), recordApiError: vi.fn() };
  const controller = new AbortController();
  const stickers = offlineStickers(); cleanups.push(() => stickers.stop());
  const adapter = createTelegramAdapter(bot, { config, configuration, access: access as unknown as AccessService, executor, stickers, health, signal: controller.signal });
  cleanups.push(() => adapter.stop());
  const sent = () => calls.filter(call => call.method === 'sendMessage' || call.method === 'sendRichMessage');
  const last = (chat = 1, thread?: number): Message => {
    const result = messages.findLast(item => item.chat.id === chat && item.message_thread_id === thread);
    if (!result) throw new Error('No recorded sent message for this chat/thread');
    return result;
  };
  const click = (operation: string, original = last(), options: Parameters<typeof message>[1] = {}) =>
    callback(buttonData(original, operation), options, original);
  return { bot, calls, sent, messages, last, click, adapter, executor, execute, confirm, prepare, pending, access, allowed, groups, settings, configuration, health, controller, choices, aliases, resolveAlias, aliasesFor,
    failApi: (predicate: (call: ApiRecord) => boolean, code = 403, description = 'sensitive-token-should-not-leak') => {
      fail = predicate; errorCode = code; errorDescription = description;
    },
    delayApi: (operation: (call: ApiRecord) => Promise<void>) => { delay = operation; } };
}

describe('offline native message recording', () => {
  it('does not erase embedded controls on markup edits and replaces them only with rich content edits', async () => {
    const f = fixture();
    const live = { text: 'PNG', callback_data: 'mk:ui:k:example:0:stformat:png' };
    const rich = { blocks: [{ type: 'paragraph' as const, text: 'Body' }, { type: 'buttons' as const, buttons: [live], align: 'left' as const }] };
    await f.bot.api.sendRichMessage(10, rich, { message_thread_id: 9 });
    const pane = f.last(10, 9);
    expect(pane.rich_message).toEqual(rich);
    expect(pane.reply_markup).toBeUndefined();
    expect(pane).not.toHaveProperty('text');
    expect(pane).not.toHaveProperty('entities');
    await f.bot.api.editMessageReplyMarkup(10, pane.message_id, { reply_markup: { inline_keyboard: [] } });
    expect(pane.rich_message).toEqual(rich);
    expect(liveCallbacks(pane)).toEqual([live.callback_data]);
    const closed = { blocks: [{ type: 'paragraph' as const, text: 'Closed' }, { type: 'buttons' as const,
      buttons: [{ text: 'Reopen /sticker', callback_data: 'mk:open:k:10' }], align: 'left' as const }] };
    await f.bot.api.editMessageText(10, pane.message_id, closed, { reply_markup: { inline_keyboard: [] } });
    expect(pane.rich_message).toEqual(closed);
    expect(richText(pane)).toBe('Closed');
    expect(liveCallbacks(pane)).toEqual([]);
    expect(callbacks(pane)).toEqual(['mk:open:k:10']);
    expect(telegramMessage(pane)).toMatchObject({ message_id: pane.message_id, chat: { id: 10 }, from: me,
      message_thread_id: 9, is_topic_message: true, rich_message: closed });
    expect(f.calls.at(-1)!.payload).not.toHaveProperty('text');
  });
});

describe('module-isolated input storage', () => {
  it('expires fields independently without refreshing older inputs when another field starts', () => {
    let now = 0;
    const sessions = new SessionStore(100, 1, () => now);
    const aliasInput = { panelId: 'alias', messageId: 1, promptMessageId: 2, command: 'help', revision: 0 };
    const rssInput = { panelId: 'rss', messageId: 3, promptMessageId: 4 };
    sessions.setInput('owner', 'aliasInput', aliasInput);
    now = 50; sessions.setInput('owner', 'rssInput', rssInput);
    expect(sessions.get('owner')).toEqual({ aliasInput, rssInput });
    now = 100;
    expect(sessions.get('owner')).toEqual({ rssInput });
    expect(sessions.clearInput('owner', 'rssInput', 'alias')).toBe(false);
    expect(sessions.get('owner')).toEqual({ rssInput });
    now = 150;
    expect(sessions.get('owner')).toBeUndefined(); expect(sessions.size).toBe(0);
    sessions.stop();
  });

  it('rejects capacity without evicting another owner and clears only the matching module and panel', () => {
    const sessions = new SessionStore(1000, 1);
    const aliasInput = { panelId: 'alias', messageId: 1, promptMessageId: 2, command: 'help', revision: 0 };
    const rssInput = { panelId: 'rss', messageId: 3, promptMessageId: 4 };
    sessions.setInput('owner', 'aliasInput', aliasInput);
    sessions.setInput('owner', 'rssInput', rssInput);
    expect(() => sessions.setInput('other', 'rssInput', { ...rssInput, panelId: 'other' })).toThrow('CAPACITY');
    expect(() => sessions.set('other', { rssInput })).toThrow('CAPACITY');
    expect(sessions.get('owner')).toEqual({ aliasInput, rssInput });
    expect(sessions.get('other')).toBeUndefined();
    expect(sessions.clearInput('owner', 'aliasInput', 'rss')).toBe(false);
    expect(sessions.clearInput('owner', 'aliasInput', 'alias')).toBe(true);
    expect(sessions.get('owner')).toEqual({ rssInput });
    expect(sessions.clearInput('owner', 'rssInput', 'rss')).toBe(true);
    sessions.setInput('other', 'rssInput', rssInput);
    expect(sessions.get('other')).toEqual({ rssInput });
    sessions.stop();
  });
});

describe('offline Telegram admission and commands', () => {
  it('does not initialize networking, publish menus, or allocate sessions on creation', () => {
    const f = fixture();
    expect(f.calls).toEqual([]);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(0);
  });

  it('publishes localized public and admin menus explicitly from the help metadata', async () => {
    const f = fixture();
    await f.adapter.registerMenus();
    expect(f.calls).toHaveLength(20);
    expect(f.calls.every(call => call.method === 'setMyCommands' && !!call.signal)).toBe(true);
    const english = f.calls.find(call => call.payload.language_code === 'en' && (call.payload.scope as { type: string }).type === 'all_private_chats')!;
    expect(english.payload.commands).toEqual(menuCommands('en', false, true));
    expect(helpMarkdown('en', false, true)).not.toBe(helpMarkdown('en', true, true));
    expect(helpMarkdown('en', true, false)).not.toBe(helpMarkdown('en', true, true));
    expect(helpMarkdown('en', false, true)).not.toContain('| /stats |');
  });

  it('does not fail startup when an admin has not opened the private chat', async () => {
    const f = fixture();
    f.failApi(call => call.method === 'setMyCommands' && (call.payload.scope as { type: string }).type === 'chat');
    await expect(f.adapter.registerMenus()).resolves.toBeUndefined();
    expect(f.calls).toHaveLength(20);
    expect(f.health.recordApiError).toHaveBeenCalledTimes(8);
    f.failApi(call => call.method === 'setMyCommands');
    await expect(f.adapter.registerMenus()).rejects.toThrow('UNAVAILABLE');
  });

  it('sends native rich help with normal-size bold titles and an unfenced command table, and keeps topic replies', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/help', { chat: -100, thread: 9 }));
    const rich = f.sent()[0]!;
    expect(rich.method).toBe('sendRichMessage');
    expect(rich.payload).toMatchObject({ chat_id: -100, message_thread_id: 9, reply_parameters: { allow_sending_without_reply: true } });
    const markdown = (rich.payload.rich_message as { markdown: string }).markdown;
    expect(markdown).toContain('**Misaka');
    expect(markdown).not.toMatch(/^#{1,6}\s/m);
    expect(markdown).toMatch(/\|.+\|/);
    expect(markdown).not.toContain('| /help |');
    expect(markdown).not.toContain('`');
    expect(markdown.match(/^\| [^\n]+ \| \/\w+[^\n]* \|$/gm)).toHaveLength(modules.length + 3);
    for (const command of ['/ai', '/chats', '/memory', '/tasks']) expect(markdown).toContain(command);
    expect(markdown).not.toMatch(/^\/\w+/m);
    expect(markdown).toContain(`Installed native modules: ${modules.length}`);
    expect(markdown).not.toContain('Untrusted');
    expect(rich.payload).not.toHaveProperty('parse_mode');
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('routes core commands to shared Actions and returns copyable private IDs/status', async () => {
    const f = fixture();
    for (const command of ['/start', '/modules', '/stats', '/id', '/commands', '/cancel']) await f.bot.handleUpdate(message(command, { thread: 42 }));
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['core.info', 'modules.list', 'core.status', 'sticker.cancel']);
    expect(f.sent().every(call => call.payload.message_thread_id === 42)).toBe(true);
    expect(f.messages.some(message => richText(message).includes('User ID: 1'))).toBe(true);
    expect(f.sent().some(call => String(call.payload.text).includes('Natural-language AI'))).toBe(false);
    expect(f.execute.mock.calls[0]![0]).toMatchObject({ actorId: 1, source: 'telegram', botId: me.id, chat: { id: 1, type: 'private', threadId: 42 }, language: 'en' });
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('reports the replied sender with literal names and monospace IDs without copy buttons in %s', async language => {
    const f = fixture(); const update = message('/id', { thread: 7 });
    update.message!.from!.language_code = language;
    update.message!.reply_to_message = { ...message('visible', { user: 42, chat: -100, thread: 7 }).message!,
      chat: update.message!.chat, reply_to_message: undefined, from: { id: 42, is_bot: false, first_name: '<b>Alice</b>', last_name: '@untrusted', username: 'alice_example' } };
    await f.bot.handleUpdate(update);
    const response = f.last(1, 7); const rich = response.rich_message!; const serialized = JSON.stringify(rich);
    expect(richText(response)).toContain('<b>Alice</b> @untrusted');
    expect(richText(response)).toContain('@alice_example');
    expect(rich).toMatchObject({ skip_entity_detection: true });
    for (const id of ['42', '1', '7']) expect(serialized).toContain(JSON.stringify({ type: 'code', text: id }));
    expect(serialized).not.toContain('copy_text');
    expect(serialized).not.toContain('"type":"button"');
    expect(response.reply_markup).toBeUndefined();
    expect(serialized).not.toContain('"type":"mention"');
    expect(serialized).not.toContain('callback_data');
    expect(f.calls.at(-1)?.payload).toMatchObject({ reply_parameters: { message_id: update.message!.message_id } });
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.method === 'getChat' || call.method === 'getChatMember')).toBe(false);
  });

  it.each(['channel', 'supergroup'] as const)('does not mistake a %s sender for the anonymous placeholder user', async type => {
    const f = fixture(); const update = message('/id');
    update.message!.reply_to_message = { ...message('anonymous').message!,
      reply_to_message: undefined, from: { id: 1087968824, is_bot: true, first_name: 'Placeholder must not identify a person' },
      sender_chat: { id: -100123, type, title: '<literal> Sender', username: 'sender_example' } };
    await f.bot.handleUpdate(update);
    const response = f.last(); const serialized = JSON.stringify(response.rich_message);
    expect(richText(response)).toContain('<literal> Sender');
    expect(richText(response)).toContain('does not identify a personal account');
    expect(serialized).toContain('"type":"code","text":"-100123"');
    expect(serialized).not.toContain('copy_text');
    expect(serialized).not.toContain('1087968824');
    expect(serialized).not.toContain('Placeholder');
  });

  it('reports the actual forwarding sender rather than inferring the original author', async () => {
    const f = fixture(); const update = message('/id');
    update.message!.reply_to_message = { ...message('forwarded').message!,
      reply_to_message: undefined, from: { id: 42, is_bot: false, first_name: 'Visible sender' },
      forward_origin: { type: 'user', date: 10, sender_user: { id: 99, is_bot: false, first_name: 'Original author' } } };
    await f.bot.handleUpdate(update);
    expect(richText(f.last())).toContain('User ID: 42');
    expect(JSON.stringify(f.last().rich_message)).not.toContain('"type":"code","text":"99"');
    expect(richText(f.last())).not.toContain('Original author');
  });

  it('does not invent a sender for incomplete replies or treat incidental thread IDs as topics', async () => {
    const f = fixture(); const update = message('/id');
    update.message!.is_topic_message = undefined; update.message!.message_thread_id = 55;
    update.message!.reply_to_message = { ...message('unknown').message!, from: undefined, reply_to_message: undefined,
      forward_origin: { type: 'hidden_user', date: 10, sender_user_name: 'Hidden original' } };
    await f.bot.handleUpdate(update);
    expect(richText(f.last())).toContain('No identity was inferred');
    expect(richText(f.last())).toContain('Thread ID: None');
    expect(JSON.stringify(f.last().rich_message)).not.toContain('"type":"code","text":"55"');
    expect(richText(f.last())).not.toContain('Hidden original');
    expect(f.calls.at(-1)?.payload.message_thread_id).toBeUndefined();
  });

  it('keeps /id adapter-local and leaves another module input intact', async () => {
    const f = fixture(); const key = `${me.id}:1:1:0`;
    f.adapter.sessions.setInput(key, 'rssInput', { panelId: 'rss', messageId: 12, promptMessageId: 13 });
    await f.bot.handleUpdate(message('/id'));
    expect(richText(f.last())).toContain('User ID: 1');
    expect(JSON.stringify(f.last().rich_message)).toContain('"type":"code","text":"1"');
    expect(JSON.stringify(f.last().rich_message)).not.toContain('"type":"button"');
    expect(f.adapter.sessions.get(key)?.rssInput).toEqual({ panelId: 'rss', messageId: 12, promptMessageId: 13 });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('sends stats as literal native RichText only after core.status, without forwarding resource parameters', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/stats /private/cgroup/path', { thread: 42 }));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 1, source: 'telegram', chat: { id: 1, type: 'private', threadId: 42 } }), 'core.status', {});
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]!.method).toBe('sendRichMessage');
    expect(f.sent()[0]!.payload).toMatchObject({ message_thread_id: 42, rich_message: { skip_entity_detection: true } });
    expect(richText(f.last(1, 42))).toContain('Runtime status');
    expect(richText(f.last(1, 42))).toContain('Resource snapshot\nUnavailable');
    expect(richText(f.last(1, 42))).not.toContain('/private/cgroup/path');
    expect(f.sent()[0]!.payload).not.toHaveProperty('parse_mode');
    f.execute.mockResolvedValueOnce({ status: 'rejected', invocationId: 'test', error: { code: 'FORBIDDEN' } });
    await f.bot.handleUpdate(message('/stats'));
    expect(richText(f.last())).not.toContain('Runtime status');
    expect(richText(f.last())).not.toContain('Resource snapshot');
  });

  it('gives superadmins localized guidance in unauthorized groups without authorizing or executing commands', async () => {
    const f = fixture();
    for (const text of ['/help', '/stats@offline_bot', '/unknown']) await f.bot.handleUpdate(message(text, { chat: -200, thread: 9 }));
    const mention = message('hello @offline_bot', { chat: -200, thread: 9, language: 'zh' });
    mention.message!.entities = [{ type: 'mention', offset: 6, length: 12 }];
    await f.bot.handleUpdate(mention);
    expect(f.sent()).toHaveLength(4);
    expect(f.sent().every(call => String(call.payload.text).includes('/addgroup@offline_bot'))).toBe(true);
    expect(f.sent().every(call => call.payload.message_thread_id === 9)).toBe(true);
    expect(f.sent()[3]!.payload.text).not.toBe(f.sent()[0]!.payload.text);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.allowed.has(-200)).toBe(false);
    for (const text of ['hello', '/help@other_bot', '@other_bot']) await f.bot.handleUpdate(message(text, { chat: -200 }));
    await f.bot.handleUpdate(message('/help', { chat: -200, user: 10 }));
    await f.bot.handleUpdate(message('/addgroup', { chat: -200, user: 10 }));
    expect(f.sent()).toHaveLength(4);
    await f.bot.handleUpdate(message('/addgroup -300', { chat: -200 }));
    expect(f.execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(message('/addgroup', { chat: -200 }));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ chat: { id: -200, type: 'supergroup' } }), 'groups.authorize', { chatId: -200, revision: 3, groupRevision: 1 });
  });

  it('does not answer unauthorized ordinary, anonymous, bot, other-bot or unaddressed chatter mentions', async () => {
    const f = fixture();
    const mention = (user = 1, bot = false, username = 'offline_bot') => {
      const update = message(`hello @${username}`, { user, bot, chat: -200 });
      update.message!.entities = [{ type: 'mention', offset: 6, length: username.length + 1 }];
      return update;
    };
    const anonymous = mention();
    anonymous.message!.sender_chat = anonymous.message!.chat;
    for (const update of [mention(10), mention(1, true), anonymous, mention(1, false, 'other_bot'),
      message('offline_bot', { chat: -200 }), message('/help@other_bot', { chat: -200 })]) {
      await f.bot.handleUpdate(update);
    }
    expect(f.calls).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.access.membership).not.toHaveBeenCalled();
    expect(f.allowed.has(-200)).toBe(false);
  });

  it('denies private management to ordinary users and does not publish admin data in groups', async () => {
    const f = fixture();
    for (const text of ['/stats', '/listgroups', '/webui', '/addgroup -200']) await f.bot.handleUpdate(message(text, { user: 10 }));
    for (const text of ['/stats', '/listgroups', '/webui', '/settings']) await f.bot.handleUpdate(message(text, { chat: -100 }));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sent()).toHaveLength(8);
    expect(f.sent().slice(4).every(call => String(call.payload.text).includes('private chat'))).toBe(true);
  });

  it('ignores bots, anonymous senders, edited, business, channel and other-bot commands', async () => {
    const f = fixture();
    const base = message('/help').message!;
    const updates = [
      message('/help', { bot: true }), message('/help@other_bot'),
      { update_id: ++sequence, message: { ...base, sender_chat: { id: -100, type: 'supergroup', title: 'Anonymous' } } },
      { update_id: ++sequence, edited_message: base }, { update_id: ++sequence, business_message: base },
      { update_id: ++sequence, message: { ...base, business_connection_id: 'business' } },
      { update_id: ++sequence, message: { ...base, guest_query_id: 'guest' } },
      { update_id: ++sequence, channel_post: base }, { update_id: ++sequence, edited_business_message: base },
    ];
    for (const update of updates) await f.bot.handleUpdate(update as Update);
    expect(f.calls).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each(['forward_origin', 'external_reply'] as const)('never executes forwarded command-looking text or captions with %s', async origin => {
    const f = fixture();
    for (const value of ['/stats', '/addgroup -200', '/帮助']) {
      for (const caption of [false, true]) {
        const update = message(value);
        const provenance = { type: 'user' as const, date: 100, sender_user: { id: 10, is_bot: false, first_name: 'Forwarded author' } };
        if (origin === 'forward_origin') update.message!.forward_origin = provenance;
        else update.message!.external_reply = { origin: provenance };
        if (caption) {
          update.message!.caption = value; update.message!.caption_entities = update.message!.entities;
          delete update.message!.text; delete update.message!.entities;
          update.message!.photo = [{ file_id: 'forwarded-photo', file_unique_id: 'unique', width: 10, height: 10 }];
        }
        await f.bot.handleUpdate(update);
      }
    }
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.resolveAlias).not.toHaveBeenCalled();
    expect(f.allowed.has(-200)).toBe(false);
    expect(f.calls.some(call => call.method === 'getChat' || call.method === 'getChatMember')).toBe(false);
    expect(f.sent().some(call => (call.payload.rich_message as { markdown?: string } | undefined)?.markdown)).toBe(false);
  });

  it('keeps unknown commands out of Actions and leaves group chatter silent', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/legacy_echo'));
    await f.bot.handleUpdate(message('hello'));
    await f.bot.handleUpdate(message('hello', { chat: -100 }));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sent()).toHaveLength(2);
    expect(f.sent()[0]!.payload.text).toContain('Unknown command');
    expect(f.sent()[1]!.payload.text).toBe(translator('en')('bot:fallback'));
  });

  it.each([
    ['en', 'Unknown command. Did you mean /help?'],
    ['zh-CN', '未知命令。你是不是想输入 /help？'],
    ['zh-Hant', '未知指令。你是不是想輸入 /help？'],
    ['ja', '不明なコマンドです。/help の入力間違いですか？'],
  ])('suggests a clickable command in %s without executing it or echoing arguments', async (language, expected) => {
    const f = fixture();
    const update = message('/hlep@offline_bot private-argument', { user: 10, language, thread: 9 });
    delete update.message!.entities;
    await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]).toMatchObject({ method: 'sendMessage', payload: {
      text: expected, chat_id: 10, message_thread_id: 9,
      reply_parameters: { message_id: update.message!.message_id },
    } });
    expect(f.sent()[0]!.payload).not.toHaveProperty('parse_mode');
    expect(f.sent()[0]!.payload.entities).toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.adapter.panels.size).toBe(0);
  });

  it('filters typo suggestions by role and chat scope without preparing administrative operations', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/statss', { user: 10 }));
    expect(f.last(10).text).not.toContain('/stats');
    await f.bot.handleUpdate(message('/statss'));
    expect(f.last().text).toBe('Unknown command. Did you mean /stats?');
    await f.bot.handleUpdate(message('/setings', { chat: -100 }));
    expect(f.last(-100).text).not.toContain('/settings');
    await f.bot.handleUpdate(message('/addgrop -200 sensitive-argument', { chat: -100 }));
    expect(f.last(-100).text).toBe('Unknown command. Did you mean /addgroup?');
    expect(f.allowed.has(-200)).toBe(false);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('suggests the canonical command for a mistyped Unicode alias and keeps distant names generic', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/助帮', { user: 10 }));
    expect(f.last(10).text).toBe('Unknown command. Did you mean /help?');
    await f.bot.handleUpdate(message('/unrelatedword', { user: 10 }));
    expect(f.last(10).text).toBe('Unknown command. Use /help to see the available commands.');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not suggest commands to other bots, bot senders, or unauthorized ordinary groups', async () => {
    const f = fixture();
    for (const update of [message('/hlep@other_bot'), message('/hlep', { bot: true }), message('/hlep', { user: 10, chat: -200 })]) {
      await f.bot.handleUpdate(update);
    }
    expect(f.calls).toEqual([]);
    expect(f.aliasesFor).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('uses fixed trusted URLs only for private superadmin WebUI', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/webui https://evil.test'));
    const markup = JSON.stringify(f.sent()[0]!.payload.reply_markup);
    expect(markup).toContain('https://example.test');
    expect(markup).not.toContain('evil.test');
    expect(markup).toContain('web_app');
    expect(f.sent()[0]!.method).toBe('sendRichMessage');
    expect(f.sent()[0]!.payload.rich_message).toMatchObject({ blocks: expect.any(Array), skip_entity_detection: true });
  });
});

describe('safe callbacks and bounded interaction', () => {
  it.each([1, 10])('opens exactly one settings message with role-scoped sections for actor %s', async user => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { user }));
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]!.method).toBe('sendRichMessage');
    const pane = f.last(user);
    expect(pane.from?.id).toBe(me.id);
    expect(richText(pane)).toContain('Your language:');
    expect(richText(pane)).not.toContain('Panel expires at');
    expect(richText(pane)).not.toMatch(/revision|\{\{/i);
    expect(f.sent()[0]!.payload).not.toHaveProperty('text');
    expect(f.sent()[0]!.payload.rich_message).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]), skip_entity_detection: true });
    expect(pane.reply_markup?.inline_keyboard ?? []).toEqual([]);
    expect(JSON.stringify(pane.rich_message)).not.toContain('"type":"date_time"');
    expect(callbacks(pane).filter(data => data.includes(':lang:'))).toHaveLength(5);
    expect(callbacks(pane).filter(data => data.includes(':corelang:'))).toHaveLength(user === 1 ? 4 : 0);
    expect(buttonRows(pane).filter(row => row.every(button => !('callback_data' in button))))
      .toHaveLength(user === 1 ? 2 : 1);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(1);
  });

  it('edits personal and default language in place while keeping revisions server-side', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { thread: 9 }));
    const pane = f.last(1, 9);
    const id = pane.message_id;
    await f.bot.handleUpdate(f.click('lang:en', pane, { thread: 9 }));
    expect(richText(pane)).toContain('Language preference saved.');
    expect(f.choices.get(1)).toBe('en');
    await f.bot.handleUpdate(f.click('corelang:en', pane, { thread: 9 }));
    expect(richText(pane)).toContain('Core settings saved.');
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(f.settings.revision).toBe(1);
    expect(f.execute.mock.calls.filter(call => call[1] === 'core.settings.update').map(call => call[2]))
      .toEqual([{ revision: 0, settings: { defaultLanguage: 'en' } }]);
    expect(f.settings.effective.defaultLanguage).toBe('en');
    expect(f.sent()).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'editMessageText').map(call => call.payload.message_id)).toEqual([id, id]);
    for (const edit of f.calls.filter(call => call.method === 'editMessageText')) {
      expect(edit.payload).not.toHaveProperty('text');
      expect(edit.payload).not.toHaveProperty('parse_mode');
      expect(edit.payload.rich_message).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]), skip_entity_detection: true });
    }
    expect(callbacks(pane).every(data => Buffer.byteLength(data, 'utf8') <= 64)).toBe(true);
  });

  it('replaces only the owners same-kind settings pane while preserving other kinds, users and topics', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const first = f.last();
    const stale = f.click('lang:en', first);
    await f.bot.handleUpdate(message('/commands'));
    const commands = f.last();
    await f.bot.handleUpdate(message('/settings', { thread: 9 }));
    const topic = f.last(1, 9);
    await f.bot.handleUpdate(message('/settings', { user: 10 }));
    const other = f.last(10);
    await f.bot.handleUpdate(message('/settings'));
    const replacement = f.last();
    expect(replacement.message_id).not.toBe(first.message_id);
    expect(liveCallbacks(first)).toEqual([]);
    expectClosed(first, 's');
    expect([commands, topic, other, replacement].every(pane => callbacks(pane).length > 0)).toBe(true);
    expect(f.adapter.panels.size).toBe(4);
    await f.bot.handleUpdate(stale);
    expect(f.execute.mock.calls.filter(call => call[1] === 'preferences.set')).toHaveLength(0);
    expect(callbacks(replacement).length).toBeGreaterThan(0);
  });

  it('separates native static help from a rich six-command paged catalogue with in-place native navigation', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/help'));
    await f.bot.handleUpdate(message('/commands'));
    const [help, catalogue] = f.sent();
    expect(help!.method).toBe('sendRichMessage');
    expect(catalogue!.method).toBe('sendRichMessage');
    const pane = f.last();
    const pages = Math.ceil(commands.length / 6);
    expectNativeCommands(catalogue!.payload.rich_message,
      ['/start', '/help', '/帮助', '/幫助', '/ヘルプ', '/id', '/modules', '/commands', '/cancel', '/help']);
    expect(richText(pane).split('\n').filter(line => /^\/\w+(?: \([^\n]+\))? - /.test(line))).toHaveLength(6);
    expect(pane.reply_markup?.inline_keyboard ?? []).toEqual([]);
    expect(buttonRows(pane)).toHaveLength(1);
    const firstRow = buttonRows(pane)[0]!;
    expect(firstRow).toHaveLength(3);
    expect(firstRow.map(button => button.text)).toEqual(['\u25c1 Prev', `1/${pages}`, 'Next \u25b7']);
    expect(firstRow[0]).not.toHaveProperty('callback_data');
    expect(firstRow[1]).toHaveProperty('callback_data', buttonData(pane, 'pick'));
    await f.bot.handleUpdate(f.click('page:1', pane));
    expectNativeCommands(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.rich_message,
      ['/settings', '/stats', '/addgroup', '/listgroups', '/webui', '/alias', '/别名', '/別名', '/エイリアス', '/help']);
    expect(richText(pane)).toContain('/stats -');
    expect(richText(pane).split('\n').filter(line => /^\/\w+(?: \([^\n]+\))? - /.test(line))).toHaveLength(6);
    expect(buttonRows(pane)[0]![2]).toHaveProperty('callback_data');
    for (let page = 2; page < pages; page++) {
      await f.bot.handleUpdate(f.click(`page:${page}`, pane));
      const expected = commands.slice(page * 6, (page + 1) * 6);
      expectNativeCommands(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.rich_message,
        [...expected.flatMap(command => [`/${command.name}`, ...(f.aliases[command.name] ?? []).map(alias => `/${alias}`)]), '/help']);
      expect(richText(pane).split('\n').filter(line => /^\/\w+(?: \([^\n]+\))? - /.test(line))).toHaveLength(expected.length);
      if (page < pages - 1) expect(buttonRows(pane)[0]![2]).toHaveProperty('callback_data');
    }
    expect(buttonRows(pane)[0]![2]).not.toHaveProperty('callback_data');
    for (let page = pages - 2; page >= 0; page--) await f.bot.handleUpdate(f.click(`page:${page}`, pane));
    expect(f.sent()).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(2 * (pages - 1));
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('rechecks catalogue role and group admission after ten minutes without exposing admin-only entries', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/commands'));
    const privatePane = f.last();
    const next = f.click('page:1', privatePane);
    await vi.advanceTimersByTimeAsync(600_001);
    f.access.isAdmin.mockReturnValue(false);
    await f.bot.handleUpdate(next);
    expect(richText(privatePane)).not.toContain('/stats -');
    expect(richText(privatePane)).not.toContain('/listgroups -');
    f.access.isAdmin.mockImplementation(id => config.adminIds.includes(id));
    await f.bot.handleUpdate(message('/commands', { chat: -100, thread: 9 }));
    const groupPane = f.last(-100, 9);
    const groupNext = f.click('page:1', groupPane, { chat: -100, thread: 9 });
    await vi.advanceTimersByTimeAsync(600_001);
    f.allowed.delete(-100);
    const edits = f.calls.filter(call => call.method === 'editMessageText').length;
    await f.bot.handleUpdate(groupNext);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(edits + 1);
    expectClosed(groupPane, 'c');
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(2);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery').at(-1)!.payload.text).toContain('permission');
    expect(f.adapter.panels.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it.each([
    { user: 10, chat: 10, admin: false, privateChat: true },
    { user: 1, chat: 1, admin: true, privateChat: true },
    { user: 10, chat: -100, admin: false, privateChat: false },
    { user: 1, chat: -100, admin: true, privateChat: false },
  ])('shows only the commands allowed to user $user in chat $chat', async ({ user, chat, admin, privateChat }) => {
    const f = fixture();
    await f.bot.handleUpdate(message('/commands', { user, chat }));
    const pane = f.last(chat);
    const names = () => [...richText(pane).matchAll(/^\/(\w+)(?: \([^\n]+\))? - /gm)].map(match => match[1]);
    const shown = names();
    for (let page = 1; page < Math.ceil(commands.length / 6) && callbacks(pane).some(data => data.endsWith(`:page:${page}`)); page++) {
      await f.bot.handleUpdate(f.click('pick', pane, { user, chat }));
      await f.bot.handleUpdate(f.click(`page:${page}`, pane, { user, chat }));
      shown.push(...names());
    }
    const expected = commands.filter(command => (!command.admin || admin) && (!command.private || privateChat)).map(command => command.name);
    expect(shown).toEqual(expected);
    if (!admin) expect(shown).not.toContain('stats');
    if (!privateChat) for (const name of ['settings', 'alias', 'sticker', 'subconv']) expect(shown).not.toContain(name);
  });

  it('opens a page grid from the counter and selects or returns in place without accepting stale or foreign buttons', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/commands', { thread: 9 }));
    const pane = f.last(1, 9);
    const pages = Math.ceil(commands.length / 6);
    const original = structuredClone(pane.rich_message);
    const stale = f.click('page:1', pane, { thread: 9 });
    await f.bot.handleUpdate(f.click('pick', pane, { user: 2, thread: 9 }));
    expect(pane.rich_message).toEqual(original);
    await f.bot.handleUpdate(f.click('pick', pane, { thread: 9 }));
    expect(richText(pane)).toContain(`Select a page (currently 1/${pages})`);
    expect(buttonRows(pane)[0]!.map(button => button.text)).toEqual(Array.from({ length: pages }, (_, index) => String(index + 1)));
    expect(buttonRows(pane).at(-1)![0]!.text).toBe('Back to list');
    const selection = structuredClone(pane.rich_message);
    await f.bot.handleUpdate(stale);
    expect(pane.rich_message).toEqual(selection);
    await f.bot.handleUpdate(f.click('page:1', pane, { thread: 9 }));
    expect(richText(pane)).toContain('/stats -');
    expect(buttonRows(pane)[0]!.map(button => button.text)).toEqual(['\u25c1 Prev', `2/${pages}`, 'Next \u25b7']);
    await f.bot.handleUpdate(f.click('pick', pane, { thread: 9 }));
    expect(buttonRows(pane)[0]![1]).toMatchObject({ text: '2', style: 'primary' });
    await f.bot.handleUpdate(f.click('page:1', pane, { thread: 9 }));
    expect(f.sent()).toHaveLength(1);
    expect(f.adapter.panels.size).toBe(1);
    expect(f.execute).not.toHaveBeenCalled();
    expect(pane.message_thread_id).toBe(9);
  });

  it('reuses bounded page selection for groups and rejects hidden revoke operations while choosing pages', async () => {
    const f = fixture();
    f.groups.push(...Array.from({ length: 211 }, (_, index) => group(-100 - index)));
    await f.bot.handleUpdate(message('/listgroups'));
    const pane = f.last();
    await f.bot.handleUpdate(f.click('pick', pane));
    const numbers = () => buttonRows(pane).flat().filter(button => /^\d+$/.test(richText(button.text)));
    expect(numbers()).toHaveLength(20);
    const markup = structuredClone(pane.rich_message);
    const forged = buttonData(pane, 'pick:1').replace(/pick:1$/, 'revoke:-100');
    await f.bot.handleUpdate(callback(forged, {}, pane));
    expect(pane.rich_message).toEqual(markup);
    expect(f.execute.mock.calls.filter(call => call[1] === 'groups.revoke')).toHaveLength(0);
    await f.bot.handleUpdate(f.click('pick:1', pane));
    expect(numbers().map(button => button.text)).toEqual(['21', '22']);
    await f.bot.handleUpdate(f.click('page:21', pane));
    expect(richText(pane)).toContain('22/22');
    expect(callbacks(pane).filter(data => data.includes(':revoke:'))).toEqual([buttonData(pane, 'revoke:-310')]);
    expect(f.sent()).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'getChat' || call.method === 'getChatMember')).toBe(false);
    expect(callbacks(pane).every(data => Buffer.byteLength(data) <= 64)).toBe(true);
  });

  it('does not extend the groups management TTL when the page picker is opened', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const f = fixture();
    f.groups.push(...Array.from({ length: 11 }, (_, index) => group(-100 - index)));
    await f.bot.handleUpdate(message('/listgroups'));
    const pane = f.last();
    await vi.advanceTimersByTimeAsync(590_000);
    await f.bot.handleUpdate(f.click('pick', pane));
    const select = f.click('page:1', pane);
    const executions = f.execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(liveCallbacks(pane)).toEqual([]);
    expectClosed(pane, 'g');
    await f.bot.handleUpdate(select);
    expect(liveCallbacks(pane)).toEqual([]);
    expect(f.adapter.panels.size).toBe(0);
    expectClosed(pane, 'g');
    expect(f.execute).toHaveBeenCalledTimes(executions);
    expect(f.execute.mock.calls.every(call => call[1] === 'groups.list')).toBe(true);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a timer-free command catalogue pageable and owner-bound beyond ten minutes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/commands', { thread: 9 }));
    const pane = f.last(1, 9);
    const data = buttonData(pane, 'page:1');
    const panel = f.adapter.panels.get(data.split(':')[3]!, {
      key: `${me.id}:1:1:9`, botId: me.id, chatId: 1, userId: 1, threadId: 9, language: 'en', messageId: pane.message_id,
    });
    expect(panel.expiresAt).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const markup = structuredClone(pane.rich_message);
    await vi.advanceTimersByTimeAsync(600_001);
    const forgedMessages = [
      { ...pane, message_id: pane.message_id + 999 },
      { ...pane, chat: { id: 2, type: 'private', first_name: 'Other' } },
      { ...pane, message_thread_id: 10, is_topic_message: true },
      { ...pane, from: { ...me, id: 99999 } },
      { ...pane, from: undefined },
    ] as Message[];
    await f.bot.handleUpdate(callback(data, { user: 2, thread: 9 }, pane));
    for (const forged of forgedMessages) await f.bot.handleUpdate(callback(data, { thread: 9 }, forged));
    expect(pane.rich_message).toEqual(markup);
    expect(f.calls.filter(call => call.method.startsWith('editMessage'))).toHaveLength(0);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(6);
    await f.bot.handleUpdate(callback(data, { thread: 9 }, pane));
    expect(richText(pane)).toContain('/stats -');
    await f.bot.handleUpdate(f.click('pick', pane, { thread: 9 }));
    expect(richText(pane)).toContain(`Select a page (currently 2/${Math.ceil(commands.length / 6)})`);
    await vi.advanceTimersByTimeAsync(600_001);
    await f.bot.handleUpdate(f.click('page:0', pane, { thread: 9 }));
    expect(richText(pane)).toContain('/help (');
    expect(f.sent()).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(3);
    expect(f.adapter.panels.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('rejects transferred live buttons by actor, chat, thread, message and bot sender without disabling the owners pane', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { thread: 9 }));
    const pane = f.last(1, 9);
    const originalMarkup = structuredClone(pane.rich_message);
    const data = buttonData(pane, 'lang:en');
    const forgedMessages = [
      { ...pane, message_id: pane.message_id + 999 },
      { ...pane, chat: { id: 2, type: 'private', first_name: 'Other' } },
      { ...pane, message_thread_id: 10, is_topic_message: true },
      { ...pane, from: { ...me, id: 99999 } },
      { ...pane, from: undefined },
    ] as Message[];
    await f.bot.handleUpdate(callback(data, { user: 2 }, pane));
    for (const forged of forgedMessages) await f.bot.handleUpdate(callback(data, {}, forged));
    expect(f.execute.mock.calls.filter(call => call[1] === 'preferences.set')).toHaveLength(0);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(6);
    expect(pane.rich_message).toEqual(originalMarkup);
    await f.bot.handleUpdate(f.click('lang:en', pane, { thread: 9 }));
    expect(f.choices.get(1)).toBe('en');
  });

  it('rejects a command from the wrong panel kind and a revoke ID outside the cached group page', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/commands'));
    const catalogue = f.last();
    await f.bot.handleUpdate(callback(buttonData(catalogue, 'page:1').replace(/page:1$/, 'corelang:en'), {}, catalogue));
    f.groups.push(group(-100));
    await f.bot.handleUpdate(message('/listgroups'));
    const groups = f.last();
    const markup = structuredClone(groups.rich_message);
    await f.bot.handleUpdate(callback(buttonData(groups, 'revoke:-100').replace(/revoke:-100$/, 'revoke:-999'), {}, groups));
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['groups.list']);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(groups.rich_message).toEqual(markup);
  });

  it('acknowledges missing/inaccessible messages, old data, bots and unauthorized groups without execution', async () => {
    const f = fixture();
    const missing = callback(`mk:confirm:${token}`);
    delete missing.callback_query!.message;
    const inaccessible = callback(`mk:confirm:${token}`);
    inaccessible.callback_query!.message!.date = 0;
    for (const update of [missing, inaccessible, callback('old_approve_-100'), callback('mk:lang:en', { bot: true }), callback(`mk:confirm:${token}`, { chat: -200 })]) {
      await f.bot.handleUpdate(update);
    }
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(5);
    expect(f.sent()).toEqual([]);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('acknowledges callbacks even when preference resolution fails before admission', async () => {
    const f = fixture();
    vi.spyOn(f.configuration, 'resolveLanguage').mockImplementation(() => { throw new Error('Broken preferences'); });
    const update = callback('unknown');
    delete update.callback_query!.message;
    await f.bot.handleUpdate(update);
    expect(f.calls.map(call => call.method)).toEqual(['answerCallbackQuery']);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('does not interpret injected or malformed callback data', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const current = f.last();
    const originalMarkup = structuredClone(current.rich_message);
    const initialExecutions = f.execute.mock.calls.length;
    const malformed = ['mk:confirm:evil', `mk:confirm:${token}:extra`, 'mk:groups:100001', 'mk:revoke:-100:0:admin', 'mk:lang:<b>en</b>',
      `mk:ui:${'0'.repeat(24)}:lang:en`, buttonData(current, 'lang:en') + ':injected',
      buttonData(current, 'lang:en').replace(/lang:en$/, 'page:9007199254740992'),
      buttonData(current, 'lang:en').replace(/lang:en$/, 'page:NaN')];
    for (const data of malformed) {
      await f.bot.handleUpdate(callback(data, { user: 2 }, current));
    }
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.execute).toHaveBeenCalledTimes(initialExecutions);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(malformed.length);
    expect(current.rich_message).toEqual(originalMarkup);
    expect(f.calls.filter(call => call.method.startsWith('editMessage'))).toHaveLength(0);
  });

  it('prepares revocation through the executor then confirms once and accurately shows partial success', async () => {
    const f = fixture();
    f.groups.push(group(-100));
    await f.bot.handleUpdate(message('/listgroups'));
    await f.bot.handleUpdate(f.click('revoke:-100'));
    expect(f.execute.mock.calls.at(-1)!.slice(1)).toEqual(['groups.revoke', { chatId: -100, revision: 3, groupRevision: 1 }]);
    expect(f.confirm).not.toHaveBeenCalled();
    const approval = f.last();
    const confirm = f.click('confirm', approval);
    expect(confirm.callback_query!.data).toMatch(/^mk:ui:g:[a-f0-9]{24}:\d{1,6}:confirm$/);
    expect(JSON.stringify(approval)).not.toContain(token);
    const original = f.confirm.getMockImplementation()!;
    f.confirm.mockImplementation(async () => {
      expect(liveCallbacks(approval)).toEqual([]);
      expectClosed(approval, 'g');
      return original();
    });
    await f.bot.handleUpdate(confirm);
    expect(f.pending).toHaveBeenCalledOnce();
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(richText(approval)).toContain('Bot left: No');
    expect(f.sent()).toHaveLength(2);
    await f.bot.handleUpdate({ ...confirm, update_id: ++sequence });
    expect(f.confirm).toHaveBeenCalledOnce();
    expect(liveCallbacks(approval)).toEqual([]);
    expectClosed(approval, 'g');
    const terminal = f.calls.filter(call => call.method === 'editMessageText').at(-1)!;
    expect(terminal.payload).not.toHaveProperty('text');
    expect(terminal.payload.rich_message).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]), skip_entity_detection: true });
  });

  it('rechecks the role on private management callbacks', async () => {
    const f = fixture();
    f.groups.push(group(-100));
    await f.bot.handleUpdate(message('/listgroups'));
    const revoke = f.click('revoke:-100');
    f.access.isAdmin.mockReturnValue(false);
    await f.bot.handleUpdate(revoke);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['groups.list']);
  });

  it('isolates settings panels by user/thread, and cancel clears only the current form and non-approval panels', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { thread: 10 }));
    const first = f.last(1, 10);
    const stale = f.click('corelang:en', first, { thread: 10 });
    await f.bot.handleUpdate(message('/settings', { thread: 11 }));
    const other = f.last(1, 11);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(2);
    f.adapter.sessions.set(`${me.id}:1:1:10`, { rssInput: { panelId: 'first', messageId: 7 } });
    f.adapter.sessions.set(`${me.id}:1:1:11`, { rssInput: { panelId: 'other', messageId: 8 } });
    await f.bot.handleUpdate(message('/cancel', { thread: 10 }));
    await f.bot.handleUpdate(stale);
    expect(f.execute.mock.calls.filter(call => call[1] === 'core.settings.update')).toHaveLength(0);
    expect(liveCallbacks(first)).toEqual([]);
    expectClosed(first, 's');
    expect(f.adapter.sessions.get(`${me.id}:1:1:10`)).toBeUndefined();
    expect(f.adapter.sessions.get(`${me.id}:1:1:11`)).toEqual({ rssInput: { panelId: 'other', messageId: 8 } });
    await f.bot.handleUpdate(f.click('corelang:en', other, { thread: 11 }));
    expect(f.execute.mock.calls.filter(call => call[1] === 'core.settings.update')).toHaveLength(1);
    expect(f.adapter.panels.size).toBe(1);
  });

  it('serializes identical resolver keys before settings lookup without blocking other threads', async () => {
    const f = fixture();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = f.execute.getMockImplementation()!;
    f.execute.mockImplementation(async (ctx, id, input) => {
      if (id === 'core.settings.get' && ctx.chat?.threadId === 10) { entered(); await gate; }
      return original(ctx, id, input);
    });
    const first = f.bot.handleUpdate(message('/settings', { thread: 10 }));
    await started;
    const cancel = f.bot.handleUpdate(message('/cancel', { thread: 10 }));
    await f.bot.handleUpdate(message('/settings', { thread: 11 }));
    expect(f.adapter.panels.size).toBe(1);
    release();
    await Promise.all([first, cancel]);
    const key = sessionKey(new Context(message('', { thread: 10 }), f.bot.api, me));
    expect(f.adapter.sessions.get(key)).toBeUndefined();
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(1);
    expect(callbacks(f.last(1, 11)).length).toBeGreaterThan(0);
  });

  it('binds concurrent languages without global locale mutation', async () => {
    const f = fixture();
    await Promise.all([f.bot.handleUpdate(message('/start', { user: 10, language: 'en' })), f.bot.handleUpdate(message('/start', { user: 11, language: 'zh' }))]);
    expect(f.sent().find(call => call.payload.chat_id === 10)!.payload.text).toBe(translator('en')('bot:start'));
    expect(f.sent().find(call => call.payload.chat_id === 11)!.payload.text).toBe(translator('zh-CN')('bot:start'));
    await f.bot.handleUpdate(message('/settings', { user: 10 }));
    const panel = f.last(10);
    const sentCount = f.sent().length;
    await f.bot.handleUpdate(f.click('lang:zh-CN', panel, { user: 10 }));
    expect(richText(panel)).toContain('语言偏好已保存');
    expect(f.sent()).toHaveLength(sentCount);
  });

  it('paginates cached group data, truncates untrusted titles and never parses dynamic values as markup', async () => {
    const f = fixture();
    f.groups.push(...Array.from({ length: 11 }, (_, index) => group(-100 - index, '<b>unsafe</b>'.repeat(1000))));
    await f.bot.handleUpdate(message('/listgroups'));
    expect(richText(f.sent()[0]!.payload.rich_message).length).toBeLessThan(4096);
    expect(f.sent()[0]!.payload).not.toHaveProperty('parse_mode');
    expect(f.sent()[0]!.payload).not.toHaveProperty('text');
    expect(f.sent()[0]!.payload.rich_message).toMatchObject({ blocks: expect.arrayContaining([{ type: 'paragraph', text: expect.arrayContaining([
      expect.objectContaining({ type: 'date_time', unix_time: Date.parse('2026-11-08T00:00:00.000Z') / 1000, date_time_format: 'Dt' }),
    ]) }]), skip_entity_detection: true });
    expect(richText(f.sent()[0]!.payload.rich_message)).toContain('<b>unsafe</b>');
    const pane = f.last();
    expect(buttonData(pane, 'page:1')).toMatch(/^mk:ui:g:[a-f0-9]{24}:\d{1,6}:page:1$/);
    await f.bot.handleUpdate(f.click('page:1', pane));
    expect(f.execute.mock.calls[1]!.slice(1)).toEqual(['groups.list', { page: 1 }]);
    expect(f.sent()).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(1);
    expect(callbacks(pane).some(data => data.endsWith(':revoke:-110'))).toBe(true);
    expect(f.calls.some(call => call.method === 'getChat')).toBe(false);
  });

  it('keeps hostile cached group titles literal in native rich blocks, not links or parsed formatting', async () => {
    const f = fixture();
    const title = '<b>owner</b> **admin** [login](https://evil.test) @offline_bot /help /帮助';
    f.groups.push(group(-100, title));
    await f.bot.handleUpdate(message('/listgroups'));
    const payload = f.sent()[0]!.payload;
    expect(payload).not.toHaveProperty('text');
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload.rich_message).toMatchObject({ blocks: expect.arrayContaining([expect.objectContaining({ type: 'paragraph' })]), skip_entity_detection: true });
    expect(richText(payload.rich_message)).toContain(title);
    const serialized = JSON.stringify(payload.rich_message);
    expect(serialized).not.toContain('"url":');
    expect(serialized).not.toContain('"type":"text_link"');
    expect(serialized).not.toContain('"type":"heading"');
    expect(serialized).not.toContain('"type":"italic"');
    expect(serialized).not.toContain('"type":"bot_command"');
  });

  it('expires settings, groups and approvals without another update while commands remain active', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-08T00:00:00Z'));
    const f = fixture();
    f.groups.push(group(-100));
    await f.bot.handleUpdate(message('/settings'));
    const settings = f.last();
    const staleSetting = f.click('corelang:en', settings);
    await f.bot.handleUpdate(message('/commands'));
    const commands = f.last();
    const commandMarkup = structuredClone(commands.rich_message);
    await f.bot.handleUpdate(message('/listgroups'));
    const groups = f.last();
    const staleRevoke = f.click('revoke:-100', groups);
    await f.bot.handleUpdate(f.click('revoke:-100'));
    const approval = f.last();
    const staleConfirm = f.click('confirm', approval);
    for (const pane of [settings, commands, groups, approval]) expect(richText(pane)).not.toContain('Panel expires at');
    expect(f.adapter.panels.size).toBe(4);
    expect(vi.getTimerCount()).toBe(1);
    const executions = f.execute.mock.calls.length;
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.adapter.panels.size).toBe(1);
    expectClosed(settings, 's');
    expectClosed(groups, 'g');
    expectClosed(approval, 'g');
    expect(commands.rich_message).toEqual(commandMarkup);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(3);
    expect(f.calls.filter(call => call.method === 'editMessageReplyMarkup')).toHaveLength(0);
    for (const stale of [staleSetting, staleRevoke, staleConfirm]) await f.bot.handleUpdate(stale);
    expectClosed(settings, 's');
    expectClosed(groups, 'g');
    expectClosed(approval, 'g');
    expect(f.execute).toHaveBeenCalledTimes(executions);
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.settings.revision).toBe(0);
    expect(f.allowed.has(-100)).toBe(true);
    expect(f.adapter.panels.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the last successfully displayed body when a later edit fails and the panel expires', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const pane = f.last();
    const body = structuredClone(pane.rich_message!.blocks[0]);
    let reject = true;
    f.failApi(call => reject && call.method === 'editMessageText', 500, 'Temporary failure');
    await f.bot.handleUpdate(f.click('lang:ja', pane));
    expect(f.choices.get(1)).toBe('ja');
    expect(pane.rich_message!.blocks[0]).toEqual(body);
    reject = false;
    await vi.advanceTimersByTimeAsync(600_000);
    expectClosed(pane, 's');
    expect(pane.rich_message!.blocks[0]).toEqual(body);
  });

  it('removes embedded controls even when the opening send attaches after expiration', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    cleanups.unshift(async () => { release.resolve(); });
    f.delayApi(async call => {
      if (call.method === 'sendRichMessage') { entered.resolve(); await release.promise; }
    });
    const opening = f.bot.handleUpdate(message('/settings'));
    await entered.promise;
    const body = richText(f.calls.find(call => call.method === 'sendRichMessage')!.payload.rich_message);
    await vi.advanceTimersByTimeAsync(600_000);
    release.resolve();
    await opening;
    expectClosed(f.last(), 's');
    expect(richText(f.last())).toBe(body);
    expect(f.adapter.panels.size).toBe(0);
  });

  it.each([
    [403, 'sensitive-token-should-not-leak'],
    [400, 'Bad Request: message to edit not found'],
    [400, 'Bad Request: message is not modified'],
  ] as const)('safely handles expiry edit failure %s %s', async (code, description) => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    f.failApi(call => call.method === 'editMessageText', code, description);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.adapter.panels.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    if (description.endsWith('is not modified')) expect(f.health.recordApiError).not.toHaveBeenCalled();
    else expect(f.health.recordApiError).toHaveBeenCalledWith(`TELEGRAM_${code}`);
    expect(JSON.stringify(f.health.recordApiError.mock.calls)).not.toContain('sensitive-token');
    await expect(f.adapter.stop()).resolves.toBeUndefined();
  });

  it('cancels and drains an actual expiry edit before stop completes and leaves zero timers', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanups.unshift(async () => { release.resolve(); });
    let cancelled = false;
    f.delayApi(async call => {
      if (call.method !== 'editMessageText') return;
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        call.signal!.addEventListener('abort', () => {
          cancelled = true;
          void release.promise.then(() => reject(new DOMException('Stopped', 'AbortError')));
        }, { once: true });
      });
    });
    await vi.advanceTimersByTimeAsync(600_000);
    await entered.promise;
    let finished = false;
    const stopping = f.adapter.stop().then(() => { finished = true; });
    await Promise.resolve();
    expect(cancelled).toBe(true);
    expect(finished).toBe(false);
    release.resolve();
    await stopping;
    expect(finished).toBe(true);
    expect(f.adapter.panels.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.health.recordApiError).not.toHaveBeenCalled();
  });

  it('acknowledges and disables an accessible bot-owned old panel after restart without mutations', async () => {
    const old = fixture();
    await old.bot.handleUpdate(message('/settings'));
    const pane = structuredClone(old.last());
    const data = buttonData(pane, 'lang:en');
    await old.adapter.stop();
    const restarted = fixture();
    restarted.messages.push(pane);
    await restarted.bot.handleUpdate(callback(data, {}, pane));
    expect(restarted.calls.find(call => call.method === 'answerCallbackQuery')!.payload.text).toContain('expired');
    expect(liveCallbacks(pane)).toEqual([]);
    expectClosed(pane, 's');
    expect(restarted.execute).not.toHaveBeenCalled();
    expect(restarted.adapter.panels.size).toBe(0);
  });

  it.each(['native', 'legacy', 'mixed'] as const)('replaces %s settings controls after restart with only a native reopen', async representation => {
    const old = fixture();
    await old.bot.handleUpdate(message('/settings'));
    const pane = telegramMessage(old.last());
    const data = buttonData(pane, 'corelang:en');
    const body = richText(pane);
    if (representation === 'native') delete pane.reply_markup;
    else pane.reply_markup = { inline_keyboard: [[{ text: 'English', callback_data: data }]] };
    if (representation === 'legacy') pane.rich_message!.blocks = pane.rich_message!.blocks.filter(block => block.type !== 'buttons');
    await old.adapter.stop();
    const f = fixture(); f.messages.push(pane);
    await f.bot.handleUpdate(callback(data, {}, pane));
    expectClosed(pane, 's');
    expect(richText(pane)).toBe(body);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method.startsWith('editMessage')).map(call => call.method)).toEqual(['editMessageText']);
  });

  it('expires legacy callback markup only on accessible bot-owned messages, not third-party messages', async () => {
    const old = fixture();
    await old.bot.handleUpdate(message('/settings'));
    const pane = structuredClone(old.last());
    await old.adapter.stop();
    const restarted = fixture();
    restarted.messages.push(pane);
    const foreign = { ...structuredClone(pane), from: { ...me, id: me.id + 1 } } as Message;
    await restarted.bot.handleUpdate(callback('mk:lang:en', {}, foreign));
    expect(restarted.calls.filter(call => call.method.startsWith('editMessage'))).toHaveLength(0);
    await restarted.bot.handleUpdate(callback('mk:lang:en', {}, pane));
    expect(liveCallbacks(pane)).toEqual([]);
    expectClosed(pane, 's');
    expect(restarted.execute).not.toHaveBeenCalled();
    expect(restarted.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(2);
  });
});

describe('subconv native admission and recovery', () => {
  it.each(['native', 'markup', 'legacy'] as const)('removes stale %s controls and all URL output after restart without replay', async mode => {
    const old = fixture();
    await old.bot.handleUpdate(message('/subconv', { user: 10 }));
    const pane = telegramMessage(old.last(10));
    let data = buttonData(pane, 'ugenerate');
    const secret = 'https://converter.example/sub?url=PRIVATE_SOURCE_TOKEN';
    if (mode === 'native') pane.rich_message!.blocks.splice(1, 0, { type: 'pre', text: secret });
    else {
      if (mode === 'legacy') data = 'mk:subconv:generate';
      delete pane.rich_message;
      pane.text = secret;
      pane.reply_markup = { inline_keyboard: [[{ text: 'Generate', callback_data: data }]] };
    }
    await old.adapter.stop();
    const restarted = fixture(); restarted.messages.push(pane);
    await restarted.bot.handleUpdate(callback(data, { user: 10 }, pane));
    expect(restarted.execute).not.toHaveBeenCalled();
    expect(restarted.calls.map(call => call.method)).toEqual(['answerCallbackQuery', 'editMessageText']);
    expect(pane.reply_markup?.inline_keyboard).toEqual([]);
    expect(callbacks(pane)).toEqual(['mk:open:u:10']);
    expect(pane.rich_message?.blocks.map(block => block.type)).toEqual(['paragraph', 'buttons']);
    expect(JSON.stringify(pane)).not.toContain('PRIVATE_SOURCE_TOKEN');
    await restarted.bot.handleUpdate(callback('mk:open:u:10', { user: 11 }, pane));
    expect(restarted.execute).not.toHaveBeenCalled();
    await restarted.bot.handleUpdate(callback('mk:open:u:10', { user: 10 }, pane));
    expect(restarted.execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
    expect(restarted.last(10).message_id).not.toBe(pane.message_id);
  });

  it('preserves command priority and rejects unsupported edited, business, bot and sender-chat input', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/subconv', { user: 10 }));
    const pane = f.last(10);
    await f.bot.handleUpdate(f.click('uinput:0', pane, { user: 10 }));
    const prompt = f.last(10);
    const base = message('https://subscription.example/secret', { user: 10 }).message!;
    base.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
    for (const update of [
      { edited_message: base }, { business_message: base },
      { message: { ...base, from: { ...base.from!, is_bot: true } } },
      { message: { ...base, sender_chat: base.chat } },
      { message: { ...base, business_connection_id: 'business' } },
      { message: { ...base, sender_business_bot: me } },
      { message: { ...base, guest_query_id: 'guest' } },
    ]) await f.bot.handleUpdate({ update_id: ++sequence, ...update } as Update);
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
    expect(f.adapter.sessions.get(`${me.id}:10:10:0`)?.subconvInput).toBeDefined();
    const help = message('/help', { user: 10 });
    help.message!.reply_to_message = base.reply_to_message;
    await f.bot.handleUpdate(help);
    expect(f.adapter.sessions.get(`${me.id}:10:10:0`)?.subconvInput).toBeDefined();
    expect(f.sent().at(-1)?.payload.rich_message).toHaveProperty('markdown');
    const other = message('/help@other_bot', { user: 10 });
    other.message!.reply_to_message = base.reply_to_message;
    const calls = f.calls.length;
    await f.bot.handleUpdate(other);
    expect(f.calls).toHaveLength(calls);
    await f.bot.handleUpdate(message('/cancel', { user: 10 }));
    expect(callbacks(pane)).toEqual(['mk:open:u:10']);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('expires a pending ForceReply panel using a full rich edit, not markup-only changes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/subconv', { user: 10 }));
    const pane = f.last(10);
    await f.bot.handleUpdate(f.click('uinput:0', pane, { user: 10 }));
    const prompt = f.last(10);
    expect(f.calls.at(-1)?.payload.reply_markup).toMatchObject({ force_reply: true });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(callbacks(pane)).toEqual(['mk:open:u:10']);
    expect(pane.reply_markup?.inline_keyboard).toEqual([]);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.calls.filter(call => call.method === 'editMessageReplyMarkup')).toHaveLength(0);
    const late = message('https://subscription.example/late', { user: 10 });
    late.message!.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
    await f.bot.handleUpdate(late);
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
  });
});

describe('Unicode aliases and safe panel reopen', () => {
  it.each(['帮助', '幫助', 'ヘルプ'])('resolves /%s without Telegram command entities using the real actor and topic', async alias => {
    const f = fixture();
    const update = message(`/${alias}@offline_bot keep arguments`, { user: 10, chat: -100, thread: 9 });
    delete update.message!.entities;
    const before = structuredClone(update);
    await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]!).toMatchObject({ method: 'sendRichMessage', payload: { chat_id: -100, message_thread_id: 9,
      reply_parameters: { message_id: update.message!.message_id } } });
    expect(f.resolveAlias).toHaveBeenCalledWith(alias);
    expect(f.execute).not.toHaveBeenCalled();
    expect(update).toEqual(before);
  });

  it('normalizes full-width aliases and preserves arguments through inherited target authorization', async () => {
    const f = fixture();
    f.aliases.addgroup = ['join'];
    const update = message('/ＪＯＩＮ@offline_bot -200', { thread: 9 });
    delete update.message!.entities;
    await f.bot.handleUpdate(update);
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 1, botId: me.id, source: 'telegram',
      chat: { id: 1, type: 'private', threadId: 9 }, invocationId: `telegram:${me.id}:${update.update_id}` }),
    'groups.authorize', { chatId: -200, revision: 3, groupRevision: 1 });
  });

  it('applies original permissions and resolves the exact-current-group addgroup exception before admission', async () => {
    const f = fixture();
    f.aliases.stats = ['状态'];
    f.aliases.addgroup = ['授权'];
    for (const update of [message('/状态', { user: 10 }), message('/状态', { chat: -100 }),
      message('/授权', { user: 10, chat: -200 }), message('/授权 -300', { chat: -200 })]) {
      delete update.message!.entities;
      await f.bot.handleUpdate(update);
    }
    expect(f.execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(message('/授权', { chat: -200, thread: 9 }));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 1, chat: { id: -200, type: 'supergroup', threadId: 9 } }),
      'groups.authorize', { chatId: -200, revision: 3, groupRevision: 1 });
    await f.bot.handleUpdate(message('/帮助', { chat: -200 }));
    expect(f.sent().at(-1)!.payload.text).toContain('/addgroup@offline_bot');
    expect(f.execute).toHaveBeenCalledOnce();
  });

  it('never admits aliases from other bots, bot/anonymous/business/edited senders or unauthorized ordinary groups', async () => {
    const f = fixture();
    const base = message('/幫助').message!;
    delete base.entities;
    const updates = [message('/幫助@other_bot'), message('/幫助', { bot: true }), message('/幫助', { user: 10, chat: -200 }),
      { update_id: ++sequence, message: { ...base, sender_chat: { id: -100, type: 'supergroup', title: 'Anonymous' } } },
      { update_id: ++sequence, edited_message: base }, { update_id: ++sequence, business_message: base },
      { update_id: ++sequence, message: { ...base, business_connection_id: 'business' } },
      { update_id: ++sequence, message: { ...base, guest_query_id: 'guest' } }];
    for (const update of updates) await f.bot.handleUpdate(update as Update);
    expect(f.calls).toEqual([]);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(0);
  });

  it('keeps unmigrated legacy actions unknown rather than treating them as aliases', async () => {
    const f = fixture();
    for (const command of ['/hug', '/抱抱', '/legacy_echo']) await f.bot.handleUpdate(message(command));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sent()).toHaveLength(3);
    expect(f.sent().every(call => String(call.payload.text).includes('Unknown command'))).toBe(true);
  });

  it('fetches aliases on each catalogue render only for currently visible canonical commands', async () => {
    const f = fixture();
    f.aliases.stats = ['private_status'];
    await f.bot.handleUpdate(message('/commands', { user: 10 }));
    const pane = f.last(10);
    expect(richText(pane)).toContain('/幫助');
    expectNativeCommands(f.sent()[0]!.payload.rich_message,
      ['/start', '/help', '/帮助', '/幫助', '/ヘルプ', '/id', '/modules', '/commands', '/cancel', '/help']);
    expect(richText(pane)).not.toContain('private_status');
    expect(f.aliasesFor.mock.calls.flat()).not.toContain('stats');
    expect(f.aliasesFor.mock.calls.flat()).not.toContain('alias');
    f.aliases.help = ['动态帮助'];
    await f.bot.handleUpdate(f.click('page:1', pane, { user: 10 }));
    await f.bot.handleUpdate(f.click('page:0', pane, { user: 10 }));
    expect(richText(pane)).toContain('/动态帮助');
    expect(richText(pane)).not.toContain('/幫助');
    expectNativeCommands(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.rich_message,
      ['/start', '/help', '/动态帮助', '/id', '/modules', '/commands', '/cancel', '/help']);
    expect(f.sent()).toHaveLength(1);
  });

  it('reopens an expired settings panel as a new rich message with a fresh token and generation zero', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { thread: 9 }));
    const expired = f.last(1, 9);
    const oldToken = buttonData(expired, 'lang:en').split(':')[3];
    await vi.advanceTimersByTimeAsync(600_000);
    expectClosed(expired, 's');
    const reopen = callback('mk:open:s:1', { thread: 9 }, expired);
    expect(reopen.callback_query!.message).toHaveProperty('rich_message');
    expect(reopen.callback_query!.message).not.toHaveProperty('text');
    f.execute.mockClear();
    await f.bot.handleUpdate(reopen);
    const fresh = f.last(1, 9);
    expect(fresh.message_id).not.toBe(expired.message_id);
    expect(buttonData(fresh, 'lang:en')).toMatch(/^mk:ui:s:[a-f0-9]{24}:0:lang:en$/);
    expect(buttonData(fresh, 'lang:en').split(':')[3]).not.toBe(oldToken);
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['preferences.get', 'core.settings.get']);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(1);
    expectClosed(expired, 's');
  });

  it.each(['/settings', '/cancel'])('reopens a settings panel closed by %s without retaining old pending choices', async closingCommand => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const closed = f.last();
    const oldButton = f.click('corelang:ja', closed);
    await f.bot.handleUpdate(message(closingCommand));
    expectClosed(closed, 's');
    f.execute.mockClear();
    await f.bot.handleUpdate(callback('mk:open:s:1', {}, closed));
    const fresh = f.last();
    expect(fresh.message_id).not.toBe(closed.message_id);
    expect(buttonData(fresh, 'corelang:ja')).toMatch(/^mk:ui:s:[a-f0-9]{24}:0:corelang:ja$/);
    await f.bot.handleUpdate(oldButton);
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['preferences.get', 'core.settings.get']);
    expect(f.settings.revision).toBe(0);
    expect(f.adapter.panels.size).toBe(1);
  });

  it('reopens stable readonly callbacks after restart without restoring expired mutations', async () => {
    const old = fixture();
    await old.bot.handleUpdate(message('/settings'));
    const pane = structuredClone(old.last());
    const expired = buttonData(pane, 'corelang:en');
    await old.adapter.stop();
    const fresh = fixture();
    fresh.messages.push(pane);
    await fresh.bot.handleUpdate(callback(expired, {}, pane));
    expectClosed(pane, 's');
    await fresh.bot.handleUpdate(callback('mk:open:s:1', {}, pane));
    expect(fresh.last().message_id).not.toBe(pane.message_id);
    expect(fresh.execute.mock.calls.map(call => call[1])).toEqual(['preferences.get', 'core.settings.get']);
    expect(fresh.confirm).not.toHaveBeenCalled();
    expect(fresh.choices.size).toBe(0);
    expect(fresh.settings.revision).toBe(0);
  });

  it.each(['/commands', '/cancel'])('closes a non-expiring catalogue with %s and only reopens a fresh view', async command => {
    vi.useFakeTimers();
    const f = fixture();
    await f.bot.handleUpdate(message('/commands'));
    const closed = f.last();
    const stale = f.click('page:1', closed);
    const oldToken = stale.callback_query!.data!.split(':')[3];
    await vi.advanceTimersByTimeAsync(600_001);
    await f.bot.handleUpdate(message(command));
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(command === '/cancel' ? ['sticker.cancel'] : []);
    f.execute.mockClear();
    expectClosed(closed, 'c');
    await f.bot.handleUpdate(callback('mk:open:c:1', {}, closed));
    const fresh = f.last();
    expect(fresh.message_id).not.toBe(closed.message_id);
    expect(buttonData(fresh, 'page:1')).toMatch(/^mk:ui:c:[a-f0-9]{24}:0:page:1$/);
    expect(buttonData(fresh, 'page:1').split(':')[3]).not.toBe(oldToken);
    const markup = structuredClone(fresh.rich_message);
    await f.bot.handleUpdate(stale);
    expect(fresh.rich_message).toEqual(markup);
    expectClosed(closed, 'c');
    expect(f.adapter.panels.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('invalidates an old non-expiring catalogue after restart and reopens with a fresh token', async () => {
    vi.useFakeTimers();
    const old = fixture();
    await old.bot.handleUpdate(message('/commands', { thread: 9 }));
    const pane = structuredClone(old.last(1, 9));
    const data = buttonData(pane, 'page:1');
    await old.adapter.stop();
    const fresh = fixture();
    fresh.messages.push(pane);
    await fresh.bot.handleUpdate(callback(data, { thread: 9 }, pane));
    expectClosed(pane, 'c');
    expect(fresh.adapter.panels.size).toBe(0);
    await fresh.bot.handleUpdate(callback('mk:open:c:1', { thread: 9 }, pane));
    const reopened = fresh.last(1, 9);
    expect(reopened.message_id).not.toBe(pane.message_id);
    expect(buttonData(reopened, 'page:1')).toMatch(/^mk:ui:c:[a-f0-9]{24}:0:page:1$/);
    expect(buttonData(reopened, 'page:1').split(':')[3]).not.toBe(data.split(':')[3]);
    expect(fresh.adapter.panels.size).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(fresh.execute).not.toHaveBeenCalled();
    expect(fresh.confirm).not.toHaveBeenCalled();
  });

  it('rejects reopen from other actors, non-bot messages, missing messages and injected routes', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const pane = f.last();
    await f.bot.handleUpdate(message('/cancel'));
    const missing = callback('mk:open:s:1', {}, pane);
    delete missing.callback_query!.message;
    const inaccessible = callback('mk:open:s:1', {}, pane);
    inaccessible.callback_query!.message!.date = 0;
    const updates = [callback('mk:open:s:1', { user: 2 }, pane), callback('mk:open:s:1', { bot: true }, pane),
      callback('mk:open:s:1', {}, { ...pane, from: { ...me, id: 999 } } as Message),
      callback('mk:open:s:1', {}, { ...pane, from: undefined } as Message), missing, inaccessible,
      ...['mk:open:x:1', 'mk:open:s:1:corelang:ja', 'mk:open:g:1:confirm', 'mk:open:s:0'].map(data => callback(data, {}, pane))];
    const sends = f.sent().length;
    f.execute.mockClear();
    for (const update of updates) await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(sends);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(updates.length);
  });

  it('freshly checks admin role and group admission for readonly reopen routes', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/listgroups'));
    const groups = f.last();
    await f.bot.handleUpdate(message('/cancel'));
    await f.bot.handleUpdate(message('/commands', { chat: -100 }));
    const catalogue = f.last(-100);
    await f.bot.handleUpdate(message('/cancel', { chat: -100 }));
    const sends = f.sent().length;
    f.execute.mockClear();
    f.access.isAdmin.mockReturnValue(false);
    f.allowed.delete(-100);
    await f.bot.handleUpdate(callback('mk:open:g:1', {}, groups));
    await f.bot.handleUpdate(callback('mk:open:c:1', { chat: -100 }, catalogue));
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.sent()).toHaveLength(sends);
    expect(f.adapter.panels.size).toBe(0);
  });

  it('reopens settings with the current reduced role, never resurrecting administrative controls', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const pane = f.last();
    await f.bot.handleUpdate(message('/cancel'));
    f.access.isAdmin.mockReturnValue(false);
    f.execute.mockClear();
    await f.bot.handleUpdate(callback('mk:open:s:1', {}, pane));
    expect(f.last().message_id).not.toBe(pane.message_id);
    expect(callbacks(f.last()).some(data => data.includes(':corelang:'))).toBe(false);
    expect(callbacks(f.last()).filter(data => data.includes(':lang:'))).toHaveLength(5);
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['preferences.get']);
  });

  it('rechecks reopen authorization after callback acknowledgement was in flight', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/listgroups'));
    const pane = f.last();
    await f.bot.handleUpdate(message('/cancel'));
    const entered = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    cleanups.unshift(async () => { gate.resolve(); });
    f.delayApi(async call => {
      if (call.method === 'answerCallbackQuery') { entered.resolve(); await gate.promise; }
    });
    f.execute.mockClear();
    const reopening = f.bot.handleUpdate(callback('mk:open:g:1', {}, pane));
    await entered.promise;
    f.access.isAdmin.mockReturnValue(false);
    gate.resolve();
    await reopening;
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.adapter.panels.size).toBe(0);
  });

  it('rejects a forged live callback route even when its panel token, generation and operation are valid', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings'));
    const pane = f.last();
    const markup = structuredClone(pane.rich_message);
    const forged = buttonData(pane, 'lang:en').replace('mk:ui:s:', 'mk:ui:a:');
    f.execute.mockClear();
    await f.bot.handleUpdate(callback(forged, {}, pane));
    expect(f.execute).not.toHaveBeenCalled();
    expect(pane.rich_message).toEqual(markup);
  });
});

describe('system membership and Telegram effects', () => {
  function membership(actor = 10): Update {
    return { update_id: ++sequence, my_chat_member: {
      chat: { id: -200, type: 'supergroup', title: '<b>Invite</b>' }, from: { id: actor, is_bot: false, first_name: 'Inviter' }, date: 100,
      old_chat_member: { status: 'left', user: me }, new_chat_member: { status: 'member', user: me },
    } };
  }

  it('warns once on ordinary invite and prepares private recipient-bound approval tokens', async () => {
    const f = fixture();
    f.choices.set(2, 'en');
    const update = membership();
    await f.bot.handleUpdate(update);
    expect(f.access.membership).toHaveBeenCalledWith(expect.objectContaining({ actorId: 10, isMember: true, wasMember: false, chatId: -200 }), expect.any(AbortSignal));
    expect(f.prepare).toHaveBeenCalledTimes(2);
    expect(f.prepare.mock.calls[0]).toEqual([expect.objectContaining({ actorId: 1, chat: { id: 1, type: 'private' }, language: 'zh-CN' }), 'groups.authorize', { chatId: -200, revision: 3, groupRevision: 1 }]);
    expect(f.sent().find(call => call.payload.chat_id === -200)!.payload.text).toContain('尚未授权');
    expect(richText(f.sent().find(call => call.payload.chat_id === 2)!.payload.rich_message)).toContain('waiting for approval');
    f.access.membership.mockResolvedValueOnce({ kind: 'duplicate', changed: false, chatId: -200, revision: 3, groupRevision: 1 });
    await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(3);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('never grants when warnings or private notifications fail', async () => {
    const f = fixture();
    f.failApi(call => call.method === 'sendMessage');
    await expect(f.bot.handleUpdate(membership())).resolves.toBeUndefined();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.health.recordApiError).toHaveBeenCalledWith('TELEGRAM_403');
    expect(JSON.stringify(f.health.recordApiError.mock.calls)).not.toContain('sensitive-token');
  });

  it('delegates admin invitation and leave to the internal membership entry only', async () => {
    const f = fixture();
    f.access.membership.mockResolvedValueOnce({ kind: 'authorized', changed: true, chatId: -200, revision: 3, groupRevision: 1 });
    await f.bot.handleUpdate(membership(1));
    const left = membership(1);
    left.my_chat_member!.old_chat_member = { status: 'member', user: me };
    left.my_chat_member!.new_chat_member = { status: 'left', user: me };
    f.access.membership.mockResolvedValueOnce({ kind: 'left', changed: true, chatId: -200, revision: 3, groupRevision: 1 });
    await f.bot.handleUpdate(left);
    expect(f.access.membership).toHaveBeenCalledTimes(2);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('accepts genuine service migration without human sessions or group admission', async () => {
    const f = fixture();
    const update = message('', { chat: -200, bot: true });
    update.message!.migrate_to_chat_id = -300;
    await f.bot.handleUpdate(update);
    expect(f.access.migrate).toHaveBeenCalledWith(-200, -300, update.update_id, expect.any(AbortSignal));
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.sent()).toEqual([]);
  });

  it('validates group identity and bot membership with fixed Telegram methods', async () => {
    const f = fixture();
    const effects = createTelegramEffects(f.bot, f.configuration, f.health, config.adminIds);
    expect(await effects.describeGroup(-100, f.controller.signal)).toEqual({ title: '<b>Group</b>', present: true });
    expect(f.calls.map(call => call.method)).toEqual(['getChat', 'getChatMember']);
    expect(f.calls.every(call => call.signal === f.controller.signal)).toBe(true);
    await expect(effects.describeGroup(1, f.controller.signal)).rejects.toThrow('INVALID_INPUT');
    f.failApi(call => call.method === 'getChatMember');
    await expect(effects.describeGroup(-100, f.controller.signal)).rejects.toThrow('UNAVAILABLE');
  });

  it('returns partial-effect booleans and propagates cancellation rather than swallowing it', async () => {
    const f = fixture();
    const effects = createTelegramEffects(f.bot, f.configuration, f.health, config.adminIds);
    f.failApi(() => true);
    expect(await effects.notifyGroup(-100, 'revoked', 'en', f.controller.signal)).toBe(false);
    expect(await effects.leaveGroup(-100, f.controller.signal)).toBe(false);
    f.controller.abort();
    await expect(effects.notifyGroup(-100, 'authorized', 'en', f.controller.signal)).rejects.toThrow('CANCELLED');
    await expect(effects.leaveGroup(-100, f.controller.signal)).rejects.toThrow('CANCELLED');
  });

  it('syncs explicit menu language for every Telegram language selector, and auto restores selectors', async () => {
    const f = fixture();
    const effects = createTelegramEffects(f.bot, f.configuration, f.health, config.adminIds);
    f.choices.set(1, 'en');
    expect(await effects.syncPrivateMenu(1, 'en', f.controller.signal)).toBe(true);
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every(call => JSON.stringify(call.payload.commands) === JSON.stringify(menuCommands('en', true, true)))).toBe(true);
    f.calls.length = 0;
    f.choices.set(1, 'auto');
    await effects.syncPrivateMenu(1, 'en', f.controller.signal);
    expect(f.calls.map(call => call.payload.language_code ?? '').sort()).toEqual(['', 'en', 'ja', 'zh']);
    expect(f.calls.find(call => call.payload.language_code === 'zh')!.payload.commands).toEqual(menuCommands('zh-CN', true, true));
    expect(f.calls.find(call => call.payload.language_code === 'ja')!.payload.commands).toEqual(menuCommands('ja', true, true));
    expect(f.calls.find(call => call.payload.language_code === 'en')!.payload.commands).toEqual(menuCommands('en', true, true));
    expect(f.calls.find(call => !call.payload.language_code)!.payload.commands).toEqual(menuCommands('zh-CN', true, true));
  });

  it('ack failures are sanitized and do not repeat business execution', async () => {
    const f = fixture();
    await f.bot.handleUpdate(message('/settings', { user: 10 }));
    f.failApi(call => call.method === 'answerCallbackQuery');
    await f.bot.handleUpdate(f.click('lang:en', f.last(10), { user: 10 }));
    expect(f.execute.mock.calls.filter(call => call[1] === 'preferences.set')).toHaveLength(1);
    expect(f.health.recordApiError).toHaveBeenCalledWith('TELEGRAM_403');
  });
});
