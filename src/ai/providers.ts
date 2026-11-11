import { createHash } from 'node:crypto';
import { AiProtocolError, approvedHttpsOrigin, boundedJson, createAiTransport, protocolLimits, type AiErrorCode, type AiTransport, type ProtocolLimits } from './transport.js';

export type ProviderProtocol = 'openai-responses' | 'anthropic-messages' | 'google-generate-content' | 'openai-chat-completions';
export type Modality = 'text' | 'image' | 'audio' | 'file';
// Only trusted capture adapters construct these. No filesystem paths, fetchable URLs or Telegram URLs.
export type PreparedContent = { type: 'text'; text: string } | {
  type: 'image' | 'audio' | 'file'; mimeType: string; bytes: Uint8Array; filename?: string;
};
export interface ProviderProfile {
  protocol: ProviderProtocol; origin: string; model: string; apiKey: string;
  /** Endpoint directory, including its API version. Root/omitted uses the protocol default. */
  basePath?: string;
  capabilities: { input: readonly Modality[]; output: readonly Modality[] };
  limits?: Partial<ProtocolLimits>;
  /** Explicit native API version; defaults to the version checked against current docs. */
  anthropicVersion?: string;
  /** Required for Fable; configuring the model alone does not authorize its 30-day retention. */
  retention?: 'standard' | 'fable-30-days-approved';
  /** Only an explicitly approved OpenAI image-generation tool may be sent upstream. */
  imageGeneration?: { model: string; outputFormat: 'png' | 'jpeg' | 'webp' };
  /** Google speech output needs an administrator-selected voice, never a live endpoint. */
  audioVoice?: string;
  /** Compatible chat defaults to max_tokens; newer OpenAI chat models can explicitly select the alternate field. */
  chatTokenLimit?: 'max_tokens' | 'max_completion_tokens';
}
export interface ProviderTool { name: string; description: string; inputSchema: Record<string, unknown> }
export interface ProviderToolCall { id: string; name: string; arguments: Record<string, unknown> }
export interface ProviderToolResult { id: string; name: string; result: unknown }
export interface NativeContinuation {
  version: 1; protocol: ProviderProtocol; origin: string; model: string; binding: string; basePath?: string;
  /** Native records include private reasoning/signatures. Persist encrypted; never render to users. */
  records: Record<string, unknown>[];
  pending: { id: string; name: string }[];
  files?: ProviderFileReference[];
}
export interface ProviderFileReference {
  version: 1; protocol: ProviderProtocol; origin: string; basePath: string; id: string; mimeType: string; bytes: number;
  expiresAt: number; providerExpiresAt: number | null; scope: string; signature: string;
  /** Present on new uploads and covered by the MAC. Legacy references without these cannot be rehydrated. */
  kind?: Exclude<Modality, 'text'>; sha256?: string;
}
export class AiFileCleanupError extends AiProtocolError {
  constructor(code: AiErrorCode, readonly cleanup: ProviderFileReference[], billable: boolean | 'unknown' = 'unknown') { super(code, undefined, billable); }
}
export interface GenerationRequest {
  system?: string;
  /** Initial history, or NEW messages only when using continuation. The native prefix is immutable. */
  messages: { role: 'user' | 'assistant'; content: PreparedContent[] }[];
  tools?: ProviderTool[]; toolResults?: ProviderToolResult[]; continuation?: NativeContinuation; maxOutputTokens?: number;
  /** Remaining input-token allowance for this full inference, not a delta or price. Media defaults to 32768 when omitted. */
  maxInputTokens?: number;
}
export interface GenerationUsage { inputTokens?: number; outputTokens?: number; totalTokens?: number; cachedInputTokens?: number; billable: boolean | 'unknown' }
export interface GeneratedArtifact { type: 'image' | 'audio' | 'file'; mimeType: string; bytes: Uint8Array }
export interface GenerationResult { text: string; toolCalls: ProviderToolCall[]; usage: GenerationUsage; continuation?: NativeContinuation; artifacts?: GeneratedArtifact[]; cleanup?: ProviderFileReference[] }
export interface GenerationOptions {
  signal: AbortSignal; onText?: (delta: string, signal: AbortSignal) => void | Promise<void>;
  /** Trusted checkpoint hook. Never send these signed references to a model or user. */
  onFiles?: (files: readonly ProviderFileReference[]) => void | Promise<void>;
}
export interface AiProvider {
  generate(request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult>;
  release?(references: NativeContinuation | readonly ProviderFileReference[], signal: AbortSignal): Promise<void>;
}
export interface ProtocolContext {
  profile: ProviderProfile; limits: ProtocolLimits; binding: string; transport: AiTransport; fileScope?: string;
  files: ProviderFileReference[]; media: Map<PreparedContent, Record<string, unknown>>; inferenceStarted: boolean;
  countMedia: Map<string, Exclude<PreparedContent, { type: 'text' }>>;
}
export interface AiProviderDependencies {
  transport?: AiTransport; fileScope?: string;
  /** Resolve exact original bytes from this admitted run only, never a model-supplied path or URL. */
  rehydrateMedia?: (sha256: string, signal: AbortSignal) => Promise<PreparedContent>;
}

export function createAiProvider(input: ProviderProfile, dependencies: AiProviderDependencies = {}): AiProvider {
  keys(input, ['protocol', 'origin', 'basePath', 'model', 'apiKey', 'capabilities', 'limits', 'anthropicVersion', 'retention', 'imageGeneration', 'audioVoice', 'chatTokenLimit']);
  keys(input.capabilities, ['input', 'output']);
  // Snapshot the reviewed settings so mutation during a stream cannot change the credential destination.
  const profile = structuredClone(input);
  profile.origin = approvedHttpsOrigin(profile.origin);
  profile.basePath = providerBasePath(profile.protocol, profile.basePath);
  if (!['openai-responses', 'openai-chat-completions', 'anthropic-messages', 'google-generate-content'].includes(profile.protocol)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(profile.model)
    || !profile.apiKey || profile.apiKey.length > 2048 || /[^\x21-\x7e]/.test(profile.apiKey)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  if (profile.protocol === 'anthropic-messages' && profile.origin !== 'https://api.anthropic.com'
    || profile.protocol === 'google-generate-content' && profile.origin !== 'https://generativelanguage.googleapis.com') throw new AiProtocolError('UNSAFE_URL', undefined, false);
  if (profile.model.startsWith('claude-fable-') && profile.retention !== 'fable-30-days-approved') throw new AiProtocolError('UNSUPPORTED', undefined, false);
  for (const values of [profile.capabilities.input, profile.capabilities.output]) {
    if (!Array.isArray(values) || !values.length || values.some(value => !['text', 'image', 'audio', 'file'].includes(value))) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  }
  if (profile.anthropicVersion !== undefined && (profile.protocol !== 'anthropic-messages' || !/^\d{4}-\d{2}-\d{2}$/.test(profile.anthropicVersion))) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  if (profile.retention !== undefined && !['standard', 'fable-30-days-approved'].includes(profile.retention)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  if (profile.chatTokenLimit !== undefined && (profile.protocol !== 'openai-chat-completions' || !['max_tokens', 'max_completion_tokens'].includes(profile.chatTokenLimit))) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  if (profile.imageGeneration && (profile.protocol !== 'openai-responses' || !profile.capabilities.output.includes('image')
    || !/^[a-zA-Z0-9._-]{1,100}$/.test(profile.imageGeneration.model) || !['png', 'jpeg', 'webp'].includes(profile.imageGeneration.outputFormat))) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  if (profile.audioVoice && (profile.protocol !== 'google-generate-content' || !profile.capabilities.output.includes('audio')
    || !/^[a-zA-Z0-9_-]{1,64}$/.test(profile.audioVoice))) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  if ((profile.protocol === 'anthropic-messages' || profile.protocol === 'openai-chat-completions') && profile.capabilities.output.some(type => type !== 'text')
    || profile.protocol === 'openai-responses' && profile.capabilities.output.some(type => type !== 'text' && !(type === 'image' && profile.imageGeneration))
    || profile.capabilities.output.includes('file')) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const limits = protocolLimits(profile.limits);
  limits.requestBytes = Math.min(limits.requestBytes, 1_048_576);
  const transport = dependencies.transport ?? createAiTransport();
  const fileScope = dependencies.fileScope;
  const rehydrateMedia = dependencies.rehydrateMedia;
  if (fileScope !== undefined && (typeof fileScope !== 'string' || !fileScope || Buffer.byteLength(fileScope) > 512)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  if (rehydrateMedia !== undefined && typeof rehydrateMedia !== 'function') throw new AiProtocolError('INVALID_INPUT', undefined, false);
  const contextFor = (binding: string): ProtocolContext => ({ profile, limits, binding, transport, fileScope, files: [], media: new Map(), countMedia: new Map(), inferenceStarted: false });
  return { async generate(request, options) {
    keys(request, ['system', 'messages', 'tools', 'toolResults', 'continuation', 'maxOutputTokens', 'maxInputTokens']);
    if (options.signal.aborted) throw new AiProtocolError('CANCELLED', undefined, false);
    if (request.maxInputTokens !== undefined && (!Number.isSafeInteger(request.maxInputTokens) || request.maxInputTokens < 0 || request.maxInputTokens > 32_768)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
    if (request.maxInputTokens === 0) throw new AiProtocolError('QUOTA', undefined, false);
    if (!Array.isArray(request.messages) || request.messages.length > 128 || (request.tools?.length ?? 0) > 64
      || (request.toolResults?.length ?? 0) > limits.toolCalls) throw new AiProtocolError('TOO_LARGE', undefined, false);
    let bytes = 0; let parts = 0; let mediaCount = 0;
    for (const message of request.messages) {
      keys(message, ['role', 'content']);
      if (!['user', 'assistant'].includes(message.role) || !Array.isArray(message.content) || !message.content.length) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      for (const part of message.content) {
        keys(part, part.type === 'text' ? ['type', 'text'] : ['type', 'mimeType', 'bytes', 'filename']);
        if (++parts > 256 || !profile.capabilities.input.includes(part.type)) throw new AiProtocolError('UNSUPPORTED', undefined, false);
        if (part.type === 'text') {
          if (typeof part.text !== 'string') throw new AiProtocolError('INVALID_INPUT', undefined, false);
          bytes += Buffer.byteLength(part.text);
        } else {
          if (!(part.bytes instanceof Uint8Array) || part.bytes.buffer instanceof SharedArrayBuffer || !part.bytes.byteLength || !validInputMime(part.type, part.mimeType)
            || part.filename !== undefined && !/^[A-Za-z0-9._ -]{1,128}$/.test(part.filename)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
          if (++mediaCount > 8 || message.role !== 'user') throw new AiProtocolError('UNSUPPORTED', undefined, false);
          if (profile.protocol === 'openai-responses' && part.type === 'audio'
            || profile.protocol === 'anthropic-messages' && part.type === 'audio'
            || profile.protocol === 'google-generate-content' && part.mimeType === 'image/gif'
            || profile.protocol === 'anthropic-messages' && profile.anthropicVersion !== undefined && profile.anthropicVersion !== '2026-10-21'
            || profile.protocol === 'openai-chat-completions' && (part.type === 'file' || part.type === 'audio' && !['audio/wav', 'audio/mpeg', 'audio/mp3'].includes(part.mimeType))) throw new AiProtocolError('UNSUPPORTED', undefined, false);
          // An arbitrary compatible model need not tokenize compressed media in proportion to encoded bytes.
          if (profile.protocol === 'openai-chat-completions') throw new AiProtocolError('UNSUPPORTED', undefined, false);
          if (!fileScope || !transport.request
            || profile.protocol === 'openai-responses' && (profile.origin !== 'https://api.openai.com' || profile.basePath !== '/v1')) throw new AiProtocolError('UNSUPPORTED', undefined, false);
          bytes += (profile.protocol === 'anthropic-messages' ? Math.ceil(part.bytes.byteLength / 3) * 4 : part.bytes.byteLength) + 4096;
        }
        if (bytes > limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
      }
    }
    const names = new Set<string>();
    for (const tool of request.tools ?? []) {
      keys(tool, ['name', 'description', 'inputSchema']);
      if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || names.has(tool.name) || typeof tool.description !== 'string'
        || tool.inputSchema.type !== 'object') throw new AiProtocolError('INVALID_INPUT', undefined, false);
      boundedJson(tool, limits.toolArgumentsBytes); names.add(tool.name);
    }
    if (request.system !== undefined && (typeof request.system !== 'string' || Buffer.byteLength(request.system) > limits.requestBytes)) throw new AiProtocolError('TOO_LARGE', undefined, false);
    if (request.maxOutputTokens !== undefined && (!Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens < 1 || request.maxOutputTokens > 32_768)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
    if (profile.protocol === 'anthropic-messages' && request.messages.at(-1)?.role === 'assistant') throw new AiProtocolError('UNSUPPORTED', undefined, false);
    if (profile.capabilities.output.some(type => type !== 'text') && request.tools?.length) throw new AiProtocolError('UNSUPPORTED', undefined, false);
    const binding = createHash('sha256').update(boundedJson({ system: request.system ?? '', tools: request.tools ?? [], capabilities: profile.capabilities,
      imageGeneration: profile.imageGeneration ?? null, audioVoice: profile.audioVoice ?? null, retention: profile.retention ?? null, basePath: profile.basePath }, limits.requestBytes)).digest('hex');
    const continuation = request.continuation;
    if (continuation) {
      boundedJson(continuation, limits.continuationBytes);
      if (continuation.version !== 1 || continuation.origin !== profile.origin || continuation.model !== profile.model
        || continuation.protocol !== profile.protocol || continuation.binding !== binding || !Array.isArray(continuation.records)
        || providerBasePath(continuation.protocol, continuation.basePath) !== profile.basePath
        || !Array.isArray(continuation.pending)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    }
    const pending = continuation?.pending ?? [];
    const results = request.toolResults ?? [];
    if (pending.length !== results.length || results.some((item, index) => item.id !== pending[index]?.id || item.name !== pending[index]?.name)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    for (const result of results) { keys(result, ['id', 'name', 'result']); boundedJson(result, limits.toolArgumentsBytes); }
    bytes += Buffer.byteLength(boundedJson({ system: request.system ?? '', tools: request.tools ?? [], results, continuation: continuation ?? null }, limits.requestBytes));
    if (bytes > limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
    const compact = request.messages.map(message => ({ role: message.role, content: message.content.map(part => part.type === 'text' ? part : { reference: 'x'.repeat(1536) }) }));
    // Admission reserves space for a small response before any upload or billable inference.
    boundedJson({ records: [...continuation?.records ?? [], ...compact], files: continuation?.files ?? [], reserved: 'x'.repeat(2048) }, limits.continuationBytes);
    // A callback or caller mutation during Count Tokens must not change the later inference payload/budget.
    request = structuredClone(request);
    const context = contextFor(binding);
    if (mediaCount + (continuation?.files?.length ?? 0) > 8) throw new AiProtocolError('TOO_LARGE', undefined, false);
    const files = profile.protocol !== 'openai-chat-completions' && (mediaCount || continuation) ? await import('./protocol-files.js') : undefined;
    if (files) files.validateContinuation(context, request.continuation);
    // No provider SDKs or protocol execution code enters the idle application graph.
    const adapter = profile.protocol === 'anthropic-messages' ? await import('./protocol-anthropic.js')
      : profile.protocol === 'google-generate-content' ? await import('./protocol-google.js') : await import('./protocol-openai.js');
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), limits.timeoutMs); timer.unref();
    const effective = { ...options, signal: AbortSignal.any([options.signal, deadline.signal]) };
    const retained = context.files.length;
    try {
      if (files) {
        await files.rehydrateFiles(context, request, effective, bytes, rehydrateMedia);
        await files.prepareFiles(context, request, effective);
      }
      return await adapter.generate(context, request, effective);
    } catch (error) {
      const code = options.signal.aborted ? 'CANCELLED' : deadline.signal.aborted ? 'TIMEOUT' : error instanceof AiProtocolError ? error.code : 'NETWORK';
      // false means no inference was dispatched, not a claim about file-storage or count-API prices.
      const billable = context.inferenceStarted ? 'unknown' : false;
      if (files && context.files.length > retained) {
        try { await files.releaseFiles(context, context.files.slice(retained), AbortSignal.timeout(5000)); }
        catch (cleanup) {
          if (cleanup instanceof AiFileCleanupError) throw new AiFileCleanupError(code, [...context.files.slice(0, retained), ...cleanup.cleanup], billable);
          throw cleanup;
        }
      }
      if (!context.inferenceStarted && retained) throw new AiFileCleanupError(code, structuredClone(context.files.slice(0, retained)), false);
      throw new AiProtocolError(code, error instanceof AiProtocolError ? error.status : undefined, billable);
    } finally { clearTimeout(timer); context.countMedia.clear(); context.media.clear(); }
  }, async release(references, signal) {
    const values = Array.isArray(references) ? references : (references as NativeContinuation).files ?? [];
    if (!values.length) return;
    const files = await import('./protocol-files.js');
    await files.releaseFiles(contextFor(''), values, signal);
  } };
}
export function providerBasePath(protocol: ProviderProtocol, input = ''): string {
  const fallback = protocol === 'google-generate-content' ? '/v1beta' : '/v1';
  if (typeof input !== 'string' || input.length > 256 || input && (!/^\/(?:[A-Za-z0-9._~-]+\/?)*$/.test(input)
    || input.split('/').some(segment => segment === '.' || segment === '..'))) throw new AiProtocolError('UNSAFE_URL', undefined, false);
  const path = !input || input === '/' ? fallback : input.replace(/\/$/, '');
  if ((protocol === 'anthropic-messages' || protocol === 'google-generate-content') && path !== fallback) throw new AiProtocolError('UNSAFE_URL', undefined, false);
  return path;
}
function keys(value: unknown, allowed: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new AiProtocolError('INVALID_INPUT', undefined, false);
}
function validInputMime(type: Exclude<Modality, 'text'>, mime: string): boolean {
  return type === 'image' ? ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mime)
    : type === 'audio' ? ['audio/wav', 'audio/mpeg', 'audio/mp3', 'audio/ogg', 'audio/flac', 'audio/aac'].includes(mime)
      : ['application/pdf', 'text/plain'].includes(mime);
}
