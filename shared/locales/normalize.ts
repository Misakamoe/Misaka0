import type { Locale } from '../schemas/index.js';

export function normalizeLocale(hint?: string): Locale | undefined {
  const tag = hint?.trim().toLowerCase().replaceAll('_', '-');
  if (!tag || !/^[a-z]{2,3}(?:-[a-z0-9]{1,8})*$/.test(tag)) return undefined;
  const [language, ...subtags] = tag.split('-');
  if (language === 'en' || language === 'ja') return language;
  if (language !== 'zh') return undefined;
  // An explicit script takes priority over the region (for example zh-Hant-CN).
  if (subtags[0] === 'hant') return 'zh-TW';
  if (subtags[0] === 'hans') return 'zh-CN';
  const region = subtags.find(part => /^[a-z]{2}$/.test(part));
  return region && ['tw', 'hk', 'mo'].includes(region) ? 'zh-TW' : 'zh-CN';
}

export function negotiateLocale(hint?: string): Locale | undefined {
  const candidates = (hint ?? '').split(',').map((item, index) => {
    const [tag, ...parameters] = item.trim().split(';');
    const quality = parameters.find(parameter => /^q\s*=/i.test(parameter.trim()))?.trim();
    const match = quality?.match(/^q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i);
    const q = quality === undefined ? 1 : match ? Number(match[1]) : 0;
    return { locale: normalizeLocale(tag), q, index };
  }).filter(candidate => candidate.locale && candidate.q > 0);
  candidates.sort((a, b) => b.q - a.q || a.index - b.index);
  return candidates[0]?.locale;
}
