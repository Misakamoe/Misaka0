import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { z } from 'zod';
import {
  aiArtifactPayloadSchema, aiConversationNewInputSchema, aiConversationSchema, aiCredentialChangeSchema, aiCredentialValueSchema,
  aiDefaults, aiJsonValueSchema, aiMemoryPutInputSchema, aiMemorySchema,
  aiPageInputSchema, aiRecordKindSchema, aiRecordPutInputSchema, aiRecordSchema, aiRunCreateInputSchema,
  aiRunSchema, aiRunUpdateInputSchema, aiSafeStatusSchema, aiScopeSchema, aiSettingsSchema,
  aiSettingsSnapshotSchema, aiTurnInputSchema, aiTurnSchema,
  type AiConversation, type AiCredentialChange, type AiMemory, type AiPage, type AiPageInput, type AiRecord,
  type AiRecordKind, type AiRun, type AiSafeStatus, type AiScope, type AiSettings, type AiSettingsSnapshot,
  type AiTurn, type AiTurnInput,
} from '../../shared/schemas/ai.js';
import { AppError } from '../errors.js';
import { AiCipher, type AiCredentialBackend } from './vault.js';
import { aiPersonalSetupSchema, type AiPersonalSetup } from '../../shared/schemas/ai-admin.js';
import type { InvocationContext } from '../actions.js';
import { aiPolicyDependencies, aiPolicyParts } from './policy.js';

const opened = new Set<string>();
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const rowSchema = z.strictObject({
  sequence: number.min(1), id: identifier, scope: z.string().min(1).max(256), kind: z.string().min(1).max(32),
  parent: z.string().max(128), revision: number, state: z.string().max(64), due_at: z.string().max(32),
  amount: number, created_at: z.iso.datetime(), updated_at: z.iso.datetime(), ciphertext: z.string().max(400_000),
});
type Row = z.infer<typeof rowSchema>;
type RowData = Omit<Row, 'sequence' | 'ciphertext'>;
const usageAmountSchema = z.strictObject({ inputTokens: number.max(1_000_000), outputTokens: number.max(1_000_000), costMicros: number.max(1_000_000_000) });
export const aiUsageReservationSchema = z.strictObject({ id: identifier, actorId: number.min(1), period: z.iso.date(),
  runId: identifier.optional(), reserved: usageAmountSchema, actual: usageAmountSchema.nullable(),
  budgetMode: z.enum(['cost', 'usage']).optional(),
  state: z.enum(['reserved', 'settled', 'unknown']),
});
export type AiUsageAmount = z.infer<typeof usageAmountSchema>;
export type AiUsageReservation = z.infer<typeof aiUsageReservationSchema>;
export interface AiStoreOptions {
  directory: string;
  masterKey: Uint8Array;
  maxStorageBytes?: number;
  now?: () => number;
}
export type AiRecordListInput = AiPageInput & { state?: string; dueBefore?: string; idPrefix?: string };
export type AiRecordCreateInput = Omit<z.input<typeof aiRecordPutInputSchema>, 'id' | 'expectedRevision'>;
export interface AiScopedRun { scope: AiScope; run: AiRun }
export interface AiScopedRecord { scope: AiScope; record: AiRecord }

function parse<T>(schema: z.ZodType<T>, value: unknown, code: 'INVALID_INPUT' | 'STORAGE_ERROR' = 'INVALID_INPUT'): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError(code);
  return result.data;
}

// Reject non-JSON values, cycles and excessive depth before stringify or recursive Zod parsing.
function serialize(value: unknown, maxBytes = 65_536): string {
  const seen = new Set<object>();
  const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
  let nodes = 0;
  let minimumBytes = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > 8192 || item.depth > 16) throw new AppError('CAPACITY');
    const v = item.value;
    if (v === null || typeof v === 'boolean' || typeof v === 'number' || typeof v === 'string') {
      if (typeof v === 'number' && !Number.isFinite(v)) throw new AppError('INVALID_INPUT');
      minimumBytes += typeof v === 'string' ? Buffer.byteLength(v) + 2 : String(v).length;
      if (minimumBytes > maxBytes) throw new AppError('CAPACITY');
      continue;
    }
    if (typeof v !== 'object' || seen.has(v) || !Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) throw new AppError('INVALID_INPUT');
    seen.add(v);
    if (Array.isArray(v) && v.length > 8192) throw new AppError('CAPACITY');
    const keys = Object.keys(v);
    if (keys.length + pending.length + nodes > 8192) throw new AppError('CAPACITY');
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(v, key)!;
      if (!('value' in descriptor) || key.length > maxBytes) throw new AppError('INVALID_INPUT');
      minimumBytes += Array.isArray(v) ? 1 : Buffer.byteLength(key) + 4;
      if (minimumBytes > maxBytes) throw new AppError('CAPACITY');
      pending.push({ value: descriptor.value, depth: item.depth + 1 });
    }
    if (Array.isArray(v) && keys.length !== v.length) throw new AppError('INVALID_INPUT');
  }
  const text = JSON.stringify(value);
  if (Buffer.byteLength(text) > maxBytes) throw new AppError('CAPACITY');
  return text;
}

function scopeKey(scope: AiScope, personal = false): string {
  const valid = parse(aiScopeSchema, scope);
  if (personal && valid.ownerId === undefined) throw new AppError('FORBIDDEN');
  return JSON.stringify([valid.botId, valid.chatId, personal ? 0 : valid.threadId ?? 0, valid.ownerId ?? 0]);
}

function storedScope(key: string): AiScope {
  try {
    const [botId, chatId, threadId, ownerId] = parse(z.tuple([number.min(1), z.number().int(), number, number]), JSON.parse(key), 'STORAGE_ERROR');
    return parse(aiScopeSchema, { botId, chatId, ...(threadId ? { threadId } : {}), ...(ownerId ? { ownerId } : {}) }, 'STORAGE_ERROR');
  } catch { throw new AppError('STORAGE_ERROR'); }
}

function artifactPayload(key: string, value: unknown, code: 'INVALID_INPUT' | 'STORAGE_ERROR' = 'INVALID_INPUT') {
  const payload = parse(aiArtifactPayloadSchema, value, code);
  if ('transport' in payload) {
    const scope = storedScope(key);
    if (scope.ownerId !== undefined && scope.ownerId !== payload.actorId) throw new AppError(code === 'STORAGE_ERROR' ? code : 'FORBIDDEN');
  }
  return payload;
}

export class AiStore implements AiCredentialBackend {
  #db: DatabaseSync;
  #cipher: AiCipher;
  #statements = new Map<string, StatementSync>();
  #closed = false;
  #databaseId = '';
  #maxStorageBytes: number;
  #path: string;
  #now: () => number;

  private constructor(path: string, options: AiStoreOptions, cipher: AiCipher) {
    this.#path = path;
    this.#now = options.now ?? Date.now;
    this.#cipher = cipher;
    this.#maxStorageBytes = parse(number.min(1_048_576).max(1_073_741_824), options.maxStorageBytes ?? aiDefaults().limits.maxStorageBytes);
    this.#db = new DatabaseSync(path, { enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false, timeout: 1000 });
  }

  static async open(options: AiStoreOptions): Promise<AiStore> {
    const cipher = new AiCipher(options.masterKey);
    const directory = resolve(options.directory);
    const path = join(directory, 'ai.sqlite');
    if (opened.has(path)) { cipher.close(); throw new AppError('STORAGE_ERROR'); }
    opened.add(path);
    let store: AiStore | undefined;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error();
      let fresh = false;
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) throw new Error();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        await file.close();
        fresh = true;
      }
      for (const suffix of ['-wal', '-shm', '-journal']) {
        try {
          const stat = await lstat(path + suffix);
          if (!stat.isFile() || stat.isSymbolicLink() || fresh) throw new Error();
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      }
      store = new AiStore(path, options, cipher);
      store.initialize(fresh);
      await chmod(path, 0o600);
      return store;
    } catch {
      store?.close();
      cipher.close();
      opened.delete(path);
      throw new AppError('STORAGE_ERROR');
    }
  }

  private initialize(fresh: boolean): void {
    this.#db.exec('PRAGMA trusted_schema=OFF; PRAGMA cache_size=-1024; PRAGMA mmap_size=0; PRAGMA temp_store=FILE; PRAGMA busy_timeout=1000;');
    if (fresh) {
      this.#databaseId = randomUUID();
      this.#db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE meta (id INTEGER PRIMARY KEY CHECK(id=1), database_id TEXT NOT NULL, key_check TEXT NOT NULL);
        CREATE TABLE settings (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, ciphertext TEXT NOT NULL);
        CREATE TABLE entries (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL, scope TEXT NOT NULL, kind TEXT NOT NULL,
          parent TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL, due_at TEXT NOT NULL, amount INTEGER NOT NULL,
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ciphertext TEXT NOT NULL, UNIQUE(scope,kind,id)
        );
        CREATE INDEX entries_scope ON entries(scope,kind,sequence);
        CREATE INDEX entries_parent ON entries(scope,kind,parent,sequence);
        CREATE INDEX entries_due ON entries(scope,kind,state,due_at,sequence);
        CREATE INDEX entries_scheduler ON entries(kind,state,due_at,sequence);
        CREATE INDEX entries_usage ON entries(kind,parent);
        PRAGMA user_version=1;`);
      try {
        this.#db.prepare('INSERT INTO meta VALUES(1,?,?)').run(this.#databaseId, this.#cipher.seal('misaka-ai-key-check', this.#databaseId, 'key-check'));
        this.#db.prepare('INSERT INTO settings VALUES(1,0,?)').run(this.#cipher.seal(serialize(aiDefaults()), this.#databaseId, 'settings:0'));
        this.#db.exec('COMMIT');
      } catch (error) { if (this.#db.isTransaction) this.#db.exec('ROLLBACK'); throw error; }
    }
    if (this.#db.prepare('PRAGMA user_version').get()?.user_version !== 1) throw new AppError('STORAGE_ERROR');
    const meta = this.#db.prepare('SELECT * FROM meta WHERE id=1').get();
    if (!meta || typeof meta.database_id !== 'string' || typeof meta.key_check !== 'string') throw new AppError('STORAGE_ERROR');
    this.#databaseId = meta.database_id;
    if (this.#cipher.open(meta.key_check, this.#databaseId, 'key-check') !== 'misaka-ai-key-check') throw new AppError('STORAGE_ERROR');
    if (this.#db.prepare('PRAGMA quick_check').get()?.quick_check !== 'ok') throw new AppError('STORAGE_ERROR');
    this.getSettings();
    // Authenticate disk rows one at a time; never materialize all histories at startup.
    for (const row of this.#db.prepare('SELECT * FROM entries ORDER BY sequence').iterate()) this.decode(parse(rowSchema, row, 'STORAGE_ERROR'));
    this.#db.exec('PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA wal_autocheckpoint=128; PRAGMA journal_size_limit=1048576;');
    this.setPageLimit(this.getSettings().settings.limits.maxStorageBytes);
  }

  private setPageLimit(bytes: number): void {
    const pageSize = this.#db.prepare('PRAGMA page_size').get()?.page_size;
    if (typeof pageSize !== 'number') throw new AppError('STORAGE_ERROR');
    this.#db.exec(`PRAGMA max_page_count=${Math.max(1, Math.floor(Math.min(bytes, this.#maxStorageBytes) / pageSize))}`);
  }

  private statement(sql: string): StatementSync {
    if (this.#closed) throw new AppError('CANCELLED');
    const cached = this.#statements.get(sql);
    if (cached) return cached;
    const statement = this.#db.prepare(sql);
    if (this.#statements.size >= 32) this.#statements.delete(this.#statements.keys().next().value!);
    this.#statements.set(sql, statement);
    return statement;
  }

  private transaction<T>(work: () => T): T {
    if (this.#closed) throw new AppError('CANCELLED');
    let committing = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      const result = work();
      committing = true;
      this.#db.exec('COMMIT');
      return result;
    } catch (error) {
      if (this.#db.isTransaction) {
        try { this.#db.exec('ROLLBACK'); } catch { this.close(); throw new AppError('OUTCOME_UNKNOWN'); }
      } else if (committing) {
        this.close();
        throw new AppError('OUTCOME_UNKNOWN');
      }
      if (error instanceof AppError) throw error;
      if ((error as { errcode?: number }).errcode === 13) throw new AppError('CAPACITY');
      throw new AppError('STORAGE_ERROR');
    }
  }

  private timestamp(): string { return new Date(this.#now()).toISOString(); }
  private purpose(row: RowData): string {
    return JSON.stringify([this.#databaseId, row.kind, row.id, row.parent, row.revision, row.state, row.due_at, row.amount, row.created_at, row.updated_at]);
  }

  private decode(row: Row): unknown {
    try {
      const value: unknown = JSON.parse(this.#cipher.open(row.ciphertext, row.scope, this.purpose(row)));
      serialize(value);
      const base = { id: row.id, sequence: row.sequence, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
      if (row.kind === 'conversation') return parse(aiConversationSchema, { ...base, ...parse(z.strictObject({ title: z.string().max(160) }), value) }, 'STORAGE_ERROR');
      if (row.kind === 'turn') return parse(aiTurnSchema, { ...base, conversationId: row.parent, ...parse(aiTurnInputSchema, value) }, 'STORAGE_ERROR');
      if (row.kind === 'memory') return parse(aiMemorySchema, { ...base, ...parse(z.strictObject({ text: z.string().min(1).max(4096) }), value) }, 'STORAGE_ERROR');
      if (row.kind === 'run') {
        const run = parse(aiRunSchema, { ...base, ...parse(aiRunCreateInputSchema.extend({ continuation: aiJsonValueSchema }), value), state: row.state }, 'STORAGE_ERROR');
        if (run.conversationId !== row.parent) throw new Error();
        return run;
      }
      if (row.kind === 'usage') {
        const usage = parse(aiUsageReservationSchema, value, 'STORAGE_ERROR');
        if (usage.id !== row.id || usage.state !== row.state || usage.period !== row.parent
          || row.amount !== (usage.actual ?? usage.reserved).costMicros) throw new Error();
        return usage;
      }
      if (row.kind === 'credential') return parse(z.strictObject({ value: z.string().min(1).max(16_384) }), value, 'STORAGE_ERROR');
      return parse(aiRecordSchema, { ...base, kind: row.kind, payload: row.kind === 'artifact' ? artifactPayload(row.scope, value, 'STORAGE_ERROR') : value, state: row.state || null, dueAt: row.due_at || null,
        ...(row.parent ? { conversationId: row.parent } : {}),
      }, 'STORAGE_ERROR');
    } catch { throw new AppError('STORAGE_ERROR'); }
  }

  private getRow(scope: string, kind: string, id: string): Row | undefined {
    parse(identifier, id);
    const row = this.statement('SELECT * FROM entries WHERE scope=? AND kind=? AND id=?').get(scope, kind, id);
    return row && parse(rowSchema, row, 'STORAGE_ERROR');
  }

  private requiredRow(scope: string, kind: string, id: string, revision?: number): Row {
    const row = this.getRow(scope, kind, id);
    if (!row) throw new AppError('NOT_FOUND');
    if (revision !== undefined && parse(number, revision) !== row.revision) throw new AppError('CONFLICT');
    return row;
  }

  private insert(scope: string, kind: string, value: unknown, fields: Partial<Pick<RowData, 'id' | 'parent' | 'state' | 'due_at' | 'amount'>> = {}): Row {
    const now = this.timestamp();
    const data: RowData = { id: randomUUID(), scope, kind, parent: '', revision: 0, state: '', due_at: '', amount: 0, created_at: now, updated_at: now, ...fields };
    const ciphertext = this.#cipher.seal(serialize(value), scope, this.purpose(data));
    const result = this.statement('INSERT INTO entries(id,scope,kind,parent,revision,state,due_at,amount,created_at,updated_at,ciphertext) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(data.id, data.scope, data.kind, data.parent, data.revision, data.state, data.due_at, data.amount, data.created_at, data.updated_at, ciphertext);
    return { ...data, sequence: Number(result.lastInsertRowid), ciphertext };
  }

  private update(row: Row, value: unknown, fields: Partial<Pick<RowData, 'state' | 'due_at' | 'amount'>> = {}): Row {
    const data = { ...row, ...fields, revision: row.revision + 1, updated_at: this.timestamp() };
    const ciphertext = this.#cipher.seal(serialize(value), row.scope, this.purpose(data));
    const result = this.statement('UPDATE entries SET revision=?,state=?,due_at=?,amount=?,updated_at=?,ciphertext=? WHERE scope=? AND kind=? AND id=? AND revision=?')
      .run(data.revision, data.state, data.due_at, data.amount, data.updated_at, ciphertext, row.scope, row.kind, row.id, row.revision);
    if (result.changes !== 1) throw new AppError('CONFLICT');
    return { ...data, ciphertext };
  }

  private list<T>(scope: string, kind: string, input: AiPageInput = {}, parent = '', state = '', dueBefore = '', idPrefix = ''): AiPage<T> {
    const { after, limit } = parse(aiPageInputSchema, input);
    const rows = this.statement(`SELECT * FROM entries WHERE scope=? AND kind=? AND sequence>?
      ${parent ? 'AND parent=?' : ''} ${state ? 'AND state=?' : ''} ${dueBefore ? "AND due_at<>'' AND due_at<=?" : ''}
      ${idPrefix ? 'AND id>=? AND id<?' : ''} ORDER BY sequence LIMIT ?`)
      .all(scope, kind, after, ...(parent ? [parent] : []), ...(state ? [state] : []), ...(dueBefore ? [dueBefore] : []), ...(idPrefix ? [idPrefix, `${idPrefix}\x7f`] : []), limit + 1);
    const more = rows.length > limit;
    const selected = rows.slice(0, limit).map(row => parse(rowSchema, row, 'STORAGE_ERROR'));
    return { items: selected.map(row => this.decode(row) as T), nextCursor: more ? selected.at(-1)!.sequence : null };
  }

  private count(scope: string, kind: string, parent = ''): number {
    return Number(this.statement("SELECT count(*) AS count FROM entries WHERE scope=? AND kind=? AND (?='' OR parent=?)").get(scope, kind, parent, parent)!.count);
  }

  getSettings(): AiSettingsSnapshot {
    const row = this.statement('SELECT revision,ciphertext FROM settings WHERE id=1').get();
    if (!row || typeof row.ciphertext !== 'string') throw new AppError('STORAGE_ERROR');
    try {
      const revision = parse(number, row.revision, 'STORAGE_ERROR');
      return parse(aiSettingsSnapshotSchema, { revision, settings: JSON.parse(this.#cipher.open(row.ciphertext, this.#databaseId, `settings:${revision}`)) }, 'STORAGE_ERROR');
    } catch { throw new AppError('STORAGE_ERROR'); }
  }

  updateSettings(settings: AiSettings, revision: number): AiSettingsSnapshot {
    serialize(settings, 262_144);
    const valid = parse(aiSettingsSchema, settings);
    parse(number, revision);
    const result = this.transaction(() => {
      const current = this.getSettings();
      if (current.revision !== revision) throw new AppError('CONFLICT');
      if (JSON.stringify(current.settings) === JSON.stringify(valid)) return current;
      this.changePolicy(current.settings, valid);
      const next = revision + 1;
      this.statement('UPDATE settings SET revision=?,ciphertext=? WHERE id=1 AND revision=?')
        .run(next, this.#cipher.seal(serialize(valid, 262_144), this.#databaseId, `settings:${next}`), revision);
      return { revision: next, settings: valid };
    });
    try { this.setPageLimit(valid.limits.maxStorageBytes); }
    catch { this.close(); throw new AppError('OUTCOME_UNKNOWN'); }
    return result;
  }

  // Durable epochs retain revocation history even if an administrator restores identical settings.
  private bumpPolicy(key: string): void {
    const id = createHash('sha256').update(key).digest('hex');
    const row = this.getRow('policy:instance', 'receipt', id);
    if (row) this.update(row, { key });
    else this.insert('policy:instance', 'receipt', { key }, { id });
  }

  private changePolicy(before: AiSettings, after: AiSettings): void {
    const old = aiPolicyParts(before); const next = aiPolicyParts(after);
    for (const key of new Set([...old.keys(), ...next.keys()])) {
      if (JSON.stringify(old.get(key)) !== JSON.stringify(next.get(key))) this.bumpPolicy(key);
    }
  }

  policyKey(context: Pick<InvocationContext, 'actorId' | 'botId' | 'chat'>, actionId = ''): string {
    const snapshot = this.getSettings();
    if (actionId.startsWith('ai.admin.')) return `admin:${snapshot.revision}`;
    const parts = aiPolicyParts(snapshot.settings);
    return createHash('sha256').update(JSON.stringify(aiPolicyDependencies(context, snapshot.settings, actionId).map(key => {
      const row = this.getRow('policy:instance', 'receipt', createHash('sha256').update(key).digest('hex'));
      if (row) this.decode(row);
      return [key, row ? row.revision + 1 : 0, parts.get(key) ?? null];
    }))).digest('hex');
  }

  personalSetup(input: AiPersonalSetup, ownerId: number): AiSettingsSnapshot {
    const valid = parse(aiPersonalSetupSchema, input);
    parse(number.min(1), ownerId);
    return this.transaction(() => {
      const current = this.getSettings();
      if (current.revision !== valid.revision) throw new AppError('CONFLICT');
      if (current.settings.deniedUserIds.includes(ownerId)) throw new AppError('FORBIDDEN');
      if (current.settings.enabled || current.settings.providers.length || current.settings.presets.length || current.settings.grants.length) throw new AppError('CONFLICT');
      const suffix = randomUUID(); const providerId = `personal-${suffix}`; const presetId = `text-${suffix}`;
      const ref = `vault:personal-${suffix}`;
      // An orphan secret is never replaced, even if a generated reference collides.
      if (this.getRow(this.credentialScope('instance'), 'credential', ref)) throw new AppError('CONFLICT');
      const settings = parse(aiSettingsSchema, { ...current.settings, enabled: true,
        providers: [{ id: providerId, enabled: true, protocol: valid.protocol, baseUrl: valid.baseUrl,
          allowedOrigins: [new URL(valid.baseUrl).origin], credentialRef: ref }],
        presets: [{ id: presetId, providerId, model: valid.model, tools: ['rate.convert', 'rate.currencies', 'weather.search', 'weather.query'],
          inputCapabilities: ['text'], outputCapabilities: ['text'], budgetMode: 'usage',
          budget: { maxInputTokens: 32768, maxOutputTokens: 8192, maxToolCalls: 4, maxDurationMs: 60000, maxCostMicros: 100000 } }],
        grants: [{ id: `owner-${suffix}`, kind: 'private', subjectId: ownerId, presetId },
          ...valid.groupIds.map((subjectId, index) => ({ id: `group-${index}-${suffix}`, kind: 'group', subjectId, presetId }))],
        limits: { ...current.settings.limits, dailyRuns: current.settings.limits.dailyRuns ?? 50 },
      });
      this.insert(this.credentialScope('instance'), 'credential', { value: valid.apiKey }, { id: ref });
      this.bumpPolicy(`credential:${ref}`); this.changePolicy(current.settings, settings);
      const revision = valid.revision + 1;
      this.statement('UPDATE settings SET revision=?,ciphertext=? WHERE id=1 AND revision=?')
        .run(revision, this.#cipher.seal(serialize(settings, 262_144), this.#databaseId, `settings:${revision}`), valid.revision);
      return { revision, settings };
    });
  }

  conversationNew(scope: AiScope, input: z.input<typeof aiConversationNewInputSchema> = {}): AiConversation {
    const key = scopeKey(scope);
    const valid = parse(aiConversationNewInputSchema, input);
    return this.transaction(() => {
      if (this.count(key, 'conversation') >= this.getSettings().settings.limits.maxConversationsPerScope) throw new AppError('CAPACITY');
      return this.decode(this.insert(key, 'conversation', valid)) as AiConversation;
    });
  }

  conversationList(scope: AiScope, input: AiPageInput = {}): AiPage<AiConversation> { return this.list(scopeKey(scope), 'conversation', input); }
  conversationGet(scope: AiScope, id: string): AiConversation | undefined {
    const row = this.getRow(scopeKey(scope), 'conversation', id);
    return row ? this.decode(row) as AiConversation : undefined;
  }

  conversationRename(scope: AiScope, id: string, title: string, revision: number): AiConversation {
    const key = scopeKey(scope);
    const valid = parse(aiConversationNewInputSchema, { title });
    return this.transaction(() => this.decode(this.update(this.requiredRow(key, 'conversation', id, revision), valid)) as AiConversation);
  }

  conversationClear(scope: AiScope, id: string, revision: number): AiConversation {
    const key = scopeKey(scope);
    return this.transaction(() => {
      const row = this.requiredRow(key, 'conversation', id, revision);
      if (this.hasPendingRun(scope, id)) throw new AppError('CONFLICT');
      const conversation = this.decode(row) as AiConversation;
      this.statement("DELETE FROM entries WHERE scope=? AND parent=? AND kind IN ('turn','summary')").run(key, id);
      return this.decode(this.update(row, { title: conversation.title })) as AiConversation;
    });
  }

  conversationDelete(scope: AiScope, id: string, revision: number): boolean {
    const key = scopeKey(scope);
    return this.transaction(() => {
      this.requiredRow(key, 'conversation', id, revision);
      if (this.hasPendingRun(scope, id)) throw new AppError('CONFLICT');
      this.statement("DELETE FROM entries WHERE scope=? AND (id=? AND kind='conversation' OR parent=? AND kind IN ('turn','run','summary'))").run(key, id, id);
      return true;
    });
  }

  hasPendingRun(scope: AiScope, conversationId: string): boolean {
    const key = scopeKey(scope);
    parse(identifier, conversationId);
    return Boolean(this.statement("SELECT 1 FROM entries WHERE scope=? AND kind='run' AND parent=? AND state IN ('queued','running','waiting-approval','unknown') LIMIT 1").get(key, conversationId));
  }

  conversationHistory(scope: AiScope, id: string, input: AiPageInput = {}): AiPage<AiTurn> {
    const key = scopeKey(scope);
    this.requiredRow(key, 'conversation', id);
    return this.list(key, 'turn', input, id);
  }

  conversationRecent(scope: AiScope, id: string, limit = 20): AiTurn[] {
    const key = scopeKey(scope);
    parse(number.min(1).max(50), limit);
    this.requiredRow(key, 'conversation', id);
    return this.statement("SELECT * FROM entries WHERE scope=? AND kind='turn' AND parent=? ORDER BY sequence DESC LIMIT ?")
      .all(key, id, limit).reverse().map(row => this.decode(parse(rowSchema, row, 'STORAGE_ERROR')) as AiTurn);
  }

  conversationExport(scope: AiScope, id: string, input: AiPageInput = {}): { conversation: AiConversation } & AiPage<AiTurn> {
    const conversation = this.conversationGet(scope, id);
    if (!conversation) throw new AppError('NOT_FOUND');
    return { conversation, ...this.conversationHistory(scope, id, input) };
  }

  turnAppend(scope: AiScope, conversationId: string, turns: AiTurnInput[]): AiTurn[] {
    const key = scopeKey(scope);
    serialize(turns, 262_144);
    const valid = parse(z.array(aiTurnInputSchema).min(1).max(16), turns);
    if (scope.ownerId !== undefined && valid.some(turn => turn.actorId !== scope.ownerId)) throw new AppError('FORBIDDEN');
    return this.transaction(() => {
      this.requiredRow(key, 'conversation', conversationId);
      if (this.count(key, 'turn', conversationId) + valid.length > this.getSettings().settings.limits.maxTurnsPerConversation) throw new AppError('CAPACITY');
      return valid.map(turn => this.decode(this.insert(key, 'turn', turn, { parent: conversationId })) as AiTurn);
    });
  }

  memoryList(scope: AiScope, input: AiPageInput = {}): AiPage<AiMemory> { return this.list(scopeKey(scope, true), 'memory', input); }
  memoryGet(scope: AiScope, id: string): AiMemory | undefined {
    const row = this.getRow(scopeKey(scope, true), 'memory', id);
    return row ? this.decode(row) as AiMemory : undefined;
  }
  memoryPut(scope: AiScope, input: z.input<typeof aiMemoryPutInputSchema>): AiMemory {
    const key = scopeKey(scope, true);
    const valid = parse(aiMemoryPutInputSchema, input);
    return this.transaction(() => {
      if (valid.id) {
        if (valid.expectedRevision === undefined) throw new AppError('CONFLICT');
        return this.decode(this.update(this.requiredRow(key, 'memory', valid.id, valid.expectedRevision), { text: valid.text })) as AiMemory;
      }
      if (valid.expectedRevision !== undefined) throw new AppError('INVALID_INPUT');
      if (this.count(key, 'memory') >= 1000) throw new AppError('CAPACITY');
      return this.decode(this.insert(key, 'memory', { text: valid.text })) as AiMemory;
    });
  }
  memoryDelete(scope: AiScope, id: string, expectedRevision?: number): boolean {
    return this.deleteRow(scopeKey(scope, true), 'memory', id, expectedRevision);
  }

  runCreate(scope: AiScope, input: z.input<typeof aiRunCreateInputSchema>): AiRun {
    const key = scopeKey(scope);
    serialize(input);
    const valid = parse(aiRunCreateInputSchema, input);
    if (scope.ownerId !== undefined && valid.actorId !== scope.ownerId) throw new AppError('FORBIDDEN');
    return this.transaction(() => {
      this.assertRunCapacity();
      this.requiredRow(key, 'conversation', valid.conversationId);
      if (this.count(key, 'run') >= 10_000) throw new AppError('CAPACITY');
      const date = this.timestamp().slice(0, 10);
      const counter = this.getRow('budget:instance', 'receipt', `runs:${date}`);
      const count = this.dailyRunCount(date) + 1;
      if (counter) this.update(counter, { count });
      else this.insert('budget:instance', 'receipt', { count }, { id: `runs:${date}` });
      return this.decode(this.insert(key, 'run', valid, { state: 'queued', parent: valid.conversationId })) as AiRun;
    });
  }
  assertRunCapacity(): void {
    const settings = this.getSettings().settings;
    const limit = settings.limits.dailyRuns ?? (settings.presets.some(preset => preset.budgetMode === 'usage') ? 50 : undefined);
    if (limit === undefined) return;
    const date = this.timestamp().slice(0, 10);
    if (this.dailyRunCount(date) >= limit) throw new AppError('CAPACITY');
  }
  private dailyRunCount(date: string): number {
    const counter = this.getRow('budget:instance', 'receipt', `runs:${date}`);
    if (counter) return parse(z.strictObject({ count: number }), (this.decode(counter) as AiRecord).payload, 'STORAGE_ERROR').count;
    return Number(this.statement("SELECT count(*) AS count FROM entries WHERE kind='run' AND created_at>=? AND created_at<?")
      .get(`${date}T00:00:00.000Z`, `${date}T24:00:00.000Z`)!.count);
  }
  runGet(scope: AiScope, id: string): AiRun | undefined {
    const row = this.getRow(scopeKey(scope), 'run', id);
    return row ? this.decode(row) as AiRun : undefined;
  }
  runUpdate(scope: AiScope, id: string, input: z.input<typeof aiRunUpdateInputSchema>): AiRun {
    const key = scopeKey(scope);
    serialize(input);
    const valid = parse(aiRunUpdateInputSchema, input);
    return this.transaction(() => {
      const row = this.requiredRow(key, 'run', id, valid.revision);
      const run = this.decode(row) as AiRun;
      const transitions: Record<AiRun['state'], readonly AiRun['state'][]> = {
        queued: ['queued', 'running', 'cancelled', 'failed'], running: ['running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'unknown'],
        'waiting-approval': ['waiting-approval', 'queued', 'cancelled', 'failed'], completed: [], failed: [], cancelled: [], unknown: ['unknown', 'cancelled'],
      };
      if (!transitions[run.state].includes(valid.state)) throw new AppError('CONFLICT');
      return this.decode(this.update(row, { conversationId: run.conversationId, actorId: run.actorId, presetId: run.presetId,
        settingsRevision: run.settingsRevision, continuation: valid.continuation }, { state: valid.state })) as AiRun;
    });
  }
  runListPending(scope: AiScope, input: AiPageInput = {}): AiPage<AiRun> {
    const key = scopeKey(scope);
    const { after, limit } = parse(aiPageInputSchema, input);
    const rows = this.statement("SELECT * FROM entries WHERE scope=? AND kind='run' AND sequence>? AND state IN ('queued','running','waiting-approval','unknown') ORDER BY sequence LIMIT ?").all(key, after, limit + 1);
    const selected = rows.slice(0, limit).map(row => parse(rowSchema, row, 'STORAGE_ERROR'));
    return { items: selected.map(row => this.decode(row) as AiRun), nextCursor: rows.length > limit ? selected.at(-1)!.sequence : null };
  }

  // Trusted lifecycle recovery only. Never register these scans as public/admin Actions.
  runScanPending(input: AiPageInput = {}): AiPage<AiScopedRun> {
    const { after, limit } = parse(aiPageInputSchema, input);
    const rows = this.statement("SELECT * FROM entries WHERE kind='run' AND sequence>? AND state IN ('queued','running','waiting-approval','unknown') ORDER BY sequence LIMIT ?")
      .all(after, limit + 1);
    const selected = rows.slice(0, limit).map(row => parse(rowSchema, row, 'STORAGE_ERROR'));
    return { items: selected.map(row => ({ scope: storedScope(row.scope), run: this.decode(row) as AiRun })),
      nextCursor: rows.length > limit ? selected.at(-1)!.sequence : null };
  }

  recordCreate(scope: AiScope, kind: AiRecordKind, id: string, input: AiRecordCreateInput): AiRecord {
    const key = scopeKey(scope);
    parse(aiRecordKindSchema, kind);
    parse(identifier, id);
    serialize(input);
    const valid = parse(aiRecordPutInputSchema.omit({ id: true, expectedRevision: true }), input);
    if (kind === 'artifact') valid.payload = artifactPayload(key, valid.payload);
    return this.transaction(() => {
      if (this.getRow(key, kind, id)) throw new AppError('CONFLICT');
      if (kind === 'summary' && !valid.conversationId) throw new AppError('INVALID_INPUT');
      if (valid.conversationId) this.requiredRow(key, 'conversation', valid.conversationId);
      if (this.count(key, kind) >= 10_000) throw new AppError('CAPACITY');
      return this.decode(this.insert(key, kind, valid.payload, { id, state: valid.state ?? '', due_at: valid.dueAt ?? '', parent: valid.conversationId ?? '' })) as AiRecord;
    });
  }

  recordPut(scope: AiScope, kind: AiRecordKind, input: z.input<typeof aiRecordPutInputSchema>): AiRecord {
    const key = scopeKey(scope);
    parse(aiRecordKindSchema, kind);
    serialize(input);
    const valid = parse(aiRecordPutInputSchema, input);
    if (kind === 'artifact') valid.payload = artifactPayload(key, valid.payload);
    return this.transaction(() => {
      if (kind === 'summary' && !valid.conversationId) throw new AppError('INVALID_INPUT');
      if (valid.conversationId) this.requiredRow(key, 'conversation', valid.conversationId);
      const fields = { state: valid.state ?? '', due_at: valid.dueAt ?? '' };
      if (valid.id) {
        if (valid.expectedRevision === undefined) throw new AppError('CONFLICT');
        const row = this.requiredRow(key, kind, valid.id, valid.expectedRevision);
        if (row.parent !== (valid.conversationId ?? '')) throw new AppError('CONFLICT');
        return this.decode(this.update(row, valid.payload, fields)) as AiRecord;
      }
      if (valid.expectedRevision !== undefined) throw new AppError('INVALID_INPUT');
      if (this.count(key, kind) >= 10_000) throw new AppError('CAPACITY');
      return this.decode(this.insert(key, kind, valid.payload, { ...fields, parent: valid.conversationId ?? '' })) as AiRecord;
    });
  }
  recordGet(scope: AiScope, kind: AiRecordKind, id: string): AiRecord | undefined {
    parse(aiRecordKindSchema, kind);
    const row = this.getRow(scopeKey(scope), kind, id);
    return row ? this.decode(row) as AiRecord : undefined;
  }
  recordList(scope: AiScope, kind: AiRecordKind, input: AiRecordListInput = {}): AiPage<AiRecord> {
    const valid = parse(aiPageInputSchema.extend({ state: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/).optional(), dueBefore: z.iso.datetime().optional(), idPrefix: identifier.optional() }), input);
    parse(aiRecordKindSchema, kind);
    return this.list(scopeKey(scope), kind, { after: valid.after, limit: valid.limit }, '', valid.state, valid.dueBefore, valid.idPrefix);
  }
  recordDelete(scope: AiScope, kind: AiRecordKind, id: string, expectedRevision?: number): boolean {
    parse(aiRecordKindSchema, kind);
    return this.deleteRow(scopeKey(scope), kind, id, expectedRevision);
  }

  // Scheduler scans return each stored audience; callers must freshly authorize it before work.
  recordScanScheduled(kind: 'automation' | 'outbox', input: AiRecordListInput = {}): AiPage<AiScopedRecord> {
    parse(z.enum(['automation', 'outbox']), kind);
    const valid = parse(aiPageInputSchema.extend({ state: z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/).optional(), dueBefore: z.iso.datetime().optional() }), input);
    const rows = this.statement(`SELECT * FROM entries WHERE kind=? AND sequence>?
      ${valid.state ? 'AND state=?' : ''} ${valid.dueBefore ? "AND due_at<>'' AND due_at<=?" : ''} ORDER BY sequence LIMIT ?`)
      .all(kind, valid.after, ...(valid.state ? [valid.state] : []), ...(valid.dueBefore ? [valid.dueBefore] : []), valid.limit + 1);
    const selected = rows.slice(0, valid.limit).map(row => parse(rowSchema, row, 'STORAGE_ERROR'));
    return { items: selected.map(row => ({ scope: storedScope(row.scope), record: this.decode(row) as AiRecord })),
      nextCursor: rows.length > valid.limit ? selected.at(-1)!.sequence : null };
  }

  recordNearestDue(kind: 'automation' | 'outbox', state: string): string | null {
    parse(z.enum(['automation', 'outbox']), kind);
    parse(z.string().regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/), state);
    const row = this.statement("SELECT due_at FROM entries WHERE kind=? AND state=? AND due_at<>'' ORDER BY due_at LIMIT 1").get(kind, state);
    return row ? parse(z.iso.datetime(), row.due_at, 'STORAGE_ERROR') : null;
  }

  private deleteRow(key: string, kind: string, id: string, revision?: number): boolean {
    return this.transaction(() => {
      const row = this.getRow(key, kind, id);
      if (!row) return false;
      if (revision !== undefined && parse(number, revision) !== row.revision) throw new AppError('CONFLICT');
      return this.statement('DELETE FROM entries WHERE scope=? AND kind=? AND id=?').run(key, kind, id).changes === 1;
    });
  }

  usageReserve(scope: AiScope, input: { id: string; actorId: number; period: string; runId?: string; amount: AiUsageAmount; limitCostMicros: number; budgetMode?: 'cost' | 'usage' }): AiUsageReservation {
    const key = scopeKey(scope);
    const valid = parse(z.strictObject({ id: identifier, actorId: number.min(1), period: z.iso.date(), runId: identifier.optional(), amount: usageAmountSchema, limitCostMicros: number.max(1_000_000_000), budgetMode: z.enum(['cost', 'usage']).optional() }), input);
    if (scope.ownerId !== undefined && valid.actorId !== scope.ownerId) throw new AppError('FORBIDDEN');
    return this.transaction(() => {
      const previous = this.getRow(key, 'usage', valid.id);
      if (previous) {
        const existing = this.decode(previous) as AiUsageReservation;
        if (existing.actorId !== valid.actorId || existing.period !== valid.period || existing.runId !== valid.runId
          || existing.budgetMode !== valid.budgetMode
          || JSON.stringify(existing.reserved) !== JSON.stringify(valid.amount)) throw new AppError('CONFLICT');
        return existing;
      }
      if (valid.runId) this.requiredRow(key, 'run', valid.runId);
      const amount = Number(this.statement("SELECT coalesce(sum(amount),0) AS amount FROM entries WHERE scope=? AND kind='usage' AND parent=?").get(key, valid.period)!.amount);
      const globalAmount = Number(this.statement("SELECT coalesce(sum(amount),0) AS amount FROM entries WHERE kind='usage' AND parent=?").get(valid.period)!.amount);
      if (valid.budgetMode !== 'usage' && (amount + valid.amount.costMicros > valid.limitCostMicros
        || globalAmount + valid.amount.costMicros > this.getSettings().settings.limits.dailyCostMicros)) throw new AppError('CAPACITY');
      const value: AiUsageReservation = { id: valid.id, actorId: valid.actorId, period: valid.period,
        ...(valid.runId ? { runId: valid.runId } : {}), ...(valid.budgetMode ? { budgetMode: valid.budgetMode } : {}), reserved: valid.amount, actual: null, state: 'reserved' };
      return this.decode(this.insert(key, 'usage', value, { id: valid.id, parent: valid.period, state: 'reserved', amount: valid.amount.costMicros })) as AiUsageReservation;
    });
  }
  usageSettle(scope: AiScope, id: string, actual: AiUsageAmount | null): AiUsageReservation {
    const key = scopeKey(scope);
    const valid = parse(usageAmountSchema.nullable(), actual);
    return this.transaction(() => {
      const row = this.requiredRow(key, 'usage', id);
      const value = this.decode(row) as AiUsageReservation;
      if (value.state === 'settled') {
        if (JSON.stringify(value.actual) !== JSON.stringify(valid)) throw new AppError('CONFLICT');
        return value;
      }
      const next: AiUsageReservation = { ...value, state: valid === null ? 'unknown' : 'settled', actual: valid };
      return this.decode(this.update(row, next, { state: next.state, amount: (valid ?? value.reserved).costMicros })) as AiUsageReservation;
    });
  }

  credentialGet(owner: string, ref: string): string | undefined {
    const row = this.getRow(this.credentialScope(owner), 'credential', this.credentialId(ref));
    return row ? (this.decode(row) as { value: string }).value : undefined;
  }

  changeCredential(owner: string, change: AiCredentialChange, revision: number): AiSettingsSnapshot {
    const key = this.credentialScope(owner);
    const valid = parse(aiCredentialChangeSchema, change);
    const id = this.credentialId(valid.ref);
    parse(number, revision);
    return this.transaction(() => {
      const current = this.getSettings();
      if (current.revision !== revision) throw new AppError('CONFLICT');
      const next = parse(number, revision + 1);
      this.bumpPolicy(`credential:${valid.ref}`);
      if (valid.operation === 'replace') {
        const row = this.getRow(key, 'credential', id);
        if (row) this.update(row, { value: valid.value });
        else this.insert(key, 'credential', { value: valid.value }, { id });
      } else {
        this.statement('DELETE FROM entries WHERE scope=? AND kind=? AND id=?').run(key, 'credential', id);
      }
      // Even identical replacements and absent deletes invalidate the previous authority.
      const result = this.statement('UPDATE settings SET revision=?,ciphertext=? WHERE id=1 AND revision=?')
        .run(next, this.#cipher.seal(serialize(current.settings, 262_144), this.#databaseId, `settings:${next}`), revision);
      if (result.changes !== 1) throw new AppError('CONFLICT');
      return { revision: next, settings: current.settings };
    });
  }

  credentialPut(owner: string, ref: string, value: string): void {
    const key = this.credentialScope(owner);
    const id = this.credentialId(ref);
    const valid = parse(aiCredentialValueSchema, value);
    this.transaction(() => {
      this.bumpPolicy(`credential:${ref}`);
      const row = this.getRow(key, 'credential', id);
      if (row) this.update(row, { value: valid });
      else this.insert(key, 'credential', { value: valid }, { id });
    });
  }
  credentialDelete(owner: string, ref: string): boolean {
    const key = this.credentialScope(owner); const id = this.credentialId(ref);
    return this.transaction(() => { this.bumpPolicy(`credential:${ref}`);
      return this.statement('DELETE FROM entries WHERE scope=? AND kind=? AND id=?').run(key, 'credential', id).changes === 1; });
  }
  private credentialScope(owner: string): string { return `credential:${parse(identifier, owner)}`; }
  private credentialId(ref: string): string { return parse(z.string().regex(/^vault:[A-Za-z][A-Za-z0-9_.-]{0,63}$/), ref); }

  safeStatus(): AiSafeStatus {
    const counts = this.statement(`SELECT
      count(CASE WHEN kind='conversation' THEN 1 END) AS conversations,
      count(CASE WHEN kind='turn' THEN 1 END) AS turns,
      count(CASE WHEN kind='memory' THEN 1 END) AS memories,
      count(CASE WHEN kind='run' AND state IN ('queued','running','waiting-approval','unknown') THEN 1 END) AS pendingRuns,
      count(CASE WHEN kind IN ('artifact','automation','outbox','summary','receipt') THEN 1 END) AS records,
      coalesce(sum(CASE WHEN kind='usage' AND state<>'settled' THEN amount ELSE 0 END),0) AS reservedCostMicros,
      coalesce(sum(CASE WHEN kind='usage' AND state='settled' THEN amount ELSE 0 END),0) AS settledCostMicros FROM entries`).get()!;
    const pages = Number(this.statement('PRAGMA page_count').get()!.page_count);
    const bytes = Number(this.statement('PRAGMA page_size').get()!.page_size);
    return parse(aiSafeStatusSchema, { available: true, schemaVersion: 1, ...counts, storageBytes: pages * bytes }, 'STORAGE_ERROR');
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#statements.clear();
    try { this.#db.close(); } finally { this.#cipher.close(); opened.delete(this.#path); }
  }
}
