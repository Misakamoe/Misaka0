import { Decimal } from 'decimal.js';

export { CurrencyCatalog, CurrencyParseError, parseAmount } from './currency.js';
export const Money = Decimal.clone({ precision: 48, toExpNeg: -30, toExpPos: 40 });
export const englishCurrencyNames = new Intl.DisplayNames('en', { type: 'currency' });
