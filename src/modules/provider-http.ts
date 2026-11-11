import { request } from 'node:https';
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib';
import { AppError } from '../errors.js';
import { publicAddress, resolveFeedAddresses, resolvePublicAddresses } from '../network.js';

export type ProviderErrorCode = 'NOT_CONFIGURED' | 'AUTH' | 'QUOTA' | 'NETWORK' | 'TIMEOUT' | 'INVALID_RESPONSE' | 'NOT_FOUND';
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly retryAfterMs?: number) { super(code); }
}
export type ProviderJson = (url: URL, signal: AbortSignal, headers?: Readonly<Record<string, string>>) => Promise<unknown>;
export function createProviderJson(hosts: readonly string[]): ProviderJson {
  const allowed = new Set(hosts);
  return async (url, caller, extra = {}) => {
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !allowed.has(url.hostname)) throw new ProviderError('NOT_CONFIGURED');
    if (caller.aborted) throw new AppError('CANCELLED');
    const signal = AbortSignal.any([caller, AbortSignal.timeout(12_000)]);
    try {
      let addresses = await resolveFeedAddresses(url.hostname, signal);
      // These are fixed provider origins, not user feed URLs; bypass fake A/AAAA answers without connecting to them.
      if (addresses.some(address => !publicAddress(address.address))) addresses = await resolvePublicAddresses(url.hostname, signal);
      if (!addresses.length || addresses.some(address => !publicAddress(address.address))) throw new ProviderError('NETWORK');
      return await new Promise<unknown>((resolve, reject) => {
        const req = request(url, {
          agent: false, signal,
          headers: { accept: 'application/json', 'accept-encoding': 'gzip, deflate, br', 'user-agent': 'Misaka/0.1', ...extra },
          lookup: (_host, options, callback) => options.all ? callback(null, addresses) : callback(null, addresses[0]!.address, addresses[0]!.family),
        }, response => {
          const status = response.statusCode ?? 0;
          if (status !== 200) {
            response.destroy();
            const retry = Number(response.headers['retry-after']);
            reject(new ProviderError(status === 401 || status === 403 ? 'AUTH' : status === 429 ? 'QUOTA' : status === 404 ? 'NOT_FOUND' : 'NETWORK',
              Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 86_400_000) : undefined));
            return;
          }
          const encoding = response.headers['content-encoding']?.trim().toLowerCase();
          if (encoding && !['gzip', 'deflate', 'br', 'identity'].includes(encoding)) { response.destroy(); reject(new ProviderError('INVALID_RESPONSE')); return; }
          const decoder = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : undefined;
          const decoded = decoder ?? response;
          let compressed = 0; let size = 0;
          const chunks: Buffer[] = [];
          const fail = () => { response.destroy(); decoded.destroy(); reject(new ProviderError('INVALID_RESPONSE')); };
          response.on('error', error => { if (decoded !== response) decoded.destroy(error); reject(error); });
          response.on('data', (chunk: Buffer) => { compressed += chunk.length; if (compressed > 524_288) fail(); });
          if (decoder) response.pipe(decoder);
          decoded.on('error', reject);
          decoded.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 524_288) fail(); else chunks.push(chunk); });
          decoded.once('end', () => {
            try { resolve(JSON.parse(Buffer.concat(chunks, size).toString('utf8'))); }
            catch { reject(new ProviderError('INVALID_RESPONSE')); }
          });
        });
        req.on('error', reject);
        req.end();
      });
    } catch (error) {
      if (caller.aborted) throw new AppError('CANCELLED');
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(signal.aborted ? 'TIMEOUT' : 'NETWORK');
    }
  };
}
export function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
export function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function number(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '' || !['number', 'string'].includes(typeof value)) return undefined;
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}
export async function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw new AppError('CANCELLED');
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new AppError('CANCELLED'));
    signal.addEventListener('abort', abort, { once: true });
    void promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
