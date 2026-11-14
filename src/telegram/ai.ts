import { createHash, randomInt } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Bot, Context, GrammyError, InputFile } from 'grammy';
import type { InputRichMessageWithoutUpload, Message, RichMessageButton } from 'grammy/types';
import { aiOutputTextLimits, type AiConversation, type AiMemory, type AiPage, type AiSettingsSnapshot, type AiTurn } from '../../shared/schemas/ai.js';
import type { AutomationView } from '../../shared/schemas/ai-automation.js';
import { confirmationSchema, errorCodeSchema, type ActionResult, type Confirmation } from '../../shared/schemas/index.js';
import { createInvocation, type ActionExecutor, type InvocationContext } from '../actions.js';
import type { AccessService } from '../access.js';
import type { AiCapturedFile, AiDelivery, AiDeliveryTarget, AiTelegramPort } from '../ai/telegram-port.js';
import type { ConfigurationService } from '../configuration.js';
import { AppError, safeError, throwIfAborted } from '../errors.js';
import { translator } from '../i18n.js';
import { plainValue, telegramSignal, type ApiHealth } from './effects.js';
import { PanelStore, type Panel } from './panels.js';
import { messageTopicId, sessionKey } from './session.js';
import { panelContent } from './rich.js';

const maxBytes = 1_048_576;
const maxText = 32_768;
const maxProposalBytes = 32 * 1024;
type StructuredMessage = { blocks: NonNullable<InputRichMessageWithoutUpload['blocks']>; skip_entity_detection?: boolean };
type Control = { label: string; action: string; input: Record<string, unknown>; confirmation?: string };
type Controls = { items: Control[]; signal?: AbortSignal; generation?: number; busy?: boolean; executing?: boolean;
  reopen?: Control; receipt?: string; runId?: string; proposal?: StructuredMessage };
type Proposal = { key: string; runId?: string; expiresAt: number; digest: string; controller: AbortController;
  work?: Promise<void>; failed?: ReturnType<typeof safeError>['code'] };
type Run = {
  target: AiDeliveryTarget; controller: AbortController; signal: AbortSignal; turnSignal: AbortSignal; detach: () => void;
  draftId: number; messageId?: number; panel: Panel<Controls>; text: string; hasOutput: boolean;
  nextAt: number; timer?: ReturnType<typeof setTimeout>; work?: Promise<void>; retirement?: Promise<void>; finalizing: boolean; uncertain: boolean;
};
type Album = { context: InvocationContext; files: AiCapturedFile[]; text: string; replyTo?: number; invalid: boolean; timer: ReturnType<typeof setTimeout> };

export interface AiAdapterDependencies {
  ai?: AiTelegramPort;
  executor: Pick<ActionExecutor, 'execute' | 'confirm' | 'pendingDetails'>;
  access: Pick<AccessService, 'isAdmin' | 'isAllowed'>;
  configuration: Pick<ConfigurationService, 'resolveLanguage'>;
  health: ApiHealth;
  signal: AbortSignal;
  token: string;
  fetch?: typeof fetch;
}

// Controls, parameters and server notices remain literal, separate from model answer formatting.
function rich(text: string, buttons: RichMessageButton[][] = []): StructuredMessage {
  if (typeof text !== 'string' || text.length > maxText) throw new AppError('INVALID_OUTPUT');
  return { blocks: [{ type: 'paragraph', text }, ...buttons.map(row => ({ type: 'buttons' as const, buttons: row }))], skip_entity_detection: true };
}
let answerRenderer: Promise<typeof import('./ai-rich.js')> | undefined;
async function answer(text: string): Promise<StructuredMessage> {
  return (await (answerRenderer ??= import('./ai-rich.js'))).aiAnswerContent(text);
}

function captureFile(message: Message): AiCapturedFile | undefined {
  if (message.video || message.video_note || message.animation) throw new AppError('INVALID_INPUT');
  const photo = message.photo?.findLast(item => item.file_size !== undefined && item.file_size <= maxBytes);
  if (message.photo?.length && !photo) throw new AppError('CAPACITY');
  const file = photo ?? message.voice ?? message.audio ?? message.document ?? message.sticker;
  if (!file) return undefined;
  const sticker = message.sticker;
  const mimeType = photo ? 'image/jpeg' : message.voice ? 'audio/ogg' : sticker
    ? sticker.is_animated ? 'application/x-tgsticker' : sticker.is_video ? 'video/webm' : 'image/webp'
    : message.audio?.mime_type ?? message.document?.mime_type ?? '';
  const imageDocument = Boolean(message.document && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mimeType));
  if (!Number.isSafeInteger(file.file_size) || file.file_size! < 1 || file.file_size! > maxBytes
    || !file.file_id || file.file_id.length > 512 || !file.file_unique_id || file.file_unique_id.length > 256
    || message.audio && !['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/flac'].includes(mimeType)
    || message.document && !imageDocument && !['application/pdf', 'text/plain'].includes(mimeType)) throw new AppError('INVALID_INPUT');
  return { fileId: file.file_id, uniqueId: file.file_unique_id, size: file.file_size!, mimeType,
    kind: photo || imageDocument ? 'image' : sticker ? 'sticker' : message.document ? 'document' : 'audio',
    name: photo ? 'photo.jpg' : sticker ? 'sticker' : message.voice ? 'voice.ogg'
      : Array.from(message.audio?.file_name ?? message.document?.file_name ?? 'attachment').map(c => c.charCodeAt(0) < 32 || '/\\'.includes(c) ? '_' : c).join('').slice(0, 128) };
}

function validateFile(file: AiCapturedFile, bytes: Uint8Array): void {
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 16));
  const starts = (text: string, offset = 0) => header.toString('ascii', offset, offset + text.length) === text;
  if (file.mimeType === 'text/plain') {
    if (bytes.includes(0)) throw new AppError('INVALID_INPUT');
    const decoder = new TextDecoder('utf-8', { fatal: true });
    try {
      for (let offset = 0; offset < bytes.byteLength; offset += 65_536) decoder.decode(bytes.subarray(offset, offset + 65_536), { stream: true });
      decoder.decode();
    } catch { throw new AppError('INVALID_INPUT'); }
    return;
  }
  const valid = file.mimeType === 'application/pdf' ? starts('%PDF-')
    : file.mimeType === 'image/jpeg' ? header[0] === 255 && header[1] === 216 && header[2] === 255
      : file.mimeType === 'image/png' ? header.subarray(0, 8).toString('hex') === '89504e470d0a1a0a'
        : file.mimeType === 'image/gif' ? starts('GIF87a') || starts('GIF89a')
      : file.mimeType === 'image/webp' ? starts('RIFF') && starts('WEBP', 8)
        : file.mimeType === 'application/x-tgsticker' ? header[0] === 31 && header[1] === 139 && header[2] === 8
          : file.mimeType === 'video/webm' && file.kind === 'sticker' ? header.subarray(0, 4).toString('hex') === '1a45dfa3'
            : file.mimeType === 'audio/ogg' ? starts('OggS')
              : file.mimeType === 'audio/mp4' ? starts('ftyp', 4)
                : file.mimeType === 'audio/mpeg' ? starts('ID3') || header[0] === 255 && (header[1]! & 224) === 224
                  : file.mimeType === 'audio/flac' ? starts('fLaC')
                    : ['audio/wav', 'audio/x-wav'].includes(file.mimeType) && starts('RIFF') && starts('WAVE', 8);
  if (!valid) throw new AppError('INVALID_INPUT');
}

export function createAiTelegramAdapter(bot: Bot, deps: AiAdapterDependencies) {
  const shutdown = new AbortController();
  const signal = AbortSignal.any([deps.signal, shutdown.signal]);
  const runs = new Map<string, Run>();
  const proposals = new Map<string, Proposal>();
  const exports = new Map<string, { key: string; controller: AbortController; work?: Promise<void> }>();
  const albums = new Map<string, Album>();
  const closedAlbums = new Map<string, number>();
  const pending = new Set<Promise<unknown>>();
  let cacheTimer: ReturnType<typeof setTimeout> | undefined;
  let backoffUntil = 0;
  const track = <T>(task: Promise<T>): Promise<T> => {
    pending.add(task);
    void task.then(() => pending.delete(task), () => pending.delete(task));
    return task;
  };
  function pruneCaches() {
    if (cacheTimer) clearTimeout(cacheTimer);
    cacheTimer = undefined;
    const now = Date.now(); const deadlines: number[] = [];
    for (const [token, entry] of proposals) {
      if (entry.work) continue;
      if (entry.expiresAt <= now) proposals.delete(token);
      else deadlines.push(entry.expiresAt);
    }
    for (const [key, expiry] of closedAlbums) {
      if (expiry <= now) closedAlbums.delete(key);
      else deadlines.push(expiry);
    }
    if (signal.aborted || !deadlines.length) return;
    cacheTimer = setTimeout(pruneCaches, Math.min(2_147_483_647, Math.max(0, Math.min(...deadlines) - now)));
    cacheTimer.unref();
  }
  const language = (ctx: Context) => deps.configuration.resolveLanguage(ctx.from!.id, ctx.from?.language_code);
  const context = (ctx: Context, phase = ''): InvocationContext => {
    const message = ctx.update.message ?? ctx.update.callback_query?.message;
    if (!message || !sessionKey(ctx)) throw new AppError('FORBIDDEN');
    return createInvocation({ actorId: ctx.from!.id, botId: ctx.me.id, source: 'telegram', language: language(ctx),
      chat: { id: message.chat.id, type: message.chat.type as InvocationContext['chat']['type'], threadId: messageTopicId(message) },
      signal, invocationId: `telegram:${ctx.me.id}:${ctx.update.update_id}:ai${phase}` });
  };
  const scopeKey = (target: Pick<AiDeliveryTarget, 'botId' | 'actorId' | 'chat'>) =>
    `${target.botId}:${target.chat.id}:${target.actorId}:${target.chat.threadId ?? 0}`;
  const binding = (target: AiDeliveryTarget | InvocationContext) => ({ key: scopeKey(target), botId: target.botId,
    userId: target.actorId, chatId: target.chat.id, threadId: target.chat.threadId, language: target.language });
  const checkTarget = (target: Pick<AiDeliveryTarget, 'botId' | 'actorId' | 'chat'>) => {
    if (target.botId !== bot.botInfo.id || target.chat.type === 'private' && target.chat.id !== target.actorId
      || target.chat.type !== 'private' && !deps.access.isAllowed(target.chat.id)) throw new AppError('FORBIDDEN');
  };

  async function api<T>(operation: (s: ReturnType<typeof telegramSignal>) => Promise<T>, requestSignal = signal, persistent = false, control = false, retry = true): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(requestSignal);
      if (!control && backoffUntil > Date.now()) await delay(backoffUntil - Date.now(), undefined, { signal: requestSignal });
      try { return await operation(telegramSignal(requestSignal)); }
      catch (error) {
        deps.health.recordApiError(error instanceof GrammyError ? `TELEGRAM_${error.error_code}` : 'TELEGRAM_UNAVAILABLE');
        if (error instanceof GrammyError && error.error_code === 429) {
          const seconds = error.parameters.retry_after;
          const wait = Number.isFinite(seconds) && seconds! >= 0 ? Math.max(1000, seconds! * 1000) : 1000;
          backoffUntil = Date.now() + wait;
          if (retry && !control && attempt < 2 && wait <= 60_000) continue;
          throw new AppError('RATE_LIMITED');
        }
        if (error instanceof GrammyError && error.error_code === 400 && error.description.startsWith('Bad Request: message is not modified')) return true as T;
        if (persistent && (!(error instanceof GrammyError) || error.error_code >= 500)) throw new AppError('OUTCOME_UNKNOWN');
        throwIfAborted(requestSignal);
        throw new AppError(error instanceof GrammyError && error.error_code === 403 ? 'FORBIDDEN' : 'UNAVAILABLE');
      }
    }
  }

  function controlContent(panel: Panel<Controls>, notice: string, rows: RichMessageButton[][] = []): StructuredMessage {
    if (!panel.value.proposal) return rich(notice, rows);
    return { blocks: [...panel.value.proposal.blocks, { type: 'paragraph', text: notice },
      ...rows.map(buttons => ({ type: 'buttons' as const, buttons }))], skip_entity_detection: true };
  }
  const panels = new PanelStore<Controls>({ capacity: 128, onClose: async (panel, reason) => {
    panel.value.items = [];
    if (signal.aborted || panel.messageId === undefined) return;
    const t = translator(panel.binding.language);
    const text = panel.value.receipt ?? t(panel.value.executing ? 'bot:ai.pendingOutcome'
      : reason === 'cancelled' ? 'bot:ai.cancelled' : reason === 'used' ? 'bot:ai.used' : 'bot:ai.expired');
    let rows: RichMessageButton[][] = [];
    let fresh: Panel<Controls> | undefined;
    if (panel.value.reopen && reason !== 'replaced') {
      // Keep only a read-only route and display text, never executable old parameters or approval tokens.
      try {
        fresh = panels.create(panel.binding, { items: [panel.value.reopen], receipt: text, proposal: panel.value.proposal });
        await panels.attach(fresh, panel.messageId);
        rows = buttons(fresh);
      } catch { /* Keep the receipt even if there is no room for another navigation panel. */ }
    }
    const edit = () => api(s => bot.api.editMessageText(panel.binding.chatId, panel.messageId!,
      panel.value.proposal ? controlContent(panel, text, rows) : panelContent(text, [], rows), { reply_markup: { inline_keyboard: [] } }, s)).then(() => undefined);
    // Retrying an edit of this exact message cannot duplicate a mutation or delivery.
    const render = () => edit().catch(error => safeError(error).code === 'FORBIDDEN' ? undefined : edit());
    if (fresh) await panels.render(fresh, render);
    else await render();
  } });
  const buttons = (panel: Panel<Controls>, items = panel.value.items): RichMessageButton[][] => items.map((item, index) => [{
    text: item.label, callback_data: `mk:ai:${panel.id}:${panel.value.generation ?? 0}:${index}`,
  }]);

  const readAction = (action: string) => ['ai.conversations.list', 'ai.conversations.history', 'ai.memory.list',
    'ai.automations.list', 'ai.admin.get', 'ai.run.status'].includes(action);
  function navigation(ctx: InvocationContext, action: string): Control | undefined {
    const t = translator(ctx.language);
    const route = action.startsWith('ai.conversations.') ? ['ai.conversations.list', 'chatsTitle']
      : action.startsWith('ai.memory.') ? ['ai.memory.list', 'memoryTitle']
        : action.startsWith('ai.automations.') ? ['ai.automations.list', 'tasksTitle']
          : action.startsWith('ai.admin.') ? ['ai.admin.get', 'adminTitle'] : undefined;
    return route ? { action: route[0]!, label: t(`bot:ai.${route[1]}`), input: {} } : undefined;
  }

  async function show(ctx: InvocationContext, text: string | StructuredMessage, items: Control[], panel?: Panel<Controls>, reopen?: Control) {
    if (items.length > 64) throw new AppError('INVALID_OUTPUT');
    if (!panel) {
      const fresh = panels.create(binding(ctx), { items, reopen });
      await send(ctx, text, [], undefined, { panel: fresh });
      return;
    }
    await panels.render(panel, async () => {
      panel.value.items = [];
      panel.value.generation = (panel.value.generation ?? 0) + 1;
      const rows = buttons(panel, items);
      const content = typeof text === 'string' ? rich(text, rows) : { ...text,
        blocks: [...text.blocks, ...rows.map(buttons => ({ type: 'buttons' as const, buttons }))], skip_entity_detection: true };
      await api(s => bot.api.editMessageText(ctx.chat.id, panel.messageId!, content, { reply_markup: { inline_keyboard: [] } }, s), ctx.signal);
      panel.value.items = items;
      panel.value.reopen = reopen;
      panel.value.receipt = undefined;
      panel.value.proposal = undefined;
    });
  }

  async function receipt(ctx: InvocationContext, text: string, action: string, panel?: Panel<Controls>) {
    const reopen = navigation(ctx, action);
    let fresh: Panel<Controls> | undefined;
    if (panel) {
      const active = await panels.render(panel, async () => { panel.value.receipt = text; panel.value.reopen = reopen; });
      if (active) { await panels.close(panel, 'used'); return; }
      // An operation can finish after its UI expires or is cancelled. Report it, but do not revive controls.
    } else if (reopen) {
      try { fresh = panels.create(binding(ctx), { items: [reopen], receipt: text }); }
      catch { /* Navigation capacity must not hide an operation's receipt. */ }
    }
    // Delivery failure must not turn a committed operation into a failure or trigger a second receipt send.
    await send(ctx, text, [], undefined, fresh ? { panel: fresh } : undefined).catch(() => undefined);
  }

  async function send(ctx: InvocationContext, text: string | StructuredMessage, items: Control[] = [], expiresAt?: number,
    prepared?: { panel: Panel<Controls>; replyTo?: number }): Promise<void> {
    const panel = prepared?.panel ?? (items.length ? panels.create(binding(ctx), { items }, expiresAt) : undefined);
    try {
      const rows = panel ? buttons(panel) : [];
      const content = typeof text === 'string' ? rich(text, rows) : { ...text,
        blocks: [...text.blocks, ...rows.map(buttons => ({ type: 'buttons' as const, buttons }))], skip_entity_detection: true };
      const message = await api(s => bot.api.sendRichMessage(ctx.chat.id, content, {
        message_thread_id: ctx.chat.threadId, protect_content: true,
        ...(prepared?.replyTo === undefined ? {} : { reply_parameters: { message_id: prepared.replyTo, allow_sending_without_reply: false } }),
      }, s), ctx.signal, true, false, !prepared);
      throwIfAborted(ctx.signal);
      if (panel) await panels.attach(panel, message.message_id);
    } catch (error) { if (panel) await panels.close(panel, 'expired'); throw error; }
  }

  async function proposal(ctx: InvocationContext, confirmation: Confirmation, input: unknown, items: Control[], run?: Run): Promise<void> {
    checkTarget(ctx);
    // Write-only credential updates belong exclusively to the HTTP adapter.
    if (ctx.source !== 'telegram' || confirmation.actionId === 'ai.admin.secret.update') throw new AppError('FORBIDDEN');
    const expiresAt = Date.parse(confirmation.expiresAt);
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= Date.now()) throw new AppError('CONFIRMATION_EXPIRED');
    let json: string | undefined;
    try {
      json = JSON.stringify(input, (_key, value: unknown) => {
        if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint'
          || typeof value === 'number' && !Number.isFinite(value)) throw new AppError('INVALID_OUTPUT');
        return value;
      });
    } catch { throw new AppError('INVALID_OUTPUT'); }
    if (json === undefined) throw new AppError('INVALID_OUTPUT');
    const parsedSubject = confirmationSchema.shape.subject.safeParse(confirmation.subject);
    if (!parsedSubject.success) throw new AppError('INVALID_OUTPUT');
    const subject = parsedSubject.data;
    if (subject && (!['rss.update', 'rss.remove'].includes(confirmation.actionId) || input === null || typeof input !== 'object'
      || Array.isArray(input) || (input as Record<string, unknown>).id !== subject.id)) throw new AppError('INVALID_OUTPUT');
    const subjectJson = subject ? JSON.stringify(subject) : '';
    const serialized = json;
    if (Buffer.byteLength(json) + Buffer.byteLength(subjectJson) > maxProposalBytes) throw new AppError('CAPACITY');
    if (!confirmation.token || json.includes(confirmation.token) || confirmation.actionId.includes(confirmation.token)
      || confirmation.target.includes(confirmation.token) || subjectJson.includes(confirmation.token)) throw new AppError('INVALID_OUTPUT');
    const digest = createHash('sha256').update(JSON.stringify([confirmation.actionId, confirmation.target, expiresAt, json, subject ?? null])).digest('hex');
    pruneCaches();
    const previous = proposals.get(confirmation.token);
    if (previous) {
      if (previous.key !== scopeKey(ctx) || previous.runId !== run?.target.runId) throw new AppError('FORBIDDEN');
      if (previous.digest !== digest) throw new AppError('CONFLICT');
      if (previous.failed) throw new AppError(previous.failed);
      if (previous.controller.signal.aborted) throw new AppError('CANCELLED');
      await previous.work;
      return;
    }
    if (proposals.size >= 128) throw new AppError('CAPACITY');
    const remaining = expiresAt - Date.now();
    if (remaining <= 0) throw new AppError('CONFIRMATION_EXPIRED');
    const controller = new AbortController();
    const requestSignal = AbortSignal.any([signal, ctx.signal, controller.signal, AbortSignal.timeout(Math.min(600_000, remaining))]);
    throwIfAborted(requestSignal);
    const panel = panels.create(binding(ctx), { items, signal: requestSignal, runId: run?.target.runId,
      reopen: run ? undefined : navigation(ctx, confirmation.actionId) }, expiresAt);
    const entry: Proposal = { key: scopeKey(ctx), runId: run?.target.runId, expiresAt, digest, controller };
    proposals.set(confirmation.token, entry);
    const t = translator(ctx.language);
    const content: StructuredMessage = { blocks: [
      { type: 'paragraph', text: { type: 'bold', text: t('bot:ai.approval', { tool: confirmation.actionId, target: confirmation.target }) } },
      { type: 'paragraph', text: t('bot:ai.approvalScope', { botId: ctx.botId, actorId: ctx.actorId, chatType: ctx.chat.type,
        chatId: ctx.chat.id, threadId: ctx.chat.threadId ?? 0 }) },
      { type: 'paragraph', text: [t('bot:ai.approvalExpiry'), ' ', { type: 'date_time', text: confirmation.expiresAt,
        unix_time: Math.floor(expiresAt / 1000), date_time_format: 'Dt' }] },
    ] };
    if (subject) content.blocks.splice(1, 0, { type: 'paragraph', text: [
      t('bot:ai.rssSubject', { title: plainValue(subject.title, 128).trim() || t('bot:rss.untitled') }), ' ', { type: 'code', text: subject.id },
    ] });
    const revision = input !== null && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>).revision : undefined;
    if (revision !== undefined) content.blocks.push({ type: 'paragraph', text: t('bot:ai.approvalRevision', { revision: JSON.stringify(revision) }) });
    const document = json.length > 1500;
    content.blocks.push({ type: 'paragraph', text: t(document ? 'bot:ai.largeProposal' : 'bot:ai.proposal') });
    if (!document) content.blocks.push({ type: 'paragraph', text: json });
    panel.value.proposal = content;
    const work = (async () => {
      try {
        let replyTo: number | undefined;
        if (document) {
          const message = await api(s => bot.api.sendDocument(ctx.chat.id, new InputFile(Buffer.from(serialized), 'proposed-action.json'), {
            message_thread_id: ctx.chat.threadId, protect_content: true, disable_content_type_detection: true,
          }, s), requestSignal, true, false, false);
          if (!Number.isSafeInteger(message.message_id) || message.message_id < 1 || message.chat.id !== ctx.chat.id
            || messageTopicId(message) !== ctx.chat.threadId) throw new AppError('OUTCOME_UNKNOWN');
          replyTo = message.message_id;
        }
        throwIfAborted(requestSignal);
        checkTarget(ctx);
        if (Date.now() >= expiresAt) throw new AppError('CONFIRMATION_EXPIRED');
        await send(createInvocation({ ...ctx, signal: requestSignal }), content, [], expiresAt, { panel, replyTo });
      } catch (error) {
        entry.failed = safeError(error).code;
        if (run && entry.failed === 'OUTCOME_UNKNOWN') run.uncertain = true;
        // Retain the token tombstone, but never leave a usable control after incomplete delivery.
        panel.value.items = [];
        panel.messageId = undefined;
        await panels.close(panel, 'cancelled');
        throw error;
      }
    })();
    entry.work = work;
    try { await track(work); } finally { entry.work = undefined; pruneCaches(); }
  }

  async function result<T>(ctx: InvocationContext, value: ActionResult<T>): Promise<T | undefined> {
    const t = translator(ctx.language);
    if (value.status === 'succeeded') return value.data;
    if (value.status === 'pending_confirmation') {
      const { confirmation: approval, input } = deps.executor.pendingDetails(ctx, value.confirmation.token);
      await proposal(ctx, approval, input, [{
        label: t('bot:ai.confirm'), action: approval.actionId, input: {}, confirmation: approval.token,
      }]);
    } else await send(ctx, t(`common:errors.${value.error.code}`));
    return undefined;
  }
  const execute = <T>(ctx: InvocationContext, action: string, input: unknown) => deps.executor.execute<T>(ctx, action, input).then(value => result(ctx, value));

  function retire(run: Run, reason: 'used' | 'cancelled' = 'cancelled'): Promise<void> {
    if (run.retirement) return run.retirement;
    if (run.uncertain || reason === 'cancelled' && run.finalizing) run.panel.messageId = undefined;
    run.finalizing = true;
    if (run.timer) clearTimeout(run.timer);
    run.timer = undefined;
    run.detach();
    run.controller.abort(); run.text = ''; run.panel.value.items = [];
    const draining: Promise<unknown>[] = run.work ? [run.work] : [];
    for (const entry of proposals.values()) if (entry.runId === run.target.runId && entry.key === scopeKey(run.target)) {
      entry.controller.abort(); if (entry.work) draining.push(entry.work);
    }
    run.retirement = track(Promise.resolve().then(async () => {
      await Promise.allSettled(draining);
      await Promise.all([panels.close(run.panel, reason),
        panels.closeOwned(scopeKey(run.target), reason, panel => panel.value.runId === run.target.runId)]);
    }).finally(() => { if (runs.get(run.target.runId) === run) runs.delete(run.target.runId); }));
    return run.retirement;
  }
  function bindSignal(run: Run, turnSignal: AbortSignal) {
    run.detach();
    run.turnSignal = turnSignal;
    run.signal = AbortSignal.any([signal, turnSignal, run.controller.signal]);
    const abort = () => { void retire(run); };
    run.detach = () => run.signal.removeEventListener('abort', abort);
    run.signal.addEventListener('abort', abort, { once: true });
    if (run.signal.aborted) void retire(run);
  }
  function live(target: AiDeliveryTarget, turnSignal?: AbortSignal): Run | undefined {
    const run = runs.get(target.runId);
    if (!run || scopeKey(run.target) !== scopeKey(target) || run.target.conversationId !== target.conversationId
      || run.uncertain || run.retirement) return undefined;
    if (turnSignal && turnSignal !== run.turnSignal) bindSignal(run, turnSignal);
    if (run.signal.aborted) return undefined;
    checkTarget(target);
    return run;
  }
  async function preview(run: Run) {
    if (run.finalizing || !live(run.target)) return;
    const content = run.hasOutput ? await answer(run.text) : rich(run.text);
    if (run.target.chat.type !== 'private') content.blocks.push(...buttons(run.panel).map(row => ({ type: 'buttons' as const, buttons: row })));
    if (run.target.chat.type === 'private') {
      await api(s => bot.api.sendRichMessageDraft(run.target.chat.id, run.draftId, content, {
        message_thread_id: run.target.chat.threadId, can_stop: true, keep_on_stop: true,
      }, s), run.signal);
    } else if (run.messageId !== undefined) {
      await api(s => bot.api.editMessageText(run.target.chat.id, run.messageId!, content, { reply_markup: { inline_keyboard: [] } }, s), run.signal);
    }
    run.nextAt = Date.now() + 750;
  }
  function schedule(run: Run) {
    if (run.timer || run.work || run.finalizing || !live(run.target)) return;
    run.timer = setTimeout(() => {
      run.timer = undefined;
      const previous = run.text;
      run.work = track(preview(run).catch(() => undefined).finally(() => {
        run.work = undefined;
        if (run.text !== previous) schedule(run);
      }));
    }, Math.max(0, run.nextAt - Date.now(), backoffUntil - Date.now()));
    run.timer.unref();
  }

  async function finishReply(target: AiDeliveryTarget, text: string, turnSignal: AbortSignal, notice?: string): Promise<number | undefined> {
    const run = live(target, turnSignal);
    if (!run || run.finalizing || turnSignal.aborted) return undefined;
    run.finalizing = true;
    if (run.timer) clearTimeout(run.timer);
    await run.work;
    if (run.signal.aborted) { await retire(run); return undefined; }
    try {
      const t = translator(target.language);
      const content: StructuredMessage = text.length > maxText ? rich(t('bot:ai.outputTooLong'))
        : text ? await answer(text) : notice ? { blocks: [], skip_entity_detection: true } : rich(t('bot:ai.saved'));
      // A truncated fence or other model markup must not absorb the trusted failure notice.
      if (notice) content.blocks.push({ type: 'paragraph', text: notice });
      if (target.chat.type === 'private') {
        const message = await track(api(s => bot.api.sendRichMessage(target.chat.id, content, {
          message_thread_id: target.chat.threadId, protect_content: false,
        }, s), run.signal, true));
        return message.message_id;
      }
      if (run.messageId !== undefined) await track(api(s => bot.api.editMessageText(target.chat.id, run.messageId!, content, {
        reply_markup: { inline_keyboard: [] },
      }, s), run.signal, true));
      // Do not let the expiry hook overwrite the completed answer.
      run.panel.messageId = undefined;
      return run.messageId;
    } catch (error) { run.uncertain = safeError(error).code === 'OUTCOME_UNKNOWN'; throw error; }
    finally { await retire(run, 'used'); }
  }

  const delivery: AiDelivery = {
    async started(target, turnSignal) {
      checkTarget(target); throwIfAborted(signal); throwIfAborted(turnSignal);
      if (runs.has(target.runId)) return;
      if (runs.size >= 16) throw new AppError('CAPACITY');
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, turnSignal, controller.signal]);
      const panel = panels.create(binding(target), { runId: target.runId, items: [{ label: translator(target.language)('bot:ai.stop'),
        action: 'ai.run.stop', input: { runId: target.runId } }] });
      let draftId: number;
      do { draftId = randomInt(1, 2_147_483_647); } while ([...runs.values()].some(run => run.draftId === draftId));
      const run: Run = { target: { ...target, chat: { ...target.chat } }, controller, signal: combined, turnSignal,
        detach: () => undefined, panel, draftId,
        text: translator(target.language)('bot:ai.started'), hasOutput: false, nextAt: 0, finalizing: false, uncertain: false };
      runs.set(target.runId, run);
      bindSignal(run, turnSignal);
      try {
        if (target.chat.type === 'private') await track(preview(run));
        else {
          const message = await track(api(s => bot.api.sendRichMessage(target.chat.id, rich(run.text, buttons(panel)), {
            message_thread_id: target.chat.threadId,
          }, s), combined, true));
          run.messageId = message.message_id;
          await panels.attach(panel, message.message_id);
        }
      } catch (error) {
        run.uncertain = safeError(error).code === 'OUTCOME_UNKNOWN';
        throw error;
      }
    },
    async progress(target, text, turnSignal) {
      const run = live(target, turnSignal);
      if (!run || run.finalizing) return;
      if (text.length > aiOutputTextLimits.characters) throw new AppError('AI_OUTPUT_LIMIT');
      // Load on first output; parsing stays coalesced with the actual preview updates.
      await (answerRenderer ??= import('./ai-rich.js'));
      if (!live(target, turnSignal) || run.finalizing) return;
      run.text = text; run.hasOutput = true; schedule(run);
    },
    async approval(target, confirmation: Confirmation, tool, turnSignal, input) {
      const run = live(target, turnSignal);
      if (!run || run.finalizing) return;
      if (tool !== confirmation.actionId) throw new AppError('INVALID_OUTPUT');
      const ctx = createInvocation({ ...target, source: 'telegram', signal: AbortSignal.any([run.signal, turnSignal]) });
      const t = translator(target.language);
      const details = input === undefined ? deps.executor.pendingDetails(ctx, confirmation.token) : { confirmation, input };
      await proposal(ctx, details.confirmation, details.input, [{
        label: t('bot:ai.confirm'), action: 'ai.run.confirm', input: { runId: target.runId, token: confirmation.token },
      }, { label: t('bot:ai.stop'), action: 'ai.run.stop', input: { runId: target.runId } }], run);
    },
    completed: finishReply,
    async failed(target, code, turnSignal, partialText = '') {
      const run = live(target, turnSignal);
      if (!run) return;
      if (run.signal.aborted || run.uncertain || run.finalizing) { await retire(run); return; }
      const t = translator(target.language); const safeCode = errorCodeSchema.safeParse(code);
      const key = safeCode.success ? safeCode.data : 'UNAVAILABLE';
      const notice = t(partialText ? 'bot:ai.partial' : 'bot:ai.failed', { code: key, reason: t(`common:errors.${key}`) });
      await finishReply(target, partialText, run.signal, notice);
    },
    async retire(target) {
      const run = runs.get(target.runId);
      if (!run) return;
      // Retirement must also work after revocation, but never for another owner's run.
      if (scopeKey(run.target) !== scopeKey(target) || run.target.conversationId !== target.conversationId) throw new AppError('FORBIDDEN');
      await retire(run);
    },
    async file(target, file, turnSignal) {
      checkTarget(target);
      if (file.path !== undefined) {
        if (!target.runId.startsWith('export:') || target.chat.type !== 'private' || !isAbsolute(file.path)
          || !/^[A-Za-z0-9._ -]{1,128}$/.test(file.name)) throw new AppError('FORBIDDEN');
        if (exports.size >= 2 || exports.has(target.runId)) throw new AppError('CAPACITY');
        const controller = new AbortController();
        const requestSignal = AbortSignal.any([signal, turnSignal, controller.signal]);
        throwIfAborted(requestSignal);
        exports.set(target.runId, { key: scopeKey(target), controller });
        const job = (async () => {
          const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size < 1 || stat.size > 8 * 1024 * 1024) throw new AppError('INVALID_OUTPUT');
            await api(async s => {
              throwIfAborted(requestSignal);
              const stream = handle.createReadStream({ start: 0, highWaterMark: 65_536, autoClose: false, signal: requestSignal });
              const drained = finished(stream).catch(() => undefined);
              try { await bot.api.sendDocument(target.actorId, new InputFile(stream, file.name), {
                message_thread_id: target.chat.threadId, protect_content: true, disable_content_type_detection: true,
              }, s); }
              finally { stream.destroy(); await drained; }
            }, requestSignal, true);
          } finally { await handle.close(); }
        })();
        exports.get(target.runId)!.work = job;
        try { await track(job); } finally { exports.delete(target.runId); }
        return;
      }
      const run = live(target, turnSignal);
      if (!run || run.finalizing || turnSignal.aborted) return;
      if (!file.bytes.byteLength || file.bytes.byteLength > maxBytes || !file.name || file.name.length > 128
        || Array.from(file.name).some(c => c.charCodeAt(0) < 32 || '/\\'.includes(c))) throw new AppError('INVALID_OUTPUT');
      const input = new InputFile(file.bytes, file.name);
      const options = { message_thread_id: target.chat.threadId, protect_content: file.protectContent !== false };
      try {
        await track(api<Message>(s => file.mimeType === 'image/jpeg' || file.mimeType === 'image/png'
          ? bot.api.sendPhoto(target.chat.id, input, options, s)
          : file.mimeType === 'audio/mpeg' ? bot.api.sendAudio(target.chat.id, input, options, s)
            : bot.api.sendDocument(target.chat.id, input, { ...options, disable_content_type_detection: true }, s), run.signal, true));
      } catch (error) { run.uncertain = safeError(error).code === 'OUTCOME_UNKNOWN'; throw error; }
    },
  };

  async function download(file: AiCapturedFile, turnSignal: AbortSignal): Promise<Uint8Array> {
    const request = AbortSignal.any([signal, turnSignal, AbortSignal.timeout(15_000)]);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maxBytes) throw new AppError('INVALID_INPUT');
    const info = await api(s => bot.api.getFile(file.fileId, s), request);
    const path = info.file_path;
    if (!path || path.length > 512 || !/^(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(path)
      || info.file_size !== undefined && info.file_size !== file.size) throw new AppError('INVALID_INPUT');
    let response: Response | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const abort = () => { void (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined); };
    request.addEventListener('abort', abort, { once: true });
    try {
      response = await (deps.fetch ?? fetch)(`https://api.telegram.org/file/bot${deps.token}/${path}`, {
        signal: request, redirect: 'error', credentials: 'omit', headers: { 'Accept-Encoding': 'identity' },
      });
      throwIfAborted(request);
      const length = response.headers.get('content-length');
      if (response.status !== 200 || !response.body || response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity'
        || length !== null && (!/^\d+$/.test(length) || Number(length) !== file.size)) throw new AppError('INVALID_INPUT');
      reader = response.body.getReader();
      const bytes = new Uint8Array(file.size);
      let offset = 0;
      for (;;) {
        const part = await reader.read(); throwIfAborted(request);
        if (part.done) break;
        if (offset + part.value.byteLength > bytes.byteLength) throw new AppError('INVALID_INPUT');
        bytes.set(part.value, offset); offset += part.value.byteLength;
      }
      if (offset !== bytes.byteLength) throw new AppError('INVALID_INPUT');
      validateFile(file, bytes);
      return bytes;
    } catch (error) { throwIfAborted(request); throw error instanceof AppError ? error : new AppError('UNAVAILABLE'); }
    finally {
      request.removeEventListener('abort', abort);
      await (reader ? reader.cancel() : response?.body?.cancel())?.catch(() => undefined); reader?.releaseLock();
    }
  }
  deps.ai?.attachTelegram(delivery, (file, turnSignal) => track(download(file, turnSignal)));

  async function start(ctx: InvocationContext, text: string, files: AiCapturedFile[], replyTo?: number) {
    if (!deps.ai?.available(ctx)) { await send(ctx, translator(ctx.language)('bot:ai.unavailable')); return; }
    if (files.length > 5 || files.reduce((bytes, file) => bytes + file.size, 0) > maxBytes || text.length > maxText) throw new AppError('INVALID_INPUT');
    const attachments: string[] = [];
    for (const file of files) attachments.push(await deps.ai.capture(ctx, file));
    await execute(ctx, 'ai.run.start', { text, ...(attachments.length ? { attachments } : {}), ...(replyTo === undefined ? {} : { replyTo }) });
  }

  async function input(ctx: Context, explicitText?: string): Promise<boolean> {
    if (!deps.ai && explicitText === undefined) return false;
    const message = ctx.update.message;
    if (!message || !sessionKey(ctx)) return false;
    const invocation = context(ctx);
    const t = translator(invocation.language);
    const reply = message.reply_to_message;
    const ownedReply = reply && deps.ai?.isReply(invocation, reply.message_id)
      && reply.from?.id === ctx.me.id && reply.chat.id === message.chat.id && messageTopicId(reply) === messageTopicId(message);
    const albumKey = message.media_group_id ? `${scopeKey(invocation)}:${message.media_group_id}` : undefined;
    const body = explicitText ?? message.text ?? message.caption ?? '';
    const entities = message.entities ?? message.caption_entities ?? [];
    const mentioned = !message.forward_origin && !message.external_reply && entities.some(entity => entity.type === 'mention' && body.slice(entity.offset, entity.offset + entity.length).toLowerCase() === `@${ctx.me.username.toLowerCase()}`
      || entity.type === 'text_mention' && entity.user.id === ctx.me.id);
    if (explicitText === undefined && message.chat.type !== 'private' && !ownedReply && !mentioned && !(albumKey && albums.has(albumKey))) return false;
    if (reply?.from?.is_bot && !ownedReply) { await send(invocation, t('bot:ai.blockedReply')); return true; }
    if (!deps.ai?.available(invocation)) {
      if (explicitText !== undefined || mentioned || ownedReply) { await send(invocation, t('bot:ai.unavailable')); return true; }
      return false;
    }
    let file: AiCapturedFile | undefined;
    try { file = captureFile(message); }
    catch {
      if (albumKey && albums.has(albumKey)) albums.get(albumKey)!.invalid = true;
      await send(invocation, t('bot:ai.unsupported')); return true;
    }
    if (!body.trim() && !file) return false;
    if (albumKey && file) {
      pruneCaches();
      if (closedAlbums.has(albumKey)) return true;
      let album = albums.get(albumKey);
      if (!album) {
        if (albums.size >= 16 || closedAlbums.size >= 128) throw new AppError('CAPACITY');
        const timer = setTimeout(() => {
          const entry = albums.get(albumKey); albums.delete(albumKey); closedAlbums.set(albumKey, Date.now() + 120_000); pruneCaches();
          if (!entry || signal.aborted) return;
          track((entry.invalid ? send(entry.context, t('bot:ai.unsupported')) : start(entry.context, entry.text, entry.files, entry.replyTo))
            .catch(error => signal.aborted ? undefined : send(entry.context, t(`common:errors.${safeError(error).code}`)).catch(() => undefined)));
        }, 600);
        timer.unref();
        album = { context: invocation, files: [], text: '', replyTo: ownedReply ? reply!.message_id : undefined, invalid: false, timer };
        albums.set(albumKey, album);
      }
      if (album.files.length >= 5 || album.files.reduce((bytes, item) => bytes + item.size, file.size) > maxBytes) album.invalid = true;
      else album.files.push(file);
      if (body) album.text = (album.text ? `${album.text}\n${body}` : body).slice(0, maxText + 1);
      return true;
    }
    await start(invocation, body, file ? [file] : [], ownedReply ? reply!.message_id : undefined);
    return true;
  }

  async function view(ctx: InvocationContext, action: string, input: Record<string, unknown>, panel?: Panel<Controls>, confirmed?: ActionResult): Promise<void> {
    const t = translator(ctx.language);
    const value = confirmed ?? await deps.executor.execute(ctx, action, input);
    if (panel && (readAction(action) || value.status === 'pending_confirmation')) {
      try { panels.get(panel.id, { ...binding(ctx), messageId: panel.messageId! }); }
      catch { return; }
    }
    if (value.status !== 'succeeded') {
      if (value.status === 'pending_confirmation') {
        await result(ctx, value);
        if (panel) await receipt(ctx, t('bot:ai.pending'), action, panel);
      } else await receipt(ctx, t(value.error.code === 'OUTCOME_UNKNOWN' ? 'bot:ai.unknown' : 'bot:ai.operationFailed', {
        error: t(`common:errors.${value.error.code}`),
      }), action, panel);
      return;
    }
    const data = value.data;
    const reopen = navigation(ctx, action);
    if (!readAction(action)) {
      if (action === 'ai.conversations.export' && (data as { delivered?: boolean }).delivered !== true) throw new AppError('INVALID_OUTPUT');
      const conversation = data as Partial<AiConversation>;
      const text = action === 'ai.run.confirm' ? t('bot:ai.approvalAccepted') : t('bot:ai.saved');
      await receipt(ctx, text + (action.startsWith('ai.conversations.') && typeof conversation.title === 'string'
        ? '\n\n' + t('bot:ai.conversation', { title: conversation.title, id: conversation.id, revision: conversation.revision }) : ''), action, panel);
      return;
    }
    const display = (text: string | StructuredMessage, items: Control[] = []) => show(ctx, text, items, panel, reopen);
    const paging = (page: AiPage<unknown>): Control[] => {
      const current = input.page ?? 0;
      if (!Array.isArray(page.items) || page.items.length > 10 || !Number.isSafeInteger(current) || (current as number) < 0
        || page.nextCursor !== null && (!Number.isSafeInteger(page.nextCursor) || page.nextCursor <= (current as number))) throw new AppError('INVALID_OUTPUT');
      return [
        { label: t('bot:ai.refresh'), action, input: { ...input } },
        ...(current === 0 ? [] : [{ label: t('bot:ai.firstPage'), action, input: { ...input, page: 0 } }]),
        ...(page.nextCursor === null ? [] : [{ label: t('bot:panels.next'), action, input: { ...input, page: page.nextCursor } }]),
      ];
    };
    if (action === 'ai.run.status') {
      const run = data as { runId?: string; id?: string; state: string };
      await display(t('bot:ai.status', { id: run.runId ?? run.id, state: run.state }), [{ label: t('bot:ai.refresh'), action, input }]); return;
    }
    if (action === 'ai.conversations.list') {
      const page = data as AiPage<AiConversation>;
      const pages = paging(page);
      const controls: Control[] = [{ label: t('bot:ai.newChat'), action: 'ai.conversations.new', input: {} }];
      let text = t('bot:ai.chatsTitle');
      for (const item of page.items) {
        text += '\n\n' + t('bot:ai.conversation', { title: item.title, id: item.id, revision: item.revision });
        controls.push({ label: `${t('bot:ai.select')}: ${item.title.slice(0, 40) || item.id}`, action: 'ai.conversations.select', input: { id: item.id } },
          { label: `${t('bot:ai.history')}: ${item.title.slice(0, 40) || item.id}`, action: 'ai.conversations.history', input: { id: item.id } },
          { label: `${t('bot:ai.export')}: ${item.title.slice(0, 40) || item.id}`, action: 'ai.conversations.export', input: { id: item.id } },
          { label: `${t('bot:ai.clear')}: ${item.title.slice(0, 40) || item.id}`, action: 'ai.conversations.clear', input: { id: item.id, revision: item.revision } },
          { label: `${t('bot:ai.delete')}: ${item.title.slice(0, 40) || item.id}`, action: 'ai.conversations.delete', input: { id: item.id, revision: item.revision } });
      }
      if (!page.items.length) text += '\n' + t('bot:ai.empty');
      await display(text + '\n\n' + t('bot:ai.chatsUsage'), [...controls, ...pages]); return;
    }
    if (action === 'ai.memory.list') {
      const page = data as AiPage<AiMemory>;
      const pages = paging(page);
      const text = t('bot:ai.memoryTitle') + '\n\n' + (page.items.map(item => t('bot:ai.memoryRow', item)).join('\n\n') || t('bot:ai.empty'));
      const controls: Control[] = page.items.map(item => ({ label: `${t('bot:ai.delete')}: ${item.id}`,
        action: 'ai.memory.delete', input: { id: item.id, revision: item.revision } }));
      controls.push(...pages);
      if (text.length + t('bot:ai.memoryUsage').length + 2 > maxText) {
        if (ctx.chat.type !== 'private' || ctx.actorId !== ctx.chat.id) throw new AppError('FORBIDDEN');
        await api(s => bot.api.sendDocument(ctx.actorId, new InputFile(Buffer.from(text), 'memory.txt'), {
          message_thread_id: ctx.chat.threadId, protect_content: true, disable_content_type_detection: true,
        }, s), ctx.signal, true);
        await display(t('bot:ai.memoryUsage'), controls);
      } else await display(text + '\n\n' + t('bot:ai.memoryUsage'), controls);
      return;
    }
    if (action === 'ai.conversations.history') {
      if (ctx.chat.type !== 'private' || ctx.actorId !== ctx.chat.id) throw new AppError('FORBIDDEN');
      const page = data as AiPage<AiTurn>;
      const next = [...paging(page), reopen!];
      const text = page.items.map(item => `${item.role} (${item.actorId})\n${item.content}`).join('\n\n');
      if (text.length > maxText) {
        await api(s => bot.api.sendDocument(ctx.actorId, new InputFile(Buffer.from(text), 'history.txt'), {
          message_thread_id: ctx.chat.threadId, protect_content: true,
        }, s), ctx.signal, true);
        await display(t('bot:ai.history'), next);
      } else await display(text || t('bot:ai.empty'), next);
      return;
    }
    if (action === 'ai.admin.get') {
      const snapshot = data as AiSettingsSnapshot;
      await display(t('bot:ai.adminTitle') + '\n' + t('bot:ai.adminStatus', { enabled: snapshot.settings.enabled,
        providers: snapshot.settings.providers.length, presets: snapshot.settings.presets.length }) + '\n\n' + t('bot:ai.adminUsage'),
      [{ label: t('bot:ai.disable'), action: 'ai.admin.disable', input: { revision: snapshot.revision } },
        { label: t('bot:ai.refresh'), action, input: {} }]); return;
    }
    if (action === 'ai.automations.list') {
      const page = data as AiPage<AutomationView>;
      const pages = paging(page);
      const content: StructuredMessage = { blocks: [{ type: 'paragraph', text: { type: 'bold', text: t('bot:ai.tasksTitle') } }] };
      for (const item of page.items) {
        content.blocks.push({ type: 'paragraph', text: t('bot:ai.taskRow', { title: item.title, id: item.id, revision: item.revision,
          state: item.state, timeZone: item.trigger.timeZone, target: item.target }) });
        content.blocks.push({ type: 'paragraph', text: t('bot:ai.taskDetails', { trigger: JSON.stringify(item.trigger),
          tools: item.tools.join(', '), completedRuns: item.completedRuns, maxRuns: item.maxRuns,
          inputTokens: item.maxInputTokens, outputTokens: item.maxOutputTokens, expiresAt: item.expiresAt }) });
        content.blocks.push({ type: 'paragraph', text: t('bot:ai.taskCost', { maxCostMicros: item.maxCostMicros }) });
        if (item.nextAt) content.blocks.push({ type: 'paragraph', text: [t('bot:ai.nextRun'), ' ', { type: 'date_time',
          text: new Intl.DateTimeFormat(ctx.language, { dateStyle: 'medium', timeStyle: 'short', timeZone: item.trigger.timeZone }).format(new Date(item.nextAt)),
          unix_time: Math.floor(Date.parse(item.nextAt) / 1000), date_time_format: 'Dt' }] });
      }
      if (!page.items.length) content.blocks.push({ type: 'paragraph', text: t('bot:ai.empty') });
      content.blocks.push({ type: 'paragraph', text: t('bot:ai.tasksUsage') });
      await display(content, [...page.items.flatMap(item => [
        { label: `${t('bot:ai.pause')}: ${item.title.slice(0, 40)}`, action: 'ai.automations.pause', input: { id: item.id, revision: item.revision } },
        { label: `${t('bot:ai.delete')}: ${item.title.slice(0, 40)}`, action: 'ai.automations.remove', input: { id: item.id, revision: item.revision } },
      ]), ...pages]); return;
    }
  }

  async function command(ctx: Context, name: string, argument: string): Promise<boolean> {
    if (!['ai', 'chats', 'memory', 'tasks', 'aiconfig'].includes(name)) return false;
    const invocation = context(ctx); const t = translator(invocation.language);
    if (['chats', 'memory', 'aiconfig'].includes(name) && invocation.chat.type !== 'private') { await send(invocation, t('bot:privateOnly')); return true; }
    if (name === 'aiconfig' && !deps.access.isAdmin(invocation.actorId)) { await send(invocation, t('common:errors.FORBIDDEN')); return true; }
    const parts = argument.trim().split(/\s+/).filter(Boolean);
    const operation = parts[0];
    const id = parts[1];
    const revision = parts[2] && /^(0|[1-9]\d*)$/.test(parts[2]) ? Number(parts[2]) : undefined;
    const usage = () => send(invocation, t(`bot:ai.${name === 'ai' ? 'usage' : name === 'aiconfig' ? 'adminUsage' : `${name}Usage`}`));
    if (name === 'ai') {
      if (operation === 'stop' && parts.length <= 2) { await cancel(invocation, id); await send(invocation, t('bot:ai.stopped')); }
      else if (operation === 'status' && parts.length === 2) await view(invocation, 'ai.run.status', { runId: id });
      else if (!argument && !ctx.message?.photo && !ctx.message?.document && !ctx.message?.audio && !ctx.message?.voice) await usage();
      else await input(ctx, argument);
      return true;
    }
    if (name === 'aiconfig') {
      if (!operation) await view(invocation, 'ai.admin.get', {});
      else if (operation === 'disable' && parts.length === 1) {
        const snapshot = await execute<AiSettingsSnapshot>(invocation, 'ai.admin.get', {});
        if (snapshot) await view(invocation, 'ai.admin.disable', { revision: snapshot.revision });
      }
      else await usage();
      return true;
    }
    if (!operation || operation === 'list' && parts.length === 1) {
      await view(invocation, name === 'chats' ? 'ai.conversations.list' : name === 'memory' ? 'ai.memory.list' : 'ai.automations.list', {}); return true;
    }
    if (name === 'chats') {
      if (operation === 'topic') {
        if (!bot.botInfo.has_topics_enabled || !id) { await send(invocation, t('bot:ai.topicUnavailable')); return true; }
        if (!deps.ai?.available(invocation)) { await send(invocation, t('bot:ai.unavailable')); return true; }
        const title = parts.slice(1).join(' ');
        if (title.length > 128) { await usage(); return true; }
        const topic = await api(s => bot.api.createForumTopic(invocation.chat.id, title, {}, s), invocation.signal, true);
        const topicContext = createInvocation({ ...invocation, chat: { ...invocation.chat, threadId: topic.message_thread_id } });
        await view(topicContext, 'ai.conversations.new', { title }); return true;
      }
      if (operation === 'new') await view(invocation, 'ai.conversations.new', { title: parts.slice(1).join(' ') });
      else if (['select', 'export'].includes(operation) && parts.length === 2) await view(invocation, `ai.conversations.${operation}`, { id });
      else if (operation === 'rename' && parts.length >= 4 && revision !== undefined) await view(invocation, 'ai.conversations.rename', { id, revision, title: parts.slice(3).join(' ') });
      else if (operation === 'history' && (parts.length === 2 || parts.length === 3 && revision !== undefined)) await view(invocation, 'ai.conversations.history', { id, ...(revision === undefined ? {} : { page: revision }) });
      else if (['clear', 'delete'].includes(operation) && parts.length === 3 && revision !== undefined) await view(invocation, `ai.conversations.${operation}`, { id, revision });
      else await usage();
    } else if (name === 'memory') {
      if (operation === 'remember' && id) await view(invocation, 'ai.memory.remember', { text: argument.slice(argument.indexOf(' ') + 1).trim() });
      else if (operation === 'update' && parts.length >= 4 && revision !== undefined) await view(invocation, 'ai.memory.update', { id, revision, text: parts.slice(3).join(' ') });
      else if (operation === 'delete' && parts.length === 3 && revision !== undefined) await view(invocation, 'ai.memory.delete', { id, revision });
      else await usage();
    } else if (['create', 'update'].includes(operation)) {
      let value: unknown;
      try { value = JSON.parse(argument.slice(argument.indexOf(' ') + 1)); } catch { await usage(); return true; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) { await usage(); return true; }
      await view(invocation, `ai.automations.${operation}`, value as Record<string, unknown>);
    } else if (['pause', 'remove'].includes(operation) && parts.length === 3 && revision !== undefined) await view(invocation, `ai.automations.${operation}`, { id, revision });
    else await usage();
    return true;
  }

  async function cancel(invocation: InvocationContext, runId?: string) {
    const draining: Promise<unknown>[] = [];
    for (const entry of proposals.values()) if (entry.key === scopeKey(invocation) && (!runId || entry.runId === runId)) {
      entry.controller.abort(); if (entry.work) draining.push(entry.work);
    }
    if (!runId) for (const job of exports.values()) if (job.key === scopeKey(invocation)) {
      job.controller.abort(); if (job.work) draining.push(job.work);
    }
    suspendInput(invocation);
    for (const run of runs.values()) if (scopeKey(run.target) === scopeKey(invocation) && (!runId || run.target.runId === runId)) {
      run.controller.abort(); draining.push(retire(run));
    }
    draining.push(panels.closeOwned(scopeKey(invocation), 'cancelled', panel => !runId || panel.value.runId === runId));
    // Abort real run work before waiting for preview transports to finish their cleanup.
    if (deps.ai) await execute(invocation, 'ai.run.stop', runId ? { runId } : {});
    await Promise.allSettled(draining);
  }

  function suspendInput(invocation: InvocationContext): void {
    for (const [key, album] of albums) if (scopeKey(album.context) === scopeKey(invocation)) {
      clearTimeout(album.timer); albums.delete(key); closedAlbums.set(key, Date.now() + 120_000);
    }
    pruneCaches();
  }

  return {
    command, input, context,
    suspendInput(ctx: Context): void {
      const message = ctx.update.message ?? ctx.callbackQuery?.message;
      if (message && sessionKey(ctx) && (message.chat.type !== 'private' || message.chat.id === ctx.from?.id)) suspendInput(context(ctx));
    },
    ownsAlbum(ctx: Context): boolean {
      const id = ctx.update.message?.media_group_id;
      if (!id || !sessionKey(ctx)) return false;
      pruneCaches();
      const key = `${scopeKey(context(ctx))}:${id}`;
      return albums.has(key) || closedAlbums.has(key);
    },
    closedAlbum(ctx: Context): boolean {
      const id = ctx.update.message?.media_group_id;
      return !!id && !!sessionKey(ctx) && closedAlbums.has(`${scopeKey(context(ctx))}:${id}`);
    },
    ownsReply(ctx: Context): boolean {
      const message = ctx.update.message; const reply = message?.reply_to_message;
      return !!message && !!reply && reply.from?.id === ctx.me.id && reply.from.is_bot && reply.chat.id === message.chat.id
        && messageTopicId(reply) === messageTopicId(message) && Boolean(deps.ai?.isReply(context(ctx), reply.message_id));
    },
    async blockedReply(ctx: Context): Promise<boolean> {
      const message = ctx.update.message;
      const reply = message?.reply_to_message;
      if (!message || !reply?.from?.is_bot) return false;
      const invocation = context(ctx);
      if (reply.from.id === ctx.me.id && reply.chat.id === message.chat.id && messageTopicId(reply) === messageTopicId(message)
        && deps.ai?.isReply(invocation, reply.message_id)) return false;
      await send(invocation, translator(invocation.language)('bot:ai.blockedReply'));
      return true;
    },
    async cancel(ctx: Context) { await cancel(context(ctx)); },
    async stoppedGeneration(ctx: Context): Promise<boolean> {
      const event = ctx.update.stopped_message_generation;
      if (!event) return false;
      // This update has no `from`. Only the stored initiating actor may stop the bound draft.
      const run = [...runs.values()].find(item => item.target.botId === ctx.me.id && item.target.chat.type === 'private'
        && item.target.chat.id === event.chat.id && item.target.chat.threadId === event.message_thread_id && item.draftId === event.draft_id);
      if (run) await cancel(createInvocation({ actorId: run.target.actorId, botId: run.target.botId, chat: run.target.chat,
        language: run.target.language, source: 'telegram', signal, invocationId: `telegram:${ctx.me.id}:${ctx.update.update_id}:stop` }), run.target.runId);
      return true;
    },
    async callback(ctx: Context): Promise<boolean> {
      if (!ctx.callbackQuery?.data?.startsWith('mk:ai:')) return false;
      let panel: Panel<Controls> | undefined;
      let control: Control | undefined;
      let invocation: InvocationContext | undefined;
      let code: string | undefined;
      let claimed = false;
      try {
        invocation = context(ctx);
        const match = /^mk:ai:([a-f0-9]{24}):(\d{1,10}):(\d{1,2})$/.exec(ctx.callbackQuery.data);
        const message = ctx.callbackQuery.message;
        if (!match || !message || message.from?.id !== ctx.me.id) throw new AppError('CONFIRMATION_EXPIRED');
        panel = panels.get(match[1]!, { ...binding(invocation), messageId: message.message_id });
        if (panel.value.signal?.aborted) throw new AppError('CONFIRMATION_EXPIRED');
        if ((panel.value.generation ?? 0) !== Number(match[2])) throw new AppError('CONFIRMATION_EXPIRED');
        control = panel.value.items[Number(match[3])];
        if (!control) throw new AppError('CONFIRMATION_EXPIRED');
        if (control.action !== 'ai.run.stop' && invocation.chat.type !== 'private' && !deps.access.isAllowed(invocation.chat.id)) throw new AppError('FORBIDDEN');
        if (panel.value.busy) code = 'BUSY';
        else { panel.value.busy = true; claimed = true; }
      } catch (error) { code = safeError(error).code; }
      await api(s => bot.api.answerCallbackQuery(ctx.callbackQuery!.id, {
        text: code ? translator(invocation?.language ?? 'en')(code === 'BUSY' ? 'bot:ai.busy'
          : code === 'CONFIRMATION_EXPIRED' ? 'bot:ai.expired' : `common:errors.${code}`) : undefined,
      }, s), signal, false, true).catch(() => undefined);
      if (code || !claimed || !panel || !control || !invocation) return true;
      try {
        panels.get(panel.id, { ...binding(invocation), messageId: ctx.callbackQuery.message!.message_id });
        if (panel.value.signal?.aborted || !panel.value.items.includes(control)) return true;
        if (!readAction(control.action) || control.confirmation) {
          // Claim before acknowledgement and consume before execution. Old generations never become usable again.
          panel.value.items = [];
          panel.value.generation = (panel.value.generation ?? 0) + 1;
          if (control.action === 'ai.run.stop') { await cancel(invocation, control.input.runId as string); return true; }
           const active = await panels.render(panel, () => api(s => bot.api.editMessageText(invocation!.chat.id, panel!.messageId!,
             controlContent(panel!, translator(invocation!.language)('bot:ai.busy')), { reply_markup: { inline_keyboard: [] } }, s)).then(() => undefined));
          if (!active) return true;
          panels.get(panel.id, { ...binding(invocation), messageId: panel.messageId! });
          if (panel.value.signal?.aborted) return true;
          panel.value.executing = true;
        }
        if (control.confirmation) await view(invocation, control.action, control.input, panel, await deps.executor.confirm(invocation, control.confirmation));
        else await view(invocation, control.action, control.input, panel);
      } catch (error) {
        const failure = safeError(error).code;
        if (failure !== 'CONFIRMATION_EXPIRED') {
          const t = translator(invocation.language);
          await receipt(invocation, t(failure === 'OUTCOME_UNKNOWN' ? 'bot:ai.unknown' : 'bot:ai.operationFailed', {
            error: t(`common:errors.${failure}`),
          }), control.action, panel);
        }
      } finally { panel.value.busy = false; }
      return true;
    },
    async stop() {
      shutdown.abort();
      if (cacheTimer) clearTimeout(cacheTimer);
      cacheTimer = undefined;
      for (const album of albums.values()) clearTimeout(album.timer);
      albums.clear(); closedAlbums.clear();
      for (const run of runs.values()) { run.controller.abort(); void retire(run); }
      await Promise.allSettled([...pending]);
      proposals.clear();
      await panels.stop();
    },
  };
}
