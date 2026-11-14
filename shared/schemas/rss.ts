import { z } from 'zod';
import { revisionSchema } from './index.js';

export const rssIdSchema = z.string().regex(/^[a-f0-9]{12}$/);
export const rssErrorSchema = z.enum(['UNSAFE_URL', 'BLOCKED', 'HTTP_ERROR', 'INVALID_FEED', 'TOO_LARGE', 'TIMEOUT', 'NETWORK']);
export type FeedErrorCode = z.infer<typeof rssErrorSchema>;
export const RSS_MAX_KEYWORDS = 20;
export const RSS_MAX_KEYWORD_LENGTH = 64;
const rssKeywordSchema = z.string().regex(/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]*$/u).trim().min(1).max(RSS_MAX_KEYWORD_LENGTH);
export const rssKeywordFiltersSchema = z.strictObject({
  include: z.array(rssKeywordSchema).max(RSS_MAX_KEYWORDS), exclude: z.array(rssKeywordSchema).max(RSS_MAX_KEYWORDS),
});
export type RssKeywordFilters = z.infer<typeof rssKeywordFiltersSchema>;
export const rssListInputSchema = z.strictObject({ page: z.number().int().min(0).max(100_000).default(0) });
export const rssAddInputSchema = z.strictObject({
  url: z.string().min(1).max(2048), title: z.string().trim().min(1).max(128).optional(), silent: z.boolean().default(true),
  filters: rssKeywordFiltersSchema.optional(),
});
export const rssRemoveInputSchema = z.strictObject({ id: rssIdSchema, revision: revisionSchema });
export const rssUpdateInputSchema = rssRemoveInputSchema.extend({
  silent: z.boolean().optional(), paused: z.boolean().optional(), title: z.string().trim().min(1).max(128).nullable().optional(),
  filters: rssKeywordFiltersSchema.nullable().optional(),
}).refine(input => input.silent !== undefined || input.paused !== undefined || input.title !== undefined || input.filters !== undefined);
export const rssMutationSchema = z.strictObject({ id: rssIdSchema, changed: z.boolean() });
export const rssSubscriptionSchema = z.strictObject({
  id: rssIdSchema, revision: revisionSchema, title: z.string().max(128), url: z.string().max(2048),
  silent: z.boolean(), paused: z.boolean(), intervalSeconds: z.number().int().min(60).max(3600),
  filters: rssKeywordFiltersSchema.optional(),
  lastCheckAt: z.number().nonnegative().nullable(), lastSuccessAt: z.number().nonnegative().nullable(),
  failures: z.number().int().nonnegative(), totalChecks: z.number().int().nonnegative(), totalFailures: z.number().int().nonnegative(),
  lastError: rssErrorSchema.nullable(), pending: z.number().int().nonnegative(), uncertain: z.number().int().nonnegative(),
  deliveryError: z.enum(['BLOCKED', 'REJECTED', 'UNKNOWN']).nullable(),
});
export const rssListSchema = z.strictObject({
  items: z.array(rssSubscriptionSchema).max(5), page: z.number().int().nonnegative(), pageSize: z.literal(5), total: z.number().int().nonnegative(),
});
export type RssSubscriptionView = z.infer<typeof rssSubscriptionSchema>;
export type RssList = z.infer<typeof rssListSchema>;
export type RssUpdate = z.infer<typeof rssUpdateInputSchema>;
