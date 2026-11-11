import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs/promises', { spy: true });

// A standalone JS entry point is deliberately not compiled into the application.
const modulePath = '../scripts/check-resource-envelope.mjs';
const { LIMITS, parseOptions, probeLimits, createLimitGroup, readCgroup, evaluateGate, sampleProcessTree, createSampler, launchRuntime, runVariant,
  createStateInbox, boundedWait, measureScenario } = await import(modulePath);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { vi.useRealTimers(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function directory() {
  const path = await mkdtemp('/tmp/kilo/resource-envelope-test-');
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const charged = () => ({ cpuMax: '100000 100000', memoryMax: 256 * 1024 ** 2, peak: 150 * 1024 ** 2, swap: 0, events: { oom: 0, oom_kill: 0, max: 0 } });
const sampling = () => ({ complete: true, errors: 0, exhausted: false, peakRss: 20 * 1024 ** 2 });

describe('cgroup probe diagnostics', () => {
  function fixture(options: { readError?: string; writeError?: string; available?: string; enabled?: string; deniedFile?: string } = {}) {
    const parent = '/sys/fs/cgroup/diagnostic-fixture';
    const failure = (code: string) => Object.assign(new Error('PRIVATE_CGROUP_DETAIL'), { code, path: '/private/target' });
    vi.spyOn(fs, 'realpath').mockResolvedValue(parent);
    vi.spyOn(fs, 'statfs').mockResolvedValue({ type: 0x63677270 } as Awaited<ReturnType<typeof fs.statfs>>);
    vi.spyOn(fs, 'access').mockImplementation(async (_path, mode) => {
      if (mode === (constants.R_OK | constants.X_OK) && options.readError) throw failure(options.readError);
      if (mode === (constants.W_OK | constants.X_OK) && options.writeError) throw failure(options.writeError);
    });
    vi.spyOn(fs, 'readFile').mockImplementation(async path => {
      if (String(path) === '/proc/self/cgroup') return '0::/diagnostic-fixture\n';
      if (String(path) === `${parent}/${options.deniedFile}`) throw failure('EACCES');
      if (String(path) === `${parent}/cgroup.controllers`) return options.available ?? 'cpuset cpu io memory pids';
      if (String(path) === `${parent}/cgroup.subtree_control`) return options.enabled ?? 'cpu memory pids';
      throw failure('ENOENT');
    });
    vi.spyOn(fs, 'mkdir').mockRejectedValue(new Error('No cgroup writes allowed'));
    vi.spyOn(fs, 'writeFile').mockRejectedValue(new Error('No controller writes allowed'));
    return parent;
  }
  afterEach(() => {
    try {
      expect(fs.mkdir).not.toHaveBeenCalled();
      expect(fs.writeFile).not.toHaveBeenCalled();
    } finally { vi.resetAllMocks(); vi.restoreAllMocks(); }
  });
  it.each(['EACCES', 'EROFS'])('retains both %s write refusal and an empty enabled subtree', async writeError => {
    const parent = fixture({ writeError, enabled: '' });
    const result = await probeLimits();
    expect(result).toMatchObject({ available: false, parent, checks: {
      readAccess: { ok: true }, writeAccess: { ok: false, error: writeError },
      availableControllers: { ok: true, readable: true, present: ['cpu', 'memory', 'pids'], missing: [] },
      enabledControllers: { ok: false, readable: true, present: [], missing: ['cpu', 'memory', 'pids'] },
    } });
    expect(result.reason).toContain(`Parent write/search access failed: ${writeError}`);
    expect(result.reason).toContain('Required controllers not enabled for children: cpu, memory, pids');
    expect(await createLimitGroup(result)).toEqual({ applied: false, reason: result.reason });
  });
  it('does not accept enabled controllers without write/search permission', async () => {
    fixture({ writeError: 'EACCES' });
    const result = await probeLimits();
    expect(result).toMatchObject({ available: false, checks: { writeAccess: { ok: false, error: 'EACCES' }, enabledControllers: { ok: true } } });
    expect(result.reason).not.toContain('not enabled');
    expect(fs.access).toHaveBeenCalledWith(result.parent, constants.W_OK | constants.X_OK);
  });
  it('checks read/search access independently and never exposes error payloads', async () => {
    fixture({ readError: 'PRIVATE DETAIL' });
    const result = await probeLimits();
    expect(result).toMatchObject({ available: false, checks: { readAccess: { ok: false, error: 'HARNESS_ERROR' },
      writeAccess: { ok: true }, availableControllers: { ok: true }, enabledControllers: { ok: true } } });
    expect(JSON.stringify(result)).not.toMatch(/PRIVATE|\/private\//);
  });
  it('denies writable but unavailable or undelegated required controllers', async () => {
    fixture({ available: 'cpu pids OTHER_PRIVATE_VALUE', enabled: 'cpu' });
    const result = await probeLimits();
    expect(result).toMatchObject({ available: false, checks: { writeAccess: { ok: true },
      availableControllers: { ok: false, present: ['cpu', 'pids'], missing: ['memory'] },
      enabledControllers: { ok: false, present: ['cpu'], missing: ['memory', 'pids'] } } });
    expect(result.reason).toContain('Required controllers unavailable: memory');
    expect(result.reason).toContain('Required controllers not enabled for children: memory, pids');
    expect(JSON.stringify(result)).not.toContain('OTHER_PRIVATE_VALUE');
  });
  it.each(['cgroup.controllers', 'cgroup.subtree_control'])('retains independent observations when %s is unreadable', async deniedFile => {
    fixture({ deniedFile });
    const result = await probeLimits();
    const denied = deniedFile === 'cgroup.controllers' ? 'availableControllers' : 'enabledControllers';
    const readable = deniedFile === 'cgroup.controllers' ? 'enabledControllers' : 'availableControllers';
    expect(result).toMatchObject({ available: false, checks: { [denied]: { ok: false, readable: false, error: 'EACCES' }, [readable]: { ok: true } } });
    expect(result.reason).toContain(`${deniedFile} read failed: EACCES`);
    expect(result.checks.writeAccess).toEqual({ ok: true });
  });
  it.each(['available', 'enabled'] as const)('requires %s controllers even when all other checks pass', async name => {
    fixture({ [name]: '' });
    const result = await probeLimits();
    expect(result.available).toBe(false);
    expect(result.checks.readAccess.ok).toBe(true);
    expect(result.checks.writeAccess.ok).toBe(true);
    expect(result.checks[name === 'available' ? 'availableControllers' : 'enabledControllers'].ok).toBe(false);
    expect(result.checks[name === 'available' ? 'enabledControllers' : 'availableControllers'].ok).toBe(true);
  });
  it('denies absent unified membership before checking a parent or creating a group', async () => {
    fixture(); vi.mocked(fs.readFile).mockResolvedValueOnce('1:memory:/fixture\n');
    expect(await probeLimits()).toMatchObject({ available: false, reason: 'No unified cgroup v2 membership' });
    expect(fs.realpath).not.toHaveBeenCalled();
    expect(fs.statfs).not.toHaveBeenCalled();
  });
  it('identifies a denied parent resolution without claiming a missing group or tool approval', async () => {
    fixture(); vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error('PRIVATE'), { code: 'EACCES' }));
    expect(await probeLimits()).toEqual({ available: false, reason: 'Cgroup parent resolution check failed: EACCES' });
  });
  it('reports only candidate delegation when every independent check passes', async () => {
    fixture();
    expect(await probeLimits()).toMatchObject({ available: true, checks: { readAccess: { ok: true }, writeAccess: { ok: true },
      availableControllers: { ok: true }, enabledControllers: { ok: true } }, reason: 'Candidate delegation; child limit creation/readback still required' });
  });
});

describe('whole-runtime resource gate', () => {
  it('never substitutes low observed RSS/heap for an enforced cgroup limit', () => {
    expect(evaluateGate({ limited: false, cgroup: null, completed: true, sampling: sampling() })).toMatchObject({ qualified: false, status: 'unqualified' });
    expect(evaluateGate({ limited: false, cgroup: charged(), completed: true, sampling: sampling() }).qualified).toBe(false);
  });
  it('requires the 20 percent margin on whole-cgroup peak, not latest memory or heap', () => {
    const valid = { limited: true, cgroup: charged(), completed: true, sampling: sampling() };
    expect(evaluateGate(valid)).toMatchObject({ qualified: true, budgetBytes: Math.floor(LIMITS.memoryBytes * 0.8) });
    expect(evaluateGate({ ...valid, cgroup: { ...charged(), current: 1, peak: 220 * 1024 ** 2 } }).qualified).toBe(false);
    expect(evaluateGate({ ...valid, cgroup: { ...charged(), peak: null } }).qualified).toBe(false);
    expect(evaluateGate({ ...valid, cgroup: { ...charged(), cpuMax: 'max 100000' } }).qualified).toBe(false);
    expect(evaluateGate({ ...valid, cgroup: { ...charged(), memoryMax: 512 * 1024 ** 2 } }).qualified).toBe(false);
    expect(evaluateGate({ ...valid, cgroup: { ...charged(), swap: 1 } }).qualified).toBe(false);
  });
  it('refuses failures, OOM events, incomplete sampling and missing integration scenarios', () => {
    const valid = { limited: true, cgroup: charged(), completed: true, sampling: sampling() };
    for (const change of [{ completed: false }, { cgroup: { ...charged(), events: { oom_kill: 1 } } },
      { sampling: { ...sampling(), errors: 1 } }, { sampling: { ...sampling(), exhausted: true } },
      { sampling: { ...sampling(), complete: false } }, { missing: ['sandbox unqualified'] }]) {
      expect(evaluateGate({ ...valid, ...change }).qualified).toBe(false);
    }
  });
  it('does not mistake an ordinary writable directory for cgroup delegation', async () => {
    const path = await directory();
    expect(await probeLimits(path)).toMatchObject({ available: false });
    expect(await createLimitGroup({ available: false, reason: 'No delegation' })).toEqual({ applied: false, reason: 'No delegation' });
    expect(await readdir(path)).toEqual([]);
  });
  it('strict CLI refuses before launching the application and returns nonzero', async () => {
    const path = await directory();
    const child = spawn(process.execPath, [resolve('scripts/check-resource-envelope.mjs'), '--require-limit', `--cgroup-parent=${path}`],
      { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.resume();
    const [code] = await once(child, 'close');
    expect(code).toBe(2);
    expect(JSON.parse(output)).toMatchObject({ qualified: false, status: 'unqualified', measured: [] });
    expect(await readdir(path)).toEqual([]);
  });
  it('bounds options and rejects implicit production environment/configuration options', () => {
    expect(parseOptions(['--http=on', '--iterations=9', '--require-limit'])).toMatchObject({ http: 'on', iterations: 9, requireLimit: true });
    for (const arg of ['--iterations=0', '--iterations=100', '--http=maybe', '--env=.env', '--data=data', '--docker', '--limit=512']) {
      expect(() => parseOptions([arg])).toThrow();
    }
  });
});

describe('bounded whole-process accounting', () => {
  it('reads kernel charged peak, filesystem cache and CPU independently from process RSS', async () => {
    const path = await directory();
    for (const [name, value] of Object.entries({ 'memory.current': '8000', 'memory.peak': '9000', 'memory.swap.current': '0',
      'memory.stat': 'anon 3000\nfile 4000\nkernel 1000', 'memory.events': 'oom 0\noom_kill 0\nmax 0',
      'cpu.stat': 'usage_usec 123\nthrottled_usec 45', 'cpu.max': '100000 100000', 'memory.max': '268435456' })) await writeFile(join(path, name), value);
    expect(await readCgroup(path)).toMatchObject({ current: 8000, peak: 9000, swap: 0, stat: { anon: 3000, file: 4000, kernel: 1000 },
      cpu: { usage_usec: 123, throttled_usec: 45 }, memoryMax: LIMITS.memoryBytes });
  });
  it('includes recursive children launched by non-main threads and flags truncation', async () => {
    const proc = await directory();
    for (const [pid, rss, tids] of [[10, 10, [10, 11]], [20, 20, [20]], [30, 30, [30]]] as const) {
      await mkdir(join(proc, String(pid), 'task'), { recursive: true });
      await writeFile(join(proc, String(pid), 'status'), `Name:\tfixture\nVmRSS:\t${rss} kB\n`);
      await writeFile(join(proc, String(pid), 'stat'), `${pid} (fixture with spaces) S ${Array(18).fill('0').join(' ')} ${pid}`);
      for (const tid of tids) {
        await mkdir(join(proc, String(pid), 'task', String(tid)));
        await writeFile(join(proc, String(pid), 'task', String(tid), 'children'), tid === 11 ? '20' : pid === 20 ? '30' : '');
      }
    }
    expect(await sampleProcessTree(10, { proc })).toMatchObject({ complete: true, rss: 60 * 1024,
      processes: [{ pid: 10 }, { pid: 20 }, { pid: 30 }] });
    expect(await sampleProcessTree(10, { proc, maxProcesses: 2 })).toMatchObject({ complete: false, rss: 30 * 1024 });
  });
  it('accounts for a real descendant allocation and drains both processes', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { spawn } from 'node:child_process';
      const child = spawn(process.execPath, ['-e', 'globalThis.memory = Buffer.alloc(8*1024*1024,1); process.send("ready"); process.on("message", () => process.disconnect());'], {stdio:['ignore','ignore','ignore','ipc']});
      child.on('message', () => process.send({pid:child.pid}));
      process.on('message', () => child.send('stop'));
      child.on('close', () => process.disconnect());
    `], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
    const closed = once(child, 'close');
    const [ready] = await once(child, 'message') as [{ pid: number }];
    const identity = await readFile(`/proc/${ready.pid}/stat`, 'utf8');
    const startTime = identity.slice(identity.lastIndexOf(')') + 2).split(/\s+/)[19];
    cleanups.push(async () => {
      if (child.exitCode === null) child.kill('SIGKILL');
      try {
        const current = await readFile(`/proc/${ready.pid}/stat`, 'utf8');
        if (current.slice(current.lastIndexOf(')') + 2).split(/\s+/)[19] === startTime) process.kill(ready.pid, 'SIGKILL');
      } catch { /* Already reaped. Never signal a reused PID. */ }
      await closed;
    });
    const tree = await sampleProcessTree(child.pid);
    expect(tree.complete).toBe(true);
    expect(tree.processes.map((item: { pid: number }) => item.pid)).toContain(ready.pid);
    expect(tree.rss).toBeGreaterThan(tree.processes[0].rss + 8 * 1024 ** 2);
    child.send('stop'); await closed;
    expect(await sampleProcessTree(child.pid)).toMatchObject({ processes: [], rss: 0 });
    expect(() => process.kill(ready.pid, 0)).toThrow();
  });
  it('retains a fixed tail while preserving all-sample peaks and stops at a fixed cap', async () => {
    vi.useFakeTimers();
    let count = 0;
    const sample = vi.fn(async () => ({ rss: ++count === 1 ? 999 : count, complete: true, processes: [{ pid: 1 }, { pid: 2 }], cgroup: { peak: 1234 } }));
    const sampler = createSampler(sample, { intervalMs: 10, maxSamples: 4, retained: 2 });
    await vi.advanceTimersByTimeAsync(1000);
    const summary = await sampler.stop();
    expect(sample).toHaveBeenCalledTimes(4);
    expect(summary).toMatchObject({ samples: 4, dropped: 2, exhausted: true, peakRss: 999, peakCharged: 1234, peakChildren: 1 });
    expect(summary.tail).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('never overlaps samples and stop awaits the actual in-flight sample', async () => {
    vi.useFakeTimers();
    const gate = Promise.withResolvers<{ rss: number }>();
    const sample = vi.fn(() => gate.promise);
    const sampler = createSampler(sample, { intervalMs: 10 });
    await vi.advanceTimersByTimeAsync(500);
    expect(sample).toHaveBeenCalledOnce();
    let stopped = false; const stop = sampler.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    gate.resolve({ rss: 1 }); await stop;
    expect(vi.getTimerCount()).toBe(0);
  });
  it('marks sampler errors incomplete rather than reporting a low peak as success', async () => {
    const sampler = createSampler(async () => { throw new Error('unreadable proc'); });
    expect(await sampler.stop()).toMatchObject({ complete: false, errors: 1 });
    expect(() => createSampler(async () => ({}), { retained: 999999 })).toThrow();
  });
});

describe('fixture lifecycle isolation', () => {
  it('uses only fixed heap flags without inherited credentials, flags, poller or production cwd', async () => {
    const path = await directory();
    vi.stubEnv('MISAKA_BOT_TOKEN', 'SHOULD_NOT_INHERIT'); vi.stubEnv('NODE_OPTIONS', '--trace-warnings');
    const child = launchRuntime(path, { applied: false });
    const closed = once(child, 'close'); child.stdout.resume(); child.stderr.resume();
    cleanups.push(async () => { vi.unstubAllEnvs(); if (child.exitCode === null) child.kill('SIGKILL'); await closed; });
    const environment = await readFile(`/proc/${child.pid}/environ`, 'utf8');
    expect(environment).not.toContain('SHOULD_NOT_INHERIT');
    expect(environment).not.toContain('--trace-warnings');
    expect(environment.split('\0').filter(entry => entry.startsWith('NODE_OPTIONS=')))
      .toEqual(['NODE_OPTIONS=--max-old-space-size=96 --max-semi-space-size=4']);
    child.send({ id: 1, op: 'stop' }); await closed;
    expect(await readdir(path)).toEqual([]);
  });
  it('failed limit attach cleans only its newly-owned fixture directory', async () => {
    const path = await directory();
    await writeFile(join(path, 'preserve-existing-state'), 'must remain');
    const result = await runVariant({ base: path, media: false, group: { applied: true, path: join(path, 'missing-group') } });
    expect(result.completed).toBe(false);
    expect(result.gate.qualified).toBe(false);
    expect(await readdir(path)).toEqual(['preserve-existing-state']);
    expect(await readFile(join(path, 'preserve-existing-state'), 'utf8')).toBe('must remain');
  });
});

describe('bounded event-driven AI fixture observations', () => {
  it('waits for real state transitions without polling or retaining checkpoint payloads', async () => {
    vi.useFakeTimers();
    const inbox = createStateInbox(2);
    const completed = inbox.wait('run-1', ['completed']);
    inbox.publish('run-1', 'running'); expect(inbox.pending).toBe(1);
    inbox.publish('run-1', 'completed'); expect(await completed).toBe('completed');
    expect(await inbox.wait('run-1', ['completed'])).toBe('completed');
    expect(inbox.size).toBe(1); expect(inbox.pending).toBe(0); expect(vi.getTimerCount()).toBe(0);
    expect(() => inbox.publish('run-2', { state: 'completed', continuation: 'PRIVATE' })).toThrow();
    inbox.close();
  });
  it('bounds retained runs and pending observations and cleans timers on close', async () => {
    vi.useFakeTimers(); const inbox = createStateInbox(2);
    inbox.publish('one', 'running'); inbox.publish('two', 'queued');
    expect(() => inbox.publish('three', 'queued')).toThrow();
    const pending = Array.from({ length: 32 }, (_, index) => inbox.wait(`pending-${index}`, ['completed']).catch(() => 'closed'));
    await expect(inbox.wait('overflow', ['completed'])).rejects.toThrow();
    inbox.close(); expect(await Promise.all(pending)).toEqual(Array(32).fill('closed'));
    expect(inbox.size).toBe(0); expect(inbox.pending).toBe(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('fails a missing transition explicitly instead of polling indefinitely', async () => {
    vi.useFakeTimers(); const inbox = createStateInbox();
    const failure = inbox.wait('missing', ['completed'], 100).catch((error: { code: string }) => error.code);
    await vi.advanceTimersByTimeAsync(100);
    expect(await failure).toBe('SCENARIO_TIMEOUT'); expect(inbox.pending).toBe(0); inbox.close();
    const hook = boundedWait(new Promise(() => {}), 100).catch((error: { code: string }) => error.code);
    await vi.advanceTimersByTimeAsync(100); expect(await hook).toBe('SCENARIO_TIMEOUT'); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps fixture failures explicitly unmeasured and does not include error payloads', async () => {
    expect(await measureScenario('fixture', async () => ({ calls: 3 }))).toMatchObject({ status: 'measured', details: { calls: 3 } });
    const result = await measureScenario('fixture', async () => { throw Object.assign(new Error('PRIVATE_TEST_VALUE'), { code: 'CAPACITY' }); });
    expect(result).toMatchObject({ status: 'unmeasured', error: 'CAPACITY' });
    expect(JSON.stringify(result)).not.toContain('PRIVATE_TEST_VALUE');
    expect(evaluateGate({ limited: true, cgroup: charged(), completed: true, sampling: sampling(), missing: [result.name] }).qualified).toBe(false);
  });
});
