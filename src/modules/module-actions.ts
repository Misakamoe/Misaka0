import { z } from 'zod';
import { emptyInputSchema } from '../../shared/schemas/index.js';
import { aliasMutationResultSchema, aliasMutationSchema, aliasSnapshotSchema } from '../../shared/schemas/alias.js';
import { rssAddInputSchema, rssListInputSchema, rssListSchema, rssMutationSchema, rssRemoveInputSchema, rssSubscriptionSchema, rssUpdateInputSchema } from '../../shared/schemas/rss.js';
import { rateCurrenciesSchema, rateInputSchema, ratePageInputSchema, rateResultSchema } from '../../shared/schemas/rate.js';
import { weatherDefaultInputSchema, weatherDefaultSchema, weatherQueryInputSchema, weatherResultSchema, weatherSearchInputSchema, weatherSearchSchema } from '../../shared/schemas/weather.js';
import { stickerCancelInputSchema, stickerCancelResultSchema, stickerConvertInputSchema, stickerInspectInputSchema, stickerResultSchema, stickerViewSchema } from '../../shared/schemas/sticker.js';
import { subconvGenerateInputSchema, subconvResultSchema, subconvSnapshotSchema } from '../../shared/schemas/subconv.js';
import { stickerSourcesSchema, subconvGenerateOwnedSchema, subconvOptionsUpdateSchema, subconvOwnedReceiptSchema,
  subconvSafeOptionsSchema, subconvSafeSettingsSchema, subconvSourcesSchema } from '../../shared/schemas/ai-native.js';
import type { ActionExecutor, InvocationContext } from '../actions.js';
import { AppError } from '../errors.js';
import type { AliasService } from './alias.js';
import type { RssService, RssTarget } from './rss.js';
import type { RateService } from './rate.js';
import type { WeatherService } from './weather.js';
import type { StickerService } from './sticker.js';
import type { SubconvNativeDelivery, SubconvService } from './subconv.js';
import { subconvResetSchema, subconvUpdateSchema } from './subconv-schema.js';

export function registerAliasActions(executor: Pick<ActionExecutor, 'register'>, service: AliasService): void {
  const common = {
    permission: 'superadmin', scopes: ['private'], sources: ['telegram', 'http', 'ai'], aiVisible: true, timeoutMs: 15_000,
  } as const;
  executor.register({ ...common, id: 'alias.list', input: emptyInputSchema, output: aliasSnapshotSchema, effect: 'read',
    aiDescription: 'List native command aliases and the current revision. Available only to a configured superadministrator in a private chat.',
    execute: () => { const { revision, aliases } = service.snapshot(); return { revision, aliases }; },
  });
  executor.register({ ...common, id: 'alias.add', input: aliasMutationSchema, output: aliasMutationResultSchema, effect: 'permission',
    aiDescription: 'Add a native command alias at the current revision. Private configured-superadministrator operation requiring human confirmation.',
    execute: (input, context) => service.add(input.command, input.alias, input.revision, context.signal),
  });
  executor.register({ ...common, id: 'alias.remove', input: aliasMutationSchema, output: aliasMutationResultSchema, effect: 'permission',
    aiDescription: 'Remove a native command alias at the current revision. Private configured-superadministrator operation requiring human confirmation.',
    execute: (input, context) => service.remove(input.command, input.alias, input.revision, context.signal),
  });
}

export function registerRssActions(executor: Pick<ActionExecutor, 'register'>, service: RssService): void {
  const modelSubscription = rssSubscriptionSchema.omit({ url: true }).extend({ sourceRedacted: z.literal(true) });
  const project = (value: z.infer<typeof rssSubscriptionSchema>) => {
    // Feed URLs may contain access tokens. Management uses scoped IDs instead.
    const { url, ...metadata } = value; void url;
    return { ...metadata, sourceRedacted: true as const };
  };
  const common = { permission: 'chat_manager', scopes: ['private', 'group'], sources: ['telegram', 'http', 'ai'], aiVisible: true, timeoutMs: 30_000,
    target: (_input: unknown, context: InvocationContext) => context.chat.type === 'private'
      ? { kind: 'user' as const, id: context.actorId } : { kind: 'chat' as const, id: context.chat.id },
  } as const;
  const target = (context: InvocationContext): RssTarget => ({ chatId: context.chat.id, kind: context.chat.type === 'private' ? 'private' : 'group', threadId: context.chat.threadId });
  const confirmationSubject = (input: z.infer<typeof rssRemoveInputSchema>, context: InvocationContext) => {
    const subscription = service.get(target(context), input.id);
    if (subscription.revision !== input.revision) throw new AppError('CONFLICT');
    return { kind: 'rss' as const, id: subscription.id, title: subscription.title };
  };
  executor.register({ ...common, id: 'rss.list', input: rssListInputSchema, output: rssListSchema, effect: 'read',
    aiOutput: rssListSchema.extend({ items: z.array(modelSubscription).max(5) }), modelOutput: output => ({ ...output, items: output.items.map(project) }),
    aiDescription: 'List scoped RSS IDs, titles, keyword filters and health. Group callers must be chat managers. Source URLs are withheld from the model.', execute: (input, context) => service.list(target(context), input.page) });
  executor.register({ ...common, id: 'rss.get', input: rssRemoveInputSchema.pick({ id: true }), output: rssSubscriptionSchema, effect: 'read',
    aiOutput: modelSubscription, modelOutput: project,
    aiDescription: 'Read scoped RSS metadata, keyword filters and revision. Source URLs are withheld from the model.', execute: (input, context) => service.get(target(context), input.id) });
  executor.register({ ...common, id: 'rss.add', input: rssAddInputSchema, output: rssMutationSchema, effect: 'permission',
    aiDescription: 'Subscribe the current chat and actual topic to an RSS feed without backfilling history. Optional filters require include and exclude arrays of literal keywords: NFKC-normalized, case-insensitive substring matching on title or bounded visible feed content, include-any and exclude-any veto; empty arrays disable filtering. No regex or article-page fetch. Requires chat-manager permission and human confirmation.', execute: (input, context) => service.add(target(context), input, context.language, context.signal) });
  executor.register({ ...common, id: 'rss.update', input: rssUpdateInputSchema, output: rssMutationSchema, effect: 'permission', confirmationSubject,
    aiDescription: 'Update an RSS subscription at its current revision, only in this chat and topic. Filters replace both include and exclude arrays; filters:null clears them. Literal NFKC-normalized, case-insensitive keywords match title or bounded visible feed content: include-any, exclude-any veto, empty arrays disabled, no regex or article-page fetch. Rejected queued entries are dropped; clearing never backfills history or retries uncertain sends. Requires chat-manager permission and human confirmation.', execute: (input, context) => service.update(target(context), input, context.signal) });
  executor.register({ ...common, id: 'rss.remove', input: rssRemoveInputSchema, output: rssMutationSchema, effect: 'permission', confirmationSubject,
    aiDescription: 'Remove an RSS subscription at its current revision, only in this chat and topic. Requires chat-manager permission and human confirmation.', execute: (input, context) => service.remove(target(context), input.id, input.revision, context.signal) });
}

export function registerRateActions(executor: Pick<ActionExecutor, 'register'>, service: RateService): void {
  const common = { permission: 'any', scopes: ['private', 'group'], sources: ['telegram', 'http', 'ai'], effect: 'read', timeoutMs: 40_000, aiVisible: true } as const;
  executor.register({ ...common, id: 'rate.convert', input: rateInputSchema, output: rateResultSchema,
    aiDescription: 'Convert fiat or supported cryptocurrency amounts using native rates. Resolve ambiguous currencies and report stale-rate status and attribution.', execute: (input, context) => service.convert(input, context.signal) });
  executor.register({ ...common, id: 'rate.currencies', input: ratePageInputSchema, output: rateCurrenciesSchema,
    aiDescription: 'List supported currencies in bounded pages for native conversion.', execute: (input, context) => service.currencies(input.page, context.signal) });
}

export function registerWeatherActions(executor: Pick<ActionExecutor, 'register'>, service: WeatherService): void {
  const common = { permission: 'any', scopes: ['private', 'group'], sources: ['telegram', 'http', 'ai'], effect: 'read', timeoutMs: 60_000, aiVisible: true } as const;
  executor.register({ ...common, id: 'weather.search', input: weatherSearchInputSchema, output: weatherSearchSchema,
    aiDescription: 'Search weather locations by name; resolve ambiguous results before querying weather.', execute: (input, context) => service.search(input, context.language, context.signal) });
  executor.register({ ...common, id: 'weather.query', input: weatherQueryInputSchema, output: weatherResultSchema,
    aiDescription: 'Get current weather or a bounded forecast for an explicit location. Group queries never use personal defaults; preserve timezone and provider attribution.', execute: (input, context) => service.query(input, context.language, context.signal) });
  executor.register({ ...common, id: 'weather.default.get', permission: 'self', scopes: ['private'], input: emptyInputSchema, output: weatherDefaultSchema,
    aiDescription: 'Read only the current private caller\'s personal weather default and revision. Never available in groups.', execute: (_input, context) => service.getDefault(context.actorId) });
  executor.register({ ...common, id: 'weather.default.set', permission: 'self', scopes: ['private'], effect: 'personal_write', input: weatherDefaultInputSchema, output: weatherDefaultSchema,
    aiDescription: 'Set or clear the current private caller\'s personal weather default at its current revision. Cannot change another user\'s settings.', execute: (input, context) => service.setDefault(context.actorId, input, context.signal) });
}

export function registerStickerActions(executor: Pick<ActionExecutor, 'register'>, service: StickerService): void {
  const common = { permission: 'self', scopes: ['private'], sources: ['telegram', 'ai'], aiVisible: true, timeoutMs: 60_000 } as const;
  executor.register({ ...common, id: 'sticker.sources', input: emptyInputSchema, output: stickerSourcesSchema, effect: 'read',
    aiDescription: 'List up to eight unexpired opaque sticker references captured by the current owner through native Telegram UI in this private topic. No Telegram file IDs or download URLs are exposed.',
    execute: (_input, context) => service.listSources(context) });
  executor.register({ ...common, id: 'sticker.inspect', input: stickerInspectInputSchema, output: stickerViewSchema,
    aiDescription: 'Inspect an owned opaque sticker reference from sticker.sources in this private topic. Use supported formats; never invent file IDs or URLs.',
    effect: 'read', execute: (input, context) => service.inspect(context, input.source) });
  executor.register({ ...common, id: 'sticker.convert', input: stickerConvertInputSchema, output: stickerResultSchema,
    aiDescription: 'Convert or deliver an owned native sticker reference directly to this private topic. Returns only a delivery receipt. Original files remain available; native conversion may be unavailable under resource limits.',
    effect: 'personal_write', execute: (input, context) => service.convert(context, input) });
  executor.register({ ...common, id: 'sticker.cancel', input: stickerCancelInputSchema, output: stickerCancelResultSchema,
    aiDescription: 'Cancel and drain the current owner\'s sticker job in this private topic, optionally restricted to one opaque source reference.',
    effect: 'personal_write', execute: (input, context) => service.cancel(context, input.source) });
}

export function registerSubconvActions(executor: Pick<ActionExecutor, 'register'>, service: SubconvService, deliver?: SubconvNativeDelivery): void {
  const common = { permission: 'self', sources: ['telegram'], scopes: ['private'], aiVisible: false, timeoutMs: 15_000 } as const;
  const visible = { ...common, sources: ['telegram', 'ai'], aiVisible: true } as const;
  const projection = { aiOutput: subconvSafeSettingsSchema, modelOutput: (output: ReturnType<SubconvService['settings']>) => ({
    revision: output.revision, configured: Boolean(output.settings.backend),
    ...subconvSafeOptionsSchema.parse(Object.fromEntries(Object.keys(subconvSafeOptionsSchema.shape)
      .map(key => [key, output.settings.options[key as keyof typeof output.settings.options]]))),
  }) };
  executor.register({ ...visible, ...projection, id: 'subconv.settings.get', input: emptyInputSchema, output: subconvSnapshotSchema, effect: 'read',
    aiDescription: 'Read only whether the private owner configured subscription conversion, its revision, target and nonsecret options. Backend, source URLs, filters and remote configuration are hidden.', execute: (_input, context) => service.settings(context) });
  executor.register({ ...common, id: 'subconv.settings.set', input: subconvUpdateSchema, output: subconvSnapshotSchema, effect: 'personal_write', execute: (input, context) => service.update(context, input.settings, input.revision) });
  executor.register({ ...common, id: 'subconv.settings.reset', input: subconvResetSchema, output: subconvSnapshotSchema, effect: 'personal_write', execute: (input, context) => service.reset(context, input.revision) });
  executor.register({ ...common, id: 'subconv.generate', input: subconvGenerateInputSchema, output: subconvResultSchema, effect: 'read', execute: (input, context) => service.generate(context, input) });
  executor.register({ ...visible, ...projection, id: 'subconv.options.set', input: subconvOptionsUpdateSchema, output: subconvSnapshotSchema, effect: 'personal_write',
    aiDescription: 'Change only nonsecret conversion options at the current revision. Hidden backend, source, remote configuration, filename and private filters remain unchanged.', execute: (input, context) => service.updateOptions(context, input) });
  executor.register({ ...visible, id: 'subconv.sources', input: emptyInputSchema, output: subconvSourcesSchema, effect: 'read',
    aiDescription: 'List up to eight opaque subscription source handles explicitly captured through native generation by this owner in this private topic. Handles expire after ten minutes; raw inputs and custom parameters are never returned.', execute: (_input, context) => service.listSources(context) });
  executor.register({ ...visible, id: 'subconv.generate_owned', input: subconvGenerateOwnedSchema, output: subconvOwnedReceiptSchema, effect: 'personal_write',
    aiDescription: 'Generate from an owned source handle at the current settings revision and deliver subscription.txt directly to the same private owner. This is pure local URL construction, not fetching, shortening or contacting a backend. Returns only a receipt, never the generated URL.',
    execute: (input, context) => service.generateOwned(context, input, deliver) });
}
