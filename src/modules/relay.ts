import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { localeSchema, revisionSchema, userIdSchema, type Locale } from '../../shared/schemas/index.js';
import {
  relayIdSchema, relayListInputSchema, relayMutationInputSchema, relaySettingsInputSchema, relaySourceSchema, relayStatusSchema,
  type RelayContact, type RelayContactList, type RelayContactStatus, type RelayMutationInput,
  type RelayOwnerContact, type RelaySendResult, type RelaySettings, type RelaySettingsInput,
} from '../../shared/schemas/relay.js';
import type { InvocationContext } from '../actions.js';
import { AppError, throwIfAborted } from '../errors.js';
import { AsyncMutex, JsonDocument, type JsonStorage } from '../storage.js';

export { registerRelayActions } from './relay-actions.js';

export interface RelayTarget { botId: number; chatId: number; threadId?: number; replyTo?: number; languageHint?: Locale; contact?: { id: string; name: string } }
export interface RelayMessage { botId: number; chatId: number; threadId?: number; messageId: number }
export type RelayNotice = { kind: 'request'; contactId: string; visitor: { id: number; name: string; username?: string } }
  | { kind: 'accepted' | 'declined' | 'closed' | 'blocked'; contactId: string };
export interface RelayTransport {
  notify(target: RelayTarget, notice: RelayNotice, signal: AbortSignal): Promise<number>;
  copy(source: RelayMessage, target: RelayTarget, signal: AbortSignal): Promise<number>;
}
// Construct only for an acknowledged Telegram 4xx response, never a network/timeout error.
export class RelayTransportError extends Error {
  constructor(readonly status: number) { super('RELAY_TRANSPORT_REJECTED'); }
}
export interface RelayCapture { messageId: number; replyToMessageId?: number; sentAt: number; name: string; username?: string }
export type RelayClassification = 'reply' | 'active' | 'blocked' | 'none';
export interface RelayOptions { transport: RelayTransport; isAdmin: (actorId: number) => boolean; now?: () => number }

const MAX_CONTACTS = 256;
const MAX_ATTEMPTS = 2_048;
const MAX_MAPPINGS = 4_096;
const CAPTURE_TTL = 120_000;
const SOURCE_MAX_AGE = 300_000;
const MODE_TTL = 600_000;
const METADATA_TTL = 7 * 86_400_000;
const CONTACT_TTL = 30 * 86_400_000;
const timestamp = z.number().int().nonnegative();
const messageId = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const scopeSchema = z.strictObject({ botId: userIdSchema, userId: userIdSchema, chatId: userIdSchema, threadId: messageId.optional() })
  .refine(scope => scope.userId === scope.chatId);
const windowSchema = z.strictObject({ at: timestamp, count: z.number().int().nonnegative() });
const contactSchema = z.strictObject({
  id: relayIdSchema, revision: revisionSchema, status: relayStatusSchema, visitor: scopeSchema,
  name: z.string().max(128), username: z.string().max(32).optional(), language: localeSchema,
  createdAt: timestamp, updatedAt: timestamp, lastRequestAt: timestamp,
  ownerHighWater: z.number().int().nonnegative(), visitorHighWater: z.number().int().nonnegative(),
  ownerWindow: windowSchema, visitorWindow: windowSchema,
});
const attemptSchema = z.strictObject({
  key: z.string().min(1).max(180), contactId: relayIdSchema, status: z.enum(['attempted', 'sent', 'failed']),
  error: z.enum(['FORBIDDEN', 'NOT_FOUND', 'RATE_LIMITED', 'INVALID_INPUT']).optional(), expires: timestamp,
});
const mappingSchema = z.strictObject({ contactId: relayIdSchema, scope: scopeSchema, messageId, peerMessageId: messageId.optional(), expires: timestamp });
const fileSchema = z.strictObject({
  schema_version: z.literal(1), revision: revisionSchema, settingsRevision: revisionSchema,
  enabled: z.boolean(), owner: scopeSchema.nullable(), contacts: z.array(contactSchema).max(MAX_CONTACTS),
  attempts: z.array(attemptSchema).max(MAX_ATTEMPTS), mappings: z.array(mappingSchema).max(MAX_MAPPINGS), requests: windowSchema,
}).superRefine((state, context) => {
  const fail = () => context.addIssue({ code: 'custom', message: 'INVALID_RELAY_STATE' });
  if (state.enabled && !state.owner || new Set(state.contacts.map(item => item.id)).size !== state.contacts.length
    || new Set(state.contacts.map(item => `${item.visitor.botId}:${item.visitor.userId}`)).size !== state.contacts.length
    || new Set(state.attempts.map(item => item.key)).size !== state.attempts.length
    || new Set(state.mappings.map(item => `${scopeKey(item.scope)}:${item.messageId}`)).size !== state.mappings.length) fail();
  for (const contact of state.contacts) if (!state.owner || contact.visitor.botId !== state.owner.botId || contact.visitor.userId === state.owner.userId) fail();
  for (const mapping of state.mappings) {
    const contact = state.contacts.find(item => item.id === mapping.contactId);
    if (!contact || !sameScope(mapping.scope, contact.visitor) && (!state.owner || !sameScope(mapping.scope, state.owner))) fail();
  }
  if (state.attempts.some(item => !state.contacts.some(contact => contact.id === item.contactId)
    || (item.status === 'failed') !== (item.error !== undefined))) fail();
});
type Scope = z.infer<typeof scopeSchema>;
type Contact = z.infer<typeof contactSchema>;
type State = z.infer<typeof fileSchema>;
type Mapping = z.infer<typeof mappingSchema>;
type Attempt = z.infer<typeof attemptSchema>;
interface Source { scope: Scope; capture: RelayCapture; expires: number; suspended: boolean }
type Mode = { kind: 'pending' | 'active'; expires: number } | { kind: 'suspended' };
interface Task { scope: Scope; controller: AbortController; result: Promise<unknown>; finished: boolean }
function scopeKey(scope: Scope): string { return `${scope.botId}:${scope.userId}:${scope.chatId}:${scope.threadId ?? 0}`; }
function sameScope(left: Scope, right: Scope): boolean { return scopeKey(left) === scopeKey(right); }
function target(scope: Scope, replyTo?: number): RelayTarget {
  return { botId: scope.botId, chatId: scope.chatId, ...(scope.threadId === undefined ? {} : { threadId: scope.threadId }),
    ...(replyTo === undefined ? {} : { replyTo }) };
}

export class RelayService {
  private readonly file: JsonDocument<State>;
  private readonly now: () => number;
  private readonly mutex = new AsyncMutex();
  private readonly abort = new AbortController();
  private readonly tasks = new Map<Promise<unknown>, Task>();
  private readonly sources = new Map<string, Source>();
  private readonly modes = new Map<string, Mode>();
  private closed = false;
  private ownerSuspended = false;

  constructor(storage: JsonStorage, private readonly options: RelayOptions) {
    this.file = new JsonDocument(storage, 'relay.json', fileSchema);
    this.now = options.now ?? Date.now;
  }
  async initialize(): Promise<void> {
    await this.file.load({ schema_version: 1, revision: 0, settingsRevision: 0, enabled: false, owner: null,
      contacts: [], attempts: [], mappings: [], requests: { at: 0, count: 0 } });
  }
  private scope(context: InvocationContext): Scope {
    if (this.closed) throw new AppError('CANCELLED');
    if (context.source !== 'telegram' || context.chat.type !== 'private') throw new AppError('FORBIDDEN');
    const result = scopeSchema.safeParse({ botId: context.botId, userId: context.actorId, chatId: context.chat.id,
      ...(context.chat.threadId === undefined ? {} : { threadId: context.chat.threadId }) });
    if (!result.success) throw new AppError('FORBIDDEN');
    return result.data;
  }
  private available(state: State, scope: Scope): boolean {
    return Boolean(state.enabled && state.owner && state.owner.botId === scope.botId && this.options.isAdmin(state.owner.userId));
  }
  private owner(state: State, scope: Scope, unbound = false): void {
    if (!this.options.isAdmin(scope.userId) || (state.owner ? !sameScope(state.owner, scope) : !unbound)) throw new AppError('FORBIDDEN');
  }
  private ownedContact(state: State, scope: Scope, id: string): Contact {
    const contact = state.contacts.find(item => item.id === id);
    if (!contact || !sameScope(contact.visitor, scope) && (!state.owner || !sameScope(state.owner, scope) || !this.options.isAdmin(scope.userId))) throw new AppError('FORBIDDEN');
    return contact;
  }
  private active(contact: Contact): boolean {
    const mode = this.modes.get(contact.id);
    return contact.status === 'accepted' && mode?.kind === 'active' && mode.expires > this.now();
  }
  private view(contact: Contact, scope: Scope): RelayContact {
    return { id: contact.id, revision: contact.revision, status: contact.status, createdAt: contact.createdAt,
      updatedAt: contact.updatedAt, routingActive: sameScope(contact.visitor, scope) && this.active(contact)
        && this.available(this.file.snapshot(), scope) };
  }
  private ownerView(contact: Contact, scope: Scope): RelayOwnerContact {
    return { ...this.view(contact, scope), visitor: { id: contact.visitor.userId, name: contact.name,
      ...(contact.username === undefined ? {} : { username: contact.username }) } };
  }
  settings(context: InvocationContext): RelaySettings {
    const scope = this.scope(context); const state = this.file.snapshot(); this.owner(state, scope, true);
    return { revision: state.settingsRevision, enabled: state.enabled, ownerBound: state.owner !== null };
  }
  configure(context: InvocationContext, raw: RelaySettingsInput): Promise<RelaySettings> {
    return this.run(context, async (scope, signal) => {
      const input = relaySettingsInputSchema.safeParse(raw); if (!input.success) throw new AppError('INVALID_INPUT');
      await this.file.update(state => {
        this.owner(state, scope, true);
        if (state.settingsRevision !== input.data.revision) throw new AppError('CONFLICT');
        if (!state.owner && input.data.enabled) state.owner = scope;
        if (state.enabled === input.data.enabled) return false;
        state.enabled = input.data.enabled; state.settingsRevision++;
      }, { signal });
      if (!input.data.enabled) for (const [id, mode] of this.modes) if (mode.kind !== 'suspended') this.modes.delete(id);
      return this.settings(context);
    });
  }
  status(context: InvocationContext): RelayContactStatus {
    const scope = this.scope(context); const state = this.file.snapshot();
    const contact = state.contacts.find(item => sameScope(item.visitor, scope));
    return { available: this.available(state, scope) && state.owner!.userId !== scope.userId,
      contact: contact ? this.view(contact, scope) : null };
  }
  list(context: InvocationContext, page = 0): RelayContactList {
    const scope = this.scope(context); const state = this.file.snapshot(); this.owner(state, scope);
    if (!relayListInputSchema.safeParse({ page }).success) throw new AppError('INVALID_INPUT');
    const items = [...state.contacts].sort((a, b) => b.updatedAt - a.updatedAt);
    return { items: items.slice(page * 5, page * 5 + 5).map(item => this.ownerView(item, scope)), page, totalPages: Math.max(1, Math.ceil(items.length / 5)) };
  }
  get(context: InvocationContext, id: string): RelayOwnerContact {
    const scope = this.scope(context); const state = this.file.snapshot(); this.owner(state, scope);
    return this.ownerView(this.ownedContact(state, scope, id), scope);
  }

  // Trusted adapter capture only: never expose this method or its fields as Action parameters.
  capture(context: InvocationContext, input: RelayCapture): string {
    const scope = this.scope(context); const now = this.now();
    const parsed = z.strictObject({ messageId, replyToMessageId: messageId.optional(), sentAt: timestamp,
      name: z.string().max(128), username: z.string().regex(/^[A-Za-z0-9_]{1,32}$/).optional() }).safeParse(input);
    if (!parsed.success || parsed.data.sentAt < now - SOURCE_MAX_AGE || parsed.data.sentAt > now + 60_000) throw new AppError('INVALID_INPUT');
    for (const [key, source] of this.sources) if (source.expires <= now) this.sources.delete(key);
    for (const [key, source] of this.sources) if (sameScope(scope, source.scope) && source.capture.messageId === parsed.data.messageId) {
      if (JSON.stringify(source.capture) !== JSON.stringify(parsed.data)) throw new AppError('CONFLICT');
      return key;
    }
    if (this.sources.size >= 512 || [...this.sources.values()].filter(item => item.scope.botId === scope.botId && item.scope.userId === scope.userId).length >= 64) throw new AppError('CAPACITY');
    const reference = randomBytes(12).toString('hex');
    this.sources.set(reference, { scope, capture: parsed.data, expires: now + CAPTURE_TTL, suspended: false });
    return reference;
  }
  private source(scope: Scope, reference: string): Source {
    const source = this.sources.get(reference);
    if (!relaySourceSchema.safeParse(reference).success || !source || !sameScope(scope, source.scope)) throw new AppError('FORBIDDEN');
    if (source.expires <= this.now()) { this.sources.delete(reference); throw new AppError('NOT_FOUND'); }
    return source;
  }
  private mapping(state: State, scope: Scope, replyTo: number): Mapping | undefined {
    return state.mappings.find(item => sameScope(item.scope, scope) && item.messageId === replyTo);
  }
  // Source ownership survives mode changes so duplicate updates cannot become another module's input.
  ownsMessage(context: InvocationContext, sourceMessageId: number): boolean {
    const scope = this.scope(context);
    return this.file.snapshot().attempts.some(item => item.key === `copy:${scopeKey(scope)}:${sourceMessageId}`)
      || [...this.sources.values()].some(source => sameScope(source.scope, scope) && source.capture.messageId === sourceMessageId);
  }
  classify(context: InvocationContext, replyToMessageId?: number): RelayClassification {
    const scope = this.scope(context); const state = this.file.snapshot();
    const mapping = replyToMessageId === undefined ? undefined : this.mapping(state, scope, replyToMessageId);
    if (mapping) {
      const contact = state.contacts.find(item => item.id === mapping.contactId)!;
      return mapping.expires > this.now() && this.available(state, scope) && contact.status === 'accepted' ? 'reply' : 'blocked';
    }
    if (state.owner && sameScope(state.owner, scope) && replyToMessageId === undefined) return this.ownerSuspended ? 'none' : 'blocked';
    const contact = state.contacts.find(item => sameScope(item.visitor, scope));
    if (contact && ['pending', 'accepted'].includes(contact.status)) {
      if (this.modes.get(contact.id)?.kind === 'suspended') return 'none';
      return this.active(contact) && this.available(state, scope) && replyToMessageId === undefined ? 'active' : 'blocked';
    }
    return 'none';
  }
  // Routing-only adapter hook. Other commands/prompts win, including while acceptance is in flight.
  // This changes no persisted business state and never resumes a mode; resume is an Action.
  suspend(context: InvocationContext): void {
    const scope = this.scope(context);
    const state = this.file.snapshot();
    if (state.owner && sameScope(state.owner, scope)) this.ownerSuspended = true;
    const contact = state.contacts.find(item => sameScope(item.visitor, scope));
    if (contact) this.modes.set(contact.id, { kind: 'suspended' });
    for (const source of this.sources.values()) if (sameScope(source.scope, scope)) source.suspended = true;
  }
  // Selecting the inbox reserves unaddressed text, but still never selects a recipient.
  focus(context: InvocationContext): void {
    const scope = this.scope(context); const state = this.file.snapshot();
    if (!state.owner) return;
    this.owner(state, scope); this.ownerSuspended = false;
  }

  request(context: InvocationContext, reference: string): Promise<RelayContact> {
    return this.run(context, async (scope, signal) => {
      const source = this.source(scope, reference); const state = this.file.snapshot();
      if (!this.available(state, scope)) throw new AppError('UNAVAILABLE');
      if (state.owner!.userId === scope.userId) throw new AppError('FORBIDDEN');
      const existing = state.contacts.find(item => item.visitor.userId === scope.userId);
      if (existing && existing.status === 'blocked') throw new AppError('FORBIDDEN');
      if (existing && ['pending', 'accepted'].includes(existing.status)) {
        if (!sameScope(existing.visitor, scope)) throw new AppError('FORBIDDEN');
        const previous = state.attempts.find(item => item.key === `request:${existing.id}:${existing.revision}`);
        if (previous) this.acknowledged(previous);
        return this.view(existing, scope);
      }
      if (existing && (this.now() - existing.lastRequestAt < 60_000 || source.capture.messageId <= existing.visitorHighWater)) throw new AppError('RATE_LIMITED');
      const id = existing?.id ?? randomBytes(12).toString('hex');
      const revision = (existing?.revision ?? 0) + 1; const key = `request:${id}:${revision}`;
      await this.file.update(candidate => {
        this.prune(candidate, id);
        if (!existing && candidate.contacts.length >= MAX_CONTACTS) throw new AppError('CAPACITY');
        if (this.now() - candidate.requests.at >= 60_000) candidate.requests = { at: this.now(), count: 0 };
        if (++candidate.requests.count > 60) throw new AppError('RATE_LIMITED');
        candidate.contacts = candidate.contacts.filter(item => item.id !== id);
        candidate.mappings = candidate.mappings.filter(item => item.contactId !== id);
        candidate.contacts.push({ id, revision, status: 'pending', visitor: scope, name: source.capture.name,
          ...(source.capture.username === undefined ? {} : { username: source.capture.username }), language: context.language,
          createdAt: existing?.createdAt ?? this.now(), updatedAt: this.now(), lastRequestAt: this.now(),
          ownerHighWater: existing?.ownerHighWater ?? 0, visitorHighWater: source.capture.messageId,
          ownerWindow: { at: 0, count: 0 }, visitorWindow: { at: 0, count: 0 } });
        this.mark(candidate, key, id);
      }, { signal });
      this.modes.set(id, source.suspended ? { kind: 'suspended' } : { kind: 'pending', expires: this.now() + MODE_TTL });
      await this.deliver(key, id, scope, source.capture.messageId, state.owner!, signal,
        next => this.options.transport.notify(target(state.owner!), { kind: 'request', contactId: id,
          visitor: { id: scope.userId, name: source.capture.name, ...(source.capture.username === undefined ? {} : { username: source.capture.username }) } }, next));
      return this.view(this.file.snapshot().contacts.find(item => item.id === id)!, scope);
    });
  }
  change(context: InvocationContext, operation: 'accept' | 'decline' | 'close' | 'block', raw: RelayMutationInput): Promise<RelayContact> {
    return this.run(context, async (scope, signal) => {
      const parsed = relayMutationInputSchema.safeParse(raw); if (!parsed.success) throw new AppError('INVALID_INPUT');
      const input = parsed.data; const state = this.file.snapshot();
      if (operation !== 'close') this.owner(state, scope);
      const contact = this.ownedContact(state, scope, input.id); const owner = Boolean(state.owner && sameScope(state.owner, scope));
      const claim = this.modes.get(contact.id);
      const status = ({ accept: 'accepted', decline: 'declined', close: 'closed', block: 'blocked' } as const)[operation];
      const key = `${operation}:${contact.id}:${input.revision}`;
      const previous = state.attempts.find(item => item.key === key);
      if (previous && contact.revision === input.revision + 1 && contact.status === status) {
        this.acknowledged(previous); return this.view(contact, scope);
      }
      if (contact.revision !== input.revision) throw new AppError('CONFLICT');
      if (operation === 'accept' || operation === 'decline') {
        if (contact.status !== 'pending') throw new AppError('CONFLICT');
      } else if (contact.status === 'blocked' || operation === 'close' && !['pending', 'accepted'].includes(contact.status)) throw new AppError('FORBIDDEN');
      if (operation === 'accept' && !this.available(state, scope)) throw new AppError('UNAVAILABLE');
      const recipient = owner ? contact.visitor : state.owner;
      const notify = Boolean(recipient && (owner || this.options.isAdmin(recipient.userId)));
      await this.file.update(candidate => {
        this.prune(candidate, contact.id);
        const item = candidate.contacts.find(item => item.id === contact.id)!;
        item.status = status; item.revision++; item.updatedAt = this.now();
        if (notify) this.mark(candidate, key, contact.id);
      }, { signal });
      if (operation !== 'accept') this.modes.delete(contact.id);
      if (notify) await this.deliver(key, contact.id, undefined, undefined, recipient!, signal,
        next => this.options.transport.notify({ ...target(recipient!), ...(owner ? { languageHint: contact.language } : {}) },
          { kind: status, contactId: contact.id }, next));
      if (operation === 'accept' && claim?.kind === 'pending' && this.modes.get(contact.id) === claim && claim.expires > this.now()) {
        this.modes.set(contact.id, { kind: 'active', expires: this.now() + MODE_TTL });
      }
      return this.view(this.file.snapshot().contacts.find(item => item.id === contact.id)!, scope);
    });
  }
  resume(context: InvocationContext, raw: RelayMutationInput): Promise<RelayContact> {
    return this.run(context, async (scope, signal) => {
      const input = relayMutationInputSchema.safeParse(raw); if (!input.success) throw new AppError('INVALID_INPUT');
      const state = this.file.snapshot(); const contact = this.ownedContact(state, scope, input.data.id);
      if (!sameScope(contact.visitor, scope)) throw new AppError('FORBIDDEN');
      if (contact.revision !== input.data.revision) throw new AppError('CONFLICT');
      if (!this.available(state, scope) || contact.status !== 'accepted') throw new AppError('UNAVAILABLE');
      const key = `resume:${scopeKey(scope)}:${createHash('sha256').update(context.invocationId).digest('hex')}`;
      if (state.attempts.some(item => item.key === key)) return this.view(contact, scope);
      const claim = this.modes.get(contact.id);
      // Persist consumption, not the active mode: a replay after restart must not restore consent.
      await this.file.update(candidate => {
        this.prune(candidate, contact.id);
        if (candidate.attempts.length >= MAX_ATTEMPTS) throw new AppError('CAPACITY');
        candidate.attempts.push({ key, contactId: contact.id, status: 'sent', expires: this.now() + METADATA_TTL });
      }, { signal });
      throwIfAborted(signal);
      if (this.modes.get(contact.id) === claim || !this.modes.has(contact.id) && claim?.kind !== 'suspended') {
        this.modes.set(contact.id, { kind: 'active', expires: this.now() + MODE_TTL });
      }
      return this.view(contact, scope);
    });
  }
  send(context: InvocationContext, reference: string): Promise<RelaySendResult> {
    return this.run(context, async (scope, signal) => {
      const source = this.source(scope, reference); const state = this.file.snapshot();
      const reply = source.capture.replyToMessageId;
      const mapping = reply === undefined ? undefined : this.mapping(state, scope, reply);
      const contact = reply === undefined ? state.contacts.find(item => sameScope(item.visitor, scope))
        : mapping && state.contacts.find(item => item.id === mapping.contactId);
      if (!contact) throw new AppError('FORBIDDEN');
      this.ownedContact(state, scope, contact.id);
      const owner = sameScope(state.owner!, scope);
      if (!this.available(state, scope)) throw new AppError('UNAVAILABLE');
      if (contact.status !== 'accepted' || (mapping ? mapping.expires <= this.now() : owner || !this.active(contact))) throw new AppError('FORBIDDEN');
      if (owner && !source.suspended) this.ownerSuspended = false;
      const claim = this.modes.get(contact.id);
      const keepActive = claim?.kind === 'active' && claim.expires > this.now();
      const key = `copy:${scopeKey(scope)}:${source.capture.messageId}`;
      const previous = state.attempts.find(item => item.key === key);
      if (previous) {
        if (previous.contactId !== contact.id) throw new AppError('CONFLICT');
        this.acknowledged(previous); return { id: contact.id, delivered: true, replayed: true };
      }
      if (source.capture.messageId <= (owner ? contact.ownerHighWater : contact.visitorHighWater)) throw new AppError('OUTCOME_UNKNOWN');
      const recipient = owner ? contact.visitor : state.owner!;
      await this.file.update(candidate => {
        this.prune(candidate);
        const item = candidate.contacts.find(value => value.id === contact.id)!;
        const window = owner ? item.ownerWindow : item.visitorWindow;
        if (this.now() - window.at >= 60_000) { window.at = this.now(); window.count = 0; }
        if (++window.count > (owner ? 60 : 20)) throw new AppError('RATE_LIMITED');
        if (owner) item.ownerHighWater = source.capture.messageId; else item.visitorHighWater = source.capture.messageId;
        item.updatedAt = this.now();
        this.mark(candidate, key, contact.id);
      }, { signal });
      await this.deliver(key, contact.id, scope, source.capture.messageId, recipient, signal,
        next => this.options.transport.copy({ ...target(scope), messageId: source.capture.messageId },
          { ...target(recipient, mapping?.peerMessageId), ...(!owner ? { contact: { id: contact.id, name: contact.name } } : {}) }, next));
      if (keepActive && this.modes.get(contact.id) === claim) this.modes.set(contact.id, { kind: 'active', expires: this.now() + MODE_TTL });
      return { id: contact.id, delivered: true, replayed: false };
    });
  }

  private prune(state: State, keepId?: string): void {
    const now = this.now();
    state.contacts = state.contacts.filter(item => item.id === keepId || !['declined', 'closed'].includes(item.status) || item.updatedAt > now - CONTACT_TTL);
    const ids = new Set(state.contacts.map(item => item.id));
    state.attempts = state.attempts.filter(item => item.expires > now && ids.has(item.contactId));
    state.mappings = state.mappings.filter(item => item.expires > now && ids.has(item.contactId));
    for (const [id, mode] of this.modes) if (!ids.has(id) || mode.kind !== 'suspended' && mode.expires <= now) this.modes.delete(id);
  }
  private mark(state: State, key: string, contactId: string): void {
    // Reserve acknowledgement mapping capacity before an irreversible external effect.
    if (state.attempts.length >= MAX_ATTEMPTS || state.mappings.length > MAX_MAPPINGS - 2) throw new AppError('CAPACITY');
    state.attempts.push({ key, contactId, status: 'attempted', expires: this.now() + METADATA_TTL });
  }
  private acknowledged(attempt: Attempt): void {
    if (attempt.status === 'attempted') throw new AppError('OUTCOME_UNKNOWN');
    if (attempt.status === 'failed') throw new AppError(attempt.error!);
  }
  private async deliver(key: string, contactId: string, source: Scope | undefined, sourceId: number | undefined,
    destination: Scope, signal: AbortSignal, send: (signal: AbortSignal) => Promise<number>): Promise<void> {
    throwIfAborted(signal);
    const current = this.file.snapshot();
    if (!current.owner || !this.options.isAdmin(current.owner.userId)) throw new AppError('FORBIDDEN');
    let result: number;
    try {
      result = await send(signal);
      if (!messageId.safeParse(result).success) throw new Error('INVALID_ACK');
    } catch (error) {
      if (!(error instanceof RelayTransportError) || !Number.isInteger(error.status) || error.status < 400 || error.status >= 500 || signal.aborted) throw new AppError('OUTCOME_UNKNOWN');
      const code = error.status === 403 ? 'FORBIDDEN' : error.status === 404 ? 'NOT_FOUND' : error.status === 429 ? 'RATE_LIMITED' : 'INVALID_INPUT';
      try { await this.file.update(state => { const attempt = state.attempts.find(item => item.key === key)!; attempt.status = 'failed'; attempt.error = code; }); }
      catch { throw new AppError('OUTCOME_UNKNOWN'); }
      throw new AppError(code);
    }
    try {
      // Finish the durable acknowledgement even after cancellation; stop() drains this write.
      await this.file.update(state => {
        state.attempts.find(item => item.key === key)!.status = 'sent';
        const add = (scope: Scope, id: number, peerMessageId?: number) => {
          const previous = this.mapping(state, scope, id);
          if (previous && (previous.contactId !== contactId || previous.peerMessageId !== peerMessageId)) throw new AppError('CONFLICT');
          if (!previous) state.mappings.push({ contactId, scope, messageId: id, expires: this.now() + METADATA_TTL,
            ...(peerMessageId === undefined ? {} : { peerMessageId }) });
        };
        add(destination, result, sourceId);
        if (source && sourceId !== undefined) add(source, sourceId, result);
      });
    } catch { throw new AppError('OUTCOME_UNKNOWN'); }
    if (signal.aborted) throw new AppError('OUTCOME_UNKNOWN');
  }
  private run<T>(context: InvocationContext, work: (scope: Scope, signal: AbortSignal) => Promise<T>): Promise<T> {
    let scope: Scope;
    try { scope = this.scope(context); } catch (error) { return Promise.reject(error); }
    if (this.tasks.size >= 32) return Promise.reject(new AppError('CAPACITY'));
    const controller = new AbortController();
    const signal = AbortSignal.any([context.signal, this.abort.signal, controller.signal]);
    const result = Promise.withResolvers<T>(); let started = false;
    const job: Task = { scope, controller, result: result.promise, finished: false };
    const onAbort = () => { if (!started) { job.finished = true; result.reject(new AppError('CANCELLED')); } };
    signal.addEventListener('abort', onAbort, { once: true });
    const task = this.mutex.run(async () => {
      started = true;
      try { const value = await work(scope, signal); job.finished = true; result.resolve(value); }
      catch (error) { job.finished = true; result.reject(error); }
    }, signal);
    // Cancel queued callers immediately, but retain their queue slots until drained to bound memory.
    this.tasks.set(task, job);
    void task.catch(error => { job.finished = true; result.reject(error); }).finally(() => {
      signal.removeEventListener('abort', onAbort); this.tasks.delete(task);
    });
    if (signal.aborted) onAbort();
    return result.promise;
  }
  // Does not join the mutation queue: cancellation must be able to interrupt its active send.
  // True means matching work was found or a pending/accepted routing claim was explicitly paused.
  async cancel(context: InvocationContext): Promise<boolean> {
    const scope = this.scope(context); throwIfAborted(context.signal);
    const contact = this.file.snapshot().contacts.find(item => sameScope(item.visitor, scope));
    const paused = Boolean(contact && ['pending', 'accepted'].includes(contact.status) && this.modes.get(contact.id)?.kind !== 'suspended');
    this.suspend(context);
    const tasks = [...this.tasks.values()].filter(task => !task.finished && sameScope(task.scope, scope));
    for (const task of tasks) task.controller.abort();
    await Promise.allSettled(tasks.map(task => task.result));
    return paused || tasks.length > 0;
  }
  async stop(): Promise<void> {
    this.closed = true; this.abort.abort();
    await Promise.allSettled([...this.tasks.keys()]);
    this.sources.clear(); this.modes.clear();
  }
}
