import type { AiGrant, AiPreset, AiProvider, AiScope, AiSettings, AiSettingsSnapshot } from '../../shared/schemas/ai.js';
import type { AiExtensionScope } from '../../shared/schemas/ai-extensions.js';
import type { AccessService } from '../access.js';
import type { InvocationContext } from '../actions.js';
import { AppError, throwIfAborted } from '../errors.js';

export function aiScope(context: Pick<InvocationContext, 'botId' | 'actorId' | 'chat'>): AiScope {
  return { botId: context.botId, chatId: context.chat.id, ...(context.chat.threadId ? { threadId: context.chat.threadId } : {}),
    ...(context.chat.type === 'private' ? { ownerId: context.actorId } : {}) };
}

export function aiScopeId(scope: AiScope): string {
  return `${scope.botId}:${scope.chatId}:${scope.threadId ?? 0}:${scope.ownerId ?? 0}`;
}

export interface AiSelection {
  snapshot: AiSettingsSnapshot;
  grant: AiGrant;
  preset: AiPreset;
  provider: AiProvider;
  policyKey?: string;
}

export function aiPolicyParts(settings: AiSettings): Map<string, unknown> {
  const parts = new Map<string, unknown>([['enabled', settings.enabled], ['limits', settings.limits],
    ['search', settings.search ?? null], ['sandbox', settings.sandbox?.enabled ?? false]]);
  for (const id of settings.deniedUserIds) parts.set(`denied:${id}`, true);
  for (const grant of settings.grants) parts.set(`grant:${grant.kind}:${grant.subjectId}`, grant);
  for (const [kind, values] of [['provider', settings.providers], ['preset', settings.presets], ['skill', settings.skills ?? []],
    ['mcp', settings.mcp ?? []], ['remote', settings.sandbox?.profiles ?? []], ['local', settings.sandbox?.localProfiles ?? []],
    ['stdio', settings.sandbox?.stdioProfiles ?? []]] as const) {
    for (const value of values) parts.set(`${kind}:${value.id}`, value);
  }
  return parts;
}

export function aiPolicyDependencies(context: Pick<InvocationContext, 'actorId' | 'botId' | 'chat'>, settings: AiSettings, actionId = ''): string[] {
  const kind = context.chat.type === 'private' ? 'private' : 'group';
  const subject = kind === 'private' ? context.actorId : context.chat.id;
  const keys = ['enabled', `denied:${context.actorId}`];
  // Human-owned data controls remain usable after provider access is revoked.
  if (/^ai\.(?:conversations\.|memory\.(?:remember|update|delete|list)$)/.test(actionId)) return keys;
  keys.push('limits', `grant:${kind}:${subject}`);
  const grant = settings.grants.find(item => item.kind === kind && item.subjectId === subject);
  const preset = settings.presets.find(item => item.id === grant?.presetId);
  const provider = settings.providers.find(item => item.id === preset?.providerId);
  if (preset) keys.push(`preset:${preset.id}`);
  if (provider) keys.push(`provider:${provider.id}`, `credential:${provider.credentialRef}`);
  const tools = preset?.tools ?? [];
  const matches = (scope?: AiExtensionScope) => scope?.botId === context.botId && scope.ownerId === context.actorId
    && scope.audience.kind === kind && (scope.audience.kind === 'private' ? scope.audience.userId : scope.audience.chatId) === context.chat.id
    && scope.audience.threadId === context.chat.threadId;
  if (tools.some(tool => ['ai.search', 'ai.fetch'].includes(tool))) {
    keys.push('search');
    const search = settings.providers.find(item => item.id === settings.search?.providerId);
    if (search) keys.push(`provider:${search.id}`, `credential:${search.credentialRef}`);
  }
  if (tools.some(tool => tool.startsWith('ai.skills.'))) {
    for (const skill of settings.skills ?? []) if (skill.scopes.some(matches)) keys.push(`skill:${skill.id}`);
  }
  for (const [prefix, name, profiles] of [['ai.mcp.', 'mcp', settings.mcp ?? []], ['ai.sandbox.', 'remote', settings.sandbox?.profiles ?? []],
    ['ai.sandbox.', 'local', settings.sandbox?.localProfiles ?? []], ['ai.mcp.', 'stdio', settings.sandbox?.stdioProfiles ?? []]] as const) {
    if (!tools.some(tool => tool.startsWith(prefix))) continue;
    if (name !== 'mcp') keys.push('sandbox');
    for (const profile of profiles) if (matches(profile.scope)) {
      keys.push(`${name}:${profile.id}`);
      if ('credentialRef' in profile && profile.credentialRef) keys.push(`credential:${profile.credentialRef}`);
    }
  }
  return [...new Set(keys)].sort();
}

export function selectAi(context: InvocationContext, snapshot: AiSettingsSnapshot, access: Pick<AccessService, 'isAllowed'>, now = Date.now()): AiSelection {
  throwIfAborted(context.signal);
  const settings = snapshot.settings;
  if (!settings.enabled) throw new AppError('AI_DISABLED');
  if (settings.deniedUserIds.includes(context.actorId)) throw new AppError('FORBIDDEN');
  const kind = context.chat.type === 'private' ? 'private' : 'group';
  if (kind === 'group' && !access.isAllowed(context.chat.id)) throw new AppError('FORBIDDEN');
  const subject = kind === 'private' ? context.actorId : context.chat.id;
  const grant = settings.grants.find(item => item.kind === kind && item.subjectId === subject);
  if (!grant || grant.expiresAt && Date.parse(grant.expiresAt) <= now) throw new AppError('FORBIDDEN');
  const preset = settings.presets.find(item => item.id === grant.presetId);
  const provider = preset && settings.providers.find(item => item.id === preset.providerId && item.enabled);
  if (!preset || !provider) throw new AppError('UNAVAILABLE');
  if (context.aiSettingsRevision !== undefined && context.aiSettingsRevision !== snapshot.revision
    || context.aiGrantId !== undefined && context.aiGrantId !== grant.id) throw new AppError('FORBIDDEN');
  return { snapshot, grant, preset, provider };
}
