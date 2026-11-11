import type { AutomationDefinition, AutomationTrigger } from '../../shared/schemas/ai-automation.js';
import { AppError } from '../errors.js';

// Daily schedules skip missing DST wall times and use the first repeated wall time only.
export function nextAutomationTime(trigger: AutomationTrigger, after: number): number | null {
  if (trigger.kind === 'event') return null;
  if (trigger.kind === 'once') { const at = Date.parse(trigger.at); return at > after ? at : null; }
  if (trigger.kind === 'interval') {
    const start = Date.parse(trigger.startAt);
    const interval = trigger.minutes * 60_000;
    return start > after ? start : start + (Math.floor((after - start) / interval) + 1) * interval;
  }
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: trigger.timeZone, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const local = (at: number) => {
    const parts = Object.fromEntries(format.formatToParts(at).map(part => [part.type, part.value]));
    return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  };
  const previous = local(after);
  // Timezone offsets need not be whole hours; minute steps also handle half-hour DST.
  for (let at = Math.floor(after / 60_000) * 60_000 + 60_000, end = at + 72 * 60 * 60_000; at < end; at += 60_000) {
    const candidate = local(at);
    if (candidate.time !== trigger.time) continue;
    if (candidate.day === previous.day && previous.time >= trigger.time) continue;
    let repeated = false;
    for (let earlier = at - 4 * 60 * 60_000; earlier < at; earlier += 60_000) {
      const other = local(earlier);
      if (other.day === candidate.day && other.time === candidate.time) { repeated = true; break; }
    }
    if (repeated) continue;
    return at;
  }
  throw new AppError('INVALID_INPUT');
}

export function validateAutomation(definition: AutomationDefinition, now: number): number | null {
  const expires = Date.parse(definition.expiresAt);
  if (expires <= now || expires > now + 366 * 86_400_000 || new Set(definition.tools).size !== definition.tools.length) throw new AppError('INVALID_INPUT');
  const next = nextAutomationTime(definition.trigger, now);
  if (definition.trigger.kind !== 'event' && (next === null || next >= expires)) throw new AppError('INVALID_INPUT');
  return next;
}
