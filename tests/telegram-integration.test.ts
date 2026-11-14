import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unzipSync } from 'fflate';
import { Bot } from 'grammy';
import type { Message, Sticker, Update, UserFromGetMe } from 'grammy/types';
import { JsonStorage } from '../src/storage.js';
import { AccessService } from '../src/access.js';
import { ConfigurationService } from '../src/configuration.js';
import { ActionExecutor, createInvocation } from '../src/actions.js';
import { createTelegramAdapter, createTelegramEffects } from '../src/telegram/index.js';
import type { StartupConfig } from '../src/config.js';
import { AliasService } from '../src/modules/alias.js';
import { RssService, type RssOptions } from '../src/modules/rss.js';
import { FeedFetchError } from '../src/modules/rss-feed.js';
import { RateService, type RateOptions } from '../src/modules/rate.js';
import { WeatherService, type WeatherOptions } from '../src/modules/weather.js';
import type { StickerFile, StickerTransport } from '../src/modules/sticker.js';
import type { StickerConverter } from '../src/modules/sticker-media.js';
import type { StickerKind } from '../shared/schemas/sticker.js';
import { SubconvService } from '../src/modules/subconv.js';
import { subconvBooleanFields, subconvDefaults, subconvPresets, subconvTargets, subconvTriStateFields } from '../shared/schemas/subconv.js';
import { AppError } from '../src/errors.js';
import { translator } from '../src/i18n.js';
import type { ProviderJson } from '../src/modules/provider-http.js';
import { commands, menuCommands } from '../src/telegram/commands.js';
import { buttonRows, callbacks, liveCallbacks, recordContent, richText, telegramMessage } from './support/telegram.js';
import { offlineStickers } from './support/core.js';
import { ResourcePolicy } from '../src/resources.js';
import type { AiTelegramPort } from '../src/ai/telegram-port.js';
import { modules } from '../src/modules/index.js';

const me: UserFromGetMe = {
  id: 12345, is_bot: true, first_name: 'Offline', username: 'offline_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false,
  can_connect_to_business: false, has_main_web_app: false, has_topics_enabled: false,
  allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false,
};
type Call = { method: string; payload: Record<string, unknown>; signal?: AbortSignal };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); vi.useRealTimers(); vi.restoreAllMocks(); });
let sequence = 10_000;
function text(command: string, actor = 1, chatId = actor, thread?: number): Update {
  const id = ++sequence;
  return { update_id: id, message: {
    message_id: id, date: 100, text: command,
    from: { id: actor, is_bot: false, first_name: 'User', language_code: 'en' },
    chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'User' } : { id: chatId, type: 'supergroup', title: 'Group' },
    message_thread_id: thread, is_topic_message: thread !== undefined,
    ...(command.startsWith('/') ? { entities: [{ type: 'bot_command' as const, offset: 0, length: command.split(' ')[0]!.length }] } : {}),
  } };
}
function formReply(value: string, prompt: Message, actor = 1, chatId = actor, thread?: number): Update {
  const update = text(value, actor, chatId, thread);
  update.message!.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
  return update;
}
function button(data: string, original: Message, actor = 1): Update {
  const base = text('', actor);
  return { update_id: base.update_id, callback_query: {
    id: String(base.update_id), from: base.message!.from!, chat_instance: 'private', data, message: telegramMessage(original),
  } };
}
function buttonData(message: Message, operation: string): string {
  const data = callbacks(message).find(data => data.endsWith(`:${operation}`));
  if (!data) throw new Error(`Missing ${operation} button: ${JSON.stringify(buttonRows(message))}`);
  return data;
}
function expectClosed(message: Message, route: 's' | 'c' | 'g' | 'a' | 'r' | 'k' | 'u', userId = 1): void {
  const command = { s: 'settings', c: 'commands', g: 'listgroups', a: 'alias', r: 'rss', k: 'sticker', u: 'subconv' }[route];
  expect(message.reply_markup?.inline_keyboard ?? []).toEqual([]);
  expect(buttonRows(message)).toEqual([[{
    text: expect.stringContaining(`/${command}`), callback_data: `mk:open:${route}:${userId}`,
  }]]);
  expect(message.rich_message?.blocks).toEqual([
    { type: 'paragraph', text: expect.any(Array) },
    { type: 'buttons', buttons: buttonRows(message)[0] },
  ]);
  expect(liveCallbacks(message)).toEqual([]);
}
function expectNativeCommands(rich: unknown, commands: string[]): void {
  expect(rich).toMatchObject({ blocks: expect.arrayContaining([{ type: 'paragraph', text: expect.any(Array) }]), skip_entity_detection: false });
  const inline = (rich as { blocks: { type: string; text?: (string | { type: string })[] }[] }).blocks.flatMap(block => block.type === 'paragraph' ? block.text ?? [] : []);
  expect(inline.filter(text => typeof text !== 'string' && text.type === 'bot_command'))
    .toEqual(commands.map(text => ({ type: 'bot_command', text, bot_command: text.slice(1) })));
  expect(inline.filter(text => typeof text !== 'string' && text.type === 'code')).toEqual([]);
}
function joined(actor = 10, chatId = -200): Update {
  return { update_id: ++sequence, my_chat_member: {
    chat: { id: chatId, type: 'supergroup', title: '<b>Untrusted group</b>' }, from: { id: actor, is_bot: false, first_name: 'Inviter' }, date: 100,
    old_chat_member: { status: 'left', user: me }, new_chat_member: { status: 'member', user: me },
  } };
}

async function fixture(rssOptions: Partial<RssOptions> = {}, groupAdmin?: (chatId: number, userId: number, signal: AbortSignal) => Promise<boolean>, providers: { rate?: RateOptions; weather?: WeatherOptions; sticker?: Parameters<typeof offlineStickers>[0]; ai?: AiTelegramPort } = {}) {
  const directory = await mkdtemp('/tmp/kilo/telegram-integration-');
  const config: StartupConfig = {
    botToken: '12345:offline-test', adminIds: [1, 2], dataDir: directory, logLevel: 'silent', pollingTimeout: 30,
    requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 },
  };
  const storage = new JsonStorage(directory);
  await storage.initialize();
  const configuration = new ConfigurationService(storage);
  const access = new AccessService(storage, config.adminIds);
  await configuration.initialize();
  await access.initialize();
  const aliases = new AliasService(storage, commands.map(command => command.name));
  await aliases.initialize();
  const calls: Call[] = [];
  const messages: Message[] = [];
  let failure: ((call: Call) => boolean) | undefined;
  let delayed: ((call: Call) => Promise<void>) | undefined;
  let memberStatus: 'member' | 'left' = 'member';
  let chatType: 'supergroup' | 'private' = 'supergroup';
  const bot = new Bot(config.botToken, { botInfo: me, client: { fetch: vi.fn(() => { throw new Error('Production network forbidden'); }) } });
  bot.api.config.use(async (_previous, method, payload, signal) => {
    const call = { method, payload: structuredClone(payload) as Record<string, unknown>, signal: signal as unknown as AbortSignal };
    calls.push(call);
    await delayed?.(call);
    if (failure?.(call)) return { ok: false, error_code: 403, description: 'secret-token-private-exception' };
    let result: unknown = method === 'getChat' ? { id: call.payload.chat_id, type: chatType, title: '<b>Telegram group</b>', accent_color_id: 1 }
      : method === 'getChatMember' ? { status: memberStatus, user: me }
      : true;
    if (method === 'sendMessage' || method === 'sendRichMessage') {
      const chatId = Number(call.payload.chat_id);
      const sent = {
        message_id: ++sequence, date: 100, from: me,
        chat: chatId > 0 ? { id: chatId, type: 'private', first_name: 'User' } : { id: chatId, type: 'supergroup', title: 'Group' },
        message_thread_id: call.payload.message_thread_id, is_topic_message: call.payload.message_thread_id !== undefined, text: call.payload.text,
        entities: call.payload.entities, reply_markup: call.payload.reply_markup,
      } as Message;
      recordContent(sent, call.payload);
      messages.push(sent);
      result = telegramMessage(sent);
    }
    if (method === 'editMessageText' || method === 'editMessageReplyMarkup') {
      const sent = messages.findLast(item => item.chat.id === call.payload.chat_id && item.message_id === call.payload.message_id);
      if (!sent) throw new Error('Attempted to edit an unrecorded Telegram message');
      if (method !== 'editMessageReplyMarkup') recordContent(sent, call.payload);
      Object.assign(sent, { reply_markup: call.payload.reply_markup });
      result = telegramMessage(sent);
    }
    return { ok: true, result: structuredClone(result) } as never;
  });
  const health = { recordUpdate: vi.fn(), recordApiError: vi.fn() };
  const effects = createTelegramEffects(bot, configuration, health, config.adminIds);
  let now = Date.now();
  const rss = new RssService(storage, { allowed: target => target.kind === 'private' || access.isAllowed(target.chatId), send: async () => {}, ...rssOptions });
  await rss.initialize();
  const rate = new RateService(storage, providers.rate); await rate.initialize();
  const weather = new WeatherService(storage, providers.weather); await weather.initialize();
  const stickers = offlineStickers(providers.sticker);
  const subconv = new SubconvService(storage); await subconv.initialize();
  const executor = new ActionExecutor({ access, configuration, effects, aliases, rss, rate, weather, stickers, subconv, groupAdmin, now: () => now,
    status: () => ({ uptimeSeconds: 20, updateCount: 5, authorizedGroupCount: access.count(), polling: 'running', http: 'disabled', lastApiError: null }) });
  const controller = new AbortController();
  const adapter = createTelegramAdapter(bot, { config, access, configuration, executor, stickers, ai: providers.ai, health, signal: controller.signal });
  cleanup.push(async () => { await adapter.stop(); await Promise.all([rss.stop(), rate.stop(), weather.stop(), stickers.stop()]); await executor.close(); await storage.close(); await rm(directory, { recursive: true, force: true }); });
  const sent = () => calls.filter(call => call.method === 'sendMessage' || call.method === 'sendRichMessage');
  const last = (actor = 1, thread?: number): Message => {
    const result = messages.findLast(item => item.chat.id === actor && item.message_thread_id === thread);
    if (!result) throw new Error('No recorded sent message for this chat/thread');
    return result;
  };
  const approvalFor = (actor: number): Message => {
    const result = messages.findLast(item => item.chat.id === actor && callbacks(item).some(data => data.endsWith(':confirm')));
    if (!result) throw new Error('No recorded approval panel for this recipient');
    return result;
  };
  const click = (operation: string, original = last(), actor = 1) => button(buttonData(original, operation), original, actor);
  return { bot, adapter, storage, access, aliases, rss, rate, weather, stickers, subconv, configuration, executor, effects, calls, sent, messages, last, click, approvalFor, health, controller,
    fail: (predicate: (call: Call) => boolean) => { failure = predicate; },
    delay: (operation: (call: Call) => Promise<void>) => { delayed = operation; },
    expire: () => { now += 600_001; },
    setMember: (status: typeof memberStatus) => { memberStatus = status; },
    setChatType: (type: typeof chatType) => { chatType = type; },
  };
}

async function aliasInput(f: Awaited<ReturnType<typeof fixture>>, thread?: number): Promise<Message> {
  await f.bot.handleUpdate(text('/alias', 1, 1, thread));
  const pane = f.last(1, thread);
  await f.bot.handleUpdate(f.click('aliasadd', pane));
  const target = buttonRows(pane).flat().find(button => richText(button.text).includes('/help') && 'callback_data' in button);
  if (!target || !('callback_data' in target)) throw new Error('Missing cached /help alias target');
  await f.bot.handleUpdate(button(target.callback_data, pane));
  const prompt = f.last(1, thread);
  expect(prompt.message_id).not.toBe(pane.message_id);
  expect(f.sent().at(-1)).toMatchObject({ method: 'sendRichMessage', payload: { reply_markup: { force_reply: true, selective: true } } });
  expect(pane.reply_markup?.force_reply).toBeUndefined();
  expect(f.adapter.sessions.get(`${me.id}:1:1:${thread ?? 0}`)?.aliasInput).toMatchObject({
    messageId: pane.message_id, promptMessageId: prompt.message_id,
  });
  return pane;
}

describe('private native subconv frontend', () => {
  const source = 'https://subscription.example/list?token=PRIVATE_SOURCE_TOKEN';
  const backend = 'https://convert.example:8443/private-path?api_key=PRIVATE_BACKEND_TOKEN';
  const owner = (actor = 10) => createInvocation({ actorId: actor, botId: me.id, source: 'telegram', language: 'en', chat: { id: actor, type: 'private' } });
  const reply = (value: string, prompt: Message, actor = 10, thread?: number) => {
    const update = text(value, actor, actor, thread);
    update.message!.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
    return update;
  };
  const native = (pane: Message) => {
    expect(pane.reply_markup?.inline_keyboard ?? []).toEqual([]);
    expect(pane.rich_message).toMatchObject({ skip_entity_detection: true });
    expect(pane.rich_message?.blocks[0]?.type).toBe('paragraph');
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/"type":"(?:heading|button)"|"(?:html|markdown|url|web_app|login_url)":/);
    expect(callbacks(pane).every(value => Buffer.byteLength(value) <= 64)).toBe(true);
    expect(pane.rich_message?.blocks.at(-1)?.type).toBe('buttons');
  };
  async function open(f: Awaited<ReturnType<typeof fixture>>, actor = 10, thread?: number) {
    await f.bot.handleUpdate(text('/subconv', actor, actor, thread));
    return f.last(actor, thread);
  }
  async function enter(f: Awaited<ReturnType<typeof fixture>>, pane: Message, field: number, value: string, actor = 10, thread?: number) {
    await f.bot.handleUpdate(f.click(`uinput:${field}`, pane, actor));
    const prompt = f.last(actor, thread);
    expect(prompt.message_id).not.toBe(pane.message_id);
    const sent = f.calls.findLast(call => call.method === 'sendRichMessage')!;
    expect(sent.payload.reply_markup).toMatchObject({ force_reply: true, input_field_placeholder: expect.any(String) });
    expect(sent.payload).not.toHaveProperty('parse_mode');
    await f.bot.handleUpdate(reply(value, prompt, actor, thread));
    return prompt;
  }
  async function ready(f: Awaited<ReturnType<typeof fixture>>, raw = source) {
    const pane = await open(f);
    await enter(f, pane, 1, backend);
    await enter(f, pane, 0, raw);
    return pane;
  }

  it('opens for an ordinary private owner with blank backend and no provider or converter calls', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const f = await fixture();
    const execute = vi.spyOn(f.executor, 'execute');
    const pane = await open(f);
    native(pane);
    expect(f.subconv.settings(owner())).toEqual({ revision: 0, settings: subconvDefaults() });
    expect(f.subconv.settings(owner()).settings.backend).toBe('');
    expect(richText(pane)).toContain('TLS');
    expect(richText(pane)).toContain(translator('en')('bot:subconv.disclosure'));
    expect(buttonRows(pane)).toHaveLength(5);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
    expect(network).not.toHaveBeenCalled();
    expect(f.calls.map(call => call.method)).toEqual(['sendRichMessage']);
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.bot.handleUpdate(text('/subconv', 10, -100));
    expect(richText(f.last(-100))).toBe(translator('en')('bot:privateOnly'));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(menuCommands('en', false, true).some(command => command.command === 'subconv')).toBe(true);
    expect(menuCommands('en', true, false).some(command => command.command === 'subconv')).toBe(false);
  });

  it('presents all current targets and grouped presets with native selected controls', async () => {
    const f = await fixture(); const pane = await open(f);
    await f.bot.handleUpdate(f.click('utargets', pane, 10));
    expect(callbacks(pane).filter(data => /:utarget:\d$/.test(data))).toHaveLength(6);
    for (const [index, target] of subconvTargets.entries()) {
      await f.bot.handleUpdate(f.click(`utarget:${index}`, pane, 10));
      expect(f.subconv.settings(owner()).settings.options.target).toBe(target.id);
      expect(buttonRows(pane).flat().find(button => button.text === target.label)).toMatchObject({ style: 'primary' });
      native(pane);
    }
    await f.bot.handleUpdate(f.click('uhome', pane, 10));
    await f.bot.handleUpdate(f.click('upresets', pane, 10));
    expect(callbacks(pane).filter(data => /:upreset:\d$/.test(data))).toHaveLength(7);
    expect(pane.rich_message?.blocks.filter(block => block.type === 'paragraph')).toHaveLength(4);
    for (const [index, preset] of subconvPresets.entries()) {
      await f.bot.handleUpdate(f.click(`upreset:${index}`, pane, 10));
      expect(f.subconv.settings(owner()).settings.options.remoteConfig).toBe(preset.url);
      expect(buttonRows(pane).flat().find(button => button.text === preset.label)).toMatchObject({ style: 'primary' });
      expect(richText(pane)).not.toContain(preset.url);
    }
    expect(f.subconv.settings(owner(11)).settings).toEqual(subconvDefaults());
  });

  it('persists every boolean independently and cycles tri-state options default, true, false, default', async () => {
    const f = await fixture(); const pane = await open(f);
    await f.bot.handleUpdate(f.click('uoptions', pane, 10));
    const flags = [...subconvBooleanFields, ...subconvTriStateFields];
    for (const [index, field] of flags.entries()) {
      await f.bot.handleUpdate(f.click(`upage:${Math.floor(index / 6)}`, pane, 10));
      expect(callbacks(pane).filter(data => /:uflag:/.test(data))).toHaveLength(6);
      if (field === 'udp' || field === 'tfo') {
        for (const state of [true, false, null]) {
          await f.bot.handleUpdate(f.click(`uflag:${index}`, pane, 10));
          expect(f.subconv.settings(owner()).settings.options[field]).toBe(state);
          const button = buttonRows(pane).flat().find(button => 'callback_data' in button && button.callback_data.endsWith(`:uflag:${index}`));
          expect(button?.text).toContain(translator('en')(`bot:subconv.states.${state === null ? 'default' : String(state)}`));
          expect(button?.style).toBe(state === true ? 'primary' : undefined);
        }
      } else {
        await f.bot.handleUpdate(f.click(`uflag:${index}`, pane, 10));
        expect(f.subconv.settings(owner()).settings.options[field]).toBe(!subconvDefaults().options[field]);
      }
    }
    native(pane);
  });

  it('only accepts an explicit reply to the current bot prompt in the exact owner/chat/topic scope', async () => {
    const f = await fixture(); const execute = vi.spyOn(f.executor, 'execute');
    await f.subconv.update(owner(), { ...subconvDefaults(), backend }, 0);
    const pane = await open(f, 10, 9);
    await f.bot.handleUpdate(f.click('uinput:0', pane, 10));
    const prompt = f.last(10, 9);
    const key = `${me.id}:10:10:9`;
    const pending = f.adapter.sessions.get(key)?.subconvInput;
    expect(pending).toMatchObject({ promptMessageId: prompt.message_id, messageId: pane.message_id, field: 'source', revision: 1 });
    const wrongBot = telegramMessage(prompt); wrongBot.from = { ...me, id: 999 };
    const wrongChat = telegramMessage(prompt); wrongChat.chat = { id: 11, type: 'private', first_name: 'Other' };
    const wrongTopic = telegramMessage(prompt); wrongTopic.message_thread_id = 10;
    for (const update of [text(source, 10, 10, 9), reply(source, pane, 10, 9), reply(source, prompt, 11, 9),
      reply(source, prompt, 10, 10), reply(source, wrongBot, 10, 9), reply(source, wrongChat, 10, 9), reply(source, wrongTopic, 10, 9)]) {
      await f.bot.handleUpdate(update);
      expect(f.adapter.sessions.get(key)?.subconvInput).toEqual(pending);
    }
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
    await f.bot.handleUpdate(reply(source, prompt, 10, 9));
    expect(f.adapter.sessions.get(key)?.subconvInput).toBeUndefined();
    expect(richText(pane)).not.toContain('PRIVATE_SOURCE_TOKEN');
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    expect(execute.mock.calls.find(call => call[1] === 'subconv.generate')?.[2]).toMatchObject({ source });
  });

  it('keeps secrets out of routine panels, prompts, errors and callback data; stores only personal settings', async () => {
    const f = await fixture(); const pane = await ready(f);
    await enter(f, pane, 6, 'token=CUSTOM_SECRET=a=b\nlabel= value with spaces ');
    await f.bot.handleUpdate(f.click('upresets', pane, 10));
    await enter(f, pane, 2, 'https://config.example/path?key=PRIVATE_CONFIG_TOKEN');
    await f.bot.handleUpdate(f.click('ufilters', pane, 10));
    await enter(f, pane, 3, '<b>PRIVATE_FILTER</b>');
    await f.bot.handleUpdate(f.click('uinput:1', pane, 10));
    await f.bot.handleUpdate(reply('https://user:PRIVATE_INVALID@invalid.example/', f.last(10)));
    expect(f.adapter.sessions.get(`${me.id}:10:10:0`)?.subconvInput).toBeDefined();
    const serialized = JSON.stringify(f.calls);
    for (const secret of ['PRIVATE_SOURCE_TOKEN', 'PRIVATE_BACKEND_TOKEN', 'PRIVATE_CONFIG_TOKEN', 'PRIVATE_FILTER', 'PRIVATE_INVALID', 'CUSTOM_SECRET']) expect(serialized).not.toContain(secret);
    expect(richText(pane)).toContain('convert.example:8443');
    expect(richText(pane)).not.toContain('private-path');
    const saved = await readFile(join(f.storage.directory, 'subconv.json'), 'utf8');
    expect(saved).toContain('PRIVATE_BACKEND_TOKEN');
    expect(saved).toContain('PRIVATE_CONFIG_TOKEN');
    expect(saved).not.toContain('PRIVATE_SOURCE_TOKEN');
    expect(saved).not.toContain('CUSTOM_SECRET');
    expect(saved).not.toContain('customParams');
  });

  it('shows the complete generated URL only as deliberate owner-only preformatted output without links or fetches', async () => {
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network allowed'));
    const f = await fixture();
    const raw = `${source}&long=${'x'.repeat(7000)}`;
    const pane = await ready(f, raw);
    await enter(f, pane, 6, 'token=CUSTOM_SECRET=a=b');
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    const pre = pane.rich_message?.blocks.find(block => block.type === 'pre');
    expect(pre?.type).toBe('pre');
    const output = richText(pre);
    expect(output.length).toBeGreaterThan(4096);
    expect(output.length).toBeLessThanOrEqual(24_576);
    expect(new URL(output).searchParams.get('url')).toBe(raw);
    expect(new URL(output).searchParams.get('token')).toBe('CUSTOM_SECRET=a=b');
    expect(new URL(output).searchParams.get('scv')).toBe('true');
    expect(pane.rich_message?.blocks[1]).toEqual({ type: 'pre', text: output });
    expect(richText(pane.rich_message?.blocks[0])).not.toMatch(/PRIVATE_|CUSTOM_SECRET/);
    expect(buttonRows(pane).flat().some(button => 'copy_text' in button)).toBe(false);
    native(pane);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.generate']);
    expect(network).not.toHaveBeenCalled();
    expect(f.calls.every(call => ['sendRichMessage', 'editMessageText', 'answerCallbackQuery'].includes(call.method))).toBe(true);
    await f.bot.handleUpdate(f.click('uhome', pane, 10));
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/PRIVATE_|CUSTOM_SECRET/);
  });

  it('offers copy_text only for short output and keeps reset backend and one-shot source intact', async () => {
    const f = await fixture(); const pane = await ready(f, 'ss://abc');
    await f.bot.handleUpdate(f.click('upresets', pane, 10));
    await f.bot.handleUpdate(f.click('uinput:2', pane, 10));
    await f.bot.handleUpdate(f.click('uclear', pane, 10));
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    const output = richText(pane.rich_message?.blocks.find(block => block.type === 'pre'));
    expect(output.length).toBeLessThanOrEqual(256);
    expect(buttonRows(pane).flat().find(button => 'copy_text' in button)).toMatchObject({ copy_text: { text: output } });
    await f.bot.handleUpdate(f.click('uhome', pane, 10));
    await f.bot.handleUpdate(f.click('ureset', pane, 10));
    expect(f.subconv.settings(owner()).settings).toEqual({ ...subconvDefaults(), backend });
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ source: 'ss://abc' });
  });

  it('discards unsubmitted input on back, cancel and fresh open, without consuming other module input or stickers', async () => {
    const f = await fixture(); const alias = await aliasInput(f);
    const key = `${me.id}:1:1:0`;
    const originalAlias = f.adapter.sessions.get(key)?.aliasInput;
    const pane = await open(f, 1);
    await f.bot.handleUpdate(f.click('uinput:0', pane, 1));
    const prompt = f.last();
    expect(f.adapter.sessions.get(key)?.aliasInput).toEqual(originalAlias);
    const sticker = text('', 1);
    sticker.message!.sticker = { type: 'regular', file_id: 'input-sticker', file_unique_id: 'unique', width: 1, height: 1, is_animated: false, is_video: false };
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(sticker);
    expect(execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(reply(source, prompt, 1));
    expect(f.adapter.sessions.get(key)?.aliasInput).toEqual(originalAlias);
    await f.bot.handleUpdate(f.click('uinput:0', pane, 1));
    const abandoned = f.last();
    await f.bot.handleUpdate(f.click('uhome', pane, 1));
    await f.bot.handleUpdate(reply(source, abandoned, 1));
    expect(execute.mock.calls.some(call => call[1].startsWith('subconv.') && call[1] !== 'subconv.settings.get')).toBe(false);
    await f.bot.handleUpdate(text('/cancel', 1));
    expectClosed(pane, 'u', 1); expectClosed(alias, 'a', 1);
    expect(f.adapter.sessions.size).toBe(0);
    const reopened = await open(f, 1);
    await f.bot.handleUpdate(f.click('ugenerate', reopened, 1));
    expect(execute.mock.calls.some(call => call[1] === 'subconv.generate')).toBe(false);
  });

  it.each(['rss', 'weather'])('does not disclose unmatched subconv input to an already open %s form', async module => {
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher });
    await f.subconv.update(owner(), { ...subconvDefaults(), backend }, 0);
    await f.bot.handleUpdate(text(`/${module}`, 10));
    if (module === 'rss') await f.bot.handleUpdate(f.click('rssadd', f.last(10), 10));
    const key = `${me.id}:10:10:0`;
    expect(f.adapter.sessions.get(key)?.[module === 'rss' ? 'rssInput' : 'weatherInput']).toBeDefined();
    const pane = await open(f);
    await f.bot.handleUpdate(f.click('uinput:0', pane, 10));
    const prompt = f.last(10);
    const pending = structuredClone(f.adapter.sessions.get(key)?.subconvInput);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text(source, 10));
    expect(execute).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.adapter.sessions.get(key)?.subconvInput).toEqual(pending);
    expect(await readFile(join(f.storage.directory, 'rss.json'), 'utf8')).not.toContain('PRIVATE_SOURCE_TOKEN');
    await f.bot.handleUpdate(reply(source, prompt));
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.generate']);
    expect(new URL(richText(pane.rich_message?.blocks.find(block => block.type === 'pre'))).searchParams.get('url')).toBe(source);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects foreign, wrong-message, cross-topic, wrong-route, unlisted-field and stale-generation callbacks before Actions', async () => {
    const f = await fixture(); const pane = await open(f);
    const execute = vi.spyOn(f.executor, 'execute');
    const valid = buttonData(pane, 'uinput:0');
    const wrongMessage = telegramMessage(pane); wrongMessage.message_id++;
    const wrongTopic = telegramMessage(pane); wrongTopic.is_topic_message = true; wrongTopic.message_thread_id = 9;
    const wrongChat = telegramMessage(pane); wrongChat.chat = { id: 11, type: 'private', first_name: 'Other' };
    const wrongBot = telegramMessage(pane); wrongBot.from = { ...me, id: 999 };
    for (const update of [button(valid, pane, 11), button(valid, wrongMessage, 10), button(valid, wrongTopic, 10),
      button(valid, wrongChat, 10), button(valid, wrongBot, 10), button(valid.replace(':u:', ':s:'), pane, 10),
      button(valid.replace('uinput:0', 'uinput:3'), pane, 10), button(valid.replace('uinput:0', 'uflag:11'), pane, 10),
      button(valid.replace('uinput:0', 'upreset:9'), pane, 10)]) await f.bot.handleUpdate(update);
    expect(execute).not.toHaveBeenCalled();
    expect(f.adapter.sessions.size).toBe(0);
    await f.bot.handleUpdate(f.click('uoptions', pane, 10));
    const hidden = buttonData(pane, 'uflag:0').replace('uflag:0', 'uflag:11');
    await f.bot.handleUpdate(button(hidden, pane, 10));
    await f.bot.handleUpdate(button(valid, pane, 10));
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery').every(call => call.payload.text === undefined || !JSON.stringify(call.payload).includes(source))).toBe(true);
  });

  it.each(['save', 'generate'] as const)('refuses a stale personal revision on %s instead of applying new settings silently', async operation => {
    const f = await fixture(); const pane = await ready(f);
    if (operation === 'save') await f.bot.handleUpdate(f.click('uinput:1', pane, 10));
    const snapshot = f.subconv.settings(owner());
    await f.subconv.update(owner(), { ...snapshot.settings, backend: 'https://new-backend.example' }, snapshot.revision);
    const execute = vi.spyOn(f.executor, 'execute');
    if (operation === 'save') await f.bot.handleUpdate(reply('https://stale-change.example', f.last(10)));
    else await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    expectClosed(pane, 'u', 10);
    expect(f.subconv.settings(owner()).settings.backend).toBe('https://new-backend.example');
    expect(pane.rich_message?.blocks.some(block => block.type === 'pre')).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    const stale = JSON.stringify(f.calls);
    expect(stale).not.toContain('PRIVATE_SOURCE_TOKEN');
  });

  it('expires results and RAM secrets and reopens using only a fresh settings read', async () => {
    const f = await fixture(); const pane = await ready(f);
    await enter(f, pane, 6, 'token=CUSTOM_SECRET');
    const data = buttonData(pane, 'ugenerate');
    const id = data.split(':')[3]!;
    const panel = f.adapter.panels.get(id, { key: `${me.id}:10:10:0`, botId: me.id, chatId: 10, userId: 10, language: 'en', messageId: pane.message_id });
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    const execute = vi.spyOn(f.executor, 'execute');
    vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001);
    expect(f.adapter.panels.size).toBe(0);
    await f.adapter.panels.closeOwned(`${me.id}:10:10:0`, 'expired');
    await vi.waitFor(() => expectClosed(pane, 'u', 10));
    expect(JSON.stringify(panel.value)).not.toMatch(/PRIVATE_SOURCE_TOKEN|CUSTOM_SECRET/);
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/PRIVATE_|CUSTOM_SECRET/);
    await f.bot.handleUpdate(button(callbacks(pane)[0]!, pane, 10));
    const reopened = f.last(10);
    expect(reopened.message_id).not.toBe(pane.message_id);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.settings.get']);
    await f.bot.handleUpdate(f.click('ugenerate', reopened, 10));
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('retries only the failed result edit, never generation or a duplicate delivery', async () => {
    const f = await fixture(); const pane = await ready(f);
    const data = buttonData(pane, 'ugenerate');
    const execute = vi.spyOn(f.executor, 'execute');
    f.fail(call => call.method === 'editMessageText');
    await f.bot.handleUpdate(button(data, pane, 10));
    f.fail(() => false);
    await f.bot.handleUpdate(button(data, pane, 10));
    expect(execute.mock.calls.map(call => call[1])).toEqual(['subconv.generate']);
    expect(pane.rich_message?.blocks.filter(block => block.type === 'pre')).toHaveLength(1);
    expect(f.calls.filter(call => call.method === 'sendRichMessage' && (call.payload.rich_message as { blocks: { type: string }[] }).blocks.some(block => block.type === 'pre'))).toHaveLength(0);
    const edits = f.calls.filter(call => call.method === 'editMessageText').length;
    await f.bot.handleUpdate(button(data, pane, 10));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.calls.filter(call => call.method === 'editMessageText')).toHaveLength(edits);
  });

  it('never restores a generated secret into a panel that expired while its Action was pending', async () => {
    const f = await fixture(); const pane = await ready(f);
    const callback = buttonData(pane, 'ugenerate');
    const panel = f.adapter.panels.get(callback.split(':')[3]!, { key: `${me.id}:10:10:0`, botId: me.id,
      chatId: 10, userId: 10, language: 'en', messageId: pane.message_id });
    const generated = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    cleanup.unshift(async () => { release.resolve(); });
    const original = f.executor.execute.bind(f.executor);
    vi.spyOn(f.executor, 'execute').mockImplementation(async (...args) => {
      const result = await original(...args);
      if (args[1] === 'subconv.generate') { generated.resolve(); await release.promise; }
      return result;
    });
    const update = f.bot.handleUpdate(button(callback, pane, 10));
    await generated.promise;
    await f.adapter.panels.close(panel, 'expired');
    expectClosed(pane, 'u', 10);
    release.resolve(); await update;
    expect(JSON.stringify(panel.value)).not.toContain('PRIVATE_SOURCE_TOKEN');
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/PRIVATE_|"type":"pre"/);
  });

  it('clears individual fields and replaces the previous panel without restoring its one-shot values', async () => {
    const f = await fixture(); const pane = await ready(f);
    await enter(f, pane, 6, 'token=CUSTOM_SECRET');
    for (const [field, index] of [['include', 3], ['exclude', 4], ['filename', 5]] as const) {
      await f.bot.handleUpdate(f.click('ufilters', pane, 10));
      await enter(f, pane, index, `private-${field}`);
      expect(f.subconv.settings(owner()).settings.options[field]).toBe(`private-${field}`);
      await f.bot.handleUpdate(f.click('ufilters', pane, 10));
      await f.bot.handleUpdate(f.click(`uinput:${index}`, pane, 10));
      await f.bot.handleUpdate(f.click('uclear', pane, 10));
      expect(f.subconv.settings(owner()).settings.options[field]).toBe('');
    }
    await f.bot.handleUpdate(f.click('uinput:6', pane, 10));
    await f.bot.handleUpdate(f.click('uclear', pane, 10));
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('ugenerate', pane, 10));
    expect(execute.mock.calls[0]?.[2]).toMatchObject({ source, customParams: [] });
    const replacement = await open(f);
    expectClosed(pane, 'u', 10);
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/PRIVATE_|CUSTOM_SECRET/);
    expect(f.subconv.settings(owner()).settings.backend).toBe(backend);
    await f.bot.handleUpdate(f.click('ugenerate', replacement, 10));
    expect(execute.mock.calls.filter(call => call[1] === 'subconv.generate')).toHaveLength(1);
    await f.bot.handleUpdate(f.click('uinput:1', replacement, 10));
    await f.bot.handleUpdate(f.click('uclear', replacement, 10));
    expect(f.subconv.settings(owner()).settings.backend).toBe('');
  });
});

describe('Telegram with real Actions and persistent services', () => {
  function lookupProviders() {
    const rateJson = vi.fn<ProviderJson>(async url => url.pathname.endsWith('/codes')
      ? { result: 'success', supported_codes: [['USD', 'US Dollar'], ['JPY', 'Japanese Yen'], ['CNY', 'Chinese Yuan']] }
      : { result: 'success', base_code: 'USD', conversion_rates: { USD: 1, JPY: 150, CNY: 7.2 }, time_last_update_unix: Math.floor(Date.now() / 1000), time_next_update_unix: Math.floor(Date.now() / 1000) + 86400 });
    const weatherJson = vi.fn<ProviderJson>(async url => url.pathname.includes('/geo/')
      ? { code: '200', location: [{ id: 'haidian', name: '海淀', adm1: '北京市', adm2: '北京', country: '中国', lat: '39.96', lon: '116.30', tz: 'Asia/Shanghai' }] }
      : url.pathname.includes('/daily/') ? { days: [{ forecastStartTime: '2026-11-09T16:00:00Z', temperatureMin: { value: 2 }, temperatureMax: { value: 8 }, daytime: { condition: { code: 101, text: 'Cloudy' } } }] }
        : { temperature: { value: 8 }, feelsLike: { value: 7 }, humidity: 0.5, wind: { speed: { value: 2 } }, precipitation: { amount: { value: 0 } }, condition: { code: 100, text: 'Clear' } });
    return { rate: { key: 'TEST_ONLY_KEY', json: rateJson }, weather: { qweatherHost: 'test.qweatherapi.com', qweatherKey: 'TEST_ONLY_KEY', json: weatherJson }, rateJson, weatherJson };
  }

  const inputFields = { alias: 'aliasInput', rss: 'rssInput', weather: 'weatherInput', subconv: 'subconvInput' } as const;
  const inputKinds = ['alias', 'rss', 'weather', 'subconv'] as const;
  const values = { alias: 'isolated_alias', rss: 'https://feeds.example.com/isolated Isolated feed', weather: '北京海淀区', subconv: 'https://convert.example/sub' };
  function availableAi() {
    return { available: vi.fn(() => true), capture: vi.fn<AiTelegramPort['capture']>(async () => 'offline-file'),
      isReply: vi.fn(() => false), attachTelegram: vi.fn<AiTelegramPort['attachTelegram']>() } satisfies AiTelegramPort;
  }
  async function waitingForms(f: Awaited<ReturnType<typeof fixture>>) {
    const key = `${me.id}:1:1:9`;
    const alias = await aliasInput(f, 9); const aliasPrompt = f.last(1, 9);
    const savedAlias = f.adapter.sessions.get(key)?.aliasInput;
    await f.bot.handleUpdate(text('/rss', 1, 1, 9));
    const rss = f.last(1, 9);
    await f.bot.handleUpdate(f.click('rssadd', rss));
    const rssPrompt = f.last(1, 9);
    expect(f.adapter.sessions.get(key)?.aliasInput).toEqual(savedAlias);
    const savedRss = f.adapter.sessions.get(key)?.rssInput;
    await f.bot.handleUpdate(text('/weather', 1, 1, 9));
    const weatherPrompt = f.last(1, 9); const weather = f.messages.at(-2)!;
    const savedWeather = f.adapter.sessions.get(key)?.weatherInput;
    await f.bot.handleUpdate(text('/subconv', 1, 1, 9));
    const subconv = f.last(1, 9);
    await f.bot.handleUpdate(f.click('uinput:1', subconv));
    const subconvPrompt = f.last(1, 9);
    const panels = { alias, rss, weather, subconv };
    const prompts = { alias: aliasPrompt, rss: rssPrompt, weather: weatherPrompt, subconv: subconvPrompt };
    const pending = f.adapter.sessions.get(key)!;
    expect(pending).toMatchObject({ aliasInput: savedAlias, rssInput: savedRss, weatherInput: savedWeather });
    expect(Object.keys(pending).sort()).toEqual(Object.values(inputFields).sort());
    expect(new Set(Object.values(prompts).map(prompt => prompt.message_id)).size).toBe(4);
    for (const kind of inputKinds) {
      expect(prompts[kind]).toMatchObject({ from: me, chat: { id: 1 }, message_thread_id: 9, is_topic_message: true,
        reply_markup: { force_reply: true }, rich_message: { skip_entity_detection: kind === 'subconv' } });
      expect(prompts[kind].message_id).not.toBe(panels[kind].message_id);
      expect(panels[kind].reply_markup?.force_reply).toBeUndefined();
      expect(pending[inputFields[kind]]).toMatchObject({ messageId: panels[kind].message_id, promptMessageId: prompts[kind].message_id });
    }
    return { key, panels, prompts, pending };
  }

  it.each(inputKinds)('routes an exact %s ForceReply only to its owner while all four module inputs coexist', async kind => {
    const providers = lookupProviders(); const ai = availableAi();
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher }, undefined, { ...providers, ai });
    const form = await waitingForms(f);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(formReply(values[kind], form.prompts[kind], 1, 1, 9));
    const expected = { alias: ['alias.add', 'alias.list'], rss: ['rss.add', 'rss.list'],
      weather: ['weather.search', 'weather.query', 'weather.default.get'], subconv: ['subconv.settings.set'] };
    expect(execute.mock.calls.map(call => call[1])).toEqual(expected[kind]);
    expect(f.adapter.sessions.get(form.key)?.[inputFields[kind]]).toBeUndefined();
    for (const other of inputKinds.filter(other => other !== kind)) {
      expect(f.adapter.sessions.get(form.key)?.[inputFields[other]]).toEqual(form.pending[inputFields[other]]);
    }
    if (kind === 'alias') expect(f.aliases.resolve(values.alias)).toBe('help');
    else expect(f.aliases.snapshot().revision).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(kind === 'rss' ? 1 : 0);
    expect(providers.weatherJson).toHaveBeenCalledTimes(kind === 'weather' ? 2 : 0);
    expect(f.weather.getDefault(1).location).toBeNull();
    if (kind === 'subconv') expect(f.subconv.settings(createInvocation({ actorId: 1, botId: me.id, source: 'telegram',
      chat: { id: 1, type: 'private', threadId: 9 }, language: 'en' })).settings.backend).toBe(values.subconv);
    expect(ai.capture).not.toHaveBeenCalled(); expect(ai.available).not.toHaveBeenCalled();
    execute.mockClear();
    await f.bot.handleUpdate(formReply(values[kind], form.prompts[kind], 1, 1, 9));
    expect(execute).not.toHaveBeenCalled();
    expect(f.adapter.sessions.get(form.key)?.[inputFields[kind]]).toBeUndefined();
  });

  it('does not treat bare values as any waiting form input or leak them to available AI', async () => {
    const providers = lookupProviders(); const ai = availableAi();
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher }, undefined, { ...providers, ai });
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text('AI routing positive control', 1, 1, 9));
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'ai.run.start', { text: 'AI routing positive control' });
    const form = await waitingForms(f); execute.mockClear(); ai.available.mockClear();
    for (const value of Object.values(values)) await f.bot.handleUpdate(text(value, 1, 1, 9));
    expect(execute).not.toHaveBeenCalled(); expect(ai.capture).not.toHaveBeenCalled(); expect(ai.available).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled(); expect(providers.weatherJson).not.toHaveBeenCalled();
    expect(f.aliases.snapshot().revision).toBe(0); expect(f.rss.snapshot().subscriptions).toEqual([]);
    expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
  });

  it.each(inputKinds)('rejects foreign, stale and forwarded %s prompt replies without consuming any other form', async kind => {
    const ai = availableAi(); const providers = lookupProviders();
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher }, undefined, { ...providers, ai });
    const form = await waitingForms(f); const prompt = form.prompts[kind];
    const execute = vi.spyOn(f.executor, 'execute');
    const forwarded = formReply(values[kind], prompt, 1, 1, 9);
    forwarded.message!.forward_origin = { type: 'user', date: 100, sender_user: { id: 2, is_bot: false, first_name: 'Other' } };
    const external = formReply(values[kind], prompt, 1, 1, 9);
    external.message!.external_reply = { origin: { type: 'hidden_user', date: 100, sender_user_name: 'Other' } };
    const replies = [formReply(values[kind], form.panels[kind], 1, 1, 9), formReply(values[kind], prompt, 2, 2, 9),
      formReply(values[kind], prompt, 2, 1, 9), formReply(values[kind], prompt, 1, 1, 10), forwarded, external];
    for (const fake of [
      { ...prompt, message_id: prompt.message_id + 1_000_000 }, { ...prompt, from: { ...me, id: 999 } },
      { ...prompt, from: { ...me, is_bot: false } }, { ...prompt, from: undefined },
      { ...prompt, chat: { id: 2, type: 'private', first_name: 'Other' } },
      { ...prompt, message_thread_id: 10, is_topic_message: true }, { ...prompt, message_thread_id: 9, is_topic_message: false },
    ]) replies.push(formReply(values[kind], fake as Message, 1, 1, 9));
    for (const update of replies) {
      await f.bot.handleUpdate(update);
      expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
    }
    expect(execute).not.toHaveBeenCalled(); expect(ai.capture).not.toHaveBeenCalled(); expect(ai.available).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled(); expect(providers.weatherJson).not.toHaveBeenCalled();
  });

  it.each(inputKinds)('keeps captioned and non-text attachments out of AI, stickers and weather while %s waits', async kind => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const ai = availableAi(); const providers = lookupProviders();
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher }, undefined, { ...providers, ai });
    const form = await waitingForms(f); const execute = vi.spyOn(f.executor, 'execute');
    for (const attachment of ['photo', 'document', 'sticker', 'voice'] as const) {
      for (const addressed of [false, true]) {
        const update = addressed ? formReply('', form.prompts[kind], 1, 1, 9) : text('', 1, 1, 9);
        delete update.message!.text; delete update.message!.entities;
        if (attachment === 'photo') {
          update.message!.photo = [{ file_id: 'photo', file_unique_id: 'photo-unique', width: 10, height: 10, file_size: 10 }];
          update.message!.caption = 'Beijing weather PRIVATE_CAPTION';
          update.message!.media_group_id = `blocked-${kind}-${addressed}`;
        } else if (attachment === 'document') {
          update.message!.document = { file_id: 'doc', file_unique_id: 'doc-unique', file_name: 'source.txt', mime_type: 'text/plain', file_size: 10 };
          update.message!.caption = values[kind];
        } else if (attachment === 'sticker') {
          update.message!.sticker = { type: 'regular', file_id: 'sticker', file_unique_id: 'sticker-unique', width: 1, height: 1, is_animated: false, is_video: false };
        } else update.message!.voice = { file_id: 'voice', file_unique_id: 'voice-unique', duration: 1, mime_type: 'audio/ogg', file_size: 10 };
        await f.bot.handleUpdate(update);
        expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
      }
    }
    await vi.advanceTimersByTimeAsync(601);
    expect(execute).not.toHaveBeenCalled(); expect(ai.capture).not.toHaveBeenCalled(); expect(ai.available).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled(); expect(providers.weatherJson).not.toHaveBeenCalled();
    expect(f.calls.some(call => call.method === 'getFile' || call.method === 'sendPhoto' || call.method === 'sendDocument')).toBe(false);
  });

  it.each(inputKinds)('navigation or completion in %s clears only that module input', async kind => {
    const providers = lookupProviders(); const f = await fixture({}, undefined, providers);
    const form = await waitingForms(f);
    if (kind === 'weather') await f.bot.handleUpdate(text(`/weather ${values.weather}`, 1, 1, 9));
    else await f.bot.handleUpdate(f.click({ alias: 'aliashome', rss: 'rsshome', subconv: 'uhome' }[kind], form.panels[kind]));
    expect(f.adapter.sessions.get(form.key)?.[inputFields[kind]]).toBeUndefined();
    for (const other of inputKinds.filter(other => other !== kind)) {
      expect(f.adapter.sessions.get(form.key)?.[inputFields[other]]).toEqual(form.pending[inputFields[other]]);
    }
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(formReply(values[kind], form.prompts[kind], 1, 1, 9));
    expect(execute).not.toHaveBeenCalled();
  });

  it('rate navigation and settings never clear module input, and expiry only removes the older alias prompt', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const providers = lookupProviders(); const f = await fixture({}, undefined, providers);
    const alias = await aliasInput(f, 9); const aliasPrompt = f.last(1, 9);
    const key = `${me.id}:1:1:9`;
    const originalAlias = f.adapter.sessions.get(key)?.aliasInput;
    await vi.advanceTimersByTimeAsync(300_000);
    await f.bot.handleUpdate(text('/rss', 1, 1, 9)); const rss = f.last(1, 9);
    await f.bot.handleUpdate(f.click('rssadd', rss));
    await f.bot.handleUpdate(text('/weather', 1, 1, 9));
    await f.bot.handleUpdate(text('/subconv', 1, 1, 9)); const subconv = f.last(1, 9);
    await f.bot.handleUpdate(f.click('uinput:1', subconv));
    const pending = f.adapter.sessions.get(key)!;
    expect(pending.aliasInput).toEqual(originalAlias);
    expect(Object.keys(pending)).toHaveLength(4);
    await f.bot.handleUpdate(text('/rate currencies', 1, 1, 9)); const rate = f.last(1, 9);
    await f.bot.handleUpdate(f.click('page:1', rate));
    await f.bot.handleUpdate(text('/settings', 1, 1, 9));
    expect(f.adapter.sessions.get(key)).toEqual(pending);
    await vi.advanceTimersByTimeAsync(300_000);
    expectClosed(alias, 'a');
    const { aliasInput: _expired, ...remaining } = pending;
    expect(f.adapter.sessions.get(key)).toEqual(remaining);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(formReply('late_alias', aliasPrompt, 1, 1, 9));
    expect(execute).not.toHaveBeenCalled();
    expect(f.adapter.sessions.get(key)).toEqual(remaining);
  });

  it('does not send a location reply intended for RSS to the coexisting weather prompt', async () => {
    const providers = lookupProviders(); const f = await fixture({}, undefined, providers);
    const form = await waitingForms(f); const execute = vi.spyOn(f.executor, 'execute');
    const update = formReply('', form.prompts.rss, 1, 1, 9);
    delete update.message!.text;
    update.message!.location = { latitude: 39.96, longitude: 116.3 };
    await f.bot.handleUpdate(update);
    expect(execute).not.toHaveBeenCalled(); expect(providers.weatherJson).not.toHaveBeenCalled();
    expect(f.adapter.sessions.get(form.key)).toEqual(form.pending);
    const intended = { ...update, update_id: ++sequence, message: { ...update.message!, message_id: sequence,
      reply_to_message: { ...telegramMessage(form.prompts.weather), reply_to_message: undefined } } };
    await f.bot.handleUpdate(intended);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['weather.search', 'weather.query', 'weather.default.get']);
    expect(f.adapter.sessions.get(form.key)?.rssInput).toEqual(form.pending.rssInput);
    expect(f.adapter.sessions.get(form.key)?.weatherInput).toBeUndefined();
  });

  it('ignores incidental reply thread IDs when the RSS prompt and reply are not real topics', async () => {
    const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher });
    await f.bot.handleUpdate(text('/rss', 10)); const pane = f.last(10);
    await f.bot.handleUpdate(f.click('rssadd', pane, 10)); const prompt = f.last(10);
    const update = formReply('https://feeds.example.com/ordinary', prompt, 10);
    update.message!.message_thread_id = 777; update.message!.is_topic_message = false;
    update.message!.reply_to_message!.message_thread_id = 888; update.message!.reply_to_message!.is_topic_message = false;
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(update);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['rss.add', 'rss.list']);
    expect(execute.mock.calls[0]![0].chat).toEqual({ id: 10, type: 'private', threadId: undefined });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(f.rss.list({ kind: 'private', chatId: 10 }).total).toBe(1);
    expect(f.rss.list({ kind: 'private', chatId: 10, threadId: 777 }).total).toBe(0);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('does not route stale bot replies or their attachments into AI or weather when no form remains', async () => {
    const ai = availableAi(); const providers = lookupProviders();
    const f = await fixture({}, undefined, { ...providers, ai });
    const pane = await aliasInput(f, 9); const prompt = f.last(1, 9);
    await f.bot.handleUpdate(f.click('aliashome', pane));
    expect(f.adapter.sessions.size).toBe(0);
    const execute = vi.spyOn(f.executor, 'execute');
    const reply = formReply('Beijing weather', prompt, 1, 1, 9);
    await f.bot.handleUpdate(reply);
    const photo = formReply('', prompt, 1, 1, 9);
    delete photo.message!.text;
    photo.message!.caption = 'PRIVATE_STALE_CAPTION';
    photo.message!.photo = [{ file_id: 'stale-photo', file_unique_id: 'unique', width: 1, height: 1, file_size: 10 }];
    await f.bot.handleUpdate(photo);
    expect(execute).not.toHaveBeenCalled(); expect(ai.capture).not.toHaveBeenCalled(); expect(ai.available).not.toHaveBeenCalled();
    expect(providers.weatherJson).not.toHaveBeenCalled();
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it.each(['/settings', '/commands', '/listgroups', '/alias', '/rss', '/rate 100 jp rmb', '/weather 北京海淀区', '/forecast 北京海淀区'])('renders ordinary controls inside %s rich content', async command => {
    const f = await fixture({}, undefined, lookupProviders());
    if (command === '/listgroups') await f.access.authorize(-100, 'Example group', 1, 0);
    await f.bot.handleUpdate(text(command));
    const pane = f.last();
    expect(pane.rich_message).toBeDefined();
    expect(pane.reply_markup?.inline_keyboard ?? []).toEqual([]);
    const rows = pane.rich_message!.blocks.filter(block => block.type === 'buttons');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map(block => block.buttons)).toEqual(buttonRows(pane));
    for (const block of rows) {
      expect(block).not.toHaveProperty('align');
      expect(block.buttons.length).toBeGreaterThan(0);
      expect(block.buttons.length).toBeLessThanOrEqual(8);
    }
    expect(callbacks(pane).every(value => Buffer.byteLength(value) <= 64)).toBe(true);
    expect(f.calls.filter(call => call.method === 'editMessageReplyMarkup')).toHaveLength(0);
  });

  it('only converts explicit commands and leaves natural sentences for a future AI entry', async () => {
    const providers = lookupProviders();
    const f = await fixture({}, undefined, providers);
    await f.bot.handleUpdate(text('100日元是多少人民币', 10));
    await f.bot.handleUpdate(text('How much is 100 yen in yuan?', 10));
    expect(providers.rateJson).not.toHaveBeenCalled();
    await f.bot.handleUpdate(text('/rate 100 jp rmb', 10));
    expect(richText(f.last(10))).toContain('4.8 CNY');
    expect(richText(f.last(10))).toContain('ExchangeRate-API');
    expect(richText(f.last(10))).not.toContain('TEST_ONLY_KEY');
    await f.access.authorize(-100, 'Group', 1, 0);
    const before = f.calls.length;
    await f.bot.handleUpdate(text('100日元是多少人民币', 10, -100));
    expect(f.calls).toHaveLength(before);
    await f.bot.handleUpdate(text('/rate 日本 100 中国', 10, -100));
    expect(richText(f.last(-100))).toContain('4.8 CNY');
    expect(providers.rateJson).toHaveBeenCalledTimes(2);
  });
  it('resolves ambiguous currency symbols through bound buttons without accepting stale or foreign choices', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.bot.handleUpdate(text('/rate 100¥ USD', 10));
    const pane = f.last(10);
    expect(richText(pane)).toContain('choose the source currency');
    const choice = buttonData(pane, 'fchoose:0');
    await f.bot.handleUpdate(button(choice, pane, 11));
    expect(richText(pane)).toContain('choose the source currency');
    await f.bot.handleUpdate(button(choice, pane, 10));
    expect(richText(pane)).toContain('Reference rate');
    const result = richText(pane);
    await f.bot.handleUpdate(button(choice, pane, 10));
    expect(richText(pane)).toBe(result);
    await f.bot.handleUpdate(f.click('fcurrencies', pane, 10));
    expect(richText(pane)).toContain('Supported currencies');
  });
  it('keeps every currency directory row unbolded across pages', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.bot.handleUpdate(text('/rate currencies', 10));
    const pane = f.last(10);
    const total = (await f.rate.currencies(0, new AbortController().signal)).total;
    for (let page = 0; page < Math.ceil(total / 10); page++) {
      if (page) await f.bot.handleUpdate(f.click(`page:${page}`, pane, 10));
      const rich = f.calls.filter(call => call.payload.rich_message).at(-1)!.payload.rich_message as { blocks: { type: string; text?: (string | { type: string; text: string })[] }[] };
      const bold = rich.blocks.flatMap(block => block.type === 'paragraph' ? block.text ?? [] : []).filter((part): part is { type: string; text: string } => typeof part === 'object' && part.type === 'bold');
      expect(bold.map(part => part.text)).toEqual(['Currency conversion', `Supported currencies (${total})`]);
      const items = (await f.rate.currencies(page, new AbortController().signal)).items;
      expect(bold.some(part => items.some(item => part.text.startsWith(item.code + ' ')))).toBe(false);
    }
  });
  it('queries district weather without silently saving it, then persists an explicit personal default', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.bot.handleUpdate(text('/weather 北京市海淀区', 10));
    const pane = f.last(10);
    expect(richText(pane)).toContain('北京市 / 北京 / 海淀');
    expect(richText(pane)).toContain('Temperature: 8');
    expect(richText(pane)).toContain('☀️ Clear');
    expect(richText(pane)).toContain('🌡️ Temperature: 8');
    expect(richText(pane)).toContain('🥶 Feels like: 7 °C (Cold)');
    expect(richText(pane)).toContain('💧 Humidity: 50%');
    expect(richText(pane)).toContain('🌬️ Wind: 7.2');
    expect(richText(pane)).toContain('🌧️ Precipitation: 0');
    expect(callbacks(pane).some(data => data.endsWith(':winput'))).toBe(false);
    expect(f.weather.getDefault(10).location).toBeNull();
    await f.bot.handleUpdate(f.click('wsave', pane, 10));
    expect(f.weather.getDefault(10)).toMatchObject({ revision: 1, location: { name: '海淀', latitude: 39.96, longitude: 116.3 } });
    await f.bot.handleUpdate(f.click('wforecast', pane, 10));
    expect(richText(pane)).toContain('2026-11-10');
    expect(richText(pane)).toContain('☁️ Cloudy');
    expect(callbacks(pane).some(data => data.endsWith(':winput'))).toBe(false);
    await f.bot.handleUpdate(f.click('wclear', pane, 10));
    expect(f.weather.getDefault(10).location).toBeNull();
    expect(richText(pane)).toContain('Default location cleared');
  });
  it('rejects retired weather input callbacks without changing the active panel', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10));
    const pane = f.last(10);
    const before = structuredClone(pane);
    const calls = f.calls.length;
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(button(buttonData(pane, 'wforecast').replace(':wforecast', ':winput'), pane, 10));
    expect(pane).toEqual(before);
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(1);
    expect(execute).not.toHaveBeenCalled();
    expect(f.calls.slice(calls).map(call => call.method)).toEqual(['answerCallbackQuery']);
  });
  it('never loads or exposes a private weather default to a group', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.weather.setDefault(10, { revision: 0, location: { id: 'private', name: 'Private place', label: 'PRIVATE_HOME', country: 'CN', latitude: 39.96, longitude: 116.3 } }, new AbortController().signal);
    await f.access.authorize(-100, 'Group', 1, 0);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text('/weather', 10, -100));
    expect(richText(f.last(-100))).toContain('private chat');
    expect(richText(f.last(-100))).not.toContain('PRIVATE_HOME');
    expect(execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10, -100));
    expect(richText(f.last(-100))).toContain('海淀');
    expect(callbacks(f.last(-100)).some(data => /wsave|wclear/.test(data))).toBe(false);
    expect(f.weather.getDefault(10).location!.label).toBe('PRIVATE_HOME');
  });
  it('lets the original requester switch group weather even when a regular reply carries a thread ID', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10, -100));
    const pane = f.last(-100);
    const execute = vi.spyOn(f.executor, 'execute');
    const reply = { ...pane, message_thread_id: 999_123, is_topic_message: false } as Message;
    await f.bot.handleUpdate(button(buttonData(pane, 'wforecast'), reply, 10));
    expect(richText(pane)).toContain('2026-11-10');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]![1]).toBe('weather.query');
    expect(execute.mock.calls[0]![0].chat.threadId).toBeUndefined();
    expect(callbacks(pane).some(data => data.endsWith(':wcurrent'))).toBe(true);
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
  });
  it('opens another group member own weather result without editing the original panel or either default', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.access.authorize(-100, 'Group', 1, 0);
    const location = { id: 'private', name: 'Private', label: 'PRIVATE_DEFAULT', country: 'CN', latitude: 30, longitude: 100 };
    await f.weather.setDefault(10, { revision: 0, location }, new AbortController().signal);
    await f.weather.setDefault(11, { revision: 0, location: { ...location, label: 'OTHER_PRIVATE_DEFAULT' } }, new AbortController().signal);
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10, -100, 9));
    const original = f.last(-100, 9);
    const before = structuredClone(original);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('wforecast', original, 11));
    const own = f.last(-100, 9);
    expect(own.message_id).not.toBe(original.message_id);
    expect(richText(own)).toContain('2026-11-10');
    expect(richText(own)).not.toContain('PRIVATE_DEFAULT');
    expect(original).toEqual(before);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['weather.query']);
    expect(execute.mock.calls[0]![0]).toMatchObject({ actorId: 11, chat: { id: -100, threadId: 9 } });
    expect(callbacks(own).some(data => /wsave|wclear/.test(data))).toBe(false);
    expect(f.weather.getDefault(10)).toEqual({ revision: 1, location });
    expect(f.weather.getDefault(11).location!.label).toBe('OTHER_PRIVATE_DEFAULT');
    await f.bot.handleUpdate(f.click('wcurrent', own, 11));
    expect(richText(own)).toContain('Temperature: 8');
    expect(original).toEqual(before);
  });
  it('does not share private weather, cross topics/chats, or grant group default-location writes', async () => {
    const f = await fixture({}, undefined, lookupProviders());
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.access.authorize(-101, 'Other group', 1, f.access.snapshot().revision);
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10));
    const privatePane = f.last(10);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('wforecast', privatePane, 11));
    expect(execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10, -100, 9));
    const group = f.last(-100, 9); const data = buttonData(group, 'wforecast');
    execute.mockClear();
    for (const forged of [
      { ...group, chat: { id: -101, type: 'supergroup', title: 'Other' } },
      { ...group, message_thread_id: 10, is_topic_message: true },
      { ...group, message_id: group.message_id + 1 },
    ]) await f.bot.handleUpdate(button(data, forged as Message, 11));
    await f.bot.handleUpdate(button(data.replace('wforecast', 'wsave'), group, 11));
    await f.bot.handleUpdate(button(data.replace('wforecast', 'wsave'), group, 10));
    expect(execute).not.toHaveBeenCalled();
    expect(f.weather.getDefault(10).location).toBeNull();
    expect(f.weather.getDefault(11).location).toBeNull();
  });
  it('rejects shared weather access after group revocation or panel expiry', async () => {
    vi.useFakeTimers();
    const f = await fixture({}, undefined, lookupProviders());
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10, -100));
    const pane = f.last(-100); const data = buttonData(pane, 'wforecast');
    const execute = vi.spyOn(f.executor, 'execute');
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    await f.bot.handleUpdate(button(data, pane, 11));
    expect(execute).not.toHaveBeenCalled();
    await f.access.authorize(-100, 'Group', 1, f.access.snapshot().revision);
    await vi.advanceTimersByTimeAsync(600_001);
    await f.bot.handleUpdate(button(data, pane, 11));
    expect(execute).not.toHaveBeenCalled();
    expect(callbacks(pane)).toEqual(['mk:open:w:10']);
  });
  it.each([
    [null, '🌡️', 'Unavailable'], [-10, '🥶', 'Cold'], [0, '🥶', 'Cold'], [9.9, '🥶', 'Cold'],
    [10, '🧥', 'Cool'], [17.9, '🧥', 'Cool'], [18, '🙂', 'Comfortable'], [25.9, '🙂', 'Comfortable'],
    [26, '😅', 'Warm'], [31.9, '😅', 'Warm'], [32, '🥵', 'Hot'], [42, '🥵', 'Hot'],
  ] as const)('classifies feels-like %s without substituting air temperature', async (feelsLike, icon, label) => {
    const json = vi.fn<ProviderJson>(async url => url.pathname.includes('/geo/')
      ? { code: '200', location: [{ id: 'haidian', name: '海淀', adm1: '北京市', adm2: '北京', country: '中国', lat: '39.96', lon: '116.30', tz: 'Asia/Shanghai' }] }
      : { temperature: { value: 8 }, feelsLike: { value: feelsLike }, condition: { code: 100, text: 'Clear' } });
    const f = await fixture({}, undefined, { weather: { qweatherHost: 'test.qweatherapi.com', qweatherKey: 'TEST_ONLY_KEY', json } });
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10));
    expect(richText(f.last(10))).toContain(`${icon} Feels like: ${feelsLike === null ? '--' : feelsLike} °C (${label})`);
    expect(richText(f.last(10))).toContain('🌡️ Temperature: 8');
  });
  it.each([
    ['qweather', 100, '☀️'], ['qweather', 101, '☁️'], ['qweather', 150, '🌙'], ['qweather', 302, '⛈️'],
    ['qweather', 305, '🌧️'], ['qweather', 400, '🌨️'], ['qweather', 501, '🌫️'],
    ['openweather', 800, '☀️'], ['openweather', 803, '☁️'], ['openweather', 200, '⛈️'],
    ['open-meteo', 0, '☀️'], ['open-meteo', 3, '☁️'], ['open-meteo', 63, '🌧️'], ['open-meteo', 75, '🌨️'], ['open-meteo', 95, '⛈️'],
  ] as const)('renders the correct weather icon for %s code %s', async (provider, code, icon) => {
    const json = vi.fn<ProviderJson>(async url => {
      if (url.pathname.includes('/geo/')) return { code: '200', location: [] };
      if (provider === 'qweather') return { temperature: { value: 8 }, condition: { code, text: 'Condition' } };
      if (provider === 'openweather') return { main: { temp: 8 }, weather: [{ id: code, description: 'Condition' }] };
      return { current: { temperature_2m: 8, weather_code: code } };
    });
    const weather: WeatherOptions = { json, ...(provider === 'qweather' ? { qweatherHost: 'test.qweatherapi.com', qweatherKey: 'TEST_ONLY_KEY' }
      : provider === 'openweather' ? { openWeatherKey: 'TEST_ONLY_KEY' } : {}) };
    const f = await fixture({}, undefined, { weather });
    await f.bot.handleUpdate(text('/weather 39.96,116.30', 10));
    expect(richText(f.last(10))).toContain(icon);
    expect(richText(f.last(10))).toContain('🌡️ Temperature: 8');
    expect(callbacks(f.last(10)).some(data => data.endsWith(':winput'))).toBe(false);
  });
  it('accepts an explicitly shared location only in the owner/topic-bound weather input', async () => {
    const providers = lookupProviders();
    const f = await fixture({}, undefined, providers);
    const shared = (user: number, thread: number) => {
      const update = text('', user, user, thread);
      delete update.message!.text; delete update.message!.entities;
      update.message!.location = { latitude: 39.961234, longitude: 116.301234 };
      return update;
    };
    await f.bot.handleUpdate(shared(10, 9));
    expect(providers.weatherJson).not.toHaveBeenCalled();
    await f.bot.handleUpdate(text('/weather', 10, 10, 9));
    const prompt = f.last(10, 9);
    const pane = f.messages.at(-2)!;
    expect(prompt.message_id).not.toBe(pane.message_id);
    expect(prompt.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(f.adapter.sessions.get(`${me.id}:10:10:9`)?.weatherInput).toMatchObject({
      messageId: pane.message_id, promptMessageId: prompt.message_id,
    });
    await f.bot.handleUpdate(shared(11, 9));
    await f.bot.handleUpdate(shared(10, 10));
    await f.bot.handleUpdate(shared(10, 9));
    expect(providers.weatherJson).not.toHaveBeenCalled();
    const intended = shared(10, 9);
    intended.message!.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
    await f.bot.handleUpdate(intended);
    expect(richText(pane)).toContain('Temperature: 8');
    expect(f.weather.getDefault(10).location).toBeNull();
    await f.bot.handleUpdate(f.click('wsave', pane, 10));
    expect(f.weather.getDefault(10).location).toMatchObject({ latitude: 39.96, longitude: 116.3 });
  });
  it('does not let expired weather panels save a default location', async () => {
    vi.useFakeTimers();
    const f = await fixture({}, undefined, lookupProviders());
    await f.bot.handleUpdate(text('/weather 北京海淀区', 10));
    const pane = f.last(10); const save = buttonData(pane, 'wsave');
    await vi.advanceTimersByTimeAsync(600_001);
    await f.bot.handleUpdate(button(save, pane, 10));
    expect(f.weather.getDefault(10).location).toBeNull();
    expect(callbacks(pane)).toEqual(['mk:open:w:10']);
  });
  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('renders only the RSS URL field as copyable code in %s', async locale => {
    const url = 'https://feeds.example.com/rss?a=1&b=2';
    const f = await fixture({ fetcher: async () => ({ finalUrl: url, notModified: false, feed: { title: `${url} <literal>`, entries: [] } }) });
    const add = text(`/rss add ${url}`, 10);
    add.message!.from!.language_code = locale;
    await f.bot.handleUpdate(add);
    const pane = f.last(10);
    const detail = f.click('rssitem:0', pane, 10);
    detail.callback_query!.from.language_code = locale;
    await f.bot.handleUpdate(detail);
    const serialized = JSON.stringify(pane.rich_message);
    expect(serialized).toContain(JSON.stringify({ type: 'code', text: url }));
    expect(serialized.match(/"type":"code"/g)).toHaveLength(1);
    expect(serialized).not.toContain('\\u0000');
    expect(serialized).not.toContain('"type":"url"');
    expect(pane.rich_message).toMatchObject({ skip_entity_detection: true });
    expect(richText(pane)).toContain(`${url} <literal>`);
  });

  it.each(['$&', '$`', "$'", '$$'])('keeps replacement-like URL text %s literal and copyable', async value => {
    const url = `https://feeds.example.com/rss?q=${value}`;
    const f = await fixture({ fetcher: async requested => ({ finalUrl: requested, notModified: false, feed: { title: 'Feed', entries: [] } }) });
    await f.bot.handleUpdate(text(`/rss add ${url}`, 10));
    const pane = f.last(10);
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10));
    const saved = new URL(url).href;
    const serialized = JSON.stringify(pane.rich_message);
    expect(serialized).toContain(JSON.stringify({ type: 'code', text: saved }));
    expect(serialized.match(/"type":"code"/g)).toHaveLength(1);
    expect(serialized).not.toContain('\\u0000');
  });

  it('adds RSS through an owner/topic-bound input and manages silent, pause and unsubscribe settings in place', async () => {
    const fetcher = vi.fn(async () => ({ notModified: false, finalUrl: 'https://feeds.example.com/rss', feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher });
    await f.bot.handleUpdate(text('/rss', 10, 10, 9));
    const pane = f.last(10, 9);
    await f.bot.handleUpdate(f.click('rssadd', pane, 10));
    const prompt = f.last(10, 9);
    expect(prompt.message_id).not.toBe(pane.message_id);
    expect(prompt.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(richText(pane)).toContain('RSS or Atom URL');
    await f.bot.handleUpdate(text('https://feeds.example.com/rss', 11, 11, 9));
    await f.bot.handleUpdate(text('https://feeds.example.com/rss My feed', 10, 10, 9));
    await f.bot.handleUpdate(formReply('https://feeds.example.com/rss', pane, 10, 10, 9));
    expect(fetcher).not.toHaveBeenCalled();
    await f.bot.handleUpdate(formReply('https://feeds.example.com/rss My feed', prompt, 10, 10, 9));
    expect(fetcher).toHaveBeenCalledOnce();
    expect(richText(pane)).toContain('My feed');
    expect(richText(pane)).not.toMatch(/revision|expires at/i);
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10));
    const stale = f.click('rsssilent', pane, 10);
    await f.bot.handleUpdate(stale);
    expect(f.rss.list({ kind: 'private', chatId: 10, threadId: 9 }).items[0]!.silent).toBe(false);
    await f.bot.handleUpdate(stale);
    expect(f.rss.list({ kind: 'private', chatId: 10, threadId: 9 }).items[0]!.revision).toBe(1);
    await f.bot.handleUpdate(f.click('rsspause', pane, 10));
    expect(richText(pane)).toContain('Paused');
    await f.bot.handleUpdate(f.click('rssremove', pane, 10));
    expect(f.rss.list({ kind: 'private', chatId: 10, threadId: 9 }).total).toBe(0);
    expect(richText(pane)).toContain('Unsubscribed');
    expect(f.calls.filter(call => call.method === 'sendRichMessage' && call.payload.chat_id === 10)).toHaveLength(2);
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('edits and clears RSS keyword lists through dedicated native prompts in %s', async locale => {
    const fetcher = vi.fn(async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher });
    const target = { kind: 'private', chatId: 10, threadId: 9 } as const;
    const handle = async (update: Update) => {
      const actor = update.callback_query?.from ?? update.message!.from!;
      actor.language_code = locale; await f.bot.handleUpdate(update);
    };
    await handle(text('/rss add https://feeds.example.com/rss', 10, 10, 9));
    const pane = f.last(10, 9);
    await handle(f.click('rssitem:0', pane, 10));
    await handle(f.click('rssinclude', pane, 10));
    const includePrompt = f.last(10, 9);
    expect(includePrompt.message_id).not.toBe(pane.message_id);
    expect(includePrompt.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(richText(includePrompt)).toContain(translator(locale)('bot:rss.includeKeywords'));
    await handle(text('Not a filter input', 10, 10, 9));
    await handle(formReply('Wrong prompt', pane, 10, 10, 9));
    expect(f.rss.list(target).items[0]?.filters).toBeUndefined();
    await handle(formReply(' NASA \n\n宇宙\n[a-z]+', includePrompt, 10, 10, 9));
    expect(f.rss.list(target).items[0]).toMatchObject({ revision: 1, filters: { include: ['NASA', '宇宙', '[a-z]+'], exclude: [] } });
    expect(pane.rich_message).toMatchObject({ skip_entity_detection: true });
    expect(richText(pane)).toContain('[a-z]+');
    await handle(f.click('rssexclude', pane, 10));
    const excludePrompt = f.last(10, 9);
    await handle(formReply('广告\nspam', excludePrompt, 10, 10, 9));
    expect(f.rss.list(target).items[0]).toMatchObject({ revision: 2, filters: { include: ['NASA', '宇宙', '[a-z]+'], exclude: ['广告', 'spam'] } });
    await handle(formReply('Stale reply', includePrompt, 10, 10, 9));
    expect(f.rss.list(target).items[0]?.revision).toBe(2);
    await handle(f.click('rssinclude', pane, 10));
    await handle(f.click('rssclearfield', pane, 10));
    expect(f.rss.list(target).items[0]).toMatchObject({ revision: 3, filters: { include: [], exclude: ['广告', 'spam'] } });
    await handle(f.click('rssexclude', pane, 10));
    await handle(f.click('rssclearfield', pane, 10));
    expect(f.rss.list(target).items[0]).toMatchObject({ revision: 4, filters: { include: [], exclude: [] } });
    await handle(f.click('rssfilterclear', pane, 10));
    expect(f.rss.list(target).items[0]).toMatchObject({ revision: 5 });
    expect(f.rss.list(target).items[0]?.filters).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('shows the complete keyword list in its edit panel without detecting dynamic commands or markup', async () => {
    const f = await fixture({ fetcher: async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) });
    const target = { kind: 'private', chatId: 10 } as const;
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10));
    const entry = f.rss.list(target).items[0]!;
    const last = '/help <b>literal</b> @not_a_command';
    const include = [...Array.from({ length: 19 }, (_, index) => `keyword-${index}`), last];
    await f.rss.update(target, { id: entry.id, revision: 0, filters: { include, exclude: [] } });
    await f.bot.handleUpdate(text(`/rss filter ${entry.id}`, 10)); const pane = f.last(10);
    expect(richText(pane)).not.toContain(last);
    await f.bot.handleUpdate(f.click('rssinclude', pane, 10));
    for (const keyword of include) expect(richText(pane)).toContain(keyword);
    expect(pane.rich_message).toMatchObject({ skip_entity_detection: true });
    expect(JSON.stringify(pane.rich_message)).not.toContain('"type":"bot_command"');
    expect(JSON.stringify(pane.rich_message)).not.toContain('"type":"url"');
    expect(richText(f.last(10))).not.toContain(last);
  });

  it('preserves another module input while applying RSS keywords and never parses them as feed URLs', async () => {
    const fetcher = vi.fn(async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher }); const target = { kind: 'private', chatId: 10, threadId: 9 } as const;
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10, 10, 9));
    const rss = f.last(10, 9); await f.bot.handleUpdate(f.click('rssitem:0', rss, 10));
    await f.bot.handleUpdate(text('/subconv', 10, 10, 9));
    const subconv = f.last(10, 9); await f.bot.handleUpdate(f.click('uinput:0', subconv, 10));
    const subconvPrompt = f.last(10, 9); const key = `${me.id}:10:10:9`;
    const waiting = f.adapter.sessions.get(key)!.subconvInput;
    await f.bot.handleUpdate(f.click('rssinclude', rss, 10)); const prompt = f.last(10, 9);
    expect(f.adapter.sessions.get(key)?.subconvInput).toEqual(waiting);
    await f.bot.handleUpdate(formReply('wrong actor', prompt, 11, 11, 9));
    await f.bot.handleUpdate(formReply('wrong topic', prompt, 10, 10, 8));
    const picture = formReply('', prompt, 10, 10, 9);
    picture.message!.text = undefined;
    picture.message!.photo = [{ file_id: 'not-downloaded', file_unique_id: 'no-download', width: 1, height: 1, file_size: 8 }];
    await f.bot.handleUpdate(picture);
    expect(f.rss.list(target).items[0]?.filters).toBeUndefined();
    await f.bot.handleUpdate(formReply('https://example.com/literal-keyword\nspace telescope', prompt, 10, 10, 9));
    expect(f.rss.list(target).items[0]?.filters).toEqual({ include: ['https://example.com/literal-keyword', 'space telescope'], exclude: [] });
    expect(f.adapter.sessions.get(key)?.subconvInput).toEqual(waiting);
    await f.bot.handleUpdate(formReply('https://subscription.example.com/private', subconvPrompt, 10, 10, 9));
    expect(f.adapter.sessions.get(key)?.subconvInput).toBeUndefined();
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each(['x'.repeat(65), Array.from({ length: 21 }, (_, index) => `word${index}`).join('\n'), 'hidden\u0000word'])('rejects invalid RSS keyword form input without saving a partial list: %j', async value => {
    const f = await fixture({ fetcher: async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) });
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10)); const pane = f.last(10);
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10)); await f.bot.handleUpdate(f.click('rssinclude', pane, 10));
    await f.bot.handleUpdate(formReply(value, f.last(10), 10));
    expect(f.rss.list({ kind: 'private', chatId: 10 }).items[0]).toMatchObject({ revision: 0 });
    expect(f.rss.list({ kind: 'private', chatId: 10 }).items[0]?.filters).toBeUndefined();
  });

  it('uses current RSS revision and permissions for keyword changes and supports read/clear shortcuts', async () => {
    const groupAdmin = vi.fn(async () => true);
    const f = await fixture({ fetcher: async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) }, groupAdmin);
    await f.access.authorize(-100, 'Group', 1, 0);
    const target = { kind: 'group', chatId: -100, threadId: 9 } as const;
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10, -100, 9)); const pane = f.last(-100, 9);
    const subscription = f.rss.list(target).items[0]!;
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10)); await f.bot.handleUpdate(f.click('rssinclude', pane, 10));
    const stale = f.last(-100, 9);
    await f.rss.update(target, { id: subscription.id, revision: 0, filters: { include: [], exclude: ['Keep this rule'] } });
    await f.bot.handleUpdate(formReply('Must not overwrite', stale, 10, -100, 9));
    expect(f.rss.get(target, subscription.id)).toMatchObject({ revision: 1, filters: { include: [], exclude: ['Keep this rule'] } });
    await f.bot.handleUpdate(f.click('rssinclude', pane, 10)); const denied = f.last(-100, 9);
    groupAdmin.mockResolvedValue(false);
    await f.bot.handleUpdate(formReply('Forbidden rule', denied, 10, -100, 9));
    expect(f.rss.get(target, subscription.id).revision).toBe(1);
    groupAdmin.mockResolvedValue(true);
    await f.bot.handleUpdate(text(`/rss filter ${subscription.id}`, 10, -100, 9));
    expect(richText(f.last(-100, 9))).toContain('Keep this rule');
    await f.bot.handleUpdate(text(`/rss filter ${subscription.id} clear`, 10, -100, 9));
    expect(f.rss.get(target, subscription.id).filters).toBeUndefined();
    expect(f.rss.get(target, subscription.id).revision).toBe(2);
  });

  it('does not replay an expired RSS keyword input when its panel is reopened', async () => {
    vi.useFakeTimers();
    const f = await fixture({ fetcher: async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) });
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10)); const pane = f.last(10);
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10)); await f.bot.handleUpdate(f.click('rssinclude', pane, 10));
    const prompt = f.last(10);
    await vi.advanceTimersByTimeAsync(600_001);
    await f.bot.handleUpdate(formReply('Expired keyword', prompt, 10));
    expect(f.rss.list({ kind: 'private', chatId: 10 }).items[0]?.filters).toBeUndefined();
    await f.bot.handleUpdate(button('mk:open:r:10', pane, 10));
    expect(f.rss.list({ kind: 'private', chatId: 10 }).items[0]?.revision).toBe(0);
  });

  it('rechecks RSS group administrator rights before accepting form input', async () => {
    const fetcher = vi.fn(async () => ({ notModified: false, finalUrl: 'https://feeds.example.com/rss', feed: { title: 'Feed', entries: [] } }));
    const groupAdmin = vi.fn(async () => true);
    const f = await fixture({ fetcher }, groupAdmin);
    await f.access.authorize(-100, 'Group', 1, 0);
    await f.bot.handleUpdate(text('/rss', 10, -100, 9));
    const pane = f.last(-100, 9);
    await f.bot.handleUpdate(f.click('rssadd', pane, 10));
    const prompt = f.last(-100, 9);
    expect(prompt.reply_markup).toMatchObject({ force_reply: true, selective: true });
    expect(prompt.rich_message?.blocks[0]).toMatchObject({ type: 'paragraph', text: { type: 'text_mention', user: { id: 10 } } });
    groupAdmin.mockResolvedValue(false);
    await f.bot.handleUpdate(formReply('https://feeds.example.com/rss', prompt, 10, -100, 9));
    expect(fetcher).not.toHaveBeenCalled();
    expect(f.rss.snapshot().subscriptions).toEqual([]);
    expectClosed(pane, 'r', 10);
    expect(richText(f.last(-100, 9))).toMatch(/permission/i);
  });

  it('does not let RSS controls cross users, topics or subscription revisions', async () => {
    const f = await fixture({ fetcher: async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }) });
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss', 10, 10, 9));
    const pane = f.last(10, 9);
    await f.bot.handleUpdate(f.click('rssitem:0', pane, 10));
    const data = buttonData(pane, 'rssremove');
    const original = structuredClone(pane.rich_message);
    await f.bot.handleUpdate(button(data, pane, 11));
    await f.bot.handleUpdate(button(data, { ...pane, message_thread_id: 10, is_topic_message: true } as Message, 10));
    expect(pane.rich_message).toEqual(original);
    const scope = { kind: 'private', chatId: 10, threadId: 9 } as const;
    const subscription = f.rss.list(scope).items[0]!;
    await f.rss.update(scope, { id: subscription.id, revision: subscription.revision, title: 'Changed elsewhere' });
    await f.bot.handleUpdate(button(data, pane, 10));
    expect(f.rss.list(scope).total).toBe(1);
    expect(richText(pane)).toContain('Changed elsewhere');
  });

  it('expires RSS input safely and leaves only a fresh read-only reopen button', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async url => ({ finalUrl: url, notModified: false, feed: { title: 'Feed', entries: [] } }));
    const f = await fixture({ fetcher });
    await f.bot.handleUpdate(text('/rss', 10));
    const pane = f.last(10);
    await f.bot.handleUpdate(f.click('rssadd', pane, 10));
    const prompt = f.last(10);
    await vi.advanceTimersByTimeAsync(600_001);
    expectClosed(pane, 'r', 10);
    await f.bot.handleUpdate(text('https://feeds.example.com/rss', 10));
    await f.bot.handleUpdate(formReply('https://feeds.example.com/rss', prompt, 10));
    expect(fetcher).not.toHaveBeenCalled();
    await f.bot.handleUpdate(button('mk:open:r:10', pane, 10));
    expect(richText(f.last(10))).toContain('RSS subscriptions (0)');
    expect(f.rss.snapshot().subscriptions).toEqual([]);
  });

  it('classifies browser-protected feeds without storing them or reflecting private URL parameters', async () => {
    const f = await fixture({ fetcher: async () => { throw new FeedFetchError('BLOCKED', 403); } });
    await f.bot.handleUpdate(text('/rss add https://feeds.example.com/rss?token=PRIVATE_SECRET', 10));
    expect(richText(f.last(10))).toContain('browser verification');
    expect(richText(f.last(10))).not.toContain('PRIVATE_SECRET');
    expect(f.rss.snapshot().sources).toEqual([]);
    expect(f.rss.snapshot().subscriptions).toEqual([]);
  });

  it('uses current persisted aliases for suggestions without executing the suggested command', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/alias add help manual'));
    const before = f.aliases.snapshot();
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text('/manula', 10));
    expect(richText(f.last(10))).toBe('Unknown command. Did you mean /help?');
    expect(f.aliases.snapshot()).toEqual(before);
    expect(execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(text('/alias remove help manual'));
    execute.mockClear();
    await f.bot.handleUpdate(text('/manula', 10));
    expect(richText(f.last(10))).toBe('Unknown command. Use /help to see the available commands.');
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ['zh-Hant', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant-CN', 'zh-TW'],
    ['zh-Hans-HK', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['ja-JP', 'ja'], ['en-US', 'en'],
  ] as const)('resolves auto Telegram hint %s to %s in the actual settings panel', async (hint, expected) => {
    const f = await fixture();
    const update = text('/settings', 10);
    update.message!.from!.language_code = hint;
    await f.bot.handleUpdate(update);
    expect(f.configuration.getPreference(10, hint)).toMatchObject({ language: 'auto', resolvedLanguage: expected });
    expect(f.last(10).rich_message).toBeDefined();
    expect(richText(f.last(10))).not.toContain('bot:');
    expect(callbacks(f.last(10)).filter(data => data.includes(':lang:'))).toHaveLength(5);
  });

  it.each(['zh-TW', 'ja'] as const)('persists %s and publishes that explicit preference in all four menu slots', async language => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/settings', 10));
    const pane = f.last(10);
    await f.bot.handleUpdate(f.click(`lang:${language}`, pane, 10));
    expect(f.configuration.getPreference(10, 'en').language).toBe(language);
    const menus = f.calls.filter(call => call.method === 'setMyCommands');
    expect(menus.map(call => call.payload.language_code ?? '').sort()).toEqual(['', 'en', 'ja', 'zh']);
    expect(menus.every(call => JSON.stringify(call.payload.commands) === JSON.stringify(menuCommands(language, false, true)))).toBe(true);
    const restored = new ConfigurationService(f.storage);
    await restored.initialize();
    expect(restored.getPreference(10, 'en')).toMatchObject({ language, resolvedLanguage: language });
  });

  it.each(['/alias', '/别名', '/別名', '/エイリアス'])('opens %s without incoming entities and renders individually clickable alias commands', async command => {
    const f = await fixture();
    const execute = vi.spyOn(f.executor, 'execute');
    const update = text(command);
    delete update.message!.entities;
    await f.bot.handleUpdate(update);
    const pane = f.last();
    expect(richText(pane)).toContain('Command aliases');
    expect(richText(pane)).toContain('/help');
    expect(pane.rich_message).toBeDefined();
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(JSON.stringify(pane.rich_message)).not.toContain('"type":"date_time"');
    expectNativeCommands(f.sent()[0]!.payload.rich_message,
      ['/help', '/帮助', '/幫助', '/ヘルプ', '/alias', '/别名', '/別名', '/エイリアス']);
    expect(buttonData(pane, 'aliasadd')).toMatch(/^mk:ui:a:[a-f0-9]{24}:0:aliasadd$/);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['alias.list']);
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('executes explicit alias add/remove through shared Actions and makes the mapping immediately dispatchable', async () => {
    const f = await fixture();
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text('/alias add help 新别名'));
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 1, source: 'telegram' }), 'alias.add',
      { command: 'help', alias: '新别名', revision: 0 });
    expect(f.aliases.resolve('新别名')).toBe('help');
    expectNativeCommands(f.sent().at(-1)!.payload.rich_message,
      ['/help', '/帮助', '/幫助', '/ヘルプ', '/新别名', '/alias', '/别名', '/別名', '/エイリアス', '/新别名', '/help']);
    const alias = text('/新别名@offline_bot trailing argument', 10);
    delete alias.message!.entities;
    await f.bot.handleUpdate(alias);
    expect(f.sent().at(-1)!).toMatchObject({ method: 'sendRichMessage', payload: { chat_id: 10, rich_message: { markdown: expect.stringContaining('**Misaka**') } } });
    await f.bot.handleUpdate(text('/commands', 10));
    expect(richText(f.last(10))).toContain('/新别名');
    expectNativeCommands(f.sent().at(-1)!.payload.rich_message,
      ['/start', '/help', '/帮助', '/幫助', '/ヘルプ', '/新别名', '/id', '/modules', '/commands', '/cancel', '/help']);
    await f.bot.handleUpdate(text('/alias remove help 新别名'));
    expect(execute).toHaveBeenCalledWith(expect.anything(), 'alias.remove', { command: 'help', alias: '新别名', revision: 1 });
    expect(f.aliases.resolve('新别名')).toBeUndefined();
    expect(f.aliases.snapshot().revision).toBe(2);
    expectNativeCommands(f.sent().at(-1)!.payload.rich_message,
      ['/help', '/帮助', '/幫助', '/ヘルプ', '/alias', '/别名', '/別名', '/エイリアス', '/新别名', '/help']);
    await f.bot.handleUpdate(text('/新别名', 10));
    expect(f.sent().at(-1)!.payload.text).toContain('Unknown command');
  });

  it('does not let ordinary users or group chats manage aliases even through the default Unicode names', async () => {
    const f = await fixture();
    await f.access.authorize(-200, 'Group', 1, 0);
    const execute = vi.spyOn(f.executor, 'execute');
    for (const command of ['/alias', '/別名', '/エイリアス add help hidden']) {
      await f.bot.handleUpdate(text(command, 10));
      await f.bot.handleUpdate(text(command, 1, -200));
    }
    expect(execute).not.toHaveBeenCalled();
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.adapter.panels.size).toBe(0);
  });

  it('inherits real target authorization, including the current-group-only admission exception', async () => {
    const f = await fixture();
    await f.aliases.add('stats', '状态', 0);
    await f.aliases.add('addgroup', '授权', 1);
    await f.bot.handleUpdate(text('/状态', 10));
    await f.bot.handleUpdate(text('/授权 -200', 10));
    await f.bot.handleUpdate(text('/授权', 10, -200));
    await f.bot.handleUpdate(text('/授权 -201', 1, -200));
    expect(f.access.count()).toBe(0);
    expect(f.calls.some(call => call.method === 'getChat')).toBe(false);
    await f.bot.handleUpdate(text('/授权@offline_bot', 1, -200, 9));
    expect(f.access.isAllowed(-200)).toBe(true);
    expect(f.access.isAllowed(-201)).toBe(false);
    expect(f.calls.filter(call => call.method === 'getChat').map(call => call.payload.chat_id)).toEqual([-200]);
  });

  it('shows registered native modules without claiming unrelated modules migrated', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/modules', 10));
    expect(richText(f.last(10))).toContain('Command aliases');
    expect(richText(f.last(10))).toContain('RSS subscriptions');
    expect(richText(f.last(10))).not.toMatch(/no modules|not implemented/i);
    expect(richText(f.last(10))).toContain('Currency conversion');
    expect(richText(f.last(10))).toContain('Weather');
    expect(richText(f.last(10))).toContain('Sticker conversion');
    expect(richText(f.last(10))).toContain(translator('en')('web:subconv.name'));
    expect(richText(f.last(10))).not.toMatch(/hug|reminder|echo/i);
    expect(menuCommands('en', true, true).map(command => command.command)).toEqual(commands.map(command => command.name));
    await f.bot.handleUpdate(text('/help', 10));
    expect(richText(f.last(10))).toContain('/sticker');
    expect(richText(f.last(10))).toContain('/subconv');
    expect(richText(f.last(10))).toContain(`Installed native modules: ${modules.length}`);
    expect(richText(f.last(10))).toContain('/sticker and /subconv remain private-chat only without an administrator role');
  });

  it('binds alias text entry to its owner/topic and gives recognized commands priority without fabricating updates', async () => {
    const f = await fixture();
    const pane = await aliasInput(f, 9);
    const prompt = f.last(1, 9);
    expectNativeCommands(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.rich_message, ['/help', '/cancel']);
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    const key = `${me.id}:1:1:9`;
    expect(f.adapter.sessions.get(key)?.aliasInput).toMatchObject({ messageId: pane.message_id, promptMessageId: prompt.message_id, command: 'help', revision: 0 });
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(text('foreign_user', 2, 1, 9));
    await f.bot.handleUpdate(text('foreign_topic', 1, 1, 10));
    await f.bot.handleUpdate(text('bare_input', 1, 1, 9));
    await f.bot.handleUpdate(text('/help', 1, 1, 9));
    await f.bot.handleUpdate(text('/幫助', 1, 1, 9));
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.adapter.sessions.get(key)?.aliasInput).toBeDefined();
    const input = formReply('新輸入', prompt, 1, 1, 9);
    const before = structuredClone(input);
    await f.bot.handleUpdate(input);
    expect(input).toEqual(before);
    expect(f.aliases.resolve('新輸入')).toBe('help');
    expect(execute.mock.calls.filter(call => call[1] === 'alias.add')).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ actorId: 1, chat: { id: 1, type: 'private', threadId: 9 },
      invocationId: `telegram:${me.id}:${input.update_id}` }), 'alias.add', { command: 'help', alias: '新輸入', revision: 0 });
    expect(f.adapter.sessions.get(key)).toBeUndefined();
    expect(richText(pane)).toContain('/新輸入');
    expectNativeCommands(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.rich_message,
      ['/help', '/帮助', '/幫助', '/ヘルプ', '/新輸入', '/alias', '/别名', '/別名', '/エイリアス', '/新輸入', '/help']);
  });

  it('clears alias entry on cancel and reopening only creates a fresh readonly manager', async () => {
    const f = await fixture();
    const pane = await aliasInput(f);
    await f.bot.handleUpdate(text('/cancel'));
    expect(f.adapter.sessions.size).toBe(0);
    expectClosed(pane, 'a');
    await f.bot.handleUpdate(text('not_an_alias'));
    expect(f.aliases.snapshot().revision).toBe(0);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(button('mk:open:a:1', pane));
    expect(f.last().message_id).not.toBe(pane.message_id);
    expect(buttonData(f.last(), 'aliasadd')).toMatch(/^mk:ui:a:[a-f0-9]{24}:0:aliasadd$/);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['alias.list']);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('ignores replies to a different message while retaining the panel-bound alias input', async () => {
    const f = await fixture();
    const pane = await aliasInput(f);
    const prompt = f.last();
    await f.bot.handleUpdate(text('/help'));
    const unrelated = text('wrong_reply');
    unrelated.message!.reply_to_message = { ...telegramMessage(f.last()), reply_to_message: undefined };
    await f.bot.handleUpdate(unrelated);
    expect(f.aliases.resolve('wrong_reply')).toBeUndefined();
    await f.bot.handleUpdate(formReply('panel_reply', pane));
    expect(f.aliases.resolve('panel_reply')).toBeUndefined();
    expect(f.adapter.sessions.get(`${me.id}:1:1:0`)?.aliasInput?.messageId).toBe(pane.message_id);
    const intended = text('right_reply');
    intended.message!.reply_to_message = { ...telegramMessage(prompt), reply_to_message: undefined };
    await f.bot.handleUpdate(intended);
    expect(f.aliases.resolve('right_reply')).toBe('help');
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('expires waiting alias input at the panel deadline and never applies the late text', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = await fixture();
    const pane = await aliasInput(f);
    const prompt = f.last();
    const execute = vi.spyOn(f.executor, 'execute');
    await vi.advanceTimersByTimeAsync(600_000);
    expect(f.adapter.sessions.size).toBe(0);
    expectClosed(pane, 'a');
    expect(f.adapter.panels.size).toBe(0);
    await f.bot.handleUpdate(text('too_late'));
    await f.bot.handleUpdate(formReply('too_late', prompt));
    expect(f.aliases.resolve('too_late')).toBeUndefined();
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(['main', 'add', 'remove'] as const)('keeps the alias %s view time-limited without displaying its deadline', async view => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = await fixture();
    await f.bot.handleUpdate(text('/alias'));
    const pane = f.last();
    const panel = f.adapter.panels.get(buttonData(pane, 'aliasadd').split(':')[3]!, {
      key: `${me.id}:1:1:0`, botId: me.id, chatId: 1, userId: 1, language: 'en', messageId: pane.message_id,
    });
    expect(panel.expiresAt).toBe(Date.now() + 600_000);
    await vi.advanceTimersByTimeAsync(590_000);
    if (view !== 'main') await f.bot.handleUpdate(f.click(`alias${view}`, pane));
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(JSON.stringify(pane.rich_message)).not.toContain('"type":"date_time"');
    const stale = button(callbacks(pane)[0]!, pane);
    const execute = vi.spyOn(f.executor, 'execute');
    await vi.advanceTimersByTimeAsync(10_000);
    expectClosed(pane, 'a');
    await f.bot.handleUpdate(stale);
    expectClosed(pane, 'a');
    expect(execute).not.toHaveBeenCalled();
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(f.adapter.panels.size).toBe(0);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('rejects invalid waiting input and role loss without turning either into an alias mutation', async () => {
    const f = await fixture();
    for (const value of ['two aliases', '<b>help</b>', 'https://evil.test']) {
      await aliasInput(f);
      await f.bot.handleUpdate(formReply(value, f.last()));
    }
    expect(f.aliases.snapshot().revision).toBe(0);
    await aliasInput(f);
    const prompt = f.last();
    expect(f.adapter.sessions.get(`${me.id}:1:1:0`)?.aliasInput).toBeDefined();
    const execute = vi.spyOn(f.executor, 'execute');
    vi.spyOn(f.access, 'isAdmin').mockReturnValue(false);
    await f.bot.handleUpdate(formReply('no_longer_admin', prompt));
    expect(f.aliases.resolve('no_longer_admin')).toBeUndefined();
    expect(f.aliases.snapshot().revision).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('paginates server-cached alias targets and rejects hidden target indices before entering input', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/alias'));
    const pane = f.last();
    await f.bot.handleUpdate(f.click('aliasadd', pane));
    const first = callbacks(pane).find(data => data.includes(':aliastarget:'))!;
    expect(first).toBeDefined();
    const before = structuredClone(pane.rich_message);
    await f.bot.handleUpdate(button(first.replace(/aliastarget:\d+$/, 'aliastarget:999999'), pane));
    expect(f.adapter.sessions.size).toBe(0);
    expect(pane.rich_message).toEqual(before);
    await f.bot.handleUpdate(f.click('page:1', pane));
    const target = buttonRows(pane).flat().find(button => richText(button.text).includes('/alias') && 'callback_data' in button);
    if (!target || !('callback_data' in target)) throw new Error('Missing final-page /alias target');
    await f.bot.handleUpdate(button(target.callback_data, pane));
    expect(f.adapter.sessions.get(`${me.id}:1:1:0`)?.aliasInput?.command).toBe('alias');
    expect(f.sent()).toHaveLength(2);
    expect(f.sent().at(-1)).toMatchObject({ method: 'sendRichMessage', payload: { reply_markup: { force_reply: true } } });
    expect(callbacks(pane).every(data => Buffer.byteLength(data) <= 64)).toBe(true);
  });

  it('refreshes stale alias input after a concurrent mapping revision without silently retrying mutation', async () => {
    const f = await fixture();
    const pane = await aliasInput(f);
    const prompt = f.last();
    const http = createInvocation({ actorId: 1, botId: me.id, source: 'http', chat: { id: 1, type: 'private' }, language: 'en' });
    expect(await f.executor.execute(http, 'alias.add', { command: 'help', alias: 'concurrent', revision: 0 })).toMatchObject({ status: 'succeeded' });
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(formReply('stale_input', prompt));
    expect(f.aliases.resolve('stale_input')).toBeUndefined();
    expect(f.aliases.snapshot().revision).toBe(1);
    expect(execute.mock.calls.filter(call => call[1] === 'alias.add').map(call => call[2]))
      .toEqual([{ command: 'help', alias: 'stale_input', revision: 0 }]);
    await expect(execute.mock.results[0]!.value).resolves.toMatchObject({ error: { code: 'CONFLICT' } });
    expect(richText(pane)).toMatch(/changed|reload/i);
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(f.adapter.sessions.size).toBe(0);
    await f.bot.handleUpdate(text('stale_input'));
    expect(f.aliases.snapshot().revision).toBe(1);
    expect(execute.mock.calls.filter(call => call[1] === 'alias.add')).toHaveLength(1);
    await f.bot.handleUpdate(f.click('aliasadd', pane));
    const help = buttonRows(pane).flat().find(button => richText(button.text).startsWith('/help ') && 'callback_data' in button);
    if (!help || !('callback_data' in help)) throw new Error('Missing refreshed /help alias target');
    await f.bot.handleUpdate(button(help.callback_data, pane));
    expect(f.adapter.sessions.get(`${me.id}:1:1:0`)?.aliasInput?.revision).toBe(1);
    await f.bot.handleUpdate(formReply('fresh_input', f.last()));
    expect(f.aliases.resolve('fresh_input')).toBe('help');
    expect(f.aliases.snapshot().revision).toBe(2);
    expect(execute.mock.calls.filter(call => call[1] === 'alias.add').map(call => call[2]))
      .toEqual([{ command: 'help', alias: 'stale_input', revision: 0 }, { command: 'help', alias: 'fresh_input', revision: 1 }]);
  });

  it('removes only a server-cached alias after its explicit selection and rejects forged indices/replays', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/alias'));
    const pane = f.last();
    await f.bot.handleUpdate(f.click('aliasremove', pane));
    const remove = buttonRows(pane).flat().find(button => richText(button.text).includes('/帮助') && 'callback_data' in button);
    if (!remove || !('callback_data' in remove)) throw new Error('Missing cached alias removal entry');
    expect(f.aliases.resolve('帮助')).toBe('help');
    await f.bot.handleUpdate(button(remove.callback_data.replace(/aliasdelete:\d+$/, 'aliasdelete:999999'), pane));
    expect(f.aliases.snapshot().revision).toBe(0);
    const click = button(remove.callback_data, pane);
    await f.bot.handleUpdate(click);
    expect(f.aliases.resolve('帮助')).toBeUndefined();
    expect(f.aliases.resolve('幫助')).toBe('help');
    expect(f.aliases.snapshot().revision).toBe(1);
    await f.bot.handleUpdate({ ...click, update_id: ++sequence });
    expect(f.aliases.snapshot().revision).toBe(1);
  });

  it('does not remove a cached alias after a concurrent revision until the user makes a fresh selection', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/alias'));
    const pane = f.last();
    await f.bot.handleUpdate(f.click('aliasremove', pane));
    const remove = buttonRows(pane).flat().find(button => richText(button.text).includes('/帮助') && 'callback_data' in button);
    if (!remove || !('callback_data' in remove)) throw new Error('Missing cached alias removal entry');
    const stale = button(remove.callback_data, pane);
    await f.aliases.add('help', 'new_mapping', 0);
    await f.bot.handleUpdate(stale);
    expect(f.aliases.resolve('帮助')).toBe('help');
    expect(f.aliases.snapshot().revision).toBe(1);
    expect(richText(pane)).toMatch(/changed|reload/i);
    await f.bot.handleUpdate({ ...stale, update_id: ++sequence });
    expect(f.aliases.snapshot().revision).toBe(1);
  });

  it.each(['used', 'expired'] as const)('reopens a %s approval into the current groups list without preparing or confirming old parameters', async state => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const approval = f.approvalFor(1);
    if (state === 'expired') f.expire();
    await f.bot.handleUpdate(f.click('confirm', approval));
    expect(f.access.isAllowed(-200)).toBe(state === 'used');
    expectClosed(approval, 'g');
    const revision = f.access.snapshot().revision;
    const execute = vi.spyOn(f.executor, 'execute');
    const confirm = vi.spyOn(f.executor, 'confirm');
    const prepare = vi.spyOn(f.executor, 'prepare');
    await f.bot.handleUpdate(button('mk:open:g:1', approval));
    const fresh = f.last();
    expect(fresh.message_id).not.toBe(approval.message_id);
    if (state === 'used') expect(buttonData(fresh, 'revoke:-200')).toMatch(/^mk:ui:g:[a-f0-9]{24}:0:revoke:-200$/);
    else expect(callbacks(fresh).some(data => data.includes(':revoke:'))).toBe(false);
    expect(callbacks(fresh).some(data => data.endsWith(':confirm'))).toBe(false);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['groups.list']);
    expect(confirm).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.access.snapshot().revision).toBe(revision);
  });

  it('shares actual language and settings mutations with HTTP-context Actions', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/settings', 10));
    const personal = f.last(10);
    await f.bot.handleUpdate(f.click('lang:en', personal, 10));
    expect(f.configuration.getPreference(10).language).toBe('en');
    const http = createInvocation({ actorId: 1, botId: me.id, source: 'http', chat: { id: 1, type: 'private' }, language: 'en' });
    expect(await f.executor.execute(http, 'core.settings.update', { revision: 0, settings: { defaultLanguage: 'en' } })).toMatchObject({ status: 'succeeded' });
    await f.bot.handleUpdate(text('/settings'));
    const settings = f.last();
    expect(richText(settings)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(f.configuration.settings().revision).toBe(1);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(f.click('corelang:zh-CN', settings));
    expect(f.configuration.settings().effective.defaultLanguage).toBe('zh-CN');
    expect(f.configuration.settings().revision).toBe(2);
    expect(f.calls.filter(call => call.method === 'setMyCommands')).toHaveLength(4);
    expect(f.sent().filter(call => call.payload.chat_id === 1)).toHaveLength(1);
    expect(f.sent().filter(call => call.payload.chat_id === 10)).toHaveLength(1);
    expect(richText(settings)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(execute.mock.calls.filter(call => call[1] === 'core.settings.update').map(call => call[2]))
      .toEqual([{ revision: 1, settings: { defaultLanguage: 'zh-CN' } }]);
    expect(f.adapter.sessions.size).toBe(0);
  });

  it('returns stale-revision conflict after another entry changes settings', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/settings'));
    const pane = f.last();
    const stale = f.click('corelang:zh-CN', pane);
    await f.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(stale);
    expect(f.configuration.settings().effective.defaultLanguage).toBe('en');
    expect(f.configuration.settings().revision).toBe(1);
    expect(richText(pane)).toContain('changed elsewhere');
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(execute.mock.calls.filter(call => call[1] === 'core.settings.update').map(call => call[2]))
      .toEqual([{ revision: 0, settings: { defaultLanguage: 'zh-CN' } }]);
    await expect(execute.mock.results[0]!.value).resolves.toMatchObject({ error: { code: 'CONFLICT' } });
    expect(f.sent()).toHaveLength(1);
    const refreshed = structuredClone(pane.rich_message);
    await f.bot.handleUpdate({ ...stale, update_id: ++sequence });
    expect(f.configuration.settings().revision).toBe(1);
    expect(pane.rich_message).toEqual(refreshed);
    expect(execute.mock.calls.filter(call => call[1] === 'core.settings.update')).toHaveLength(1);
    await f.bot.handleUpdate(f.click('corelang:zh-CN', pane));
    expect(f.configuration.settings().effective.defaultLanguage).toBe('zh-CN');
    expect(f.configuration.settings().revision).toBe(2);
    expect(richText(pane)).not.toMatch(/revision|Panel expires at|\{\{/i);
    expect(execute.mock.calls.filter(call => call[1] === 'core.settings.update').map(call => call[2]))
      .toEqual([{ revision: 0, settings: { defaultLanguage: 'zh-CN' } }, { revision: 1, settings: { defaultLanguage: 'zh-CN' } }]);
  });

  it('rejects replayed rendered settings selections after success instead of applying them to a new revision', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/settings'));
    const pane = f.last();
    const oldEnglish = f.click('corelang:en', pane);
    const oldChinese = f.click('corelang:zh-CN', pane);
    await f.bot.handleUpdate(oldEnglish);
    expect(f.configuration.settings().revision).toBe(1);
    await f.bot.handleUpdate(oldChinese);
    expect(f.configuration.settings().effective.defaultLanguage).toBe('en');
    expect(f.configuration.settings().revision).toBe(1);
    await f.bot.handleUpdate(f.click('corelang:zh-CN', pane));
    expect(f.configuration.settings().revision).toBe(2);
    expect(f.sent()).toHaveLength(1);
  });

  it('clamps a stale out-of-range group page and refetches cached service data without Telegram lookups', async () => {
    const f = await fixture();
    for (let id = -210; id <= -200; id++) await f.access.authorize(id, `Cached ${id}`, 1, f.access.snapshot().revision);
    await f.bot.handleUpdate(text('/listgroups'));
    const pane = f.last();
    const next = f.click('page:1', pane);
    await f.access.revoke(-200, 1, f.access.snapshot().revision);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(next);
    expect(execute.mock.calls.filter(call => call[1] === 'groups.list').map(call => call[2])).toEqual([{ page: 1 }, { page: 0 }]);
    expect(richText(pane)).toContain('1/1');
    expect(callbacks(pane).filter(data => data.includes(':revoke:'))).toHaveLength(10);
    expect(callbacks(pane).some(data => data.includes(':page:'))).toBe(false);
    expect(f.sent()).toHaveLength(1);
    expect(f.calls.some(call => call.method === 'getChat' || call.method === 'getChatMember')).toBe(false);
  });

  it('does not hide a groups.list failure during stale-page refetch or replace the panel with empty data', async () => {
    const f = await fixture();
    for (let id = -210; id <= -200; id++) await f.access.authorize(id, `Cached ${id}`, 1, f.access.snapshot().revision);
    await f.bot.handleUpdate(text('/listgroups'));
    const pane = f.last();
    const originalText = richText(pane);
    const next = f.click('page:1', pane);
    await f.access.revoke(-200, 1, f.access.snapshot().revision);
    const original = f.executor.execute.bind(f.executor);
    vi.spyOn(f.executor, 'execute').mockImplementation(async (context, action, input) => {
      if (action === 'groups.list' && (input as { page: number }).page === 0) {
        return { status: 'failed', invocationId: context.invocationId, error: { code: 'UNAVAILABLE' } };
      }
      return original(context, action, input);
    });
    await f.bot.handleUpdate(next);
    expect(f.sent().at(-1)!.payload.text).toContain('temporarily unavailable');
    expect(richText(pane)).toBe(originalText);
    expect(f.calls.some(call => call.method === 'getChat')).toBe(false);
  });

  it('uses only cached group IDs and target revisions, and requires a fresh click after a target conflict refresh', async () => {
    const f = await fixture();
    await f.access.authorize(-200, 'Target', 1, 0);
    await f.bot.handleUpdate(text('/listgroups'));
    const pane = f.last();
    const stale = f.click('revoke:-200', pane);
    const forged = button(buttonData(pane, 'revoke:-200').replace(/revoke:-200$/, 'revoke:-999'), pane);
    await f.bot.handleUpdate(forged);
    expect(f.adapter.panels.size).toBe(1);
    await f.access.revoke(-200, 1, f.access.snapshot().revision);
    await f.access.authorize(-200, 'Target', 1, f.access.snapshot().revision);
    await f.bot.handleUpdate(stale);
    expect(f.access.isAllowed(-200)).toBe(true);
    expect(f.adapter.panels.size).toBe(1);
    expect(richText(pane)).toContain('changed elsewhere');
    const refreshed = structuredClone(pane.rich_message);
    await f.bot.handleUpdate({ ...stale, update_id: ++sequence });
    expect(f.adapter.panels.size).toBe(1);
    expect(pane.rich_message).toEqual(refreshed);
    await f.bot.handleUpdate(f.click('revoke:-200', pane));
    expect(richText(f.approvalFor(1))).toContain('Revoke group -200');
    expect(f.adapter.panels.size).toBe(2);
    expect(f.access.isAllowed(-200)).toBe(true);
  });

  it('cancel clears ordinary panels and form state but leaves recipient-bound approval executable', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const approval = f.approvalFor(1);
    const confirm = f.click('confirm', approval);
    await f.bot.handleUpdate(text('/settings'));
    const settings = f.last();
    await f.bot.handleUpdate(text('/commands'));
    const commands = f.last();
    f.adapter.sessions.set(`${me.id}:1:1:0`, { rssInput: { panelId: 'input', messageId: 1 } });
    await f.bot.handleUpdate(text('/cancel'));
    expect(liveCallbacks(settings)).toEqual([]);
    expect(liveCallbacks(commands)).toEqual([]);
    expect(callbacks(settings)).toEqual(['mk:open:s:1']);
    expect(callbacks(commands)).toEqual(['mk:open:c:1']);
    expect(callbacks(approval)).toHaveLength(1);
    expect(f.adapter.sessions.size).toBe(0);
    await f.bot.handleUpdate(confirm);
    expect(f.access.isAllowed(-200)).toBe(true);
    expect(liveCallbacks(approval)).toEqual([]);
    expect(callbacks(approval)).toEqual(['mk:open:g:1']);
  });

  it('blocks a real approval when the configured role is lost before clicking, even within UI TTL', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const approval = f.approvalFor(1);
    const confirm = f.click('confirm', approval);
    vi.spyOn(f.access, 'isAdmin').mockReturnValue(false);
    const execute = vi.spyOn(f.executor, 'confirm');
    await f.bot.handleUpdate(confirm);
    expect(execute).not.toHaveBeenCalled();
    expect(f.access.isAllowed(-200)).toBe(false);
  });

  it('rechecks real approval permission after the disabling UI edit was in flight', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const approval = f.approvalFor(1);
    const started = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    cleanup.unshift(async () => { gate.resolve(); });
    f.delay(async call => {
      if (call.method === 'editMessageText' && call.payload.message_id === approval.message_id) {
        started.resolve();
        await gate.promise;
      }
    });
    const running = f.bot.handleUpdate(f.click('confirm', approval));
    await started.promise;
    vi.spyOn(f.access, 'isAdmin').mockReturnValue(false);
    gate.resolve();
    await running;
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(liveCallbacks(approval)).toEqual([]);
    expect(richText(approval)).not.toContain('is authorized');
    expect(f.calls.some(call => call.method === 'getChat')).toBe(false);
  });

  it('serializes concurrent approval clicks and commits only once', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const approval = f.approvalFor(1);
    const data = buttonData(approval, 'confirm');
    const before = f.access.snapshot().revision;
    const confirm = vi.spyOn(f.executor, 'confirm');
    await Promise.all([
      f.bot.handleUpdate(button(data, approval)),
      f.bot.handleUpdate(button(data, approval)),
    ]);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(f.access.snapshot().revision).toBe(before + 1);
    expect(f.access.isAllowed(-200)).toBe(true);
    expect(liveCallbacks(approval)).toEqual([]);
    expect(f.calls.filter(call => call.method === 'getChat')).toHaveLength(1);
  });

  it('preserves private topic binding from group list through approval and same-message receipt', async () => {
    const f = await fixture();
    await f.access.authorize(-200, 'Target', 1, 0);
    await f.bot.handleUpdate(text('/listgroups', 1, 1, 9));
    const listing = f.last(1, 9);
    await f.bot.handleUpdate(f.click('revoke:-200', listing));
    const approval = f.approvalFor(1);
    expect(approval.message_thread_id).toBe(9);
    const data = buttonData(approval, 'confirm');
    await f.bot.handleUpdate(button(data, { ...approval, message_thread_id: 10, is_topic_message: true } as Message));
    expect(f.access.isAllowed(-200)).toBe(true);
    await f.bot.handleUpdate(button(data, approval));
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(richText(approval)).toContain('no longer authorized');
    expect(liveCallbacks(approval)).toEqual([]);
    const privateSends = f.sent().filter(call => call.payload.chat_id === 1);
    expect(privateSends).toHaveLength(2);
    expect(privateSends.every(call => call.payload.message_thread_id === 9)).toBe(true);
    expect(f.calls.filter(call => call.method === 'editMessageText').at(-1)!.payload.message_id).toBe(approval.message_id);
  });

  it('ordinary invite warns once, never grants directly, and binds approval to its private recipient', async () => {
    const f = await fixture();
    const update = joined();
    await f.bot.handleUpdate(update);
    expect(f.access.isAllowed(-200)).toBe(false);
    const approval = f.approvalFor(1);
    const data = buttonData(approval, 'confirm');
    expect(data).toMatch(/^mk:ui:g:[a-f0-9]{24}:\d{1,6}:confirm$/);
    expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    expect(f.sent()).toHaveLength(3);
    await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(3);
    await f.bot.handleUpdate(button(data, approval, 2));
    expect(f.access.isAllowed(-200)).toBe(false);
    await f.bot.handleUpdate(button(data, { ...approval, message_thread_id: 42, is_topic_message: true } as Message));
    expect(f.access.isAllowed(-200)).toBe(false);
    await f.bot.handleUpdate(button(data, approval));
    expect(f.access.isAllowed(-200)).toBe(true);
    const revision = f.access.snapshot().revision;
    await f.bot.handleUpdate(button(data, approval));
    expect(f.access.snapshot().revision).toBe(revision);
    expect(liveCallbacks(approval)).toEqual([]);
    expect(f.calls.filter(call => call.method === 'answerCallbackQuery').at(-1)!.payload.text).toContain('expired');
  });

  it('approves two independently invited groups despite unrelated language and membership changes', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined(10, -200));
    const first = f.approvalFor(1);
    await f.bot.handleUpdate(joined(10, -201));
    const second = f.approvalFor(1);
    await f.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
    const bookkeeping = joined(10, -201);
    bookkeeping.my_chat_member!.old_chat_member = { status: 'member', user: me };
    await f.bot.handleUpdate(bookkeeping);
    await f.bot.handleUpdate(f.click('confirm', first));
    await f.bot.handleUpdate(f.click('confirm', second));
    expect(f.access.isAllowed(-200)).toBe(true);
    expect(f.access.isAllowed(-201)).toBe(true);
    expect(richText(first)).toContain('is authorized');
    expect(richText(second)).toContain('is authorized');
    expect(f.calls.filter(call => call.method === 'getChat')).toHaveLength(2);
  });

  it('retains cached group-list revoke controls through writes to another group', async () => {
    const f = await fixture();
    await f.access.authorize(-200, 'Target', 1, 0);
    await f.bot.handleUpdate(text('/listgroups'));
    const listing = f.last();
    await f.bot.handleUpdate(joined(10, -201));
    await f.bot.handleUpdate(f.click('revoke:-200', listing));
    const approval = f.approvalFor(1);
    await f.bot.handleUpdate(joined(10, -202));
    await f.bot.handleUpdate(f.click('confirm', approval));
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(richText(approval)).toContain('no longer authorized');
  });

  it('expires approval tokens and invalidates approvals after relevant state changes', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const first = f.approvalFor(1);
    const expired = f.click('confirm', first);
    f.expire();
    await f.bot.handleUpdate(expired);
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(liveCallbacks(first)).toEqual([]);
    await f.bot.handleUpdate(joined(10, -201));
    const next = f.approvalFor(1);
    const stale = f.click('confirm', next);
    const leave = joined(10, -201);
    leave.my_chat_member!.old_chat_member = { status: 'member', user: me };
    leave.my_chat_member!.new_chat_member = { status: 'left', user: me };
    await f.bot.handleUpdate(leave);
    await f.bot.handleUpdate(stale);
    expect(f.access.isAllowed(-201)).toBe(false);
    expect(liveCallbacks(next)).toEqual([]);
    for (const panel of [first, next]) {
      expectClosed(panel, 'g');
    }
  });

  it('only autogrants on admin invitation transition and never refreshes on replay or restores after revoke', async () => {
    const f = await fixture();
    const update = joined(1);
    await f.bot.handleUpdate(update);
    expect(f.access.isAllowed(-200)).toBe(true);
    const granted = f.access.snapshot().groups['-200'];
    const revision = f.access.snapshot().revision;
    await f.bot.handleUpdate(update);
    expect(f.access.snapshot().revision).toBe(revision);
    expect(f.access.snapshot().groups['-200']).toEqual(granted);
    await f.access.revoke(-200, 1, revision);
    await f.bot.handleUpdate(update);
    expect(f.access.isAllowed(-200)).toBe(false);
    const adminChange = joined(1);
    adminChange.my_chat_member!.old_chat_member = { status: 'member', user: me };
    await f.bot.handleUpdate(adminChange);
    expect(f.access.isAllowed(-200)).toBe(false);
  });

  it('persists authorization before notification and leaves denial effective after revoke notification/leave failures', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/addgroup', 1, -200));
    expect(f.access.isAllowed(-200)).toBe(true);
    f.fail(call => call.method === 'leaveChat' || call.method === 'sendMessage' && call.payload.chat_id === -200);
    await f.bot.handleUpdate(text('/listgroups'));
    await f.bot.handleUpdate(f.click('revoke:-200'));
    const approval = f.approvalFor(1);
    expect(richText(approval)).toContain('Revoke group -200');
    expect(f.access.isAllowed(-200)).toBe(true);
    await f.bot.handleUpdate(f.click('confirm', approval));
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(richText(approval)).toContain('Bot left: No');
    expect(liveCallbacks(approval)).toEqual([]);
    f.fail(() => false);
    const count = f.sent().length;
    await f.bot.handleUpdate(text('/help', 1, -200));
    expect(f.sent()).toHaveLength(count + 1);
    expect(f.sent().at(-1)!.payload.text).toContain('/addgroup@offline_bot');
    const freshAccess = new AccessService(f.storage, [1, 2]);
    await freshAccess.initialize();
    expect(freshAccess.isAllowed(-200)).toBe(false);
  });

  it('does not grant absent/non-group targets or failed Telegram verification', async () => {
    const f = await fixture();
    f.setMember('left');
    await f.bot.handleUpdate(text('/addgroup -200'));
    expect(f.access.isAllowed(-200)).toBe(false);
    f.setMember('member');
    f.setChatType('private');
    await f.bot.handleUpdate(text('/addgroup -200'));
    expect(f.access.isAllowed(-200)).toBe(false);
    f.setChatType('supergroup');
    f.fail(call => call.method === 'getChatMember');
    await f.bot.handleUpdate(text('/addgroup -200'));
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(JSON.stringify(f.sent())).not.toContain('secret-token');
  });

  it('deduplicates repeated authorization updates without another permission write or API side effect', async () => {
    const f = await fixture();
    const update = text('/addgroup -200');
    await f.bot.handleUpdate(update);
    const revision = f.access.snapshot().revision;
    await f.bot.handleUpdate(update);
    expect(f.access.snapshot().revision).toBe(revision);
    expect(f.calls.filter(call => call.method === 'getChatMember')).toHaveLength(1);
  });

  it('migrates authorization without moving sessions, then removes it when the bot leaves', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined(1));
    const original = f.access.snapshot().groups['-200'];
    const migration = text('', 1, -200);
    migration.message!.from = { id: 1087968824, is_bot: true, first_name: 'Group' };
    migration.message!.migrate_to_chat_id = -300;
    f.adapter.sessions.set(`${me.id}:-200:1:4`, { rssInput: { panelId: 'input', messageId: 1 } });
    await f.bot.handleUpdate(migration);
    expect(f.access.isAllowed(-200)).toBe(false);
    expect(f.access.snapshot().groups['-300']).toEqual({ ...original, id: -300 });
    expect(f.adapter.sessions.get(`${me.id}:-300:1:4`)).toBeUndefined();
    const leave = joined(1, -300);
    leave.my_chat_member!.old_chat_member = { status: 'member', user: me };
    leave.my_chat_member!.new_chat_member = { status: 'left', user: me };
    await f.bot.handleUpdate(leave);
    expect(f.access.isAllowed(-300)).toBe(false);
  });

  it('retains persisted personal language when menu publication fails', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(text('/settings', 10));
    const pane = f.last(10);
    f.fail(call => call.method === 'setMyCommands');
    await f.bot.handleUpdate(f.click('lang:en', pane, 10));
    expect(f.configuration.getPreference(10).language).toBe('en');
    expect(richText(pane)).toContain('could not be synchronized');
    expect(f.sent()).toHaveLength(1);
  });

  it('stop aborts actual in-flight API work and drains handlers before completing', async () => {
    const f = await fixture();
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    let cancelled = false;
    f.delay(async call => {
      if (call.method !== 'sendRichMessage') return;
      entered();
      await new Promise<void>((_resolve, reject) => {
        call.signal!.addEventListener('abort', () => { cancelled = true; reject(new DOMException('Stopped', 'AbortError')); }, { once: true });
      });
    });
    const running = f.bot.handleUpdate(text('/help')).catch(error => error);
    await started;
    await f.adapter.stop();
    expect(cancelled).toBe(true);
    expect((await running).error).toMatchObject({ code: 'CANCELLED' });
    expect(f.adapter.sessions.size).toBe(0);
    expect(f.adapter.panels.size).toBe(0);
    expect(f.health.recordApiError).not.toHaveBeenCalled();
  });

  it('rejects a malformed rich-message response safely without generic markdown conversion', async () => {
    const f = await fixture();
    f.fail(call => call.method === 'sendRichMessage');
    await f.bot.handleUpdate(text('/help'));
    expect(f.calls.filter(call => call.method === 'sendRichMessage')).toHaveLength(1);
    expect(f.sent().at(-1)!.payload.text).toContain('temporarily unavailable');
    expect(f.sent().every(call => !call.payload.parse_mode)).toBe(true);
  });

  it('keeps inaccessible callbacks acknowledged without leaking pending approval details', async () => {
    const f = await fixture();
    await f.bot.handleUpdate(joined());
    const update = f.click('confirm', f.approvalFor(1));
    update.callback_query!.message = { message_id: 3, date: 0, chat: { id: 1, type: 'private', first_name: 'User' } } as Message;
    const count = f.sent().length;
    await f.bot.handleUpdate(update);
    expect(f.sent()).toHaveLength(count);
    expect(f.calls.at(-1)!.method).toBe('answerCallbackQuery');
    expect(f.access.isAllowed(-200)).toBe(false);
  });
});

describe('Telegram sticker panels with real scoped Actions', () => {
  const t = translator('en');
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const webp = Buffer.from([82, 73, 70, 70, 8, 0, 0, 0, 87, 69, 66, 80, 1, 2, 3, 4]);
  const tgs = Buffer.from([31, 139, 8, 0, 1, 2, 3]);
  const webm = Buffer.from([26, 69, 223, 163, 1, 2, 3]);
  const originals = { static: png, animated: tgs, video: webm };
  const outputs = { png, webp, jpg: Buffer.from([255, 216, 255, 224]), gif: Buffer.from('GIF89a') };

  function sticker(kind: StickerKind = 'static', actor = 10, chatId = actor, thread?: number, extra: Partial<Sticker> = {}): Update {
    const update = text('', actor, chatId, thread);
    delete update.message!.text; delete update.message!.entities;
    update.message!.sticker = { file_id: `file_${kind}`, file_unique_id: `unique_${kind}`, type: 'regular', width: 512, height: 256,
      is_animated: kind === 'animated', is_video: kind === 'video', ...extra };
    return update;
  }

  function packFile(kind: StickerKind, extra: Partial<StickerFile> = {}): StickerFile {
    return { fileId: `file_${kind}`, uniqueId: `unique_${kind}`, kind, width: 512, height: 256, setType: 'regular', ...extra };
  }

  async function stickerFixture() {
    const tempDirectory = await mkdtemp(join(process.cwd(), '.kilo', 'sticker-integration-test-'));
    const sentData: Buffer[] = [];
    const transport = {
      download: vi.fn<StickerTransport['download']>(async file => originals[file.kind]),
      getSet: vi.fn<StickerTransport['getSet']>(async name => ({ name, title: '<literal pack>',
        stickers: [packFile('static'), packFile('animated'), packFile('video')] })),
      send: vi.fn<StickerTransport['send']>(async (_target, result) => {
        sentData.push(Buffer.isBuffer(result.data) ? result.data : await readFile(result.data.path));
        return ++sequence;
      }),
    };
    const convert = vi.fn<StickerConverter>(async request => ({ data: outputs[request.format], format: request.format, width: 512, height: 256 }));
    const f = await fixture({}, undefined, { sticker: { transport, convert, tempDirectory, resources: new ResourcePolicy({ heavyBytes: 48 * 1024 * 1024 }) } });
    cleanup.push(() => rm(tempDirectory, { recursive: true, force: true }));
    return { ...f, transport, convert, sentData };
  }

  function gate() {
    const result = Promise.withResolvers<void>();
    cleanup.unshift(async () => { result.resolve(); });
    return result;
  }

  async function sent(pane: Message, format: string): Promise<void> {
    await vi.waitFor(() => expect(richText(pane)).toContain(`Sent ${format.toUpperCase()} as`), { timeout: 2_000, interval: 5 });
    expectNativeSticker(pane);
    expect(callbacks(pane).some(data => data.endsWith(':stcancel'))).toBe(false);
  }

  function expectNativeSticker(pane: Message): void {
    expect(pane.reply_markup?.inline_keyboard ?? []).toEqual([]);
    expect(pane.rich_message?.blocks[0]?.type).toBe('paragraph');
    const rows = pane.rich_message!.blocks.slice(1);
    expect(rows).toEqual(buttonRows(pane).map(buttons => ({ type: 'buttons', buttons })));
    for (const row of buttonRows(pane)) {
      expect(row.length).toBeGreaterThan(0);
      expect(row.length).toBeLessThanOrEqual(8);
      for (const button of row) {
        expect(Object.keys(button).sort()).toEqual(['text', 'disabled' in button ? 'disabled' : 'callback_data' in button ? 'callback_data' : 'url',
          ...('style' in button ? ['style'] : [])].sort());
      }
    }
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/"size":|"type":"(?:heading|button)"/);
    expect(callbacks(pane).every(data => Buffer.byteLength(data) > 0 && Buffer.byteLength(data) <= 64)).toBe(true);
    expect(pane).not.toHaveProperty('text');
    expect(pane).not.toHaveProperty('entities');
  }

  function expectSelectedMode(pane: Message, mode: 'media' | 'file'): void {
    expect(buttonRows(pane).flat().filter(button => button.style === 'primary')).toEqual([{
      text: t(`bot:sticker.${mode}`), callback_data: buttonData(pane, `stmode:${mode}`), style: 'primary',
    }]);
    expect(richText(pane)).not.toContain('Delivery mode:');
  }

  async function packPanel(f: Awaited<ReturnType<typeof stickerFixture>>, actor = 10, thread?: number): Promise<Message> {
    return vi.waitFor(() => {
      const pane = f.last(actor, thread);
      expect(callbacks(pane).filter(data => data.includes(':stformat:'))).toEqual([buttonData(pane, 'stformat:original')]);
      expect(callbacks(pane).some(data => data.includes(':stmode:'))).toBe(false);
      expect(f.adapter.panels.hasMessage(me.id, actor, pane.message_id)).toBe(true);
      return pane;
    }, { timeout: 2_000, interval: 5 });
  }

  it('opens an owner-bound native panel for an ordinary user without automatic conversion or duplicate rendering', async () => {
    const f = await stickerFixture(); const update = sticker('static', 10, 10, 9);
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(update);
    const pane = f.last(10, 9);
    expect(f.access.isAdmin(10)).toBe(false);
    expect(richText(pane)).toContain('Static sticker');
    expectNativeSticker(pane);
    expectSelectedMode(pane, 'media');
    expect(f.sent()[0]!.payload.reply_markup).toEqual({ inline_keyboard: [] });
    expect(pane.rich_message).toBeDefined();
    expect(f.sent()).toHaveLength(1);
    expect(f.sent()[0]).toMatchObject({ method: 'sendRichMessage', payload: { chat_id: 10, message_thread_id: 9,
      reply_parameters: { message_id: update.message!.message_id }, rich_message: { skip_entity_detection: true } } });
    expect(buttonData(pane, 'stformat:png')).toMatch(/^mk:ui:k:[a-f0-9]{24}:0:stformat:png$/);
    expect(callbacks(pane).every(data => Buffer.byteLength(data) <= 64)).toBe(true);
    expect(execute.mock.calls.map(call => call[1])).toEqual(['sticker.inspect']);
    const unchanged = structuredClone(pane);
    await f.bot.handleUpdate(button(buttonData(pane, 'stformat:png'), pane, 11));
    await f.bot.handleUpdate(update);
    expect(pane).toEqual(unchanged);
    expect(f.sent()).toHaveLength(1);
    expect(f.adapter.panels.size).toBe(1);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(JSON.stringify(pane.rich_message)).not.toMatch(/file_static|unique_static/);
  });

  it.each(['static', 'animated', 'video'] as const)('keeps the %s description compact and mode selection in native controls', async kind => {
    const f = await stickerFixture();
    await f.bot.handleUpdate(sticker(kind, 10, 10, undefined, { emoji: '\u{1f680}', set_name: 'Example_pack' }));
    const pane = f.last(10);
    const description = `${t('bot:sticker.single', { kind: t(`bot:sticker.kinds.${kind}`), width: 512, height: 256 })} \u{1f680}`;
    expect(richText(pane)).toBe(`${t('bot:sticker.title')}\n${description}\n${t(kind === 'static' ? 'bot:sticker.hint' : 'bot:sticker.animationHint')}`);
    expect(richText(pane).length).toBeLessThan(180);
    expect(richText(pane)).not.toMatch(/Associated emoji:|Dimensions:|Delivery mode:|10 minutes/);
    expectNativeSticker(pane);
    expectSelectedMode(pane, 'media');
    expect(buttonRows(pane)[0]?.map(button => richText(button.text))).toEqual(['As media', 'As files']);
    expect(buttonRows(pane)[1]).toEqual([
      { text: t('bot:sticker.original'), callback_data: buttonData(pane, 'stformat:original') },
      { text: t('bot:sticker.wholePack'), callback_data: buttonData(pane, 'stpack') },
    ]);
    expect(buttonRows(pane)).toHaveLength(4);
    expect(buttonRows(pane).at(-1)?.every(button => 'callback_data' in button && /:stformat:(?:png|jpg|gif)$/.test(button.callback_data))).toBe(true);
    expect(pane.rich_message?.blocks.at(-2)).toEqual({ type: 'buttons', buttons: [{ text: 'Choose format', disabled: true }] });
    expect(buttonRows(pane).flat().some(button => 'url' in button)).toBe(false);
    await f.bot.handleUpdate(f.click('stmode:file', pane, 10));
    expectSelectedMode(pane, 'file');
    expectNativeSticker(pane);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja'] as const)('uses a disabled format placeholder without a colon in %s', async locale => {
    const f = await stickerFixture();
    const update = sticker();
    update.message!.from!.language_code = locale;
    await f.bot.handleUpdate(update);
    const label = translator(locale)('bot:sticker.format');
    expect(f.last(10).rich_message?.blocks.at(-2)).toEqual({
      type: 'buttons', buttons: [{ text: label, disabled: true }],
    });
    expect(label).not.toMatch(/[:：]$/);
    expect(richText(f.last(10))).not.toContain(label);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('replaces embedded choices with progress and then fresh completed controls on the same message', async () => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<void>(); const finish = gate();
    f.convert.mockImplementationOnce(async request => {
      entered.resolve(); await finish.promise;
      return { data: png, format: request.format, width: 512, height: 256 };
    });
    await f.bot.handleUpdate(sticker());
    const pane = f.last(10); const initial = callbacks(pane);
    await f.bot.handleUpdate(f.click('stformat:png', pane, 10));
    await entered.promise;
    expectNativeSticker(pane);
    const progress = callbacks(pane);
    expect(progress).toEqual([buttonData(pane, 'stcancel')]);
    expect(progress.some(data => initial.includes(data))).toBe(false);
    expect(richText(pane)).toContain('Processing. You can cancel.');
    expect(richText(pane)).not.toContain(t('bot:sticker.format'));
    finish.resolve(); await sent(pane, 'png');
    expectSelectedMode(pane, 'media');
    expect(callbacks(pane).some(data => [...initial, ...progress].includes(data))).toBe(false);
    expect(richText(pane)).not.toContain(t('bot:sticker.processing'));
    const edits = f.calls.filter(call => call.method.startsWith('editMessage'));
    expect(edits).toHaveLength(2);
    for (const edit of edits) {
      expect(edit.method).toBe('editMessageText');
      expect(edit.payload).toMatchObject({ message_id: pane.message_id, chat_id: 10, rich_message: { blocks: expect.any(Array) } });
      expect(edit.payload).not.toHaveProperty('text');
      expect(edit.payload.reply_markup).toEqual({ inline_keyboard: [] });
    }
    expect(f.sent()).toHaveLength(1);
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });

  it('keeps only the original download when the sticker has no source pack', async () => {
    const f = await stickerFixture();
    await f.bot.handleUpdate(sticker('static', 10, 10, undefined, { set_name: undefined }));
    const pane = f.last(10);
    expect(buttonRows(pane)[1]).toEqual([{ text: t('bot:sticker.original'), callback_data: buttonData(pane, 'stformat:original') }]);
    expect(buttonRows(pane).flat().some(button => 'url' in button)).toBe(false);
    expect(callbacks(pane).some(data => data.endsWith(':stpack'))).toBe(false);
  });

  it('binds /sticker replies and their eventual delivery to the original source message and topic', async () => {
    const f = await stickerFixture(); const original = sticker('static', 10, 10, 7);
    const command = text('/sticker', 10, 10, 7);
    command.message!.reply_to_message = { ...original.message!, reply_to_message: undefined };
    await f.bot.handleUpdate(command);
    const pane = f.last(10, 7);
    expect(f.sent()[0]!.payload.reply_parameters).toMatchObject({ message_id: original.message!.message_id });
    await f.bot.handleUpdate(f.click('stformat:png', pane, 10));
    await sent(pane, 'png');
    expect(f.transport.send.mock.calls[0]![0]).toEqual({ chatId: 10, threadId: 7, replyTo: original.message!.message_id });
    expect(f.transport.send.mock.calls[0]![0].replyTo).not.toBe(command.message!.message_id);
  });

  it.each([
    ['static', 'png', 'media', 'photo'], ['static', 'jpg', 'media', 'photo'], ['static', 'png', 'file', 'document'],
    ['static', 'jpg', 'file', 'document'], ['static', 'webp', 'file', 'document'], ['static', 'original', 'media', 'document'],
    ['animated', 'png', 'media', 'photo'], ['animated', 'gif', 'media', 'animation'], ['animated', 'gif', 'file', 'document'],
    ['animated', 'original', 'media', 'document'],
    ['video', 'png', 'file', 'document'], ['video', 'gif', 'media', 'animation'], ['video', 'original', 'media', 'document'],
  ] as const)('routes %s/%s/%s through one Action and delivers %s', async (kind, format, mode, delivery) => {
    const f = await stickerFixture(); const update = sticker(kind);
    await f.bot.handleUpdate(update);
    const pane = f.last(10);
    const initial = buttonData(pane, 'stformat:png');
    if (kind !== 'static') {
      expect(buttonRows(pane).flat().find(item => 'callback_data' in item && item.callback_data.endsWith(':stformat:png'))?.text).toBe(t('bot:sticker.firstFrame'));
      expect(buttonData(pane, 'stformat:gif')).toBeDefined();
    }
    if (mode === 'file') {
      await f.bot.handleUpdate(f.click('stmode:file', pane, 10));
      expectSelectedMode(pane, 'file');
      expect(buttonData(pane, 'stformat:png')).not.toBe(initial);
    }
    const execute = vi.spyOn(f.executor, 'execute');
    const convertClick = f.click(`stformat:${format}`, pane, 10);
    await Promise.all([f.bot.handleUpdate(convertClick), f.bot.handleUpdate({ ...convertClick, update_id: ++sequence })]);
    const extension = format === 'original' ? { static: 'png', animated: 'tgs', video: 'webm' }[kind] : format;
    await sent(pane, extension);
    expect(execute.mock.calls.filter(call => call[1] === 'sticker.convert')).toHaveLength(1);
    expect(execute.mock.calls.find(call => call[1] === 'sticker.convert')?.[2]).toEqual({ source: expect.stringMatching(/^[a-f0-9]{24}$/),
      format, delivery: format === 'original' ? 'file' : mode });
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.send.mock.calls[0]![1]).toEqual({ data: format === 'original' ? originals[kind] : outputs[format], filename: `sticker.${extension}`, delivery });
    if (format === 'original') expect(f.convert).not.toHaveBeenCalled();
    else expect(f.convert).toHaveBeenCalledExactlyOnceWith({ data: originals[kind], kind, format, media: mode === 'media', width: 512, height: 256 }, expect.any(AbortSignal));
    await f.bot.handleUpdate(button(convertClick.callback_query!.data!, pane, 10));
    expect(f.transport.send).toHaveBeenCalledTimes(1);
  });

  it('hides static WEBP in media mode and rejects a forged request until file mode is selected', async () => {
    const f = await stickerFixture(); await f.bot.handleUpdate(sticker());
    const pane = f.last(10); const pngData = buttonData(pane, 'stformat:png');
    expect(callbacks(pane).some(data => data.endsWith(':stformat:webp'))).toBe(false);
    await f.bot.handleUpdate(button(pngData.replace(/png$/, 'webp'), pane, 10));
    expect(f.transport.download).not.toHaveBeenCalled();
    await f.bot.handleUpdate(f.click('stmode:file', pane, 10));
    await f.bot.handleUpdate(f.click('stformat:webp', pane, 10));
    await sent(pane, 'webp');
    expect(f.transport.send.mock.calls[0]![1].delivery).toBe('document');
  });

  it.each(['name', 'url', 'source-button'] as const)('downloads the complete mixed original pack opened by %s', async entry => {
    const f = await stickerFixture(); let replyTo: number;
    if (entry === 'source-button') {
      await f.bot.handleUpdate(sticker('static', 10, 10, undefined, { set_name: 'Example_pack' }));
      const sourcePane = f.last(10); replyTo = sourcePane.message_id;
      expect(buttonRows(sourcePane)[1]?.map(button => 'callback_data' in button ? button.callback_data : '')).toEqual([
        buttonData(sourcePane, 'stformat:original'), buttonData(sourcePane, 'stpack'),
      ]);
      expect(buttonRows(sourcePane).flat().some(button => 'url' in button)).toBe(false);
      await f.bot.handleUpdate(f.click('stpack', sourcePane, 10));
      expect(callbacks(sourcePane).some(data => data.endsWith(':stformat:png'))).toBe(true);
    } else {
      const update = text(entry === 'name' ? '/sticker Example_pack' : 'https://t.me/addstickers/Example_pack', 10);
      replyTo = update.message!.message_id; await f.bot.handleUpdate(update);
    }
    const pane = await packPanel(f);
    if (entry === 'source-button') expect(f.adapter.panels.size).toBe(2);
    expect(richText(pane)).toContain(t('bot:sticker.pack', { title: '<literal pack>', count: 3 }));
    expect(richText(pane)).toContain(t('bot:sticker.packLimit'));
    expect(richText(pane)).not.toMatch(/Pack:|Items:/);
    expectNativeSticker(pane);
    expect(buttonRows(pane)).toEqual([[{ text: 'Download ZIP', callback_data: buttonData(pane, 'stformat:original') }]]);
    expect(callbacks(pane).filter(data => data.includes(':stformat:'))).toHaveLength(1);
    expect(callbacks(pane).some(data => data.includes(':stmode:'))).toBe(false);
    expect(f.transport.download).not.toHaveBeenCalled();
    await f.bot.handleUpdate(f.click('stformat:original', pane, 10));
    await sent(pane, 'zip');
    expect(f.transport.getSet).toHaveBeenCalledExactlyOnceWith('Example_pack', expect.any(AbortSignal));
    expect(f.transport.download).toHaveBeenCalledTimes(3);
    expect(f.convert).not.toHaveBeenCalled();
    const upload = f.transport.send.mock.calls[0]!;
    expect(upload[0]).toEqual({ chatId: 10, replyTo });
    expect(upload[1]).toMatchObject({ filename: 'stickers.zip', delivery: 'document' });
    const entries = unzipSync(f.sentData[0]!);
    expect(Object.keys(entries)).toEqual(['001.png', '002.tgs', '003.webm']);
    expect(Object.values(entries).map(value => Buffer.from(value))).toEqual([png, tgs, webm]);
  });

  it('accepts custom emoji pack links without adding an external pack button', async () => {
    const f = await stickerFixture();
    f.transport.getSet.mockResolvedValue({ name: 'Emoji_pack', title: 'Emoji pack', stickers: [packFile('animated', { setType: 'custom_emoji' })] });
    await f.bot.handleUpdate(text('https://t.me/addemoji/Emoji_pack', 10));
    const pane = await packPanel(f);
    expect(richText(pane)).toContain('Emoji pack');
    expect(buttonRows(pane).flat().some(button => 'url' in button)).toBe(false);
    expect(JSON.stringify(pane.rich_message)).not.toContain('addstickers');
    await f.bot.handleUpdate(f.click('stformat:original', pane, 10));
    await sent(pane, 'zip');
    expect(Object.keys(unzipSync(f.sentData[0]!))).toEqual(['001.tgs']);
  });

  it('retains multiple source panels with independent modes and message-bound deliveries', async () => {
    const f = await stickerFixture(); const first = sticker(); const second = sticker('video');
    await f.bot.handleUpdate(first); const firstPane = f.last(10);
    await f.bot.handleUpdate(f.click('stmode:file', firstPane, 10));
    const firstView = structuredClone(firstPane);
    await f.bot.handleUpdate(second); const secondPane = f.last(10);
    expect(f.adapter.panels.size).toBe(2);
    expect(firstPane).toEqual(firstView);
    expectSelectedMode(secondPane, 'media');
    const secondView = structuredClone(secondPane);
    await f.bot.handleUpdate(f.click('stformat:webp', firstPane, 10)); await sent(firstPane, 'webp');
    expect(secondPane).toEqual(secondView);
    await f.bot.handleUpdate(f.click('stformat:gif', secondPane, 10)); await sent(secondPane, 'gif');
    expect(f.transport.send.mock.calls.map(call => [call[0].replyTo, call[1].delivery])).toEqual([
      [first.message!.message_id, 'document'], [second.message!.message_id, 'animation'],
    ]);
  });

  it('rejects stale, foreign actor/chat/topic/message/bot and forged-route callbacks without conversion', async () => {
    const f = await stickerFixture(); await f.bot.handleUpdate(sticker('static', 10, 10, 9));
    const pane = f.last(10, 9); const stale = buttonData(pane, 'stformat:png');
    await f.bot.handleUpdate(f.click('stmode:file', pane, 10));
    const data = buttonData(pane, 'stformat:png'); const unchanged = structuredClone(pane);
    await f.bot.handleUpdate(button(stale, pane, 10));
    await f.bot.handleUpdate(button(data, pane, 11));
    await f.bot.handleUpdate(button(data.replace('mk:ui:k:', 'mk:ui:w:'), pane, 10));
    for (const forged of [
      { ...pane, chat: { id: 11, type: 'private', first_name: 'Other' } },
      { ...pane, chat: { id: -100, type: 'supergroup', title: 'Other' } },
      { ...pane, message_thread_id: 10, is_topic_message: true }, { ...pane, message_thread_id: undefined, is_topic_message: false },
      { ...pane, message_id: pane.message_id + 100 }, { ...pane, from: { ...me, id: me.id + 1 } },
    ]) await f.bot.handleUpdate(button(data, forged as Message, 10));
    expect(pane).toEqual(unchanged);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['alias', 'rss', 'weather'] as const)('does not consume a direct sticker while %s input is active', async kind => {
    const f = await stickerFixture(); const actor = kind === 'alias' ? 1 : 10;
    if (kind === 'alias') await aliasInput(f, 9);
    else {
      await f.bot.handleUpdate(text(`/${kind}`, actor, actor, 9));
      if (kind === 'rss') await f.bot.handleUpdate(f.click('rssadd', f.last(actor, 9), actor));
    }
    const key = `${me.id}:${actor}:${actor}:9`; const session = f.adapter.sessions.get(key);
    expect(session?.[`${kind}Input`]).toBeDefined();
    const pane = structuredClone(f.last(actor, 9)); const count = f.sent().length;
    const execute = vi.spyOn(f.executor, 'execute');
    await f.bot.handleUpdate(sticker('static', actor, actor, 9));
    expect(f.adapter.sessions.get(key)).toEqual(session);
    expect(f.last(actor, 9)).toEqual(pane);
    expect(f.sent()).toHaveLength(count);
    expect(execute).not.toHaveBeenCalled();
    expect(f.transport.download).not.toHaveBeenCalled();
  });

  it('denies group, edited and protected sources without creating sticker Actions or panels', async () => {
    const f = await stickerFixture(); await f.access.authorize(-100, 'Allowed', 1, 0);
    const execute = vi.spyOn(f.executor, 'execute');
    for (const chat of [-100, -200]) {
      await f.bot.handleUpdate(sticker('static', 10, chat));
      const command = text('/sticker', 10, chat); command.message!.reply_to_message = { ...sticker('static', 10, chat).message!, reply_to_message: undefined };
      await f.bot.handleUpdate(command);
    }
    const protectedSource = sticker(); protectedSource.message!.has_protected_content = true;
    await f.bot.handleUpdate(protectedSource);
    const reply = text('/sticker', 10); reply.message!.reply_to_message = { ...protectedSource.message!, reply_to_message: undefined };
    await f.bot.handleUpdate(reply);
    const edited = sticker();
    await f.bot.handleUpdate({ update_id: edited.update_id, edited_message: { ...edited.message!, edit_date: 101 } });
    expect(execute).not.toHaveBeenCalled();
    expect(f.adapter.panels.size).toBe(0);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.transport.getSet).not.toHaveBeenCalled();
  });

  it('expires sources and reopens only fresh help, never inspection or a saved delivery', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const f = await stickerFixture(); await f.bot.handleUpdate(sticker());
    const pane = f.last(10); const stale = buttonData(pane, 'stformat:png');
    const execute = vi.spyOn(f.executor, 'execute');
    await vi.advanceTimersByTimeAsync(600_001);
    expectClosed(pane, 'k', 10);
    expect(richText(pane)).toContain(t('bot:sticker.expired'));
    expect(f.calls.filter(call => call.method.startsWith('editMessage'))).toEqual([expect.objectContaining({
      method: 'editMessageText', payload: expect.objectContaining({ rich_message: pane.rich_message }),
    })]);
    await f.bot.handleUpdate(button(stale, pane, 10));
    await f.bot.handleUpdate(button('mk:open:k:10', pane, 11));
    expect(f.sent()).toHaveLength(1);
    await f.bot.handleUpdate(button('mk:open:k:10', pane, 10));
    expect(richText(f.last(10))).toBe(t('bot:sticker.usage'));
    expect(richText(f.last(10))).toMatch(/private chat/i);
    expect(richText(f.last(10))).toContain('/sticker');
    expect(f.last(10).message_id).not.toBe(pane.message_id);
    expect(callbacks(f.last(10))).toEqual([]);
    expect(f.adapter.panels.size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['native', 'legacy', 'both'] as const)('cleans up %s sticker controls after restart and reopens owner-only fresh help', async representation => {
    const old = await stickerFixture();
    await old.bot.handleUpdate(sticker('static', 10, 10, 9));
    const pane = telegramMessage(old.last(10, 9));
    const stale = buttonData(pane, 'stformat:png');
    delete pane.reply_markup;
    expect(pane.rich_message).toBeDefined();
    expect(pane).not.toHaveProperty('text');
    expect(pane).not.toHaveProperty('entities');
    expect(pane).not.toHaveProperty('reply_markup');
    if (representation !== 'native') pane.reply_markup = { inline_keyboard: [[{ text: 'PNG', callback_data: stale }]] };
    if (representation === 'legacy') pane.rich_message!.blocks = pane.rich_message!.blocks.filter(block => block.type !== 'buttons');
    await old.adapter.stop();
    const f = await stickerFixture(); f.messages.push(pane);
    const execute = vi.spyOn(f.executor, 'execute');
    const original = structuredClone(pane);
    for (const forged of [{ ...pane, from: { ...me, id: me.id + 1 } }, { ...pane, from: undefined }]) {
      await f.bot.handleUpdate(button(stale, forged as Message, 10));
    }
    expect(pane).toEqual(original);
    expect(f.calls.filter(call => call.method.startsWith('editMessage'))).toEqual([]);
    await f.bot.handleUpdate(button(stale, pane, 10));
    expectClosed(pane, 'k', 10);
    expectNativeSticker(pane);
    expect(richText(pane)).toContain(t('bot:sticker.expired'));
    const edits = f.calls.filter(call => call.method.startsWith('editMessage'));
    expect(edits).toHaveLength(1);
    expect(edits[0]).toMatchObject({ method: 'editMessageText', payload: { chat_id: 10, message_id: pane.message_id,
      rich_message: pane.rich_message, reply_markup: { inline_keyboard: [] } } });
    expect(execute).not.toHaveBeenCalled();
    await f.bot.handleUpdate(button('mk:open:k:10', pane, 11));
    expect(f.sent()).toEqual([]);
    await f.bot.handleUpdate(button('mk:open:k:10', pane, 10));
    const fresh = f.last(10, 9);
    expect(fresh.message_id).not.toBe(pane.message_id);
    expect(richText(fresh)).toBe(t('bot:sticker.usage'));
    expect(callbacks(fresh)).toEqual([]);
    expectClosed(pane, 'k', 10);
    expect(f.adapter.panels.size).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(f.transport.getSet).not.toHaveBeenCalled();
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['command', 'button'] as const)('lets %s cancellation bypass the conversation queue and await real converter cleanup', async entry => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<AbortSignal>(); const aborted = Promise.withResolvers<void>(); const finish = gate();
    f.convert.mockImplementationOnce(async (request, signal) => {
      entered.resolve(signal); signal.addEventListener('abort', () => aborted.resolve(), { once: true });
      await finish.promise; return { data: png, format: request.format, width: 512, height: 256 };
    });
    await f.bot.handleUpdate(sticker('static', 10, 10, 9)); const pane = f.last(10, 9);
    await f.bot.handleUpdate(f.click('stformat:png', pane, 10));
    const signal = await entered.promise;
    expect(richText(pane)).toContain(t('bot:sticker.processing'));
    expectNativeSticker(pane);
    expect(buttonRows(pane)).toEqual([[{ text: 'Cancel', callback_data: buttonData(pane, 'stcancel'), style: 'danger' }]]);
    let settled = false;
    const cancellation = f.bot.handleUpdate(entry === 'command' ? text('/cancel', 10, 10, 9) : f.click('stcancel', pane, 10)).then(() => { settled = true; });
    await aborted.promise;
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(f.transport.send).not.toHaveBeenCalled();
    finish.resolve(); await cancellation;
    expectClosed(pane, 'k', 10);
    expect(richText(pane)).toContain(t('bot:sticker.cancelled'));
    expect(richText(pane)).not.toContain(t('bot:sticker.processing'));
    expect(f.adapter.panels.size).toBe(0);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it.each(['command', 'button'] as const)('retires the source on %s cancellation while the progress edit is still pending', async entry => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<Call>(); const finish = gate();
    await f.bot.handleUpdate(sticker('static', 10, 10, 9)); const pane = f.last(10, 9);
    f.delay(async call => {
      if (call.method === 'editMessageText' && richText(call.payload.rich_message).includes(t('bot:sticker.processing'))) { entered.resolve(call); await finish.promise; }
    });
    await f.bot.handleUpdate(f.click('stformat:png', pane, 10));
    const progress = await entered.promise;
    expect(f.convert).not.toHaveBeenCalled();
    const release = vi.spyOn(f.stickers, 'release');
    // Telegram may display the submitted edit before its HTTP response reaches the adapter.
    const visibleProgress = telegramMessage(pane);
    recordContent(visibleProgress, progress.payload);
    expect(visibleProgress.rich_message).toEqual(progress.payload.rich_message);
    expect(visibleProgress.rich_message).not.toBe(progress.payload.rich_message);
    expect(visibleProgress).toMatchObject({ message_id: pane.message_id, chat: pane.chat, from: me,
      message_thread_id: 9, is_topic_message: true });
    expect(visibleProgress).not.toHaveProperty('text');
    let settled = false;
    const cancellation = f.bot.handleUpdate(entry === 'command' ? text('/cancel', 10, 10, 9) : f.click('stcancel', visibleProgress, 10)).then(() => { settled = true; });
    await vi.waitFor(() => expect(release).toHaveBeenCalled(), { timeout: 2_000, interval: 5 });
    expect(settled).toBe(false);
    finish.resolve(); await cancellation;
    expectClosed(pane, 'k', 10);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('cancelling panel B behind its progress edit does not abort panel A active conversion', async () => {
    const f = await stickerFixture(); const active = Promise.withResolvers<AbortSignal>(); const finishA = gate();
    const progressB = Promise.withResolvers<Call>(); const finishEditB = gate();
    const capture = vi.spyOn(f.stickers, 'capture'); const execute = vi.spyOn(f.executor, 'execute');
    const sourceA = sticker('static', 10, 10, 9);
    await f.bot.handleUpdate(sourceA); const paneA = f.last(10, 9);
    await f.bot.handleUpdate(sticker('video', 10, 10, 9)); const paneB = f.last(10, 9);
    const referenceB = capture.mock.results[1]!.value;
    f.convert.mockImplementationOnce(async (request, signal) => {
      active.resolve(signal); await finishA.promise;
      return { data: png, format: request.format, width: 512, height: 256 };
    });
    await f.bot.handleUpdate(f.click('stformat:png', paneA, 10));
    const signalA = await active.promise;
    f.delay(async call => {
      if (call.method === 'editMessageText' && call.payload.message_id === paneB.message_id
        && richText(call.payload.rich_message).includes(t('bot:sticker.processing'))) { progressB.resolve(call); await finishEditB.promise; }
    });
    await f.bot.handleUpdate(f.click('stformat:gif', paneB, 10));
    const progress = await progressB.promise;
    const visibleB = telegramMessage(paneB);
    recordContent(visibleB, progress.payload);
    let cancelledB = false;
    const cancellation = f.bot.handleUpdate(f.click('stcancel', visibleB, 10)).then(() => { cancelledB = true; });
    await vi.waitFor(() => expect(execute.mock.calls.filter(call => call[1] === 'sticker.cancel')).toHaveLength(1), { timeout: 2_000, interval: 5 });
    expect(execute.mock.calls.find(call => call[1] === 'sticker.cancel')?.[2]).toEqual({ source: referenceB });
    expect(signalA.aborted).toBe(false);
    expect(cancelledB).toBe(false);
    finishEditB.resolve();
    await vi.waitFor(() => expect(cancelledB).toBe(true), { timeout: 2_000, interval: 5 });
    await cancellation;
    expectClosed(paneB, 'k', 10);
    expect(signalA.aborted).toBe(false);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(f.transport.download.mock.calls.map(call => call[0].kind)).toEqual(['static']);
    expect(f.transport.send).not.toHaveBeenCalled();
    finishA.resolve(); await sent(paneA, 'png');
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.send.mock.calls[0]![0]).toEqual({ chatId: 10, threadId: 9, replyTo: sourceA.message!.message_id });
    expect(f.convert).toHaveBeenCalledTimes(1);
  });

  it.each(['name', 'url', 'source-button'] as const)('cancels a detached %s pack lookup and drains it without creating a stale panel', async entry => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = gate();
    const capture = vi.spyOn(f.stickers, 'capture'); const release = vi.spyOn(f.stickers, 'release'); const execute = vi.spyOn(f.executor, 'execute');
    let cleaned = false;
    f.transport.getSet.mockImplementationOnce(async (name, signal) => {
      entered.resolve(signal); await finish.promise; cleaned = true;
      return { name, title: '<late pack>', stickers: [packFile('static')] };
    });
    let request: Update;
    if (entry === 'source-button') {
      await f.bot.handleUpdate(sticker('static', 10, 10, 9, { set_name: 'Example_pack' }));
      request = f.click('stpack', f.last(10, 9), 10);
    } else request = text(entry === 'name' ? '/sticker Example_pack' : 'https://t.me/addstickers/Example_pack', 10, 10, 9);
    let opened = false;
    const opening = f.bot.handleUpdate(request).then(() => { opened = true; });
    const signal = await entered.promise;
    await vi.waitFor(() => expect(opened).toBe(true), { timeout: 2_000, interval: 5 });
    const reference = capture.mock.results.at(-1)!.value;
    let cancelled = false;
    const cancellation = f.bot.handleUpdate(text('/cancel', 10, 10, 9)).then(() => { cancelled = true; });
    await vi.waitFor(() => expect(signal.aborted).toBe(true), { timeout: 2_000, interval: 5 });
    expect(cancelled).toBe(false);
    expect(cleaned).toBe(false);
    expect(execute.mock.calls.find(call => call[1] === 'sticker.cancel')?.[2]).toEqual({});
    expect(f.messages.some(message => richText(message).includes('<late pack>'))).toBe(false);
    finish.resolve(); await Promise.all([opening, cancellation]);
    await vi.waitFor(() => expect(release.mock.calls.some(call => call[1] === reference)).toBe(true), { timeout: 2_000, interval: 5 });
    const releaseContext = release.mock.calls.find(call => call[1] === reference)![0];
    expect(releaseContext.signal.aborted).toBe(false);
    expect(releaseContext).toMatchObject({ actorId: 10, botId: me.id, chat: { id: 10, threadId: 9 } });
    expect(cleaned).toBe(true);
    expect(f.adapter.panels.size).toBe(0);
    expect(f.messages.some(message => richText(message).includes('<late pack>'))).toBe(false);
    expect(f.transport.download).not.toHaveBeenCalled();
    expect(f.convert).not.toHaveBeenCalled();
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.health.recordApiError).not.toHaveBeenCalled();
  });

  it('does not cancel another private topic pending pack lookup', async () => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = gate();
    f.transport.getSet.mockImplementationOnce(async (name, signal) => {
      entered.resolve(signal); await finish.promise;
      return { name, title: 'Other topic pack', stickers: [packFile('static')] };
    });
    const opening = f.bot.handleUpdate(text('/sticker Example_pack', 10, 10, 9));
    const signal = await entered.promise;
    await f.bot.handleUpdate(text('/cancel', 10, 10, 10));
    expect(signal.aborted).toBe(false);
    expect(f.adapter.panels.size).toBe(0);
    finish.resolve(); await opening;
    expect(richText(await packPanel(f, 10, 9))).toContain('Other topic pack');
    expect(f.adapter.panels.size).toBe(1);
    expect(f.last(10, 9).message_thread_id).toBe(9);
    expect(f.transport.send).not.toHaveBeenCalled();
  });

  it('adapter shutdown aborts and awaits detached pack lookup cleanup before settling', async () => {
    const f = await stickerFixture(); const entered = Promise.withResolvers<AbortSignal>(); const finish = gate();
    let cleaned = false;
    f.transport.getSet.mockImplementationOnce(async (name, signal) => {
      entered.resolve(signal); await finish.promise; cleaned = true;
      return { name, title: 'Shutdown pack', stickers: [packFile('static')] };
    });
    const opening = f.bot.handleUpdate(text('https://t.me/addstickers/Example_pack', 10));
    const signal = await entered.promise;
    let stopped = false;
    const stopping = f.adapter.stop().then(() => { stopped = true; });
    expect(signal.aborted).toBe(true);
    await Promise.resolve(); expect(stopped).toBe(false);
    expect(cleaned).toBe(false);
    finish.resolve(); await Promise.all([opening, stopping]);
    expect(cleaned).toBe(true);
    expect(f.adapter.panels.size).toBe(0);
    expect(f.sent()).toEqual([]);
    expect(f.transport.send).not.toHaveBeenCalled();
    expect(f.health.recordApiError).not.toHaveBeenCalled();
  });

  it('disables conversion after an unknown upload outcome and never retries or falls back', async () => {
    const f = await stickerFixture(); f.transport.send.mockRejectedValue(new AppError('OUTCOME_UNKNOWN'));
    await f.bot.handleUpdate(sticker()); const pane = f.last(10); const data = buttonData(pane, 'stformat:png');
    await f.bot.handleUpdate(button(data, pane, 10));
    await vi.waitFor(() => expect(richText(pane)).toContain(t('bot:sticker.uncertain')), { timeout: 2_000, interval: 5 });
    expectNativeSticker(pane);
    expect(callbacks(pane)).toEqual([]);
    await f.bot.handleUpdate(button(data, pane, 10));
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(f.calls.some(call => ['sendPhoto', 'sendAnimation', 'sendDocument'].includes(call.method))).toBe(false);
  });

  it('does not resend when final UI rendering fails after successful Telegram delivery', async () => {
    const f = await stickerFixture(); await f.bot.handleUpdate(sticker());
    const pane = f.last(10); const data = buttonData(pane, 'stformat:png');
    f.fail(call => call.method === 'editMessageText' && richText(call.payload.rich_message).includes('Sent PNG as'));
    await f.bot.handleUpdate(button(data, pane, 10));
    await vi.waitFor(() => expect(f.health.recordApiError).toHaveBeenCalled(), { timeout: 2_000, interval: 5 });
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(richText(pane)).toContain(t('bot:sticker.processing'));
    expectNativeSticker(pane);
    await f.bot.handleUpdate(button(data, pane, 10));
    expect(f.transport.send).toHaveBeenCalledTimes(1);
    expect(f.transport.download).toHaveBeenCalledTimes(1);
    expect(f.convert).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.sent())).not.toContain('secret-token-private-exception');
  });
});
