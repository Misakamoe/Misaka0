import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import enCommon from '../../shared/locales/en/common.json';
import zhCommon from '../../shared/locales/zh-CN/common.json';
import enWeb from '../../shared/locales/en/web.json';
import zhWeb from '../../shared/locales/zh-CN/web.json';
import twCommon from '../../shared/locales/zh-TW/common.json';
import twWeb from '../../shared/locales/zh-TW/web.json';
import jaCommon from '../../shared/locales/ja/common.json';
import jaWeb from '../../shared/locales/ja/web.json';
import { supportedLocales } from '../../shared/schemas';
import { negotiateLocale } from '../../shared/locales/normalize';

await i18n.use(initReactI18next).init({
  resources: {
    en: { common: enCommon, web: enWeb },
    'zh-CN': { common: zhCommon, web: zhWeb },
    'zh-TW': { common: twCommon, web: twWeb },
    ja: { common: jaCommon, web: jaWeb },
  },
  lng: negotiateLocale(navigator.languages?.join(',') || navigator.language) ?? 'zh-CN',
  fallbackLng: 'en',
  supportedLngs: supportedLocales,
  defaultNS: 'web',
  interpolation: { escapeValue: false },
});

export default i18n;
