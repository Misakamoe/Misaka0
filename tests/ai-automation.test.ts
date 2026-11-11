import { describe, expect, it } from 'vitest';
import { automationDefinitionSchema } from '../shared/schemas/ai-automation.js';
import { nextAutomationTime, validateAutomation } from '../src/ai/automation.js';

const now = Date.parse('2026-11-11T00:00:00Z');
const definition = () => automationDefinitionSchema.parse({ title: 'Daily test', instruction: 'Summarize weather.',
  trigger: { kind: 'interval', startAt: '2026-11-11T00:05:00Z', minutes: 5, timeZone: 'Asia/Tokyo' },
  tools: ['weather.query'], expiresAt: '2026-11-12T00:00:00Z', maxRuns: 10, maxInputTokens: 1000, maxOutputTokens: 200, maxCostMicros: 1000 });

describe('declarative automation scheduling', () => {
  it('requires strict explicit scope, timezone, expiry, and budgets', () => {
    const value = definition();
    expect(validateAutomation(value, now)).toBe(now + 300_000);
    expect(automationDefinitionSchema.safeParse({ ...value, actorId: 2 }).success).toBe(false);
    expect(automationDefinitionSchema.safeParse({ ...value, trigger: { ...value.trigger, timeZone: 'made/up' } }).success).toBe(false);
    expect(() => validateAutomation({ ...value, tools: ['weather.query', 'weather.query'] }, now)).toThrow('INVALID_INPUT');
    expect(() => validateAutomation({ ...value, expiresAt: '2026-11-10T23:59:00Z' }, now)).toThrow('INVALID_INPUT');
  });

  it('skips missed absolute intervals rather than burst-replaying them', () => {
    expect(nextAutomationTime(definition().trigger, now + 19 * 60_000)).toBe(now + 20 * 60_000);
    expect(nextAutomationTime({ kind: 'once', at: '2026-11-10T00:00:00Z', timeZone: 'UTC' }, now)).toBeNull();
    expect(nextAutomationTime({ kind: 'event', event: 'rss.delivered', cooldownMinutes: 5, timeZone: 'UTC' }, now)).toBeNull();
  });

  it('skips missing daily DST wall times without moving the requested clock time', () => {
    const result = nextAutomationTime({ kind: 'daily', time: '02:30', timeZone: 'America/New_York' }, Date.parse('2026-03-08T05:00:00Z'));
    expect(new Date(result!).toISOString()).toBe('2026-03-09T06:30:00.000Z');
  });

  it('uses only the first repeated daily wall time, even after a restart inside the repeated hour', () => {
    const trigger = { kind: 'daily' as const, time: '01:30', timeZone: 'America/New_York' };
    expect(new Date(nextAutomationTime(trigger, Date.parse('2026-11-01T04:00:00Z'))!).toISOString()).toBe('2026-11-01T05:30:00.000Z');
    expect(new Date(nextAutomationTime(trigger, Date.parse('2026-11-01T06:10:00Z'))!).toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });

});
