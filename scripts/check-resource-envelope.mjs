import { Buffer } from 'node:buffer';
import assert from 'node:assert/strict';
import { fork, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, rmdir, statfs, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { PassThrough, Readable } from 'node:stream';
import { setImmediate as nextTurn, setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, gzipSync } from 'node:zlib';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const { AbortController } = globalThis;
const setTimeout = (callback, ms) => globalThis.setTimeout(callback, ms);
const clearTimeout = timer => globalThis.clearTimeout(timer);
export const LIMITS = Object.freeze({ memoryBytes: 256 * 1024 ** 2, cpuQuota: 100_000, cpuPeriod: 100_000,
  margin: 0.2, pids: 64, sampleMs: 50, maxSamples: 2400, retainedSamples: 128, deadlineMs: 120_000 });
export const MISSING_SCENARIOS = Object.freeze([
  'browser E2E and live OIDC/provider/Telegram acceptance (outside this offline driver)',
  'all native-provider maximum multimodal/tool-continuation combinations',
  'all weather fallback providers and end-to-end RSS network/delivery/repair',
  'maximum animated media, slow encoders and actual disk exhaustion',
  'near-limit existing JSON, idle expiry and long-duration retention',
  'reviewed Skills plus full root MCP/remote-executor integration',
  'qualified local sandbox workloads, compiler/platform isolation and escape tests',
  'automation crash/restart, long-duration schedule and clock-change workloads',
]);

export async function measureScenario(name, operation) {
  const start = performance.now();
  try {
    const details = await operation();
    return { name, status: 'measured', durationMs: performance.now() - start,
      ...(details && typeof details === 'object' ? { details } : {}) };
  } catch (error) {
    return { name, status: 'unmeasured', error: errorCode(error),
      ...(error?.stack?.match(/check-resource-envelope\.mjs:(\d+)/)?.[1] ? { harnessLine: Number(error.stack.match(/check-resource-envelope\.mjs:(\d+)/)[1]) } : {}) };
  }
}

export async function boundedWait(promise, ms = 5000) {
  if (!Number.isInteger(ms) || ms < 1 || ms > 30000) throw new Error('Invalid fixture wait bound');
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('Fixture hook timed out'), { code: 'SCENARIO_TIMEOUT' })), ms);
    })]);
  } finally { clearTimeout(timer); }
}

// Observe original durable writes, never poll or retain private checkpoint contents.
export function createStateInbox(limit = 128) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 256) throw new Error('Invalid inbox bound');
  const values = new Map(); const waiters = new Set();
  let closed = false;
  return {
    publish(id, state) {
      if (closed) return;
      if (typeof id !== 'string' || id.length > 160 || typeof state !== 'string' || state.length > 64) throw new Error('Invalid state observation');
      if (!values.has(id) && values.size >= limit) throw Object.assign(new Error('State observations full'), { code: 'CAPACITY' });
      values.set(id, state);
      for (const waiter of [...waiters]) if (waiter.id === id && waiter.states.includes(state)) waiter.finish(undefined, state);
    },
    wait(id, states, timeoutMs = 5000) {
      if (closed || waiters.size >= 32 || typeof id !== 'string' || id.length > 160 || !Array.isArray(states) || !states.length || states.length > 16
        || states.some(state => typeof state !== 'string' || state.length > 64) || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return Promise.reject(new Error('Invalid state wait'));
      if (states.includes(values.get(id))) return Promise.resolve(values.get(id));
      return new Promise((resolveWait, reject) => {
        const waiter = { id, states, finish(error, value) { clearTimeout(timer); waiters.delete(waiter); if (error) reject(error); else resolveWait(value); } };
        const timer = setTimeout(() => waiter.finish(Object.assign(new Error('State transition timed out'), { code: 'SCENARIO_TIMEOUT' })), timeoutMs);
        waiters.add(waiter);
      });
    },
    get size() { return values.size; },
    get pending() { return waiters.size; },
    close() { closed = true; for (const waiter of [...waiters]) waiter.finish(new Error('State inbox closed')); values.clear(); },
  };
}

async function httpScenario(port) {
  const call = (path, headers = {}, method = 'GET', body) => new Promise((resolveRequest, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers: { host: 'resource.example', ...headers,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, timeout: 5000 }, response => {
      let size = 0; const chunks = [];
      response.on('data', chunk => { size += chunk.length; if (size > 1024 ** 2) response.destroy(new Error('HTTP body bound')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => resolveRequest({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error('HTTP deadline'))); req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });
  assert.equal((await call('/api/ai/admin')).status, 401);
  const login = await call('/auth/login'); assert.equal(login.status, 302);
  const state = new URL(login.headers.location).searchParams.get('state');
  const binding = login.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const callback = await call(`/auth/callback?state=${encodeURIComponent(state)}&code=OFFLINE_CODE`, { cookie: binding });
  assert.equal(callback.status, 302);
  const cookie = callback.headers['set-cookie'].map(value => value.split(';')[0]).join('; ');
  const me = JSON.parse((await call('/api/me', { cookie })).text); assert.equal(me.user.id, 1);
  for (const path of ['/api/status', '/api/settings/core/schema', '/api/modules', '/api/rss', '/api/ai/admin', '/api/ai/admin/extensions/status']) {
    const response = await call(path, { cookie }); assert.equal(response.status, 200, `HTTP ${path}`);
    assert.ok(!response.text.includes('RESOURCE_PRIVATE_MEMORY') && !response.text.includes('RESOURCE_PRIVATE_HISTORY'), 'Admin projection leaks private fixture');
  }
  const logout = await call('/auth/logout', { cookie, origin: 'https://resource.example', 'x-csrf-token': me.csrfToken }, 'POST', {});
  assert.equal(logout.status, 204);
  assert.equal((await call('/api/ai/admin', { cookie })).status, 401);
  return { transport: 'real-loopback-TCP', oidc: 'mock-authorize/exchange', authenticatedReads: 6, cookiesReported: false };
}

function errorCode(error) { return /^[A-Z_0-9]+$/.test(error?.code ?? '') ? error.code : 'HARNESS_ERROR'; }
const integer = value => /^\d+$/.test(value.trim()) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const counters = text => Object.fromEntries(text.trim().split('\n').map(line => line.trim().split(/\s+/)).filter(pair => pair.length === 2).map(([key, value]) => [key, integer(value)]));

export function parseOptions(args) {
  const options = { http: 'both', requireLimit: false, probe: false, cgroupParent: undefined, iterations: 3 };
  for (const arg of args) {
    if (arg === '--require-limit') options.requireLimit = true;
    else if (arg === '--disk-fixtures') options.diskFixtures = true;
    else if (arg === '--probe') options.probe = true;
    else if (/^--http=(off|on|both)$/.test(arg)) options.http = arg.slice(7);
    else if (arg.startsWith('--cgroup-parent=/')) options.cgroupParent = arg.slice(16);
    else if (/^--iterations=[1-9]\d?$/.test(arg)) options.iterations = Number(arg.slice(13));
    else throw new Error(`Unsupported resource harness option: ${arg}`);
  }
  return options;
}

// Never enable controllers, move the driver, or modify an existing group's limits.
export async function probeLimits(parent) {
  if (process.platform !== 'linux') return { available: false, reason: 'Linux cgroup v2 is required' };
  let step = 'membership';
  try {
    const membership = (await readFile('/proc/self/cgroup', 'utf8')).split('\n').find(line => line.startsWith('0::'))?.slice(3);
    if (membership === undefined) return { available: false, reason: 'No unified cgroup v2 membership' };
    step = 'parent resolution';
    parent = await realpath(parent ?? join('/sys/fs/cgroup', membership));
    step = 'filesystem';
    if ((await statfs(parent)).type !== 0x63677270) return { available: false, reason: 'Parent is not a cgroup v2 filesystem' };
    const checks = {}; const reasons = []; const required = ['cpu', 'memory', 'pids'];
    // An access failure must not hide independently readable controller diagnostics.
    for (const [name, mode] of [['readAccess', constants.R_OK], ['writeAccess', constants.W_OK]]) {
      try { await access(parent, mode | constants.X_OK); checks[name] = { ok: true }; }
      catch (error) {
        checks[name] = { ok: false, error: errorCode(error) };
        reasons.push(`Parent ${name === 'readAccess' ? 'read' : 'write'}/search access failed: ${errorCode(error)}`);
      }
    }
    for (const [name, file] of [['availableControllers', 'cgroup.controllers'], ['enabledControllers', 'cgroup.subtree_control']]) {
      try {
        const controllers = (await readFile(join(parent, file), 'utf8')).trim().split(/\s+/);
        const present = required.filter(name => controllers.includes(name)), missing = required.filter(name => !controllers.includes(name));
        checks[name] = { ok: missing.length === 0, readable: true, present, missing };
        if (missing.length) reasons.push(`Required controllers ${name === 'availableControllers' ? 'unavailable' : 'not enabled for children'}: ${missing.join(', ')}`);
      } catch (error) {
        checks[name] = { ok: false, readable: false, error: errorCode(error) };
        reasons.push(`${file} read failed: ${errorCode(error)}`);
      }
    }
    return { available: reasons.length === 0, parent, checks,
      reason: reasons.length ? `${reasons.join('; ')}; existing groups are not modified` : 'Candidate delegation; child limit creation/readback still required' };
  } catch (error) { return { available: false, reason: `Cgroup ${step} check failed: ${errorCode(error)}` }; }
}

export async function createLimitGroup(probe) {
  if (!probe.available) return { applied: false, reason: probe.reason };
  const path = join(probe.parent, `misaka-envelope-${randomUUID()}`);
  let created = false;
  try {
    await mkdir(path); created = true;
    for (const [name, value] of Object.entries({ 'memory.max': LIMITS.memoryBytes, 'memory.swap.max': 0,
      'memory.oom.group': 1, 'cpu.max': `${LIMITS.cpuQuota} ${LIMITS.cpuPeriod}`, 'pids.max': LIMITS.pids })) {
      await writeFile(join(path, name), String(value));
      if ((await readFile(join(path, name), 'utf8')).trim() !== String(value)) throw new Error('Limit readback mismatch');
    }
    return { applied: true, path, reason: 'Fresh child-only cgroup; launch attaches before exec of Node',
      cleanup: async () => {
        await writeFile(join(path, 'cgroup.kill'), '1');
        // cgroup.kill is asynchronous. A populated group must not be silently removed or ignored.
        if (counters(await readFile(join(path, 'cgroup.events'), 'utf8')).populated !== 0) throw new Error('Cgroup remains populated');
        await rmdir(path);
      } };
  } catch (error) {
    if (created) await rmdir(path);
    return { applied: false, reason: `Isolated limit setup failed: ${errorCode(error)}` };
  }
}

export async function readCgroup(path) {
  const values = await Promise.all(['memory.current', 'memory.peak', 'memory.swap.current', 'memory.stat', 'memory.events', 'cpu.stat', 'cpu.max', 'memory.max'].map(name => readFile(join(path, name), 'utf8')));
  return { current: integer(values[0]), peak: integer(values[1]), swap: integer(values[2]),
    stat: counters(values[3]), events: counters(values[4]), cpu: counters(values[5]), cpuMax: values[6].trim(), memoryMax: integer(values[7]) };
}

// /proc RSS sums may double-count shared pages and miss short-lived children. They are NOT charged memory.
export async function sampleProcessTree(pid, options = {}) {
  const proc = options.proc ?? '/proc';
  const maxProcesses = options.maxProcesses ?? 128;
  if (!Number.isSafeInteger(pid) || pid < 1 || !Number.isSafeInteger(maxProcesses) || maxProcesses < 1 || maxProcesses > 128) throw new Error('Invalid process sampling bounds');
  const queue = [pid]; const seen = new Set(); const processes = [];
  let complete = true;
  for (let i = 0; i < queue.length; i++) {
    const current = queue[i];
    if (seen.has(current)) continue;
    if (seen.size === maxProcesses) { complete = false; break; }
    seen.add(current);
    try {
      const base = join(proc, String(current));
      const status = await readFile(join(base, 'status'), 'utf8');
      const raw = await readFile(join(base, 'stat'), 'utf8');
      const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
      const rss = Number(status.match(/^VmRSS:\s+(\d+) kB$/m)?.[1] ?? 0) * 1024;
      processes.push({ pid: current, rss, startTime: fields[19] });
      const tasks = await readdir(join(base, 'task'));
      if (tasks.length > 128) complete = false;
      for (const tid of tasks.slice(0, 128)) {
        try {
          const children = (await readFile(join(base, 'task', tid, 'children'), 'utf8')).trim();
          for (const child of children ? children.split(/\s+/).map(Number) : []) {
            if (queue.length >= maxProcesses * 2) { complete = false; break; }
            if (Number.isSafeInteger(child) && child > 0 && !seen.has(child)) queue.push(child);
          }
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') complete = false; }
      }
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') complete = false; }
  }
  return { processes, rss: processes.reduce((sum, item) => sum + item.rss, 0), complete };
}

export function createSampler(sample, options = {}) {
  const intervalMs = options.intervalMs ?? LIMITS.sampleMs;
  const maxSamples = options.maxSamples ?? LIMITS.maxSamples;
  const retained = options.retained ?? LIMITS.retainedSamples;
  if (![intervalMs, maxSamples, retained].every(value => Number.isSafeInteger(value) && value > 0)
    || intervalMs < 5 || maxSamples > 10_000 || retained > 512) throw new Error('Invalid bounded sampler settings');
  const summary = { samples: 0, dropped: 0, exhausted: false, errors: 0, complete: true, peakRss: 0, peakChildren: 0, peakCharged: null, tail: [] };
  let timer; let running; let stopped = false;
  const tick = () => {
    running = (async () => {
      try {
        const value = await sample();
        summary.samples++;
        summary.complete &&= value.complete !== false;
        summary.peakRss = Math.max(summary.peakRss, value.rss ?? 0);
        summary.peakChildren = Math.max(summary.peakChildren, Math.max(0, (value.processes?.length ?? 1) - 1));
        if (value.cgroup) summary.peakCharged = Math.max(summary.peakCharged ?? 0, value.cgroup.peak ?? value.cgroup.current ?? 0);
        if (summary.tail.length === retained) { summary.tail.shift(); summary.dropped++; }
        summary.tail.push(value);
      } catch { summary.errors++; summary.complete = false; summary.samples++; }
      if (summary.samples >= maxSamples) summary.exhausted = true;
      else if (!stopped) timer = setTimeout(tick, intervalMs);
    })();
  };
  tick();
  return { summary, async stop() { stopped = true; clearTimeout(timer); await running; return summary; } };
}

export function evaluateGate({ limited, cgroup, sampling, completed, missing = [] }) {
  const reasons = [];
  const budget = Math.floor(LIMITS.memoryBytes * (1 - LIMITS.margin));
  if (!limited || cgroup?.cpuMax !== '100000 100000' || cgroup?.memoryMax !== LIMITS.memoryBytes
    || !Number.isSafeInteger(cgroup?.peak) || cgroup.peak <= 0 || cgroup.swap !== 0) reasons.push('one-core/256MiB limits and charged peak are not verified');
  if (!sampling?.complete || sampling.errors || sampling.exhausted) reasons.push('sampling was incomplete, failed or exhausted');
  if (!completed) reasons.push('runtime workload or cleanup did not complete');
  if ((cgroup?.events?.oom ?? 0) || (cgroup?.events?.oom_kill ?? 0) || (cgroup?.events?.max ?? 0)) reasons.push('cgroup hit memory pressure/OOM limit');
  if (cgroup?.peak > budget) reasons.push('charged peak exceeds the 80% memory safety budget');
  if (missing.length) reasons.push('required integration scenarios remain unmeasured');
  return { qualified: reasons.length === 0, status: reasons.length ? 'unqualified' : 'qualified', budgetBytes: budget, reasons };
}

function cleanEnvironment(directory) {
  return { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin`, HOME: directory, TMPDIR: directory, TZ: 'UTC', LANG: 'C.UTF-8',
    NODE_OPTIONS: '--max-old-space-size=96 --max-semi-space-size=4' };
}

export function launchRuntime(directory, group) {
  const options = { cwd: directory, env: cleanEnvironment(directory), stdio: ['ignore', 'pipe', 'pipe', 'ipc'] };
  // This is a fixed, noninteractive attach+exec shim, not a sandbox or a shell workload.
  // Attaching an already-running Node would leave its pre-migration allocations charged elsewhere.
  if (group.applied) return spawn('/bin/sh', ['-c', 'printf "%s" "$$" > "$1/cgroup.procs" || exit 125; exec "$2" "$3" --child',
    'resource-envelope', group.path, process.execPath, script], options);
  return fork(script, ['--child'], { ...options, execArgv: [] });
}

async function prepareMedia(directory) {
  const { default: sharp } = await import('sharp');
  await writeFile(join(directory, 'fixture.png'), await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 255, g: 64, b: 32, alpha: 0.5 } } }).png().toBuffer());
  const photo = await sharp(randomBytes(512 * 512 * 3), { raw: { width: 512, height: 512, channels: 3 } }).png({ compressionLevel: 0 }).toBuffer();
  const padding = Buffer.alloc(1024 ** 2 - photo.length);
  padding.writeUInt32BE(padding.length - 12); padding.write('tEXt', 4); padding.write('fixture\0', 8);
  padding.fill(32, 16, padding.length - 4); padding.writeUInt32BE(crc32(padding.subarray(4, -4)), padding.length - 4);
  await writeFile(join(directory, 'fixture-1m.png'), Buffer.concat([photo.subarray(0, -12), padding, photo.subarray(-12)]));
  await writeFile(join(directory, 'fixture-1m.txt'), Buffer.alloc(1024 ** 2, 82));
  const animation = { v: '5.7.4', fr: 2, ip: 0, op: 2, w: 32, h: 32, ddd: 0, assets: [], layers: [{
    ty: 4, ind: 1, sr: 1, ip: 0, op: 2, st: 0,
    ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [16, 16, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
    shapes: [{ ty: 'rc', d: 1, s: { a: 0, k: [8, 8] }, p: { a: 0, k: [0, 0] }, r: { a: 0, k: 0 } },
      { ty: 'fl', c: { a: 0, k: [1, 0, 0, 1] }, o: { a: 0, k: 100 }, r: 1 }],
  }] };
  await writeFile(join(directory, 'fixture.tgs'), gzipSync(JSON.stringify(animation)));
  // Fixture encoding is a test-driver cost, outside the application cgroup. Decoding is inside.
  const frames = Buffer.alloc(32 * 32 * 4 * 2, 128);
  const encoded = await new Promise(resolveEncoding => {
    const encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-filter_threads', '1',
      '-f', 'rawvideo', '-pixel_format', 'rgba', '-video_size', '32x32', '-framerate', '2', '-i', 'pipe:0',
      '-an', '-threads', '1', '-c:v', 'libvpx-vp9', '-lossless', '1', '-deadline', 'realtime', '-cpu-used', '8',
      '-auto-alt-ref', '0', '-lag-in-frames', '0', '-pix_fmt', 'yuva420p', '-f', 'webm', 'pipe:1'],
    { cwd: directory, env: cleanEnvironment(directory), stdio: ['pipe', 'pipe', 'pipe'] });
    let bytes = 0; let failed = false; const chunks = [];
    const timer = setTimeout(() => { failed = true; encoder.kill('SIGKILL'); }, 5000);
    encoder.on('error', () => { failed = true; }); encoder.stdin.on('error', () => {}); encoder.stderr.resume();
    encoder.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 1024 ** 2) { failed = true; encoder.kill('SIGKILL'); }
      else chunks.push(chunk);
    });
    encoder.once('close', code => { clearTimeout(timer); resolveEncoding(code === 0 && !failed ? Buffer.concat(chunks) : null); });
    encoder.stdin.end(frames);
  });
  if (encoded) await writeFile(join(directory, 'fixture.webm'), encoded);
}

export async function runVariant({ http = false, iterations = 3, group = { applied: false }, base = '/tmp/kilo', media = true } = {}) {
  const directory = await mkdtemp(join(base, 'misaka-envelope-'));
  let child; let sampler; let exit; let timer; let finalCgroup; let failure; let compiledApplication; let compiledAiService;
  const checkpoints = []; const operations = []; const known = new Map(); const pending = new Map();
  let sequence = 0; let outputBytes = 0; let exited = false; let completed = false;
  const interrupt = () => { failure = 'INTERRUPTED'; child?.kill('SIGKILL'); };
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const command = (op, input = {}) => new Promise((resolveCommand, reject) => {
    if (exited) { reject(new Error('Runtime exited')); return; }
    const id = ++sequence; pending.set(id, { resolve: resolveCommand, reject });
    child.send({ id, op, ...input }, error => { if (error) { pending.delete(id); reject(error); } });
  });
  try {
    await mkdir(join(directory, 'public'));
    await writeFile(join(directory, 'public', 'index.html'), '<!doctype html><title>Isolated resource fixture</title>');
    if (media) await prepareMedia(directory);
    if (failure) throw new Error('Interrupted');
    child = launchRuntime(directory, group);
    exit = new Promise(resolveExit => {
      child.once('error', error => { failure ??= errorCode(error); });
      child.once('close', (code, signal) => {
        exited = true; for (const { reject } of pending.values()) reject(new Error('Runtime exited')); pending.clear();
        resolveExit({ code, signal });
      });
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => {
      outputBytes += chunk.length;
      if (outputBytes > 64 * 1024) { failure = 'OUTPUT_LIMIT'; child.kill('SIGKILL'); }
    });
    child.on('message', message => {
      if (!message || typeof message !== 'object') return;
      if (message.type === 'checkpoint' && checkpoints.length < 32) checkpoints.push(message.value);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error));
        else waiter.resolve(message.value);
      }
    });
    timer = setTimeout(() => { failure = 'DEADLINE'; child.kill('SIGKILL'); }, LIMITS.deadlineMs);
    sampler = createSampler(async () => {
      const tree = await sampleProcessTree(child.pid);
      for (const item of tree.processes) known.set(item.pid, item.startTime);
      return { atMs: Math.round(performance.now()), ...tree, ...(group.applied ? { cgroup: await readCgroup(group.path) } : {}) };
    });
    const cold = await command('start', { http, directory });
    compiledApplication = createHash('sha256').update(await readFile(join(root, 'dist/src/app.js'))).digest('hex');
    compiledAiService = createHash('sha256').update(await readFile(join(root, 'dist/src/ai/service.js'))).digest('hex');
    checkpoints.push(cold);
    if (http) {
      await new Promise((resolveRequest, reject) => {
        const req = request({ host: '127.0.0.1', port: cold.port, path: '/health', headers: { host: 'resource.example' }, timeout: 5000 }, response => {
          response.resume(); response.once('end', () => response.statusCode === 200 ? resolveRequest() : reject(new Error('HTTP health failed')));
        });
        req.on('timeout', () => req.destroy(new Error('HTTP deadline'))); req.on('error', reject); req.end();
      });
      operations.push({ name: 'http-health-real-tcp', status: 'measured' });
    }
    for (let i = 0; i < iterations; i++) operations.push(...await command('warm'));
    operations.push(...await command('ai'));
    checkpoints.push(await command('snapshot', { label: 'after-ai-sqlite-workloads' }));
    if (http) operations.push(await measureScenario('http-oidc-admin-schema-logout', () => httpScenario(cold.port)));
    operations.push(...await command('media'));
    checkpoints.push(await command('snapshot', { label: 'after-native-media' }));
    operations.push(...await command('providers'));
    operations.push(...await command('extras'));
    operations.push(await command('cancel'));
    checkpoints.push(await command('snapshot', { label: 'warm-retained' }));
    const stopped = await command('stop'); checkpoints.push(stopped);
    const result = await exit;
    completed = result.code === 0 && !failure;
    if (compiledApplication !== createHash('sha256').update(await readFile(join(root, 'dist/src/app.js'))).digest('hex')
      || compiledAiService !== createHash('sha256').update(await readFile(join(root, 'dist/src/ai/service.js'))).digest('hex')) failure = 'COMPILED_INPUTS_CHANGED';
    if (!completed) failure ??= `EXIT_${result.code ?? result.signal}`;
  } catch (error) { failure ??= errorCode(error); }
  finally {
    clearTimeout(timer);
    if (child) {
      if (!exited) {
        const lastTree = await sampleProcessTree(child.pid);
        for (const item of lastTree.processes) known.set(item.pid, item.startTime);
      }
      if (group.applied) {
        try { await writeFile(join(group.path, 'cgroup.kill'), '1'); }
        catch { failure ??= 'CGROUP_KILL_FAILED'; }
      }
      // Kill only still-identical descendants observed beneath this fixture. Never arbitrary host PIDs.
      for (const [pid, startTime] of known) {
        if (pid === child.pid) continue;
        try {
          const raw = await readFile(`/proc/${pid}/stat`, 'utf8');
          if (raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/)[19] === startTime) { process.kill(pid, 'SIGKILL'); completed = false; failure ??= 'LEAKED_CHILD'; }
        } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'ESRCH') failure ??= 'CLEANUP_FAILED'; }
      }
      if (!exited) child.kill('SIGKILL');
      await exit;
    }
    if (sampler) await sampler.stop();
    if (group.applied) { try { finalCgroup = await readCgroup(group.path); } catch { failure ??= 'CGROUP_READ_FAILED'; } }
    process.removeListener('SIGTERM', interrupt); process.removeListener('SIGINT', interrupt);
    await rm(directory, { recursive: true, force: true });
  }
  const missing = [...new Set([...MISSING_SCENARIOS, ...operations.filter(item => item.status !== 'measured').map(item => item.name)])];
  const sampling = sampler?.summary ?? { complete: false, errors: 1 };
  return { http, iterations, compiledApplicationSha256: compiledApplication, compiledAiServiceSha256: compiledAiService,
    limitsApplied: group.applied, limitReason: group.reason, completed: completed && !failure, failure,
    checkpoints, operations, sampling, cgroup: finalCgroup ?? null, missing,
    gate: evaluateGate({ limited: group.applied, cgroup: finalCgroup, sampling, completed: completed && !failure, missing }) };
}

async function aiScenarios(app, directory, driver, createInvocation, checkpoint) {
  const load = name => import(pathToFileURL(join(root, `dist/src/ai/${name}.js`)).href);
  const [{ aiDefaults, aiSettingsSchema }, { aiScope }, { createAiProvider }, { createAiTransport }, { AppError }, { z }] = await Promise.all([
    import(pathToFileURL(join(root, 'dist/shared/schemas/ai.js')).href), load('policy'), load('providers'), load('transport'),
    import(pathToFileURL(join(root, 'dist/src/errors.js')).href), import('zod'),
  ]);
  const context = (actorId = 1, chatId = actorId, threadId) => createInvocation({ actorId, botId: 12345, source: 'telegram', language: 'en',
    chat: { id: chatId, type: chatId > 0 ? 'private' : 'supergroup', ...(threadId ? { threadId } : {}) } });
  const admin = context(); const store = app.ai.data(admin); const inbox = createStateInbox();
  const approvals = new Map(); const deliveries = { progress: 0, completed: 0, files: 0, fileBytes: 0, failures: 0 };
  let fileHook; let progressHook; let downloadHook;
  const originalUpdate = store.runUpdate; const originalPut = store.recordPut; const originalCreate = store.recordCreate;
  store.runUpdate = function (...args) { const result = originalUpdate.apply(this, args); inbox.publish(result.id, result.state); return result; };
  for (const [key, original] of [['recordPut', originalPut], ['recordCreate', originalCreate]]) store[key] = function (...args) {
    const result = original.apply(this, args); if (result.kind === 'automation') inbox.publish(`auto:${result.id}`, result.state); return result;
  };
  const execute = async (actor, id, input = {}) => {
    const result = await app.executor.execute(createInvocation({ ...actor, invocationId: randomUUID() }), id, input);
    assert.equal(result.status, 'succeeded', `Fixture Action ${id}: ${result.error?.code ?? result.status}`); return result.data;
  };
  const start = (actor = admin, text = 'resource fixture', attachments = []) => execute(actor, 'ai.run.start', { text, attachments });
  const settled = async (actor, ticket, state = 'completed') => {
    const result = await inbox.wait(ticket.runId, ['completed', 'failed', 'cancelled', 'unknown', 'waiting-approval']);
    await nextTurn();
    assert.equal(result, state, `AI terminal state: ${app.ai.runView(actor, ticket.runId).error ?? result}`);
    return store.runGet(aiScope(actor), ticket.runId);
  };
  const final = (text = 'resource answer') => ({ text, toolCalls: [], usage: { inputTokens: 20, outputTokens: 5, billable: false } });
  const toolName = id => `action_${createHash('sha256').update(id).digest('hex').slice(0, 56)}`;
  const calls = (request, items) => {
    const toolCalls = items.map((item, index) => {
      const name = toolName(item.id); assert.ok(request.tools.some(tool => tool.name === name), `Tool not advertised: ${item.id}`);
      return { id: `call-${index}`, name, arguments: item.input ?? {} };
    });
    return { ...final(''), toolCalls, continuation: { version: 1, protocol: 'openai-responses', origin: 'https://api.openai.com', model: 'resource-model',
      binding: 'fixture-only-mocked-provider', records: [{ type: 'reasoning', encrypted_content: 'RESOURCE_NATIVE_SIGNATURE' }], pending: toolCalls.map(({ id, name }) => ({ id, name })) } };
  };
  const plain = (generate = async () => final()) => { driver.provider = () => ({ generate }); };
  const baseTools = ['core.info', 'rate.convert', 'weather.query', 'rss.list', 'alias.list', 'alias.add'];
  const configure = (tools = baseTools) => {
    const old = store.getSettings();
    store.updateSettings(aiSettingsSchema.parse({ ...aiDefaults(), enabled: true,
      providers: [{ id: 'resource', enabled: true, protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', allowedOrigins: ['https://api.openai.com'], credentialRef: 'env:RESOURCE_FIXTURE' }],
      presets: [{ id: 'fixed', providerId: 'resource', model: 'resource-model', tools, inputCapabilities: ['text', 'image', 'document'], outputCapabilities: ['text'],
        budget: { maxInputTokens: 32768, maxOutputTokens: 8192, maxToolCalls: 16, maxDurationMs: 10000, maxCostMicros: 100 },
        pricing: { currency: 'CNY', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }],
      grants: [...Array.from({ length: 20 }, (_, index) => ({ id: `private${index + 1}`, kind: 'private', subjectId: index + 1, presetId: 'fixed' })),
        { id: 'group100', kind: 'group', subjectId: -100, presetId: 'fixed' }],
    }), old.revision);
  };
  const delivery = {
    started: async (_target, signal) => signal.throwIfAborted(),
    progress: async (target, text, signal) => { signal.throwIfAborted(); deliveries.progress++; await progressHook?.(target, text, signal); },
    approval: async (target, confirmation) => { assert.ok(approvals.size < 32); approvals.set(target.runId, confirmation.token); },
    completed: async (_target, _text, signal) => { signal.throwIfAborted(); deliveries.completed++; return 10000 + deliveries.completed; },
    failed: async () => { deliveries.failures++; },
    retire: async () => {},
    file: async (target, file, signal) => {
      deliveries.files++; signal.throwIfAborted();
      if (fileHook) return fileHook(target, file, signal);
      if (file.path) {
        for await (const chunk of createReadStream(file.path, { highWaterMark: 64 * 1024, signal })) deliveries.fileBytes += chunk.length;
      } else deliveries.fileBytes += file.bytes.length;
    },
  };
  app.ai.attachTelegram(delivery, async (file, signal) => {
    signal.throwIfAborted(); if (downloadHook) return downloadHook(file, signal);
    assert.ok(['fixture-1m.png', 'fixture-1m.txt'].includes(file.fileId));
    return readFile(join(directory, file.fileId));
  });
  const operations = [];
  const scenario = async (name, fn) => operations.push(await measureScenario(name, fn));
  try {
    await scenario('ai-default-off-then-scoped-settings', async () => {
      assert.equal(store.getSettings().settings.enabled, false);
      assert.notEqual((await app.executor.execute(admin, 'ai.run.start', { text: 'blocked before configuration' })).status, 'succeeded');
      assert.equal(driver.calls, 0); configure();
      await app.access.authorize(-100, 'Resource Fixture Group', 1, app.access.snapshot().revision);
      assert.equal(app.ai.available(context(3)), true); assert.equal(app.ai.available(context(21)), false);
      return { sqlite: store.safeStatus(), configuredUsers: 20, configuredGroups: 1 };
    });
    await scenario('ai-native-responses-native-tools-human-approval-continuation', async () => {
      const revision = (await execute(admin, 'alias.list')).revision;
      let step = 0; let prefix; let nativeCalls = 0;
      const marker = { type: 'reasoning', id: 'rs_resource', encrypted_content: 'RESOURCE_NATIVE_SIGNATURE', summary: [] };
      const batches = [
        [{ id: 'core.info' }, { id: 'rate.convert', input: { query: 'JPY USD' } },
          { id: 'weather.query', input: { location: { id: 'qweather:fixture', name: 'Fixture', label: 'Fixture', latitude: 35, longitude: 139, country: 'JP', timezone: 'Asia/Tokyo' }, mode: 'current', days: 3 } }, { id: 'rss.list' }],
        [{ id: 'alias.add', input: { command: 'help', alias: 'resource_ai_alias', revision } }],
      ];
      const transport = createAiTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (_url, request) => {
        nativeCalls++;
        const body = JSON.parse(request.body.toString('utf8'));
        if (prefix) { assert.equal(JSON.stringify(body.tools), prefix.tools); assert.equal(body.instructions, prefix.instructions); assert.ok(body.input.some(record => record.encrypted_content === marker.encrypted_content)); }
        else prefix = { tools: JSON.stringify(body.tools), instructions: body.instructions };
        const batch = batches[step++];
        const output = batch ? [marker, ...batch.map((item, index) => ({ type: 'function_call', id: `fc_${step}_${index}`, call_id: `call_${step}_${index}`,
          name: toolName(item.id), arguments: JSON.stringify(item.input ?? {}), status: 'completed' }))]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'approved resource answer' }] }];
        const event = { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 20, output_tokens: 5 } } };
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]) };
      } });
      driver.provider = profile => createAiProvider(profile, { transport });
      const ticket = await start(); await settled(admin, ticket, 'waiting-approval');
      const token = approvals.get(ticket.runId); assert.equal(typeof token, 'string');
      assert.notEqual((await app.executor.execute(context(3), 'ai.run.confirm', { runId: ticket.runId, token })).status, 'succeeded');
      await execute(admin, 'ai.run.confirm', { runId: ticket.runId, token });
      await settled(admin, ticket);
      assert.equal(nativeCalls, 3); assert.equal(deliveries.completed, 1);
      const receipts = store.recordList(aiScope(admin), 'receipt', { limit: 50 }).items.filter(record => record.payload.actionId);
      assert.deepEqual(receipts.map(record => record.payload.actionId), ['core.info', 'rate.convert', 'weather.query', 'rss.list', 'alias.add']);
      assert.ok(receipts.every(record => record.payload.result.status === 'succeeded'));
      assert.notEqual((await app.executor.execute(admin, 'ai.run.confirm', { runId: ticket.runId, token })).status, 'succeeded');
      return { modelRequests: nativeCalls, nativeReceipts: receipts.length, humanConfirmations: 1, replayRejected: true };
    });
    await scenario('ai-one-active-eight-queued-cancel-drain', async () => {
      const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const aborted = Promise.withResolvers();
      plain(async (_request, { signal }) => { entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise; throw new AppError('CANCELLED'); });
      const before = driver.calls; const first = await start(context(3)); await boundedWait(entered.promise);
      const queued = [];
      try {
        for (let actorId = 4; actorId <= 11; actorId++) queued.push({ actor: context(actorId), ticket: await start(context(actorId)) });
        const overflow = await app.executor.execute(context(12), 'ai.run.start', { text: 'queue overflow' });
        assert.equal(overflow.error?.code, 'CAPACITY'); assert.equal(store.safeStatus().pendingRuns, 9); assert.equal(driver.calls - before, 1);
        await checkpoint('ai-queue-saturated', { activeRuns: 1, queuedRuns: 8, sqlite: store.safeStatus() });
        for (const item of queued) await execute(item.actor, 'ai.run.stop', { runId: item.ticket.runId });
        let drained = false; const began = performance.now();
        const stopping = execute(context(3), 'ai.run.stop', { runId: first.runId }).then(() => { drained = true; });
        await boundedWait(aborted.promise); assert.equal(drained, false); await execute(admin, 'core.info');
        release.resolve(); await stopping; await settled(context(3), first, 'cancelled');
        assert.equal(driver.calls - before, 1); assert.equal(store.safeStatus().pendingRuns, 0);
        return { active: 1, queued: 8, overflow: 'CAPACITY', providerRequests: 1, cancellationDrainMs: performance.now() - began };
      } finally { release.resolve(); await app.ai.cancelAll(); }
    });
    await scenario('ai-shared-group-actors-topics-and-private-memory', async () => {
      await execute(context(3), 'ai.memory.remember', { text: 'RESOURCE_PRIVATE_MEMORY_USER3' });
      const entered = Promise.withResolvers(); const release = Promise.withResolvers();
      plain(async (_request, { signal }) => { entered.resolve(); await release.promise; signal.throwIfAborted(); return final(); });
      const actor3 = context(3, -100, 7); const actor4 = context(4, -100, 7);
      const first = await start(actor3, 'group actor three'); await boundedWait(entered.promise);
      try {
        assert.equal((await app.executor.execute(actor4, 'ai.run.start', { text: 'contending group actor' })).error?.code, 'CONFLICT');
        assert.equal((await app.executor.execute(actor4, 'ai.run.stop', { runId: first.runId })).error?.code, 'NOT_FOUND');
        const differentTopic = await start(context(4, -100, 8));
        await execute(context(4, -100, 8), 'ai.run.stop', { runId: differentTopic.runId });
        const stopping = execute(actor3, 'ai.run.stop', { runId: first.runId }); release.resolve(); await stopping;
      } finally { release.resolve(); }
      let checked = false;
      plain(async request => { const text = JSON.stringify(request); assert.ok(text.includes('[Speaker user:3]') && text.includes('[Speaker user:4]')); assert.ok(!text.includes('RESOURCE_PRIVATE_MEMORY')); checked = true; return final(); });
      const second = await start(actor4, 'group actor four'); await settled(actor4, second);
      assert.equal(second.conversationId, first.conversationId); assert.equal(checked, true);
      return { sharedConversation: true, foreignStopRefused: true, separateTopicQueue: true, privateMemoryExcluded: true };
    });
    await scenario('ai-capture-1m-document-and-valid-1m-photo', async () => {
      configure(['core.info']);
      const sizes = []; plain(async request => {
        const media = request.messages.flatMap(message => message.content).filter(part => part.type !== 'text');
        assert.equal(media.length, 1); assert.equal(media[0].bytes.length, 1048576); sizes.push(media[0].bytes.length); return final();
      });
      for (const [actorId, name, kind, mimeType] of [[13, 'fixture-1m.txt', 'document', 'text/plain'], [14, 'fixture-1m.png', 'image', 'image/png']]) {
        const actor = context(actorId); const ref = await app.ai.capture(actor, { fileId: name, uniqueId: name, name, kind, mimeType, size: 1048576 });
        const ticket = await start(actor, 'inspect fixture', [ref]); await settled(actor, ticket);
      }
      return { bytesPerCapture: sizes, photoPixels: 512 * 512, provider: 'mock generation; actual service file validation', nativeUploadNotClaimed: true };
    });
    await scenario('ai-native-file-upload-release-and-total-envelope-refusal', async () => {
      let uploads = 0; let deletes = 0; let inferences = 0;
      const transport = createAiTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (url, request) => {
        if (request.method === 'DELETE') { deletes++; return { status: 204, headers: {}, body: Readable.from([]) }; }
        if (url.pathname === '/v1/files') {
          uploads++; return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from([Buffer.from(JSON.stringify({
            id: 'file-resource', bytes: 524288, expires_at: Math.floor(Date.now() / 1000) + 3600,
          }))]) };
        }
        if (url.pathname === '/v1/responses/input_tokens') return { status: 200, headers: { 'content-type': 'application/json' },
          body: Readable.from([Buffer.from(JSON.stringify({ object: 'response.input_tokens', input_tokens: 20 }))]) };
        inferences++;
        const event = { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'native file answer' }] }], usage: { input_tokens: 20, output_tokens: 5 } } };
        return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]) };
      } });
      driver.provider = profile => createAiProvider(profile, { transport, fileScope: 'resource-fixture-private-user13' });
      downloadHook = async file => Buffer.alloc(file.size, 82);
      const actor = context(13);
      try {
        const file = { fileId: 'document', uniqueId: 'native-document', name: 'document.txt', kind: 'document', mimeType: 'text/plain', size: 524288 };
        const small = await app.ai.capture(actor, file); await settled(actor, await start(actor, 'native file', [small]));
        assert.equal(uploads, 1); assert.equal(deletes, 1); assert.equal(inferences, 1);
        const large = await app.ai.capture(actor, { ...file, uniqueId: 'native-large', size: 1048576 });
        const rejected = await start(actor, 'over total native envelope', [large]); await settled(actor, rejected, 'failed');
        assert.equal(app.ai.runView(actor, rejected.runId).error, 'CAPACITY'); assert.equal(uploads, 1);
        return { uploadedBytes: 524288, uploadRequests: uploads, releaseRequests: deletes, inferenceRequests: inferences,
          exact1MiBFileRejectedBeforeUpload: true, reason: '1MiB native request budget includes metadata/history overhead, not file bytes alone' };
      } finally { downloadHook = undefined; }
    });
    await scenario('ai-cancel-download-and-late-provider-file-frames', async () => {
      const entered = Promise.withResolvers(); const release = Promise.withResolvers();
      const before = driver.calls; const filesBefore = deliveries.files; const doneBefore = deliveries.completed;
      downloadHook = async (_file, signal) => { entered.resolve(); await release.promise; signal.throwIfAborted(); return Buffer.alloc(1); };
      const actor = context(15); const ref = await app.ai.capture(actor, { fileId: 'fixture-1m.txt', uniqueId: 'cancel-doc', name: 'document.txt', kind: 'document', mimeType: 'text/plain', size: 1048576 });
      try {
        const ticket = await start(actor, 'cancel download', [ref]); await boundedWait(entered.promise);
        const stopping = execute(actor, 'ai.run.stop', { runId: ticket.runId }); release.resolve(); await stopping; await settled(actor, ticket, 'cancelled');
        assert.equal(driver.calls, before);
      } finally { release.resolve(); downloadHook = undefined; }
      const modelEntered = Promise.withResolvers(); const modelRelease = Promise.withResolvers();
      plain(async () => { modelEntered.resolve(); await modelRelease.promise; return { ...final('late fixture answer'), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(1048576) }] }; });
      const ticket = await start(actor, 'cancel provider'); await boundedWait(modelEntered.promise);
      try { const stopping = execute(actor, 'ai.run.stop', { runId: ticket.runId }); modelRelease.resolve(); await stopping; await settled(actor, ticket, 'cancelled'); }
      finally { modelRelease.resolve(); }
      assert.equal(deliveries.files, filesBefore); assert.equal(deliveries.completed, doneBefore);
      return { downloadCancelledBeforeModel: true, lateTextAndFileSuppressed: true };
    });
    await scenario('ai-file-output-cancel-real-drain-unknown-no-final', async () => {
      const entered = Promise.withResolvers(); const release = Promise.withResolvers(); const aborted = Promise.withResolvers();
      const before = deliveries.completed; const actor = context(16);
      plain(async () => ({ ...final(), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(1048576) }] }));
      fileHook = async (_target, file, signal) => { assert.equal(file.bytes.length, 1048576); entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise; };
      try {
        const ticket = await start(actor); await boundedWait(entered.promise);
        let drained = false; const stopping = execute(actor, 'ai.run.stop', { runId: ticket.runId }).then(() => { drained = true; });
        await boundedWait(aborted.promise); assert.equal(drained, false); release.resolve(); await stopping;
        await settled(actor, ticket, 'unknown'); assert.equal(deliveries.completed, before);
        return { outputBytes: 1048576, stopWaitsForDrain: true, state: 'unknown', finalTextSuppressed: true };
      } finally { release.resolve(); fileHook = undefined; }
    });
    await scenario('ai-maximum-stream-slow-consumer-and-overflow', async () => {
      let live = 0; let peak = 0;
      progressHook = async () => { peak = Math.max(peak, ++live); await delay(2); live--; };
      plain(async (_request, options) => { for (let i = 0; i < 24; i++) await options.onText('x'.repeat(1024), options.signal); return final('x'.repeat(24576)); });
      try {
        await settled(context(17), await start(context(17))); assert.equal(peak, 1);
        plain(async (_request, options) => { await options.onText('x'.repeat(24577), options.signal); return final(); });
        const overflow = await start(context(18)); await settled(context(18), overflow, 'failed');
        assert.equal(app.ai.runView(context(18), overflow.runId).error, 'CAPACITY');
        return { acceptedTextBytes: 24576, rejectedTextBytes: 24577, maxConcurrentDeliveryCallbacks: peak };
      } finally { progressHook = undefined; }
    });
    await scenario('ai-max-tool-arguments-and-oversized-continuation', async () => {
      let bytes = 0;
      app.executor.register({ id: 'resource.bounded', input: z.strictObject({ value: z.string().max(8192) }), output: z.number(),
        permission: 'self', scopes: ['private'], sources: ['telegram', 'ai'], effect: 'read', aiVisible: true, timeoutMs: 1000,
        execute: input => { bytes = Buffer.byteLength(JSON.stringify(input)); return bytes; } });
      configure(['resource.bounded']);
      plain(async request => request.continuation ? final() : calls(request, [{ id: 'resource.bounded', input: { value: 'x'.repeat(8180) } }]));
      await settled(context(19), await start(context(19))); assert.equal(bytes, 8192);
      plain(async request => { const output = calls(request, [{ id: 'resource.bounded', input: { value: 'x' } }]); output.continuation.records = [{ value: 'x'.repeat(48001) }]; return output; });
      const oversized = await start(context(20)); await settled(context(20), oversized, 'failed');
      assert.equal(app.ai.runView(context(20), oversized.runId).error, 'CAPACITY');
      return { acceptedArgumentBytes: bytes, oversizedNativeContinuationRejected: true };
    });
    await scenario('ai-unknown-billing-and-uncertain-mutation-no-retry', async () => {
      configure(['core.info']); const before = store.safeStatus().reservedCostMicros;
      plain(async () => ({ ...final(), usage: { billable: 'unknown' } }));
      await settled(context(12), await start(context(12)));
      assert.equal(store.safeStatus().reservedCostMicros, before + 100);
      let mutations = 0;
      app.executor.register({ id: 'resource.uncertain', input: z.strictObject({}), output: z.boolean(), permission: 'self', scopes: ['private'],
        sources: ['telegram', 'ai'], effect: 'write', aiVisible: true, timeoutMs: 1000, execute: () => { mutations++; throw new AppError('OUTCOME_UNKNOWN'); } });
      configure(['resource.uncertain']); plain(async request => calls(request, [{ id: 'resource.uncertain' }]));
      const beforeCalls = driver.calls; const actor = context(11); const ticket = await start(actor); await settled(actor, ticket, 'waiting-approval');
      await execute(actor, 'ai.run.confirm', { runId: ticket.runId, token: approvals.get(ticket.runId) }); await settled(actor, ticket, 'unknown');
      assert.equal((await app.executor.execute(actor, 'ai.run.start', { text: 'must not retry' })).error?.code, 'CONFLICT');
      await execute(actor, 'ai.run.stop', { runId: ticket.runId });
      assert.equal(mutations, 1); assert.equal(driver.calls - beforeCalls, 1);
      return { unknownReservationRetained: 100, mutations: 1, providerCalls: 1, retryRefused: true };
    });
    await scenario('ai-paged-memory-long-history-sqlite-export', async () => {
      configure(['core.info']); plain(); const actor = context(10); const scope = aiScope(actor);
      for (let i = 0; i < 12; i++) await execute(actor, 'ai.memory.remember', { text: `RESOURCE_PRIVATE_MEMORY_${i}:${'x'.repeat(1000)}` });
      const first = await execute(actor, 'ai.memory.list'); const second = await execute(actor, 'ai.memory.list', { page: first.nextCursor });
      assert.equal(first.items.length + second.items.length, 12);
      const conversation = await execute(actor, 'ai.conversations.new', { title: 'Resource private history' });
      for (let batch = 0; batch < 16; batch++) store.turnAppend(scope, conversation.id, Array.from({ length: 16 }, (_, index) => ({ actorId: 10,
        role: index % 2 ? 'assistant' : 'user', content: `RESOURCE_PRIVATE_HISTORY_${batch}_${index}:${'x'.repeat(8192)}` })));
      let page = 0; let rows = 0;
      for (let i = 0; i < 32; i++) {
        const result = await execute(actor, 'ai.conversations.history', { id: conversation.id, page }); rows += result.items.length;
        if (result.nextCursor === null) break; page = result.nextCursor;
      }
      assert.equal(rows, 256);
      const beforeBytes = deliveries.fileBytes; await execute(actor, 'ai.conversations.export', { id: conversation.id });
      assert.ok(deliveries.fileBytes - beforeBytes > 2 * 1024 ** 2);
      assert.deepEqual(await readdir(join(directory, 'state', 'ai-tmp')), []);
      assert.equal((await app.executor.execute(context(9), 'ai.conversations.history', { id: conversation.id })).error?.code, 'NOT_FOUND');
      return { memories: 12, historyTurns: rows, maxPageRows: 10, streamedExportBytes: deliveries.fileBytes - beforeBytes, sqlite: store.safeStatus() };
    });
    await scenario('ai-automations-module-event-once-quota-unknown', async () => {
      configure(['core.info', 'resource.uncertain']); const actor = context(2);
      plain(async request => request.continuation ? final() : calls(request, [{ id: 'core.info' }]));
      const create = async (trigger, tools = ['core.info']) => {
        const pending = await app.executor.execute(createInvocation({ ...actor, invocationId: randomUUID() }), 'ai.automations.create', { definition: { title: 'Resource automation', instruction: 'Resource baseline', trigger,
          tools, expiresAt: new Date(Date.now() + 60000).toISOString(), maxRuns: 1, maxInputTokens: 32768, maxOutputTokens: 1024, maxCostMicros: 100 } });
        assert.equal(pending.status, 'pending_confirmation');
        const result = await app.executor.confirm(actor, pending.confirmation.token); assert.equal(result.status, 'succeeded'); return result.data;
      };
      const event = await create({ kind: 'event', event: 'rate.converted', cooldownMinutes: 5, timeZone: 'UTC' });
      await execute(actor, 'rate.convert', { query: 'JPY USD' });
      await inbox.wait(`auto:${event.id}`, ['completed']); await nextTurn();
      const once = await create({ kind: 'once', at: new Date(Date.now() + 250).toISOString(), timeZone: 'UTC' });
      await inbox.wait(`auto:${once.id}`, ['completed']); await nextTurn();
      plain(async request => calls(request, [{ id: 'resource.uncertain' }]));
      const unknown = await create({ kind: 'once', at: new Date(Date.now() + 250).toISOString(), timeZone: 'UTC' }, ['resource.uncertain']);
      await inbox.wait(`auto:${unknown.id}`, ['unknown']); await nextTurn();
      const listed = (await execute(actor, 'ai.automations.list')).items;
      assert.equal(listed.find(item => item.id === event.id).completedRuns, 1);
      assert.equal(listed.find(item => item.id === once.id).completedRuns, 1);
      assert.equal(listed.find(item => item.id === unknown.id).state, 'unknown');
      return { moduleEvent: 'rate.converted', onceCompleted: 1, perJobRunQuota: 1, uncertainMutationState: 'unknown' };
    });
    await checkpoint('ai-full-service-retained', { sqlite: store.safeStatus(), providerCalls: driver.calls, deliveries });
  } finally {
    await app.ai.cancelAll(); inbox.close(); store.runUpdate = originalUpdate; store.recordPut = originalPut; store.recordCreate = originalCreate;
    driver.provider = () => ({ generate: async () => final() });
  }
  return operations;
}

async function extensionScenarios(app, directory, createInvocation) {
  const operations = [];
  operations.push(await measureScenario('zip-20m-disk-spool-stream-and-late-failure', async () => {
    const { withStickerZip } = await import(pathToFileURL(join(root, 'dist/src/modules/sticker-zip.js')).href);
    const filesystem = await statfs(directory);
    if (filesystem.type === 0x01021994) throw Object.assign(new Error('Fixture storage is tmpfs; no unapproved disk fallback'), { code: 'TMPFS_SPOOL_REFUSED' });
    if (filesystem.bavail * filesystem.bsize < 21 * 1024 ** 2) throw Object.assign(new Error('Insufficient isolated fixture disk'), { code: 'INSUFFICIENT_FIXTURE_DISK' });
    const base = join(directory, 'zip-fixture'); const input = await readFile(join(directory, 'fixture-1m.png'));
    let delivered = 0; let streamed = 0;
    await withStickerZip(base, (async function* () {
      for (let i = 0; i < 20; i++) yield { name: `${String(i).padStart(3, '0')}.png`, data: input };
    })(), new AbortController().signal, async file => {
      delivered++; for await (const chunk of createReadStream(file.path, { highWaterMark: 65536 })) streamed += chunk.length;
      assert.equal(streamed, file.size);
    });
    const failed = await withStickerZip(base, (async function* () {
      yield { name: '000.png', data: input }; yield { name: '000.png', data: input };
    })(), new AbortController().signal, async () => { delivered++; }).then(() => 'UNEXPECTED_SUCCESS', errorCode);
    assert.equal(failed, 'INVALID_INPUT'); assert.equal(delivered, 1); assert.deepEqual(await readdir(base), []);
    return { originalsBytes: input.length * 20, streamedArchiveBytes: streamed, lateFailureSentNothing: true, cleanup: true };
  }));
  operations.push(await measureScenario('mcp-pinned-mock-review-schema-session-cleanup', async () => {
    const { McpService, createPinnedTransport } = await import(pathToFileURL(join(root, 'dist/src/ai/mcp.js')).href);
    const scope = { ownerId: 'user:1', audience: 'private:1' };
    const profile = { id: 'resource', enabled: true, transport: 'http', url: 'https://mcp.example.com/mcp', approvedOrigin: 'https://mcp.example.com', scope, approvedTools: ['lookup'] };
    const tools = [{ name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 16 } }, required: ['query'], additionalProperties: false } }];
    let calls = 0; let cleanups = 0;
    const transport = createPinnedTransport({ credential: () => { throw new Error('UNEXPECTED_CREDENTIAL'); }, authorize: request => assert.deepEqual(request.scope, scope), network: {
      lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async (_url, request) => {
        if (request.method === 'DELETE') { cleanups++; return { status: 204, headers: {}, body: Readable.from([]) }; }
        const rpc = JSON.parse(request.body.toString('utf8'));
        if (!rpc.id) return { status: 202, headers: {}, body: Readable.from([]) };
        if (rpc.method === 'tools/call') calls++;
        const result = rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'resource', version: '1' } }
          : rpc.method === 'tools/list' ? { tools } : { content: [{ type: 'text', text: 'fixture result' }] };
        return { status: 200, headers: { 'content-type': 'application/json', ...(rpc.method === 'initialize' ? { 'mcp-session-id': 'resource-session' } : {}) },
          body: Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }))]) };
      },
    } });
    const mcp = new McpService({ profiles: () => [profile], transport });
    profile.reviewedDigest = (await mcp.discover(profile.id, scope, new AbortController().signal)).digest;
    const result = await mcp.call(profile.id, 'lookup', { query: 'fixture' }, scope, new AbortController().signal);
    assert.equal(result.isError, false);
    const invalid = await mcp.call(profile.id, 'lookup', { query: 1 }, scope, new AbortController().signal).then(() => 'UNEXPECTED_SUCCESS', errorCode);
    assert.equal(invalid, 'INVALID_EXTENSION'); assert.equal(calls, 1); assert.ok(cleanups >= 2);
    return { toolCalls: calls, deletedSessions: cleanups, invalidArgumentsRejected: true, network: 'mock pinned transport', fullRootIntegration: false };
  }));
  operations.push(await measureScenario('sandbox-real-qualification-refusal-no-user-code', async () => {
    const { LocalSandbox } = await import(pathToFileURL(join(root, 'dist/src/ai/local-sandbox.js')).href);
    const report = await new LocalSandbox().probe();
    // A fixed platform self-test, if available, is not permission to execute arbitrary user code.
    const actor = createInvocation({ actorId: 1, botId: 12345, source: 'telegram', chat: { id: 1, type: 'private' }, language: 'en' });
    const status = await app.executor.execute(actor, 'ai.admin.get', {}); assert.equal(status.status, 'succeeded');
    return { platform: report, applicationSandbox: status.data.sandbox, userCodeExecuted: false };
  }));
  return operations;
}

async function runtime() {
  // This fixture never imports index.js/loadConfig, inherits secrets, or permits an outbound socket.
  globalThis.fetch = async () => { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
  net.Socket.prototype.connect = function () { throw new Error('EXTERNAL_NETWORK_FORBIDDEN'); };
  syncBuiltinESMExports();
  let app; let runnerInput; let createInvocation; let converter; let directory;
  const aiDriver = { calls: 0, provider: () => ({ generate: async () => { throw new Error('AI_NOT_CONFIGURED'); } }) };
  let messageId = 1; let updateId = 1; let apiCalls = 0; let providerCalls = 0;
  const histogram = monitorEventLoopDelay({ resolution: 10 }); histogram.enable();
  const baselineCpu = process.cpuUsage(); const began = performance.now();
  const sampledPeak = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
  const heapSampler = createSampler(async () => {
    const value = process.memoryUsage();
    for (const name of Object.keys(sampledPeak)) sampledPeak[name] = Math.max(sampledPeak[name], value[name]);
    return { rss: value.rss };
  }, { retained: 1 });
  const memory = label => {
    const value = process.memoryUsage();
    for (const name of Object.keys(sampledPeak)) sampledPeak[name] = Math.max(sampledPeak[name], value[name]);
    return { label, atMs: performance.now() - began, memory: value, sampledPeak: { ...sampledPeak }, cpu: process.cpuUsage(baselineCpu),
      eventLoop: { meanMs: Number.isFinite(histogram.mean) ? histogram.mean / 1e6 : null, p99Ms: histogram.percentile(99) / 1e6, maxMs: histogram.max / 1e6 }, apiCalls, providerCalls };
  };
  const snapshot = label => ({ ...memory(label), port: app?.web?.server.address()?.port });
  const action = async (name, input = {}, signal) => {
    const context = createInvocation({ actorId: 1, botId: 12345, source: 'telegram', chat: { id: 1, type: 'private' }, language: 'en', ...(signal ? { signal } : {}) });
    const result = await app.executor.execute(context, name, input);
    if (result.status !== 'succeeded') throw Object.assign(new Error('Action did not succeed'), { code: result.error?.code ?? 'ACTION_UNEXPECTED_RESULT' });
    return result.data;
  };
  const measured = measureScenario;
  const location = { id: 'qweather:fixture', name: 'Fixture', label: 'Fixture', latitude: 35, longitude: 139, country: 'JP', timezone: 'Asia/Tokyo' };
  const send = value => new Promise((resolveSend, reject) => process.send(value, error => error ? reject(error) : resolveSend()));
  let chain = Promise.resolve();
  process.on('message', message => {
    chain = chain.then(async () => {
      try {
        let value;
        if (message.op === 'start') {
          directory = message.directory;
          await send({ type: 'checkpoint', value: memory('node-before-app-import') });
          const { createApplication } = await import(pathToFileURL(join(root, 'dist/src/app.js')).href);
          ({ createInvocation } = await import(pathToFileURL(join(root, 'dist/src/actions.js')).href));
          const { Bot } = await import('grammy');
          const config = { botToken: '12345:OFFLINE_RESOURCE_FIXTURE_NO_CREDENTIALS', adminIds: [1], dataDir: join(directory, 'state'), logLevel: 'silent',
            pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false,
            ai: { masterKey: '37'.repeat(32), secrets: { RESOURCE_FIXTURE: 'OFFLINE_RESOURCE_PROVIDER_NOT_A_CREDENTIAL' } },
            providers: { exchangeRateKey: 'OFFLINE_FIXTURE', qweatherHost: 'fixture.qweatherapi.com', qweatherKey: 'OFFLINE_FIXTURE', openMeteo: false },
            web: { enabled: message.http, host: '127.0.0.1', port: 0, publicBaseUrl: 'https://resource.example', oidcClientId: '12345', oidcClientSecret: 'OFFLINE_FIXTURE' } };
          const bot = new Bot(config.botToken, { client: { fetch: globalThis.fetch } });
          bot.api.config.use(async (_previous, method, payload) => {
            apiCalls++;
            if (method === 'getUpdates') throw new Error('POLLER_FORBIDDEN');
            const result = method === 'getMe' ? { id: 12345, is_bot: true, first_name: 'Resource', username: 'resource_bot' }
              : method === 'getChatMember' ? { status: 'administrator', user: { id: payload.user_id, is_bot: false, first_name: 'Fixture' } }
              : method.startsWith('send') ? { message_id: messageId++, date: 100, chat: { id: payload.chat_id, type: 'private' } } : true;
            return { ok: true, result };
          });
          const done = Promise.withResolvers(); let running = true;
          app = createApplication(config, { bot, shutdownGraceMs: 10,
            aiProvider: profile => {
              const provider = aiDriver.provider(profile);
              return { ...provider, generate: async (...args) => { aiDriver.calls++; return provider.generate(...args); } };
            },
            runnerFactory: input => { runnerInput = input; return { isRunning: () => running, task: () => done.promise, size: () => 0,
              start: () => { throw new Error('POLLER_FORBIDDEN'); }, stop: async () => { running = false; done.resolve(); } }; },
            webFactory: async dependencies => (await import(pathToFileURL(join(root, 'dist/src/web/server.js')).href)).createWebServer({ ...dependencies, staticRoot: join(directory, 'public'), oidc: {
              authorize: async attempt => new URL(`https://oauth.telegram.org/auth?state=${attempt.state}&nonce=${attempt.nonce}`),
              exchange: async () => ({ id: 1, name: 'Offline Admin' }),
            } }),
            rssFetcher: async url => {
              providerCalls++;
              const { parseFeed } = await import(pathToFileURL(join(root, 'dist/src/modules/rss-feed.js')).href);
              return { finalUrl: url, notModified: false, feed: parseFeed('<rss version="2.0"><channel><title>Fixture</title><item><guid>fixture-1</guid><title>Entry</title><description>Safe fixture</description></item></channel></rss>', url) };
            },
            rateJson: async url => { providerCalls++; return url.pathname.endsWith('/codes')
              ? { result: 'success', supported_codes: [['USD', 'US Dollar'], ['JPY', 'Japanese Yen']] }
              : { result: 'success', base_code: 'USD', conversion_rates: { USD: 1, JPY: 150 }, time_last_update_unix: Math.floor(Date.now() / 1000), time_next_update_unix: Math.floor(Date.now() / 1000) + 86400 }; },
            weatherJson: async url => { providerCalls++; return url.pathname.includes('/geo/') ? { code: '200', location: [{ id: 'fixture', name: 'Fixture', lat: '35', lon: '139', country: 'JP', tz: 'Asia/Tokyo' }] }
              : { condition: { code: 100, text: 'Clear' }, temperature: { value: 12 }, feelsLike: { value: 11 }, humidity: 0.5, wind: { speed: { value: 2 } }, precipitation: { amount: { value: 0 } } }; },
            stickerTransport: { download: async () => { throw new Error('UNEXPECTED_DOWNLOAD'); }, getSet: async () => { throw new Error('UNEXPECTED_SET'); }, send: async () => messageId++ },
          });
          await app.start(); value = snapshot('cold-started');
        } else if (message.op === 'warm') {
          value = [];
          for (const [name, input] of [['core.info', {}], ['modules.list', {}], ['alias.list', {}], ['rss.list', {}],
            ['rate.convert', { query: 'JPY USD' }], ['weather.search', { query: 'Fixture' }], ['weather.query', { location, mode: 'current', days: 3 }],
            ['subconv.settings.get', {}]]) value.push(await measured(name, () => action(name, input)));
          value.push(await measured('rss-parse-and-subscription', () => action('rss.add', { url: 'https://feeds.example.com/rss' })));
          value.push(await measured('alias-revision-write', async () => {
            const before = await action('alias.list');
            const added = await action('alias.add', { command: 'help', alias: 'fixture_help', revision: before.revision });
            await action('alias.remove', { command: 'help', alias: 'fixture_help', revision: added.revision });
          }));
          value.push(await measured('subconv-local-generation-and-noop-write', async () => {
            const before = await action('subconv.settings.get');
            const updated = await action('subconv.settings.set', { revision: before.revision, settings: { ...before.settings, backend: 'https://converter.example' } });
            await action('subconv.generate', { revision: updated.revision, source: 'https://source.example/sub', customParams: [] });
          }));
          value.push(await measured('telegram-controls', async () => {
            for (const text of ['/help', '/commands', '/sticker', '/cancel']) await runnerInput.handleUpdate({ update_id: updateId++, message: {
              message_id: messageId++, date: 100, chat: { id: 1, type: 'private' }, from: { id: 1, is_bot: false, first_name: 'Fixture', language_code: 'en' }, text,
              entities: [{ type: 'bot_command', offset: 0, length: text.length }],
            } });
          }));
        } else if (message.op === 'ai') {
          value = await aiScenarios(app, directory, aiDriver, createInvocation, async (label, details) => send({ type: 'checkpoint', value: { ...memory(label), ...details } }));
        } else if (message.op === 'extras') {
          value = await extensionScenarios(app, directory, createInvocation);
        } else if (message.op === 'media') {
          value = [];
          for (const [file, kind, format] of [['png', 'static', 'png'], ['tgs', 'animated', 'png'], ['tgs', 'animated', 'gif'], ['webm', 'video', 'png'], ['webm', 'video', 'gif']]) {
            value.push(await measured(`fixed-child-${kind}-${format}-32px-candidate`, async () => {
              const { createStickerConverter } = await import(pathToFileURL(join(root, 'dist/src/modules/sticker-media.js')).href);
              const { ResourcePolicy } = await import(pathToFileURL(join(root, 'dist/src/resources.js')).href);
              // BENCHMARK CANDIDATE ONLY: this is neither production configuration nor a qualification claim.
              converter ??= createStickerConverter({ resources: new ResourcePolicy({ heavyBytes: 96 * 1024 ** 2 }) });
              const data = await readFile(join(directory, `fixture.${file}`));
              for (let i = 0; i < 2; i++) {
                const result = await converter({ data, kind, format, width: 32, height: 32, media: false }, new AbortController().signal);
                if (!result.data.length || result.format !== format || result.width !== 32 || result.height !== 32) throw new Error('INVALID_MEDIA_OUTPUT');
              }
            }));
          }
          value.push(await measured('native-child-cancel-then-next-job', async () => {
            const data = await readFile(join(directory, 'fixture.tgs'));
            const request = { data, kind: 'animated', format: 'gif', width: 32, height: 32, media: false };
            const controller = new AbortController();
            const work = converter(request, controller.signal);
            const start = performance.now(); controller.abort();
            const code = await work.then(() => 'UNEXPECTED_SUCCESS', errorCode);
            if (code !== 'CANCELLED') throw new Error('NATIVE_CANCEL_FAILED');
            await send({ type: 'checkpoint', value: { ...memory('native-cancelled'), cancellationMs: performance.now() - start } });
            await converter(request, new AbortController().signal);
          }));
          value.push(await measured('rss-photo-fixed-child-32px-candidate', async () => {
            const { createRssPhotoPreparer } = await import(pathToFileURL(join(root, 'dist/src/modules/rss-photo.js')).href);
            const { ResourcePolicy } = await import(pathToFileURL(join(root, 'dist/src/resources.js')).href);
            const data = await readFile(join(directory, 'fixture.png'));
            const prepare = createRssPhotoPreparer(async () => data, { resources: new ResourcePolicy({ heavyBytes: 96 * 1024 ** 2 }) });
            for (let i = 0; i < 2; i++) {
              const result = await prepare('https://images.example.com/fixture.png', new AbortController().signal);
              if (!result.data.length || result.sourceBytes !== data.length) throw new Error('INVALID_PHOTO_OUTPUT');
            }
          }));
        } else if (message.op === 'providers') {
          value = [];
          for (const [protocol, origin, events] of [
            ['openai-responses', 'https://api.openai.com', [
              { type: 'response.output_text.delta', delta: 'Fixture' },
              { type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Fixture' }] }], usage: { input_tokens: 2, output_tokens: 1 } } },
            ]],
            ['openai-chat-completions', 'https://api.deepseek.com', [
              { choices: [{ index: 0, delta: { content: 'Fixture' }, finish_reason: 'stop' }] }, '[DONE]',
            ]],
            ['anthropic-messages', 'https://api.anthropic.com', [
              { type: 'message_start', message: { usage: { input_tokens: 2, output_tokens: 0 } } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Fixture' } },
              { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' },
            ]],
            ['google-generate-content', 'https://generativelanguage.googleapis.com', [
              { candidates: [{ index: 0, content: { parts: [{ text: 'Fixture' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1 } },
            ]],
          ]) value.push(await measured(`native-${protocol}-small-sse`, async () => {
            const { createAiProvider } = await import(pathToFileURL(join(root, 'dist/src/ai/providers.js')).href);
            const { createAiTransport } = await import(pathToFileURL(join(root, 'dist/src/ai/transport.js')).href);
            const transport = createAiTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => {
              providerCalls++;
              const body = Buffer.from(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join(''));
              return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from((async function* () {
                for (let i = 0; i < body.length; i += 23) yield body.subarray(i, i + 23);
              })()) };
            } });
            const provider = createAiProvider({ protocol, origin, model: 'fixture-model', apiKey: 'OFFLINE_FIXTURE', capabilities: { input: ['text'], output: ['text'] } }, { transport });
            for (let i = 0; i < 3; i++) {
              const result = await provider.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture' }] }] }, { signal: new AbortController().signal });
              if (result.text !== 'Fixture') throw new Error('INVALID_FIXTURE_OUTPUT');
            }
          }));
          for (const operation of ['search', 'fetch']) value.push(await measured(`deepseek-${operation}-small-json`, async () => {
            const { createDeepSeekRetrieval } = await import(pathToFileURL(join(root, 'dist/src/ai/retrieval.js')).href);
            const { createAiTransport } = await import(pathToFileURL(join(root, 'dist/src/ai/transport.js')).href);
            const lookup = async () => [{ address: '93.184.216.34', family: 4 }];
            const transport = createAiTransport({ lookup, request: async () => {
              providerCalls++;
              const item = { title: 'Fixture', content: 'Fixture content' };
              return { status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from([Buffer.from(JSON.stringify(operation === 'search'
                ? { results: [{ ...item, url: 'https://docs.example.com/item', snippet: '', summary: '' }] } : item))]) };
            } });
            const retrieval = createDeepSeekRetrieval({ apiKey: 'OFFLINE_FIXTURE', lookup, transport });
            const result = await retrieval[operation](operation === 'search' ? { query: 'Fixture' } : { url: 'https://docs.example.com/item' }, { signal: new AbortController().signal });
            if (result.trust !== 'untrusted' || result.results.length !== 1) throw new Error('INVALID_RETRIEVAL_OUTPUT');
          }));
          value.push(await measured('native-provider-cancel-and-control-lane', async () => {
            const { createAiProvider } = await import(pathToFileURL(join(root, 'dist/src/ai/providers.js')).href);
            const { createAiTransport } = await import(pathToFileURL(join(root, 'dist/src/ai/transport.js')).href);
            const body = new PassThrough(); const entered = Promise.withResolvers();
            const transport = createAiTransport({ lookup: async () => [{ address: '93.184.216.34', family: 4 }], request: async () => {
              body.write('data: {"type":"response.output_text.delta","delta":"Fixture"}\n\n');
              return { status: 200, headers: { 'content-type': 'text/event-stream' }, body };
            } });
            const provider = createAiProvider({ protocol: 'openai-responses', origin: 'https://api.openai.com', model: 'fixture-model', apiKey: 'OFFLINE_FIXTURE',
              capabilities: { input: ['text'], output: ['text'] } }, { transport });
            const controller = new AbortController();
            const work = provider.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Fixture' }] }] },
              { signal: controller.signal, onText: () => entered.resolve() }).then(() => 'UNEXPECTED_SUCCESS', errorCode);
            try {
              await Promise.race([entered.promise, work.then(() => { throw new Error('PROVIDER_NOT_STARTED'); })]);
              await action('core.info');
              const start = performance.now(); controller.abort();
              if (await work !== 'CANCELLED' || !body.destroyed) throw new Error('PROVIDER_NOT_DRAINED');
              await send({ type: 'checkpoint', value: { ...memory('provider-cancelled'), cancellationMs: performance.now() - start } });
            } finally { controller.abort(); body.destroy(); await work; }
          }));
        } else if (message.op === 'cancel') {
          value = await measured('action-cancellation-and-control-lane', async () => {
            const { z } = await import('zod');
            const entered = Promise.withResolvers();
            app.executor.register({ id: 'resource.blocked', input: z.strictObject({}), output: z.strictObject({}), permission: 'self', scopes: ['private'], sources: ['telegram'], effect: 'read', aiVisible: false, timeoutMs: 5000,
              execute: async (_input, context) => { entered.resolve(); await new Promise(resolveAbort => context.signal.addEventListener('abort', resolveAbort, { once: true })); return {}; } });
            const controller = new AbortController();
            const work = action('resource.blocked', {}, controller.signal).catch(() => undefined);
            await entered.promise;
            await action('core.info');
            const start = performance.now(); controller.abort(); await work;
            await send({ type: 'checkpoint', value: { ...memory('cancelled'), cancellationMs: performance.now() - start } });
          });
        } else if (message.op === 'snapshot') { await delay(100); value = snapshot(message.label); }
        else if (message.op === 'stop') { const start = performance.now(); await app?.stop(); await app?.done; histogram.disable(); await heapSampler.stop(); value = { ...snapshot('stopped'), shutdownMs: performance.now() - start }; }
        else throw new Error('UNKNOWN_OPERATION');
        await send({ id: message.id, value });
        if (message.op === 'stop') process.disconnect();
      } catch (error) { await send({ id: message.id, error: errorCode(error) }); }
    });
  });
  process.on('disconnect', () => { histogram.disable(); void heapSampler.stop(); void chain.then(() => app?.stop()); });
}

async function main() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error('Use Node.js 24 for comparable runtime measurements');
  const options = parseOptions(process.argv.slice(2));
  const probe = await probeLimits(options.cgroupParent);
  if (options.probe) { console.log(JSON.stringify({ platform: process.platform, node: process.version, limits: LIMITS, probe, qualified: false }, null, 2)); if (options.requireLimit) process.exitCode = 2; return; }
  const variants = [];
  for (const http of options.http === 'both' ? [false, true] : [options.http === 'on']) {
    const group = await createLimitGroup(probe);
    if (options.requireLimit && !group.applied) {
      console.log(JSON.stringify({ qualified: false, status: 'unqualified', reason: group.reason, measured: [], missing: MISSING_SCENARIOS }, null, 2)); process.exitCode = 2; return;
    }
    try { variants.push(await runVariant({ http, iterations: options.iterations, group, base: options.diskFixtures ? root : '/tmp/kilo' })); }
    finally { await group.cleanup?.(); }
  }
  const qualified = variants.every(result => result.gate.qualified);
  console.log(JSON.stringify({ version: 1, node: process.version, limits: LIMITS, qualified, status: qualified ? 'qualified' : 'unqualified',
    accounting: 'Parent orchestration/TCP driver/build/fixture encoding outside budget; child fixture hooks and assertions counted conservatively. Runtime + descendants in fresh cgroup when available. RSS is diagnostic, not charged memory. Child heap/external excludes native descendants; cgroup includes them and charged filesystem cache. Cold means fresh process, not flushed host filesystem caches. Media is a fixture-only 96MiB admission candidate, not production qualification.', variants }, null, 2));
  if (variants.some(result => !result.completed) || options.requireLimit && !qualified) process.exitCode = 2;
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  if (process.argv[2] === '--child' && process.send) await runtime();
  else await main().catch(error => { console.error(JSON.stringify({ status: 'unqualified', error: errorCode(error) })); process.exitCode = 2; });
}
