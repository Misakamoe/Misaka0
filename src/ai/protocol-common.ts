import { AiProtocolError, boundedJson } from './transport.js';
import type { GeneratedArtifact, GenerationOptions, GenerationResult, GenerationUsage, ProtocolContext, ProviderToolCall } from './providers.js';

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiProtocolError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}
export function list(value: unknown): unknown[] { if (!Array.isArray(value)) throw new AiProtocolError('INVALID_RESPONSE'); return value; }
export function string(value: unknown): string { if (typeof value !== 'string') throw new AiProtocolError('INVALID_RESPONSE'); return value; }
export function parseJson(value: string): unknown { try { return JSON.parse(value) as unknown; } catch { throw new AiProtocolError('INVALID_RESPONSE'); } }
export function index(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1024) throw new AiProtocolError('INVALID_RESPONSE'); return value as number; }
export function token(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new AiProtocolError('INVALID_RESPONSE');
  return value;
}
export function base64(bytes: Uint8Array): string { return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64'); }
export function argumentsObject(value: unknown, context: ProtocolContext): Record<string, unknown> {
  if (typeof value === 'string') {
    if (Buffer.byteLength(value) > context.limits.toolArgumentsBytes) throw new AiProtocolError('TOO_LARGE');
    value = parseJson(value);
  }
  const result = object(value); boundedJson(result, context.limits.toolArgumentsBytes); return result;
}
export class OutputCollector {
  text = ''; textBytes = 0; artifactBytes = 0;
  calls: ProviderToolCall[] = []; artifacts: GeneratedArtifact[] = [];
  usage: GenerationUsage = { billable: 'unknown' };
  constructor(readonly context: ProtocolContext, readonly options: GenerationOptions, readonly toolNames: Set<string>) {}
  async append(value: unknown): Promise<void> {
    const text = string(value);
    if (!text) return;
    if (!this.context.profile.capabilities.output.includes('text')) throw new AiProtocolError('OUTPUT_UNSUPPORTED');
    this.textBytes += Buffer.byteLength(text);
    if (this.textBytes > this.context.limits.textBytes) throw new AiProtocolError('OUTPUT_LIMIT');
    this.options.signal.throwIfAborted(); this.text += text;
    await this.options.onText?.(text, this.options.signal);
  }
  call(id: unknown, name: unknown, args: unknown): void {
    const call = { id: string(id), name: string(name), arguments: argumentsObject(args, this.context) };
    if (!/^[\x21-\x7e]{1,256}$/.test(call.id) || !this.toolNames.has(call.name) || this.calls.some(item => item.id === call.id)) throw new AiProtocolError('INVALID_RESPONSE');
    if (this.calls.length >= this.context.limits.toolCalls) throw new AiProtocolError('TOO_LARGE');
    this.calls.push(call);
  }
  artifact(mime: unknown, data: unknown): void {
    const mimeType = string(mime); const encoded = string(data);
    const type = ['image/png', 'image/jpeg', 'image/webp'].includes(mimeType) ? 'image'
      : /^audio\/(?:wav|mpeg|mp3|ogg|flac|L16(?:;codec=pcm;rate=\d{4,6})?)$/.test(mimeType) ? 'audio'
        : ['application/pdf', 'text/plain'].includes(mimeType) ? 'file' : undefined;
    if (!type || !this.context.profile.capabilities.output.includes(type)) throw new AiProtocolError('UNSUPPORTED');
    if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new AiProtocolError('INVALID_RESPONSE');
    const size = encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
    this.artifactBytes += size;
    if (this.artifactBytes > this.context.limits.artifactBytes || this.artifacts.length >= 4) throw new AiProtocolError('TOO_LARGE');
    this.artifacts.push({ type, mimeType, bytes: Buffer.from(encoded, 'base64') });
  }
  finish(records: Record<string, unknown>[]): GenerationResult {
    const { protocol, origin, model } = this.context.profile;
    const continuation = { version: 1 as const, protocol, origin, model, binding: this.context.binding, basePath: this.context.profile.basePath, records,
      pending: this.calls.map(({ id, name }) => ({ id, name })), ...(this.context.files.length ? { files: this.context.files } : {}) };
    const usage: GenerationUsage = { billable: this.usage.billable };
    for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cachedInputTokens'] as const) {
      if (this.usage[key] !== undefined) usage[key] = token(this.usage[key]);
    }
    if (this.artifacts.length) {
      if (this.calls.length) throw new AiProtocolError('UNSUPPORTED');
      // Native generated media may not have a replayable file handle. This is terminal output, not a stripped prefix.
      return { text: this.text, toolCalls: [], usage, artifacts: this.artifacts, ...(this.context.files.length ? { cleanup: this.context.files } : {}) };
    }
    try { boundedJson(continuation, this.context.limits.continuationBytes); }
    catch (error) {
      // A complete text answer needs no replay buffer. Pending tool calls must retain theirs intact.
      if (this.calls.length || !(error instanceof AiProtocolError) || error.code !== 'TOO_LARGE') throw error;
      return { text: this.text, toolCalls: [], usage, ...(this.context.files.length ? { cleanup: this.context.files } : {}) };
    }
    return { text: this.text, toolCalls: this.calls, usage, continuation, ...(this.context.files.length ? { cleanup: this.context.files } : {}) };
  }
}
