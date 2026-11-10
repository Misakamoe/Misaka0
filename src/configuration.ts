import { z } from 'zod';
import {
  coreSettingsSchema, languagePreferenceSchema, revisionSchema,
  type CoreSettings, type LanguagePreference, type Locale, type Preference, type SettingsSnapshot,
} from '../shared/schemas/index.js';
import { normalizeLanguage } from './i18n.js';
import { JsonDocument, type JsonStorage } from './storage.js';

const settingsFileSchema = z.strictObject({ schema_version: z.literal(1), revision: revisionSchema, core: coreSettingsSchema });
const preferencesFileSchema = z.strictObject({
  schema_version: z.literal(1), revision: revisionSchema,
  users: z.record(z.string().regex(/^[1-9]\d*$/), z.strictObject({ language: languagePreferenceSchema })),
});

export class ConfigurationService {
  private readonly settingsFile: JsonDocument<z.infer<typeof settingsFileSchema>>;
  private readonly preferencesFile: JsonDocument<z.infer<typeof preferencesFileSchema>>;

  constructor(storage: JsonStorage) {
    this.settingsFile = new JsonDocument(storage, 'settings.json', settingsFileSchema);
    this.preferencesFile = new JsonDocument(storage, 'preferences.json', preferencesFileSchema);
  }

  async initialize(): Promise<void> {
    await this.settingsFile.load({ schema_version: 1, revision: 0, core: { defaultLanguage: 'zh-CN' } });
    await this.preferencesFile.load({ schema_version: 1, revision: 0, users: {} });
  }

  settings(): SettingsSnapshot {
    const value = this.settingsFile.snapshot();
    return { revision: value.revision, saved: { ...value.core }, effective: { ...value.core }, requiresRestart: false };
  }

  async updateSettings(settings: CoreSettings, revision: number, signal?: AbortSignal): Promise<SettingsSnapshot> {
    const parsed = coreSettingsSchema.parse(settings);
    await this.settingsFile.update(candidate => { candidate.core = parsed; }, { revision, signal });
    return this.settings();
  }

  resolveLanguage(userId: number, hint?: string): Locale {
    const choice = this.preferencesFile.snapshot().users[String(userId)]?.language;
    return choice && choice !== 'auto' ? choice : normalizeLanguage(hint) ?? this.settings().effective.defaultLanguage;
  }

  getPreference(userId: number, hint?: string): Preference {
    return {
      language: this.preferencesFile.snapshot().users[String(userId)]?.language ?? 'auto',
      resolvedLanguage: this.resolveLanguage(userId, hint),
      menuSynced: true,
    };
  }

  async setPreference(userId: number, language: LanguagePreference, hint?: string, signal?: AbortSignal): Promise<Preference> {
    await this.preferencesFile.update(candidate => {
      if (language === 'auto') delete candidate.users[String(userId)];
      else candidate.users[String(userId)] = { language };
    }, { signal });
    return this.getPreference(userId, hint);
  }
}
