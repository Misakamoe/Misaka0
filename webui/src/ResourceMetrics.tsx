import { useTranslation } from 'react-i18next';
import type { SystemMetricsSnapshot } from '../../shared/schemas/system-metrics';

export function ResourceMetrics({ snapshot }: { snapshot?: SystemMetricsSnapshot }) {
  const { t, i18n } = useTranslation();
  const r = (key: string, parameters: Record<string, unknown> = {}) => t(`common:resources.${key}`, parameters);
  if (!snapshot) return <section className="log-line"><h2>{r('title')}</h2><p>{r('unavailable')}</p></section>;
  const number = new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 2 });
  const percent = new Intl.NumberFormat(i18n.language, { style: 'percent', maximumFractionDigits: 1 });
  const numeric = (value: number | null) => value === null ? r('unavailable') : number.format(value);
  const bytes = (value: number | null): string => {
    if (value === null) return r('unavailable');
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
    const exponent = value === 0 ? 0 : Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${number.format(value / 1024 ** exponent)} ${units[exponent]}`;
  };
  const cpu = (value: number | null, interval = snapshot.intervalSeconds) => value === null ? r(interval === null ? 'warmup' : 'unavailable') : percent.format(value / 100);
  const seconds = (value: number | null) => value === null ? r('warmup')
    : new Intl.NumberFormat(i18n.language, { style: 'unit', unit: 'second', maximumFractionDigits: 2 }).format(value);
  const limit = (state: 'limited' | 'unlimited' | 'unavailable', value: number | null, format = bytes) =>
    state !== 'limited' ? r(state) : r('limited', { value: format(value) });
  const { process, system, cgroup } = snapshot;
  const groups: { key: string; note?: string; rows: [string, string][] }[] = [
    { key: 'process', note: r('cpuNote'), rows: [
      ['cpu', cpu(process.cpuPercent)], ['rss', bytes(process.rssBytes)],
      ['heap', r('heapValue', { used: bytes(process.heapUsedBytes), total: bytes(process.heapTotalBytes), limit: bytes(process.heapLimitBytes) })],
      ['buffers', r('buffersValue', { external: bytes(process.externalBytes), buffers: bytes(process.arrayBuffersBytes) })],
    ] },
    { key: 'system', note: r('systemNote'), rows: [
      ['cpu', system.logicalCpus === null ? r('unavailable') : cpu(system.cpuPercent)],
      ['cpus', r('cpusValue', { logical: numeric(system.logicalCpus), available: numeric(system.availableCpus) })],
      ['load', system.loadAverage === null ? r('unavailable') : r('loadValue', {
        one: numeric(system.loadAverage[0]), five: numeric(system.loadAverage[1]), fifteen: numeric(system.loadAverage[2]),
      })],
      ['memory', r('memoryValue', { available: bytes(system.memoryAvailableBytes), total: bytes(system.memoryTotalBytes) })],
    ] },
    cgroup.version !== 'v2' || cgroup.state === 'unavailable'
      ? { key: 'cgroup', rows: [['availability', r(cgroup.version === 'v1' ? 'v1Unavailable' : 'unavailable')]] }
      : { key: 'cgroup', note: r('cgroupNote'), rows: [
        ['availability', r(`states.${cgroup.state}`)],
        ['cpu', r('cgroupCpuValue', { usage: cgroup.cpuScope === 'unavailable' || cgroup.state === 'partial' && cgroup.cpuPercent === null
          ? r('unavailable') : cpu(cgroup.cpuPercent, cgroup.cpuIntervalSeconds),
          quota: limit(cgroup.cpuLimit, cgroup.cpuQuotaCores, value => r('cores', { value: numeric(value) })), scope: r(`scopes.${cgroup.cpuScope}`) })],
        ['window', cgroup.cpuScope === 'unavailable' || cgroup.state === 'partial' && cgroup.cpuPercent === null ? r('unavailable') : seconds(cgroup.cpuIntervalSeconds)],
        ['memory', r('cgroupMemoryValue', { current: bytes(cgroup.memoryCurrentBytes), peak: bytes(cgroup.memoryPeakBytes),
          limit: limit(cgroup.memoryLimit, cgroup.memoryLimitBytes), scope: r(`scopes.${cgroup.memoryScope}`) })],
        ['swap', r('boundedValue', { current: bytes(cgroup.swapCurrentBytes), limit: limit(cgroup.swapLimit, cgroup.swapLimitBytes) })],
        ['pids', r('pidsValue', { current: numeric(cgroup.pidsCurrent), limit: limit(cgroup.pidsLimitState, cgroup.pidsLimit, numeric), scope: r(`scopes.${cgroup.pidsScope}`) })],
      ] },
  ];
  return <section aria-labelledby="resource-title">
    <div className="log-line"><h2 id="resource-title">{r('title')}</h2>
      <p className="help">{r('sampledAt')}: <time dateTime={snapshot.sampledAt}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(snapshot.sampledAt))} UTC</time></p>
      <p className="help">{r('window')}: {seconds(snapshot.intervalSeconds)}</p>
    </div>
    {groups.map(group => <section className="log-line" key={group.key} aria-labelledby={`resource-${group.key}`}>
      <h2 id={`resource-${group.key}`}>{r(group.key)}</h2>
      {group.note && <p className="help">{group.note}</p>}
      <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 16rem), 1fr))', gap: '16px', marginBottom: 0 }}>
        {group.rows.map(([key, value]) => <div key={key} style={{ minWidth: 0 }}>
          <dt className="help">{r(key)}</dt><dd style={{ margin: 0, overflowWrap: 'anywhere', fontSize: '.84rem', lineHeight: 1.65 }}>{value}</dd>
        </div>)}
      </dl>
    </section>)}
    <p className="help section-footnote">{r('qualificationNote')}</p>
  </section>;
}
