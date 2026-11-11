import { z } from 'zod';

const positive = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const id = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/);
const tool = z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const unique = <T>(items: T[]) => new Set(items).size === items.length;
const endpoint = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return value.startsWith('https://') && !/[\s\\\p{Cc}]/u.test(value) && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
});
const origin = endpoint.refine(value => { try { return new URL(value).origin === value; } catch { return false; } });
const approvedEndpoint = (value: { endpoint: string; allowedOrigins: string[] }) => {
  try { return value.allowedOrigins[0] === new URL(value.endpoint).origin; } catch { return false; }
};

/** Administrator target configuration, never an invocation identity claim. */
export const aiExtensionScopeSchema = z.strictObject({
  botId: positive, ownerId: positive,
  audience: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('private'), userId: positive, threadId: positive.optional() }),
    z.strictObject({ kind: z.literal('group'), chatId: z.number().int().min(-Number.MAX_SAFE_INTEGER).max(-1), threadId: positive.optional() }),
  ]),
}).refine(scope => scope.audience.kind !== 'private' || scope.audience.userId === scope.ownerId);
export type AiExtensionScope = z.infer<typeof aiExtensionScopeSchema>;

export const aiSkillSettingSchema = z.strictObject({
  id: z.string().max(64).regex(/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/), enabled: z.boolean(), digest,
  tools: z.array(tool).max(64).refine(unique),
  scopes: z.array(aiExtensionScopeSchema).min(1).max(64).refine(items => unique(items.map(item => JSON.stringify(item)))),
});
export type AiSkillSetting = z.infer<typeof aiSkillSettingSchema>;

const remote = {
  id, enabled: z.boolean(), endpoint, allowedOrigins: z.array(origin).length(1),
  credentialRef: z.string().regex(/^(?:env|vault):[A-Za-z][A-Za-z0-9_.-]{0,63}$/).optional(),
  credentialAuthority: z.enum(['service', 'owner']), scope: aiExtensionScopeSchema.optional(),
};
export const aiMcpSettingSchema = z.strictObject({
  ...remote, tools: z.array(tool).max(64).refine(unique), readTools: z.array(tool).max(64).refine(unique), schemaDigest: digest.optional(),
}).refine(value => approvedEndpoint(value) && (!value.enabled || Boolean(value.scope && value.schemaDigest))
  && (value.credentialAuthority !== 'owner' || Boolean(value.credentialRef)) && value.readTools.every(name => value.tools.includes(name)));
export type AiMcpSetting = z.infer<typeof aiMcpSettingSchema>;

export const aiSandboxLimitsSchema = z.strictObject({
  memoryBytes: positive.max(64 * 1024 * 1024), cpuMs: positive.max(5000), pids: positive.max(16),
  outputBytes: positive.max(64 * 1024), tempBytes: positive.max(4 * 1024 * 1024), wallMs: positive.max(15_000),
});
/** External executor allocation only; never the local namespace or application heap. */
export const aiRemoteSandboxLimitsSchema = aiSandboxLimitsSchema.extend({ memoryBytes: positive.max(512 * 1024 * 1024) });
export const aiSandboxProfileSchema = z.strictObject({
  ...remote, languages: z.array(z.enum(['javascript', 'python'])).min(1).max(2).refine(unique),
  reviewedDigest: digest.optional(), limits: aiRemoteSandboxLimitsSchema,
}).refine(value => approvedEndpoint(value) && (!value.enabled || Boolean(value.scope && value.reviewedDigest))
  && (value.credentialAuthority !== 'owner' || Boolean(value.credentialRef)));
export type AiSandboxProfile = z.infer<typeof aiSandboxProfileSchema>;
const relativeFile = z.string().max(240).regex(/^(?!.*(?:^|\/)\.{1,2}(?:\/|$))(?!\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,5}$/);
const localLimits = aiSandboxLimitsSchema.refine(limits => limits.tempBytes % 4096 === 0);
const local = { id, enabled: z.boolean(), scope: aiExtensionScopeSchema.optional(), runtime: z.literal('node'), limits: localLimits };
export const aiLocalSandboxProfileSchema = z.strictObject({ ...local, reviewedDigest: digest.optional() })
  .refine(profile => !profile.enabled || Boolean(profile.scope && profile.reviewedDigest));
export type AiLocalSandboxProfile = z.infer<typeof aiLocalSandboxProfileSchema>;
export const aiStdioMcpProfileSchema = z.strictObject({
  ...local, bundle: z.strictObject({ id: aiSkillSettingSchema.shape.id, digest, entrypoint: relativeFile,
    args: z.array(z.string().max(1024).refine(value => !value.includes('\0'))).max(32),
    inputs: z.array(relativeFile).max(15).refine(unique),
  }).refine(bundle => !bundle.inputs.includes(bundle.entrypoint)),
  tools: z.array(tool).max(64).refine(unique), readTools: z.array(tool).max(64).refine(unique), schemaDigest: digest.optional(),
}).refine(profile => (!profile.enabled || Boolean(profile.scope && profile.schemaDigest)) && profile.readTools.every(name => profile.tools.includes(name)));
export type AiStdioMcpProfile = z.infer<typeof aiStdioMcpProfileSchema>;
export const aiSandboxSettingSchema = z.strictObject({
  enabled: z.boolean(), profiles: z.array(aiSandboxProfileSchema).max(8).refine(items => unique(items.map(item => item.id))),
  localProfiles: z.array(aiLocalSandboxProfileSchema).max(8).refine(items => unique(items.map(item => item.id))).optional(),
  stdioProfiles: z.array(aiStdioMcpProfileSchema).max(8).refine(items => unique(items.map(item => item.id))).optional(),
});

export const aiSkillUploadFileSchema = z.strictObject({
  path: z.string().max(240).regex(/^(?!.*(?:^|\/)\.\.(?:\/|$))(?!\/)[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){0,5}$/),
  text: z.string().max(32_768),
});
export const aiSkillInstallSchema = z.strictObject({
  id: aiSkillSettingSchema.shape.id, files: z.array(aiSkillUploadFileSchema).min(1).max(16),
  tools: aiSkillSettingSchema.shape.tools, scopes: aiSkillSettingSchema.shape.scopes,
});
export const aiSkillReviewSchema = z.strictObject({ id: aiSkillSettingSchema.shape.id, digest });
export const aiSkillReviewResultSchema = z.strictObject({
  trust: z.literal('untrusted'), id: aiSkillSettingSchema.shape.id, digest,
  manifest: z.array(z.strictObject({ path: z.string(), sha256: digest })).max(16),
  name: z.string(), description: z.string(), body: z.string(), declaredTools: z.array(z.string()).max(128),
  tools: z.array(z.string()).max(64), scopes: z.array(aiExtensionScopeSchema).max(64),
});
export const aiMcpReviewInputSchema = z.strictObject({ profile: aiMcpSettingSchema });
export const aiSandboxReviewInputSchema = z.strictObject({ profile: aiSandboxProfileSchema });
export const aiLocalSandboxReviewInputSchema = z.strictObject({ profile: aiLocalSandboxProfileSchema });
export const aiStdioMcpReviewInputSchema = z.strictObject({ profile: aiStdioMcpProfileSchema });
export const aiMcpToolSchema = z.strictObject({ name: z.string(), description: z.string().optional(), inputSchema: z.record(z.string(), z.json()), outputSchema: z.record(z.string(), z.json()).optional() });
export const aiMcpDiscoveryResultSchema = z.strictObject({ trust: z.literal('untrusted'), profileId: z.string(), digest,
  tools: z.array(aiMcpToolSchema).max(64), review: z.record(z.string(), z.json()) });
export const aiSandboxReviewResultSchema = z.strictObject({ profileId: z.string(), digest, localQualified: z.literal(false), protocol: z.literal('misaka-remote-executor-v1') });
export const aiLocalSandboxReviewResultSchema = z.strictObject({ profileId: z.string(), digest, policyHash: digest, runtime: z.literal('node') });
export const aiMcpProfileInputSchema = z.strictObject({ profileId: id });
export const aiMcpCallInputSchema = z.strictObject({ profileId: id, tool: tool, arguments: z.record(z.string(), z.json()) });
export const aiMcpResourceInputSchema = z.strictObject({ profileId: id, reference: z.string().regex(/^mcp_[a-f0-9]{48}$/) });
export const aiSandboxExecuteInputSchema = z.strictObject({
  profileId: id, language: z.enum(['javascript', 'python']), code: z.string().min(1).max(16_384),
  files: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/)).max(8),
});
export const aiLocalSandboxExecuteInputSchema = aiSandboxExecuteInputSchema.extend({ language: z.literal('javascript') });
export const aiLocalSandboxProbeResultSchema = z.strictObject({
  localRunnerImplemented: z.literal(true), localEnabled: z.boolean(), localReason: z.string().regex(/^[A-Z0-9_]{1,80}$/),
});
export const aiExtensionStatusSchema = z.strictObject({
  skills: z.number().int().nonnegative(), mcp: z.number().int().nonnegative(), remoteExecutors: z.number().int().nonnegative(),
  localExecutors: z.number().int().nonnegative(), stdioMcp: z.number().int().nonnegative(),
  ...aiLocalSandboxProbeResultSchema.shape,
});
