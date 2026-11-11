import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { aiDefaults, type AiSettingsSnapshot } from '../shared/schemas/ai.js';
import { aiLocalSandboxProfileSchema, aiStdioMcpProfileSchema, type AiExtensionScope, type AiLocalSandboxProfile, type AiStdioMcpProfile } from '../shared/schemas/ai-extensions.js';
import type { ActionResult } from '../shared/schemas/index.js';
import { createAgentExtensions } from '../src/ai/extensions.js';
import { LOCAL_SANDBOX_POLICY_SHA256, LocalSandbox, LocalSandboxError, type LocalSandboxQualification, type LocalStdioPort } from '../src/ai/local-sandbox.js';
import type { SandboxFile, SandboxRequest } from '../src/ai/sandbox.js';
import { ResourcePolicy } from '../src/resources.js';
import { AppError } from '../src/errors.js';
import { coreFixture, invocation } from './support/core.js';

const scope: AiExtensionScope = { botId: 12345, ownerId: 1, audience: { kind: 'private', userId: 1 } };
const limits = { memoryBytes: 32 * 1024 * 1024, cpuMs: 1000, pids: 4, outputBytes: 4096, tempBytes: 65536, wallMs: 1000 };
const localProfile = (): AiLocalSandboxProfile => ({ id: 'local', enabled: false, scope, runtime: 'node', limits });
const report = (qualified = false): LocalSandboxQualification => ({ qualified, localEnabled: qualified, policyHash: LOCAL_SANDBOX_POLICY_SHA256,
  namespaces: qualified ? 'passed' : 'not-tested', cgroup: qualified ? 'passed' : 'failed', seccomp: qualified ? 'passed' : 'unqualified',
  reasons: qualified ? [] : [{ code: 'CGROUP_DELEGATION_FAILED', detail: 'Delegation unavailable (EACCES).' }] });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
function data<T>(result: ActionResult<unknown>): T {
  expect(result.status, JSON.stringify(result)).toBe('succeeded');
  if (result.status !== 'succeeded') throw new Error('Action failed');
  return result.data as T;
}
function free(resources: ResourcePolicy): void {
  const lease = resources.tryAcquire('heavy', 64 * 1024 * 1024);
  expect(lease).toBeDefined(); lease?.release();
}

async function fixture() {
  const core = await coreFixture({ services: { aiEnabled: true } });
  const resources = new ResourcePolicy({ heavyBytes: 64 * 1024 * 1024 });
  const snapshot: AiSettingsSnapshot = { revision: 1, settings: { ...aiDefaults(), enabled: true, sandbox: { enabled: true, profiles: [] } } };
  let permitted = true;
  core.services.aiPolicy = { available: () => permitted, authorize: () => { if (!permitted) throw new AppError('FORBIDDEN'); } };
  const authorize = vi.fn(() => { if (!permitted) throw new AppError('FORBIDDEN'); });
  const probe = vi.spyOn(LocalSandbox.prototype, 'probe').mockResolvedValue(report());
  const execute = vi.spyOn(LocalSandbox.prototype, 'execute').mockResolvedValue({ exitCode: 0, stdout: 'local result', stderr: '', files: [] });
  let description = 'Reviewed tool';
  let toolResult: unknown = { content: [{ type: 'text', text: 'stdio result' }] };
  const rpc = vi.fn(async (raw: unknown) => {
    const request = raw as { id: number; method: string };
    return { jsonrpc: '2.0', id: request.id, result: request.method === 'initialize'
      ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixed-bundle', version: '1' } }
      : request.method === 'tools/list' ? { tools: [{ name: 'lookup', description, inputSchema: { type: 'object', properties: { query: { type: 'string' } }, additionalProperties: false }, annotations: { readOnlyHint: true } }] }
        : request.method === 'resources/read' ? { contents: [{ uri: 'file:///never-read-on-host', text: 'scoped resource' }] } : toolResult };
  });
  const notify = vi.fn(async (_message: unknown) => {});
  async function exchange<T>(_request: SandboxRequest, _inputs: readonly SandboxFile[], signal: AbortSignal, callback: (port: LocalStdioPort) => Promise<T>): Promise<T> {
    return callback({ request: rpc, notify, signal });
  }
  const withStdio = vi.spyOn(LocalSandbox.prototype, 'withStdio').mockImplementation(exchange);
  const credential = vi.fn(() => 'synthetic-never-used');
  const networkRequest = vi.fn(async () => { throw new Error('NO_NETWORK_EXPECTED'); });
  const lookup = vi.fn(async () => { throw new Error('NO_DNS_EXPECTED'); });
  const readOwned = vi.fn(async () => ({ scope, bytes: Buffer.from('owned input'), name: 'owner.txt' }));
  const deliver = vi.fn(async () => {});
  const bridge = createAgentExtensions({ dataDir: core.directory, settings: () => snapshot, credential, authorize,
    readFile: readOwned, deliver, resources, network: { lookup, request: networkRequest } });
  bridge.register(core.executor);
  cleanups.push(async () => { await bridge.stop(); await core.close(); });
  const agent = () => invocation({ source: 'ai', aiRunId: 'run1', aiGrantId: 'grant1', aiSettingsRevision: snapshot.revision });
  async function approved(id: string, input: unknown) {
    const caller = ['ai.sandbox.local.execute', 'ai.mcp.stdio.call'].includes(id) ? agent() : invocation();
    const proposed = await core.executor.execute(caller, id, input);
    return proposed.status === 'pending_confirmation' ? core.executor.confirm(invocation(), proposed.confirmation.token) : proposed;
  }
  async function enableLocal() {
    const profile = localProfile();
    const pin = data<{ digest: string }>(await approved('ai.sandbox.local.review', { profile }));
    snapshot.settings.sandbox!.localProfiles = [{ ...profile, enabled: true, reviewedDigest: pin.digest }]; snapshot.revision++;
  }
  async function bundle(): Promise<AiStdioMcpProfile> {
    const installed = data<{ digest: string }>(await approved('ai.skills.install', { id: 'stdio-bundle', tools: [], scopes: [scope], files: [
      { path: 'SKILL.md', text: '---\nname: stdio-bundle\ndescription: Explicit reviewed stdio bundle.\n---\nNo authority.' },
      { path: 'server.mjs', text: '// Reviewed fixture source; never executed by these mocked bridge tests.' },
      { path: 'data.json', text: '{"fixed":"reviewed input"}' },
    ] }));
    return { id: 'stdio', enabled: false, scope, runtime: 'node', limits, tools: ['lookup'], readTools: [],
      bundle: { id: 'stdio-bundle', digest: installed.digest, entrypoint: 'server.mjs', args: ['--format', 'safe'], inputs: ['data.json'] } };
  }
  async function enableStdio(readTools: string[] = []) {
    probe.mockResolvedValue(report(true));
    const profile = { ...await bundle(), readTools };
    const pin = data<{ digest: string }>(await approved('ai.mcp.stdio.discover', { profile }));
    snapshot.settings.sandbox!.stdioProfiles = [{ ...profile, enabled: true, schemaDigest: pin.digest }]; snapshot.revision++;
    probe.mockClear(); withStdio.mockClear(); rpc.mockClear(); notify.mockClear();
    return snapshot.settings.sandbox!.stdioProfiles[0]!;
  }
  return { ...core, resources, snapshot, bridge, probe, execute, withStdio, rpc, notify, credential, networkRequest, lookup, readOwned, deliver,
    agent, approved, enableLocal, bundle, enableStdio, exchange,
    revoke: () => { permitted = false; }, changeTools: () => { description = 'changed'; }, setResult: (value: unknown) => { toolResult = value; } };
}

describe('scoped local settings', () => {
  it('requires explicit scope and digest to enable local execution or stdio', () => {
    expect(aiLocalSandboxProfileSchema.safeParse({ ...localProfile(), enabled: true }).success).toBe(false);
    expect(aiLocalSandboxProfileSchema.safeParse({ ...localProfile(), enabled: true, reviewedDigest: 'a'.repeat(64), scope: undefined }).success).toBe(false);
    expect(aiLocalSandboxProfileSchema.safeParse({ ...localProfile(), runtime: 'python' }).success).toBe(false);
    expect(aiLocalSandboxProfileSchema.safeParse({ ...localProfile(), limits: { ...limits, tempBytes: 4097 } }).success).toBe(false);
  });
  it.each([{ command: '/bin/sh' }, { runner: '/usr/bin/node' }, { qualified: true }, { env: { TOKEN: 'synthetic' } }])('rejects unscoped host configuration %j', extra => {
    expect(aiLocalSandboxProfileSchema.safeParse({ ...localProfile(), ...extra }).success).toBe(false);
    expect(aiStdioMcpProfileSchema.safeParse({ ...localProfile(), ...extra, bundle: { id: 'test', digest: 'a'.repeat(64), entrypoint: 'server.mjs', args: [], inputs: [] }, tools: [], readTools: [] }).success).toBe(false);
  });
});

describe('qualified local execution bridge', () => {
  it('is demand-only and reports implemented but not probed truthfully', async () => {
    const f = await fixture();
    expect(f.bridge.safeStatus()).toMatchObject({ localRunnerImplemented: true, localEnabled: false, localReason: 'LOCAL_NOT_PROBED' });
    expect(f.probe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.withStdio).not.toHaveBeenCalled();
    const result = data(await f.approved('ai.sandbox.local.probe', {}));
    expect(result).toEqual({ localRunnerImplemented: true, localEnabled: false, localReason: 'CGROUP_DELEGATION_FAILED' });
    expect(f.execute).not.toHaveBeenCalled(); free(f.resources);
  });

  it('does not read files, execute code or fall back remotely when unqualified', async () => {
    const f = await fixture(); await f.enableLocal();
    f.snapshot.settings.sandbox!.profiles = [{ id: 'local', enabled: true, endpoint: 'https://remote.example.com/run', allowedOrigins: ['https://remote.example.com'],
      scope, credentialAuthority: 'service', languages: ['javascript'], reviewedDigest: 'a'.repeat(64), limits }];
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: ['owned'] })).toMatchObject({ status: 'failed', error: { code: 'UNAVAILABLE' } });
    expect(f.probe).toHaveBeenCalledTimes(1); expect(f.execute).not.toHaveBeenCalled(); expect(f.readOwned).not.toHaveBeenCalled();
    expect(f.networkRequest).not.toHaveBeenCalled(); expect(f.lookup).not.toHaveBeenCalled(); expect(f.credential).not.toHaveBeenCalled(); free(f.resources);
  });

  it('acquires heavy admission before probing and never overrides existing heavy work', async () => {
    const f = await fixture(); await f.enableLocal();
    const lease = f.resources.tryAcquire('heavy', 64 * 1024 * 1024)!;
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: [] })).toMatchObject({ status: 'failed', error: { code: 'CAPACITY' } });
    expect(f.probe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); lease.release();
  });

  it('holds admission during the real probe promise, including cancellation', async () => {
    const f = await fixture();
    let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.probe.mockImplementation(async () => { entered(); await gate; return report(true); });
    const probing = f.approved('ai.sandbox.local.probe', {});
    await started;
    const stop = f.bridge.stop();
    expect(f.resources.tryAcquire('heavy', 1)).toBeUndefined();
    release(); await stop;
    expect(await probing).toMatchObject({ status: 'failed' }); free(f.resources);
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('requires approval, scoped owned bytes and a fresh reviewed profile for local scripts', async () => {
    const f = await fixture(); await f.enableLocal(); f.probe.mockResolvedValue(report(true));
    const input = { profileId: 'local', language: 'javascript', code: 'console.log(1)', files: ['owned'] };
    const proposal = await f.executor.execute(f.agent(), 'ai.sandbox.local.execute', input);
    expect(proposal.status).toBe('pending_confirmation'); expect(f.probe).not.toHaveBeenCalled();
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    f.execute.mockImplementation(async (request) => {
      expect(f.resources.tryAcquire('heavy', 1)).toBeUndefined();
      expect(request).toMatchObject({ runtime: 'node', entrypoint: 'main.mjs', args: [], network: 'deny' });
      expect(request.files.map(file => file.path)).toEqual(['main.mjs', 'inputs/0.bin']);
      return { exitCode: 0, stdout: 'ok', stderr: '', files: [{ path: 'result.txt', contentBase64: Buffer.from('owned').toString('base64') }] };
    });
    expect(data<{ delivered: number }>(await f.executor.confirm(invocation(), proposal.confirmation.token)).delivered).toBe(1);
    expect(f.deliver).toHaveBeenCalledTimes(1); free(f.resources);
    f.snapshot.settings.sandbox!.localProfiles![0]!.limits = { ...limits, cpuMs: 2000 };
    expect(await f.approved('ai.sandbox.local.execute', input)).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rechecks revoked grants and changed local policy after asynchronous qualification', async () => {
    const f = await fixture(); await f.enableLocal();
    f.probe.mockImplementationOnce(async () => {
      f.snapshot.settings.sandbox!.localProfiles![0]!.limits = { ...limits, pids: 5 };
      return report(true);
    });
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: ['owned'] })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.execute).not.toHaveBeenCalled(); expect(f.readOwned).not.toHaveBeenCalled(); free(f.resources);
    f.snapshot.settings.sandbox!.localProfiles![0]!.limits = limits;
    f.probe.mockImplementationOnce(async () => { f.revoke(); return report(true); });
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: ['owned'] })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.execute).not.toHaveBeenCalled(); free(f.resources);
  });

  it('refuses foreign owned files and audience changes before code execution', async () => {
    const f = await fixture(); await f.enableLocal(); f.probe.mockResolvedValue(report(true));
    f.readOwned.mockResolvedValueOnce({ scope: { ...scope, ownerId: 2, audience: { kind: 'private', userId: 2 } }, bytes: Buffer.from('foreign'), name: 'x' });
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: ['foreign'] })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.execute).not.toHaveBeenCalled(); free(f.resources);
    const caller = invocation({ source: 'ai', actorId: 2, chat: { id: 2, type: 'private' }, aiRunId: 'run2', aiGrantId: 'grant2', aiSettingsRevision: f.snapshot.revision });
    const proposal = await f.executor.execute(caller, 'ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: [] });
    if (proposal.status !== 'pending_confirmation') throw new Error('No approval');
    f.probe.mockClear();
    expect(await f.executor.confirm(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), proposal.confirmation.token)).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.probe).not.toHaveBeenCalled(); expect(f.networkRequest).not.toHaveBeenCalled();
  });

  it.each([{ env: { HOME: '/' } }, { entrypoint: '/bin/sh' }, { args: ['-c', 'id'] }, { qualified: true }, { scope }])('model cannot supply local authority or host parameters %j', async extra => {
    const f = await fixture(); await f.enableLocal();
    expect(await f.executor.execute(f.agent(), 'ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: [], ...extra })).toMatchObject({ status: 'rejected', error: { code: 'INVALID_INPUT' } });
    expect(f.probe).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled();
  });

  it('holds the heavy lease until aborted execution has actually reaped', async () => {
    const f = await fixture(); await f.enableLocal(); f.probe.mockResolvedValue(report(true));
    let entered!: () => void; let release!: () => void; let aborted!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const cancelling = new Promise<void>(resolve => { aborted = resolve; });
    f.execute.mockImplementation(async (_request, _files, signal) => {
      entered(); await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted(); resolve(); }, { once: true }));
      await gate; throw new LocalSandboxError('LOCAL_CANCELLED', 'ABORTED');
    });
    const run = f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: [] });
    await started; const stop = f.bridge.stop(); await cancelling;
    expect(f.resources.tryAcquire('heavy', 1)).toBeUndefined();
    release(); await stop; expect(await run).toMatchObject({ status: 'failed', error: { code: 'CANCELLED' } }); free(f.resources);
  });

  it('keeps heavy admission poisoned when native whole-tree drain cannot be verified', async () => {
    const f = await fixture(); await f.enableLocal(); f.probe.mockResolvedValue(report(true));
    f.execute.mockRejectedValue(new LocalSandboxError('LOCAL_OUTCOME_UNKNOWN', 'SUPERVISOR_DRAIN_RECEIPT_MISSING'));
    expect(await f.approved('ai.sandbox.local.execute', { profileId: 'local', language: 'javascript', code: '1', files: [] })).toMatchObject({ status: 'failed', error: { code: 'OUTCOME_UNKNOWN' } });
    expect(f.resources.tryAcquire('heavy', 1)).toBeUndefined();
    expect(f.bridge.safeStatus()).toMatchObject({ localEnabled: false, localReason: 'SUPERVISOR_DRAIN_RECEIPT_MISSING' });
    expect(f.networkRequest).not.toHaveBeenCalled();
  });
});

describe('reviewed stdio MCP bridge', () => {
  it('never starts a bundle when qualification fails', async () => {
    const f = await fixture(); const profile = await f.bundle();
    expect(await f.approved('ai.mcp.stdio.discover', { profile })).toMatchObject({ status: 'failed', error: { code: 'UNAVAILABLE' } });
    expect(f.withStdio).not.toHaveBeenCalled(); expect(f.execute).not.toHaveBeenCalled(); expect(f.networkRequest).not.toHaveBeenCalled(); free(f.resources);
  });

  it('runs bounded initialize/list/call exchanges with only reviewed files and fixed argv', async () => {
    const f = await fixture(); await f.enableStdio();
    const result = data<{ content: { text: string }[] }>(await f.approved('ai.mcp.stdio.call', { profileId: 'stdio', tool: 'lookup', arguments: { query: 'x' } }));
    expect(result.content[0]!.text).toBe('stdio result');
    expect(f.withStdio).toHaveBeenCalledTimes(1);
    const request = f.withStdio.mock.calls[0]![0];
    expect(request).toMatchObject({ runtime: 'node', entrypoint: 'server.mjs', args: ['--format', 'safe'], network: 'deny', limits });
    expect(request.files.map(file => file.path)).toEqual(['server.mjs', 'data.json']);
    expect(f.rpc.mock.calls.map(([message]) => (message as { method: string }).method)).toEqual(['initialize', 'tools/list', 'tools/call']);
    expect(f.notify).toHaveBeenCalledWith({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(f.credential).not.toHaveBeenCalled(); expect(f.networkRequest).not.toHaveBeenCalled(); free(f.resources);
  });

  it('requires reapproval on schema change and ignores upstream read-only annotations', async () => {
    const f = await fixture(); await f.enableStdio();
    expect(await f.executor.execute(f.agent(), 'ai.mcp.stdio.read', { profileId: 'stdio', tool: 'lookup', arguments: {} })).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.probe).not.toHaveBeenCalled();
    f.changeTools();
    expect(await f.approved('ai.mcp.stdio.call', { profileId: 'stdio', tool: 'lookup', arguments: {} })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.rpc.mock.calls.some(([message]) => (message as { method: string }).method === 'tools/call')).toBe(false); free(f.resources);
  });

  it('rejects modified reviewed bundle bytes before starting its process', async () => {
    const f = await fixture(); const profile = await f.enableStdio();
    await writeFile(join(f.directory, 'skills', profile.bundle.digest, profile.bundle.id, 'server.mjs'), 'unreviewed source');
    expect(await f.executor.execute(f.agent(), 'ai.mcp.stdio.list', { profileId: 'stdio' })).toMatchObject({ status: 'failed', error: { code: 'CONFLICT' } });
    expect(f.withStdio).not.toHaveBeenCalled(); free(f.resources);
  });

  it('keeps resources opaque and scoped, with no host file or HTTP dereference', async () => {
    const f = await fixture(); await f.enableStdio(['lookup']);
    f.setResult({ content: [{ type: 'resource_link', uri: 'file:///host-private-never-open' }] });
    const result = data<{ content: { reference: string }[] }>(await f.executor.execute(f.agent(), 'ai.mcp.stdio.read', { profileId: 'stdio', tool: 'lookup', arguments: {} }));
    expect(JSON.stringify(result)).not.toContain('host-private');
    const input = { profileId: 'stdio', reference: result.content[0]!.reference };
    f.probe.mockClear();
    expect(await f.executor.execute(invocation({ actorId: 2, chat: { id: 2, type: 'private' } }), 'ai.mcp.stdio.resource', input)).toMatchObject({ status: 'failed', error: { code: 'FORBIDDEN' } });
    expect(f.probe).not.toHaveBeenCalled();
    const read = data<{ content: { text: string }[] }>(await f.executor.execute(f.agent(), 'ai.mcp.stdio.resource', input));
    expect(read.content[0]!.text).toBe('scoped resource'); expect(f.networkRequest).not.toHaveBeenCalled(); free(f.resources);
  });

  it('holds admission until the stdio session teardown actually completes', async () => {
    const f = await fixture(); await f.enableStdio();
    let completed!: () => void; let release!: () => void;
    const exchanged = new Promise<void>(resolve => { completed = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    f.withStdio.mockImplementation(async function <T>(request: SandboxRequest, files: readonly SandboxFile[], signal: AbortSignal, exchange: (port: LocalStdioPort) => Promise<T>) {
      const result = await f.exchange(request, files, signal, exchange); completed(); await gate; return result;
    });
    const call = f.approved('ai.mcp.stdio.call', { profileId: 'stdio', tool: 'lookup', arguments: {} });
    await exchanged; expect(f.resources.tryAcquire('heavy', 1)).toBeUndefined();
    release(); data(await call); free(f.resources);
  });
});
