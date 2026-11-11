import { z } from 'zod';
import { groupIdSchema, groupSchema, revisionSchema, userIdSchema, type GroupPage, type GroupState } from '../shared/schemas/index.js';
import { AppError } from './errors.js';
import { JsonDocument, type JsonStorage } from './storage.js';

const groupKey = z.string().regex(/^-[1-9]\d*$/);
const accessSchema = z.strictObject({
  schema_version: z.literal(1), revision: revisionSchema,
  groups: z.record(groupKey, groupSchema),
  membership: z.record(groupKey, z.strictObject({ updateId: z.number().int().nonnegative(), present: z.boolean() })),
  migrations: z.record(groupKey, groupIdSchema),
  groupRevisions: z.record(groupKey, revisionSchema).optional(),
}).superRefine((value, context) => {
  for (const [key, group] of Object.entries(value.groups)) {
    if (String(group.id) !== key) context.addIssue({ code: 'custom', path: ['groups', key] });
  }
});

export interface MembershipEvent {
  chatId: number;
  title: string;
  actorId?: number;
  actorIsBot?: boolean;
  isMember: boolean;
  wasMember: boolean;
  updateId: number;
  at: string;
}

export class AccessService {
  private readonly file: JsonDocument<z.infer<typeof accessSchema>>;
  private readonly admins: ReadonlySet<number>;

  constructor(storage: JsonStorage, adminIds: readonly number[]) {
    this.file = new JsonDocument(storage, 'access.json', accessSchema);
    this.admins = new Set(adminIds);
  }

  async initialize(): Promise<void> {
    await this.file.load({ schema_version: 1, revision: 0, groups: {}, membership: {}, migrations: {} });
  }

  isAdmin(id: number): boolean { return this.admins.has(id); }
  isAllowed(chatId: number): boolean { return Boolean(this.file.snapshot().groups[String(chatId)]); }
  snapshot(): z.infer<typeof accessSchema> { return this.file.snapshot(); }
  count(): number { return Object.keys(this.file.snapshot().groups).length; }
  groupRevision(chatId: number): number { return this.file.snapshot().groupRevisions?.[String(chatId)] ?? 0; }
  state(chatId: number): GroupState {
    groupIdSchema.parse(chatId);
    return { chatId, revision: this.file.snapshot().revision, groupRevision: this.groupRevision(chatId) };
  }

  list(page: number): GroupPage {
    const snapshot = this.file.snapshot();
    const groups = Object.values(snapshot.groups).sort((a, b) => a.id - b.id);
    return { items: groups.slice(page * 10, (page + 1) * 10).map(group => ({ ...group, groupRevision: this.groupRevision(group.id) })),
      page, pageSize: 10, total: groups.length, revision: snapshot.revision };
  }

  async authorize(chatId: number, title: string, actorId: number, revision: number, signal?: AbortSignal, groupRevision?: number): Promise<{ changed: boolean; revision: number; groupRevision: number }> {
    groupIdSchema.parse(chatId);
    userIdSchema.parse(actorId);
    if (!this.isAdmin(actorId)) throw new AppError('FORBIDDEN');
    const result = await this.file.update(candidate => {
      if (groupRevision !== undefined && groupRevision !== (candidate.groupRevisions?.[String(chatId)] ?? 0)) throw new AppError('CONFLICT');
      if (candidate.migrations[String(chatId)]) throw new AppError('CONFLICT');
      if (candidate.groups[String(chatId)]) return false;
      candidate.groups[String(chatId)] = { id: chatId, title: title.slice(0, 128), authorizedBy: actorId, authorizedAt: new Date().toISOString(), present: true };
      this.advance(candidate, chatId);
    }, { revision: groupRevision === undefined ? revision : undefined, signal });
    return { changed: result.changed, revision: result.snapshot.revision, groupRevision: result.snapshot.groupRevisions?.[String(chatId)] ?? 0 };
  }

  async revoke(chatId: number, actorId: number, revision: number, signal?: AbortSignal, groupRevision?: number): Promise<{ changed: boolean; revision: number; groupRevision: number }> {
    groupIdSchema.parse(chatId);
    if (!this.isAdmin(actorId)) throw new AppError('FORBIDDEN');
    const result = await this.file.update(candidate => {
      if (groupRevision !== undefined && groupRevision !== (candidate.groupRevisions?.[String(chatId)] ?? 0)) throw new AppError('CONFLICT');
      if (!candidate.groups[String(chatId)]) return false;
      delete candidate.groups[String(chatId)];
      this.advance(candidate, chatId);
    }, { revision: groupRevision === undefined ? revision : undefined, signal });
    return { changed: result.changed, revision: result.snapshot.revision, groupRevision: result.snapshot.groupRevisions?.[String(chatId)] ?? 0 };
  }

  // System entry: only the Telegram membership adapter calls this, never HTTP/tools.
  async membership(event: MembershipEvent, signal?: AbortSignal): Promise<{ kind: 'duplicate' | 'left' | 'authorized' | 'waiting' | 'unchanged'; chatId: number; changed: boolean; revision: number; groupRevision: number }> {
    groupIdSchema.parse(event.chatId);
    let kind: 'duplicate' | 'left' | 'authorized' | 'waiting' | 'unchanged' = 'unchanged';
    const result = await this.file.update(candidate => {
      const key = String(event.chatId);
      if (candidate.migrations[key] || (candidate.membership[key]?.updateId ?? -1) >= event.updateId) { kind = 'duplicate'; return false; }
      const presence = candidate.membership[key]?.present;
      const allowed = Boolean(candidate.groups[key]);
      candidate.membership[key] = { updateId: event.updateId, present: event.isMember };
      if (!event.isMember) {
        delete candidate.groups[key];
        kind = 'left';
      } else if (!event.wasMember) {
        if (candidate.groups[key]) { kind = 'unchanged'; }
        else if (!event.actorIsBot && event.actorId && this.isAdmin(event.actorId)) {
          candidate.groups[key] = { id: event.chatId, title: event.title.slice(0, 128), authorizedBy: event.actorId, authorizedAt: event.at, present: true };
          kind = 'authorized';
        } else { kind = 'waiting'; }
      }
      if (presence !== event.isMember || event.wasMember !== event.isMember || allowed !== Boolean(candidate.groups[key])) this.advance(candidate, event.chatId);
    }, { signal });
    return { kind, chatId: event.chatId, changed: result.changed, revision: result.snapshot.revision,
      groupRevision: result.snapshot.groupRevisions?.[String(event.chatId)] ?? 0 };
  }

  async migrate(oldId: number, newId: number, updateId: number, signal?: AbortSignal): Promise<boolean> {
    groupIdSchema.parse(oldId);
    groupIdSchema.parse(newId);
    if (oldId === newId) return false;
    const result = await this.file.update(candidate => {
      if (candidate.migrations[String(oldId)]) return false;
      const group = candidate.groups[String(oldId)];
      // Unknown/previously revoked groups are never resurrected by migration messages.
      if (group && !candidate.groups[String(newId)]) candidate.groups[String(newId)] = { ...group, id: newId };
      delete candidate.groups[String(oldId)];
      candidate.migrations[String(oldId)] = newId;
      candidate.membership[String(oldId)] = { updateId, present: false };
      const current = candidate.membership[String(newId)];
      if (!current || current.updateId < updateId) candidate.membership[String(newId)] = { updateId, present: true };
      this.advance(candidate, oldId);
      this.advance(candidate, newId);
    }, { signal });
    return result.changed;
  }

  private advance(candidate: z.infer<typeof accessSchema>, chatId: number): void {
    // Retain tombstones: revoke/regrant must not recreate an old approval dependency.
    const revisions = candidate.groupRevisions ??= {};
    revisions[String(chatId)] = (revisions[String(chatId)] ?? 0) + 1;
  }
}
