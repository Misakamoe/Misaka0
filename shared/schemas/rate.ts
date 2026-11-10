import { z } from 'zod';

export const currencyDefinitionSchema = z.strictObject({
  code: z.string().regex(/^[A-Z0-9]{2,10}$/), name: z.string().min(1).max(160), kind: z.enum(['fiat', 'crypto']), coinId: z.string().max(80).optional(),
});
export const rateInputSchema = z.strictObject({
  query: z.string().min(1).max(500).optional(), amount: z.string().min(1).max(64).optional(),
  from: z.string().min(1).max(128).optional(), to: z.string().min(1).max(128).optional(),
}).refine(input => input.query ? !input.amount && !input.from && !input.to : Boolean(input.from && input.to));
export const ratePageInputSchema = z.strictObject({ page: z.number().int().min(0).max(100_000).default(0) });
export const rateCurrenciesSchema = z.strictObject({ items: z.array(currencyDefinitionSchema).max(10), total: z.number().int().nonnegative(), page: z.number().int().nonnegative(), pageSize: z.literal(10) });
export const rateResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('ambiguous'), amount: z.string(), from: z.array(currencyDefinitionSchema).max(300), to: z.array(currencyDefinitionSchema).max(300) }),
  z.strictObject({ kind: z.literal('converted'), amount: z.string(), result: z.string().max(160), unitRate: z.string().max(160),
    from: currencyDefinitionSchema, to: currencyDefinitionSchema, stale: z.boolean(),
    sources: z.array(z.strictObject({ name: z.enum(['ExchangeRate-API', 'CoinGecko']), updatedAt: z.iso.datetime(), url: z.url() })).max(2),
  }),
]);
export type RateInput = z.infer<typeof rateInputSchema>;
export type RateResult = z.infer<typeof rateResultSchema>;
export type RateCurrencies = z.infer<typeof rateCurrenciesSchema>;
