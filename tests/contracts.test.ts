import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createInstance } from 'i18next';
import validator from '@rjsf/validator-ajv8';
import { resources } from '../shared/locales/index.js';
import {
  coreSettingsMetadata, coreSettingsSchema, inputJsonSchema, secretChangeSchema, settingsJsonSchema, supportedLocales,
  type SettingFieldMetadata,
} from '../shared/schemas/index.js';
import { normalizeLanguage, translator } from '../src/i18n.js';
import { modules } from '../src/modules/index.js';
import { aliasMetadata } from '../src/modules/alias.js';
import { coreFixture } from './support/core.js';

function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof item === 'string') result[path] = item;
    else Object.assign(result, flatten(item as Record<string, unknown>, path));
  }
  return result;
}

describe('shared localization', () => {
  it('has matching semantic keys, interpolation parameters and valid plural branches', () => {
    const en = flatten(resources.en);
    const semantic = (key: string) => key.replace(/_(zero|one|two|few|many|other)$/, '');
    const parameters = (text: string) => [...text.matchAll(/\{\{\s*([^},]+)(?:,[^}]+)?\s*\}\}/g)].map(match => match[1]?.trim()).sort();
    expect(supportedLocales).toEqual(['zh-CN', 'zh-TW', 'en', 'ja']);
    expect(Object.keys(resources).sort()).toEqual([...supportedLocales].sort());
    for (const locale of supportedLocales) {
      const strings = flatten(resources[locale]);
      expect([...new Set(Object.keys(strings).map(semantic))].sort(), locale)
        .toEqual([...new Set(Object.keys(en).map(semantic))].sort());
      for (const [key, text] of Object.entries(en)) {
        const counterpart = strings[key] ?? strings[semantic(key)] ?? strings[`${semantic(key)}_other`];
        expect(counterpart, `${locale}:${key}`).toBeDefined();
        expect(counterpart?.trim(), `${locale}:${key}`).not.toBe('');
        expect(parameters(text), `${locale}:${key}`).toEqual(parameters(counterpart!));
      }
      const categories = new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
      const pluralKeys = new Set([...Object.keys(en), ...Object.keys(strings)].filter(key => semantic(key) !== key).map(semantic));
      for (const key of pluralKeys) {
        for (const category of categories) {
          expect(strings[`${key}_${category}`] ?? (categories.length === 1 ? strings[key] : undefined),
            `${locale}:${key}:${category}`).toBeDefined();
        }
      }
    }
  });

  it('normalizes supported preferences and never shares mutable locale across concurrent invocations', async () => {
    expect(normalizeLanguage('zh-Hans')).toBe('zh-CN');
    expect(normalizeLanguage('zh-Hant-HK')).toBe('zh-TW');
    expect(normalizeLanguage('zh-Hans-TW')).toBe('zh-CN');
    expect(normalizeLanguage('en-GB')).toBe('en');
    expect(normalizeLanguage('ja-JP')).toBe('ja');
    expect(normalizeLanguage('fr, en-US;q=0.9,zh-CN;q=0.5')).toBe('en');
    expect(normalizeLanguage('en;q=0, zh;q=0.8')).toBe('zh-CN');
    expect(normalizeLanguage('de')).toBeUndefined();
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => Promise.resolve()
      .then(() => translator(supportedLocales[index % supportedLocales.length]!)('common:actions.cancel'))));
    const expected = ['取消', '取消', 'Cancel', '\u30ad\u30e3\u30f3\u30bb\u30eb'];
    expect(results.every((result, index) => result === expected[index % expected.length])).toBe(true);
    const i18n = createInstance();
    await i18n.init({ resources, lng: 'fr', fallbackLng: 'en', initAsync: false });
    expect(i18n.t('common:actions.cancel')).toBe('Cancel');
  });

  it('resolves explicit preference, entry hint and instance default in that order', async () => {
    const f = await coreFixture();
    try {
      expect(f.configuration.resolveLanguage(1)).toBe('zh-CN');
      expect(f.configuration.resolveLanguage(1, 'en-US')).toBe('en');
      for (const locale of supportedLocales) {
        await f.configuration.setPreference(1, locale);
        expect(f.configuration.resolveLanguage(1, locale === 'en' ? 'ja-JP' : 'en-US')).toBe(locale);
      }
      await f.configuration.setPreference(1, 'auto');
      expect(f.configuration.resolveLanguage(1, 'en-US')).toBe('en');
      await f.configuration.updateSettings({ defaultLanguage: 'en' }, 0);
      expect(f.configuration.resolveLanguage(2, 'unsupported')).toBe('en');
    } finally { await f.close(); }
  });

  it('resolves every public core schema label without returning an untranslated key', () => {
    for (const locale of supportedLocales) {
      const t = translator(locale);
      for (const key of [coreSettingsMetadata.nameKey, coreSettingsMetadata.descriptionKey,
        coreSettingsMetadata.fields.defaultLanguage.labelKey, coreSettingsMetadata.fields.defaultLanguage.descriptionKey,
        ...Object.values(coreSettingsMetadata.fields.defaultLanguage.enumKeys),
        aliasMetadata.nameKey, aliasMetadata.descriptionKey]) expect(t(key)).not.toBe(key);
    }
  });
});

describe('settings and operation schema boundaries', () => {
  const fixtureSchema = z.strictObject({
    enabled: z.boolean(),
    mode: z.enum(['first', 'second']),
    options: z.strictObject({ retries: z.number().int().min(0).max(4) }),
    labels: z.array(z.string().max(20)).max(3),
    secret: z.string().default('PRIVATE_SCHEMA_DEFAULT'),
    restartValue: z.string(),
    immutable: z.string(),
  });
  const fields: Record<string, SettingFieldMetadata> = {
    enabled: { labelKey: 'fixture.enabled', effect: 'immediate' },
    mode: { labelKey: 'fixture.mode', effect: 'immediate' },
    options: { labelKey: 'fixture.options', effect: 'immediate' },
    labels: { labelKey: 'fixture.labels', effect: 'immediate' },
    secret: { labelKey: 'fixture.secret', effect: 'immediate', secret: true },
    restartValue: { labelKey: 'fixture.restartValue', effect: 'restart_required' },
    immutable: { labelKey: 'fixture.immutable', effect: 'immediate', readOnly: true },
  };
  const saved = { enabled: true, mode: 'first' as const, options: { retries: 1 }, labels: ['one'], secret: 'PRIVATE_VALUE', restartValue: 'old', immutable: 'fixed' };

  it('exports strict Draft 7 inputs and agrees with AJV on JSON-expressible boundaries', () => {
    const schema = inputJsonSchema(coreSettingsSchema);
    expect(schema.$schema).toBe('http://json-schema.org/draft-07/schema#');
    expect(schema.additionalProperties).toBe(false);
    expect((schema.properties as Record<string, { enum: string[] }>).defaultLanguage!.enum).toEqual([...supportedLocales]);
    for (const value of [...supportedLocales.map(defaultLanguage => ({ defaultLanguage })),
      { defaultLanguage: 'fr' }, { defaultLanguage: 'auto' }, { defaultLanguage: 'zh-Hant' },
      { defaultLanguage: 3 }, { defaultLanguage: 'en', token: 'secret' }, {}]) {
      const frontend = validator.isValid(schema, value, schema);
      expect(frontend).toBe(coreSettingsSchema.safeParse(value).success);
    }
    const schema2 = inputJsonSchema(fixtureSchema);
    for (const value of [saved, { ...saved, options: { retries: '1' } }, { ...saved, mode: 'other' }, { ...saved, labels: ['a', 'b', 'c', 'd'] }]) {
      expect(validator.isValid(schema2, value, schema2)).toBe(fixtureSchema.safeParse(value).success);
    }
    expect(() => inputJsonSchema(z.strictObject({ date: z.date() }))).toThrow();
  });

  it('removes secret defaults and referenced enum values from public settings schemas', () => {
    expect(JSON.stringify(settingsJsonSchema(fixtureSchema, fields))).not.toContain('PRIVATE_SCHEMA_DEFAULT');
    const referenced = z.enum(['PRIVATE_ENUM_VALUE']).default('PRIVATE_ENUM_VALUE').meta({ id: 'private-credential' });
    const referencedSchema = z.strictObject({ secret: referenced });
    expect(JSON.stringify(settingsJsonSchema(referencedSchema, fields))).not.toContain('PRIVATE_ENUM_VALUE');
    expect(settingsJsonSchema(referencedSchema, fields).properties).toEqual({ secret: { type: 'string', writeOnly: true } });
  });

  it('accepts only explicit secret replacements or clears, never masks or returned state', () => {
    expect(secretChangeSchema.parse({ operation: 'replace', value: 'NEW_VALUE' })).toEqual({ operation: 'replace', value: 'NEW_VALUE' });
    expect(secretChangeSchema.parse({ operation: 'clear' })).toEqual({ operation: 'clear' });
    for (const change of ['********', { has_value: true }, { operation: 'replace', value: '********' },
      { operation: 'replace', value: '' }, { operation: 'replace', value: 'x'.repeat(16_385) }, { operation: 'clear', value: 'unexpected' }]) {
      expect(secretChangeSchema.safeParse(change).success).toBe(false);
    }
  });
});

describe('legacy and frontend isolation', () => {
  it('includes only the fixed sandbox build inputs in the Docker context', async () => {
    const rules = (await readFile('.dockerignore', 'utf8')).split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
    const dockerfile = await readFile('Dockerfile', 'utf8');
    expect(rules[0]).toBe('**');
    expect(dockerfile).toContain('COPY scripts scripts');
    expect(rules.filter(rule => rule.startsWith('!scripts'))).toEqual([
      '!scripts/', '!scripts/build-sandbox.mjs', '!scripts/sandbox-runner.c', '!scripts/sandbox-smoke.mjs',
    ]);
    for (const path of ['scripts/build-sandbox.mjs', 'scripts/sandbox-runner.c', 'scripts/sandbox-smoke.mjs']) {
      expect((await readFile(path)).byteLength).toBeGreaterThan(0);
    }
    for (const excluded of ['**/.env', '**/.env.*', '**/.git/', '**/.kilo/', '**/data/', 'legacy/', 'tests/']) expect(rules).toContain(excluded);
    expect(rules).not.toContain('!scripts/**');
    expect(rules).not.toContain('!data/');
    expect(rules).not.toContain('!legacy/');
  });

  it('retains exact archived bytes and registers only explicitly migrated native modules', async () => {
    const manifest = JSON.parse(await readFile('legacy/ptb/manifest.json', 'utf8')) as { files: { path: string; archive: string | null; sha256: string }[] };
    const archived = manifest.files.filter(file => file.archive);
    expect(archived).toHaveLength(39);
    for (const file of archived) expect(createHash('sha256').update(await readFile(file.archive!)).digest('hex'), file.path).toBe(file.sha256);
    expect(modules).toEqual([{ metadata: {
      id: 'alias', nameKey: 'web:modules.aliasName', descriptionKey: 'web:modules.aliasDescription',
      schema_version: 1, configurable: false,
    } }, { metadata: { id: 'rss', nameKey: 'web:rss.name', descriptionKey: 'web:rss.description', schema_version: 1, configurable: false } },
    { metadata: { id: 'rate', nameKey: 'web:rate.name', descriptionKey: 'web:rate.description', schema_version: 1, configurable: false } },
    { metadata: { id: 'weather', nameKey: 'web:weather.name', descriptionKey: 'web:weather.description', schema_version: 1, configurable: false } },
    { metadata: { id: 'sticker', nameKey: 'web:modules.stickerName', descriptionKey: 'web:modules.stickerDescription', schema_version: 1, configurable: false } },
    { metadata: { id: 'subconv', nameKey: 'web:subconv.name', descriptionKey: 'web:subconv.description', schema_version: 1, configurable: false } },
    { metadata: { id: 'relay', nameKey: 'web:modules.relayName', descriptionKey: 'web:modules.relayDescription', schema_version: 1, configurable: false } }]);
    expect(Object.isFrozen(modules)).toBe(true);
    const packageJson = JSON.parse(await readFile('package.json', 'utf8'));
    expect(packageJson.scripts.start).toBe('node dist/src/index.js');
    expect(JSON.stringify(packageJson.dependencies)).not.toMatch(/python|ai-sdk|langchain|openai|anthropic|mcp/i);
  });

  it('keeps the low-memory benchmark opt-in without removing container security', async () => {
    const [dockerfile, compose] = await Promise.all([readFile('Dockerfile', 'utf8'), readFile('docker-compose.yml', 'utf8')]);
    expect(dockerfile).not.toMatch(/^ENV NODE_OPTIONS=/m);
    expect(compose).not.toMatch(/^\s+(?:cpus|mem_limit|memswap_limit):/m);
    expect(dockerfile).toContain('USER node');
    expect(compose).toContain('read_only: true');
    expect(compose).toContain('no-new-privileges:true');
    expect(compose).toContain('pids_limit: 64');
    expect(compose).toContain('cap_drop:');
    expect(compose).toContain('- ALL');
  });

  it('keeps public shared/frontend modules independent of server imports and startup secrets', async () => {
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await visit(path);
        else if (/\.[cm]?[jt]sx?$/.test(entry.name)) {
          const content = await readFile(path, 'utf8');
          expect(content, path).not.toMatch(/from\s+['"][^'"]*(?:src\/(?:config|actions|access)|legacy\/|node:)/);
          expect(content, path).not.toMatch(/MISAKA_BOT_TOKEN|MISAKA_OIDC_CLIENT_SECRET|dangerouslySetInnerHTML/);
        }
      }
    };
    await visit('shared');
    await visit('webui/src');
  });
});
