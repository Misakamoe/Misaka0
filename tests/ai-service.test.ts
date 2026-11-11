import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { aiDefaults, aiSettingsSchema, type AiRunState, type AiSettings } from '../shared/schemas/ai.js';
import type { AiRunStart } from '../shared/schemas/ai-control.js';
import { emptyInputSchema, type ActionResult } from '../shared/schemas/index.js';
import { subconvDefaults } from '../shared/schemas/subconv.js';
import { ActionExecutor, type ActionDefinition, type ActionServices, type InvocationContext } from '../src/actions.js';
import { aiScope } from '../src/ai/policy.js';
import { createAiProvider, type AiProvider, type GenerationRequest, type GenerationResult, type NativeContinuation, type ProviderProfile } from '../src/ai/providers.js';
import { AiService } from '../src/ai/service.js';
import type { AiCapturedFile, AiDelivery } from '../src/ai/telegram-port.js';
import { createAiTransport, type AiHttpTransport } from '../src/ai/transport.js';
import type { StartupConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import { ResourcePolicy } from '../src/resources.js';
import { coreFixture, invocation, testToken } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  try { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); }
  finally { vi.restoreAllMocks(); }
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
      inputCapabilities: ['text', 'image', 'audio', 'document'], outputCapabilities: ['text', 'image'],
      budget: { maxInputTokens: 32768, maxOutputTokens: 1024, maxToolCalls: 4, maxDurationMs: 10000, maxCostMicros: 100 },
      // Explicit zero prices are valid only for this injected, non-billable test provider.
      pricing: { currency: 'CNY', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }],
    grants: [3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map(subjectId => ({ id: `user${subjectId}`, kind: 'private', subjectId, presetId: 'fixed' }))
      .concat([{ id: 'group100', kind: 'group', subjectId: -100, presetId: 'fixed' }]),
  });
}

function data<T>(result: ActionResult<T>): T {
  expect(result.status).toBe('succeeded');
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

async function fixture(options: { settings?: AiSettings; now?: () => number; groupAdmin?: ActionServices['groupAdmin'] } = {}) {
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
  const ai = new AiService({ config, access: core.access, provider, resources, now: options.now });
  const executor = new ActionExecutor({ ...core.services, ai, now: options.now,
    aiPolicy: { available: context => ai.available(context), authorize: (context, id, effect) => ai.authorize(context, id, effect),
      approvalExempt: (context, id) => ai.approvalExempt(context, id) },
    aiNativeDelivery: (context, file) => ai.deliverNative(context, file), groupAdmin: options.groupAdmin });
  let message = 100;
  const delivery = { started: vi.fn<AiDelivery['started']>(async () => {}), progress: vi.fn<AiDelivery['progress']>(async () => {}),
    approval: vi.fn<AiDelivery['approval']>(async () => {}), completed: vi.fn<AiDelivery['completed']>(async () => ++message),
    failed: vi.fn<AiDelivery['failed']>(async () => {}), file: vi.fn<AiDelivery['file']>(async () => {}) };
  const download = vi.fn(async (_file: AiCapturedFile, _signal: AbortSignal): Promise<Uint8Array> => Buffer.from('mock document'));
  ai.attachExecutor(executor); ai.attachTelegram(delivery, download);
  cleanups.push(async () => { await ai.stop(false); await executor.close(); await ai.stop(); core.subconv.stop(); await core.close(); });
  await ai.initialize();
  const store = ai.data(alice());
  store.updateSettings(options.settings ?? settings(), 0);
  await core.access.authorize(-100, 'mock group', 1, 0);
  return { ...core, config, ai, executor, generate, provider, delivery, download, store, resources };
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
    } finally { vi.useRealTimers(); }
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
    expect(Buffer.from(output.bytes!).toString('utf8')).toContain('MOCK_SOURCE_SECRET');
    expect(JSON.stringify(f.generate.mock.calls)).not.toMatch(/MOCK_SOURCE_SECRET|MOCK_BACKEND_SECRET|source\.invalid|converter\.invalid/);
    expect(JSON.stringify(f.store.recordList(aiScope(alice()), 'receipt'))).not.toMatch(/MOCK_SOURCE_SECRET|MOCK_BACKEND_SECRET/);
  });

  it('stops at the cumulative tool-call budget instead of beginning another native mutation', async () => {
    const selected = settings(['fixture.read']); selected.presets[0]!.budget.maxToolCalls = 1;
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementation(async request => calls(request, [{ action: 'fixture.read' }]));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('CAPACITY');
    expect(native).toHaveBeenCalledTimes(1); expect(f.generate).toHaveBeenCalledTimes(2);
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
      if (kind === 'stream') { await options.onText?.('\u754c'.repeat(8193), options.signal); return final(); }
      if (kind === 'final') return final('\u754c'.repeat(8193));
      if (kind === 'artifact') return { ...final(), artifacts: [{ type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(1048577) }] };
      const result = calls(request, [{ action: 'core.info' }]);
      if (kind === 'continuation') result.continuation!.records = [{ opaque: 'x'.repeat(48001) }];
      else result.toolCalls[0]!.arguments = { text: 'x'.repeat(8193) };
      return result;
    });
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('CAPACITY');
    expect(f.generate).toHaveBeenCalledTimes(1); expect(f.delivery.completed).not.toHaveBeenCalled(); expect(f.delivery.file).not.toHaveBeenCalled();
    if (kind === 'stream') expect(f.delivery.progress).not.toHaveBeenCalled();
  });

  it('retains a conservative reservation when a successful response has unknown usage', async () => {
    const selected = settings(); selected.limits.dailyCostMicros = 100;
    const f = await fixture({ settings: selected }); f.generate.mockResolvedValue({ ...final(), usage: { billable: 'unknown' } });
    await settled(f, (await start(f)).runId);
    expect(f.store.safeStatus()).toMatchObject({ reservedCostMicros: 100, settledCostMicros: 0 });
    const second = await start(f); await settled(f, second.runId, alice(), 'failed');
    expect(f.ai.runView(alice(), second.runId).error).toBe('CAPACITY'); expect(f.generate).toHaveBeenCalledTimes(1);
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
      expect(requests.reduce((sum, request) => sum + request.maxInputTokens!, 0)).toBeLessThanOrEqual(selected.presets[0]!.budget.maxInputTokens);
      expect(requests.reduce((sum, request) => sum + request.maxOutputTokens!, 0)).toBeLessThanOrEqual(selected.presets[0]!.budget.maxOutputTokens);
    }
    await settled(f, (await start(f, bob())).runId, bob());
    const conversation = f.store.conversationGet(aiScope(alice()), first.conversationId)!;
    f.store.conversationDelete(aiScope(alice()), conversation.id, conversation.revision);
    expect(await f.executor.execute(alice(), 'ai.run.start', { text: 'over global daily run cap' })).toMatchObject({ error: { code: 'CAPACITY' } });
    expect(f.generate).toHaveBeenCalledTimes(4);
  });

  it('bounds provider calls and missing-usage output without retries', async () => {
    const selected = settings(['fixture.read']); delete selected.presets[0]!.pricing; selected.presets[0]!.budgetMode = 'usage';
    selected.presets[0]!.budget.maxToolCalls = 1;
    const f = await fixture({ settings: selected }); const native = vi.fn(() => true); register(f, 'fixture.read', native);
    f.generate.mockImplementation(async request => ({ ...calls(request, [{ action: 'fixture.read' }]), usage: { billable: 'unknown' } }));
    const ticket = await start(f); await settled(f, ticket.runId, alice(), 'failed');
    expect(f.generate).toHaveBeenCalledTimes(2); expect(native).toHaveBeenCalledOnce();
    expect(f.ai.runView(alice(), ticket.runId).error).toBe('CAPACITY');
    f.generate.mockImplementationOnce(async request => ({ ...final('x'.repeat(request.maxOutputTokens! * 4 + 1)), usage: { billable: 'unknown' } }));
    await settled(f, (await start(f)).runId, alice(), 'failed');
    expect(f.delivery.completed).not.toHaveBeenCalled(); expect(f.generate).toHaveBeenCalledTimes(3);
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
