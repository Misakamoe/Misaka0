import { AiProtocolError } from './transport.js';
import type { GenerationOptions, GenerationRequest, GenerationResult, PreparedContent, ProtocolContext } from './providers.js';
import { OutputCollector, index, list, object, parseJson, string, token } from './protocol-common.js';
import { enforceInputBudget } from './protocol-budget.js';

function content(part: PreparedContent, assistant: boolean, chat: boolean, context: ProtocolContext): Record<string, unknown> {
  if (part.type === 'text') return { type: chat ? 'text' : assistant ? 'output_text' : 'input_text', text: part.text };
  if (assistant || chat) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  const reference = context.media.get(part);
  if (!reference) throw new AiProtocolError('UNSUPPORTED', undefined, false);
  return reference;
}
export async function generate(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  const chat = context.profile.protocol === 'openai-chat-completions';
  const output = new OutputCollector(context, options, new Set(request.tools?.map(tool => tool.name)));
  const records: Record<string, unknown>[] = [...request.continuation?.records ?? []];
  if (chat && !request.continuation && request.system) records.push({ role: 'system', content: request.system });
  for (const result of request.toolResults ?? []) records.push(chat ? { role: 'tool', tool_call_id: result.id, content: JSON.stringify(result.result) }
    : { type: 'function_call_output', call_id: result.id, output: JSON.stringify(result.result) });
  records.push(...request.messages.map(message => ({ role: message.role, content: chat && message.content.every(part => part.type === 'text')
    ? message.content.map(part => (part as { text: string }).text).join('\n') : message.content.map(part => content(part, message.role === 'assistant', chat, context)) })));
  if (!records.length) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  const tools: Record<string, unknown>[] = (request.tools ?? []).map(tool => chat
    ? { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }
    : { type: 'function', name: tool.name, description: tool.description, parameters: tool.inputSchema, strict: false });
  if (context.profile.imageGeneration) tools.push({ type: 'image_generation', model: context.profile.imageGeneration.model, output_format: context.profile.imageGeneration.outputFormat });
  if (chat) return generateChat(context, request, options, output, records, tools);
  let completed = false; let final: Record<string, unknown>[] = [];
  const argumentSizes = new Map<number, number>(); const started = new Set<number>();
  const body = { model: context.profile.model, input: records, ...(request.system ? { instructions: request.system } : {}), tools,
    stream: true, store: false, include: ['reasoning.encrypted_content'], truncation: 'disabled', max_output_tokens: request.maxOutputTokens ?? 4096 };
  await enforceInputBudget(context, request, body, options);
  options.signal.throwIfAborted(); context.inferenceStarted = true;
  await context.transport.post({ origin: context.profile.origin, path: `${context.profile.basePath}/responses`, headers: { authorization: `Bearer ${context.profile.apiKey}` },
    body }, {
    signal: options.signal, limits: context.limits, onEvent: async event => {
      if (completed) throw new AiProtocolError('INVALID_RESPONSE');
      const data = object(parseJson(event.data)); const type = string(data.type);
      if (type === 'error' || type === 'response.failed') throw new AiProtocolError('NETWORK');
      if (type === 'response.incomplete') throw new AiProtocolError('INCOMPLETE');
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta') { await output.append(data.delta); return; }
      if (type === 'response.function_call_arguments.delta') {
        const key = index(data.output_index); const size = (argumentSizes.get(key) ?? 0) + Buffer.byteLength(string(data.delta));
        if (size > context.limits.toolArgumentsBytes || !started.has(key)) throw new AiProtocolError('TOO_LARGE');
        argumentSizes.set(key, size); return;
      }
      if (type === 'response.output_item.added') {
        const key = index(data.output_index); const item = object(data.item);
        if (started.has(key) || started.size >= context.limits.toolCalls + 32) throw new AiProtocolError('TOO_LARGE');
        started.add(key);
        if (item.type === 'function_call') {
          argumentSizes.set(key, 0);
          if (argumentSizes.size > context.limits.toolCalls) throw new AiProtocolError('TOO_LARGE');
        } else if (!['message', 'reasoning', 'image_generation_call'].includes(string(item.type))) throw new AiProtocolError('UNSUPPORTED');
        return;
      }
      if (type === 'response.completed') {
        const response = object(data.response);
        if (response.status !== 'completed') throw new AiProtocolError('INCOMPLETE');
        if (response.model !== undefined && response.model !== context.profile.model) throw new AiProtocolError('CONTINUATION_MISMATCH');
        final = list(response.output).map(object);
        if (final.length > context.limits.toolCalls + 32) throw new AiProtocolError('TOO_LARGE');
        let finalText = '';
        for (const item of final) {
          if (item.type === 'function_call') {
            if (item.async === true || item.namespace !== undefined || item.caller && object(item.caller).type !== 'direct') throw new AiProtocolError('UNSUPPORTED');
            output.call(item.call_id, item.name, item.arguments);
          }
          else if (item.type === 'message') {
            for (const block of list(item.content).map(object)) {
              if (block.type === 'output_text') finalText += string(block.text);
              else if (block.type === 'refusal') finalText += string(block.refusal);
              else throw new AiProtocolError('UNSUPPORTED');
            }
          } else if (item.type === 'image_generation_call') {
            if (!context.profile.imageGeneration || item.status !== 'completed') throw new AiProtocolError('UNSUPPORTED');
            output.artifact(`image/${context.profile.imageGeneration.outputFormat}`, item.result);
          } else if (item.type !== 'reasoning') throw new AiProtocolError('UNSUPPORTED');
        }
        if (!output.text) await output.append(finalText);
        else if (output.text !== finalText) throw new AiProtocolError('INVALID_RESPONSE');
        const usage = response.usage === undefined ? {} : object(response.usage);
        output.usage = { inputTokens: token(usage.input_tokens), outputTokens: token(usage.output_tokens), totalTokens: token(usage.total_tokens),
          ...(usage.input_tokens_details ? { cachedInputTokens: token(object(usage.input_tokens_details).cached_tokens) } : {}), billable: true };
        completed = true; return;
      }
      // These events are represented losslessly by the terminal native output records.
      if (['response.created', 'response.in_progress', 'response.output_item.done', 'response.content_part.added', 'response.content_part.done',
        'response.output_text.done', 'response.output_text.annotation.added', 'response.refusal.done', 'response.function_call_arguments.done'].includes(type)
        || /^response\.reasoning(?:_summary)?[._]/.test(type)
        || context.profile.imageGeneration && /^response\.image_generation_call\.(?:in_progress|generating|completed)$/.test(type)) return;
      throw new AiProtocolError('UNSUPPORTED');
    },
  });
  if (!completed) throw new AiProtocolError('INCOMPLETE');
  return output.finish([...records, ...final]);
}

async function generateChat(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions, output: OutputCollector,
  records: Record<string, unknown>[], tools: Record<string, unknown>[]): Promise<GenerationResult> {
  let done = false; let finish = ''; let reasoning = ''; let reasoningBytes = 0;
  const calls = new Map<number, { id: string; name: string; arguments: string; bytes: number }>();
  const body = { model: context.profile.model, messages: records, tools, stream: true, stream_options: { include_usage: true }, [context.profile.chatTokenLimit ?? 'max_tokens']: request.maxOutputTokens ?? 4096 };
  await enforceInputBudget(context, request, body, options);
  options.signal.throwIfAborted(); context.inferenceStarted = true;
  await context.transport.post({ origin: context.profile.origin, path: `${context.profile.basePath}/chat/completions`, headers: { authorization: `Bearer ${context.profile.apiKey}` },
    body }, {
    signal: options.signal, limits: context.limits, onEvent: async event => {
      if (done) throw new AiProtocolError('INVALID_RESPONSE');
      if (event.data === '[DONE]') { done = true; return; }
      const data = object(parseJson(event.data));
      if (data.error) throw new AiProtocolError('NETWORK');
      if (data.usage) {
        const usage = object(data.usage);
        output.usage = { inputTokens: token(usage.prompt_tokens), outputTokens: token(usage.completion_tokens), totalTokens: token(usage.total_tokens), billable: true };
      }
      const choices = list(data.choices);
      if (choices.length > 1) throw new AiProtocolError('UNSUPPORTED');
      if (!choices.length) return;
      const choice = object(choices[0]);
      if (choice.index !== 0 || finish) throw new AiProtocolError('INVALID_RESPONSE');
      const delta = object(choice.delta);
      if (Object.keys(delta).some(key => !['role', 'content', 'tool_calls', 'reasoning_content', 'refusal'].includes(key))) throw new AiProtocolError('UNSUPPORTED');
      if (delta.role !== undefined && delta.role !== 'assistant') throw new AiProtocolError('INVALID_RESPONSE');
      if (delta.content !== undefined && delta.content !== null) await output.append(delta.content);
      if (delta.refusal !== undefined && delta.refusal !== null) await output.append(delta.refusal);
      if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) {
        const text = string(delta.reasoning_content); reasoningBytes += Buffer.byteLength(text);
        if (reasoningBytes > context.limits.continuationBytes) throw new AiProtocolError('TOO_LARGE');
        reasoning += text;
      }
      for (const value of delta.tool_calls === undefined ? [] : list(delta.tool_calls)) {
        const item = object(value); const key = index(item.index);
        let call = calls.get(key);
        if (!call) {
          if (calls.size >= context.limits.toolCalls) throw new AiProtocolError('TOO_LARGE');
          call = { id: '', name: '', arguments: '', bytes: 0 }; calls.set(key, call);
        }
        if (item.type !== undefined && item.type !== 'function') throw new AiProtocolError('UNSUPPORTED');
        if (item.id !== undefined) call.id += string(item.id);
        const fn = item.function === undefined ? {} : object(item.function);
        if (Object.keys(fn).some(key => !['name', 'arguments'].includes(key))) throw new AiProtocolError('UNSUPPORTED');
        if (fn.name !== undefined) call.name += string(fn.name);
        if (fn.arguments !== undefined) { const text = string(fn.arguments); call.bytes += Buffer.byteLength(text); call.arguments += text; }
        if (call.id.length > 256 || call.name.length > 64 || call.bytes > context.limits.toolArgumentsBytes) throw new AiProtocolError('TOO_LARGE');
      }
      if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
        finish = string(choice.finish_reason);
        if (!['stop', 'tool_calls'].includes(finish)) throw new AiProtocolError(finish === 'length' ? 'INCOMPLETE' : 'UNSUPPORTED');
      }
    },
  });
  if (!done || !finish) throw new AiProtocolError('INCOMPLETE');
  if (Boolean(calls.size) !== (finish === 'tool_calls')) throw new AiProtocolError('INVALID_RESPONSE');
  for (const [, call] of [...calls].sort(([left], [right]) => left - right)) output.call(call.id, call.name, call.arguments);
  const message = { role: 'assistant', content: output.text || null,
    ...(reasoning ? { reasoning_content: reasoning } : {}),
    ...(calls.size ? { tool_calls: [...calls].sort(([left], [right]) => left - right).map(([, call]) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) } : {}) };
  return output.finish([...records, message]);
}
