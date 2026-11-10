import { z } from 'zod';

export const stickerKindSchema = z.enum(['static', 'animated', 'video']);
export const stickerFormatSchema = z.enum(['original', 'png', 'jpg', 'webp', 'gif']);
export const stickerDeliverySchema = z.enum(['media', 'file']);
export const stickerSourceSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const stickerSetNameSchema = z.string().regex(/^[A-Za-z0-9_]{1,64}$/);
export const stickerInspectInputSchema = z.strictObject({ source: stickerSourceSchema });
export const stickerConvertInputSchema = z.strictObject({
  source: stickerSourceSchema, format: stickerFormatSchema, delivery: stickerDeliverySchema,
});
export const stickerViewSchema = z.strictObject({
  source: stickerSourceSchema, kind: z.enum(['single', 'pack']),
  sourceKind: stickerKindSchema.optional(),
  width: z.number().int().min(1).max(512).optional(), height: z.number().int().min(1).max(512).optional(),
  emoji: z.string().max(64).optional(), setName: stickerSetNameSchema.optional(),
  setType: z.enum(['regular', 'mask', 'custom_emoji']).optional(),
  title: z.string().max(128).optional(), count: z.number().int().min(1).max(120),
  formats: z.array(stickerFormatSchema).min(1).max(5), expiresAt: z.iso.datetime(),
});
export const stickerResultSchema = z.strictObject({
  format: z.enum(['png', 'jpg', 'webp', 'gif', 'tgs', 'webm', 'zip']),
  delivery: z.enum(['photo', 'animation', 'document']),
  bytes: z.number().int().min(1).max(21 * 1024 * 1024),
  count: z.number().int().min(1).max(120), messageId: z.number().int().positive(),
});
export const stickerCancelResultSchema = z.strictObject({ cancelled: z.boolean() });
export const stickerCancelInputSchema = z.strictObject({ source: stickerSourceSchema.optional() });

export type StickerKind = z.infer<typeof stickerKindSchema>;
export type StickerFormat = z.infer<typeof stickerFormatSchema>;
export type StickerDelivery = z.infer<typeof stickerDeliverySchema>;
export type StickerView = z.infer<typeof stickerViewSchema>;
export type StickerConvertInput = z.infer<typeof stickerConvertInputSchema>;
export type StickerResult = z.infer<typeof stickerResultSchema>;
