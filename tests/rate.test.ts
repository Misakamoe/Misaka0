import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type ProviderJson } from '../src/modules/provider-http.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const start = Date.UTC(2026, 10, 9);
async function fixture() {
  let now = start;
  const fiat = () => ({ result: 'success', base_code: 'USD', conversion_rates: { USD: 1, JPY: 150, CNY: 7.2, EUR: 0.9 },
    time_last_update_unix: Math.floor(start / 1000), time_next_update_unix: Math.floor(start / 1000) + 86400 });
  const json = vi.fn<ProviderJson>(async url => url.pathname.endsWith('/codes')
    ? { result: 'success', supported_codes: [['USD', 'US Dollar'], ['JPY', 'Japanese Yen'], ['CNY', 'Chinese Yuan'], ['EUR', 'Euro']] }
    : url.hostname === 'api.coingecko.com' ? { bitcoin: { usd: 60000, last_updated_at: Math.floor(now / 1000) } } : fiat());
  const f = await coreFixture({ rate: { key: 'TEST_PROVIDER_SECRET', json, now: () => now } });
  cleanup.push(f.close);
  return { ...f, json, fiat, advance: (ms: number) => { now += ms; } };
}
describe('rate service', () => {
  it('converts from a shared USD table precisely without sending amounts upstream', async () => {
    const f = await fixture();
    expect(await f.rate.convert({ query: '100 jp rmb' }, new AbortController().signal)).toMatchObject({ kind: 'converted', result: '4.8', unitRate: '0.048', from: { code: 'JPY' }, to: { code: 'CNY' }, stale: false });
    await f.rate.convert({ query: '日本 100 中国' }, new AbortController().signal);
    expect(f.json).toHaveBeenCalledTimes(2);
    expect(f.json.mock.calls.every(([url]) => !url.search && !url.pathname.includes('/pair/'))).toBe(true);
    expect(await readFile(join(f.directory, 'rates.json'), 'utf8')).not.toContain('TEST_PROVIDER_SECRET');
  });
  it('does not require crypto data to serve fiat, and preserves private caller cancellation', async () => {
    const f = await fixture();
    await f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal);
    expect(f.json.mock.calls.every(([url]) => url.hostname !== 'api.coingecko.com')).toBe(true);
    const controller = new AbortController(); controller.abort();
    await expect(f.rate.convert({ query: 'JPY CNY' }, controller.signal)).rejects.toThrow('CANCELLED');
  });
  it('can still serve crypto/USD when the fiat service is unavailable', async () => {
    const f = await fixture();
    f.json.mockImplementation(async url => {
      if (url.hostname !== 'api.coingecko.com') throw new ProviderError('AUTH');
      return { bitcoin: { usd: 60000, last_updated_at: start / 1000 } };
    });
    expect(await f.rate.convert({ query: 'BTC USD' }, new AbortController().signal)).toMatchObject({ kind: 'converted', result: '60000', sources: [{ name: 'CoinGecko' }] });
    await expect(f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal)).rejects.toMatchObject({ fields: ['provider.AUTH'] });
  });
  it('uses clearly marked stale fiat data for a bounded time and backs off failed refreshes', async () => {
    const f = await fixture();
    await f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal);
    f.advance(86_401_000);
    f.json.mockRejectedValue(new ProviderError('QUOTA'));
    expect(await f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal)).toMatchObject({ stale: true, result: '0.048' });
    await f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal);
    expect(f.json).toHaveBeenCalledTimes(3);
    f.advance(7 * 86_400_000);
    await expect(f.rate.convert({ query: 'JPY CNY' }, new AbortController().signal)).rejects.toMatchObject({ fields: ['provider.QUOTA'] });
  });
  it('deduplicates refreshes and cancellation of one caller does not abort others', async () => {
    const f = await fixture();
    const gate = Promise.withResolvers<void>(); const entered = Promise.withResolvers<void>();
    f.json.mockImplementation(async url => {
      if (url.pathname.endsWith('/codes')) return { result: 'success', supported_codes: [] };
      entered.resolve(); await gate.promise; return f.fiat();
    });
    const controller = new AbortController();
    const first = f.rate.convert({ query: 'JPY CNY' }, controller.signal);
    const rejected = expect(first).rejects.toThrow('CANCELLED');
    await entered.promise;
    const second = f.rate.convert({ query: '100USD CNY' }, new AbortController().signal);
    controller.abort(); gate.resolve();
    await rejected;
    expect(await second).toMatchObject({ result: '720' });
    expect(f.json).toHaveBeenCalledTimes(2);
  });
  it('keeps ambiguous symbols interactive and rejects malformed money without auto-correction', async () => {
    const f = await fixture();
    expect(await f.rate.convert({ query: '100¥ USD' }, new AbortController().signal)).toMatchObject({ kind: 'ambiguous', from: expect.arrayContaining([expect.objectContaining({ code: 'CNY' }), expect.objectContaining({ code: 'JPY' })]) });
    await expect(f.rate.convert({ query: '1+2JPY CNY' }, new AbortController().signal)).rejects.toMatchObject({ code: 'INVALID_INPUT', fields: ['rate.AMOUNT'] });
    const output = await f.executor.execute(invocation({ source: 'ai' }), 'rate.convert', { query: 'JPY CNY' });
    expect(output.status).toBe('rejected');
  });
});
