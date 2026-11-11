import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, mkdtemp, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { aiCredentialRefSchema, aiCredentialValueSchema, type AiCredentialState } from '../../shared/schemas/ai.js';
import { AppError } from '../errors.js';

export function parseAiMasterKey(value: string): Buffer {
  if (!/^[A-Fa-f0-9]{64}$/.test(value)) throw new AppError('STORAGE_ERROR');
  return Buffer.from(value, 'hex');
}

// Called under the application's storage lock, before SQLite can create any files.
export async function loadAiMasterKey(directory: string, explicit?: string): Promise<Buffer> {
  if (explicit !== undefined) return parseAiMasterKey(explicit);
  let temporary: string | undefined;
  let generated: Buffer | undefined;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const parent = await lstat(directory);
    if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0
      || typeof process.getuid === 'function' && parent.uid !== process.getuid()) throw new Error();
    const path = join(directory, 'ai-master.key');
    try { await lstat(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // Missing keys never authorize replacement of an existing or interrupted database.
      for (const name of ['ai.sqlite', 'ai.sqlite-wal', 'ai.sqlite-shm', 'ai.sqlite-journal']) {
        try { await lstat(join(directory, name)); throw new AppError('STORAGE_ERROR'); }
        catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ENOENT') throw failure; }
      }
      temporary = await mkdtemp(join(directory, '.ai-key-'));
      generated = randomBytes(32);
      const staged = join(temporary, 'key');
      const file = await open(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(generated); await file.sync(); } finally { await file.close(); }
      // link is an atomic no-replace publication. A racing creator's key always wins intact.
      try { await link(staged, path); }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'EEXIST') throw failure; }
      await rm(temporary, { recursive: true }); temporary = undefined;
    }
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer | undefined;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size !== 32 || (stat.mode & 0o777) !== 0o600
        || typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error();
      bytes = await file.readFile();
      if (bytes.length !== 32) throw new Error();
      const current = await lstat(path);
      if (current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev) throw new Error();
      await file.sync();
      const dir = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { await dir.sync(); } finally { await dir.close(); }
      return bytes;
    } catch (error) { bytes?.fill(0); throw error; }
    finally { await file.close(); }
  } catch { throw new AppError('STORAGE_ERROR'); }
  finally { generated?.fill(0); if (temporary) await rm(temporary, { recursive: true, force: true }); }
}

export class AiCipher {
  #key: Buffer;
  #closed = false;
  constructor(masterKey: Uint8Array) {
    if (!(masterKey instanceof Uint8Array) || masterKey.byteLength !== 32) throw new AppError('STORAGE_ERROR');
    this.#key = Buffer.from(masterKey);
  }

  seal(plaintext: string, owner: string, purpose: string): string {
    if (this.#closed) throw new AppError('STORAGE_ERROR');
    const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(['misaka-ai', 1, owner, purpose])));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return `v1.${nonce.toString('base64url')}.${ciphertext.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}`;
  }

  open(envelope: string, owner: string, purpose: string): string {
    try {
      if (this.#closed || envelope.length > 400_000 || !/^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]{22}$/.test(envelope)) throw new Error();
      const [, nonce, ciphertext, tag] = envelope.split('.');
      const decode = (value: string) => {
        const bytes = Buffer.from(value, 'base64url');
        if (bytes.toString('base64url') !== value) throw new Error();
        return bytes;
      };
      const decipher = createDecipheriv('aes-256-gcm', this.#key, decode(nonce!));
      decipher.setAAD(Buffer.from(JSON.stringify(['misaka-ai', 1, owner, purpose])));
      decipher.setAuthTag(decode(tag!));
      return Buffer.concat([decipher.update(decode(ciphertext!)), decipher.final()]).toString('utf8');
    } catch { throw new AppError('STORAGE_ERROR'); }
  }

  close(): void { this.#closed = true; this.#key.fill(0); }
}

// Only the trusted provider transport receives resolve(). No public DTO includes it.
export interface AiCredentialBackend {
  credentialGet(owner: string, ref: string): string | undefined;
  credentialPut(owner: string, ref: string, value: string): void;
  credentialDelete(owner: string, ref: string): boolean;
}
export type AiEnvironmentSecrets = Readonly<Record<string, string | (() => string | undefined)>>;
export class AiVault {
  #backend: AiCredentialBackend;
  #environment: AiEnvironmentSecrets;
  constructor(backend: AiCredentialBackend, environment: AiEnvironmentSecrets = {}) {
    this.#backend = backend;
    this.#environment = { ...environment };
  }

  private reference(ref: string): { source: 'environment' | 'vault'; name: string } {
    if (!aiCredentialRefSchema.safeParse(ref).success) throw new AppError('INVALID_INPUT');
    return { source: ref.startsWith('env:') ? 'environment' : 'vault', name: ref.slice(ref.indexOf(':') + 1) };
  }

  resolve(owner: string, ref: string): string {
    const { source, name } = this.reference(ref);
    let value: string | undefined;
    try {
      if (source === 'vault') value = this.#backend.credentialGet(owner, ref);
      else if (Object.hasOwn(this.#environment, name)) {
        const entry = this.#environment[name];
        value = typeof entry === 'function' ? entry() : entry;
      }
    } catch { throw new AppError('UNAVAILABLE'); }
    if (!value || value.length > 16_384 || /\p{Cc}/u.test(value)) throw new AppError('UNAVAILABLE');
    return value;
  }

  state(owner: string, ref: string): AiCredentialState {
    const { source } = this.reference(ref);
    try { this.resolve(owner, ref); return { ref, source, hasValue: true }; }
    catch { return { ref, source, hasValue: false }; }
  }

  replace(owner: string, ref: string, value: string): AiCredentialState {
    if (this.reference(ref).source !== 'vault' || !aiCredentialValueSchema.safeParse(value).success) throw new AppError('INVALID_INPUT');
    this.#backend.credentialPut(owner, ref, value);
    return this.state(owner, ref);
  }

  delete(owner: string, ref: string): AiCredentialState {
    if (this.reference(ref).source !== 'vault') throw new AppError('INVALID_INPUT');
    this.#backend.credentialDelete(owner, ref);
    return { ref, source: 'vault', hasValue: false };
  }
}
