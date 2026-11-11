import { z } from 'zod';
import { aiRunStateSchema } from './ai.js';

export const aiOpaqueIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const aiControlPageSchema = z.strictObject({ page: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0) });
export const aiControlIdSchema = z.strictObject({ id: aiOpaqueIdSchema });
export const aiControlMutationSchema = z.strictObject({ id: aiOpaqueIdSchema, revision: z.number().int().nonnegative() });
export const aiRunStartSchema = z.strictObject({
  text: z.string().max(16_384).refine(text => text.length <= 16_384),
  attachments: z.array(aiOpaqueIdSchema).max(5).default([]),
  replyTo: z.number().int().positive().optional(),
}).refine(input => input.text.trim().length > 0 || input.attachments.length > 0);
export type AiRunStart = z.infer<typeof aiRunStartSchema>;
export const aiRunTicketSchema = z.strictObject({ runId: aiOpaqueIdSchema, conversationId: aiOpaqueIdSchema });
export const aiRunViewSchema = z.strictObject({
  runId: aiOpaqueIdSchema, conversationId: aiOpaqueIdSchema, state: aiRunStateSchema,
  tool: z.string().max(64).optional(), error: z.string().max(64).optional(),
});
export type AiRunView = z.infer<typeof aiRunViewSchema>;
