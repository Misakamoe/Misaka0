import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Bot } from 'grammy';
import { createApplication } from './dist/src/app.js';
import { createInvocation } from './dist/src/actions.js';
import { LocalSandbox, verifyLocalSandboxBuildIdentity } from './dist/src/ai/local-sandbox.js';

assert.notEqual(process.getuid(), 0);
for (const path of ['/app/.env', '/app/legacy', '/app/tests', '/app/scripts', '/usr/bin/gcc', '/usr/bin/cc']) {
  await assert.rejects(access(path), { code: 'ENOENT' });
}
const manifestBytes = await readFile('/app/dist/sandbox/manifest.json');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.available, true);
verifyLocalSandboxBuildIdentity(await readFile('/app/dist/sandbox/sandbox-runner'), manifestBytes);
for (const path of ['/app/dist', '/app/dist/sandbox', '/app/dist/sandbox/sandbox-runner', '/app/dist/src/ai/local-sandbox.js']) {
  const info = await stat(path); assert.equal(info.uid, 0); assert.equal(info.mode & 0o022, 0);
}
assert.equal(spawnSync('/usr/bin/ffmpeg', ['-version'], { env: {}, timeout: 5000, maxBuffer: 65536 }).status, 0);

const directory = await mkdtemp('/tmp/misaka-image-smoke-');
const token = '12345:OFFLINE_FIXTURE_NEVER_NETWORK';
const bot = new Bot(token, { client: { fetch: () => { throw new Error('NETWORK_FORBIDDEN'); } } });
const methods = new Set();
const runnerDone = Promise.withResolvers();
let running = false;
bot.api.config.use(async (_next, method) => {
  methods.add(method);
  return { ok: true, result: method === 'getMe'
    ? { id: 12345, is_bot: true, first_name: 'Offline fixture', username: 'offline_fixture_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, has_topics_enabled: false }
    : true };
});
const app = createApplication({ botToken: token, adminIds: [1], dataDir: directory, logLevel: 'silent',
  pollingTimeout: 1, requestTimeout: 5, dropPendingUpdates: false,
  web: { enabled: true, host: '127.0.0.1', port: 8080, publicBaseUrl: 'https://127.0.0.1:8080' },
  providers: { openMeteo: false } }, {
  bot, runnerFactory: () => {
    running = true;
    return { start() { running = true; }, async stop() { running = false; runnerDone.resolve(); },
      size: () => 0, isRunning: () => running, task: () => runnerDone.promise };
  },
});
try {
  await app.start();
  const context = createInvocation({ botId: 12345, actorId: 1, source: 'telegram', chat: { id: 1, type: 'private' }, language: 'en' });
  const result = await app.executor.execute(context, 'core.status', {});
  assert.equal(result.status, 'succeeded');
  assert.equal(result.data.http, 'running');
  assert.equal(result.data.resources.cgroup.memoryLimitBytes, 268435456);
  assert.equal(result.data.resources.cgroup.cpuQuotaCores, 1);
  const ai = await app.executor.execute(context, 'ai.admin.get', {});
  assert.equal(ai.status, 'succeeded');
  assert.equal(ai.data.status.available, true);
  assert.equal(ai.data.settings.enabled, false);
  const keyInfo = await stat(`${directory}/ai-master.key`);
  assert.equal(keyInfo.size, 32); assert.equal(keyInfo.mode & 0o777, 0o600);
  const methodsResponse = await globalThis.fetch('http://127.0.0.1:8080/auth/methods', { signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(methodsResponse.status, 200);
  assert.deepEqual(await methodsResponse.json(), { oidc: false, miniapp: true });
  assert.equal(methods.has('getUpdates'), false);
  const local = await new LocalSandbox().probe();
  console.log(JSON.stringify({ runtimeStarted: true, pollingIsMocked: true, networkDisabled: true,
    automaticAiStorageVerified: true, miniAppWithoutOidcVerified: true,
    compiledBundleVerified: true, uid: process.getuid(), process: result.data.resources.process,
    cgroup: result.data.resources.cgroup, localQualification: local }, null, 2));
} finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
