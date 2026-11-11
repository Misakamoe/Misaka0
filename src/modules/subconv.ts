import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { revisionSchema } from '../../shared/schemas/index.js';
import {
  subconvDefaults, subconvGenerateInputSchema, subconvOptionsSchema, subconvResultSchema,
  subconvSnapshotSchema, subconvSourceCount, subconvSourceSchema, type SubconvResult, type SubconvSettings, type SubconvSnapshot,
} from '../../shared/schemas/subconv.js';
import { subconvGenerateOwnedSchema, subconvOptionsUpdateSchema, type SubconvGenerateOwned, type SubconvOptionsUpdate,
  type SubconvOwnedReceipt, type SubconvSources } from '../../shared/schemas/ai-native.js';
import type { InvocationContext } from '../actions.js';
import { subconvUpdateSchema } from './subconv-schema.js';
import { AppError, throwIfAborted } from '../errors.js';
import { JsonDocument, type JsonStorage } from '../storage.js';

export { subconvMetadata } from './metadata.js';
export { registerSubconvActions } from './module-actions.js';
const fileSchema = z.strictObject({ schema_version: z.literal(1), revision: revisionSchema,
  // Zod records omit __proto__; reject it before parsing rather than repairing saved data.
  users: z.unknown().refine(value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && !Object.hasOwn(value, '__proto__')).pipe(
    z.record(z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number(value) <= Number.MAX_SAFE_INTEGER), subconvSnapshotSchema)
      .refine(users => Object.keys(users).length <= 10_000)),
});

// Exact sub-web 9bdeaeef tribool parsing, including its intentionally narrow false cases.
function backendBoolean(value: string | null): boolean | null {
  if (value === 'true' || value === '1' || value !== null && Number.parseInt(value, 10) > 1) return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

export type SubconvNativeDelivery = (context: InvocationContext, file: { bytes: Uint8Array; name: string; mimeType: string }) => Promise<void>;
type GenerateInput = z.infer<typeof subconvGenerateInputSchema>;
interface OwnedSource {
  owner: string; scope: string; source: string; customParams: GenerateInput['customParams']; sourceCount: number; expires: number; bytes: number;
}
const SOURCE_TTL = 600_000;
const SOURCE_BYTES = 1024 * 1024;

export class SubconvService {
  private readonly file: JsonDocument<z.infer<typeof fileSchema>>;
  readonly #sources = new Map<string, OwnedSource>();
  #sourceBytes = 0;
  private expiryTimer?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly now: () => number;
  constructor(storage: JsonStorage, options: { now?: () => number } = {}) {
    this.file = new JsonDocument(storage, 'subconv.json', fileSchema);
    this.now = options.now ?? Date.now;
  }
  async initialize(): Promise<void> { await this.file.load({ schema_version: 1, revision: 0, users: {} }); }

  private user(context: InvocationContext, ai = false): string {
    if ((context.source !== 'telegram' && !(ai && context.source === 'ai' && context.aiRunId)) || context.chat.type !== 'private' || context.chat.id !== context.actorId
      || context.dataScope.kind !== 'user' || context.dataScope.id !== context.actorId
      || !Number.isSafeInteger(context.actorId) || context.actorId <= 0) throw new AppError('FORBIDDEN');
    throwIfAborted(context.signal);
    if (this.closed) throw new AppError('CANCELLED');
    return String(context.actorId);
  }
  settings(context: InvocationContext): SubconvSnapshot {
    const user = this.user(context, true);
    return structuredClone(this.file.snapshot().users[user] ?? { revision: 0, settings: subconvDefaults() });
  }
  async update(context: InvocationContext, settings: SubconvSettings, revision: number): Promise<SubconvSnapshot> {
    const user = this.user(context);
    const parsed = subconvUpdateSchema.safeParse({ revision, settings });
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['settings', 'revision']);
    return this.commit(user, parsed.data.revision, () => parsed.data.settings, context.signal);
  }
  private async commit(user: string, revision: number, change: (current: SubconvSettings) => SubconvSettings, signal: AbortSignal): Promise<SubconvSnapshot> {
    const result = await this.file.update(state => {
      const current = state.users[user];
      if ((current?.revision ?? 0) !== revision) throw new AppError('CONFLICT');
      if (!current && Object.keys(state.users).length >= 10_000 || state.revision >= Number.MAX_SAFE_INTEGER
        || revision >= Number.MAX_SAFE_INTEGER) throw new AppError('CAPACITY');
      state.users[user] = { revision: revision + 1, settings: change(current?.settings ?? subconvDefaults()) };
    }, { signal, sizeError: 'CAPACITY' });
    return structuredClone(result.snapshot.users[user]!);
  }
  updateOptions(context: InvocationContext, input: SubconvOptionsUpdate): Promise<SubconvSnapshot> {
    const user = this.user(context, true);
    const parsed = subconvOptionsUpdateSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['options', 'revision']);
    return this.commit(user, parsed.data.revision, settings => ({ ...settings, options: { ...settings.options, ...parsed.data.options } }), context.signal);
  }
  async reset(context: InvocationContext, revision: number): Promise<SubconvSnapshot> {
    const current = this.settings(context);
    return this.update(context, { ...subconvDefaults(), backend: current.settings.backend }, revision);
  }
  generate(context: InvocationContext, input: z.infer<typeof subconvGenerateInputSchema>): SubconvResult {
    this.user(context);
    const current = this.settings(context);
    const parsed = subconvGenerateInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['source', 'customParams', 'revision']);
    const result = this.build(current, parsed.data);
    this.remember(context, parsed.data, result.sourceCount);
    return result;
  }
  private build(current: SubconvSnapshot, input: GenerateInput): SubconvResult {
    if (current.revision !== input.revision) throw new AppError('CONFLICT');
    if (!current.settings.backend) throw new AppError('INVALID_INPUT', ['backend']);
    const output = new URL(current.settings.backend);
    const path = output.pathname.replace(/\/+$/, '');
    output.pathname = path.endsWith('/sub') ? path : `${path}/sub`;
    const options = current.settings.options;
    const params = output.searchParams;
    params.set('target', options.target);
    if (options.target === 'surge') params.set('ver', '4');
    params.set('url', input.source.replace(/\r\n|\r|\n/g, '|'));
    params.set('insert', String(options.insert));
    for (const [field, name] of [['remoteConfig', 'config'], ['exclude', 'exclude'], ['include', 'include'], ['filename', 'filename']] as const) {
      if (options[field]) params.set(name, options[field]);
    }
    if (options.appendType) params.set('append_type', 'true');
    for (const [field, name] of [['emoji', 'emoji'], ['nodeList', 'list'], ['scv', 'scv'], ['expand', 'expand'], ['sort', 'sort']] as const) params.set(name, String(options[field]));
    for (const field of ['udp', 'tfo'] as const) if (options[field] !== null) params.set(field, String(options[field]));
    if (options.surgeDoh) params.set('surge.doh', 'true');
    if (options.target === 'clash') {
      if (options.clashDoh) params.set('clash.doh', 'true');
      params.set('new_name', String(options.newName));
    }
    const customNames = new Set<string>();
    for (const { name, value } of input.customParams) { params.set(name, value); customNames.add(name); }
    for (const name of ['list', 'sort']) if (params.get(name) === 'false' && !customNames.has(name)) params.delete(name);
    if (options.target === 'clash' && params.get('target') === 'clash' && backendBoolean(params.get('expand')) === false
      && params.get('new_name') === 'true' && !customNames.has('new_name')) params.delete('new_name');
    const source = params.get('url')!;
    if (!subconvSourceSchema.safeParse(source).success) throw new AppError('INVALID_INPUT', ['source']);
    if (params.getAll('config').some(value => !subconvOptionsSchema.shape.remoteConfig.safeParse(value).success)) throw new AppError('INVALID_INPUT', ['remoteConfig']);
    const url = output.toString();
    if (url.length > 24_576) throw new AppError('INVALID_INPUT', ['url']);
    const result = subconvResultSchema.safeParse({ url, sourceCount: subconvSourceCount(source), target: params.get('target')!,
      backendHost: output.host, skipsCertVerification: backendBoolean(params.get('scv')) });
    if (!result.success) throw new AppError('INVALID_OUTPUT');
    return result.data;
  }

  listSources(context: InvocationContext): SubconvSources {
    this.user(context, true);
    this.pruneSources();
    const scope = this.scope(context);
    return { items: [...this.#sources.entries()].filter(([, source]) => source.scope === scope).slice(-8).reverse()
      .map(([sourceRef, source]) => ({ sourceRef, sourceCount: source.sourceCount, expiresAt: new Date(source.expires).toISOString() })) };
  }

  async generateOwned(context: InvocationContext, input: SubconvGenerateOwned, deliver?: SubconvNativeDelivery): Promise<SubconvOwnedReceipt> {
    this.user(context, true);
    const parsed = subconvGenerateOwnedSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['sourceRef', 'revision']);
    this.pruneSources();
    const source = this.#sources.get(parsed.data.sourceRef);
    if (!source || source.scope !== this.scope(context)) throw new AppError('NOT_FOUND');
    if (!deliver) throw new AppError('UNAVAILABLE');
    const result = this.build(this.settings(context), { revision: parsed.data.revision, source: source.source, customParams: source.customParams });
    throwIfAborted(context.signal);
    try {
      await deliver(context, { bytes: Buffer.from(`${result.url}\n`, 'utf8'), name: 'subscription.txt', mimeType: 'text/plain' });
      if (this.closed || context.signal.aborted) throw new AppError('OUTCOME_UNKNOWN');
    } catch (error) {
      // Delivery may already have succeeded. Never expose a transport error containing the private URL.
      throw new AppError(error instanceof AppError && ['FORBIDDEN', 'NOT_FOUND', 'INVALID_INPUT', 'CAPACITY', 'UNAVAILABLE'].includes(error.code)
        ? error.code : 'OUTCOME_UNKNOWN');
    }
    return { delivered: true, sourceCount: result.sourceCount };
  }

  stop(): void {
    this.closed = true;
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    this.#sources.clear(); this.#sourceBytes = 0;
  }
  private scope(context: InvocationContext): string { return `${context.botId}:${context.actorId}:${context.chat.id}:${context.chat.threadId ?? 0}`; }
  private remember(context: InvocationContext, input: GenerateInput, sourceCount: number): void {
    this.pruneSources();
    const scope = this.scope(context); const owner = `${context.botId}:${context.actorId}`;
    for (const source of this.#sources.values()) if (source.scope === scope && source.source === input.source
      && source.customParams.length === input.customParams.length && source.customParams.every((param, i) => param.name === input.customParams[i]!.name && param.value === input.customParams[i]!.value)) return;
    const bytes = 512 + 2 * (scope.length + owner.length + input.source.length)
      + input.customParams.reduce((sum, param) => sum + 96 + 2 * (param.name.length + param.value.length), 0);
    // Source retention is optional: pressure must not break the existing human one-shot generator.
    if (this.#sources.size >= 128 || this.#sourceBytes + bytes > SOURCE_BYTES
      || [...this.#sources.values()].filter(source => source.owner === owner).length >= 8) return;
    let reference: string;
    do { reference = randomBytes(12).toString('hex'); } while (this.#sources.has(reference));
    this.#sources.set(reference, { owner, scope, source: input.source, customParams: input.customParams, sourceCount, expires: this.now() + SOURCE_TTL, bytes });
    this.#sourceBytes += bytes;
    this.pruneSources();
  }
  private pruneSources(): void {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = undefined;
    let next = Infinity;
    for (const [reference, source] of this.#sources) {
      if (source.expires <= this.now()) { this.#sources.delete(reference); this.#sourceBytes -= source.bytes; }
      else next = Math.min(next, source.expires);
    }
    if (Number.isFinite(next)) {
      this.expiryTimer = setTimeout(() => this.pruneSources(), Math.max(1, next - this.now()));
      this.expiryTimer.unref();
    }
  }
}
