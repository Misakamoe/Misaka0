import { z } from 'zod';
import { emptyInputSchema, revisionSchema, type ModuleMetadata } from '../../shared/schemas/index.js';
import {
  subconvDefaults, subconvGenerateInputSchema, subconvOptionsSchema, subconvResultSchema, subconvSettingsSchema,
  subconvSnapshotSchema, subconvSourceCount, subconvSourceSchema, type SubconvResult, type SubconvSettings, type SubconvSnapshot,
} from '../../shared/schemas/subconv.js';
import type { ActionExecutor, InvocationContext } from '../actions.js';
import { AppError, throwIfAborted } from '../errors.js';
import { JSON_DOCUMENT_MAX_BYTES, JsonDocument, type JsonStorage } from '../storage.js';

export const subconvMetadata: ModuleMetadata = { id: 'subconv', nameKey: 'web:subconv.name', descriptionKey: 'web:subconv.description', schema_version: 1, configurable: false };
const fileSchema = z.strictObject({ schema_version: z.literal(1), revision: revisionSchema,
  // Zod records omit __proto__; reject it before parsing rather than repairing saved data.
  users: z.unknown().refine(value => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && !Object.hasOwn(value, '__proto__')).pipe(
    z.record(z.string().regex(/^[1-9]\d{0,15}$/).refine(value => Number(value) <= Number.MAX_SAFE_INTEGER), subconvSnapshotSchema)
      .refine(users => Object.keys(users).length <= 10_000)),
});
const updateSchema = z.strictObject({ revision: revisionSchema, settings: subconvSettingsSchema });
const resetSchema = z.strictObject({ revision: revisionSchema });

// Exact sub-web 9bdeaeef tribool parsing, including its intentionally narrow false cases.
function backendBoolean(value: string | null): boolean | null {
  if (value === 'true' || value === '1' || value !== null && Number.parseInt(value, 10) > 1) return true;
  if (value === 'false' || value === '0') return false;
  return null;
}

export class SubconvService {
  private readonly file: JsonDocument<z.infer<typeof fileSchema>>;
  constructor(storage: JsonStorage) { this.file = new JsonDocument(storage, 'subconv.json', fileSchema); }
  async initialize(): Promise<void> { await this.file.load({ schema_version: 1, revision: 0, users: {} }); }

  private user(context: InvocationContext): string {
    if (context.source !== 'telegram' || context.chat.type !== 'private' || context.chat.id !== context.actorId
      || context.dataScope.kind !== 'user' || context.dataScope.id !== context.actorId
      || !Number.isSafeInteger(context.actorId) || context.actorId <= 0) throw new AppError('FORBIDDEN');
    throwIfAborted(context.signal);
    return String(context.actorId);
  }
  settings(context: InvocationContext): SubconvSnapshot {
    const user = this.user(context);
    return structuredClone(this.file.snapshot().users[user] ?? { revision: 0, settings: subconvDefaults() });
  }
  async update(context: InvocationContext, settings: SubconvSettings, revision: number): Promise<SubconvSnapshot> {
    const user = this.user(context);
    const parsed = updateSchema.safeParse({ revision, settings });
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['settings', 'revision']);
    const result = await this.file.update(state => {
      const current = state.users[user];
      if ((current?.revision ?? 0) !== parsed.data.revision) throw new AppError('CONFLICT');
      if (!current && Object.keys(state.users).length >= 10_000 || state.revision >= Number.MAX_SAFE_INTEGER
        || parsed.data.revision >= Number.MAX_SAFE_INTEGER) throw new AppError('CAPACITY');
      state.users[user] = { revision: parsed.data.revision + 1, settings: parsed.data.settings };
      // Match JsonDocument's pretty-printed candidate, including its next document revision.
      if (Buffer.byteLength(`${JSON.stringify({ ...state, revision: state.revision + 1 }, null, 2)}\n`) > JSON_DOCUMENT_MAX_BYTES) throw new AppError('CAPACITY');
    }, { signal: context.signal });
    return structuredClone(result.snapshot.users[user]!);
  }
  async reset(context: InvocationContext, revision: number): Promise<SubconvSnapshot> {
    const current = this.settings(context);
    return this.update(context, { ...subconvDefaults(), backend: current.settings.backend }, revision);
  }
  generate(context: InvocationContext, input: z.infer<typeof subconvGenerateInputSchema>): SubconvResult {
    const current = this.settings(context);
    const parsed = subconvGenerateInputSchema.safeParse(input);
    if (!parsed.success) throw new AppError('INVALID_INPUT', ['source', 'customParams', 'revision']);
    if (current.revision !== parsed.data.revision) throw new AppError('CONFLICT');
    if (!current.settings.backend) throw new AppError('INVALID_INPUT', ['backend']);
    const output = new URL(current.settings.backend);
    const path = output.pathname.replace(/\/+$/, '');
    output.pathname = path.endsWith('/sub') ? path : `${path}/sub`;
    const options = current.settings.options;
    const params = output.searchParams;
    params.set('target', options.target);
    if (options.target === 'surge') params.set('ver', '4');
    params.set('url', parsed.data.source.replace(/\r\n|\r|\n/g, '|'));
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
    for (const { name, value } of parsed.data.customParams) { params.set(name, value); customNames.add(name); }
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
}

export function registerSubconvActions(executor: Pick<ActionExecutor, 'register'>, service: SubconvService): void {
  const common = { permission: 'self', sources: ['telegram'], scopes: ['private'], aiVisible: false, timeoutMs: 15_000 } as const;
  executor.register({ ...common, id: 'subconv.settings.get', input: emptyInputSchema, output: subconvSnapshotSchema, effect: 'read', execute: (_input, context) => service.settings(context) });
  executor.register({ ...common, id: 'subconv.settings.set', input: updateSchema, output: subconvSnapshotSchema, effect: 'personal_write', execute: (input, context) => service.update(context, input.settings, input.revision) });
  executor.register({ ...common, id: 'subconv.settings.reset', input: resetSchema, output: subconvSnapshotSchema, effect: 'personal_write', execute: (input, context) => service.reset(context, input.revision) });
  executor.register({ ...common, id: 'subconv.generate', input: subconvGenerateInputSchema, output: subconvResultSchema, effect: 'read', execute: (input, context) => service.generate(context, input) });
}
