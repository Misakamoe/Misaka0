import { z } from 'zod';
import { revisionSchema } from '../../shared/schemas/index.js';
import type { RateCurrencies, RateInput, RateResult } from '../../shared/schemas/rate.js';
import { AppError, throwIfAborted } from '../errors.js';
import { JsonDocument, type JsonStorage } from '../storage.js';
import type { CurrencyCatalog, CurrencyDefinition, CurrencyParse } from './currency.js';
import { cancellable, createProviderJson, list, number, object, ProviderError, string, type ProviderJson } from './provider-http.js';

export { rateMetadata } from './metadata.js';
export { registerRateActions } from './module-actions.js';
const codeSchema = z.string().regex(/^[A-Z]{3}$/);
const fiatSchema = z.strictObject({ codes: z.array(z.tuple([codeSchema, z.string().max(160)])).max(400), rates: z.record(codeSchema, z.number().positive().max(1e15)), updatedAt: z.number().nonnegative(), nextAt: z.number().nonnegative() });
const coinSchema = z.strictObject({ usd: z.number().min(1e-18).max(1e15), updatedAt: z.number().nonnegative(), fetchedAt: z.number().nonnegative() });
const fileSchema = z.strictObject({ schema_version: z.literal(1), revision: revisionSchema, fiat: fiatSchema.nullable(), crypto: z.record(z.string(), coinSchema) });
export interface RateOptions { key?: string; json?: ProviderJson; now?: () => number }
export class RateService {
  private readonly file: JsonDocument<z.infer<typeof fileSchema>>;
  private readonly json: ProviderJson;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private fiatTask?: Promise<void>;
  private cryptoTask?: Promise<void>;
  private fiatRetryAt = 0;
  private cryptoRetryAt = 0;
  private fiatError: ProviderError = new ProviderError('NOT_CONFIGURED');
  private cryptoError: ProviderError = new ProviderError('NETWORK');
  private catalogValue?: CurrencyCatalog;
  private catalogCodes?: readonly (readonly [string, string])[];
  private catalogDate?: string;
  private runtimeTask?: Promise<typeof import('./rate-runtime.js')>;
  constructor(storage: JsonStorage, private readonly options: RateOptions = {}) {
    this.file = new JsonDocument(storage, 'rates.json', fileSchema);
    this.json = options.json ?? createProviderJson(['v6.exchangerate-api.com', 'api.coingecko.com']);
    this.now = options.now ?? Date.now;
  }
  async initialize(): Promise<void> { await this.file.load({ schema_version: 1, revision: 0, fiat: null, crypto: {} }); }
  snapshot() { return this.file.snapshot(); }
  private runtime() { return this.runtimeTask ??= import('./rate-runtime.js'); }
  private async catalog(): Promise<CurrencyCatalog> {
    const { CurrencyCatalog, englishCurrencyNames } = await this.runtime();
    throwIfAborted(this.abort.signal);
    const codes = this.snapshot().fiat?.codes;
    const date = new Date(this.now()).toISOString().slice(0, 10);
    if (!this.catalogValue || this.catalogDate !== date || codes?.length !== this.catalogCodes?.length
      || codes?.some(([code, name], index) => code !== this.catalogCodes?.[index]?.[0] || name !== this.catalogCodes?.[index]?.[1])) {
      this.catalogValue = new CurrencyCatalog(codes ?? Intl.supportedValuesOf('currency').map(code => [code, englishCurrencyNames.of(code)!] as const), this.now());
      this.catalogCodes = codes;
      this.catalogDate = date;
    }
    return this.catalogValue;
  }
  private async refreshFiat(signal: AbortSignal): Promise<void> {
    const cached = this.snapshot().fiat;
    if (cached && this.now() < cached.nextAt) return;
    if (!this.options.key) throw new ProviderError('NOT_CONFIGURED');
    if (this.now() < this.fiatRetryAt) throw this.fiatError;
    if (!this.fiatTask) this.fiatTask = (async () => {
      const root = `https://v6.exchangerate-api.com/v6/${encodeURIComponent(this.options.key!)}`;
      const [rawCodes, rawRates] = await Promise.all([
        cached ? Promise.resolve({ result: 'success', supported_codes: cached.codes }) : this.json(new URL(`${root}/codes`), this.abort.signal),
        this.json(new URL(`${root}/latest/USD`), this.abort.signal),
      ]);
      const codes = object(rawCodes); const data = object(rawRates);
      for (const value of [codes, data]) if (value.result !== 'success') {
        const error = string(value['error-type']);
        throw new ProviderError(error === 'quota-reached' ? 'QUOTA' : ['invalid-key', 'inactive-account'].includes(error) ? 'AUTH' : 'INVALID_RESPONSE');
      }
      const rates = object(data.conversion_rates);
      const last = number(data.time_last_update_unix); const next = number(data.time_next_update_unix);
      if (data.base_code !== 'USD' || rates.USD !== 1 || !last || !next || next <= last || last * 1000 > this.now() + 600_000) throw new ProviderError('INVALID_RESPONSE');
      const declared = new Map(list(codes.supported_codes).filter(Array.isArray).map(row => [string(row[0]), string(row[1])]));
      const { englishCurrencyNames: english } = await this.runtime();
      throwIfAborted(this.abort.signal);
      const fiat = fiatSchema.safeParse({ rates, updatedAt: last * 1000, nextAt: Math.min(next * 1000, this.now() + 86_400_000),
        codes: Object.keys(rates).map(code => [code, declared.get(code) || (/^[A-Z]{3}$/.test(code) ? english.of(code) : '') || code]),
      });
      if (!fiat.success) throw new ProviderError('INVALID_RESPONSE');
      await this.file.update(state => { state.fiat = fiat.data; }, { signal: this.abort.signal });
      this.fiatRetryAt = 0;
    })().catch(error => {
      this.fiatError = error instanceof ProviderError ? error : new ProviderError('NETWORK');
      this.fiatRetryAt = this.now() + Math.max(60_000, this.fiatError.retryAfterMs ?? 0);
      throw error;
    }).finally(() => { this.fiatTask = undefined; });
    await cancellable(this.fiatTask, signal);
  }
  private async coins(currencies: CurrencyDefinition[], signal: AbortSignal): Promise<void> {
    const wanted = currencies.filter(currency => currency.kind === 'crypto');
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = this.snapshot();
      const missing = wanted.filter(currency => !state.crypto[currency.code] || this.now() - state.crypto[currency.code]!.fetchedAt >= 300_000);
      if (!missing.length) return;
      if (this.now() < this.cryptoRetryAt) throw this.cryptoError;
      if (!this.cryptoTask) this.cryptoTask = (async () => {
        const url = new URL('https://api.coingecko.com/api/v3/simple/price');
        url.searchParams.set('ids', [...new Set(missing.map(currency => currency.coinId!))].join(','));
        url.searchParams.set('vs_currencies', 'usd'); url.searchParams.set('include_last_updated_at', 'true');
        const data = object(await this.json(url, this.abort.signal));
        const values = missing.map(currency => {
          const price = object(data[currency.coinId!]); const usd = number(price.usd); const updated = number(price.last_updated_at);
          if (!usd || usd < 0 || !updated || updated * 1000 > this.now() + 600_000 || this.now() - updated * 1000 > 86_400_000) throw new ProviderError('NOT_FOUND');
          return [currency.code, coinSchema.parse({ usd, updatedAt: updated * 1000, fetchedAt: this.now() })] as const;
        });
        await this.file.update(candidate => { for (const [code, value] of values) candidate.crypto[code] = value; }, { signal: this.abort.signal });
      })().catch(error => {
        this.cryptoError = error instanceof ProviderError ? error : new ProviderError('NETWORK');
        this.cryptoRetryAt = this.now() + Math.max(60_000, this.cryptoError.retryAfterMs ?? 0);
        throw error;
      }).finally(() => { this.cryptoTask = undefined; });
      await cancellable(this.cryptoTask, signal);
    }
    throw new ProviderError('NETWORK');
  }
  async currencies(page: number, signal: AbortSignal): Promise<RateCurrencies> {
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    try { await this.refreshFiat(signal); } catch (error) { throwIfAborted(signal); if (!this.snapshot().fiat) throw await this.safe(error); }
    const entries = (await this.catalog()).list();
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    const selected = Math.max(0, Math.min(page, Math.ceil(entries.length / 10) - 1));
    return { items: [...entries.slice(selected * 10, selected * 10 + 10)], total: entries.length, page: selected, pageSize: 10 };
  }
  private async safe(error: unknown): Promise<AppError> {
    if (error instanceof AppError) return error;
    if (this.runtimeTask) {
      const runtime = await this.runtimeTask.catch(() => undefined);
      if (runtime && error instanceof runtime.CurrencyParseError) return new AppError('INVALID_INPUT', [`rate.${error.code}`]);
    }
    return new AppError('UNAVAILABLE', [`provider.${error instanceof ProviderError ? error.code : 'NETWORK'}`]);
  }
  async convert(input: RateInput, signal: AbortSignal): Promise<RateResult> {
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    try {
      let fiatFailure: unknown;
      try { await this.refreshFiat(signal); } catch (error) { throwIfAborted(signal); fiatFailure = error; }
      const catalog = await this.catalog();
      const { CurrencyParseError, parseAmount, Money } = await this.runtime();
      throwIfAborted(signal); throwIfAborted(this.abort.signal);
      let parsed: CurrencyParse;
      if (input.query) parsed = catalog.parse(input.query);
      else {
        const from = catalog.resolve(input.from!); const to = catalog.resolve(input.to!);
        if (!from.length || !to.length) throw new CurrencyParseError('CURRENCY');
        const amount = parseAmount(input.amount ?? '1');
        parsed = from.length === 1 && to.length === 1 ? { kind: 'conversion', amount, from: from[0]!.code, to: to[0]!.code }
          : { kind: 'ambiguous', amount, from: from.map(item => item.code), to: to.map(item => item.code) };
      }
      const definitions = catalog.list();
      const definition = (code: string) => definitions.find(item => item.code === code)!;
      if (parsed.kind === 'ambiguous') return { kind: 'ambiguous', amount: parsed.amount, from: parsed.from.map(definition), to: parsed.to.map(definition) };
      const from = definition(parsed.from); const to = definition(parsed.to);
      const needsFiat = [from, to].some(currency => currency.kind === 'fiat' && currency.code !== 'USD');
      const fiat = this.snapshot().fiat;
      if (needsFiat && (!fiat || this.now() - fiat.updatedAt > 7 * 86_400_000)) throw fiatFailure ?? new ProviderError('NETWORK');
      await this.coins([from, to], signal);
      const state = this.snapshot();
      const usdValue = (currency: CurrencyDefinition) => currency.kind === 'crypto' ? new Money(state.crypto[currency.code]!.usd)
        : currency.code === 'USD' ? new Money(1) : new Money(1).div(fiat!.rates[currency.code]!);
      const rate = usdValue(from).div(usdValue(to));
      throwIfAborted(signal);
      const sources: Extract<RateResult, { kind: 'converted' }>['sources'] = [];
      if (needsFiat) sources.push({ name: 'ExchangeRate-API', updatedAt: new Date(fiat!.updatedAt).toISOString(), url: 'https://www.exchangerate-api.com' });
      if ([from, to].some(currency => currency.kind === 'crypto')) sources.push({ name: 'CoinGecko', updatedAt: new Date(Math.min(...[from, to].filter(item => item.kind === 'crypto').map(item => state.crypto[item.code]!.updatedAt))).toISOString(), url: 'https://www.coingecko.com' });
      return { kind: 'converted', amount: parsed.amount, from, to, result: new Money(parsed.amount).mul(rate).toSignificantDigits(24).toFixed(),
        unitRate: rate.toSignificantDigits(18).toFixed(), stale: Boolean(needsFiat && fiat && this.now() >= fiat.nextAt), sources };
    } catch (error) { throwIfAborted(signal); throw await this.safe(error); }
  }
  async stop(): Promise<void> { this.abort.abort(); await Promise.allSettled([this.fiatTask, this.cryptoTask, this.runtimeTask]); this.catalogValue = undefined; this.catalogCodes = undefined; }
}
