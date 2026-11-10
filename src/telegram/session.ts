import type { Context } from 'grammy';
import { AppError } from '../errors.js';

/** Ordinary reply threads are not forum topics and must not change a session's scope. */
export function messageTopicId(message: { is_topic_message?: boolean; message_thread_id?: number }): number | undefined {
  return message.is_topic_message ? message.message_thread_id : undefined;
}

/** Only supported human messages have session state or a serialization key. */
export function sessionKey(ctx: Context): string | undefined {
  const message = ctx.update.message ?? ctx.update.callback_query?.message;
  const actor = ctx.update.callback_query?.from ?? ctx.update.message?.from;
  if (!message || message.date === 0 || !actor || actor.is_bot || !Number.isSafeInteger(actor.id) || actor.id <= 0 || message.sender_chat
    || message.business_connection_id || message.sender_business_bot || message.guest_query_id || message.is_automatic_forward
    || !['private', 'group', 'supergroup'].includes(message.chat.type)) return undefined;
  return `${ctx.me.id}:${message.chat.id}:${actor.id}:${messageTopicId(message) ?? 0}`;
}

export type SubconvInputField = 'source' | 'backend' | 'remoteConfig' | 'include' | 'exclude' | 'filename' | 'customParams';

export interface SessionData {
  aliasInput?: { panelId: string; messageId: number; command: string; revision: number };
  rssInput?: { panelId: string; messageId: number };
  weatherInput?: { panelId: string; messageId: number; mode: 'current' | 'forecast'; days: number };
  subconvInput?: { panelId: string; messageId: number; promptMessageId: number; field: SubconvInputField; revision: number; generation: number };
}

export class SessionStore {
  private readonly entries = new Map<string, { expiresAt: number; data: SessionData }>();
  private closed = false;

  constructor(
    readonly ttlMs = 10 * 60_000,
    readonly capacity = 1_000,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(capacity) || capacity < 1) {
      throw new AppError('INVALID_INPUT');
    }
  }

  private prune(): void {
    const now = this.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.entries.delete(key);
  }

  get size(): number { this.prune(); return this.entries.size; }

  get(key: string | undefined): SessionData | undefined {
    this.prune();
    if (!key || this.closed) return undefined;
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    return structuredClone(entry.data);
  }

  set(key: string | undefined, data: SessionData): void {
    this.prune();
    if (!key || this.closed) throw new AppError('CANCELLED');
    this.entries.delete(key);
    while (this.entries.size >= this.capacity) this.entries.delete(this.entries.keys().next().value!);
    this.entries.set(key, { data: structuredClone(data), expiresAt: this.now() + this.ttlMs });
  }

  delete(key: string | undefined): boolean { return key ? this.entries.delete(key) : false; }
  stop(): void { this.closed = true; this.entries.clear(); }
}
