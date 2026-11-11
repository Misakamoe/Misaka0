import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as childProcess from 'node:child_process';
import { LocalSandbox, LocalSandboxError, LOCAL_SANDBOX_POLICY_SHA256, LOCAL_SANDBOX_BUILD_IDENTITY,
  assertLocalSandboxOwnership, exchangeLocalStdio, validateLocalSupervisorElf, verifyLocalSandboxBuildIdentity } from '../src/ai/local-sandbox.js';
import type { SandboxRequest } from '../src/ai/sandbox.js';

vi.mock('node:child_process', { spy: true });
vi.mock('node:fs/promises', { spy: true });

const limits = { memoryBytes: 67_108_864, cpuMs: 5000, pids: 16, outputBytes: 65_536, tempBytes: 4_194_304, wallMs: 15_000 };
function request(code = "console.log('isolated')"): SandboxRequest {
  return { runtime: 'node', entrypoint: 'main.cjs', args: [], network: 'deny', limits: { ...limits },
    files: [{ path: 'main.cjs', contentBase64: Buffer.from(code).toString('base64') }] };
}
const signal = () => new AbortController().signal;
const build = await import(fileURLToPath(new URL('../scripts/build-sandbox.mjs', import.meta.url))) as {
  sandboxRuntimeMode(path: string): number;
  capturedSandboxCompilation(binary: string): { args: string[]; input: Buffer };
  pinSandboxAdapter(source: string, identity: string, policyHash: string): string;
};

function staticElf(): Buffer {
  const bytes = Buffer.alloc(128); Buffer.from('7f454c46020101', 'hex').copy(bytes);
  bytes.writeUInt16LE(2, 16); bytes.writeUInt16LE(62, 18); bytes.writeUInt32LE(1, 20);
  bytes.writeBigUInt64LE(0x400078n, 24); bytes.writeBigUInt64LE(64n, 32);
  bytes.writeUInt16LE(56, 54); bytes.writeUInt16LE(1, 56);
  bytes.writeUInt32LE(1, 64); bytes.writeUInt32LE(5, 68); bytes.writeBigUInt64LE(0x400000n, 80);
  bytes.writeBigUInt64LE(BigInt(bytes.length), 96);
  return bytes;
}

describe('compiler diagnostics', () => {
  it.each([
    ['ENOENT', 'EACCES', 1000, 0o100755, true, 'missing'],
    ['ENOTDIR', 'EPERM', 0, 0o100775, true, 'missing'],
    ['PRIVATE_CODE', 'EACCES', 0, 0o40755, false, 'inspection-failed'],
    ['ENOENT', 'EACCES', 0, 0o104755, true, 'missing'],
    ['EACCES', 'EPERM', 1000, 0o100755, true, 'permission-denied'],
  ] as const)('distinguishes %s, %s and untrusted metadata without changing the manifest', async (missingCode, deniedCode, uid, mode, file, category) => {
    const argv = process.argv, exitCode = process.exitCode;
    const project = fileURLToPath(new URL('../', import.meta.url)).replace(/\/$/, '');
    const script = `${project}/scripts/build-sandbox.mjs`;
    const failure = (code: string) => Object.assign(new Error('PRIVATE_COMPILER_DETAIL'), { code, path: '/private/resolved-target' });
    vi.spyOn(fs, 'realpath').mockImplementation(async path => {
      if (String(path) === '/usr/bin/cc') throw failure(missingCode);
      if (String(path) === '/usr/bin/gcc') return '/private/gcc-target';
      if (String(path) === '/usr/bin/clang') return '/private/clang-target';
      return String(path);
    });
    vi.spyOn(fs, 'lstat').mockImplementation(async path => {
      if (String(path) === '/private/gcc-target') throw failure(deniedCode);
      if (String(path) === '/private/clang-target') return { uid, mode, isFile: () => file } as Awaited<ReturnType<typeof fs.lstat>>;
      if ([project, `${project}/dist`].includes(String(path))) return { mode: 0o40755, isDirectory: () => true } as Awaited<ReturnType<typeof fs.lstat>>;
      throw failure('ENOENT');
    });
    vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    vi.spyOn(fs, 'mkdtemp').mockResolvedValue('/not-created/sandbox-build');
    vi.spyOn(fs, 'writeFile').mockResolvedValue(undefined);
    vi.spyOn(fs, 'chmod').mockResolvedValue(undefined);
    vi.spyOn(fs, 'rename').mockResolvedValue(undefined);
    vi.spyOn(fs, 'rm').mockResolvedValue(undefined);
    const spawn = vi.spyOn(childProcess, 'spawn').mockImplementation(() => { throw new Error('Compiler execution forbidden in diagnostic tests'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      process.argv = [process.execPath, script, '--require-available'];
      vi.resetModules(); await import(script);
      expect(warn.mock.calls.slice(0, 3)).toEqual([
        [`Local sandbox compiler /usr/bin/cc: ${category}.`],
        ['Local sandbox compiler /usr/bin/gcc: permission-denied.'],
        ['Local sandbox compiler /usr/bin/clang: untrusted (file type, ownership or mode).'],
      ]);
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/PRIVATE|\/private\//);
      expect(spawn).not.toHaveBeenCalled();
      expect(process.exitCode).toBe(2);
      expect(fs.writeFile).toHaveBeenCalledOnce();
      const manifest = JSON.parse(String(vi.mocked(fs.writeFile).mock.calls[0]![1]));
      expect(manifest).toEqual({ version: 1, platform: 'linux', arch: 'x64', policyHash: LOCAL_SANDBOX_POLICY_SHA256,
        available: false, reason: 'C_COMPILER_UNAVAILABLE', binarySha256: '', files: [] });
    } finally { process.argv = argv; process.exitCode = exitCode; vi.resetAllMocks(); vi.restoreAllMocks(); vi.resetModules(); }
  });
});

describe('local runner unit and fail-closed boundary', () => {
  it('pins the exact C policy and fixed smoke test, not a caller path or boolean', async () => {
    const [source, smoke] = await Promise.all([
      readFile(new URL('../scripts/sandbox-runner.c', import.meta.url)), readFile(new URL('../scripts/sandbox-smoke.mjs', import.meta.url)),
    ]);
    expect(createHash('sha256').update(source).update('\0').update(smoke).digest('hex')).toBe(LOCAL_SANDBOX_POLICY_SHA256);
  });
  it('prepares captured policy bytes for compiler stdin without reopening the C pathname', async () => {
    const compilation = build.capturedSandboxCompilation('/not-created/sandbox-runner');
    const [source, smoke] = await Promise.all([
      readFile(new URL('../scripts/sandbox-runner.c', import.meta.url)), readFile(new URL('../scripts/sandbox-smoke.mjs', import.meta.url)),
    ]);
    expect(compilation.input).toEqual(source);
    expect(compilation.args.slice(-3)).toEqual(['-x', 'c', '-']);
    expect(compilation.args.some((arg) => arg.endsWith('sandbox-runner.c'))).toBe(false);
    expect(compilation.args).toContain('-static');
    const hash = createHash('sha256').update(compilation.input).update('\0').update(smoke).digest('hex');
    expect(hash).toBe(LOCAL_SANDBOX_POLICY_SHA256);
    expect(compilation.args).toContain(`-DPOLICY_SHA256="${hash}"`);
    compilation.input.fill(0);
    expect(build.capturedSandboxCompilation('/not-created/sandbox-runner').input).toEqual(source);
    const builder = await readFile(new URL('../scripts/build-sandbox.mjs', import.meta.url), 'utf8');
    expect(builder).toContain('spawn(compiler, compilation.args');
    expect(builder).toContain("stdio: ['pipe', 'inherit', 'inherit']");
    expect(builder).toContain('child.stdin.end(compilation.input)');
  });
  it('has no process or persistent worker at construction', () => {
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    new LocalSandbox(); expect(spawn).not.toHaveBeenCalled();
  });
  it.each(['/etc/passwd', '../secret', 'a/../../secret', './main.cjs', 'a//main.cjs', 'a\\main.cjs', 'main\0.cjs'])('rejects unsafe input path %j before probing or spawning', async (path) => {
    const value = request(); value.entrypoint = path; value.files = [{ path, contentBase64: 'eA==' }];
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    try { await expect(new LocalSandbox().execute(value, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' }); expect(spawn).not.toHaveBeenCalled(); }
    finally { spawn.mockClear(); }
  });
  it.each(['python', '/usr/bin/node', 'sh', 'node --eval'])('rejects unsupported or caller-chosen runtime %j', async (runtime) => {
    await expect(new LocalSandbox().execute({ ...request(), runtime }, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' });
  });
  it.each(Object.keys(limits) as (keyof typeof limits)[])('rejects missing, noninteger and excessive %s', async (key) => {
    for (const value of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, limits[key] + 1, undefined, '1']) {
      const input = request(); (input.limits as unknown as Record<string, unknown>)[key] = value;
      await expect(new LocalSandbox().execute(input, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' });
    }
  });
  it('rejects caller qualification and host-path attestation fields', async () => {
    for (const extra of [{ qualified: true }, { rootOwned: true }, { immutable: true }, { binary: '/usr/bin/node' }, { environment: {} }, { workspace: '/home' }]) {
      await expect(new LocalSandbox().execute({ ...request(), ...extra }, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' });
    }
  });
  it('rejects changed network policy, NUL args and extra limits', async () => {
    const values = [{ ...request(), network: 'allow' }, { ...request(), args: ['x\0y'] }, { ...request(), limits: { ...limits, qualified: true } }];
    for (const value of values) await expect(new LocalSandbox().execute(value as SandboxRequest, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' });
  });
  it('rejects collisions between script files and trusted byte inputs', async () => {
    const file = { path: 'main.cjs', contentBase64: 'eA==' };
    await expect(new LocalSandbox().execute(request(), [file], signal())).rejects.toMatchObject({ reason: 'DUPLICATE_INPUT' });
    await expect(new LocalSandbox().execute(request(), [{ ...file, path: 'main.cjs/child' }], signal())).rejects.toMatchObject({ reason: 'INPUT_PATH_COLLISION' });
  });
  it('requires canonical base64, bounded bytes and an existing entrypoint', async () => {
    for (const contentBase64 of ['Zg', 'Zh==', '%%%=', 'data:;base64,eA==']) {
      await expect(new LocalSandbox().execute({ ...request(), files: [{ path: 'main.cjs', contentBase64 }] }, [], signal())).rejects.toMatchObject({ code: 'LOCAL_INVALID' });
    }
    const input = request('x'.repeat(5000)); input.limits.tempBytes = 4096;
    await expect(new LocalSandbox().execute(input, [], signal())).rejects.toMatchObject({ reason: 'INPUT_LIMIT' });
    await expect(new LocalSandbox().execute({ ...request(), entrypoint: 'missing.cjs' }, [], signal())).rejects.toMatchObject({ reason: 'INPUT_LIMIT' });
  });
  it('aborts before qualification without preparing or executing code', async () => {
    const controller = new AbortController(); controller.abort();
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    try { await expect(new LocalSandbox().execute(request(), [], controller.signal)).rejects.toMatchObject({ code: 'LOCAL_CANCELLED' }); expect(spawn).not.toHaveBeenCalled(); }
    finally { spawn.mockClear(); }
  });
  it('reports sanitized explicit error codes', () => {
    expect(new LocalSandboxError('LOCAL_UNAVAILABLE', 'C_COMPILER_UNAVAILABLE').message).toBe('LOCAL_UNAVAILABLE: C_COMPILER_UNAVAILABLE');
  });
  it('marks Node and every permitted ELF interpreter path executable, but not data libraries', () => {
    for (const path of ['usr/bin/node', 'lib64/ld-linux-x86-64.so.2', 'lib/x86_64-linux-gnu/ld-linux-x86-64.so.2', 'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2']) {
      expect(build.sandboxRuntimeMode(path)).toBe(0o555);
    }
    expect(build.sandboxRuntimeMode('lib/x86_64-linux-gnu/libc.so.6')).toBe(0o444);
    expect(build.sandboxRuntimeMode('usr/lib/misaka/smoke.mjs')).toBe(0o444);
  });
  it.each([0o100555, 0o100444, 0o40755, 0o40555])('rejects application-owned bundle entries even with mode %i', (mode) => {
    expect(() => assertLocalSandboxOwnership({ uid: 1000, mode })).toThrow('IMMUTABLE_SANDBOX_INSTALLATION_REQUIRED');
    expect(() => assertLocalSandboxOwnership({ uid: 0, mode })).not.toThrow();
  });
  it.each([0o100575, 0o100557, 0o40775, 0o40757])('rejects root-owned but group/other writable mode %i', (mode) => {
    expect(() => assertLocalSandboxOwnership({ uid: 0, mode })).toThrow('IMMUTABLE_SANDBOX_INSTALLATION_REQUIRED');
  });
  it.each(['getuid', 'geteuid'] as const)('refuses an application with root %s before any spawn', async (name) => {
    const identity = vi.spyOn(process, name).mockReturnValue(0), spawn = vi.mocked(childProcess.spawn); spawn.mockClear();
    try {
      const report = await new LocalSandbox().probe();
      expect(report.qualified).toBe(false);
      expect(report.reasons).toEqual([{ code: 'UNPRIVILEGED_RUNNER_REQUIRED', detail: 'Local execution refuses real or effective host root.' }]);
      expect(spawn).not.toHaveBeenCalled();
    } finally { identity.mockRestore(); }
  });
  it('pins executable and full manifest hashes in emitted application code only', () => {
    const emitted = `export const LOCAL_SANDBOX_POLICY_SHA256 = '${LOCAL_SANDBOX_POLICY_SHA256}';\nexport const LOCAL_SANDBOX_BUILD_IDENTITY = 'UNBUILT';\n`;
    const identity = `${'1'.repeat(64)}:${'2'.repeat(64)}`;
    expect(build.pinSandboxAdapter(emitted, identity, LOCAL_SANDBOX_POLICY_SHA256)).toContain(`LOCAL_SANDBOX_BUILD_IDENTITY = '${identity}'`);
    expect(build.pinSandboxAdapter(emitted, 'UNAVAILABLE:C_COMPILER_UNAVAILABLE', LOCAL_SANDBOX_POLICY_SHA256)).toContain('UNAVAILABLE:C_COMPILER_UNAVAILABLE');
    expect(() => build.pinSandboxAdapter(emitted, identity, 'wrong-policy')).toThrow('COMPILED_ADAPTER_IDENTITY_MISSING');
    expect(() => build.pinSandboxAdapter(emitted.repeat(2), identity, LOCAL_SANDBOX_POLICY_SHA256)).toThrow('COMPILED_ADAPTER_IDENTITY_MISSING');
    expect(() => build.pinSandboxAdapter(emitted, '/caller/binary', LOCAL_SANDBOX_POLICY_SHA256)).toThrow('COMPILED_ADAPTER_IDENTITY_MISSING');
  });
  it('cannot turn a forged adjacent manifest into trusted source-mode execution', () => {
    expect(LOCAL_SANDBOX_BUILD_IDENTITY).toBe('UNBUILT');
    const binary = staticElf();
    const forged = Buffer.from(JSON.stringify({ policyHash: LOCAL_SANDBOX_POLICY_SHA256, binarySha256: createHash('sha256').update(binary).digest('hex'), available: true }));
    expect(() => verifyLocalSandboxBuildIdentity(binary, forged)).toThrow('SANDBOX_BUILD_IDENTITY_UNAVAILABLE');
  });
  it('rejects scripts, dynamic/interpreted ELF and malformed static entries before spawn', () => {
    expect(() => validateLocalSupervisorElf(staticElf())).not.toThrow();
    expect(() => validateLocalSupervisorElf(Buffer.from('#!/bin/sh\nexit 0\n'))).toThrow('STATIC_SUPERVISOR_REQUIRED');
    for (const type of [2, 3]) {
      const bytes = staticElf(); bytes.writeUInt32LE(type, 64);
      expect(() => validateLocalSupervisorElf(bytes)).toThrow('STATIC_SUPERVISOR_REQUIRED');
    }
    const malformed = staticElf(); malformed.writeBigUInt64LE(999999n, 24);
    expect(() => validateLocalSupervisorElf(malformed)).toThrow('INVALID_SUPERVISOR_ENTRY');
  });
  it('keeps the parent-controlled admission barrier and pre-drain direct-child reap in source', async () => {
    const source = await readFile(new URL('../scripts/sandbox-runner.c', import.meta.url), 'utf8');
    const child = source.slice(source.indexOf('if (!child) {'), source.indexOf('close(admission[0]);\n  close(out[1])'));
    expect(child).not.toContain('put_at(cg, "cgroup.procs"');
    expect(child.indexOf('read(admission[0]')).toBeLessThan(child.indexOf('unshare('));
    const parent = source.slice(source.indexOf('char member[64]'), source.indexOf('static int qualify'));
    expect(parent.indexOf('put_at(cg, "cgroup.procs", member)')).toBeLessThan(parent.indexOf('write_all(admission[1], "g", 1)'));
    expect(parent.indexOf('kill(child, SIGKILL)')).toBeLessThan(parent.indexOf('destroy_cgroup()'));
    expect(parent.indexOf('waitpid(child, &status, 0)')).toBeLessThan(parent.indexOf('destroy_cgroup()'));
    expect(source).toContain('measured_cpu_children == 2');
    expect(source).toContain('result == 5 && test_cancelled && measured_cancel_point == test && !cancelled');
  });
});

describe('stdio stream regressions (mock I/O, no native qualification or process)', () => {
  function fixture(chunks: string[], controller = new AbortController(), max = 4096) {
    const stdin = new PassThrough(), stdout = new PassThrough();
    const drain = Promise.withResolvers<{ receipt: string; exit: number }>();
    const teardown = Promise.withResolvers<void>();
    const abort = vi.fn(() => teardown.resolve());
    stdin.once('data', () => { for (const chunk of chunks) stdout.write(chunk); });
    const task = exchangeLocalStdio({ stdin, stdout, done: drain.promise, abort }, max, controller.signal, (port) => port.request({ id: 1 }));
    // Observe failures immediately, but retain the assertion against the promise.
    void task.catch(() => {});
    return { task, stdout, drain, teardown: teardown.promise, abort, controller };
  }
  it.each([
    ['valid reply plus BAD line', '{"id":1}\nBAD\n', 'UNEXPECTED_STDIO_MESSAGE'],
    ['duplicate reply', '{"id":1}\n{"id":1}\n', 'UNEXPECTED_STDIO_MESSAGE'],
    ['invalid reply', 'BAD\n', 'INVALID_NDJSON'],
    ['valid reply plus trailing partial', '{"id":1}\nBAD', 'TRUNCATED_NDJSON'],
  ])('rejects %s only after actual drain', async (_name, text, reason) => {
    const f = fixture([text!]); let settled = false;
    void f.task.then(() => { settled = true; }, () => { settled = true; });
    await f.teardown;
    expect(settled).toBe(false);
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ reason });
  });
  it('keeps listening for an unexpected response during teardown', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.stdout.write('{"id":2}\n');
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ reason: 'UNEXPECTED_STDIO_MESSAGE' });
  });
  it('does not convert wall timeout into a successful cancellation receipt', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.drain.resolve({ receipt: 'ERR RUN_3 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ reason: 'STDIO_TEARDOWN_FAILED' });
  });
  it('prioritizes unverified drain over malformed input and keeps only a safe cause', async () => {
    const f = fixture(['BAD\n']); await f.teardown;
    f.drain.reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'DRAIN_MISSING'));
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_OUTCOME_UNKNOWN', reason: 'DRAIN_MISSING',
      cause: { code: 'LOCAL_INVALID', reason: 'INVALID_NDJSON' } });
  });
  it('reports unverified drain even after a valid response', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.drain.reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'DRAIN_MISSING'));
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_OUTCOME_UNKNOWN', reason: 'DRAIN_MISSING' });
  });
  it('prioritizes unverified drain over caller abort', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.controller.abort();
    f.drain.reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'DRAIN_MISSING'));
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_OUTCOME_UNKNOWN', reason: 'DRAIN_MISSING',
      cause: { code: 'LOCAL_CANCELLED', reason: 'ABORTED' } });
  });
  it('prioritizes unverified drain over output limits', async () => {
    const f = fixture(['x'.repeat(100)], new AbortController(), 32); await f.teardown;
    f.drain.reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'DRAIN_MISSING'));
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_OUTCOME_UNKNOWN', reason: 'DRAIN_MISSING',
      cause: { code: 'LOCAL_LIMIT', reason: 'STDIO_OUTPUT_LIMIT' } });
  });
  it('retains LOCAL_INVALID when malformed input has a verified drain', async () => {
    const f = fixture(['BAD\n']); await f.teardown;
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_INVALID', reason: 'INVALID_NDJSON' });
  });
  it('does not put arbitrary callback messages into an unknown-drain cause', async () => {
    const drain = Promise.withResolvers<{ receipt: string; exit: number }>(), teardown = Promise.withResolvers<void>();
    const task = exchangeLocalStdio({ stdin: new PassThrough(), stdout: new PassThrough(), done: drain.promise, abort: () => teardown.resolve() },
      4096, signal(), async () => { throw new Error('untrusted callback diagnostic'); });
    void task.catch(() => {}); await teardown.promise;
    drain.reject(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'DRAIN_MISSING'));
    await expect(task).rejects.toMatchObject({ code: 'LOCAL_OUTCOME_UNKNOWN', reason: 'DRAIN_MISSING' });
    await expect(task.catch((error: unknown) => (error as Error).cause)).resolves.toBeUndefined();
  });
  it('rejects caller abort racing with a valid reply and cleanup', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.controller.abort();
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_CANCELLED', reason: 'ABORTED' });
  });
  it('retains an output limit violation after a valid reply', async () => {
    const f = fixture(['{"id":1}\n', 'x'.repeat(100)], new AbortController(), 32); await f.teardown;
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).rejects.toMatchObject({ code: 'LOCAL_LIMIT', reason: 'STDIO_OUTPUT_LIMIT' });
  });
  it('returns a clean reply only after the expected signal-cancel drain', async () => {
    const f = fixture(['{"id":1}\n']); await f.teardown;
    f.drain.resolve({ receipt: 'ERR RUN_5 0\n', exit: 125 });
    await expect(f.task).resolves.toEqual({ id: 1 });
  });
});

// This preflight can execute ONLY the bundled fixed C tests in empty namespaces
// and cgroups. Submitted Node code is not run until the entire gate passes.
// Native acceptance must use the build-pinned JS adapter, never source-mode
// identity or a test-injected qualification. An absent/stale build stays closed.
const compiled = await import(fileURLToPath(new URL('../dist/src/ai/local-sandbox.js', import.meta.url))).catch(() => undefined) as typeof import('../src/ai/local-sandbox.js') | undefined;
const NativeSandbox = compiled?.LOCAL_SANDBOX_POLICY_SHA256 === LOCAL_SANDBOX_POLICY_SHA256 ? compiled.LocalSandbox : LocalSandbox;
const qualification = await new NativeSandbox().probe();
const gate = qualification.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join(' ');
if (!qualification.qualified) console.info(`Local sandbox real-suite platform gate: ${gate}`);

describe('actual local platform qualification', () => {
  it('never treats a denied mandatory control as a qualified runner', () => {
    if (qualification.reasons.length) {
      expect(qualification.localEnabled).toBe(false);
      expect(qualification.qualified).toBe(false);
      expect(qualification.seccomp).toBe('unqualified');
      expect(gate).not.toBe('');
    } else {
      expect(qualification).toMatchObject({ qualified: true, localEnabled: true, cgroup: 'passed', namespaces: 'passed', seccomp: 'passed' });
    }
  });
  it('denies both script and stdio without a fallback when the platform gate fails', async () => {
    if (qualification.qualified) return;
    const spawn = vi.mocked(childProcess.spawn); spawn.mockClear(); const exchange = vi.fn();
    try {
      await expect(new LocalSandbox().execute(request(), [], signal())).rejects.toMatchObject({ code: 'LOCAL_UNAVAILABLE' });
      await expect(new LocalSandbox().withStdio(request(), [], signal(), exchange)).rejects.toMatchObject({ code: 'LOCAL_UNAVAILABLE' });
      expect(exchange).not.toHaveBeenCalled();
      // Delegation is tested before a binary is loaded or any input is prepared.
      if (qualification.cgroup === 'failed') expect(spawn).not.toHaveBeenCalled();
    } finally { spawn.mockClear(); }
  });
});

describe.skipIf(!qualification.qualified)(`real namespace/resource/escape suite${gate ? ` [SKIP: ${gate}]` : ''}`, () => {
  it('passes real parent-signal cancellation at daemon-ready and all three startup barriers', async () => {
    expect(compiled?.LOCAL_SANDBOX_BUILD_IDENTITY).toMatch(/^[a-f0-9]{64}:[a-f0-9]{64}$/);
    expect((await new NativeSandbox().probe()).qualified).toBe(true);
  }, 180_000);
  it('starts Node only in the private root and exports bounded regular files', async () => {
    const value = await new NativeSandbox().execute(request("require('node:fs').writeFileSync('/work/out/result.txt','ok'); console.log(process.cwd());"), [], signal());
    expect(value.exitCode).toBe(0); expect(value.stdout).toBe('/work\n');
    expect(value.files).toEqual([{ path: 'result.txt', contentBase64: 'b2s=' }]);
  }, 180_000);
  it('does not expose host environment, parent data, receipt descriptors or other processes', async () => {
    const code = `const fs=require('node:fs'), a=require('node:assert/strict');
      a.deepEqual(Object.keys(process.env).sort(),['HOME','LANG','PATH','TMPDIR','UV_THREADPOOL_SIZE']);
      for(const p of ['/home','/etc','/data','/sys','/dev','/old/home','/proc/1/fd/6','/proc/3/status']) a.throws(()=>fs.readFileSync(p));
      for(const fd of fs.readdirSync('/proc/self/fd')) { let target; try {target=fs.readlinkSync('/proc/self/fd/'+fd)}catch{continue}
        a.equal(target.startsWith('/home/'),false); a.equal(target.startsWith('/sys/'),false); }
      console.log('private');`;
    expect((await new NativeSandbox().execute(request(code), [], signal())).stdout).toBe('private\n');
  }, 180_000);
  it('denies remote, host loopback and private-namespace loopback sockets', async () => {
    const code = `const net=require('node:net'); let pending=3;
      for(const host of ['127.0.0.1','::1','1.1.1.1']) { const socket=net.connect({host,port:80});
        socket.on('connect',()=>process.exit(9)); socket.on('error',()=>{ if(!--pending) console.log('denied'); }); }`;
    const result = await new NativeSandbox().execute(request(code), [], signal());
    expect(result.exitCode).toBe(0); expect(result.stdout).toBe('denied\n');
  }, 180_000);
  it.each([
    "require('node:fs').symlinkSync('/usr/bin/node','/work/out/escape')",
    "const fs=require('node:fs'); fs.writeFileSync('/work/tmp/source','x'); fs.linkSync('/work/tmp/source','/work/out/escape')",
    "const fs=require('node:fs'); fs.rmdirSync('/work/out'); fs.symlinkSync('/usr/bin','/work/out')",
  ])('rejects symlink/hardlink exports without following host paths', async (code) => {
    await expect(new NativeSandbox().execute(request(code), [], signal())).rejects.toMatchObject({ code: 'LOCAL_LIMIT' });
  }, 180_000);
  it.each(["while(true){}", "while(true) process.stdout.write('x'.repeat(4096))"] )('kills and drains on CPU or output exhaustion', async (code) => {
    const input = request(code); input.limits.cpuMs = 250;
    await expect(new NativeSandbox().execute(input, [], signal())).rejects.toMatchObject({ code: 'LOCAL_LIMIT' });
    expect((await new NativeSandbox().probe()).qualified).toBe(true);
  }, 180_000);
  it('enforces the private tmpfs limit', async () => {
    const code = `const fs=require('node:fs'); const b=Buffer.alloc(4096); const fd=fs.openSync('/work/tmp/large','w');
      let denied=false; try { for(let n=0;n<2048;n++) fs.writeSync(fd,b); } catch { denied=true; }
      console.log(denied);`;
    expect((await new NativeSandbox().execute(request(code), [], signal())).stdout).toBe('true\n');
  }, 180_000);
  it('bounds one demand-started NDJSON exchange and awaits full teardown', async () => {
    const input = request("require('node:readline').createInterface({input:process.stdin}).on('line',line=>console.log(JSON.stringify({reply:JSON.parse(line)})))");
    const value = await new NativeSandbox().withStdio(input, [], signal(), (port) => port.request({ id: 1, method: 'ping' }));
    expect(value).toEqual({ reply: { id: 1, method: 'ping' } });
    expect((await new NativeSandbox().probe()).qualified).toBe(true);
  }, 180_000);
});
