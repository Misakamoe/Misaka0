import type { InputRichMessage, RichText } from 'grammy/types';
import type { Locale, RuntimeStatus } from '../../shared/schemas/index.js';
import { translator } from '../i18n.js';
import { plainValue } from './effects.js';
import { panelContent } from './rich.js';

export function statusMessage(status: RuntimeStatus, language: Locale): InputRichMessage {
  const t = translator(language);
  const r = (key: string, parameters?: Record<string, unknown>) => t(`common:resources.${key}`, parameters);
  const core = t('bot:stats', {
    uptime: Math.floor(status.uptimeSeconds), updates: status.updateCount, groups: status.authorizedGroupCount,
    polling: t(`common:states.${status.polling}`), http: t(`common:states.${status.http}`),
    apiError: status.lastApiError ? plainValue(status.lastApiError.code, 64) : t('bot:noError'),
  });
  const blocks: InputRichMessage['blocks'] = [...panelContent(core).blocks];
  const section = (title: string, rows: string[], note?: string) => {
    const text: RichText = [{ type: 'bold', text: title }, '\n' + rows.join('\n'), ...(note ? ['\n', { type: 'italic' as const, text: note }] : [])];
    blocks.push({ type: 'paragraph', text });
  };
  const snapshot = status.resources;
  if (!snapshot) {
    section(r('title'), [r('unavailable')]);
    return { blocks, skip_entity_detection: true };
  }
  const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
  const numeric = (value: number | null) => value === null ? r('unavailable') : number.format(value);
  const bytes = (value: number | null): string => {
    if (value === null) return r('unavailable');
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const exponent = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${number.format(value / 1024 ** exponent)} ${units[exponent]}`;
  };
  const cpu = (value: number | null, interval = snapshot.intervalSeconds) => value === null ? r(interval === null ? 'warmup' : 'unavailable') : percent.format(value / 100);
  const seconds = (value: number | null) => value === null ? r('warmup')
    : new Intl.NumberFormat(language, { style: 'unit', unit: 'second', maximumFractionDigits: 2 }).format(value);
  const limit = (state: 'limited' | 'unlimited' | 'unavailable', value: number | null, format = bytes) =>
    state !== 'limited' ? r(state) : r('limited', { value: format(value) });
  const row = (key: string, value: string) => `${r(key)}: ${value}`;
  const { process, system, cgroup } = snapshot;
  const date = new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(snapshot.sampledAt)) + ' UTC';
  blocks.push({ type: 'paragraph', text: [
    { type: 'bold', text: r('title') }, '\n', r('sampledAt') + ': ',
    { type: 'date_time', text: date, unix_time: Math.floor(Date.parse(snapshot.sampledAt) / 1000), date_time_format: 'DT' },
    '\n' + row('window', seconds(snapshot.intervalSeconds)),
  ] });
  section(r('process'), [
    row('cpu', cpu(process.cpuPercent)), row('rss', bytes(process.rssBytes)),
    row('heap', r('heapValue', { used: bytes(process.heapUsedBytes), total: bytes(process.heapTotalBytes), limit: bytes(process.heapLimitBytes) })),
    row('buffers', r('buffersValue', { external: bytes(process.externalBytes), buffers: bytes(process.arrayBuffersBytes) })),
  ], r('cpuNote'));
  section(r('system'), [
    row('cpu', system.logicalCpus === null ? r('unavailable') : cpu(system.cpuPercent)),
    row('cpus', r('cpusValue', { logical: numeric(system.logicalCpus), available: numeric(system.availableCpus) })),
    row('load', system.loadAverage === null ? r('unavailable') : r('loadValue', {
      one: numeric(system.loadAverage[0]), five: numeric(system.loadAverage[1]), fifteen: numeric(system.loadAverage[2]),
    })),
    row('memory', r('memoryValue', { available: bytes(system.memoryAvailableBytes), total: bytes(system.memoryTotalBytes) })),
  ], r('systemNote'));
  if (cgroup.version !== 'v2' || cgroup.state === 'unavailable') {
    section(r('cgroup'), [r(cgroup.version === 'v1' ? 'v1Unavailable' : 'unavailable')]);
  } else {
    section(r('cgroup'), [
      row('availability', r(`states.${cgroup.state}`)),
      row('cpu', r('cgroupCpuValue', { usage: cgroup.cpuScope === 'unavailable' || cgroup.state === 'partial' && cgroup.cpuPercent === null
        ? r('unavailable') : cpu(cgroup.cpuPercent, cgroup.cpuIntervalSeconds),
        quota: limit(cgroup.cpuLimit, cgroup.cpuQuotaCores, value => r('cores', { value: numeric(value) })), scope: r(`scopes.${cgroup.cpuScope}`) })),
      row('window', cgroup.cpuScope === 'unavailable' || cgroup.state === 'partial' && cgroup.cpuPercent === null ? r('unavailable') : seconds(cgroup.cpuIntervalSeconds)),
      row('memory', r('cgroupMemoryValue', { current: bytes(cgroup.memoryCurrentBytes), peak: bytes(cgroup.memoryPeakBytes),
        limit: limit(cgroup.memoryLimit, cgroup.memoryLimitBytes), scope: r(`scopes.${cgroup.memoryScope}`) })),
      row('swap', r('boundedValue', { current: bytes(cgroup.swapCurrentBytes), limit: limit(cgroup.swapLimit, cgroup.swapLimitBytes) })),
      row('pids', r('pidsValue', { current: numeric(cgroup.pidsCurrent), limit: limit(cgroup.pidsLimitState, cgroup.pidsLimit, numeric), scope: r(`scopes.${cgroup.pidsScope}`) })),
    ], r('cgroupNote'));
  }
  blocks.push({ type: 'paragraph', text: { type: 'italic', text: r('qualificationNote') } });
  return { blocks, skip_entity_detection: true };
}
