import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  coreSettingsMetadata, coreSettingsSchema, emptyInputSchema, groupMutationResultSchema,
  groupMutationSchema, groupPageInputSchema, groupPageSchema, infoSchema, inputJsonSchema,
  localeSchema, moduleListSchema, preferenceInputSchema, preferenceSchema, settingsSnapshotSchema,
  settingsUpdateSchema, statusSchema, userIdSchema,
  type ActionResult, type Confirmation, type Locale, type RuntimeStatus,
} from '../shared/schemas/index.js';
import type { AccessService } from './access.js';
import type { ConfigurationService } from './configuration.js';
import { AppError, safeError, throwIfAborted } from './errors.js';
import { modules } from './modules/index.js';
import { registerAliasActions, type AliasService } from './modules/alias.js';
import { registerRssActions, type RssService } from './modules/rss.js';
import { registerRateActions, type RateService } from './modules/rate.js';
import { registerWeatherActions, type WeatherService } from './modules/weather.js';
import { registerStickerActions, type StickerService } from './modules/sticker.js';
import { registerSubconvActions, type SubconvService } from './modules/subconv.js';

export type InvocationSource = 'telegram' | 'http' | 'ai';
export interface InvocationInput {
  actorId: number;
  source: InvocationSource;
  botId: number;
  chat: { id: number; type: 'private' | 'group' | 'supergroup'; threadId?: number };
  language: Locale;
  languageHint?: string;
  confirmationSource?: 'telegram' | 'http';
  invocationId?: string;
  signal?: AbortSignal;
  deadline?: number;
}
export interface InvocationContext extends Readonly<InvocationInput> {
  readonly chat: Readonly<InvocationInput['chat']>;
  readonly invocationId: string;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly dataScope: Readonly<{ kind: 'user'; id: number }>;
}

const trustedContexts = new WeakSet<object>();

// This constructor belongs to trusted adapters, not to the public shared package.
export function createInvocation(input: InvocationInput): InvocationContext {
  if (!userIdSchema.safeParse(input.actorId).success || !userIdSchema.safeParse(input.botId).success
    || !localeSchema.safeParse(input.language).success || !['telegram', 'http', 'ai'].includes(input.source)
    || !Number.isSafeInteger(input.chat.id) || input.chat.id === 0
    || !['private', 'group', 'supergroup'].includes(input.chat.type)
    || (input.chat.type === 'private' ? input.chat.id !== input.actorId : input.chat.id >= 0)
    || input.chat.threadId !== undefined && (!Number.isSafeInteger(input.chat.threadId) || input.chat.threadId < 1)
    || input.invocationId !== undefined && !/^[A-Za-z0-9_.:-]{1,128}$/.test(input.invocationId)
    || input.deadline !== undefined && !Number.isFinite(input.deadline)) throw new AppError('FORBIDDEN');
  const context: InvocationContext = Object.freeze({
    ...input,
    chat: Object.freeze({ ...input.chat }),
    invocationId: input.invocationId ?? randomUUID(),
    signal: input.signal ?? new AbortController().signal,
    deadline: input.deadline ?? Date.now() + 60_000,
    dataScope: Object.freeze({ kind: 'user' as const, id: input.actorId }),
  });
  trustedContexts.add(context);
  return context;
}

export type Effect = 'read' | 'personal_write' | 'write' | 'destructive' | 'permission';
export interface ActionDefinition<I, O> {
  id: string;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  permission: 'any' | 'self' | 'superadmin' | 'group_admin' | 'chat_manager';
  scopes: readonly ('private' | 'group')[];
  sources: readonly InvocationSource[];
  effect: Effect;
  aiVisible: boolean;
  timeoutMs: number;
  target?: (input: I, context: InvocationContext) => { kind: 'user' | 'chat'; id: number };
  confirmation?: (input: I, context: InvocationContext) => boolean;
  execute: (input: I, context: InvocationContext) => Promise<O> | O;
}

export interface TelegramEffects {
  describeGroup(chatId: number, signal: AbortSignal): Promise<{ title: string; present: boolean }>;
  notifyGroup(chatId: number, event: 'authorized' | 'revoked', language: Locale, signal: AbortSignal): Promise<boolean>;
  leaveGroup(chatId: number, signal: AbortSignal): Promise<boolean>;
  syncPrivateMenu(userId: number, language: Locale, signal: AbortSignal): Promise<boolean>;
}

export interface AuditRecord {
  actorId: number;
  actionId: string;
  source: InvocationSource;
  invocationId: string;
  outcome: ActionResult['status'];
  code?: string;
  durationMs: number;
}

export interface ActionServices {
  access: AccessService;
  configuration: ConfigurationService;
  aliases: AliasService;
  rss: RssService;
  rate: RateService;
  weather: WeatherService;
  stickers: StickerService;
  subconv: SubconvService;
  effects: TelegramEffects;
  status: () => RuntimeStatus;
  aiEnabled?: boolean;
  groupAdmin?: (chatId: number, userId: number, signal: AbortSignal) => Promise<boolean>;
  audit?: (record: AuditRecord) => void;
  now?: () => number;
  capacity?: number;
}

type AnyAction = ActionDefinition<unknown, unknown>;
interface Approval {
  confirmation: Confirmation;
  action: AnyAction;
  input: unknown;
  actorId: number;
  botId: number;
  source: InvocationSource;
  chatId: number;
  threadId?: number;
  accessRevision: number;
  settingsRevision: number;
  expires: number;
}
interface Execution {
  fingerprint: string;
  promise: Promise<ActionResult>;
  expires: number;
  active: boolean;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new AppError('INVALID_OUTPUT');
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  throw new AppError('INVALID_OUTPUT');
}

export class ActionExecutor {
  private readonly registry = new Map<string, AnyAction>();
  private readonly approvals = new Map<string, Approval>();
  private readonly executions = new Map<string, Execution>();
  private readonly controllers = new Set<AbortController>();
  private readonly runningTasks = new Set<Promise<ActionResult>>();
  private readonly now: () => number;
  private readonly capacity: number;
  private closed = false;

  constructor(private readonly services: ActionServices) {
    this.now = services.now ?? Date.now;
    this.capacity = services.capacity ?? 5_000;
    this.registerCore();
    registerAliasActions(this, services.aliases);
    registerRssActions(this, services.rss);
    registerRateActions(this, services.rate);
    registerWeatherActions(this, services.weather);
    registerStickerActions(this, services.stickers);
    registerSubconvActions(this, services.subconv);
  }

  resolveAlias(name: string): string | undefined { return this.services.aliases.resolve(name); }
  aliasesFor(command: string): readonly string[] { return this.services.aliases.forCommand(command); }

  register<I, O>(definition: ActionDefinition<I, O>): void {
    if (!/^[a-z][a-z0-9_.]{1,63}$/.test(definition.id) || this.registry.has(definition.id)
      || definition.timeoutMs < 1 || definition.timeoutMs > 60_000) throw new AppError('INVALID_INPUT');
    const schema = inputJsonSchema(definition.input);
    if (schema.type !== 'object' || schema.additionalProperties !== false) throw new AppError('INVALID_INPUT');
    z.toJSONSchema(definition.output, { target: 'draft-7', unrepresentable: 'throw' });
    this.registry.set(definition.id, definition as AnyAction);
  }

  async execute<T = unknown>(context: InvocationContext, id: string, rawInput: unknown): Promise<ActionResult<T>> {
    try {
      const action = this.find(context, id);
      const input = this.parse(action, rawInput);
      await this.policy(action, context, input);
      const fingerprint = createHash('sha256').update(canonical(input)).digest('hex');
      const key = `${context.botId}:${context.actorId}:${context.source}:${context.chat.id}:${context.chat.threadId ?? 0}:${id}:${context.invocationId}`;
      this.prune();
      const existing = this.executions.get(key);
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new AppError('CONFLICT');
        const result = await existing.promise;
        return (result.status === 'succeeded' ? { ...result, replayed: true } : result) as ActionResult<T>;
      }
      if (this.executions.size >= this.capacity) throw new AppError('CAPACITY');
      const promise = this.needsConfirmation(action, context, input)
        ? Promise.resolve(this.approval(context, action, input))
        : this.run(action, context, input);
      const record: Execution = { fingerprint, promise, expires: this.now() + 600_000, active: true };
      this.executions.set(key, record);
      try { return await promise as ActionResult<T>; }
      finally { record.active = false; record.expires = this.now() + 600_000; }
    } catch (error) { return this.reject(context, id, error) as ActionResult<T>; }
  }

  async prepare<T = unknown>(context: InvocationContext, id: string, rawInput: unknown): Promise<ActionResult<T>> {
    try {
      const action = this.find(context, id);
      if (context.source === 'ai') throw new AppError('FORBIDDEN');
      const input = this.parse(action, rawInput);
      await this.policy(action, context, input);
      return this.approval(context, action, input) as ActionResult<T>;
    } catch (error) { return this.reject(context, id, error) as ActionResult<T>; }
  }

  pending(context: InvocationContext, token: string): Confirmation {
    this.assertContext(context);
    this.prune();
    const item = this.approvals.get(token);
    if (!/^[a-f0-9]{40}$/.test(token)) throw new AppError('CONFIRMATION_EXPIRED');
    this.checkApproval(context, item);
    return { ...item.confirmation };
  }

  async confirm<T = unknown>(context: InvocationContext, token: string): Promise<ActionResult<T>> {
    let id = 'confirmation';
    try {
      this.pending(context, token);
      const item = this.approvals.get(token)!;
      this.approvals.delete(token);
      id = item.action.id;
      await this.policy(item.action, context, item.input);
      this.checkApproval(context, item);
      return await this.run(item.action, context, item.input) as ActionResult<T>;
    } catch (error) { return this.reject(context, id, error) as ActionResult<T>; }
  }

  async discoverTools(context: InvocationContext): Promise<{ id: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }[]> {
    this.assertContext(context);
    if (!this.services.aiEnabled) return [];
    const aiContext = createInvocation({ ...context, source: 'ai' });
    const tools = [];
    for (const action of this.registry.values()) {
      try {
        this.basePolicy(action, aiContext);
        if (action.permission === 'group_admin' && (!this.services.groupAdmin
          || !await this.services.groupAdmin(context.chat.id, context.actorId, context.signal))) continue;
        tools.push({ id: action.id, inputSchema: inputJsonSchema(action.input), outputSchema: z.toJSONSchema(action.output, { target: 'draft-7' }) });
      } catch { throwIfAborted(context.signal); }
    }
    return tools;
  }

  executeTool<T = unknown>(authenticated: InvocationContext, id: string, input: unknown): Promise<ActionResult<T>> {
    this.assertContext(authenticated);
    return this.execute<T>(createInvocation({ ...authenticated, source: 'ai',
      confirmationSource: authenticated.source === 'ai' ? authenticated.confirmationSource : authenticated.source }), id, input);
  }

  async close(): Promise<void> {
    this.closed = true;
    this.approvals.clear();
    for (const controller of this.controllers) controller.abort();
    await Promise.all([...this.runningTasks]);
    this.executions.clear();
  }

  private assertContext(context: InvocationContext): void {
    if (!trustedContexts.has(context) || this.closed) throw new AppError(this.closed ? 'CANCELLED' : 'FORBIDDEN');
    throwIfAborted(context.signal);
  }

  private find(context: InvocationContext, id: string): AnyAction {
    this.assertContext(context);
    const action = this.registry.get(id);
    if (!action) throw new AppError('NOT_FOUND');
    return action;
  }

  private parse(action: AnyAction, rawInput: unknown): unknown {
    const result = action.input.safeParse(rawInput);
    if (!result.success) throw new AppError('INVALID_INPUT', [...new Set(result.error.issues.map(issue => issue.path.filter(part => typeof part !== 'symbol').join('.')).filter(Boolean))]);
    canonical(result.data);
    return result.data;
  }

  private basePolicy(action: AnyAction, context: InvocationContext): void {
    this.assertContext(context);
    if (context.source === 'ai' && !this.services.aiEnabled) throw new AppError('AI_DISABLED');
    if (!action.sources.includes(context.source) || context.source === 'ai' && !action.aiVisible) throw new AppError('FORBIDDEN');
    const scope = context.chat.type === 'private' ? 'private' : 'group';
    if (!action.scopes.includes(scope)) throw new AppError('FORBIDDEN');
    if (action.permission === 'superadmin' && !this.services.access.isAdmin(context.actorId)) throw new AppError('FORBIDDEN');
    if (scope === 'group' && !this.services.access.isAllowed(context.chat.id)
      && !(action.id === 'groups.authorize' && this.services.access.isAdmin(context.actorId) && context.source === 'telegram')) throw new AppError('FORBIDDEN');
  }

  private targetPolicy(action: AnyAction, context: InvocationContext, input: unknown): void {
    this.basePolicy(action, context);
    const target = action.target?.(input, context);
    if (context.chat.type !== 'private' && action.id === 'groups.authorize' && target?.id !== context.chat.id) throw new AppError('FORBIDDEN');
    if (target?.kind === 'user' && target.id !== context.actorId && action.permission !== 'superadmin') throw new AppError('FORBIDDEN');
    if (target?.kind === 'chat' && action.permission !== 'superadmin'
      && (target.id !== context.chat.id || !this.services.access.isAllowed(target.id))) throw new AppError('FORBIDDEN');
  }

  private async policy(action: AnyAction, context: InvocationContext, input: unknown): Promise<void> {
    this.targetPolicy(action, context, input);
    if (action.permission === 'group_admin' || action.permission === 'chat_manager' && context.chat.type !== 'private' && !this.services.access.isAdmin(context.actorId)) {
      if (context.chat.type === 'private' || !this.services.groupAdmin) throw new AppError('FORBIDDEN');
      let allowed = false;
      try { allowed = await this.services.groupAdmin(context.chat.id, context.actorId, context.signal); }
      catch { throwIfAborted(context.signal); }
      if (!allowed) throw new AppError('FORBIDDEN');
    }
    this.targetPolicy(action, context, input);
  }

  private checkApproval(context: InvocationContext, item: Approval | undefined): asserts item is Approval {
    if (!item || item.actorId !== context.actorId || item.botId !== context.botId
      || item.source !== context.source || context.source === 'ai' || item.chatId !== context.chat.id || item.threadId !== context.chat.threadId
      || item.expires <= this.now() || item.accessRevision !== this.services.access.snapshot().revision
      || item.settingsRevision !== this.services.configuration.settings().revision) throw new AppError('CONFIRMATION_EXPIRED');
    this.targetPolicy(item.action, context, item.input);
    const target = item.action.target?.(item.input, context) ?? { kind: 'user', id: context.actorId };
    if (`${target.kind}:${target.id}` !== item.confirmation.target) throw new AppError('CONFIRMATION_EXPIRED');
  }

  private needsConfirmation(action: AnyAction, context: InvocationContext, input: unknown): boolean {
    return action.effect === 'destructive' || action.effect === 'write' || Boolean(action.confirmation?.(input, context));
  }

  private approval(context: InvocationContext, action: AnyAction, input: unknown): ActionResult {
    this.prune();
    if (this.approvals.size >= this.capacity) throw new AppError('CAPACITY');
    const token = randomBytes(20).toString('hex');
    const expires = this.now() + 600_000;
    const target = action.target?.(input, context) ?? { kind: 'user', id: context.actorId };
    const confirmation: Confirmation = { token, actionId: action.id, expiresAt: new Date(expires).toISOString(), target: `${target.kind}:${target.id}` };
    this.approvals.set(token, {
      confirmation, action, input: structuredClone(input), actorId: context.actorId, botId: context.botId,
      source: context.source === 'ai' ? context.confirmationSource ?? 'telegram' : context.source,
      chatId: context.chat.id, threadId: context.chat.threadId,
      accessRevision: this.services.access.snapshot().revision, settingsRevision: this.services.configuration.settings().revision, expires,
    });
    const result: ActionResult = { status: 'pending_confirmation', invocationId: context.invocationId, confirmation };
    this.audit(context, action.id, result, 0);
    return result;
  }

  private run(action: AnyAction, original: InvocationContext, input: unknown): Promise<ActionResult> {
    const task = this.perform(action, original, input);
    this.runningTasks.add(task);
    void task.then(() => this.runningTasks.delete(task), () => this.runningTasks.delete(task));
    return task;
  }

  private async perform(action: AnyAction, original: InvocationContext, input: unknown): Promise<ActionResult> {
    const started = this.now();
    const controller = new AbortController();
    this.controllers.add(controller);
    let timedOut = false;
    const abort = () => controller.abort();
    original.signal.addEventListener('abort', abort, { once: true });
    if (original.signal.aborted) controller.abort();
    const duration = Math.max(0, Math.min(action.timeoutMs, original.deadline - Date.now()));
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, duration);
    timer.unref();
    let begun = false;
    let result: ActionResult;
    try {
      if (duration === 0) { timedOut = true; controller.abort(); }
      throwIfAborted(controller.signal);
      const context = createInvocation({ ...original, signal: controller.signal, deadline: Math.min(original.deadline, Date.now() + duration) });
      this.targetPolicy(action, context, input);
      // Await real completion after cancellation; never race away from side effects.
      begun = true;
      const output = await action.execute(input, context);
      throwIfAborted(controller.signal);
      const parsed = action.output.safeParse(output);
      if (!parsed.success) throw new AppError('INVALID_OUTPUT');
      canonical(parsed.data);
      result = { status: 'succeeded', invocationId: original.invocationId, data: structuredClone(parsed.data) };
    } catch (error) {
      const cancelled = controller.signal.aborted;
      result = {
        status: 'failed', invocationId: original.invocationId,
        error: cancelled ? { code: begun && action.effect !== 'read' ? 'OUTCOME_UNKNOWN' : timedOut ? 'TIMEOUT' : 'CANCELLED' } : safeError(error),
      };
    } finally {
      clearTimeout(timer);
      original.signal.removeEventListener('abort', abort);
      this.controllers.delete(controller);
    }
    this.audit(original, action.id, result, this.now() - started);
    return result;
  }

  private reject(context: InvocationContext, id: string, error: unknown): ActionResult {
    const result: ActionResult = { status: 'rejected', invocationId: trustedContexts.has(context) ? context.invocationId : 'untrusted', error: safeError(error) };
    if (trustedContexts.has(context)) this.audit(context, id, result, 0);
    return result;
  }

  private audit(context: InvocationContext, id: string, result: ActionResult, durationMs: number): void {
    this.services.audit?.({ actorId: context.actorId, actionId: this.registry.has(id) ? id : 'unknown', source: context.source,
      invocationId: context.invocationId, outcome: result.status, durationMs,
      ...('error' in result ? { code: result.error.code } : {}),
    });
  }

  private prune(): void {
    const now = this.now();
    for (const [key, item] of this.approvals) if (item.expires <= now) this.approvals.delete(key);
    for (const [key, item] of this.executions) if (!item.active && item.expires <= now) this.executions.delete(key);
  }

  private registerCore(): void {
    const common = { scopes: ['private', 'group'], sources: ['telegram', 'http', 'ai'], timeoutMs: 15_000 } as const;
    const humanAdmin = { scopes: ['private'], sources: ['telegram', 'http'], permission: 'superadmin', aiVisible: false, timeoutMs: 30_000 } as const;
    this.register({ ...common, id: 'core.info', input: emptyInputSchema, output: infoSchema, permission: 'any', effect: 'read', aiVisible: true,
      execute: () => ({ runtime: 'grammy' as const, version: '0.1.0', moduleCount: modules.length, aiAvailable: false }) });
    this.register({ ...common, id: 'modules.list', input: emptyInputSchema, output: moduleListSchema, permission: 'any', effect: 'read', aiVisible: true,
      execute: () => modules.map(module => module.metadata) });
    this.register({ ...humanAdmin, id: 'core.status', input: emptyInputSchema, output: statusSchema, effect: 'read', execute: () => this.services.status() });
    this.register({ ...humanAdmin, id: 'groups.list', input: groupPageInputSchema, output: groupPageSchema, effect: 'read', execute: input => this.services.access.list(input.page) });
    this.register({ ...humanAdmin, scopes: ['private', 'group'], id: 'groups.authorize', input: groupMutationSchema, output: groupMutationResultSchema,
      effect: 'permission', target: input => ({ kind: 'chat', id: input.chatId }),
      execute: async (input, context) => {
        const group = await this.services.effects.describeGroup(input.chatId, context.signal);
        if (!group.present) throw new AppError('FORBIDDEN');
        const change = await this.services.access.authorize(input.chatId, group.title, context.actorId, input.revision, context.signal);
        const notificationSent = change.changed && await this.services.effects.notifyGroup(input.chatId, 'authorized', this.services.configuration.settings().effective.defaultLanguage, context.signal);
        return { chatId: input.chatId, ...change, notificationSent, left: false };
      },
    });
    this.register({ ...humanAdmin, id: 'groups.revoke', input: groupMutationSchema, output: groupMutationResultSchema,
      effect: 'destructive', target: input => ({ kind: 'chat', id: input.chatId }),
      execute: async (input, context) => {
        const change = await this.services.access.revoke(input.chatId, context.actorId, input.revision, context.signal);
        const notificationSent = change.changed && await this.services.effects.notifyGroup(input.chatId, 'revoked', this.services.configuration.settings().effective.defaultLanguage, context.signal);
        const left = change.changed && await this.services.effects.leaveGroup(input.chatId, context.signal);
        return { chatId: input.chatId, ...change, notificationSent, left };
      },
    });
    this.register({ ...humanAdmin, id: 'core.settings.get', input: emptyInputSchema, output: settingsSnapshotSchema, effect: 'read', execute: () => this.services.configuration.settings() });
    this.register({ ...humanAdmin, id: 'core.settings.update', input: settingsUpdateSchema, output: settingsSnapshotSchema, effect: 'permission',
      execute: (input, context) => this.services.configuration.updateSettings(input.settings, input.revision, context.signal) });
    this.register({ ...humanAdmin, id: 'core.settings.schema', input: emptyInputSchema,
      output: z.strictObject({ id: z.string(), schema_version: z.number().int(), nameKey: z.string(), descriptionKey: z.string(),
        schema: z.record(z.string(), z.unknown()), fields: z.record(z.string(), z.unknown()), order: z.array(z.string()) }),
      effect: 'read', execute: () => ({ ...coreSettingsMetadata, order: [...coreSettingsMetadata.order], schema: inputJsonSchema(coreSettingsSchema) }) });
    this.register({ ...common, sources: ['telegram', 'http'], id: 'preferences.get', input: emptyInputSchema, output: preferenceSchema,
      effect: 'read', permission: 'self', aiVisible: false,
      execute: (_input, context) => this.services.configuration.getPreference(context.actorId, context.languageHint) });
    this.register({ ...common, sources: ['telegram', 'http'], id: 'preferences.set', input: preferenceInputSchema, output: preferenceSchema,
      effect: 'personal_write', permission: 'self', aiVisible: false,
      execute: async (input, context) => {
        const result = await this.services.configuration.setPreference(context.actorId, input.language, context.languageHint, context.signal);
        const menuSynced = await this.services.effects.syncPrivateMenu(context.actorId, result.resolvedLanguage, context.signal);
        return { ...result, menuSynced };
      },
    });
  }
}
