import { createInstance } from 'i18next';
import { resources } from '../shared/locales/index.js';
import { supportedLocales, type Locale } from '../shared/schemas/index.js';

export { negotiateLocale as normalizeLanguage } from '../shared/locales/normalize.js';

const i18n = createInstance();
await i18n.init({
  resources,
  lng: 'zh-CN',
  fallbackLng: 'en',
  supportedLngs: supportedLocales,
  defaultNS: 'common',
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
});

export type Translator = (key: string, parameters?: Record<string, unknown>) => string;

export function translator(language: Locale): Translator {
  const fixed = i18n.getFixedT(language);
  return (key, parameters = {}) => String(fixed(key, parameters));
}
