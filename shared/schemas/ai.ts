import { z } from 'zod';
import { aiMcpSettingSchema, aiSandboxSettingSchema, aiSkillSettingSchema } from './ai-extensions.js';

const integer = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveId = integer.min(1);
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const name = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
const timestamp = z.iso.datetime();
const unique = <T>(values: T[]) => new Set(values).size === values.length;

export const aiProtocolSchema = z.enum(['openai-responses', 'anthropic-messages', 'google-generate-content', 'openai-chat-completions']);
export const aiCredentialRefSchema = z.string().regex(/^(?:env|vault):[A-Za-z][A-Za-z0-9_.-]{0,63}$/);
export const aiEndpointSchema = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return /^https:\/\//.test(value) && !/[\s\\\p{Cc}]/u.test(value)
      && !url.username && !url.password && !url.search && !url.hash && Boolean(url.hostname);
  } catch { return false; }
}, { message: 'INVALID_INPUT' });
export const aiOriginSchema = aiEndpointSchema.refine(value => {
  try { return new URL(value).origin === value; } catch { return false; }
}, { message: 'INVALID_INPUT' });
function allowedEndpoint(endpoint: string, origins: string[]): boolean {
  try { return origins.includes(new URL(endpoint).origin); } catch { return false; }
}
export const aiProviderSchema = z.strictObject({
  id: name, protocol: aiProtocolSchema, baseUrl: aiEndpointSchema,
  allowedOrigins: z.array(aiOriginSchema).min(1).max(8).refine(unique),
  credentialRef: aiCredentialRefSchema, enabled: z.boolean(), anthropicVersion: z.iso.date().optional(),
}).refine(value => allowedEndpoint(value.baseUrl, value.allowedOrigins), { message: 'INVALID_INPUT' });
export const aiBudgetSchema = z.strictObject({
  maxInputTokens: integer.min(1).max(32_768), maxOutputTokens: integer.min(1).max(8192),
  maxToolCalls: integer.max(16), maxDurationMs: integer.min(1000).max(600_000),
  maxCostMicros: integer.max(1_000_000_000),
});
export const aiPresetSchema = z.strictObject({
  id: name, providerId: name, model: z.string().min(1).max(256).regex(/^[^\s\p{Cc}]+$/u),
  system: z.string().max(16_384).optional(), tools: z.array(name).max(64).refine(unique),
  inputCapabilities: z.array(z.enum(['text', 'image', 'audio', 'document'])).min(1).max(4).refine(unique),
  outputCapabilities: z.array(z.enum(['text', 'image', 'audio', 'file'])).min(1).max(4).refine(unique),
  budget: aiBudgetSchema, budgetMode: z.enum(['cost', 'usage']).optional(),
  pricing: z.strictObject({ currency: z.literal('CNY'), inputMicrosPerMillion: integer.max(1_000_000_000), outputMicrosPerMillion: integer.max(1_000_000_000) }).optional(),
  retention: z.enum(['standard', 'fable-30-days-approved']).optional(),
  imageGeneration: z.strictObject({ model: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/), outputFormat: z.enum(['png', 'jpeg', 'webp']) }).optional(),
  audioVoice: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),
  chatTokenLimit: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
});
export const aiGrantSchema = z.strictObject({
  id: name, kind: z.enum(['private', 'group']), subjectId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  presetId: name, expiresAt: timestamp.optional(),
}).refine(value => value.kind === 'private' ? value.subjectId > 0 : value.subjectId < 0, { message: 'INVALID_INPUT' });
export const aiLimitsSchema = z.strictObject({
  maxConcurrentRuns: z.literal(1), maxQueuedRuns: integer.max(8),
  maxConversationsPerScope: integer.min(1).max(10_000), maxTurnsPerConversation: integer.min(1).max(100_000),
  maxStorageBytes: integer.min(1_048_576).max(1_073_741_824), dailyCostMicros: integer.max(1_000_000_000),
  dailyRuns: integer.min(1).max(10_000).optional(),
});
export const aiSettingsSchema = z.strictObject({
  enabled: z.boolean(), providers: z.array(aiProviderSchema).max(16), presets: z.array(aiPresetSchema).max(64),
  grants: z.array(aiGrantSchema).max(1000), deniedUserIds: z.array(positiveId).max(1000).refine(unique), limits: aiLimitsSchema,
  search: z.strictObject({ enabled: z.boolean(), providerId: name, maxResults: integer.min(1).max(10),
    currency: z.literal('CNY').optional(), costMicrosPerResultRequest: integer.max(1_000_000_000).optional(),
  }).optional(),
  skills: z.array(aiSkillSettingSchema).max(32).optional(),
  mcp: z.array(aiMcpSettingSchema).max(16).optional(),
  sandbox: aiSandboxSettingSchema.optional(),
}).superRefine((settings, context) => {
  const providers = new Set(settings.providers.map(item => item.id));
  const presets = new Set(settings.presets.map(item => item.id));
  if (providers.size !== settings.providers.length || presets.size !== settings.presets.length
    || !unique(settings.grants.map(item => item.id)) || !unique(settings.grants.map(item => `${item.kind}:${item.subjectId}`))
    || !unique((settings.skills ?? []).map(item => item.id)) || !unique((settings.mcp ?? []).map(item => item.id))
    || settings.presets.some(item => !providers.has(item.providerId)) || settings.grants.some(item => !presets.has(item.presetId))
    || settings.search && !providers.has(settings.search.providerId)) context.addIssue({ code: 'custom', message: 'INVALID_INPUT' });
  for (const preset of settings.presets) {
    const protocol = settings.providers.find(provider => provider.id === preset.providerId)?.protocol;
    if (preset.imageGeneration && (protocol !== 'openai-responses' || !preset.outputCapabilities.includes('image'))
      || preset.audioVoice && (protocol !== 'google-generate-content' || !preset.outputCapabilities.includes('audio'))
      || preset.chatTokenLimit && protocol !== 'openai-chat-completions'
      || preset.retention === 'fable-30-days-approved' && protocol !== 'anthropic-messages') context.addIssue({ code: 'custom', message: 'INVALID_INPUT' });
  }
  const ownerCredentials = new Map<string, string>();
  for (const profile of [...(settings.mcp ?? []), ...(settings.sandbox?.profiles ?? [])]) {
    if (profile.credentialAuthority !== 'owner' || !profile.credentialRef || !profile.scope) continue;
    const owner = `${profile.scope.botId}:${profile.scope.ownerId}`;
    const existing = ownerCredentials.get(profile.credentialRef);
    if (existing && existing !== owner) context.addIssue({ code: 'custom', message: 'INVALID_INPUT' });
    ownerCredentials.set(profile.credentialRef, owner);
  }
});
export type AiProtocol = z.infer<typeof aiProtocolSchema>;
export type AiProvider = z.infer<typeof aiProviderSchema>;
export type AiPreset = z.infer<typeof aiPresetSchema>;
export type AiBudget = z.infer<typeof aiBudgetSchema>;
export type AiGrant = z.infer<typeof aiGrantSchema>;
export type AiLimits = z.infer<typeof aiLimitsSchema>;
export type AiSettings = z.infer<typeof aiSettingsSchema>;
export function aiDefaults(): AiSettings {
  return { enabled: false, providers: [], presets: [], grants: [], deniedUserIds: [], limits: {
    maxConcurrentRuns: 1, maxQueuedRuns: 8, maxConversationsPerScope: 100, maxTurnsPerConversation: 10_000,
    maxStorageBytes: 67_108_864, dailyCostMicros: 1_000_000,
  } };
}

// This is an internal adapter contract, never an Action input or identity claim.
export const aiScopeSchema = z.strictObject({ botId: positiveId, chatId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER),
  threadId: positiveId.optional(), ownerId: positiveId.optional(),
}).refine(value => value.chatId > 0 ? value.ownerId === value.chatId : value.chatId < 0 && value.ownerId === undefined, { message: 'INVALID_INPUT' });
export type AiScope = z.infer<typeof aiScopeSchema>;
export const aiSettingsSnapshotSchema = z.strictObject({ revision: integer, settings: aiSettingsSchema });
export type AiSettingsSnapshot = z.infer<typeof aiSettingsSnapshotSchema>;
export const aiSettingsUpdateSchema = z.strictObject({ revision: integer, settings: aiSettingsSchema });
export const aiPageInputSchema = z.strictObject({ after: integer.default(0), limit: integer.min(1).max(50).default(20) });
export type AiPageInput = z.input<typeof aiPageInputSchema>;
export interface AiPage<T> { items: T[]; nextCursor: number | null }
const row = { id, sequence: positiveId, revision: integer, createdAt: timestamp, updatedAt: timestamp };
export const aiConversationSchema = z.strictObject({ ...row, title: z.string().max(160) });
export type AiConversation = z.infer<typeof aiConversationSchema>;
export const aiConversationNewInputSchema = z.strictObject({ title: z.string().max(160).default('') });
export const aiConversationIdInputSchema = z.strictObject({ conversationId: id });
export const aiConversationRenameInputSchema = z.strictObject({ conversationId: id, title: z.string().max(160), revision: integer });
export const aiConversationMutationInputSchema = z.strictObject({ conversationId: id, revision: integer });
export const aiConversationHistoryInputSchema = z.strictObject({ conversationId: id, ...aiPageInputSchema.shape });
export const aiConversationPageSchema = z.strictObject({ items: z.array(aiConversationSchema).max(50), nextCursor: integer.nullable() });
export const aiJsonValueSchema = z.json();
export type AiJsonValue = z.infer<typeof aiJsonValueSchema>;
export const aiTurnInputSchema = z.strictObject({ actorId: positiveId, role: z.enum(['user', 'assistant', 'tool']),
  content: z.string().max(32_768), artifacts: z.array(id).max(16).optional(), toolCallId: id.optional(),
});
export type AiTurnInput = z.infer<typeof aiTurnInputSchema>;
export const aiTurnSchema = z.strictObject({ ...row, conversationId: id, ...aiTurnInputSchema.shape });
export type AiTurn = z.infer<typeof aiTurnSchema>;
export const aiTurnPageSchema = z.strictObject({ items: z.array(aiTurnSchema).max(50), nextCursor: integer.nullable() });
export const aiExportSchema = z.strictObject({ conversation: aiConversationSchema, ...aiTurnPageSchema.shape });
export const aiMemorySchema = z.strictObject({ ...row, text: z.string().min(1).max(4096) });
export type AiMemory = z.infer<typeof aiMemorySchema>;
export const aiMemoryPutInputSchema = z.strictObject({ id: id.optional(), text: z.string().min(1).max(4096), expectedRevision: integer.optional() });
export const aiMemoryDeleteInputSchema = z.strictObject({ id, expectedRevision: integer.optional() });
export const aiMemoryPageSchema = z.strictObject({ items: z.array(aiMemorySchema).max(50), nextCursor: integer.nullable() });
export const aiRunStateSchema = z.enum(['queued', 'running', 'waiting-approval', 'completed', 'failed', 'cancelled', 'unknown']);
export type AiRunState = z.infer<typeof aiRunStateSchema>;
export const aiRunSchema = z.strictObject({ ...row, conversationId: id, actorId: positiveId, presetId: name,
  settingsRevision: integer, state: aiRunStateSchema, continuation: aiJsonValueSchema,
});
export type AiRun = z.infer<typeof aiRunSchema>;
export const aiRunCreateInputSchema = z.strictObject({ conversationId: id, actorId: positiveId, presetId: name,
  settingsRevision: integer, continuation: aiJsonValueSchema.default(null),
});
export const aiRunUpdateInputSchema = z.strictObject({ revision: integer, state: aiRunStateSchema, continuation: aiJsonValueSchema });
export const aiRunIdInputSchema = z.strictObject({ runId: id });
export const aiRunPageSchema = z.strictObject({ items: z.array(aiRunSchema).max(50), nextCursor: integer.nullable() });
export const aiRecordKindSchema = z.enum(['artifact', 'automation', 'outbox', 'summary', 'receipt']);
export type AiRecordKind = z.infer<typeof aiRecordKindSchema>;
export const aiRecordSchema = z.strictObject({ ...row, kind: aiRecordKindSchema, payload: aiJsonValueSchema,
  state: name.nullable(), dueAt: timestamp.nullable(), conversationId: id.optional(),
});
export type AiRecord = z.infer<typeof aiRecordSchema>;
export const aiRecordPutInputSchema = z.strictObject({ id: id.optional(), payload: aiJsonValueSchema,
  state: name.optional(), dueAt: timestamp.optional(), expectedRevision: integer.optional(), conversationId: id.optional(),
});
export const aiArtifactMetadataSchema = z.strictObject({ filename: z.string().min(1).max(256), mimeType: z.string().min(1).max(128),
  bytes: integer, sha256: z.string().regex(/^[a-f0-9]{64}$/), storageRef: id, expiresAt: timestamp.optional(),
});
export type AiArtifactMetadata = z.infer<typeof aiArtifactMetadataSchema>;
// Trusted pre-download capture only; this is not an administration DTO or a verified file.
const capturedText = (max: number) => z.string().min(1).max(max).refine(value => value.length <= max && !/\p{Cc}/u.test(value));
export const aiCapturedArtifactSchema = z.strictObject({
  transport: z.literal('telegram'), actorId: positiveId, expires: positiveId,
  file: z.strictObject({ fileId: capturedText(512), uniqueId: capturedText(256),
    kind: z.enum(['image', 'audio', 'document', 'sticker']), mimeType: capturedText(128), name: capturedText(128),
    size: integer.min(1).max(1_048_576),
  }),
});
export type AiCapturedArtifact = z.infer<typeof aiCapturedArtifactSchema>;
export const aiArtifactPayloadSchema = z.union([aiArtifactMetadataSchema, aiCapturedArtifactSchema]);
export type AiArtifactPayload = z.infer<typeof aiArtifactPayloadSchema>;
export const aiCredentialStateSchema = z.strictObject({ ref: aiCredentialRefSchema, hasValue: z.boolean(), source: z.enum(['environment', 'vault']) });
export type AiCredentialState = z.infer<typeof aiCredentialStateSchema>;
export const aiCredentialValueSchema = z.string().min(1).max(16_384)
  .refine(value => value.length <= 16_384 && !/\p{Cc}/u.test(value) && !/^([*\u2022])+$/.test(value));
export const aiCredentialChangeSchema = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('replace'), ref: aiCredentialRefSchema, value: aiCredentialValueSchema }),
  z.strictObject({ operation: z.literal('delete'), ref: aiCredentialRefSchema }),
]);
export type AiCredentialChange = z.infer<typeof aiCredentialChangeSchema>;
export const aiSafeStatusSchema = z.strictObject({ available: z.boolean(), schemaVersion: z.literal(1),
  conversations: integer, turns: integer, memories: integer, pendingRuns: integer, records: integer,
  reservedCostMicros: integer, settledCostMicros: integer, storageBytes: integer,
});
export type AiSafeStatus = z.infer<typeof aiSafeStatusSchema>;
