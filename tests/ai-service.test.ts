import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { Bot } from 'grammy';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiDefaults, aiInteractiveBudget, aiOutputTextLimits, aiSettingsSchema, type AiRunState, type AiSettings } from '../shared/schemas/ai.js';
import { aiToolCatalogSchema, type AiToolCatalog } from '../shared/schemas/ai-admin.js';
import type { AiRunStart } from '../shared/schemas/ai-control.js';
import { emptyInputSchema, type ActionResult } from '../shared/schemas/index.js';
import { subconvDefaults } from '../shared/schemas/subconv.js';
import { ActionExecutor, type ActionDefinition, type ActionServices, type InvocationContext } from '../src/actions.js';
import { aiScope } from '../src/ai/policy.js';
import { createAiProvider, type AiProvider, type GenerationRequest, type GenerationResult, type NativeContinuation, type ProviderProfile } from '../src/ai/providers.js';
import { AiService } from '../src/ai/service.js';
import { SandboxService } from '../src/ai/sandbox.js';
import type { AiCapturedFile, AiDelivery } from '../src/ai/telegram-port.js';
import { AiProtocolError, createAiTransport, type AiHttpTransport, type AiTransport, type AiTransportDependencies } from '../src/ai/transport.js';
import { resources as locales } from '../shared/locales/index.js';
import type { StartupConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { ResourcePolicy } from '../src/resources.js';
import { createAiTelegramAdapter } from '../src/telegram/ai.js';
import { coreFixture, invocation, testToken } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.useRealTimers(); vi.restoreAllMocks(); }
});

const alice = () => invocation({ actorId: 3, chat: { id: 3, type: 'private' } });
const bob = () => invocation({ actorId: 4, chat: { id: 4, type: 'private' } });
const group = (actorId = 3, threadId = 7) => invocation({ actorId, chat: { id: -100, type: 'supergroup', threadId } });
const masterKey = '37'.repeat(32);
const nativePolicy = { permission: 'self', scopes: ['private', 'group'], sources: ['telegram', 'ai'],
  aiVisible: true, effect: 'read', timeoutMs: 1000 } as const;

function settings(tools = ['core.info']): AiSettings {
  return aiSettingsSchema.parse({ ...aiDefaults(), enabled: true,
    providers: [{ id: 'mock', enabled: true, protocol: 'openai-responses', baseUrl: 'https://provider.invalid/v1',
      allowedOrigins: ['https://provider.invalid'], credentialRef: 'env:MOCK_PROVIDER' }],
    presets: [{ id: 'fixed', providerId: 'mock', model: 'mock-model', tools,
      inputCapabilities: ['text', 'image', 'audio', 'document'], outputCapabilities: ['text'],
      budget: { maxInputTokens: 32768, maxOutputTokens: 1024, maxToolCalls: 4, maxDurationMs: 10000, maxCostMicros: 100 },
      // Explicit zero prices are valid only for this injected, non-billable test provider.
      pricing: { currency: 'CNY', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }],
    grants: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(subjectId => ({ id: `user${subjectId}`, kind: 'private', subjectId, presetId: 'fixed' }))
      .concat([{ id: 'group100', kind: 'group', subjectId: -100, presetId: 'fixed' }]),
  });
}

function data<T>(result: ActionResult<T>): T {
  expect(result.status, JSON.stringify(result)).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
  return result.data;
}

function final(text = 'mock answer'): GenerationResult {
  return { text, toolCalls: [], usage: { inputTokens: 20, outputTokens: 5, billable: false } };
}

function toolName(request: GenerationRequest, action: string): string {
  const tool = request.tools?.find(item => item.description === action || item.name === `action_${createHash('sha256').update(action).digest('hex').slice(0, 56)}`);
  expect(tool, `Missing advertised tool ${action}`).toBeDefined();
  return tool!.name;
}

function calls(request: GenerationRequest, inputs: { action: string; arguments?: Record<string, unknown> }[]): GenerationResult {
  const toolCalls = inputs.map((input, index) => ({ id: `call-${index}`, name: toolName(request, input.action), arguments: input.arguments ?? {} }));
  const continuation: NativeContinuation = { version: 1, protocol: 'openai-responses', origin: 'https://provider.invalid',
    model: 'mock-model', binding: 'mock-binding', records: [{ type: 'reasoning', encrypted_content: 'opaque-native-signature' }],
    pending: toolCalls.map(({ id, name }) => ({ id, name })) };
  return { ...final(''), toolCalls, continuation };
}

async function fixture(options: { settings?: AiSettings; now?: () => number; groupAdmin?: ActionServices['groupAdmin']; retrievalNetwork?: AiTransportDependencies;
  extensionNetwork?: AiTransportDependencies; telegram?: boolean; realProvider?: boolean } = {}) {
  const core = await coreFixture({
    rss: { fetcher: vi.fn(async () => { throw new Error('Unexpected RSS network'); }) },
    rate: { json: vi.fn(async () => { throw new Error('Unexpected rate network'); }) },
    weather: { json: vi.fn(async () => { throw new Error('Unexpected weather network'); }) },
  });
  const config: StartupConfig = { botToken: testToken, adminIds: [1, 2], dataDir: core.directory, logLevel: 'silent',
    pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 },
    ai: { masterKey, secrets: { MOCK_PROVIDER: 'mock-provider-secret-not-real' } } };
  const generate = vi.fn<AiProvider['generate']>(async () => final());
  const provider = vi.fn<(profile: ProviderProfile) => AiProvider>(() => ({ generate }));
  const resources = new ResourcePolicy({ heavyBytes: 16 * 1024 * 1024 });
  const ai = new AiService({ config, access: core.access, provider: options.realProvider ? undefined : provider, resources, now: options.now,
    retrievalNetwork: options.retrievalNetwork, extensionNetwork: options.extensionNetwork });
  const executor = new ActionExecutor({ ...core.services, ai, now: options.now,
    aiPolicy: { available: context => ai.available(context), authorize: (context, id, effect) => ai.authorize(context, id, effect),
      approvalExempt: (context, id) => ai.approvalExempt(context, id) },
    aiNativeDelivery: (context, file) => ai.deliverNative(context, file), groupAdmin: options.groupAdmin });
  let message = 100;
  const delivery = { started: vi.fn<AiDelivery['started']>(async () => {}), progress: vi.fn<AiDelivery['progress']>(async () => {}),
    approval: vi.fn<AiDelivery['approval']>(async () => {}), completed: vi.fn<AiDelivery['completed']>(async () => ++message),
    failed: vi.fn<AiDelivery['failed']>(async () => {}), file: vi.fn<AiDelivery['file']>(async () => {}), retire: vi.fn<AiDelivery['retire']>(async () => {}) };
  const download = vi.fn(async (_file: AiCapturedFile, _signal: AbortSignal): Promise<Uint8Array> => Buffer.from('mock document'));
  ai.attachExecutor(executor); ai.attachTelegram(delivery, download);
  const telegramCalls: string[] = [];
  let telegram: ReturnType<typeof createAiTelegramAdapter> | undefined;
  if (options.telegram) {
    const bot = new Bot(testToken, { client: { fetch: async () => { throw new Error('Unexpected Telegram network'); } } });
    bot.botInfo = { id: 12345, is_bot: true, first_name: 'Offline test', username: 'offline_bot',
      can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false, has_topics_enabled: false,
      can_connect_to_business: false, has_main_web_app: false, allows_users_to_create_topics: false, can_manage_bots: false, supports_join_request_queries: false };
    bot.api.config.use(async (_previous, method, payload) => {
      telegramCalls.push(method);
      if (method === 'sendRichMessageDraft') return { ok: true, result: true } as never;
      const value = payload as { chat_id?: number; message_thread_id?: number; message_id?: number };
      return { ok: true, result: { message_id: value.message_id ?? ++message, date: 0, from: bot.botInfo,
        chat: { id: value.chat_id, type: value.chat_id! > 0 ? 'private' : 'supergroup' },
        ...(value.message_thread_id ? { is_topic_message: true, message_thread_id: value.message_thread_id } : {}) } } as never;
    });
    telegram = createAiTelegramAdapter(bot, { ai, executor, access: core.access, configuration: core.configuration,
      signal: new AbortController().signal, token: testToken, health: { recordApiError: () => {} } });
  }
  cleanups.push(async () => { await ai.stop(false); await telegram?.stop(); await executor.close(); await ai.stop(); core.subconv.stop(); await core.close(); });
  await ai.initialize();
  const store = ai.data(alice());
  store.updateSettings(options.settings ?? settings(), 0);
  await core.access.authorize(-100, 'mock group', 1, 0);
  return { ...core, config, ai, executor, generate, provider, delivery, download, store, resources, telegram, telegramCalls };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

async function start(f: Fixture, context = alice(), input: Partial<AiRunStart> = {}) {
  return data(await f.executor.execute<{ runId: string; conversationId: string }>(context, 'ai.run.start', { text: 'hello', ...input }));
}

async function settled(f: Fixture, runId: string, context = alice(), state: AiRunState = 'completed') {
  await vi.waitFor(() => expect(['queued', 'running']).not.toContain(f.ai.runView(context, runId).state));
  const view = f.ai.runView(context, runId);
  expect(view, JSON.stringify(view)).toMatchObject({ state });
  return f.store.runGet(aiScope(context), runId)!;
}

function register(f: Fixture, id: string, execute: ActionDefinition<Record<string, never>, boolean>['execute'], effect: 'read' | 'write' | 'personal_write' = 'read') {
  f.executor.register({ ...nativePolicy, id, input: emptyInputSchema, output: z.boolean(), effect, execute });
}

describe('real AI service and Action executor boundary', () => {
  it('catalogs every registered AI tool independently of runtime selections and availability without executing tools', async () => {
    const network = { lookup: vi.fn(async () => { throw new Error('Unexpected DNS'); }),
      request: vi.fn(async () => { throw new Error('Unexpected network'); }) };
    const groupAdmin = vi.fn(async () => { throw new Error('Unexpected Telegram lookup'); });
    const probe = vi.spyOn(SandboxService.prototype, 'probe').mockImplementation(() => { throw new Error('Unexpected sandbox probe'); });
    const f = await fixture({ retrievalNetwork: network, extensionNetwork: network, groupAdmin });
    const admin = () => invocation({ source: 'http' });
    const available = vi.spyOn(f.ai, 'available');
    const authorize = vi.spyOn(f.ai, 'authorize');
    const retrieve = vi.spyOn(f.ai, 'retrieve');
    const credential = vi.spyOn(f.ai, 'credential');
    const handlers = [...f.executor['registry'].values()].filter(action => action.id !== 'ai.admin.tools')
      .map(action => vi.spyOn(action, 'execute'));
    const snapshot = f.store.getSettings();
    const catalog = data(await f.executor.execute<AiToolCatalog>(admin(), 'ai.admin.tools', {}));
    expect(aiToolCatalogSchema.parse(catalog)).toEqual(catalog);
    const grouped: Record<string, string[]> = {};
    for (const item of catalog.items) (grouped[item.group] ??= []).push(item.id);
    expect(grouped).toEqual({
      core: ['core.info', 'modules.list'], alias: ['alias.add', 'alias.list', 'alias.remove'],
      rss: ['rss.add', 'rss.get', 'rss.list', 'rss.remove', 'rss.update'], rate: ['rate.convert', 'rate.currencies'],
      weather: ['weather.default.get', 'weather.default.set', 'weather.query', 'weather.search'],
      sticker: ['sticker.cancel', 'sticker.convert', 'sticker.inspect', 'sticker.sources'],
      subconv: ['subconv.generate_owned', 'subconv.options.set', 'subconv.settings.get', 'subconv.sources'],
      search: ['ai.fetch', 'ai.search'], memory: ['ai.memory.forget', 'ai.memory.propose', 'ai.memory.read', 'ai.memory.revise'],
      automation: ['ai.automations.create', 'ai.automations.list', 'ai.automations.pause', 'ai.automations.remove', 'ai.automations.update'],
      skills: ['ai.skills.list', 'ai.skills.load'],
      local: ['ai.mcp.stdio.call', 'ai.mcp.stdio.list', 'ai.mcp.stdio.read', 'ai.mcp.stdio.resource', 'ai.sandbox.local.execute'],
      mcp: ['ai.mcp.call', 'ai.mcp.list', 'ai.mcp.read', 'ai.mcp.resource'], sandbox: ['ai.sandbox.execute'],
      ai: ['ai.extensions.list', 'ai.files.from_sticker'],
    });
    expect(catalog.items).toHaveLength(49);
    for (const locale of Object.values(locales)) for (const item of catalog.items) {
      const copy = locale.web.ai.toolPicker;
      expect(Object.hasOwn(copy.names, item.id.replaceAll('.', '_')), item.id).toBe(true);
      expect(Object.hasOwn(copy.groups, item.group), item.group).toBe(true);
      expect(Object.hasOwn(copy.effects, item.effect), item.effect).toBe(true);
    }
    expect(catalog.items.map(item => item.id)).toEqual(catalog.items.map(item => item.id).sort());
    expect(f.store.getSettings()).toEqual(snapshot);
    expect(available).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    expect((await f.executor.discoverTools(alice())).map(tool => tool.id)).toEqual(['core.info']);
    const configured = settings();
    for (const selected of [
      aiDefaults(), { ...configured, enabled: false }, { ...configured, grants: [] }, settings([]),
      { ...configured, providers: configured.providers.map(provider => ({ ...provider, enabled: false })) },
      { ...settings(['ai.search', 'ai.fetch', 'ai.mcp.call']), search: { enabled: true, providerId: 'mock', maxResults: 5 } },
    ]) {
      f.store.updateSettings(aiSettingsSchema.parse(selected), f.store.getSettings().revision);
      available.mockClear(); authorize.mockClear();
      expect(data(await f.executor.execute<AiToolCatalog>(admin(), 'ai.admin.tools', {}))).toEqual(catalog);
      expect(available).not.toHaveBeenCalled(); expect(authorize).not.toHaveBeenCalled();
    }
    for (const callback of [network.lookup, network.request, groupAdmin, probe, retrieve, credential,
      f.provider, f.generate, f.download, ...handlers, ...Object.values(f.delivery), ...Object.values(f.effects)]) {
      expect(callback).not.toHaveBeenCalled();
    }
    f.store.updateSettings(settings(['alias.add']), f.store.getSettings().revision);
    expect((await f.executor.discoverTools(alice())).map(tool => tool.id)).not.toContain('alias.add');
    expect(await f.executor.executeTool(alice(), 'alias.add', { command: 'help', alias: 'fixture', revision: 0 }))
      .toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('rejects unmanaged AI execution while allowing metadata discovery', async () => {
    const f = await fixture();
    expect((await f.executor.discoverTools(alice())).map(tool => tool.id)).toEqual(['core.info']);
    expect(await f.executor.executeTool(alice(), 'core.info', {})).toMatchObject({ error: { code: 'FORBIDDEN' } });
  });

  it('stores a natural-language memory proposal only after this owner confirms the exact fact', async () => {
    const f = await fixture({ settings: settings(['ai.memory.propose']) });
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'ai.memory.propose', arguments: { text: 'Explicit mock fact.' } }]))
      .mockResolvedValueOnce(final('saved'));
    const ticket = await start(f);
    await settled(f, ticket.runId, alice(), 'waiting-approval');
    expect(f.store.memoryList(aiScope(alice())).items).toEqual([]);
    const confirmation = f.delivery.approval.mock.calls[0]![1];
    expect(f.delivery.approval.mock.calls[0]![4]).toEqual({ text: 'Explicit mock fact.' });
    expect(await f.executor.execute(bob(), 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token })).toHaveProperty('error');
    data(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token }));
    await settled(f, ticket.runId);
    expect(f.store.memoryList(aiScope(alice())).items).toMatchObject([{ text: 'Explicit mock fact.' }]);
    expect(f.store.memoryList(aiScope(bob())).items).toEqual([]);
  });

  it('creates a declarative automation through the AI Action only after human consent', async () => {
    const f = await fixture({ settings: settings(['ai.automations.create', 'core.info']) });
    const definition = { title: 'Owned daily query', instruction: 'Read runtime information.',
      trigger: { kind: 'once', at: new Date(Date.now() + 60_000).toISOString(), timeZone: 'UTC' },
      tools: ['core.info'], expiresAt: new Date(Date.now() + 86_400_000).toISOString(), maxRuns: 1,
      maxInputTokens: 10_000, maxOutputTokens: 100, maxCostMicros: 100 };
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'ai.automations.create', arguments: { definition } }]))
      .mockResolvedValueOnce(final('scheduled'));
    const ticket = await start(f);
    await settled(f, ticket.runId, alice(), 'waiting-approval');
    expect(f.store.recordList(aiScope(alice()), 'automation').items).toEqual([]);
    const token = f.delivery.approval.mock.calls[0]![1].token;
    data(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token }));
    await settled(f, ticket.runId);
    const rows = f.store.recordList(aiScope(alice()), 'automation').items;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.payload).toMatchObject({ actor: { actorId: 3 }, definition });
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('preserves unrelated human extension approvals and rejects affected policy changes', async () => {
    const f = await fixture();
    f.executor.register({ ...nativePolicy, sources: ['telegram'], aiVisible: false, id: 'ai.fixture.review',
      input: emptyInputSchema, output: z.boolean(), effect: 'write', execute: vi.fn(() => true) });
    const pending = await f.executor.execute(alice(), 'ai.fixture.review', {});
    if (pending.status !== 'pending_confirmation') throw new Error('Missing fixture approval');
    const before = f.store.getSettings();
    f.store.updateSettings({ ...before.settings, deniedUserIds: [5] }, before.revision);
    expect(await f.executor.confirm(alice(), pending.confirmation.token)).toMatchObject({ status: 'succeeded' });
    const affected = await f.executor.execute(alice(), 'ai.fixture.review', {});
    if (affected.status !== 'pending_confirmation') throw new Error('Missing fixture approval');
    f.store.changeCredential('instance', { operation: 'replace', ref: 'vault:unrelated', value: 'isolated-test-value' }, before.revision + 1);
    f.store.updateSettings({ ...before.settings, deniedUserIds: [3] }, before.revision + 2);
    expect(await f.executor.confirm(alice(), affected.confirmation.token)).toMatchObject({ error: { code: 'CONFIRMATION_EXPIRED' } });
  });

  it('uses the remaining whole-run token budget and releases known pre-inference failures', async () => {
    const selected = settings(); selected.presets[0]!.budget.maxInputTokens = 32_768; selected.presets[0]!.budget.maxOutputTokens = 1024;
    const f = await fixture({ settings: selected });
    f.generate.mockImplementationOnce(async request => ({ ...calls(request, [{ action: 'core.info' }]),
      usage: { inputTokens: 20, outputTokens: 1000, billable: false } })).mockImplementationOnce(async request => {
      expect(request.maxInputTokens).toBe(32_748); expect(request.maxOutputTokens).toBe(24); return final();
    });
    await settled(f, (await start(f)).runId);
    const { AiProtocolError } = await import('../src/ai/transport.js');
    f.generate.mockRejectedValueOnce(new AiProtocolError('UNSUPPORTED', undefined, false));
    await settled(f, (await start(f)).runId, alice(), 'failed');
    expect(f.store.safeStatus().reservedCostMicros).toBe(0);
  });

  it('does not send private RSS source URLs or access tokens to the model', async () => {
    const f = await fixture({ settings: settings(['rss.get']) });
    vi.spyOn(f.rss, 'get').mockReturnValue({ id: 'abcdef123456', revision: 1, title: 'Owned feed',
      url: 'https://feed.example.com/rss?access_token=PRIVATE_TEST_FEED_TOKEN', silent: true, paused: false,
      intervalSeconds: 60, lastCheckAt: null, lastSuccessAt: null, failures: 0, totalChecks: 0, totalFailures: 0,
      lastError: null, pending: 0, uncertain: 0, deliveryError: null });
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'rss.get', arguments: { id: 'abcdef123456' } }]))
      .mockImplementationOnce(async request => {
        expect(request.toolResults?.[0]?.result).toMatchObject({ data: { id: 'abcdef123456', sourceRedacted: true } });
        expect(JSON.stringify(request)).not.toContain('PRIVATE_TEST_FEED_TOKEN');
        expect(JSON.stringify(request)).not.toContain('feed.example.com');
        return final();
      });
    await settled(f, (await start(f)).runId);
    expect(data(await f.executor.execute<{ url: string }>(alice(), 'rss.get', { id: 'abcdef123456' })).url).toContain('PRIVATE_TEST_FEED_TOKEN');
  });

  it('drains an active run before deleting its conversation and rejects competing input', async () => {
    const f = await fixture(); const release = Promise.withResolvers<GenerationResult>();
    f.generate.mockImplementationOnce(async () => release.promise);
    try {
      const ticket = await start(f); await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
      const conversation = f.store.conversationGet(aiScope(alice()), ticket.conversationId)!;
      const pending = await f.executor.execute(alice(), 'ai.conversations.delete', { id: conversation.id, revision: conversation.revision });
      if (pending.status !== 'pending_confirmation') throw new Error('Missing delete approval');
      const deleting = f.executor.confirm(alice(), pending.confirmation.token);
      await vi.waitFor(() => expect(f.generate.mock.calls[0]![1].signal.aborted).toBe(true));
      expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'must not enter a deleting conversation' })).toMatchObject({ error: { code: 'CONFLICT' } });
      release.resolve(final('late data'));
      expect(await deleting).toMatchObject({ status: 'succeeded', data: { deleted: true } });
      expect(f.delivery.completed).not.toHaveBeenCalled();
      expect(f.store.conversationGet(aiScope(alice()), ticket.conversationId)).toBeUndefined();
    } finally { release.resolve(final()); }
  });

  it('expires abandoned approval work without replaying a mutation or blocking the conversation forever', async () => {
    vi.useFakeTimers();
    try {
      const f = await fixture({ settings: settings(['fixture.write']), now: () => Date.now() });
      const execute = vi.fn(() => true); register(f, 'fixture.write', execute, 'write');
      f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }]));
      const ticket = await start(f); await settled(f, ticket.runId, alice(), 'waiting-approval');
      expect(f.ai.runView(alice(), ticket.runId).state).toBe('waiting-approval');
      await vi.advanceTimersByTimeAsync(600_001);
      expect(f.ai.runView(alice(), ticket.runId)).toMatchObject({ state: 'failed', error: 'CONFIRMATION_EXPIRED' });
      expect(execute).not.toHaveBeenCalled();
      expect(f.store.hasPendingRun(aiScope(alice()), ticket.conversationId)).toBe(false);
      expect(f.store.safeStatus().reservedCostMicros).toBe(0);
      expect(f.delivery.retire).toHaveBeenCalledWith(expect.objectContaining({ runId: ticket.runId, conversationId: ticket.conversationId, actorId: 3 }));
    } finally { vi.useRealTimers(); }
  });

  it.each(['expiry', 'cancel'] as const)('reclaims real Telegram run slots after repeated paused-run %s without replay', async mode => {
    vi.useFakeTimers();
    const f = await fixture({ settings: settings(['fixture.write']), now: () => Date.now(), telegram: true });
    const execute = vi.fn(() => true); register(f, 'fixture.write', execute, 'write');
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.write' }]));
    for (let index = 0; index < 18; index++) {
      const ticket = await start(f); await settled(f, ticket.runId, alice(), 'waiting-approval');
      if (mode === 'expiry') {
        await vi.advanceTimersByTimeAsync(600_001);
        expect(f.ai.runView(alice(), ticket.runId)).toMatchObject({ state: 'failed', error: 'CONFIRMATION_EXPIRED' });
      } else {
        expect(await f.ai.stopRun(alice(), ticket.runId)).toEqual({ stopped: 1 });
        expect(f.ai.runView(alice(), ticket.runId).state).toBe('cancelled');
      }
      expect(f.store.hasPendingRun(aiScope(alice()), ticket.conversationId)).toBe(false);
    }
    const previews = f.telegramCalls.filter(method => method === 'sendRichMessageDraft').length;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.telegramCalls.filter(method => method === 'sendRichMessageDraft')).toHaveLength(previews);
    expect(previews).toBe(18); expect(execute).not.toHaveBeenCalled();
    f.generate.mockResolvedValueOnce(final('next run is admitted'));
    await settled(f, (await start(f)).runId);
    expect(f.generate).toHaveBeenCalledTimes(19);
  });

  it('completes a bounded model -> native Action -> model roundtrip without flattening native continuation', async () => {
    const f = await fixture({ settings: settings(['core.info', 'fixture.actor']) });
    const native = vi.fn((_input: Record<string, never>, context: InvocationContext) => {
      expect(context).toMatchObject({ actorId: 3, botId: 12345, source: 'ai', chat: { id: -100, threadId: 7 }, dataScope: { id: 3 } });
      return true;
    });
    register(f, 'fixture.actor', native);
    let continuation: NativeContinuation | undefined;
    f.generate.mockImplementationOnce(async request => {
      expect(request.tools?.map(tool => tool.name)).toEqual(['core.info', 'fixture.actor'].map(id => `action_${createHash('sha256').update(id).digest('hex').slice(0, 56)}`));
      const generated = calls(request, [{ action: 'core.info' }, { action: 'fixture.actor' }]);
      continuation = generated.continuation;
      return generated;
    }).mockImplementationOnce(async request => {
      expect(request.messages).toEqual([]);
      expect(request.continuation).toEqual(continuation);
      expect(request.toolResults).toMatchObject([
        { id: 'call-0', name: toolName(request, 'core.info'), result: { status: 'succeeded', data: { runtime: 'grammy', aiAvailable: true } } },
        { id: 'call-1', name: toolName(request, 'fixture.actor'), result: { status: 'succeeded', data: true } },
      ]);
      expect(JSON.stringify(request)).not.toContain('mock-provider-secret');
      return final();
    });
    const ticket = await start(f, group());
    await settled(f, ticket.runId, group());
    expect(f.generate).toHaveBeenCalledTimes(2); expect(native).toHaveBeenCalledTimes(1);
    expect(f.delivery.completed).toHaveBeenCalledTimes(1);
    expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 0, settledCostMicros: 0 });
    expect(f.store.conversationHistory(aiScope(group()), ticket.conversationId).items.map(turn => turn.role)).toEqual(['user', 'tool', 'tool', 'assistant']);
  });

  it.each(['core.info', 'core_info', 'action_core_info', 'action_636f72652e696e666f00'])('rejects non-advertised model tool name %s', async name => {
    const f = await fixture();
    f.generate.mockImplementation(async request => { const result = calls(request, [{ action: 'core.info' }]); result.toolCalls[0]!.name = name; return result; });
    const ticket = await start(f);
    await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('FORBIDDEN');
    expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.audit.mock.calls.some(([entry]) => entry.source === 'ai' && entry.actionId === 'core.info')).toBe(false);
  });

  it('rejects actor/approval fields in strict tool input without executing native code', async () => {
    const f = await fixture({ settings: settings(['fixture.read']) });
    const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.read', arguments: { actorId: 1, confirmed: true } }]))
      .mockImplementationOnce(async request => { expect(request.toolResults?.[0]?.result).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } }); return final(); });
    await settled(f, (await start(f)).runId);
    expect(native).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(2);
  });

  it('preserves provider-native call IDs and signatures across a human approval using the real Responses adapter', async () => {
    const selected = settings(['fixture.write']); selected.presets[0]!.outputCapabilities = ['text'];
    selected.providers[0]!.baseUrl = 'https://provider.example.com/v1';
    selected.providers[0]!.allowedOrigins = ['https://provider.example.com'];
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.write', native, 'write');
    const reasoning = { type: 'reasoning', id: 'rs_native', encrypted_content: 'DO_NOT_FLATTEN_NATIVE_SIGNATURE', summary: [] };
    const bodies: Record<string, unknown>[] = [];
    const request = vi.fn<AiHttpTransport>(async (_url, options) => {
      const body = JSON.parse(options.body.toString('utf8')) as Record<string, unknown>; bodies.push(body);
      const tools = body.tools as { name: string }[];
      const output = bodies.length === 1 ? [reasoning,
        { type: 'function_call', id: 'fc_native', call_id: 'call_native', name: tools[0]!.name, arguments: '{}', status: 'completed' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'approved answer' }] }];
      const event = { type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 20, output_tokens: 5 } } };
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(`data: ${JSON.stringify(event)}\n\n`)]) };
    });
    const transport = createAiTransport({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    f.provider.mockImplementation(profile => createAiProvider(profile, { transport }));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'waiting-approval');
    const token = f.delivery.approval.mock.calls[0]![1].token;
    data(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token }));
    await settled(f, ticket.runId);
    expect(native).toHaveBeenCalledTimes(1); expect(request).toHaveBeenCalledTimes(2);
    expect(bodies[1]?.input).toContainEqual(reasoning);
    expect(bodies[1]?.input).toContainEqual(expect.objectContaining({ type: 'function_call_output', call_id: 'call_native' }));
    expect(bodies[1]?.tools).toEqual(bodies[0]?.tools); expect(bodies[1]?.instructions).toEqual(bodies[0]?.instructions);
    expect(JSON.stringify(bodies)).not.toContain(token);
    expect(JSON.stringify(f.delivery.completed.mock.calls)).not.toContain('DO_NOT_FLATTEN');
  });

  it('passes the administrator-selected API path prefix to the injected provider factory', async () => {
    const selected = settings(); selected.providers[0]!.baseUrl = 'https://provider.invalid/approved/v2';
    const f = await fixture({ settings: selected }); await settled(f, (await start(f)).runId);
    expect(f.provider.mock.calls[0]![0]).toMatchObject({ origin: 'https://provider.invalid', basePath: '/approved/v2' });
  });

  it('maps long valid Action IDs to unique bounded provider tool names without disabling the run', async () => {
    const names = [`fixture.${'a'.repeat(56)}`, `fixture.${'a'.repeat(55)}b`];
    const f = await fixture({ settings: settings(names) }); const native = vi.fn(() => true);
    for (const name of names) register(f, name, native);
    f.generate.mockImplementationOnce(async request => {
      expect(request.tools).toHaveLength(2);
      expect(new Set(request.tools!.map(tool => tool.name)).size).toBe(2);
      for (const tool of request.tools!) expect(tool.name).toMatch(/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/);
      return calls(request, names.map(action => ({ action })));
    }).mockResolvedValueOnce(final());
    await settled(f, (await start(f)).runId); expect(native).toHaveBeenCalledTimes(2);
  });

  it('delivers native subscription output only to its owner and projects handles/receipts instead of source URLs', async () => {
    const f = await fixture({ settings: settings(['subconv.sources', 'subconv.settings.get', 'subconv.generate_owned']) });
    await f.subconv.update(alice(), { ...subconvDefaults(), backend: 'https://converter.invalid/sub?auth=MOCK_BACKEND_SECRET' }, 0);
    f.subconv.generate(alice(), { revision: 1, source: 'https://source.invalid/sub?token=MOCK_SOURCE_SECRET', customParams: [] });
    const { sourceRef } = f.subconv.listSources(alice()).items[0]!;
    expect(f.subconv.listSources(bob()).items).toEqual([]);
    expect(f.subconv.listSources(invocation({ actorId: 3, chat: { id: 3, type: 'private', threadId: 1 } })).items).toEqual([]);
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'subconv.sources' }, { action: 'subconv.settings.get' }]))
      .mockImplementationOnce(async request => {
        expect(request.toolResults?.[0]?.result).toMatchObject({ status: 'succeeded', data: { items: [{ sourceRef }] } });
        expect(request.toolResults?.[1]?.result).toMatchObject({ status: 'succeeded', data: { configured: true, revision: 1 } });
        return calls(request, [{ action: 'subconv.generate_owned', arguments: { sourceRef, revision: 1 } }]);
      }).mockResolvedValueOnce(final());
    const ticket = await start(f); await settled(f, ticket.runId);
    const receipt = f.generate.mock.calls[2]?.[0].toolResults?.[0]?.result;
    expect(receipt, JSON.stringify(receipt)).toMatchObject({ status: 'succeeded', data: { delivered: true, sourceCount: 1 } });
    expect(f.delivery.file).toHaveBeenCalledTimes(1);
    const [target, output] = f.delivery.file.mock.calls[0]!;
    expect(target).toMatchObject({ actorId: 3, chat: { id: 3, type: 'private' } });
    expect(output.name).toBe('subscription.txt');
    expect(output.protectContent).not.toBe(false);
    expect(Buffer.from(output.bytes!).toString('utf8')).toContain('MOCK_SOURCE_SECRET');
    expect(JSON.stringify(f.generate.mock.calls)).not.toMatch(/MOCK_SOURCE_SECRET|MOCK_BACKEND_SECRET|source\.invalid|converter\.invalid/);
    expect(JSON.stringify(f.store.recordList(aiScope(alice()), 'receipt'))).not.toMatch(/MOCK_SOURCE_SECRET|MOCK_BACKEND_SECRET/);
  });

  it('marks model-generated media as forwardable without changing owner-scoped delivery', async () => {
    const selected = settings(); selected.presets[0]!.outputCapabilities = ['text', 'image', 'audio'];
    const f = await fixture({ settings: selected });
    f.generate.mockResolvedValueOnce({ ...final('Generated media'), artifacts: [
      { type: 'image', mimeType: 'image/png', bytes: Buffer.from('image fixture') },
      { type: 'audio', mimeType: 'audio/mpeg', bytes: Buffer.from('audio fixture') },
    ] });
    await settled(f, (await start(f)).runId);
    expect(f.delivery.file).toHaveBeenCalledTimes(2);
    for (const [target, file] of f.delivery.file.mock.calls) {
      expect(target).toMatchObject({ actorId: 3, chat: { id: 3, type: 'private' } });
      expect(file.protectContent).toBe(false);
    }
  });

  it('stops at the cumulative tool-call budget instead of beginning another native mutation', async () => {
    const selected = settings(['fixture.read']); selected.presets[0]!.budget.maxToolCalls = 1;
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.read' }]));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('AI_TOOL_LIMIT');
    expect(native).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.generate.mock.calls[1]![0].toolChoice).toBe('none');
  });

  it.each(['default-off', 'denied', 'missing-grant', 'expired-grant', 'provider-disabled', 'group-revoked'] as const)('prevents provider work for %s', async kind => {
    const selected = kind === 'default-off' ? aiDefaults() : settings();
    if (kind === 'denied') selected.deniedUserIds = [3];
    if (kind === 'missing-grant') selected.grants = selected.grants.filter(item => item.subjectId !== 3);
    if (kind === 'expired-grant') selected.grants.find(item => item.subjectId === 3)!.expiresAt = '2000-01-01T00:00:00.000Z';
    if (kind === 'provider-disabled') selected.providers[0]!.enabled = false;
    const f = await fixture({ settings: selected });
    if (kind === 'group-revoked') await f.access.revoke(-100, 1, f.access.snapshot().revision);
    const context = kind === 'group-revoked' ? group() : alice();
    expect(f.ai.available(context)).toBe(false);
    expect(await f.executor.execute(context, 'ai.run.start', { text: 'blocked' })).toHaveProperty('error');
    expect(f.provider).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    expect(f.store.safeStatus().turns).toBe(0);
  });

  it('isolates private users, bot and topic scopes while shared group turns retain the current actor', async () => {
    const f = await fixture({ settings: settings(['fixture.actor']) });
    const actors: number[] = []; register(f, 'fixture.actor', (_input, context) => { actors.push(context.actorId); return true; });
    f.generate.mockImplementation(async request => request.continuation ? final() : calls(request, [{ action: 'fixture.actor' }]));
    f.store.memoryPut(aiScope(alice()), { text: 'ALICE_PRIVATE_MEMORY' });
    f.store.memoryPut(aiScope(bob()), { text: 'BOB_PRIVATE_MEMORY' });
    const privateTicket = await start(f, alice(), { text: 'ALICE_PRIVATE_HISTORY' }); await settled(f, privateTicket.runId);
    const bobTicket = await start(f, bob(), { text: 'BOB_PRIVATE_HISTORY' }); await settled(f, bobTicket.runId, bob());
    const first = await start(f, group(3), { text: 'GROUP_TOPIC_SEVEN' }); await settled(f, first.runId, group(3));
    const second = await start(f, group(4), { text: 'CURRENT_BOB_TURN' }); await settled(f, second.runId, group(4));
    const otherTopic = await start(f, group(3, 8), { text: 'TOPIC_EIGHT' }); await settled(f, otherTopic.runId, group(3, 8));
    expect(second.conversationId).toBe(first.conversationId); expect(otherTopic.conversationId).not.toBe(first.conversationId);
    const requests = f.generate.mock.calls.map(([request]) => JSON.stringify(request));
    expect(requests[0]).toContain('ALICE_PRIVATE_MEMORY'); expect(requests[2]).not.toContain('ALICE_PRIVATE');
    expect(requests[4]).not.toMatch(/ALICE_PRIVATE|BOB_PRIVATE/);
    expect(requests[6]).toContain('[Speaker user:3]'); expect(requests[6]).toContain('[Speaker user:4]');
    expect(requests[8]).not.toContain('GROUP_TOPIC_SEVEN'); expect(actors).toEqual([3, 4, 3, 4, 3]);
    for (const foreign of [bob(), group(), invocation({ actorId: 3, botId: 999, chat: { id: 3, type: 'private' } })]) {
      expect(await f.executor.execute(foreign, 'ai.conversations.history', { id: privateTicket.conversationId })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    expect(await f.executor.execute(group(4), 'ai.run.status', { runId: first.runId })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(() => invocation({ actorId: 4, chat: { id: 3, type: 'private' } })).toThrow('FORBIDDEN');
  });

  it('admits one active run and eight queued IDs and drains cancellation before another provider starts', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, { signal }) => {
      entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise;
      throw new AppError('CANCELLED');
    });
    const first = await start(f); await entered.promise;
    try {
      for (let actorId = 4; actorId <= 11; actorId++) await start(f, invocation({ actorId, chat: { id: actorId, type: 'private' } }));
      expect(await f.executor.execute(invocation({ actorId: 12, chat: { id: 12, type: 'private' } }), 'ai.run.start', { text: 'overflow' }))
        .toMatchObject({ error: { code: 'CAPACITY' } });
      expect(f.store.safeStatus()).toMatchObject({ pendingRuns: 9, turns: 9 }); expect(f.generate).toHaveBeenCalledTimes(1);
      let drained = false;
      const stop = f.ai.stop(false).then(() => { drained = true; });
      const again = f.ai.stop(false); await aborted.promise;
      expect(drained).toBe(false); expect(f.generate).toHaveBeenCalledTimes(1);
      release.resolve(); await Promise.all([stop, again]);
      expect(f.store.runGet(aiScope(alice()), first.runId)?.state).toBe('cancelled');
      expect(f.store.safeStatus().pendingRuns).toBe(0); expect(f.generate).toHaveBeenCalledTimes(1);
      expect(f.delivery.completed).not.toHaveBeenCalled(); expect(f.delivery.file).not.toHaveBeenCalled();
    } finally { release.resolve(); }
  });
});

describe('AI approvals and uncertain outcomes', () => {
  it('binds an approval to its owner and executes once as the original non-admin AI actor', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) });
    const native = vi.fn((_input: Record<string, never>, context: InvocationContext) => {
      expect(context).toMatchObject({ actorId: 3, source: 'ai', chat: { id: -100, threadId: 7 }, dataScope: { id: 3 } }); return true;
    });
    register(f, 'fixture.write', native, 'write');
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }])).mockResolvedValueOnce(final());
    const ticket = await start(f, group()); await settled(f, ticket.runId, group(), 'waiting-approval');
    const confirmation = f.delivery.approval.mock.calls[0]![1];
    for (const foreign of [group(4), group(3, 8), alice(), group(1)]) {
      expect(await f.executor.execute(foreign, 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token })).toHaveProperty('error');
    }
    expect(native).not.toHaveBeenCalled(); expect(f.store.safeStatus().reservedCostMicros).toBe(100);
    data(await f.executor.execute(group(), 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token }));
    await settled(f, ticket.runId, group());
    expect(native).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(f.generate.mock.calls)).not.toContain(confirmation.token);
    expect(await f.executor.execute(group(), 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token })).toHaveProperty('error');
    expect(native).toHaveBeenCalledTimes(1);
  });

  it('rejects a same-owner token from a different waiting run before executing either mutation', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); const native = vi.fn(() => true); register(f, 'fixture.write', native, 'write');
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.write' }]));
    const first = await start(f); await settled(f, first.runId, alice(), 'waiting-approval');
    data(await f.executor.execute(alice(), 'ai.conversations.new', {}));
    const second = await start(f); await settled(f, second.runId, alice(), 'waiting-approval');
    const token = f.delivery.approval.mock.calls[1]![1].token;
    const result = await f.executor.execute(alice(), 'ai.run.confirm', { runId: first.runId, token });
    expect(result).toHaveProperty('error');
    expect(f.ai.runView(alice(), first.runId).state).toBe('waiting-approval');
    expect(f.ai.runView(alice(), second.runId).state).toBe('waiting-approval'); expect(native).not.toHaveBeenCalled();
  });

  it('rechecks revoked grants on approval while keeping owner stop/status/export controls usable', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); const native = vi.fn(() => true); register(f, 'fixture.write', native, 'write');
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.write' }]));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'waiting-approval');
    const confirmation = f.delivery.approval.mock.calls[0]![1]; const snapshot = f.store.getSettings();
    f.store.updateSettings({ ...snapshot.settings, deniedUserIds: [3] }, snapshot.revision);
    expect(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token: confirmation.token })).toHaveProperty('error');
    expect(await f.executor.confirm(alice(), confirmation.token)).toHaveProperty('error'); expect(native).not.toHaveBeenCalled();
    expect(data(await f.executor.execute(alice(), 'ai.run.status', { runId: ticket.runId }))).toMatchObject({ state: 'waiting-approval' });
    expect(data(await f.executor.execute(alice(), 'ai.run.stop', { runId: ticket.runId }))).toEqual({ stopped: 1 });
    let exported = '';
    f.delivery.file.mockImplementation(async (_target, file) => { if (file.path) exported = await readFile(file.path, 'utf8'); });
    expect(data(await f.executor.execute(alice(), 'ai.conversations.export', { id: ticket.conversationId }))).toEqual({ delivered: true });
    expect(exported).toContain('hello'); expect(exported).not.toContain(confirmation.token);
    expect(await readdir(join(f.directory, 'ai-tmp'))).toEqual([]);
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'still blocked' })).toHaveProperty('error');
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('keeps the native tool prefix stable across a pause while rechecking permissions for actual execution', async () => {
    let manager = true;
    const f = await fixture({ settings: settings(['fixture.write', 'fixture.manager']), groupAdmin: async () => manager });
    const write = vi.fn(() => true); register(f, 'fixture.write', write, 'write');
    const privileged = vi.fn(() => true);
    f.executor.register({ ...nativePolicy, id: 'fixture.manager', input: emptyInputSchema, output: z.boolean(), permission: 'group_admin', execute: privileged });
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }])).mockResolvedValueOnce(final());
    const ticket = await start(f, group()); await settled(f, ticket.runId, group(), 'waiting-approval');
    const prefix = structuredClone(f.generate.mock.calls[0]![0].tools);
    expect(prefix).toHaveLength(2); manager = false;
    const token = f.delivery.approval.mock.calls[0]![1].token;
    data(await f.executor.execute(group(), 'ai.run.confirm', { runId: ticket.runId, token }));
    await settled(f, ticket.runId, group());
    expect(f.generate.mock.calls[1]?.[0].tools).toEqual(prefix);
    expect(write).toHaveBeenCalledTimes(1); expect(privileged).not.toHaveBeenCalled();
    expect((await f.executor.discoverTools(group())).some(tool => tool.id === 'fixture.manager')).toBe(false);
  });

  it('keeps group owner status and stop available after allowlist revocation without letting another actor stop it', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); register(f, 'fixture.write', () => true, 'write');
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.write' }]));
    const ticket = await start(f, group()); await settled(f, ticket.runId, group(), 'waiting-approval');
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    expect(data(await f.executor.execute(group(), 'ai.run.status', { runId: ticket.runId }))).toMatchObject({ state: 'waiting-approval' });
    expect(await f.executor.execute(group(4), 'ai.run.stop', { runId: ticket.runId })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    expect(data(await f.executor.execute(group(), 'ai.run.stop', { runId: ticket.runId }))).toEqual({ stopped: 1 });
    expect(await f.executor.execute(group(), 'ai.run.start', { text: 'no admission' })).toHaveProperty('error');
    expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('freezes an uncertain mutation and never continues the model or retries it with another call ID', async () => {
    const f = await fixture({ settings: settings(['fixture.mutate']) }); const native = vi.fn(() => { throw new AppError('OUTCOME_UNKNOWN'); });
    register(f, 'fixture.mutate', native, 'personal_write');
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.mutate' }]));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'unknown');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('OUTCOME_UNKNOWN');
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'try again' })).toMatchObject({ error: { code: 'CONFLICT' } });
    expect(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token: '0'.repeat(40) })).toHaveProperty('error');
    expect(native).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.delivery.completed).not.toHaveBeenCalled(); expect(f.delivery.failed).not.toHaveBeenCalled();
  });

  it('marks ambiguous final delivery unknown without duplicate or failure fallback', async () => {
    const f = await fixture(); f.delivery.completed.mockRejectedValue(new Error('mock ambiguous send'));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'unknown');
    expect(f.delivery.completed).toHaveBeenCalledTimes(1); expect(f.delivery.failed).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(1);
    expect(f.store.recordGet(aiScope(alice()), 'outbox', `delivery:${ticket.runId}`)?.state).toBe('sending');
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'retry' })).toMatchObject({ error: { code: 'CONFLICT' } });
  });

  it.each([undefined, 0])('does not finalize a delivery without a valid message ID (%s)', async messageId => {
    const f = await fixture(); f.delivery.completed.mockResolvedValue(messageId);
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'unknown');
    expect(f.delivery.completed).toHaveBeenCalledTimes(1); expect(f.delivery.failed).not.toHaveBeenCalled();
    expect(f.store.recordGet(aiScope(alice()), 'outbox', `delivery:${ticket.runId}`)?.state).toBe('sending');
  });
});

describe('AI files, cancellation and durable safety', () => {
  const file: AiCapturedFile = { fileId: 'PRIVATE_TELEGRAM_FILE_ID', uniqueId: 'PRIVATE_TELEGRAM_UNIQUE_ID',
    kind: 'document', mimeType: 'text/plain', name: 'safe.txt', size: Buffer.byteLength('mock document') };

  it('holds captured files until admitted work and sends only validated owned bytes to the model', async () => {
    const f = await fixture(); const ref = await f.ai.capture(alice(), file);
    expect(f.download).not.toHaveBeenCalled(); expect(ref).not.toContain(file.fileId);
    for (const foreign of [bob(), group(), invocation({ actorId: 3, chat: { id: 3, type: 'private', threadId: 1 } })]) {
      expect(await f.executor.execute(foreign, 'ai.run.start', { text: 'foreign', attachments: [ref] })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    const groupRef = await f.ai.capture(group(3), file);
    for (const foreign of [group(4), group(3, 8)]) {
      expect(await f.executor.execute(foreign, 'ai.run.start', { text: 'foreign', attachments: [groupRef] })).toMatchObject({ error: { code: 'NOT_FOUND' } });
    }
    await settled(f, (await start(f, alice(), { attachments: [ref] })).runId);
    expect(f.download).toHaveBeenCalledTimes(1);
    const request = f.generate.mock.calls[0]![0];
    expect(request.messages[0]?.content).toContainEqual({ type: 'file', mimeType: 'text/plain', filename: 'safe.txt', bytes: Buffer.from('mock document') });
    expect(JSON.stringify(request)).not.toMatch(/PRIVATE_TELEGRAM|fileId|uniqueId|mock-provider-secret/);
    expect(JSON.stringify(f.ai.admin(invocation()))).not.toMatch(/PRIVATE_TELEGRAM|mock document|mock-provider-secret/);
  });

  it('rejects total captured bytes before downloading and rejects mismatched downloaded bytes before model work', async () => {
    const f = await fixture(); const large = await f.ai.capture(alice(), { ...file, size: 600000 });
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'oversized', attachments: [large, large] })).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(f.download).not.toHaveBeenCalled(); expect(f.store.safeStatus().turns).toBe(0);
    const ref = await f.ai.capture(alice(), file); f.download.mockResolvedValue(Buffer.from('wrong size'));
    const ticket = await start(f, alice(), { attachments: [ref] }); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('CAPACITY'); expect(f.generate).not.toHaveBeenCalled();
  });

  it('suppresses a provider result returned after cancellation, including files and assistant history', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
    f.generate.mockImplementation(async (_request, { signal }) => {
      entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise;
      return { ...final('LATE_MODEL_TEXT'), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.from('late') }] };
    });
    const ticket = await start(f); await entered.promise;
    try {
      const stop = f.ai.stopRun(alice(), ticket.runId); await aborted.promise;
      expect(f.delivery.file).not.toHaveBeenCalled(); release.resolve(); await stop;
      expect(f.delivery.file).not.toHaveBeenCalled(); expect(f.delivery.completed).not.toHaveBeenCalled();
      expect(f.store.conversationHistory(aiScope(alice()), ticket.conversationId).items.map(turn => turn.role)).toEqual(['user']);
      expect(f.ai.runView(alice(), ticket.runId).state).toBe('cancelled');
    } finally { release.resolve(); }
  });

  it('drains an already-started file delivery but never starts final text after cancellation', async () => {
    const f = await fixture(); const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); const aborted = Promise.withResolvers<void>();
    f.generate.mockResolvedValue({ ...final(), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.from('mock file') }] });
    f.delivery.file.mockImplementation(async (_target, _file, signal) => {
      entered.resolve(); signal.addEventListener('abort', () => aborted.resolve(), { once: true }); await release.promise;
    });
    const ticket = await start(f); await entered.promise;
    try {
      let drained = false;
      const stop = f.ai.stopRun(alice(), ticket.runId).then(() => { drained = true; }); await aborted.promise;
      expect(drained).toBe(false); release.resolve(); await stop;
      expect(f.delivery.file).toHaveBeenCalledTimes(1); expect(f.delivery.completed).not.toHaveBeenCalled();
      expect(f.ai.runView(alice(), ticket.runId).state).toBe('unknown');
      expect(f.delivery.failed).not.toHaveBeenCalled();
    } finally { release.resolve(); }
  });

  it.each(['stream', 'final', 'continuation', 'arguments', 'artifact'] as const)('enforces the %s byte cap without delivering oversized data', async kind => {
    const f = await fixture();
    f.generate.mockImplementation(async (request, options) => {
      if (kind === 'stream') { await options.onText?.('\u754c'.repeat(Math.floor(aiOutputTextLimits.bytes / 3) + 1), options.signal); return final(); }
      if (kind === 'final') return final('\u754c'.repeat(Math.floor(aiOutputTextLimits.bytes / 3) + 1));
      if (kind === 'artifact') return { ...final(), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(1048577) }] };
      const result = calls(request, [{ action: 'core.info' }]);
      if (kind === 'continuation') result.continuation!.records = [{ opaque: 'x'.repeat(48001) }];
      else result.toolCalls[0]!.arguments = { text: 'x'.repeat(8193) };
      return result;
    });
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe(kind === 'stream' || kind === 'final' ? 'AI_OUTPUT_LIMIT' : 'CAPACITY');
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.delivery.completed).not.toHaveBeenCalled(); expect(f.delivery.file).not.toHaveBeenCalled();
    if (kind === 'stream') expect(f.delivery.progress).not.toHaveBeenCalled();
  });

  it('retains a conservative reservation when a successful response has unknown usage', async () => {
    const selected = settings(); selected.limits.dailyCostMicros = 100;
    const f = await fixture({ settings: selected }); f.generate.mockResolvedValue({ ...final(), usage: { billable: 'unknown' } });
    await settled(f, (await start(f)).runId);
    expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 100, settledCostMicros: 0 });
    const second = await start(f); await settled(f, second.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), second.runId).error).toBe('AI_BUDGET_LIMIT'); expect(f.generate).toHaveBeenCalledTimes(1);
  });

  it('fails closed for a missing or wrong master key without resetting recoverable encrypted state', async () => {
    const f = await fixture(); f.store.memoryPut(aiScope(alice()), { text: 'RECOVERABLE_PRIVATE_FACT' });
    const revision = f.store.getSettings().revision; await f.ai.stop();
    const before = await readFile(join(f.directory, 'ai.sqlite'));
    for (const key of [undefined, '42'.repeat(32)]) {
      const ai = new AiService({ config: { ...f.config, ai: { masterKey: key, secrets: {} } }, access: f.access, provider: f.provider });
      try { await expect(ai.initialize()).rejects.toMatchObject({ code: 'STORAGE_ERROR' }); }
      finally { await ai.stop(); }
    }
    expect(await readFile(join(f.directory, 'ai.sqlite'))).toEqual(before);
    const recovered = new AiService({ config: f.config, access: f.access, provider: f.provider });
    try {
      await recovered.initialize(); expect(recovered.data(alice()).getSettings().revision).toBe(revision);
      expect(recovered.data(alice()).memoryList(aiScope(alice())).items[0]?.text).toBe('RECOVERABLE_PRIVATE_FACT');
    } finally { await recovered.stop(); }
    expect(f.provider).not.toHaveBeenCalled();
  });

  it('marks running work unknown and queued work cancelled on restart without replaying models or approvals', async () => {
    const f = await fixture(); const scope = aiScope(alice()); const conversation = f.ai.current(alice());
    const template = f.ai.startRun(alice(), { text: 'checkpoint template', attachments: [] });
    await f.ai.cancelAll();
    const checkpoint = f.store.runGet(scope, template.runId)!.continuation;
    const ids = ['queued', 'running', 'waiting-approval', 'unknown'].map(state => {
      let run = f.store.runCreate(scope, { conversationId: conversation.id, actorId: 3, presetId: 'fixed', settingsRevision: 1, continuation: checkpoint });
      if (state !== 'queued') run = f.store.runUpdate(scope, run.id, { revision: run.revision, state: 'running', continuation: checkpoint });
      if (state === 'waiting-approval' || state === 'unknown') run = f.store.runUpdate(scope, run.id, { revision: run.revision, state, continuation: checkpoint });
      return run.id;
    });
    await f.ai.stop(); const restarted = new AiService({ config: f.config, access: f.access, provider: f.provider });
    try {
      await restarted.initialize();
      // Graceful shutdown revokes pending approvals; stale running rows still recover as unknown.
      expect(ids.map(id => restarted.data(alice()).runGet(scope, id)?.state)).toEqual(['cancelled', 'unknown', 'cancelled', 'unknown']);
      expect(f.provider).not.toHaveBeenCalled(); expect(f.delivery.completed).not.toHaveBeenCalled();
    } finally { await restarted.stop(); }
  });
});

describe('usage budgets and scoped policy invalidation', () => {
  it.each(['openai-chat-completions', 'openai-responses'] as const)('uses real %s vision payloads and scoped rehydration through a tool call', async protocol => {
    const selected = settings(['fixture.read']); const preset = selected.presets[0]!;
    preset.budgetMode = 'usage'; preset.budget = aiInteractiveBudget();
    selected.providers[0] = { ...selected.providers[0]!, protocol, baseUrl: 'https://vision.example.com/gateway/v1', allowedOrigins: ['https://vision.example.com'] };
    const f = await fixture({ settings: selected, realProvider: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZxkAAAAASUVORK5CYII=', 'base64');
    f.download.mockResolvedValue(png);
    const reference = await f.ai.capture(alice(), { fileId: 'owned-photo', uniqueId: 'owned-photo-unique', name: 'photo.png',
      size: png.length, kind: 'image', mimeType: 'image/png' });
    const execute = vi.fn(() => true); register(f, 'fixture.read', execute);
    const bodies: Record<string, unknown>[] = [];
    const request = vi.fn<AiHttpTransport>(async (url, input) => {
      expect(url.origin).toBe('https://vision.example.com');
      expect(url.pathname).toBe(`/gateway/v1/${protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`);
      const body = JSON.parse(input.body.toString()) as Record<string, unknown>; bodies.push(body);
      const tools = body.tools as { name?: string; function?: { name: string } }[];
      const name = protocol === 'openai-responses' ? tools[0]!.name : tools[0]!.function!.name;
      const first = bodies.length === 1;
      const wire = protocol === 'openai-responses'
        ? `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: first
          ? [{ type: 'function_call', call_id: 'photo-call', name, arguments: '{}' }]
          : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Image understood' }] }], usage: { input_tokens: 100, output_tokens: 5 } } })}\n\n`
        : `data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: first ? '' : 'Image understood',
          ...(first ? { tool_calls: [{ index: 0, id: 'photo-call', type: 'function', function: { name, arguments: '{}' } }] } : {}) },
          finish_reason: first ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } })}\n\ndata: [DONE]\n\n`;
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
    });
    const transport = createAiTransport({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
    const native = await import('../src/ai/providers.js'); const factory = native.createAiProvider;
    vi.spyOn(native, 'createAiProvider').mockImplementation((profile, dependencies) => {
      expect(profile.mediaTokenPolicy).toBe('bounded');
      return factory(profile, { ...dependencies, transport });
    });
    const ticket = await start(f, alice(), { attachments: [reference] }); await settled(f, ticket.runId);
    expect(execute).toHaveBeenCalledOnce(); expect(request).toHaveBeenCalledTimes(2); expect(f.download).toHaveBeenCalledTimes(2);
    for (const body of bodies) {
      expect(JSON.stringify(body)).toContain(`data:image/png;base64,${png.toString('base64')}`);
      expect(JSON.stringify(body)).not.toContain('misaka-inline:'); expect(JSON.stringify(body)).not.toContain('mock-provider-secret-not-real');
    }
    const history = bodies[1]![protocol === 'openai-responses' ? 'input' : 'messages'] as Record<string, unknown>[];
    const receipt = protocol === 'openai-responses' ? history.find(item => item.type === 'function_call_output')!.output
      : history.find(item => item.role === 'tool')!.content;
    expect(JSON.parse(String(receipt))).toMatchObject({ status: 'succeeded', data: true });
    const stored = JSON.stringify(f.store.runGet(aiScope(alice()), ticket.runId)!.continuation);
    expect(stored).not.toContain('base64'); expect(stored).not.toContain(png.toString('base64'));
    expect(f.delivery.completed).toHaveBeenCalledWith(expect.anything(), 'Image understood', expect.any(AbortSignal));
  });

  it('does not weaken a cost budget to obtain compatible vision', async () => {
    const selected = settings(); selected.providers[0]!.protocol = 'openai-chat-completions';
    selected.providers[0]!.baseUrl = 'https://vision.example.com/v1'; selected.providers[0]!.allowedOrigins = ['https://vision.example.com'];
    const f = await fixture({ settings: selected, realProvider: true });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/ZxkAAAAASUVORK5CYII=', 'base64');
    f.download.mockResolvedValue(png);
    const reference = await f.ai.capture(alice(), { fileId: 'photo', uniqueId: 'unique-photo', name: 'photo.png', size: png.length, kind: 'image', mimeType: 'image/png' });
    const request = vi.fn<AiHttpTransport>(async () => { throw new Error('No inference is authorized'); });
    const native = await import('../src/ai/providers.js'); const factory = native.createAiProvider;
    vi.spyOn(native, 'createAiProvider').mockImplementation((profile, dependencies) => {
      expect(profile.mediaTokenPolicy).toBe('strict');
      return factory(profile, { ...dependencies, transport: createAiTransport({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] }) });
    });
    const ticket = await start(f, alice(), { attachments: [reference] }); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('AI_MEDIA_COUNT_UNAVAILABLE'); expect(request).not.toHaveBeenCalled();
    expect(f.store.safeStatus().reservedCostMicros).toBe(0);
  });

  it('reports disabled image input before downloading, but does not require vision for sticker metadata only', async () => {
    const selected = settings(); selected.presets[0]!.inputCapabilities = ['text'];
    const f = await fixture({ settings: selected });
    const image = await f.ai.capture(alice(), { fileId: 'photo', uniqueId: 'photo-unique', name: 'photo.png', size: 33, kind: 'image', mimeType: 'image/png' });
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'Describe', attachments: [image] })).toMatchObject({ error: { code: 'AI_INPUT_DISABLED' } });
    expect(f.download).not.toHaveBeenCalled(); expect(f.generate).not.toHaveBeenCalled();
    const tgs = Buffer.from([31, 139, 8, 0, 0, 0, 0, 0]); f.download.mockResolvedValue(tgs);
    const sticker = await f.ai.capture(alice(), { fileId: 'sticker', uniqueId: 'sticker-unique', name: 'sticker.tgs', size: tgs.length, kind: 'sticker', mimeType: 'application/x-tgsticker' });
    await settled(f, (await start(f, alice(), { attachments: [sticker] })).runId);
    expect(f.generate.mock.calls[0]![0].messages.flatMap(message => message.content).every(part => part.type === 'text')).toBe(true);
  });

  it('reports a missing chat credential without a provider request or retained cost', async () => {
    const selected = settings(); selected.providers[0]!.credentialRef = 'env:MISSING';
    const f = await fixture({ settings: selected });
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('AI_PROVIDER_AUTH');
    expect(f.generate).not.toHaveBeenCalled(); expect(f.store.safeStatus().reservedCostMicros).toBe(0);
  });

  it.each([['OUTPUT_LIMIT', 'AI_OUTPUT_LIMIT'], ['INCOMPLETE', 'AI_RESPONSE_INCOMPLETE'], ['QUOTA', 'AI_PROVIDER_QUOTA'],
    ['AUTH', 'AI_PROVIDER_AUTH'], ['TIMEOUT', 'TIMEOUT']] as const)('preserves partial text and distinguishes %s from local capacity', async (protocolCode, code) => {
    const f = await fixture(); const partial = '<b>literal partial answer</b>';
    f.generate.mockImplementationOnce(async (_request, options) => {
      await options.onText!(partial, options.signal); throw new AiProtocolError(protocolCode);
    });
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe(code);
    expect(f.delivery.failed).toHaveBeenCalledWith(expect.anything(), code, expect.any(AbortSignal), partial);
    const turn = f.store.conversationHistory(aiScope(alice()), ticket.conversationId).items.at(-1)!;
    expect(turn.role).toBe('assistant'); expect(turn.content).toContain(partial); expect(turn.content).toContain(code);
    expect(f.generate).toHaveBeenCalledOnce(); expect(f.delivery.completed).not.toHaveBeenCalled();
  });

  it('reports a run deadline while keeping the delivery signal alive for the partial answer', async () => {
    vi.useFakeTimers();
    const selected = settings(); selected.presets[0]!.budget.maxDurationMs = 1000;
    const f = await fixture({ settings: selected }); const entered = Promise.withResolvers<void>();
    f.generate.mockImplementationOnce(async (_request, options) => {
      await options.onText!('deadline partial', options.signal); entered.resolve();
      await new Promise<void>(resolve => options.signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new AiProtocolError('CANCELLED');
    });
    f.delivery.failed.mockImplementation(async (_target, code, signal, text) => {
      expect(signal.aborted).toBe(false); expect(code).toBe('TIMEOUT'); expect(text).toBe('deadline partial');
    });
    const ticket = await start(f);
    await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce()); await entered.promise;
    await vi.advanceTimersByTimeAsync(1001); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('TIMEOUT'); expect(f.delivery.failed).toHaveBeenCalledOnce();
  });

  it('gives full per-request output and a final answer after the last allowed tool', async () => {
    const selected = settings(['fixture.read']); selected.presets[0]!.budgetMode = 'usage'; delete selected.presets[0]!.pricing;
    selected.presets[0]!.budget = { ...aiInteractiveBudget(), maxToolCalls: 1 };
    const f = await fixture({ settings: selected }); register(f, 'fixture.read', () => true);
    const text = 'A full answer with evidence. '.repeat(700);
    f.generate.mockImplementationOnce(async request => {
      expect(request.maxOutputTokens).toBe(8192);
      return { ...calls(request, [{ action: 'fixture.read' }]), usage: { billable: 'unknown' } };
    }).mockImplementationOnce(async (request, options) => {
      expect(request).toMatchObject({ maxInputTokens: 65_536, maxOutputTokens: 8192, toolChoice: 'none' });
      await options.onText!(text, options.signal); return { ...final(text), usage: { billable: 'unknown' } };
    });
    const ticket = await start(f); await settled(f, ticket.runId);
    expect(f.delivery.completed).toHaveBeenCalledWith(expect.anything(), text, expect.any(AbortSignal));
    expect(f.store.getSettings().settings.presets[0]!.budget).toEqual(selected.presets[0]!.budget);
  });

  it.each([undefined, 'cost'] as const)('rejects unpriced tools early in %s cost mode', async budgetMode => {
    const selected = settings(); delete selected.presets[0]!.pricing;
    if (budgetMode) selected.presets[0]!.budgetMode = budgetMode;
    const f = await fixture({ settings: selected });
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'hello' })).toMatchObject({ error: { code: 'AI_PRICING_REQUIRED' } });
    expect(f.generate).not.toHaveBeenCalled(); expect(f.store.safeStatus().turns).toBe(0);
  });

  it.each([true, false])('continues bounded tools without prices when usage is known=%s', async known => {
    const selected = settings(['fixture.read']); delete selected.presets[0]!.pricing; selected.presets[0]!.budgetMode = 'usage';
    selected.limits.dailyCostMicros = 0; selected.limits.dailyRuns = 2;
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementation(async request => {
      const result = request.continuation ? final() : calls(request, [{ action: 'fixture.read' }]);
      return { ...result, usage: known ? { inputTokens: 20, outputTokens: 5, billable: true } : { billable: 'unknown' } };
    });
    const first = await start(f); await settled(f, first.runId);
    expect(native).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledTimes(2);
    expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 100, settledCostMicros: 0 });
    const requests = f.generate.mock.calls.map(([request]) => request);
    if (!known) {
      const budget = selected.presets[0]!.budget;
      expect(requests.every(request => request.maxInputTokens === budget.maxInputTokens && request.maxOutputTokens === budget.maxOutputTokens)).toBe(true);
      expect(requests.reduce((sum, request) => sum + request.maxInputTokens!, 0)).toBeLessThanOrEqual(budget.maxInputTokens * (budget.maxToolCalls + 1));
      expect(requests.reduce((sum, request) => sum + request.maxOutputTokens!, 0)).toBeLessThanOrEqual(budget.maxOutputTokens * (budget.maxToolCalls + 1));
    }
    await settled(f, (await start(f, bob())).runId, bob());
    const conversation = f.store.conversationGet(aiScope(alice()), first.conversationId)!;
    f.store.conversationDelete(aiScope(alice()), conversation.id, conversation.revision);
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'over global daily run cap' })).toMatchObject({ error: { code: 'AI_DAILY_LIMIT' } });
    expect(f.generate).toHaveBeenCalledTimes(4);
  });

  it('bounds calls and reported tokens without pretending four bytes is a token limit', async () => {
    const selected = settings(['fixture.read']); delete selected.presets[0]!.pricing; selected.presets[0]!.budgetMode = 'usage';
    selected.presets[0]!.budget.maxToolCalls = 1;
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementation(async request => ({ ...calls(request, [{ action: 'fixture.read' }]), usage: { billable: 'unknown' } }));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.generate).toHaveBeenCalledTimes(2); expect(native).toHaveBeenCalledOnce();
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('AI_TOOL_LIMIT');
    f.generate.mockImplementationOnce(async request => ({ ...final('x'.repeat(request.maxOutputTokens! * 4 + 1)), usage: { billable: 'unknown' } }));
    await settled(f, (await start(f)).runId);
    expect(f.delivery.completed).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledTimes(3);
    f.generate.mockImplementationOnce(async request => ({ ...final(), usage: { inputTokens: 20, outputTokens: request.maxOutputTokens! + 1, billable: true } }));
    const over = await start(f); await settled(f, over.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), over.runId).error).toBe('AI_OUTPUT_LIMIT');
    expect(f.delivery.completed).toHaveBeenCalledOnce(); expect(f.generate).toHaveBeenCalledTimes(4);
  });

  it('preserves active and queued runs across no-op saves and unrelated provider, grant and credential changes', async () => {
    const selected = settings();
    selected.providers.push({ ...structuredClone(selected.providers[0]!), id: 'other', credentialRef: 'vault:other' });
    selected.presets.push({ ...structuredClone(selected.presets[0]!), id: 'other-preset', providerId: 'other' });
    const f = await fixture({ settings: selected }); const release = Promise.withResolvers<GenerationResult>();
    f.generate.mockImplementationOnce(async () => release.promise);
    const first = await start(f); await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    const queued = await start(f, bob());
    try {
      const before = f.store.getSettings();
      expect((await f.ai.updateSettings(invocation(), structuredClone(before.settings), before.revision)).revision).toBe(before.revision);
      const next = structuredClone(before.settings); next.providers[1]!.baseUrl = 'https://provider.invalid/v2';
      next.grants = next.grants.filter(grant => grant.subjectId !== 5);
      await f.ai.updateSettings(invocation(), next, before.revision);
      await f.ai.replaceSecret(invocation({ source: 'http' }), before.revision + 1, { operation: 'replace', ref: 'vault:other', value: 'new-isolated-secret' });
      expect(f.generate.mock.calls[0]![1].signal.aborted).toBe(false);
      expect(f.ai.runView(alice(), first.runId).state).toBe('running');
      expect(f.ai.runView(bob(), queued.runId).state).toBe('queued');
      release.resolve(final()); await settled(f, first.runId); await settled(f, queued.runId, bob());
    } finally { release.resolve(final()); }
  });

  it('cancels and drains only runs using the replaced credential', async () => {
    const selected = settings(); selected.providers[0]!.credentialRef = 'vault:primary';
    selected.providers.push({ ...structuredClone(selected.providers[0]!), id: 'other', credentialRef: 'env:MOCK_PROVIDER' });
    selected.presets.push({ ...structuredClone(selected.presets[0]!), id: 'other-preset', providerId: 'other' });
    selected.grants.find(grant => grant.subjectId === 4)!.presetId = 'other-preset';
    const f = await fixture({ settings: selected }); f.store.credentialPut('instance', 'vault:primary', 'old-isolated-secret');
    const release = Promise.withResolvers<GenerationResult>(); f.generate.mockImplementationOnce(async () => release.promise);
    const affected = await start(f); await vi.waitFor(() => expect(f.generate).toHaveBeenCalledOnce());
    const other = await start(f, bob());
    try {
      let drained = false;
      const replacing = f.ai.replaceSecret(invocation({ source: 'http' }), f.store.getSettings().revision,
        { operation: 'replace', ref: 'vault:primary', value: 'new-isolated-secret' }).then(() => { drained = true; });
      await vi.waitFor(() => expect(f.generate.mock.calls[0]![1].signal.aborted).toBe(true));
      expect(drained).toBe(false); expect(f.ai.runView(bob(), other.runId).state).toBe('queued');
      release.resolve(final('late ignored')); await replacing;
      await settled(f, affected.runId, alice(), 'cancelled'); await settled(f, other.runId, bob());
      expect(f.delivery.completed).toHaveBeenCalledTimes(1);
    } finally { release.resolve(final()); }
  });

  it('never resurrects a waiting run after an identical grant is revoked and restored', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); const native = vi.fn(() => true); register(f, 'fixture.write', native, 'write');
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }]));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'waiting-approval');
    const token = f.delivery.approval.mock.calls[0]![1].token; const original = f.store.getSettings();
    const oldKey = f.ai.approvalPolicyKey(alice(), 'ai.fixture.review');
    f.store.updateSettings({ ...original.settings, grants: original.settings.grants.filter(grant => grant.subjectId !== 3) }, original.revision);
    f.store.updateSettings(original.settings, original.revision + 1);
    expect(f.ai.approvalPolicyKey(alice(), 'ai.fixture.review')).not.toBe(oldKey);
    expect(await f.executor.execute(alice(), 'ai.run.confirm', { runId: ticket.runId, token })).toHaveProperty('error');
    expect(await f.executor.confirm(alice(), token)).toHaveProperty('error'); expect(native).not.toHaveBeenCalled();
  });

  it('fails conservatively for legacy run checkpoints after any real policy change', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); register(f, 'fixture.write', () => true, 'write');
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }]));
    const ticket = await start(f); const run = await settled(f, ticket.runId, alice(), 'waiting-approval');
    const checkpoint = { ...run.continuation as Record<string, never> }; delete checkpoint.policyKey;
    f.store.runUpdate(aiScope(alice()), run.id, { revision: run.revision, state: 'waiting-approval', continuation: checkpoint });
    const before = f.store.getSettings();
    await f.ai.updateSettings(invocation(), { ...before.settings, deniedUserIds: [5] }, before.revision);
    expect(f.ai.runView(alice(), run.id).state).toBe('cancelled');
  });

  it('does not restore a group run when its allowlist grant is revoked and regranted', async () => {
    const f = await fixture({ settings: settings(['fixture.write']) }); const native = vi.fn(() => true); register(f, 'fixture.write', native, 'write');
    f.generate.mockImplementationOnce(async request => calls(request, [{ action: 'fixture.write' }]));
    const ticket = await start(f, group()); await settled(f, ticket.runId, group(), 'waiting-approval');
    await f.access.revoke(-100, 1, f.access.snapshot().revision);
    await f.access.authorize(-100, 'regranted test group', 1, f.access.snapshot().revision);
    const token = f.delivery.approval.mock.calls[0]![1].token;
    expect(await f.executor.execute(group(), 'ai.run.confirm', { runId: ticket.runId, token })).toHaveProperty('error');
    expect(native).not.toHaveBeenCalled();
  });
});

describe('search readiness, accounting and real model roundtrips', () => {
  function searchSettings(): AiSettings {
    const value = settings(['ai.search', 'ai.fetch', 'core.info']);
    value.providers.push({ id: 'search', enabled: true, protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com/v1',
      allowedOrigins: ['https://api.deepseek.com'], credentialRef: 'env:MOCK_PROVIDER' });
    value.search = { enabled: true, providerId: 'search', maxResults: 2 };
    return value;
  }
  const lookup = async () => [{ address: '8.8.8.8', family: 4 }];
  const result = { title: 'Source', url: 'https://example.com/article', snippet: 'Evidence', summary: 'Summary', content: 'Page' };

  it.each(['missing', 'disabled', 'wrong-origin', 'provider-disabled', 'missing-key'] as const)('does not advertise or invoke unavailable %s search', async reason => {
    const selected = searchSettings();
    if (reason === 'missing') delete selected.search;
    else if (reason === 'disabled') selected.search!.enabled = false;
    else if (reason === 'wrong-origin') selected.search!.providerId = 'mock';
    else if (reason === 'provider-disabled') selected.providers[1]!.enabled = false;
    else selected.providers[1]!.credentialRef = 'env:MISSING';
    const request = vi.fn<AiHttpTransport>(async () => { throw new Error('No network expected'); });
    const f = await fixture({ settings: selected, retrievalNetwork: { request, lookup } });
    expect((await f.executor.discoverTools(alice())).map(tool => tool.id)).toEqual(['core.info']);
    expect(await f.executor.execute(alice(), 'ai.search', { query: 'public information' })).toMatchObject({ error: { code: 'AI_SEARCH_UNAVAILABLE' } });
    expect(request).not.toHaveBeenCalled(); expect(f.store.safeStatus().reservedCostMicros).toBe(0);
  });

  it.each([[401, 'AI_PROVIDER_AUTH'], [429, 'AI_PROVIDER_QUOTA'], [503, 'UNAVAILABLE']] as const)('refunds confirmed HTTP %i failures instead of exhausting the daily budget', async (status, code) => {
    const selected = searchSettings(); selected.limits.dailyCostMicros = 5000;
    const request = vi.fn<AiHttpTransport>(async () => ({ status, headers: {}, body: Readable.from(['private upstream error body']) }));
    const f = await fixture({ settings: selected, retrievalNetwork: { request, lookup } });
    for (let index = 0; index < 3; index++) {
      expect(await f.executor.execute(alice(), 'ai.search', { query: 'public information' })).toMatchObject({ error: { code } });
      expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 0, settledCostMicros: 0 });
    }
    expect(request).toHaveBeenCalledTimes(3); expect(JSON.stringify(f.audit.mock.calls)).not.toContain('private upstream error body');
  });

  it('keeps ambiguous dispatched failures reserved, but refunds blocked fetches before dispatch', async () => {
    const selected = searchSettings(); selected.limits.dailyCostMicros = 5000;
    const request = vi.fn<AiHttpTransport>(async () => { throw new Error('untrusted network detail'); });
    const f = await fixture({ settings: selected, retrievalNetwork: { request, lookup } });
    expect(await f.executor.execute(alice(), 'ai.fetch', { url: 'http://127.0.0.1/private' })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(request).not.toHaveBeenCalled(); expect(f.store.safeStatus().reservedCostMicros).toBe(0);
    expect(await f.executor.execute(alice(), 'ai.search', { query: 'public information' })).toMatchObject({ error: { code: 'UNAVAILABLE' } });
    expect(f.store.safeStatus().reservedCostMicros).toBe(5000);
    expect(await f.executor.execute(alice(), 'ai.search', { query: 'another query' })).toMatchObject({ error: { code: 'AI_BUDGET_LIMIT' } });
    expect(request).toHaveBeenCalledOnce(); expect(JSON.stringify(f.audit.mock.calls)).not.toContain('untrusted network detail');
  });

  it('refunds DNS failures before the search request is dispatched', async () => {
    const selected = searchSettings(); selected.limits.dailyCostMicros = 5000;
    const request = vi.fn<AiHttpTransport>(async () => { throw new Error('No dispatch expected'); });
    const f = await fixture({ settings: selected, retrievalNetwork: { request, lookup: async () => { throw new Error('DNS unavailable'); } } });
    for (let index = 0; index < 2; index++) {
      expect(await f.executor.execute(alice(), 'ai.search', { query: 'public information' })).toMatchObject({ error: { code: 'UNAVAILABLE' } });
      expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 0, settledCostMicros: 0 });
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('applies configured result limits and accepts 128 Unicode code points through the Action', async () => {
    const request = vi.fn<AiHttpTransport>(async () => ({ status: 200, headers: { 'content-type': 'application/json' }, body: Readable.from([Buffer.from(JSON.stringify({ results: [result] }))]) }));
    const f = await fixture({ settings: searchSettings(), retrievalNetwork: { request, lookup } });
    expect((await f.executor.discoverTools(alice())).map(tool => tool.id)).toEqual(['core.info', 'ai.search', 'ai.fetch']);
    const query = '\u{1f30d}'.repeat(128);
    data(await f.executor.execute(alice(), 'ai.search', { query, count: 10 }));
    expect(JSON.parse(request.mock.calls[0]![1].body.toString())).toEqual({ query, count: 2, need_content: false });
    expect(request.mock.calls[0]![0].origin).toBe('https://api.deepseek.com');
    expect(await f.executor.execute(alice(), 'ai.search', { query: `${query}x` })).toMatchObject({ error: { code: 'INVALID_INPUT' } });
    expect(request).toHaveBeenCalledOnce();
  });

  it('finishes a native model -> large search result -> native model roundtrip within real tool-result limits', async () => {
    const selected = searchSettings(); const preset = selected.presets[0]!;
    selected.providers[0]!.baseUrl = 'https://api.openai.com/v1'; selected.providers[0]!.allowedOrigins = ['https://api.openai.com'];
    preset.budgetMode = 'usage'; delete preset.pricing; preset.outputCapabilities = ['text'];
    preset.budget = { ...aiInteractiveBudget(), maxCostMicros: 100 };
    const request = vi.fn<AiHttpTransport>(async () => ({ status: 200, headers: { 'content-type': 'application/json' },
      body: Readable.from([Buffer.from(JSON.stringify({ results: [result, { ...result, url: 'https://example.com/second', content: '\u754c'.repeat(5000), summary: '\u754c'.repeat(3000) }] }))]) }));
    const f = await fixture({ settings: selected, retrievalNetwork: { request, lookup } });
    const reply = 'Verified answer. '.repeat(1000); const requests: GenerationRequest[] = [];
    const post = vi.fn<AiTransport['post']>(async (input, options) => {
      const first = requests.length === 1;
      if (!first) {
        const records = (input.body as { input: { type?: string; output?: string }[] }).input;
        const receipt = records.find(item => item.type === 'function_call_output')!.output!;
        expect(Buffer.byteLength(receipt)).toBeLessThan(8192);
        expect(JSON.parse(receipt)).toMatchObject({ status: 'succeeded', data: { trust: 'untrusted', truncated: true, results: expect.any(Array) } });
      }
      await options.onEvent!({ event: 'message', data: JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: first
        ? [{ type: 'function_call', call_id: 'search-call', name: toolName(requests[0]!, 'ai.search'), arguments: '{"query":"public evidence","count":10,"needContent":true}' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }] } }) });
    });
    f.provider.mockImplementation(profile => {
      const native = createAiProvider(profile, { transport: { post } });
      return { generate: (input, options) => { requests.push(structuredClone(input)); return native.generate(input, options); } };
    });
    const ticket = await start(f); await settled(f, ticket.runId);
    expect(request).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledTimes(2);
    expect(requests.every(input => input.maxOutputTokens === 8192)).toBe(true);
    expect(f.delivery.completed).toHaveBeenCalledWith(expect.anything(), reply, expect.any(AbortSignal));
    expect(f.store.runGet(aiScope(alice()), ticket.runId)!.continuation).toMatchObject({ calls: 1, costMicros: 5000, billingUnknown: true });
  });
});
