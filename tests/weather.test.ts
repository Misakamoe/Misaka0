import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, type ProviderJson } from '../src/modules/provider-http.js';
import { isWeatherIntent, parseWeatherIntent, WeatherService, WEATHER_MAX_TASKS } from '../src/modules/weather.js';
import { coreFixture, invocation } from './support/core.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const location = { id: 'qweather:haidian', name: '海淀', label: '中国 / 北京市 / 北京 / 海淀', latitude: 39.96, longitude: 116.30, country: '中国', timezone: 'Asia/Shanghai' };
const current = { condition: { code: 100, text: '晴' }, temperature: { value: 0 }, feelsLike: { value: -1 }, humidity: 0.5, wind: { speed: { value: 2 } }, precipitation: { amount: { value: 0 } } };
async function fixture() {
  const json = vi.fn<ProviderJson>(async url => url.pathname.includes('/geo/')
    ? { code: '200', location: [{ id: 'haidian', name: '海淀', adm1: '北京市', adm2: '北京', country: '中国', lat: '39.96', lon: '116.30', tz: 'Asia/Shanghai' }] }
    : url.pathname.includes('/daily/') ? { days: [{ forecastStartTime: '2026-11-09T16:00:00Z', temperatureMin: { value: -3 }, temperatureMax: { value: 8 }, daytime: { condition: { code: 305, text: '雨' }, precipitation: { amount: { value: 2 }, probability: 0.25 } } }] }
      : current);
  const options = { json, qweatherHost: 'test.qweatherapi.com', qweatherKey: 'TEST_ONLY_WEATHER_SECRET', openWeatherKey: 'TEST_ONLY_OWM_SECRET' };
  const f = await coreFixture({ weather: options }); cleanup.push(f.close);
  return { ...f, json, options };
}
describe('weather service and location privacy', () => {
  it.each(['北京市海淀区', '北京海淀区', '北京 海淀区'])('uses district and parent filters for %s without falling back to the city centre', async query => {
    const f = await fixture();
    expect(await f.weather.search({ query }, 'zh-CN', new AbortController().signal)).toMatchObject({ locations: [location] });
    expect(f.json.mock.calls[0]![0].searchParams.get('location')).toBe('海淀区');
    expect(f.json.mock.calls[0]![0].searchParams.get('adm')).toMatch(/北京/);
    expect(f.json.mock.calls[0]![2]).toEqual({ 'X-QW-Api-Key': 'TEST_ONLY_WEATHER_SECRET' });
    expect(f.json.mock.calls[0]![0].href).not.toContain('SECRET');
  });
  it('uses rounded latitude/longitude in the correct provider order without saving a default', async () => {
    const f = await fixture();
    const result = await f.weather.search({ latitude: 39.961234, longitude: 116.301234 }, 'en', new AbortController().signal);
    expect(result.locations[0]).toMatchObject({ latitude: 39.96, longitude: 116.30 });
    expect(f.json.mock.calls[0]![0].searchParams.get('location')).toBe('116.3,39.96');
    const weather = await f.weather.query({ location, mode: 'current', days: 3 }, 'zh-CN', new AbortController().signal);
    expect(weather).toMatchObject({ temperature: 0, humidity: 50, windKph: 7.2, precipitation: 0, provider: 'qweather', code: 100 });
    expect(f.json.mock.calls[1]![0].pathname).toContain('/39.96/116.30');
    expect(f.weather.getDefault(10)).toEqual({ revision: 0, location: null });
  });
  it('parses daily forecast dates in the selected location timezone', async () => {
    const f = await fixture();
    expect(await f.weather.query({ location, mode: 'forecast', days: 3 }, 'en', new AbortController().signal)).toMatchObject({ days: [{ date: '2026-11-10', min: -3, max: 8, description: '雨', code: 305, probability: 25 }] });
  });
  it('only persists an explicit default, keeps it private and rejects stale revisions after clearing', async () => {
    const f = await fixture();
    await f.weather.setDefault(10, { revision: 0, location: { ...location, latitude: 39.961111, longitude: 116.301234 } }, new AbortController().signal);
    expect(f.weather.getDefault(10)).toMatchObject({ revision: 1, location });
    expect(f.weather.getDefault(11).location).toBeNull();
    const restored = new WeatherService(f.storage, f.options); cleanup.push(() => restored.stop());
    await restored.initialize(); expect(restored.getDefault(10)).toMatchObject({ revision: 1, location });
    await f.weather.setDefault(10, { revision: 1, location: null }, new AbortController().signal);
    await expect(f.weather.setDefault(10, { revision: 1, location }, new AbortController().signal)).rejects.toThrow('CONFLICT');
    await f.access.authorize(-100, 'Group', 1, 0);
    expect(await f.executor.execute(invocation({ actorId: 10, chat: { id: -100, type: 'supergroup' } }), 'weather.default.get', {})).toMatchObject({ status: 'rejected', error: { code: 'FORBIDDEN' } });
  });
  it('caches weather without leaking another caller location label', async () => {
    const f = await fixture();
    await f.weather.query({ location: { ...location, label: 'Private user label' }, mode: 'current', days: 3 }, 'en', new AbortController().signal);
    const result = await f.weather.query({ location, mode: 'current', days: 3 }, 'en', new AbortController().signal);
    expect(result.location.label).toBe(location.label);
    expect(f.json).toHaveBeenCalledTimes(1);
  });
  it('bounds retained weather bytes before its entry-count limit and isolates returned objects', async () => {
    const f = await fixture();
    f.json.mockResolvedValue({ ...current, metadata: { attributions: Array.from({ length: 8 }, (_, i) => `https://example.com/${i}/${'x'.repeat(460)}`) } });
    const signal = new AbortController().signal;
    const input = { location, mode: 'current' as const, days: 3 };
    const first = await f.weather.query(input, 'en', signal);
    first.attributions[0] = 'https://changed.example/';
    expect((await f.weather.query(input, 'en', signal)).attributions[0]).not.toBe(first.attributions[0]);
    for (let i = 1; i < 20; i++) await f.weather.query({ ...input, location: { ...location, latitude: i } }, 'en', signal);
    expect(f.json).toHaveBeenCalledTimes(20);
    await f.weather.query(input, 'en', signal);
    expect(f.json).toHaveBeenCalledTimes(21);
  });
  it('shares bounded requests without letting one caller cancel another and drains actual work', async () => {
    const f = await fixture();
    const release = Promise.withResolvers<void>();
    f.json.mockImplementation(async () => { await release.promise; return current; });
    const signal = new AbortController().signal;
    const controller = new AbortController();
    const input = { location, mode: 'current' as const, days: 3 };
    const first = f.weather.query(input, 'en', controller.signal);
    const cancelled = expect(first).rejects.toThrow('CANCELLED');
    const second = f.weather.query({ ...input, location: { ...location, label: 'Other caller' } }, 'en', signal);
    const other = Array.from({ length: WEATHER_MAX_TASKS - 1 }, (_, i) => f.weather.query({ ...input, location: { ...location, latitude: i } }, 'en', signal));
    await expect(f.weather.query({ ...input, location: { ...location, latitude: 80 } }, 'en', signal)).rejects.toThrow('CAPACITY');
    expect(f.json).toHaveBeenCalledTimes(WEATHER_MAX_TASKS);
    controller.abort(); await cancelled;
    expect(f.json.mock.calls.every(([, request]) => !request.aborted)).toBe(true);
    release.resolve();
    expect((await second).location.label).toBe('Other caller');
    await Promise.all(other);
    const gate = Promise.withResolvers<void>();
    f.json.mockImplementation(async () => { await gate.promise; return current; });
    const pending = f.weather.query({ ...input, location: { ...location, latitude: 70 } }, 'en', signal);
    const rejected = expect(pending).rejects.toThrow('CANCELLED');
    let stopped = false;
    const stop = f.weather.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false);
    gate.resolve(); await rejected; await stop;
    await expect(f.weather.query(input, 'en', signal)).rejects.toThrow('CANCELLED');
  });
  it('keeps duplicate place names as choices and rejects an incorrect parent region', async () => {
    const f = await fixture();
    f.json.mockImplementation(async url => url.pathname.includes('/geo/v2/') ? { code: '200', location: [
      { id: 'beijing', name: '朝阳', adm1: '北京市', adm2: '北京', country: '中国', lat: '39.9', lon: '116.4' },
      { id: 'changchun', name: '朝阳', adm1: '吉林省', adm2: '长春', country: '中国', lat: '43.8', lon: '125.3' },
      { id: 'liaoning', name: '朝阳', adm1: '辽宁省', adm2: '朝阳', country: '中国', lat: '41.6', lon: '120.4' },
      { id: 'county', name: '朝阳县', adm1: '辽宁省', adm2: '朝阳', country: '中国', lat: '41.5', lon: '120.4' },
    ] } : []);
    expect((await f.weather.search({ query: '朝阳区' }, 'zh-CN', new AbortController().signal)).locations).toHaveLength(2);
    expect((await f.weather.search({ query: '北京朝阳区' }, 'zh-CN', new AbortController().signal)).locations.map(item => item.id)).toEqual(['qweather:beijing']);
  });
  it('falls back transparently and does not forward QWeather headers to another vendor', async () => {
    const f = await fixture();
    f.json.mockImplementation(async url => {
      if (url.hostname.endsWith('qweatherapi.com')) throw new ProviderError('AUTH');
      return { main: { temp: 12, feels_like: 11, humidity: 60 }, weather: [{ id: 800, description: 'clear' }], wind: { speed: 3 }, dt: 1794182400 };
    });
    expect(await f.weather.query({ location, mode: 'current', days: 3 }, 'en', new AbortController().signal)).toMatchObject({ provider: 'openweather', fallback: true, temperature: 12, code: 800 });
    expect(f.json.mock.calls[1]![2]).toBeUndefined();
    expect(f.json.mock.calls[1]![0].searchParams.has('appid')).toBe(true);
  });
  it.each([
    ['北京市海淀区', '北京市海淀区', 'current', 3], ['北京海淀区明天天气', '北京海淀区', 'forecast', 2],
    ['明天北京天气', '北京', 'forecast', 2], ['Tokyo weather tomorrow', 'Tokyo', 'forecast', 2], ['weather in Tokyo', 'Tokyo', 'current', 3],
    ['東京の天気', '東京', 'current', 3], ['北京未来3天', '北京', 'forecast', 3],
  ] as const)('parses weather request %s', (input, query, mode, days) => {
    expect(parseWeatherIntent(input)).toEqual({ query, mode, days });
  });
  it('does not classify unrelated chat as a weather lookup', () => {
    expect(isWeatherIntent('北京海淀区天气')).toBe(true);
    expect(isWeatherIntent('今天聊天气氛不错')).toBe(false);
    expect(isWeatherIntent('/other 天气')).toBe(false);
  });
  it('can disable public Open-Meteo endpoints without making an unexpected fallback request', async () => {
    const json = vi.fn<ProviderJson>(async () => { throw new Error('Unexpected public request'); });
    const f = await coreFixture({ weather: { openMeteo: false, json } }); cleanup.push(f.close);
    await expect(f.weather.query({ location, mode: 'current', days: 3 }, 'en', new AbortController().signal)).rejects.toMatchObject({ fields: ['provider.NOT_CONFIGURED'] });
    expect(await f.weather.search({ query: '海淀区' }, 'zh-CN', new AbortController().signal)).toEqual({ locations: [] });
    expect(json).not.toHaveBeenCalled();
  });
});
