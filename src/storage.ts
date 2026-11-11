import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { z } from 'zod';
import { AppError, throwIfAborted } from './errors.js';

export const JSON_DOCUMENT_MAX_BYTES = 8 * 1024 * 1024;

// Size admission without retaining another full pretty-printed document alongside the candidate.
export function jsonDocumentByteLength(value: unknown): number {
  if (value === undefined) throw new AppError('STORAGE_ERROR');
  function size(item: unknown, depth: number): number {
    if (item === undefined) return 4; // Undefined array slots serialize as null; object fields are omitted below.
    if (item === null || typeof item === 'string' || typeof item === 'boolean' || typeof item === 'number') return Buffer.byteLength(JSON.stringify(item));
    if (typeof item !== 'object' || depth > 64) throw new AppError('STORAGE_ERROR');
    let count = 0; let children = 0;
    if (Array.isArray(item)) {
      for (const child of item) { count++; children += size(child, depth + 1); }
    } else {
      if (Object.getPrototypeOf(item) !== Object.prototype && Object.getPrototypeOf(item) !== null) throw new AppError('STORAGE_ERROR');
      for (const [key, child] of Object.entries(item)) if (child !== undefined) {
        count++; children += Buffer.byteLength(JSON.stringify(key)) + 2 + size(child, depth + 1);
      }
    }
    return count ? 2 + count * 2 + count * (depth + 1) * 2 + depth * 2 + children : 2;
  }
  return size(value, 0) + 1;
}

export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async run<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { throwIfAborted(signal); return await work(); }
    finally { release(); }
  }

  async drain(): Promise<void> { await this.tail; }
}

export interface StorageOptions {
  beforeCommit?: (filename: string, signal?: AbortSignal) => Promise<void>;
}

function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

type Versioned = { schema_version: 1; revision: number };

export class JsonDocument<T extends Versioned> {
  private value!: T;
  private unavailable = false;

  constructor(
    private readonly owner: JsonStorage,
    readonly filename: 'access.json' | 'settings.json' | 'preferences.json' | 'aliases.json' | 'rss.json' | 'rates.json' | 'weather.json' | 'subconv.json',
    private readonly schema: z.ZodType<T>,
  ) {}

  async load(initial: T): Promise<void> {
    await this.owner.lock.run(async () => {
      const path = join(this.owner.directory, this.filename);
      try {
        const stat = await lstat(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > JSON_DOCUMENT_MAX_BYTES) throw new AppError('STORAGE_ERROR');
        const parsed = this.schema.safeParse(JSON.parse(await readFile(path, 'utf8')));
        if (!parsed.success) throw new AppError('STORAGE_ERROR');
        await chmod(path, 0o600);
        this.value = freeze(parsed.data);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('STORAGE_ERROR');
        const data = this.schema.parse(initial);
        await this.write(data);
        this.value = freeze(data);
      }
    });
  }

  snapshot(): T {
    if (this.unavailable || !this.value) throw new AppError('STORAGE_ERROR');
    return this.value;
  }

  async update(
    mutate: (candidate: T) => boolean | void | Promise<boolean | void>,
    options: { revision?: number; signal?: AbortSignal; preflight?: (current: Readonly<T>) => boolean; sizeError?: 'CAPACITY' | 'STORAGE_ERROR' } = {},
  ): Promise<{ snapshot: T; changed: boolean }> {
    return this.owner.lock.run(async () => {
      this.owner.assertOpen();
      const current = this.snapshot();
      if (options.revision !== undefined && options.revision !== current.revision) throw new AppError('CONFLICT');
      // The frozen snapshot and revision are checked under the same lock as mutation.
      if (options.preflight?.(current) === false) {
        throwIfAborted(options.signal);
        return { snapshot: current, changed: false };
      }
      const candidate = structuredClone(current);
      const requested = await mutate(candidate);
      throwIfAborted(options.signal);
      if (requested === false || isDeepStrictEqual(candidate, current)) return { snapshot: current, changed: false };
      candidate.schema_version = 1;
      candidate.revision = current.revision + 1;
      const parsed = this.schema.safeParse(candidate);
      if (!parsed.success) throw new AppError('INVALID_INPUT');
      await this.write(parsed.data, options.signal, options.sizeError);
      this.value = freeze(parsed.data);
      return { snapshot: this.value, changed: true };
    }, options.signal);
  }

  private async write(candidate: T, signal?: AbortSignal, sizeError: 'CAPACITY' | 'STORAGE_ERROR' = 'STORAGE_ERROR'): Promise<void> {
    const path = join(this.owner.directory, this.filename);
    const temporary = join(this.owner.directory, `.${this.filename}.${randomUUID()}.tmp`);
    let committed = false;
    try {
      throwIfAborted(signal);
      const serialized = `${JSON.stringify(candidate, null, 2)}\n`;
      if (Buffer.byteLength(serialized) > JSON_DOCUMENT_MAX_BYTES) throw new AppError(sizeError);
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try {
        await handle.writeFile(serialized, { encoding: 'utf8', signal });
        await handle.sync();
      } finally { await handle.close(); }
      await this.owner.options.beforeCommit?.(this.filename, signal);
      throwIfAborted(signal);
      await rename(temporary, path);
      committed = true;
      // After rename, finish the durability barrier even if the caller cancels.
      const directory = await open(this.owner.directory, constants.O_RDONLY);
      try { await directory.sync(); }
      finally { await directory.close(); }
    } catch (error) {
      if (committed) {
        // A failed durability barrier cannot safely be called a rollback.
        this.unavailable = true;
        throw new AppError('OUTCOME_UNKNOWN');
      }
      if (signal?.aborted || error instanceof AppError && error.code === 'CANCELLED') throw new AppError('CANCELLED');
      if (error instanceof AppError && error.code === sizeError) throw error;
      throw new AppError('STORAGE_ERROR');
    } finally {
      if (!committed) await unlink(temporary).catch(() => undefined);
    }
  }
}

export class JsonStorage {
  readonly lock = new AsyncMutex();
  private closed = false;

  constructor(readonly directory: string, readonly options: StorageOptions = {}) {}

  async initialize(): Promise<void> {
    try {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const stat = await lstat(this.directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error();
      await chmod(this.directory, 0o700);
    } catch { throw new AppError('STORAGE_ERROR'); }
  }

  assertOpen(): void { if (this.closed) throw new AppError('CANCELLED'); }
  async close(): Promise<void> { this.closed = true; await this.lock.drain(); }
}
