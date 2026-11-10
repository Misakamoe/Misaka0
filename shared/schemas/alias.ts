import { z } from 'zod';
import { revisionSchema } from './index.js';

export function normalizeAliasName(name: string): string {
  return name.normalize('NFKC').toLowerCase();
}

const nameValueSchema = z.string().min(1).max(32).regex(/^[\p{L}\p{N}\p{M}_]+$/u)
  // Zod counts code points; the alias contract bounds UTF-16 units instead.
  .refine(name => name.length <= 32)
  .refine(name => !/[\p{Default_Ignorable_Code_Point}\p{Extended_Pictographic}\u20e3]/u.test(name));
const canonicalValueSchema = z.string().min(1).max(32).regex(/^[a-z0-9_]+$/)
  .refine(name => name !== '__proto__');
const normalizedNameSchema = nameValueSchema.refine(name => normalizeAliasName(name) === name);

export const aliasNameSchema = nameValueSchema.transform(normalizeAliasName).pipe(normalizedNameSchema);
export const canonicalCommandSchema = aliasNameSchema.pipe(canonicalValueSchema);

// Zod records omit __proto__ keys; reject them before parsing rather than repairing corrupt state.
const aliasesSchema = z.unknown().refine(value => value !== null && typeof value === 'object'
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && !Object.hasOwn(value, '__proto__'))
  .pipe(z.record(canonicalValueSchema, z.array(normalizedNameSchema).max(8)));

export const aliasSnapshotSchema = z.strictObject({ revision: revisionSchema, aliases: aliasesSchema })
  .superRefine((snapshot, context) => {
    const seen = new Set<string>();
    for (const [command, aliases] of Object.entries(snapshot.aliases)) {
      for (const alias of aliases) {
        if (seen.has(alias)) context.addIssue({ code: 'custom', path: ['aliases', command], message: 'Duplicate alias' });
        seen.add(alias);
      }
    }
  });
export type AliasSnapshot = z.infer<typeof aliasSnapshotSchema>;

export const aliasMutationSchema = z.strictObject({
  command: canonicalCommandSchema, alias: aliasNameSchema, revision: revisionSchema,
});
export const aliasMutationResultSchema = z.strictObject({
  command: canonicalValueSchema, alias: normalizedNameSchema, changed: z.boolean(), revision: revisionSchema,
});
export type AliasMutationResult = z.infer<typeof aliasMutationResultSchema>;
