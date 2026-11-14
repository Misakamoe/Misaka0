import { z } from 'zod';
import { aiCredentialChangeSchema, aiCredentialStateSchema, aiCredentialValueSchema, aiEndpointSchema, aiPresetSchema, aiProtocolSchema, aiSafeStatusSchema, aiSettingsSchema } from './ai.js';

export const aiPersonalSetupSchema = z.strictObject({
  revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), protocol: aiProtocolSchema,
  baseUrl: aiEndpointSchema, model: aiPresetSchema.shape.model, apiKey: aiCredentialValueSchema.refine(value => value.trim().length > 0),
  groupIds: z.array(z.number().int().min(-Number.MAX_SAFE_INTEGER).max(-1)).max(999)
    .refine(values => new Set(values).size === values.length),
});
export type AiPersonalSetup = z.infer<typeof aiPersonalSetupSchema>;

export const aiAdminSnapshotSchema = z.strictObject({
  revision: z.number().int().nonnegative(), settings: aiSettingsSchema,
  credentials: z.array(aiCredentialStateSchema).max(64), status: aiSafeStatusSchema,
  sandbox: z.strictObject({ qualified: z.boolean(), reasons: z.array(z.string().max(128)).max(16) }),
});
export type AiAdminSnapshot = z.infer<typeof aiAdminSnapshotSchema>;
export const aiAdminSecretUpdateSchema = z.strictObject({ revision: z.number().int().nonnegative(), change: aiCredentialChangeSchema });

export const aiToolCatalogSchema = z.strictObject({
  items: z.array(z.strictObject({
    id: z.string().min(2).max(64).regex(/^[a-z][a-z0-9_.]{1,63}$/),
    group: z.string().min(1).max(32).regex(/^[a-z][a-z0-9_]*$/),
    effect: z.enum(['read', 'personal_write', 'write', 'destructive', 'permission']),
    scopes: z.array(z.enum(['private', 'group'])).min(1).max(2).refine(values => new Set(values).size === values.length),
    permission: z.enum(['any', 'self', 'superadmin', 'group_admin', 'chat_manager']),
    approval: z.enum(['none', 'required', 'conditional']),
  })).max(256).refine(items => new Set(items.map(item => item.id)).size === items.length),
});
export type AiToolCatalog = z.infer<typeof aiToolCatalogSchema>;
