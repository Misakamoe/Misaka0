import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, type FileHandle } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { aiExtensionScopeSchema, aiSkillInstallSchema, type AiExtensionScope } from '../../shared/schemas/ai-extensions.js';

/** Trusted adapter values, never fields accepted from model tool arguments. */
export interface ExtensionScope { ownerId: string; audience: string }
export interface SkillFile { path: string; sha256: string }
export interface InstalledSkill {
  id: string;
  path: string;
  enabled: boolean;
  files: readonly SkillFile[];
  approvedTools: readonly string[];
  scopes: readonly ExtensionScope[];
  reviewedDigest: string;
}
export interface SkillDocument {
  name: string;
  description: string;
  license?: string;
  compatibility?: string;
  metadata: Readonly<Record<string, string>>;
  declaredTools: readonly string[];
  body: string;
}
export interface LoadedSkill extends SkillDocument {
  id: string;
  reviewedDigest: string;
  /** Catalog policy ceiling only. The Action executor still authorizes every call. */
  approvedTools: readonly string[];
}

export class ExtensionError extends Error {
  constructor(readonly code: 'INVALID_EXTENSION' | 'EXTENSION_FORBIDDEN' | 'REVIEW_REQUIRED' | 'EXTENSION_LIMIT' | 'EXTENSION_UNAVAILABLE' | 'EXTENSION_CANCELLED' | 'OUTCOME_UNKNOWN') {
    super(code);
    this.name = 'ExtensionError';
  }
}

export function assertExtensionScope(scope: ExtensionScope, approved: readonly ExtensionScope[]): void {
  if (!scope || typeof scope.ownerId !== 'string' || !scope.ownerId || scope.ownerId.length > 256
    || typeof scope.audience !== 'string' || !scope.audience || scope.audience.length > 256
    || !approved.some((item) => item.ownerId === scope.ownerId && item.audience === scope.audience)) {
    throw new ExtensionError('EXTENSION_FORBIDDEN');
  }
}

const namePattern = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const hashPattern = /^[a-f0-9]{64}$/;
const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const maxFileBytes = 64 * 1024;
const maxBundleBytes = 256 * 1024;

function relativePath(path: string): void {
  if (typeof path !== 'string' || path.length > 240 || isAbsolute(path)
    || !/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').some((part) => !part || part === '.' || part === '..')
    || path.split('/').length > 6) throw new ExtensionError('INVALID_EXTENSION');
}

/** Canonical bounded JSON also used for MCP review digests. No custom prototypes. */
export function extensionJson(value: unknown, maxBytes = maxBundleBytes): string {
  let nodes = 0;
  let bytes = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++nodes > 8192 || depth > 16) throw new ExtensionError('EXTENSION_LIMIT');
    let result: string;
    if (item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) {
      result = JSON.stringify(item);
    } else if (typeof item === 'string') {
      if (Buffer.byteLength(item) > maxBytes) throw new ExtensionError('EXTENSION_LIMIT');
      result = JSON.stringify(item);
    } else if (Array.isArray(item)) {
      if (item.length > 1024) throw new ExtensionError('EXTENSION_LIMIT');
      if (Object.getPrototypeOf(item) !== Array.prototype) throw new ExtensionError('INVALID_EXTENSION');
      const entries: string[] = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, index);
        if (!descriptor || !('value' in descriptor)) throw new ExtensionError('INVALID_EXTENSION');
        entries.push(visit(descriptor.value, depth + 1));
      }
      return `[${entries.join(',')}]`;
    } else if (typeof item === 'object' && item && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const keys = Object.keys(item).sort();
      if (keys.length > 1024) throw new ExtensionError('EXTENSION_LIMIT');
      return `{${keys.map((key) => {
        if (forbiddenKeys.has(key)) throw new ExtensionError('INVALID_EXTENSION');
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !('value' in descriptor)) throw new ExtensionError('INVALID_EXTENSION');
        return `${visit(key, depth + 1)}:${visit(descriptor.value, depth + 1)}`;
      }).join(',')}}`;
    } else throw new ExtensionError('INVALID_EXTENSION');
    bytes += Buffer.byteLength(result);
    if (bytes > maxBytes) throw new ExtensionError('EXTENSION_LIMIT');
    return result;
  };
  const result = visit(value, 0);
  if (Buffer.byteLength(result) > maxBytes) throw new ExtensionError('EXTENSION_LIMIT');
  return result;
}

export function extensionDigest(value: unknown): string {
  return createHash('sha256').update(extensionJson(value)).digest('hex');
}

export function extensionScopeKey(scope: AiExtensionScope): ExtensionScope {
  const checked = aiExtensionScopeSchema.parse(scope);
  return { ownerId: `${checked.botId}:${checked.ownerId}`, audience: extensionJson(checked.audience) };
}

async function childDirectory(parent: FileHandle, name: string, create = false): Promise<FileHandle> {
  const path = `/proc/self/fd/${parent.fd}/${name}`;
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  return open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
}

async function rootedDirectory(path: string): Promise<FileHandle> {
  if (process.platform !== 'linux') throw new ExtensionError('EXTENSION_UNAVAILABLE');
  let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of resolve(path).split('/').filter(Boolean)) {
      const next = await childDirectory(directory, part);
      await directory.close();
      directory = next;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}

async function boundedFile(directory: FileHandle, name: string, max: number): Promise<Buffer> {
  const handle = await open(`/proc/self/fd/${directory.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > max) throw new ExtensionError('EXTENSION_LIMIT');
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ExtensionError('REVIEW_REQUIRED');
    return bytes.subarray(0, count);
  } finally { await handle.close(); }
}

const installationSchema = z.strictObject({
  id: aiSkillInstallSchema.shape.id, digest: z.string().regex(hashPattern), bytes: z.number().int().min(0).max(maxBundleBytes),
  state: z.enum(['pending', 'installed']),
});
const installationIndexSchema = z.strictObject({ version: z.literal(1), entries: z.array(installationSchema).max(64) })
  .refine(index => new Set(index.entries.map(entry => entry.digest)).size === index.entries.length
    && index.entries.reduce((sum, entry) => sum + entry.bytes, 0) <= 4 * 1024 * 1024);
const installedManifestSchema = aiSkillInstallSchema.omit({ files: true }).extend({
  files: z.array(z.strictObject({ path: aiSkillInstallSchema.shape.files.element.shape.path, sha256: z.string().regex(hashPattern) })).min(1).max(16),
});

/** Explicit, bounded on-disk catalog. Failed installs reserve capacity, never reset data. */
export class SkillBundleStore {
  private root?: Promise<FileHandle>;
  private busy = false;
  private closed = false;
  private readonly tasks = new Set<Promise<unknown>>();
  constructor(private readonly dataDir: string) {}

  private directory(): Promise<FileHandle> {
    if (this.closed) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    return this.root ??= (async () => {
      const parent = await rootedDirectory(this.dataDir);
      try { return await childDirectory(parent, 'skills', true); }
      finally { await parent.close(); }
    })();
  }

  private async index(directory: FileHandle) {
    try { return installationIndexSchema.parse(JSON.parse((await boundedFile(directory, 'catalog.json', 32 * 1024)).toString('utf8'))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1 as const, entries: [] as z.infer<typeof installationSchema>[] };
      throw new ExtensionError('EXTENSION_UNAVAILABLE');
    }
  }

  private async writeIndex(directory: FileHandle, index: z.infer<typeof installationIndexSchema>): Promise<void> {
    const json = extensionJson(installationIndexSchema.parse(index), 32 * 1024);
    const temp = `/proc/self/fd/${directory.fd}/.index-${randomBytes(12).toString('hex')}`;
    const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(json); await handle.sync(); }
    finally { await handle.close(); }
    try { await rename(temp, `/proc/self/fd/${directory.fd}/catalog.json`); await directory.sync(); }
    catch { await unlink(temp).catch(() => undefined); throw new ExtensionError('OUTCOME_UNKNOWN'); }
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ExtensionError('EXTENSION_UNAVAILABLE'));
    const task = operation();
    this.tasks.add(task);
    void task.finally(() => this.tasks.delete(task)).catch(() => undefined);
    return task;
  }

  install(raw: z.input<typeof aiSkillInstallSchema>, signal: AbortSignal): Promise<ReturnType<SkillBundleStore['manifestResult']>> {
    return this.track(() => this.installBundle(raw, signal));
  }

  private async installBundle(raw: z.input<typeof aiSkillInstallSchema>, signal: AbortSignal): Promise<ReturnType<SkillBundleStore['manifestResult']>> {
    signal.throwIfAborted();
    if (this.busy) throw new ExtensionError('EXTENSION_LIMIT');
    const input = aiSkillInstallSchema.parse(raw);
    if (new Set(input.files.map(file => file.path)).size !== input.files.length) throw new ExtensionError('INVALID_EXTENSION');
    let bytes = 0;
    for (const file of input.files) {
      relativePath(file.path);
      bytes += Buffer.byteLength(file.text);
      if (file.text.includes('\0') || Buffer.byteLength(file.text) > 32 * 1024) throw new ExtensionError('EXTENSION_LIMIT');
    }
    if (bytes > 64 * 1024) throw new ExtensionError('EXTENSION_LIMIT');
    const skill = input.files.find(file => file.path === 'SKILL.md');
    if (!skill || parseSkillDocument(skill.text).name !== input.id) throw new ExtensionError('INVALID_EXTENSION');
    const manifest = { ...input, files: input.files.map(file => ({ path: file.path, sha256: createHash('sha256').update(file.text).digest('hex') })) };
    bytes += Buffer.byteLength(extensionJson(manifest, 32 * 1024));
    const entry = this.entry(manifest);
    this.busy = true;
    let directory: FileHandle | undefined;
    let lock: FileHandle | undefined;
    try {
      directory = await this.directory();
      try {
        lock = await open(`/proc/self/fd/${directory.fd}/install.lock`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      } catch (error) {
        // A crash leaves the reservation and lock for explicit repair, never auto-reset.
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ExtensionError('EXTENSION_LIMIT');
        throw error;
      }
      const index = await this.index(directory);
      const found = index.entries.find(item => item.digest === entry.reviewedDigest);
      if (found) {
        if (found.state !== 'installed') throw new ExtensionError('EXTENSION_UNAVAILABLE');
        return await this.review(input.id, entry.reviewedDigest);
      }
      signal.throwIfAborted();
      const reservation = { id: input.id, digest: entry.reviewedDigest, bytes, state: 'pending' as const };
      if (!installationIndexSchema.safeParse({ ...index, entries: [...index.entries, reservation] }).success) throw new ExtensionError('EXTENSION_LIMIT');
      index.entries.push(reservation);
      await this.writeIndex(directory, index);
      const path = `/proc/self/fd/${directory.fd}/${entry.reviewedDigest}`;
      await mkdir(path, { mode: 0o700 });
      const bundle = await childDirectory(directory, entry.reviewedDigest);
      try {
        const content = await childDirectory(bundle, input.id, true);
        try {
          for (const file of input.files) {
            signal.throwIfAborted();
            const parts = file.path.split('/');
            const parents: FileHandle[] = [];
            let parent = content;
            try {
              for (const name of parts.slice(0, -1)) { parent = await childDirectory(parent, name, true); parents.push(parent); }
              const target = await open(`/proc/self/fd/${parent.fd}/${parts.at(-1)!}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              try { await target.writeFile(file.text); await target.sync(); } finally { await target.close(); }
              await parent.sync();
            } finally { for (const parent of parents.reverse()) await parent.close(); }
          }
          await content.sync();
        } finally { await content.close(); }
        const target = await open(`/proc/self/fd/${bundle.fd}/manifest.json`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { await target.writeFile(extensionJson(manifest, 32 * 1024)); await target.sync(); } finally { await target.close(); }
        await bundle.sync();
      } finally { await bundle.close(); }
      const row = index.entries.at(-1)!;
      row.state = 'installed';
      await this.writeIndex(directory, index);
      return await this.review(input.id, entry.reviewedDigest);
    } finally {
      this.busy = false;
      if (lock && directory) {
        await lock.close();
        await unlink(`/proc/self/fd/${directory.fd}/install.lock`);
        await directory.sync();
      }
    }
  }

  private entry(manifest: z.infer<typeof installedManifestSchema>): InstalledSkill {
    const entry = { id: manifest.id, path: manifest.id, enabled: true, files: manifest.files,
      approvedTools: manifest.tools, scopes: manifest.scopes.map(extensionScopeKey), reviewedDigest: '' };
    entry.reviewedDigest = skillReviewDigest(entry);
    return entry;
  }

  private manifestResult(manifest: z.infer<typeof installedManifestSchema>, entry: InstalledSkill, skill: LoadedSkill) {
    return { trust: 'untrusted' as const, id: entry.id, digest: entry.reviewedDigest, manifest: manifest.files,
      name: skill.name, description: skill.description, body: skill.body, declaredTools: [...skill.declaredTools], tools: manifest.tools, scopes: manifest.scopes };
  }

  catalogEntry(id: string, digest: string): Promise<{ entry: InstalledSkill; scopes: AiExtensionScope[] }> {
    return this.track(() => this.readCatalogEntry(id, digest));
  }

  private async readCatalogEntry(id: string, digest: string): Promise<{ entry: InstalledSkill; scopes: AiExtensionScope[] }> {
    if (!namePattern.test(id) || !hashPattern.test(digest)) throw new ExtensionError('INVALID_EXTENSION');
    const directory = await this.directory();
    const index = await this.index(directory);
    if (!index.entries.some(item => item.id === id && item.digest === digest && item.state === 'installed')) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const bundle = await childDirectory(directory, digest);
    try {
      const manifest = installedManifestSchema.parse(JSON.parse((await boundedFile(bundle, 'manifest.json', 32 * 1024)).toString('utf8')));
      const entry = this.entry(manifest);
      if (entry.id !== id || entry.reviewedDigest !== digest) throw new ExtensionError('REVIEW_REQUIRED');
      return { entry, scopes: manifest.scopes };
    } finally { await bundle.close(); }
  }

  service(entry: InstalledSkill, catalog: () => readonly InstalledSkill[] = () => [entry]): SkillService {
    return new SkillService({ root: join(this.dataDir, 'skills', entry.reviewedDigest), catalog });
  }

  review(id: string, digest: string): Promise<ReturnType<SkillBundleStore['manifestResult']>> {
    return this.track(() => this.reviewBundle(id, digest));
  }

  private async reviewBundle(id: string, digest: string): Promise<ReturnType<SkillBundleStore['manifestResult']>> {
    const { entry, scopes } = await this.catalogEntry(id, digest);
    const skill = await this.service(entry).load(id, entry.scopes[0]!);
    return this.manifestResult({ id, tools: [...entry.approvedTools], scopes, files: [...entry.files] }, entry, skill);
  }

  async stop(): Promise<void> {
    this.closed = true;
    await Promise.allSettled([...this.tasks]);
    const directory = await this.root?.catch(() => undefined);
    if (directory) await directory.close();
  }
}

/** Publishing is a separate, human-admin Action; computing a digest grants nothing. */
export function skillReviewDigest(entry: Omit<InstalledSkill, 'reviewedDigest'>): string {
  if (!namePattern.test(entry.id) || entry.id.length > 64 || typeof entry.enabled !== 'boolean') {
    throw new ExtensionError('INVALID_EXTENSION');
  }
  relativePath(entry.path);
  if (basename(entry.path) !== entry.id || entry.files.length < 1 || entry.files.length > 32
    || entry.approvedTools.length > 64 || entry.scopes.length > 128) throw new ExtensionError('INVALID_EXTENSION');
  const paths = new Set<string>();
  for (const file of entry.files) {
    relativePath(file.path);
    if (!hashPattern.test(file.sha256) || paths.has(file.path)) throw new ExtensionError('INVALID_EXTENSION');
    paths.add(file.path);
  }
  if (!paths.has('SKILL.md') || entry.approvedTools.some((tool) => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool))) {
    throw new ExtensionError('INVALID_EXTENSION');
  }
  for (const scope of entry.scopes) assertExtensionScope(scope, [scope]);
  return extensionDigest({
    version: 1, id: entry.id, path: entry.path, enabled: entry.enabled,
    files: [...entry.files].sort((a, b) => a.path.localeCompare(b.path, 'en')),
    approvedTools: [...entry.approvedTools].sort(),
    scopes: [...entry.scopes].sort((a, b) => extensionJson(a).localeCompare(extensionJson(b), 'en')),
  });
}

function scalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch { /* Unsupported YAML escapes fail closed. */ }
    throw new ExtensionError('INVALID_EXTENSION');
  }
  if (value.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/.test(value)) throw new ExtensionError('INVALID_EXTENSION');
    return value.slice(1, -1).replaceAll("''", "'");
  }
  // A deliberately data-only YAML subset: no tags, aliases, flow maps or merges.
  if (/^[!&*[{>|%@`]/.test(value) || /:\s/.test(value)) throw new ExtensionError('INVALID_EXTENSION');
  return value.replace(/\s+#.*$/, '').trimEnd();
}

/** Parses standard Skill fields, scalar/block strings and a flat metadata map. */
export function parseSkillDocument(text: string): SkillDocument {
  if (Buffer.byteLength(text) > maxFileBytes || text.includes('\0')) throw new ExtensionError('EXTENSION_LIMIT');
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') throw new ExtensionError('INVALID_EXTENSION');
  const end = lines.indexOf('---', 1);
  if (end < 1 || end > 200 || Buffer.byteLength(lines.slice(0, end).join('\n')) > 8192) {
    throw new ExtensionError('INVALID_EXTENSION');
  }
  const fields: Record<string, string> = Object.create(null) as Record<string, string>;
  const metadata: Record<string, string> = Object.create(null) as Record<string, string>;
  const keys = new Set<string>();
  const accepted = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.startsWith('#')) continue;
    const match = /^([a-z][a-z-]*):(?: +(.*))?$/.exec(line);
    if (!match || !accepted.has(match[1]!) || keys.has(match[1]!)) throw new ExtensionError('INVALID_EXTENSION');
    const key = match[1]!;
    keys.add(key);
    const value = match[2] ?? '';
    if (key === 'metadata') {
      if (value) throw new ExtensionError('INVALID_EXTENSION');
      while (i + 1 < end && lines[i + 1]!.startsWith('  ')) {
        const item = /^ {2}([a-zA-Z0-9_.-]{1,64}): +(.*)$/.exec(lines[++i]!);
        if (!item || forbiddenKeys.has(item[1]!) || Object.hasOwn(metadata, item[1]!)) throw new ExtensionError('INVALID_EXTENSION');
        metadata[item[1]!] = scalar(item[2]!);
        if (Object.keys(metadata).length > 32) throw new ExtensionError('EXTENSION_LIMIT');
      }
    } else if (/^[|>][-+]?$/.test(value)) {
      const parts: string[] = [];
      while (i + 1 < end && (lines[i + 1]!.startsWith('  ') || !lines[i + 1]!.trim())) {
        parts.push(lines[++i]!.slice(2));
      }
      fields[key] = parts.join(value.startsWith('>') ? ' ' : '\n') + (value.endsWith('-') ? '' : '\n');
    } else fields[key] = scalar(value);
  }
  if (!fields.name || fields.name.length > 64 || !namePattern.test(fields.name)
    || !fields.description?.trim() || fields.description.length > 1024
    || (fields.compatibility !== undefined && (!fields.compatibility || fields.compatibility.length > 500))) {
    throw new ExtensionError('INVALID_EXTENSION');
  }
  const declaredTools = (fields['allowed-tools'] ?? '').split(/\s+/).filter(Boolean);
  if (declaredTools.length > 128 || declaredTools.some(tool => tool.length > 256)) throw new ExtensionError('EXTENSION_LIMIT');
  return {
    name: fields.name, description: fields.description, metadata: Object.freeze(metadata),
    ...(fields.license === undefined ? {} : { license: fields.license }),
    ...(fields.compatibility === undefined ? {} : { compatibility: fields.compatibility }),
    declaredTools: Object.freeze(declaredTools),
    body: lines.slice(end + 1).join('\n'),
  };
}

export class SkillService {
  private reading = false;
  constructor(private readonly options: { root: string; catalog: () => readonly InstalledSkill[] }) {}

  private entry(id: string, scope: ExtensionScope): InstalledSkill {
    const entries = this.options.catalog();
    if (entries.length > 128) throw new ExtensionError('EXTENSION_LIMIT');
    const matches = entries.filter((item) => item.id === id);
    if (matches.length !== 1 || !matches[0]!.enabled) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const entry = structuredClone(matches[0]!);
    assertExtensionScope(scope, entry.scopes);
    if (!hashPattern.test(entry.reviewedDigest) || skillReviewDigest(entry) !== entry.reviewedDigest) {
      throw new ExtensionError('REVIEW_REQUIRED');
    }
    return entry;
  }

  /** Metadata is parsed from reviewed bytes, not an untrusted directory scan. */
  async list(scope: ExtensionScope): Promise<Pick<LoadedSkill, 'id' | 'description' | 'reviewedDigest'>[]> {
    const catalog = this.options.catalog();
    if (catalog.length > 128) throw new ExtensionError('EXTENSION_LIMIT');
    const result: Pick<LoadedSkill, 'id' | 'description' | 'reviewedDigest'>[] = [];
    for (const item of catalog) {
      if (!item.enabled || !item.scopes.some((s) => s.ownerId === scope.ownerId && s.audience === scope.audience)) continue;
      const skill = await this.load(item.id, scope);
      result.push({ id: skill.id, description: skill.description, reviewedDigest: skill.reviewedDigest });
    }
    return result;
  }

  async load(id: string, scope: ExtensionScope): Promise<LoadedSkill> {
    const entry = this.entry(id, scope);
    const bytes = await this.readBundle(entry, 'SKILL.md');
    const document = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (document.name !== id) throw new ExtensionError('INVALID_EXTENSION');
    if (this.entry(id, scope).reviewedDigest !== entry.reviewedDigest) throw new ExtensionError('REVIEW_REQUIRED');
    return { ...document, id, reviewedDigest: entry.reviewedDigest, approvedTools: Object.freeze([...entry.approvedTools]) };
  }

  async readResource(id: string, path: string, scope: ExtensionScope): Promise<Uint8Array> {
    relativePath(path);
    const entry = this.entry(id, scope);
    if (!entry.files.some((file) => file.path === path)) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const bytes = await this.readBundle(entry, path);
    if (this.entry(id, scope).reviewedDigest !== entry.reviewedDigest) throw new ExtensionError('REVIEW_REQUIRED');
    return bytes;
  }

  private async readBundle(entry: InstalledSkill, requested: string): Promise<Uint8Array> {
    if (this.reading) throw new ExtensionError('EXTENSION_LIMIT');
    if (process.platform !== 'linux') throw new ExtensionError('EXTENSION_UNAVAILABLE');
    this.reading = true;
    const root = resolve(this.options.root);
    let total = 0;
    let result: Uint8Array | undefined;
    try {
      // Anchor each open to a held directory fd. Path lstat + open alone permits an
      // ancestor symlink swap between the check and read. Never follow such links.
      for (const file of entry.files) {
        const full = join(root, entry.path, file.path);
        const parts = full.split('/').filter(Boolean);
        let directory = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        let handle: Awaited<ReturnType<typeof open>>;
        try {
          for (const part of parts.slice(0, -1)) {
            const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            await directory.close();
            directory = next;
          }
          handle = await open(`/proc/self/fd/${directory.fd}/${parts.at(-1)!}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        } finally { await directory.close(); }
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.nlink !== 1 || before.size > maxFileBytes) throw new ExtensionError('EXTENSION_LIMIT');
          total += before.size;
          if (total > maxBundleBytes) throw new ExtensionError('EXTENSION_LIMIT');
          const buffer = Buffer.alloc(before.size + 1);
          let count = 0;
          while (count < buffer.length) {
            const read = await handle.read(buffer, count, buffer.length - count, count);
            if (!read.bytesRead) break;
            count += read.bytesRead;
          }
          const after = await handle.stat();
          if (count !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
            throw new ExtensionError('REVIEW_REQUIRED');
          }
          const bytes = buffer.subarray(0, count);
          if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new ExtensionError('REVIEW_REQUIRED');
          if (file.path === requested) result = bytes;
        } finally { await handle.close(); }
      }
    } catch (error) {
      if (error instanceof ExtensionError) throw error;
      if (error && typeof error === 'object' && 'code' in error && ['ELOOP', 'ENOTDIR'].includes(String(error.code))) {
        throw new ExtensionError('INVALID_EXTENSION');
      }
      throw new ExtensionError('EXTENSION_UNAVAILABLE');
    } finally { this.reading = false; }
    if (!result) throw new ExtensionError('INVALID_EXTENSION');
    return result;
  }
}

/** Reviewed descriptions only; exposure and permission remain registered Actions. */
export const nativeModuleSkills = Object.freeze([
  { id: 'rate', description: 'Query currency catalogs and exchange rates. Require explicit amounts/currencies; disclose source and stale data.' },
  { id: 'weather', description: 'Search locations and query weather. Personal defaults belong only to their authenticated private owner; groups must supply a location.' },
  { id: 'rss', description: 'Manage subscriptions in the authorized private/chat/actual-topic scope. Group admission does not grant RSS management. Confirm changes to ongoing delivery.' },
  { id: 'alias', description: 'Manage aliases only for configured superadmins in private. Preserve reserved names and command permissions.' },
  { id: 'sticker', description: 'Convert or deliver stickers only from trusted captured media belonging to this owner. Apply resource limits; deliver originals when conversion is unavailable.' },
  { id: 'subconv', description: 'Generate subscription links for the private owner only. Keep source credentials and generated sensitive URLs out of model history; deliver directly using safe handles.' },
].map((item) => Object.freeze(item)));
