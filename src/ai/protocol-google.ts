import { randomUUID } from 'node:crypto';
import { AiProtocolError } from './transport.js';
import type { GenerationOptions, GenerationRequest, GenerationResult, ProtocolContext } from './providers.js';
import { OutputCollector, list, object, parseJson, string, token } from './protocol-common.js';
import { enforceInputBudget } from './protocol-budget.js';

export async function generate(context: ProtocolContext, request: GenerationRequest, options: GenerationOptions): Promise<GenerationResult> {
  const output = new OutputCollector(context, options, new Set(request.tools?.map(tool => tool.name)));
  const records: Record<string, unknown>[] = [...request.continuation?.records ?? []];
  const providerIds = new Set((Array.isArray(records.at(-1)?.parts) ? records.at(-1)!.parts as unknown[] : [])
    .map(part => object(part).functionCall).filter(call => call !== undefined).map(call => object(call).id).filter(id => typeof id === 'string'));
  if (request.toolResults?.length) records.push({ role: 'user', parts: request.toolResults.map(result => ({ functionResponse: {
    ...(providerIds.has(result.id) ? { id: result.id } : {}), name: result.name, response: { result: result.result },
  } })) });
  records.push(...request.messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.map(part => {
      if (part.type === 'text') return { text: part.text };
      const reference = context.media.get(part);
      if (!reference) throw new AiProtocolError('UNSUPPORTED', undefined, false);
      return reference;
    }) })));
  if (!records.length) throw new AiProtocolError('INVALID_INPUT', undefined, false);
  const parts: Record<string, unknown>[] = []; let completed = false;
  const modalities = context.profile.capabilities.output.filter(type => type !== 'file').map(type => type.toUpperCase());
  const body = { contents: records,
      ...(request.system ? { systemInstruction: { parts: [{ text: request.system }] } } : {}),
      ...(request.tools?.length ? { tools: [{ functionDeclarations: request.tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }] } : {}),
      ...(request.toolChoice ? { toolConfig: { functionCallingConfig: { mode: 'NONE' } } } : {}),
      generationConfig: { maxOutputTokens: request.maxOutputTokens ?? 4096, candidateCount: 1, responseModalities: modalities,
        ...(context.profile.audioVoice ? { speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: context.profile.audioVoice } } } } : {}) } };
  await enforceInputBudget(context, request, body, options);
  options.signal.throwIfAborted(); context.inferenceStarted = true;
  await context.transport.post({ origin: context.profile.origin, path: `${context.profile.basePath}/models/${encodeURIComponent(context.profile.model)}:streamGenerateContent?alt=sse`,
    headers: { 'x-goog-api-key': context.profile.apiKey }, body }, {
    signal: options.signal, limits: context.limits, onEvent: async event => {
      const data = object(parseJson(event.data));
      if (data.error) throw new AiProtocolError('NETWORK');
      if (data.promptFeedback && object(data.promptFeedback).blockReason) throw new AiProtocolError('UNSUPPORTED');
      if (data.usageMetadata) {
        const usage = object(data.usageMetadata);
        const visible = token(usage.candidatesTokenCount); const thinking = token(usage.thoughtsTokenCount);
        output.usage = { inputTokens: token(usage.promptTokenCount), outputTokens: visible === undefined ? undefined : visible + (thinking ?? 0),
          totalTokens: token(usage.totalTokenCount), cachedInputTokens: token(usage.cachedContentTokenCount), billable: true };
      }
      const candidates = data.candidates === undefined ? [] : list(data.candidates);
      if (candidates.length > 1) throw new AiProtocolError('UNSUPPORTED');
      if (!candidates.length) return;
      if (completed) throw new AiProtocolError('INVALID_RESPONSE');
      const candidate = object(candidates[0]);
      if (candidate.index !== undefined && candidate.index !== 0) throw new AiProtocolError('UNSUPPORTED');
      if (candidate.content) {
        for (const value of list(object(candidate.content).parts)) {
          const part = object(value);
          if (Object.keys(part).some(key => !['text', 'thought', 'thoughtSignature', 'functionCall', 'inlineData'].includes(key))) throw new AiProtocolError('UNSUPPORTED');
          if (['text', 'functionCall', 'inlineData'].filter(key => part[key] !== undefined).length > 1) throw new AiProtocolError('UNSUPPORTED');
          if (part.functionCall) {
            const call = object(part.functionCall);
            if (Object.keys(call).some(key => !['id', 'name', 'args'].includes(key))) throw new AiProtocolError('UNSUPPORTED');
            // Older Gemini responses omit IDs. A local ID is only correlation, never a fabricated provider ID.
            output.call(call.id ?? `local-google-${randomUUID()}`, call.name, call.args);
          } else if (part.inlineData) {
            const inline = object(part.inlineData); output.artifact(inline.mimeType, inline.data);
          } else if (part.text !== undefined) {
            if (part.thought !== true) await output.append(part.text);
          } else if (!part.thoughtSignature) throw new AiProtocolError('UNSUPPORTED');
          if (parts.length >= 1024) throw new AiProtocolError('TOO_LARGE');
          // Never detach the thought signature from its native part or merge signed parts.
          parts.push(part);
        }
      }
      if (candidate.finishReason !== undefined) {
        const finish = string(candidate.finishReason);
        if (finish !== 'STOP') throw new AiProtocolError(finish === 'MAX_TOKENS' ? 'OUTPUT_LIMIT' : 'UNSUPPORTED');
        completed = true;
      }
    },
  });
  if (!completed) throw new AiProtocolError('INCOMPLETE');
  output.usage.billable = true;
  return output.finish([...records, { role: 'model', parts }]);
}
