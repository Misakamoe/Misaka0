import { Readable } from 'node:stream';
import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { AiFileCleanupError, createAiProvider, type GenerationRequest, type NativeContinuation, type PreparedContent, type ProviderFileReference, type ProviderProfile, type ProviderProtocol } from '../src/ai/providers.js';
import { AiProtocolError, createAiTransport, type AiHttpTransport } from '../src/ai/transport.js';

const signal = () => new AbortController().signal;
const scope = 'private:7:run:fixture';
const profile = (protocol: ProviderProtocol): ProviderProfile => ({ protocol, model: 'fixture-model', apiKey: 'TEST_ONLY_SECRET',
  origin: protocol === 'anthropic-messages' ? 'https://api.anthropic.com' : protocol === 'google-generate-content' ? 'https://generativelanguage.googleapis.com' : 'https://api.openai.com',
  capabilities: { input: ['text', 'image', 'audio', 'file'], output: ['text'] }, limits: { requestBytes: 1_048_576, continuationBytes: 48_000 } });
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const json = (value: unknown, status = 200) => ({ status, headers: { 'content-type': 'application/json' }, body: Readable.from([Buffer.from(JSON.stringify(value))]) });
function completion(protocol: ProviderProtocol) {
  const wire = protocol === 'anthropic-messages'
    ? event({ type: 'message_start', message: {} }) + event({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'Read' } })
      + event({ type: 'content_block_stop', index: 0 }) + event({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + event({ type: 'message_stop' })
    : protocol === 'google-generate-content' ? event({ candidates: [{ content: { parts: [{ text: 'Read' }] }, finishReason: 'STOP' }] })
      : protocol === 'openai-chat-completions' ? event({ choices: [{ index: 0, delta: { content: 'Read' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
        : event({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Read' }] }] } });
  return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
}
const message = (content: PreparedContent[]): GenerationRequest => ({ messages: [{ role: 'user', content }] });
function fixture(protocol: ProviderProtocol, content: Exclude<PreparedContent, { type: 'text' }>[], options: {
  uploadLocation?: string; fileUri?: string; failGeneration?: boolean; failDelete?: boolean; process?: boolean;
  count?: number; countResponse?: unknown; countStatus?: number;
} = {}) {
  let uploaded = 0; let googleId = ''; let part = content[0]!; let polled = false;
  const googleFile = () => ({ name: googleId, uri: options.fileUri ?? `https://generativelanguage.googleapis.com/v1beta/${googleId}`,
    mimeType: part.mimeType, sizeBytes: String(part.bytes.byteLength), expirationTime: new Date(Date.now() + 48 * 3_600_000).toISOString(), state: options.process && !polled ? 'PROCESSING' : 'ACTIVE' });
  const request = vi.fn<AiHttpTransport>(async (url, input) => {
    if (input.method === 'DELETE') {
      if (options.failDelete) return json({ error: 'not exposed' }, 503);
      const id = url.pathname.split('/').at(-1)!;
      return protocol === 'google-generate-content' ? json({}) : json(protocol === 'anthropic-messages' ? { id, type: 'file_deleted' } : { id, deleted: true });
    }
    if (input.method === 'GET') { polled = true; return json(googleFile()); }
    if (url.pathname.endsWith('/input_tokens') || url.pathname.endsWith('/count_tokens') || url.pathname.endsWith(':countTokens')) {
      return json(Object.hasOwn(options, 'countResponse') ? options.countResponse : protocol === 'google-generate-content' ? { totalTokens: options.count ?? 100 }
        : protocol === 'anthropic-messages' ? { input_tokens: options.count ?? 100 } : { object: 'response.input_tokens', input_tokens: options.count ?? 100 }, options.countStatus ?? 200);
    }
    if (url.pathname === '/upload/v1beta/files' && !url.search) {
      const body = JSON.parse(input.body.toString()) as { file: { name: string } };
      googleId = body.file.name; part = content[uploaded++]!;
      return { status: 200, headers: { 'x-goog-upload-url': options.uploadLocation ?? `${url.origin}/upload/v1beta/files?upload_id=fixture-token&upload_protocol=resumable` }, body: Readable.from([]) };
    }
    if (url.pathname === '/upload/v1beta/files') return json({ file: googleFile() });
    if (url.pathname === '/v1/files') {
      part = content[uploaded++]!;
      return protocol === 'anthropic-messages'
        ? json({ id: `file_native${uploaded}`, mime_type: part.mimeType, size_bytes: part.bytes.byteLength, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, 201)
        : json({ id: `file-native${uploaded}`, bytes: part.bytes.byteLength, expires_at: Math.floor(Date.now() / 1000) + 3600 });
    }
    return options.failGeneration ? json({ error: 'private upstream details' }, 503) : completion(protocol);
  });
  const transport = createAiTransport({ request, lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  return { request, transport, provider: createAiProvider(profile(protocol), { transport, fileScope: scope }) };
}

describe('explicit compatible API directories', () => {
  it.each([
    [undefined, '/v1'], ['', '/v1'], ['/', '/v1'], ['/v1', '/v1'], ['/v1/', '/v1'], ['/gateway/v1/', '/gateway/v1'], ['/gateway', '/gateway'],
  ])('uses directory %s without adding a second version', async (basePath, prefix) => {
    for (const protocol of ['openai-responses', 'openai-chat-completions'] as const) {
      const mock = fixture(protocol, []);
      const provider = createAiProvider({ ...profile(protocol), origin: 'https://api.deepseek.com', basePath }, { transport: mock.transport });
      const generated = await provider.generate(message([{ type: 'text', text: 'Hello' }]), { signal: signal() });
      expect(mock.request.mock.calls[0]![0].pathname).toBe(`${prefix}/${protocol === 'openai-responses' ? 'responses' : 'chat/completions'}`);
      expect(generated.continuation?.basePath).toBe(prefix);
    }
  });
  it.each(['//evil.com', 'https://evil.com/v1', '/a/../v1', '/a/./v1', '/v1?key=secret', '/v1#x', '/v1%2fother', '/v1\\other', '/v1//other'])('rejects ambiguous directory %s', basePath => {
    expect(() => createAiProvider({ ...profile('openai-responses'), basePath })).toThrow('UNSAFE_URL');
  });
  it('pins native directories and binds continuation to its configured directory', async () => {
    for (const protocol of ['anthropic-messages', 'google-generate-content'] as const) expect(() => createAiProvider({ ...profile(protocol), basePath: '/proxy/v1' })).toThrow('UNSAFE_URL');
    const mock = fixture('openai-responses', []);
    const first = await mock.provider.generate(message([{ type: 'text', text: 'Hi' }]), { signal: signal() });
    const other = createAiProvider({ ...profile('openai-responses'), basePath: '/proxy/v1' }, { transport: mock.transport });
    await expect(other.generate({ messages: [], continuation: first.continuation }, { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    expect(mock.request).toHaveBeenCalledTimes(1);
  });
});

describe('native scoped upload references', () => {
  it.each(['openai-responses', 'anthropic-messages', 'google-generate-content'] as const)('%s uploads media and round-trips a sub-48KiB continuation without binary copies', async protocol => {
    const content: Exclude<PreparedContent, { type: 'text' }>[] = [
      { type: 'image', mimeType: 'image/png', bytes: Buffer.alloc(90_000, 7), filename: 'image.png' },
      { type: 'file', mimeType: 'application/pdf', bytes: Buffer.alloc(90_000, 8), filename: 'document.pdf' },
      { type: 'file', mimeType: 'text/plain', bytes: Buffer.alloc(90_000, 65), filename: 'text.txt' },
      ...(protocol === 'google-generate-content' ? [{ type: 'audio' as const, mimeType: 'audio/mpeg', bytes: Buffer.alloc(90_000, 9), filename: 'audio.mp3' }] : []),
    ];
    const mock = fixture(protocol, content); const onFiles = vi.fn();
    const first = await mock.provider.generate(message(content), { signal: signal(), onFiles });
    const serialized = JSON.stringify(first.continuation);
    expect(Buffer.byteLength(serialized)).toBeLessThan(48_000);
    expect(serialized).not.toMatch(/base64|inlineData|file_data|fixture-token/);
    expect(serialized).not.toContain(Buffer.alloc(90_000, 7).toString('base64'));
    expect(first.continuation!.files).toHaveLength(content.length);
    expect(onFiles).toHaveBeenCalledTimes(content.length);
    const persisted = JSON.parse(serialized) as NativeContinuation;
    const next = createAiProvider(profile(protocol), { transport: mock.transport, fileScope: scope });
    if (protocol === 'anthropic-messages') {
      const before = mock.request.mock.calls.length;
      await expect(next.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'More details' }] }], continuation: persisted }, { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', billable: false, cleanup: persisted.files });
      expect(mock.request).toHaveBeenCalledTimes(before);
      await next.release!(persisted, signal());
      return;
    }
    const second = await next.generate({ messages: [{ role: 'user', content: [{ type: 'text', text: 'More details' }] }], continuation: persisted }, { signal: signal() });
    expect(second.continuation!.files).toEqual(first.continuation!.files);
    const last = JSON.parse(mock.request.mock.calls.at(-1)![1].body.toString()) as Record<string, unknown>;
    expect(JSON.stringify(last)).toContain(protocol === 'google-generate-content' ? 'fileUri' : 'file_id');
    expect(JSON.stringify(last)).not.toContain('base64');
    await next.release!(second.continuation!, signal());
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(content.length);
    const uploads = mock.request.mock.calls.filter(([url, input]) => url.pathname === '/v1/files' && input.method === 'POST');
    for (const [, input] of uploads) expect(input.body.toString()).toContain('expires_after[seconds]');
    if (protocol === 'google-generate-content') {
      for (const [url, input] of mock.request.mock.calls.filter(([url]) => url.searchParams.has('upload_id'))) {
        expect(url.origin).toBe('https://generativelanguage.googleapis.com');
        expect(input.headers).not.toHaveProperty('x-goog-api-key');
        expect(input.headers).not.toHaveProperty('authorization');
      }
    }
  });
  it('handles bounded Google processing metadata before inference', async () => {
    const content = [{ type: 'audio' as const, mimeType: 'audio/mpeg', bytes: Buffer.alloc(100) }];
    const mock = fixture('google-generate-content', content, { process: true });
    await mock.provider.generate(message(content), { signal: signal() });
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'GET')).toHaveLength(1);
  });
  it('requires trusted scope and rejects unsupported native types before uploading anything', async () => {
    const image = { type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) };
    const audio = { type: 'audio' as const, mimeType: 'audio/mpeg', bytes: Buffer.alloc(100) };
    const mock = fixture('openai-responses', [image]);
    await expect(createAiProvider(profile('openai-responses'), { transport: mock.transport }).generate(message([image]), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    for (const protocol of ['openai-responses', 'anthropic-messages'] as const) {
      await expect(createAiProvider(profile(protocol), { transport: mock.transport, fileScope: scope }).generate(message([image, audio]), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    }
    await expect(createAiProvider({ ...profile('openai-responses'), origin: 'https://api.deepseek.com' }, { transport: mock.transport, fileScope: scope }).generate(message([image]), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(createAiProvider({ ...profile('anthropic-messages'), anthropicVersion: '2023-06-01' }, { transport: mock.transport, fileScope: scope }).generate(message([image]), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('cannot relax public DNS checks through the file upload interface', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content);
    const transport = createAiTransport({ request: mock.request, lookup: async () => [{ address: '127.0.0.1', family: 4 }] });
    await expect(createAiProvider(profile('openai-responses'), { transport, fileScope: scope }).generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('rejects invented generic file output and media/tool continuation combinations before network', async () => {
    for (const protocol of ['openai-responses', 'anthropic-messages', 'google-generate-content'] as const) {
      expect(() => createAiProvider({ ...profile(protocol), capabilities: { input: ['text'], output: ['file'] } })).toThrow('UNSUPPORTED');
    }
    const mock = fixture('google-generate-content', []);
    const provider = createAiProvider({ ...profile('google-generate-content'), capabilities: { input: ['text'], output: ['image'] } }, { transport: mock.transport });
    await expect(provider.generate({ ...message([{ type: 'text', text: 'Draw' }]), tools: [{ name: 'read', description: '', inputSchema: { type: 'object' } }] }, { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it('bounds raw media and prompt bytes, and rejects uncountable compatible media before network', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(600_000) }, { type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(500_000) }];
    const mock = fixture('openai-responses', content);
    await expect(mock.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    const compatible = createAiProvider(profile('openai-chat-completions'), { transport: mock.transport });
    await expect(compatible.generate(message([content[0]!]), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', billable: false });
    await expect(mock.provider.generate({ ...message([content[0]!]), system: 'x'.repeat(500_000) }, { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(mock.request).not.toHaveBeenCalled();
  });
  it.each(['https://evil.com/upload/v1beta/files?upload_id=x', 'http://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x',
    'https://user:secret@generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x', 'https://generativelanguage.googleapis.com/upload/v1beta/files?upload_id=x&key=secret',
    'https://generativelanguage.googleapis.com/other?upload_id=x'])('rejects upload session URL %s without sending bytes or credentials there', async uploadLocation => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('google-generate-content', content, { uploadLocation });
    await expect(mock.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'UNSAFE_URL' });
    expect(mock.request.mock.calls.every(([url]) => url.origin === 'https://generativelanguage.googleapis.com')).toBe(true);
    expect(mock.request.mock.calls.filter(([, input]) => input.headers['x-goog-upload-command'] === 'upload, finalize')).toHaveLength(0);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });
  it.each(['https://evil.com/private', 'https://generativelanguage.googleapis.com/v1beta/files/other?key=secret'])('rejects foreign/tokenized file URI %s and deletes only its own client-chosen file', async fileUri => {
    const content = [{ type: 'audio' as const, mimeType: 'audio/mpeg', bytes: Buffer.alloc(100) }];
    const mock = fixture('google-generate-content', content, { fileUri });
    await expect(mock.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    expect(mock.request.mock.calls.some(([url]) => url.pathname.endsWith(':streamGenerateContent'))).toBe(false);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')[0]![0].pathname).toMatch(/^\/v1beta\/files\/misaka-/);
  });
  it('rejects forged, cross-scope, expired, or unowned references before inference or deletion', async () => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content);
    const result = await mock.provider.generate(message(content), { signal: signal() });
    const continuation = result.continuation!; const ref = continuation.files![0]!;
    const before = mock.request.mock.calls.length;
    for (const changed of [{ ...ref, id: 'file-foreign' }, { ...ref, origin: 'https://evil.com' }, { ...ref, signature: '0'.repeat(64) }, { ...ref, uri: 'https://evil.com' }]) {
      await expect(mock.provider.release!([changed], signal())).rejects.toBeDefined();
    }
    const wrongScope = createAiProvider(profile('openai-responses'), { transport: mock.transport, fileScope: 'other-owner-run' });
    await expect(wrongScope.release!(continuation, signal())).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    await expect(wrongScope.generate({ messages: [], continuation }, { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    const foreign = structuredClone(continuation); foreign.records = [{ role: 'user', content: [{ type: 'input_file', file_id: 'file-foreign' }] }];
    await expect(mock.provider.generate({ messages: [], continuation: foreign }, { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    const now = vi.spyOn(Date, 'now').mockReturnValue(ref.expiresAt + 1);
    try { await expect(mock.provider.generate({ messages: [], continuation }, { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' }); } finally { now.mockRestore(); }
    expect(mock.request).toHaveBeenCalledTimes(before);
  });
  it('cleans uploaded files on generation failure and exposes only unresolved signed cleanup handles', async () => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const cleaned = fixture('openai-responses', content, { failGeneration: true });
    await expect(cleaned.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'NETWORK' });
    expect(cleaned.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
    const stranded = fixture('anthropic-messages', content, { failGeneration: true, failDelete: true });
    const error = await stranded.provider.generate(message(content), { signal: signal() }).catch(value => value as unknown);
    expect(error).toBeInstanceOf(AiFileCleanupError);
    expect((error as AiFileCleanupError).cleanup).toHaveLength(1);
    expect(String(error)).not.toMatch(/SECRET|private upstream/);
  });
  it('does not claim a server expiration when malformed upload metadata prevented verification', async () => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content, { failDelete: true });
    mock.request.mockImplementationOnce(async () => json({ id: 'file-native1', bytes: 100, expires_at: null }));
    const error = await mock.provider.generate(message(content), { signal: signal() }).catch(value => value as AiFileCleanupError);
    expect(error).toBeInstanceOf(AiFileCleanupError);
    expect((error as AiFileCleanupError).cleanup[0]!.providerExpiresAt).toBeNull();
  });
  it('treats already-deleted owned files as released without accepting arbitrary IDs', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content);
    const result = await mock.provider.generate(message(content), { signal: signal() });
    mock.request.mockImplementationOnce(async () => json({}, 404));
    await expect(mock.provider.release!(result.cleanup!, signal())).resolves.toBeUndefined();
  });
  it('cancels after upload and releases the known file with an independent bounded cleanup signal', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content); const controller = new AbortController(); let refs: readonly ProviderFileReference[] = [];
    await expect(mock.provider.generate(message(content), { signal: controller.signal, onFiles: value => { refs = value; controller.abort(); } })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(refs).toHaveLength(1);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
    expect(mock.request.mock.calls.some(([url]) => url.pathname === '/v1/responses')).toBe(false);
  });
  it('never follows upload or delete redirects with credentials', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content);
    mock.request.mockImplementationOnce(async () => ({ status: 307, headers: { location: 'https://evil.com/upload' }, body: Readable.from([]) }));
    await expect(mock.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'NETWORK', status: 307 });
    expect(mock.request).toHaveBeenCalledTimes(1);
    const result = await mock.provider.generate(message(content), { signal: signal() });
    const before = mock.request.mock.calls.length;
    mock.request.mockImplementationOnce(async () => ({ status: 307, headers: { location: 'https://evil.com/delete' }, body: Readable.from([]) }));
    await expect(mock.provider.release!(result.continuation!, signal())).rejects.toBeInstanceOf(AiFileCleanupError);
    expect(mock.request).toHaveBeenCalledTimes(before + 1);
  });
});

describe('media input-token admission', () => {
  const isCount = (url: URL) => url.pathname.endsWith('/input_tokens') || url.pathname.endsWith('/count_tokens') || url.pathname.endsWith(':countTokens');
  const isGeneration = (url: URL) => ['/v1/responses', '/v1/messages', '/v1/chat/completions'].includes(url.pathname) || url.pathname.endsWith(':streamGenerateContent');
  const tool = { name: 'read_state', description: 'Read bounded state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };

  it.each(['openai-responses', 'anthropic-messages', 'google-generate-content'] as const)('%s rejects huge expanded token counts from a tiny compressed PDF before inference', async protocol => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.from('%PDF-fixture-compressed') }];
    const mock = fixture(protocol, content, { count: 100_000 });
    await expect(mock.provider.generate({ ...message(content), maxInputTokens: 32_768 }, { signal: signal() })).rejects.toMatchObject({ code: 'QUOTA', billable: false });
    expect(mock.request.mock.calls.filter(([url]) => isCount(url))).toHaveLength(1);
    expect(mock.request.mock.calls.filter(([url]) => isGeneration(url))).toHaveLength(0);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it.each(['openai-responses', 'anthropic-messages', 'google-generate-content'] as const)('%s counts the native full prompt, system, tools and media with documented fields', async protocol => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100, 7) }];
    const mock = fixture(protocol, content);
    await mock.provider.generate({ ...message(content), system: 'Trusted system', tools: [tool], maxInputTokens: 100 }, { signal: signal() });
    const counts = mock.request.mock.calls.filter(([url]) => isCount(url)); const generations = mock.request.mock.calls.filter(([url]) => isGeneration(url));
    expect(counts).toHaveLength(1); expect(generations).toHaveLength(1);
    const [url, input] = counts[0]!;
    const counted = JSON.parse(input.body.toString()) as Record<string, unknown>;
    const generated = JSON.parse(generations[0]![1].body.toString()) as Record<string, unknown>;
    if (protocol === 'openai-responses') {
      expect(url.pathname).toBe('/v1/responses/input_tokens');
      expect(counted).toEqual({ model: 'fixture-model', input: generated.input, instructions: 'Trusted system', tools: generated.tools, truncation: 'disabled' });
      expect(input.headers.authorization).toBe('Bearer TEST_ONLY_SECRET');
    } else if (protocol === 'anthropic-messages') {
      expect(url.pathname).toBe('/v1/messages/count_tokens');
      expect(counted).toEqual({ model: 'fixture-model', system: 'Trusted system', tools: generated.tools,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: content[0]!.bytes.toString('base64') } }] }] });
      expect(JSON.stringify(generated)).not.toContain('base64');
      expect(input.headers['x-api-key']).toBe('TEST_ONLY_SECRET');
      expect(input.headers['anthropic-version']).toBe('2026-10-21');
    } else {
      expect(url.pathname).toBe('/v1beta/models/fixture-model:countTokens');
      expect(counted).toEqual({ generateContentRequest: { ...generated, model: 'models/fixture-model' } });
      expect(counted).not.toHaveProperty('contents');
      expect(input.headers['x-goog-api-key']).toBe('TEST_ONLY_SECRET');
    }
    expect(mock.request.mock.calls.indexOf(counts[0]!)).toBeLessThan(mock.request.mock.calls.indexOf(generations[0]!));
  });

  it('defaults media admission to 32768 tokens when maxInputTokens is omitted', async () => {
    const content = [{ type: 'audio' as const, mimeType: 'audio/mpeg', bytes: Buffer.alloc(100) }];
    const mock = fixture('google-generate-content', content, { count: 32_769 });
    await expect(mock.provider.generate(message(content), { signal: signal() })).rejects.toMatchObject({ code: 'QUOTA', billable: false });
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
  });

  it.each([{}, { object: 'response.input_tokens' }, { object: 'other', input_tokens: 1 }, { object: 'response.input_tokens', input_tokens: '1' },
    { object: 'response.input_tokens', input_tokens: 0 }, { object: 'response.input_tokens', input_tokens: -1 }, { object: 'response.input_tokens', input_tokens: 1.5 },
    { object: 'response.input_tokens', input_tokens: null }, { object: 'response.input_tokens', input_tokens: Number.MAX_SAFE_INTEGER + 1 },
    { object: 'response.input_tokens', input_tokens: 1, error: 'untrusted' }, []])('fails closed for malformed count response %j', async countResponse => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content, { countResponse });
    await expect(mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_RESPONSE', billable: false });
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it.each([400, 404, 405, 501])('does not fall back to generation when the count API returns %i', async countStatus => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content, { countStatus });
    await expect(mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', status: countStatus, billable: false });
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
  });

  it.each(['openai-responses', 'google-generate-content'] as const)('%s recounts continued image references and signed tool history against a smaller remaining allowance', async protocol => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture(protocol, content); const original = mock.request.getMockImplementation()!;
    mock.request.mockImplementation(async (url, input) => {
      if (!isGeneration(url)) return original(url, input);
      const wire = protocol === 'openai-responses' ? event({ type: 'response.completed', response: { status: 'completed', output: [
        { type: 'reasoning', id: 'rs_fixture', encrypted_content: 'opaque-signature', summary: [] },
        { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: tool.name, arguments: '{}' },
      ] } }) : event({ candidates: [{ content: { parts: [{ functionCall: { id: 'call_fixture', name: tool.name, args: {} }, thoughtSignature: 'opaque-signature' }] }, finishReason: 'STOP' }] });
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
    });
    const first = await mock.provider.generate({ ...message(content), system: 'Trusted system', tools: [tool], maxInputTokens: 100 }, { signal: signal() });
    const continued: GenerationRequest = { system: 'Trusted system', tools: [tool], messages: [], continuation: JSON.parse(JSON.stringify(first.continuation)) as NativeContinuation,
      toolResults: [{ id: 'call_fixture', name: tool.name, result: { current: true } }], maxInputTokens: 99 };
    const error = await mock.provider.generate(continued, { signal: signal() }).catch(value => value as AiFileCleanupError);
    expect(error).toMatchObject({ code: 'QUOTA', billable: false, cleanup: first.cleanup });
    expect(mock.request.mock.calls.filter(([url]) => isGeneration(url))).toHaveLength(1);
    const counted = JSON.parse(mock.request.mock.calls.filter(([url]) => isCount(url)).at(-1)![1].body.toString()) as Record<string, unknown>;
    expect(JSON.stringify(counted)).toContain('opaque-signature'); expect(JSON.stringify(counted)).toContain('call_fixture');
    expect(JSON.stringify(counted)).toContain('current'); expect(JSON.stringify(counted)).toContain('Trusted system');
    expect(JSON.stringify(counted)).toContain(protocol === 'openai-responses' ? 'file_id' : 'fileUri');
    const wrongScope = createAiProvider(profile(protocol), { transport: mock.transport, fileScope: 'different-owner' });
    const before = mock.request.mock.calls.length;
    await expect(wrongScope.release!((error as AiFileCleanupError).cleanup, signal())).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    expect(mock.request).toHaveBeenCalledTimes(before);
    await mock.provider.release!((error as AiFileCleanupError).cleanup, signal());
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it('rejects an Anthropic continued file before uploads/counting and retains authenticated cleanup references', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('anthropic-messages', content);
    const first = await mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: signal() });
    const before = mock.request.mock.calls.length;
    await expect(mock.provider.generate({ ...message(content), continuation: first.continuation, maxInputTokens: 100 }, { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', billable: false, cleanup: first.cleanup });
    expect(mock.request).toHaveBeenCalledTimes(before);
  });

  it('preserves Anthropic thinking signatures and tool results when counting newly supplied media', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('anthropic-messages', content); const original = mock.request.getMockImplementation()!; let generated = false;
    mock.request.mockImplementation(async (url, input) => {
      if (!isGeneration(url) || generated) return original(url, input);
      generated = true;
      const wire = event({ type: 'message_start', message: {} })
        + event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'private thought', signature: 'opaque-signature' } })
        + event({ type: 'content_block_stop', index: 0 })
        + event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_fixture', name: tool.name, input: {} } })
        + event({ type: 'content_block_stop', index: 1 }) + event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + event({ type: 'message_stop' });
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
    });
    const first = await mock.provider.generate({ ...message([{ type: 'text', text: 'Inspect' }]), system: 'Trusted system', tools: [tool] }, { signal: signal() });
    expect(first.text).toBe('');
    await mock.provider.generate({ ...message(content), system: 'Trusted system', tools: [tool], continuation: first.continuation,
      toolResults: [{ id: 'tool_fixture', name: tool.name, result: { current: true } }], maxInputTokens: 100 }, { signal: signal() });
    const counts = mock.request.mock.calls.filter(([url]) => isCount(url)); expect(counts).toHaveLength(1);
    const counted = JSON.parse(counts[0]![1].body.toString()) as { messages: unknown[] };
    expect(counted.messages).toContainEqual(first.continuation!.records.at(-1));
    expect(JSON.stringify(counted)).toContain('tool_fixture'); expect(JSON.stringify(counted)).toContain('opaque-signature');
    expect(JSON.stringify(counted)).toContain('base64');
  });

  it('retains billable:false and only signed unresolved handles when over-budget cleanup fails', async () => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content, { count: 200, failDelete: true });
    const error = await mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: signal() }).catch(value => value as AiFileCleanupError);
    expect(error).toBeInstanceOf(AiFileCleanupError); expect(error).toMatchObject({ code: 'QUOTA', billable: false });
    expect((error as AiFileCleanupError).cleanup[0]).toMatchObject({ id: 'file-native1', signature: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
  });

  it('snapshots the budget and complete input before callbacks or a count round trip can mutate them', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content, { count: 101 });
    const input: GenerationRequest = { ...message(content), system: 'Original system', maxInputTokens: 100 };
    await expect(mock.provider.generate(input, { signal: signal(), onFiles: () => {
      input.maxInputTokens = 32_768; input.system = 'Mutated system'; input.messages[0]!.content.push({ type: 'text', text: 'Uncounted mutation' });
    } })).rejects.toMatchObject({ code: 'QUOTA', billable: false });
    const counted = mock.request.mock.calls.find(([url]) => isCount(url))![1].body.toString();
    expect(counted).toContain('Original system'); expect(counted).not.toContain('Mutated system'); expect(counted).not.toContain('Uncounted mutation');
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
  });

  it('cancels a blocked count response without inference and cleans its owned upload', async () => {
    const content = [{ type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(100) }];
    const mock = fixture('openai-responses', content); const original = mock.request.getMockImplementation()!; const controller = new AbortController();
    let countBody: Readable | undefined;
    mock.request.mockImplementation(async (url, input) => {
      if (!isCount(url)) return original(url, input);
      countBody = new Readable({ read() { controller.abort(); } });
      return { status: 200, headers: { 'content-type': 'application/json' }, body: countBody };
    });
    await expect(mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED', billable: false });
    expect(countBody?.destroyed).toBe(true);
    expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it('never marks an error nonbillable after inference was dispatched', async () => {
    const mock = fixture('openai-responses', []);
    await expect(mock.provider.generate(message([{ type: 'text', text: 'Hello' }]), { signal: signal(),
      onText: () => { throw new AiProtocolError('INVALID_INPUT', undefined, false); },
    })).rejects.toMatchObject({ code: 'INVALID_INPUT', billable: 'unknown' });
  });

  it('rejects count redirects and oversized count bodies without leaking credential redirects', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100) }];
    for (const status of [307, 200]) {
      const mock = fixture('openai-responses', content); const original = mock.request.getMockImplementation()!;
      mock.request.mockImplementation(async (url, input) => !isCount(url) ? original(url, input) : status === 307
        ? { status, headers: { location: 'https://evil.com/count' }, body: Readable.from([]) }
        : json({ object: 'response.input_tokens', input_tokens: 1, ignored: 'x'.repeat(20_000) }));
      await expect(mock.provider.generate({ ...message(content), maxInputTokens: 100 }, { signal: signal() })).rejects.toMatchObject({ code: status === 307 ? 'NETWORK' : 'TOO_LARGE', billable: false });
      expect(mock.request.mock.calls.every(([url]) => url.origin === 'https://api.openai.com')).toBe(true);
      expect(mock.request.mock.calls.some(([url]) => isGeneration(url))).toBe(false);
    }
  });

  it('rejects invalid/exhausted limits and compatible tiny binary classes before any network', async () => {
    const content = [{ type: 'image' as const, mimeType: 'image/png', bytes: Buffer.from('tiny') }];
    const mock = fixture('openai-responses', content);
    for (const maxInputTokens of [-1, 0.5, 32_769, NaN, '100']) {
      await expect(mock.provider.generate({ ...message(content), maxInputTokens } as GenerationRequest, { signal: signal() })).rejects.toMatchObject({ code: 'INVALID_INPUT', billable: false });
    }
    await expect(mock.provider.generate({ ...message(content), maxInputTokens: 0 }, { signal: signal() })).rejects.toMatchObject({ code: 'QUOTA', billable: false });
    const compatible = createAiProvider(profile('openai-chat-completions'), { transport: mock.transport });
    await expect(compatible.generate({ ...message(content), maxInputTokens: 32_768 }, { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', billable: false });
    expect(mock.request).not.toHaveBeenCalled();
    const textOnly = fixture('openai-chat-completions', []);
    await expect(textOnly.provider.generate({ ...message([{ type: 'text', text: 'tiny text' }]), maxInputTokens: 1 }, { signal: signal() })).rejects.toMatchObject({ code: 'QUOTA', billable: false });
    expect(textOnly.request).not.toHaveBeenCalled();
    await textOnly.provider.generate({ ...message([{ type: 'text', text: 'tiny text' }]), maxInputTokens: 32_768 }, { signal: signal() });
    expect(textOnly.request.mock.calls.filter(([url]) => isCount(url))).toHaveLength(0);
    expect(textOnly.request).toHaveBeenCalledTimes(1);
  });
});

describe('trusted Anthropic media rehydration', () => {
  const original = { type: 'image' as const, mimeType: 'image/png', bytes: Buffer.alloc(100, 7) };
  const sha256 = createHash('sha256').update(original.bytes).digest('hex');
  const resumed = (continuation: NativeContinuation): GenerationRequest => ({ messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }], continuation, maxInputTokens: 100 });

  it('resumes parent media and tool results using an active owned lease without reuploading or persisting restored bytes', async () => {
    const tool = { name: 'read_state', description: 'Read state', inputSchema: { type: 'object', properties: {}, additionalProperties: false } };
    const mock = fixture('anthropic-messages', [original]); const implementation = mock.request.getMockImplementation()!; let firstGeneration = true;
    mock.request.mockImplementation(async (url, input) => {
      if (url.pathname !== '/v1/messages' || !firstGeneration) return implementation(url, input);
      firstGeneration = false;
      const wire = event({ type: 'message_start', message: {} })
        + event({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'Private reasoning', signature: 'signed-prefix' } })
        + event({ type: 'content_block_stop', index: 0 })
        + event({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tool_parent', name: tool.name, input: {} } })
        + event({ type: 'content_block_stop', index: 1 }) + event({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + event({ type: 'message_stop' });
      return { status: 200, headers: { 'content-type': 'text/event-stream' }, body: Readable.from([Buffer.from(wire)]) };
    });
    const first = await mock.provider.generate({ ...message([original]), system: 'Trusted system', tools: [tool], maxInputTokens: 100 }, { signal: signal() });
    expect(first.continuation!.files![0]).toMatchObject({ sha256, kind: 'image', mimeType: 'image/png', bytes: 100 });
    const persisted = JSON.parse(JSON.stringify(first.continuation)) as NativeContinuation;
    const prefix = structuredClone(persisted.records);
    // The root may resolve an admitted parent's original capture after its new-use capability expires.
    const capture = { content: original, newUseExpiresAt: Date.now() - 1 };
    const rehydrateMedia = vi.fn(async (digest: string, currentSignal: AbortSignal) => {
      expect(digest).toBe(sha256); expect(currentSignal.aborted).toBe(false); expect(capture.newUseExpiresAt).toBeLessThan(Date.now());
      return capture.content;
    });
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope, rehydrateMedia });
    const second = await provider.generate({ messages: [], system: 'Trusted system', tools: [tool], continuation: persisted, maxInputTokens: 100,
      toolResults: [{ id: 'tool_parent', name: tool.name, result: { allowed: true } }] }, { signal: signal() });
    expect(first.text).toBe(''); expect(second.text).toBe('Read');
    expect(persisted.records).toEqual(prefix);
    expect(second.continuation!.records.slice(0, prefix.length)).toEqual(prefix);
    expect(JSON.stringify(second.continuation)).not.toMatch(/base64|BwcHBwcH/);
    expect(second.continuation!.files).toEqual(first.continuation!.files);
    const count = JSON.parse(mock.request.mock.calls.filter(([url]) => url.pathname === '/v1/messages/count_tokens').at(-1)![1].body.toString()) as { messages: Record<string, unknown>[] };
    const generated = JSON.parse(mock.request.mock.calls.filter(([url]) => url.pathname === '/v1/messages').at(-1)![1].body.toString()) as { messages: Record<string, unknown>[] };
    expect(count.messages).toContainEqual(prefix[1]); expect(generated.messages).toContainEqual(prefix[1]);
    expect(JSON.stringify(count)).toContain('tool_parent'); expect(JSON.stringify(count)).toContain('signed-prefix');
    expect(JSON.stringify(count)).toContain('base64'); expect(JSON.stringify(generated)).not.toContain('base64');
    expect(generated.messages.slice(0, prefix.length)).toEqual(prefix);
    const third = await provider.generate({ ...resumed(second.continuation!), system: 'Trusted system', tools: [tool] }, { signal: signal() });
    expect(rehydrateMedia).toHaveBeenCalledTimes(2);
    expect(mock.request.mock.calls.filter(([url, input]) => url.pathname === '/v1/files' && input.method === 'POST')).toHaveLength(1);
    await provider.release!(third.continuation!, signal());
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it.each([
    { ...original, bytes: Buffer.alloc(100, 8) }, { ...original, mimeType: 'image/jpeg' }, { ...original, type: 'file' },
    { ...original, bytes: Buffer.alloc(101) }, { ...original, bytes: Buffer.alloc(2 * 1024 * 1024) },
    { ...original, bytes: new Uint8Array(new SharedArrayBuffer(100)) },
    { ...original, url: 'https://evil.com/input' }, { ...original, path: '/private/file' }, { type: 'text', text: 'not media' },
  ])('rejects mismatched or nonopaque resolver output before new uploads/count/inference', async restored => {
    const mock = fixture('anthropic-messages', [original]);
    const first = await mock.provider.generate(message([original]), { signal: signal() });
    const rehydrateMedia = vi.fn(async () => restored as PreparedContent);
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope, rehydrateMedia });
    const before = mock.request.mock.calls.length;
    await expect(provider.generate({ ...message([original]), continuation: first.continuation }, { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false, cleanup: first.cleanup });
    expect(rehydrateMedia).toHaveBeenCalledExactlyOnceWith(sha256, expect.any(AbortSignal));
    expect(mock.request).toHaveBeenCalledTimes(before);
  });

  it('validates the entire reference batch, kind, scope, and active lease before invoking the resolver', async () => {
    const mock = fixture('anthropic-messages', [original, original]);
    const first = await mock.provider.generate(message([original, original]), { signal: signal() });
    const rehydrateMedia = vi.fn(async () => original);
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope, rehydrateMedia });
    const foreign = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: 'other-private-owner', rehydrateMedia });
    const before = mock.request.mock.calls.length;
    await expect(foreign.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    for (const change of [{ sha256: '0'.repeat(64) }, { kind: 'file' as const }, { scope: 'foreign' }]) {
      const continuation = structuredClone(first.continuation!); Object.assign(continuation.files![1]!, change);
      await expect(provider.generate(resumed(continuation), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    }
    const wrongBlock = structuredClone(first.continuation!);
    (wrongBlock.records[0]!.content as Record<string, unknown>[])[0]!.type = 'document';
    await expect(provider.generate(resumed(wrongBlock), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(first.continuation!.files![0]!.expiresAt + 1);
    try { await expect(provider.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH' }); } finally { clock.mockRestore(); }
    expect(rehydrateMedia).not.toHaveBeenCalled(); expect(mock.request).toHaveBeenCalledTimes(before);
  });

  it('rejects combined restored/new encoded bytes above the cap before fetching originals or uploading', async () => {
    const large = { type: 'file' as const, mimeType: 'application/pdf', bytes: Buffer.alloc(600_000) };
    const mock = fixture('anthropic-messages', [large]);
    const first = await mock.provider.generate(message([large]), { signal: signal() });
    const rehydrateMedia = vi.fn(async () => large);
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope, rehydrateMedia });
    const before = mock.request.mock.calls.length;
    await expect(provider.generate({ ...message([{ ...large, bytes: Buffer.alloc(200_000) }]), continuation: first.continuation }, { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE', billable: false });
    const repeated = structuredClone(first.continuation!); repeated.records.push(repeated.records[0]!);
    await expect(provider.generate(resumed(repeated), { signal: signal() })).rejects.toMatchObject({ code: 'TOO_LARGE', billable: false });
    expect(rehydrateMedia).not.toHaveBeenCalled(); expect(mock.request).toHaveBeenCalledTimes(before);
  });

  it('cancels or times out a blocked resolver without any count/new upload and retains cleanup handles', async () => {
    const mock = fixture('anthropic-messages', [original]);
    const first = await mock.provider.generate(message([original]), { signal: signal() });
    const before = mock.request.mock.calls.length;
    let effective: AbortSignal | undefined;
    const rehydrateMedia = vi.fn((_digest: string, currentSignal: AbortSignal) => {
      effective = currentSignal; return new Promise<PreparedContent>(() => {});
    });
    const provider = createAiProvider({ ...profile('anthropic-messages'), limits: { ...profile('anthropic-messages').limits, timeoutMs: 20 } }, { transport: mock.transport, fileScope: scope, rehydrateMedia });
    await expect(provider.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'TIMEOUT', billable: false, cleanup: first.cleanup });
    expect(effective?.aborted).toBe(true);
    const controller = new AbortController();
    const cancelled = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope,
      rehydrateMedia: async () => { controller.abort(); return original; } });
    await expect(cancelled.generate(resumed(first.continuation!), { signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED', billable: false, cleanup: first.cleanup });
    expect(mock.request).toHaveBeenCalledTimes(before);
    await provider.release!(first.continuation!, signal());
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });

  it('rechecks the lease after restoring bytes and never turns an expired lease into a new capability', async () => {
    const mock = fixture('anthropic-messages', [original]);
    const first = await mock.provider.generate(message([original]), { signal: signal() });
    const before = mock.request.mock.calls.length; const clock = vi.spyOn(Date, 'now');
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope,
      rehydrateMedia: async () => { clock.mockReturnValue(first.continuation!.files![0]!.expiresAt + 1); return original; } });
    try { await expect(provider.generate(resumed(first.continuation!), { signal: signal() })).rejects.toMatchObject({ code: 'CONTINUATION_MISMATCH', billable: false }); } finally { clock.mockRestore(); }
    expect(mock.request).toHaveBeenCalledTimes(before);
  });

  it('keeps digestless legacy references cleanup-only rather than guessing an original source', async () => {
    const mock = fixture('anthropic-messages', [original]);
    const first = await mock.provider.generate(message([original]), { signal: signal() }); const ref = first.continuation!.files![0]!;
    const payload = { version: ref.version, protocol: ref.protocol, origin: ref.origin, basePath: ref.basePath, id: ref.id,
      mimeType: ref.mimeType, bytes: ref.bytes, expiresAt: ref.expiresAt, providerExpiresAt: ref.providerExpiresAt, scope: ref.scope };
    const legacy = { ...payload, signature: createHmac('sha256', 'TEST_ONLY_SECRET').update('MisakaProviderFile/v1\0').update(JSON.stringify(payload)).digest('hex') };
    const continuation = { ...first.continuation!, files: [legacy] }; const rehydrateMedia = vi.fn(async () => original);
    const provider = createAiProvider(profile('anthropic-messages'), { transport: mock.transport, fileScope: scope, rehydrateMedia });
    const before = mock.request.mock.calls.length;
    await expect(provider.generate(resumed(continuation), { signal: signal() })).rejects.toMatchObject({ code: 'UNSUPPORTED', billable: false, cleanup: [legacy] });
    expect(rehydrateMedia).not.toHaveBeenCalled(); expect(mock.request).toHaveBeenCalledTimes(before);
    await provider.release!([legacy], signal());
    expect(mock.request.mock.calls.filter(([, input]) => input.method === 'DELETE')).toHaveLength(1);
  });
});
