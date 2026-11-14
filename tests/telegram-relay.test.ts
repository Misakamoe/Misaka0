import { setImmediate } from 'node:timers/promises';
import { Bot } from 'grammy';
import type { Message, Update, UserFromGetMe } from 'grammy/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ActionResult } from '../shared/schemas/index.js';
import { ActionExecutor, createInvocation, type InvocationContext } from '../src/actions.js';
import type { AiTelegramPort } from '../src/ai/telegram-port.js';
import type { StartupConfig } from '../src/config.js';
import { translator } from '../src/i18n.js';
import { RelayService } from '../src/modules/relay.js';
import { createTelegramAdapter } from '../src/telegram/index.js';
import { createRelayTransport } from '../src/telegram/relay.js';
import { coreFixture, testToken } from './support/core.js';
import { buttonRows, callbacks, recordContent, richText, telegramMessage } from './support/telegram.js';

const me: UserFromGetMe = {
  id: 12345, is_bot: true, first_name: 'Offline relay bot', username: 'offline_relay_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: true,
  allows_users_to_create_topics: true, can_manage_bots: false, supports_join_request_queries: false,
};
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); vi.restoreAllMocks(); });
let sequence = 100_000;
type Call = { method: string; payload: Record<string, unknown>; signal?: AbortSignal };
const scope = (actor = 10, thread: number | null = 9) => createInvocation({ actorId: actor, botId: me.id, source: 'telegram',
  chat: { id: actor, type: 'private', ...(thread === null ? {} : { threadId: thread }) }, language: 'en' });
function text(value: string, actor = 10, thread: number | null = 9, extra: Partial<Message> = {}): Update & { message: Message } {
  const id = ++sequence;
  return { update_id: id, message: {
    message_id: id, date: Math.floor(Date.now() / 1000), text: value,
    from: { id: actor, is_bot: false, first_name: actor === 2 ? 'Owner Display Secret' : `Visitor ${actor}`,
      username: actor === 2 ? 'owner_private_name' : `visitor_${actor}`, language_code: 'en' },
    chat: { id: actor, type: 'private', first_name: `Chat ${actor}` },
    ...(thread === null ? {} : { message_thread_id: thread, is_topic_message: true }),
    ...(value.startsWith('/') ? { entities: [{ type: 'bot_command', offset: 0, length: value.split(' ')[0]!.length }] } : {}), ...extra,
  } as NonNullable<Update['message']> };
}
function reply(value: string, original: Message, actor = 10, thread: number | null = 9, extra: Partial<Message> = {}) {
  return text(value, actor, thread, { ...extra, reply_to_message: { ...telegramMessage(original), reply_to_message: undefined } });
}
function callback(data: string, original: Message, actor = original.chat.id): Update {
  return { update_id: ++sequence, callback_query: { id: `callback-${sequence}`, from: text('', actor).message.from!,
    chat_instance: 'offline-private-chat', data, message: telegramMessage(original) } };
}
function operation(message: Message, name: string): string {
  const result = callbacks(message).find(value => value.endsWith(`:${name}`));
  if (!result) throw new Error(`Missing ${name} control: ${JSON.stringify(buttonRows(message))}`);
  return result;
}
const photo = (caption: string, actor = 10, thread = 9, extra: Partial<Message> = {}) => text('', actor, thread, {
  text: undefined, photo: [{ file_id: 'offline-photo', file_unique_id: 'offline-photo-unique', width: 16, height: 16, file_size: 32 }], caption, ...extra,
});

async function fixture() {
  const weatherJson = vi.fn(async () => ({ results: [
    { id: 1, name: 'Paris', latitude: 48.85, longitude: 2.35, country: 'France', timezone: 'Europe/Paris' },
    { id: 2, name: 'Paris', latitude: 33.66, longitude: -95.55, country: 'United States', timezone: 'America/Chicago' },
  ] }));
  const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Offline feed', entries: [] } }));
  const core = await coreFixture({ rss: { fetcher }, weather: { json: weatherJson }, services: { aiEnabled: true } });
  const config: StartupConfig = { botToken: testToken, adminIds: [1, 2], dataDir: core.directory, logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 } };
  const calls: Call[] = []; const messages: Message[] = []; const incoming = new Map<string, Message>();
  const jobs = new Set<Promise<unknown>>();
  const ai = { available: vi.fn(() => true), capture: vi.fn<AiTelegramPort['capture']>(async () => 'offline-capture'),
    isReply: vi.fn<AiTelegramPort['isReply']>(() => false), attachTelegram: vi.fn<AiTelegramPort['attachTelegram']>() } satisfies AiTelegramPort;
  let before: ((call: Call) => Promise<void> | void) | undefined;
  let failure: ((call: Call) => number | undefined) | undefined;
  let offset = 0;
  const health = { recordUpdate: vi.fn(), recordApiError: vi.fn() };
  async function start() {
    const bot = new Bot(testToken, { botInfo: me, client: { fetch: vi.fn(() => { throw new Error('Unexpected external Telegram request'); }) } });
    bot.api.config.use(async (_previous, method, payload, rawSignal) => {
      const call: Call = { method, payload: structuredClone(payload) as Record<string, unknown>, signal: rawSignal as unknown as AbortSignal };
      calls.push(call); await before?.(call);
      const error = failure?.(call);
      if (error) return { ok: false, error_code: error, description: 'Offline Telegram rejection' } as never;
      const chatId = Number(call.payload.chat_id);
      const makeMessage = (): Message => ({ message_id: ++sequence, date: Math.floor(Date.now() / 1000), from: me,
        chat: chatId > 0 ? { id: chatId, type: 'private', first_name: `Chat ${chatId}` } : { id: chatId, type: 'supergroup', title: 'Offline group' },
        ...(call.payload.message_thread_id === undefined ? {} : { message_thread_id: Number(call.payload.message_thread_id), is_topic_message: true }),
        ...(call.payload.protect_content ? { has_protected_content: true } : {}),
      });
      let result: unknown = true;
      if (method === 'sendRichMessage' || method === 'sendMessage') {
        const sent = makeMessage(); recordContent(sent, call.payload);
        Object.assign(sent, { reply_markup: call.payload.reply_markup }); messages.push(sent); result = telegramMessage(sent);
      } else if (method === 'editMessageText' || method === 'editMessageReplyMarkup') {
        const sent = messages.findLast(item => item.chat.id === chatId && item.message_id === call.payload.message_id);
        if (!sent) throw new Error('Editing an unknown offline Telegram message');
        if (method === 'editMessageText') recordContent(sent, call.payload);
        Object.assign(sent, { reply_markup: call.payload.reply_markup }); result = telegramMessage(sent);
      } else if (method === 'copyMessage') {
        const source = incoming.get(`${call.payload.from_chat_id}:${call.payload.message_id}`)
          ?? messages.find(item => item.chat.id === call.payload.from_chat_id && item.message_id === call.payload.message_id);
        if (!source) throw new Error('Copy source was never registered as a real incoming message');
        const sent = makeMessage();
        for (const field of ['text', 'entities', 'caption', 'caption_entities', 'photo', 'video', 'animation', 'audio', 'voice', 'video_note', 'document', 'sticker', 'location', 'venue', 'contact'] as const) {
          if (source[field] !== undefined) Object.assign(sent, { [field]: structuredClone(source[field]) });
        }
        // Telegram retains source buttons unless the copy explicitly replaces its markup.
        Object.assign(sent, { reply_markup: structuredClone(call.payload.reply_markup ?? source.reply_markup) });
        const replyId = (call.payload.reply_parameters as { message_id?: number } | undefined)?.message_id;
        const original = incoming.get(`${chatId}:${replyId}`) ?? messages.find(item => item.chat.id === chatId && item.message_id === replyId);
        if (original) sent.reply_to_message = { ...telegramMessage(original), reply_to_message: undefined };
        messages.push(sent); result = { message_id: sent.message_id };
      } else if (method === 'getChat') result = { id: chatId, type: 'private', first_name: 'Offline chat', accent_color_id: 1 };
      else if (method === 'getChatMember') result = { status: 'member', user: me };
      else if (!['answerCallbackQuery', 'setMyCommands', 'leaveChat', 'sendChatAction'].includes(method)) throw new Error(`Unexpected Telegram API operation ${method}`);
      return { ok: true, result: structuredClone(result) } as never;
    });
    const relay = new RelayService(core.storage, { transport: createRelayTransport(bot, core.configuration), isAdmin: id => core.access.isAdmin(id), now: () => Date.now() + offset });
    await relay.initialize();
    const executor = new ActionExecutor({ ...core.services, relay });
    const actual = executor.execute.bind(executor);
    const execute = vi.spyOn(executor, 'execute').mockImplementation(<T>(context: InvocationContext, id: string, input: unknown): Promise<ActionResult<T>> => {
      const task = id === 'ai.run.start'
        ? Promise.resolve({ status: 'succeeded' as const, invocationId: context.invocationId, data: { runId: 'offline-run' } as T })
        : actual<T>(context, id, input);
      jobs.add(task); void task.finally(() => jobs.delete(task)).catch(() => undefined); return task;
    });
    const controller = new AbortController();
    const adapter = createTelegramAdapter(bot, { config, executor, relay, access: core.access, configuration: core.configuration,
      stickers: core.stickers, ai, health, signal: controller.signal });
    return { bot, relay, executor, execute, adapter, controller };
  }
  let runtime = await start();
  const drain = async () => { while (jobs.size) await Promise.allSettled([...jobs]); await setImmediate(); };
  const dispatch = async (update: Update) => {
    if (update.message) incoming.set(`${update.message.chat.id}:${update.message.message_id}`, telegramMessage(update.message));
    await runtime.bot.handleUpdate(update);
  };
  const handle = async (update: Update) => { await dispatch(update); await drain(); };
  const last = (actor = 10, thread: number | null = 9): Message => {
    const result = messages.findLast(item => item.chat.id === actor && (item.is_topic_message ? item.message_thread_id : undefined) === (thread ?? undefined));
    if (!result) throw new Error(`No bot message for ${actor}:${thread}`); return result;
  };
  const click = async (name: string, original = last(), actor = original.chat.id) => handle(callback(operation(original, name), original, actor));
  const enable = async (thread: number | null = 7) => {
    await handle(text('/relay', 2, thread)); const panel = last(2, thread);
    await click('enable', panel); expect(runtime.relay.settings(scope(2, thread)).ownerBound).toBe(false);
    await click('apply', panel); expect(runtime.relay.settings(scope(2, thread))).toMatchObject({ enabled: true, ownerBound: true }); return panel;
  };
  const request = async (actor = 10, thread = 9) => {
    await handle(text('/contact', actor, thread)); const contact = runtime.relay.status(scope(actor, thread)).contact;
    if (!contact) throw new Error('No contact after /contact');
    const notice = messages.findLast(item => item.chat.id === 2 && callbacks(item).includes(`rn:${contact.id}`));
    if (!notice) throw new Error('No owner request notice'); return { contact, notice, visitorPanel: last(actor, thread) };
  };
  const accept = async (actor = 10, thread = 9) => {
    const requestResult = await request(actor, thread);
    await handle(callback(`rn:${requestResult.contact.id}`, requestResult.notice, 2)); const panel = last(2, 7);
    await click('accept', panel, 2);
    expect(runtime.relay.status(scope(actor, thread)).contact).toMatchObject({ status: 'accepted', routingActive: true });
    return { ...requestResult, panel, receipt: last(actor, thread), contact: runtime.relay.status(scope(actor, thread)).contact! };
  };
  cleanup.push(async () => { await runtime.adapter.stop(); await runtime.relay.stop(); await runtime.executor.close(); await core.close(); });
  return { core, ai, calls, messages, incoming, health, fetcher, weatherJson, handle, dispatch, drain, last, click, enable, request, accept,
    get relay() { return runtime.relay; }, get executor() { return runtime.executor; }, get execute() { return runtime.execute; }, get adapter() { return runtime.adapter; },
    copies: () => calls.filter(call => call.method === 'copyMessage'), aiStarts: () => runtime.execute.mock.calls.filter(call => call[1] === 'ai.run.start'),
    before: (hook?: typeof before) => { before = hook; }, fail: (hook?: typeof failure) => { failure = hook; },
    expire: () => { offset += 600_001; },
    restart: async () => { await runtime.adapter.stop(); await runtime.relay.stop(); await runtime.executor.close(); offset = 0; runtime = await start(); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function forms(f: Fixture) {
  const actor = 1; const key = `${me.id}:1:1:9`;
  await f.handle(text('/alias', actor)); const alias = f.last(actor);
  await f.click('aliasadd', alias);
  const help = buttonRows(alias).flat().find(button => richText(button.text).startsWith('/help ') && 'callback_data' in button);
  if (!help || !('callback_data' in help)) throw new Error('Missing real /help alias target');
  await f.handle(callback(help.callback_data, alias)); const aliasPrompt = f.last(actor);
  await f.handle(text('/rss', actor)); const rss = f.last(actor); await f.click('rssadd', rss); const rssPrompt = f.last(actor);
  await f.handle(text('/weather', actor)); const weatherPrompt = f.last(actor);
  await f.handle(text('/subconv', actor)); const subconv = f.last(actor); await f.click('uinput:1', subconv); const subconvPrompt = f.last(actor);
  const pending = f.adapter.sessions.get(key)!;
  expect(Object.keys(pending).sort()).toEqual(['aliasInput', 'rssInput', 'subconvInput', 'weatherInput']);
  return { key, pending, alias, rss, subconv, prompts: { alias: aliasPrompt, rss: rssPrompt, weather: weatherPrompt, subconv: subconvPrompt } };
}

describe('real Telegram relay actions and transport', () => {
  it('requires owner Enable and Confirm, binds the chosen admin and true topic, then accepts a contact through read-only Open', async () => {
    const f = await fixture(); await f.handle(text('/relay', 2, 7)); const panel = f.last(2, 7);
    expect(f.relay.settings(scope(2, 7))).toEqual({ enabled: false, ownerBound: false, revision: 0 });
    expect(f.execute.mock.calls.some(call => call[1] === 'relay.settings.set')).toBe(false);
    await f.click('enable', panel); expect(f.relay.settings(scope(2, 7)).enabled).toBe(false);
    await f.click('apply', panel);
    const set = f.execute.mock.calls.find(call => call[1] === 'relay.settings.set')!;
    expect(set[0]).toMatchObject({ actorId: 2, botId: me.id, source: 'telegram', chat: { id: 2, type: 'private', threadId: 7 } });
    expect(set[2]).toEqual({ enabled: true, revision: 0 });
    expect(() => f.relay.settings(scope(1, 7))).toThrow('FORBIDDEN'); expect(() => f.relay.settings(scope(2, 8))).toThrow('FORBIDDEN');
    const pending = await f.request(); expect(pending.contact.status).toBe('pending');
    expect(callbacks(pending.notice)).toEqual([`rn:${pending.contact.id}`]);
    expect(richText(pending.notice)).toContain('Visitor 10');
    expect(richText(pending.visitorPanel)).not.toMatch(/Owner Display Secret|owner_private_name|ID: 2/);
    await f.handle(callback(`rn:${pending.contact.id}`, pending.notice, 2));
    expect(f.relay.status(scope()).contact?.status).toBe('pending');
    await f.click('accept', f.last(2, 7));
    expect(f.relay.status(scope()).contact).toMatchObject({ status: 'accepted', routingActive: true });
    for (const call of f.calls.filter(call => ['sendRichMessage', 'editMessageText'].includes(call.method))) {
      expect(call.payload.rich_message).toMatchObject({ skip_entity_detection: true });
      expect(call.payload.parse_mode).toBeUndefined();
    }
  });

  it('ignores incidental non-topic thread IDs when binding the owner', async () => {
    const f = await fixture();
    await f.handle(text('/relay', 2, 77, { is_topic_message: false })); const panel = f.last(2, null);
    expect(panel.message_thread_id).toBeUndefined();
    await f.click('enable', panel); await f.click('apply', panel);
    expect(f.relay.settings(scope(2, null)).enabled).toBe(true);
    expect(() => f.relay.settings(scope(2, 77))).toThrow('FORBIDDEN');
  });

  it('keeps group commands and non-private callbacks from enabling or managing the private relay', async () => {
    const f = await fixture();
    await f.handle(text('/relay', 2, 7, { chat: { id: -100, type: 'supergroup', title: 'Untrusted group' } }));
    expect(f.relay.settings(scope(2, 7))).toMatchObject({ enabled: false, ownerBound: false });
    const panel = await f.enable(); const pending = await f.request();
    await f.handle(callback(`rn:${pending.contact.id}`, { ...pending.notice, chat: { id: -100, type: 'supergroup', title: 'Untrusted group' } }, 2));
    await f.handle(callback(operation(panel, 'disable'), { ...panel, is_topic_message: false }, 2));
    expect(f.relay.settings(scope(2, 7)).enabled).toBe(true); expect(f.relay.status(scope()).contact?.status).toBe('pending');
    expect(f.execute.mock.calls.filter(call => call[1] === 'relay.settings.set')).toHaveLength(1);
  });

  it('executes owner Decline and Block controls and the visitor end command without exposing owner management', async () => {
    const f = await fixture(); await f.enable();
    const declined = await f.request();
    await f.handle(text('/contact')); expect(f.messages.filter(item => item.chat.id === 2 && callbacks(item).includes(`rn:${declined.contact.id}`))).toHaveLength(1);
    await f.handle(callback(`rn:${declined.contact.id}`, declined.notice, 2)); await f.click('decline', f.last(2, 7));
    expect(f.relay.status(scope()).contact?.status).toBe('declined');
    const blocked = await f.request(11);
    await f.handle(callback(`rn:${blocked.contact.id}`, blocked.notice, 2)); await f.click('block', f.last(2, 7));
    expect(f.relay.status(scope(11)).contact?.status).toBe('blocked');
    await f.handle(callback(`rn:${blocked.contact.id}`, f.last(11), 11));
    expect(callbacks(f.last(11)).some(data => /:(accept|decline|block|resume)$/.test(data))).toBe(false);
    await f.accept(12); await f.handle(text('/contact end', 12));
    expect(f.relay.status(scope(12)).contact?.status).toBe('closed');
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(expect.arrayContaining(['relay.contact.decline', 'relay.contact.block', 'relay.contact.close']));
  });

  it('localizes visitor acceptance using the captured visitor language rather than the owner locale', async () => {
    const f = await fixture();
    expect(await f.executor.execute(scope(2, 7), 'preferences.set', { language: 'en' })).toMatchObject({ status: 'succeeded' });
    await f.enable(); const request = text('/contact');
    request.message.from = { ...request.message.from!, language_code: 'ja' }; await f.handle(request);
    const contact = f.relay.status(scope()).contact!;
    const notice = f.messages.findLast(item => item.chat.id === 2 && callbacks(item).includes(`rn:${contact.id}`))!;
    expect(richText(notice)).toContain(translator('en')('bot:relay.newRequest'));
    await f.handle(callback(`rn:${contact.id}`, notice, 2)); await f.click('accept', f.last(2, 7));
    expect(richText(f.last())).toContain(translator('ja')('bot:relay.states.accepted'));
    expect(richText(f.last())).not.toMatch(/owner_private_name|Owner Display Secret/);
    expect(await f.executor.execute(scope(), 'preferences.set', { language: 'en' })).toMatchObject({ status: 'succeeded' });
    const accepted = f.relay.status(scope()).contact!;
    expect(await f.executor.execute(scope(2, 7), 'relay.contact.close', { id: accepted.id, revision: accepted.revision })).toMatchObject({ status: 'succeeded' });
    expect(richText(f.last())).toContain(translator('en')('bot:relay.states.closed'));
  });

  it('copies bidirectional text and media with owner labels but no visitor-side owner provenance or controls', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const visitorText = text('Literal <b>hello</b>'); await f.handle(visitorText);
    const inbox = f.last(2, 7);
    expect(inbox.text).toBe(visitorText.message.text); expect(inbox.has_protected_content).toBe(true);
    expect(buttonRows(inbox)).toEqual([[{ text: 'Visitor 10', callback_data: `rn:${accepted.contact.id}` }]]);
    expect(f.copies().at(-1)?.payload).toMatchObject({ chat_id: 2, from_chat_id: 10, message_id: visitorText.message.message_id,
      message_thread_id: 7, protect_content: true });
    const ownerReply = reply('A private answer', inbox, 2, 7);
    await f.handle(ownerReply); const answer = f.last();
    expect(answer).toMatchObject({ from: me, text: 'A private answer', reply_markup: { inline_keyboard: [] } });
    expect(answer.has_protected_content).toBeUndefined(); expect(answer.forward_origin).toBeUndefined(); expect(answer.via_bot).toBeUndefined();
    expect(answer.reply_to_message?.message_id).toBe(visitorText.message.message_id);
    expect(JSON.stringify(answer)).not.toMatch(/Owner Display Secret|owner_private_name|sender_chat|author_signature/);
    expect(f.copies().at(-1)?.payload).toMatchObject({ chat_id: 10, from_chat_id: 2, protect_content: false, reply_markup: { inline_keyboard: [] } });
    await f.handle(photo('Visitor media caption')); const inboxPhoto = f.last(2, 7);
    expect(inboxPhoto.photo?.[0]?.file_id).toBe('offline-photo'); expect(inboxPhoto.caption).toBe('Visitor media caption');
    const ownerPhoto = reply('', inboxPhoto, 2, 7, { text: undefined,
      document: { file_id: 'owner-document', file_unique_id: 'owner-document-unique', file_name: 'answer.txt', mime_type: 'text/plain', file_size: 8 }, caption: 'Owner media answer' });
    await f.handle(ownerPhoto); expect(f.last().document?.file_id).toBe('owner-document'); expect(f.last().caption).toBe('Owner media answer');
    expect(buttonRows(f.last())).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.calls.some(call => ['getFile', 'forwardMessage', 'sendPhoto', 'sendDocument'].includes(call.method))).toBe(false);
  });

  it('routes multiple visitors only by the exact owner reply, never by the most recent contact', async () => {
    const f = await fixture(); await f.enable(); const first = await f.accept(); const second = await f.accept(11);
    await f.handle(text('first visitor payload')); const firstCopy = f.last(2, 7);
    await f.handle(text('second visitor payload', 11)); const secondCopy = f.last(2, 7);
    const before = f.copies().length; await f.handle(text('Bare owner message', 2, 7)); expect(f.copies()).toHaveLength(before);
    expect(f.aiStarts()).toHaveLength(0);
    expect(richText(f.last(2, 7))).toContain(translator('en')('bot:relay.ownerHint'));
    await f.handle(text('/ai Explicitly choose the assistant', 2, 7));
    await f.handle(text('Assistant follow-up, not a contact reply', 2, 7));
    expect(f.aiStarts()).toHaveLength(2);
    await f.handle(text('/relay', 2, 7));
    await f.handle(text('Unaddressed inbox text stays out of AI', 2, 7));
    expect(f.aiStarts()).toHaveLength(2); expect(f.copies()).toHaveLength(before);
    await f.handle(reply('Answer first only', firstCopy, 2, 7)); expect(f.copies().at(-1)?.payload.chat_id).toBe(10);
    await f.handle(reply('Answer second only', secondCopy, 2, 7)); expect(f.copies().at(-1)?.payload.chat_id).toBe(11);
    await f.handle(callback(`rn:${first.contact.id}`, firstCopy, 2)); expect(richText(f.last(2, 7))).toContain('Visitor 10');
    expect(f.relay.status(scope(11)).contact?.id).toBe(second.contact.id);
    const count = f.copies().length;
    await f.handle(reply('wrong topic', firstCopy, 2, 8)); await f.handle(reply('wrong visitor', firstCopy, 11));
    await f.handle(text('/contact', 2, 8)); expect(f.copies()).toHaveLength(count);
  });

  it('rejects foreign users, chats, topics, bot messages and stale revisions at callbacks', async () => {
    const f = await fixture(); await f.enable(); const pending = await f.request();
    await f.handle(callback(`rn:${pending.contact.id}`, pending.notice, 2)); const panel = f.last(2, 7);
    const accept = operation(panel, 'accept'); const visitorPanel = pending.visitorPanel;
    for (const update of [callback(accept, panel, 1), callback(accept, panel, 10),
      callback(accept, { ...panel, message_thread_id: 8 }, 2), callback(accept, { ...panel, chat: { id: 10, type: 'private', first_name: 'Other' } }, 10),
      callback(accept, { ...panel, from: { ...me, id: 999 } }, 2),
      callback(operation(visitorPanel, 'close').replace(/:close$/, ':accept'), visitorPanel, 10)]) {
      await f.handle(update); expect(f.relay.status(scope()).contact?.status).toBe('pending');
    }
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery')).toHaveLength(9);
    const declined = await f.executor.execute(scope(2, 7), 'relay.contact.decline', { id: pending.contact.id, revision: pending.contact.revision });
    expect(declined.status).toBe('succeeded'); await f.handle(callback(accept, panel, 2));
    expect(f.relay.status(scope()).contact?.status).toBe('declined');
    expect(f.execute.mock.calls.filter(call => call[1] === 'relay.contact.accept')).toHaveLength(1);
    const attempt = f.execute.mock.calls.findLastIndex(call => call[1] === 'relay.contact.accept');
    expect(await f.execute.mock.results[attempt]!.value).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  });

  it('pauses on other commands, resumes explicitly, and keeps mapped replies separate from default AI', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    await f.handle(text('/help')); expect(f.relay.status(scope()).contact?.routingActive).toBe(false);
    const count = f.copies().length; await f.handle(text('Explicitly switched to normal input'));
    expect(f.aiStarts().at(-1)?.[2]).toEqual({ text: 'Explicitly switched to normal input' }); expect(f.copies()).toHaveLength(count);
    await f.handle(reply('Mapped relay reply while paused', accepted.receipt)); expect(f.copies()).toHaveLength(count + 1);
    await f.handle(text('/contact resume')); expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
    await f.handle(text('Resumed relay payload')); expect(f.copies()).toHaveLength(count + 2);
    await f.handle(text('/contact pause')); expect(f.relay.status(scope()).contact?.routingActive).toBe(false);
    expect(f.execute.mock.calls.some(call => call[1] === 'relay.contact.resume')).toBe(true);
    expect(f.execute.mock.calls.some(call => call[1] === 'relay.cancel')).toBe(true);
  });

  it('blocks unknown and stale bot replies from AI and relay, both active and paused', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    await f.handle(text('/help')); const unrelated = f.last();
    for (const active of [false, true]) {
      if (active) await f.handle(text('/contact resume'));
      const before = f.copies().length; f.execute.mockClear(); f.ai.capture.mockClear();
      await f.handle(reply('never reinterpret this stale bot reply', unrelated));
      await f.handle(reply('', { ...unrelated, message_id: unrelated.message_id + 1_000_000 }, 10, 9, {
        text: undefined, document: { file_id: 'stale-document', file_unique_id: 'stale-unique', file_name: 'private.txt', mime_type: 'text/plain', file_size: 8 }, caption: 'Private stale attachment',
      }));
      expect(f.copies()).toHaveLength(before); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
      expect(f.execute.mock.calls.some(call => call[1] === 'relay.send')).toBe(false);
    }
  });

  it('lets an explicitly owned AI reply reach only AI even while automatic relay mode is active', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    await f.handle(text('/help')); const aiMessage = f.last();
    f.ai.isReply.mockImplementation((context, messageId) => context.actorId === 10 && messageId === aiMessage.message_id);
    await f.handle(text('/contact resume')); f.execute.mockClear();
    await f.handle(reply('Continue the explicitly addressed AI conversation', aiMessage));
    expect(f.aiStarts()).toHaveLength(1);
    expect(f.aiStarts()[0]?.[2]).toEqual({ text: 'Continue the explicitly addressed AI conversation', replyTo: aiMessage.message_id });
    expect(f.copies()).toEqual([]); expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
  });

  it('copies command-looking forwarded text and captions literally without executing them', async () => {
    const f = await fixture(); await f.enable(); await f.accept(); f.execute.mockClear();
    const forward_origin = { type: 'hidden_user' as const, date: Math.floor(Date.now() / 1000), sender_user_name: 'Forwarded source' };
    await f.handle(text('/cancel', 10, 9, { forward_origin }));
    expect(f.last(2, 7).text).toBe('/cancel'); expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
    await f.handle(photo('/contact end', 10, 9, { forward_origin, caption_entities: [{ type: 'bot_command', offset: 0, length: 8 }] }));
    expect(f.last(2, 7).caption).toBe('/contact end'); expect(f.last(2, 7).forward_origin).toBeUndefined();
    expect(f.execute.mock.calls.map(call => call[1])).toEqual(['relay.send', 'relay.send']); expect(f.aiStarts()).toEqual([]);
  });

  it.each(['protected', 'interactive', 'markup', 'unsupported'] as const)('never sends rejected %s content to relay, AI, or another module', async kind => {
    const f = await fixture(); await f.enable(); await f.accept(); f.execute.mockClear();
    const update = kind === 'protected' ? photo('Protected private payload', 10, 9, { has_protected_content: true })
      : kind === 'interactive' ? text('', 10, 9, { text: undefined, rich_message: { blocks: [{ type: 'paragraph', text: 'Rich private payload' },
        { type: 'buttons', buttons: [{ text: 'Do not transfer', callback_data: 'private-button' }] }] } })
        : kind === 'markup' ? text('Inline private payload', 10, 9, { reply_markup: { inline_keyboard: [[{ text: 'Do not inherit', callback_data: 'private-button' }]] } })
          : text('', 10, 9, { text: undefined, dice: { emoji: '\u{1f3b2}', value: 4 } });
    await f.handle(update);
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.some(call => /^(relay\.send|sticker\.|weather\.|rss\.)/.test(call[1]))).toBe(false);
  });
});

describe('relay and simultaneous module forms', () => {
  const fields = { alias: 'aliasInput', rss: 'rssInput', weather: 'weatherInput', subconv: 'subconvInput' } as const;
  const values = { alias: 'relay_form_alias', rss: 'https://feed.example.test/rss Private feed', weather: 'Paris', subconv: 'https://converter.example.test/sub' };
  it.each(['alias', 'rss', 'weather', 'subconv'] as const)('gives an exact %s form reply precedence even after explicit relay resume', async kind => {
    const f = await fixture(); await f.enable(); await f.accept(1); const form = await forms(f);
    await f.handle(text('/contact resume', 1)); expect(f.relay.status(scope(1)).contact?.routingActive).toBe(true); f.execute.mockClear();
    await f.handle(reply(values[kind], form.prompts[kind], 1));
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.execute.mock.calls.map(call => call[1])).toEqual({ alias: ['alias.add', 'alias.list'], rss: ['rss.add', 'rss.list'],
      weather: ['weather.search'], subconv: ['subconv.settings.set'] }[kind]);
    expect(f.adapter.sessions.get(form.key)?.[fields[kind]]).toBeUndefined();
    for (const other of (Object.keys(fields) as (keyof typeof fields)[]).filter(item => item !== kind)) {
      expect(f.adapter.sessions.get(form.key)?.[fields[other]]).toEqual(form.pending[fields[other]]);
    }
  });

  it('reserves bare values and unsupported form attachments while preserving exact relay replies', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept(1); const form = await forms(f); f.execute.mockClear();
    for (const update of [text('Private bare form value', 1), photo('Private form caption', 1),
      reply('', form.prompts.rss, 1, 9, { text: undefined, document: { file_id: 'form-document', file_unique_id: 'form-doc-unique', file_name: 'input.txt', mime_type: 'text/plain', file_size: 8 } })]) {
      await f.handle(update); expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
    }
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled(); expect(f.weatherJson).not.toHaveBeenCalled();
    await f.handle(reply('Explicit relay message, not a form value', accepted.receipt, 1));
    expect(f.copies()).toHaveLength(1); expect(f.copies()[0]?.payload.chat_id).toBe(2);
    expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
  });
});

describe('relay album, restart and delivery boundaries', () => {
  it('keeps bare form values and their albums private even after explicit relay resume', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept(1); const form = await forms(f);
    await f.handle(text('/contact resume', 1)); f.execute.mockClear();
    await f.handle(text('https://subscription.example.test/private-token', 1));
    await f.handle(photo('Private form attachment', 1, 9, { media_group_id: 'resumed-form' }));
    await f.handle(photo('Remaining private form attachment', 1, 9, { media_group_id: 'resumed-form' }));
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
    await f.handle(reply('An explicitly addressed relay reply', accepted.receipt, 1));
    expect(f.copies()).toHaveLength(1); expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
  });

  it('does not forward cross-chat replies or the rest of their album as bare relay input', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const external_reply = { origin: { type: 'user' as const, date: Math.floor(Date.now() / 1000), sender_user: me } };
    await f.handle(text('Private answer to an unrelated prompt', 10, 9, { external_reply }));
    await f.handle(photo('Private external reply attachment', 10, 9, { external_reply, media_group_id: 'external-reply' }));
    await f.handle(photo('Remaining external reply attachment', 10, 9, { media_group_id: 'external-reply' }));
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
  });

  it.each(['pause', 'close', 'block'] as const)('never reinterprets a delivered relay update as AI after %s and restart', async operation => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const update = text('Relay-only private message'); await f.handle(update);
    if (operation !== 'pause') expect(await f.executor.execute(scope(2, 7), `relay.contact.${operation}`, {
      id: accepted.contact.id, revision: accepted.contact.revision,
    })).toMatchObject({ status: 'succeeded' });
    await f.restart();
    if (operation === 'pause') await f.handle(text('/contact pause'));
    f.execute.mockClear(); await f.handle(update);
    expect(f.copies()).toHaveLength(1); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
  });

  it.each(['known', 'ambiguous'] as const)('keeps a %s relay attempt out of AI after restart and suspension', async kind => {
    const f = await fixture(); await f.enable(); await f.accept();
    if (kind === 'known') f.fail(call => call.method === 'copyMessage' ? 403 : undefined);
    else f.before(call => { if (call.method === 'copyMessage') throw new Error('Offline uncertain copy'); });
    const update = text('Attempted relay-only private message'); await f.handle(update);
    f.fail(); f.before(); await f.restart(); await f.handle(text('/contact pause')); f.execute.mockClear();
    await f.handle(update);
    expect(f.copies()).toHaveLength(1); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled();
  });

  it('requires a fresh resume rather than replaying a pre-restart or stale resume command', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const resume = text('/contact resume'); await f.handle(resume);
    await f.restart(); expect(f.relay.status(scope()).contact?.routingActive).toBe(false);
    await f.handle(resume); expect(f.relay.status(scope()).contact?.routingActive).toBe(false);
    await f.handle(text('/contact resume')); expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
    await f.handle(text('/contact pause'));
    await f.handle(text('/contact resume', 10, 9, { date: Math.floor(Date.now() / 1000) - 301 }));
    expect(f.relay.status(scope()).contact?.routingActive).toBe(false);
  });

  it.each(['request', 'accept'] as const)('lets scoped /cancel interrupt an in-flight %s notification', async operation => {
    const f = await fixture(); await f.enable();
    let update: Update;
    if (operation === 'accept') {
      const pending = await f.request(); await f.handle(callback(`rn:${pending.contact.id}`, pending.notice, 2));
      const panel = f.last(2, 7); update = callback(callbacks(panel).find(data => data.endsWith(':accept'))!, panel, 2);
    } else update = text('/contact');
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<void>();
    let held = false;
    f.before(async call => {
      if (!held && call.method === 'sendRichMessage' && call.payload.chat_id === (operation === 'request' ? 2 : 10)) {
        held = true; entered.resolve(call.signal!); await release.promise; throw new Error('Offline interrupted notice');
      }
    });
    const notifying = f.dispatch(update); const signal = await entered.promise;
    await f.dispatch(text('/cancel', operation === 'request' ? 10 : 2, 8));
    expect(signal.aborted).toBe(false);
    let finished = false;
    const cancelling = f.dispatch(text('/cancel', operation === 'request' ? 10 : 2, operation === 'request' ? 9 : 7))
      .then(() => { finished = true; });
    try { await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 500 }); expect(finished).toBe(false); }
    finally { release.resolve(); await notifying; await cancelling; await f.drain(); }
    expect(f.relay.status(scope()).contact).toMatchObject({ status: operation === 'request' ? 'pending' : 'accepted', routingActive: false });
  });

  it('does not split a relay album into AI when the visitor pauses between media items', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    await f.handle(photo('First relay album item', 10, 9, { media_group_id: 'relay-album' })); expect(f.copies()).toHaveLength(1);
    await f.handle(text('/contact pause')); f.ai.available.mockClear();
    await f.handle(photo('Remaining private relay album item', 10, 9, { media_group_id: 'relay-album' }));
    expect(f.copies()).toHaveLength(1); expect(f.aiStarts()).toEqual([]); expect(f.ai.capture).not.toHaveBeenCalled(); expect(f.ai.available).not.toHaveBeenCalled();
  });

  it('pins owner album routing to its first exact reply rather than a later contact header', async () => {
    const f = await fixture(); await f.enable(); const first = await f.accept(); const second = await f.accept(11);
    await f.handle(reply('', first.notice, 2, 7, { text: undefined, photo: photo('').message.photo,
      caption: 'First owner album item', media_group_id: 'owner-album' }));
    expect(f.copies().at(-1)?.payload.chat_id).toBe(10);
    const before = f.copies().length;
    await f.handle(reply('', second.notice, 2, 7, { text: undefined, photo: photo('').message.photo, caption: 'Do not switch recipient', media_group_id: 'owner-album' }));
    expect(f.copies()).toHaveLength(before);
    await f.handle(photo('Continue original recipient', 2, 7, { media_group_id: 'owner-album' }));
    expect(f.copies().at(-1)?.payload.chat_id).toBe(10); expect(f.copies()).toHaveLength(before + 1);
  });

  it.each(['expire', 'restart'] as const)('blocks default AI for accepted contacts after %s until explicit resume', async transition => {
    const f = await fixture(); await f.enable(); await f.accept();
    if (transition === 'expire') f.expire(); else await f.restart();
    f.ai.available.mockClear(); f.execute.mockClear();
    await f.handle(text('This is still presumed to be a private relay conversation'));
    expect(f.copies()).toEqual([]); expect(f.aiStarts()).toEqual([]); expect(f.ai.available).not.toHaveBeenCalled(); expect(f.ai.capture).not.toHaveBeenCalled();
    expect(f.relay.status(scope()).contact).toMatchObject({ status: 'accepted', routingActive: false });
    if (transition === 'restart') {
      await f.handle(text('/contact resume')); await f.handle(text('Explicitly resumed after restart')); expect(f.copies()).toHaveLength(1);
    }
  });

  it('lets /cancel abort and drain detached copy work without closing the contact', async () => {
    const f = await fixture(); await f.enable(); const accepted = await f.accept();
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<void>();
    f.before(async call => { if (call.method === 'copyMessage') { entered.resolve(call.signal!); await release.promise; throw new Error('Offline interrupted transport'); } });
    const delivering = f.dispatch(text('Interrupt this relay copy')); const signal = await entered.promise;
    let finished = false; const cancelling = f.dispatch(text('/cancel')).then(() => { finished = true; });
    try { await vi.waitFor(() => expect(signal.aborted).toBe(true)); expect(finished).toBe(false); }
    finally { release.resolve(); }
    await delivering; await cancelling; await f.drain();
    expect(f.relay.status(scope()).contact).toMatchObject({ id: accepted.contact.id, revision: accepted.contact.revision, status: 'accepted', routingActive: false });
    const index = f.execute.mock.calls.findLastIndex(call => call[1] === 'relay.send');
    expect(await f.execute.mock.results[index]!.value).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.copies()).toHaveLength(1); expect(f.aiStarts()).toEqual([]);
  });

  it('keeps a later resume ordered after /cancel while the cancelled copy drains', async () => {
    const f = await fixture(); await f.enable(); await f.accept();
    const entered = Promise.withResolvers<AbortSignal>(); const release = Promise.withResolvers<void>();
    f.before(async call => {
      if (call.method === 'copyMessage') { entered.resolve(call.signal!); await release.promise; throw new Error('Offline interrupted copy'); }
    });
    const delivering = f.dispatch(text('Cancel before resuming')); const signal = await entered.promise;
    const cancelling = f.dispatch(text('/cancel'));
    await vi.waitFor(() => expect(signal.aborted).toBe(true));
    const resuming = f.dispatch(text('/contact resume'));
    await setImmediate(); release.resolve();
    await delivering; await cancelling; await resuming; await f.drain();
    expect(f.relay.status(scope()).contact?.routingActive).toBe(true);
  });

  it.each(['known', 'ambiguous'] as const)('does not retry %s copy failure across duplicate updates and restart', async kind => {
    const f = await fixture(); await f.enable(); await f.accept();
    if (kind === 'known') f.fail(call => call.method === 'copyMessage' ? 403 : undefined);
    else f.before(call => { if (call.method === 'copyMessage') throw new Error('Offline connection lost after possible send'); });
    const update = text('Do not deliver this twice'); await f.handle(update); await f.handle(update);
    const index = f.execute.mock.calls.findLastIndex(call => call[1] === 'relay.send');
    expect(await f.execute.mock.results[index]!.value).toMatchObject({ status: 'failed', error: { code: kind === 'known' ? 'FORBIDDEN' : 'OUTCOME_UNKNOWN' } });
    expect(f.copies()).toHaveLength(1);
    f.fail(); f.before(); await f.restart(); await f.handle(text('/contact resume')); await f.handle(update);
    expect(f.copies()).toHaveLength(1); expect(f.aiStarts()).toEqual([]);
    expect(f.relay.status(scope()).contact?.status).toBe('accepted');
  });
});
