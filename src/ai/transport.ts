import { Agent, request as httpsRequest } from 'node:https';
import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { LookupAddress } from 'node:dns';
import { finished } from 'node:stream/promises';
import { abortable, normalizePublicUrl, publicAddress, resolveFeedAddresses, type NetworkResponse } from '../network.js';

export type AiErrorCode = 'INVALID_INPUT' | 'UNSAFE_URL' | 'AUTH' | 'QUOTA' | 'CAPACITY' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED' | 'TOO_LARGE' | 'INVALID_RESPONSE' | 'INCOMPLETE' | 'UNSUPPORTED' | 'CONTINUATION_MISMATCH';
export class AiProtocolError extends Error {
  constructor(readonly code: AiErrorCode, readonly status?: number, readonly billable: boolean | 'unknown' = 'unknown') { super(code); }
}
export interface ProtocolLimits {
  requestBytes: number; responseBytes: number; eventBytes: number; events: number;
  textBytes: number; toolCalls: number; toolArgumentsBytes: number; continuationBytes: number;
  artifactBytes: number; timeoutMs: number;
}
export const DEFAULT_PROTOCOL_LIMITS: Readonly<ProtocolLimits> = Object.freeze({
  requestBytes: 1024 * 1024, responseBytes: 4 * 1024 * 1024, eventBytes: 256 * 1024, events: 8192,
  textBytes: 128 * 1024, toolCalls: 16, toolArgumentsBytes: 32 * 1024, continuationBytes: 512 * 1024,
  artifactBytes: 1024 * 1024, timeoutMs: 60_000,
});
const ceilings: ProtocolLimits = { requestBytes: 8 * 1024 * 1024, responseBytes: 16 * 1024 * 1024, eventBytes: 4 * 1024 * 1024,
  events: 32_768, textBytes: 512 * 1024, toolCalls: 32, toolArgumentsBytes: 128 * 1024, continuationBytes: 2 * 1024 * 1024,
  artifactBytes: 2 * 1024 * 1024, timeoutMs: 120_000 };
export function protocolLimits(overrides: Partial<ProtocolLimits> = {}): ProtocolLimits {
  const result = { ...DEFAULT_PROTOCOL_LIMITS };
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(ceilings, key) || !Number.isSafeInteger(value) || value <= 0 || value > ceilings[key as keyof ProtocolLimits]) throw new AiProtocolError('INVALID_INPUT', undefined, false);
    result[key as keyof ProtocolLimits] = value;
  }
  return result;
}
// Reject before stringify: a trusted adapter can still accidentally hand us an oversized tree.
export function boundedJson(value: unknown, maxBytes: number): string {
  let nodes = 0; let size = 0;
  const seen = new Set<object>();
  const visit = (entry: unknown, depth: number): void => {
    if (++nodes > 50_000 || depth > 48) throw new AiProtocolError('TOO_LARGE');
    if (entry === null || typeof entry === 'boolean') { size += 5; }
    else if (typeof entry === 'number' && Number.isFinite(entry)) { size += String(entry).length; }
    else if (typeof entry === 'string') { size += Buffer.byteLength(entry) + 2; }
    else if (entry && typeof entry === 'object') {
      if (seen.has(entry)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      seen.add(entry);
      if (Array.isArray(entry)) { size += entry.length + 2; for (const child of entry) visit(child, depth + 1); }
      else {
        if (Object.getPrototypeOf(entry) !== Object.prototype && Object.getPrototypeOf(entry) !== null) throw new AiProtocolError('INVALID_INPUT', undefined, false);
        for (const [key, child] of Object.entries(entry)) { size += Buffer.byteLength(key) + 4; visit(child, depth + 1); }
      }
      seen.delete(entry);
    } else throw new AiProtocolError('INVALID_INPUT', undefined, false);
    if (size > maxBytes) throw new AiProtocolError('TOO_LARGE');
  };
  visit(value, 0);
  const result = JSON.stringify(value);
  if (Buffer.byteLength(result) > maxBytes) throw new AiProtocolError('TOO_LARGE');
  return result;
}
export function approvedHttpsOrigin(input: string): string {
  try {
    const url = new URL(normalizePublicUrl(input));
    if (url.protocol !== 'https:' || input !== url.origin) throw new Error();
    return url.origin;
  } catch { throw new AiProtocolError('UNSAFE_URL', undefined, false); }
}
export interface SseEvent { event: string; data: string }
export async function* parseSse(chunks: AsyncIterable<Uint8Array>, limits: Pick<ProtocolLimits, 'responseBytes' | 'eventBytes' | 'events'>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let line = ''; let data: string[] = []; let event = ''; let bytes = 0; let eventBytes = 0; let count = 0; let skipLf = false;
  function acceptLine(): SseEvent | undefined {
    eventBytes += Buffer.byteLength(line) + 1;
    if (eventBytes > limits.eventBytes) throw new AiProtocolError('TOO_LARGE');
    if (line === '') {
      const result = data.length ? { event: event || 'message', data: data.join('\n') } : undefined;
      data = []; event = ''; eventBytes = 0;
      if (result && ++count > limits.events) throw new AiProtocolError('TOO_LARGE');
      return result;
    }
    if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
    return undefined;
  }
  try {
    for await (const chunk of chunks) {
      bytes += chunk.byteLength;
      if (bytes > limits.responseBytes) throw new AiProtocolError('TOO_LARGE');
      const decoded = decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let index = 0; index < decoded.length; index++) {
        const char = decoded[index];
        if (skipLf) { skipLf = false; if (char === '\n') { start = index + 1; continue; } }
        if (char !== '\n' && char !== '\r') continue;
        line += decoded.slice(start, index); start = index + 1;
        const result = acceptLine(); line = ''; skipLf = char === '\r';
        if (result) yield result;
      }
      line += decoded.slice(start);
      if (eventBytes + Buffer.byteLength(line) > limits.eventBytes) throw new AiProtocolError('TOO_LARGE');
    }
    line += decoder.decode();
    // A truncated event is not a completed provider response, even if its JSON happens to parse.
    if (line || data.length || event) throw new AiProtocolError('INCOMPLETE');
  } catch (error) {
    if (error instanceof AiProtocolError) throw error;
    throw new AiProtocolError('INVALID_RESPONSE');
  }
}
export interface AiHttpRequest { addresses: LookupAddress[]; headers: Record<string, string>; body: Buffer; signal: AbortSignal; method: 'POST' | 'GET' | 'DELETE' }
export type AiHttpTransport = (url: URL, options: AiHttpRequest) => Promise<NetworkResponse>;
export interface AiTransportDependencies {
  request?: AiHttpTransport;
  lookup?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;
}
export type MultipartPart = { name: string; value: string } | { name: string; filename: string; mimeType: string; bytes: Uint8Array };
export interface AiPostRequest { origin: string; path: string; headers: Record<string, string>; body?: unknown; multipart?: readonly MultipartPart[] }
export interface AiPostOptions { signal: AbortSignal; limits?: Partial<ProtocolLimits>; onEvent?: (event: SseEvent) => void | Promise<void> }
export interface AiRequest extends AiPostRequest { method: 'POST' | 'GET' | 'DELETE'; raw?: Uint8Array; contentType?: string; headersOnly?: boolean; mcp?: boolean }
export interface AiResponse { status: number; headers: NetworkResponse['headers']; value: unknown }
export interface AiTransport {
  post(request: AiPostRequest, options: AiPostOptions): Promise<unknown>;
  request?(request: AiRequest, options: AiPostOptions): Promise<AiResponse>;
}
const sockets = new Agent({ keepAlive: false, maxSockets: 4, maxTotalSockets: 4 });
const nativeRequest: AiHttpTransport = (url, options) => new Promise((resolve, reject) => {
  const req = httpsRequest(url, {
    method: options.method, agent: sockets, signal: options.signal, maxHeaderSize: 16_384,
    headers: options.headers,
    lookup: (_hostname, settings, callback) => settings.all ? callback(null, options.addresses)
      : callback(null, options.addresses[0]!.address, options.addresses[0]!.family),
  }, response => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
  req.on('error', reject); req.end(options.body);
});
let activeRequests = 0;
export function createAiTransport(dependencies: AiTransportDependencies = {}): AiTransport {
  async function perform(input: AiRequest, options: AiPostOptions, fileRequest: boolean): Promise<AiResponse> {
    if (options.signal.aborted) throw new AiProtocolError('CANCELLED', undefined, false);
    if (activeRequests >= 4) throw new AiProtocolError('CAPACITY', undefined, false);
    const limits = protocolLimits(options.limits);
    const origin = approvedHttpsOrigin(input.origin);
    const url = new URL(input.path, origin);
    if (!input.path.startsWith('/') || input.path.startsWith('//') || url.origin !== origin || url.username || url.password || url.hash) throw new AiProtocolError('UNSAFE_URL', undefined, false);
    if (!['POST', 'GET', 'DELETE'].includes(input.method)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
    if (input.mcp && (input.multipart !== undefined || input.raw !== undefined || options.onEvent || input.headersOnly)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
    let body: Buffer; let contentType = 'application/json';
    if (input.method !== 'POST') {
      if (input.body !== undefined || input.multipart !== undefined || input.raw !== undefined) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      body = Buffer.alloc(0);
    } else if (input.raw !== undefined) {
      if (input.body !== undefined || input.multipart !== undefined || !(input.raw instanceof Uint8Array)
        || !input.contentType || input.contentType.length > 128 || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(input.contentType)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      if (input.raw.byteLength > limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
      body = Buffer.from(input.raw.buffer, input.raw.byteOffset, input.raw.byteLength); contentType = input.contentType;
    } else if (input.multipart !== undefined) {
      if (input.body !== undefined || !Array.isArray(input.multipart) || !input.multipart.length || input.multipart.length > 16) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      const boundary = `misaka-${randomBytes(16).toString('hex')}`; const chunks: Buffer[] = []; let size = 0;
      const append = (chunk: Buffer) => { size += chunk.length; if (size > limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false); chunks.push(chunk); };
      for (const part of input.multipart) {
        if (!/^[A-Za-z0-9_-]{1,64}(?:\[[A-Za-z0-9_-]{1,32}\])?$/.test(part.name)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
        if ('value' in part) {
          if (typeof part.value !== 'string' || Buffer.byteLength(part.value) > limits.requestBytes) throw new AiProtocolError('TOO_LARGE', undefined, false);
          append(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"\r\n\r\n${part.value}\r\n`));
        } else {
          if (!/^[A-Za-z0-9._ -]{1,128}$/.test(part.filename) || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(part.mimeType)
            || !(part.bytes instanceof Uint8Array)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
          append(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.mimeType}\r\n\r\n`));
          append(Buffer.from(part.bytes.buffer, part.bytes.byteOffset, part.bytes.byteLength)); append(Buffer.from('\r\n'));
        }
      }
      append(Buffer.from(`--${boundary}--\r\n`)); body = Buffer.concat(chunks, size); contentType = `multipart/form-data; boundary=${boundary}`;
    } else body = Buffer.from(boundedJson(input.body, limits.requestBytes));
    const headers: Record<string, string> = { accept: input.mcp ? 'application/json, text/event-stream' : options.onEvent ? 'text/event-stream' : 'application/json', 'accept-encoding': 'identity',
      'content-type': contentType, 'content-length': String(body.length), 'user-agent': 'Misaka/0.1' };
    for (const [key, value] of Object.entries(input.headers)) {
      const uploadHeader = origin === 'https://generativelanguage.googleapis.com' && url.pathname === '/upload/v1beta/files'
        && ['x-goog-upload-protocol', 'x-goog-upload-command', 'x-goog-upload-header-content-length', 'x-goog-upload-header-content-type', 'x-goog-upload-offset'].includes(key.toLowerCase());
      const mcpHeader = input.mcp && (key.toLowerCase() === 'mcp-session-id' && /^[\x21-\x7e]{1,128}$/.test(value)
        || key.toLowerCase() === 'mcp-protocol-version' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        || key.toLowerCase() === 'accept' && value === 'application/json, text/event-stream');
      if (!uploadHeader && !mcpHeader && !['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'anthropic-beta'].includes(key.toLowerCase())
        || typeof value !== 'string' || value.length > 4096 || /[^\x20-\x7e]/.test(value)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      headers[key.toLowerCase()] = value;
    }
    if (options.signal.aborted) throw new AiProtocolError('CANCELLED', undefined, false);
    if (activeRequests >= 4) throw new AiProtocolError('CAPACITY', undefined, false);
    activeRequests++;
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), limits.timeoutMs); timer.unref();
    const signal = AbortSignal.any([options.signal, timeout.signal]);
    let response: NetworkResponse | undefined;
    const abort = () => response?.body.destroy(new AiProtocolError(options.signal.aborted ? 'CANCELLED' : 'TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }]
        : await abortable((dependencies.lookup ?? resolveFeedAddresses)(hostname, signal), signal);
      if (!addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) throw new AiProtocolError('UNSAFE_URL', undefined, false);
      signal.throwIfAborted();
      const pending = (dependencies.request ?? nativeRequest)(url, { addresses, headers, body, signal, method: input.method }).then(value => {
        if (signal.aborted) { value.body.destroy(); throw new AiProtocolError('CANCELLED'); }
        return value;
      });
      response = await abortable(pending, signal);
      // No redirects, including same-origin redirects carrying credentials.
      if (!(input.mcp ? [200, 202, 204] : fileRequest ? [200, 201, 204] : [200]).includes(response.status)) throw new AiProtocolError(response.status === 401 || response.status === 403 ? 'AUTH'
        : response.status === 402 || response.status === 429 ? 'QUOTA' : 'NETWORK', response.status);
      const encoding = response.headers['content-encoding'];
      if (encoding && encoding.trim().toLowerCase() !== 'identity') throw new AiProtocolError('UNSUPPORTED');
      if (Number(response.headers['content-length']) > limits.responseBytes) throw new AiProtocolError('TOO_LARGE');
      if (input.mcp && response.status === 202) {
        if (input.method !== 'POST' || !input.body || typeof input.body !== 'object' || Array.isArray(input.body)
          || Object.hasOwn(input.body, 'id')) throw new AiProtocolError('INVALID_RESPONSE');
        for await (const chunk of response.body as AsyncIterable<Buffer>) {
          signal.throwIfAborted();
          if (chunk.length) throw new AiProtocolError('INVALID_RESPONSE');
        }
        return { status: response.status, headers: response.headers, value: null };
      }
      if (input.headersOnly || response.status === 204) return { status: response.status, headers: response.headers, value: null };
      const mime = response.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase();
      if (input.mcp && mime === 'text/event-stream') {
        const id = input.body && typeof input.body === 'object' && !Array.isArray(input.body)
          ? (input.body as Record<string, unknown>).id : undefined;
        if (id === undefined) throw new AiProtocolError('INVALID_RESPONSE');
        for await (const event of parseSse(response.body as AsyncIterable<Buffer>, limits)) {
          signal.throwIfAborted();
          let value: unknown;
          try { value = JSON.parse(event.data); } catch { throw new AiProtocolError('INVALID_RESPONSE'); }
          if (event.event !== 'message' || !value || typeof value !== 'object' || Array.isArray(value)
            || (value as Record<string, unknown>).jsonrpc !== '2.0' || (value as Record<string, unknown>).id !== id) throw new AiProtocolError('INVALID_RESPONSE');
          return { status: response.status, headers: response.headers, value };
        }
        throw new AiProtocolError('INCOMPLETE');
      }
      if (options.onEvent) {
        if (mime !== 'text/event-stream') throw new AiProtocolError('INVALID_RESPONSE');
        for await (const event of parseSse(response.body as AsyncIterable<Buffer>, limits)) {
          signal.throwIfAborted();
          await abortable(Promise.resolve(options.onEvent(event)), signal);
        }
        signal.throwIfAborted();
        return { status: response.status, headers: response.headers, value: undefined };
      }
      if (mime !== 'application/json') throw new AiProtocolError('INVALID_RESPONSE');
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of response.body as AsyncIterable<Buffer>) {
        signal.throwIfAborted(); size += chunk.length;
        if (size > limits.responseBytes) throw new AiProtocolError('TOO_LARGE');
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      try { return { status: response.status, headers: response.headers, value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size))) as unknown }; }
      catch { throw new AiProtocolError('INVALID_RESPONSE'); }
    } catch (error) {
      if (signal.aborted) throw new AiProtocolError(options.signal.aborted ? 'CANCELLED' : 'TIMEOUT');
      if (error instanceof AiProtocolError) throw error;
      throw new AiProtocolError('NETWORK');
    } finally {
      if (response) {
        const drained = finished(response.body, { cleanup: true }).catch(() => undefined);
        response.body.destroy(); await drained;
      }
      clearTimeout(timer); signal.removeEventListener('abort', abort); activeRequests--;
    }
  }
  return {
    post: async (input, options) => (await perform({ ...input, method: 'POST' }, options, false)).value,
    request: (input, options) => perform(input, options, true),
  };
}
