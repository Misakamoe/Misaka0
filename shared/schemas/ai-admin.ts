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
