import { randomBytes } from 'node:crypto';
import type { Locale } from '../../shared/schemas/index.js';
import { AppError } from '../errors.js';

export type PanelCloseReason = 'expired' | 'used' | 'cancelled' | 'replaced';

export interface PanelBinding {
  key: string;
  botId: number;
  chatId: number;
  userId: number;
  threadId?: number;
  language: Locale;
}

export interface Panel<T> {
  readonly id: string;
  readonly binding: Readonly<PanelBinding>;
  value: T;
  readonly expiresAt: number | null;
  messageId?: number;
}

interface Entry<T> {
  panel: Panel<T>;
  messageId?: number;
  reason?: PanelCloseReason;
  cleanupQueued: boolean;
  tail: Promise<void>;
}

export class PanelStore<T> {
  private readonly entries = new Map<string, Entry<T>>();
  // Closed panels remain attachable only while their sender still holds the object.
  private readonly records = new WeakMap<Panel<T>, Entry<T>>();
  private readonly pending = new Set<Promise<void>>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly onClose: (panel: Panel<T>, reason: PanelCloseReason) => Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private timerDeadline?: number;
  private stopped = false;
  private stopTask?: Promise<void>;

  constructor(options: {
    ttlMs?: number;
    capacity?: number;
    now?: () => number;
    onClose: (panel: Panel<T>, reason: PanelCloseReason) => Promise<void>;
  }) {
    this.ttlMs = options.ttlMs ?? 10 * 60_000;
    this.capacity = options.capacity ?? 1_000;
    this.now = options.now ?? (() => Date.now());
    this.onClose = options.onClose;
    if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs < 1
      || !Number.isSafeInteger(this.capacity) || this.capacity < 1) throw new AppError('INVALID_INPUT');
  }

  get size(): number {
    this.expire();
    return this.entries.size;
  }

  create(binding: PanelBinding, value: T, expiresAt: number | null = this.now() + this.ttlMs): Panel<T> {
    if (this.stopped) throw new AppError('CONFIRMATION_EXPIRED');
    if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt < 0)) throw new AppError('INVALID_INPUT');
    const now = this.now();
    this.expire(now);
    if ((expiresAt === null || expiresAt > now) && this.entries.size >= this.capacity) {
      // Read-only views may be replaced under pressure; never evict a live form or approval.
      const oldest = [...this.entries.values()].find(entry => entry.panel.expiresAt === null);
      if (!oldest) throw new AppError('CAPACITY');
      this.invalidate(oldest, 'replaced');
    }
    let id: string;
    do { id = randomBytes(12).toString('hex'); } while (this.entries.has(id));
    const panel: Panel<T> = { id, binding: Object.freeze({ ...binding }), value, expiresAt };
    const entry: Entry<T> = { panel, cleanupQueued: false, tail: Promise.resolve() };
    this.records.set(panel, entry);
    if (expiresAt !== null && expiresAt <= now) entry.reason = 'expired';
    else this.entries.set(id, entry);
    this.schedule();
    return panel;
  }

  async attach(panel: Panel<T>, messageId: number): Promise<void> {
    const entry = this.record(panel);
    if (this.stopped) return;
    if (!Number.isSafeInteger(messageId) || messageId < 1) throw new AppError('INVALID_INPUT');
    if (entry.messageId !== undefined && entry.messageId !== messageId) throw new AppError('FORBIDDEN');
    this.expire();
    for (const other of this.entries.values()) {
      if (other !== entry && other.messageId === messageId
        && other.panel.binding.botId === panel.binding.botId
        && other.panel.binding.chatId === panel.binding.chatId) throw new AppError('FORBIDDEN');
    }
    entry.messageId = messageId;
    panel.messageId = messageId;
    if (entry.reason) await this.cleanup(entry);
  }

  get(id: string, binding: PanelBinding & { messageId: number }, allowOtherOwner?: (value: T) => boolean): Panel<T> {
    this.expire();
    const entry = this.entries.get(id);
    if (this.stopped || !entry) throw new AppError('CONFIRMATION_EXPIRED');
    const owner = entry.panel.binding;
    if (owner.botId !== binding.botId || owner.chatId !== binding.chatId || (owner.threadId ?? 0) !== (binding.threadId ?? 0)
      || entry.messageId === undefined || entry.messageId !== binding.messageId) throw new AppError('FORBIDDEN');
    if (owner.userId === binding.userId ? owner.key !== binding.key : !allowOtherOwner?.(entry.panel.value)) throw new AppError('FORBIDDEN');
    if (entry.panel.expiresAt === null) {
      this.entries.delete(id);
      this.entries.set(id, entry);
    }
    return entry.panel;
  }

  /** Queue UI edits only; do not await attach/close from inside the operation. */
  render(panel: Panel<T>, operation: () => Promise<void>): Promise<boolean> {
    const entry = this.record(panel);
    this.expire();
    if (this.stopped || entry.reason) return Promise.resolve(false);
    return this.enqueue(entry, async () => {
      this.expire();
      if (this.stopped || entry.reason) return false;
      await operation();
      return true;
    });
  }

  close(panel: Panel<T>, reason: PanelCloseReason): Promise<void> {
    const entry = this.record(panel);
    this.expire();
    if (!this.stopped) this.invalidate(entry, reason);
    this.schedule();
    return entry.tail;
  }

  closeOwned(key: string, reason: PanelCloseReason, predicate?: (panel: Panel<T>) => boolean): Promise<void> {
    this.expire();
    const tasks: Promise<void>[] = [];
    for (const entry of this.entries.values()) {
      if (entry.panel.binding.key === key && (!predicate || predicate(entry.panel))) {
        this.invalidate(entry, reason);
        tasks.push(entry.tail);
      }
    }
    this.schedule();
    return Promise.all(tasks).then(() => undefined);
  }

  hasMessage(botId: number, chatId: number, messageId: number): boolean {
    this.expire();
    for (const entry of this.entries.values()) {
      if (entry.panel.binding.botId === botId && entry.panel.binding.chatId === chatId
        && entry.messageId === messageId) return true;
    }
    return false;
  }

  stop(): Promise<void> {
    if (this.stopTask) return this.stopTask;
    this.stopped = true;
    this.entries.clear();
    this.schedule();
    this.stopTask = Promise.all([...this.pending]).then(() => undefined);
    return this.stopTask;
  }

  private record(panel: Panel<T>): Entry<T> {
    const entry = this.records.get(panel);
    if (!entry) throw new AppError('FORBIDDEN');
    return entry;
  }

  private enqueue<R>(entry: Entry<T>, operation: () => Promise<R>): Promise<R> {
    const task = entry.tail.then(operation);
    const settled = task.then(() => undefined, () => undefined);
    entry.tail = settled;
    this.pending.add(settled);
    void settled.then(() => { this.pending.delete(settled); });
    return task;
  }

  private cleanup(entry: Entry<T>): Promise<void> {
    if (!this.stopped && entry.reason && entry.messageId !== undefined && !entry.cleanupQueued) {
      entry.cleanupQueued = true;
      const reason = entry.reason;
      void this.enqueue(entry, async () => {
        if (this.stopped) return;
        try { await this.onClose(entry.panel, reason); } catch { /* The hook owns API error reporting. */ }
      });
    }
    return entry.tail;
  }

  private invalidate(entry: Entry<T>, reason: PanelCloseReason): void {
    if (entry.reason) return;
    entry.reason = reason;
    this.entries.delete(entry.panel.id);
    this.cleanup(entry);
  }

  private expire(now = this.now()): void {
    if (this.stopped) return;
    for (const entry of this.entries.values()) {
      if (entry.panel.expiresAt !== null && entry.panel.expiresAt <= now) this.invalidate(entry, 'expired');
    }
    this.schedule();
  }

  private schedule(): void {
    let deadline: number | undefined;
    if (!this.stopped) {
      for (const entry of this.entries.values()) {
        const expiresAt = entry.panel.expiresAt;
        if (expiresAt !== null && (deadline === undefined || expiresAt < deadline)) deadline = expiresAt;
      }
    }
    if (this.timer && this.timerDeadline === deadline) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.timerDeadline = deadline;
    if (deadline === undefined) return;
    // Node clamps larger delays to 1ms; recheck distant deadlines in bounded steps.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.expire();
    }, Math.min(2_147_483_647, Math.max(0, deadline - this.now())));
    this.timer.unref();
  }
}
