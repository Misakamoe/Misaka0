import { z } from 'zod';
import { systemMetricsSchema } from './system-metrics.js';

export const supportedLocales = ['zh-CN', 'zh-TW', 'en', 'ja'] as const;
export const languagePreferences = ['auto', ...supportedLocales] as const;
export const localeSchema = z.enum(supportedLocales);
export const languagePreferenceSchema = z.enum(languagePreferences);
export type Locale = z.infer<typeof localeSchema>;
export type LanguagePreference = z.infer<typeof languagePreferenceSchema>;
export const userIdSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const groupIdSchema = z.number().int().negative().min(-Number.MAX_SAFE_INTEGER);
export const revisionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const emptyInputSchema = z.strictObject({});

export const coreSettingsSchema = z.strictObject({ defaultLanguage: localeSchema });
export type CoreSettings = z.infer<typeof coreSettingsSchema>;
export const settingsSnapshotSchema = z.strictObject({
  revision: revisionSchema,
  saved: coreSettingsSchema,
  effective: coreSettingsSchema,
  requiresRestart: z.boolean(),
});
export type SettingsSnapshot = z.infer<typeof settingsSnapshotSchema>;
export const settingsUpdateSchema = z.strictObject({ revision: revisionSchema, settings: coreSettingsSchema });
export const preferenceInputSchema = z.strictObject({ language: languagePreferenceSchema });
export const preferenceSchema = z.strictObject({
  language: languagePreferenceSchema,
  resolvedLanguage: localeSchema,
  menuSynced: z.boolean(),
});
export type Preference = z.infer<typeof preferenceSchema>;

export const groupSchema = z.strictObject({
  id: groupIdSchema,
  title: z.string().max(128),
  authorizedBy: userIdSchema,
  authorizedAt: z.iso.datetime(),
  present: z.boolean(),
});
export type AuthorizedGroup = z.infer<typeof groupSchema>;
export const groupPageInputSchema = z.strictObject({ page: z.number().int().min(0).max(100_000).default(0) });
export const groupPageSchema = z.strictObject({
  items: z.array(groupSchema.extend({ groupRevision: revisionSchema })).max(10),
  page: z.number().int().nonnegative(),
  pageSize: z.literal(10),
  total: z.number().int().nonnegative(),
  revision: revisionSchema,
});
export type GroupPage = z.infer<typeof groupPageSchema>;
export const groupStateInputSchema = z.strictObject({ chatId: groupIdSchema });
export const groupStateSchema = z.strictObject({ chatId: groupIdSchema, revision: revisionSchema, groupRevision: revisionSchema });
export type GroupState = z.infer<typeof groupStateSchema>;
export const groupMutationSchema = z.strictObject({ chatId: groupIdSchema, revision: revisionSchema, groupRevision: revisionSchema.optional() });
export const groupMutationResultSchema = z.strictObject({
  chatId: groupIdSchema,
  revision: revisionSchema,
  groupRevision: revisionSchema,
  changed: z.boolean(),
  notificationSent: z.boolean(),
  left: z.boolean(),
});

export const infoSchema = z.strictObject({
  runtime: z.literal('grammy'),
  version: z.string(),
  moduleCount: z.number().int().nonnegative(),
  aiAvailable: z.boolean(),
});
export const componentStateSchema = z.enum(['disabled', 'starting', 'running', 'stopping', 'stopped', 'failed']);
export const statusSchema = z.strictObject({
  uptimeSeconds: z.number().nonnegative(),
  updateCount: z.number().int().nonnegative(),
  authorizedGroupCount: z.number().int().nonnegative(),
  polling: componentStateSchema,
  http: componentStateSchema,
  lastApiError: z.strictObject({ code: z.string(), at: z.iso.datetime() }).nullable(),
  resources: systemMetricsSchema.optional(),
});
export type RuntimeStatus = z.infer<typeof statusSchema>;

export const moduleMetadataSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/),
  nameKey: z.string(),
  descriptionKey: z.string(),
  schema_version: z.number().int().positive(),
  configurable: z.boolean(),
});
export type ModuleMetadata = z.infer<typeof moduleMetadataSchema>;
export const moduleListSchema = z.array(moduleMetadataSchema);
export const moduleIdSchema = z.strictObject({ id: moduleMetadataSchema.shape.id });
export const errorCodeSchema = z.enum([
  'INVALID_INPUT', 'FORBIDDEN', 'UNAUTHORIZED', 'NOT_FOUND', 'CONFLICT', 'CONFIRMATION_EXPIRED',
  'CONFIRMATION_REQUIRED', 'AI_DISABLED', 'AI_PRICING_REQUIRED', 'CANCELLED', 'TIMEOUT', 'OUTCOME_UNKNOWN',
  'UNAVAILABLE', 'RATE_LIMITED', 'INTERNAL_ERROR', 'INVALID_ORIGIN', 'CSRF_INVALID',
  'AUTH_EXPIRED', 'AUTH_INVALID', 'STORAGE_ERROR', 'INVALID_OUTPUT', 'CAPACITY',
]);
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export const safeErrorSchema = z.strictObject({
  code: errorCodeSchema,
  fields: z.array(z.string()).optional(),
});
export type SafeError = z.infer<typeof safeErrorSchema>;
export const confirmationSchema = z.strictObject({
  token: z.string().regex(/^[a-f0-9]{40}$/),
  actionId: z.string(),
  expiresAt: z.iso.datetime(),
  target: z.string(),
});
export type Confirmation = z.infer<typeof confirmationSchema>;
export type ActionResult<T = unknown> =
  | { status: 'succeeded'; invocationId: string; data: T; replayed?: boolean }
  | { status: 'pending_confirmation'; invocationId: string; confirmation: Confirmation }
  | { status: 'rejected' | 'failed'; invocationId: string; error: SafeError };

export interface Me {
  user: { id: number; name: string };
  language: LanguagePreference;
  resolvedLanguage: Locale;
  csrfToken: string | null;
  expiresAt: string;
  method: 'oidc' | 'miniapp';
}

export function inputJsonSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: 'draft-7', io: 'input', unrepresentable: 'throw' });
}

export const coreSettingsMetadata = {
  id: 'core',
  schema_version: 1,
  nameKey: 'web:settings.title',
  descriptionKey: 'web:settings.description',
  fields: {
    defaultLanguage: {
      labelKey: 'web:settings.defaultLanguage',
      descriptionKey: 'web:settings.defaultLanguageHelp',
      enumKeys: Object.fromEntries(supportedLocales.map(locale => [locale, `common:languages.${locale}`])),
      control: 'select', secret: false, readOnly: false, effect: 'immediate',
    },
  },
  order: ['defaultLanguage'],
} as const;

export interface SettingFieldMetadata {
  labelKey: string;
  descriptionKey?: string;
  enumKeys?: Record<string, string>;
  control?: 'text' | 'password' | 'select' | 'textarea';
  secret?: boolean;
  readOnly?: boolean;
  effect: 'immediate' | 'restart_required';
}

export interface SettingsDescriptor {
  id: string;
  schema_version: number;
  nameKey: string;
  descriptionKey: string;
  schema: Record<string, unknown>;
  fields: Record<string, SettingFieldMetadata>;
  order: string[];
}

export const secretStateSchema = z.strictObject({ has_value: z.boolean() });
export const secretChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('replace'), value: z.string().min(1).max(16_384).refine(value => !/^([*\u2022])+$/u.test(value)) }),
  z.strictObject({ operation: z.literal('clear') }),
]);
export type SecretState = z.infer<typeof secretStateSchema>;
export type SecretChange = z.infer<typeof secretChangeSchema>;

export function settingsJsonSchema(schema: z.ZodType, fields: Record<string, SettingFieldMetadata>): Record<string, unknown> {
  const json = inputJsonSchema(schema);
  const visited = new Set<string>();
  const scrub = (value: unknown, secret = false): void => {
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    delete node.default;
    delete node.examples;
    if (secret && typeof node.$ref === 'string' && node.$ref.startsWith('#/') && !visited.has(node.$ref)) {
      visited.add(node.$ref);
      const path = node.$ref.slice(2).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
      const last = path.pop()!;
      let parent: Record<string, unknown> | undefined = json;
      for (const part of path) parent = parent?.[part] as Record<string, unknown> | undefined;
      if (parent && parent[last]) {
        const definition = parent[last];
        parent[last] = { type: 'string', writeOnly: true };
        scrub(definition, true);
      }
    }
    for (const child of Object.values(node)) scrub(child, secret);
  };
  scrub(json);
  const properties = json.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const [key, metadata] of Object.entries(fields)) {
      if (metadata.secret && key in properties) {
        scrub(properties[key], true);
        properties[key] = { type: 'string', writeOnly: true };
      }
    }
  }
  return json;
}
