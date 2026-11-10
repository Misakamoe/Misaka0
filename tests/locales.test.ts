import { describe, expect, it } from 'vitest';
import { createInstance } from 'i18next';
import { resources } from '../shared/locales/index.js';
import { negotiateLocale, normalizeLocale } from '../shared/locales/normalize.js';
import {
  coreSettingsMetadata, coreSettingsSchema, errorCodeSchema, inputJsonSchema,
  languagePreferenceSchema, languagePreferences, localeSchema, supportedLocales,
} from '../shared/schemas/index.js';
import { normalizeLanguage, translator } from '../src/i18n.js';

function leaves(object: object, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(object).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string' ? [[path, value]] : Object.entries(leaves(value as object, path));
  }));
}

const semanticKey = (key: string) => key.replace(/_(?:zero|one|two|few|many|other)$/, '');
const placeholders = (value: string) => [...value.matchAll(/{{\s*(\w+)\s*}}/g)].map(match => match[1]!).sort();

describe('canonical locale contract', () => {
  it('shares canonical arrays between schemas, metadata and resources', () => {
    expect(supportedLocales).toEqual(['zh-CN', 'zh-TW', 'en', 'ja']);
    expect(languagePreferences).toEqual(['auto', ...supportedLocales]);
    expect(localeSchema.options).toEqual(supportedLocales);
    expect(languagePreferenceSchema.options).toEqual(languagePreferences);
    expect(Object.keys(resources).sort()).toEqual([...supportedLocales].sort());
    expect(coreSettingsMetadata.fields.defaultLanguage.enumKeys).toEqual(Object.fromEntries(
      supportedLocales.map(locale => [locale, `common:languages.${locale}`]),
    ));
    const schema = inputJsonSchema(coreSettingsSchema);
    expect(schema.properties).toMatchObject({ defaultLanguage: { enum: [...supportedLocales] } });
  });

  it.each(supportedLocales)('accepts the persisted canonical locale %s unchanged', locale => {
    expect(localeSchema.parse(locale)).toBe(locale);
    expect(languagePreferenceSchema.parse(locale)).toBe(locale);
    expect(coreSettingsSchema.parse({ defaultLanguage: locale })).toEqual({ defaultLanguage: locale });
  });

  it.each(['zh-Hant', 'zh', 'ja-JP', 'en-US', 'auto', 'fr'])('does not persist a noncanonical locale %s', locale => {
    expect(localeSchema.safeParse(locale).success).toBe(false);
  });
});

describe('shared language negotiation', () => {
  it.each([
    ['zh', 'zh-CN'], ['zh-CN', 'zh-CN'], ['zh-SG', 'zh-CN'], ['zh-Hans', 'zh-CN'],
    ['zh-TW', 'zh-TW'], ['zh-HK', 'zh-TW'], ['zh-MO', 'zh-TW'], ['zh-Hant', 'zh-TW'],
    ['zh-Hant-CN', 'zh-TW'], ['zh-Hant-SG', 'zh-TW'], ['zh-Hans-TW', 'zh-CN'],
    ['zh-Hans-HK', 'zh-CN'], ['zh-Hans-MO', 'zh-CN'], ['ZH-hAnT-hK', 'zh-TW'],
    [' zh_TW ', 'zh-TW'], ['zh_Hant_CN', 'zh-TW'], ['en', 'en'], ['en-US', 'en'],
    ['en-GB', 'en'], ['ja', 'ja'], ['ja-JP', 'ja'], ['JA-jp', 'ja'],
    ['', undefined], ['fr-FR', undefined], ['zh@TW', undefined], ['english', undefined],
    ['*', undefined], ['auto', undefined], ['ja-', undefined], [undefined, undefined],
  ])('normalizes %s to %s', (hint, expected) => {
    expect(normalizeLocale(hint)).toBe(expected);
    expect(normalizeLanguage(hint)).toBe(expected);
  });

  it.each([
    ['en;q=0.4, zh-Hant;q=0.9, ja;q=0.6', 'zh-TW'],
    ['zh-Hant;q=0.2, ja-JP;q=0.9', 'ja'],
    ['zh-HK;q=0, en-US;q=0.3', 'en'],
    ['fr-FR, zh-Hans-TW;q=0.8, en;q=0.7', 'zh-CN'],
    ['zh-TW;q=0.8, ja;q=0.8', 'zh-TW'],
    ['ja;q=0.8, zh-TW;q=0.8', 'ja'],
    ['ja;q=0.1, zh-Hant', 'zh-TW'],
    ['zh-Hant;q=bogus, en;q=0.5', 'en'],
    ['zh-TW;q=2, ja;q=0.5', 'ja'],
    ['zh-CN;q=-1, ja;q=0.5', 'ja'],
    ['zh-CN;q=0, zh-Hant;q=0', undefined],
    ['*;q=1, ja-JP;q=0.2', 'ja'],
    ['ja; Q=0.800, en;q=0.4', 'ja'],
    ['fr-FR, de-DE;q=0.9', undefined],
  ])('respects Accept-Language quality in %s', (hint, expected) => {
    expect(negotiateLocale(hint)).toBe(expected);
    expect(normalizeLanguage(hint)).toBe(expected);
  });
});

describe.each(supportedLocales)('%s translations', locale => {
  it('uses equal-length labels for paired sticker controls without spacing padding', () => {
    const t = translator(locale);
    for (const [left, right] of [['media', 'file'], ['original', 'wholePack']]) {
      const labels = [t(`bot:sticker.${left}`), t(`bot:sticker.${right}`)];
      expect(Array.from(labels[0]!).length).toBe(Array.from(labels[1]!).length);
      expect(labels.every(label => label === label.trim() && !/\s{2}|[\u00a0\u2000-\u200b\u3000]/u.test(label))).toBe(true);
    }
  });

  it('contains every semantic key and preserves interpolation parameters without fallback', async () => {
    const instance = createInstance();
    await instance.init({ resources, lng: locale, fallbackLng: false, initAsync: false, interpolation: { escapeValue: false } });
    for (const namespace of ['common', 'bot', 'web'] as const) {
      const expected = leaves(resources.en[namespace]);
      const actual = leaves(resources[locale][namespace]);
      expect([...new Set(Object.keys(actual).map(semanticKey))].sort()).toEqual([...new Set(Object.keys(expected).map(semanticKey))].sort());
      for (const [key, value] of Object.entries(actual)) {
        expect(value.trim(), `${namespace}:${key}`).not.toBe('');
        expect(instance.getResource(locale, namespace, key), `${namespace}:${key}`).toBe(value);
        expect(placeholders(value), `${namespace}:${key}`).toEqual(placeholders(expected[key] ?? expected[semanticKey(key)]!));
        const parameters = Object.fromEntries(placeholders(value).map(name => [name, name === 'count' ? 2 : `test_${name}`]));
        const rendered = translator(locale)(`${namespace}:${key}`, parameters);
        expect(rendered, `${namespace}:${key}`).not.toMatch(/{{\s*\w+\s*}}/);
        for (const parameter of Object.values(parameters)) expect(rendered).toContain(String(parameter));
      }
    }
  });

  it('provides all language choices, errors and native alias metadata', () => {
    const t = translator(locale);
    for (const preference of languagePreferences) expect(t(`common:languages.${preference}`)).not.toBe(`languages.${preference}`);
    for (const code of errorCodeSchema.options) expect(t(`common:errors.${code}`)).not.toBe(`errors.${code}`);
    expect(t('web:modules.aliasName')).not.toBe('modules.aliasName');
    expect(t('web:modules.aliasDescription')).toContain('/alias');
    expect(t('bot:commands.alias')).not.toBe('commands.alias');
    expect(t('bot:panels.reopen', { command: 'alias' })).toContain('/alias');
    expect(t('bot:alias.added', { command: 'help', alias: '説明' })).toContain('/説明');
    expect(t('bot:modulesTitle', { count: 1 })).toContain('1');
  });

  it('keeps rich help at normal font size with the actual installed count', () => {
    for (const value of Object.values(resources[locale].bot.help)) {
      expect(value).not.toMatch(/(?:^|\n)\s*#{1,6}\s/);
      expect(value).toMatch(/^\*\*[^\n]+\*\*/);
    }
    expect(resources[locale].bot.help.details).toContain('{{count}}');
    expect(translator(locale)('bot:help.details', { count: 1 })).toContain('1');
    expect(translator(locale)('bot:help.details', { count: 7 })).toContain('7');
  });

  it('renders count-based messages for every locale plural category', () => {
    for (const count of [0, 1, 2, 5, 10]) {
      const rendered = translator(locale)('web:groups.total', { count });
      expect(rendered).toContain(String(count));
      expect(rendered).not.toContain('{{');
      expect(rendered).not.toBe('groups.total');
    }
    if (locale === 'en') {
      expect(translator(locale)('web:groups.total', { count: 1 })).toBe('1 authorized group');
      expect(translator(locale)('web:groups.total', { count: 2 })).toBe('2 authorized groups');
    }
  });
});
