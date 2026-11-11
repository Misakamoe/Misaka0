import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import ipaddr from 'ipaddr.js';

export class NetworkError extends Error {
  constructor(readonly code: 'UNSAFE_URL' | 'BLOCKED' | 'HTTP_ERROR' | 'INVALID_FEED' | 'TOO_LARGE' | 'TIMEOUT' | 'NETWORK',
    readonly status?: number, readonly retryAfterMs?: number) { super(code); }
}
export function publicAddress(address: string): boolean {
  try {
    if (!isIP(address)) return false;
    return ipaddr.process(address).range() === 'unicast';
  } catch { return false; }
}
export function normalizePublicUrl(input: string): string {
  try {
    if (input.length > 2048 || [...input].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127)) throw new Error();
    const url = new URL(input);
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port
      || !host.includes('.') && !isIP(host) || /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(host)
      || isIP(host) && !publicAddress(host)) throw new Error();
    url.hash = '';
    return url.href;
  } catch { throw new NetworkError('UNSAFE_URL'); }
}
export interface NetworkResponse { status: number; headers: IncomingHttpHeaders; body: Readable }
export interface NetworkRequestOptions { addresses: LookupAddress[]; headers: Record<string, string>; signal: AbortSignal }
export type NetworkTransport = (url: URL, options: NetworkRequestOptions) => Promise<NetworkResponse>;
export const networkGet: NetworkTransport = (url, options) => new Promise((resolve, reject) => {
  const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
    method: 'GET', agent: false, headers: options.headers,
    // Pin every answer so fallback between IPv4/IPv6 never performs another DNS lookup.
    lookup: (_hostname, settings, callback) => settings.all
      ? callback(null, options.addresses) : callback(null, options.addresses[0]!.address, options.addresses[0]!.family),
  }, response => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: response }));
  const abort = () => request.destroy(new NetworkError('TIMEOUT'));
  options.signal.addEventListener('abort', abort, { once: true });
  request.once('close', () => options.signal.removeEventListener('abort', abort));
  request.on('error', reject);
  if (options.signal.aborted) abort();
  request.end();
});
export async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => undefined); throw new NetworkError('TIMEOUT'); }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new NetworkError('TIMEOUT'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
export async function readBody(response: NetworkResponse, signal: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const encoding = response.headers['content-encoding']?.toLowerCase().trim();
  if (encoding && !['gzip', 'deflate', 'br', 'identity'].includes(encoding)) { response.body.destroy(); throw new NetworkError('INVALID_FEED'); }
  const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
  const body = decoder ?? response.body;
  const destroy = (error: Error) => { response.body.destroy(error); decoder?.destroy(error); };
  const abort = () => destroy(new NetworkError('TIMEOUT'));
  let compressed = 0;
  response.body.on('data', (chunk: Buffer) => { compressed += chunk.length; if (compressed > maxBytes) destroy(new NetworkError('TOO_LARGE')); });
  response.body.on('error', error => decoder?.destroy(error));
  signal.addEventListener('abort', abort, { once: true });
  if (decoder) response.body.pipe(decoder);
  if (signal.aborted) abort();
  try {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const value of body) {
      const chunk = Buffer.from(value as Uint8Array);
      size += chunk.length;
      if (size > maxBytes) throw new NetworkError('TOO_LARGE');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener('abort', abort); response.body.destroy(); decoder?.destroy(); }
}
export async function resolveFeedAddresses(hostname: string, signal: AbortSignal,
  lookup: (hostname: string) => Promise<LookupAddress[]> = name => dnsLookup(name, { all: true, verbatim: true }), query: NetworkTransport = networkGet): Promise<LookupAddress[]> {
  const addresses = await abortable(lookup(hostname), signal);
  const fake = (address: string) => isIP(address) === 4 && /^198\.(18|19)\./.test(address);
  if (!addresses.some(address => fake(address.address)) || addresses.some(address => !publicAddress(address.address) && !fake(address.address))) return addresses;
  // TUN fake-IP DNS never grants access to reserved networks. Use pinned public TLS instead.
  return resolvePublicAddresses(hostname, signal, query);
}
export async function resolvePublicAddresses(hostname: string, signal: AbortSignal, query: NetworkTransport = networkGet): Promise<LookupAddress[]> {
  const replies = await Promise.all(['A', 'AAAA'].map(async type => {
    const url = new URL('https://cloudflare-dns.com/dns-query');
    url.searchParams.set('name', hostname); url.searchParams.set('type', type);
    const response = await query(url, { addresses: [{ address: '1.1.1.1', family: 4 }], headers: { accept: 'application/dns-json' }, signal });
    if (response.status !== 200 || Number(response.headers['content-length']) > 65_536) { response.body.destroy(); throw new NetworkError('NETWORK'); }
    const body = await readBody(response, signal);
    if (body.length > 65_536) throw new NetworkError('NETWORK');
    let data: Record<string, unknown>;
    const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    try { data = object(JSON.parse(body.toString('utf8'))); } catch { throw new NetworkError('NETWORK'); }
    const answers = data.Answer === undefined || data.Answer === null ? [] : Array.isArray(data.Answer) ? data.Answer : [data.Answer];
    if (data.Status !== 0 || answers.length > 128) throw new NetworkError('NETWORK');
    const addresses = answers.map(object).filter(answer => answer.type === 1 || answer.type === 28)
      .map(answer => ({ address: typeof answer.data === 'string' ? answer.data : '', family: answer.type === 1 ? 4 : 6 }));
    if (addresses.some(answer => !publicAddress(answer.address) || isIP(answer.address) !== answer.family)) throw new NetworkError('UNSAFE_URL');
    return addresses;
  }));
  const result = replies.flat();
  if (!result.length) throw new NetworkError('NETWORK');
  return result;
}
