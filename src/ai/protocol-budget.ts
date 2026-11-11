import type { GenerationOptions, GenerationRequest, PreparedContent, ProtocolContext } from './providers.js';
import { AiProtocolError, boundedJson } from './transport.js';
import { base64, object } from './protocol-common.js';

// These are admission counts, not usage receipts. No fee is inferred from a count response.
export async function enforceInputBudget(context: ProtocolContext, request: GenerationRequest, body: Record<string, unknown>, options: GenerationOptions): Promise<void> {
  const media = context.files.length > 0 || request.messages.some(message => message.content.some(part => part.type !== 'text'));
  if (!media) {
    if (context.profile.protocol === 'openai-chat-completions') {
      const records = body.messages as Record<string, unknown>[];
      if (records.some(record => Array.isArray(record.content) && record.content.some(value => object(value).type !== 'text'))) throw new AiProtocolError('UNSUPPORTED', undefined, false);
    }
    // Text-only callers can use the conservative encoded-byte bound without a second API request.
    if (request.maxInputTokens !== undefined && Buffer.byteLength(boundedJson(body, context.limits.requestBytes)) > request.maxInputTokens) throw new AiProtocolError('QUOTA', undefined, false);
    return;
  }
  const { protocol, origin, basePath, model, apiKey } = context.profile;
  const limit = request.maxInputTokens ?? 32_768;
  let path: string; let headers: Record<string, string>; let countBody: Record<string, unknown>;
  if (protocol === 'openai-responses') {
    if (origin !== 'https://api.openai.com' || basePath !== '/v1') throw new AiProtocolError('UNSUPPORTED', undefined, false);
    path = `${basePath}/responses/input_tokens`; headers = { authorization: `Bearer ${apiKey}` };
    countBody = { model, input: body.input, tools: body.tools, ...(body.instructions === undefined ? {} : { instructions: body.instructions }), truncation: 'disabled' };
  } else if (protocol === 'anthropic-messages') {
    path = `${basePath}/messages/count_tokens`; headers = { 'x-api-key': apiKey, 'anthropic-version': context.profile.anthropicVersion ?? '2026-10-21' };
    const originals = new Map<string, Exclude<PreparedContent, { type: 'text' }>>(context.countMedia);
    context.countMedia.clear();
    for (const [part, native] of context.media) if (part.type !== 'text') originals.set(String(object(native.source).file_id), part);
    const messages = structuredClone(body.messages) as Record<string, unknown>[];
    const converted = new Set<Record<string, unknown>>();
    for (const message of messages) if (Array.isArray(message.content)) for (const value of message.content) {
      const block = object(value);
      if (block.type !== 'image' && block.type !== 'document') continue;
      // structuredClone preserves aliases when one native part occurs more than once.
      if (converted.has(block)) continue;
      converted.add(block);
      const source = object(block.source); const original = originals.get(String(source.file_id));
      // Official count guide excludes file/url sources even though the general input schema lists them.
      if (source.type !== 'file' || !original) throw new AiProtocolError('UNSUPPORTED', undefined, false);
      if (original.mimeType === 'text/plain') {
        try { block.source = { type: 'text', media_type: 'text/plain', data: new TextDecoder('utf-8', { fatal: true }).decode(original.bytes) }; }
        catch { throw new AiProtocolError('INVALID_INPUT', undefined, false); }
      } else block.source = { type: 'base64', media_type: original.mimeType, data: base64(original.bytes) };
    }
    countBody = { model, messages, tools: body.tools, ...(body.system === undefined ? {} : { system: body.system }) };
  } else if (protocol === 'google-generate-content') {
    path = `${basePath}/models/${encodeURIComponent(model)}:countTokens`; headers = { 'x-goog-api-key': apiKey };
    // contents alone omits system instructions and function declarations. Count the entire native request.
    countBody = { generateContentRequest: { ...body, model: `models/${model}` } };
  } else throw new AiProtocolError('UNSUPPORTED', undefined, false);
  boundedJson(countBody, context.limits.requestBytes);
  if (context.files.some(ref => ref.expiresAt <= Date.now())) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  options.signal.throwIfAborted();
  let result: Record<string, unknown>;
  try {
    result = object(await context.transport.post({ origin, path, headers, body: countBody }, {
      signal: options.signal, limits: { ...context.limits, responseBytes: 16_384 },
    }));
  } catch (error) {
    if (error instanceof AiProtocolError && [400, 404, 405, 501].includes(error.status ?? 0)) throw new AiProtocolError('UNSUPPORTED', error.status, false);
    throw error;
  }
  options.signal.throwIfAborted();
  if (context.files.some(ref => ref.expiresAt <= Date.now())) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  const count = protocol === 'google-generate-content' ? result.totalTokens : result.input_tokens;
  if (result.error !== undefined || protocol === 'openai-responses' && result.object !== 'response.input_tokens'
    || typeof count !== 'number' || !Number.isSafeInteger(count) || count <= 0) throw new AiProtocolError('INVALID_RESPONSE', undefined, false);
  if (count > limit) throw new AiProtocolError('QUOTA', undefined, false);
}
