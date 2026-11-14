import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAiProvider, type GenerationRequest, type NativeContinuation, type PreparedContent, type ProviderProfile, type ProviderProtocol } from '../src/ai/providers.js';
import { createAiTransport, type AiHttpTransport } from '../src/ai/transport.js';

const signal = () => new AbortController().signal;
const scope = 'bot:1:private:3:run:inline-fixture';
const tool = { name: 'lookup', description: 'Read a fixture', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
const image = (): Exclude<PreparedContent, { type: 'text' }> => ({ type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(90_000, 7), filename: 'fixture.png' });
const profile = (protocol: ProviderProtocol): ProviderProfile => ({ protocol, origin: 'https://vision.example.com', basePath: '/gateway/v1',
  model: 'fixture-vision', apiKey: 'TEST_ONLY_VISION_KEY', capabilities: { input: ['text', 'image'], output: ['text'] },
  mediaTokenPolicy: 'bounded', limits: { requestBytes: 2_097_152, continuationBytes: 48_000 } });
const initial = (part = image(), tools = true): GenerationRequest => ({ system: 'Trusted instructions',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Describe this image' }, part] }],
  ...(tools ? { tools: [tool] } : {}), maxInputTokens: 2048, maxOutputTokens: 512 });
const resumed = (continuation: NativeContinuation): GenerationRequest => ({ system: 'Trusted instructions', messages: [], tools: [tool], continuation,
  toolResults: [{ id: 'call-1', name: tool.name, result: { ok: true, image_url: 'https://127.0.0.1/not-media', inlineData: 'literal tool data' } }],
  maxInputTokens: 2048, maxOutputTokens: 512 });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function fixture(protocol: ProviderProtocol, withTools = true) {
  let generations = 0;
  const request = vi.fn<AiHttpTransport>(async (url, input) => {
    const path = `/gateway/v1/${protocol === 'openai-chat-completions' ? 'chat/completions' : 'responses'}`;
    expect(input.method).toBe('POST'); expect(url.origin).toBe('https://vision.example.com'); expect(url.pathname).toBe(path);
    const call = withTools && ++generations === 1;
    const text = call ? '' : 'Image understood';
    const wire = protocol === 'openai-chat-completions'
      ? event({ choices: [{ index: 0, delta: { role: 'assistant', content: text, ...(call ? { tool_calls: [
        { index: 0, id: 'call-1', type: 'function', function: { name: tool.name, arguments: '{}' } },
      ] } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 5 } }) + 'data: [DONE]\n\n'
      : event({ type: 'response.completed', response: { status: 'completed', output: call
        ? [{ type: 'function_call', call_id: 'call-1', name: tool.name, arguments: '{}' }]
        : [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 100, output_tokens: 5 } } });
    return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
  });
  const network = createAiTransport({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  // Compatible vision needs only POST, never a provider Files API.
  const transport = { post: network.post };
  const bytes = image();
  const restore = vi.fn<(digest: string, signal: AbortSignal) => Promise<PreparedContent>>(async () => ({ ...bytes, bytes: Uint8Array.from(bytes.bytes) }));
  return { request, transport, restore, provider: createAiProvider(profile(protocol), { transport, fileScope: scope, rehydrateMedia: restore }) };
}
const body = (request: ReturnType<typeof fixture>['request'], at = 0) => JSON.parse(request.mock.calls[at]![1].body.toString()) as Record<string, unknown>;
const records = (body: Record<string, unknown>, protocol: ProviderProtocol) => (body[protocol === 'openai-chat-completions' ? 'messages' : 'input'] as Record<string, unknown>[]);
function mediaBlock(continuation: NativeContinuation): Record<string, unknown> {
  return (continuation.records.find(record => record.role === 'user')!.content as Record<string, unknown>[]).find(part => part.type === 'image_url' || part.type === 'input_image')!;
}
function mediaUrl(block: Record<string, unknown>, protocol: ProviderProtocol): string {
  return protocol === 'openai-chat-completions' ? (block.image_url as { url: string }).url : block.image_url as string;
}
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe.each(['openai-chat-completions', 'openai-responses'] as const)('%s bounded compatible vision', protocol => {
  it('distinguishes requesting image generation from accepting image input', () => {
    const f = fixture(protocol, false);
    expect(() => createAiProvider({ ...profile(protocol), capabilities: { input: ['text', 'image'], output: ['text', 'image'] } },
      { transport: f.transport, fileScope: scope })).toThrow('OUTPUT_UNSUPPORTED');
    expect(f.request).not.toHaveBeenCalled();
  });

  it('sends scoped bytes inline, persists only compact signed references, and rehydrates through a tool roundtrip', async () => {
    const f = fixture(protocol); const onFiles = vi.fn();
    const first = await f.provider.generate(initial(), { signal: signal(), onFiles });
    expect(first.toolCalls).toEqual([{ id: 'call-1', name: tool.name, arguments: {} }]);
    const serialized = JSON.stringify(first.continuation);
    expect(Buffer.byteLength(serialized)).toBeLessThan(48_000);
    expect(serialized).not.toContain('data:image'); expect(serialized).not.toContain('base64');
    expect(serialized).toContain('misaka-inline:');
    expect(first.continuation!.files).toEqual([expect.objectContaining({ storage: 'inline', kind: 'image', bytes: 90_000,
      providerExpiresAt: null, signature: expect.stringMatching(/^[a-f0-9]{64}$/) })]);
    expect(onFiles).toHaveBeenCalledOnce();
    expect(JSON.stringify(onFiles.mock.calls)).not.toContain(Buffer.from(image().bytes).toString('base64'));
    const wireFirst = records(body(f.request), protocol);
    const firstImage = mediaBlock({ ...first.continuation!, records: wireFirst });
    expect(mediaUrl(firstImage, protocol)).toBe(`data:image/png;base64,${Buffer.from(image().bytes).toString('base64')}`);
    expect(JSON.stringify(body(f.request))).not.toContain('misaka-inline:');
    expect(JSON.stringify(body(f.request))).not.toContain('providerExpiresAt');
    const persisted = JSON.parse(serialized) as NativeContinuation;
    const next = createAiProvider(profile(protocol), { transport: f.transport, fileScope: scope, rehydrateMedia: f.restore });
    const second = await next.generate(resumed(persisted), { signal: signal() });
    expect(second.text).toBe('Image understood'); expect(f.request).toHaveBeenCalledTimes(2);
    expect(f.restore).toHaveBeenCalledExactlyOnceWith(createHash('sha256').update(image().bytes).digest('hex'), expect.any(AbortSignal));
    expect(mediaUrl(mediaBlock({ ...persisted, records: records(body(f.request, 1), protocol) }), protocol)).toBe(mediaUrl(firstImage, protocol));
    expect(JSON.stringify(body(f.request, 1))).toContain('literal tool data');
    expect(JSON.stringify(second.continuation)).not.toContain('base64');
    expect(JSON.stringify(persisted)).toBe(serialized);
    await next.release!(second.cleanup!, signal());
    expect(f.request).toHaveBeenCalledTimes(2);
  });

  it('does not reinterpret source bytes as tokens or weaken an explicit strict media budget', async () => {
    const f = fixture(protocol, false);
    const strict = createAiProvider({ ...profile(protocol), mediaTokenPolicy: 'strict' }, { transport: f.transport, fileScope: scope });
    const onFiles = vi.fn();
    await expect(strict.generate(initial(image(), false), { signal: signal(), onFiles })).rejects.toMatchObject({ code: 'MEDIA_COUNT_UNAVAILABLE', billable: false });
    expect(f.request).not.toHaveBeenCalled(); expect(onFiles).not.toHaveBeenCalled();
    await expect(f.provider.generate(initial(image(), false), { signal: signal() })).resolves.toMatchObject({ text: 'Image understood' });
    expect(f.request).toHaveBeenCalledOnce();
    const missingInput = createAiProvider({ ...profile(protocol), capabilities: { input: ['text'], output: ['text'] } }, { transport: f.transport, fileScope: scope });
    await expect(missingInput.generate(initial(), { signal: signal() })).rejects.toMatchObject({ code: 'INPUT_DISABLED', billable: false });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it('snapshots caller bytes and handles aliased native image positions without storing binary data', async () => {
    const f = fixture(protocol, false); const part = image(); const expected = Buffer.from(part.bytes).toString('base64');
    const request = initial(part, false); request.messages[0]!.content.push(part);
    const result = await f.provider.generate(request, { signal: signal(), onFiles: () => { part.bytes.fill(3); } });
    const user = records(body(f.request), protocol).find(record => record.role === 'user')!;
    const images = (user.content as Record<string, unknown>[]).filter(item => item.type === 'image_url' || item.type === 'input_image');
    expect(images).toHaveLength(2); expect(images.every(item => mediaUrl(item, protocol) === `data:image/png;base64,${expected}`)).toBe(true);
    expect(JSON.stringify(result.continuation)).not.toContain(expected);
  });

  it.each(['scope', 'origin', 'protocol', 'mime', 'bytes', 'digest', 'storage', 'signature'] as const)('rejects changed %s before rehydration or transport', async kind => {
    const f = fixture(protocol); const first = await f.provider.generate(initial(), { signal: signal() });
    const continuation = structuredClone(first.continuation!); const ref = continuation.files![0]!;
    if (kind === 'scope') ref.scope = '0'.repeat(64);
    if (kind === 'origin') ref.origin = 'https://elsewhere.example.com';
    if (kind === 'protocol') ref.protocol = protocol === 'openai-responses' ? 'openai-chat-completions' : 'openai-responses';
    if (kind === 'mime') ref.mimeType = 'image/jpeg';
    if (kind === 'bytes') ref.bytes++;
    if (kind === 'digest') ref.sha256 = '0'.repeat(64);
    if (kind === 'storage') delete ref.storage;
    if (kind === 'signature') ref.signature = '0'.repeat(64);
    await expect(f.provider.generate(resumed(continuation), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    expect(f.restore).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
    await expect(f.provider.release!(continuation, signal())).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it.each(['https://127.0.0.1/private', 'file:///private/image.png', 'data:image/png;base64,AAAA'] as const)('rejects unowned URI %s, including alongside a valid lease', async url => {
    const f = fixture(protocol); const first = await f.provider.generate(initial(), { signal: signal() });
    for (const keepFiles of [false, true]) {
      const continuation = structuredClone(first.continuation!);
      if (!keepFiles) continuation.files = [];
      mediaBlock(continuation).image_url = protocol === 'openai-chat-completions' ? { url } : url;
      await expect(f.provider.generate(resumed(continuation), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    }
    const continuation = structuredClone(first.continuation!);
    const foreign = protocol === 'openai-chat-completions' ? { type: 'image_url', image_url: { url } } : { type: 'input_image', image_url: url, detail: 'auto' };
    continuation.records.push(protocol === 'openai-chat-completions' ? { role: 'tool', tool_call_id: 'foreign', content: [foreign] }
      : { type: 'function_call_output', call_id: 'foreign', output: [foreign] });
    await expect(f.provider.generate(resumed(continuation), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    expect(f.restore).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
  });

  it('rejects cross-run replay, expired leases and excessive image occurrences before resolving bytes', async () => {
    vi.useFakeTimers();
    const f = fixture(protocol); const first = await f.provider.generate(initial(), { signal: signal() });
    const foreign = createAiProvider(profile(protocol), { transport: f.transport, fileScope: 'another-run', rehydrateMedia: f.restore });
    await expect(foreign.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    const excessive = structuredClone(first.continuation!); const block = mediaBlock(excessive);
    (excessive.records.find(record => record.role === 'user')!.content as unknown[]).push(...Array.from({ length: 8 }, () => structuredClone(block)));
    await expect(f.provider.generate(resumed(excessive), { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE', billable: false });
    await vi.advanceTimersByTimeAsync(3_600_001);
    await expect(f.provider.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    expect(f.restore).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
    await f.provider.release!(first.continuation!, signal()); expect(f.request).toHaveBeenCalledOnce();
  });

  it('checks rehydrated hashes, bounded wire size and cancellation without any file API calls', async () => {
    const f = fixture(protocol); const first = await f.provider.generate(initial(), { signal: signal() });
    f.restore.mockResolvedValueOnce({ ...image(), bytes: Buffer.alloc(90_000, 8) });
    await expect(f.provider.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false });
    f.restore.mockClear();
    const small = createAiProvider({ ...profile(protocol), limits: { requestBytes: 30_000, continuationBytes: 48_000 } }, { transport: f.transport, fileScope: scope, rehydrateMedia: f.restore });
    await expect(small.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE', billable: false });
    expect(f.restore).not.toHaveBeenCalled(); expect(f.request).toHaveBeenCalledOnce();
    const controller = new AbortController();
    f.restore.mockImplementationOnce(async () => { controller.abort(); return image(); });
    await expect(f.provider.generate(resumed(first.continuation!), { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED', billable: false });
    expect(f.request).toHaveBeenCalledOnce();
  });

  it('admits an image near the raw one-MiB bound with enough encoded request space, but not oversized sources', async () => {
    const f = fixture(protocol, false);
    const large = { ...image(), bytes: Buffer.alloc(1_000_000, 7) };
    await expect(f.provider.generate(initial(large, false), { signal: signal() })).resolves.toMatchObject({ text: 'Image understood' });
    expect(f.request).toHaveBeenCalledOnce(); expect(f.request.mock.calls[0]![1].body.byteLength).toBeLessThan(2_097_152);
    await expect(f.provider.generate(initial({ ...large, bytes: Buffer.alloc(1_048_577) }, false), { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE', billable: false });
    expect(f.request).toHaveBeenCalledOnce();
  });
});
