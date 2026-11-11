import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { abortable } from '../network.js';
import { AiFileCleanupError, type AiProviderDependencies, type GenerationOptions, type GenerationRequest, type NativeContinuation, type PreparedContent, type ProtocolContext, type ProviderFileReference } from './providers.js';
import { AiProtocolError, boundedJson, type AiRequest } from './transport.js';
import { object, string } from './protocol-common.js';

// Files are upstream workspace/project scoped. Only signed, run-bound server references may reuse or delete them.
const leaseMs = 3_600_000;
const googleRetentionMs = 48 * 3_600_000;
function scope(context: ProtocolContext): string {
  if (!context.fileScope) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  return createHash('sha256').update(context.fileScope).digest('hex');
}
function payload(ref: ProviderFileReference): Omit<ProviderFileReference, 'signature'> {
  return { version: ref.version, protocol: ref.protocol, origin: ref.origin, basePath: ref.basePath, id: ref.id,
    mimeType: ref.mimeType, bytes: ref.bytes, expiresAt: ref.expiresAt, providerExpiresAt: ref.providerExpiresAt, scope: ref.scope,
    ...(ref.kind === undefined ? {} : { kind: ref.kind }), ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }) };
}
function sign(context: ProtocolContext, ref: Omit<ProviderFileReference, 'signature'>): string {
  return createHmac('sha256', context.profile.apiKey).update('MisakaProviderFile/v1\0').update(boundedJson(ref, 4096)).digest('hex');
}
function validId(context: ProtocolContext, id: string): boolean {
  return context.profile.protocol === 'google-generate-content' ? /^files\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)
    : context.profile.protocol === 'anthropic-messages' ? /^file_[A-Za-z0-9_-]{1,120}$/.test(id) : /^file-[A-Za-z0-9_-]{1,120}$/.test(id);
}
function check(context: ProtocolContext, refs: readonly ProviderFileReference[], active: boolean): void {
  if (!Array.isArray(refs) || !context.transport.request || refs.length > 8) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const ownedScope = scope(context); const seen = new Set<string>();
  for (const ref of refs) {
    boundedJson(ref, 4096);
    if (Object.keys(ref).some(key => !['version', 'protocol', 'origin', 'basePath', 'id', 'mimeType', 'bytes', 'expiresAt', 'providerExpiresAt', 'scope', 'signature', 'kind', 'sha256'].includes(key))
      || ref.version !== 1 || ref.protocol !== context.profile.protocol || ref.origin !== context.profile.origin || ref.basePath !== context.profile.basePath
      || ref.scope !== ownedScope || typeof ref.id !== 'string' || !validId(context, ref.id) || seen.has(ref.id)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 1_048_576 || !Number.isSafeInteger(ref.expiresAt)
      || ref.providerExpiresAt !== null && (!Number.isSafeInteger(ref.providerExpiresAt) || ref.expiresAt > ref.providerExpiresAt)
      || (ref.kind === undefined) !== (ref.sha256 === undefined)
      || ref.kind !== undefined && (!['image', 'audio', 'file'].includes(ref.kind) || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
      || !/^[a-f0-9]{64}$/.test(ref.signature)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    const expected = sign(context, payload(ref));
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(ref.signature, 'hex'))) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (active && (ref.providerExpiresAt === null || ref.expiresAt <= Date.now())) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    seen.add(ref.id);
  }
}
function reference(context: ProtocolContext, id: string, part: Exclude<PreparedContent, { type: 'text' }>, expires: number | null): ProviderFileReference {
  if (!validId(context, id)) throw new AiProtocolError('INVALID_RESPONSE');
  const ref = { version: 1 as const, protocol: context.profile.protocol, origin: context.profile.origin, basePath: context.profile.basePath!, id,
    mimeType: part.mimeType, bytes: part.bytes.byteLength, expiresAt: Math.min(Date.now() + leaseMs, expires ?? Infinity), providerExpiresAt: expires, scope: scope(context),
    kind: part.type, sha256: createHash('sha256').update(part.bytes).digest('hex') };
  return { ...ref, signature: sign(context, ref) };
}
function headers(context: ProtocolContext): Record<string, string> {
  return context.profile.protocol === 'anthropic-messages' ? { 'x-api-key': context.profile.apiKey, 'anthropic-version': context.profile.anthropicVersion ?? '2026-10-21' }
    : context.profile.protocol === 'google-generate-content' ? { 'x-goog-api-key': context.profile.apiKey } : { authorization: `Bearer ${context.profile.apiKey}` };
}
function uri(context: ProtocolContext, id: string): string { return `${context.profile.origin}/v1beta/${id}`; }
function path(context: ProtocolContext, id: string): string {
  return context.profile.protocol === 'google-generate-content' ? `/v1beta/${id}` : `${context.profile.basePath}/files/${id}`;
}
export function validateContinuation(context: ProtocolContext, continuation: NativeContinuation | undefined): void {
  const refs = continuation?.files ?? [];
  if (refs.length) check(context, refs, true);
  const ids = new Set(refs.map(ref => ref.id)); const uris = new Set(refs.map(ref => uri(context, ref.id)));
  const block = (value: unknown): void => {
    const item = object(value);
    if (['input_image', 'input_file'].includes(String(item.type)) && (!ids.has(String(item.file_id)) || item.image_url !== undefined || item.file_data !== undefined || item.file_url !== undefined)
      || item.type === 'input_audio') throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (item.type === 'image' || item.type === 'document') {
      const source = object(item.source);
      if (source.type !== 'file' || !ids.has(String(source.file_id))) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      const ref = refs.find(ref => ref.id === source.file_id)!;
      if (ref.kind !== undefined && ref.kind !== (item.type === 'image' ? 'image' : 'file')) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    }
    if (item.inlineData !== undefined || item.fileData !== undefined && !uris.has(String(object(item.fileData).fileUri))) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  };
  // Inspect native media positions, not arbitrary tool-result JSON with coincidentally named keys.
  for (const record of continuation?.records ?? []) {
    block(record);
    if (Array.isArray(record.content)) for (const item of record.content) block(item);
    if (Array.isArray(record.parts)) for (const item of record.parts) block(item);
  }
  context.files.push(...refs);
}
export async function rehydrateFiles(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions, reservedBytes: number,
  resolve: AiProviderDependencies['rehydrateMedia']): Promise<void> {
  if (context.profile.protocol !== 'anthropic-messages' || !context.files.length) return;
  // Validate the whole batch before any callback or new upload. A matching digest alone is not authority.
  check(context, context.files, true);
  if (!resolve || context.files.some(ref => !ref.sha256 || !ref.kind)) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  if (context.profile.anthropicVersion !== undefined && context.profile.anthropicVersion !== '2026-10-21') throw new AiProtocolError('UNSUPPORTED', undefined, false);
  let total = reservedBytes;
  for (const ref of context.files) {
    if (!ref.kind || !context.profile.capabilities.input.includes(ref.kind)
      || ref.kind === 'image' && !['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mimeType)
      || ref.kind === 'file' && !['application/pdf', 'text/plain'].includes(ref.mimeType)
      || ref.kind === 'audio') throw new AiProtocolError('UNSUPPORTED', undefined, false);
    let occurrences = 0;
    for (const record of request.continuation?.records ?? []) if (Array.isArray(record.content)) for (const value of record.content) {
      const block = object(value);
      if ((block.type === 'image' || block.type === 'document') && object(block.source).file_id === ref.id) occurrences++;
    }
    total += Math.max(1, occurrences) * (Math.ceil(ref.bytes / 3) * 4 + 4096);
  }
  if (total > context.limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
  for (const ref of context.files) {
    options.signal.throwIfAborted();
    const restored = await abortable(Promise.resolve().then(() => { options.signal.throwIfAborted(); return resolve(ref.sha256!, options.signal); }), options.signal);
    check(context, context.files, true);
    if (!restored || typeof restored !== 'object' || Object.keys(restored).some(key => !['type', 'mimeType', 'bytes', 'filename'].includes(key))
      || restored.type === 'text' || restored.type !== ref.kind || restored.mimeType !== ref.mimeType
      || !(restored.bytes instanceof Uint8Array) || restored.bytes.buffer instanceof SharedArrayBuffer || restored.bytes.byteLength !== ref.bytes
      || restored.filename !== undefined && !/^[A-Za-z0-9._ -]{1,128}$/.test(restored.filename)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    // Copy before hashing; later caller mutations cannot alter the counted content.
    const bytes = Uint8Array.from(restored.bytes);
    if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    options.signal.throwIfAborted();
    context.countMedia.set(ref.id, { type: restored.type, mimeType: restored.mimeType, bytes });
  }
}
export async function releaseFiles(context: ProtocolContext, refs: readonly ProviderFileReference[], signal: AbortSignal): Promise<void> {
  if (!refs.length) return;
  // Validate the entire batch before deleting anything. No raw model/file IDs enter this operation.
  check(context, refs, false);
  const remaining: ProviderFileReference[] = [];
  for (const ref of refs) {
    try {
      const response = await context.transport.request!({ origin: context.profile.origin, path: path(context, ref.id), method: 'DELETE', headers: headers(context) },
        { signal, limits: { requestBytes: 4096, responseBytes: 16_384, timeoutMs: 5000 } });
      if (context.profile.protocol !== 'google-generate-content' && response.status !== 204) {
        const data = object(response.value);
        if (data.id !== ref.id || (context.profile.protocol === 'openai-responses' ? data.deleted !== true : data.type !== 'file_deleted')) throw new AiProtocolError('INVALID_RESPONSE');
      }
    } catch (error) {
      if (!(error instanceof AiProtocolError && error.status === 404)) remaining.push(ref);
    }
  }
  if (remaining.length) throw new AiFileCleanupError(signal.aborted ? 'CANCELLED' : 'NETWORK', remaining);
}
export async function prepareFiles(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions): Promise<void> {
  for (const message of request.messages) for (const part of message.content) {
    if (part.type === 'text') continue;
    if (context.files.length >= 8) throw new AiProtocolError('TOO_LARGE', undefined, false);
    const filename = part.filename ?? (part.type === 'image' ? `input.${part.mimeType.split('/')[1]}` : part.type === 'audio' ? 'input.audio' : part.mimeType === 'application/pdf' ? 'input.pdf' : 'input.txt');
    let ref: ProviderFileReference;
    const uploadOptions = { signal: options.signal, limits: { ...context.limits, responseBytes: 16_384 } };
    if (context.profile.protocol === 'google-generate-content') {
      const id = `files/misaka-${randomBytes(12).toString('hex')}`;
      // This client-chosen name is known even if upload initiation/finalization has an ambiguous outcome.
      ref = reference(context, id, part, null); context.files.push(ref);
      const start = await context.transport.request!({ origin: context.profile.origin, path: '/upload/v1beta/files', method: 'POST', headersOnly: true,
        headers: { ...headers(context), 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start',
          'x-goog-upload-header-content-length': String(part.bytes.byteLength), 'x-goog-upload-header-content-type': part.mimeType },
        body: { file: { name: id, displayName: filename } } }, uploadOptions);
      const location = start.headers['x-goog-upload-url'];
      let upload: URL;
      try {
        if (typeof location !== 'string' || location.length > 2048 || /[\s\\]/.test(location)) throw new Error();
        upload = new URL(location);
        if (upload.origin !== context.profile.origin || upload.username || upload.password || upload.hash || upload.pathname !== '/upload/v1beta/files'
          || upload.searchParams.getAll('upload_id').length !== 1 || !/^[A-Za-z0-9_-]{1,1024}$/.test(upload.searchParams.get('upload_id') ?? '')
          || [...upload.searchParams.keys()].some(key => !['upload_id', 'upload_protocol'].includes(key))
          || upload.searchParams.getAll('upload_protocol').length > 1 || upload.searchParams.has('upload_protocol') && upload.searchParams.get('upload_protocol') !== 'resumable') throw new Error();
      } catch { throw new AiProtocolError('UNSAFE_URL'); }
      let data = object((await context.transport.request!({ origin: context.profile.origin, path: upload.pathname + upload.search, method: 'POST',
        headers: { 'x-goog-upload-offset': '0', 'x-goog-upload-command': 'upload, finalize' }, raw: part.bytes, contentType: part.mimeType }, uploadOptions)).value);
      let file = object(data.file);
      for (let poll = 0; file.state === 'PROCESSING' && poll < 8; poll++) {
        await delay(250, undefined, { signal: options.signal });
        data = object((await context.transport.request!({ origin: context.profile.origin, path: path(context, id), method: 'GET', headers: headers(context) }, uploadOptions)).value);
        file = data;
      }
      if (file.name !== id || file.uri !== uri(context, id) || file.mimeType !== part.mimeType || file.sizeBytes !== String(part.bytes.byteLength)) throw new AiProtocolError('INVALID_RESPONSE');
      if (file.state !== 'ACTIVE') throw new AiProtocolError('INCOMPLETE');
      const expires = Date.parse(string(file.expirationTime));
      if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + googleRetentionMs + 60_000) throw new AiProtocolError('INVALID_RESPONSE');
      ref = reference(context, id, part, expires); context.files[context.files.length - 1] = ref;
      context.media.set(part, { fileData: { mimeType: part.mimeType, fileUri: uri(context, id) } });
    } else {
      const anthropic = context.profile.protocol === 'anthropic-messages';
      const input: AiRequest = { origin: context.profile.origin, path: `${context.profile.basePath}/files`, method: 'POST', headers: headers(context),
        multipart: [{ name: 'file', filename, mimeType: part.mimeType, bytes: part.bytes }, ...(anthropic
          ? [{ name: 'expires_in_seconds', value: '3600' }]
          : [{ name: 'purpose', value: 'user_data' }, { name: 'expires_after[anchor]', value: 'created_at' }, { name: 'expires_after[seconds]', value: '3600' }])] };
      const file = object((await context.transport.request!(input, uploadOptions)).value);
      const id = string(file.id);
      ref = reference(context, id, part, null); context.files.push(ref);
      const expires = anthropic ? Date.parse(string(file.expires_at)) : typeof file.expires_at === 'number' ? file.expires_at * 1000 : NaN;
      if ((anthropic ? file.size_bytes : file.bytes) !== part.bytes.byteLength || anthropic && file.mime_type !== part.mimeType
        || !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + leaseMs + 60_000) throw new AiProtocolError('INVALID_RESPONSE');
      ref = reference(context, id, part, expires); context.files[context.files.length - 1] = ref;
      context.media.set(part, anthropic ? { type: part.type === 'image' ? 'image' : 'document', source: { type: 'file', file_id: id } }
        : { type: part.type === 'image' ? 'input_image' : 'input_file', file_id: id, ...(part.type === 'image' ? { detail: 'auto' } : {}) });
    }
    if (options.onFiles) await abortable(Promise.resolve(options.onFiles(structuredClone(context.files))), options.signal);
  }
}
