import { z } from 'zod';
import { revisionSchema, type Locale } from '../../shared/schemas/index.js';
import {
  weatherDefaultInputSchema, weatherDefaultSchema, weatherQueryInputSchema, weatherResultSchema,
  type WeatherLocation, type WeatherQueryInput, type WeatherResult, type WeatherSearchInput,
} from '../../shared/schemas/weather.js';
import { AppError, throwIfAborted } from '../errors.js';
import { JsonDocument, type JsonStorage } from '../storage.js';
import { cancellable, createProviderJson, list, number, object, ProviderError, string, type ProviderJson } from './provider-http.js';

export { weatherMetadata } from './metadata.js';
export { registerWeatherActions } from './module-actions.js';
const fileSchema = z.strictObject({ schema_version: z.literal(1), revision: revisionSchema,
  users: z.record(z.string().regex(/^[1-9]\d*$/), weatherDefaultSchema),
});
export interface WeatherOptions { qweatherHost?: string; qweatherKey?: string; openWeatherKey?: string; openMeteo?: boolean; json?: ProviderJson; now?: () => number }
export interface WeatherIntent { query: string; mode: 'current' | 'forecast'; days: number }
export function parseWeatherIntent(input: string, forecast = false): WeatherIntent {
  let query = input.normalize('NFKC').trim();
  let mode: WeatherIntent['mode'] = forecast || /预报|預報|forecast|予報|明天|明日|tomorrow|后天|後天|未来|未來/i.test(query) ? 'forecast' : 'current';
  let days = /后天|後天|未来|未來/.test(query) ? 3 : /明天|明日|tomorrow/i.test(query) ? 2 : 3;
  const amount = /(?:\s|^)([1-7])\s*$/.exec(query) ?? /([1-7])\s*(?:天|日|days?)\s*$/i.exec(query);
  if (amount) { days = Number(amount[1]); mode = 'forecast'; query = query.slice(0, amount.index).trim(); }
  query = query.replace(/^(?:请问|請問|请|請)?\s*(?:查一下|查询|查詢|查看)?\s*/, '')
    .replace(/^(?:weather|forecast|天气预报|天氣預報|天气|天氣|天気)\s*(?:in\s+|for\s+)?/i, '')
    .replace(/\s+(?:today|tomorrow)[?？]?$/i, '')
    .replace(/^(?:今天|今日|明天|明日|后天|後天)\s*/, '')
    .replace(/\s*(?:今天|今日|明天|明日|后天|後天|未来|未來|today|tomorrow)?\s*(?:的|の)?\s*(?:天气预报|天氣預報|天气|天氣|天気|forecast|weather|予報)(?:怎么样|怎麼樣|如何|どう|ですか)?[?？]?$/i, '')
    .replace(/(?:未来|未來)$/, '').trim();
  if (query.length > 120 || /\p{Cc}/u.test(query)) throw new AppError('INVALID_INPUT');
  return { query, mode, days };
}
export function isWeatherIntent(text: string): boolean {
  return text.length <= 160 && !text.startsWith('/') && /(?:^weather\s+(?:in|for)\s+.+|^forecast\s+.+|.{2,}(?:天气|天氣|天気|天气预报|天氣預報|予報)(?:怎么样|怎麼樣|如何|ですか)?[?？]?)$/i.test(text.trim());
}
function language(locale: Locale): string { return locale === 'zh-CN' ? 'zh' : locale === 'zh-TW' ? 'zh-hant' : locale; }
function tidy(value: unknown, max = 128): string { return string(value).replace(/\p{Cc}/gu, ' ').slice(0, max); }
function coarse(value: number): number { return Math.round(value * 100) / 100; }
const dateFormatters = new Map<string, Intl.DateTimeFormat>();
function dateFormatter(zone: string): Intl.DateTimeFormat {
  let formatter = dateFormatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' });
    dateFormatters.set(zone, formatter);
    if (dateFormatters.size > 8) dateFormatters.delete(dateFormatters.keys().next().value!);
  }
  return formatter;
}
function timezone(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 64) return undefined;
  try { dateFormatter(value); return value; } catch { return undefined; }
}
function geoQuery(query: string): { name: string; adm?: string; district: boolean } {
  const value = query.replace(/[，,]/g, ' ').trim();
  const pieces = value.split(/\s+/);
  if (pieces.length > 1) return { name: pieces.at(-1)!, adm: pieces.slice(0, -1).join(' '), district: /区|區|县|縣|旗/.test(pieces.at(-1)!) };
  const qualified = /^(?:.+?(?:省|自治区|自治區))?(.+?(?:市|州|盟))(.+(?:区|區|县|縣|旗|市))$/.exec(value)
    ?? /^(.+?(?:都|道|府|県))(.+(?:区|區|市|町|村))$/.exec(value);
  if (qualified) return { name: qualified[2]!, adm: qualified[1]!, district: true };
  const prefix = /^(北京|上海|天津|重庆|重慶|广州|廣州|深圳|杭州|成都|南京|武汉|武漢|西安|长沙|長沙|苏州|蘇州|東京|大阪)(.+)$/.exec(value);
  if (prefix) return { name: prefix[2]!, adm: prefix[1]!, district: true };
  return { name: value, district: /(?:区|區|县|縣|旗)$/.test(value) };
}
function relevant(name: string, wanted: string): boolean {
  const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/(?:特别行政区|特別行政區|新区|新區|区|區|县|縣|市|旗|省|都|府|県)$/g, '');
  return normalize(name).includes(normalize(wanted));
}
function geoLocation(row: Record<string, unknown>, provider: string): WeatherLocation | undefined {
  const latitude = number(row.lat ?? row.latitude); const longitude = number(row.lon ?? row.longitude);
  if (latitude === undefined || longitude === undefined || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return undefined;
  const name = tidy(row.name);
  const country = tidy(row.country, 80);
  const parts = [country, tidy(row.adm1 ?? row.admin1 ?? row.state), tidy(row.adm2 ?? row.admin2), name].filter(Boolean);
  const label = [...new Set(parts)].join(' / ').slice(0, 300) || `${coarse(latitude)}, ${coarse(longitude)}`;
  const zone = timezone(row.tz ?? row.timezone);
  return { id: `${provider}:${tidy(row.id, 60) || `${coarse(latitude)},${coarse(longitude)}`}`, name, label,
    latitude: coarse(latitude), longitude: coarse(longitude), country, ...(zone ? { timezone: zone } : {}) };
}
function localDate(value: unknown, zone = 'UTC'): string {
  const date = typeof value === 'number' ? new Date(value * 1000) : new Date(string(value));
  if (!Number.isFinite(date.getTime())) throw new ProviderError('INVALID_RESPONSE');
  return dateFormatter(zone).format(date);
}
function attributes(data: unknown, fallback: string): string[] {
  const urls = list(data).filter((value): value is string => {
    if (typeof value !== 'string' || value.length > 500) return false;
    try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
  }).slice(0, 8);
  return urls.length ? urls : [fallback];
}

export const WEATHER_CACHE_MAX_BYTES = 128 * 1024;
export const WEATHER_MAX_TASKS = 4;
function retainedBytes(value: unknown): number {
  if (typeof value === 'string') return 32 + value.length * 2;
  if (Array.isArray(value)) return 32 + value.reduce((bytes, item) => bytes + 8 + retainedBytes(item), 0);
  if (value && typeof value === 'object') return 32 + Object.entries(value).reduce((bytes, [key, item]) => bytes + 16 + retainedBytes(key) + retainedBytes(item), 0);
  return 8;
}

export class WeatherService {
  private readonly file: JsonDocument<z.infer<typeof fileSchema>>;
  private readonly json: ProviderJson;
  private readonly now: () => number;
  private readonly abort = new AbortController();
  private readonly cache = new Map<string, { expires: number; value: unknown; bytes: number }>();
  private cacheBytes = 0;
  private readonly tasks = new Map<string, Promise<unknown>>();
  private readonly cooldown = new Map<string, number>();
  constructor(storage: JsonStorage, private readonly options: WeatherOptions = {}) {
    this.file = new JsonDocument(storage, 'weather.json', fileSchema);
    this.json = options.json ?? createProviderJson(['api.openweathermap.org', 'api.open-meteo.com', 'geocoding-api.open-meteo.com', ...(options.qweatherHost ? [options.qweatherHost] : [])]);
    this.now = options.now ?? Date.now;
  }
  async initialize(): Promise<void> { await this.file.load({ schema_version: 1, revision: 0, users: {} }); }
  getDefault(userId: number) { return this.file.snapshot().users[String(userId)] ?? { revision: 0, location: null }; }
  async setDefault(userId: number, value: z.infer<typeof weatherDefaultInputSchema>, signal: AbortSignal) {
    weatherDefaultInputSchema.parse(value);
    await this.file.update(state => {
      const current = state.users[String(userId)];
      if ((current?.revision ?? 0) !== value.revision) throw new AppError('CONFLICT');
      if (!current && Object.keys(state.users).length >= 10_000) throw new AppError('CAPACITY');
      state.users[String(userId)] = { revision: value.revision + 1, location: value.location ? { ...value.location, latitude: coarse(value.location.latitude), longitude: coarse(value.location.longitude) } : null };
    }, { signal });
    return this.getDefault(userId);
  }
  private async memo<T>(key: string, ttl: number, loader: () => Promise<T>, signal: AbortSignal): Promise<T> {
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    for (const [entryKey, entry] of this.cache) if (entry.expires <= this.now()) {
      this.cache.delete(entryKey); this.cacheBytes -= entry.bytes;
    }
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key); this.cache.set(key, cached);
      return structuredClone(cached.value) as T;
    }
    if (!this.tasks.has(key)) {
      if (this.tasks.size >= WEATHER_MAX_TASKS) throw new AppError('CAPACITY');
      const task = loader().then(value => {
        throwIfAborted(this.abort.signal);
        const bytes = retainedBytes(value) + retainedBytes(key) + 64;
        if (bytes <= WEATHER_CACHE_MAX_BYTES) {
          while (this.cache.size >= 32 || this.cacheBytes + bytes > WEATHER_CACHE_MAX_BYTES) {
            const oldest = this.cache.keys().next().value!;
            this.cacheBytes -= this.cache.get(oldest)!.bytes; this.cache.delete(oldest);
          }
          this.cache.set(key, { expires: this.now() + ttl, value, bytes }); this.cacheBytes += bytes;
        }
        return value;
      }).finally(() => { this.tasks.delete(key); });
      this.tasks.set(key, task);
    }
    return structuredClone(await cancellable(this.tasks.get(key)!, signal)) as T;
  }
  private error(error: unknown): AppError {
    if (error instanceof AppError) return error;
    return new AppError('UNAVAILABLE', [`provider.${error instanceof ProviderError ? error.code : 'NETWORK'}`]);
  }
  private async qweather(path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
    if (!this.options.qweatherHost || !this.options.qweatherKey) throw new ProviderError('NOT_CONFIGURED');
    const url = new URL(`https://${this.options.qweatherHost}${path}`);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    const value = object(await this.json(url, this.abort.signal, { 'X-QW-Api-Key': this.options.qweatherKey }));
    if (value.code && value.code !== '200' && value.code !== '204' && value.code !== '404') throw new ProviderError(['401', '403'].includes(String(value.code)) ? 'AUTH' : ['402', '429'].includes(String(value.code)) ? 'QUOTA' : 'NETWORK');
    return value;
  }
  async search(input: WeatherSearchInput, locale: Locale, signal: AbortSignal): Promise<{ locations: WeatherLocation[] }> {
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    try {
      const query = input.query?.normalize('NFKC').trim();
      const coordinate = query && /^(-?\d+(?:\.\d+)?)\s*[,，]\s*(-?\d+(?:\.\d+)?)$/.exec(query);
      const latitude = input.latitude ?? (coordinate ? Number(coordinate[1]) : undefined);
      const longitude = input.longitude ?? (coordinate ? Number(coordinate[2]) : undefined);
      if (latitude !== undefined && longitude !== undefined) {
        if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180) throw new AppError('INVALID_INPUT');
        const lat = coarse(latitude); const lon = coarse(longitude);
        return await this.memo(`coord:${lat}:${lon}:${locale}`, 3_600_000, async () => {
          let nearby: WeatherLocation | undefined;
          try {
            const data = await this.qweather('/geo/v2/city/lookup', { location: `${lon},${lat}`, number: '1', lang: language(locale) });
            nearby = geoLocation(object(list(data.location)[0]), 'qweather');
          } catch { throwIfAborted(this.abort.signal); }
          return { locations: [{ ...(nearby ?? { name: '', country: '', label: `${lat}, ${lon}` }), id: `coordinates:${lat},${lon}`, latitude: lat, longitude: lon }] };
        }, signal);
      }
      if (!query || query.length > 120 || /\p{Cc}/u.test(query)) throw new AppError('INVALID_INPUT');
      return await this.memo(`search:${query}:${locale}`, 3_600_000, async () => {
        const part = geoQuery(query);
        const han = /\p{Script=Han}/u.test(query);
        let last: unknown;
        if (this.options.qweatherHost && this.options.qweatherKey) {
          try {
            const data = await this.qweather('/geo/v2/city/lookup', { location: part.name, ...(part.adm ? { adm: part.adm } : {}), number: '10', lang: han && locale !== 'ja' ? 'zh' : language(locale) });
            const locations = list(data.location).map(object).filter(row => !/[区區]$/.test(part.name)
              || !/[县縣市町村]$/.test(tidy(row.name)) && tidy(row.name) !== tidy(row.adm2))
              .map(row => geoLocation(row, 'qweather')).filter((row): row is WeatherLocation => Boolean(row))
              .filter(row => (!part.district || relevant(row.name, part.name)) && (!part.adm || relevant(row.label, part.adm)));
            if (locations.length) return { locations: locations.slice(0, 10) };
          } catch (error) { throwIfAborted(this.abort.signal); last = error; }
        }
        if (this.options.openWeatherKey) {
          try {
            const url = new URL('https://api.openweathermap.org/geo/1.0/direct');
            url.searchParams.set('q', query); url.searchParams.set('limit', '5'); url.searchParams.set('appid', this.options.openWeatherKey);
            const data = list(await this.json(url, this.abort.signal));
            const locations = data.map(value => {
              const row = object(value); const names = object(row.local_names);
              return geoLocation({ ...row, name: names[locale === 'zh-CN' || locale === 'zh-TW' ? 'zh' : locale] ?? row.name }, 'openweather');
            }).filter((row): row is WeatherLocation => Boolean(row)).filter(row => !part.district || relevant(row.name, part.name));
            if (locations.length) return { locations };
          } catch (error) { throwIfAborted(this.abort.signal); last = error; }
        }
        if (this.options.openMeteo === false) { if (last) throw last; return { locations: [] }; }
        try {
          const url = new URL('https://geocoding-api.open-meteo.com/v1/search');
          url.searchParams.set('name', part.name); url.searchParams.set('count', '10'); url.searchParams.set('language', han ? 'zh' : locale); url.searchParams.set('format', 'json');
          const data = object(await this.json(url, this.abort.signal));
          const locations = list(data.results).map(value => geoLocation(object(value), 'open-meteo')).filter((row): row is WeatherLocation => Boolean(row))
            .filter(row => (!part.district || relevant(row.name, part.name)) && (!part.adm || relevant(row.label, part.adm)));
          return { locations: locations.slice(0, 10) };
        } catch (error) { throwIfAborted(this.abort.signal); throw last ?? error; }
      }, signal);
    } catch (error) { throwIfAborted(signal); throw this.error(error); }
  }
  private blank(input: WeatherQueryInput, provider: WeatherResult['provider']): WeatherResult {
    return { location: input.location, provider, fetchedAt: new Date(this.now()).toISOString(), observedAt: null, description: '', code: null,
      temperature: null, feelsLike: null, humidity: null, windKph: null, precipitation: null, days: [], attributions: [], model: provider === 'open-meteo', fallback: false };
  }
  private async queryProvider(input: WeatherQueryInput, locale: Locale, provider: WeatherResult['provider']): Promise<WeatherResult> {
    const result = this.blank(input, provider);
    const { latitude, longitude } = input.location;
    if (provider === 'qweather') {
      const data = await this.qweather(`/weather/v1/${input.mode === 'current' ? 'current' : 'daily'}/${latitude.toFixed(2)}/${longitude.toFixed(2)}`,
        { lang: language(locale), ...(input.mode === 'forecast' ? { days: String(input.days) } : {}) });
      result.attributions = attributes(object(data.metadata).attributions, 'https://developer.qweather.com/attribution.html');
      if (input.mode === 'current') {
        result.description = tidy(object(data.condition).text, 200);
        result.code = number(object(data.condition).code) ?? null;
        result.temperature = number(object(data.temperature).value) ?? null;
        result.feelsLike = number(object(data.feelsLike).value) ?? null;
        result.humidity = data.humidity === undefined ? null : Math.round((number(data.humidity) ?? 0) * 100);
        result.windKph = number(object(object(data.wind).speed).value) === undefined ? null : number(object(object(data.wind).speed).value)! * 3.6;
        result.precipitation = number(object(object(data.precipitation).amount).value) ?? null;
      } else result.days = list(data.days).slice(0, input.days).map(value => {
        const day = object(value); const part = object(day.daytime); const rain = object(part.precipitation);
        return { date: localDate(day.forecastStartTime, input.location.timezone), min: number(object(day.temperatureMin).value) ?? null,
          max: number(object(day.temperatureMax).value) ?? null, description: tidy(object(part.condition).text, 200), code: number(object(part.condition).code) ?? null,
          precipitation: number(object(rain.amount).value) ?? null, probability: number(rain.probability) === undefined ? null : Math.round(number(rain.probability)! * 100) };
      });
    } else if (provider === 'openweather') {
      if (!this.options.openWeatherKey) throw new ProviderError('NOT_CONFIGURED');
      const url = new URL(`https://api.openweathermap.org/data/2.5/${input.mode === 'current' ? 'weather' : 'forecast'}`);
      for (const [key, value] of Object.entries({ lat: String(latitude), lon: String(longitude), units: 'metric', lang: locale === 'zh-CN' ? 'zh_cn' : locale === 'zh-TW' ? 'zh_tw' : locale, appid: this.options.openWeatherKey })) url.searchParams.set(key, value);
      const data = object(await this.json(url, this.abort.signal));
      result.attributions = ['https://openweathermap.org'];
      if (input.mode === 'current') {
        const main = object(data.main);
        result.description = tidy(object(list(data.weather)[0]).description, 200);
        result.code = number(object(list(data.weather)[0]).id) ?? null;
        result.temperature = number(main.temp) ?? null; result.feelsLike = number(main.feels_like) ?? null; result.humidity = number(main.humidity) ?? null;
        result.windKph = number(object(data.wind).speed) === undefined ? null : number(object(data.wind).speed)! * 3.6;
        result.precipitation = number(object(data.rain)['1h']) ?? null;
        if (number(data.dt)) result.observedAt = new Date(number(data.dt)! * 1000).toISOString();
      } else {
        const days = new Map<string, WeatherResult['days'][number]>();
        const offset = number(object(data.city).timezone) ?? 0;
        for (const value of list(data.list)) {
          const item = object(value); const main = object(item.main); const epoch = number(item.dt);
          if (epoch === undefined) continue;
          const date = new Date((epoch + offset) * 1000).toISOString().slice(0, 10);
          const min = number(main.temp_min); const max = number(main.temp_max);
          if (min === undefined || max === undefined) continue;
          const day = days.get(date) ?? { date, min, max, description: tidy(object(list(item.weather)[0]).description, 200), code: number(object(list(item.weather)[0]).id) ?? null, precipitation: 0, probability: 0 };
          day.min = Math.min(day.min ?? min, min); day.max = Math.max(day.max ?? max, max);
          day.precipitation = (day.precipitation ?? 0) + (number(object(item.rain)['3h']) ?? 0);
          day.probability = Math.max(day.probability ?? 0, Math.round((number(item.pop) ?? 0) * 100));
          days.set(date, day);
        }
        result.days = [...days.values()].slice(0, input.days);
      }
    } else {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      const params = { latitude: String(latitude), longitude: String(longitude), timezone: 'auto', timeformat: 'unixtime', wind_speed_unit: 'kmh',
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation',
        ...(input.mode === 'forecast' ? { forecast_days: String(input.days), daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max' } : {}),
      };
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      const data = object(await this.json(url, this.abort.signal));
      const current = object(data.current);
      result.temperature = number(current.temperature_2m) ?? null; result.feelsLike = number(current.apparent_temperature) ?? null;
      result.humidity = number(current.relative_humidity_2m) ?? null; result.windKph = number(current.wind_speed_10m) ?? null;
      result.precipitation = number(current.precipitation) ?? null; result.code = number(current.weather_code) ?? null;
      if (number(current.time)) result.observedAt = new Date(number(current.time)! * 1000).toISOString();
      const zone = timezone(data.timezone) ?? input.location.timezone;
      result.location = { ...input.location, ...(zone ? { timezone: zone } : {}) };
      result.attributions = ['https://open-meteo.com/'];
      if (input.mode === 'forecast') {
        const daily = object(data.daily);
        result.days = list(daily.time).slice(0, input.days).map((time, index) => ({ date: localDate(time, result.location.timezone),
          min: number(list(daily.temperature_2m_min)[index]) ?? null, max: number(list(daily.temperature_2m_max)[index]) ?? null,
          description: '', code: number(list(daily.weather_code)[index]) ?? null,
          precipitation: number(list(daily.precipitation_sum)[index]) ?? null, probability: number(list(daily.precipitation_probability_max)[index]) ?? null,
        }));
      }
    }
    if (input.mode === 'current' ? result.temperature === null : !result.days.length) throw new ProviderError('INVALID_RESPONSE');
    const parsed = weatherResultSchema.safeParse(result);
    if (!parsed.success) throw new ProviderError('INVALID_RESPONSE');
    return parsed.data;
  }
  async query(raw: WeatherQueryInput, locale: Locale, signal: AbortSignal): Promise<WeatherResult> {
    throwIfAborted(signal); throwIfAborted(this.abort.signal);
    try {
      const { timezone: rawZone, ...location } = raw.location;
      const zone = timezone(rawZone);
      const input = { ...raw, location: { ...location, latitude: coarse(location.latitude), longitude: coarse(location.longitude), ...(zone ? { timezone: zone } : {}) } };
      weatherQueryInputSchema.parse(input);
      const key = `weather:${input.location.latitude}:${input.location.longitude}:${input.mode}:${input.days}:${locale}:${zone ?? ''}`;
      const value = await this.memo(key, 600_000, async () => {
        const providers: WeatherResult['provider'][] = [...(this.options.qweatherHost && this.options.qweatherKey ? ['qweather' as const] : []),
          ...(this.options.openWeatherKey ? ['openweather' as const] : []), ...(this.options.openMeteo === false ? [] : ['open-meteo' as const])];
        if (!providers.length) throw new ProviderError('NOT_CONFIGURED');
        let last: unknown;
        for (const [index, provider] of providers.entries()) {
          if ((this.cooldown.get(provider) ?? 0) > this.now()) continue;
          try {
            // Shared entries retain coordinates/provider timezone, never a caller's personal label.
            const value = await this.queryProvider({ ...input, location: {
              ...input.location, id: 'coordinates', name: '', label: `${input.location.latitude}, ${input.location.longitude}`, country: '',
            } }, locale, provider);
            return { ...value, fallback: index > 0 };
          } catch (error) {
            throwIfAborted(this.abort.signal); last = error;
            this.cooldown.set(provider, this.now() + (error instanceof ProviderError && error.code === 'NOT_FOUND' ? 0 : Math.max(60_000, error instanceof ProviderError ? error.retryAfterMs ?? 0 : 0)));
          }
        }
        throw last ?? new ProviderError('NETWORK');
      }, signal);
      const resultZone = value.location.timezone ?? input.location.timezone;
      return { ...value, location: { ...input.location, ...(resultZone ? { timezone: resultZone } : {}) } };
    } catch (error) { throwIfAborted(signal); throw this.error(error); }
  }
  async stop(): Promise<void> { this.abort.abort(); await Promise.allSettled(this.tasks.values()); this.cache.clear(); this.cacheBytes = 0; this.cooldown.clear(); }
}
