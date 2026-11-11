import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, realpath, rmdir, statfs, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertExtensionScope, ExtensionError, extensionDigest, extensionJson, type ExtensionScope } from './skills.js';
import { validateExtensionEndpoint, type ExtensionHttpTransport } from './mcp.js';
import { defaultResourcePolicy, type ResourcePolicy } from '../resources.js';
import type { LocalSandbox, LocalSandboxQualification, LocalStdioPort } from './local-sandbox.js';
import type { AiLocalSandboxProfile } from '../../shared/schemas/ai-extensions.js';

export interface SandboxQualification {
  localEnabled: false;
  namespaces: 'passed' | 'failed' | 'not-tested';
  cgroup: 'passed' | 'failed' | 'not-tested';
  seccomp: 'unqualified';
  reasons: { code: string; detail: string }[];
}
export interface SandboxLimits {
  memoryBytes: number;
  cpuMs: number;
  pids: number;
  outputBytes: number;
  tempBytes: number;
  wallMs: number;
}
export interface SandboxFile { path: string; contentBase64: string }
export interface SandboxRequest {
  runtime: string;
  entrypoint: string;
  args: readonly string[];
  files: readonly SandboxFile[];
  network: 'deny';
  limits: SandboxLimits;
}
export interface RemoteExecutorProfile {
  id: string;
  enabled: boolean;
  url: string;
  approvedOrigin: string;
  credentialRef?: string;
  scope: ExtensionScope;
  runtimes: readonly string[];
  reviewedDigest: string;
  policyBinding?: string;
  limits?: SandboxLimits;
}
/** Issued and consumed by the root's human-authorized, one-time grant store. */
export interface RemoteExecutionGrant {
  id: string;
  profileId: string;
  profileDigest: string;
  scope: ExtensionScope;
  requestDigest: string;
  expiresAt: number;
}
export interface SandboxResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  files: SandboxFile[];
}

const ceilings: Readonly<SandboxLimits> = Object.freeze({ memoryBytes: 64 * 1024 * 1024, cpuMs: 5000,
  pids: 16, outputBytes: 64 * 1024, tempBytes: 4 * 1024 * 1024, wallMs: 15_000 });
const remoteCeilings: Readonly<SandboxLimits> = Object.freeze({ ...ceilings, memoryBytes: 512 * 1024 * 1024 });
export const remoteSandboxTransferLimits = Object.freeze({
  controlBytes: 32 * 1024, ownedInputBytes: 1024 * 1024, codeBytes: 64 * 1024,
  requestBytes: 1536 * 1024, responseBytes: 128 * 1024,
});

function errno(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && /^[A-Z_]{1,32}$/.test(code) ? code : 'UNAVAILABLE';
}

/** A fixed, non-shell preflight. No caller-controlled executable, arguments or env. */
async function probeNamespaces(): Promise<boolean> {
  for (const path of ['/usr/bin/unshare', '/usr/bin/true']) {
    if (await realpath(path) !== path) throw new Error('UNSAFE_PROBE_EXECUTABLE');
    const info = await lstat(path);
    if (!info.isFile() || info.uid !== 0 || (info.mode & 0o6022) !== 0) throw new Error('UNSAFE_PROBE_EXECUTABLE');
  }
  return new Promise<boolean>((resolve, reject) => {
    const child = spawn('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--net', '--ipc', '--uts', '--cgroup', '--kill-child=SIGKILL', '/usr/bin/true'], {
      cwd: '/', env: { PATH: '/usr/bin', LANG: 'C' }, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* Already exited. */ }
      }
    }, 2000);
    timer.unref();
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    // close, not exit: wait for the fixed probe child and its inherited descriptors.
    child.once('close', (code) => { clearTimeout(timer); resolve(!timedOut && code === 0); });
  });
}

/** Checks actual delegated controls in a new EMPTY cgroup; never moves host tasks. */
async function probeCgroup(): Promise<void> {
  if ((await statfs('/sys/fs/cgroup')).type !== 0x63677270) throw new Error('CGROUP_V2_UNAVAILABLE');
  const membership = await readFile('/proc/self/cgroup', 'utf8');
  if (membership.length > 4096) throw new Error('CGROUP_MEMBERSHIP_INVALID');
  const path = /^0::(\/[^\n]*)$/m.exec(membership)?.[1];
  if (!path || path.split('/').some((part) => part === '.' || part === '..') || path.includes('\\')
    || [...path].some((char) => char.charCodeAt(0) < 32)) throw new Error('CGROUP_MEMBERSHIP_INVALID');
  const parent = join('/sys/fs/cgroup', path);
  if (await realpath(parent) !== parent) throw new Error('CGROUP_MEMBERSHIP_INVALID');
  await access(parent, constants.W_OK | constants.X_OK);
  const controllers = (await readFile(join(parent, 'cgroup.subtree_control'), 'utf8')).trim().split(/\s+/);
  if (!['memory', 'cpu', 'pids'].every((name) => controllers.includes(name))) throw new Error('CGROUP_CONTROLLERS_NOT_DELEGATED');
  const directory = join(parent, `misaka-probe-${randomBytes(12).toString('hex')}`);
  await mkdir(directory, { mode: 0o700 });
  try {
    for (const [file, value] of [['memory.max', '67108864'], ['memory.swap.max', '0'], ['memory.oom.group', '1'], ['pids.max', '16'], ['cpu.max', '10000 100000']] as const) {
      await writeFile(join(directory, file), value);
      if ((await readFile(join(directory, file), 'utf8')).trim() !== value) throw new Error('CGROUP_LIMIT_NOT_ENFORCED');
    }
    await access(join(directory, 'cgroup.kill'), constants.W_OK);
    if ((await readFile(join(directory, 'cgroup.procs'), 'utf8')).trim()) throw new Error('CGROUP_PROBE_NOT_EMPTY');
  } finally { await rmdir(directory); }
}

/** Namespace diagnostics only. Actual qualification is SandboxService.probe(). */
export async function probeLocalSandbox(): Promise<SandboxQualification> {
  const report: SandboxQualification = { localEnabled: false, namespaces: 'not-tested', cgroup: 'not-tested', seccomp: 'unqualified', reasons: [] };
  if (process.platform !== 'linux') report.reasons.push({ code: 'LINUX_REQUIRED', detail: 'Local execution requires Linux namespaces and cgroup v2 delegation.' });
  else {
    try {
      report.namespaces = await probeNamespaces() ? 'passed' : 'failed';
      if (report.namespaces === 'failed') report.reasons.push({ code: 'NAMESPACE_PROBE_FAILED', detail: 'Unprivileged user/mount/PID/network/IPC/UTS/cgroup namespace creation was denied or the fixed probe failed.' });
    } catch (error) {
      report.namespaces = 'failed';
      report.reasons.push({ code: 'NAMESPACE_PROBE_UNAVAILABLE', detail: `The fixed unprivileged namespace probe could not run (${errno(error)}).` });
    }
    try { await probeCgroup(); report.cgroup = 'passed'; }
    catch (error) {
      report.cgroup = 'failed';
      const reason = error instanceof Error && /^CGROUP_[A-Z_]+$/.test(error.message) ? error.message : errno(error);
      report.reasons.push({ code: 'CGROUP_DELEGATION_FAILED', detail: `No verified writable delegated memory/CPU/PIDs/swap/tree-kill controls (${reason}).` });
    }
  }
  report.reasons.push({ code: 'SECCOMP_UNQUALIFIED', detail: 'This namespace-only diagnostic does not qualify the bundled seccomp runner.' },
    { code: 'LOCAL_RUNNER_UNQUALIFIED', detail: 'Execution requires the independent bundled runner qualification in SandboxService.probe(), never this diagnostic report.' });
  return report;
}

function validateFile(file: SandboxFile, maxBytes = 64 * 1024): number {
  if (!file || typeof file.path !== 'string' || file.path.length > 240 || !/^[a-zA-Z0-9_./-]+$/.test(file.path)
    || file.path.split('/').some((part) => !part || part === '.' || part === '..') || file.path.split('/').length > 6
    || typeof file.contentBase64 !== 'string') throw new ExtensionError('INVALID_EXTENSION');
  if (file.contentBase64.length > 4 * Math.ceil(maxBytes / 3)) throw new ExtensionError('EXTENSION_LIMIT');
  // A single character run avoids a backtracking stack proportional to a large file.
  if (file.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.contentBase64)) throw new ExtensionError('INVALID_EXTENSION');
  const bytes = Buffer.from(file.contentBase64, 'base64');
  if (bytes.length > maxBytes) throw new ExtensionError('EXTENSION_LIMIT');
  if (bytes.toString('base64') !== file.contentBase64) throw new ExtensionError('INVALID_EXTENSION');
  return bytes.length;
}

function validateLimits(limits: SandboxLimits, maximum: Readonly<SandboxLimits>): void {
  if (!limits || Object.keys(limits).sort().join(',') !== Object.keys(maximum).sort().join(',')) throw new ExtensionError('INVALID_EXTENSION');
  for (const key of Object.keys(maximum) as (keyof SandboxLimits)[]) {
    if (!Number.isSafeInteger(limits[key]) || limits[key] < 1 || limits[key] > maximum[key]) throw new ExtensionError('EXTENSION_LIMIT');
  }
}

function requestDigest(request: SandboxRequest, maxBytes: number, remote = false): string {
  const serialized = extensionJson(request, maxBytes);
  if (Object.keys(request).sort().join(',') !== 'args,entrypoint,files,limits,network,runtime' || request.network !== 'deny'
    || typeof request.runtime !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(request.runtime)
    || !Array.isArray(request.args) || request.args.length > 32 || request.args.some((arg) => typeof arg !== 'string' || arg.length > 1024 || arg.includes('\0'))
    || !Array.isArray(request.files) || request.files.length > 16) throw new ExtensionError('INVALID_EXTENSION');
  validateLimits(request.limits, remote ? remoteCeilings : ceilings);
  if (remote) extensionJson({ ...request, files: request.files.map(file => ({ path: file.path })) }, remoteSandboxTransferLimits.controlBytes);
  const paths = new Set<string>();
  let bytes = 0;
  let ownedBytes = 0;
  for (const file of request.files) {
    if (Object.keys(file).sort().join(',') !== 'contentBase64,path' || paths.has(file.path)) throw new ExtensionError('INVALID_EXTENSION');
    const count = validateFile(file, remote
      ? file.path === request.entrypoint ? remoteSandboxTransferLimits.codeBytes : remoteSandboxTransferLimits.ownedInputBytes
      : 64 * 1024);
    bytes += count;
    if (file.path !== request.entrypoint) ownedBytes += count;
    paths.add(file.path);
  }
  if (bytes > request.limits.tempBytes || !paths.has(request.entrypoint)
    || remote && ownedBytes > remoteSandboxTransferLimits.ownedInputBytes) throw new ExtensionError('EXTENSION_LIMIT');
  // Payload hashes use the explicitly bounded packet, not the small scope/metadata helper.
  return createHash('sha256').update(serialized).digest('hex');
}

export function sandboxRequestDigest(request: SandboxRequest): string { return requestDigest(request, remoteSandboxTransferLimits.requestBytes, true); }

export function localSandboxRequestDigest(request: SandboxRequest): string {
  const digest = requestDigest(request, 128 * 1024);
  if (request.runtime !== 'node' || request.limits.tempBytes % 4096 !== 0
    || request.files.reduce((sum, file) => sum + Buffer.from(file.contentBase64, 'base64').length, 0) > 65_536) throw new ExtensionError('INVALID_EXTENSION');
  for (const file of request.files) {
    if (request.files.some(other => file.path.startsWith(`${other.path}/`))) throw new ExtensionError('INVALID_EXTENSION');
  }
  return digest;
}

export async function localSandboxPolicyHash(): Promise<string> {
  return (await import('./local-sandbox.js')).LOCAL_SANDBOX_POLICY_SHA256;
}

export async function localExecutorReviewDigest(profile: AiLocalSandboxProfile): Promise<string> {
  if (!profile.scope || profile.runtime !== 'node') throw new ExtensionError('INVALID_EXTENSION');
  return extensionDigest({ version: 1, id: profile.id, scope: profile.scope, runtime: profile.runtime, limits: profile.limits,
    network: 'deny', policyHash: await localSandboxPolicyHash() });
}

export function remoteExecutorReviewDigest(profile: Omit<RemoteExecutorProfile, 'reviewedDigest'>): string {
  validateExtensionEndpoint(profile);
  assertExtensionScope(profile.scope, [profile.scope]);
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(profile.id) || typeof profile.enabled !== 'boolean'
    || !profile.runtimes.length || profile.runtimes.length > 8 || profile.runtimes.some((runtime) => !/^[a-zA-Z0-9_.-]{1,64}$/.test(runtime))) throw new ExtensionError('INVALID_EXTENSION');
  validateLimits(profile.limits ?? ceilings, remoteCeilings);
  return extensionDigest({ version: 2, id: profile.id, enabled: profile.enabled, url: profile.url, approvedOrigin: profile.approvedOrigin,
    credentialRef: profile.credentialRef ?? null, scope: profile.scope, runtimes: [...profile.runtimes].sort(), limits: profile.limits ?? ceilings,
    policyBinding: profile.policyBinding ?? null, network: 'deny', applicationLimits: remoteCeilings, transferLimits: remoteSandboxTransferLimits });
}

export class SandboxService {
  private active = false;
  private local?: Promise<LocalSandbox>;
  private localReport?: LocalSandboxQualification;
  constructor(private readonly options?: {
    profiles: () => readonly RemoteExecutorProfile[];
    transport: ExtensionHttpTransport;
    /** Must atomically recheck and consume the persisted human-approved transfer grant. */
    consumeGrant: (grant: RemoteExecutionGrant) => void;
    now?: () => number;
    resources?: ResourcePolicy;
    /** Trusted adapter rechecks the active invocation and reviewed target scope. */
    authorizeLocal?: (scope?: ExtensionScope) => void;
  }) {}

  localStatus(): { localRunnerImplemented: true; localEnabled: boolean; localReason: string } {
    const reason = this.localReport?.reasons[0]?.code ?? (this.localReport?.qualified ? 'LOCAL_QUALIFIED' : 'LOCAL_NOT_PROBED');
    return { localRunnerImplemented: true, localEnabled: this.localReport?.qualified === true && this.localReport.localEnabled,
      localReason: /^[A-Z0-9_]{1,80}$/.test(reason) ? reason : 'LOCAL_UNAVAILABLE' };
  }

  probe(signal: AbortSignal = new AbortController().signal): Promise<LocalSandboxQualification> {
    return this.localOperation<never>(undefined, signal);
  }

  withLocal<T>(scope: ExtensionScope, signal: AbortSignal, operation: (runner: LocalSandbox) => Promise<T>): Promise<T> {
    assertExtensionScope(scope, [scope]);
    return this.localOperation(scope, signal, operation) as Promise<T>;
  }

  private async localOperation<T>(scope: ExtensionScope | undefined, signal: AbortSignal,
    operation?: (runner: LocalSandbox) => Promise<T>): Promise<T | LocalSandboxQualification> {
    if (!this.options?.authorizeLocal) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    this.options.authorizeLocal(scope);
    signal.throwIfAborted();
    const lease = (this.options.resources ?? defaultResourcePolicy).tryAcquire('heavy', 64 * 1024 * 1024);
    if (!lease) throw new ExtensionError('EXTENSION_LIMIT');
    let uncertainDrain = false;
    let module: typeof import('./local-sandbox.js') | undefined;
    try {
      module = await import('./local-sandbox.js');
      this.local ??= Promise.resolve(new module.LocalSandbox());
      const runner = await this.local;
      signal.throwIfAborted();
      this.options.authorizeLocal(scope);
      // probe() itself waits for its fixed native qualification workload to reap.
      this.localReport = await runner.probe();
      uncertainDrain = this.localReport.reasons.some(reason => reason.code === 'LOCAL_DRAIN_UNVERIFIED' || reason.detail.includes('SUPERVISOR_DRAIN_RECEIPT_MISSING'));
      signal.throwIfAborted();
      this.options.authorizeLocal(scope);
      if (!operation) return structuredClone(this.localReport);
      if (!this.localReport.localEnabled || !this.localReport.qualified) throw new ExtensionError('EXTENSION_UNAVAILABLE');
      const result = await operation(runner);
      signal.throwIfAborted();
      this.options.authorizeLocal(scope);
      return result;
    } catch (error) {
      if (module && error instanceof module.LocalSandboxError) {
        uncertainDrain ||= error.code === 'LOCAL_OUTCOME_UNKNOWN';
        const reason = /^[A-Z0-9_]{1,80}$/.test(error.reason) ? error.reason : error.code;
        if (this.localReport) this.localReport = { ...this.localReport, localEnabled: false, qualified: false, reasons: [{ code: reason, detail: 'Local runner rejected or could not verify this operation.' }] };
        const codes = { LOCAL_UNAVAILABLE: 'EXTENSION_UNAVAILABLE', LOCAL_INVALID: 'INVALID_EXTENSION', LOCAL_LIMIT: 'EXTENSION_LIMIT',
          LOCAL_CANCELLED: 'EXTENSION_CANCELLED', LOCAL_OUTCOME_UNKNOWN: 'OUTCOME_UNKNOWN' } as const;
        throw new ExtensionError(codes[error.code]);
      }
      throw error;
    } finally {
      // A missing native drain receipt poisons both runner and heavy admission.
      // Do not make another heavy job overlap descendants whose death is unknown.
      if (!uncertainDrain) lease.release();
    }
  }

  async executeLocal(request: SandboxRequest, scope: ExtensionScope, signal: AbortSignal): Promise<SandboxResult> {
    if (!this.options?.authorizeLocal) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    localSandboxRequestDigest(request);
    const snapshot = structuredClone(request);
    return this.withLocal(scope, signal, runner => runner.execute(snapshot, [], signal));
  }

  async withLocalStdio<T>(request: SandboxRequest, scope: ExtensionScope, signal: AbortSignal,
    exchange: (port: LocalStdioPort) => Promise<T>): Promise<T> {
    if (!this.options?.authorizeLocal) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    localSandboxRequestDigest(request);
    const snapshot = structuredClone(request);
    return this.withLocal(scope, signal, runner => runner.withStdio(snapshot, [], signal, exchange));
  }

  async executeRemote(id: string, request: SandboxRequest, scope: ExtensionScope, grant: RemoteExecutionGrant, signal: AbortSignal): Promise<SandboxResult> {
    if (!this.options) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    if (this.active) throw new ExtensionError('EXTENSION_LIMIT');
    signal.throwIfAborted();
    const digest = sandboxRequestDigest(request);
    // Strings are immutable: snapshot containers without duplicating large base64 data.
    request = { ...request, args: [...request.args], limits: { ...request.limits }, files: request.files.map(file => ({ ...file })) };
    scope = { ...scope };
    grant = structuredClone(grant);
    const profiles = this.options.profiles();
    if (profiles.length > 32) throw new ExtensionError('EXTENSION_LIMIT');
    const matches = profiles.filter((profile) => profile.id === id);
    if (matches.length !== 1 || !matches[0]!.enabled) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const profile = structuredClone(matches[0]!);
    const profileLimits = profile.limits ?? ceilings;
    validateLimits(profileLimits, remoteCeilings);
    if ((Object.keys(ceilings) as (keyof SandboxLimits)[]).some(key => request.limits[key] > profileLimits[key])) throw new ExtensionError('EXTENSION_LIMIT');
    assertExtensionScope(scope, [profile.scope]);
    assertExtensionScope(scope, [grant.scope]);
    if (!profile.runtimes.includes(request.runtime) || profile.reviewedDigest !== remoteExecutorReviewDigest(profile)
      || grant.profileId !== id || grant.profileDigest !== profile.reviewedDigest || grant.requestDigest !== digest
      || !/^[a-zA-Z0-9_-]{16,128}$/.test(grant.id) || !Number.isSafeInteger(grant.expiresAt)
      || grant.expiresAt <= (this.options.now?.() ?? Date.now())) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const packet = JSON.stringify({ version: 1, operation: 'execute', requestId: grant.id, request });
    if (Buffer.byteLength(packet) > remoteSandboxTransferLimits.requestBytes) throw new ExtensionError('EXTENSION_LIMIT');
    this.options.consumeGrant(structuredClone(grant));
    signal.throwIfAborted();
    const currentProfile = this.options.profiles().find((item) => item.id === id);
    if (!currentProfile || extensionDigest(currentProfile) !== extensionDigest(profile)) throw new ExtensionError('EXTENSION_FORBIDDEN');
    this.active = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, request.limits.wallMs);
    timer.unref();
    const send = (operation: string, operationSignal: AbortSignal) => this.options!.transport({
      url: profile.url, approvedOrigin: profile.approvedOrigin, credentialRef: profile.credentialRef, scope: { ...scope }, method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: operation === 'execute' ? packet : extensionJson({ version: 1, operation, requestId: grant.id }, remoteSandboxTransferLimits.controlBytes),
      maxRequestBytes: operation === 'execute' ? remoteSandboxTransferLimits.requestBytes : remoteSandboxTransferLimits.controlBytes,
      maxResponseBytes: remoteSandboxTransferLimits.responseBytes, signal: operationSignal,
    });
    try {
      const response = await send('execute', controller.signal);
      controller.signal.throwIfAborted();
      const current = this.options.profiles().find((item) => item.id === id);
      if (!current || extensionDigest(current) !== extensionDigest(profile)) throw new ExtensionError('OUTCOME_UNKNOWN');
      extensionJson(response.body, remoteSandboxTransferLimits.responseBytes);
      const body = response.body as { version?: unknown; requestId?: unknown; state?: unknown; result?: SandboxResult } | null;
      if (response.status !== 200 || body?.version !== 1 || body.requestId !== grant.id || body.state !== 'reaped' || !body.result) throw new ExtensionError('OUTCOME_UNKNOWN');
      const result = body.result;
      if (!Number.isInteger(result.exitCode) || result.exitCode < 0 || result.exitCode > 255 || typeof result.stdout !== 'string'
        || typeof result.stderr !== 'string' || !Array.isArray(result.files) || result.files.length > 16) throw new ExtensionError('OUTCOME_UNKNOWN');
      let bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      const paths = new Set<string>();
      const files: SandboxFile[] = [];
      for (const file of result.files) {
        if (Object.keys(file).sort().join(',') !== 'contentBase64,path' || paths.has(file.path)) throw new ExtensionError('OUTCOME_UNKNOWN');
        bytes += validateFile(file);
        paths.add(file.path);
        files.push({ path: file.path, contentBase64: file.contentBase64 });
      }
      if (bytes > request.limits.outputBytes) throw new ExtensionError('OUTCOME_UNKNOWN');
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, files };
    } catch {
      // An HTTP abort is not proof the remote job stopped. Request whole-tree kill
      // and reap, await the real transport, and retain uncertainty even on success.
      const cleanup = new AbortController();
      const cleanupTimer = setTimeout(() => cleanup.abort(), 5000);
      cleanupTimer.unref();
      try { await send('cancelAndWait', cleanup.signal); } catch { /* Never retry an uncertain execution. */ }
      finally { clearTimeout(cleanupTimer); }
      throw new ExtensionError('OUTCOME_UNKNOWN');
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
      this.active = false;
    }
  }
}
