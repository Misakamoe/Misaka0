import { z } from 'zod';

export const aiModuleEvents = ['rss.delivered', 'rate.converted', 'weather.queried'] as const;
const timeZone = z.string().min(1).max(64).refine(value => {
  try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; }
});
const timestamp = z.iso.datetime({ offset: true });
export const automationTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('once'), at: timestamp, timeZone }),
  z.strictObject({ kind: z.literal('interval'), minutes: z.number().int().min(5).max(43_200), startAt: timestamp, timeZone }),
  z.strictObject({ kind: z.literal('daily'), time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/), timeZone }),
  z.strictObject({ kind: z.literal('event'), event: z.enum(aiModuleEvents), cooldownMinutes: z.number().int().min(5).max(43_200), timeZone }),
]);
export const automationDefinitionSchema = z.strictObject({
  title: z.string().trim().min(1).max(80),
  instruction: z.string().trim().min(1).max(4000),
  trigger: automationTriggerSchema,
  tools: z.array(z.string().regex(/^[a-z][a-z0-9_.]{1,63}$/)).max(24).refine(values => new Set(values).size === values.length),
  expiresAt: timestamp,
  maxRuns: z.number().int().min(1).max(1000),
  maxInputTokens: z.number().int().min(256).max(32_768),
  maxOutputTokens: z.number().int().min(64).max(8192),
  maxCostMicros: z.number().int().min(0).max(1_000_000_000),
});
export type AutomationTrigger = z.infer<typeof automationTriggerSchema>;
export type AutomationDefinition = z.infer<typeof automationDefinitionSchema>;
export type AiModuleEvent = typeof aiModuleEvents[number];

export const automationViewSchema = z.strictObject({
  id: z.string().min(1).max(64), revision: z.number().int().nonnegative(),
  title: z.string().max(80), instruction: z.string().max(4000), trigger: automationTriggerSchema,
  tools: z.array(z.string()).max(24), expiresAt: timestamp,
  maxRuns: z.number().int(), maxInputTokens: z.number().int(), maxOutputTokens: z.number().int(),
  maxCostMicros: z.number().int().min(0).max(1_000_000_000),
  completedRuns: z.number().int().nonnegative(),
  state: z.enum(['active', 'paused', 'completed', 'unknown']),
  nextAt: timestamp.nullable(), target: z.string().max(100),
});
export type AutomationView = z.infer<typeof automationViewSchema>;

export const automationCreateSchema = z.strictObject({ definition: automationDefinitionSchema });
export const automationUpdateSchema = z.strictObject({ id: z.string().min(1).max(64), revision: z.number().int().nonnegative(), definition: automationDefinitionSchema });
export const automationMutationSchema = z.strictObject({ id: z.string().min(1).max(64), revision: z.number().int().nonnegative() });
