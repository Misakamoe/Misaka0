import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, mkdtemp, open, readdir, rm, rmdir, statfs, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import type { SandboxFile, SandboxLimits, SandboxRequest, SandboxResult } from './sandbox.js';

// SHA-256(C source || NUL || fixed smoke source), pinned in reviewed application
// code, also embedded by the build in the static supervisor. No caller attestation.
export const LOCAL_SANDBOX_POLICY_SHA256 = '6234f470c05593300d3ad4b412ec14f1ea395f3c57c9c909c4c1ac6b4ea96a24';
// The build replaces ONLY this literal in trusted dist/src/ai/local-sandbox.js.
// Direct TypeScript execution cannot attest a compiler output and fails closed.
export const LOCAL_SANDBOX_BUILD_IDENTITY: string = 'UNBUILT';
const ceilings: Readonly<SandboxLimits> = Object.freeze({ memoryBytes: 67_108_864, cpuMs: 5000,
  pids: 16, outputBytes: 65_536, tempBytes: 4_194_304, wallMs: 15_000 });
const modulePath = fileURLToPath(import.meta.url);
const bundle = resolve(dirname(modulePath), modulePath.endsWith('.ts') ? '../../dist/sandbox' : '../../sandbox');
const artifactPath = /^(?:usr\/bin\/node|usr\/lib\/misaka\/smoke\.mjs|(?:usr\/)?lib(?:64|\/x86_64-linux-gnu)?\/[A-Za-z0-9_.+-]+\.so(?:\.[A-Za-z0-9_.+-]+)?)$/;
let leased = false;
let poisoned = false;

export interface LocalSandboxQualification {
  localEnabled: boolean;
  qualified: boolean;
  namespaces: 'passed' | 'failed' | 'not-tested';
  cgroup: 'passed' | 'failed' | 'not-tested';
  seccomp: 'passed' | 'unqualified';
  policyHash: string;
  reasons: { code: string; detail: string }[];
}
export class LocalSandboxError extends Error {
  constructor(readonly code: 'LOCAL_UNAVAILABLE' | 'LOCAL_INVALID' | 'LOCAL_LIMIT' | 'LOCAL_CANCELLED' | 'LOCAL_OUTCOME_UNKNOWN', readonly reason: string, options?: ErrorOptions) {
    super(`${code}: ${reason}`, options); this.name = 'LocalSandboxError';
  }
}
function prioritizeFailure(previous: unknown, next: unknown): unknown {
  if (!(next instanceof LocalSandboxError) || next.code !== 'LOCAL_OUTCOME_UNKNOWN'
    || (previous instanceof LocalSandboxError && previous.code === 'LOCAL_OUTCOME_UNKNOWN')) return previous;
  // Keep only known internal classifications as a cause, never callback errors,
  // peer text, stacks or an arbitrary message that may contain private data.
  if (previous instanceof LocalSandboxError && ['LOCAL_INVALID', 'LOCAL_LIMIT', 'LOCAL_CANCELLED'].includes(previous.code)
    && /^(?:INVALID_NDJSON|UNEXPECTED_STDIO_MESSAGE|TRUNCATED_NDJSON|STDIO_REQUEST_UNSETTLED|STDIO_OUTPUT_LIMIT|STDIO_INPUT_LIMIT|STDIO_CLOSED|STDIO_REQUEST_IN_FLIGHT|ABORTED|STDIO_JOB_ENDED|STDIO_TEARDOWN_FAILED|INVALID_NDJSON_REQUEST|NDJSON_REQUEST_LIMIT|OUTPUT_LIMIT|SUPERVISOR_DEADLINE)$/.test(previous.reason)) {
    return new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', next.reason, {
      cause: Object.freeze({ code: previous.code, reason: previous.reason }),
    });
  }
  return next;
}
export interface LocalStdioPort {
  /** One outstanding NDJSON request; total session input/output remains bounded. */
  request(message: unknown): Promise<unknown>;
  /** NDJSON notification with no response. */
  notify(message: unknown): Promise<void>;
  readonly signal: AbortSignal;
}
interface Manifest {
  version: number; platform: string; arch: string; available: boolean; reason: string; policyHash: string;
  binarySha256: string; files: { path: string; sha256: string; bytes: number; mode: number }[];
}
interface Artifacts { binary: FileHandle; root: FileHandle; close(): Promise<void> }
function errno(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'UNAVAILABLE';
}
function invalid(reason: string): never { throw new LocalSandboxError('LOCAL_INVALID', reason); }
function relativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && path.length <= 240 && /^[A-Za-z0-9_./-]+$/.test(path)
    && path.split('/').length <= 6 && !path.split('/').some((part) => !part || part === '.' || part === '..');
}
function bytes(file: SandboxFile): Buffer {
  if (!file || Object.keys(file).sort().join(',') !== 'contentBase64,path' || !relativePath(file.path)
    || typeof file.contentBase64 !== 'string' || file.contentBase64.length > 90_000
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(file.contentBase64)) invalid('INVALID_INPUT_FILE');
  const data = Buffer.from(file.contentBase64, 'base64');
  if (data.toString('base64') !== file.contentBase64) invalid('INVALID_INPUT_FILE');
  return data;
}
function validate(request: SandboxRequest, ownedInputs: readonly SandboxFile[]): { request: SandboxRequest; files: { path: string; data: Buffer }[] } {
  if (!request || Object.keys(request).sort().join(',') !== 'args,entrypoint,files,limits,network,runtime'
    || request.runtime !== 'node' || request.network !== 'deny' || !relativePath(request.entrypoint)
    || !Array.isArray(request.args) || request.args.length > 32 || request.args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))
    || !Array.isArray(request.files) || !Array.isArray(ownedInputs) || request.files.length + ownedInputs.length > 16) invalid('INVALID_REQUEST');
  if (!request.limits || Object.keys(request.limits).sort().join(',') !== Object.keys(ceilings).sort().join(',')) invalid('INVALID_LIMITS');
  for (const key of Object.keys(ceilings) as (keyof SandboxLimits)[]) {
    if (!Number.isSafeInteger(request.limits[key]) || request.limits[key] < 1 || request.limits[key] > ceilings[key]) invalid('INVALID_LIMITS');
  }
  if (request.limits.tempBytes % 4096 !== 0) invalid('TMPFS_PAGE_ALIGNED_LIMIT_REQUIRED');
  const names = new Set<string>(); let total = 0;
  const files = [...request.files, ...ownedInputs].map((file) => {
    const data = bytes(file);
    if (names.has(file.path)) invalid('DUPLICATE_INPUT');
    names.add(file.path); total += data.length;
    return { path: file.path, data };
  });
  for (const path of names) {
    const parts = path.split('/'); parts.pop();
    while (parts.length) { if (names.has(parts.join('/'))) invalid('INPUT_PATH_COLLISION'); parts.pop(); }
  }
  if (!names.has(request.entrypoint) || total > Math.min(request.limits.tempBytes, 65_536)) invalid('INPUT_LIMIT');
  return { request: structuredClone(request), files };
}

// Directory descriptors pin each ancestor. O_NOFOLLOW applies to EVERY path
// component, including build roots and prepared inputs, not just the last name.
async function directory(path: string): Promise<FileHandle> {
  if (!path.startsWith('/')) invalid('ABSOLUTE_INTERNAL_PATH_REQUIRED');
  let fd = await open('/', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    for (const part of path.split('/').filter(Boolean)) {
      if (part === '.' || part === '..') invalid('UNSAFE_INTERNAL_PATH');
      const next = await open(`/proc/self/fd/${fd.fd}/${part}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      await fd.close(); fd = next;
    }
    return fd;
  } catch (error) { await fd.close(); throw error; }
}
async function boundedRead(fd: FileHandle, max: number): Promise<Buffer> {
  const buffer = Buffer.alloc(max + 1); let length = 0;
  for (;;) {
    const read = await fd.read(buffer, length, buffer.length - length, null);
    length += read.bytesRead;
    if (length > max) throw new LocalSandboxError('LOCAL_UNAVAILABLE', 'FILE_LIMIT');
    if (!read.bytesRead) return buffer.subarray(0, length);
  }
}
async function readAt(fd: FileHandle, name: string, max = 4096): Promise<string> {
  const file = await open(`/proc/self/fd/${fd.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return (await boundedRead(file, max)).toString('utf8'); } finally { await file.close(); }
}
async function writeAt(fd: FileHandle, name: string, text: string): Promise<void> {
  const file = await open(`/proc/self/fd/${fd.fd}/${name}`, constants.O_WRONLY | constants.O_NOFOLLOW);
  try { await file.writeFile(text); } finally { await file.close(); }
}
async function cgroupGate(): Promise<void> {
  if ((await statfs('/sys/fs/cgroup')).type !== 0x63677270) throw new Error('CGROUP_V2_REQUIRED');
  const proc = await open('/proc/self/cgroup', constants.O_RDONLY | constants.O_NOFOLLOW);
  let membership: string;
  try { membership = (await boundedRead(proc, 4096)).toString('utf8'); } finally { await proc.close(); }
  const match = /^0::(\/[^\n]*)\n?$/.exec(membership);
  if (!match || match[1]!.split('/').some((part) => part === '..' || part === '.') || [...match[1]!].some((c) => c.charCodeAt(0) < 32 || c === '\\')) throw new Error('CGROUP_MEMBERSHIP_INVALID');
  const parent = await directory(`/sys/fs/cgroup${match[1] === '/' ? '' : match[1]}`);
  const name = `misaka-preflight-${randomBytes(12).toString('hex')}`;
  const path = `/proc/self/fd/${parent.fd}/${name}`; let created = false;
  try {
    // The mkdir is deliberate even when controllers are absent: report the real
    // delegation denial, and never move a host process or enable parent controls.
    await mkdir(path, { mode: 0o700 }); created = true;
    const child = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      const values = { 'memory.max': '67108864', 'memory.swap.max': '0', 'memory.oom.group': '1', 'pids.max': '16', 'cpu.max': '10000 100000' };
      for (const [key, value] of Object.entries(values)) {
        await writeAt(child, key, value);
        if ((await readAt(child, key)).trim() !== value) throw new Error('CGROUP_LIMIT_READBACK_FAILED');
      }
      await access(`${path}/cgroup.kill`, constants.W_OK);
      if ((await readAt(child, 'cgroup.procs')).trim()) throw new Error('CGROUP_PREFLIGHT_NOT_EMPTY');
      await writeAt(child, 'cgroup.kill', '1');
      if (!(await readAt(child, 'cgroup.events')).split('\n').includes('populated 0')) throw new Error('CGROUP_DRAIN_UNVERIFIED');
    } finally { await child.close(); }
  } finally { try { if (created) await rmdir(path); } finally { await parent.close(); } }
}
async function trusted(fd: FileHandle, max: number): Promise<void> {
  const info = await fd.stat();
  assertLocalSandboxOwnership(info);
  if (!info.isFile() || info.nlink !== 1 || info.size > max || (info.mode & 0o6000)) throw new Error('UNSAFE_BUNDLE_FILE');
}
/** Metadata check only, not qualification. Runtime callers use fstat on owned
 * descriptors. Root ownership prevents application-UID chmod/rewrite AFTER a
 * hash check; an open descriptor by itself does not prevent inode mutation. */
export function assertLocalSandboxOwnership(info: { uid: number; mode: number }): void {
  if (info.uid !== 0 || !Number.isInteger(info.mode) || (info.mode & 0o022)) throw new Error('IMMUTABLE_SANDBOX_INSTALLATION_REQUIRED');
}
async function hash(fd: FileHandle): Promise<string> {
  const digest = createHash('sha256'), buffer = Buffer.alloc(65_536); let position = 0;
  for (;;) {
    const { bytesRead } = await fd.read(buffer, 0, buffer.length, position);
    if (!bytesRead) return digest.digest('hex');
    digest.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    if (position > 160 * 1024 * 1024) throw new Error('BUNDLE_FILE_TOO_LARGE');
  }
}
/** Data validation only; this function never launches a process or qualifies a runner. */
export function validateLocalSupervisorElf(bytes: Buffer): void {
  if (bytes.length < 64 || bytes.toString('hex', 0, 7) !== '7f454c46020101' || bytes.readUInt16LE(16) !== 2
    || bytes.readUInt16LE(18) !== 62 || bytes.readUInt32LE(20) !== 1) throw new Error('STATIC_SUPERVISOR_REQUIRED');
  const offset = Number(bytes.readBigUInt64LE(32)), count = bytes.readUInt16LE(56), size = bytes.readUInt16LE(54);
  const entry = bytes.readBigUInt64LE(24); let executableEntry = false;
  if (!Number.isSafeInteger(offset) || offset < 64 || count < 1 || count > 64 || size !== 56 || offset + count * size > bytes.length) throw new Error('INVALID_SUPERVISOR_ELF');
  for (let i = 0; i < count; i++) {
    const at = offset + i * size, type = bytes.readUInt32LE(at), flags = bytes.readUInt32LE(at + 4);
    if (type === 2 || type === 3) throw new Error('STATIC_SUPERVISOR_REQUIRED');
    const start = bytes.readBigUInt64LE(at + 8), length = bytes.readBigUInt64LE(at + 32), address = bytes.readBigUInt64LE(at + 16);
    if (start + length > BigInt(bytes.length)) throw new Error('INVALID_SUPERVISOR_ELF');
    if (type === 1 && (flags & 1) && entry >= address && entry < address + length) executableEntry = true;
  }
  if (!executableEntry) throw new Error('INVALID_SUPERVISOR_ENTRY');
}
export function verifyLocalSandboxBuildIdentity(binary: Buffer, manifest: Buffer): void {
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(LOCAL_SANDBOX_BUILD_IDENTITY)) throw new Error('SANDBOX_BUILD_IDENTITY_UNAVAILABLE');
  const actual = `${createHash('sha256').update(binary).digest('hex')}:${createHash('sha256').update(manifest).digest('hex')}`;
  if (actual !== LOCAL_SANDBOX_BUILD_IDENTITY) throw new Error('SANDBOX_BUILD_IDENTITY_MISMATCH');
  validateLocalSupervisorElf(binary);
}
async function artifacts(): Promise<Artifacts> {
  if (!/^[a-f0-9]{64}:[a-f0-9]{64}$/.test(LOCAL_SANDBOX_BUILD_IDENTITY)) {
    throw new Error(LOCAL_SANDBOX_BUILD_IDENTITY.startsWith('UNAVAILABLE:') ? LOCAL_SANDBOX_BUILD_IDENTITY.slice(12) : 'SANDBOX_BUILD_IDENTITY_UNAVAILABLE');
  }
  const top = await directory(bundle); let binary: FileHandle | undefined, root: FileHandle | undefined;
  try {
    assertLocalSandboxOwnership(await top.stat());
    const raw = await open(`/proc/self/fd/${top.fd}/manifest.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
    let manifest: Manifest, manifestBytes: Buffer;
    try { await trusted(raw, 16_384); manifestBytes = await boundedRead(raw, 16_384); manifest = JSON.parse(manifestBytes.toString('utf8')) as Manifest; }
    finally { await raw.close(); }
    if (manifest.version !== 1 || manifest.platform !== 'linux' || manifest.arch !== 'x64' || manifest.policyHash !== LOCAL_SANDBOX_POLICY_SHA256) throw new Error('BUNDLE_POLICY_MISMATCH');
    if (manifest.available !== true) throw new Error(/^[A-Z0-9_]{1,80}$/.test(manifest.reason) ? manifest.reason : 'BUNDLE_UNAVAILABLE');
    if (!/^[a-f0-9]{64}$/.test(manifest.binarySha256) || !Array.isArray(manifest.files) || manifest.files.length < 2 || manifest.files.length > 48) throw new Error('INVALID_BUNDLE_MANIFEST');
    binary = await open(`/proc/self/fd/${top.fd}/sandbox-runner`, constants.O_RDONLY | constants.O_NOFOLLOW);
    await trusted(binary, 4 * 1024 * 1024);
    if (((await binary.stat()).mode & 0o777) !== 0o555) throw new Error('SUPERVISOR_MODE_MISMATCH');
    const executable = await boundedRead(binary, 4 * 1024 * 1024);
    verifyLocalSandboxBuildIdentity(executable, manifestBytes);
    if (createHash('sha256').update(executable).digest('hex') !== manifest.binarySha256) throw new Error('SUPERVISOR_HASH_MISMATCH');
    root = await open(`/proc/self/fd/${top.fd}/root`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    const expected = new Map<string, { sha256: string; bytes: number; mode: number }>(); let total = 0;
    for (const file of manifest.files) {
      if (!file || !artifactPath.test(file.path) || expected.has(file.path) || !/^[a-f0-9]{64}$/.test(file.sha256)
        || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > 160 * 1024 * 1024) throw new Error('INVALID_RUNTIME_MANIFEST');
      const mode = file.path === 'usr/bin/node' || /(?:^|\/)ld-linux-x86-64\.so\.2$/.test(file.path) ? 0o555 : 0o444;
      if (file.mode !== mode) throw new Error('RUNTIME_MODE_MISMATCH');
      expected.set(file.path, file); total += file.bytes;
    }
    if (total > 192 * 1024 * 1024 || !expected.has('usr/bin/node') || !expected.has('usr/lib/misaka/smoke.mjs')) throw new Error('INVALID_RUNTIME_MANIFEST');
    const allowedDirectories = new Set(['', 'input', 'work', 'tmp', 'proc', 'old']);
    for (const path of expected.keys()) {
      const parts = path.split('/'); parts.pop();
      while (parts.length) { allowedDirectories.add(parts.join('/')); parts.pop(); }
    }
    const visit = async (fd: FileHandle, prefix: string): Promise<void> => {
      assertLocalSandboxOwnership(await fd.stat());
      const entries = await readdir(`/proc/self/fd/${fd.fd}`, { withFileTypes: true });
      if (entries.length > 64) throw new Error('RUNTIME_DIRECTORY_LIMIT');
      for (const entry of entries) {
        const path = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory() && allowedDirectories.has(path)) {
          const next = await open(`/proc/self/fd/${fd.fd}/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          try { await visit(next, path); } finally { await next.close(); }
        } else {
          const expectedFile = expected.get(path);
          if (!entry.isFile() || !expectedFile) throw new Error('UNEXPECTED_RUNTIME_FILE');
          const file = await open(`/proc/self/fd/${fd.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            await trusted(file, expectedFile.bytes);
            const actual = await file.stat();
            if ((actual.mode & 0o777) !== expectedFile.mode) throw new Error('RUNTIME_MODE_MISMATCH');
            if (actual.size !== expectedFile.bytes || await hash(file) !== expectedFile.sha256) throw new Error('RUNTIME_HASH_MISMATCH');
          } finally { await file.close(); }
          expected.delete(path);
        }
      }
    };
    await visit(root, '');
    if (expected.size) throw new Error('MISSING_RUNTIME_FILE');
    const result: Artifacts = { binary, root, close: async () => { await result.binary.close(); await result.root.close(); } };
    binary = undefined; root = undefined;
    return result;
  } catch (error) { await binary?.close(); await root?.close(); throw error; }
  finally { await top.close(); }
}
async function prepare(files: { path: string; data: Buffer }[]): Promise<{ fd: FileHandle; cleanup(): Promise<void> }> {
  const path = await mkdtemp('/tmp/misaka-owned-input-');
  const root = await directory(path);
  try {
    for (const file of files) {
      let current = await open(`/proc/self/fd/${root.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
      try {
        const parts = file.path.split('/'), name = parts.pop()!;
        for (const part of parts) {
          const path = `/proc/self/fd/${current.fd}/${part}`;
          try { await mkdir(path, { mode: 0o700 }); } catch (error) { if (errno(error) !== 'EEXIST') throw error; }
          const next = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
          await current.close(); current = next;
        }
        const output = await open(`/proc/self/fd/${current.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o400);
        try { await output.writeFile(file.data); if ((await output.stat()).nlink !== 1) invalid('INPUT_LINK_REJECTED'); }
        finally { await output.close(); }
      } finally { await current.close(); }
    }
    return { fd: root, cleanup: async () => { await root.close(); await rm(path, { recursive: true }); } };
  } catch (error) { await root.close(); await rm(path, { recursive: true }); throw error; }
}
interface Job {
  child: ChildProcess;
  stdout: Readable;
  done: Promise<{ stdout: string; stderr: string; receipt: string; exit: number | null }>;
  abort(): void;
}
function supervise(bundle: Artifacts, input: FileHandle, args: string[], signal: AbortSignal, outputBytes: number, wallMs: number): Job {
  signal.throwIfAborted();
  const child = spawn('/proc/self/fd/3', args, { cwd: '/', env: {}, shell: false,
    stdio: ['pipe', 'pipe', 'pipe', bundle.binary.fd, bundle.root.fd, input.fd, 'pipe'] });
  const output = child.stdout!, error = child.stderr!, receipt = (child.stdio as (Readable | null | undefined)[])[6]!;
  let stdout = '', stderr = '', control = '', bytes = 0, failure: LocalSandboxError | undefined;
  const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8');
  let controlPartial = '', nextCancelPoint = 10;
  const abort = () => { child.kill('SIGTERM'); };
  const timer = setTimeout(() => { failure ??= new LocalSandboxError('LOCAL_LIMIT', 'SUPERVISOR_DEADLINE'); abort(); }, wallMs + 150_000);
  signal.addEventListener('abort', abort, { once: true });
  const consume = (which: 'stdout' | 'stderr' | 'receipt', chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > outputBytes * 3 + 16_384) { failure ??= new LocalSandboxError('LOCAL_LIMIT', 'OUTPUT_LIMIT'); abort(); return; }
    if (which === 'stdout') stdout += stdoutDecoder.write(chunk);
    else if (which === 'stderr') stderr += stderrDecoder.write(chunk);
    else {
      controlPartial += chunk.toString('ascii');
      let newline: number;
      while ((newline = controlPartial.indexOf('\n')) >= 0) {
        const line = controlPartial.slice(0, newline); controlPartial = controlPartial.slice(newline + 1);
        if (line.startsWith('TEST_CANCEL ')) {
          if (line !== `TEST_CANCEL ${nextCancelPoint}` || nextCancelPoint > 13) {
            failure ??= new LocalSandboxError('LOCAL_UNAVAILABLE', 'INVALID_CANCELLATION_PROBE'); abort();
          } else { nextCancelPoint++; child.kill('SIGUSR2'); }
        } else control += `${line}\n`;
      }
    }
  };
  output.on('data', (chunk: Buffer) => consume('stdout', chunk));
  error.on('data', (chunk: Buffer) => consume('stderr', chunk));
  receipt.on('data', (chunk: Buffer) => consume('receipt', chunk));
  // EPIPE is normal on cancellation or an early exit. Actual success requires
  // the supervisor's post-drain receipt, never child_process's exit event alone.
  child.stdin!.on('error', () => { abort(); });
  const done = new Promise<{ stdout: string; stderr: string; receipt: string; exit: number | null }>((resolve, reject) => {
    let spawnError: Error | undefined;
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (exit, termination) => {
      stdout += stdoutDecoder.end(); stderr += stderrDecoder.end();
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (spawnError) { reject(new LocalSandboxError('LOCAL_UNAVAILABLE', errno(spawnError))); return; }
      if (termination || controlPartial || !/\n?(?:OK \d+|QUALIFIED [a-f0-9]{64}|ERR (?:QUALIFICATION_\d+|RUN_\d+) \d+)\n$/.test(control)) {
        poisoned = true;
        reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'SUPERVISOR_DRAIN_RECEIPT_MISSING')); return;
      }
      if (/\n?(?:OK \d+|QUALIFIED [a-f0-9]{64})\n$/.test(control) && nextCancelPoint !== 14) {
        failure ??= new LocalSandboxError('LOCAL_UNAVAILABLE', 'CANCELLATION_PROBE_MISSING');
      }
      if (failure) { reject(failure); return; }
      resolve({ stdout, stderr, receipt: control, exit });
    });
  });
  return { child, stdout: output, done, abort };
}

function ndjson(message: unknown): string {
  const seen = new Set<object>(); let budget = 0, entries = 0;
  const visit = (value: unknown, depth: number): void => {
    if (depth > 16 || ++entries > 2048 || budget > 65_536) invalid('NDJSON_REQUEST_LIMIT');
    if (value === null || typeof value === 'boolean') budget += 5;
    else if (typeof value === 'number' && Number.isFinite(value)) budget += 24;
    else if (typeof value === 'string') budget += Buffer.byteLength(value) * 6 + 2;
    else if (typeof value === 'object' && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
      if (Array.isArray(value) && value.length > 2048) invalid('NDJSON_REQUEST_LIMIT');
      if (seen.has(value)) invalid('INVALID_NDJSON_REQUEST'); seen.add(value);
      for (const [key, item] of Object.entries(value)) { budget += Buffer.byteLength(key) * 6 + 4; visit(item, depth + 1); }
      seen.delete(value);
    } else invalid('INVALID_NDJSON_REQUEST');
  };
  visit(message, 0);
  if (budget > 65_536) invalid('NDJSON_REQUEST_LIMIT');
  return `${JSON.stringify(message)}\n`;
}

/** Bounded protocol adapter, NOT a process launcher or an isolation attestation.
 * Keeping it independent lets stream races be tested without running user code. */
export async function exchangeLocalStdio<T>(io: {
  stdin: Writable; stdout: Readable; done: Promise<{ receipt: string; exit: number | null }>; abort(): void;
}, outputLimit: number, signal: AbortSignal, exchange: (port: LocalStdioPort) => Promise<T>): Promise<T> {
  const session = new AbortController(), decoder = new StringDecoder('utf8');
  let pending: { resolve(value: unknown): void; reject(error: unknown): void } | undefined;
  let partial = '', inputBytes = 0, outputBytes = 0, closed = false, failed = false, firstError: unknown;
  const fail = (error: unknown) => {
    if (!failed) { failed = true; firstError = error; }
    else firstError = prioritizeFailure(firstError, error);
    pending?.reject(firstError); pending = undefined; session.abort(); io.abort();
  };
  const abortSession = () => fail(new LocalSandboxError('LOCAL_CANCELLED', 'ABORTED'));
  signal.addEventListener('abort', abortSession, { once: true });
  if (signal.aborted) abortSession();
  const receive = (chunk: Buffer) => {
    if (failed) return;
    outputBytes += chunk.length;
    if (outputBytes > outputLimit) { fail(new LocalSandboxError('LOCAL_LIMIT', 'STDIO_OUTPUT_LIMIT')); return; }
    partial += decoder.write(chunk);
    let newline: number;
    while ((newline = partial.indexOf('\n')) >= 0) {
      const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
      if (!pending) { fail(new LocalSandboxError('LOCAL_INVALID', 'UNEXPECTED_STDIO_MESSAGE')); return; }
      try {
        const value: unknown = JSON.parse(line), waiter = pending; pending = undefined; waiter.resolve(value);
      } catch { fail(new LocalSandboxError('LOCAL_INVALID', 'INVALID_NDJSON')); return; }
    }
  };
  io.stdout.on('data', receive);
  const streamError = (error: Error) => fail(error);
  io.stdout.on('error', streamError);
  const send = async (message: unknown) => {
    try {
      if (closed || session.signal.aborted) throw new LocalSandboxError('LOCAL_CANCELLED', 'STDIO_CLOSED');
      const line = ndjson(message); inputBytes += Buffer.byteLength(line);
      if (inputBytes > 65_536) throw new LocalSandboxError('LOCAL_LIMIT', 'STDIO_INPUT_LIMIT');
      await new Promise<void>((resolve, reject) => io.stdin.write(line, (error) => error ? reject(error) : resolve()));
    } catch (error) { fail(error); throw error; }
  };
  const port: LocalStdioPort = { signal: session.signal, notify: send, request: async (message) => {
    if (pending) { const error = new LocalSandboxError('LOCAL_LIMIT', 'STDIO_REQUEST_IN_FLIGHT'); fail(error); throw error; }
    const reply = new Promise<unknown>((resolve, reject) => { pending = { resolve, reject }; });
    // Attach before writing: a mock or very fast peer may synchronously reply.
    await Promise.all([Promise.resolve().then(() => send(message)), reply]); return reply;
  } };
  let value: T | undefined;
  const ended = io.done.then(() => { throw new LocalSandboxError('LOCAL_CANCELLED', 'STDIO_JOB_ENDED'); });
  try {
    value = await Promise.race([Promise.resolve().then(() => {
      if (failed) throw firstError;
      return exchange(port);
    }), ended]);
  } catch (error) { fail(error); }
  closed = true;
  if (pending) fail(new LocalSandboxError('LOCAL_INVALID', 'STDIO_REQUEST_UNSETTLED'));
  session.abort(); io.abort();
  try {
    const drained = await io.done;
    // Leave the data listener installed THROUGH drain: late duplicate messages
    // or a valid reply followed by a partial line cannot become success.
    partial += decoder.end();
    if (partial) fail(new LocalSandboxError('LOCAL_INVALID', 'TRUNCATED_NDJSON'));
    if (!((drained.exit === 0 && /(?:^|\n)OK 0\n$/.test(drained.receipt))
      || (drained.exit === 125 && /(?:^|\n)ERR RUN_5 \d+\n$/.test(drained.receipt)))) {
      fail(new LocalSandboxError('LOCAL_LIMIT', 'STDIO_TEARDOWN_FAILED'));
    }
  } catch (error) { fail(error); }
  finally {
    signal.removeEventListener('abort', abortSession); io.stdout.removeListener('data', receive); io.stdout.removeListener('error', streamError);
  }
  if (signal.aborted) abortSession();
  if (failed) throw firstError;
  return value as T;
}

/** Demand-only local execution. Authorization and the application's heavy-work
 * admission lease belong to the trusted Action adapter, not this runner. */
export class LocalSandbox {
  private async preflight(): Promise<{ report: LocalSandboxQualification; bundle?: Artifacts }> {
    const report: LocalSandboxQualification = { localEnabled: false, qualified: false, namespaces: 'not-tested',
      cgroup: 'not-tested', seccomp: 'unqualified', policyHash: LOCAL_SANDBOX_POLICY_SHA256, reasons: [] };
    if (process.platform !== 'linux' || process.arch !== 'x64' || process.versions.node.split('.')[0] !== '24') {
      report.reasons.push({ code: 'LINUX_X64_NODE24_REQUIRED', detail: 'The reviewed local runner requires Linux x86-64 and Node 24.' });
      return { report };
    }
    if (process.getuid?.() === 0 || process.geteuid?.() === 0) { report.reasons.push({ code: 'UNPRIVILEGED_RUNNER_REQUIRED', detail: 'Local execution refuses real or effective host root.' }); return { report }; }
    try { await cgroupGate(); report.cgroup = 'passed'; }
    catch (error) {
      report.cgroup = 'failed';
      report.reasons.push({ code: 'CGROUP_DELEGATION_FAILED', detail: `Delegated cgroup v2 memory/CPU/PIDs/swap/tree-kill controls unavailable (${errno(error)}).` });
      return { report };
    }
    try { return { report, bundle: await artifacts() }; }
    catch (error) {
      const reason = error instanceof Error && /^[A-Z0-9_]+$/.test(error.message) ? error.message : errno(error);
      report.reasons.push({ code: 'SANDBOX_BUILD_UNAVAILABLE', detail: `Verified bundled supervisor/runtime unavailable (${reason}).` }); return { report };
    }
  }
  async probe(): Promise<LocalSandboxQualification> {
    if (leased || poisoned) return { localEnabled: false, qualified: false, namespaces: 'not-tested', cgroup: 'not-tested', seccomp: 'unqualified',
      policyHash: LOCAL_SANDBOX_POLICY_SHA256, reasons: [{ code: poisoned ? 'LOCAL_DRAIN_UNVERIFIED' : 'LOCAL_BUSY', detail: 'The local runner cannot acquire its exclusive admission lease.' }] };
    leased = true;
    try {
      const checked = await this.preflight();
      if (!checked.bundle) return checked.report;
      let input: Awaited<ReturnType<typeof prepare>> | undefined;
      try {
        input = await prepare([]);
        const job = supervise(checked.bundle, input.fd, ['--probe'], new AbortController().signal, 65_536, 0);
        job.child.stdin!.end();
        const result = await job.done;
        if (result.exit !== 0 || result.receipt !== `QUALIFIED ${LOCAL_SANDBOX_POLICY_SHA256}\n`) throw new Error('FIXED_SELF_TEST_FAILED');
        return { ...checked.report, localEnabled: true, qualified: true, namespaces: 'passed', seccomp: 'passed' };
      } catch (error) {
        checked.report.namespaces = 'failed';
        checked.report.reasons.push({ code: 'LOCAL_SELF_TEST_FAILED', detail: `Fixed escape/resource/runtime qualification failed (${error instanceof LocalSandboxError ? error.reason : 'SUPERVISOR_REJECTED'}).` });
        return checked.report;
      } finally { try { await input?.cleanup(); } finally { await checked.bundle.close(); } }
    } finally { if (!poisoned) leased = false; }
  }
  execute(request: SandboxRequest, ownedInputs: readonly SandboxFile[], signal: AbortSignal): Promise<SandboxResult> {
    return this.run(request, ownedInputs, signal) as Promise<SandboxResult>;
  }
  withStdio<T>(request: SandboxRequest, ownedInputs: readonly SandboxFile[], signal: AbortSignal, exchange: (port: LocalStdioPort) => Promise<T>): Promise<T> {
    return this.run(request, ownedInputs, signal, exchange) as Promise<T>;
  }
  private async run<T>(request: SandboxRequest, ownedInputs: readonly SandboxFile[], signal: AbortSignal,
    exchange?: (port: LocalStdioPort) => Promise<T>): Promise<SandboxResult | T> {
    const submitted = validate(request, ownedInputs); request = submitted.request;
    if (signal.aborted) throw new LocalSandboxError('LOCAL_CANCELLED', 'ABORTED');
    if (leased || poisoned) throw new LocalSandboxError('LOCAL_UNAVAILABLE', poisoned ? 'LOCAL_DRAIN_UNVERIFIED' : 'LOCAL_BUSY');
    leased = true;
    let bundle: Artifacts | undefined, input: Awaited<ReturnType<typeof prepare>> | undefined, job: Job | undefined, operationFailed = false, operationError: unknown;
    try {
      const checked = await this.preflight(); bundle = checked.bundle;
      if (!bundle) throw new LocalSandboxError('LOCAL_UNAVAILABLE', checked.report.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' '));
      input = await prepare(submitted.files);
      signal.throwIfAborted();
      const limits = request.limits;
      const args = ['--run', limits.memoryBytes, limits.cpuMs, limits.pids, limits.outputBytes, limits.tempBytes, limits.wallMs].map(String);
      args.push(`/input/${request.entrypoint}`, ...request.args);
      job = supervise(bundle, input.fd, args, signal, limits.outputBytes, limits.wallMs);
      if (exchange) {
        return await exchangeLocalStdio({ stdin: job.child.stdin!, stdout: job.stdout, done: job.done, abort: job.abort }, limits.outputBytes, signal, exchange);
      }
      job.child.stdin!.end();
      const result = await job.done;
      if (signal.aborted) throw new LocalSandboxError('LOCAL_CANCELLED', 'ABORTED');
      const lines = result.receipt.trimEnd().split('\n'), completion = lines.pop();
      if (result.exit !== 0 || !completion || !/^OK \d{1,3}$/.test(completion)) throw new LocalSandboxError('LOCAL_LIMIT', 'JOB_REJECTED_OR_LIMITED');
      const files: SandboxFile[] = []; let total = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      for (const line of lines) {
        const match = /^F ([A-Za-z0-9_.-]{1,120}) ((?:[a-f0-9]{2})*)$/.exec(line);
        if (!match || match[1] === '.' || match[1] === '..' || files.some((file) => file.path === match[1]) || files.length >= 16) throw new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'INVALID_EXPORT_RECEIPT');
        const content = Buffer.from(match[2]!, 'hex'); total += content.length;
        files.push({ path: match[1]!, contentBase64: content.toString('base64') });
      }
      const exitCode = Number(completion.slice(3));
      if (total > limits.outputBytes || exitCode > 255) throw new LocalSandboxError('LOCAL_LIMIT', 'RESULT_LIMIT');
      return { stdout: result.stdout, stderr: result.stderr, exitCode, files };
    } catch (error) { operationFailed = true; operationError = error; throw error; }
    finally {
      // In particular, never release on abort() or the leader's exit event.
      const finish = async () => {
        let failed = operationFailed, failure = operationError;
        const remember = (error: unknown) => { failure = failed ? prioritizeFailure(failure, error) : error; failed = true; };
        try { if (job) { job.abort(); await job.done; } } catch (error) { remember(error); }
        try { await input?.cleanup(); } catch (error) { remember(error); }
        try { await bundle?.close(); } catch (error) { remember(error); }
        if (!poisoned) leased = false;
        // Unverified drain overrides earlier protocol/cancel/limit failures,
        // including when a second await of job.done rejects during this cleanup.
        if (failed) throw failure;
      };
      await finish();
    }
  }
}
