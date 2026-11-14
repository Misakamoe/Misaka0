import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiPersonalSetupSchema, type AiPersonalSetup } from '../shared/schemas/ai-admin.js';
import { aiDefaults, aiInteractiveBudget, aiInteractiveDailyRuns, aiProtocolSchema } from '../shared/schemas/ai.js';
import { ActionExecutor } from '../src/actions.js';
import { AiService } from '../src/ai/service.js';
import { AiStore } from '../src/ai/store.js';
import { buildMisakaSystemInstructions } from '../src/ai/persona.js';
import { aiScope } from '../src/ai/policy.js';
import { createAiProvider, type AiProvider, type GenerationRequest, type ProviderProfile } from '../src/ai/providers.js';
import type { AiTransport } from '../src/ai/transport.js';
import type { AiDelivery } from '../src/ai/telegram-port.js';
import { loadAiMasterKey } from '../src/ai/vault.js';
import type { StartupConfig } from '../src/config.js';
import { AsyncMutex } from '../src/storage.js';
import { coreFixture, invocation, testToken } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
async function directory() {
  const path = await mkdtemp('/tmp/kilo/misaka-ai-setup-');
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
const input: AiPersonalSetup = { revision: 0, protocol: 'openai-responses', baseUrl: 'https://provider.invalid/v1', model: 'mock-text',
  apiKey: 'ISOLATED_SETUP_TEST_SECRET', groupIds: [] };
const admin = () => invocation({ source: 'http' });
const providerToolName = (id: string) => `action_${createHash('sha256').update(id).digest('hex').slice(0, 56)}`;

async function fixture(options: Parameters<typeof coreFixture>[0] = {}) {
  const core = await coreFixture(options);
  const config: StartupConfig = { botToken: testToken, adminIds: [1, 2], dataDir: core.directory, logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 } };
  const provider = vi.fn<(profile: ProviderProfile) => AiProvider>(() => { throw new Error('No provider network in setup tests'); });
  const ai = new AiService({ config, access: core.access, provider, storageLock: core.storage.lock });
  const executor = new ActionExecutor({ ...core.services, ai,
    aiPolicy: { available: context => ai.available(context), authorize: (context, id, effect) => ai.authorize(context, id, effect),
      approvalExempt: (context, id) => ai.approvalExempt(context, id) } });
  ai.attachExecutor(executor);
  cleanups.push(async () => { await ai.stop(); await executor.close(); core.subconv.stop(); await core.close(); });
  await ai.initialize();
  return { ...core, config, ai, executor, provider, store: ai.data(admin()) };
}

describe('automatic durable AI master key', () => {
  it('publishes exactly 32 private bytes and reuses the same key across races and restarts', async () => {
    const dir = await directory();
    const keys = await Promise.all(Array.from({ length: 8 }, () => loadAiMasterKey(dir)));
    expect(keys.every(key => key.equals(keys[0]!))).toBe(true);
    const stat = await lstat(join(dir, 'ai-master.key'));
    expect(stat.mode & 0o777).toBe(0o600); expect(stat.size).toBe(32);
    expect(await readdir(dir)).toEqual(['ai-master.key']);
    expect(await loadAiMasterKey(dir)).toEqual(keys[0]);
    keys.forEach(key => key.fill(0));
  });

  it('ignores an interrupted unpublished temporary key and reuses an already published key without a database', async () => {
    const dir = await directory();
    await mkdir(join(dir, '.ai-key-interrupted'), { mode: 0o700 });
    await writeFile(join(dir, '.ai-key-interrupted/key'), Buffer.alloc(7), { mode: 0o600 });
    const key = await loadAiMasterKey(dir);
    expect(key.length).toBe(32);
    expect(await loadAiMasterKey(dir)).toEqual(key);
    expect(await readFile(join(dir, '.ai-key-interrupted/key'))).toEqual(Buffer.alloc(7));
  });

  it.each([0, 31, 33, 64])('rejects a malformed %i-byte key without replacing it or creating a database', async size => {
    const dir = await directory(); const bytes = Buffer.alloc(size, 1);
    await writeFile(join(dir, 'ai-master.key'), bytes, { mode: 0o600 });
    await expect(loadAiMasterKey(dir)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(await readFile(join(dir, 'ai-master.key'))).toEqual(bytes);
    expect(await readdir(dir)).toEqual(['ai-master.key']);
  });

  it('rejects unsafe key permissions, key symlinks and directory symlinks', async () => {
    const dir = await directory(); const key = join(dir, 'ai-master.key');
    await writeFile(key, Buffer.alloc(32, 2), { mode: 0o644 });
    await expect(loadAiMasterKey(dir)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    await rm(key); await writeFile(join(dir, 'elsewhere'), Buffer.alloc(32, 3), { mode: 0o600 });
    await symlink(join(dir, 'elsewhere'), key);
    await expect(loadAiMasterKey(dir)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    const parent = await directory(); await symlink(dir, join(parent, 'link'));
    await expect(loadAiMasterKey(join(parent, 'link'))).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it.each(['ai.sqlite', 'ai.sqlite-wal', 'ai.sqlite-shm', 'ai.sqlite-journal'])('never generates a missing key next to existing %s', async name => {
    const dir = await directory(); await writeFile(join(dir, name), 'preserved-test-data');
    await expect(loadAiMasterKey(dir)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
    expect(await readdir(dir)).toEqual([name]);
    expect(await readFile(join(dir, name), 'utf8')).toBe('preserved-test-data');
  });

  it('keeps the explicit environment key supported without writing an automatic key', async () => {
    const dir = await directory();
    expect(await loadAiMasterKey(dir, 'ab'.repeat(32))).toEqual(Buffer.alloc(32, 0xab));
    expect(await readdir(dir)).toEqual([]);
    await expect(loadAiMasterKey(dir, 'bad')).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });

  it('holds key and database initialization under the supplied shared lock', async () => {
    const f = await fixture(); await f.ai.stop();
    const dir = await directory(); const lock = new AsyncMutex(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    const holder = lock.run(async () => { entered.resolve(); await release.promise; }); await entered.promise;
    const ai = new AiService({ config: { ...f.config, dataDir: dir }, access: f.access, storageLock: lock });
    const started = ai.initialize();
    try {
      expect(await readdir(dir)).toEqual([]);
      release.resolve(); await holder; await started;
      expect(await readdir(dir)).toContain('ai-master.key'); expect(await readdir(dir)).toContain('ai.sqlite');
    } finally { release.resolve(); await started; await ai.stop(); }
  });
});

describe('fresh personal setup transaction', () => {
  it.each([['openai-responses', 8192], ['openai-chat-completions', 8192], ['openai-responses', 2048]] as const)('enforces real persona/catalog and unknown-usage read-roundtrip budgets: %s/%i', async (protocol, outputLimit) => {
    const weatherJson = vi.fn(async () => ({ results: [{ id: 1, name: 'Tokyo', country: 'Japan', latitude: 35.68, longitude: 139.69, timezone: 'Asia/Tokyo' }] }));
    const rateJson = vi.fn(async () => { throw new Error('No rate network in same-currency conversion'); });
    const f = await fixture({ weather: { json: weatherJson }, rate: { json: rateJson } });
    const conversion = vi.spyOn(f.rate, 'convert'); const weather = vi.spyOn(f.weather, 'search');
    const requests: GenerationRequest[] = [];
    const reply = 'A bounded ordinary reply with the verified currency conversion and Tokyo location. '.repeat(26);
    const calls = [{ id: 'read-rate', name: providerToolName('rate.convert'), arguments: { amount: '2', from: 'USD', to: 'USD' } },
      { id: 'read-weather', name: providerToolName('weather.search'), arguments: { query: 'Tokyo' } }];
    const post = vi.fn<AiTransport['post']>(async (request, options) => {
      expect(Buffer.byteLength(JSON.stringify(request.body))).toBeLessThanOrEqual(requests.at(-1)!.maxInputTokens!);
      const first = requests.length === 1;
      if (protocol === 'openai-responses') {
        await options.onEvent!({ event: 'message', data: JSON.stringify({ type: 'response.completed', response: { status: 'completed', model: input.model,
          output: first ? calls.map(call => ({ type: 'function_call', call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
            : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }],
        } }) });
      } else {
        await options.onEvent!({ event: 'message', data: JSON.stringify({ choices: [{ index: 0, delta: first ? { role: 'assistant',
          tool_calls: calls.map((call, index) => ({ index, id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })),
        } : { role: 'assistant', content: reply }, finish_reason: first ? 'tool_calls' : 'stop' }] }) });
        await options.onEvent!({ event: 'message', data: '[DONE]' });
      }
    });
    f.provider.mockImplementation(profile => {
      const native = createAiProvider(profile, { transport: { post } });
      return { ...native, generate: (request, options) => { requests.push(structuredClone(request)); return native.generate(request, options); } };
    });
    const delivery = { started: vi.fn<AiDelivery['started']>(async () => {}), progress: vi.fn<AiDelivery['progress']>(async () => {}),
      approval: vi.fn<AiDelivery['approval']>(async () => {}), completed: vi.fn<AiDelivery['completed']>(async () => 42),
      failed: vi.fn<AiDelivery['failed']>(async () => {}), file: vi.fn<AiDelivery['file']>(async () => {}), retire: vi.fn<AiDelivery['retire']>(async () => {}) };
    f.ai.attachTelegram(delivery, async () => { throw new Error('No downloads in text setup regression'); });
    f.ai.personalSetup(admin(), { ...input, protocol, baseUrl: 'https://api.openai.com/v1' });
    if (outputLimit === 2048) {
      const existing = f.store.getSettings(); existing.settings.presets[0]!.budget.maxOutputTokens = outputLimit;
      f.store.updateSettings(existing.settings, existing.revision);
    }
    const context = invocation();
    const ticket = await f.executor.execute(context, 'ai.run.start', { text: 'Convert two USD to USD and find Tokyo, then summarize the results.' });
    expect(ticket.status, JSON.stringify(ticket)).toBe('succeeded');
    if (ticket.status !== 'succeeded') throw new Error('Expected admitted setup run');
    const { runId } = ticket.data as { runId: string };
    await vi.waitFor(() => expect(['queued', 'running']).not.toContain(f.ai.runView(context, runId).state));
    const view = f.ai.runView(context, runId);
    expect(view, JSON.stringify({ view, requests: requests.length })).toMatchObject({ state: 'completed' });
    const budget = f.store.getSettings().settings.presets[0]!.budget;
    expect(budget).toEqual({ ...aiInteractiveBudget(), maxOutputTokens: outputLimit });
    expect(f.store.getSettings().settings.limits.dailyRuns).toBe(aiInteractiveDailyRuns);
    expect(requests).toHaveLength(2); expect(post).toHaveBeenCalledTimes(2);
    expect(requests[0]!.system).toContain(buildMisakaSystemInstructions());
    expect(Buffer.byteLength(requests[0]!.system!)).toBeGreaterThan(2000);
    expect(requests[0]!.tools!.map(tool => tool.name).sort()).toEqual(['rate.convert', 'rate.currencies', 'weather.search', 'weather.query'].map(providerToolName).sort());
    expect(requests[0]!.tools!.find(tool => tool.name === providerToolName('weather.query'))!.inputSchema).toHaveProperty('properties.location.properties.latitude');
    expect(requests[1]!.system).toBe(requests[0]!.system); expect(requests[1]!.tools).toEqual(requests[0]!.tools);
    expect(requests[1]!.toolResults).toMatchObject([{ id: 'read-rate', result: { status: 'succeeded', data: { kind: 'converted', amount: '2', result: '2' } } },
      { id: 'read-weather', result: { status: 'succeeded', data: { locations: [{ name: 'Tokyo' }] } } }]);
    const inputTokens = requests.reduce((total, request) => total + request.maxInputTokens!, 0);
    const outputTokens = requests.reduce((total, request) => total + request.maxOutputTokens!, 0);
    expect(inputTokens).toBeLessThanOrEqual(budget.maxInputTokens * (budget.maxToolCalls + 1));
    expect(outputTokens).toBeLessThanOrEqual(budget.maxOutputTokens * (budget.maxToolCalls + 1));
    expect(requests.every(request => request.maxOutputTokens === outputLimit)).toBe(true);
    expect(requests.every(request => request.maxInputTokens === budget.maxInputTokens)).toBe(true);
    expect(f.store.runGet(aiScope(context), runId)!.continuation).toMatchObject({ inputTokens, outputTokens, calls: 2, steps: 2, billingUnknown: true });
    expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 100000, settledCostMicros: 0 });
    expect(conversion).toHaveBeenCalledOnce(); expect(weather).toHaveBeenCalledOnce(); expect(weatherJson).toHaveBeenCalledOnce(); expect(rateJson).not.toHaveBeenCalled();
    expect(delivery.failed).not.toHaveBeenCalled(); expect(delivery.approval).not.toHaveBeenCalled();
    expect(delivery.completed).toHaveBeenCalledWith(expect.anything(), reply, expect.any(AbortSignal));
  });

  it.each(aiProtocolSchema.options)('stores %s, owner and allowlisted groups in one encrypted revision', async protocol => {
    const f = await fixture(); await f.access.authorize(-100, 'test group', 1, 0);
    const result = await f.executor.execute(admin(), 'ai.admin.setup', { ...input, protocol, groupIds: [-100] });
    expect(result).toMatchObject({ status: 'succeeded', data: { revision: 1, settings: { enabled: true, limits: { dailyRuns: aiInteractiveDailyRuns } } } });
    const snapshot = f.ai.admin(admin());
    expect(snapshot.settings.providers[0]).toMatchObject({ protocol, baseUrl: input.baseUrl, allowedOrigins: ['https://provider.invalid'] });
    expect(snapshot.settings.presets[0]).toMatchObject({ budgetMode: 'usage', inputCapabilities: ['text'], outputCapabilities: ['text'],
      tools: ['rate.convert', 'rate.currencies', 'weather.search', 'weather.query'] });
    expect(snapshot.settings.presets[0]?.pricing).toBeUndefined();
    expect(snapshot.settings.grants).toMatchObject([{ kind: 'private', subjectId: 1 }, { kind: 'group', subjectId: -100 }]);
    expect(snapshot.credentials).toMatchObject([{ source: 'vault', hasValue: true }]);
    expect(JSON.stringify(result)).not.toContain(input.apiKey); expect(JSON.stringify(f.audit.mock.calls)).not.toContain(input.apiKey);
    expect(f.provider).not.toHaveBeenCalled();
    const ref = snapshot.settings.providers[0]!.credentialRef;
    await f.ai.stop();
    expect((await readFile(join(f.directory, 'ai.sqlite'))).includes(Buffer.from(input.apiKey))).toBe(false);
    const reopened = new AiService({ config: f.config, access: f.access });
    try { await reopened.initialize(); expect(reopened.credential(ref)).toBe(input.apiKey); expect(reopened.admin(admin()).revision).toBe(1); }
    finally { await reopened.stop(); }
  });

  it('rejects caller identity, coercion, insecure endpoints, duplicate groups and masked keys', () => {
    for (const value of [{ ...input, ownerId: 2 }, { ...input, revision: '0' }, { ...input, groupIds: [-100, -100] },
      { ...input, baseUrl: 'http://provider.invalid' }, { ...input, baseUrl: 'https://user:password@provider.invalid' },
      { ...input, baseUrl: 'https://provider.invalid?key=secret' }, { ...input, groupIds: [1] }, { ...input, apiKey: '***' }, { ...input, apiKey: '   ' }]) {
      expect(aiPersonalSetupSchema.safeParse(value).success).toBe(false);
    }
  });

  it('requires an HTTP private superadmin and current group allowlisting', async () => {
    const f = await fixture();
    for (const context of [invocation(), invocation({ source: 'http', actorId: 3, chat: { id: 3, type: 'private' } }),
      invocation({ source: 'ai' }), invocation({ source: 'http', chat: { id: -100, type: 'supergroup' } })]) {
      expect(await f.executor.execute(context, 'ai.admin.setup', input)).toHaveProperty('error');
    }
    expect(await f.executor.execute(admin(), 'ai.admin.setup', { ...input, groupIds: [-100] })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    await f.access.authorize(-100, 'test', 1, 0); await f.access.revoke(-100, 1, f.access.snapshot().revision);
    expect(await f.executor.execute(admin(), 'ai.admin.setup', { ...input, groupIds: [-100] })).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(f.store.getSettings()).toEqual({ revision: 0, settings: aiDefaults() });
  });

  it('refuses existing configuration and denied owners while preserving orphan credentials', async () => {
    const f = await fixture();
    f.store.credentialPut('instance', 'vault:orphan', 'PRESERVED_ORPHAN_TEST_VALUE');
    f.store.updateSettings({ ...aiDefaults(), deniedUserIds: [1] }, 0);
    expect(() => f.ai.personalSetup(admin(), { ...input, revision: 1 })).toThrow('FORBIDDEN');
    f.store.updateSettings(aiDefaults(), 1);
    const snapshot = f.ai.personalSetup(admin(), { ...input, revision: 2 });
    expect(f.store.credentialGet('instance', 'vault:orphan')).toBe('PRESERVED_ORPHAN_TEST_VALUE');
    expect(() => f.ai.personalSetup(admin(), { ...input, revision: snapshot.revision })).toThrow('CONFLICT');
    expect(f.store.getSettings().revision).toBe(snapshot.revision);
    expect(() => f.ai.personalSetup(admin(), input)).toThrow('CONFLICT');
  });

  it('rolls back the new credential, policy epochs and setup settings on write failure', async () => {
    const dir = await directory(); const key = await loadAiMasterKey(dir);
    const initial = await AiStore.open({ directory: dir, masterKey: key }); initial.close();
    const db = new DatabaseSync(join(dir, 'ai.sqlite'));
    db.exec("CREATE TRIGGER reject_setup BEFORE UPDATE ON settings BEGIN SELECT RAISE(ABORT,'test failure'); END"); db.close();
    const store = await AiStore.open({ directory: dir, masterKey: key });
    try {
      expect(() => store.personalSetup(input, 1)).toThrow('STORAGE_ERROR');
      expect(store.getSettings()).toEqual({ revision: 0, settings: aiDefaults() });
      expect(store.safeStatus().records).toBe(0);
    } finally { store.close(); }
    const verify = new DatabaseSync(join(dir, 'ai.sqlite'));
    try { expect(verify.prepare('SELECT count(*) AS n FROM entries').get()?.n).toBe(0); } finally { verify.close(); }
  });

  it('admits only one concurrent setup and leaves a stale caller without a second credential', async () => {
    const f = await fixture();
    const results = await Promise.all([input, { ...input, apiKey: 'OTHER_ISOLATED_TEST_SECRET' }]
      .map(value => f.executor.execute(admin(), 'ai.admin.setup', value)));
    expect(results.map(result => result.status)).toEqual(['succeeded', 'failed']);
    expect(results[1]).toMatchObject({ error: { code: 'CONFLICT' } });
    const snapshot = f.ai.admin(admin()); expect(snapshot.revision).toBe(1); expect(snapshot.credentials).toHaveLength(1);
    expect(f.ai.credential(snapshot.settings.providers[0]!.credentialRef)).toBe(input.apiKey);
  });

  it('rejects unsafe directory permissions rather than weakening key protection', async () => {
    const dir = await directory(); await chmod(dir, 0o755);
    await expect(loadAiMasterKey(dir)).rejects.toMatchObject({ code: 'STORAGE_ERROR' });
  });
});
