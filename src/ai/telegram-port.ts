import type { Confirmation, Locale } from '../../shared/schemas/index.js';
import type { InvocationContext } from '../actions.js';
import type { AiJsonValue } from '../../shared/schemas/ai.js';

export interface AiDeliveryTarget {
  runId: string;
  conversationId: string;
  actorId: number;
  botId: number;
  chat: InvocationContext['chat'];
  language: Locale;
}

export interface AiCapturedFile {
  fileId: string;
  uniqueId: string;
  kind: 'image' | 'audio' | 'document' | 'sticker';
  mimeType: string;
  name: string;
  size: number;
}

export type AiOutputFile = {
  name: string;
  mimeType: string;
  /** Only trusted delivery code chooses this; private exports are always protected. */
  protectContent?: boolean;
} & ({ bytes: Uint8Array; path?: never } | { path: string; bytes?: never });

export interface AiDelivery {
  started(target: AiDeliveryTarget, signal: AbortSignal): Promise<void>;
  progress(target: AiDeliveryTarget, text: string, signal: AbortSignal): Promise<void>;
  approval(target: AiDeliveryTarget, confirmation: Confirmation, tool: string, signal: AbortSignal, input?: AiJsonValue): Promise<void>;
  completed(target: AiDeliveryTarget, text: string, signal: AbortSignal): Promise<number | undefined>;
  failed(target: AiDeliveryTarget, code: string, signal: AbortSignal, partialText?: string): Promise<void>;
  retire(target: AiDeliveryTarget): Promise<void>;
  file(target: AiDeliveryTarget, file: AiOutputFile, signal: AbortSignal): Promise<void>;
}

// Only the trusted Telegram adapter supplies file provenance or delivery methods.
export interface AiTelegramPort {
  available(context: InvocationContext): boolean;
  capture(context: InvocationContext, file: AiCapturedFile): Promise<string>;
  isReply(context: InvocationContext, messageId: number): boolean;
  attachTelegram(delivery: AiDelivery, download: (file: AiCapturedFile, signal: AbortSignal) => Promise<Uint8Array>): void;
}
