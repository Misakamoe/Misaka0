import { Bot, Context, GrammyError, InlineKeyboard } from 'grammy';
import type { ChatMember, InputRichMessage, Message, MessageEntity, RichMessageButton, RichText } from 'grammy/types';
import { sequentialize } from '@grammyjs/runner';
import { languagePreferences, supportedLocales } from '../../shared/schemas/index.js';
import { aliasNameSchema, type AliasSnapshot, type AliasMutationResult } from '../../shared/schemas/alias.js';
import { rssIdSchema, type RssList, type RssSubscriptionView } from '../../shared/schemas/rss.js';
import type { RateCurrencies, RateInput, RateResult } from '../../shared/schemas/rate.js';
import type { WeatherLocation, WeatherResult, WeatherSearchInput } from '../../shared/schemas/weather.js';
import { stickerFormatSchema, type StickerDelivery, type StickerResult, type StickerView } from '../../shared/schemas/sticker.js';
import { parseSubconvCustomParams, subconvBooleanFields, subconvPresets, subconvSettingsSchema, subconvSourceCount, subconvSourceSchema,
  subconvTargets, subconvTriStateFields, type SubconvCustomParam, type SubconvResult, type SubconvSettings, type SubconvSnapshot } from '../../shared/schemas/subconv.js';
import type { StickerCapture, StickerService } from '../modules/sticker.js';
import type { CurrencyDefinition } from '../modules/currency.js';
import { isWeatherIntent, parseWeatherIntent } from '../modules/weather.js';
import type {
  ActionResult, Confirmation, GroupPage, Locale, ModuleMetadata, Preference, RuntimeStatus, SettingsSnapshot,
} from '../../shared/schemas/index.js';
import { createInvocation, type ActionExecutor } from '../actions.js';
import type { AccessService } from '../access.js';
import type { StartupConfig } from '../config.js';
import type { ConfigurationService } from '../configuration.js';
import { AppError, safeError, throwIfAborted } from '../errors.js';
import { translator } from '../i18n.js';
import { commands, helpMarkdown, menuCommands, menuLanguages, suggestCommands, visibleCommands } from './commands.js';
import { bestEffort, plainValue, telegramCall, telegramSignal, type ApiHealth } from './effects.js';
import { PanelStore, type Panel, type PanelBinding } from './panels.js';
import { pageBounds, pageSelectionKeyboard, paginate, paginationKeyboard, type PageBounds } from './pagination.js';
import { SessionStore, messageTopicId, sessionKey, type SubconvInputField } from './session.js';
import { commandEntities, panelContent, richButtonRows } from './rich.js';
import { stickerSetName, telegramStickerFile } from './sticker.js';
import type { AiTelegramPort } from '../ai/telegram-port.js';
import { createAiTelegramAdapter } from './ai.js';
import { statusMessage } from './status.js';

export { createTelegramEffects } from './effects.js';
export { SessionStore, sessionKey } from './session.js';

export interface TelegramDependencies {
  config: StartupConfig;
  executor: ActionExecutor;
  access: AccessService;
  configuration: ConfigurationService;
  stickers: StickerService;
  ai?: AiTelegramPort;
  health: ApiHealth & { recordUpdate(): void };
  signal: AbortSignal;
}

interface GroupMutationResult {
  chatId: number;
  revision: number;
  changed: boolean;
  notificationSent: boolean;
  left: boolean;
}

type PanelValue = { language: Locale; generation: number; signature?: string; lastView?: { text: string; entities?: MessageEntity[] } } & (
  | { kind: 'settings'; revision?: number }
  | { kind: 'commands'; page: number }
  | { kind: 'groups'; page: number; revision: number; groups: { id: number; groupRevision: number }[] }
  | { kind: 'approval'; confirmation: Confirmation }
  | { kind: 'alias'; view: 'main' | 'add' | 'remove' | 'input'; page: number; revision: number; targets: string[]; removals: { command: string; alias: string }[] }
  | { kind: 'rss'; view: 'list' | 'item' | 'input'; page: number; items: RssSubscriptionView[]; selected?: RssSubscriptionView }
  | { kind: 'rate'; view: 'result' | 'currencies'; page: number; result?: RateResult }
  | { kind: 'weather'; view: 'input' | 'locations' | 'result'; mode: 'current' | 'forecast'; days: number; locations: WeatherLocation[]; result?: WeatherResult; defaultRevision?: number }
  | { kind: 'sticker'; info: StickerView; delivery: StickerDelivery; busy: boolean; uncertain: boolean }
  | { kind: 'subconv'; snapshot: SubconvSnapshot; source: string; customParams: SubconvCustomParam[];
    view: 'main' | 'targets' | 'presets' | 'options' | 'filters' | 'input' | 'result'; page: number; input?: SubconvInputField; result?: SubconvResult }
);
type CorePanel = Panel<PanelValue>;
interface PanelView { text: string; preformatted?: string; keyboard?: InlineKeyboard; buttonRows?: RichMessageButton[][]; buttonRowLabels?: Record<number, RichText>; entities?: MessageEntity[] }

const subconvInputFields = ['source', 'backend', 'remoteConfig', 'include', 'exclude', 'filename', 'customParams'] as const;
const subconvFlags = [...subconvBooleanFields, ...subconvTriStateFields];

function panelCallback(data: string) {
  const subconv = /^mk:ui:(u):([a-f0-9]{24}):(0|[1-9]\d{0,5}):(uhome|utargets|upresets|uoptions|ufilters|ugenerate|ureset|uclear|uinput:[0-6]|utarget:[0-5]|upreset:[0-6]|uflag:(?:[0-9]|1[01])|upage:[01])$/.exec(data);
  if (subconv) {
    const [operation, argument] = subconv[4]!.split(':');
    return { route: subconv[1]!, id: subconv[2]!, generation: Number(subconv[3]), operation: operation!, argument };
  }
  const match = /^mk:ui:([scgarfwk]):([a-f0-9]{24}):(0|[1-9]\d{0,5}):(page:(?:0|[1-9]\d{0,5})|pick(?::(?:0|[1-9]\d{0,5}))?|lang:[a-zA-Z-]+|corelang:[a-zA-Z-]+|revoke:-[1-9]\d{0,15}|confirm|aliasadd|aliasremove|aliashome|aliastarget:(?:0|[1-9]\d{0,5})|aliasdelete:(?:0|[1-9]\d{0,5})|rssadd|rsshome|rsssilent|rsspause|rssremove|rssitem:(?:0|[1-9]\d{0,5})|fcurrencies|fswap|fchoose:(?:0|[1-9]\d{0,5})|wcurrent|wforecast|wsave|wclear|wlocation:(?:0|[1-9]\d{0,5})|stmode:(?:media|file)|stformat:(?:original|png|jpg|webp|gif)|stpack|stcancel)$/.exec(data);
  if (!match) return undefined;
  const [operation, argument] = match[4]!.split(':');
  if ((operation === 'page' || operation === 'pick') && Number(argument) > 100_000) return undefined;
  if (operation === 'lang' && !languagePreferences.some(language => language === argument)) return undefined;
  if (operation === 'corelang' && !supportedLocales.some(language => language === argument)) return undefined;
  return { route: match[1]!, id: match[2]!, generation: Number(match[3]), operation: operation!, argument };
}

const reopenCommands = { s: 'settings', c: 'commands', g: 'listgroups', a: 'alias', r: 'rss', f: 'rate', w: 'weather', k: 'sticker', u: 'subconv' } as const;
type ReopenRoute = keyof typeof reopenCommands;
function reopenCallback(data: string): { route: ReopenRoute; userId: number } | undefined {
  const match = /^mk:open:([scgarfwku]):([1-9]\d{0,15})$/.exec(data);
  if (!match || !Number.isSafeInteger(Number(match[2]))) return undefined;
  return { route: match[1] as ReopenRoute, userId: Number(match[2]) };
}
function panelRoute(panel: CorePanel): ReopenRoute {
  if (panel.value.kind === 'subconv') return 'u';
  return panel.value.kind === 'settings' ? 's' : panel.value.kind === 'commands' ? 'c' : panel.value.kind === 'alias' ? 'a' : panel.value.kind === 'rss' ? 'r' : panel.value.kind === 'rate' ? 'f' : panel.value.kind === 'weather' ? 'w' : panel.value.kind === 'sticker' ? 'k' : 'g';
}

function operationAllowed(panel: CorePanel, operation: string): boolean {
  switch (panel.value.kind) {
    case 'settings': return operation === 'lang' || operation === 'corelang' && panel.value.revision !== undefined;
    case 'commands': return operation === 'page' || operation === 'pick';
    case 'groups': return operation === 'page' || operation === 'pick' || operation === 'revoke';
    case 'approval': return operation === 'confirm';
    case 'alias': return ['aliasadd', 'aliasremove', 'aliashome'].includes(operation)
      || ['page', 'pick'].includes(operation) && panel.value.view !== 'input'
       || operation === 'aliastarget' && panel.value.view === 'add' || operation === 'aliasdelete' && panel.value.view === 'remove';
    case 'rss': return ['rsshome', 'rssadd'].includes(operation)
      || panel.value.view === 'list' && ['page', 'pick', 'rssitem'].includes(operation)
      || panel.value.view === 'item' && ['rsssilent', 'rsspause', 'rssremove'].includes(operation);
    case 'rate': return operation === 'fcurrencies' || operation === 'page' || operation === 'pick'
      || operation === 'fswap' && panel.value.result?.kind === 'converted' || operation === 'fchoose' && panel.value.result?.kind === 'ambiguous';
    case 'weather': return operation === 'wlocation' && panel.value.view === 'locations'
      || ['wcurrent', 'wforecast'].includes(operation) && panel.value.result !== undefined
       || ['wsave', 'wclear'].includes(operation) && panel.value.defaultRevision !== undefined;
    case 'sticker': return !panel.value.uncertain && (panel.value.busy ? operation === 'stcancel'
      : operation === 'stformat' || operation === 'stmode' && panel.value.info.kind === 'single'
         || operation === 'stpack' && panel.value.info.kind === 'single' && panel.value.info.setName !== undefined);
    case 'subconv': return operation === 'uhome'
      || panel.value.view === 'main' && ['utargets', 'upresets', 'uoptions', 'ufilters', 'ugenerate', 'ureset', 'uinput'].includes(operation)
      || panel.value.view === 'targets' && operation === 'utarget'
      || panel.value.view === 'presets' && ['upreset', 'uinput'].includes(operation)
      || panel.value.view === 'options' && ['uflag', 'upage'].includes(operation)
      || panel.value.view === 'filters' && operation === 'uinput'
      || panel.value.view === 'input' && operation === 'uclear';
  }
}

function subconvArgumentAllowed(panel: CorePanel, operation: string, argument?: string): boolean {
  if (panel.value.kind !== 'subconv') return true;
  const index = Number(argument);
  if (operation === 'uinput') return (panel.value.view === 'main' ? [0, 1, 6] : panel.value.view === 'presets' ? [2] : [3, 4, 5]).includes(index);
  if (operation === 'uflag') return index >= panel.value.page * 6 && index < (panel.value.page + 1) * 6 && subconvFlags[index] !== undefined;
  if (operation === 'utarget') return subconvTargets[index] !== undefined;
  if (operation === 'upreset') return subconvPresets[index] !== undefined;
  if (operation === 'upage') return index === 0 || index === 1;
  return operation !== 'uclear' || panel.value.input !== undefined;
}

function memberPresent(member: ChatMember): boolean {
  return member.status === 'creator' || member.status === 'administrator' || member.status === 'member'
    || member.status === 'restricted' && member.is_member;
}

function commandOf(ctx: Context, resolve: (name: string) => string | undefined): { name: string; argument: string } | undefined {
  const message = ctx.update.message;
  const text = message?.text ?? message?.caption;
  if (!text) return undefined;
  const match = /^\/([^\s/@]+)(?:@([a-z0-9_]+))?(?=\s|$)([\s\S]*)$/i.exec(text);
  if (!match || match[2] && match[2].toLowerCase() !== ctx.me.username.toLowerCase()
    || (message?.entities ?? message?.caption_entities)?.some(entity => ['code', 'pre'].includes(entity.type) && entity.offset === 0)) return undefined;
  const name = aliasNameSchema.safeParse(match[1]);
  if (!name.success) return undefined;
  return { name: commands.some(command => command.name === name.data) ? name.data : resolve(name.data) ?? name.data, argument: match[3]!.trim() };
}

function supportedMessage(ctx: Context): Message | undefined {
  return sessionKey(ctx) ? ctx.update.message ?? ctx.update.callback_query?.message : undefined;
}

function mentionsBot(ctx: Context): boolean {
  const message = ctx.update.message;
  const text = message?.text ?? message?.caption ?? '';
  return (message?.entities ?? message?.caption_entities ?? []).some(entity =>
    entity.type === 'mention' && text.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${ctx.me.username.toLowerCase()}`
    || entity.type === 'text_mention' && entity.user.id === ctx.me.id);
}

export function createTelegramAdapter(bot: Bot, deps: TelegramDependencies) {
  const { config, executor, access, configuration, stickers, health } = deps;
  const shutdown = new AbortController();
  const signal = telegramSignal(AbortSignal.any([deps.signal, shutdown.signal]));
  const sessions = new SessionStore();
  const inFlight = new Set<Promise<void>>();
  const stickerOpenings = new Set<{ key: string; controller: AbortController }>();
  let stopped = false;
  const languageOf = (ctx: Context) => configuration.resolveLanguage(ctx.from!.id, ctx.from?.language_code);
  const call = <T>(operation: () => Promise<T>) => telegramCall(health, signal, operation);
  const ai = createAiTelegramAdapter(bot, { ai: deps.ai, executor, access, configuration, health, signal, token: config.botToken });

  const edit = (operation: () => Promise<unknown>) => call(async () => {
    try { await operation(); }
    catch (error) {
      if (!(error instanceof GrammyError && error.error_code === 400
        && error.description.startsWith('Bad Request: message is not modified'))) throw error;
    }
  });
  const panels = new PanelStore<PanelValue>({ onClose: async (panel, reason) => {
    if (panel.value.kind === 'sticker') stickers.release(createInvocation({
      actorId: panel.binding.userId, botId: panel.binding.botId, source: 'telegram', language: panel.value.language,
      chat: { id: panel.binding.chatId, type: 'private', threadId: panel.binding.threadId },
    }), panel.value.info.source);
    if (sessions.get(panel.binding.key)?.aliasInput?.panelId === panel.id) sessions.delete(panel.binding.key);
    if (sessions.get(panel.binding.key)?.rssInput?.panelId === panel.id) sessions.delete(panel.binding.key);
    if (sessions.get(panel.binding.key)?.weatherInput?.panelId === panel.id) sessions.delete(panel.binding.key);
    if (sessions.get(panel.binding.key)?.subconvInput?.panelId === panel.id) clearSubconvInput(panel.binding.key);
    if (panel.value.kind === 'subconv') {
      panel.value.source = ''; panel.value.customParams = []; delete panel.value.result; delete panel.value.input; delete panel.value.signature; delete panel.value.lastView;
      if (stopped || signal.aborted || panel.messageId === undefined) return;
      const t = translator(panel.value.language);
      const rich = panelContent(`${t('bot:subconv.title')}\n${t(reason === 'cancelled' ? 'bot:subconv.cancelled' : 'bot:subconv.expired')}`,
        [], [[reopenButton('u', panel.binding.userId, panel.value.language)]]);
      await edit(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, rich, { reply_markup: { inline_keyboard: [] } }, signal));
      return;
    }
    if (stopped || signal.aborted || panel.messageId === undefined) return;
    if (panel.value.kind === 'sticker') {
      const t = translator(panel.value.language);
      const view = stickerView(panel, t(reason === 'cancelled' ? 'bot:sticker.cancelled' : 'bot:sticker.expired'), true);
      await edit(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, panelContent(view.text, view.entities, view.buttonRows, view.buttonRowLabels), {
        reply_markup: { inline_keyboard: [] },
      }, signal));
      return;
    }
    const view = panel.value.lastView ?? { text: translator(panel.value.language)('bot:expired') };
    const rich = panelContent(view.text, view.entities, [[reopenButton(panelRoute(panel), panel.binding.userId, panel.value.language)]]);
    await edit(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, rich, {
      reply_markup: { inline_keyboard: [] },
    }, signal));
  } });

  function binding(ctx: Context): PanelBinding {
    const message = supportedMessage(ctx)!;
    return { key: sessionKey(ctx)!, botId: ctx.me.id, chatId: message.chat.id, userId: ctx.from!.id,
      threadId: messageTopicId(message), language: languageOf(ctx) };
  }

  function callbackPanel(ctx: Context, id: string, operation: string): CorePanel {
    const message = supportedMessage(ctx)!;
    const shareWeather = message.chat.type !== 'private' && access.isAllowed(message.chat.id)
      && (operation === 'wcurrent' || operation === 'wforecast');
    return panels.get(id, { ...binding(ctx), messageId: message.message_id }, shareWeather
      ? value => value.kind === 'weather' && value.view === 'result' && value.result !== undefined && value.defaultRevision === undefined
      : undefined);
  }

  function callbackData(panel: CorePanel, operation: string): string {
    const data = `mk:ui:${panelRoute(panel)}:${panel.id}:${panel.value.generation}:${operation}`;
    if (Buffer.byteLength(data) > 64) throw new AppError('INVALID_OUTPUT');
    return data;
  }

  function refreshGeneration(panel: CorePanel): void {
    if (panel.value.generation >= 999_999) throw new AppError('CONFIRMATION_EXPIRED');
    panel.value.generation += 1;
  }

  function reopenButton(route: ReopenRoute, userId: number, language: Locale) {
    const t = translator(language);
    return { text: t('bot:panels.reopen', { command: reopenCommands[route] }), callback_data: `mk:open:${route}:${userId}` };
  }

  function closedKeyboard(route: ReopenRoute, userId: number, language: Locale): InlineKeyboard {
    const button = reopenButton(route, userId, language);
    return new InlineKeyboard().text(button.text, button.callback_data);
  }

  async function createPanel(ctx: Context, value: PanelValue): Promise<CorePanel> {
    const owner = binding(ctx);
    await panels.closeOwned(owner.key, 'replaced', panel => panel.value.kind === value.kind);
    return panels.create(owner, value, value.kind === 'commands' || value.kind === 'rate' ? null : undefined);
  }

  async function displayPanel(panel: CorePanel, view: PanelView, replyTo?: number): Promise<void> {
    if (view.text.length > 4096) { await panels.close(panel, 'expired'); throw new AppError('INVALID_OUTPUT'); }
    if (view.preformatted !== undefined && (view.preformatted.length > 24_576 || !/^[\x21-\x7e]+$/.test(view.preformatted))) {
      await panels.close(panel, 'expired'); throw new AppError('INVALID_OUTPUT');
    }
    const converted = view.keyboard && richButtonRows(view.keyboard);
    const replyMarkup = converted === undefined && view.keyboard
      ? { ...view.keyboard, inline_keyboard: view.keyboard.inline_keyboard.filter(row => row.length) }
      : { inline_keyboard: [] };
    const rows = [...(view.buttonRows ?? []), ...(converted ?? [])];
    const content = panelContent(view.text, view.entities, rows, view.buttonRowLabels);
    const rich: InputRichMessage = view.preformatted === undefined ? content : {
      ...content, blocks: [content.blocks[0], { type: 'pre', text: view.preformatted }, ...content.blocks.slice(1)], skip_entity_detection: true,
    };
    const signature = JSON.stringify({ rich, keyboard: replyMarkup });
    if (panel.messageId === undefined) {
      try {
        panel.value.lastView = { text: view.text, entities: view.entities };
        const message = await call(() => bot.api.sendRichMessage(panel.binding.chatId, rich, {
          message_thread_id: panel.binding.threadId, reply_markup: replyMarkup,
          ...(replyTo === undefined ? {} : { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }),
        }, signal));
        // Opening sends are tracked by the update handler. Never await attach inside render's queue.
        await panels.attach(panel, message.message_id);
        panel.value.signature = signature;
      } catch (error) { await panels.close(panel, 'expired'); throw error; }
    } else {
      await panels.render(panel, async () => {
        if (panel.value.signature === signature) return;
        await edit(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, rich, { reply_markup: replyMarkup }, signal));
        panel.value.lastView = { text: view.text, entities: view.entities };
        panel.value.signature = signature;
      });
    }
  }

  function navigation(panel: CorePanel, bounds: PageBounds): InlineKeyboard {
    const t = translator(panel.value.language);
    return paginationKeyboard(bounds, page => callbackData(panel, `page:${page}`), {
      previous: t('bot:panels.previous'), next: t('bot:panels.next'),
      page: (page, pages) => t('bot:panels.page', { page, pages }),
    }, callbackData(panel, 'pick'));
  }

  function pageSelection(panel: CorePanel, bounds: PageBounds, window?: number): PanelView {
    const t = translator(panel.value.language);
    return {
      text: t('bot:panels.selectPage', { page: bounds.page + 1, pages: bounds.pages }),
      keyboard: pageSelectionKeyboard(bounds, {
        page: page => callbackData(panel, `page:${page}`), window: window => callbackData(panel, `pick:${window}`),
        back: callbackData(panel, `page:${bounds.page}`),
      }, { previous: t('bot:panels.previous'), next: t('bot:panels.next'), back: t('bot:panels.back') }, window),
    };
  }

  async function expireUnknown(ctx: Context): Promise<void> {
    const message = supportedMessage(ctx);
    if (!message || message.from?.id !== ctx.me.id || panels.hasMessage(ctx.me.id, message.chat.id, message.message_id)) return;
    const controls = [...(message.reply_markup?.inline_keyboard.flat() ?? []),
      ...(message.rich_message?.blocks.flatMap(block => block.type === 'buttons' ? block.buttons : []) ?? [])];
    const buttons = controls.flatMap(button => 'callback_data' in button ? [button.callback_data] : []);
    if (!buttons.length) return;
    const closed = buttons.map(reopenCallback).find(Boolean);
    if (closed && closed.userId !== ctx.from!.id) return;
    const recorded = closed?.route ?? buttons.map(panelCallback).find(Boolean)?.route as ReopenRoute | undefined;
    const legacy = buttons.join(' ');
    const route = recorded ?? (/subconv|mk:ui:u:/.test(legacy) ? 'u' : /(?:^|:)(?:lang|corelang):/.test(legacy) ? 's'
      : /(?:^|:)(?:revoke|confirm|groups):/.test(legacy) ? 'g' : /alias/.test(legacy) ? 'a' : 'c');
    if (route === 'u' && (message.chat.type !== 'private' || message.chat.id !== ctx.from!.id)) return;
    if (route === 'k' || route === 'u') {
      const language = languageOf(ctx);
      const t = translator(language);
      const module = route === 'k' ? 'sticker' : 'subconv';
      const rich = panelContent(`${t(`bot:${module}.title`)}\n${t(`bot:${module}.expired`)}`, [], [[reopenButton(route, ctx.from!.id, language)]]);
      await bestEffort(() => edit(() => bot.api.editMessageText(message.chat.id, message.message_id, rich, {
        reply_markup: { inline_keyboard: [] },
      }, signal)));
      return;
    }
    const plain = (text: RichText): string => typeof text === 'string' ? text : Array.isArray(text) ? text.map(plain).join('')
      : 'text' in text ? plain(text.text) : text.type === 'button' ? plain(text.button.text) : '';
    const text = message.rich_message?.blocks.filter(block => block.type === 'paragraph').map(block => plain(block.text)).join('\n\n')
      || message.text || translator(languageOf(ctx))('bot:expired');
    const rich = panelContent(text, [], [[reopenButton(route, ctx.from!.id, languageOf(ctx))]]);
    await bestEffort(() => edit(() => bot.api.editMessageText(message.chat.id, message.message_id, rich, {
      reply_markup: { inline_keyboard: [] },
    }, signal)));
  }

  function invocation(ctx: Context, phase = '') {
    const message = supportedMessage(ctx)!;
    const type = message.chat.type as 'private' | 'group' | 'supergroup';
    const topic = messageTopicId(message);
    return createInvocation({
      actorId: ctx.from!.id, source: 'telegram', botId: ctx.me.id,
      chat: { id: message.chat.id, type, ...(topic === undefined ? {} : { threadId: topic }) },
      language: languageOf(ctx), languageHint: ctx.from?.language_code,
      invocationId: `telegram:${ctx.me.id}:${ctx.update.update_id}${phase ? `:${phase}` : ''}`, signal,
    });
  }

  async function send(ctx: Context, text: string, keyboard?: InlineKeyboard, entities?: MessageEntity[]): Promise<void> {
    const message = supportedMessage(ctx);
    if (!message) return;
    if (text.length > 4096) { text = translator(languageOf(ctx))('bot:outputTooLong'); entities = undefined; }
    if (keyboard) {
      const rows = richButtonRows(keyboard);
      await call(() => bot.api.sendRichMessage(message.chat.id, panelContent(text, entities, rows), {
        message_thread_id: messageTopicId(message), reply_markup: rows === undefined ? keyboard : { inline_keyboard: [] },
        reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
      }, signal));
      return;
    }
    await call(() => bot.api.sendMessage(message.chat.id, text, {
      message_thread_id: messageTopicId(message),
      entities,
      reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
    }, signal));
  }

  async function sendError(ctx: Context, code: string): Promise<void> {
    await send(ctx, translator(languageOf(ctx))(code === 'CONFIRMATION_EXPIRED' ? 'bot:expired' : `common:errors.${code}`));
  }

  async function confirmation(ctx: Context, pending: Confirmation): Promise<void> {
    if (!['groups.authorize', 'groups.revoke'].includes(pending.actionId)) throw new AppError('INVALID_OUTPUT');
    const owner = binding(ctx);
    await panels.closeOwned(owner.key, 'replaced', panel => panel.value.kind === 'approval'
      && panel.value.confirmation.actionId === pending.actionId && panel.value.confirmation.target === pending.target);
    const panel = panels.create(owner, { kind: 'approval', language: owner.language, generation: 0, confirmation: pending }, Date.parse(pending.expiresAt));
    const t = translator(owner.language);
    const key = pending.actionId === 'groups.authorize' ? 'confirmAuthorize' : 'confirmRevoke';
    const keyboard = new InlineKeyboard().text(t('common:actions.confirm'), callbackData(panel, 'confirm'));
    if (pending.actionId === 'groups.revoke') keyboard.danger();
    else keyboard.success();
    await displayPanel(panel, { text: t(`bot:groups.${key}`, { chatId: plainValue(pending.target.replace(/^chat:/, '')) }), keyboard }, supportedMessage(ctx)!.message_id);
  }

  async function resultData<T>(ctx: Context, result: ActionResult<T>): Promise<T | undefined> {
    if (result.status === 'succeeded') return result.data;
    if (result.status === 'pending_confirmation') await confirmation(ctx, result.confirmation);
    else {
      if (result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
      await sendError(ctx, result.error.code);
    }
    return undefined;
  }

  function mutationText(ctx: Context, action: string, data: GroupMutationResult): string {
    const t = translator(languageOf(ctx));
    const yesNo = (value: boolean) => t(value ? 'common:yes' : 'common:no');
    return t(action === 'groups.authorize' ? 'bot:groups.authorizeReceipt' : 'bot:groups.revokeReceipt', {
      chatId: data.chatId, changed: yesNo(data.changed), notified: yesNo(data.notificationSent), left: yesNo(data.left),
    });
  }

  async function mutationReceipt(ctx: Context, action: string, result: ActionResult<GroupMutationResult>): Promise<void> {
    const data = await resultData(ctx, result);
    if (data) await send(ctx, mutationText(ctx, action, data));
  }

  async function showCommands(ctx: Context, requestedPage = 0, current?: CorePanel, selection?: { window?: number }): Promise<void> {
    const message = supportedMessage(ctx)!;
    const language = languageOf(ctx);
    const t = translator(language);
    const page = paginate(visibleCommands(access.isAdmin(ctx.from!.id), message.chat.type === 'private'), requestedPage, 6);
    const panel = current ?? await createPanel(ctx, { kind: 'commands', language, generation: 0, page: page.page });
    if (panel.value.kind !== 'commands') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    panel.value.language = language;
    panel.value.page = page.page;
    let text = t('bot:catalog.heading', { page: page.page + 1, pages: page.pages, total: page.total });
    const entities: MessageEntity[] = [];
    for (const command of page.items) {
      const aliases = executor.aliasesFor(command.name);
      const label = `/${command.name}${aliases.length ? ` (${aliases.map(alias => `/${alias}`).join(', ')})` : ''}`;
      entities.push(...commandEntities(label, text.length + 1));
      text += `\n${label} - ${t(`bot:commands.${command.name}`)}`;
    }
    const hint = t('bot:catalog.hint');
    entities.push(...commandEntities(hint, text.length + 2));
    text += `\n\n${hint}`;
    await displayPanel(panel, selection ? pageSelection(panel, page, selection.window) : { text, entities, keyboard: navigation(panel, page) }, message.message_id);
  }

  async function showGroups(ctx: Context, page: number, current?: CorePanel, notice?: string, selection?: { window?: number }): Promise<void> {
    let data = await resultData(ctx, await executor.execute<GroupPage>(invocation(ctx), 'groups.list', { page }));
    if (!data) return;
    let bounds = pageBounds(data.total, data.page, data.pageSize);
    if (data.total && bounds.page !== data.page) {
      data = await resultData(ctx, await executor.execute<GroupPage>(invocation(ctx, 'page-bounds'), 'groups.list', { page: bounds.page }));
      if (!data) return;
      bounds = pageBounds(data.total, data.page, data.pageSize);
      if (data.total && bounds.page !== data.page) {
        data = await resultData(ctx, await executor.execute<GroupPage>(invocation(ctx, 'page-origin'), 'groups.list', { page: 0 }));
        if (!data) return;
        bounds = pageBounds(data.total, data.page, data.pageSize);
      }
    }
    const language = languageOf(ctx);
    const t = translator(language);
    const panel = current ?? await createPanel(ctx, { kind: 'groups', language, generation: 0, page: bounds.page, revision: data.revision, groups: [] });
    if (panel.value.kind !== 'groups') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    Object.assign(panel.value, { language, page: bounds.page, revision: data.revision,
      groups: selection ? [] : data.items.map(group => ({ id: group.id, groupRevision: group.groupRevision })) });
    if (selection) {
      await displayPanel(panel, pageSelection(panel, bounds, selection.window), supportedMessage(ctx)!.message_id);
      return;
    }
    let text = data.total ? t('bot:groups.heading', { page: bounds.page + 1, pages: bounds.pages, total: data.total }) : t('bot:groups.empty');
    const entities: MessageEntity[] = [];
    for (const group of data.items) {
      const at = new Intl.DateTimeFormat(languageOf(ctx), { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(group.authorizedAt)) + ' UTC';
      const row = t('bot:groups.row', { title: plainValue(group.title), chatId: group.id, at, present: t(group.present ? 'common:yes' : 'common:no') });
      entities.push({ type: 'date_time', offset: text.length + 2 + row.lastIndexOf(at), length: at.length,
        unix_time: Math.floor(Date.parse(group.authorizedAt) / 1000), date_time_format: 'Dt' });
      text += `\n\n${row}`;
    }
    const keyboard = new InlineKeyboard();
    for (const group of data.items) keyboard.text(t('bot:groups.revoke', { chatId: group.id }), callbackData(panel, `revoke:${group.id}`)).danger().row();
    keyboard.add(...navigation(panel, bounds).inline_keyboard.flat());
    if (notice) text += `\n\n${notice}`;
    await displayPanel(panel, { text, keyboard, entities }, supportedMessage(ctx)!.message_id);
  }

  async function showSettings(ctx: Context, current?: CorePanel, notice?: string): Promise<void> {
    const preference = await resultData(ctx, await executor.execute<Preference>(invocation(ctx), 'preferences.get', {}));
    if (!preference) return;
    const settings = access.isAdmin(ctx.from!.id)
      ? await resultData(ctx, await executor.execute<SettingsSnapshot>(invocation(ctx), 'core.settings.get', {})) : undefined;
    if (access.isAdmin(ctx.from!.id) && !settings) return;
    const language = languageOf(ctx);
    const t = translator(language);
    const panel = current ?? await createPanel(ctx, { kind: 'settings', language, generation: 0, revision: settings?.revision });
    if (panel.value.kind !== 'settings') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    panel.value.language = language;
    panel.value.revision = settings?.revision;
    const keyboard = new InlineKeyboard().disabled(t('bot:settings.personalTitle')).row();
    for (const [index, choice] of languagePreferences.entries()) {
      if (index && index % 3 === 0) keyboard.row();
      keyboard.text(t(`common:languages.${choice}`), callbackData(panel, `lang:${choice}`));
      if (choice === preference.language) keyboard.primary();
    }
    let text = t('bot:settings.personal', {
      language: t(`common:languages.${preference.language}`), resolved: t(`common:languages.${preference.resolvedLanguage}`),
    });
    if (settings) {
      keyboard.row().disabled(t('bot:settings.coreTitle')).row();
      for (const [index, choice] of supportedLocales.entries()) {
        if (index && index % 2 === 0) keyboard.row();
        keyboard.text(t('bot:settings.defaultLanguage', { language: t(`common:languages.${choice}`) }), callbackData(panel, `corelang:${choice}`));
        if (choice === settings.saved.defaultLanguage) keyboard.primary();
      }
      text += `\n\n${t('bot:settings.core', {
        saved: t(`common:languages.${settings.saved.defaultLanguage}`),
        effective: t(`common:languages.${settings.effective.defaultLanguage}`), restart: t(settings.requiresRestart ? 'common:yes' : 'common:no'),
      })}`;
    }
    if (notice) text = `${notice}\n\n${text}`;
    await displayPanel(panel, { text, keyboard }, supportedMessage(ctx)!.message_id);
  }

  function aliasNotice(ctx: Context, result: ActionResult<AliasMutationResult>, operation: 'add' | 'remove'): string {
    const t = translator(languageOf(ctx));
    if (result.status === 'succeeded') return t(operation === 'add' ? 'bot:alias.added' : 'bot:alias.removed', result.data);
    if (!('error' in result)) return t('common:errors.INVALID_OUTPUT');
    if (result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
    if (result.error.code === 'INVALID_INPUT' && result.error.fields?.includes('alias')) return t('bot:alias.invalidName');
    if (result.error.code === 'NOT_FOUND' && result.error.fields?.includes('command')) return t('bot:alias.unknownCommand');
    if (result.error.code === 'CONFLICT') return t(result.error.fields?.includes('alias') ? 'bot:alias.collision' : 'bot:alias.changed');
    return t(`common:errors.${result.error.code}`);
  }

  async function showAliases(ctx: Context, view: 'main' | 'add' | 'remove' = 'main', requestedPage = 0, current?: CorePanel, notice?: string, selection?: { window?: number }): Promise<void> {
    const snapshot = await resultData(ctx, await executor.execute<AliasSnapshot>(invocation(ctx, 'alias-view'), 'alias.list', {}));
    if (!snapshot) return;
    sessions.delete(sessionKey(ctx));
    const language = languageOf(ctx);
    const t = translator(language);
    const panel = current ?? await createPanel(ctx, { kind: 'alias', language, generation: 0, view, page: 0, revision: snapshot.revision, targets: [], removals: [] });
    if (panel.value.kind !== 'alias') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    const targets = commands.filter(command => view === 'add' || (snapshot.aliases[command.name]?.length ?? 0) > 0).map(command => command.name);
    const removals = commands.flatMap(command => (snapshot.aliases[command.name] ?? []).map(alias => ({ command: command.name, alias })));
    const bounds = pageBounds(view === 'remove' ? removals.length : targets.length, requestedPage, 6);
    Object.assign(panel.value, { language, view, page: bounds.page, revision: snapshot.revision,
      targets: view === 'add' && !selection ? targets.slice(bounds.start, bounds.end) : [],
      removals: view === 'remove' && !selection ? removals.slice(bounds.start, bounds.end) : [],
    });
    if (selection) { await displayPanel(panel, pageSelection(panel, bounds, selection.window), supportedMessage(ctx)!.message_id); return; }
    let text = t(view === 'main' ? 'bot:alias.title' : view === 'add' ? 'bot:alias.chooseCommand' : 'bot:alias.chooseAlias');
    const entities: MessageEntity[] = [];
    const keyboard = new InlineKeyboard();
    if (view === 'main') {
      text += `\n\n${t('bot:alias.description')}`;
      for (const command of targets.slice(bounds.start, bounds.end)) {
        const row = `/${command} (${snapshot.aliases[command]!.map(alias => `/${alias}`).join(', ')})`;
        entities.push(...commandEntities(row, text.length + 2)); text += `\n\n${row}`;
      }
      if (!targets.length) text += `\n\n${t('bot:alias.empty')}`;
      keyboard.text(t('bot:alias.add'), callbackData(panel, 'aliasadd')).success()
        .text(t('bot:alias.remove'), callbackData(panel, 'aliasremove')).danger().row();
    } else if (view === 'add') {
      panel.value.targets.forEach((command, index) => keyboard.text(`/${command} - ${t(`bot:commands.${command}`)}`, callbackData(panel, `aliastarget:${index}`)).row());
    } else {
      if (!removals.length) text += `\n\n${t('bot:alias.empty')}`;
      panel.value.removals.forEach((entry, index) => keyboard.text(`/${entry.alias} (/${entry.command})`, callbackData(panel, `aliasdelete:${index}`)).danger().row());
    }
    keyboard.add(...navigation(panel, bounds).inline_keyboard.flat());
    if (view !== 'main') keyboard.row().text(t('bot:panels.back'), callbackData(panel, 'aliashome'));
    if (notice) {
      entities.push(...commandEntities(notice, text.length + 2));
      text += `\n\n${notice}`;
    }
    await displayPanel(panel, { text, entities, keyboard }, supportedMessage(ctx)!.message_id);
  }

  async function aliasCommand(ctx: Context, argument: string): Promise<void> {
    const parts = argument.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || parts[0] === 'list' && parts.length === 1) { await showAliases(ctx); return; }
    const operation = parts[0]?.toLowerCase();
    if ((operation === 'add' || operation === 'remove') && parts.length === 1) { await showAliases(ctx, operation); return; }
    if ((operation !== 'add' && operation !== 'remove') || parts.length !== 3) { await send(ctx, translator(languageOf(ctx))('bot:alias.usage')); return; }
    const snapshot = await resultData(ctx, await executor.execute<AliasSnapshot>(invocation(ctx, 'alias-before'), 'alias.list', {}));
    if (!snapshot) return;
    const result = await executor.execute<AliasMutationResult>(invocation(ctx), `alias.${operation}`, {
      command: parts[1]!.replace(/^\//, ''), alias: parts[2]!.replace(/^\//, ''), revision: snapshot.revision,
    });
    await showAliases(ctx, 'main', 0, undefined, aliasNotice(ctx, result, operation));
  }

  async function aliasInput(ctx: Context): Promise<boolean> {
    const pending = sessions.get(sessionKey(ctx))?.aliasInput;
    if (!pending || !ctx.message?.text) return false;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.message_id !== pending.messageId) return false;
    sessions.delete(sessionKey(ctx));
    if (ctx.message.chat.type !== 'private' || !access.isAdmin(ctx.from!.id)) { await sendError(ctx, 'FORBIDDEN'); return true; }
    let panel: CorePanel;
    try { panel = panels.get(pending.panelId, { ...binding(ctx), messageId: pending.messageId }); }
    catch {
      await send(ctx, translator(languageOf(ctx))('bot:expired'), closedKeyboard('a', ctx.from!.id, languageOf(ctx)));
      return true;
    }
    if (panel.value.kind !== 'alias' || panel.value.view !== 'input') return true;
    const result = await executor.execute<AliasMutationResult>(invocation(ctx), 'alias.add', {
      command: pending.command, alias: ctx.message.text, revision: pending.revision,
    });
    await showAliases(ctx, 'main', 0, panel, aliasNotice(ctx, result, 'add'));
    return true;
  }

  async function aliasCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'alias') return;
    if (operation === 'aliasadd' || operation === 'aliasremove' || operation === 'aliashome') {
      await showAliases(ctx, operation === 'aliasadd' ? 'add' : operation === 'aliasremove' ? 'remove' : 'main', 0, panel); return;
    }
    if (operation === 'page' || operation === 'pick') {
      if (panel.value.view === 'input') return;
      await showAliases(ctx, panel.value.view, operation === 'pick' ? panel.value.page : Number(argument), panel, undefined,
        operation === 'pick' ? { window: argument === undefined ? undefined : Number(argument) } : undefined); return;
    }
    if (operation === 'aliastarget') {
      const command = panel.value.targets[Number(argument)];
      if (!command || panel.messageId === undefined) throw new AppError('FORBIDDEN');
      refreshGeneration(panel);
      panel.value.language = languageOf(ctx);
      panel.value.view = 'input'; panel.value.targets = []; panel.value.removals = [];
      sessions.set(sessionKey(ctx), { aliasInput: { panelId: panel.id, messageId: panel.messageId, command, revision: panel.value.revision } });
      const t = translator(languageOf(ctx));
      const text = t('bot:alias.input', { command });
      await displayPanel(panel, { text, entities: commandEntities(text), keyboard: new InlineKeyboard().text(t('common:actions.cancel'), callbackData(panel, 'aliashome')) });
      return;
    }
    if (operation === 'aliasdelete') {
      const entry = panel.value.removals[Number(argument)];
      if (!entry) throw new AppError('FORBIDDEN');
      const result = await executor.execute<AliasMutationResult>(invocation(ctx), 'alias.remove', { ...entry, revision: panel.value.revision });
      await showAliases(ctx, 'remove', panel.value.page, panel, aliasNotice(ctx, result, 'remove'));
    }
  }

  function rssNotice(ctx: Context, result: ActionResult, success = 'saved'): string {
    const t = translator(languageOf(ctx));
    if (result.status === 'succeeded') return t(`bot:rss.${success}`);
    if (!('error' in result)) return t('common:errors.INVALID_OUTPUT');
    if (result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
    const field = result.error.fields?.find(field => /^rss\.[A-Z_]+$/.test(field));
    return field ? t(`bot:rss.errors.${field.slice(4)}`) : t(`common:errors.${result.error.code}`);
  }

  async function showRss(ctx: Context, page = 0, current?: CorePanel, notice?: string, selectedId?: string, selection?: { window?: number }): Promise<void> {
    const result = await executor.execute<RssList>(invocation(ctx, 'rss-view'), 'rss.list', { page });
    if (result.status !== 'succeeded') {
      if (current) await panels.close(current, 'expired');
      await resultData(ctx, result); return;
    }
    const snapshot = result.data;
    const language = languageOf(ctx);
    const t = translator(language);
    let selected: RssSubscriptionView | undefined;
    if (selectedId) {
      const detail = await executor.execute<RssSubscriptionView>(invocation(ctx, 'rss-detail'), 'rss.get', { id: selectedId });
      if (detail.status === 'succeeded') selected = detail.data;
      else notice = rssNotice(ctx, detail);
    }
    sessions.delete(sessionKey(ctx));
    const panel = current ?? await createPanel(ctx, { kind: 'rss', language, generation: 0, view: 'list', page: snapshot.page, items: [] });
    if (panel.value.kind !== 'rss') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    Object.assign(panel.value, { language, view: selected ? 'item' : 'list', page: snapshot.page, selected, items: selection ? [] : snapshot.items });
    const bounds = pageBounds(snapshot.total, snapshot.page, 5);
    if (selection) { await displayPanel(panel, pageSelection(panel, bounds, selection.window)); return; }
    const keyboard = new InlineKeyboard();
    const entities: MessageEntity[] = [];
    let text = t('bot:rss.title', { count: snapshot.total });
    const status = (item: RssSubscriptionView) => t(item.paused ? 'bot:rss.paused' : 'bot:rss.active');
    const sound = (item: RssSubscriptionView) => t(item.silent ? 'bot:rss.silent' : 'bot:rss.normal');
    if (selected) {
      const at = (time: number | null) => time === null ? t('bot:rss.never') : new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(time) + ' UTC';
      const url = plainValue(selected.url, 2048);
      // Locate the URL slot, not a matching URL that may also occur in the feed title.
      const detail = t('bot:rss.detail', { title: plainValue(selected.title), id: selected.id, url: '\0', status: status(selected), notification: sound(selected) });
      const urlOffset = detail.indexOf('\0');
      if (urlOffset < 0) throw new AppError('INVALID_OUTPUT');
      entities.push({ type: 'code', offset: text.length + 2 + urlOffset, length: url.length });
      text += '\n\n' + detail.replace('\0', () => url);
      text += '\n\n' + t('bot:rss.health', { interval: Math.round(selected.intervalSeconds / 60), lastCheck: at(selected.lastCheckAt), lastSuccess: at(selected.lastSuccessAt),
        failures: selected.failures, checks: selected.totalChecks, totalFailures: selected.totalFailures, pending: selected.pending, uncertain: selected.uncertain });
      if (selected.lastError) text += '\n\n' + t(`bot:rss.errors.${selected.lastError}`);
      if (selected.deliveryError) text += '\n\n' + t(`bot:rss.deliveryErrors.${selected.deliveryError}`);
      keyboard.text(t(selected.silent ? 'bot:rss.enableSound' : 'bot:rss.mute'), callbackData(panel, 'rsssilent'))
        .text(t(selected.paused ? 'bot:rss.resume' : 'bot:rss.pause'), callbackData(panel, 'rsspause')).row()
        .text(t('bot:rss.remove'), callbackData(panel, 'rssremove')).danger().row()
        .text(t('bot:panels.back'), callbackData(panel, 'rsshome'));
    } else {
      text += '\n\n' + t('bot:rss.description');
      if (!snapshot.total) text += '\n\n' + t('bot:rss.empty');
      for (const [index, item] of snapshot.items.entries()) {
        text += '\n\n' + t('bot:rss.row', { index: bounds.start + index + 1, title: plainValue(item.title), status: status(item), notification: sound(item) });
        keyboard.text(`${bounds.start + index + 1}. ${plainValue(item.title).slice(0, 50)}`, callbackData(panel, `rssitem:${index}`)).row();
      }
      keyboard.text(t('bot:rss.add'), callbackData(panel, 'rssadd')).success().row();
      keyboard.add(...navigation(panel, bounds).inline_keyboard.flat());
    }
    if (notice) text += '\n\n' + notice;
    await displayPanel(panel, { text, keyboard, entities }, supportedMessage(ctx)!.message_id);
  }

  async function rssCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'rss') throw new AppError('FORBIDDEN');
    if (operation === 'rsshome') { await showRss(ctx, panel.value.page, panel); return; }
    if (operation === 'page' || operation === 'pick') {
      await showRss(ctx, operation === 'page' ? Number(argument) : panel.value.page, panel, undefined, undefined,
        operation === 'pick' ? { window: argument === undefined ? undefined : Number(argument) } : undefined); return;
    }
    if (operation === 'rssitem') {
      const item = panel.value.items[Number(argument)];
      if (!item) throw new AppError('FORBIDDEN');
      await showRss(ctx, panel.value.page, panel, undefined, item.id); return;
    }
    if (operation === 'rssadd') {
      const allowed = await executor.execute(invocation(ctx, 'rss-input'), 'rss.list', { page: 0 });
      if (allowed.status !== 'succeeded') { await panels.close(panel, 'expired'); await resultData(ctx, allowed); return; }
      if (panel.messageId === undefined) throw new AppError('FORBIDDEN');
      refreshGeneration(panel);
      panel.value.view = 'input'; panel.value.items = []; panel.value.selected = undefined; panel.value.language = languageOf(ctx);
      sessions.set(sessionKey(ctx), { rssInput: { panelId: panel.id, messageId: panel.messageId } });
      const text = translator(languageOf(ctx))('bot:rss.input');
      await displayPanel(panel, { text, entities: commandEntities(text), keyboard: new InlineKeyboard().text(translator(languageOf(ctx))('common:actions.cancel'), callbackData(panel, 'rsshome')) });
      return;
    }
    const selected = panel.value.selected;
    if (!selected) throw new AppError('FORBIDDEN');
    const input = { id: selected.id, revision: selected.revision,
      ...(operation === 'rsssilent' ? { silent: !selected.silent } : operation === 'rsspause' ? { paused: !selected.paused } : {}) };
    const result = await executor.execute(invocation(ctx), operation === 'rssremove' ? 'rss.remove' : 'rss.update', input);
    await showRss(ctx, panel.value.page, panel, rssNotice(ctx, result, operation === 'rssremove' ? 'removed' : 'saved'), operation === 'rssremove' ? undefined : selected.id);
  }

  async function rssInput(ctx: Context): Promise<boolean> {
    const pending = sessions.get(sessionKey(ctx))?.rssInput;
    if (!pending || !ctx.message?.text) return false;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.message_id !== pending.messageId) return false;
    sessions.delete(sessionKey(ctx));
    let panel: CorePanel;
    try { panel = panels.get(pending.panelId, { ...binding(ctx), messageId: pending.messageId }); }
    catch { await send(ctx, translator(languageOf(ctx))('bot:expired'), closedKeyboard('r', ctx.from!.id, languageOf(ctx))); return true; }
    if (panel.value.kind !== 'rss' || panel.value.view !== 'input') return true;
    const [url, ...title] = ctx.message.text.trim().split(/\s+/);
    const result = await executor.execute(invocation(ctx), 'rss.add', { url, ...(title.length ? { title: title.join(' ') } : {}) });
    await showRss(ctx, 0, panel, rssNotice(ctx, result, 'added'));
    return true;
  }

  async function rssCommand(ctx: Context, argument: string): Promise<void> {
    const parts = argument.trim().split(/\s+/).filter(Boolean);
    const operation = parts[0]?.toLowerCase();
    if (!parts.length || operation === 'list' && parts.length === 1) { await showRss(ctx); return; }
    if (operation === 'add' && parts.length >= 2) {
      const result = await executor.execute(invocation(ctx), 'rss.add', { url: parts[1], ...(parts.length > 2 ? { title: parts.slice(2).join(' ') } : {}) });
      await showRss(ctx, 0, undefined, rssNotice(ctx, result, 'added')); return;
    }
    if (['remove', 'mute', 'pause'].includes(operation ?? '') && rssIdSchema.safeParse(parts[1]).success
      && (operation === 'remove' ? parts.length === 2 : parts.length === 3 && ['on', 'off'].includes(parts[2]!))) {
      const current = await resultData(ctx, await executor.execute<RssSubscriptionView>(invocation(ctx, 'rss-before'), 'rss.get', { id: parts[1] }));
      if (!current) return;
      const result = await executor.execute(invocation(ctx), operation === 'remove' ? 'rss.remove' : 'rss.update', {
        id: current.id, revision: current.revision, ...(operation === 'mute' ? { silent: parts[2] === 'on' } : operation === 'pause' ? { paused: parts[2] === 'on' } : {}),
      });
      await showRss(ctx, 0, undefined, rssNotice(ctx, result, operation === 'remove' ? 'removed' : 'saved')); return;
    }
    await send(ctx, translator(languageOf(ctx))('bot:rss.usage'));
  }

  async function lookupData<T>(ctx: Context, result: ActionResult<T>): Promise<T | undefined> {
    if (result.status === 'succeeded') return result.data;
    if (!('error' in result)) { await send(ctx, translator(languageOf(ctx))('common:errors.INVALID_OUTPUT')); return; }
    if (result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
    const field = result.error.fields?.find(field => /^(?:provider|rate)\.[A-Z_]+$/.test(field));
    await send(ctx, translator(languageOf(ctx))(field ? `bot:${field}` : `common:errors.${result.error.code}`));
  }
  function currencyLabel(currency: CurrencyDefinition, locale: Locale): string {
    return `${currency.code} ${currency.kind === 'fiat' ? new Intl.DisplayNames(locale, { type: 'currency' }).of(currency.code) : currency.name}`;
  }
  async function showRate(ctx: Context, input?: RateInput, current?: CorePanel, page = 0, directory = false, supplied?: RateResult, selection?: { window?: number }): Promise<void> {
    const language = languageOf(ctx); const t = translator(language);
    const result = supplied ?? (input ? await lookupData(ctx, await executor.execute<RateResult>(invocation(ctx), 'rate.convert', input)) : undefined);
    if (input && !result) return;
    const currencies = directory ? await lookupData(ctx, await executor.execute<RateCurrencies>(invocation(ctx, 'rate-currencies'), 'rate.currencies', { page })) : undefined;
    if (directory && !currencies) return;
    sessions.delete(sessionKey(ctx));
    const panel = current ?? await createPanel(ctx, { kind: 'rate', language, generation: 0, view: 'result', page: 0 });
    if (panel.value.kind !== 'rate') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    Object.assign(panel.value, { language, result, view: directory ? 'currencies' : 'result', page: currencies?.page ?? page });
    const keyboard = new InlineKeyboard();
    let text = t('bot:rate.title');
    if (currencies) {
      text += '\n\n' + t('bot:rate.catalog', { total: currencies.total });
      text += '\n' + currencies.items.map(currency => currencyLabel(currency, language)).join('\n');
      const bounds = pageBounds(currencies.total, currencies.page, 10);
      if (selection) { await displayPanel(panel, pageSelection(panel, bounds, selection.window)); return; }
      keyboard.add(...navigation(panel, bounds).inline_keyboard.flat());
    } else if (result?.kind === 'converted') {
      const { Decimal } = await import('decimal.js');
      throwIfAborted(signal);
      const quoteNumber = (value: string): string => {
        const number = new Decimal(value);
        return number.isZero() || number.abs().gte('0.000001') ? number.toDecimalPlaces(6).toFixed() : number.toSignificantDigits(6).toFixed();
      };
      text += `\n\n${result.amount} ${currencyLabel(result.from, language)}\n≈ ${quoteNumber(result.result)} ${currencyLabel(result.to, language)}`;
      text += '\n\n' + t('bot:rate.unitRate', { from: result.from.code, rate: quoteNumber(result.unitRate), to: result.to.code });
      if (result.stale) text += '\n\n' + t('bot:rate.stale');
      for (const source of result.sources) text += '\n\n' + t('bot:rate.source', { source: source.name, at: new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(source.updatedAt)) + ' UTC' });
      text += '\n\n' + t('bot:rate.disclaimer');
      keyboard.text(t('bot:rate.swap'), callbackData(panel, 'fswap')).row();
    } else if (result?.kind === 'ambiguous') {
      const choosingFrom = result.from.length > 1;
      const choices = choosingFrom ? result.from : result.to;
      const values = paginate(choices, page, 8);
      panel.value.page = values.page;
      text += '\n\n' + t(choosingFrom ? 'bot:rate.chooseFrom' : 'bot:rate.chooseTo', { amount: result.amount });
      for (const [index, currency] of values.items.entries()) {
        keyboard.text(currencyLabel(currency, language).slice(0, 50), callbackData(panel, `fchoose:${values.start + index}`));
        if (index % 2 === 1) keyboard.row();
      }
      keyboard.row();
      if (selection) { await displayPanel(panel, pageSelection(panel, values, selection.window)); return; }
      keyboard.add(...navigation(panel, values).inline_keyboard.flat()).row();
    } else text += '\n\n' + t('bot:rate.usage');
    if (!directory) keyboard.text(t('bot:rate.currencies'), callbackData(panel, 'fcurrencies'));
    await displayPanel(panel, { text, keyboard, ...(!result && !directory ? { entities: commandEntities(text) } : {}) }, supportedMessage(ctx)!.message_id);
  }
  async function rateCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'rate') throw new AppError('FORBIDDEN');
    const result = panel.value.result;
    if (operation === 'fcurrencies') { await showRate(ctx, undefined, panel, 0, true); return; }
    if (operation === 'page' || operation === 'pick') {
      await showRate(ctx, undefined, panel, operation === 'page' ? Number(argument) : panel.value.page, panel.value.view === 'currencies', result,
        operation === 'pick' ? { window: argument === undefined ? undefined : Number(argument) } : undefined); return;
    }
    if (operation === 'fswap' && result?.kind === 'converted') { await showRate(ctx, { amount: result.amount, from: `${result.to.kind}:${result.to.code}`, to: `${result.from.kind}:${result.from.code}` }, panel); return; }
    if (operation === 'fchoose' && result?.kind === 'ambiguous') {
      const from = result.from.length > 1;
      const selected = (from ? result.from : result.to)[Number(argument)];
      if (!selected) throw new AppError('FORBIDDEN');
      const next = { ...result, from: from ? [selected] : result.from, to: from ? result.to : [selected] };
      if (next.from.length === 1 && next.to.length === 1) await showRate(ctx, { amount: next.amount, from: `${next.from[0]!.kind}:${next.from[0]!.code}`, to: `${next.to[0]!.kind}:${next.to[0]!.code}` }, panel);
      else await showRate(ctx, undefined, panel, 0, false, next);
      return;
    }
    throw new AppError('FORBIDDEN');
  }
  function weatherDescription(ctx: Context, description: string, code: number | null, provider: WeatherResult['provider']): string {
    let key = 'unknown';
    if (code !== null) {
      if (provider === 'qweather') key = code === 100 || code === 150 ? 'clear' : code >= 101 && code <= 154 ? 'clouds'
        : code >= 302 && code <= 304 ? 'storm' : code >= 300 && code < 400 ? 'rain' : code >= 400 && code < 500 ? 'snow' : code >= 500 && code < 600 ? 'fog' : 'unknown';
      else if (provider === 'openweather') key = code === 800 ? 'clear' : code >= 801 && code <= 804 ? 'clouds'
        : code >= 200 && code < 300 ? 'storm' : code >= 300 && code < 400 ? 'drizzle' : code >= 500 && code < 600 ? 'rain'
          : code >= 600 && code < 700 ? 'snow' : code >= 700 && code < 800 ? 'fog' : 'unknown';
      else key = code === 0 ? 'clear' : code >= 1 && code <= 3 ? 'clouds' : code === 45 || code === 48 ? 'fog'
        : code >= 51 && code <= 57 ? 'drizzle' : code >= 61 && code <= 67 || code >= 80 && code <= 82 ? 'rain'
          : code >= 71 && code <= 77 || code >= 85 && code <= 86 ? 'snow' : code >= 95 && code <= 99 ? 'storm' : 'unknown';
    }
    const icon = provider === 'qweather' && code === 150 ? '🌙'
      : ({ clear: '☀️', clouds: '☁️', fog: '🌫️', drizzle: '🌦️', rain: '🌧️', snow: '🌨️', storm: '⛈️', unknown: '🌡️' } as Record<string, string>)[key];
    return `${icon} ${description ? plainValue(description, 200) : translator(languageOf(ctx))(`bot:weather.conditions.${key}`)}`;
  }
  async function weatherPrompt(ctx: Context, mode: 'current' | 'forecast', days: number, current?: CorePanel, notice?: string): Promise<void> {
    const language = languageOf(ctx); const t = translator(language);
    sessions.delete(sessionKey(ctx));
    const panel = current ?? await createPanel(ctx, { kind: 'weather', language, generation: 0, view: 'input', mode, days, locations: [] });
    if (panel.value.kind !== 'weather') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    Object.assign(panel.value, { language, view: 'input', mode, days, locations: [], result: undefined, defaultRevision: undefined });
    const text = `${t('bot:weather.title')}\n\n${notice ?? t('bot:weather.input')}\n\n${t('bot:weather.privacy')}`;
    await displayPanel(panel, { text, keyboard: new InlineKeyboard(), entities: commandEntities(text) }, supportedMessage(ctx)!.message_id);
    if (panel.messageId !== undefined) sessions.set(sessionKey(ctx), { weatherInput: { panelId: panel.id, messageId: panel.messageId, mode, days } });
  }
  async function showWeather(ctx: Context, input: WeatherSearchInput | { location: WeatherLocation }, mode: 'current' | 'forecast', days: number, current?: CorePanel, notice?: string): Promise<void> {
    const language = languageOf(ctx); const t = translator(language);
    let location = 'location' in input ? input.location : undefined;
    let locations: WeatherLocation[] = [];
    if (!location) {
      const data = await lookupData(ctx, await executor.execute<{ locations: WeatherLocation[] }>(invocation(ctx, 'weather-search'), 'weather.search', input));
      if (!data) return;
      locations = data.locations;
      if (!locations.length) { await weatherPrompt(ctx, mode, days, current, t('bot:weather.notFound')); return; }
      if (locations.length === 1) location = locations[0];
    }
    const result = location ? await lookupData(ctx, await executor.execute<WeatherResult>(invocation(ctx, 'weather-query'), 'weather.query', { location, mode, days })) : undefined;
    if (location && !result) return;
    sessions.delete(sessionKey(ctx));
    const panel = current ?? await createPanel(ctx, { kind: 'weather', language, generation: 0, view: 'locations', mode, days, locations: [] });
    if (panel.value.kind !== 'weather') throw new AppError('FORBIDDEN');
    if (current) refreshGeneration(panel);
    Object.assign(panel.value, { language, mode, days, view: result ? 'result' : 'locations', locations, result, defaultRevision: undefined });
    const keyboard = new InlineKeyboard();
    let text = t('bot:weather.title');
    if (!result) {
      text += '\n\n' + t('bot:weather.choose');
      for (const [index, candidate] of locations.entries()) {
        text += `\n\n${index + 1}. ${plainValue(candidate.label, 300)}`;
        keyboard.text(`${index + 1}. ${plainValue(candidate.label, 55)}`, callbackData(panel, `wlocation:${index}`)).row();
      }
    } else {
      text += '\n\n' + plainValue(result.location.label, 300);
      const value = (number: number | null) => number === null ? t('bot:weather.missing') : new Intl.NumberFormat(language, { maximumFractionDigits: 1 }).format(number);
      const feeling = result.feelsLike === null ? 'unknown' : result.feelsLike < 10 ? 'cold' : result.feelsLike < 18 ? 'cool'
        : result.feelsLike < 26 ? 'comfortable' : result.feelsLike < 32 ? 'warm' : 'hot';
      const feelsIcon = { cold: '🥶', cool: '🧥', comfortable: '🙂', warm: '😅', hot: '🥵', unknown: '🌡️' }[feeling];
      if (mode === 'current') text += '\n\n' + t('bot:weather.current', {
        condition: weatherDescription(ctx, result.description, result.code, result.provider), temperature: value(result.temperature), feelsLike: value(result.feelsLike),
        feelsIcon, feelsLabel: t(`bot:weather.feels.${feeling}`), humidity: value(result.humidity), wind: value(result.windKph), rain: value(result.precipitation),
      });
      else for (const day of result.days) text += '\n\n' + t('bot:weather.day', { date: day.date, condition: weatherDescription(ctx, day.description, day.code, result.provider),
        min: value(day.min), max: value(day.max), rain: value(day.precipitation), probability: value(day.probability) });
      text += '\n\n' + t('bot:weather.source', { source: t(`bot:weather.providers.${result.provider}`), at: new Intl.DateTimeFormat(language, {
        dateStyle: 'short', timeStyle: 'short', timeZone: result.location.timezone ?? 'UTC',
      }).format(new Date(result.observedAt ?? result.fetchedAt)) + ` (${result.location.timezone ?? 'UTC'})` });
      if (result.model) text += '\n' + t('bot:weather.model');
      if (result.fallback) text += '\n' + t('bot:weather.fallback');
      text += '\n' + t('bot:weather.resolution');
      for (const url of result.attributions) text += '\n' + url;
      keyboard.text(t(mode === 'current' ? 'bot:weather.forecast' : 'bot:weather.now'), callbackData(panel, mode === 'current' ? 'wforecast' : 'wcurrent')).row();
      if (supportedMessage(ctx)!.chat.type === 'private') {
        const saved = await lookupData(ctx, await executor.execute<{ revision: number; location: WeatherLocation | null }>(invocation(ctx, 'weather-default'), 'weather.default.get', {}));
        if (saved) {
          panel.value.defaultRevision = saved.revision;
          keyboard.text(t('bot:weather.save'), callbackData(panel, 'wsave')).success();
          if (saved.location) keyboard.text(t('bot:weather.clear'), callbackData(panel, 'wclear')).danger();
          keyboard.row();
        }
      }
    }
    if (notice) text += '\n\n' + notice;
    await displayPanel(panel, { text, keyboard }, supportedMessage(ctx)!.message_id);
  }
  async function weatherCommand(ctx: Context, argument: string, forecast = false): Promise<void> {
    const request = parseWeatherIntent(argument, forecast);
    const t = translator(languageOf(ctx));
    if (request.query === 'clear') {
      if (supportedMessage(ctx)!.chat.type !== 'private') { await send(ctx, t('bot:weather.privateDefault')); return; }
      const saved = await lookupData(ctx, await executor.execute<{ revision: number }>(invocation(ctx, 'weather-before-clear'), 'weather.default.get', {}));
      if (!saved) return;
      const cleared = await lookupData(ctx, await executor.execute(invocation(ctx), 'weather.default.set', { revision: saved.revision, location: null }));
      if (cleared) await weatherPrompt(ctx, request.mode, request.days, undefined, t('bot:weather.cleared'));
      return;
    }
    if (request.query) { await showWeather(ctx, { query: request.query }, request.mode, request.days); return; }
    if (supportedMessage(ctx)!.chat.type === 'private') {
      const saved = await lookupData(ctx, await executor.execute<{ location: WeatherLocation | null }>(invocation(ctx, 'weather-default'), 'weather.default.get', {}));
      if (saved?.location) { await showWeather(ctx, { location: saved.location }, request.mode, request.days); return; }
    }
    await weatherPrompt(ctx, request.mode, request.days, undefined, supportedMessage(ctx)!.chat.type === 'private' ? undefined : t('bot:weather.privateDefault') + '\n' + t('bot:weather.input'));
  }
  async function weatherInput(ctx: Context): Promise<boolean> {
    const waiting = sessions.get(sessionKey(ctx))?.weatherInput;
    if (!waiting || (!ctx.message?.text && !ctx.message?.location)) return false;
    if (ctx.message.reply_to_message && ctx.message.reply_to_message.message_id !== waiting.messageId) return false;
    let panel: CorePanel;
    try { panel = panels.get(waiting.panelId, { ...binding(ctx), messageId: waiting.messageId }); }
    catch { sessions.delete(sessionKey(ctx)); return true; }
    if (panel.value.kind !== 'weather' || panel.value.view !== 'input') return true;
    if (ctx.message.location) await showWeather(ctx, { latitude: ctx.message.location.latitude, longitude: ctx.message.location.longitude }, waiting.mode, waiting.days, panel);
    else {
      const request = parseWeatherIntent(ctx.message.text!, waiting.mode === 'forecast');
      await showWeather(ctx, { query: request.query }, request.mode, /明天|明日|后天|後天|tomorrow|[1-7]\s*(?:天|日|days?)/i.test(ctx.message.text!) ? request.days : waiting.days, panel);
    }
    return true;
  }
  async function weatherCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'weather') throw new AppError('FORBIDDEN');
    if (panel.binding.userId !== ctx.from!.id) {
      if (supportedMessage(ctx)!.chat.type === 'private' || !panel.value.result || !['wcurrent', 'wforecast'].includes(operation)) throw new AppError('FORBIDDEN');
      // Public group weather can be read by another member, but never edit the original user's panel or defaults.
      await showWeather(ctx, { location: panel.value.result.location }, operation === 'wcurrent' ? 'current' : 'forecast', panel.value.days);
      return;
    }
    if (operation === 'wlocation') {
      const location = panel.value.locations[Number(argument)];
      if (!location) throw new AppError('FORBIDDEN');
      await showWeather(ctx, { location }, panel.value.mode, panel.value.days, panel); return;
    }
    const result = panel.value.result;
    if (!result) throw new AppError('FORBIDDEN');
    if (operation === 'wcurrent' || operation === 'wforecast') {
      await showWeather(ctx, { location: result.location }, operation === 'wcurrent' ? 'current' : 'forecast', panel.value.days, panel); return;
    }
    if (supportedMessage(ctx)!.chat.type !== 'private' || panel.value.defaultRevision === undefined) throw new AppError('FORBIDDEN');
    const saved = await lookupData(ctx, await executor.execute(invocation(ctx), 'weather.default.set', { revision: panel.value.defaultRevision, location: operation === 'wsave' ? result.location : null }));
    if (saved) await showWeather(ctx, { location: result.location }, panel.value.mode, panel.value.days, panel, translator(languageOf(ctx))(operation === 'wsave' ? 'bot:weather.saved' : 'bot:weather.cleared'));
  }

  function stickerError(language: Locale, code: string): string {
    const t = translator(language);
    const key = code === 'INVALID_INPUT' ? 'invalid' : code === 'UNAVAILABLE' ? 'unavailable'
      : code === 'OUTCOME_UNKNOWN' ? 'uncertain' : code === 'CAPACITY' ? 'capacity'
        : code === 'CONFIRMATION_EXPIRED' ? 'expired' : code === 'CANCELLED' ? 'cancelled' : undefined;
    return t(key ? `bot:sticker.${key}` : `common:errors.${code}`);
  }

  function stickerView(panel: CorePanel, notice?: string, closed = false): PanelView {
    if (panel.value.kind !== 'sticker') throw new AppError('FORBIDDEN');
    const { info, delivery, busy, uncertain } = panel.value;
    const t = translator(panel.value.language);
    const text = [t('bot:sticker.title'), info.kind === 'pack'
      ? t('bot:sticker.pack', { title: plainValue(info.title ?? info.setName ?? ''), count: info.count })
      : [t('bot:sticker.single', { kind: t(`bot:sticker.kinds.${info.sourceKind}`), width: info.width, height: info.height }),
        ...(info.emoji ? [plainValue(info.emoji, 64)] : [])].join(' '),
    ...(!closed ? [t(info.kind === 'pack' ? 'bot:sticker.packLimit' : info.sourceKind === 'static' ? 'bot:sticker.hint' : 'bot:sticker.animationHint')] : []),
    ...(notice ? [notice] : [])].join('\n');
    const buttonRows: RichMessageButton[][] = [];
    const buttonRowLabels: Record<number, RichText> = {};
    if (closed) buttonRows.push([reopenButton('k', panel.binding.userId, panel.value.language)]);
    else if (busy) buttonRows.push([{ text: t('bot:sticker.cancel'), callback_data: callbackData(panel, 'stcancel'), style: 'danger' }]);
    else if (!uncertain) {
      if (info.kind === 'single') {
        buttonRows.push((['media', 'file'] as const).map(mode => ({ text: t(`bot:sticker.${mode}`),
          callback_data: callbackData(panel, `stmode:${mode}`), ...(mode === delivery ? { style: 'primary' as const } : {}) })));
      }
      const downloads: RichMessageButton[] = [{ text: t(info.kind === 'pack' ? 'bot:sticker.zip' : 'bot:sticker.original'), callback_data: callbackData(panel, 'stformat:original') }];
      if (info.kind === 'single' && info.setName) downloads.push({ text: t('bot:sticker.wholePack'), callback_data: callbackData(panel, 'stpack') });
      buttonRows.push(downloads);
      const formats = info.formats.filter(format => format !== 'original' && (format !== 'webp' || delivery === 'file')).map(format => {
        const label = format === 'png' && info.sourceKind !== 'static' ? t('bot:sticker.firstFrame') : format.toUpperCase();
        return { text: label, callback_data: callbackData(panel, `stformat:${format}`) };
      });
      if (formats.length) {
        const label = t('bot:sticker.format');
        const marked = label.replace(/[:：]$/, '');
        buttonRowLabels[buttonRows.length] = [{ type: 'marked', text: marked }, label.slice(marked.length)];
        buttonRows.push(formats);
      }
    }
    return { text, buttonRows, buttonRowLabels };
  }

  async function renderSticker(panel: CorePanel, notice?: string, replyTo?: number): Promise<void> {
    await displayPanel(panel, stickerView(panel, notice), replyTo);
  }

  async function showSticker(ctx: Context, source: StickerCapture, sourceMessageId: number, openingSignal?: AbortSignal): Promise<void> {
    const owner = invocation(ctx);
    const context = openingSignal ? createInvocation({ ...owner, signal: AbortSignal.any([owner.signal!, openingSignal]) }) : owner;
    const ref = stickers.capture(context, source, sourceMessageId);
    const result = await executor.execute<StickerView>(context, 'sticker.inspect', { source: ref });
    if (openingSignal?.aborted) { stickers.release(owner, ref); return; }
    if (result.status !== 'succeeded') {
      stickers.release(owner, ref);
      await send(ctx, stickerError(context.language, 'error' in result ? result.error.code : 'INVALID_OUTPUT')); return;
    }
    if (result.replayed) return;
    let panel: CorePanel | undefined;
    try {
      // Each source keeps its own controls; a second sticker must not invalidate the first one's output choices.
      panel = panels.create(binding(ctx), { kind: 'sticker', language: context.language, generation: 0,
        info: result.data, delivery: 'media', busy: false, uncertain: false }, Date.parse(result.data.expiresAt));
      await renderSticker(panel, undefined, sourceMessageId);
    } catch (error) {
      if (panel) await panels.close(panel, 'expired');
      stickers.release(owner, ref);
      throw error;
    }
  }

  function trackStickerTask(task: Promise<void>): void {
    const tracked = task.catch(error => { if (!signal.aborted) health.recordApiError(safeError(error).code); });
    inFlight.add(tracked);
    void tracked.then(() => inFlight.delete(tracked));
  }

  function openStickerPack(ctx: Context, name: string, sourceMessageId: number): void {
    const opening = { key: sessionKey(ctx)!, controller: new AbortController() };
    stickerOpenings.add(opening);
    // Pack lookup is network work too; do not make /cancel wait behind getStickerSet.
    trackStickerTask(showSticker(ctx, { kind: 'pack', name }, sourceMessageId, opening.controller.signal)
      .catch(async error => {
        if (!signal.aborted && !opening.controller.signal.aborted) await send(ctx, stickerError(languageOf(ctx), safeError(error).code));
      }).finally(() => stickerOpenings.delete(opening)));
  }

  async function stickerCommand(ctx: Context, argument: string): Promise<void> {
    const message = supportedMessage(ctx)!;
    if (message.chat.type !== 'private') throw new AppError('FORBIDDEN');
    const name = stickerSetName(argument);
    if (name) { openStickerPack(ctx, name, message.message_id); return; }
    const source = ctx.update.message?.sticker ? ctx.update.message : ctx.update.message?.reply_to_message;
    if (!argument && source?.sticker) {
      if (source.chat.id !== message.chat.id || messageTopicId(source) !== messageTopicId(message) || source.has_protected_content) throw new AppError('FORBIDDEN');
      await showSticker(ctx, { kind: 'single', sticker: telegramStickerFile(source.sticker) }, source.message_id); return;
    }
    await send(ctx, translator(languageOf(ctx))('bot:sticker.usage'));
  }

  async function stickerCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'sticker' || supportedMessage(ctx)!.chat.type !== 'private') throw new AppError('FORBIDDEN');
    if (operation === 'stcancel') {
      // Release before awaiting anything, including when conversion is still behind its progress edit.
      stickers.release(invocation(ctx), panel.value.info.source);
      await executor.execute(invocation(ctx), 'sticker.cancel', { source: panel.value.info.source });
      await panels.close(panel, 'cancelled'); return;
    }
    if (operation === 'stmode') {
      if (argument !== 'media' && argument !== 'file') throw new AppError('FORBIDDEN');
      panel.value.delivery = argument; refreshGeneration(panel); await renderSticker(panel); return;
    }
    if (operation === 'stpack') {
      if (!panel.value.info.setName) throw new AppError('FORBIDDEN');
      openStickerPack(ctx, panel.value.info.setName, panel.messageId!); return;
    }
    const format = stickerFormatSchema.parse(argument);
    if (!panel.value.info.formats.includes(format) || format === 'webp' && panel.value.delivery !== 'file') throw new AppError('FORBIDDEN');
    const context = invocation(ctx);
    const input = { source: panel.value.info.source, format, delivery: format === 'original' ? 'file' as const : panel.value.delivery };
    panel.value.busy = true;
    refreshGeneration(panel);
    // Do not hold the per-conversation queue during conversion: /cancel must be able to abort a running worker/upload.
    const task = (async () => {
      await bestEffort(() => renderSticker(panel, translator(context.language)('bot:sticker.processing')));
      try { panels.get(panel.id, { ...panel.binding, messageId: panel.messageId! }); }
      catch { return; }
      const result = await executor.execute<StickerResult>(context, 'sticker.convert', input);
      if (panel.value.kind !== 'sticker') return;
      panel.value.busy = false;
      panel.value.uncertain = 'error' in result && result.error.code === 'OUTCOME_UNKNOWN';
      refreshGeneration(panel);
      const t = translator(context.language);
      const notice = result.status === 'succeeded'
        ? t('bot:sticker.sent', { format: result.data.format.toUpperCase(), delivery: t(`bot:sticker.deliveries.${result.data.delivery}`), size: Math.ceil(result.data.bytes / 1024) })
        : stickerError(context.language, 'error' in result ? result.error.code : 'INVALID_OUTPUT');
      await bestEffort(() => renderSticker(panel, notice));
    })();
    trackStickerTask(task);
  }

  function clearSubconvInput(key: string): void {
    const data = sessions.get(key);
    if (!data?.subconvInput) return;
    delete data.subconvInput;
    if (Object.keys(data).length) sessions.set(key, data);
    else sessions.delete(key);
  }

  function subconvView(panel: CorePanel, notice?: string): PanelView {
    if (panel.value.kind !== 'subconv') throw new AppError('FORBIDDEN');
    const value = panel.value;
    const { backend, options } = value.snapshot.settings;
    const t = translator(value.language);
    const label = (field: string) => t(`bot:subconv.fields.${field}`);
    const button = (key: string, operation: string, primary = false): RichMessageButton => ({
      text: t(`bot:subconv.${key}`), callback_data: callbackData(panel, operation), ...(primary ? { style: 'primary' } : {}),
    });
    const inputButton = (field: SubconvInputField): RichMessageButton => ({
      text: label(field), callback_data: callbackData(panel, `uinput:${subconvInputFields.indexOf(field)}`),
    });
    const buttonRows: RichMessageButton[][] = [];
    const buttonRowLabels: Record<number, RichText> = {};
    const target = subconvTargets.find(target => target.id === options.target)!.label;
    const preset = subconvPresets.find(preset => preset.url === options.remoteConfig)?.label
      ?? t(options.remoteConfig ? 'bot:subconv.customPreset' : 'bot:subconv.empty');
    let text = `${t('bot:subconv.title')}\n${t('bot:subconv.summary', {
      backend: backend ? plainValue(new URL(backend).host, 256) : t('bot:subconv.empty'), target, preset,
      count: subconvSourceCount(value.source), custom: value.customParams.length,
    })}`;
    if (value.view === 'main') {
      buttonRows.push([inputButton('source'), inputButton('backend')],
        [button('targets', 'utargets'), button('presets', 'upresets')],
        [button('options', 'uoptions'), button('filters', 'ufilters')], [inputButton('customParams')],
        [button('generate', 'ugenerate', true), button('reset', 'ureset')]);
    } else if (value.view === 'targets') {
      for (let index = 0; index < subconvTargets.length; index += 2) {
        buttonRows.push(subconvTargets.slice(index, index + 2).map((target, offset) => ({
          text: target.label, callback_data: callbackData(panel, `utarget:${index + offset}`), ...(target.id === options.target ? { style: 'primary' as const } : {}),
        })));
      }
    } else if (value.view === 'presets') {
      for (const [index, preset] of subconvPresets.entries()) {
        if (index === 0 || preset.group !== subconvPresets[index - 1]!.group) {
          buttonRowLabels[buttonRows.length] = [{ type: 'bold', text: t(`bot:subconv.presetGroups.${preset.group}`) }];
        }
        buttonRows.push([{ text: preset.label, callback_data: callbackData(panel, `upreset:${index}`),
          ...(preset.url === options.remoteConfig ? { style: 'primary' as const } : {}) }]);
      }
      buttonRows.push([inputButton('remoteConfig')]);
    } else if (value.view === 'options') {
      for (let index = value.page * 6; index < (value.page + 1) * 6; index++) {
        const field = subconvFlags[index]!;
        const state = options[field];
        buttonRows.push([{ text: `${label(field)}: ${t(`bot:subconv.states.${state === null ? 'default' : String(state)}`)}`,
          callback_data: callbackData(panel, `uflag:${index}`), ...(state === true ? { style: 'primary' as const } : {}) }]);
      }
      buttonRows.push([0, 1].map(page => ({ text: `${page + 1}/2`, callback_data: callbackData(panel, `upage:${page}`),
        ...(page === value.page ? { style: 'primary' as const } : {}) })));
    } else if (value.view === 'filters') {
      for (const field of ['include', 'exclude', 'filename'] as const) {
        buttonRows.push([{ ...inputButton(field), text: `${label(field)}: ${t(options[field] ? 'bot:subconv.set' : 'bot:subconv.unset')}` }]);
      }
    } else if (value.view === 'input') {
      text += `\n\n${t('bot:subconv.input', { field: label(value.input!) })}\n${t('bot:subconv.inputHint')}`;
      buttonRows.push([button('clear', 'uclear')]);
    } else if (value.result) {
      const result = value.result;
      text = `${t('bot:subconv.title')}\n${t('bot:subconv.result', { count: result.sourceCount,
        target: subconvTargets.find(target => target.id === result.target)?.label ?? t('bot:subconv.customPreset'),
        backend: plainValue(result.backendHost, 256) })}\n${t('bot:subconv.copyHint')}`;
      if (result.url.length <= 256) buttonRows.push([{ text: t('bot:subconv.copy'), copy_text: { text: result.url } }]);
    }
    text += `\n\n${t('bot:subconv.disclosure')}`;
    if (value.view === 'result' && value.result?.skipsCertVerification === null) text += `\n${t('bot:subconv.scvUnknown')}`;
    else if (value.view === 'result' ? value.result?.skipsCertVerification : options.scv) text += `\n${t('bot:subconv.scvWarning')}`;
    if (notice) text += `\n\n${notice}`;
    if (value.view !== 'main') buttonRows.push([button('back', 'uhome')]);
    return { text, buttonRows, buttonRowLabels, ...(value.view === 'result' && value.result ? { preformatted: value.result.url } : {}) };
  }

  async function showSubconv(ctx: Context): Promise<void> {
    if (supportedMessage(ctx)!.chat.type !== 'private') throw new AppError('FORBIDDEN');
    const snapshot = await resultData(ctx, await executor.execute<SubconvSnapshot>(invocation(ctx), 'subconv.settings.get', {}));
    if (!snapshot) return;
    const panel = await createPanel(ctx, { kind: 'subconv', language: languageOf(ctx), generation: 0,
      snapshot, source: '', customParams: [], view: 'main', page: 0 });
    await displayPanel(panel, subconvView(panel), supportedMessage(ctx)!.message_id);
  }

  async function saveSubconv(ctx: Context, panel: CorePanel, settings?: SubconvSettings): Promise<boolean> {
    if (panel.value.kind !== 'subconv') throw new AppError('FORBIDDEN');
    const result = await executor.execute<SubconvSnapshot>(invocation(ctx), settings ? 'subconv.settings.set' : 'subconv.settings.reset', {
      revision: panel.value.snapshot.revision, ...(settings ? { settings } : {}),
    });
    if (result.status !== 'succeeded') {
      // A stale snapshot is never silently upgraded before applying the original intent.
      await panels.close(panel, 'expired'); await resultData(ctx, result); return false;
    }
    try { panels.get(panel.id, { ...panel.binding, messageId: panel.messageId! }); }
    catch { return false; }
    panel.value.snapshot = result.data;
    return true;
  }

  async function applySubconvInput(ctx: Context, panel: CorePanel, field: SubconvInputField, text: string): Promise<void> {
    if (panel.value.kind !== 'subconv') throw new AppError('FORBIDDEN');
    const t = translator(languageOf(ctx));
    let settings: SubconvSettings | undefined;
    let customParams: SubconvCustomParam[] | undefined;
    try {
      if (field === 'source') { if (text) subconvSourceSchema.parse(text); }
      else if (field === 'customParams') customParams = parseSubconvCustomParams(text);
      else {
        settings = structuredClone(panel.value.snapshot.settings);
        if (field === 'backend') settings.backend = text;
        else settings.options[field] = text;
        settings = subconvSettingsSchema.parse(settings);
      }
    } catch {
      await displayPanel(panel, subconvView(panel, t('bot:subconv.invalidInput', { field: t(`bot:subconv.fields.${field}`) })));
      return;
    }
    refreshGeneration(panel);
    clearSubconvInput(sessionKey(ctx)!);
    if (settings && !await saveSubconv(ctx, panel, settings)) return;
    if (field === 'source') panel.value.source = text;
    if (customParams) panel.value.customParams = customParams;
    delete panel.value.input; delete panel.value.result;
    panel.value.view = 'main';
    await displayPanel(panel, subconvView(panel));
  }

  async function subconvInput(ctx: Context): Promise<boolean> {
    const pending = sessions.get(sessionKey(ctx))?.subconvInput;
    const message = ctx.update.message;
    const reply = message?.reply_to_message;
    if (!pending || !message?.text || !reply || reply.message_id !== pending.promptMessageId
      || reply.from?.id !== ctx.me.id || !reply.from.is_bot || reply.chat.id !== message.chat.id || messageTopicId(reply) !== messageTopicId(message)) return false;
    if (message.chat.type !== 'private') return false;
    let panel: CorePanel;
    try { panel = panels.get(pending.panelId, { ...binding(ctx), messageId: pending.messageId }); }
    catch { clearSubconvInput(sessionKey(ctx)!); return true; }
    if (panel.value.kind !== 'subconv' || panel.value.view !== 'input' || panel.value.input !== pending.field
      || panel.value.generation !== pending.generation || panel.value.snapshot.revision !== pending.revision) {
      clearSubconvInput(sessionKey(ctx)!); return true;
    }
    await applySubconvInput(ctx, panel, pending.field, message.text);
    return true;
  }

  async function subconvCallback(ctx: Context, panel: CorePanel, operation: string, argument?: string): Promise<void> {
    if (panel.value.kind !== 'subconv' || supportedMessage(ctx)!.chat.type !== 'private') throw new AppError('FORBIDDEN');
    if (!subconvArgumentAllowed(panel, operation, argument)) throw new AppError('FORBIDDEN');
    const value = panel.value;
    if (operation === 'uclear') { await applySubconvInput(ctx, panel, value.input!, ''); return; }
    clearSubconvInput(sessionKey(ctx)!);
    refreshGeneration(panel);
    value.language = languageOf(ctx);
    delete value.result;
    if (operation === 'uinput') {
      const field = subconvInputFields[Number(argument)]!;
      value.view = 'input'; value.input = field;
      await displayPanel(panel, subconvView(panel));
      const t = translator(value.language);
      try {
        // ForceReply is send-only; never attach it to the editable main panel.
        const prompt = await call(() => bot.api.sendRichMessage(panel.binding.chatId,
          panelContent(`${t('bot:subconv.input', { field: t(`bot:subconv.fields.${field}`) })}\n${t('bot:subconv.inputHint')}`), {
            message_thread_id: panel.binding.threadId,
            reply_markup: { force_reply: true, input_field_placeholder: t(`bot:subconv.fields.${field}`).slice(0, 64) },
          }, signal));
        panels.get(panel.id, { ...binding(ctx), messageId: panel.messageId! });
        sessions.set(sessionKey(ctx), { ...sessions.get(sessionKey(ctx)), subconvInput: { panelId: panel.id, messageId: panel.messageId!,
          promptMessageId: prompt.message_id, field, revision: value.snapshot.revision, generation: value.generation } });
      } catch (error) {
        delete value.input; value.view = 'main'; refreshGeneration(panel);
        await bestEffort(() => displayPanel(panel, subconvView(panel)));
        throw error;
      }
      return;
    }
    delete value.input;
    if (operation === 'ugenerate') {
      if (!value.source || !value.snapshot.settings.backend) { await displayPanel(panel, subconvView(panel, translator(value.language)('bot:subconv.invalidInput', {
        field: translator(value.language)(!value.source ? 'bot:subconv.fields.source' : 'bot:subconv.fields.backend'),
      }))); return; }
      const result = await executor.execute<SubconvResult>(invocation(ctx), 'subconv.generate', {
        revision: value.snapshot.revision, source: value.source, customParams: value.customParams,
      });
      if (result.status !== 'succeeded') { await panels.close(panel, 'expired'); await resultData(ctx, result); return; }
      try { panels.get(panel.id, { ...panel.binding, messageId: panel.messageId! }); }
      catch { return; }
      value.result = result.data; value.view = 'result';
    } else if (operation === 'ureset') {
      if (!await saveSubconv(ctx, panel)) return;
      value.view = 'main';
    } else if (operation === 'utarget' || operation === 'upreset' || operation === 'uflag') {
      const settings = structuredClone(value.snapshot.settings);
      if (operation === 'utarget') settings.options.target = subconvTargets[Number(argument)]!.id;
      else if (operation === 'upreset') settings.options.remoteConfig = subconvPresets[Number(argument)]!.url;
      else {
        const field = subconvFlags[Number(argument)]!;
        if (field === 'udp' || field === 'tfo') settings.options[field] = settings.options[field] === null ? true : settings.options[field] ? false : null;
        else settings.options[field] = !settings.options[field];
      }
      if (!await saveSubconv(ctx, panel, settings)) return;
    } else if (operation === 'upage') value.page = Number(argument);
    else {
      value.view = operation === 'utargets' ? 'targets' : operation === 'upresets' ? 'presets'
        : operation === 'uoptions' ? 'options' : operation === 'ufilters' ? 'filters' : 'main';
      value.page = 0;
    }
    await displayPanel(panel, subconvView(panel));
  }

  async function handleCommand(ctx: Context, name: string, argument: string): Promise<void> {
    const t = translator(languageOf(ctx));
    const message = supportedMessage(ctx)!;
    const admin = access.isAdmin(ctx.from!.id);
    const privateChat = message.chat.type === 'private';
    const metadata = commands.find(command => command.name === name);
    if (!metadata) {
      const suggestions = suggestCommands(name, admin, privateChat, command => executor.aliasesFor(command));
      await send(ctx, suggestions.length
        ? t('bot:unknownCommandSuggestion', { commands: suggestions.map(command => `/${command}`).join(', ') })
        : t('bot:unknownCommand'));
      return;
    }
    if (metadata.admin && !admin) { await sendError(ctx, 'FORBIDDEN'); return; }
    if (metadata.private && !privateChat) { await send(ctx, t('bot:privateOnly')); return; }
    if (await ai.command(ctx, name, argument)) return;
    switch (name) {
      case 'start': {
        const info = await resultData(ctx, await executor.execute(invocation(ctx), 'core.info', {}));
        if (info) await send(ctx, t('bot:start'));
        return;
      }
      case 'help': {
        const markdown = helpMarkdown(languageOf(ctx), admin, privateChat);
        if (Array.from(markdown).length > 32768) { await send(ctx, t('bot:outputTooLong')); return; }
        await call(() => bot.api.raw.sendRichMessage({
          chat_id: message.chat.id, rich_message: { markdown }, message_thread_id: messageTopicId(message),
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        }, signal));
        return;
      }
      case 'commands': await showCommands(ctx); return;
      case 'id':
        await send(ctx, t('bot:id', { userId: ctx.from!.id, chatId: message.chat.id, threadId: messageTopicId(message) ?? t('bot:noThread') }));
        return;
      case 'modules': {
        const modules = await resultData(ctx, await executor.execute<ModuleMetadata[]>(invocation(ctx), 'modules.list', {}));
        if (modules) await send(ctx, modules.length ? [t('bot:modulesTitle', { count: modules.length }),
          ...modules.map(module => `${t(module.nameKey)}\n${t(module.descriptionKey)}`)].join('\n\n') : t('bot:modulesEmpty'));
        return;
      }
      case 'alias': await aliasCommand(ctx, argument); return;
      case 'cancel': {
        sessions.delete(sessionKey(ctx));
        const aiCancelled = ai.cancel(ctx);
        for (const opening of stickerOpenings) if (opening.key === sessionKey(ctx)) opening.controller.abort();
        // Retire sources before waiting for UI edits or an active conversion's cleanup.
        const closed = panels.closeOwned(sessionKey(ctx)!, 'cancelled', panel => {
          if (panel.value.kind === 'sticker') stickers.release(invocation(ctx), panel.value.info.source);
          return panel.value.kind !== 'approval';
        });
        await Promise.all([closed, aiCancelled, ...(privateChat ? [executor.execute(invocation(ctx), 'sticker.cancel', {})] : [])]);
        await send(ctx, t('bot:cancelled')); return;
      }
      case 'stats': {
        const status = await resultData(ctx, await executor.execute<RuntimeStatus>(invocation(ctx), 'core.status', {}));
        if (!status) return;
        await call(() => bot.api.sendRichMessage(message.chat.id, statusMessage(status, languageOf(ctx)), {
          message_thread_id: messageTopicId(message),
          reply_parameters: { message_id: message.message_id, allow_sending_without_reply: true },
        }, signal));
        return;
      }
      case 'addgroup': {
        const chatId = privateChat ? Number(argument) : message.chat.id;
        if (privateChat && !/^-[1-9]\d*$/.test(argument) || !Number.isSafeInteger(chatId) || chatId >= 0
          || !privateChat && argument !== '' && argument !== String(chatId)) {
          await send(ctx, t('bot:groups.usage')); return;
        }
        await mutationReceipt(ctx, 'groups.authorize', await executor.execute<GroupMutationResult>(invocation(ctx), 'groups.authorize', {
          ...access.state(chatId),
        }));
        return;
      }
      case 'listgroups': await showGroups(ctx, 0); return;
      case 'settings': await showSettings(ctx); return;
      case 'rss': await rssCommand(ctx, argument); return;
      case 'rate': await showRate(ctx, argument && argument !== 'currencies' ? { query: argument } : undefined, undefined, 0, argument === 'currencies'); return;
      case 'weather': await weatherCommand(ctx, argument); return;
      case 'forecast': await weatherCommand(ctx, argument, true); return;
      case 'sticker': await stickerCommand(ctx, argument); return;
      case 'subconv': await showSubconv(ctx); return;
      case 'webui': {
        if (!config.web.enabled || !config.web.publicBaseUrl) { await send(ctx, t('bot:webui.disabled')); return; }
        await send(ctx, t('bot:webui.intro'), new InlineKeyboard()
          .webApp(t('bot:webui.miniapp'), config.web.publicBaseUrl).row()
          .url(t('bot:webui.browser'), config.web.publicBaseUrl));
        return;
      }
    }
  }

  async function handleCallback(ctx: Context): Promise<void> {
    const message = supportedMessage(ctx)!;
    const reopen = reopenCallback(ctx.callbackQuery?.data ?? '');
    if (reopen) {
      if (reopen.userId !== ctx.from!.id || message.from?.id !== ctx.me.id) throw new AppError('FORBIDDEN');
      // A fresh read entry: never restore old form data, mutation arguments or approval.
      await handleCommand(ctx, reopenCommands[reopen.route], '');
      return;
    }
    const parsed = panelCallback(ctx.callbackQuery?.data ?? '');
    if (!parsed) return;
    const t = translator(languageOf(ctx));
    let panel: CorePanel;
    try { panel = callbackPanel(ctx, parsed.id, parsed.operation); }
    catch (error) {
      if (safeError(error).code === 'CONFIRMATION_EXPIRED') await expireUnknown(ctx);
      return;
    }
    if (panelRoute(panel) !== parsed.route || panel.value.generation !== parsed.generation || !operationAllowed(panel, parsed.operation)
      || !subconvArgumentAllowed(panel, parsed.operation, parsed.argument)) return;
    const selection = parsed.operation === 'pick' ? { window: parsed.argument === undefined ? undefined : Number(parsed.argument) } : undefined;
    if (panel.value.kind === 'commands') {
      await showCommands(ctx, selection ? panel.value.page : Number(parsed.argument), panel, selection); return;
    }
    if (panel.value.kind === 'rss') { await rssCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    if (panel.value.kind === 'rate') { await rateCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    if (panel.value.kind === 'weather') { await weatherCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    if (panel.value.kind === 'sticker') { await stickerCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    if (panel.value.kind === 'subconv') { await subconvCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    // Administrative data and personal preferences remain private.
    if (message.chat.type !== 'private') return;
    if (panel.value.kind === 'settings' && parsed.operation === 'lang') {
      const result = await executor.execute<Preference>(invocation(ctx), 'preferences.set', { language: parsed.argument });
      if (result.status === 'succeeded') {
        await showSettings(ctx, panel, translator(result.data.resolvedLanguage)(result.data.menuSynced ? 'bot:settings.saved' : 'bot:settings.menuFailed'));
      } else {
        if ('error' in result && result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
        await showSettings(ctx, panel, t(`common:errors.${'error' in result ? result.error.code : 'INVALID_OUTPUT'}`));
      }
      return;
    }
    if (!access.isAdmin(ctx.from!.id)) { await panels.close(panel, 'expired'); return; }
    if (panel.value.kind === 'alias') { await aliasCallback(ctx, panel, parsed.operation, parsed.argument); return; }
    if (panel.value.kind === 'approval') {
      const context = invocation(ctx);
      const approval = panel.value.confirmation;
      try { executor.pending(context, approval.token); }
      catch (error) {
        if (safeError(error).code === 'CANCELLED') throw error;
        await panels.close(panel, 'expired'); return;
      }
      await panels.close(panel, 'used');
      const result = await executor.confirm<GroupMutationResult>(context, approval.token);
      if ('error' in result && result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
      const text = result.status === 'succeeded' ? mutationText(ctx, approval.actionId, result.data)
        : t(`common:errors.${'error' in result ? result.error.code : 'INVALID_OUTPUT'}`);
      // The consumed operation is never restored; only a fresh management view can open.
      await edit(() => bot.api.editMessageText(message.chat.id, message.message_id, panelContent(text, [], [[reopenButton('g', ctx.from!.id, languageOf(ctx))]]), {
        reply_markup: { inline_keyboard: [] },
      }, signal));
      return;
    }
    if (panel.value.kind === 'groups') {
      if (parsed.operation === 'page' || selection) {
        await showGroups(ctx, selection ? panel.value.page : Number(parsed.argument), panel, undefined, selection); return;
      }
      const chatId = Number(parsed.argument);
      const group = panel.value.groups.find(group => group.id === chatId);
      if (!group) return;
      if (group.groupRevision !== access.groupRevision(chatId)) {
        await showGroups(ctx, panel.value.page, panel, t('common:errors.CONFLICT'));
        return;
      }
      const result = await executor.execute<GroupMutationResult>(invocation(ctx), 'groups.revoke', { chatId, revision: panel.value.revision, groupRevision: group.groupRevision });
      if (result.status === 'pending_confirmation') await confirmation(ctx, result.confirmation);
      else {
        if ('error' in result && result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
        const notice = result.status === 'succeeded' ? mutationText(ctx, 'groups.revoke', result.data) : t(`common:errors.${result.error.code}`);
        await showGroups(ctx, panel.value.page, panel, notice);
      }
      return;
    }
    if (panel.value.kind === 'settings' && panel.value.revision !== undefined) {
      const result = await executor.execute<SettingsSnapshot>(invocation(ctx), 'core.settings.update', {
        revision: panel.value.revision, settings: { defaultLanguage: parsed.argument },
      });
      if ('error' in result && result.error.code === 'CANCELLED') throw new AppError('CANCELLED');
      const notice = result.status === 'succeeded' ? t('bot:settings.coreSaved')
        : t(`common:errors.${'error' in result ? result.error.code : 'INVALID_OUTPUT'}`);
      await showSettings(ctx, panel, notice);
    }
  }

  async function handleMembership(ctx: Context): Promise<void> {
    const event = ctx.update.my_chat_member!;
    if (!['group', 'supergroup'].includes(event.chat.type) || event.new_chat_member.user.id !== ctx.me.id) return;
    const result = await access.membership({
      chatId: event.chat.id, title: plainValue('title' in event.chat ? event.chat.title : ''),
      actorId: event.from.id, actorIsBot: event.from.is_bot,
      isMember: memberPresent(event.new_chat_member), wasMember: memberPresent(event.old_chat_member),
      updateId: ctx.update.update_id, at: new Date(event.date * 1_000).toISOString(),
    }, signal);
    if (result.kind === 'authorized' && result.changed) {
      await bestEffort(() => call(() => bot.api.sendMessage(event.chat.id,
        translator(configuration.settings().effective.defaultLanguage)('bot:groups.authorized'), {}, signal)));
      return;
    }
    if (result.kind !== 'waiting' || !result.changed) return;
    await bestEffort(() => call(() => bot.api.sendMessage(event.chat.id,
      translator(configuration.settings().effective.defaultLanguage)('bot:groups.waiting'), {}, signal)));
    for (const actorId of config.adminIds) {
      if (!access.isAdmin(actorId)) continue;
      const language = configuration.resolveLanguage(actorId);
      const t = translator(language);
      const context = createInvocation({ actorId, source: 'telegram', botId: ctx.me.id,
        chat: { id: actorId, type: 'private' }, language, signal });
      const prepared = await executor.prepare(context, 'groups.authorize', { chatId: event.chat.id, revision: result.revision, groupRevision: result.groupRevision });
      if (prepared.status === 'failed' || prepared.status === 'rejected') {
        if (prepared.error.code === 'CANCELLED') throw new AppError('CANCELLED');
        continue;
      }
      if (prepared.status !== 'pending_confirmation') continue;
      const panel = panels.create({ key: `${ctx.me.id}:${actorId}:${actorId}:0`, botId: ctx.me.id, chatId: actorId, userId: actorId, language }, {
        kind: 'approval', language, generation: 0, confirmation: prepared.confirmation,
      }, Date.parse(prepared.confirmation.expiresAt));
      await bestEffort(() => displayPanel(panel, {
        text: t('bot:groups.approval', { title: plainValue('title' in event.chat ? event.chat.title : ''), chatId: event.chat.id }),
        keyboard: new InlineKeyboard().text(t('common:actions.confirm'), callbackData(panel, 'confirm')).success(),
      }));
    }
  }

  bot.use(async (ctx, next) => {
    const work = (async () => {
      health.recordUpdate();
      if (await ai.stoppedGeneration(ctx)) return;
      if (await ai.callback(ctx)) return;
      if (ctx.callbackQuery) {
        const parsed = panelCallback(ctx.callbackQuery.data ?? '');
        const reopen = reopenCallback(ctx.callbackQuery.data ?? '');
        const message = supportedMessage(ctx);
        let language: Locale = 'en';
        try { language = configuration.resolveLanguage(ctx.callbackQuery.from.id, ctx.callbackQuery.from.language_code); } catch { /* A broken preference must not leave a callback unacknowledged. */ }
        const t = translator(language);
        let code: string | undefined;
        let panel: CorePanel | undefined;
        let invalidated = false;
        try {
          if (!message) throw new AppError('CONFIRMATION_EXPIRED');
          if (reopen) {
            if (message.from?.id !== ctx.me.id || reopen.userId !== ctx.from!.id) throw new AppError('FORBIDDEN');
            const target = commands.find(command => command.name === reopenCommands[reopen.route])!;
            if (target.admin && !access.isAdmin(ctx.from!.id) || target.private && message.chat.type !== 'private'
              || message.chat.type !== 'private' && !access.isAllowed(message.chat.id) && !access.isAdmin(ctx.from!.id)) throw new AppError('FORBIDDEN');
          } else {
            if (!parsed) throw new AppError('CONFIRMATION_EXPIRED');
            panel = callbackPanel(ctx, parsed.id, parsed.operation);
            if (message.from?.id !== ctx.me.id || panelRoute(panel) !== parsed.route) throw new AppError('FORBIDDEN');
            if (panel.value.generation !== parsed.generation) throw new AppError('CONFLICT');
            if (!operationAllowed(panel, parsed.operation)) throw new AppError('FORBIDDEN');
            if (message.chat.type !== 'private' && (!access.isAllowed(message.chat.id) || !['commands', 'rss', 'rate', 'weather'].includes(panel.value.kind))) {
              invalidated = true; throw new AppError('FORBIDDEN');
            }
            if ((panel.value.kind === 'groups' || panel.value.kind === 'approval' || panel.value.kind === 'alias' || parsed.operation === 'corelang')
              && !access.isAdmin(ctx.from!.id)) { invalidated = true; throw new AppError('FORBIDDEN'); }
            if (panel.value.kind === 'groups' && parsed.operation === 'revoke' && !panel.value.groups.some(group => group.id === Number(parsed.argument))) throw new AppError('FORBIDDEN');
            if (panel.value.kind === 'alias' && (parsed.operation === 'aliastarget' && !panel.value.targets[Number(parsed.argument)]
              || parsed.operation === 'aliasdelete' && !panel.value.removals[Number(parsed.argument)])) throw new AppError('FORBIDDEN');
            if (panel.value.kind === 'rss' && parsed.operation === 'rssitem' && !panel.value.items[Number(parsed.argument)]) throw new AppError('FORBIDDEN');
            if (!subconvArgumentAllowed(panel, parsed.operation, parsed.argument)) throw new AppError('FORBIDDEN');
            if (panel.value.kind === 'sticker' && parsed.operation === 'stformat'
              && (!panel.value.info.formats.includes(parsed.argument as StickerView['formats'][number])
                || parsed.argument === 'webp' && panel.value.delivery !== 'file')) throw new AppError('FORBIDDEN');
          }
        } catch (error) { code = safeError(error).code; }
        await bestEffort(() => call(() => bot.api.answerCallbackQuery(ctx.callbackQuery!.id, {
          text: code === 'CONFLICT' ? t('bot:panels.updated') : code === 'CONFIRMATION_EXPIRED' ? t('bot:expired') : code ? t(`common:errors.${code}`) : undefined,
        }, signal)));
        if (code) {
          if (code === 'CONFLICT' && panel?.value.kind === 'subconv' && message?.chat.type === 'private' && message.chat.id === ctx.from!.id) {
            await bestEffort(() => displayPanel(panel, subconvView(panel)));
          }
          if (code === 'CONFIRMATION_EXPIRED') await expireUnknown(ctx);
          if (invalidated && panel) await panels.close(panel, 'expired');
          return;
        }
      }
      if (stopped) return;
      throwIfAborted(signal);
      await next();
    })();
    inFlight.add(work);
    try { await work; } finally { inFlight.delete(work); }
  });
  // Install the exact exported resolver before any session lookup or mutation.
  bot.use(sequentialize(sessionKey));
  bot.use(async ctx => {
    if (ctx.update.my_chat_member) { await handleMembership(ctx); return; }
    const serviceMessage = ctx.update.message;
    if (serviceMessage && ['group', 'supergroup'].includes(serviceMessage.chat.type)
      && !serviceMessage.business_connection_id && !serviceMessage.sender_business_bot && !serviceMessage.guest_query_id
      && (serviceMessage.migrate_to_chat_id || serviceMessage.migrate_from_chat_id)) {
      const oldId = serviceMessage.migrate_from_chat_id ?? serviceMessage.chat.id;
      const newId = serviceMessage.migrate_to_chat_id ?? serviceMessage.chat.id;
      await access.migrate(oldId, newId, ctx.update.update_id, signal);
      return;
    }
    const message = supportedMessage(ctx);
    if (!message) return;
    try {
      const command = commandOf(ctx, name => executor.resolveAlias(name));
      const reopen = reopenCallback(ctx.callbackQuery?.data ?? '');
      if (message.chat.type !== 'private' && !access.isAllowed(message.chat.id)
        && !(command?.name === 'addgroup' && access.isAdmin(ctx.from!.id))) {
        if (access.isAdmin(ctx.from!.id) && ((!ctx.callbackQuery && (command || mentionsBot(ctx))) || reopen)) {
          await send(ctx, translator(languageOf(ctx))('bot:groups.adminGuide', { username: ctx.me.username }));
        }
        return;
      }
      if (ctx.callbackQuery) { await handleCallback(ctx); return; }
      if (command) { await handleCommand(ctx, command.name, command.argument); return; }
      const content = message.text ?? message.caption;
      if (content?.startsWith('/')) {
        // Commands explicitly addressed to a different bot are never ours.
        if (/^\/[^\s@]+@[a-z0-9_]+/i.test(content)) return;
        await send(ctx, translator(languageOf(ctx))('bot:unknownCommand'));
      } else if (await subconvInput(ctx)) return;
      // A pending private conversion input must never fall through to another module's bare-text intake.
      else if (sessions.get(sessionKey(ctx))?.subconvInput && !message.reply_to_message) return;
      else if (await aliasInput(ctx)) return;
      else if (await rssInput(ctx)) return;
      else if (await weatherInput(ctx)) return;
      else if (deps.ai && await ai.blockedReply(ctx)) return;
      else if (message.chat.type === 'private' && (message.sticker || message.text && stickerSetName(message.text, false))) {
        const session = sessions.get(sessionKey(ctx));
        if (!session?.aliasInput && !session?.rssInput && !session?.weatherInput && !session?.subconvInput) await stickerCommand(ctx, message.sticker ? '' : message.text!);
      }
      else if (sessions.get(sessionKey(ctx))?.subconvInput) return;
      else if (await ai.input(ctx)) return;
      else if (message.chat.type === 'private' && message.text && isWeatherIntent(message.text)) await weatherCommand(ctx, message.text);
      else if (message.chat.type === 'private' && message.text) await send(ctx, translator(languageOf(ctx))('bot:fallback'));
    } catch (error) {
      const safe = safeError(error);
      if (safe.code === 'CANCELLED') throw error;
      await bestEffort(() => sendError(ctx, safe.code));
    }
  });

  return {
    sessions,
    panels,
    async registerMenus(): Promise<void> {
      for (const [languageCode, language] of menuLanguages(configuration.settings().effective.defaultLanguage)) {
        for (const scope of ['default', 'all_private_chats', 'all_group_chats'] as const) {
          await call(() => bot.api.setMyCommands(menuCommands(language, false, scope !== 'all_group_chats'), {
            scope: { type: scope }, ...(languageCode ? { language_code: languageCode } : {}),
          }, signal));
        }
        for (const actorId of config.adminIds) {
          const preference = configuration.getPreference(actorId);
          const resolved = preference.language === 'auto' ? language : preference.resolvedLanguage;
          // An admin may not have opened the private chat yet. A missing chat
          // must not prevent the public command menu or the bot from starting.
          await bestEffort(() => call(() => bot.api.setMyCommands(menuCommands(resolved, true, true), {
            scope: { type: 'chat', chat_id: actorId }, ...(languageCode ? { language_code: languageCode } : {}),
          }, signal)));
        }
      }
    },
    async stop(): Promise<void> {
      stopped = true;
      shutdown.abort();
      sessions.stop();
      await ai.stop();
      await Promise.allSettled([...inFlight]);
      await panels.stop();
    },
  };
}
