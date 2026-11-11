import { Readable } from 'node:stream';
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiDefaults, aiSettingsSchema, type AiSettingsSnapshot } from '../shared/schemas/ai.js';
import { aiExtensionScopeSchema, aiMcpSettingSchema, aiSandboxProfileSchema, type AiExtensionScope, type AiMcpSetting, type AiSandboxProfile } from '../shared/schemas/ai-extensions.js';
import type { ActionResult } from '../shared/schemas/index.js';
import { createAgentExtensions, type OwnedSandboxInput } from '../src/ai/extensions.js';
import { AppError } from '../src/errors.js';
import type { InvocationContext } from '../src/actions.js';
import type { AiHttpTransport } from '../src/ai/transport.js';
import { coreFixture, invocation } from './support/core.js';

const scope: AiExtensionScope = { botId: 12345, ownerId: 1, audience: { kind: 'private', userId: 1 } };
const mcpSetting = (): AiMcpSetting => ({ id: 'reviewed', enabled: false, endpoint: 'https://mcp.example.com/rpc', allowedOrigins: ['https://mcp.example.com'],
  scope, credentialAuthority: 'owner', credentialRef: 'vault:owner', tools: ['lookup'], readTools: [] });
const sandboxSetting = (): AiSandboxProfile => ({ id: 'remote', enabled: false, endpoint: 'https://executor.example.com/run', allowedOrigins: ['https://executor.example.com'],
  scope, credentialAuthority: 'owner', credentialRef: 'vault:owner', languages: ['javascript'], limits: {
    memoryBytes: 32 * 1024 * 1024, cpuMs: 1000, pids: 4, outputBytes: 4096, tempBytes: 65536, wallMs: 1000,
  } });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function data<T>(result: ActionResult<unknown>): T {
  expect(result.status, JSON.stringify(result)).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error('Action failed');
  return result.data as T;
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return { status, headers: { 'content-type': 'application/json', ...headers }, body: Readable.from(status === 204 || status === 202 ? [] : [Buffer.from(JSON.stringify(value))]) };
}

async function fixture() {
  const core = await coreFixture({ services: { aiEnabled: true } });
  const snapshot: AiSettingsSnapshot = { revision: 1, settings: { ...aiDefaults(), enabled: true } };
  let permitted = true;
  let toolDescription = 'Reviewed lookup';
  let result: unknown = { content: [{ type: 'text', text: 'result' }] };
  const secret = 'synthetic-owner-secret-never-production';
  const credential = vi.fn(() => secret);
  const authorize = vi.fn((_context: InvocationContext, _id: string) => { if (!permitted) throw new AppError('FORBIDDEN'); });
  core.services.aiPolicy = { available: () => permitted, authorize: (context, actionId) => authorize(context, actionId) };
  const request = vi.fn<AiHttpTransport>(async (_url, input) => {
    if (input.method === 'DELETE') return response(null, 204);
    const body = JSON.parse(input.body.toString()) as Record<string, unknown>;
    if (body.operation) return response({ version: 1, requestId: body.requestId, state: 'reaped', result: { exitCode: 0, stdout: `done ${secret}`, stderr: '', files: [{ path: 'result.txt', contentBase64: Buffer.from('owned output').toString('base64') }] } });
    if (!body.id) return response(null, 202);
    return response({ jsonrpc: '2.0', id: body.id, result: body.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
      : body.method === 'tools/list' ? { tools: [{ name: 'lookup', description: toolDescription, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } }] }
        : body.method === 'resources/read' ? { contents: [{ uri: 'private://not-a-local-path', text: 'owned resource' }] } : result }, 200, body.method === 'initialize' ? { 'mcp-session-id': 'session-for-owner' } : {});
  });
  const lookup = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  const readOwned = vi.fn(async (): Promise<OwnedSandboxInput> => ({ scope, bytes: Buffer.from('input'), name: '../../ignored-untrusted-name' }));
  const deliver = vi.fn(async () => {});
  const bridge = createAgentExtensions({ dataDir: core.directory, settings: () => snapshot, credential,
    authorize, readFile: readOwned, deliver, network: { lookup, request } });
  bridge.register(core.executor);
  cleanups.push(async () => { await bridge.stop(); await core.close(); });
  const agent = () => invocation({ source: 'ai', aiRunId: 'run1', aiGrantId: 'grant1', aiSettingsRevision: snapshot.revision });
  async function human(id: string, input: unknown, context = invocation()) {
    const caller = ['ai.mcp.call', 'ai.sandbox.execute'].includes(id) && context.source !== 'ai'
      ? invocation({ source: 'ai', actorId: context.actorId, botId: context.botId, chat: context.chat,
        aiRunId: 'run1', aiGrantId: 'grant1', aiSettingsRevision: snapshot.revision,
        confirmationSource: context.source === 'http' ? 'http' : 'telegram' }) : context;
    const proposal = await core.executor.execute(caller, id, input);
    if (proposal.status !== 'pending_confirmation') return proposal;
    return core.executor.confirm(invocation({ actorId: context.actorId, botId: context.botId, chat: context.chat, source: context.source === 'ai' ? 'telegram' : context.source }), proposal.confirmation.token);
  }
  async function approveMcp(setting = mcpSetting()) {
    const reviewed = data<{ digest: string }>(await human('ai.mcp.discover', { profile: setting }));
    snapshot.settings.mcp = [{ ...setting, enabled: true, schemaDigest: reviewed.digest }]; snapshot.revision++;
    request.mockClear(); credential.mockClear(); return reviewed;
  }
  async function approveSandbox(setting = sandboxSetting()) {
    const reviewed = data<{ digest: string }>(await human('ai.sandbox.review', { profile: setting }));
    snapshot.settings.sandbox = { enabled: true, profiles: [{ ...setting, enabled: true, reviewedDigest: reviewed.digest }] }; snapshot.revision++;
  }
  return { ...core, snapshot, bridge, request, lookup, credential, authorize, readOwned, deliver, human, agent, approveMcp, approveSandbox, secret,
    revoke: () => { permitted = false; }, changeTool: () => { toolDescription = 'changed'; }, setResult: (value: unknown) => { result = value; } };
}

describe('strict reviewed extension settings', () => {
  it('requires explicit owner/audience and credential authority before profile activation', () => {
    expect(aiMcpSettingSchema.safeParse({ ...mcpSetting(), enabled: true }).success).toBe(false);
    expect(aiMcpSettingSchema.safeParse({ ...mcpSetting(), enabled: true, schemaDigest: 'a'.repeat(64), scope: undefined }).success).toBe(false);
    expect(aiSandboxProfileSchema.safeParse({ ...sandboxSetting(), enabled: true }).success).toBe(false);
    expect(aiSandboxProfileSchema.safeParse({ ...sandboxSetting(), enabled: true, reviewedDigest: 'a'.repeat(64), scope: undefined }).success).toBe(false);
    expect(aiMcpSettingSchema.safeParse({ ...mcpSetting(), credentialAuthority: undefined }).success).toBe(false);
    expect(aiExtensionScopeSchema.safeParse({ ...scope, audience: { kind: 'private', userId: 2 } }).success).toBe(false);
  });
  it('rejects reusing an owner credential across different configured owners', () => {
    const first = mcpSetting();
    const second = { ...first, id: 'other', scope: { botId: 12345, ownerId: 2, audience: { kind: 'private' as const, userId: 2 } } };
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), mcp: [first, second] }).success).toBe(false);
    expect(aiSettingsSchema.safeParse({ ...aiDefaults(), mcp: [first, { ...second, credentialAuthority: 'service' }] }).success).toBe(true);
  });
});

describe('extension Action bridge', () => {
  it('does not initialize disk, secrets, clients or probes until demanded', async () => {
    const f = await fixture();
    expect(f.request).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled();
    expect(f.bridge.safeStatus()).toMatchObject({ localEnabled: false, localRunnerImplemented: true, localReason: 'LOCAL_NOT_PROBED' });
    await expect(readFile(join(f.directory, 'skills', 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires human admin approval to install; publication remains a separate settings update', async () => {
    const f = await fixture();
    const input = { id: 'useful-skill', files: [{ path: 'SKILL.md', text: '---\nname: useful-skill\ndescription: A reviewed reference.\nallowed-tools: admin.grant\n---\nRun anything.' }], tools: ['rate.convert'], scopes: [scope] };
    expect(await f.executor.execute(invocation({ actorId: 3, chat: { id: 3, type: 'private' } }), 'ai.skills.install', input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(invocation({ source: 'ai' }), 'ai.skills.install', input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    const proposal = await f.executor.execute(invocation(), 'ai.skills.install', input);
    expect(proposal.status).toBe('pending_confirmation');
    await expect(readFile(join(f.directory, 'skills', 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    const reviewed = data<{ digest: string; trust: string }>(await f.executor.confirm(invocation(), proposal.confirmation.token));
    expect(reviewed.trust).toBe('untrusted');
    expect(data<{ skills: unknown[] }>(await f.human('ai.skills.list', {})).skills).toEqual([]);
    f.snapshot.settings.skills = [{ id: input.id, enabled: true, digest: reviewed.digest, tools: input.tools, scopes: input.scopes }]; f.snapshot.revision++;
    const loaded = data<{ approvedTools: string[]; declaredTools: string[] }>(await f.executor.execute(invocation({ source: 'ai' }), 'ai.skills.load', { id: input.id }));
    expect(loaded.approvedTools).toEqual(['rate.convert']); expect(loaded.declaredTools).toEqual(['admin.grant']);
    expect(await f.executor.execute(invocation({ source: 'ai', actorId: 2, chat: { id: 2, type: 'private' } }), 'ai.skills.load', { id: input.id })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    await writeFile(join(f.directory, 'skills', reviewed.digest, input.id, 'SKILL.md'), 'changed');
    expect(await f.human('ai.skills.load', { id: input.id })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  });

  it('preserves corrupt catalog bytes instead of resetting or publishing', async () => {
    const f = await fixture();
    const input = { id: 'one', files: [{ path: 'SKILL.md', text: '---\nname: one\ndescription: One\n---\none' }], tools: [], scopes: [scope] };
    data(await f.human('ai.skills.install', input));
    const path = join(f.directory, 'skills', 'catalog.json');
    await writeFile(path, '{bad');
    expect(await f.human('ai.skills.install', { ...input, tools: ['rate.convert'] })).toMatchObject({ status: 'failed', error: { code: 'UNAVAILABLE' } });
    expect(await readFile(path, 'utf8')).toBe('{bad');
  });

  it('bounds persisted reservations and never clears an existing installer lock', async () => {
    const f = await fixture();
    const input = { id: 'one', files: [{ path: 'SKILL.md', text: '---\nname: one\ndescription: One\n---\none' }], tools: [], scopes: [scope] };
    data(await f.human('ai.skills.install', input));
    const path = join(f.directory, 'skills', 'catalog.json');
    const full = JSON.stringify({ version: 1, entries: Array.from({ length: 64 }, (_, index) => ({ id: `item-${index}`, digest: String(index).padStart(64, '0'), bytes: 65536, state: 'pending' })) });
    await writeFile(path, full);
    expect(await f.human('ai.skills.install', input)).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(await readFile(path, 'utf8')).toBe(full);
    const lock = join(f.directory, 'skills', 'install.lock');
    await writeFile(lock, 'another-writer');
    expect(await f.human('ai.skills.install', input)).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(await readFile(lock, 'utf8')).toBe('another-writer');
  });

  it('uses actual pinned DNS/TLS transport and never elevates MCP annotations to read authority', async () => {
    const f = await fixture(); await f.approveMcp();
    const context = invocation({ source: 'ai', aiRunId: 'run1', aiGrantId: 'grant1', aiSettingsRevision: f.snapshot.revision });
    expect(await f.executor.execute(context, 'ai.mcp.read', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.request).not.toHaveBeenCalled();
    const proposal = await f.executor.execute(f.agent(), 'ai.mcp.call', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } });
    expect(proposal.status).toBe('pending_confirmation'); expect(f.request).not.toHaveBeenCalled();
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    data(await f.executor.confirm(invocation(), proposal.confirmation.token));
    expect(f.lookup).toHaveBeenCalled();
    expect(f.request.mock.calls.every(([, request]) => request.addresses[0]?.address === '8.8.8.8')).toBe(true);
    expect(f.request.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${f.secret}`);
    expect(f.authorize.mock.calls.some(([context]) => context.source === 'ai')).toBe(true);
  });

  it('requires new publication when tool discovery changes and refuses scope/identity fields', async () => {
    const f = await fixture(); await f.approveMcp(); f.changeTool();
    expect(await f.human('ai.mcp.call', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.request.mock.calls.some(([, request]) => request.body.length && JSON.parse(request.body.toString()).method === 'tools/call')).toBe(false);
    expect(await f.human('ai.mcp.list', { profileId: 'reviewed', scope })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(await f.executor.execute(invocation({ botId: 54321 }), 'ai.mcp.list', { profileId: 'reviewed' })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(await f.executor.execute(invocation({ chat: { id: 1, type: 'private', threadId: 2 } }), 'ai.mcp.list', { profileId: 'reviewed' })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
  });

  it('redacts upstream echoed credentials and binds opaque references before any read', async () => {
    const f = await fixture(); await f.approveMcp();
    f.setResult({ content: [{ type: 'text', text: `value ${f.secret}` }, { type: 'resource_link', uri: 'private://secret-resource' }] });
    const result = data<{ content: ({ text?: string; reference?: string })[] }>(await f.human('ai.mcp.call', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } }));
    expect(JSON.stringify(result)).not.toContain(f.secret); expect(JSON.stringify(result)).not.toContain('secret-resource');
    f.request.mockClear();
    expect(await f.executor.execute(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), 'ai.mcp.resource', { profileId: 'reviewed', reference: result.content[1]!.reference })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('rechecks revocation after approval and sends nothing under a revoked grant', async () => {
    const f = await fixture(); await f.approveMcp();
    const proposal = await f.executor.execute(f.agent(), 'ai.mcp.call', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } });
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    f.revoke();
    expect(await f.executor.confirm(invocation(), proposal.confirmation.token)).toMatchObject({ status: 'rejected' });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('binds mutating approvals to the original agent settings revision and rejects plain human runtime calls', async () => {
    const f = await fixture(); await f.approveSandbox();
    const input = { profileId: 'remote', language: 'javascript', code: '1', files: [] };
    expect(await f.executor.execute(invocation(), 'ai.sandbox.execute', input)).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
    const proposal = await f.executor.execute(f.agent(), 'ai.sandbox.execute', input);
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    f.snapshot.revision++;
    expect(await f.executor.confirm(invocation(), proposal.confirmation.token)).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.readOwned).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
  });

  it('lists only scoped extension IDs, never endpoint credentials or another owner profile', async () => {
    const f = await fixture(); await f.approveMcp(); await f.approveSandbox();
    const listed = data<{ mcp: { id: string }[]; sandbox: { id: string }[] }>(await f.executor.execute(f.agent(), 'ai.extensions.list', {}));
    expect(listed.mcp.map(item => item.id)).toEqual(['reviewed']); expect(listed.sandbox.map(item => item.id)).toEqual(['remote']);
    expect(JSON.stringify(listed)).not.toContain('vault:'); expect(JSON.stringify(listed)).not.toContain('https:');
    const foreign = data<{ mcp: unknown[]; sandbox: unknown[] }>(await f.executor.execute(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), 'ai.extensions.list', {}));
    expect(foreign.mcp).toEqual([]); expect(foreign.sandbox).toEqual([]);
  });

  it('mints transfer grants only after approval, uses owned file refs and delivers outputs privately', async () => {
    const f = await fixture(); await f.approveSandbox();
    const input = { profileId: 'remote', language: 'javascript', code: 'console.log(1)', files: ['owned-file'] };
    const proposal = await f.executor.execute(f.agent(), 'ai.sandbox.execute', input);
    expect(proposal.status).toBe('pending_confirmation'); expect(f.readOwned).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled();
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    const receipt = data<{ stdout: string; delivered: number }>(await f.executor.confirm(invocation(), proposal.confirmation.token));
    expect(receipt.stdout).toBe('done [redacted]'); expect(receipt.delivered).toBe(1);
    expect(f.deliver).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(f.request.mock.calls[0]![1].body.toString());
    expect(sent.request.files.map((file: { path: string }) => file.path)).toEqual(['main.js', 'inputs/0.bin']);
    expect(sent.request).not.toHaveProperty('scope'); expect(sent.request).not.toHaveProperty('credential');
    expect(JSON.stringify(receipt)).not.toContain('contentBase64');
    expect(await f.human('ai.sandbox.execute', { ...input, approved: true })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
  });

  it('rejects foreign artifacts and revocation during download before transmitting code', async () => {
    const f = await fixture(); await f.approveSandbox();
    f.readOwned.mockResolvedValueOnce({ scope: { ...scope, ownerId: 2, audience: { kind: 'private', userId: 2 } }, bytes: Buffer.from('private'), name: 'x' });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['foreign'] })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.request).not.toHaveBeenCalled();
    f.readOwned.mockImplementationOnce(async () => { f.revoke(); return { scope, bytes: Buffer.from('owned'), name: 'x' }; });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['owned'] })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.request).not.toHaveBeenCalled();
  });

  it('preserves unknown remote outcomes and actually issues cancelAndWait, never retrying execute', async () => {
    const f = await fixture(); await f.approveSandbox();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, input) => JSON.parse(input.body.toString()).operation === 'execute' ? response({ state: 'running' }) : original(url, input));
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: [] })).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.request.mock.calls.map(([, request]) => JSON.parse(request.body.toString()).operation)).toEqual(['execute', 'cancelAndWait']);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('rejects private DNS targets and credential-bearing redirects through real transport policy', async () => {
    const f = await fixture();
    f.lookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    expect(await f.human('ai.mcp.discover', { profile: mcpSetting() })).toMatchObject({ status: 'failed' });
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockResolvedValueOnce(response(null, 302, { location: 'https://other.example/steal' }));
    expect(await f.human('ai.mcp.discover', { profile: mcpSetting() })).toMatchObject({ status: 'failed' });
    expect(f.request).toHaveBeenCalledTimes(1);
  });

  it('supports explicitly reviewed read-safe tools over bounded HTTP SSE', async () => {
    const f = await fixture();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, input) => {
      const result = await original(url, input);
      if (input.method === 'DELETE' || result.status === 202) return result;
      const chunks: Buffer[] = [];
      for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
      return { status: result.status, headers: { ...result.headers, 'content-type': 'text/event-stream' },
        body: Readable.from([Buffer.from(`data: ${Buffer.concat(chunks).toString()}\n\n`)]) };
    });
    await f.approveMcp({ ...mcpSetting(), readTools: ['lookup'] });
    data(await f.executor.execute(invocation({ source: 'ai' }), 'ai.mcp.read', { profileId: 'reviewed', tool: 'lookup', arguments: { query: 'x' } }));
    f.snapshot.settings.mcp![0]!.readTools = [];
    expect(await f.human('ai.mcp.list', { profileId: 'reviewed' })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
  });

  it('rejects unsafe installation paths and symlink roots without writing outside skills', async () => {
    const f = await fixture();
    const input = { id: 'one', files: [{ path: '../outside', text: 'unsafe' }], tools: [], scopes: [scope] };
    expect(await f.human('ai.skills.install', input)).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    await mkdir(join(f.directory, 'outside'));
    await writeFile(join(f.directory, 'outside', 'sentinel'), 'unchanged');
    await symlink(join(f.directory, 'outside'), join(f.directory, 'skills'));
    expect(await f.human('ai.skills.install', { ...input, files: [{ path: 'SKILL.md', text: '---\nname: one\ndescription: one\n---\none' }] })).toMatchObject({ status: 'failed' });
    expect(await readFile(join(f.directory, 'outside', 'sentinel'), 'utf8')).toBe('unchanged');
    await expect(readFile(join(f.directory, 'outside', 'catalog.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects oversized owner files before sending code and credential echoes in exported artifacts', async () => {
    const f = await fixture(); await f.approveSandbox();
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(1024 * 1024 + 1), name: 'large' });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['large'] })).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(f.request).not.toHaveBeenCalled();
    f.request.mockImplementation(async (_url, input) => response({ version: 1, requestId: JSON.parse(input.body.toString()).requestId, state: 'reaped',
      result: { exitCode: 0, stdout: '', stderr: '', files: [{ path: 'secret.txt', contentBase64: Buffer.from(f.secret).toString('base64') }] } }));
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: [] })).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('stop aborts real response I/O and awaits both transport destruction and remote cancel-and-wait', async () => {
    const f = await fixture(); await f.approveSandbox();
    let started!: () => void; let destroyed!: () => void; let cancelStarted!: () => void;
    let finishDestroy!: () => void; let releaseCancel!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const destroying = new Promise<void>(resolve => { destroyed = resolve; });
    const cancelling = new Promise<void>(resolve => { cancelStarted = resolve; });
    const cancelGate = new Promise<void>(resolve => { releaseCancel = resolve; });
    const stream = new Readable({ read() { started(); }, destroy(error, callback) { destroyed(); finishDestroy = () => callback(error); } });
    f.request.mockImplementation(async (_url, input) => {
      const body = JSON.parse(input.body.toString());
      if (body.operation === 'execute') return { status: 200, headers: { 'content-type': 'application/json' }, body: stream };
      cancelStarted(); await cancelGate; return response({ version: 1, requestId: body.requestId, state: 'reaped' });
    });
    const run = f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: [] });
    await entered;
    let stopped = false;
    const stop = f.bridge.stop().then(() => { stopped = true; });
    await destroying; expect(stopped).toBe(false);
    finishDestroy(); await cancelling; expect(stopped).toBe(false);
    releaseCancel(); await stop;
    expect(await run).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.request.mock.calls.map(([, request]) => JSON.parse(request.body.toString()).operation)).toEqual(['execute', 'cancelAndWait']);
    expect(f.deliver).not.toHaveBeenCalled();
  });

  it('transfers exactly 1 MiB of owned data through the actual pinned raw JSON path', async () => {
    const f = await fixture();
    const setting = sandboxSetting(); setting.limits = { ...setting.limits, memoryBytes: 512 * 1024 * 1024, tempBytes: 4 * 1024 * 1024 };
    await f.approveSandbox(setting);
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(1024 * 1024, 7), name: 'photo.png' });
    const result = data<{ stdout: string }>(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['photo'] }));
    expect(result.stdout).toBe('done [redacted]');
    expect(f.request).toHaveBeenCalledTimes(1);
    const upload = f.request.mock.calls[0]![1];
    expect(upload.body.byteLength).toBeGreaterThan(1024 * 1024);
    expect(upload.body.byteLength).toBeLessThanOrEqual(1536 * 1024);
    expect(upload.headers['content-length']).toBe(String(upload.body.byteLength));
    expect(upload.headers['content-type']).toBe('application/json');
    expect(upload.addresses).toEqual([{ address: '8.8.8.8', family: 4 }]);
    const packet = JSON.parse(upload.body.toString());
    expect(packet.request.limits.memoryBytes).toBe(512 * 1024 * 1024);
    expect(Buffer.from(packet.request.files[1].contentBase64, 'base64')).toEqual(Buffer.alloc(1024 * 1024, 7));
    expect(packet.request.files[1].path).toBe('inputs/0.bin');
    f.request.mockClear(); f.credential.mockClear();
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(1024 * 1024 + 1), name: 'over' });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['over'] })).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(f.request).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled();
  });

  it('reads files sequentially and rejects aggregate or mixed-scope inputs before any transfer', async () => {
    const f = await fixture(); const setting = sandboxSetting(); setting.limits.tempBytes = 4 * 1024 * 1024; await f.approveSandbox(setting);
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.readOwned.mockImplementationOnce(async () => { entered(); await gate; return { scope, bytes: Buffer.alloc(512 * 1024), name: 'first' }; });
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(512 * 1024 + 1), name: 'second' });
    const run = f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['first', 'second'] });
    await started; expect(f.readOwned).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
    release(); expect(await run).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(f.readOwned).toHaveBeenCalledTimes(2); expect(f.request).not.toHaveBeenCalled();
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(512 * 1024), name: 'owned' });
    f.readOwned.mockResolvedValueOnce({ scope: { ...scope, audience: { kind: 'group', chatId: -1 } }, bytes: Buffer.alloc(512 * 1024), name: 'foreign' });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['owned', 'foreign'] })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.request).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled();
  });

  it('aborts a large in-flight upload and sends only small cancelAndWait control data', async () => {
    const f = await fixture(); const setting = sandboxSetting(); setting.limits.tempBytes = 4 * 1024 * 1024; await f.approveSandbox(setting);
    f.readOwned.mockResolvedValueOnce({ scope, bytes: Buffer.alloc(1024 * 1024), name: 'photo' });
    let entered!: () => void; let cancelling!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const cancelStarted = new Promise<void>(resolve => { cancelling = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.request.mockImplementation(async (_url, input) => {
      const packet = JSON.parse(input.body.toString());
      if (packet.operation === 'execute') {
        expect(input.body.byteLength).toBeGreaterThan(1024 * 1024); entered();
        await new Promise<void>((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
      }
      expect(packet.operation).toBe('cancelAndWait');
      expect(Object.keys(packet).sort()).toEqual(['operation', 'requestId', 'version']);
      expect(input.body.byteLength).toBeLessThan(32768); expect(input.signal.aborted).toBe(false);
      cancelling(); await gate; return response({ version: 1, requestId: packet.requestId, state: 'reaped' });
    });
    const run = f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: ['photo'] });
    await started; let stopped = false; const stop = f.bridge.stop().then(() => { stopped = true; });
    await cancelStarted; expect(stopped).toBe(false); release(); await stop;
    expect(await run).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.request).toHaveBeenCalledTimes(2); expect(f.deliver).not.toHaveBeenCalled();
  });

  it.each(['artifact', 'json'])('preserves unknown outcome for oversized remote %s output without exposing it', async kind => {
    const f = await fixture(); const setting = sandboxSetting(); setting.limits.outputBytes = 65536; await f.approveSandbox(setting);
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async (url, input) => {
      const packet = JSON.parse(input.body.toString());
      if (packet.operation === 'cancelAndWait') return original(url, input);
      return response({ version: 1, requestId: packet.requestId, state: 'reaped', result: { exitCode: 0,
        stdout: kind === 'json' ? 'x'.repeat(128 * 1024 + 1) : '', stderr: '',
        files: kind === 'artifact' ? [{ path: 'too-large.png', contentBase64: Buffer.alloc(65537).toString('base64') }] : [] } });
    });
    expect(await f.human('ai.sandbox.execute', { profileId: 'remote', language: 'javascript', code: '1', files: [] })).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.request).toHaveBeenCalledTimes(2); expect(f.deliver).not.toHaveBeenCalled();
  });
});
