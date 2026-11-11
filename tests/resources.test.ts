import { describe, expect, it } from 'vitest';
import { defaultResourcePolicy, ResourcePolicy } from '../src/resources.js';

describe('shared resource admission', () => {
  it('reserves one slot per lane and leaves the control/agent lane independent of heavy work', () => {
    const policy = new ResourcePolicy({ heavyBytes: 1024 });
    const heavy = policy.tryAcquire('heavy', 1024)!;
    expect(policy.tryAcquire('heavy')).toBeUndefined();
    const agent = policy.tryAcquire('agent')!;
    expect(policy.tryAcquire('agent')).toBeUndefined();
    heavy.release();
    const replacement = policy.tryAcquire('heavy')!;
    heavy.release();
    expect(policy.tryAcquire('heavy')).toBeUndefined();
    replacement.release(); agent.release();
    expect(policy.tryAcquire('agent')).toBeDefined();
  });

  it('rejects estimated residency before admitting work without consuming the slot', () => {
    const policy = new ResourcePolicy({ heavyBytes: 1024 });
    expect(policy.tryAcquire('heavy', 1025)).toBeUndefined();
    expect(policy.tryAcquire('heavy', 1024)).toBeDefined();
    expect(defaultResourcePolicy.heavyBytes).toBe(32 * 1024 * 1024);
  });

  it.each([-1, NaN, Infinity, 0.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid byte estimates %s', bytes => {
    const policy = new ResourcePolicy();
    expect(() => policy.tryAcquire('heavy', bytes)).toThrow('INVALID_INPUT');
    expect(() => new ResourcePolicy({ heavyBytes: bytes })).toThrow('INVALID_INPUT');
    expect(policy.tryAcquire('heavy')).toBeDefined();
  });
});
