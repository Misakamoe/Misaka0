import { z } from 'zod';
import { revisionSchema } from './index.js';
import { stickerSourceSchema, stickerKindSchema } from './sticker.js';
import { subconvOptionsSchema } from './subconv.js';

export const stickerSourcesSchema = z.strictObject({ items: z.array(z.strictObject({
  source: stickerSourceSchema, kind: z.enum(['single', 'pack']), sourceKind: stickerKindSchema.optional(), expiresAt: z.iso.datetime(),
})).max(8) });

export const subconvSourceRefSchema = z.string().regex(/^[a-f0-9]{24}$/);
export const subconvSourcesSchema = z.strictObject({ items: z.array(z.strictObject({
  sourceRef: subconvSourceRefSchema, sourceCount: z.number().int().min(1).max(16), expiresAt: z.iso.datetime(),
})).max(8) });
export const subconvSafeOptionsSchema = subconvOptionsSchema.pick({
  target: true, insert: true, emoji: true, nodeList: true, scv: true, expand: true, sort: true,
  udp: true, tfo: true, appendType: true, newName: true, surgeDoh: true, clashDoh: true,
});
export const subconvSafeSettingsSchema = z.strictObject({ revision: revisionSchema, configured: z.boolean(), ...subconvSafeOptionsSchema.shape });
export const subconvOptionsUpdateSchema = z.strictObject({
  revision: revisionSchema, options: subconvSafeOptionsSchema.partial().refine(options => Object.keys(options).length > 0),
});
export const subconvGenerateOwnedSchema = z.strictObject({ sourceRef: subconvSourceRefSchema, revision: revisionSchema });
export const subconvOwnedReceiptSchema = z.strictObject({ delivered: z.literal(true), sourceCount: z.number().int().min(1).max(16) });

export type StickerSources = z.infer<typeof stickerSourcesSchema>;
export type SubconvSources = z.infer<typeof subconvSourcesSchema>;
export type SubconvSafeSettings = z.infer<typeof subconvSafeSettingsSchema>;
export type SubconvOptionsUpdate = z.infer<typeof subconvOptionsUpdateSchema>;
export type SubconvGenerateOwned = z.infer<typeof subconvGenerateOwnedSchema>;
export type SubconvOwnedReceipt = z.infer<typeof subconvOwnedReceiptSchema>;
