import { describe, expect, it } from 'vitest';
import { CurrencyCatalog, cryptoCurrencies, parseAmount } from '../src/modules/currency.js';

const english = new Intl.DisplayNames('en', { type: 'currency' });
const codes = Intl.supportedValuesOf('currency').map(code => [code, english.of(code)!] as const);
const catalog = new CurrencyCatalog(codes, Date.UTC(2026, 10, 9));
describe('complete currency aliases and explicit conversion arguments', () => {
  it('resolves every supported ISO code and localized currency name without a short allowlist', () => {
    for (const [code] of codes) {
      expect(catalog.resolve(code).some(currency => currency.code === code), code).toBe(true);
      for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja']) {
        const name = new Intl.DisplayNames(locale, { type: 'currency' }).of(code)!;
        expect(catalog.resolve(name).some(currency => currency.code === code), `${locale}:${name}`).toBe(true);
      }
    }
  });
  it.each(['jp', 'jpy', '日本', '日元', '日圓', '日币', '日本円'])('recognizes %s as JPY', name => {
    expect(catalog.resolve(name).map(currency => currency.code)).toEqual(['JPY']);
  });
  it.each(['cn', 'rmb', 'cny', '中国', '中國', '人民币', '人民幣', '人民元'])('recognizes %s as CNY', name => {
    expect(catalog.resolve(name).map(currency => currency.code)).toEqual(['CNY']);
  });
  it.each([
    ['100 jp rmb', '100', 'JPY', 'CNY'], ['jp cn 100', '100', 'JPY', 'CNY'],
    ['日本 中国 100', '100', 'JPY', 'CNY'], ['一万 日元 人民币', '10000', 'JPY', 'CNY'],
    ['1.2万JPY CNY', '12000', 'JPY', 'CNY'], ['10k USD EUR', '10000', 'USD', 'EUR'],
    ['100 日元 人民币', '100', 'JPY', 'CNY'], ['100 円 人民元', '100', 'JPY', 'CNY'],
    ['100 yen yuan', '100', 'JPY', 'CNY'], ['１００ ＪＰＹ ＣＮＹ', '100', 'JPY', 'CNY'],
    ['1,234.50 US dollars euros', '1234.5', 'USD', 'EUR'], ['JPY CNY', '1', 'JPY', 'CNY'],
    ['100 IN CN', '100', 'INR', 'CNY'], ['USD IN 100', '100', 'USD', 'INR'],
    ['TO USD 100', '100', 'TOP', 'USD'],
    ['IS USD', '1', 'ISK', 'USD'], ['1 BTC CNY', '1', 'BTC', 'CNY'], ['比特币 中国', '1', 'BTC', 'CNY'],
  ])('parses %s', (query, amount, from, to) => {
    expect(catalog.parse(query!)).toEqual({ kind: 'conversion', amount, from, to });
  });
  it('returns candidates for symbols and does not silently choose a dollar or yen currency', () => {
    const dollar = catalog.parse('$100 EUR');
    expect(dollar.kind).toBe('ambiguous');
    if (dollar.kind === 'ambiguous') expect(dollar.from).toEqual(expect.arrayContaining(['USD', 'CAD', 'AUD']));
    const yen = catalog.parse('100 ¥ USD');
    expect(yen).toMatchObject({ kind: 'ambiguous', from: expect.arrayContaining(['JPY', 'CNY']) });
    expect(catalog.parse('100 US$ CNY')).toMatchObject({ kind: 'conversion', from: 'USD', to: 'CNY' });
  });
  it.each(['100 bitcoinish cny', '100 USD unknown CNY', '100 USD EUR JPY', 'USD', '100 USD', '100 200 USD EUR', '-100 USD EUR', 'NaN USD EUR', 'Infinity USD EUR', '1e3 USD EUR', '1+2 USD EUR', '1,50 USD EUR'])('rejects unsafe or unclear input %s', query => {
    expect(() => catalog.parse(query)).toThrow();
  });
  it.each([['一千二百三十四点五', '1234.5'], ['两百', '200'], ['一万亿', '1000000000000'], ['.5', '0.5'], ['0', '0'], ['1.000000000001', '1.000000000001']])('parses exact amount %s', (input, expected) => {
    expect(parseAmount(input!)).toBe(expected);
  });
  it.each(['二百五', '-1', '1000000000000001', '0.0000000000001', '1,23', '1.000,50'])('rejects ambiguous or out-of-range amount %s', input => {
    expect(() => parseAmount(input)).toThrow();
  });
  it('preserves legacy crypto aliases and differentiates LUNA from LUNC', () => {
    expect(cryptoCurrencies.length).toBeGreaterThan(60);
    expect(catalog.resolve('泰达币')[0]).toMatchObject({ code: 'USDT', coinId: 'tether' });
    expect(catalog.resolve('LUNA')[0]!.coinId).not.toBe(catalog.resolve('LUNC')[0]!.coinId);
    expect(catalog.resolve('crypto:AR').map(item => item.code)).toEqual(['AR']);
    expect(catalog.resolve('fiat:ARS').map(item => item.code)).toEqual(['ARS']);
  });
  it.each(['100日元是多少人民币', 'How much is 100 yen in yuan?', '日本100换中国', '100円は何人民元', '100 USD to EUR'])('does not interpret conversion sentences: %s', query => {
    expect(() => catalog.parse(query)).toThrow();
  });
});
