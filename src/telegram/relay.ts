import { GrammyError, type Bot, type Context } from 'grammy';
import type { InputRichMessage, Message, RichMessageButton } from 'grammy/types';
import type { RelayContact, RelayOwnerContact, RelaySettings, RelayContactStatus, RelayContactList } from '../../shared/schemas/relay.js';
import { createInvocation, type ActionExecutor, type InvocationContext } from '../actions.js';
import type { AccessService } from '../access.js';
import type { ConfigurationService } from '../configuration.js';
import { AppError, safeError, throwIfAborted } from '../errors.js';
import { translator } from '../i18n.js';
import { RelayTransportError, type RelayService, type RelayTransport } from '../modules/relay.js';
import { telegramCall, telegramSignal } from './effects.js';
import { PanelStore, type Panel } from './panels.js';
import { messageTopicId, sessionKey } from './session.js';

const nameText = (name: string) => Array.from(name).slice(0, 60).map(character => {
  const code = character.codePointAt(0)!;
  return code < 32 || code === 127 || code >= 0x202a && code <= 0x202e || code >= 0x2066 && code <= 0x2069 ? ' ' : character;
}).join('');
const readCallback = (id: string) => `rn:${id}`;

export function createRelayTransport(bot: Bot, configuration: ConfigurationService): RelayTransport {
  async function effect<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    throwIfAborted(signal);
    try { return await work(); }
    catch (error) {
      if (error instanceof GrammyError) throw new RelayTransportError(error.error_code);
      throw new AppError('OUTCOME_UNKNOWN');
    }
  }
  return {
    async notify(target, notice, signal) {
      const t = translator(configuration.resolveLanguage(target.chatId, target.languageHint));
      const blocks: InputRichMessage['blocks'] = [{ type: 'paragraph', text: { type: 'marked', text: t('bot:relay.title') } }];
      if (notice.kind === 'request') {
        blocks.push({ type: 'paragraph', text: [t('bot:relay.newRequest'), '\n', { type: 'marked', text: nameText(notice.visitor.name) },
          ...(notice.visitor.username ? [`\n@${notice.visitor.username}`] : []), `\nID: ${notice.visitor.id}`] });
      } else blocks.push({ type: 'paragraph', text: t(`bot:relay.states.${notice.kind}`) });
      blocks.push({ type: 'buttons', buttons: [{ text: t('bot:relay.open'), callback_data: readCallback(notice.contactId) }] });
      const sent = await effect(signal, () => bot.api.sendRichMessage(target.chatId, { blocks, skip_entity_detection: true }, {
        message_thread_id: target.threadId, protect_content: true,
      }, telegramSignal(signal)));
      return sent.message_id;
    },
    async copy(source, target, signal) {
      const sent = await effect(signal, () => bot.api.copyMessage(target.chatId, source.chatId, source.messageId, {
        message_thread_id: target.threadId,
        ...(target.replyTo === undefined ? {} : { reply_parameters: { message_id: target.replyTo, allow_sending_without_reply: true } }),
        protect_content: Boolean(target.contact),
        reply_markup: { inline_keyboard: target.contact
          ? [[{ text: nameText(target.contact.name), callback_data: readCallback(target.contact.id) }]] : [] },
      }, telegramSignal(signal)));
      return sent.message_id;
    },
  };
}

interface RelayPanel {
  owner: boolean;
  generation: number;
  page: number;
  available: boolean;
  contact?: RelayContact | RelayOwnerContact;
  settings?: RelaySettings;
  items: RelayOwnerContact[];
  total: number;
  confirm?: 'enable' | 'disable';
  allowed: string[];
}
type Dependencies = {
  relay?: RelayService; executor: ActionExecutor; access: AccessService; configuration: ConfigurationService;
  signal: AbortSignal; health: { recordApiError: (code: string) => void };
};

export function createRelayTelegramAdapter(bot: Bot, deps: Dependencies) {
  const shutdown = new AbortController();
  const signal = telegramSignal(AbortSignal.any([deps.signal, shutdown.signal]));
  const tasks = new Set<Promise<void>>();
  const albums = new Map<string, { replyTo?: number; expires: number }>();
  let stopped = false;
  const call = <T>(work: () => Promise<T>) => telegramCall(deps.health, signal, work);
  const message = (ctx: Context) => ctx.update.message ?? ctx.callbackQuery?.message;
  const eligible = (ctx: Context) => Boolean(deps.relay && sessionKey(ctx) && message(ctx)?.chat.type === 'private' && message(ctx)?.chat.id === ctx.from?.id);
  function context(ctx: Context, phase = ''): InvocationContext {
    const input = message(ctx);
    if (!deps.relay || !input || !sessionKey(ctx) || input.chat.type !== 'private' || input.chat.id !== ctx.from!.id) throw new AppError('FORBIDDEN');
    return createInvocation({ actorId: ctx.from!.id, botId: ctx.me.id, source: 'telegram',
      chat: { id: input.chat.id, type: 'private', threadId: messageTopicId(input) },
      language: deps.configuration.resolveLanguage(ctx.from!.id, ctx.from!.language_code),
      invocationId: `tg:${ctx.update.update_id}${phase ? `:relay:${phase}` : ''}`, signal });
  }
  function binding(ctx: Context) {
    const value = context(ctx);
    return { key: sessionKey(ctx)!, botId: value.botId, chatId: value.chat.id, userId: value.actorId,
      threadId: value.chat.threadId, language: value.language };
  }
  const homeButton = (owner: boolean, language: InvocationContext['language']): RichMessageButton => ({
    text: translator(language)('bot:relay.open'), callback_data: owner ? 'rh:o' : 'rh:v',
  });
  const panels = new PanelStore<RelayPanel>({ onClose: async panel => {
    if (stopped || panel.messageId === undefined) return;
    try { await call(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, {
      skip_entity_detection: true, blocks: [{ type: 'paragraph', text: translator(panel.binding.language)('bot:relay.expired') },
        { type: 'buttons', buttons: [homeButton(panel.value.owner, panel.binding.language)] }],
    }, {}, signal)); } catch { /* Closed controls do not regain mutation authority after a failed edit. */ }
  } });
  async function execute<T>(ctx: Context, id: string, input: unknown, phase = id): Promise<T> {
    const result = await deps.executor.execute<T>(context(ctx, phase), id, input);
    if (result.status !== 'succeeded') throw new AppError('error' in result ? result.error.code : 'CONFIRMATION_REQUIRED');
    return result.data;
  }
  async function tell(ctx: Context, text: string): Promise<void> {
    const value = context(ctx);
    await call(() => bot.api.sendRichMessage(value.chat.id, { blocks: [{ type: 'paragraph', text }], skip_entity_detection: true }, {
      message_thread_id: value.chat.threadId,
    }, signal));
  }
  async function failure(ctx: Context, error: unknown): Promise<void> {
    const safe = safeError(error);
    if (stopped || signal.aborted || safe.code === 'CANCELLED') return;
    const t = translator(context(ctx).language);
    try { await tell(ctx, safe.code === 'OUTCOME_UNKNOWN' ? t('bot:relay.deliveryUnknown') : t(`common:errors.${safe.code}`)); }
    catch { /* No retries or raw Telegram diagnostics after a failed delivery. */ }
  }
  async function ownerInbox(ctx: Context): Promise<boolean> {
    if (!deps.access.isAdmin(ctx.from!.id)) return false;
    const result = await deps.executor.execute<RelaySettings>(context(ctx, 'owner-check'), 'relay.settings.get', {});
    if (result.status === 'succeeded') return result.data.ownerBound;
    if ('error' in result && result.error.code === 'FORBIDDEN') return false;
    throw new AppError('error' in result ? result.error.code : 'CONFIRMATION_REQUIRED');
  }
  function capture(ctx: Context, replyTo?: number): string {
    const source = ctx.update.message;
    if (!source) throw new AppError('FORBIDDEN');
    return deps.relay!.capture(context(ctx), { messageId: source.message_id,
      sentAt: source.date * 1000,
      name: Array.from([ctx.from!.first_name, ctx.from!.last_name].filter(Boolean).join(' ')).slice(0, 128).join(''),
      ...(ctx.from!.username ? { username: ctx.from!.username } : {}),
      ...(replyTo === undefined ? {} : { replyToMessageId: replyTo }) });
  }
  function render(panel: Panel<RelayPanel>): InputRichMessage {
    const value = panel.value; const t = translator(panel.binding.language); value.allowed = [];
    const button = (op: string, label: string, arg?: number): RichMessageButton => {
      const suffix = `${op}${arg === undefined ? '' : `:${arg}`}`; value.allowed.push(suffix);
      const data = `rl:${panel.id}:${value.generation.toString(36)}:${suffix}`;
      if (Buffer.byteLength(data) > 64) throw new AppError('CAPACITY');
      return { text: label, callback_data: data };
    };
    const blocks: InputRichMessage['blocks'] = [{ type: 'paragraph', text: { type: 'marked', text: t(value.owner ? 'bot:relay.inbox' : 'bot:relay.title') } }];
    if (value.confirm) {
      blocks.push({ type: 'paragraph', text: t(value.confirm === 'enable' ? 'bot:relay.enableConfirm' : 'bot:relay.disableConfirm') },
        { type: 'buttons', buttons: [button('apply', t('common:actions.confirm')), button('home', t('common:actions.cancel'))] });
      return { blocks, skip_entity_detection: true };
    }
    if (value.contact) {
      const item = value.contact;
      if ('visitor' in item) blocks.push({ type: 'paragraph', text: [{ type: 'marked', text: nameText(item.visitor.name) },
        ...(item.visitor.username ? [`\n@${item.visitor.username}`] : []), `\nID: ${item.visitor.id}`] });
      blocks.push({ type: 'paragraph', text: t(`bot:relay.states.${item.status}`) });
      if (value.owner) blocks.push({ type: 'paragraph', text: t('bot:relay.ownerHint') });
      else if (item.status === 'accepted') blocks.push({ type: 'paragraph', text: t(item.routingActive ? 'bot:relay.active' : 'bot:relay.paused') });
      if (value.owner && item.status === 'pending') blocks.push({ type: 'buttons', buttons: [button('accept', t('bot:relay.accept')), button('decline', t('bot:relay.decline'))] });
      if (!value.owner && item.status === 'accepted') blocks.push({ type: 'buttons', buttons: [button(item.routingActive ? 'pause' : 'resume', t(item.routingActive ? 'bot:relay.pause' : 'bot:relay.resume'))] });
      if (['pending', 'accepted'].includes(item.status)) blocks.push({ type: 'buttons', buttons: [button('close', t('bot:relay.end'))] });
      if (value.owner && item.status !== 'blocked') blocks.push({ type: 'buttons', buttons: [button('block', t('bot:relay.block'))] });
      if (!value.owner && value.available && ['declined', 'closed'].includes(item.status)) blocks.push({ type: 'paragraph', text: t('bot:relay.intro') });
      blocks.push({ type: 'buttons', buttons: [button('home', t('bot:panels.back'))] });
    } else if (value.owner) {
      blocks.push({ type: 'paragraph', text: t(value.settings?.enabled ? 'bot:relay.ownerHint' : 'bot:relay.disabled') });
      blocks.push({ type: 'buttons', buttons: [button(value.settings?.enabled ? 'disable' : 'enable', t(value.settings?.enabled ? 'bot:relay.disable' : 'bot:relay.enable'))] });
      if (!value.items.length) blocks.push({ type: 'paragraph', text: t('bot:relay.empty') });
      for (const [index, item] of value.items.entries()) blocks.push({ type: 'buttons', buttons: [button('select', `${nameText(item.visitor.name)} - ${t(`bot:relay.states.${item.status}`)}`, index)] });
      const navigation: RichMessageButton[] = [];
      if (value.page > 0) navigation.push(button('page', t('common:actions.previous'), value.page - 1));
      if (value.page + 1 < value.total) navigation.push(button('page', t('common:actions.next'), value.page + 1));
      if (navigation.length) blocks.push({ type: 'buttons', buttons: navigation });
    } else {
      blocks.push({ type: 'paragraph', text: t(value.available ? 'bot:relay.intro' : 'bot:relay.unavailable') });
    }
    return { blocks, skip_entity_detection: true };
  }
  async function show(ctx: Context, owner: boolean, options: { contact?: string; page?: number; current?: Panel<RelayPanel>; confirm?: 'enable' | 'disable' } = {}): Promise<void> {
    const value: RelayPanel = { owner, generation: (options.current?.value.generation ?? -1) + 1, page: options.page ?? 0,
      available: false, items: [], total: 0, allowed: [], ...(options.confirm ? { confirm: options.confirm } : {}) };
    if (owner) {
      value.settings = await execute(ctx, 'relay.settings.get', {}, `settings:${value.generation}`);
      deps.relay!.focus(context(ctx));
      value.available = value.settings!.enabled;
      if (value.settings!.ownerBound) {
        const list = await execute<RelayContactList>(ctx, 'relay.contacts.list', { page: value.page }, `list:${value.generation}`);
        value.items = list.items; value.total = list.totalPages;
      }
    } else {
      const status = await execute<RelayContactStatus>(ctx, 'relay.contact.status', {}, `status:${value.generation}`);
      value.available = status.available;
      if (status.contact) value.contact = status.contact;
    }
    if (options.contact) {
      if (owner) value.contact = await execute(ctx, 'relay.contacts.get', { id: options.contact }, `contact:${value.generation}`);
      else if (value.contact?.id !== options.contact) throw new AppError('FORBIDDEN');
    }
    const panel = options.current ?? panels.create(binding(ctx), value);
    if (!options.current) await panels.closeOwned(panel.binding.key, 'replaced', other => other !== panel);
    panel.value = value;
    await panels.render(panel, async () => {
      const rich = render(panel);
      if (panel.messageId === undefined) {
        const sent = await call(() => bot.api.sendRichMessage(panel.binding.chatId, rich, { message_thread_id: panel.binding.threadId, protect_content: true }, signal));
        panel.messageId = sent.message_id;
      } else await call(() => bot.api.editMessageText(panel.binding.chatId, panel.messageId!, rich, {}, signal));
    });
    if (panel.messageId !== undefined) await panels.attach(panel, panel.messageId);
  }
  async function request(ctx: Context): Promise<void> {
    const item = await execute<RelayContact>(ctx, 'relay.contact.request', { source: capture(ctx) });
    await show(ctx, false, { contact: item.id });
  }
  const isCallback = (ctx: Context) => /^(?:rl:|rn:|rh:)/.test(ctx.callbackQuery?.data ?? '');
  function key(ctx: Context): string | undefined {
    for (const [id, album] of albums) if (album.expires <= Date.now()) albums.delete(id);
    const id = ctx.update.message?.media_group_id;
    return id && sessionKey(ctx) ? `${sessionKey(ctx)}:${id}` : undefined;
  }
  function supported(input: Message): boolean {
    return !input.has_protected_content && !input.rich_message && !input.reply_markup && Boolean(input.text || input.photo?.length || input.video
      || input.animation || input.audio || input.voice || input.video_note || input.sticker || input.document || input.location || input.venue || input.contact);
  }
  return {
    isCallback,
    async acknowledge(ctx: Context): Promise<boolean> {
      const allowed = eligible(ctx) && message(ctx)?.from?.id === ctx.me.id;
      try { await call(() => bot.api.answerCallbackQuery(ctx.callbackQuery!.id, allowed ? {} : {
        text: translator(deps.configuration.resolveLanguage(ctx.from!.id, ctx.from!.language_code))('common:errors.FORBIDDEN'), show_alert: true,
      }, signal)); } catch { /* The scoped handler still validates every operation. */ }
      return allowed;
    },
    suspend(ctx: Context): void { if (eligible(ctx)) deps.relay!.suspend(context(ctx)); },
    ownsMessage(ctx: Context): boolean {
      return eligible(ctx) && !!ctx.update.message && deps.relay!.ownsMessage(context(ctx), ctx.update.message.message_id);
    },
    ownsAlbum(ctx: Context): boolean { const id = key(ctx); return !!id && albums.has(id); },
    async command(ctx: Context, name: string, argument: string): Promise<boolean> {
      if (name !== 'contact' && name !== 'relay') return false;
      context(ctx);
      if (name === 'relay') { if (argument) throw new AppError('INVALID_INPUT'); await show(ctx, true); return true; }
      if (argument && !['pause', 'resume', 'end'].includes(argument)) throw new AppError('INVALID_INPUT');
      const status = await execute<RelayContactStatus>(ctx, 'relay.contact.status', {}, 'command-status');
      if (await ownerInbox(ctx)) { await show(ctx, true); return true; }
      if (argument === 'pause') await execute(ctx, 'relay.cancel', {});
      else if (argument === 'end' && status.contact) await execute(ctx, 'relay.contact.close', { id: status.contact.id, revision: status.contact.revision });
      else if (argument === 'resume' && status.contact) {
        capture(ctx);
        await execute(ctx, 'relay.contact.resume', { id: status.contact.id, revision: status.contact.revision });
      }
      else if (!argument && status.available && (!status.contact || ['closed', 'declined'].includes(status.contact.status))) { await request(ctx); return true; }
      await show(ctx, false); return true;
    },
    async callback(ctx: Context): Promise<void> {
      const invocation = context(ctx); const input = message(ctx)!;
      if (input.from?.id !== ctx.me.id) throw new AppError('FORBIDDEN');
      const data = ctx.callbackQuery?.data ?? '';
      if (data === 'rh:o' || data === 'rh:v') { await show(ctx, data === 'rh:o'); return; }
      const read = /^rn:([a-f0-9]{24})$/.exec(data);
      if (read) {
        await show(ctx, await ownerInbox(ctx), { contact: read[1]! }); return;
      }
      const match = /^rl:([a-f0-9]{24}):([a-z0-9]+):([a-z]+)(?::(\d+))?$/.exec(data);
      if (!match) throw new AppError('CONFIRMATION_EXPIRED');
      let panel: Panel<RelayPanel>;
      try { panel = panels.get(match[1]!, { ...binding(ctx), messageId: input.message_id }); }
      catch (error) { if (safeError(error).code === 'CONFIRMATION_EXPIRED') await tell(ctx, translator(invocation.language)('bot:relay.expired')); else throw error; return; }
      if (panel.value.generation !== parseInt(match[2]!, 36)) throw new AppError('CONFLICT');
      const op = match[3]!; const argument = match[4];
      if (!panel.value.allowed.includes(`${op}${argument === undefined ? '' : `:${argument}`}`)) throw new AppError('FORBIDDEN');
      const value = panel.value;
      if (op === 'enable' || op === 'disable') { await show(ctx, true, { current: panel, confirm: op }); return; }
      if (op === 'apply') {
        if (!value.settings || !value.confirm) throw new AppError('FORBIDDEN');
        await execute(ctx, 'relay.settings.set', { enabled: value.confirm === 'enable', revision: value.settings.revision });
        await show(ctx, true, { current: panel }); return;
      }
      if (op === 'select') { await show(ctx, true, { current: panel, contact: value.items[Number(argument)]!.id }); return; }
      if (op === 'page') { await show(ctx, true, { current: panel, page: Number(argument) }); return; }
      if (op === 'home') { await show(ctx, value.owner, { current: panel }); return; }
      if (!value.contact) throw new AppError('FORBIDDEN');
      if (op === 'pause') await execute(ctx, 'relay.cancel', {});
      else await execute(ctx, `relay.contact.${op}`, { id: value.contact.id, revision: value.contact.revision });
      await show(ctx, value.owner, { current: panel, contact: value.contact.id });
    },
    async input(ctx: Context): Promise<boolean> {
      const input = ctx.update.message;
      if (!deps.relay || !input || input.chat.type !== 'private' || !sessionKey(ctx)) return false;
      const invocation = context(ctx); const albumId = key(ctx); const existing = albumId ? albums.get(albumId) : undefined;
      const reply = input.reply_to_message;
      if (reply && (reply.chat.id !== input.chat.id || messageTopicId(reply) !== messageTopicId(input))) return true;
      const replyTo = reply?.message_id ?? existing?.replyTo;
      if (existing && reply?.message_id !== undefined && existing.replyTo !== reply.message_id) return true;
      const classification = deps.relay.classify(invocation, replyTo);
      if (classification === 'none' && !existing) return false;
      if (albumId && !existing) {
        if (albums.size >= 128) throw new AppError('CAPACITY');
        albums.set(albumId, { replyTo, expires: Date.now() + 120_000 });
      }
      if (classification === 'blocked' || classification === 'none') {
        if (!existing) {
          const t = translator(invocation.language);
          const status = await execute<RelayContactStatus>(ctx, 'relay.contact.status', {}, 'blocked-status');
          const hint = await ownerInbox(ctx) ? 'bot:relay.ownerHint' : status.contact?.status === 'pending'
            ? 'bot:relay.states.pending' : replyTo === undefined ? 'bot:relay.paused' : 'bot:relay.expired';
          await tell(ctx, t(hint));
        }
        return true;
      }
      if (!supported(input)) { await tell(ctx, translator(invocation.language)('bot:relay.unsupported')); return true; }
      const source = capture(ctx, replyTo);
      // Return to the per-chat update lane so /cancel can abort and drain this operation.
      const task = execute(ctx, 'relay.send', { source }).then(() => undefined).catch(error => failure(ctx, error));
      tasks.add(task); void task.finally(() => tasks.delete(task)).catch(() => undefined);
      return true;
    },
    async cancel(ctx: Context): Promise<void> {
      if (!deps.relay || message(ctx)?.chat.type !== 'private' || !sessionKey(ctx)) return;
      await execute(ctx, 'relay.cancel', {});
      await panels.closeOwned(sessionKey(ctx)!, 'cancelled');
    },
    async stop(): Promise<void> {
      stopped = true; shutdown.abort(); albums.clear();
      await panels.stop(); await Promise.allSettled([...tasks]);
    },
  };
}
