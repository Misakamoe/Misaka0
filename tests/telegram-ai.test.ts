import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Bot, Context, InputFile } from 'grammy';
import type { Message, Update, UserFromGetMe } from 'grammy/types';
import type { ActionResult, Confirmation } from '../shared/schemas/index.js';
import type { AutomationView } from '../shared/schemas/ai-automation.js';
import type { ActionExecutor, InvocationContext } from '../src/actions.js';
import type { AccessService } from '../src/access.js';
import type { ConfigurationService } from '../src/configuration.js';
import type { StartupConfig } from '../src/config.js';
import type { AiCapturedFile, AiDelivery, AiDeliveryTarget, AiTelegramPort } from '../src/ai/telegram-port.js';
import { createTelegramAdapter } from '../src/telegram/index.js';
import { createAiTelegramAdapter } from '../src/telegram/ai.js';
import { commands } from '../src/telegram/commands.js';
import { translator } from '../src/i18n.js';
import { AppError } from '../src/errors.js';
import { buttonRows, callbacks, recordContent, richText, telegramMessage } from './support/telegram.js';
import { offlineStickers } from './support/core.js';

const me: UserFromGetMe = { id: 12345, first_name: 'Offline', username: 'offline_bot', is_bot: true,
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, can_connect_to_business: false,
  has_main_web_app: false, has_topics_enabled: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
let sequence = 100;
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function update(text: string, options: { actor?: number; chat?: number; thread?: number; reply?: Message; extra?: Partial<Message> } = {}): Update {
  const actor = options.actor ?? 3; const chat = options.chat ?? actor;
  return { update_id: ++sequence, message: { message_id: sequence, date: 100, from: { id: actor, first_name: 'Person', is_bot: false, language_code: 'en' },
    chat: chat > 0 ? { id: chat, type: 'private', first_name: 'Private' } : { id: chat, type: 'supergroup', title: 'Group' },
    text, message_thread_id: options.thread, is_topic_message: options.thread !== undefined, reply_to_message: options.reply,
    ...options.extra } as NonNullable<Update['message']> };
}
function click(message: Message, data = callbacks(message)[0]!, actor = 3): Update {
  return { update_id: ++sequence, callback_query: { id: `callback${sequence}`, chat_instance: 'offline',
    from: { id: actor, first_name: 'Person', is_bot: false }, data, message: telegramMessage(message) } };
}
function control(message: Message, label: string): string {
  const button = buttonRows(message).flat().find(button => richText(button.text) === label);
  if (!button || !('callback_data' in button)) throw new Error(`Missing control: ${label}`);
  return button.callback_data;
}
const success = (data: unknown): ActionResult => ({ status: 'succeeded', invocationId: 'offline', data });
const confirmation = (token = 'approval-token', actionId = 'ai.mcp.call'): Confirmation => ({
  token, actionId, target: 'user:3', expiresAt: new Date(Date.now() + 60_000).toISOString(),
});
async function proposalContents(payload: Record<string, unknown>): Promise<string> {
  expect(payload.document).toBeInstanceOf(InputFile);
  const bytes = await (payload.document as InputFile).toRaw();
  expect(bytes).toBeInstanceOf(Uint8Array);
  return Buffer.from(bytes as Uint8Array).toString('utf8');
}
const target = (chat = 3, thread?: number, actor = 3, runId = 'run-1'): AiDeliveryTarget => ({
  botId: me.id, actorId: actor, runId, conversationId: 'conversation-1', language: 'en',
  chat: { id: chat, type: chat > 0 ? 'private' : 'supergroup', threadId: thread },
});

function fixture(dedicated = false) {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const messages: Message[] = [];
  const controller = new AbortController();
  let available = true;
  let delivery!: AiDelivery;
  let download!: (file: AiCapturedFile, signal: AbortSignal) => Promise<Uint8Array>;
  const bot = new Bot('12345:offline-token', { botInfo: { ...me }, client: { fetch: vi.fn(() => { throw new Error('Network forbidden'); }) } });
  let intercept: ((method: string, payload: Record<string, unknown>) => Promise<unknown>) | undefined;
  bot.api.config.use(async (_previous, method, payload) => {
    const data = payload as Record<string, unknown>;
    calls.push({ method, payload: data });
    const overridden = await intercept?.(method, data);
    if (overridden !== undefined) return overridden as never;
    let result: unknown = true;
    if (method === 'sendMessage' || method === 'sendRichMessage' || method === 'sendDocument' || method === 'sendPhoto' || method === 'sendAudio') {
      const chatId = Number(data.chat_id);
      const sent = { message_id: ++sequence, from: me, date: 100,
        chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'Private' } : { id: chatId, type: 'supergroup', title: 'Group' },
        message_thread_id: data.message_thread_id, is_topic_message: data.message_thread_id !== undefined } as Message;
      recordContent(sent, data); messages.push(sent); result = telegramMessage(sent);
    }
    if (method === 'editMessageText') {
      const sent = messages.find(item => item.chat.id === data.chat_id && item.message_id === data.message_id);
      if (sent) { recordContent(sent, data); result = telegramMessage(sent); }
    }
    if (method === 'createForumTopic') result = { message_thread_id: 88, name: data.name, icon_color: 1 };
    if (method === 'getFile') result = { file_id: 'file', file_unique_id: 'unique', file_path: 'documents/file.pdf', file_size: 5 };
    return { ok: true, result } as never;
  });
  const ownedReplies = new Set<number>();
  const capture = vi.fn<AiTelegramPort['capture']>(async () => `owned-${sequence}`);
  const port: AiTelegramPort = { available: vi.fn(() => available), capture,
    isReply: vi.fn((_ctx, id) => ownedReplies.has(id)), attachTelegram: (value, fetchFile) => { delivery = value; download = fetchFile; } };
  const execute = vi.fn(async (_ctx: InvocationContext, action: string, _input: unknown): Promise<ActionResult> => {
    if (action === 'ai.run.start') return success({ runId: 'run-1', conversationId: 'conversation-1' });
    if (action === 'ai.run.status') return success({ runId: 'run-1', state: 'running' });
    if (action.endsWith('.list')) return success({ items: [], nextCursor: null });
    if (action === 'core.info') return success({ runtime: 'grammy', version: 'offline', moduleCount: 7, aiAvailable: true });
    if (action === 'alias.list') return success({ aliases: {}, revision: 0 });
    return success({});
  });
  const confirm = vi.fn(async () => success({}));
  const pendingDetails = vi.fn<ActionExecutor['pendingDetails']>(() => { throw new AppError('CONFIRMATION_EXPIRED'); });
  const executor = { execute, confirm, pendingDetails, resolveAlias: (value: string) => value === 'ask' ? 'ai' : value === 'hello' ? 'help' : undefined,
    aliasesFor: () => [] } as unknown as ActionExecutor;
  const access = { isAllowed: (id: number) => id === -100, isAdmin: (id: number) => id === 1 } as unknown as AccessService;
  const configuration = { resolveLanguage: () => 'en' } as unknown as ConfigurationService;
  const health = { recordApiError: vi.fn(), recordUpdate: vi.fn() };
  const fetcher = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70, 45]), { headers: { 'content-length': '5' } }));
  const stickers = offlineStickers(); cleanups.push(() => stickers.stop());
  const adapter = dedicated ? createAiTelegramAdapter(bot, { ai: port, executor, access, configuration, health, signal: controller.signal,
    token: '12345:offline-token', fetch: fetcher }) : createTelegramAdapter(bot, { ai: port, executor, access, configuration, health,
    signal: controller.signal, stickers, config: { botToken: '12345:offline-token', adminIds: [1], dataDir: '/tmp/kilo/offline',
      logLevel: 'silent', pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
      web: { enabled: false, host: '127.0.0.1', port: 8080 } } as StartupConfig });
  cleanups.push(() => adapter.stop());
  return { bot, adapter, calls, messages, execute, confirm, pendingDetails, capture, ownedReplies, port, health, controller, fetcher,
    delivery: () => delivery, download: (file: AiCapturedFile) => download(file, controller.signal),
    available: (value: boolean) => { available = value; }, intercept: (fn: typeof intercept) => { intercept = fn; },
    context: (value: Update) => new Context(value, bot.api, bot.botInfo) };
}

describe('AI Telegram routing and owned input', () => {
  it('reserves native names and preserves aliases, commands, forms and weather priority', async () => {
    const f = fixture();
    expect(commands.filter(item => ['ai', 'chats', 'memory', 'tasks', 'aiconfig'].includes(item.name))).toHaveLength(5);
    await f.bot.handleUpdate(update('/hello'));
    await f.bot.handleUpdate(update('/unknown'));
    await f.bot.handleUpdate(update('/ai@other_bot hidden'));
    await f.bot.handleUpdate(update('', { extra: { text: undefined, caption: '/ai@other_bot hidden',
      photo: [{ file_id: 'photo', file_unique_id: 'unique', width: 1, height: 1, file_size: 10 }] } }));
    expect(f.execute).not.toHaveBeenCalledWith(expect.anything(), 'ai.run.start', expect.anything());
    await f.bot.handleUpdate(update('/ask explain weather'));
    await f.bot.handleUpdate(update('Beijing weather'));
    expect(f.execute.mock.calls.filter(call => call[1] === 'ai.run.start').map(call => call[2])).toEqual([
      { text: 'explain weather' }, { text: 'Beijing weather' },
    ]);
  });

  it('does not forward pending sensitive forms, foreign or stale bot prompts', async () => {
    const f = fixture();
    const prompt = update('private token').message!;
    prompt.from = me; prompt.message_id = 900;
    await f.bot.handleUpdate(update('secret source', { reply: prompt }));
    expect(f.execute).not.toHaveBeenCalled();
    const key = `${me.id}:3:3:0`;
    const adapter = f.adapter as ReturnType<typeof createTelegramAdapter>;
    adapter.sessions.set(key, { subconvInput: { panelId: 'expired', messageId: 900, promptMessageId: 901,
      field: 'source', revision: 0, generation: 0 } });
    await f.bot.handleUpdate(update('https://secret.invalid/subscription'));
    expect(f.execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(update('/ai do not quote', { reply: prompt }));
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('admits only explicit group triggers and quotes refs, never reply bodies or previous actors', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('ordinary conversation', { chat: -100 }));
    await f.bot.handleUpdate(update('/ai forbidden', { chat: -200 }));
    expect(f.execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(update('@offline_bot explain', { chat: -100, thread: 7,
      extra: { entities: [{ type: 'mention', offset: 0, length: 12 }] } }));
    const reply = update('DO NOT COPY PRIVATE HISTORY', { chat: -100, thread: 7 }).message!; reply.from = me;
    f.ownedReplies.add(reply.message_id);
    await f.bot.handleUpdate(update('continue', { chat: -100, thread: 7, actor: 4, reply }));
    const starts = f.execute.mock.calls.filter(call => call[1] === 'ai.run.start');
    expect(starts).toHaveLength(2);
    expect(starts[1]![0]).toMatchObject({ actorId: 4, source: 'telegram', chat: { id: -100, threadId: 7 } });
    expect(starts[1]![2]).toEqual({ text: 'continue', replyTo: reply.message_id });
    await f.bot.handleUpdate(update('wrong topic', { chat: -100, thread: 8, reply }));
    expect(f.execute.mock.calls.filter(call => call[1] === 'ai.run.start')).toHaveLength(2);
  });

  it('ignores reply thread numbers unless Telegram marks a real topic', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('/ai hello', { extra: { message_thread_id: 55, is_topic_message: false } }));
    expect(f.execute.mock.calls[0]![0].chat.threadId).toBeUndefined();
  });

  it('captures supported files as opaque refs and rejects oversized files and video', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('', { extra: { document: { file_id: 'file', file_unique_id: 'unique', mime_type: 'application/pdf', file_name: 'safe.pdf', file_size: 4 } } }));
    expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3 }), expect.objectContaining({ kind: 'document', fileId: 'file', size: 4 }));
    expect(f.execute.mock.calls[0]![2]).toMatchObject({ text: '', attachments: [expect.stringMatching(/^owned-/)] });
    await f.bot.handleUpdate(update('/ai explain', { extra: { video: { file_id: 'video', file_unique_id: 'unique', duration: 1, width: 8, height: 8 } } }));
    await f.bot.handleUpdate(update('/ai explain', { extra: { document: { file_id: 'huge', file_unique_id: 'unique', mime_type: 'text/plain', file_size: 1_048_577 } } }));
    expect(f.capture).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['image/png', '89504e470d0a1a0a0000000d49484452'],
    ['image/jpeg', 'ffd8ffe000104a46494600'],
    ['image/webp', '524946461000000057454250'],
    ['image/gif', '47494638396101000100000000'],
  ] as const)('treats a document with %s as image input and validates its download header', async (mimeType, hex) => {
    const f = fixture(true); const bytes = Buffer.from(hex, 'hex');
    await (f.adapter as ReturnType<typeof createAiTelegramAdapter>).input(f.context(update('', { extra: { text: undefined, caption: 'Describe this picture', document: {
      file_id: 'image-file', file_unique_id: 'unique-image', mime_type: mimeType, file_name: 'picture.bin', file_size: bytes.length,
    } } })));
    expect(f.capture).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3 }), expect.objectContaining({ kind: 'image', mimeType, size: bytes.length }));
    expect(f.execute.mock.calls[0]![2]).toMatchObject({ text: 'Describe this picture', attachments: [expect.stringMatching(/^owned-/)] });
    f.intercept(async method => method === 'getFile' ? { ok: true, result: { file_id: 'image-file', file_path: 'documents/picture.bin', file_size: bytes.length } } : undefined);
    f.fetcher.mockResolvedValue(new Response(Uint8Array.from(bytes), { headers: { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' } }));
    const file = f.capture.mock.calls[0]![1];
    expect(await f.download(file)).toEqual(new Uint8Array(bytes));
    f.fetcher.mockResolvedValue(new Response(Uint8Array.from(Buffer.alloc(bytes.length, 0)), { headers: { 'content-length': String(bytes.length) } }));
    await expect(f.download(file)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('aggregates at most five album photos into one action and rejects the entire oversized album', async () => {
    vi.useFakeTimers(); const f = fixture();
    for (let index = 0; index < 5; index++) await f.bot.handleUpdate(update('', { extra: { media_group_id: 'album',
      photo: [{ file_id: `photo${index}`, file_unique_id: `unique${index}`, width: 5, height: 5, file_size: 100 }], caption: index === 0 ? 'describe' : undefined } }));
    expect(f.execute).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(700);
    expect(f.capture).toHaveBeenCalledTimes(5);
    expect(f.execute.mock.calls[0]![2]).toMatchObject({ attachments: expect.any(Array) });
    expect((f.execute.mock.calls[0]![2] as { attachments: string[] }).attachments).toHaveLength(5);
    for (let index = 0; index < 6; index++) await f.bot.handleUpdate(update('', { extra: { media_group_id: 'oversized',
      photo: [{ file_id: `photo${index}`, file_unique_id: `unique${index}`, width: 5, height: 5, file_size: 100 }] } }));
    await vi.advanceTimersByTimeAsync(700);
    expect(f.capture).toHaveBeenCalledTimes(5);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('accepts /ai captions but retains standalone sticker native handling', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('', { chat: -100, extra: { text: undefined, caption: '/ai describe',
      photo: [{ file_id: 'photo', file_unique_id: 'unique', width: 5, height: 5, file_size: 100 }] } }));
    expect(f.execute.mock.calls[0]![2]).toMatchObject({ text: 'describe', attachments: expect.any(Array) });
    await f.bot.handleUpdate(update('', { extra: { sticker: { file_id: 'sticker', file_unique_id: 'unique', width: 5, height: 5,
      type: 'regular', is_animated: false, is_video: false, file_size: 100 } } }));
    expect(f.execute.mock.calls.filter(call => call[1] === 'ai.run.start')).toHaveLength(1);
  });

  it('selects a photo variant within 1 MiB and enforces that same aggregate album limit', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.bot.handleUpdate(update('', { extra: { photo: [
      { file_id: 'owned-small', file_unique_id: 'small', width: 512, height: 512, file_size: 1_048_576 },
      { file_id: 'too-large', file_unique_id: 'large', width: 1024, height: 1024, file_size: 1_048_577 },
    ] } }));
    expect(f.capture).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ fileId: 'owned-small', size: 1_048_576 }));
    for (const [album, size] of [['at-limit', 524_288], ['over-limit', 524_289]] as const) {
      for (let index = 0; index < 2; index++) await f.bot.handleUpdate(update('', { extra: { media_group_id: album,
        photo: [{ file_id: `${album}-${index}`, file_unique_id: `${album}-${index}`, width: 512, height: 512, file_size: size }] } }));
      await vi.advanceTimersByTimeAsync(700);
    }
    expect(f.capture).toHaveBeenCalledTimes(3);
    expect(f.execute.mock.calls.filter(call => call[1] === 'ai.run.start')).toHaveLength(2);
  });

  it('keeps owner controls available after AI revoke and restricts private/admin commands', async () => {
    const f = fixture(); f.available(false);
    await f.bot.handleUpdate(update('/ai stop'));
    await f.bot.handleUpdate(update('/chats'));
    await f.bot.handleUpdate(update('/memory'));
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['ai.run.stop', 'ai.conversations.list', 'ai.memory.list']);
    await f.bot.handleUpdate(update('/chats', { chat: -100 }));
    await f.bot.handleUpdate(update('/aiconfig'));
    expect(f.execute).toHaveBeenCalledTimes(3);
    await f.bot.handleUpdate(update('/cancel'));
    expect(f.execute.mock.calls.some(call => call[1] === 'ai.run.stop')).toBe(true);
  });
});

describe('AI delivery control lane', () => {
  it('retires only the exact bound run and invalidates its controls', async () => {
    const f = fixture(true); const destination = target(-100, 7); const controller = new AbortController();
    await f.delivery().started(destination, controller.signal);
    await f.delivery().approval(destination, { token: 'bound-retirement-token', actionId: 'rss.remove', target: 'group:-100:7',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, 'rss.remove', controller.signal, { id: 'feed-1', revision: 1 });
    const message = f.messages.at(-1)!; const button = callbacks(message)[0]!;
    for (const wrong of [{ ...destination, actorId: 4 }, { ...destination, botId: 99 },
      { ...destination, chat: { ...destination.chat, threadId: 8 } }, { ...destination, conversationId: 'foreign' }]) {
      await expect(f.delivery().retire(wrong)).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    await f.delivery().retire(destination); await f.delivery().retire(destination);
    await (f.adapter as ReturnType<typeof createAiTelegramAdapter>).callback(f.context(click(message, button)));
    expect(f.execute).not.toHaveBeenCalled(); expect(f.confirm).not.toHaveBeenCalled();
    expect(callbacks(message)).toHaveLength(0);
  });

  it('drains an in-flight preview before retirement completes and suppresses late updates', async () => {
    vi.useFakeTimers(); const f = fixture(true); const controller = new AbortController();
    await f.delivery().started(target(), controller.signal);
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'sendRichMessageDraft') await gate.promise; });
    await f.delivery().progress(target(), 'preview awaiting transport cleanup', controller.signal);
    await vi.advanceTimersByTimeAsync(800);
    let retired = false;
    const retirement = f.delivery().retire(target()).then(() => { retired = true; });
    const repeated = f.delivery().retire(target());
    await vi.advanceTimersByTimeAsync(0);
    expect(retired).toBe(false);
    const sent = f.calls.length;
    await f.delivery().progress(target(), 'late preview must not queue', controller.signal);
    gate.resolve(); await Promise.all([retirement, repeated]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(f.calls).toHaveLength(sent); expect(vi.getTimerCount()).toBe(0);
    await f.delivery().completed(target(), 'late final must not send', controller.signal);
    expect(f.calls).toHaveLength(sent);
  });

  it('drops expired proposal tombstones while idle without another proposal', async () => {
    vi.useFakeTimers(); const f = fixture(true); const controller = new AbortController();
    await f.delivery().started(target(), controller.signal);
    await f.delivery().approval(target(), { token: 'idle-proposal-token', actionId: 'rss.remove', target: 'user:3',
      expiresAt: new Date(Date.now() + 1000).toISOString() }, 'rss.remove', controller.signal, { id: 'feed-1', revision: 1 });
    await f.delivery().retire(target());
    const deleted = vi.spyOn(Map.prototype, 'delete');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(deleted).not.toHaveBeenCalledWith('idle-proposal-token');
    await vi.advanceTimersByTimeAsync(1);
    expect(deleted).toHaveBeenCalledWith('idle-proposal-token');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('expires closed album IDs during idle and leaves no permanent polling timer', async () => {
    vi.useFakeTimers(); const f = fixture(true);
    await (f.adapter as ReturnType<typeof createAiTelegramAdapter>).input(f.context(update('photo', { extra: { media_group_id: 'idle-album',
      photo: [{ file_id: 'photo', file_unique_id: 'unique', width: 1, height: 1, file_size: 10 }] } })));
    await vi.advanceTimersByTimeAsync(600);
    expect(f.execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.start', expect.anything());
    const key = `${me.id}:3:3:0:idle-album`;
    const deleted = vi.spyOn(Map.prototype, 'delete');
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(119_999);
    expect(deleted).not.toHaveBeenCalledWith(key);
    await vi.advanceTimersByTimeAsync(1);
    expect(deleted).toHaveBeenCalledWith(key); expect(vi.getTimerCount()).toBe(0);
  });

  it.each([3, -100])('keeps a long literal answer and explains partial failure in chat %i', async chat => {
    const f = fixture(); const controller = new AbortController(); const destination = target(chat);
    const text = '<b>literal, not markup</b> '.repeat(750);
    await f.delivery().started(destination, controller.signal);
    await f.delivery().progress(destination, text, controller.signal);
    await f.delivery().failed(destination, 'AI_OUTPUT_LIMIT', controller.signal, text);
    const payload = f.calls.filter(call => call.method === (chat > 0 ? 'sendRichMessage' : 'editMessageText')).at(-1)!.payload;
    const message = payload.rich_message as { blocks: { text: string }[]; skip_entity_detection: boolean };
    expect(message.skip_entity_detection).toBe(true);
    expect(richText(message.blocks[0])).toContain(text.trimEnd());
    expect(message.blocks.at(-1)!.text).toContain('AI_OUTPUT_LIMIT');
    expect(message.blocks.at(-1)!.text).toContain('Incomplete answer');
    expect(richText(message).length).toBeLessThanOrEqual(32_768);
    expect(richText(message)).not.toContain('Output exceeds the safe Telegram message limit');
    if (chat > 0) expect(payload.protect_content).toBe(false);
  });

  it('coalesces rich private drafts, sends one forwardable formatted answer and suppresses late sends', async () => {
    vi.useFakeTimers(); const f = fixture(); const controller = new AbortController();
    await f.delivery().started(target(), controller.signal);
    for (let index = 0; index < 20; index++) await f.delivery().progress(target(), `partial **${index}**`, controller.signal);
    expect(f.calls.filter(call => call.method === 'sendRichMessageDraft')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(800);
    const drafts = f.calls.filter(call => call.method === 'sendRichMessageDraft');
    expect(drafts).toHaveLength(2);
    expect(drafts[0]!.payload).toMatchObject({ can_stop: true, keep_on_stop: true, draft_id: expect.any(Number) });
    expect(drafts[1]!.payload).toMatchObject({ rich_message: { skip_entity_detection: true,
      blocks: [{ type: 'paragraph', text: ['partial ', { type: 'bold', text: '19' }] }] } });
    const text = '<script>literal</script> **formatted** /help @admin';
    await f.delivery().completed(target(), text, controller.signal);
    await f.delivery().completed(target(), 'duplicate', controller.signal);
    await f.delivery().progress(target(), 'late', controller.signal);
    await vi.advanceTimersByTimeAsync(5000);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
    const payload = f.calls.find(call => call.method === 'sendRichMessage')!.payload;
    expect(payload).toMatchObject({ protect_content: false, rich_message: { skip_entity_detection: true,
      blocks: [{ type: 'paragraph', text: ['<script>literal</script> ', { type: 'bold', text: 'formatted' }, ' /help @admin'] }] } });
    expect(payload).not.toHaveProperty('parse_mode');
    expect(payload.rich_message).not.toHaveProperty('markdown'); expect(payload.rich_message).not.toHaveProperty('html');
  });

  it('uses editMessageText with native rich content for groups and does not overwrite final output on expiry', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(-100, 9), s);
    const first = f.messages[0]!;
    expect(callbacks(first)[0]).toMatch(/^mk:ai:/);
    await f.delivery().progress(target(-100, 9), '**partial**', s);
    await vi.advanceTimersByTimeAsync(800);
    expect(f.calls.at(-1)!.payload).toMatchObject({ rich_message: { blocks: [
      { type: 'paragraph', text: { type: 'bold', text: 'partial' } }, { type: 'buttons' },
    ] } });
    const id = await f.delivery().completed(target(-100, 9), '# Finished\n\nRendered *answer*.', s);
    expect(id).toBe(first.message_id);
    await vi.advanceTimersByTimeAsync(600_001);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
    expect(f.calls.at(-1)).toMatchObject({ method: 'editMessageText', payload: { rich_message: { blocks: [
      { type: 'paragraph', text: { type: 'bold', text: 'Finished' } },
      { type: 'paragraph', text: ['Rendered ', { type: 'italic', text: 'answer' }, '.'] },
    ] } } });
    expect(f.calls.some(call => call.method === 'editMessageRichMessage')).toBe(false);
  });

  it.each([3, -100])('keeps the trusted incomplete notice outside an unfinished code fence in chat %i', async chat => {
    const f = fixture(); const controller = new AbortController(); const destination = target(chat);
    const partial = 'Intro **bold**\n\n```js\nconsole.log("<b>literal</b>");\n**unfinished';
    await f.delivery().started(destination, controller.signal);
    await f.delivery().progress(destination, partial, controller.signal);
    await f.delivery().failed(destination, 'TIMEOUT', controller.signal, partial);
    const payload = f.calls.filter(call => call.method === (chat > 0 ? 'sendRichMessage' : 'editMessageText')).at(-1)!.payload;
    expect(payload.rich_message).toMatchObject({ skip_entity_detection: true, blocks: [
      { type: 'paragraph', text: ['Intro ', { type: 'bold', text: 'bold' }] },
      { type: 'pre', language: 'js', text: 'console.log("<b>literal</b>");\n**unfinished' },
      { type: 'paragraph', text: expect.stringContaining('Incomplete answer') },
    ] });
    const blocks = (payload.rich_message as { blocks: { text: string }[] }).blocks;
    expect(blocks[1]!.text).not.toContain('TIMEOUT'); expect(blocks[2]!.text).toContain('TIMEOUT');
  });

  it.each([['image/png', 'sendPhoto'], ['audio/mpeg', 'sendAudio']] as const)('allows generated %s to be forwarded while keeping private tool files protected', async (mimeType, method) => {
    const f = fixture(); const signal = new AbortController().signal; const destination = target();
    await f.delivery().started(destination, signal);
    await f.delivery().file(destination, { bytes: Buffer.from('generated bytes'), name: 'generated.bin', mimeType, protectContent: false }, signal);
    expect(f.calls.find(call => call.method === method)!.payload).toMatchObject({ chat_id: 3, protect_content: false });
    await f.delivery().file(destination, { bytes: Buffer.from('private tool data'), name: 'private.txt', mimeType: 'text/plain' }, signal);
    expect(f.calls.find(call => call.method === 'sendDocument')!.payload).toMatchObject({ chat_id: 3, protect_content: true });
  });

  it('binds native stop without from to bot/chat/actual thread/draft and the stored initiating actor', async () => {
    const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(3, 7), s);
    const draft = f.calls[0]!.payload.draft_id as number;
    for (const event of [{ chat: { id: 4, type: 'private' as const, first_name: 'Other' }, draft_id: draft, message_thread_id: 7 },
      { chat: { id: 3, type: 'private' as const, first_name: 'Owner' }, draft_id: draft, message_thread_id: 8 },
      { chat: { id: 3, type: 'private' as const, first_name: 'Owner' }, draft_id: draft + 1, message_thread_id: 7 }]) {
      await f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: event });
    }
    expect(f.execute).not.toHaveBeenCalled();
    f.available(false);
    await f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: {
      chat: { id: 3, type: 'private', first_name: 'Owner' }, draft_id: draft, message_thread_id: 7,
    } });
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, source: 'telegram', chat: { id: 3, type: 'private', threadId: 7 } }), 'ai.run.stop', { runId: 'run-1' });
    await f.delivery().completed(target(3, 7), 'late final', s);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
  });

  it('handles native stop before the ordinary sequential middleware queue', async () => {
    const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    const gate = Promise.withResolvers<ActionResult>();
    f.execute.mockImplementationOnce(() => gate.promise);
    const work = f.bot.handleUpdate(update('/start'));
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1));
    await f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: {
      chat: { id: 3, type: 'private', first_name: 'Owner' }, draft_id: f.calls[0]!.payload.draft_id as number,
    } });
    expect(f.execute.mock.calls[1]![1]).toBe('ai.run.stop');
    gate.resolve(success({})); await work;
  });

  it('lets ordinary initiating actors approve once and rejects copied foreign, topic and message controls', async () => {
    const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(-100, 7), s);
    await f.delivery().approval(target(-100, 7), { token: 'secret-token', actionId: 'rss.remove', target: 'chat:-100',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, 'rss.remove', s, { id: 'feed-1', revision: 1 });
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    expect(data).not.toContain('secret-token');
    await f.bot.handleUpdate(click(message, data, 4));
    await f.bot.handleUpdate(click({ ...message, message_thread_id: 8 }, data));
    await f.bot.handleUpdate(click({ ...message, message_id: 99999 }, data));
    expect(f.execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(click(message, data));
    await f.bot.handleUpdate(click(message, data));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, source: 'telegram' }), 'ai.run.confirm', { runId: 'run-1', token: 'secret-token' });
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('never sends a fallback or error duplicate when persistent final delivery is uncertain', async () => {
    const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    f.intercept(async method => { if (method === 'sendRichMessage') throw new Error('lost response with sensitive token'); });
    await expect(f.delivery().completed(target(), 'answer', s)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await f.delivery().failed(target(), 'OUTCOME_UNKNOWN', s);
    await f.delivery().completed(target(), 'second attempt', s);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
    expect(JSON.stringify(f.health.recordApiError.mock.calls)).not.toContain('sensitive');
  });

  it('consumes a control once even when both callback acknowledgements are in flight', async () => {
    const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), { token: 'secret-token', actionId: 'weather.default.set', target: 'user:3',
      expiresAt: new Date(Date.now() + 60_000).toISOString() }, 'weather.default.set', s, { location: 'Tokyo', revision: 1 });
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'answerCallbackQuery') await gate.promise; });
    const first = f.bot.handleUpdate(click(message, data));
    const second = f.bot.handleUpdate(click(message, data));
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(2));
    gate.resolve(); await Promise.all([first, second]);
    expect(f.execute.mock.calls.filter(call => call[1] === 'ai.run.confirm')).toHaveLength(1);
  });

  it('binds resumed delivery to the current run signal rather than the pre-approval signal', async () => {
    vi.useFakeTimers(); const f = fixture(); const initial = new AbortController(); const resumed = new AbortController();
    await f.delivery().started(target(), initial.signal);
    await f.delivery().progress(target(), 'resumed answer', resumed.signal);
    initial.abort();
    await vi.advanceTimersByTimeAsync(800);
    expect(f.calls.filter(call => call.method === 'sendRichMessageDraft')).toHaveLength(2);
    resumed.abort();
    await f.delivery().completed(target(), 'suppressed', resumed.signal);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
  });

  it('rejects a confirmation that expires during callback acknowledgement', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), { token: 'secret-token', actionId: 'rss.remove', target: 'user:3',
      expiresAt: new Date(Date.now() + 1000).toISOString() }, 'rss.remove', s, { id: 'feed-1', revision: 1 });
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'answerCallbackQuery') await gate.promise; });
    const clicked = f.bot.handleUpdate(click(message, data));
    await vi.advanceTimersByTimeAsync(1500);
    gate.resolve(); await clicked;
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('drains in-flight preview cleanup after abort without holding the Action stop lane', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'sendRichMessageDraft') await gate.promise; });
    await f.delivery().progress(target(), 'pending preview', s);
    await vi.advanceTimersByTimeAsync(800);
    const stop = f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: {
      chat: { id: 3, type: 'private', first_name: 'Owner' }, draft_id: f.calls[0]!.payload.draft_id as number,
    } });
    let settled = false; void stop.then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(f.execute.mock.calls.at(-1)![1]).toBe('ai.run.stop');
    expect(settled).toBe(false);
    gate.resolve(); await stop;
    await f.delivery().completed(target(), 'late', s);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
  });

  it('honors Retry-After without blocking native stop or sending an aborted final', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = new AbortController().signal;
    await f.delivery().started(target(), s);
    f.intercept(async method => method === 'sendRichMessage' ? { ok: false, error_code: 429, description: 'limited', parameters: { retry_after: 10 } } : undefined);
    const completed = f.delivery().completed(target(), 'answer', s);
    const rejected = expect(completed).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(0);
    await f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: {
      chat: { id: 3, type: 'private', first_name: 'Owner' }, draft_id: f.calls[0]!.payload.draft_id as number,
    } });
    await rejected;
    expect(f.execute.mock.calls.at(-1)![1]).toBe('ai.run.stop');
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
  });
});

describe('informed AI approvals', () => {
  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('shows authoritative RSS names and IDs literally in %s without changing proposed parameters', async language => {
    const f = fixture(); const s = f.controller.signal; const destination = { ...target(), language };
    const subject = { kind: 'rss' as const, id: '3ab58ce2bce3', title: '<b>NASA</b> **literal** @not_a_mention' };
    const approval = { ...confirmation('rss-subject-token', 'rss.update'), subject };
    const input = { id: subject.id, revision: 7, title: 'Proposed new name' };
    await f.delivery().started(destination, s);
    await f.delivery().approval(destination, approval, approval.actionId, s, input);
    const card = f.messages.at(-1)!; const serialized = JSON.stringify(card.rich_message);
    expect(richText(card)).toContain(translator(language)('bot:ai.rssSubject', { title: subject.title }));
    expect(richText(card)).toContain(JSON.stringify(input));
    expect(card.rich_message).toMatchObject({ skip_entity_detection: true });
    expect(serialized).toContain(JSON.stringify({ type: 'code', text: subject.id }));
    expect(serialized).not.toContain('"type":"mention"');
    expect(serialized).not.toContain('"type":"url"');
    expect(serialized).not.toContain(approval.token);
    const before = f.calls.length;
    await expect(f.delivery().approval(destination, { ...approval, subject: { ...subject, title: 'Another subscription label' } }, approval.actionId, s, input))
      .rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.calls).toHaveLength(before);
  });

  it('renders an unnamed RSS subject and uses authoritative fallback details when input is omitted', async () => {
    const f = fixture(); const s = f.controller.signal; const initial = confirmation('rss-fallback', 'rss.remove');
    const approval = { ...initial, subject: { kind: 'rss' as const, id: '3ab58ce2bce3', title: '' } };
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: approval.subject.id, revision: 1 } });
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), initial, initial.actionId, s);
    expect(richText(f.messages.at(-1)!)).toContain(translator('en')('bot:ai.rssSubject', { title: translator('en')('bot:rss.untitled') }));
    expect(richText(f.messages.at(-1)!)).toContain(approval.subject.id);
  });

  it.each([
    { kind: 'rss', id: '000000000000', title: 'Different ID' },
    { kind: 'rss', id: 'bad', title: 'Invalid ID' },
    { kind: 'rss', id: '3ab58ce2bce3', title: 'x'.repeat(129) },
    { kind: 'rss', id: '3ab58ce2bce3', title: 'Name', url: 'https://private.example/token' },
    { kind: 'rate', id: '3ab58ce2bce3', title: 'Wrong kind' },
  ])('rejects malformed or mismatched approval subjects before display: %j', async subject => {
    const f = fixture(); const s = f.controller.signal;
    const approval = { ...confirmation('malformed-subject', 'rss.update'), subject } as Confirmation;
    await f.delivery().started(target(), s);
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, { id: '3ab58ce2bce3', revision: 0, silent: true }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessageDraft']);
  });

  it('does not disclose approval tokens in subject names and budgets subject metadata with the proposal', async () => {
    const f = fixture(); const s = f.controller.signal;
    const approval = { ...confirmation('subject-secret-token', 'rss.update'), subject: { kind: 'rss' as const, id: '3ab58ce2bce3', title: 'subject-secret-token' } };
    await f.delivery().started(target(), s);
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, { id: approval.subject.id, revision: 0, silent: true }))
      .rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    const input = { id: approval.subject.id, data: '' }; input.data = 'x'.repeat(32 * 1024 - JSON.stringify(input).length);
    await expect(f.delivery().approval(target(), { ...approval, subject: { ...approval.subject, title: 'Visible name' } }, approval.actionId, s, input))
      .rejects.toMatchObject({ code: 'CAPACITY' });
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessageDraft']);
  });

  it('keeps approval details in place while processing and after acceptance instead of replacing the card with short text', async () => {
    const f = fixture(); const s = f.controller.signal;
    const approval = { ...confirmation('stable-card', 'rss.remove'), subject: { kind: 'rss' as const, id: '3ab58ce2bce3', title: 'NASA News' } };
    const input = { id: approval.subject.id, revision: 2 };
    await f.delivery().started(target(), s); await f.delivery().approval(target(), approval, approval.actionId, s, input);
    const card = f.messages.at(-1)!; const action = callbacks(card)[0]!;
    const original = structuredClone(card.rich_message!.blocks.filter(block => block.type !== 'buttons'));
    const gate = Promise.withResolvers<ActionResult>();
    f.execute.mockImplementationOnce(async () => gate.promise);
    const clickWork = f.bot.handleUpdate(click(card, action));
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.confirm', expect.objectContaining({ runId: 'run-1' })));
    expect(card.rich_message!.blocks.slice(0, original.length)).toEqual(original);
    expect(richText(card)).toContain(translator('en')('bot:ai.busy'));
    expect(callbacks(card)).toEqual([]);
    gate.resolve(success({ accepted: true })); await clickWork;
    expect(card.rich_message!.blocks.slice(0, original.length)).toEqual(original);
    expect(richText(card)).toContain(translator('en')('bot:ai.approvalAccepted'));
    await f.delivery().completed(target(), 'Final answer', s);
    expect(richText(card)).toContain('NASA News'); expect(richText(card)).toContain(JSON.stringify(input));
    expect(f.calls.some(call => ['deleteMessage', 'deleteMessages', 'sendMessageDraft'].includes(call.method))).toBe(false);
  });

  it('retains the displayed approval details on expiry without keeping executable controls', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = f.controller.signal;
    const approval = { ...confirmation('expired-card', 'rss.remove'), expiresAt: new Date(Date.now() + 1000).toISOString(),
      subject: { kind: 'rss' as const, id: '3ab58ce2bce3', title: 'Expired RSS label' } };
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), approval, approval.actionId, s, { id: approval.subject.id, revision: 0 });
    const card = f.messages.at(-1)!;
    await vi.advanceTimersByTimeAsync(1001);
    expect(richText(card)).toContain('Expired RSS label');
    expect(richText(card)).toContain(translator('en')('bot:ai.expired'));
    expect(callbacks(card)).toEqual([]); expect(f.execute).not.toHaveBeenCalled();
  });

  it('renders exact normalized parameters, real scope, revision and native expiry as literal rich text', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation('native-token', 'rss.update');
    const input = { id: 'feed-1', revision: 7, title: '<b>literal</b> **not markdown**', enabled: false };
    await f.delivery().started(target(-100, 9), s);
    await f.delivery().approval(target(-100, 9), approval, approval.actionId, s, input);
    const card = f.calls.filter(call => call.method === 'sendRichMessage').at(-1)!;
    expect(card.payload).toMatchObject({ chat_id: -100, message_thread_id: 9, protect_content: true, rich_message: {
      skip_entity_detection: true, blocks: expect.arrayContaining([{ type: 'paragraph', text: JSON.stringify(input) },
        { type: 'paragraph', text: expect.arrayContaining([expect.objectContaining({ type: 'date_time', unix_time: Math.floor(Date.parse(approval.expiresAt) / 1000) })]) }]),
    } });
    const text = richText(f.messages.at(-1)!);
    expect(text).toContain('rss.update');
    expect(text).toContain(translator('en')('bot:ai.approvalScope', { botId: me.id, actorId: 3, chatType: 'supergroup', chatId: -100, threadId: 9 }));
    expect(text).toContain(translator('en')('bot:ai.approvalRevision', { revision: '7' }));
    expect(text).not.toContain(approval.token);
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.confirm).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.method === 'sendDocument')).toBe(false);
    expect(card.payload).not.toHaveProperty('parse_mode');
  });

  it('shows generic MCP IDs and argument changes rather than redacting or reusing a different proposal', async () => {
    const f = fixture(); const s = f.controller.signal; const first = confirmation('first-token'); const second = confirmation('second-token');
    const input = { profileId: 'reviewed-mcp', tool: 'send_message', arguments: { destination: 'channel-A', body: 'literal <message>' } };
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), first, first.actionId, s, input);
    expect(richText(f.messages.at(-1)!)).toContain(JSON.stringify(input));
    const changed = { ...input, arguments: { ...input.arguments, destination: 'channel-B' } };
    await expect(f.delivery().approval(target(), first, first.actionId, s, changed)).rejects.toMatchObject({ code: 'CONFLICT' });
    await f.delivery().approval(target(), second, second.actionId, s, changed);
    expect(richText(f.messages.at(-1)!)).toContain('ai.mcp.call');
    expect(richText(f.messages.at(-1)!)).toContain(JSON.stringify(changed));
    expect(richText(f.messages.at(-1)!)).not.toContain('channel-A');
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(2);
  });

  it.each([1500, 1501])('uses the exact 1500-character inline threshold for a %s-character proposal', async length => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const input = { text: 'x'.repeat(length - 11) };
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), approval, approval.actionId, s, input);
    const documents = f.calls.filter(call => call.method === 'sendDocument');
    expect(documents).toHaveLength(length <= 1500 ? 0 : 1);
    if (length <= 1500) expect(richText(f.messages.at(-1)!)).toContain(JSON.stringify(input));
    else expect(await proposalContents(documents[0]!.payload)).toBe(JSON.stringify(input));
  });

  it('uses pendingDetails for human automation approvals, not raw command JSON, and rejects foreign controls', async () => {
    const f = fixture(); const approval = confirmation('automation-token', 'ai.automations.update');
    const input = { id: 'task-1', revision: 8, definition: { title: 'Normalized title', maxCostMicros: 234567,
      tools: ['weather.query'], trigger: { kind: 'once', at: '2027-01-01T00:00:00Z', timeZone: 'Asia/Tokyo' } } };
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'operation', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input });
    await f.bot.handleUpdate(update('/tasks update {"raw":"not the normalized proposal"}', { chat: -100, thread: 7 }));
    expect(f.pendingDetails).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, source: 'telegram', chat: { id: -100, type: 'supergroup', threadId: 7 } }), approval.token);
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    expect(richText(message)).toContain(JSON.stringify(input));
    expect(richText(message)).not.toContain('not the normalized proposal');
    expect(data).not.toContain(approval.token);
    await f.bot.handleUpdate(click(message, data, 4));
    await f.bot.handleUpdate(click({ ...message, message_thread_id: 8 }, data));
    await f.bot.handleUpdate(click({ ...message, message_id: message.message_id + 1000 }, data));
    expect(f.confirm).not.toHaveBeenCalled();
    await f.bot.handleUpdate(click(message, data));
    await f.bot.handleUpdate(click(message, data));
    expect(f.confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actorId: 3, source: 'telegram' }), approval.token);
  });

  it('retrieves authoritative details when the service hook omits its optional normalized input', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const input = { profileId: 'reviewed', tool: 'write', arguments: { count: 2 } };
    f.pendingDetails.mockReturnValue({ confirmation: approval, input });
    await f.delivery().started(target(), s);
    await f.delivery().approval(target(), approval, approval.actionId, s);
    expect(f.pendingDetails).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, source: 'telegram' }), approval.token);
    expect(richText(f.messages.at(-1)!)).toContain(JSON.stringify(input));
  });

  it.each([3, -100])('sends the complete large proposal once to its actual audience %s before its bound card', async chat => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const input = { text: 'x'.repeat(32 * 1024 - 11) };
    await f.delivery().started(target(chat, 7), s);
    await Promise.all([f.delivery().approval(target(chat, 7), approval, approval.actionId, s, input),
      f.delivery().approval(target(chat, 7), approval, approval.actionId, s, input)]);
    await f.delivery().approval(target(chat, 7), approval, approval.actionId, s, input);
    const uploads = f.calls.filter(call => call.method === 'sendDocument');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.payload).toMatchObject({ chat_id: chat, message_thread_id: 7, protect_content: true, disable_content_type_detection: true });
    const body = await proposalContents(uploads[0]!.payload);
    expect(Buffer.byteLength(body)).toBe(32 * 1024);
    expect(JSON.parse(body)).toEqual(input);
    expect(body).not.toContain(approval.token);
    expect((uploads[0]!.payload.document as InputFile).filename).toBe('proposed-action.json');
    const card = f.calls.filter(call => call.method === 'sendRichMessage').at(-1)!;
    expect(f.calls.indexOf(uploads[0]!)).toBeLessThan(f.calls.indexOf(card));
    expect(card.payload).toMatchObject({ reply_parameters: { message_id: f.messages.at(-2)!.message_id, allow_sending_without_reply: false } });
    expect(richText(f.messages.at(-1)!)).toContain(translator('en')('bot:ai.largeProposal'));
    expect(richText(f.messages.at(-1)!)).not.toContain(input.text);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(chat < 0 ? 2 : 1);
  });

  it('rejects oversized UTF-8 proposals and accidental approval-token disclosure before any document or card', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation();
    await f.delivery().started(target(), s);
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, { text: '\u00e9'.repeat(17_000) })).rejects.toMatchObject({ code: 'CAPACITY' });
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, { text: approval.token })).rejects.toMatchObject({ code: 'INVALID_OUTPUT' });
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessageDraft']);
  });

  it('never renders HTTP-only secret updates or unauthorized pending details', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation('secret-operation', 'ai.admin.secret.update');
    await f.delivery().started(target(), s);
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, { revision: 1, change: { value: 'DO_NOT_DISCLOSE_CREDENTIAL' } })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const unavailable = confirmation('unavailable-operation');
    await expect(f.delivery().approval(target(), unavailable, unavailable.actionId, s)).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessageDraft']);
    expect(JSON.stringify(f.calls[0])).not.toContain('DO_NOT_DISCLOSE_CREDENTIAL');
  });

  it('aborts between the proposal document and card and drains without blocking the native stop Action', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const gate = Promise.withResolvers<void>();
    await f.delivery().started(target(), s);
    f.intercept(async method => { if (method === 'sendDocument') await gate.promise; });
    const work = f.delivery().approval(target(), approval, approval.actionId, s, { text: 'x'.repeat(2000) });
    const rejected = expect(work).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.calls.some(call => call.method === 'sendDocument')).toBe(true));
    const stop = f.bot.handleUpdate({ update_id: ++sequence, stopped_message_generation: {
      chat: { id: 3, type: 'private', first_name: 'Owner' }, draft_id: f.calls[0]!.payload.draft_id as number,
    } });
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.stop', { runId: 'run-1' }));
    gate.resolve(); await Promise.all([stop, rejected]);
    expect(f.calls.filter(call => call.method === 'sendDocument')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
    await f.delivery().completed(target(), 'late', s);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
  });

  it('binds generic proposal uploads and already delivered approval buttons to owner cancellation', async () => {
    const f = fixture(true); const adapter = f.adapter as ReturnType<typeof createAiTelegramAdapter>;
    const approval = confirmation('generic-token', 'ai.automations.create'); const input = { definition: { instruction: 'x'.repeat(2000) } };
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'operation', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input });
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'sendDocument') await gate.promise; });
    const command = adapter.command(f.context(update('/tasks create {}')), 'tasks', 'create {}');
    const rejected = expect(command).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.calls.some(call => call.method === 'sendDocument')).toBe(true));
    const cancelled = adapter.cancel(f.context(update('/cancel')));
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.stop', {}));
    gate.resolve(); await Promise.all([cancelled, rejected]);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);

    const next = confirmation('next-generic-token', 'ai.automations.create');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'next-operation', confirmation: next });
    f.pendingDetails.mockReturnValue({ confirmation: next, input: { definition: { instruction: 'short' } } });
    await adapter.command(f.context(update('/tasks create {}')), 'tasks', 'create {}');
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    await adapter.cancel(f.context(update('/cancel')));
    await adapter.callback(f.context(click(message, data)));
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it.each(['uncertain', 'forbidden', 'limited'] as const)('does not repeat a %s proposal document or send a fallback confirm card', async failure => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const input = { text: 'x'.repeat(2000) };
    await f.delivery().started(target(), s);
    f.intercept(async method => {
      if (method !== 'sendDocument') return;
      if (failure === 'uncertain') throw new Error('untrusted sensitive transport message');
      return { ok: false, error_code: failure === 'forbidden' ? 403 : 429, description: 'rejected', parameters: { retry_after: 1 } };
    });
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, input)).rejects.toMatchObject({
      code: failure === 'uncertain' ? 'OUTCOME_UNKNOWN' : failure === 'forbidden' ? 'FORBIDDEN' : 'RATE_LIMITED',
    });
    if (failure === 'uncertain') {
      await f.delivery().approval(target(), approval, approval.actionId, s, input);
      await f.delivery().failed(target(), 'OUTCOME_UNKNOWN', s);
    } else await expect(f.delivery().approval(target(), approval, approval.actionId, s, input)).rejects.toBeDefined();
    expect(f.calls.filter(call => call.method === 'sendDocument')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
    expect(JSON.stringify(f.health.recordApiError.mock.calls)).not.toContain('sensitive');
  });

  it('does not re-upload the proposal when the following confirm card has an uncertain outcome', async () => {
    const f = fixture(); const s = f.controller.signal; const approval = confirmation(); const input = { text: 'x'.repeat(2000) };
    await f.delivery().started(target(), s);
    f.intercept(async method => { if (method === 'sendRichMessage') throw new Error('lost response'); });
    await expect(f.delivery().approval(target(), approval, approval.actionId, s, input)).rejects.toMatchObject({ code: 'OUTCOME_UNKNOWN' });
    await f.delivery().approval(target(), approval, approval.actionId, s, input);
    await f.delivery().failed(target(), 'OUTCOME_UNKNOWN', s);
    expect(f.calls.filter(call => call.method === 'sendDocument')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
  });

  it('does not attach a confirm card when its approval expires during document delivery', async () => {
    vi.useFakeTimers(); const f = fixture(); const s = f.controller.signal; const approval = { ...confirmation(), expiresAt: new Date(Date.now() + 1000).toISOString() };
    await f.delivery().started(target(), s);
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'sendDocument') await gate.promise; });
    const work = f.delivery().approval(target(), approval, approval.actionId, s, { text: 'x'.repeat(2000) });
    const rejected = expect(work).rejects.toMatchObject({ code: 'CONFIRMATION_EXPIRED' });
    await vi.advanceTimersByTimeAsync(1500);
    gate.resolve(); await rejected;
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(0);
  });
});

describe('AI private management and download boundary', () => {
  it('shows an ordinary owner the explicit automation timezone, token limits and required cost ceiling', async () => {
    const f = fixture(); f.available(false);
    const task: AutomationView = { id: 'owned-task', revision: 3, title: 'Weather report', instruction: 'Read local weather',
      trigger: { kind: 'once', at: '2027-01-01T00:00:00Z', timeZone: 'Asia/Tokyo' }, tools: ['weather.query'],
      expiresAt: '2027-01-02T00:00:00Z', maxRuns: 1, maxInputTokens: 1024, maxOutputTokens: 256,
      maxCostMicros: 234567, completedRuns: 0, state: 'active', nextAt: '2027-01-01T00:00:00Z', target: 'user:3' };
    f.execute.mockResolvedValueOnce(success({ items: [task], nextCursor: null }));
    await f.bot.handleUpdate(update('/tasks'));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, source: 'telegram', chat: { id: 3, type: 'private' } }), 'ai.automations.list', {});
    const text = richText(f.messages.at(-1)!);
    expect(text).toContain('Asia/Tokyo');
    expect(text).toContain('1024');
    expect(text).toContain('256');
    expect(text).toContain(translator('en')('bot:ai.taskCost', { maxCostMicros: task.maxCostMicros }));
  });

  it('keeps explicit memories separate from ordinary model messages and never accepts an actor parameter', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('/memory remember I prefer tea'));
    await f.bot.handleUpdate(update('/memory update fact-1 2 I prefer coffee'));
    await f.bot.handleUpdate(update('/memory delete fact-1 3'));
    expect(f.execute.mock.calls.map(call => [call[1], call[2]])).toEqual([
      ['ai.memory.remember', { text: 'I prefer tea' }], ['ai.memory.update', { id: 'fact-1', revision: 2, text: 'I prefer coffee' }],
      ['ai.memory.delete', { id: 'fact-1', revision: 3 }],
    ]);
  });

  it('creates a private native topic only when advertised and binds the new conversation to that actual thread', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('/chats topic Work'));
    expect(f.calls.some(call => call.method === 'createForumTopic')).toBe(false);
    f.bot.botInfo.has_topics_enabled = true;
    await f.bot.handleUpdate(update('/chats topic Work'));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3, chat: { id: 3, type: 'private', threadId: 88 } }), 'ai.conversations.new', { title: 'Work' });
  });

  it('exports only to the authenticated owner private chat, never a group or admin-selected user', async () => {
    const f = fixture();
    const directory = await mkdtemp(join(tmpdir(), 'telegram-ai-test-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, 'conversation.json'); await writeFile(path, '{"title":"Private"}' + ' '.repeat(2 * 1024 * 1024), { mode: 0o600 });
    f.execute.mockImplementation(async () => {
      await f.delivery().file(target(3, undefined, 3, 'export:offline'), { path, name: 'conversation.json', mimeType: 'application/json', protectContent: false }, f.controller.signal);
      return success({ delivered: true });
    });
    await f.bot.handleUpdate(update('/chats export conversation-1'));
    expect(f.calls.find(call => call.method === 'sendDocument')!.payload).toMatchObject({ chat_id: 3, protect_content: true });
    await f.bot.handleUpdate(update('/chats export conversation-1', { chat: -100, actor: 1 }));
    expect(f.execute).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.method === 'sendDocument')).toHaveLength(1);
    await expect(f.delivery().file(target(-100, undefined, 3, 'export:foreign'), { path, name: 'conversation.json', mimeType: 'application/json' }, f.controller.signal)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('requires a displayed revision when renaming an existing conversation', async () => {
    const f = fixture();
    await f.bot.handleUpdate(update('/chats rename conversation-1 3 New title'));
    expect(f.execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 3 }), 'ai.conversations.rename', { id: 'conversation-1', revision: 3, title: 'New title' });
    await f.bot.handleUpdate(update('/chats rename conversation-1 New title'));
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('downloads only the trusted Telegram file path with byte checks and never exports the token URL', async () => {
    const f = fixture(true);
    const file: AiCapturedFile = { fileId: 'file', uniqueId: 'unique', size: 5, mimeType: 'application/pdf', name: 'safe.pdf', kind: 'document' };
    expect(await f.download(file)).toEqual(new Uint8Array([37, 80, 68, 70, 45]));
    expect(f.fetcher).toHaveBeenCalledWith('https://api.telegram.org/file/bot12345:offline-token/documents/file.pdf', expect.objectContaining({ redirect: 'error', credentials: 'omit' }));
    f.intercept(async method => method === 'getFile' ? { ok: true, result: { file_path: 'https://attacker.invalid/file', file_size: 4 } } : undefined);
    await expect(f.download(file)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(f.capture).not.toHaveBeenCalled();
  });

  it('rejects disguised MIME and unadvertised body growth before handing bytes to the service', async () => {
    const f = fixture(true);
    const file: AiCapturedFile = { fileId: 'file', uniqueId: 'unique', size: 5, mimeType: 'application/pdf', name: 'safe.pdf', kind: 'document' };
    f.fetcher.mockResolvedValueOnce(new Response('hello', { headers: { 'content-length': '5' } }));
    await expect(f.download(file)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.fetcher.mockResolvedValueOnce(new Response('%PDF-too-large'));
    await expect(f.download(file)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    f.fetcher.mockResolvedValueOnce(new Response('%PDF-', { headers: { 'content-encoding': 'gzip' } }));
    await expect(f.download(file)).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('aborts an outstanding file body and waits for actual reader cleanup on shutdown', async () => {
    const f = fixture(true);
    const cancelled = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel: cancelled });
    f.fetcher.mockResolvedValueOnce(new Response(body));
    const download = f.download({ fileId: 'file', uniqueId: 'unique', size: 5, mimeType: 'application/pdf', name: 'safe.pdf', kind: 'document' });
    const rejected = expect(download).rejects.toMatchObject({ code: 'CANCELLED' });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
    await f.adapter.stop(); await rejected;
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
});

describe('AI management panel lifecycle', () => {
  const conversation = { id: 'conversation-1', title: 'Tea', revision: 7, sequence: 1,
    createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z' };

  it.each([
    ['memory', 'delete fact-1 2', 'ai.memory.delete', { deleted: true }, 'ai.memory.list'],
    ['chats', 'clear conversation-1 7', 'ai.conversations.clear', conversation, 'ai.conversations.list'],
    ['tasks', 'remove task-1 2', 'ai.automations.remove', { removed: true }, 'ai.automations.list'],
  ] as const)('keeps the successful %s confirmation receipt and reopens only current management state', async (command, argument, action, data, list) => {
    vi.useFakeTimers(); const f = fixture(); const approval = confirmation(`token-${command}`, action);
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'owned-record', revision: 2 } });
    f.confirm.mockResolvedValueOnce(success(data));
    await f.bot.handleUpdate(update(`/${command} ${argument}`));
    const message = f.messages.at(-1)!; const confirm = callbacks(message)[0]!;
    await f.bot.handleUpdate(click(message, confirm));
    expect(richText(message)).toContain(translator('en')('bot:ai.saved'));
    expect(richText(message)).not.toContain(translator('en')('bot:ai.expired'));
    if (command === 'chats') expect(richText(message)).toContain('Tea');
    expect(callbacks(message)).toHaveLength(1);
    await f.bot.handleUpdate(click(message, confirm));
    expect(f.confirm).toHaveBeenCalledTimes(1);
    await f.bot.handleUpdate(click(message));
    expect(f.execute.mock.calls.at(-1)![1]).toBe(list);
    expect(f.execute.mock.calls.filter(call => call[1] === action)).toHaveLength(1);
    expect(f.messages).toHaveLength(1);
    expect(callbacks(message).length).toBeGreaterThan(0);
  });

  it('never replaces a completed receipt with expiry feedback when its navigation ages out', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.bot.handleUpdate(update('/memory remember tea'));
    const message = f.messages.at(-1)!;
    await vi.advanceTimersByTimeAsync(600_001);
    expect(richText(message)).toBe(translator('en')('bot:ai.saved'));
    expect(callbacks(message)).toHaveLength(0);
  });

  it('disables genuinely expired approvals and reauthorizes the read-only reopen', async () => {
    vi.useFakeTimers(); const f = fixture(); const approval = confirmation('expired-token', 'ai.memory.delete');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 1 } });
    await f.bot.handleUpdate(update('/memory delete fact-1 1'));
    const message = f.messages.at(-1)!; const confirm = callbacks(message)[0]!; const original = richText(message);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(richText(message)).toBe(`${original}\n\n${translator('en')('bot:ai.expired')}`);
    expect(callbacks(message)).not.toContain(confirm);
    await f.bot.handleUpdate(click(message, confirm));
    expect(f.confirm).not.toHaveBeenCalled();
    f.execute.mockResolvedValueOnce({ status: 'rejected', invocationId: 'read', error: { code: 'FORBIDDEN' } });
    await f.bot.handleUpdate(click(message));
    expect(f.execute.mock.calls.at(-1)![1]).toBe('ai.memory.list');
    expect(richText(message)).toContain(translator('en')('common:errors.FORBIDDEN'));
    expect(f.confirm).not.toHaveBeenCalled();
  });

  it('reuses a conversation manager for history, repeated reads and bounded pagination', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (_ctx, action, input) => action === 'ai.conversations.history'
      ? success({ items: [{ role: 'user', actorId: 3, content: 'Literal history' }], nextCursor: (input as { page?: number }).page ? null : 10 })
      : success({ items: [conversation], nextCursor: null }));
    await f.bot.handleUpdate(update('/chats'));
    const message = f.messages.at(-1)!; const oldDelete = control(message, 'Delete: Tea');
    await f.bot.handleUpdate(click(message, control(message, 'History: Tea')));
    expect(richText(message)).toBe('user (3)\nLiteral history');
    await f.bot.handleUpdate(click(message, control(message, 'Refresh')));
    await f.bot.handleUpdate(click(message, control(message, translator('en')('bot:panels.next'))));
    expect(f.execute.mock.calls.at(-1)![2]).toEqual({ id: conversation.id, page: 10 });
    expect(callbacks(message)).toHaveLength(3);
    await f.bot.handleUpdate(click(message, control(message, 'First page')));
    expect(f.execute.mock.calls.at(-1)![2]).toEqual({ id: conversation.id, page: 0 });
    await f.bot.handleUpdate(click(message, control(message, 'Your conversations')));
    expect(control(message, 'Delete: Tea')).not.toBe(oldDelete);
    await f.bot.handleUpdate(click(message, oldDelete));
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['ai.conversations.list', 'ai.conversations.history',
      'ai.conversations.history', 'ai.conversations.history', 'ai.conversations.history', 'ai.conversations.list']);
    expect(f.messages).toHaveLength(1);
  });

  it('keeps read and reopened controls bound to the actor, bot, chat, actual topic and message', async () => {
    const f = fixture(); await f.bot.handleUpdate(update('/tasks', { chat: -100, thread: 7 }));
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    for (const forged of [click(message, data, 4), click({ ...message, message_thread_id: 8 }, data),
      click({ ...message, is_topic_message: false }, data), click({ ...message, message_id: 99999 }, data),
      click({ ...message, from: { ...me, id: 54321 } }, data),
      click({ ...message, chat: { id: -200, type: 'supergroup', title: 'Other' } }, data)]) await f.bot.handleUpdate(forged);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await f.bot.handleUpdate(click(message, data));
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it.each(['confirm', 'new'] as const)('claims a rapid %s before either acknowledgement finishes and never repeats it', async kind => {
    const f = fixture();
    if (kind === 'confirm') {
      const approval = confirmation('rapid-token', 'ai.memory.delete');
      f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
      f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 2 } });
      await f.bot.handleUpdate(update('/memory delete fact-1 2'));
    } else await f.bot.handleUpdate(update('/chats'));
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!;
    const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'answerCallbackQuery') await gate.promise; });
    const first = f.bot.handleUpdate(click(message, data)); const second = f.bot.handleUpdate(click(message, data));
    await vi.waitFor(() => expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(2));
    gate.resolve(); await Promise.all([first, second]);
    await f.bot.handleUpdate(click(message, data));
    if (kind === 'confirm') expect(f.confirm).toHaveBeenCalledTimes(1);
    else expect(f.execute.mock.calls.filter(call => call[1] === 'ai.conversations.new')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery').some(call => call.payload.text === translator('en')('bot:ai.busy'))).toBe(true);
  });

  it.each(['CONFLICT', 'OUTCOME_UNKNOWN'] as const)('reports %s confirmations truthfully without automatic replay', async code => {
    const f = fixture(); const approval = confirmation('failure-token', 'ai.memory.delete');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 2 } });
    f.confirm.mockResolvedValueOnce({ status: 'failed', invocationId: 'confirm', error: { code } });
    await f.bot.handleUpdate(update('/memory delete fact-1 2'));
    const message = f.messages.at(-1)!; const data = callbacks(message)[0]!; const original = richText(message);
    await f.bot.handleUpdate(click(message, data));
    expect(richText(message)).toBe(`${original}\n\n${translator('en')(code === 'OUTCOME_UNKNOWN' ? 'bot:ai.unknown' : 'bot:ai.operationFailed', {
      error: translator('en')(`common:errors.${code}`),
    })}`);
    await f.bot.handleUpdate(click(message, data)); await f.bot.handleUpdate(click(message));
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.execute.mock.calls.at(-1)![1]).toBe('ai.memory.list');
    expect(richText(message)).not.toContain(JSON.stringify({ id: 'fact-1', revision: 2 }));
  });

  it('recovers a failed read render with only fresh navigation, not stale mutation controls', async () => {
    const f = fixture(); f.execute.mockResolvedValue(success({ items: [conversation], nextCursor: null }));
    await f.bot.handleUpdate(update('/chats'));
    const message = f.messages.at(-1)!; const stale = control(message, 'Delete: Tea');
    let fail = true;
    f.intercept(async method => { if (method === 'editMessageText' && fail) { fail = false; throw new Error('lost edit response'); } });
    await f.bot.handleUpdate(click(message, control(message, 'Refresh')));
    expect(richText(message)).toBe(translator('en')('bot:ai.operationFailed', { error: translator('en')('common:errors.UNAVAILABLE') }));
    expect(callbacks(message)).toHaveLength(1);
    await f.bot.handleUpdate(click(message, stale));
    await f.bot.handleUpdate(click(message));
    expect(control(message, 'Delete: Tea')).not.toBe(stale);
    expect(f.execute.mock.calls.every(call => call[1] === 'ai.conversations.list')).toBe(true);
    expect(f.messages).toHaveLength(1);
  });

  it('retries only the exact receipt edit when a committed confirmation render fails', async () => {
    const f = fixture(); const approval = confirmation('render-token', 'ai.memory.delete');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 2 } });
    await f.bot.handleUpdate(update('/memory delete fact-1 2'));
    const message = f.messages.at(-1)!; const original = richText(message);
    let edits = 0;
    f.intercept(async method => { if (method === 'editMessageText' && ++edits === 2) throw new Error('lost receipt edit'); });
    await f.bot.handleUpdate(click(message));
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(richText(message)).toBe(`${original}\n\n${translator('en')('bot:ai.saved')}`);
    expect(f.messages).toHaveLength(1);
    expect(edits).toBe(3);
  });

  it.each(['expired', 'cancelled'] as const)('never resurrects a %s manager after a slow read finishes', async reason => {
    vi.useFakeTimers(); const f = fixture(true); const adapter = f.adapter as ReturnType<typeof createAiTelegramAdapter>;
    await adapter.command(f.context(update('/chats')), 'chats', '');
    const message = f.messages.at(-1)!; const gate = Promise.withResolvers<ActionResult>();
    f.execute.mockImplementationOnce(() => gate.promise);
    const read = adapter.callback(f.context(click(message, control(message, 'Refresh'))));
    await vi.advanceTimersByTimeAsync(0);
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(600_001);
    else await adapter.cancel(f.context(update('/cancel')));
    gate.resolve(success({ items: [conversation], nextCursor: null })); await read;
    expect(richText(message)).toBe(translator('en')(`bot:ai.${reason}`));
    expect(callbacks(message)).toHaveLength(1);
    expect(buttonRows(message).flat().some(button => richText(button.text) === 'Delete: Tea')).toBe(false);
    expect(f.messages).toHaveLength(1);
  });

  it('serializes expiry cleanup after an already in-flight read edit', async () => {
    vi.useFakeTimers(); const f = fixture(true); const adapter = f.adapter as ReturnType<typeof createAiTelegramAdapter>;
    await adapter.command(f.context(update('/chats')), 'chats', '');
    const message = f.messages.at(-1)!; const gate = Promise.withResolvers<void>(); let first = true;
    f.intercept(async method => { if (method === 'editMessageText' && first) { first = false; await gate.promise; } });
    const read = adapter.callback(f.context(click(message, control(message, 'Refresh'))));
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_001);
    gate.resolve(); await read; await vi.advanceTimersByTimeAsync(0);
    expect(richText(message)).toBe(translator('en')('bot:ai.expired'));
    expect(callbacks(message)).toHaveLength(1);
  });

  it.each(['expired', 'cancelled'] as const)('reports a late committed confirmation without reviving the %s approval', async reason => {
    vi.useFakeTimers(); const f = fixture(true); const adapter = f.adapter as ReturnType<typeof createAiTelegramAdapter>;
    const approval = confirmation('late-token', 'ai.memory.delete');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 2 } });
    await adapter.command(f.context(update('/memory delete fact-1 2')), 'memory', 'delete fact-1 2');
    const message = f.messages.at(-1)!; const confirm = callbacks(message)[0]!; const original = richText(message);
    const gate = Promise.withResolvers<ActionResult>(); f.confirm.mockImplementationOnce(() => gate.promise);
    const work = adapter.callback(f.context(click(message, confirm)));
    await vi.advanceTimersByTimeAsync(0);
    expect(f.confirm).toHaveBeenCalledTimes(1);
    if (reason === 'expired') await vi.advanceTimersByTimeAsync(60_001);
    else await adapter.cancel(f.context(update('/cancel')));
    expect(richText(message)).toBe(`${original}\n\n${translator('en')('bot:ai.pendingOutcome')}`);
    gate.resolve(success({ deleted: true })); await work;
    expect(richText(f.messages.at(-1)!)).toBe(translator('en')('bot:ai.saved'));
    expect(callbacks(f.messages.at(-1)!)).toHaveLength(0);
    expect(callbacks(message)).not.toContain(confirm);
    await adapter.callback(f.context(click(message, confirm)));
    expect(f.confirm).toHaveBeenCalledTimes(1);
  });

  it.each(['memory', 'tasks'] as const)('reuses %s pagination and current revisions instead of consuming the manager', async command => {
    const f = fixture(); const list = command === 'memory' ? 'ai.memory.list' : 'ai.automations.list';
    f.execute.mockImplementation(async (_ctx, action, input) => action === list
      ? success({ items: [], nextCursor: (input as { page?: number }).page ? null : 12 }) : success({}));
    await f.bot.handleUpdate(update(`/${command}`));
    const message = f.messages.at(-1)!;
    await f.bot.handleUpdate(click(message, control(message, translator('en')('bot:panels.next'))));
    expect(f.execute.mock.calls.at(-1)![2]).toEqual({ page: 12 });
    await f.bot.handleUpdate(click(message, control(message, 'Refresh')));
    expect(f.execute.mock.calls.at(-1)![2]).toEqual({ page: 12 });
    await f.bot.handleUpdate(click(message, control(message, 'First page')));
    expect(f.execute.mock.calls.at(-1)![2]).toEqual({ page: 0 });
    expect(f.messages).toHaveLength(1);
  });

  it('never sends a fallback duplicate when a late committed receipt has uncertain delivery', async () => {
    vi.useFakeTimers(); const f = fixture(true); const adapter = f.adapter as ReturnType<typeof createAiTelegramAdapter>;
    const approval = confirmation('uncertain-receipt', 'ai.memory.delete');
    f.execute.mockResolvedValueOnce({ status: 'pending_confirmation', invocationId: 'prepare', confirmation: approval });
    f.pendingDetails.mockReturnValue({ confirmation: approval, input: { id: 'fact-1', revision: 2 } });
    await adapter.command(f.context(update('/memory delete fact-1 2')), 'memory', 'delete fact-1 2');
    const message = f.messages.at(-1)!; const gate = Promise.withResolvers<ActionResult>();
    f.confirm.mockImplementationOnce(() => gate.promise);
    const work = adapter.callback(f.context(click(message)));
    await vi.advanceTimersByTimeAsync(60_001);
    f.intercept(async method => { if (method === 'sendRichMessage') throw new Error('lost receipt response'); });
    gate.resolve(success({ deleted: true })); await work;
    expect(f.confirm).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(2);
    expect(f.health.recordApiError).toHaveBeenCalledWith('TELEGRAM_UNAVAILABLE');
  });

  it('takes destructive conversation revisions from the displayed list without manual entry', async () => {
    const f = fixture(); f.execute.mockResolvedValueOnce(success({ items: [conversation], nextCursor: null }));
    await f.bot.handleUpdate(update('/chats'));
    const message = f.messages.at(-1)!;
    await f.bot.handleUpdate(click(message, control(message, 'Clear context: Tea')));
    expect(f.execute.mock.calls.at(-1)!.slice(1)).toEqual(['ai.conversations.clear', { id: conversation.id, revision: 7 }]);
    expect(richText(message)).toBe(translator('en')('bot:ai.saved'));
  });

  it('stops a group run before waiting for any control edit transport', async () => {
    const f = fixture(); const s = f.controller.signal;
    await f.delivery().started(target(-100, 7), s);
    const message = f.messages.at(-1)!; const gate = Promise.withResolvers<void>();
    f.intercept(async method => { if (method === 'editMessageText') await gate.promise; });
    const stopping = f.bot.handleUpdate(click(message));
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.stop', { runId: 'run-1' }));
    gate.resolve(); await stopping;
    await f.delivery().completed(target(-100, 7), 'late answer', s);
    expect(richText(message)).not.toContain('late answer');
  });

  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1])('rejects an invalid next cursor %s without exposing new controls', async nextCursor => {
    const f = fixture(); await f.bot.handleUpdate(update('/tasks'));
    const message = f.messages.at(-1)!;
    f.execute.mockResolvedValueOnce(success({ items: [], nextCursor }));
    await f.bot.handleUpdate(click(message, control(message, 'Refresh')));
    expect(richText(message)).toContain(translator('en')('common:errors.INVALID_OUTPUT'));
    expect(callbacks(message)).toHaveLength(1);
  });
});
