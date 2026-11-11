import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  aiModuleEvents, automationCreateSchema, automationDefinitionSchema, automationMutationSchema,
  automationUpdateSchema, automationViewSchema, type AiModuleEvent, type AutomationDefinition, type AutomationView,
} from '../../shared/schemas/ai-automation.js';
import { aiScopeSchema, type AiJsonValue, type AiRecord, type AiScope } from '../../shared/schemas/ai.js';
import { localeSchema } from '../../shared/schemas/index.js';
import { createInvocation, type ActionExecutor, type InvocationContext } from '../actions.js';
import { AppError, throwIfAborted } from '../errors.js';
import { nextAutomationTime, validateAutomation } from './automation.js';
import { aiScope, aiScopeId, type AiSelection } from './policy.js';
import type { AiStore } from './store.js';

const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const opaqueId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
const actorSchema = z.strictObject({ botId: integer.min(1), actorId: integer.min(1), language: localeSchema,
  chat: z.strictObject({ id: z.number().int(), type: z.enum(['private', 'group', 'supergroup']), threadId: integer.min(1).optional() }),
});
const jobSchema = z.strictObject({ version: z.literal(1), definition: automationDefinitionSchema, actor: actorSchema,
  policyRevision: integer, grantId: opaqueId, presetId: opaqueId, generation: integer,
  policyKey: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  completedRuns: integer, nextAt: integer.nullable(), lastRunAt: integer.nullable(), occurrenceId: opaqueId.nullable(),
});
type Job = z.infer<typeof jobSchema>;
const claimSchema = z.strictObject({ version: z.literal(1), automationId: opaqueId, generation: integer, dueAt: integer });
const eventSchema = z.strictObject({ version: z.literal(1), event: z.enum(aiModuleEvents), eventId: opaqueId, receivedAt: integer });
const pageSchema = z.strictObject({ page: integer.default(0) });
const MAX_JOBS_PER_OWNER = 20;

export interface AiAutomationRun {
  id: string;
  occurrenceId: string;
  allowedTools: string[];
  maxInputTokens: number;
  maxOutputTokens: number;
  maxCostMicros: number;
}
export interface AiAutomationsOptions {
  store: AiStore;
  select: (context: InvocationContext) => AiSelection;
  isMember: (chatId: number, userId: number, signal: AbortSignal) => Promise<boolean>;
  run: (context: InvocationContext, input: { text: string; attachments: [] }, automation: AiAutomationRun, signal: AbortSignal) => Promise<'completed' | 'unknown'>;
  /** Stop and drain the root run associated with this automation ID, not a model-supplied run ID. */
  stopRun: (automationId: string, scope: AiScope) => Promise<void>;
  now?: () => number;
  onError?: () => void;
}
interface Active { id: string; scope: AiScope; occurrenceId: string; controller: AbortController; promise: Promise<void> }

function parse<T>(schema: z.ZodType<T>, input: unknown, code: 'INVALID_INPUT' | 'STORAGE_ERROR' = 'INVALID_INPUT'): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new AppError(code);
  return result.data;
}
function ownerPrefix(actorId: number): string { return `a.${actorId}.`; }
function occurrenceId(id: string, key: string): string { return createHash('sha256').update(`${id}:${key}`).digest('hex'); }

export class AiAutomations {
  #options: AiAutomationsOptions;
  #timer?: ReturnType<typeof setTimeout>;
  #running?: Promise<void>;
  #active?: Active;
  #eventId?: string;
  #started = false;
  #closed = false;
  #failed = false;

  constructor(options: AiAutomationsOptions) { this.#options = options; }
  private get store(): AiStore { return this.#options.store; }
  private now(): number { return (this.#options.now ?? Date.now)(); }

  register(executor: Pick<ActionExecutor, 'register'>): void {
    const common = { scopes: ['private', 'group'], sources: ['telegram', 'ai'], permission: 'self', aiVisible: true, timeoutMs: 60_000,
      aiDescription: 'Manage only this actor\'s bounded declarative automations in this audience. Creating, updating or deleting requires owner confirmation. Specify trigger/timezone, tools, expiry and run/token/cost limits. Automatic jobs cannot create or modify jobs.' } as const;
    executor.register({ ...common, id: 'ai.automations.list', input: pageSchema,
      output: z.strictObject({ items: z.array(automationViewSchema).max(10), nextCursor: integer.nullable() }), effect: 'read',
      execute: (input, context) => {
        this.human(context);
        const scope = aiScope(context);
        const page = this.store.recordList(scope, 'automation', { after: input.page, limit: 10, idPrefix: ownerPrefix(context.actorId) });
        return { items: page.items.map(record => this.view(scope, record)), nextCursor: page.nextCursor };
      } });
    const target = (_input: unknown, context: InvocationContext) => {
      this.human(context);
      return { kind: context.chat.type === 'private' ? 'user' as const : 'chat' as const, id: context.chat.id };
    };
    executor.register({ ...common, id: 'ai.automations.create', input: automationCreateSchema, output: automationViewSchema,
      effect: 'write', target, execute: (input, context) => this.create(context, input.definition) });
    executor.register({ ...common, id: 'ai.automations.update', input: automationUpdateSchema, output: automationViewSchema,
      effect: 'write', target, execute: (input, context) => this.update(context, input.id, input.revision, input.definition) });
    executor.register({ ...common, id: 'ai.automations.pause', input: automationMutationSchema, output: automationViewSchema,
      effect: 'personal_write', target, execute: (input, context) => this.pause(context, input.id, input.revision) });
    executor.register({ ...common, id: 'ai.automations.remove', input: automationMutationSchema, output: z.strictObject({ removed: z.boolean() }),
      effect: 'destructive', target, execute: async (input, context) => {
        this.human(context);
        const scope = aiScope(context);
        this.owned(context, input.id, input.revision);
        this.store.recordDelete(scope, 'automation', input.id, input.revision);
        await this.cancel(input.id, scope);
        this.changed();
        return { removed: true };
      } });
  }

  private human(context: InvocationContext): void {
    if (this.#closed) throw new AppError('CANCELLED');
    if (context.automationId || context.source === 'telegram' && context.aiRunId
      || context.source !== 'telegram' && !(context.source === 'ai' && context.aiRunId)) throw new AppError('FORBIDDEN');
    if (context.source === 'ai') {
      const run = this.store.runGet(aiScope(context), context.aiRunId!);
      const selected = this.#options.select(context);
      if (!run || run.actorId !== context.actorId || !['running', 'waiting-approval'].includes(run.state)
        || run.settingsRevision !== context.aiSettingsRevision || run.presetId !== selected.preset.id
        || context.aiGrantId !== selected.grant.id) throw new AppError('FORBIDDEN');
    }
    parse(aiScopeSchema, aiScope(context));
    throwIfAborted(context.signal);
  }

  private job(scope: AiScope, record: AiRecord): Job {
    const job = parse(jobSchema, record.payload, 'STORAGE_ERROR');
    if (!record.id.startsWith(ownerPrefix(job.actor.actorId)) || aiScopeId(aiScope(job.actor)) !== aiScopeId(scope)
      || !['active', 'working', 'paused', 'completed', 'unknown'].includes(record.state ?? '')) throw new AppError('STORAGE_ERROR');
    return job;
  }

  private owned(context: InvocationContext, id: string, revision?: number): { record: AiRecord; job: Job } {
    if (!id.startsWith(ownerPrefix(context.actorId))) throw new AppError('NOT_FOUND');
    const scope = aiScope(context);
    const record = this.store.recordGet(scope, 'automation', id);
    if (!record) throw new AppError('NOT_FOUND');
    const job = this.job(scope, record);
    if (job.actor.actorId !== context.actorId) throw new AppError('NOT_FOUND');
    if (revision !== undefined && record.revision !== revision) throw new AppError('CONFLICT');
    return { record, job };
  }

  private view(scope: AiScope, record: AiRecord): AutomationView {
    const job = this.job(scope, record);
    return parse(automationViewSchema, { ...job.definition, id: record.id, revision: record.revision,
      completedRuns: job.completedRuns, state: record.state === 'working' ? 'active' : record.state,
      nextAt: job.nextAt === null ? null : new Date(job.nextAt).toISOString(),
      target: `${scope.ownerId === undefined ? 'group' : 'private'}:${scope.chatId}${scope.threadId ? `/topic:${scope.threadId}` : ''}`,
    }, 'STORAGE_ERROR');
  }

  private write(scope: AiScope, record: AiRecord, job: Job, state: string): AiRecord {
    const expires = Date.parse(job.definition.expiresAt);
    const due = state === 'active' ? Math.min(job.nextAt ?? expires, expires) : undefined;
    return this.store.recordPut(scope, 'automation', { id: record.id, expectedRevision: record.revision,
      payload: job as AiJsonValue, state, ...(due === undefined ? {} : { dueAt: new Date(due).toISOString() }) });
  }

  private checkSelection(context: InvocationContext, definition: AutomationDefinition, job?: Job): AiSelection {
    const selection = this.#options.select(job?.policyKey ? { ...context, aiSettingsRevision: undefined } : context);
    const policyKey = selection.policyKey ?? this.store.policyKey(context);
    if (job && ((job.policyKey ? policyKey !== job.policyKey : selection.snapshot.revision !== job.policyRevision)
      || selection.grant.id !== job.grantId || selection.preset.id !== job.presetId)) throw new AppError('FORBIDDEN');
    if (definition.tools.some(tool => !selection.preset.tools.includes(tool) || tool.startsWith('ai.automations.')
      || ['ai.memory.propose', 'ai.memory.revise', 'ai.memory.forget'].includes(tool))
      || definition.maxInputTokens > selection.preset.budget.maxInputTokens || definition.maxOutputTokens > selection.preset.budget.maxOutputTokens
      || definition.maxCostMicros > selection.preset.budget.maxCostMicros) throw new AppError('FORBIDDEN');
    return { ...selection, policyKey };
  }

  private async fresh(context: InvocationContext, definition: AutomationDefinition, job?: Job): Promise<AiSelection> {
    this.checkSelection(context, definition, job);
    // Configured superadmins are not a substitute for current group membership.
    if (context.chat.type !== 'private' && !await this.#options.isMember(context.chat.id, context.actorId, context.signal)) throw new AppError('FORBIDDEN');
    throwIfAborted(context.signal);
    return this.checkSelection(context, definition, job);
  }

  private async create(context: InvocationContext, definition: AutomationDefinition): Promise<AutomationView> {
    this.human(context);
    const selection = await this.fresh(context, definition);
    const nextAt = validateAutomation(definition, this.now());
    const scope = aiScope(context);
    if (this.store.recordList(scope, 'automation', { idPrefix: ownerPrefix(context.actorId), limit: MAX_JOBS_PER_OWNER }).items.length >= MAX_JOBS_PER_OWNER) throw new AppError('CAPACITY');
    const job: Job = { version: 1, definition, actor: { botId: context.botId, actorId: context.actorId, chat: { ...context.chat }, language: context.language },
      policyRevision: selection.snapshot.revision, policyKey: selection.policyKey, grantId: selection.grant.id, presetId: selection.preset.id,
      generation: 0, nextAt, completedRuns: 0, lastRunAt: null, occurrenceId: null };
    const record = this.store.recordCreate(scope, 'automation', `${ownerPrefix(context.actorId)}${randomUUID()}`, {
      payload: job as AiJsonValue, state: 'active', dueAt: new Date(nextAt ?? Date.parse(definition.expiresAt)).toISOString() });
    this.changed();
    return this.view(scope, record);
  }

  private async update(context: InvocationContext, id: string, revision: number, definition: AutomationDefinition): Promise<AutomationView> {
    this.human(context);
    this.owned(context, id, revision);
    const selection = await this.fresh(context, definition);
    validateAutomation(definition, this.now());
    const { record, job } = this.owned(context, id, revision);
    if (definition.maxRuns <= job.completedRuns) throw new AppError('INVALID_INPUT');
    const scope = aiScope(context);
    const next: Job = { ...job, definition, generation: job.generation + 1, occurrenceId: null, nextAt: null,
      actor: { ...job.actor, language: context.language }, policyRevision: selection.snapshot.revision, policyKey: selection.policyKey,
      grantId: selection.grant.id, presetId: selection.preset.id };
    const revoked = this.write(scope, record, next, 'paused');
    await this.cancel(id, scope);
    await this.fresh(context, definition, next);
    next.nextAt = validateAutomation(definition, this.now());
    const activated = this.write(scope, revoked, next, 'active');
    this.changed();
    return this.view(scope, activated);
  }

  private async pause(context: InvocationContext, id: string, revision: number): Promise<AutomationView> {
    this.human(context);
    const scope = aiScope(context);
    const { record, job } = this.owned(context, id, revision);
    const paused = this.write(scope, record, { ...job, generation: job.generation + 1, nextAt: null, occurrenceId: null }, 'paused');
    await this.cancel(id, scope);
    this.changed();
    return this.view(scope, paused);
  }

  private async cancel(id: string, scope: AiScope): Promise<void> {
    const active = this.#active?.id === id && aiScopeId(this.#active.scope) === aiScopeId(scope) ? this.#active : undefined;
    active?.controller.abort();
    const results = await Promise.allSettled([Promise.resolve().then(() => this.#options.stopRun(id, scope)), active?.promise]);
    if (results.some(result => result.status === 'rejected')) throw new AppError('OUTCOME_UNKNOWN');
  }

  authorizeTool(context: InvocationContext, actionId: string): boolean {
    try {
      if (this.#closed || this.#failed || context.source !== 'ai' || context.signal.aborted || !context.aiRunId || !context.automationId) return false;
      const scope = aiScope(context);
      const active = this.#active;
      if (!active || active.id !== context.automationId || active.controller.signal.aborted || aiScopeId(active.scope) !== aiScopeId(scope)) return false;
      const { record, job } = this.owned(context, context.automationId);
      if (record.state !== 'working' || job.occurrenceId !== active.occurrenceId || job.completedRuns >= job.definition.maxRuns
        || Date.parse(job.definition.expiresAt) <= this.now() || !job.definition.tools.includes(actionId)
        || context.aiGrantId !== job.grantId || !job.policyKey && context.aiSettingsRevision !== job.policyRevision) return false;
      this.checkSelection(context, job.definition, job);
      return true;
    } catch { return false; }
  }

  start(): void {
    if (this.#started || this.#closed) return;
    this.recover();
    this.#started = true;
    this.changed();
  }

  async invalidatePolicy(): Promise<void> {
    let after = 0;
    for (;;) {
      const page = this.store.recordScanScheduled('automation', { after, limit: 20 });
      for (const { scope, record } of page.items) {
        if (record.state !== 'active' && record.state !== 'working') continue;
        const job = this.job(scope, record);
        try { this.checkSelection(createInvocation({ ...job.actor, source: 'ai' }), job.definition, job); }
        catch {
          this.write(scope, record, { ...job, generation: job.generation + 1, nextAt: null, occurrenceId: null }, 'paused');
          await this.cancel(record.id, scope);
        }
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    this.changed();
  }

  private recover(): void {
    for (const state of ['automation-claimed', 'automation-working']) {
      let after = 0;
      for (;;) {
        const page = this.store.recordScanScheduled('outbox', { after, limit: 20, state });
        for (const { scope, record } of page.items) {
          const claim = parse(claimSchema, record.payload, 'STORAGE_ERROR');
          const current = this.store.recordGet(scope, 'automation', claim.automationId);
          if (current) {
            const job = this.job(scope, current);
            if (job.generation === claim.generation && (current.state === 'active' || current.state === 'working')) this.write(scope, current, { ...job, nextAt: null }, 'unknown');
          }
          this.store.recordPut(scope, 'outbox', { id: record.id, expectedRevision: record.revision, payload: record.payload, state: 'automation-unknown' });
        }
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
    }
    let after = 0;
    for (;;) {
      const page = this.store.recordScanScheduled('automation', { after, limit: 20, state: 'working' });
      for (const { scope, record } of page.items) this.write(scope, record, { ...this.job(scope, record), nextAt: null }, 'unknown');
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
  }

  changed(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    if (!this.#started || this.#closed || this.#failed || this.#running) return;
    const times = [this.store.recordNearestDue('automation', 'active'), this.store.recordNearestDue('outbox', 'automation-event')]
      .filter((time): time is string => time !== null).map(time => Date.parse(time));
    if (!times.length) return;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#running = this.drain().catch(() => { this.#failed = true; this.#options.onError?.(); })
        .finally(() => { this.#running = undefined; this.changed(); });
    }, Math.min(2_147_000_000, Math.max(0, Math.min(...times) - this.now())));
    this.#timer.unref();
  }

  emit(event: AiModuleEvent, id: string, scope: AiScope): void {
    if (!this.#started || this.#closed || this.#failed) return;
    parse(z.enum(aiModuleEvents), event);
    parse(opaqueId, id);
    parse(aiScopeSchema, scope);
    const pending = this.store.recordScanScheduled('outbox', { state: 'automation-event', limit: 9 }).items;
    for (const entry of pending) {
      const value = parse(eventSchema, entry.record.payload, 'STORAGE_ERROR');
      if (aiScopeId(entry.scope) !== aiScopeId(scope) || value.event !== event) continue;
      if (value.eventId === id) return;
      if (entry.record.id !== this.#eventId) {
        this.store.recordPut(scope, 'outbox', { id: entry.record.id, expectedRevision: entry.record.revision,
          payload: { version: 1, event, eventId: id, receivedAt: this.now() }, state: 'automation-event', dueAt: entry.record.dueAt! });
        this.changed();
        return;
      }
    }
    if (pending.length >= 8) throw new AppError('CAPACITY');
    this.store.recordCreate(scope, 'outbox', `event.${randomUUID()}`, { payload: { version: 1, event, eventId: id, receivedAt: this.now() }, state: 'automation-event', dueAt: new Date(this.now()).toISOString() });
    this.changed();
  }

  private async drain(): Promise<void> {
    if (this.#closed) return;
    const dueBefore = new Date(this.now()).toISOString();
    const event = this.store.recordScanScheduled('outbox', { state: 'automation-event', dueBefore, limit: 1 }).items[0];
    if (event) {
      this.#eventId = event.record.id;
      try { await this.event(event.scope, event.record); } finally { this.#eventId = undefined; }
      return;
    }
    const entry = this.store.recordScanScheduled('automation', { state: 'active', dueBefore, limit: 1 }).items[0];
    if (!entry) return;
    const job = this.job(entry.scope, entry.record);
    if (Date.parse(job.definition.expiresAt) <= this.now() || job.completedRuns >= job.definition.maxRuns || job.nextAt === null) {
      this.write(entry.scope, entry.record, { ...job, nextAt: null }, 'completed');
      return;
    }
    await this.occurrence(entry.scope, entry.record, occurrenceId(entry.record.id, String(job.nextAt)), job.nextAt, this.now() - job.nextAt > 60_000);
  }

  private async event(scope: AiScope, eventRecord: AiRecord): Promise<void> {
    const event = parse(eventSchema, eventRecord.payload, 'STORAGE_ERROR');
    let after = 0;
    let nextAt: number | undefined;
    for (;;) {
      const page = this.store.recordList(scope, 'automation', { after, limit: 20, state: 'active' });
      for (const listed of page.items) {
        if (this.#closed) return;
        const record = this.store.recordGet(scope, 'automation', listed.id);
        if (!record || record.state !== 'active') continue;
        const job = this.job(scope, record);
        if (job.definition.trigger.kind !== 'event' || job.definition.trigger.event !== event.event) continue;
        if (Date.parse(job.definition.expiresAt) <= this.now() || job.completedRuns >= job.definition.maxRuns) {
          this.write(scope, record, { ...job, nextAt: null }, 'completed');
          continue;
        }
        const id = occurrenceId(record.id, `${event.event}:${event.eventId}`);
        if (this.store.recordGet(scope, 'outbox', id)) continue;
        const dueAt = Math.max(event.receivedAt, (job.lastRunAt ?? 0) + job.definition.trigger.cooldownMinutes * 60_000);
        if (dueAt > this.now()) { nextAt = Math.min(nextAt ?? Infinity, dueAt, Date.parse(job.definition.expiresAt)); continue; }
        await this.occurrence(scope, record, id, dueAt, false);
      }
      if (page.nextCursor === null) break;
      after = page.nextCursor;
    }
    if (this.#closed) return;
    if (nextAt === undefined) this.store.recordDelete(scope, 'outbox', eventRecord.id, eventRecord.revision);
    else this.store.recordPut(scope, 'outbox', { id: eventRecord.id, expectedRevision: eventRecord.revision, payload: event,
      state: 'automation-event', dueAt: new Date(nextAt).toISOString() });
  }

  private async occurrence(scope: AiScope, record: AiRecord, id: string, dueAt: number, missed: boolean): Promise<void> {
    const job = this.job(scope, record);
    let ledger: AiRecord;
    try {
      ledger = this.store.recordCreate(scope, 'outbox', id, { payload: { version: 1, automationId: record.id, generation: job.generation, dueAt }, state: 'automation-claimed' });
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'CONFLICT') throw error;
      this.write(scope, record, { ...job, nextAt: null }, 'unknown');
      return;
    }
    const working = this.write(scope, record, { ...job, occurrenceId: id, lastRunAt: missed ? job.lastRunAt : this.now() }, 'working');
    const active: Active = { id: record.id, scope, occurrenceId: id, controller: new AbortController(), promise: Promise.resolve() };
    this.#active = active;
    active.promise = this.perform(active, working, ledger, missed);
    try { await active.promise; } finally { if (this.#active === active) this.#active = undefined; }
  }

  private async perform(active: Active, record: AiRecord, ledger: AiRecord, missed: boolean): Promise<void> {
    const job = this.job(active.scope, record);
    let outcome: 'completed' | 'skipped' | 'paused' | 'unknown' = missed ? 'skipped' : 'paused';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!missed) {
        const context = createInvocation({ ...job.actor, source: 'ai', automationId: record.id, aiGrantId: job.grantId,
          aiSettingsRevision: job.policyKey ? this.store.getSettings().revision : job.policyRevision,
          signal: active.controller.signal, deadline: Date.parse(job.definition.expiresAt) });
        const selected = await this.fresh(context, job.definition, job);
        const current = this.store.recordGet(active.scope, 'automation', record.id);
        if (!current || current.revision !== record.revision || Date.parse(job.definition.expiresAt) <= this.now()) throw new AppError('FORBIDDEN');
        throwIfAborted(active.controller.signal);
        const deadline = Math.min(Date.parse(job.definition.expiresAt), this.now() + selected.preset.budget.maxDurationMs);
        timer = setTimeout(() => active.controller.abort(), Math.max(0, deadline - this.now()));
        timer.unref();
        outcome = 'unknown';
        const result = await this.#options.run(createInvocation({ ...context, deadline }), { text: job.definition.instruction, attachments: [] }, {
          id: record.id, occurrenceId: active.occurrenceId, allowedTools: [...job.definition.tools], maxInputTokens: job.definition.maxInputTokens,
          maxOutputTokens: job.definition.maxOutputTokens, maxCostMicros: job.definition.maxCostMicros,
        }, active.controller.signal);
        outcome = result === 'completed' && !active.controller.signal.aborted ? 'completed' : 'unknown';
      }
    } catch { /* Admission failures pause; any attempted run with an uncertain outcome stays frozen. */ }
    finally {
      if (timer) clearTimeout(timer);
      this.store.recordPut(active.scope, 'outbox', { id: ledger.id, expectedRevision: ledger.revision, payload: ledger.payload, state: `automation-${outcome}` });
      const current = this.store.recordGet(active.scope, 'automation', record.id);
      if (current && current.revision === record.revision) {
        const completedRuns = job.completedRuns + (outcome === 'completed' ? 1 : 0);
        const next = nextAutomationTime(job.definition.trigger, this.now());
        const nextAt = next !== null && next < Date.parse(job.definition.expiresAt) ? next : null;
        const state = outcome === 'unknown' || outcome === 'paused' ? outcome
          : completedRuns >= job.definition.maxRuns || Date.parse(job.definition.expiresAt) <= this.now()
            || job.definition.trigger.kind !== 'event' && nextAt === null ? 'completed' : 'active';
        this.write(active.scope, current, { ...job, completedRuns, nextAt: state === 'active' ? nextAt : null, occurrenceId: null }, state);
      }
    }
  }

  async stop(): Promise<void> {
    if (this.#closed) { await this.#running; return; }
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    const active = this.#active;
    let failed = false;
    if (active) {
      try {
        const current = this.store.recordGet(active.scope, 'automation', active.id);
        if (current?.state === 'working') this.write(active.scope, current, { ...this.job(active.scope, current), nextAt: null }, 'unknown');
      } catch { failed = true; }
      // The closed flag has already revoked authority, including if disk writes failed.
      try { await this.cancel(active.id, active.scope); } catch { failed = true; }
    }
    await this.#running;
    if (failed) throw new AppError('OUTCOME_UNKNOWN');
  }
}
