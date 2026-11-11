import { describe, expect, it, vi } from 'vitest';
import { McpService, type ExtensionHttpRequest, type ExtensionHttpResponse, type ReviewedMcpProfile } from '../src/ai/mcp.js';

const scope = { ownerId: 'user:1', audience: 'private:1' };
const signal = () => new AbortController().signal;
function fixture() {
  let profiles: ReviewedMcpProfile[] = [{ id: 'reviewed', enabled: true, transport: 'http', url: 'https://mcp.example/mcp', approvedOrigin: 'https://mcp.example',
    credentialRef: 'user1-key', scope, approvedTools: ['lookup'] }];
  let tools: Record<string, unknown>[] = [{ name: 'lookup', description: 'A reviewed tool', inputSchema: { type: 'object', properties: { query: { type: 'string', maxLength: 20 } }, required: ['query'], additionalProperties: false }, annotations: { readOnlyHint: true } }];
  let result: unknown = { content: [{ type: 'text', text: 'result' }] };
  let now = 10;
  const transport = vi.fn(async (request: ExtensionHttpRequest): Promise<ExtensionHttpResponse> => {
    if (request.method === 'DELETE') return { status: 204, headers: {}, body: undefined };
    const rpc = JSON.parse(request.body!) as { id?: number; method: string };
    if (!rpc.id) return { status: 202, headers: {}, body: undefined };
    return { status: 200, headers: rpc.method === 'initialize' ? { 'mcp-session-id': 'opaque-session' } : {}, body: { jsonrpc: '2.0', id: rpc.id,
      result: rpc.method === 'initialize' ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }
        : rpc.method === 'tools/list' ? { tools } : rpc.method === 'resources/read' ? { contents: [{ uri: 'private://sensitive?token=not-a-real-secret', text: 'owned content' }] } : result } };
  });
  const service = new McpService({ profiles: () => profiles, transport, now: () => now });
  const approve = async () => { profiles[0]!.reviewedDigest = (await service.discover('reviewed', scope, signal())).digest; transport.mockClear(); };
  return { service, transport, approve, profile: profiles[0]!, setProfiles: (value: ReviewedMcpProfile[]) => { profiles = value; },
    tools, setTools: (value: Record<string, unknown>[]) => { tools = value; }, setResult: (value: unknown) => { result = value; }, advance: () => { now += 900_001; } };
}
const methods = (f: ReturnType<typeof fixture>) => f.transport.mock.calls.map(([request]) => request.method === 'DELETE' ? 'DELETE' : JSON.parse(request.body!).method);

describe('reviewed MCP discovery and calls', () => {
  it('is lazy, requires publication, pins endpoint/credential scope and tears down each session', async () => {
    const f = fixture();
    expect(f.transport).not.toHaveBeenCalled();
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('REVIEW_REQUIRED');
    expect(f.transport).not.toHaveBeenCalled();
    await f.approve();
    expect(await f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).toEqual({ isError: false, content: [{ type: 'text', text: 'result' }] });
    expect(methods(f)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call', 'DELETE']);
    for (const [request] of f.transport.mock.calls) expect(request).toMatchObject({ url: 'https://mcp.example/mcp', approvedOrigin: 'https://mcp.example', credentialRef: 'user1-key', scope, maxRequestBytes: 32768 });
    expect(f.transport.mock.calls[3]![0].headers).toHaveProperty('mcp-session-id', 'opaque-session');
  });

  it.each(['description', 'schema', 'annotations', 'added', 'removed'])('requires reapproval for changed %s', async (change) => {
    const f = fixture(); await f.approve();
    if (change === 'description') f.tools[0]!.description = 'new';
    if (change === 'schema') f.tools[0]!.inputSchema = { type: 'object' };
    if (change === 'annotations') f.tools[0]!.annotations = { readOnlyHint: false };
    if (change === 'added') f.tools.push({ name: 'other', inputSchema: { type: 'object' } });
    if (change === 'removed') f.setTools([]);
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('REVIEW_REQUIRED');
    expect(methods(f)).not.toContain('tools/call');
    expect(methods(f).at(-1)).toBe('DELETE');
  });

  it('does not let readOnly annotations or unknown tool names bypass the approved catalog', async () => {
    const f = fixture(); f.profile.approvedTools = []; await f.approve();
    expect(await f.service.list('reviewed', scope, signal())).toEqual([]);
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(methods(f)).not.toContain('tools/call');
  });

  it.each([{ ownerId: 'user:2', audience: 'private:1' }, { ownerId: 'user:1', audience: 'group:1' }, { ownerId: 'user:1', audience: 'private:1/topic:1' }])('blocks cross-scope credential use %j', async (foreign) => {
    const f = fixture(); await f.approve();
    await expect(f.service.list('reviewed', foreign, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each(['http://mcp.example/mcp', 'https://elsewhere.example/mcp', 'https://user:pass@mcp.example/mcp', 'https://mcp.example/mcp?key=secret', 'https://mcp.example/mcp#part'])('rejects unpinned or credential-bearing endpoint %s', async (url) => {
    const f = fixture(); f.profile.url = url;
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('INVALID_EXTENSION');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it('does not provide stdio host process fallback', async () => {
    const f = fixture(); Object.assign(f.profile, { transport: 'stdio', command: '/bin/sh' });
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('EXTENSION_UNAVAILABLE');
    expect(f.transport).not.toHaveBeenCalled();
  });

  it.each([{ query: 1 }, { query: 'x', actorId: 'admin' }, {}, { query: 'x'.repeat(21) }, []])('validates arguments without coercion or stripping %j', async (args) => {
    const f = fixture(); await f.approve();
    await expect(f.service.call('reviewed', 'lookup', args, scope, signal())).rejects.toThrow('INVALID_EXTENSION');
    expect(methods(f)).not.toContain('tools/call');
  });

  it.each([{ $ref: 'https://internal/schema' }, { pattern: '(x+)+$' }, { format: 'uri' }, { properties: { x: { $ref: '#/$defs/x' } } }])('rejects executable/unsupported schema shapes %j', async (schema) => {
    const f = fixture(); f.tools[0]!.inputSchema = { type: 'object', ...schema };
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('INVALID_EXTENSION');
  });

  it('bounds the tool count and rejects duplicate tools', async () => {
    const f = fixture(); f.setTools(Array.from({ length: 65 }, (_, index) => ({ name: `tool${index}`, inputSchema: { type: 'object' } })));
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('EXTENSION_LIMIT');
    f.setTools([f.tools[0]!, f.tools[0]!]);
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('INVALID_EXTENSION');
  });

  it('bounds JSON and treats malformed post-execution output as unknown, never replaying', async () => {
    const f = fixture(); await f.approve(); f.setResult({ content: [{ type: 'text', text: 'x'.repeat(262145) }] });
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('OUTCOME_UNKNOWN');
    expect(methods(f).filter((method) => method === 'tools/call')).toHaveLength(1);
  });

  it('validates reviewed output schemas and does not forward extra upstream metadata', async () => {
    const f = fixture(); f.tools[0]!.outputSchema = { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] }; await f.approve();
    f.setResult({ content: [{ type: 'text', text: 'safe' }], structuredContent: { count: 'wrong' }, _meta: { secret: 'not-real' } });
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('OUTCOME_UNKNOWN');
    f.setResult({ content: [{ type: 'text', text: 'safe' }], structuredContent: { count: 1 }, _meta: { secret: 'not-real' } });
    expect(await f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).toEqual({ isError: false, content: [{ type: 'text', text: 'safe' }] });
  });

  it('reauthorizes after asynchronous discovery and before dispatch', async () => {
    const f = fixture(); await f.approve();
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (request) => {
      const response = await original(request);
      if (request.body && JSON.parse(request.body).method === 'tools/list') f.setProfiles([]);
      return response;
    });
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(methods(f)).not.toContain('tools/call');
  });

  it('suppresses results and preserves uncertainty on revocation after dispatch', async () => {
    const f = fixture(); await f.approve();
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (request) => {
      const response = await original(request);
      if (request.body && JSON.parse(request.body).method === 'tools/call') f.setProfiles([]);
      return response;
    });
    await expect(f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal())).rejects.toThrow('OUTCOME_UNKNOWN');
  });

  it('holds admission until real cleanup finishes, even after cancellation', async () => {
    const f = fixture(); await f.approve();
    let release!: () => void;
    let cleaning!: () => void;
    const cleanupStarted = new Promise<void>((resolve) => { cleaning = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const original = f.transport.getMockImplementation()!;
    const controller = new AbortController();
    f.transport.mockImplementation(async (request) => {
      if (request.method === 'DELETE') { cleaning(); await gate; }
      if (request.body && JSON.parse(request.body).method === 'tools/call') controller.abort();
      return original(request);
    });
    const call = f.service.call('reviewed', 'lookup', { query: 'x' }, scope, controller.signal);
    const assertion = expect(call).rejects.toThrow('OUTCOME_UNKNOWN');
    await cleanupStarted;
    await expect(f.service.list('reviewed', scope, signal())).rejects.toThrow('EXTENSION_LIMIT');
    release(); await assertion;
  });

  it('rejects server callbacks and mismatched JSON-RPC IDs without executing anything', async () => {
    const f = fixture();
    f.transport.mockResolvedValue({ status: 200, headers: {}, body: { jsonrpc: '2.0', id: 999, method: 'sampling/createMessage', params: {} } });
    await expect(f.service.discover('reviewed', scope, signal())).rejects.toThrow('INVALID_EXTENSION');
  });
});

describe('opaque MCP resources', () => {
  it('keeps upstream resource URLs out of results and binds references to owner/audience', async () => {
    const f = fixture(); await f.approve();
    f.setResult({ content: [{ type: 'resource_link', uri: 'private://sensitive?token=not-a-real-secret', name: 'do not leak uri', _meta: { hidden: 'x' } }] });
    const result = await f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal());
    expect(JSON.stringify(result)).not.toContain('sensitive');
    const reference = (result.content[0] as { reference: string }).reference;
    expect(reference).toMatch(/^mcp_[a-f0-9]{48}$/);
    f.transport.mockClear();
    await expect(f.service.readResource(reference, { ...scope, ownerId: 'other' }, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
    expect(f.transport).not.toHaveBeenCalled();
    expect(await f.service.readResource(reference, scope, signal())).toEqual({ isError: false, content: [{ type: 'text', text: 'owned content' }] });
    expect(methods(f)).toContain('resources/read');
  });

  it('expires references and invalidates them on profile changes', async () => {
    const f = fixture(); await f.approve();
    f.setResult({ content: [{ type: 'resource', resource: { uri: 'file:///never-open-locally', text: 'private' } }] });
    const result = await f.service.call('reviewed', 'lookup', { query: 'x' }, scope, signal());
    const reference = (result.content[0] as { reference: string }).reference;
    f.profile.credentialRef = 'different';
    await expect(f.service.readResource(reference, scope, signal())).rejects.toThrow('REVIEW_REQUIRED');
    f.advance();
    await expect(f.service.readResource(reference, scope, signal())).rejects.toThrow('EXTENSION_FORBIDDEN');
  });
});
