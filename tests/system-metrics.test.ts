import { afterEach, describe, expect, it, vi } from 'vitest';
import { systemMetricsSchema } from '../shared/schemas/system-metrics.js';
import { SystemMetrics, cgroupLocation } from '../src/system-metrics.js';
import { coreFixture, invocation } from './support/core.js';

const MiB = 1024 * 1024;
const mount = '/sys/fs/cgroup';
const leaf = `${mount}/app/worker`;
const parent = `${mount}/app`;
const membership = '0::/app/worker\n';
const mountInfo = '25 20 0:25 / /sys/fs/cgroup rw,nosuid,nodev,noexec - cgroup2 cgroup rw\n';
const snapshots: SystemMetrics[] = [];

function fixture() {
  let now = 1_800_000_000_000;
  let monotonicMs = 1000;
  const host = { logicalCpus: 8 as number | null, availableCpus: 2, idle: 1000, total: 2000,
    loadAverage: [1, 0.5, 0.25] as [number, number, number], memoryTotalBytes: 1024 * MiB, memoryFreeBytes: 100 * MiB, uptimeSeconds: 20_000 };
  const process = { cpuMicros: 100_000, memory: { rss: 32 * MiB, heapUsed: 8 * MiB, heapTotal: 16 * MiB, external: MiB, arrayBuffers: 1000 },
    heapLimitBytes: 108 * MiB, uptimeSeconds: 12 };
  const files = new Map<string, string>([
    ['/proc/self/cgroup', membership], ['/proc/self/mountinfo', mountInfo],
    ['/proc/meminfo', 'MemTotal: 1048576 kB\nMemFree: 102400 kB\nMemAvailable: 524288 kB\n'],
  ]);
  for (const path of [leaf, parent, mount]) {
    for (const [name, content] of Object.entries({ 'memory.max': 'max', 'memory.current': `${64 * MiB}`, 'memory.peak': `${80 * MiB}`,
      'memory.swap.max': 'max', 'memory.swap.current': '0', 'cpu.max': 'max 100000', 'cpu.stat': 'usage_usec 1000000\n', 'pids.max': 'max', 'pids.current': '6' })) files.set(`${path}/${name}`, content);
  }
  files.set(`${leaf}/memory.max`, `${512 * MiB}`); files.set(`${parent}/memory.max`, `${256 * MiB}`);
  files.set(`${leaf}/cpu.max`, '200000 100000'); files.set(`${parent}/cpu.max`, '100000 100000');
  files.set(`${leaf}/pids.max`, '128'); files.set(`${parent}/pids.max`, '64');
  files.set(`${parent}/memory.current`, `${128 * MiB}`); files.set(`${parent}/memory.peak`, `${160 * MiB}`);
  files.set(`${parent}/pids.current`, '12');
  const read = vi.fn(async (path: string, _max: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    if (!files.has(path)) throw Object.assign(new Error('private path must not be rendered'), { code: 'ENOENT' });
    return files.get(path)!;
  });
  const metrics = new SystemMetrics({ platform: 'linux', read, host: () => ({ ...host }), process: () => ({ ...process, memory: { ...process.memory } }),
    clock: () => ({ now, monotonicMs }) });
  snapshots.push(metrics);
  return { metrics, host, process, files, read, tick: (ms = 5000) => { now += ms; monotonicMs += ms; } };
}

afterEach(async () => { for (const metrics of snapshots.splice(0)) await metrics.stop(); vi.useRealTimers(); });

describe('safe resource snapshots', () => {
  it('separates system, process and matching ancestor-group counters without exposing paths', async () => {
    const f = fixture();
    await f.metrics.sample();
    const first = f.metrics.snapshot()!;
    expect(first.intervalSeconds).toBeNull();
    expect(first.process.cpuPercent).toBeNull();
    expect(first.system.cpuPercent).toBeNull();
    expect(first.cgroup.cpuPercent).toBeNull();
    expect(first.system).toMatchObject({ logicalCpus: 8, availableCpus: 2, memoryTotalBytes: 1024 * MiB, memoryAvailableBytes: 512 * MiB });
    expect(first.process).toMatchObject({ rssBytes: 32 * MiB, heapLimitBytes: 108 * MiB });
    expect(first.cgroup).toMatchObject({ version: 'v2', state: 'available', cpuQuotaCores: 1, cpuLimit: 'limited', cpuScope: 'ancestor',
      memoryCurrentBytes: 128 * MiB, memoryLimitBytes: 256 * MiB, memoryPeakBytes: 160 * MiB, memoryScope: 'ancestor', pidsLimit: 64, pidsCurrent: 12 });
    expect(JSON.stringify(first)).not.toMatch(/\/proc|\/sys|worker|private path|hostname|filePath|pid"/);
    expect(systemMetricsSchema.safeParse(first).success).toBe(true);
    f.tick(); f.process.cpuMicros += 2_500_000; f.host.total += 1000; f.host.idle += 800;
    f.files.set(`${parent}/cpu.stat`, 'usage_usec 4750000\n');
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ intervalSeconds: 5, process: { cpuPercent: 50 }, system: { cpuPercent: 20 }, cgroup: { cpuPercent: 75 } });
  });

  it('does not normalize process or cgroup CPU to a misleading 100 percent maximum', async () => {
    const f = fixture(); await f.metrics.sample(); f.tick();
    f.process.cpuMicros += 12_500_000; f.files.set(`${parent}/cpu.stat`, 'usage_usec 16000000\n');
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.process.cpuPercent).toBe(250);
    expect(f.metrics.snapshot()?.cgroup.cpuPercent).toBe(300);
    expect(f.metrics.snapshot()?.cgroup.cpuQuotaCores).toBe(1);
  });

  it('keeps a missing CPU inventory unknown and does not treat recovered lifetime counters as an interval', async () => {
    const f = fixture(); f.host.logicalCpus = null; f.host.idle = 0; f.host.total = 0;
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.system).toMatchObject({ logicalCpus: null, availableCpus: 2, cpuPercent: null });
    f.tick(); f.host.logicalCpus = 1; f.host.idle = 100_000; f.host.total = 125_000;
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.system.cpuPercent).toBeNull();
    f.tick(); f.host.idle += 500; f.host.total += 1000;
    await f.metrics.sample(); expect(f.metrics.snapshot()?.system.cpuPercent).toBe(50);
  });

  it('uses the group counter timestamp when asynchronous read latency changes', async () => {
    const f = fixture(); await f.metrics.sample(); f.tick(); f.process.cpuMicros += 5_000_000;
    f.read.mockImplementation(async (path, _max, signal) => {
      signal.throwIfAborted();
      if (path === `${parent}/cpu.stat`) { f.tick(500); return 'usage_usec 6500000\n'; }
      if (!f.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return f.files.get(path)!;
    });
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ intervalSeconds: 5, process: { cpuPercent: 100 },
      cgroup: { cpuPercent: 100, cpuIntervalSeconds: 5.5 } });
  });

  it('returns useful process/system counters when proc and cgroup reads are denied', async () => {
    const f = fixture(); f.read.mockRejectedValue(Object.assign(new Error('PRIVATE_CGROUP_PATH'), { code: 'EACCES' }));
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ system: { memoryAvailableBytes: null }, process: { rssBytes: 32 * MiB },
      cgroup: { version: 'unavailable', state: 'unavailable', cpuQuotaCores: null, memoryCurrentBytes: null, memoryLimit: 'unavailable' } });
    expect(JSON.stringify(f.metrics.snapshot())).not.toContain('PRIVATE_CGROUP_PATH');
  });

  it('distinguishes unlimited from missing bounds and preserves a legitimate zero counter', async () => {
    const f = fixture();
    for (const path of [leaf, parent, mount]) {
      f.files.set(`${path}/memory.max`, 'max'); f.files.set(`${path}/cpu.max`, 'max 100000'); f.files.set(`${path}/pids.max`, 'max');
    }
    f.files.set(`${leaf}/memory.current`, '0'); f.files.set(`${leaf}/pids.current`, '0');
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.cgroup).toMatchObject({ memoryLimitBytes: null, memoryLimit: 'unlimited', memoryCurrentBytes: 0,
      pidsLimit: null, pidsLimitState: 'unlimited', pidsCurrent: 0, cpuQuotaCores: null, cpuLimit: 'unlimited', cpuScope: 'current' });
    f.files.delete(`${parent}/cpu.max`); f.tick(); await f.metrics.sample();
    expect(f.metrics.snapshot()?.cgroup).toMatchObject({ state: 'partial', cpuQuotaCores: null, cpuLimit: 'unavailable' });
  });

  it('recognizes absent root max files without treating root permission denial as unlimited', async () => {
    const f = fixture();
    for (const path of [leaf, parent]) {
      f.files.set(`${path}/memory.max`, 'max'); f.files.set(`${path}/cpu.max`, 'max 100000'); f.files.set(`${path}/pids.max`, 'max');
    }
    for (const name of ['memory.max', 'cpu.max', 'pids.max']) f.files.delete(`${mount}/${name}`);
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.cgroup).toMatchObject({ cpuLimit: 'unlimited', memoryLimit: 'unlimited', pidsLimitState: 'unlimited' });
    f.read.mockImplementation(async (path, _max, signal) => {
      signal.throwIfAborted();
      if (path === `${mount}/cpu.max`) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      if (!f.files.has(path)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return f.files.get(path)!;
    });
    f.tick(); await f.metrics.sample();
    expect(f.metrics.snapshot()?.cgroup).toMatchObject({ cpuLimit: 'unavailable', cpuQuotaCores: null, state: 'partial' });
  });

  it('does not turn malformed or out-of-range values into zero or unlimited', async () => {
    const f = fixture();
    for (const path of [leaf, parent, mount]) {
      f.files.set(`${path}/memory.max`, '9223372036854771712'); f.files.set(`${path}/cpu.max`, '100000 0'); f.files.set(`${path}/pids.max`, '-1');
    }
    f.files.set(`${leaf}/memory.current`, '-1'); f.files.set(`${leaf}/cpu.stat`, 'usage_usec NaN');
    f.files.set('/proc/meminfo', 'MemAvailable: 9999999999999999999999999999999 kB');
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ system: { memoryAvailableBytes: null }, cgroup: { cpuPercent: null,
      cpuLimit: 'unavailable', cpuQuotaCores: null, memoryLimitBytes: null, memoryCurrentBytes: null, pidsLimit: null } });
  });

  it('samples swap from its own limiting group rather than reusing a different memory scope', async () => {
    const f = fixture();
    f.files.set(`${leaf}/memory.swap.max`, '0'); f.files.set(`${leaf}/memory.swap.current`, '0');
    f.files.set(`${parent}/memory.swap.max`, `${64 * MiB}`); f.files.set(`${parent}/memory.swap.current`, `${12 * MiB}`);
    await f.metrics.sample();
    expect(f.metrics.snapshot()?.cgroup).toMatchObject({ memoryScope: 'ancestor', memoryCurrentBytes: 128 * MiB,
      swapLimit: 'limited', swapLimitBytes: 0, swapCurrentBytes: 0 });
  });

  it('resets baselines on counter rollback, CPU topology changes and cgroup scope changes', async () => {
    const f = fixture(); await f.metrics.sample(); f.tick();
    f.process.cpuMicros = 0; f.host.total = 1; f.host.idle = 0; f.files.set(`${parent}/cpu.stat`, 'usage_usec 0');
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ process: { cpuPercent: null }, system: { cpuPercent: null }, cgroup: { cpuPercent: null } });
    f.tick(); f.process.cpuMicros += 1_000_000; f.host.logicalCpus = 4; f.host.total += 100; f.host.idle += 20;
    f.files.set(`${leaf}/cpu.max`, '25000 100000'); f.files.set(`${leaf}/cpu.stat`, 'usage_usec 100000000');
    await f.metrics.sample();
    expect(f.metrics.snapshot()).toMatchObject({ process: { cpuPercent: 20 }, system: { cpuPercent: null },
      cgroup: { cpuPercent: null, cpuQuotaCores: 0.25, cpuScope: 'current' } });
  });

  it('keeps unsupported cgroup v1 and non-Linux metrics explicitly unavailable', async () => {
    const f = fixture(); f.files.set('/proc/self/cgroup', '2:cpu:/old\n3:memory:/old\n');
    await f.metrics.sample(); expect(f.metrics.snapshot()?.cgroup).toMatchObject({ version: 'v1', state: 'unavailable', memoryCurrentBytes: null });
    const read = vi.fn();
    const other = new SystemMetrics({ platform: 'win32', read, host: () => ({ ...f.host, loadAverage: null }), process: () => f.process });
    snapshots.push(other); await other.sample();
    expect(read).not.toHaveBeenCalled();
    expect(other.snapshot()).toMatchObject({ cgroup: { version: 'unavailable' }, system: { memoryAvailableBytes: null, loadAverage: null } });
  });

  it('bounds kernel reads and ancestor traversal and never reads another process or environment', async () => {
    const f = fixture();
    const deep = `/${Array.from({ length: 30 }, (_, i) => `level${i}`).join('/')}`;
    f.files.set('/proc/self/cgroup', `0::${deep}\n`);
    await f.metrics.sample();
    expect(f.read.mock.calls.length).toBeLessThanOrEqual(72);
    for (const [path, max] of f.read.mock.calls) {
      expect(path).toMatch(/^(?:\/proc\/(?:meminfo|self\/(?:mountinfo|cgroup))|\/sys\/fs\/cgroup\/)/);
      expect(path).not.toMatch(/environ|cmdline|\/proc\/\d|\.env/);
      expect(max).toBeLessThanOrEqual(65536);
    }
    expect(f.metrics.snapshot()?.cgroup.state).not.toBe('available');
  });

  it('keeps cached snapshots detached and validates the strictly serializable contract', async () => {
    const f = fixture(); await f.metrics.sample();
    const calls = f.read.mock.calls.length;
    const first = f.metrics.snapshot()!; first.system.memoryTotalBytes = 1;
    for (let index = 0; index < 100; index++) expect(f.metrics.snapshot()!.system.memoryTotalBytes).toBe(1024 * MiB);
    expect(f.read).toHaveBeenCalledTimes(calls);
    expect(systemMetricsSchema.safeParse({ ...first, environment: { secret: 'not-allowed' } }).success).toBe(false);
    expect(systemMetricsSchema.safeParse({ ...first, process: { ...first.process, cpuPercent: Infinity } }).success).toBe(false);
  });

  it('uses one low-frequency timer and drains a read before stopping', async () => {
    vi.useFakeTimers(); const f = fixture();
    await f.metrics.start(); const first = f.read.mock.calls.length;
    f.tick(); await vi.advanceTimersByTimeAsync(5000); expect(f.read.mock.calls.length).toBe(first * 2);
    const release = Promise.withResolvers<string>(); let pendingSignal: AbortSignal | undefined;
    f.read.mockImplementationOnce(async (_path, _max, signal) => { pendingSignal = signal; return release.promise; });
    const sample = f.metrics.sample();
    expect(f.metrics.sample()).toBe(sample);
    let stopped = false; const stopping = f.metrics.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); expect(pendingSignal?.aborted).toBe(true);
    release.resolve(''); await stopping;
    const count = f.read.mock.calls.length; await vi.advanceTimersByTimeAsync(30_000);
    expect(f.read).toHaveBeenCalledTimes(count); expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the extended status private and superadmin-only before collecting it', async () => {
    const f = await coreFixture(); const samples = fixture(); await samples.metrics.sample();
    const base = f.services.status(); const getter = vi.fn(() => ({ ...base, resources: samples.metrics.snapshot() }));
    f.services.status = getter;
    try {
      for (const context of [invocation({ actorId: 3, chat: { id: 3, type: 'private' } }), invocation({ chat: { id: -100, type: 'supergroup' } }),
        invocation({ source: 'ai' })]) expect(await f.executor.execute(context, 'core.status', {})).toHaveProperty('error');
      expect(getter).not.toHaveBeenCalled();
      expect(await f.executor.execute(invocation(), 'core.status', { path: '/proc/self/environ' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
      expect(getter).not.toHaveBeenCalled();
      expect(await f.executor.execute(invocation(), 'core.status', {})).toMatchObject({ status: 'succeeded', data: { resources: { process: { rssBytes: 32 * MiB } } } });
    } finally { await f.close(); }
  });
});

describe('cgroup mount mapping', () => {
  it.each([
    ['0::/app/worker\n', mountInfo, leaf],
    ['0::/tenant/worker\n', mountInfo.replace(' / /sys/', ' /tenant /sys/'), `${mount}/worker`],
    ['0::/\n', mountInfo, mount],
    ['0::/nested\n', mountInfo, `${mount}/nested`],
  ])('maps full and namespaced memberships without returning host paths in the DTO', (member, mounts, path) => {
    expect(cgroupLocation(member, mounts)?.current).toBe(path);
  });
  it('ignores unrelated bind roots and prefers the widest proven view of the same hierarchy', () => {
    const wrong = '24 20 0:25 /other /cg/other rw - cgroup2 cgroup rw\n';
    const narrower = '26 20 0:25 /app /cg/app rw - cgroup2 cgroup rw\n';
    expect(cgroupLocation(membership, wrong)).toBeUndefined();
    expect(cgroupLocation(membership, wrong + narrower + mountInfo)?.current).toBe(leaf);
    expect(cgroupLocation('0::/\n', narrower)).toBeUndefined();
    expect(cgroupLocation('0::/nested\n', narrower)).toBeUndefined();
  });
  it.each(['0::/../../private\n', '0::relative\n', '0::/a/../private\n', '0::/a\0b\n'])('rejects invalid membership paths', member => {
    expect(cgroupLocation(member, mountInfo)).toBeUndefined();
  });
});
