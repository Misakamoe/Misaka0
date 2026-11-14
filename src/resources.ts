import { AppError } from './errors.js';

export type ResourceKind = 'agent' | 'heavy';
export interface ResourceLease { release(): void }

// Serialize expensive work to keep peaks low. Byte estimates are not RSS caps;
// only an explicitly supplied deployment/test budget restricts admission.
export class ResourcePolicy {
  private readonly active = new Set<ResourceKind>();
  readonly heavyBytes: number | undefined;

  constructor(options: { heavyBytes?: number } = {}) {
    this.heavyBytes = options.heavyBytes;
    if (this.heavyBytes !== undefined && (!Number.isSafeInteger(this.heavyBytes) || this.heavyBytes < 0)) throw new AppError('INVALID_INPUT');
  }

  tryAcquire(kind: ResourceKind, bytes = 0): ResourceLease | undefined {
    if (!['agent', 'heavy'].includes(kind) || !Number.isSafeInteger(bytes) || bytes < 0) throw new AppError('INVALID_INPUT');
    if (this.active.has(kind) || kind === 'heavy' && this.heavyBytes !== undefined && bytes > this.heavyBytes) return undefined;
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
