import { randomBytes } from 'node:crypto';
import { assertExtensionScope, ExtensionError, extensionDigest, extensionJson, type ExtensionScope } from './skills.js';
import type { AiTransport, AiTransportDependencies } from './transport.js';
import type { LocalStdioPort } from './local-sandbox.js';

/** Implemented only by the trusted pinned transport adapter, never global fetch. */
export interface ExtensionHttpRequest {
  url: string;
  approvedOrigin: string;
  credentialRef?: string;
  scope: ExtensionScope;
  method: 'POST' | 'DELETE';
  headers: Readonly<Record<string, string>>;
  body?: string;
  maxRequestBytes: number;
  maxResponseBytes: number;
  signal: AbortSignal;
}
export interface ExtensionHttpResponse {
  status: number;
  headers: Readonly<Record<string, string | undefined>>;
  body: unknown;
}
export type ExtensionHttpTransport = (request: ExtensionHttpRequest) => Promise<ExtensionHttpResponse>;

/** Production networking always uses the shared DNS/TLS-pinned, redirect-denying client. */
export function createPinnedTransport(options: {
  credential: (reference: string, request: ExtensionHttpRequest) => string;
  authorize: (request: ExtensionHttpRequest) => void;
  network?: AiTransportDependencies;
}): ExtensionHttpTransport {
  let client: Promise<AiTransport> | undefined;
  return async input => {
    validateExtensionEndpoint(input);
    options.authorize(input);
    input.signal.throwIfAborted();
    if (input.body !== undefined && Buffer.byteLength(input.body) > input.maxRequestBytes) throw new ExtensionError('EXTENSION_LIMIT');
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.headers)) {
      if (key === 'content-type' && value === 'application/json' || key === 'accept' && value === 'application/json') continue;
      if (!['accept', 'mcp-protocol-version', 'mcp-session-id'].includes(key)
        || !/^[\x20-\x7e]{1,256}$/.test(value)
        || key === 'accept' && value !== 'application/json, text/event-stream') throw new ExtensionError('INVALID_EXTENSION');
      headers[key] = value;
    }
    if (input.credentialRef) {
      const secret = options.credential(input.credentialRef, input);
      if (!secret || secret.length > 4096 || /[^\x21-\x7e]/.test(secret)) throw new ExtensionError('EXTENSION_FORBIDDEN');
      headers.authorization = `Bearer ${secret}`;
    }
    client ??= import('./transport.js').then(module => module.createAiTransport(options.network));
    const transport = await client;
    input.signal.throwIfAborted();
    options.authorize(input);
    if (!transport.request) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    const request = { origin: input.approvedOrigin, path: new URL(input.url).pathname, method: input.method,
      headers, ...(input.body === undefined ? {} : { body: JSON.parse(input.body) as unknown }),
      mcp: input.headers['mcp-protocol-version'] !== undefined };
    const response = await transport.request(request, { signal: input.signal, limits: {
      requestBytes: input.maxRequestBytes, responseBytes: input.maxResponseBytes, eventBytes: input.maxResponseBytes,
      events: 64, timeoutMs: 25_000,
    } });
    const responseHeaders: Record<string, string> = {};
    for (const key of ['mcp-session-id', 'content-type']) {
      const value = response.headers[key];
      if (value !== undefined) {
        if (typeof value !== 'string' || value.length > 256) throw new ExtensionError('INVALID_EXTENSION');
        responseHeaders[key] = value;
      }
    }
    if (response.value !== undefined) extensionJson(response.value, input.maxResponseBytes);
    return { status: response.status, headers: responseHeaders, body: response.value };
  };
}

export interface ReviewedMcpProfile {
  id: string;
  enabled: boolean;
  transport: 'http';
  url: string;
  approvedOrigin: string;
  credentialRef?: string;
  /** One credential profile is never implicitly shared across actors or audiences. */
  scope: ExtensionScope;
  approvedTools: readonly string[];
  reviewedDigest?: string;
  policyBinding?: string;
}
export interface ReviewedStdioMcpProfile {
  id: string;
  enabled: boolean;
  transport: 'stdio';
  scope: ExtensionScope;
  approvedTools: readonly string[];
  reviewedDigest?: string;
  /** Pins the reviewed bundle, fixed argv/inputs, scope, limits and runner policy. */
  policyBinding: string;
}
type McpProfile = ReviewedMcpProfile | ReviewedStdioMcpProfile;
export interface McpTool { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown> }
export interface McpDiscovery {
  digest: string;
  tools: McpTool[];
  /** Admin review data only, never system instructions or automatic tool policy. */
  review: { initialized: Record<string, unknown>; tools: Record<string, unknown>[]; listingMetadata: Record<string, unknown>[] };
}
export interface McpResult {
  isError: boolean;
  content: ({ type: 'text'; text: string } | { type: 'resource'; reference: string })[];
}

const protocolVersion = '2025-06-18';
const maxResponseBytes = 256 * 1024;
const maxRequestBytes = 32 * 1024;
const toolName = /^[a-zA-Z0-9_.:-]{1,128}$/;
const schemas = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
  'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems',
  'description', 'title', 'default', 'examples', '$schema', 'allOf', 'anyOf', 'oneOf']);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ExtensionError('INVALID_EXTENSION');
  return value as Record<string, unknown>;
}

/** Only a bounded, non-executable schema subset; no regex, refs, codegen or fetch. */
function validateSchema(value: unknown, depth = 0): asserts value is Record<string, unknown> {
  const schema = object(value);
  if (depth > 8 || Buffer.byteLength(extensionJson(schema)) > 16 * 1024) throw new ExtensionError('EXTENSION_LIMIT');
  if (Object.keys(schema).some((key) => !schemas.has(key))) throw new ExtensionError('INVALID_EXTENSION');
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.length || types.some((type) => !['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(type as string))) {
      throw new ExtensionError('INVALID_EXTENSION');
    }
  }
  if (schema.properties !== undefined) for (const child of Object.values(object(schema.properties))) validateSchema(child, depth + 1);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== 'string'))) {
    throw new ExtensionError('INVALID_EXTENSION');
  }
  if (schema.additionalProperties !== undefined && typeof schema.additionalProperties !== 'boolean') validateSchema(schema.additionalProperties, depth + 1);
  if (schema.items !== undefined) validateSchema(schema.items, depth + 1);
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (schema[key] === undefined) continue;
    if (!Array.isArray(schema[key]) || !schema[key].length || schema[key].length > 8) throw new ExtensionError('INVALID_EXTENSION');
    for (const child of schema[key]) validateSchema(child, depth + 1);
  }
  for (const key of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'minItems', 'maxItems']) {
    if (schema[key] !== undefined && (typeof schema[key] !== 'number' || !Number.isFinite(schema[key]))) throw new ExtensionError('INVALID_EXTENSION');
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || !schema.enum.length)) throw new ExtensionError('INVALID_EXTENSION');
}

function matchesSchema(value: unknown, schema: Record<string, unknown>, budget = { remaining: 10_000 }): boolean {
  if (--budget.remaining < 0) throw new ExtensionError('EXTENSION_LIMIT');
  const types = schema.type === undefined ? [] : Array.isArray(schema.type) ? schema.type : [schema.type];
  if (types.length && !types.some((type) => type === 'null' ? value === null
    : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
      : type === 'integer' ? Number.isInteger(value) : typeof value === type)) return false;
  if (schema.const !== undefined && extensionJson(value) !== extensionJson(schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => extensionJson(item) === extensionJson(value))) return false;
  if (typeof value === 'string' && ((typeof schema.minLength === 'number' && [...value].length < schema.minLength)
    || (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength))) return false;
  if (typeof value === 'number' && ((typeof schema.minimum === 'number' && value < schema.minimum)
    || (typeof schema.maximum === 'number' && value > schema.maximum)
    || (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum)
    || (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum))) return false;
  if (Array.isArray(value)) {
    if ((typeof schema.minItems === 'number' && value.length < schema.minItems)
      || (typeof schema.maxItems === 'number' && value.length > schema.maxItems)) return false;
    if (schema.items && !value.every((item) => matchesSchema(item, object(schema.items), budget))) return false;
  } else if (value !== null && typeof value === 'object') {
    const properties = schema.properties ? object(schema.properties) : {};
    if (Array.isArray(schema.required) && schema.required.some((key) => !Object.hasOwn(value, key as string))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        if (!matchesSchema(item, object(properties[key]), budget)) return false;
      } else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object'
        && !matchesSchema(item, object(schema.additionalProperties), budget)) return false;
    }
  }
  for (const key of ['allOf', 'anyOf', 'oneOf']) {
    if (!Array.isArray(schema[key])) continue;
    const count = schema[key].filter((child) => matchesSchema(value, object(child), budget)).length;
    if (key === 'allOf' ? count !== schema[key].length : key === 'anyOf' ? count === 0 : count !== 1) return false;
  }
  return true;
}

export function validateExtensionEndpoint(profile: { url: string; approvedOrigin: string; credentialRef?: string }): void {
  try {
    const url = new URL(profile.url);
    const origin = new URL(profile.approvedOrigin);
    if (profile.url.length > 2048 || /\s/.test(profile.url) || [...profile.url].some((char) => char.charCodeAt(0) < 32) || url.protocol !== 'https:'
      || url.username || url.password || url.hash || url.search || url.origin !== profile.approvedOrigin
      || origin.href !== `${origin.origin}/` || (profile.credentialRef !== undefined && !/^[a-zA-Z0-9_.:-]{1,128}$/.test(profile.credentialRef))) {
      throw new Error();
    }
  } catch { throw new ExtensionError('INVALID_EXTENSION'); }
}

interface ResourceRecord {
  profileId: string;
  profileDigest: string;
  discoveryDigest: string;
  scope: ExtensionScope;
  uri?: string;
  embedded?: unknown;
  expiresAt: number;
}

/** Demand-only connections, one operation at a time, no long-lived client or SDK. */
export class McpService {
  private active = false;
  private readonly resources = new Map<string, ResourceRecord>();
  constructor(private readonly options: {
    profiles: () => readonly McpProfile[];
    transport: ExtensionHttpTransport;
    stdio?: <T>(profile: ReviewedStdioMcpProfile, signal: AbortSignal, exchange: (port: LocalStdioPort) => Promise<T>) => Promise<T>;
    now?: () => number;
  }) {}

  private profile(id: string, scope: ExtensionScope): McpProfile {
    const profiles = this.options.profiles();
    if (profiles.length > 64) throw new ExtensionError('EXTENSION_LIMIT');
    const matches = profiles.filter((item) => item.id === id);
    if (matches.length !== 1 || !matches[0]!.enabled) throw new ExtensionError('EXTENSION_FORBIDDEN');
    const profile = structuredClone(matches[0]!);
    assertExtensionScope(scope, [profile.scope]);
    if (profile.transport === 'http') validateExtensionEndpoint(profile);
    else if (profile.transport !== 'stdio' || !this.options.stdio) throw new ExtensionError('EXTENSION_UNAVAILABLE');
    else if (!/^[a-f0-9]{64}$/.test(profile.policyBinding) || ['url', 'approvedOrigin', 'credentialRef', 'command', 'env'].some(key => Object.hasOwn(profile, key))) throw new ExtensionError('INVALID_EXTENSION');
    if (!toolName.test(profile.id) || profile.approvedTools.length > 64 || profile.approvedTools.some((name) => !toolName.test(name))) {
      throw new ExtensionError('INVALID_EXTENSION');
    }
    return profile;
  }

  async discover(id: string, scope: ExtensionScope, signal: AbortSignal): Promise<McpDiscovery> {
    return this.session(id, scope, signal, async (_rpc, discovery) => discovery, false);
  }

  async list(id: string, scope: ExtensionScope, signal: AbortSignal): Promise<McpTool[]> {
    return this.session(id, scope, signal, async (_rpc, discovery, profile) =>
      discovery.tools.filter((tool) => profile.approvedTools.includes(tool.name)), true);
  }

  async call(id: string, name: string, args: unknown, scope: ExtensionScope, signal: AbortSignal): Promise<McpResult> {
    const argumentsSnapshot: unknown = JSON.parse(extensionJson(args, maxRequestBytes));
    object(argumentsSnapshot);
    return this.session(id, scope, signal, async (rpc, discovery, profile) => {
      const tool = discovery.tools.find((item) => item.name === name);
      if (!tool || !profile.approvedTools.includes(name)) throw new ExtensionError('EXTENSION_FORBIDDEN');
      if (!matchesSchema(argumentsSnapshot, tool.inputSchema)) throw new ExtensionError('INVALID_EXTENSION');
      let result: unknown;
      try { result = await rpc('tools/call', { name, arguments: argumentsSnapshot }); }
      catch { throw new ExtensionError('OUTCOME_UNKNOWN'); }
      // Revocation after dispatch means the result cannot be disclosed or retried.
      try { this.unchanged(profile, scope); }
      catch { throw new ExtensionError('OUTCOME_UNKNOWN'); }
      try {
        if (tool.outputSchema && object(result).isError !== true
          && (!Object.hasOwn(object(result), 'structuredContent') || !matchesSchema(object(result).structuredContent, tool.outputSchema))) throw new ExtensionError('INVALID_EXTENSION');
        return this.project(result, profile, discovery.digest);
      }
      catch { throw new ExtensionError('OUTCOME_UNKNOWN'); }
    }, true);
  }

  async readResource(reference: string, scope: ExtensionScope, signal: AbortSignal): Promise<McpResult> {
    this.pruneResources();
    const resource = this.resources.get(reference);
    if (!resource) throw new ExtensionError('EXTENSION_FORBIDDEN');
    assertExtensionScope(scope, [resource.scope]);
    const profile = this.profile(resource.profileId, scope);
    if (extensionDigest(profile) !== resource.profileDigest || profile.reviewedDigest !== resource.discoveryDigest) throw new ExtensionError('REVIEW_REQUIRED');
    return this.session(profile.id, scope, signal, async (rpc, discovery, current) => {
      if (resource.embedded) return this.project({ content: [resource.embedded] }, current, discovery.digest, true);
      const result = object(await rpc('resources/read', { uri: resource.uri }));
      this.unchanged(current, scope);
      if (!Array.isArray(result.contents)) throw new ExtensionError('INVALID_EXTENSION');
      return this.project({ content: result.contents.map((item) => ({ type: 'resource', resource: item })) }, current, discovery.digest, true);
    }, true);
  }

  private unchanged(profile: McpProfile, scope: ExtensionScope): void {
    if (extensionDigest(this.profile(profile.id, scope)) !== extensionDigest(profile)) throw new ExtensionError('REVIEW_REQUIRED');
  }

  private async session<T>(id: string, scope: ExtensionScope, signal: AbortSignal,
    operation: (rpc: (method: string, params?: unknown) => Promise<unknown>, discovery: McpDiscovery, profile: McpProfile) => Promise<T>, requireReview: boolean): Promise<T> {
    if (this.active) throw new ExtensionError('EXTENSION_LIMIT');
    signal.throwIfAborted();
    scope = { ...scope };
    const profile = this.profile(id, scope);
    if (requireReview && !/^[a-f0-9]{64}$/.test(profile.reviewedDigest ?? '')) throw new ExtensionError('REVIEW_REQUIRED');
    this.active = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 20_000);
    timer.unref();
    let sessionId: string | undefined;
    let stdio: LocalStdioPort | undefined;
    let sequence = 0;
    const send = async (method: string, params?: unknown, notification = false): Promise<unknown> => {
      controller.signal.throwIfAborted();
      this.unchanged(profile, scope);
      const requestId = ++sequence;
      const body = extensionJson({ jsonrpc: '2.0', ...(notification ? {} : { id: requestId }), method, ...(params === undefined ? {} : { params }) }, maxRequestBytes);
      let response: ExtensionHttpResponse;
      try {
        if (profile.transport === 'stdio') {
          if (!stdio) throw new ExtensionError('EXTENSION_UNAVAILABLE');
          stdio.signal.throwIfAborted();
          const message: unknown = JSON.parse(body);
          const reply = notification ? await stdio.notify(message) : await stdio.request(message);
          response = { status: notification ? 202 : 200, headers: {}, body: reply };
        } else response = await this.options.transport({
          url: profile.url, approvedOrigin: profile.approvedOrigin, credentialRef: profile.credentialRef, scope: { ...scope },
          method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json',
            'mcp-protocol-version': protocolVersion, ...(sessionId ? { 'mcp-session-id': sessionId } : {}) },
          body, maxRequestBytes, maxResponseBytes, signal: controller.signal,
        });
      } catch { throw new ExtensionError('EXTENSION_UNAVAILABLE'); }
      controller.signal.throwIfAborted();
      this.unchanged(profile, scope);
      if (response.status < 200 || response.status >= 300) throw new ExtensionError('EXTENSION_UNAVAILABLE');
      const issuedSession = response.headers['mcp-session-id'];
      if (issuedSession !== undefined) {
        if (!/^[\x21-\x7e]{1,128}$/.test(issuedSession) || (sessionId && issuedSession !== sessionId)) throw new ExtensionError('INVALID_EXTENSION');
        sessionId = issuedSession;
      }
      if (notification) return undefined;
      extensionJson(response.body, maxResponseBytes);
      const message = object(response.body);
      if (message.jsonrpc !== '2.0' || message.id !== requestId || message.error !== undefined
        || !Object.hasOwn(message, 'result') || message.method !== undefined) throw new ExtensionError('INVALID_EXTENSION');
      return message.result;
    };
    const exchange = async () => {
      const initialized = object(await send('initialize', { protocolVersion, capabilities: {}, clientInfo: { name: 'Misaka', version: '1' } }));
      if (initialized.protocolVersion !== protocolVersion || !object(initialized.capabilities).tools) throw new ExtensionError('INVALID_EXTENSION');
      await send('notifications/initialized', undefined, true);
      const rawTools: Record<string, unknown>[] = [];
      const listingMetadata: Record<string, unknown>[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      for (let page = 0; ; page++) {
        if (page >= 4) throw new ExtensionError('EXTENSION_LIMIT');
        const listing = object(await send('tools/list', cursor ? { cursor } : {}));
        listingMetadata.push(Object.fromEntries(Object.entries(listing).filter(([key]) => key !== 'tools' && key !== 'nextCursor')));
        if (!Array.isArray(listing.tools) || listing.tools.length + rawTools.length > 64) throw new ExtensionError('EXTENSION_LIMIT');
        for (const value of listing.tools) {
          const tool = object(value);
          if (typeof tool.name !== 'string' || !toolName.test(tool.name) || rawTools.some((item) => item.name === tool.name)
            || (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 4096))) throw new ExtensionError('INVALID_EXTENSION');
          validateSchema(tool.inputSchema);
          if (object(tool.inputSchema).type !== 'object') throw new ExtensionError('INVALID_EXTENSION');
          if (tool.outputSchema !== undefined) validateSchema(tool.outputSchema);
          rawTools.push(tool);
        }
        if (listing.nextCursor === undefined) break;
        if (typeof listing.nextCursor !== 'string' || !listing.nextCursor || listing.nextCursor.length > 512 || cursors.has(listing.nextCursor)) throw new ExtensionError('INVALID_EXTENSION');
        cursor = listing.nextCursor;
        cursors.add(cursor);
      }
      // Full upstream metadata, including annotations, is reviewed, never authority.
      const digest = extensionDigest({ profile: profile.transport === 'http'
        ? { url: profile.url, approvedOrigin: profile.approvedOrigin, credentialRef: profile.credentialRef ?? null, scope: profile.scope, approvedTools: [...profile.approvedTools].sort(), policyBinding: profile.policyBinding ?? null }
        : { transport: 'stdio', scope: profile.scope, approvedTools: [...profile.approvedTools].sort(), policyBinding: profile.policyBinding },
        initialized, listingMetadata, tools: rawTools.sort((a, b) => String(a.name).localeCompare(String(b.name), 'en')) });
      if (requireReview && profile.reviewedDigest !== digest) throw new ExtensionError('REVIEW_REQUIRED');
      const discovery: McpDiscovery = { digest, review: { initialized, tools: rawTools, listingMetadata }, tools: rawTools.map((tool) => ({ name: tool.name as string,
        ...(typeof tool.description === 'string' ? { description: tool.description } : {}), inputSchema: object(tool.inputSchema),
        ...(tool.outputSchema === undefined ? {} : { outputSchema: object(tool.outputSchema) }) })) };
      extensionJson(discovery, 128 * 1024);
      return await operation(send, discovery, profile);
    };
    try {
      return profile.transport === 'stdio'
        ? await this.options.stdio!(profile, controller.signal, async port => { stdio = port; return exchange(); })
        : await exchange();
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
      if (sessionId && profile.transport === 'http') {
        // Closing a session sends no user payload, even when the operation was cancelled.
        const cleanup = new AbortController();
        const cleanupTimer = setTimeout(() => cleanup.abort(), 2000);
        cleanupTimer.unref();
        try {
          await this.options.transport({ url: profile.url, approvedOrigin: profile.approvedOrigin, credentialRef: profile.credentialRef,
            scope: { ...scope }, method: 'DELETE', headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion },
            maxRequestBytes, maxResponseBytes: 1024, signal: cleanup.signal });
        } catch { /* No automatic replay, reconnect, or cleanup credential fallback. */ }
        finally { clearTimeout(cleanupTimer); }
      }
      this.active = false;
    }
  }

  private pruneResources(): void {
    const now = this.options.now?.() ?? Date.now();
    for (const [key, value] of this.resources) if (value.expiresAt <= now) this.resources.delete(key);
  }

  private project(value: unknown, profile: McpProfile, digest: string, reading = false): McpResult {
    extensionJson(value, maxResponseBytes);
    const result = object(value);
    if (!Array.isArray(result.content) || result.content.length > 64 || (result.isError !== undefined && typeof result.isError !== 'boolean')) throw new ExtensionError('INVALID_EXTENSION');
    this.pruneResources();
    const pending = new Map<string, ResourceRecord>();
    const content: McpResult['content'] = [];
    for (const raw of result.content) {
      const item = object(raw);
      if (item.type === 'text' && typeof item.text === 'string') content.push({ type: 'text', text: item.text });
      else if (item.type === 'resource' || item.type === 'resource_link') {
        const resource = item.type === 'resource' ? object(item.resource) : item;
        if (typeof resource.uri !== 'string' || !resource.uri || resource.uri.length > 2048) throw new ExtensionError('INVALID_EXTENSION');
        if (reading && typeof resource.text === 'string') { content.push({ type: 'text', text: resource.text }); continue; }
        const reference = `mcp_${randomBytes(24).toString('hex')}`;
        pending.set(reference, { profileId: profile.id, profileDigest: extensionDigest(profile), discoveryDigest: digest,
          scope: { ...profile.scope }, ...(item.type === 'resource_link' ? { uri: resource.uri } : { embedded: item }),
          expiresAt: (this.options.now?.() ?? Date.now()) + 15 * 60_000 });
        content.push({ type: 'resource', reference });
      } else throw new ExtensionError('INVALID_EXTENSION');
    }
    if (this.resources.size + pending.size > 64
      || Buffer.byteLength(extensionJson([...this.resources.values(), ...pending.values()])) > maxResponseBytes) throw new ExtensionError('EXTENSION_LIMIT');
    for (const [key, record] of pending) this.resources.set(key, record);
    return { isError: result.isError === true, content };
  }
}
