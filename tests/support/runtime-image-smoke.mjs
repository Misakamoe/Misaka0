import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { Bot } from 'grammy';
import { createApplication } from './dist/src/app.js';
import { createInvocation } from './dist/src/actions.js';
import { LocalSandbox, verifyLocalSandboxBuildIdentity } from './dist/src/ai/local-sandbox.js';
import { confirmationSubjectSchema } from './dist/shared/schemas/index.js';
import { rssKeywordFiltersSchema } from './dist/shared/schemas/rss.js';
import { RSS_PHOTO_MAX_DIMENSION, RSS_PHOTO_MAX_INPUT_PIXELS, RSS_PHOTO_MAX_REPAIR_BYTES } from './dist/src/modules/rss-photo.js';
import { aiAnswerContent } from './dist/src/telegram/ai-rich.js';

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
assert.deepEqual(rssKeywordFiltersSchema.parse({ include: [' NASA '], exclude: ['advertisement'] }),
  { include: ['NASA'], exclude: ['advertisement'] });
assert.deepEqual(confirmationSubjectSchema.parse({ kind: 'rss', id: '3ab58ce2bce3', title: 'Offline feed' }),
  { kind: 'rss', id: '3ab58ce2bce3', title: 'Offline feed' });
assert.equal(RSS_PHOTO_MAX_INPUT_PIXELS, 20_000_000);
assert.equal(RSS_PHOTO_MAX_REPAIR_BYTES, 8 * 1024 * 1024);
assert.equal(RSS_PHOTO_MAX_DIMENSION, 1280);
const richAnswer = aiAnswerContent('**Production parser**');
assert.equal(richAnswer.skip_entity_detection, true);
assert.ok(JSON.stringify(richAnswer).includes('"type":"bold"'));

const directory = await mkdtemp('/tmp/misaka-image-smoke-');
const token = '12345:OFFLINE_FIXTURE_NEVER_NETWORK';
const bot = new Bot(token, { client: { fetch: () => { throw new Error('NETWORK_FORBIDDEN'); } } });
const methods = new Set();
const sent = [];
const me = { id: 12345, is_bot: true, first_name: 'Offline fixture', username: 'offline_fixture_bot',
  can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, has_topics_enabled: false };
const runnerDone = Promise.withResolvers();
let running = false;
bot.api.config.use(async (_next, method, payload) => {
  methods.add(method);
  if (method === 'sendRichMessage' || method === 'sendMessage') {
    sent.push(globalThis.structuredClone(payload));
    return { ok: true, result: { message_id: sent.length, date: Math.floor(Date.now() / 1000), from: me,
      chat: { id: payload.chat_id, type: 'private', first_name: 'Offline owner' } } };
  }
  return { ok: true, result: method === 'getMe' ? me : true };
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
  const modules = await app.executor.execute(context, 'modules.list', {});
  assert.equal(modules.status, 'succeeded');
  assert.deepEqual(modules.data.map(item => item.id), ['alias', 'rss', 'rate', 'weather', 'sticker', 'subconv', 'relay']);
  const relay = await app.executor.execute(context, 'relay.settings.get', {});
  assert.equal(relay.status, 'succeeded');
  assert.deepEqual(relay.data, { enabled: false, ownerBound: false, revision: 0 });
  const ai = await app.executor.execute(context, 'ai.admin.get', {});
  assert.equal(ai.status, 'succeeded');
  assert.equal(ai.data.status.available, true);
  assert.equal(ai.data.settings.enabled, false);
  const keyInfo = await stat(`${directory}/ai-master.key`);
  assert.equal(keyInfo.size, 32); assert.equal(keyInfo.mode & 0o777, 0o600);
  const methodsResponse = await globalThis.fetch('http://127.0.0.1:8080/auth/methods', { signal: globalThis.AbortSignal.timeout(5000) });
  assert.equal(methodsResponse.status, 200);
  assert.deepEqual(await methodsResponse.json(), { oidc: false, miniapp: true });
  const chat = { id: 1, type: 'private', first_name: 'Offline owner' };
  const date = Math.floor(Date.now() / 1000);
  await bot.handleUpdate({ update_id: 100, message: { message_id: 100, date, chat,
    from: { id: 1, is_bot: false, first_name: 'Offline owner', language_code: 'en' }, text: '/id',
    reply_to_message: { message_id: 99, date, chat, from: me, text: 'Previous bot message' } } });
  const identity = sent.at(-1)?.rich_message;
  assert.equal(identity?.skip_entity_detection, true);
  assert.ok(JSON.stringify(identity).includes('"type":"code","text":"12345"'));
  assert.ok(JSON.stringify(identity).includes('"copy_text":{"text":"12345"}'));
  assert.equal(methods.has('getUpdates'), false);
  const local = await new LocalSandbox().probe();
  console.log(JSON.stringify({ runtimeStarted: true, pollingIsMocked: true, networkDisabled: true,
    automaticAiStorageVerified: true, miniAppWithoutOidcVerified: true,
    nativeModulesVerified: modules.data.length, relayDisabledByDefault: true, keywordFiltersVerified: true,
    authoritativeApprovalSubjectVerified: true, copyableReplyIdentityVerified: true, productionRichTextParserVerified: true,
    boundedRssPreviewPixels: RSS_PHOTO_MAX_INPUT_PIXELS,
    compiledBundleVerified: true, uid: process.getuid(), process: result.data.resources.process,
    cgroup: result.data.resources.cgroup, localQualification: local }, null, 2));
} finally { await app.stop(); await rm(directory, { recursive: true, force: true }); }
