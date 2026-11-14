import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { abortable } from '../network.js';
import { AiFileCleanupError, inlineImageTransport, type AiProviderDependencies, type GenerationOptions, type GenerationRequest, type NativeContinuation, type PreparedContent, type ProtocolContext, type ProviderFileReference } from './providers.js';
import { AiProtocolError, boundedJson, type AiRequest } from './transport.js';
import { object, string } from './protocol-common.js';

// Files are upstream workspace/project scoped. Only signed, run-bound server references may reuse or delete them.
const leaseMs = 3_600_000;
const googleRetentionMs = 48 * 3_600_000;
const imageMimes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
function scope(context: ProtocolContext): string {
  if (!context.fileScope) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  return createHash('sha256').update(context.fileScope).digest('hex');
}
function payload(ref: ProviderFileReference): Omit<ProviderFileReference, 'signature'> {
  return { version: ref.version, protocol: ref.protocol, origin: ref.origin, basePath: ref.basePath, id: ref.id,
    mimeType: ref.mimeType, bytes: ref.bytes, expiresAt: ref.expiresAt, providerExpiresAt: ref.providerExpiresAt, scope: ref.scope,
    ...(ref.kind === undefined ? {} : { kind: ref.kind }), ...(ref.sha256 === undefined ? {} : { sha256: ref.sha256 }),
    ...(ref.storage === undefined ? {} : { storage: ref.storage }) };
}
function sign(context: ProtocolContext, ref: Omit<ProviderFileReference, 'signature'>): string {
  return createHmac('sha256', context.profile.apiKey).update('MisakaProviderFile/v1\0').update(boundedJson(ref, 4096)).digest('hex');
}
function validId(context: ProtocolContext, id: string, storage?: 'inline'): boolean {
  return storage === 'inline' ? /^inline-[a-f0-9]{24}$/.test(id)
    : context.profile.protocol === 'google-generate-content' ? /^files\/[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(id)
    : context.profile.protocol === 'anthropic-messages' ? /^file_[A-Za-z0-9_-]{1,120}$/.test(id) : /^file-[A-Za-z0-9_-]{1,120}$/.test(id);
}
function check(context: ProtocolContext, refs: readonly ProviderFileReference[], active: boolean): void {
  if (!Array.isArray(refs) || refs.length > 8) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const ownedScope = scope(context); const seen = new Set<string>();
  for (const ref of refs) {
    boundedJson(ref, 4096);
    if (!ref || typeof ref !== 'object' || Object.keys(ref).some(key => !['version', 'protocol', 'origin', 'basePath', 'id', 'mimeType', 'bytes', 'expiresAt', 'providerExpiresAt', 'scope', 'signature', 'kind', 'sha256', 'storage'].includes(key))
      || ref.version !== 1 || ref.protocol !== context.profile.protocol || ref.origin !== context.profile.origin || ref.basePath !== context.profile.basePath
      || ref.scope !== ownedScope || typeof ref.id !== 'string' || !validId(context, ref.id, ref.storage) || seen.has(ref.id)
      || ref.storage !== undefined && ref.storage !== 'inline'
      || (ref.storage === 'inline') !== inlineImageTransport(context.profile)
      || ref.storage === 'inline' && (ref.kind !== 'image' || !imageMimes.includes(ref.mimeType) || ref.providerExpiresAt !== null || ref.expiresAt > Date.now() + leaseMs)
      || !Number.isSafeInteger(ref.bytes) || ref.bytes < 1 || ref.bytes > 1_048_576 || !Number.isSafeInteger(ref.expiresAt)
      || ref.providerExpiresAt !== null && (!Number.isSafeInteger(ref.providerExpiresAt) || ref.expiresAt > ref.providerExpiresAt)
      || (ref.kind === undefined) !== (ref.sha256 === undefined)
      || ref.kind !== undefined && (!['image', 'audio', 'file'].includes(ref.kind) || typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256))
      || typeof ref.signature !== 'string' || !/^[a-f0-9]{64}$/.test(ref.signature)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    const expected = sign(context, payload(ref));
    if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(ref.signature, 'hex'))) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (active && (ref.storage !== 'inline' && ref.providerExpiresAt === null || ref.expiresAt <= Date.now())) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    seen.add(ref.id);
  }
  if (refs.some(ref => ref.storage !== 'inline') && !context.transport.request) throw new AiProtocolError('UNSUPPORTED', undefined, false);
}
function reference(context: ProtocolContext, id: string, part: Exclude<PreparedContent, { type: 'text' }>, expires: number | null, storage?: 'inline'): ProviderFileReference {
  if (!validId(context, id, storage)) throw new AiProtocolError('INVALID_RESPONSE');
  const ref = { version: 1 as const, protocol: context.profile.protocol, origin: context.profile.origin, basePath: context.profile.basePath!, id,
    mimeType: part.mimeType, bytes: part.bytes.byteLength, expiresAt: Math.min(Date.now() + leaseMs, expires ?? Infinity), providerExpiresAt: expires, scope: scope(context),
    kind: part.type, sha256: createHash('sha256').update(part.bytes).digest('hex'), ...(storage === undefined ? {} : { storage }) };
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
function inspectMedia(context: ProtocolContext, records: Record<string, unknown>[], refs: readonly ProviderFileReference[],
  inline?: (item: Record<string, unknown>, ref: ProviderFileReference) => void): Map<string, number> {
  const ids = new Map(refs.map(ref => [ref.id, ref])); const uris = new Map(refs.map(ref => [uri(context, ref.id), ref]));
  const occurrences = new Map<string, number>(); let count = 0;
  const used = (ref: ProviderFileReference): void => {
    if (++count > 8) throw new AiProtocolError('TOO_LARGE', undefined, false);
    occurrences.set(ref.id, (occurrences.get(ref.id) ?? 0) + 1);
  };
  const block = (value: unknown, user = false): void => {
    const item = object(value);
    if (inlineImageTransport(context.profile)) {
      const chat = context.profile.protocol === 'openai-chat-completions';
      if (item.type === (chat ? 'image_url' : 'input_image')) {
        const source = chat && item.image_url && typeof item.image_url === 'object' && !Array.isArray(item.image_url) ? object(item.image_url) : {};
        const url = chat ? source.url : item.image_url;
        const ref = typeof url === 'string' && url.startsWith('misaka-inline:') ? ids.get(url.slice('misaka-inline:'.length)) : undefined;
        if (!user || !ref || ref.storage !== 'inline' || ref.kind !== 'image'
          || Object.keys(item).some(key => !(chat ? ['type', 'image_url'] : ['type', 'image_url', 'detail']).includes(key))
          || (chat ? Object.keys(source).some(key => key !== 'url') : item.detail !== 'auto')) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
        used(ref); inline?.(item, ref); return;
      }
      if (['input_image', 'input_file', 'input_audio', 'image_url', 'image', 'document', 'file', 'audio', 'video', 'video_url'].includes(String(item.type))
        || ['image_url', 'input_audio', 'file_id', 'file_data', 'file_url', 'inlineData', 'fileData', 'audio'].some(key => item[key] !== undefined)) {
        throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      }
      return;
    }
    if (['input_image', 'input_file'].includes(String(item.type))) {
      const ref = ids.get(String(item.file_id));
      if (!ref || ref.storage !== undefined || ref.kind !== undefined && ref.kind !== (item.type === 'input_image' ? 'image' : 'file')
        || item.image_url !== undefined || item.file_data !== undefined || item.file_url !== undefined) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      used(ref);
    }
    if (item.type === 'input_audio' || item.type === 'image_url') throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (item.type === 'image' || item.type === 'document') {
      const source = object(item.source);
      if (source.type !== 'file' || !ids.has(String(source.file_id))) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      const ref = ids.get(String(source.file_id))!;
      if (ref.kind !== undefined && ref.kind !== (item.type === 'image' ? 'image' : 'file')) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      used(ref);
    }
    if (item.inlineData !== undefined) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (item.fileData !== undefined) {
      const ref = uris.get(String(object(item.fileData).fileUri));
      if (!ref) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      used(ref);
    }
  };
  // Inspect native media positions, not arbitrary tool-result JSON with coincidentally named keys.
  for (const record of records) {
    block(record);
    if (inlineImageTransport(context.profile) && (record.role === 'tool' || record.type === 'function_call_output')) {
      if (typeof (record.role === 'tool' ? record.content : record.output) !== 'string') {
        throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
      }
      continue;
    }
    if (Array.isArray(record.content)) for (const item of record.content) block(item, record.role === 'user');
    if (Array.isArray(record.parts)) for (const item of record.parts) block(item);
  }
  return occurrences;
}
export function validateContinuation(context: ProtocolContext, continuation: NativeContinuation | undefined): void {
  const refs = continuation?.files ?? [];
  if (!Array.isArray(refs)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  if (refs.length) check(context, refs, true);
  inspectMedia(context, continuation?.records ?? [], refs);
  context.files.push(...refs);
}
function restoredBytes(ref: ProviderFileReference, restored: PreparedContent): Uint8Array {
  if (!restored || typeof restored !== 'object' || Object.keys(restored).some(key => !['type', 'mimeType', 'bytes', 'filename'].includes(key))
    || restored.type === 'text' || restored.type !== ref.kind || restored.mimeType !== ref.mimeType
    || !(restored.bytes instanceof Uint8Array) || restored.bytes.buffer instanceof SharedArrayBuffer || restored.bytes.byteLength !== ref.bytes
    || restored.filename !== undefined && !/^[A-Za-z0-9._ -]{1,128}$/.test(restored.filename)) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  // Copy before hashing; later caller mutations cannot alter the admitted content.
  const bytes = Uint8Array.from(restored.bytes);
  if (createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
  return bytes;
}
export async function rehydrateFiles(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions, reservedBytes: number,
  resolve: AiProviderDependencies['rehydrateMedia']): Promise<void> {
  if (!context.files.length || context.profile.protocol !== 'anthropic-messages' && !inlineImageTransport(context.profile)) return;
  // Validate the whole batch before any callback or new upload. A matching digest alone is not authority.
  check(context, context.files, true);
  if (!resolve || context.files.some(ref => !ref.sha256 || !ref.kind)) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  if (context.profile.protocol === 'anthropic-messages' && context.profile.anthropicVersion !== undefined && context.profile.anthropicVersion !== '2026-10-21') throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const occurrences = inspectMedia(context, request.continuation?.records ?? [], context.files);
  const newCount = request.messages.reduce((count, message) => count + message.content.filter(part => part.type !== 'text').length, 0);
  if ([...occurrences.values()].reduce((count, value) => count + value, newCount) > 8) throw new AiProtocolError('TOO_LARGE', undefined, false);
  if (!Number.isSafeInteger(reservedBytes) || reservedBytes < 0) throw new AiProtocolError('TOO_LARGE', undefined, false);
  let total = reservedBytes;
  for (const ref of context.files) {
    if (!ref.kind || !context.profile.capabilities.input.includes(ref.kind)
      || ref.kind === 'image' && !imageMimes.includes(ref.mimeType)
      || ref.kind === 'file' && !['application/pdf', 'text/plain'].includes(ref.mimeType)
      || ref.kind === 'audio') throw new AiProtocolError('UNSUPPORTED', undefined, false);
    total += Math.max(1, occurrences.get(ref.id) ?? 0) * (Math.ceil(ref.bytes / 3) * 4 + 4096);
  }
  if (total > context.limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
  for (const ref of context.files) {
    options.signal.throwIfAborted();
    const restored = await abortable(Promise.resolve().then(() => { options.signal.throwIfAborted(); return resolve(ref.sha256!, options.signal); }), options.signal);
    check(context, context.files, true);
    const bytes = restoredBytes(ref, restored);
    options.signal.throwIfAborted();
    context.countMedia.set(ref.id, { type: ref.kind!, mimeType: ref.mimeType, bytes });
  }
}
export function materializeInlineImages(context: ProtocolContext, records: Record<string, unknown>[]): Record<string, unknown>[] {
  check(context, context.files, true);
  const occurrences = inspectMedia(context, records, context.files);
  let total = Buffer.byteLength(boundedJson(records, context.limits.requestBytes));
  for (const ref of context.files) total += (occurrences.get(ref.id) ?? 0) * (Math.ceil(ref.bytes / 3) * 4 + 4096);
  if (total > context.limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
  const images = new Map<string, string>();
  for (const ref of context.files) {
    if (ref.storage !== 'inline') throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    if (!context.profile.capabilities.input.includes('image')) throw new AiProtocolError('UNSUPPORTED', undefined, false);
    const restored = context.countMedia.get(ref.id);
    if (!restored) throw new AiProtocolError('CONTINUATION_MISMATCH', undefined, false);
    const bytes = restoredBytes(ref, restored);
    images.set(ref.id, `data:${ref.mimeType};base64,${Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')}`);
  }
  const wire = structuredClone(records);
  const positions = new Map<Record<string, unknown>, ProviderFileReference>();
  // Validate before rewriting: structuredClone deliberately preserves aliased native blocks.
  inspectMedia(context, wire, context.files, (item, ref) => { positions.set(item, ref); });
  for (const [item, ref] of positions) {
    item.image_url = context.profile.protocol === 'openai-chat-completions' ? { url: images.get(ref.id)! } : images.get(ref.id)!;
  }
  return wire;
}
export async function releaseFiles(context: ProtocolContext, refs: readonly ProviderFileReference[], signal: AbortSignal): Promise<void> {
  if (!refs.length) return;
  // Validate the entire batch before deleting anything. No raw model/file IDs enter this operation.
  check(context, refs, false);
  const remaining: ProviderFileReference[] = [];
  for (const ref of refs) {
    if (ref.storage === 'inline') continue;
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
  if (inlineImageTransport(context.profile)) for (const message of request.messages) for (const part of message.content) {
    if (part.type === 'text') continue;
    if (message.role !== 'user' || part.type !== 'image' || !context.profile.capabilities.input.includes('image') || !imageMimes.includes(part.mimeType)) throw new AiProtocolError('UNSUPPORTED', undefined, false);
    if (!(part.bytes instanceof Uint8Array) || part.bytes.buffer instanceof SharedArrayBuffer || !part.bytes.byteLength || part.bytes.byteLength > 1_048_576) throw new AiProtocolError('TOO_LARGE', undefined, false);
  }
  for (const message of request.messages) for (const part of message.content) {
    if (part.type === 'text') continue;
    options.signal.throwIfAborted();
    if (context.files.length >= 8) throw new AiProtocolError('TOO_LARGE', undefined, false);
    const filename = part.filename ?? (part.type === 'image' ? `input.${part.mimeType.split('/')[1]}` : part.type === 'audio' ? 'input.audio' : part.mimeType === 'application/pdf' ? 'input.pdf' : 'input.txt');
    let ref: ProviderFileReference;
    const uploadOptions = { signal: options.signal, limits: { ...context.limits, responseBytes: 16_384 } };
    if (inlineImageTransport(context.profile)) {
      const captured = { type: part.type, mimeType: part.mimeType, bytes: Uint8Array.from(part.bytes) };
      ref = reference(context, `inline-${randomBytes(12).toString('hex')}`, captured, null, 'inline');
      context.files.push(ref); context.countMedia.set(ref.id, captured);
      context.media.set(part, context.profile.protocol === 'openai-chat-completions'
        ? { type: 'image_url', image_url: { url: `misaka-inline:${ref.id}` } }
        : { type: 'input_image', image_url: `misaka-inline:${ref.id}`, detail: 'auto' });
    } else if (context.profile.protocol === 'google-generate-content') {
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
