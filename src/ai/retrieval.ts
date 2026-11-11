import type { LookupAddress } from 'node:dns';
import { isIP } from 'node:net';
import { z } from 'zod';
import { abortable, normalizePublicUrl, publicAddress, resolveFeedAddresses } from '../network.js';
import { AiProtocolError, createAiTransport, type AiTransport } from './transport.js';

// Official contract checked 2026-11-11: https://api-docs.deepseek.com/zh-cn/guides/search/
// Intentionally excludes ori_question and localization (IP). No raw prompt forwarding.
export const deepSeekSearchInputSchema = z.strictObject({
  query: z.string().min(1).max(256).refine(value => [...value].length <= 128 && value.trim().length > 0 && !/[\p{Cc}\p{Cf}]/u.test(value)),
  count: z.number().int().min(1).max(10).default(5), needContent: z.boolean().default(false),
});
export const deepSeekFetchInputSchema = z.strictObject({ url: z.string().min(1).max(2048) });
export type DeepSeekSearchInput = z.input<typeof deepSeekSearchInputSchema>;
export type DeepSeekFetchInput = z.input<typeof deepSeekFetchInputSchema>;
export interface RetrievalCitation { id: string; url: string; title: string }
export interface RetrievalUsage { billable: boolean; requests: 1; provider: 'deepseek'; operation: 'search' | 'fetch' }
export interface RetrievalResult {
  trust: 'untrusted'; citations: RetrievalCitation[]; truncated: boolean; usage: RetrievalUsage;
  results: { citationId: string; title: string; url: string; snippet: string; summary: string; content: string }[];
}
export interface DeepSeekRetrieval {
  search(input: DeepSeekSearchInput, options: { signal: AbortSignal }): Promise<RetrievalResult>;
  fetch(input: DeepSeekFetchInput, options: { signal: AbortSignal }): Promise<RetrievalResult>;
}
function safeUrl(value: string): string | undefined {
  try {
    if (/[\p{Cc}\p{Cf}]/u.test(value)) return;
    return normalizePublicUrl(value);
  } catch { return; }
}
const searchResponseSchema = z.object({ results: z.array(z.object({
  title: z.string(), url: z.string(), snippet: z.string(), summary: z.string(), content: z.string(),
})).max(50) });
const fetchResponseSchema = z.object({ title: z.string(), content: z.string() });
export function createDeepSeekRetrieval(settings: {
  apiKey: string; transport?: AiTransport; lookup?: (hostname: string, signal: AbortSignal) => Promise<LookupAddress[]>;
}): DeepSeekRetrieval {
  const apiKey = settings.apiKey;
  if (!apiKey || apiKey.length > 2048 || /[^\x21-\x7e]/.test(apiKey)) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  const transport = settings.transport ?? createAiTransport();
  const post = (operation: 'search' | 'fetch', body: unknown, signal: AbortSignal) => transport.post({
    origin: 'https://api.deepseek.com', path: `/v1/tools/${operation}`, headers: { authorization: `Bearer ${apiKey}` }, body,
  }, { signal, limits: { requestBytes: 16_384, responseBytes: 1024 * 1024, timeoutMs: 30_000 } });
  function project(operation: 'search' | 'fetch', values: { title: string; url: string; snippet: string; summary: string; content: string }[]): RetrievalResult {
    const result: RetrievalResult = { trust: 'untrusted', results: [], citations: [], truncated: false,
      usage: { provider: 'deepseek', operation, requests: 1, billable: operation === 'search' ? values.length > 0 : values.some(value => value.content.length > 0) } };
    let remaining = 128 * 1024;
    const bounded = (value: string, limit: number): string => {
      const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, character => ['\n', '\t'].includes(character) ? character : '');
      const bytes = Buffer.from(clean); const length = Math.min(remaining, limit, bytes.length);
      let end = length;
      while (end > 0 && end < bytes.length && (bytes[end]! & 0xc0) === 0x80) end--;
      remaining -= end;
      if (end !== bytes.length || clean !== value) result.truncated = true;
      return bytes.subarray(0, end).toString('utf8');
    };
    for (const value of values) {
      const url = safeUrl(value.url);
      if (!url) { result.truncated = true; continue; }
      const title = bounded(value.title, 1024); const citationId = `source-${result.results.length + 1}`;
      result.citations.push({ id: citationId, url, title });
      result.results.push({ citationId, title, url, snippet: bounded(value.snippet, 2048), summary: bounded(value.summary, 8192), content: bounded(value.content, operation === 'fetch' ? 120 * 1024 : 16 * 1024) });
    }
    return result;
  }
  return {
    async search(input, { signal }) {
      const parsed = deepSeekSearchInputSchema.safeParse(input);
      if (!parsed.success) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      const { query, count, needContent } = parsed.data;
      const response = searchResponseSchema.safeParse(await post('search', { query, count, need_content: needContent }, signal));
      if (!response.success || response.data.results.length > count) throw new AiProtocolError('INVALID_RESPONSE');
      return project('search', response.data.results);
    },
    async fetch(input, { signal: caller }) {
      const parsed = deepSeekFetchInputSchema.safeParse(input);
      if (!parsed.success) throw new AiProtocolError('INVALID_INPUT', undefined, false);
      const url = safeUrl(parsed.data.url);
      if (!url) throw new AiProtocolError('UNSAFE_URL', undefined, false);
      const timer = new AbortController(); const deadline = setTimeout(() => timer.abort(), 30_000); deadline.unref();
      const signal = AbortSignal.any([caller, timer.signal]);
      try {
        signal.throwIfAborted();
        const hostname = new URL(url).hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await abortable((settings.lookup ?? resolveFeedAddresses)(hostname, signal), signal);
        if (!addresses.length || addresses.length > 32 || addresses.some(item => !publicAddress(item.address) || isIP(item.address) !== item.family)) throw new AiProtocolError('UNSAFE_URL', undefined, false);
        const response = fetchResponseSchema.safeParse(await post('fetch', { url }, signal));
        if (!response.success) throw new AiProtocolError('INVALID_RESPONSE');
        return project('fetch', [{ url, ...response.data, snippet: '', summary: '' }]);
      } catch (error) {
        if (signal.aborted) throw new AiProtocolError(caller.aborted ? 'CANCELLED' : 'TIMEOUT');
        if (error instanceof AiProtocolError) throw error;
        throw new AiProtocolError('NETWORK');
      } finally { clearTimeout(deadline); }
    },
  };
}
