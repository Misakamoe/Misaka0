import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiDefaults, aiSettingsSchema } from '../shared/schemas/ai.js';
import type { ActionResult, Confirmation } from '../shared/schemas/index.js';
import { ActionExecutor, type InvocationContext } from '../src/actions.js';
import type { AiProvider, GenerationResult } from '../src/ai/providers.js';
import { AiService } from '../src/ai/service.js';
import type { AiDelivery } from '../src/ai/telegram-port.js';
import type { StartupConfig } from '../src/config.js';
import { AppError } from '../src/errors.js';
import type { RssTarget } from '../src/modules/rss.js';
import { coreFixture, invocation, testToken } from './support/core.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { try { for (const close of cleanups.splice(0).reverse()) await close(); } finally { vi.restoreAllMocks(); } });
const privateTarget = { chatId: 3, kind: 'private', threadId: 7 } as const;
const owner = () => invocation({ actorId: 3, chat: { id: 3, type: 'private', threadId: 7 } });
const source = 'https://feeds.example.com/rss?token=private-source-secret';
const currentTitle = '<b>Current</b> **literal**';

async function fixture(feedTitle = 'Stored feed title') {
  const fetcher = vi.fn(async (url: string) => ({ finalUrl: url, notModified: false, feed: { title: feedTitle, entries: [] } }));
  const groupAdmin = vi.fn(async (_chatId: number, actorId: number) => actorId === 3);
  const f = await coreFixture({ rss: { fetcher }, services: { aiEnabled: true, groupAdmin } });
  cleanups.push(f.close);
  return { ...f, fetcher, groupAdmin };
}

function confirmation(result: ActionResult): Confirmation {
  expect(result.status, JSON.stringify(result)).toBe('pending_confirmation');
  if (result.status !== 'pending_confirmation') throw new Error('missing approval');
  return result.confirmation;
}

describe('authoritative RSS confirmation subjects', () => {
  it('uses the current custom title, not a proposed rename, and preserves exact normalized input without an rss.get grant', async () => {
    const f = await fixture();
    const subscription = await f.rss.add(privateTarget, { url: source, title: currentTitle }, 'en');
    f.fetcher.mockClear();
    const authorize = vi.fn((_context: InvocationContext, actionId: string) => {
      if (!['rss.update', 'rss.remove'].includes(actionId)) throw new AppError('FORBIDDEN');
    });
    f.services.aiPolicy = { available: () => true, authorize };
    const input = { id: subscription.id, revision: 0, title: '  Proposed rename  ', filters: { include: [' Keep '], exclude: [' Hide '] } };
    const result = await f.executor.executeTool(owner(), 'rss.update', input);
    const pending = confirmation(result);
    expect(pending.subject).toEqual({ kind: 'rss', id: subscription.id, title: currentTitle });
    expect(pending.target).toBe('user:3');
    expect(f.executor.pendingDetails(owner(), pending.token).input)
      .toEqual({ ...input, title: 'Proposed rename', filters: { include: ['Keep'], exclude: ['Hide'] } });
    expect(f.rss.get(privateTarget, subscription.id)).toMatchObject({ title: currentTitle, revision: 0 });
    expect(authorize.mock.calls.every(([context, id]) => context.actorId === 3 && context.source === 'ai' && id === 'rss.update')).toBe(true);
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(source); expect(JSON.stringify(result)).not.toContain('private-source-secret');
    expect(await f.executor.confirm(owner(), pending.token)).toMatchObject({ status: 'succeeded', data: { id: subscription.id, changed: true } });
    expect(f.rss.get(privateTarget, subscription.id)).toMatchObject({ title: 'Proposed rename', revision: 1 });
  });

  it.each(['Stored feed title', ''])('retains distinct IDs for duplicate feed titles, including an empty title (%j)', async title => {
    const f = await fixture(title);
    const first = await f.rss.add(privateTarget, { url: source }, 'en');
    const second = await f.rss.add(privateTarget, { url: `${source}&second=1` }, 'en');
    expect(first.id).not.toBe(second.id);
    f.fetcher.mockClear();
    for (const subscription of [first, second]) {
      const pending = confirmation(await f.executor.executeTool(owner(), 'rss.remove', { id: subscription.id, revision: 0 }));
      expect(pending.subject).toEqual({ kind: 'rss', id: subscription.id, title });
      expect(Object.keys(pending.subject!).sort()).toEqual(['id', 'kind', 'title']);
    }
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it('checks actor, group admission, actual admin status and AI policy before reading a label in the original topic', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const target = { chatId: -100, kind: 'group', threadId: 9 } as const;
    const subscription = await f.rss.add(target, { url: source, title: currentTitle }, 'en');
    const input = { id: subscription.id, revision: 0 };
    const manager = invocation({ actorId: 3, chat: { id: -100, type: 'supergroup', threadId: 9 } });
    const read = vi.spyOn(f.rss, 'get');
    const authorize = vi.fn((_context: InvocationContext, actionId: string) => {
      if (actionId !== 'rss.remove') throw new AppError('FORBIDDEN');
    });
    f.services.aiPolicy = { available: () => true, authorize };
    for (const context of [invocation({ actorId: 4, chat: manager.chat }),
      invocation({ actorId: 3, chat: { id: -200, type: 'supergroup', threadId: 9 } })]) {
      expect(await f.executor.executeTool(context, 'rss.remove', input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    }
    expect(read).not.toHaveBeenCalled();
    authorize.mockImplementationOnce(() => { throw new AppError('FORBIDDEN'); });
    expect(await f.executor.executeTool(manager, 'rss.remove', input)).toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(read).not.toHaveBeenCalled();
    f.groupAdmin.mockClear(); authorize.mockClear();
    const pending = confirmation(await f.executor.executeTool(manager, 'rss.remove', input));
    expect(pending).toMatchObject({ target: 'chat:-100', subject: { kind: 'rss', id: subscription.id, title: currentTitle } });
    expect(read).toHaveBeenCalledExactlyOnceWith(target, subscription.id);
    expect(f.groupAdmin).toHaveBeenCalledWith(-100, 3, manager.signal);
    expect(f.groupAdmin.mock.invocationCallOrder[0]).toBeLessThan(read.mock.invocationCallOrder[0]!);
    expect(authorize.mock.calls[0]![0]).toMatchObject({ source: 'ai', actorId: 3, chat: manager.chat });
    expect(authorize.mock.invocationCallOrder.at(-1)).toBeLessThan(read.mock.invocationCallOrder[0]!);
    expect(() => f.executor.pending(invocation({ actorId: 4, chat: manager.chat }), pending.token)).toThrow('CONFIRMATION_EXPIRED');
    const wrongTopic = await f.executor.executeTool(invocation({ actorId: 3, chat: { ...manager.chat, threadId: 8 } }), 'rss.remove', input);
    expect(wrongTopic).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    expect(JSON.stringify(wrongTopic)).not.toContain(currentTitle);
    expect(read).toHaveBeenLastCalledWith({ ...target, threadId: 8 }, subscription.id);
  });

  it.each(['rss.update', 'rss.remove'])('does not expose another owner or topic through %s', async actionId => {
    const f = await fixture();
    const subscription = await f.rss.add(privateTarget, { url: source, title: currentTitle }, 'en');
    const input = { id: subscription.id, revision: 0, ...(actionId === 'rss.update' ? { paused: true } : {}) };
    const contexts = [invocation({ chat: { id: 1, type: 'private', threadId: 7 } }),
      invocation({ actorId: 4, chat: { id: 4, type: 'private', threadId: 7 } }),
      invocation({ actorId: 3, chat: { id: 3, type: 'private', threadId: 8 } }),
      invocation({ actorId: 3, chat: { id: 3, type: 'private' } })];
    for (const context of contexts) {
      const result = await f.executor.executeTool(context, actionId, input);
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
      expect(JSON.stringify(result)).not.toContain(currentTitle);
    }
    expect(f.executor['approvals'].size).toBe(0);
    expect(await f.executor.executeTool(owner(), actionId, { ...input, subject: { kind: 'rss', id: subscription.id, title: 'Forged' } }))
      .toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
  });

  it.each(['rss.update', 'rss.remove'])('rejects stale or deleted subscriptions before issuing a %s approval', async actionId => {
    const f = await fixture();
    const subscription = await f.rss.add(privateTarget, { url: source, title: currentTitle }, 'en');
    const input = { id: subscription.id, revision: 0, ...(actionId === 'rss.update' ? { paused: true } : {}) };
    await f.rss.update(privateTarget, { id: subscription.id, revision: 0, title: 'Changed elsewhere' });
    expect(await f.executor.executeTool(owner(), actionId, input)).toMatchObject({ status: 'rejected', error: { code: 'CONFLICT' } });
    expect(await f.executor.prepare(owner(), actionId, input)).toMatchObject({ status: 'rejected', error: { code: 'CONFLICT' } });
    await f.rss.remove(privateTarget, subscription.id, 1);
    expect(await f.executor.executeTool(owner(), actionId, { ...input, revision: 1 })).toMatchObject({ status: 'rejected', error: { code: 'NOT_FOUND' } });
    expect(f.executor['approvals'].size).toBe(0); expect(f.executor['approvalBytes']).toBe(0);
  });

  it.each([
    ['rss.update', 'rename'], ['rss.update', 'delete'], ['rss.remove', 'rename'], ['rss.remove', 'delete'],
  ])('retains decisive revision/ownership checks for %s after an intervening %s', async (actionId, change) => {
    const f = await fixture();
    const subscription = await f.rss.add(privateTarget, { url: source, title: currentTitle }, 'en');
    const input = { id: subscription.id, revision: 0, ...(actionId === 'rss.update' ? { title: 'Proposed rename' } : {}) };
    const pending = confirmation(await f.executor.executeTool(owner(), actionId!, input));
    if (change === 'rename') await f.rss.update(privateTarget, { id: subscription.id, revision: 0, title: 'Changed elsewhere' });
    else await f.rss.remove(privateTarget, subscription.id, 0);
    expect(f.executor.pending(owner(), pending.token).subject).toEqual({ kind: 'rss', id: subscription.id, title: currentTitle });
    expect(await f.executor.confirm(owner(), pending.token)).toMatchObject({ status: 'failed', error: { code: change === 'rename' ? 'CONFLICT' : 'NOT_FOUND' } });
    expect(await f.executor.confirm(owner(), pending.token)).toMatchObject({ status: 'rejected', error: { code: 'CONFIRMATION_EXPIRED' } });
    if (change === 'rename') expect(f.rss.get(privateTarget, subscription.id)).toMatchObject({ title: 'Changed elsewhere', revision: 1 });
    else expect(f.rss.list(privateTarget).total).toBe(0);
  });

  it('does not read a subject for cancelled requests or add approvals', async () => {
    const f = await fixture();
    const read = vi.spyOn(f.rss, 'get');
    const controller = new AbortController(); controller.abort();
    expect(() => f.executor.executeTool(invocation({ ...owner(), signal: controller.signal }), 'rss.remove', { id: 'abcdef123456', revision: 0 }))
      .toThrow('CANCELLED');
    const pending = confirmation(await f.executor.executeTool(owner(), 'rss.add', { url: source }));
    expect(pending).not.toHaveProperty('subject'); expect(read).not.toHaveBeenCalled(); expect(f.fetcher).not.toHaveBeenCalled();
  });
});

describe('RSS approval service forwarding', () => {
  it('forwards canonical stored metadata and normalized input with only the mutation tool enabled', async () => {
    const f = await fixture();
    await f.access.authorize(-100, 'Group', 1, 0);
    const target: RssTarget = { chatId: -100, kind: 'group', threadId: 9 };
    const actor = invocation({ actorId: 3, chat: { id: -100, type: 'supergroup', threadId: 9 } });
    const subscription = await f.rss.add(target, { url: source, title: currentTitle }, 'en');
    f.fetcher.mockClear();
    const config: StartupConfig = { botToken: testToken, adminIds: [1, 2], dataDir: f.directory, logLevel: 'silent',
      pollingTimeout: 30, requestTimeout: 60, dropPendingUpdates: false, web: { enabled: false, host: '127.0.0.1', port: 8080 },
      ai: { masterKey: '37'.repeat(32), secrets: { MOCK_PROVIDER: 'mock-provider-secret-not-real' } } };
    const generate = vi.fn<AiProvider['generate']>(async request => {
      expect(request.tools).toHaveLength(1);
      const tool = request.tools![0]!;
      const result: GenerationResult = { text: '', usage: { inputTokens: 20, outputTokens: 5, billable: false },
        toolCalls: [{ id: 'call-1', name: tool.name, arguments: { id: subscription.id, revision: 0, title: '  Proposed rename  ' } }],
        continuation: { version: 1, protocol: 'openai-responses', origin: 'https://provider.invalid', model: 'mock-model', binding: 'mock-binding',
          records: [{ type: 'reasoning', encrypted_content: 'opaque-native-signature' }], pending: [{ id: 'call-1', name: tool.name }] } };
      return result;
    });
    const ai = new AiService({ config, access: f.access, provider: () => ({ generate }) });
    const executor = new ActionExecutor({ ...f.services, ai, aiPolicy: { available: context => ai.available(context),
      authorize: (context, id, effect) => ai.authorize(context, id, effect), approvalExempt: (context, id) => ai.approvalExempt(context, id) } });
    const delivery = { started: vi.fn<AiDelivery['started']>(async () => {}), progress: vi.fn<AiDelivery['progress']>(async () => {}),
      approval: vi.fn<AiDelivery['approval']>(async () => {}), completed: vi.fn<AiDelivery['completed']>(async () => 100),
      failed: vi.fn<AiDelivery['failed']>(async () => {}), file: vi.fn<AiDelivery['file']>(async () => {}), retire: vi.fn<AiDelivery['retire']>(async () => {}) };
    ai.attachExecutor(executor); ai.attachTelegram(delivery, async () => { throw new Error('Unexpected download'); });
    cleanups.push(async () => { await ai.stop(false); await executor.close(); await ai.stop(); });
    await ai.initialize();
    ai.data(actor).updateSettings(aiSettingsSchema.parse({ ...aiDefaults(), enabled: true,
      providers: [{ id: 'mock', enabled: true, protocol: 'openai-responses', baseUrl: 'https://provider.invalid/v1',
        allowedOrigins: ['https://provider.invalid'], credentialRef: 'env:MOCK_PROVIDER' }],
      presets: [{ id: 'fixed', providerId: 'mock', model: 'mock-model', tools: ['rss.update'], inputCapabilities: ['text'], outputCapabilities: ['text'],
        budget: { maxInputTokens: 32768, maxOutputTokens: 1024, maxToolCalls: 4, maxDurationMs: 10000, maxCostMicros: 100 },
        pricing: { currency: 'CNY', inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 } }],
      grants: [{ id: 'group100', kind: 'group', subjectId: -100, presetId: 'fixed' }],
    }), 0);
    expect((await executor.discoverTools(actor)).map(tool => tool.id)).toEqual(['rss.update']);
    const executeTool = executor.executeTool.bind(executor);
    vi.spyOn(executor, 'executeTool').mockImplementation(async (context, id, input) => {
      const result = await executeTool(context, id, input);
      if (result.status === 'pending_confirmation') result.confirmation.subject!.title = 'Tampered receipt';
      return result;
    });
    const result = await executor.execute<{ runId: string }>(actor, 'ai.run.start', { text: 'Rename the subscription.' });
    if (result.status !== 'succeeded') throw new Error(JSON.stringify(result));
    await vi.waitFor(() => expect(delivery.approval).toHaveBeenCalledOnce());
    expect(ai.runView(actor, result.data.runId).state).toBe('waiting-approval');
    const [destination, pending, tool, , input] = delivery.approval.mock.calls[0]!;
    expect(destination).toMatchObject({ actorId: 3, chat: actor.chat }); expect(tool).toBe('rss.update');
    expect(pending.subject).toEqual({ kind: 'rss', id: subscription.id, title: currentTitle });
    expect(pending.target).toBe('chat:-100');
    expect(input).toEqual({ id: subscription.id, revision: 0, title: 'Proposed rename' });
    expect({ confirmation: pending, input }).toEqual(executor.pendingDetails(actor, pending.token));
    expect(JSON.stringify(delivery.approval.mock.calls)).not.toContain('private-source-secret');
    expect(f.fetcher).not.toHaveBeenCalled(); expect(delivery.failed).not.toHaveBeenCalled();
  });
});
