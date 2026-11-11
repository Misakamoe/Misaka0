import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeLocalSandbox, localSandboxRequestDigest, remoteExecutorReviewDigest, remoteSandboxTransferLimits, SandboxService, sandboxRequestDigest, type RemoteExecutionGrant, type RemoteExecutorProfile, type SandboxRequest } from '../src/ai/sandbox.js';
import { type ExtensionHttpRequest, type ExtensionHttpResponse } from '../src/ai/mcp.js';
import { extensionDigest, extensionJson } from '../src/ai/skills.js';
import { aiRemoteSandboxLimitsSchema, aiSandboxLimitsSchema } from '../shared/schemas/ai-extensions.js';

vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === 'function' ? vi.fn(value as (...args: unknown[]) => unknown) : value]));
});

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });
const scope = { ownerId: 'user:1', audience: 'private:1' };
const signal = () => new AbortController().signal;
const request = (): SandboxRequest => ({ runtime: 'node24', entrypoint: 'main.js', args: [], files: [{ path: 'main.js', contentBase64: Buffer.from('console.log(1)').toString('base64') }], network: 'deny',
  limits: { memoryBytes: 32 * 1024 * 1024, cpuMs: 1000, pids: 4, outputBytes: 4096, tempBytes: 8192, wallMs: 1000 } });

function fixture() {
  const job = request();
  const profile: RemoteExecutorProfile = { id: 'remote', enabled: true, url: 'https://executor.example/execute', approvedOrigin: 'https://executor.example', credentialRef: 'owner-key', scope, runtimes: ['node24'], reviewedDigest: '' };
  profile.reviewedDigest = remoteExecutorReviewDigest(profile);
  const grant: RemoteExecutionGrant = { id: 'grant_1234567890123456', profileId: profile.id, profileDigest: profile.reviewedDigest, scope, requestDigest: sandboxRequestDigest(job), expiresAt: 100 };
  const transport = vi.fn(async (input: ExtensionHttpRequest): Promise<ExtensionHttpResponse> => ({ status: 200, headers: {}, body: {
    version: 1, requestId: JSON.parse(input.body!).requestId, state: 'reaped', result: { exitCode: 0, stdout: '1\n', stderr: '', files: [] },
  } }));
  const used = new Set<string>();
  const consumeGrant = vi.fn((entry: RemoteExecutionGrant) => {
    if (used.has(entry.id)) throw new Error('GRANT_USED');
    used.add(entry.id);
  });
  const service = new SandboxService({ profiles: () => [profile], transport, consumeGrant, now: () => 10 });
  return { job, profile, grant, transport, consumeGrant, service };
}

describe('local sandbox qualification is not caller attestation', () => {
  it('reports real platform capabilities but never claims an unqualified local executor', async () => {
    const report = await probeLocalSandbox();
    expect(report.localEnabled).toBe(false);
    expect(report.seccomp).toBe('unqualified');
    expect(report.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(['SECCOMP_UNQUALIFIED', 'LOCAL_RUNNER_UNQUALIFIED']));
    if (process.platform === 'linux') expect(report.namespaces).not.toBe('not-tested');
  });

  it('rejects arbitrary local execution without spawning, probing or preparing files', async () => {
    const service = new SandboxService();
    const forged = Object.assign(request(), { qualified: true, runner: '/bin/sh', namespaces: true, seccomp: true, cgroup: true });
    await expect(service.executeLocal(forged, scope, signal())).rejects.toThrow('EXTENSION_UNAVAILABLE');
    expect(spawn).not.toHaveBeenCalled();
    expect(fs.mkdir).not.toHaveBeenCalled();
  });

  it('uses only fixed unprivileged argv, empty-secret environment and ignored fds for probing', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockImplementationOnce(() => {
      queueMicrotask(() => child.emit('close', 1));
      return child as ReturnType<typeof spawn>;
    });
    const result = await probeLocalSandbox();
    expect(result.localEnabled).toBe(false);
    expect(result.namespaces).toBe('failed');
    expect(spawn).toHaveBeenCalledWith('/usr/bin/unshare', ['--user', '--map-root-user', '--mount', '--pid', '--fork', '--net', '--ipc', '--uts', '--cgroup', '--kill-child=SIGKILL', '/usr/bin/true'], {
      cwd: '/', env: { PATH: '/usr/bin', LANG: 'C' }, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
    });
  });

  it('never enables execution even when empty-cgroup controls and namespace preflight pass', async () => {
    const child = new EventEmitter();
    vi.mocked(spawn).mockImplementationOnce(() => { queueMicrotask(() => child.emit('close', 0)); return child as ReturnType<typeof spawn>; });
    vi.mocked(fs.statfs).mockResolvedValueOnce({ type: 0x63677270 } as never);
    vi.mocked(fs.realpath).mockImplementation(async (path) => String(path));
    vi.mocked(fs.access).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.mocked(fs.rmdir).mockResolvedValue(undefined);
    const values = new Map<string, string>();
    vi.mocked(fs.writeFile).mockImplementation(async (file, value) => { values.set(String(file), String(value)); });
    vi.mocked(fs.readFile).mockImplementation(async (file) => {
      const path = String(file);
      return (path === '/proc/self/cgroup' ? '0::/delegated\n' : path.endsWith('cgroup.subtree_control') ? 'cpu memory pids\n' : path.endsWith('cgroup.procs') ? '' : values.get(path) ?? '') as never;
    });
    const report = await probeLocalSandbox();
    expect(report).toMatchObject({ namespaces: 'passed', cgroup: 'passed', seccomp: 'unqualified', localEnabled: false });
    expect(fs.writeFile).toHaveBeenCalledTimes(5);
    expect(fs.rmdir).toHaveBeenCalledTimes(1);
    expect(vi.mocked(fs.writeFile).mock.calls.every(([file]) => !String(file).endsWith('cgroup.procs'))).toBe(true);
    await expect(new SandboxService().executeLocal(request(), scope, signal())).rejects.toThrow('EXTENSION_UNAVAILABLE');
  });
});

describe('authorized remote executor boundary', () => {
  it('is demand-only, requires a scoped transfer grant and pins transport', async () => {
    const f = fixture(); expect(f.transport).not.toHaveBeenCalled();
    expect(await f.service.executeRemote('remote', f.job, scope, f.grant, signal())).toEqual({ exitCode: 0, stdout: '1\n', stderr: '', files: [] });
    expect(f.consumeGrant).toHaveBeenCalledTimes(1);
    expect(f.transport).toHaveBeenCalledTimes(1);
    expect(f.transport.mock.calls[0]![0]).toMatchObject({ url: 'https://executor.example/execute', approvedOrigin: 'https://executor.example', credentialRef: 'owner-key', scope,
      method: 'POST', maxRequestBytes: 1572864, maxResponseBytes: 131072 });
    const body = JSON.parse(f.transport.mock.calls[0]![0].body!);
    expect(body.request.network).toBe('deny');
    expect(body.request.files).toEqual(f.job.files);
    expect(body).not.toHaveProperty('scope');
    expect(body).not.toHaveProperty('credentialRef');
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('GRANT_USED');
    expect(f.transport).toHaveBeenCalledTimes(1);
  });

  it.each(['owner', 'audience', 'expired', 'digest', 'profile', 'runtime', 'policy'])('rejects mismatched grant/profile %s before transmission', async (kind) => {
    const f = fixture();
    if (kind === 'owner') f.grant.scope = { ...scope, ownerId: 'other' };
    if (kind === 'audience') f.grant.scope = { ...scope, audience: 'group:1' };
    if (kind === 'expired') f.grant.expiresAt = 10;
    if (kind === 'digest') f.grant.requestDigest = '0'.repeat(64);
    if (kind === 'profile') f.grant.profileId = 'other';
    if (kind === 'runtime') f.job.runtime = 'sh';
    if (kind === 'policy') f.profile.runtimes = ['sh', 'node24'];
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(f.transport).not.toHaveBeenCalled(); expect(f.consumeGrant).not.toHaveBeenCalled();
  });

  it.each(['memoryBytes', 'cpuMs', 'pids', 'outputBytes', 'tempBytes', 'wallMs'] as const)('caps %s without silently raising budgets', (key) => {
    const job = request(); job.limits[key] = Number.MAX_SAFE_INTEGER;
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
    job.limits[key] = 0;
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
  });

  it.each(['../secret', '/etc/passwd', 'a/../../b', 'a//b', './main.js', 'C:\\file', 'a/%2e%2e/b'])('rejects unsafe prepared/exported path %s', (path) => {
    const job = request(); job.files[0]!.path = path;
    expect(() => sandboxRequestDigest(job)).toThrow('INVALID_EXTENSION');
  });

  it('rejects shell mounts/env/network fields, symlink descriptors and noncanonical base64', () => {
    expect(() => sandboxRequestDigest(Object.assign(request(), { env: { SECRET: 'synthetic' } }))).toThrow('INVALID_EXTENSION');
    const job = request(); Object.assign(job.files[0]!, { symlink: '/etc' });
    expect(() => sandboxRequestDigest(job)).toThrow('INVALID_EXTENSION');
    const invalid = request(); invalid.files[0]!.contentBase64 = 'AB==';
    expect(() => sandboxRequestDigest(invalid)).toThrow('INVALID_EXTENSION');
    expect(() => sandboxRequestDigest({ ...request(), network: 'allow' } as unknown as SandboxRequest)).toThrow('INVALID_EXTENSION');
  });

  it('treats malformed or over-budget exports as uncertain and requests cancellation/drain', async () => {
    const f = fixture();
    f.transport.mockResolvedValueOnce({ status: 200, headers: {}, body: { version: 1, requestId: f.grant.id, state: 'reaped', result: { exitCode: 0, stdout: 'x'.repeat(4097), stderr: '', files: [] } } });
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(f.transport.mock.calls.map(([input]) => JSON.parse(input.body!).operation)).toEqual(['execute', 'cancelAndWait']);
  });

  it('does not release the operation slot until the remote cancel-and-wait transport drains', async () => {
    const f = fixture();
    const controller = new AbortController();
    let executing!: () => void;
    let cleaning!: () => void;
    let release!: () => void;
    const executionStarted = new Promise<void>((resolve) => { executing = resolve; });
    const cleanupStarted = new Promise<void>((resolve) => { cleaning = resolve; });
    const cleanupGate = new Promise<void>((resolve) => { release = resolve; });
    f.transport.mockImplementation(async (input) => {
      if (JSON.parse(input.body!).operation === 'execute') {
        executing();
        await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      } else { cleaning(); await cleanupGate; }
      return { status: 200, headers: {}, body: { version: 1, requestId: f.grant.id, state: 'reaped' } };
    });
    const run = f.service.executeRemote('remote', f.job, scope, f.grant, controller.signal);
    const assertion = expect(run).rejects.toThrow('OUTCOME_UNKNOWN');
    await executionStarted; controller.abort(); await cleanupStarted;
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_LIMIT');
    release(); await assertion;
    expect(f.transport).toHaveBeenCalledTimes(2);
  });

  it('does not transmit when already cancelled or no remote executor was configured', async () => {
    const f = fixture();
    const controller = new AbortController(); controller.abort();
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, controller.signal)).rejects.toThrow();
    expect(f.transport).not.toHaveBeenCalled();
    await expect(new SandboxService().executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_UNAVAILABLE');
  });

  it('accepts exactly 1 MiB of owned inputs separately from code and rejects the next byte', () => {
    const job = request(); job.limits.tempBytes = 4 * 1024 * 1024;
    const input = { path: 'inputs/photo.bin', contentBase64: Buffer.alloc(1024 * 1024, 1).toString('base64') };
    job.files = [...job.files, input];
    expect(sandboxRequestDigest(job)).toMatch(/^[a-f0-9]{64}$/);
    input.contentBase64 = Buffer.alloc(1024 * 1024 + 1, 1).toString('base64');
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
    input.contentBase64 = Buffer.alloc(512 * 1024, 1).toString('base64');
    job.files = [...job.files, { path: 'inputs/second.bin', contentBase64: Buffer.alloc(512 * 1024, 2).toString('base64') }];
    expect(sandboxRequestDigest(job)).toMatch(/^[a-f0-9]{64}$/);
    job.files[2]!.contentBase64 = Buffer.alloc(512 * 1024 + 1, 2).toString('base64');
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
  });

  it('retains the exact 32 KiB control bound while allowing a larger file packet', () => {
    const job = request(); job.limits.tempBytes = 4 * 1024 * 1024;
    job.files = [...job.files, { path: 'photo.bin', contentBase64: Buffer.alloc(1024 * 1024).toString('base64') }];
    const args = Array<string>(32).fill('x'.repeat(900)); job.args = args;
    const control = () => extensionJson({ ...job, files: job.files.map(file => ({ path: file.path })) }, 64 * 1024);
    let remaining = remoteSandboxTransferLimits.controlBytes - Buffer.byteLength(control());
    for (let index = 0; index < args.length && remaining > 0; index++) {
      const count = Math.min(1024 - args[index]!.length, remaining); args[index] += 'x'.repeat(count); remaining -= count;
    }
    expect(remaining).toBe(0); expect(Buffer.byteLength(control())).toBe(32768);
    expect(sandboxRequestDigest(job)).toMatch(/^[a-f0-9]{64}$/);
    const packet = JSON.stringify({ version: 1, operation: 'execute', requestId: 'x'.repeat(128), request: job });
    expect(Buffer.byteLength(packet)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(packet)).toBeLessThanOrEqual(remoteSandboxTransferLimits.requestBytes);
    args[args.findIndex(arg => arg.length < 1024)] += 'x';
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
    expect(() => extensionJson({ scope: 'x'.repeat(262145) })).toThrow('EXTENSION_LIMIT');
  });

  it('bounds raw base64 length/packet overhead before decoding and preserves canonical padding checks', () => {
    const job = request(); job.limits.tempBytes = 4 * 1024 * 1024;
    job.files = [...job.files, { path: 'input.bin', contentBase64: 'A'.repeat(remoteSandboxTransferLimits.requestBytes) }];
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
    for (const contentBase64 of ['AB==', 'AAA', 'AA=A', 'A===', '!!!!']) {
      job.files[1]!.contentBase64 = contentBase64;
      expect(() => sandboxRequestDigest(job)).toThrow('INVALID_EXTENSION');
    }
    job.files[0]!.contentBase64 = Buffer.alloc(65537).toString('base64'); job.files[1]!.contentBase64 = '';
    expect(() => sandboxRequestDigest(job)).toThrow('EXTENSION_LIMIT');
  });

  it('allows 512 MiB remotely only with a newly reviewed explicit profile, never locally', async () => {
    const f = fixture(); f.job.limits.memoryBytes = 512 * 1024 * 1024;
    f.grant.requestDigest = sandboxRequestDigest(f.job);
    expect(aiRemoteSandboxLimitsSchema.safeParse(f.job.limits).success).toBe(true);
    expect(aiSandboxLimitsSchema.safeParse(f.job.limits).success).toBe(false);
    expect(() => localSandboxRequestDigest({ ...f.job, runtime: 'node' })).toThrow('EXTENSION_LIMIT');
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_LIMIT');
    f.profile.limits = { ...f.job.limits };
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(f.consumeGrant).not.toHaveBeenCalled(); expect(f.transport).not.toHaveBeenCalled();
    f.profile.reviewedDigest = remoteExecutorReviewDigest(f.profile); f.grant.profileDigest = f.profile.reviewedDigest;
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).resolves.toMatchObject({ exitCode: 0 });
    expect(aiRemoteSandboxLimitsSchema.safeParse({ ...f.job.limits, memoryBytes: 512 * 1024 * 1024 + 1 }).success).toBe(false);
    expect(aiRemoteSandboxLimitsSchema.safeParse({ ...f.job.limits, outputBytes: 65537 }).success).toBe(false);
  });

  it('invalidates old remote review pins and preserves the local input ceiling', async () => {
    const f = fixture();
    f.profile.reviewedDigest = extensionDigest({ version: 1, id: f.profile.id, enabled: true, url: f.profile.url, approvedOrigin: f.profile.approvedOrigin,
      credentialRef: f.profile.credentialRef, scope, runtimes: f.profile.runtimes,
      limits: { memoryBytes: 64 * 1024 * 1024, cpuMs: 5000, pids: 16, outputBytes: 65536, tempBytes: 4 * 1024 * 1024, wallMs: 15000 }, policyBinding: null, network: 'deny' });
    f.grant.profileDigest = f.profile.reviewedDigest;
    await expect(f.service.executeRemote('remote', f.job, scope, f.grant, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(f.transport).not.toHaveBeenCalled();
    const local = request(); local.runtime = 'node'; local.limits.tempBytes = 4 * 1024 * 1024;
    local.files = [...local.files, { path: 'input.bin', contentBase64: Buffer.alloc(65536).toString('base64') }];
    expect(() => localSandboxRequestDigest(local)).toThrow();
    expect(sandboxRequestDigest(local)).toMatch(/^[a-f0-9]{64}$/);
  });
});
