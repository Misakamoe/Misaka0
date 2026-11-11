import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAiTransport, type AiRequest } from '../src/ai/transport.js';

const input: AiRequest = { origin: 'https://mcp.example.com', path: '/rpc', method: 'POST', mcp: true,
  headers: { 'mcp-protocol-version': '2025-06-18', 'mcp-session-id': 'session-1', accept: 'application/json, text/event-stream' },
  body: { jsonrpc: '2.0', id: 'a', method: 'tools/list' } };
const options = () => ({ signal: new AbortController().signal, limits: { responseBytes: 1024, eventBytes: 512, events: 2 } });

describe('pinned MCP HTTP transport', () => {
  it('accepts controlled MCP headers and one matching split UTF-8 SSE response', async () => {
    const wire = Buffer.from('data: {"jsonrpc":"2.0","id":"a","result":{"text":"\u5fa1\u5742"}}\r\n\r\n');
    const body = Readable.from([wire.subarray(0, 55), wire.subarray(55)]);
    const request = vi.fn(async () => ({ status: 200, headers: { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-2' }, body }));
    const transport = createAiTransport({ lookup: async () => [{ address: '1.1.1.1', family: 4 }], request });
    const result = await transport.request!(input, options());
    expect(result.value).toEqual({ jsonrpc: '2.0', id: 'a', result: { text: '\u5fa1\u5742' } });
    expect(request.mock.calls[0]).toBeDefined();
    expect(body.destroyed).toBe(true);
  });

  it('allows empty 202 only for notifications and never accepts a missing request result', async () => {
    const transport = createAiTransport({ lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      request: async () => ({ status: 202, headers: {}, body: Readable.from([]) }) });
    expect(await transport.request!({ ...input, body: { jsonrpc: '2.0', method: 'notifications/initialized' } }, options())).toMatchObject({ status: 202, value: null });
    await expect(transport.request!(input, options())).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it.each(['data: {"jsonrpc":"2.0","id":"foreign","result":{}}\n\n',
    'data: {"jsonrpc":"2.0","id":"a","result":{}}', 'data: not-json\n\n'])('rejects wrong, partial, or malformed JSON-RPC events', async wire => {
    const transport = createAiTransport({ lookup: async () => [{ address: '1.1.1.1', family: 4 }],
      request: async () => ({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) }) });
    await expect(transport.request!(input, options())).rejects.toThrow();
  });

  it('keeps private DNS, redirects, and arbitrary headers rejected', async () => {
    const request = vi.fn(async () => ({ status: 302, headers: { location: 'https://elsewhere.example' }, body: Readable.from([]) }));
    const privateTransport = createAiTransport({ lookup: async () => [{ address: '127.0.0.1', family: 4 }], request });
    await expect(privateTransport.request!(input, options())).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(request).not.toHaveBeenCalled();
    const transport = createAiTransport({ lookup: async () => [{ address: '1.1.1.1', family: 4 }], request });
    await expect(transport.request!({ ...input, headers: { cookie: 'private' } }, options())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(transport.request!({ ...input, mcp: false }, options())).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await expect(transport.request!(input, options())).rejects.toMatchObject({ code: 'NETWORK', status: 302 });
  });
});
