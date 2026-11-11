import { open } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, loadavg, totalmem, uptime } from 'node:os';
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { getHeapStatistics } from 'node:v8';
import { systemMetricsSchema, type SystemMetricsSnapshot } from '../shared/schemas/system-metrics.js';

type CgroupMetrics = SystemMetricsSnapshot['cgroup'];
type HostSample = { logicalCpus: number | null; availableCpus: number | null; idle: number; total: number;
  loadAverage: [number, number, number] | null; memoryTotalBytes: number; memoryFreeBytes: number; uptimeSeconds: number };
export interface SystemMetricsDependencies {
  platform?: NodeJS.Platform;
  read?: (path: string, maxBytes: number, signal: AbortSignal) => Promise<string>;
  host?: () => HostSample;
  process?: () => { cpuMicros: number; memory: NodeJS.MemoryUsage; heapLimitBytes: number; uptimeSeconds: number };
  clock?: () => { now: number; monotonicMs: number };
  intervalMs?: number;
}
interface GroupLocation { current: string; mount: string; fileSystemRoot: boolean }
interface Baseline { at: number; processCpu: number; hostIdle: number; hostTotal: number; cpus: number | null; group?: { path: string; usage: number; at: number } }
interface Limit { value: number | null; state: 'limited' | 'unlimited' | 'unavailable'; path: string; scope: 'current' | 'ancestor'; complete: boolean }

function number(text: string | undefined): number | null {
  if (text === undefined || !/^\d+$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function emptyCgroup(version: CgroupMetrics['version'] = 'unavailable'): CgroupMetrics {
  return { version, state: 'unavailable', cpuPercent: null, cpuIntervalSeconds: null, cpuQuotaCores: null, cpuLimit: 'unavailable', cpuScope: 'unavailable',
    memoryCurrentBytes: null, memoryPeakBytes: null, memoryLimitBytes: null, memoryLimit: 'unavailable', memoryScope: 'unavailable',
    swapCurrentBytes: null, swapLimitBytes: null, swapLimit: 'unavailable', pidsCurrent: null, pidsLimit: null,
    pidsLimitState: 'unavailable', pidsScope: 'unavailable' };
}

function safePath(path: string): boolean {
  return isAbsolute(path) && !/[\p{Cc}\p{Cf}]/u.test(path) && !path.split('/').some(part => part === '.' || part === '..');
}

export function cgroupLocation(membership: string, mounts: string): GroupLocation | undefined {
  const current = membership.split('\n').find(line => line.startsWith('0::'))?.slice(3);
  if (current === undefined || !safePath(current)) return;
  const unescape = (value: string) => value.replace(/\\(040|011|012|134)/g, (_match, code: string) => String.fromCharCode(Number.parseInt(code, 8)));
  let selected: { location: GroupLocation; rootLength: number } | undefined;
  for (const line of mounts.split('\n')) {
    const split = line.indexOf(' - ');
    if (split < 0 || line.slice(split + 3).split(' ')[0] !== 'cgroup2') continue;
    const fields = line.slice(0, split).split(' ');
    if (!fields[3] || !fields[4]) continue;
    const root = unescape(fields[3]); const mount = unescape(fields[4]);
    if (!safePath(root) || !safePath(mount)) continue;
    if (root !== '/' && current !== root && !current.startsWith(`${root}/`)) continue;
    const local = root === '/' ? current.slice(1) : relative(root, current);
    const path = normalize(join(mount, local));
    if ((path === mount || path.startsWith(mount === sep ? sep : `${mount}${sep}`)) && (!selected || root.length < selected.rootLength)) {
      selected = { location: { current: path, mount: normalize(mount), fileSystemRoot: root === '/' }, rootLength: root.length };
    }
  }
  return selected?.location;
}

async function boundedRead(path: string, maxBytes: number, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(4096, maxBytes + 1));
    const parts: Buffer[] = []; let bytes = 0;
    for (;;) {
      signal.throwIfAborted();
      const result = await file.read(buffer, 0, Math.min(buffer.length, maxBytes + 1 - bytes), null);
      if (!result.bytesRead) break;
      bytes += result.bytesRead;
      if (bytes > maxBytes) throw new Error('METRIC_LIMIT');
      parts.push(Buffer.from(buffer.subarray(0, result.bytesRead)));
    }
    signal.throwIfAborted();
    return Buffer.concat(parts, bytes).toString('utf8');
  } finally { await file.close(); }
}

function hostSample(): HostSample {
  let info: ReturnType<typeof cpus> = [];
  let available: number | null = null;
  try { info = cpus(); } catch { /* Unavailable inventory is not a one-core machine. */ }
  try { available = availableParallelism(); } catch { /* Keep the scheduler estimate unknown when unavailable. */ }
  let idle = 0; let total = 0;
  for (const cpu of info) { idle += cpu.times.idle; total += Object.values(cpu.times).reduce((sum, time) => sum + time, 0); }
  return { logicalCpus: info.length || null, availableCpus: available, idle, total,
    loadAverage: process.platform === 'win32' ? null : loadavg() as [number, number, number],
    memoryTotalBytes: totalmem(), memoryFreeBytes: freemem(), uptimeSeconds: uptime() };
}

export class SystemMetrics {
  private current?: SystemMetricsSnapshot;
  private baseline?: Baseline;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<void>;
  private readonly controller = new AbortController();
  private started = false;
  private readonly interval: number;
  private readonly read: NonNullable<SystemMetricsDependencies['read']>;

  constructor(private readonly options: SystemMetricsDependencies = {}) {
    this.interval = options.intervalMs ?? 5000;
    if (!Number.isInteger(this.interval) || this.interval < 1000 || this.interval > 60_000) throw new Error('INVALID_METRIC_INTERVAL');
    this.read = options.read ?? boundedRead;
  }

  snapshot(): SystemMetricsSnapshot | undefined { return this.current ? structuredClone(this.current) : undefined; }

  async start(): Promise<void> {
    if (this.started || this.controller.signal.aborted) return;
    this.started = true;
    await this.sample();
    this.schedule();
  }

  async stop(): Promise<void> {
    this.controller.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.pending;
  }

  sample(): Promise<void> {
    if (this.controller.signal.aborted) return Promise.resolve();
    if (this.pending) return this.pending;
    this.pending = this.collect().catch(() => { this.current = undefined; this.baseline = undefined; })
      .finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private schedule(): void {
    if (!this.started || this.controller.signal.aborted) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.sample().finally(() => this.schedule()); }, this.interval);
    this.timer.unref();
  }

  private async collect(): Promise<void> {
    const clock = this.options.clock ?? (() => ({ now: Date.now(), monotonicMs: performance.now() }));
    const time = clock();
    const host = (this.options.host ?? hostSample)();
    const proc = this.options.process?.() ?? { cpuMicros: Object.values(process.cpuUsage()).reduce((sum, value) => sum + value, 0),
      memory: process.memoryUsage(), heapLimitBytes: getHeapStatistics().heap_size_limit, uptimeSeconds: process.uptime() };
    const previous = this.baseline;
    const elapsed = previous ? time.monotonicMs - previous.at : 0;
    const cpu = (now: number, before: number | undefined): number | null => elapsed > 0 && before !== undefined && now >= before
      ? (now - before) / (elapsed * 1000) * 100 : null;
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(750)]);
    const missing = new Set<string>();
    const safeRead = async (path: string, maxBytes = 4096): Promise<string | undefined> => {
      try { const value = await this.read(path, maxBytes, signal); return Buffer.byteLength(value) <= maxBytes ? value : undefined; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') missing.add(path); return undefined; }
    };
    let available: number | null = null;
    let group = emptyCgroup(); let groupBaseline: Baseline['group'];
    if ((this.options.platform ?? process.platform) === 'linux') {
      const [memory, membership, mounts] = await Promise.all([safeRead('/proc/meminfo', 32768), safeRead('/proc/self/cgroup', 8192), safeRead('/proc/self/mountinfo', 65536)]);
      const availableKb = number(memory?.match(/^MemAvailable:\s+(\d+)\s+kB\s*$/m)?.[1]);
      if (availableKb !== null && Number.isSafeInteger(availableKb * 1024) && availableKb * 1024 <= host.memoryTotalBytes) available = availableKb * 1024;
      const location = membership !== undefined && mounts !== undefined ? cgroupLocation(membership, mounts) : undefined;
      if (location) {
        const locations: string[] = [];
        let cursor = location.current;
        for (let depth = 0; depth < 16; depth++) {
          locations.push(cursor);
          if (cursor === location.mount) break;
          const parent = dirname(cursor);
          if (parent === cursor || parent !== location.mount && !parent.startsWith(`${location.mount}${sep}`)) break;
          cursor = parent;
        }
        const complete = locations.at(-1) === location.mount;
        const selectLimit = async (name: string, cpuQuota = false): Promise<Limit> => {
          const result: Limit = { value: null, state: 'unavailable', path: location.current, scope: 'current', complete };
          let allRead = complete;
          for (const path of locations) {
            const file = join(path, name);
            const text = (await safeRead(file))?.trim();
            if (text === undefined) {
              // The cgroup filesystem root has no max files. Permission errors or
              // hidden ancestors are not evidence of an unlimited allocation.
              if (!(path === location.mount && location.fileSystemRoot && missing.has(file))) allRead = false;
              continue;
            }
            const fields = text.split(/\s+/);
            const unlimited = cpuQuota ? fields.length === 2 && fields[0] === 'max' && (number(fields[1]) ?? 0) > 0 : text === 'max';
            if (unlimited) continue;
            const quota = number(cpuQuota ? fields[0] : text);
            const period = cpuQuota ? number(fields[1]) : 1;
            if (quota === null || period === null || period === 0 || cpuQuota && (fields.length !== 2 || quota === 0)) { allRead = false; continue; }
            const limit = quota / period;
            if (result.value === null || limit < result.value) { result.value = limit; result.path = path; result.scope = path === location.current ? 'current' : 'ancestor'; }
          }
          result.complete = allRead;
          result.state = result.value !== null ? 'limited' : allRead ? 'unlimited' : 'unavailable';
          return result;
        };
        // Usage and limits come from the same visible group; ancestor limits must not be paired with leaf usage.
        const [memoryLimit, cpuLimit, pidsLimit, swapLimit] = await Promise.all([
          selectLimit('memory.max'), selectLimit('cpu.max', true), selectLimit('pids.max'), selectLimit('memory.swap.max'),
        ]);
        const groupCpu = async () => {
          const text = await safeRead(join(cpuLimit.path, 'cpu.stat'));
          return { text, at: clock().monotonicMs };
        };
        const [memoryCurrent, memoryPeak, swapCurrent, usage, pidsCurrent] = await Promise.all([
          safeRead(join(memoryLimit.path, 'memory.current')), safeRead(join(memoryLimit.path, 'memory.peak')),
          safeRead(join(swapLimit.path, 'memory.swap.current')),
          groupCpu(), safeRead(join(pidsLimit.path, 'pids.current')),
        ]);
        const cpuUsage = number(usage.text?.match(/^usage_usec\s+(\d+)\s*$/m)?.[1]);
        if (cpuUsage !== null) groupBaseline = { path: cpuLimit.path, usage: cpuUsage, at: usage.at };
        const oldGroup = previous?.group;
        const groupElapsed = oldGroup?.path === cpuLimit.path ? usage.at - oldGroup.at : 0;
        const groupPercent = cpuUsage !== null && oldGroup && groupElapsed > 0 && cpuUsage >= oldGroup.usage
          ? (cpuUsage - oldGroup.usage) / (groupElapsed * 1000) * 100 : null;
        const known = memoryLimit.complete && cpuLimit.complete && pidsLimit.complete && swapLimit.complete
          && cpuUsage !== null && number(memoryCurrent) !== null && number(memoryPeak) !== null && number(swapCurrent) !== null && number(pidsCurrent) !== null;
        group = { version: 'v2', state: known ? 'available' : 'partial',
          cpuPercent: groupPercent, cpuIntervalSeconds: groupPercent === null ? null : groupElapsed / 1000,
          cpuQuotaCores: cpuLimit.value, cpuLimit: cpuLimit.state, cpuScope: cpuLimit.scope,
          memoryCurrentBytes: number(memoryCurrent), memoryPeakBytes: number(memoryPeak), memoryLimitBytes: memoryLimit.value,
          memoryLimit: memoryLimit.state, memoryScope: memoryLimit.scope, swapCurrentBytes: number(swapCurrent), swapLimitBytes: swapLimit.value,
          swapLimit: swapLimit.state,
          pidsCurrent: number(pidsCurrent), pidsLimit: pidsLimit.value, pidsLimitState: pidsLimit.state, pidsScope: pidsLimit.scope };
        if (memoryCurrent === undefined && usage.text === undefined && pidsCurrent === undefined) group.state = 'unavailable';
      } else if (membership !== undefined && !membership.split('\n').some(line => line.startsWith('0::')) && membership.trim()) group = emptyCgroup('v1');
    }
    const totalDelta = previous ? host.total - previous.hostTotal : 0;
    const idleDelta = previous ? host.idle - previous.hostIdle : 0;
    const hostCpu = previous && elapsed > 0 && previous.cpus !== null && host.logicalCpus !== null
      && previous.cpus === host.logicalCpus && totalDelta > 0 && idleDelta >= 0 && idleDelta <= totalDelta
      ? (totalDelta - idleDelta) / totalDelta * 100 : null;
    if (this.controller.signal.aborted) return;
    const result = systemMetricsSchema.safeParse({ sampledAt: new Date(time.now).toISOString(), intervalSeconds: elapsed > 0 ? elapsed / 1000 : null,
      process: { cpuPercent: cpu(proc.cpuMicros, previous?.processCpu), rssBytes: proc.memory.rss, heapUsedBytes: proc.memory.heapUsed,
        heapTotalBytes: proc.memory.heapTotal, heapLimitBytes: proc.heapLimitBytes, externalBytes: proc.memory.external,
        arrayBuffersBytes: proc.memory.arrayBuffers, uptimeSeconds: proc.uptimeSeconds },
      system: { logicalCpus: host.logicalCpus, availableCpus: host.availableCpus, cpuPercent: hostCpu, loadAverage: host.loadAverage,
        memoryTotalBytes: host.memoryTotalBytes, memoryAvailableBytes: available, memoryFreeBytes: host.memoryFreeBytes, uptimeSeconds: host.uptimeSeconds }, cgroup: group });
    this.current = result.success ? result.data : undefined;
    this.baseline = { at: time.monotonicMs, processCpu: proc.cpuMicros, hostIdle: host.idle, hostTotal: host.total, cpus: host.logicalCpus, group: groupBaseline };
  }
}
