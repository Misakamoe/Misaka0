import { AiProtocolError, boundedJson } from './transport.js';
import type { GenerationOptions, GenerationRequest, GenerationResult, PreparedContent, ProtocolContext } from './providers.js';
import { OutputCollector, argumentsObject, index, object, parseJson, string, token } from './protocol-common.js';
import { enforceInputBudget } from './protocol-budget.js';

function content(part: PreparedContent, context: ProtocolContext): Record<string, unknown> {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const reference = context.media.get(part);
  if (!reference) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  return reference;
}
export async function generate(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  const output = new OutputCollector(context, options, new Set(request.tools?.map(tool => tool.name)));
  const records: Record<string, unknown>[] = [...request.continuation?.records ?? []];
  if (request.toolResults?.length) records.push({ role: 'user', content: request.toolResults.map(result => ({ type: 'tool_result', tool_use_id: result.id, content: JSON.stringify(result.result) })) });
  records.push(...request.messages.map(message => ({ role: message.role, content: message.content.map(part => content(part, context)) })));
  // Current Claude models prohibit assistant prefills; never fabricate a partial reasoning prefix.
  if (!records.length || records.at(-1)?.role !== 'user') throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const blocks = new Map<number, { value: Record<string, unknown>; args: string; bytes: number; stopped: boolean }>();
  let started = false; let completed = false; let finish = ''; let tools = 0;
  let inputTokens: number | undefined; let cacheRead = 0; let cacheWrite = 0;
  const usageUpdate = (usage: Record<string, unknown>) => {
    if (usage.input_tokens !== undefined) inputTokens = token(usage.input_tokens);
    if (usage.cache_read_input_tokens !== undefined) cacheRead = token(usage.cache_read_input_tokens)!;
    if (usage.cache_creation_input_tokens !== undefined) cacheWrite = token(usage.cache_creation_input_tokens)!;
    if (inputTokens !== undefined) output.usage.inputTokens = inputTokens + cacheRead + cacheWrite;
    if (usage.output_tokens !== undefined) output.usage.outputTokens = token(usage.output_tokens);
    if (cacheRead) output.usage.cachedInputTokens = cacheRead;
  };
  const body = { model: context.profile.model, messages: records, ...(request.system ? { system: request.system } : {}),
    tools: (request.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema })),
    max_tokens: request.maxOutputTokens ?? 4096, stream: true };
  await enforceInputBudget(context, request, body, options);
  options.signal.throwIfAborted(); context.inferenceStarted = true;
  await context.transport.post({ origin: context.profile.origin, path: `${context.profile.basePath}/messages`, headers: {
    'x-api-key': context.profile.apiKey, 'anthropic-version': context.profile.anthropicVersion ?? '2026-10-21',
  }, body }, {
    signal: options.signal, limits: context.limits, onEvent: async event => {
      if (completed) throw new AiProtocolError('INVALID_RESPONSE');
      const data = object(parseJson(event.data)); const type = string(data.type);
      if (event.event !== 'message' && event.event !== type) throw new AiProtocolError('INVALID_RESPONSE');
      if (type === 'ping') return;
      if (type === 'error') throw new AiProtocolError('NETWORK');
      if (type === 'message_start') {
        if (started) throw new AiProtocolError('INVALID_RESPONSE');
        const message = object(data.message);
        if (message.model !== undefined && message.model !== context.profile.model) throw new AiProtocolError('CONTINUATION_MISMATCH');
        const usage = message.usage === undefined ? {} : object(message.usage);
        usageUpdate(usage);
        started = true; return;
      }
      if (!started) throw new AiProtocolError('INVALID_RESPONSE');
      if (type === 'content_block_start') {
        const key = index(data.index); const value = object(data.content_block);
        if (blocks.has(key) || blocks.size >= context.limits.toolCalls + 32) throw new AiProtocolError('TOO_LARGE');
        if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(string(value.type))) throw new AiProtocolError('UNSUPPORTED');
        if (value.type === 'tool_use' && value.caller && object(value.caller).type !== 'direct') throw new AiProtocolError('UNSUPPORTED');
        if (value.type === 'tool_use' && ++tools > context.limits.toolCalls) throw new AiProtocolError('TOO_LARGE');
        if (value.type === 'text') await output.append(value.text);
        blocks.set(key, { value: { ...value }, args: '', bytes: Buffer.byteLength(boundedJson(value, context.limits.continuationBytes)), stopped: false }); return;
      }
      if (type === 'content_block_delta') {
        const block = blocks.get(index(data.index)); const delta = object(data.delta);
        if (!block || block.stopped) throw new AiProtocolError('INVALID_RESPONSE');
        const field = delta.type === 'text_delta' && block.value.type === 'text' ? 'text'
          : delta.type === 'thinking_delta' && block.value.type === 'thinking' ? 'thinking'
            : delta.type === 'signature_delta' && block.value.type === 'thinking' ? 'signature' : undefined;
        if (field) {
          const text = string(delta[field]); block.bytes += Buffer.byteLength(text);
          if (block.bytes > context.limits.continuationBytes) throw new AiProtocolError('TOO_LARGE');
          block.value[field] = string(block.value[field] ?? '') + text;
          if (field === 'text') await output.append(text);
        } else if (delta.type === 'input_json_delta' && block.value.type === 'tool_use') {
          const text = string(delta.partial_json); block.bytes += Buffer.byteLength(text);
          if (block.bytes > context.limits.toolArgumentsBytes) throw new AiProtocolError('TOO_LARGE');
          block.args += text;
        } else throw new AiProtocolError('UNSUPPORTED');
        return;
      }
      if (type === 'content_block_stop') {
        const block = blocks.get(index(data.index));
        if (!block || block.stopped) throw new AiProtocolError('INVALID_RESPONSE');
        if (block.value.type === 'tool_use') {
          block.value.input = argumentsObject(block.args || block.value.input, context);
          output.call(block.value.id, block.value.name, block.value.input);
        }
        if (block.value.type === 'thinking' && !string(block.value.signature)) throw new AiProtocolError('INCOMPLETE');
        block.stopped = true; return;
      }
      if (type === 'message_delta') {
        const delta = object(data.delta); const usage = data.usage === undefined ? {} : object(data.usage);
        if (delta.stop_reason !== undefined && delta.stop_reason !== null) finish = string(delta.stop_reason);
        // message_delta usage is cumulative, not incremental.
        usageUpdate(usage);
        return;
      }
      if (type === 'message_stop') {
        if ([...blocks.values()].some(block => !block.stopped) || !finish || finish === 'max_tokens') throw new AiProtocolError('INCOMPLETE');
        if (!['end_turn', 'tool_use', 'stop_sequence'].includes(finish)) throw new AiProtocolError('UNSUPPORTED');
        if (Boolean(output.calls.length) !== (finish === 'tool_use')) throw new AiProtocolError('INVALID_RESPONSE');
        if (output.usage.inputTokens !== undefined && output.usage.outputTokens !== undefined) output.usage.totalTokens = output.usage.inputTokens + output.usage.outputTokens;
        completed = true; output.usage.billable = true; return;
      }
      throw new AiProtocolError('UNSUPPORTED');
    },
  });
  if (!completed) throw new AiProtocolError('INCOMPLETE');
  return output.finish([...records, { role: 'assistant', content: [...blocks].sort(([left], [right]) => left - right).map(([, block]) => block.value) }]);
}
