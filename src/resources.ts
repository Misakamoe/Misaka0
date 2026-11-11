import { AppError } from './errors.js';

export type ResourceKind = 'agent' | 'heavy';
export interface ResourceLease { release(): void }

// Admission estimates include input, output and peak native/child residency, not just JS heap.
export class ResourcePolicy {
  private readonly active = new Set<ResourceKind>();
  readonly heavyBytes: number;

  constructor(options: { heavyBytes?: number } = {}) {
    this.heavyBytes = options.heavyBytes ?? 32 * 1024 * 1024;
    if (!Number.isSafeInteger(this.heavyBytes) || this.heavyBytes < 0) throw new AppError('INVALID_INPUT');
  }

  tryAcquire(kind: ResourceKind, bytes = 0): ResourceLease | undefined {
    if (!['agent', 'heavy'].includes(kind) || !Number.isSafeInteger(bytes) || bytes < 0) throw new AppError('INVALID_INPUT');
    if (this.active.has(kind) || kind === 'heavy' && bytes > this.heavyBytes) return undefined;
    this.active.add(kind);
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.active.delete(kind);
    } };
  }
}

export const defaultResourcePolicy = new ResourcePolicy();
