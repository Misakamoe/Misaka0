import { z } from 'zod';
import { revisionSchema, userIdSchema } from './index.js';

export const relayIdSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const relaySourceSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const relayStatusSchema = z.enum(['pending', 'accepted', 'declined', 'closed', 'blocked']);
export const relaySettingsInputSchema = z.strictObject({ enabled: z.boolean(), revision: revisionSchema });
export const relaySettingsSchema = z.strictObject({ enabled: z.boolean(), ownerBound: z.boolean(), revision: revisionSchema });
export const relaySourceInputSchema = z.strictObject({ source: relaySourceSchema });
export const relayContactInputSchema = z.strictObject({ id: relayIdSchema });
export const relayMutationInputSchema = z.strictObject({ id: relayIdSchema, revision: revisionSchema });
export const relayListInputSchema = z.strictObject({ page: z.number().int().min(0).max(255).default(0) });
export const relayContactSchema = z.strictObject({
  id: relayIdSchema, revision: revisionSchema, status: relayStatusSchema,
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), routingActive: z.boolean(),
});
export const relayOwnerContactSchema = relayContactSchema.extend({
  visitor: z.strictObject({ id: userIdSchema, name: z.string().max(128), username: z.string().max(32).optional() }),
});
export const relayContactStatusSchema = z.strictObject({ available: z.boolean(), contact: relayContactSchema.nullable() });
export const relayContactListSchema = z.strictObject({
  items: z.array(relayOwnerContactSchema).max(5), page: z.number().int().nonnegative(), totalPages: z.number().int().min(1),
});
export const relaySendResultSchema = z.strictObject({ id: relayIdSchema, delivered: z.literal(true), replayed: z.boolean() });
export const relayCancelResultSchema = z.boolean();

export type RelaySettingsInput = z.infer<typeof relaySettingsInputSchema>;
export type RelaySettings = z.infer<typeof relaySettingsSchema>;
export type RelayStatus = z.infer<typeof relayStatusSchema>;
export type RelayMutationInput = z.infer<typeof relayMutationInputSchema>;
export type RelayContact = z.infer<typeof relayContactSchema>;
export type RelayOwnerContact = z.infer<typeof relayOwnerContactSchema>;
export type RelayContactStatus = z.infer<typeof relayContactStatusSchema>;
export type RelayContactList = z.infer<typeof relayContactListSchema>;
export type RelaySendResult = z.infer<typeof relaySendResultSchema>;
export type RelayCancelResult = z.infer<typeof relayCancelResultSchema>;
