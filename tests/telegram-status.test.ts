import { describe, expect, it } from 'vitest';
import { resources } from '../shared/locales/index.js';
import { supportedLocales, type RuntimeStatus } from '../shared/schemas/index.js';
import { systemMetricsSchema, type SystemMetricsSnapshot } from '../shared/schemas/system-metrics.js';
import { translator } from '../src/i18n.js';
import { statusMessage } from '../src/telegram/status.js';
import { richText } from './support/telegram.js';

const snapshot: SystemMetricsSnapshot = {
  sampledAt: '2026-11-11T04:00:00.000Z', intervalSeconds: 5.25,
  process: { cpuPercent: 175.25, rssBytes: 80 * 1024 ** 2, heapUsedBytes: 24 * 1024 ** 2, heapTotalBytes: 32 * 1024 ** 2,
    heapLimitBytes: 108 * 1024 ** 2, externalBytes: 6 * 1024 ** 2, arrayBuffersBytes: 2 * 1024 ** 2, uptimeSeconds: 400 },
  system: { logicalCpus: 8, availableCpus: 2, cpuPercent: 35.5, loadAverage: [1.25, 0.5, 0], memoryTotalBytes: 16 * 1024 ** 3,
    memoryAvailableBytes: 6 * 1024 ** 3, memoryFreeBytes: 2 * 1024 ** 3, uptimeSeconds: 900 },
  cgroup: { version: 'v2', state: 'available', cpuPercent: 185.5, cpuIntervalSeconds: 5, cpuQuotaCores: 2.5, cpuLimit: 'limited', cpuScope: 'ancestor',
    memoryCurrentBytes: 96 * 1024 ** 2, memoryPeakBytes: 128 * 1024 ** 2, memoryLimitBytes: 256 * 1024 ** 2,
    memoryLimit: 'limited', memoryScope: 'ancestor', swapCurrentBytes: 0, swapLimitBytes: 0, swapLimit: 'limited',
    pidsCurrent: 0, pidsLimit: 64, pidsLimitState: 'limited', pidsScope: 'current' },
};
const status = (resources?: SystemMetricsSnapshot): RuntimeStatus => ({
  uptimeSeconds: 400, updateCount: 42, authorizedGroupCount: 1, polling: 'running', http: 'disabled', lastApiError: null,
  ...(resources ? { resources } : {}),
});
function nullable(): SystemMetricsSnapshot {
  return { ...structuredClone(snapshot), intervalSeconds: null,
    process: { ...snapshot.process, cpuPercent: null },
    system: { ...snapshot.system, cpuPercent: null, loadAverage: null, memoryAvailableBytes: null },
    cgroup: { version: 'v2', state: 'partial', cpuPercent: null, cpuIntervalSeconds: null, cpuQuotaCores: null, cpuLimit: 'unavailable', cpuScope: 'unavailable',
      memoryCurrentBytes: null, memoryPeakBytes: null, memoryLimitBytes: null, memoryLimit: 'unavailable', memoryScope: 'unavailable',
      swapCurrentBytes: null, swapLimitBytes: null, swapLimit: 'unavailable', pidsCurrent: null, pidsLimit: null,
      pidsLimitState: 'unavailable', pidsScope: 'unavailable' },
  };
}
function flatten(value: Record<string, unknown>, prefix = ''): Record<string, string> {
  return Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'string'
    ? [[prefix + key, item]] : Object.entries(flatten(item as Record<string, unknown>, `${prefix}${key}.`))));
}

describe('localized resource status', () => {
  it('keeps all resource copy keys and named placeholders in sync across four locales', () => {
    const english = flatten(resources.en.common.resources);
    for (const language of supportedLocales) {
      const copy = flatten(resources[language].common.resources);
      expect(Object.keys(copy).sort()).toEqual(Object.keys(english).sort());
      for (const [key, value] of Object.entries(english)) {
        expect(copy[key]?.trim()).not.toBe('');
        expect([...copy[key]!.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort())
          .toEqual([...value.matchAll(/\{\{(\w+)\}\}/g)].map(match => match[1]).sort());
      }
    }
  });

  for (const language of supportedLocales) {
    it(`${language}: renders full scoped resources with IEC bytes, CPU >100%, native time and normal bold sections`, () => {
      expect(systemMetricsSchema.parse(snapshot)).toEqual(snapshot);
      const t = translator(language);
      const rich = statusMessage(status(snapshot), language);
      const text = richText(rich);
      const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
      const duration = new Intl.NumberFormat(language, { style: 'unit', unit: 'second', maximumFractionDigits: 2 }).format(5.25);
      expect(text).toContain(percent.format(1.7525));
      expect(text).toContain(percent.format(0.355));
      expect(text).toContain(percent.format(1.855));
      expect(text).toContain(duration);
      for (const value of ['80 MiB', '24 MiB', '32 MiB', '108 MiB', '6 MiB', '2 MiB', '16 GiB', '6 GiB', '96 MiB', '128 MiB', '256 MiB']) expect(text).toContain(value);
      for (const key of ['cpuNote', 'systemNote', 'cgroupNote', 'qualificationNote', 'scopes.ancestor', 'scopes.current']) {
        expect(text).toContain(t(`common:resources.${key}`));
      }
      expect(text).toContain(t('common:resources.pidsValue', { current: '0', limit: t('common:resources.limited', { value: '64' }), scope: t('common:resources.scopes.current') }));
      expect(text).toContain(t('common:resources.boundedValue', { current: '0 B', limit: t('common:resources.limited', { value: '0 B' }) }));
      expect(text).not.toMatch(/NaN|undefined|null|\{\{|common:resources/);
      expect(text.length).toBeLessThan(4096);
      expect(rich.skip_entity_detection).toBe(true);
      expect(rich.blocks?.every(block => block.type === 'paragraph')).toBe(true);
      expect(JSON.stringify(rich)).not.toMatch(/"(?:markdown|html|parse_mode|heading|size)"/);
      expect(JSON.stringify(rich)).toContain('"type":"bold"');
      expect(JSON.stringify(rich)).toContain('"type":"date_time"');
      expect(JSON.stringify(rich)).toContain(`"unix_time":${Date.parse(snapshot.sampledAt) / 1000}`);
    });

    it(`${language}: distinguishes warmup, null measurements, limited, unlimited and legacy missing snapshots`, () => {
      const t = translator(language);
      const empty = nullable();
      expect(systemMetricsSchema.parse(empty)).toEqual(empty);
      let text = richText(statusMessage(status(empty), language));
      expect(text).toContain(t('common:resources.warmup'));
      expect(text).toContain(t('common:resources.states.partial'));
      expect(text).toContain(t('common:resources.memoryValue', { available: t('common:resources.unavailable'), total: '16 GiB' }));
      const pids = t('common:resources.pidsValue', { current: t('common:resources.unavailable'), limit: t('common:resources.unavailable'), scope: t('common:resources.scopes.unavailable') });
      expect(text).toContain(pids);
      expect(text).not.toContain('0 B');
      empty.cgroup.memoryLimit = 'limited';
      expect(richText(statusMessage(status(empty), language))).toContain(t('common:resources.limited', { value: t('common:resources.unavailable') }));
      const unlimited = structuredClone(empty);
      unlimited.intervalSeconds = 5;
      Object.assign(unlimited.cgroup, { cpuLimit: 'unlimited', memoryLimit: 'unlimited', swapLimit: 'unlimited', pidsLimitState: 'unlimited' });
      text = richText(statusMessage(status(unlimited), language));
      expect(text).toContain(t('common:resources.unlimited'));
      expect(text).not.toContain(t('common:resources.warmup'));
      expect(text).not.toContain('0 B');
      const legacy = richText(statusMessage(status(), language));
      expect(legacy).toContain(t('common:resources.unavailable'));
      expect(legacy).toContain(t('common:states.running'));
      expect(legacy).not.toContain(t('common:resources.process'));
    });
  }

  it('renders unsupported v1 and unavailable cgroups explicitly, without invented values', () => {
    for (const language of supportedLocales) for (const version of ['v1', 'unavailable', 'v2'] as const) {
      const input = nullable();
      input.cgroup.version = version;
      input.cgroup.state = 'unavailable';
      const rich = statusMessage(status(input), language);
      const block = rich.blocks?.at(-2);
      expect(richText(block)).toContain(translator(language)(`common:resources.${version === 'v1' ? 'v1Unavailable' : 'unavailable'}`));
      expect(richText(block)).not.toMatch(/0 B|0%/);
    }
  });

  it('keeps dynamic status strings literal and never enumerates metadata', () => {
    const input = { ...status(snapshot), lastApiError: { code: '<b>raw</b> @user /secret', at: snapshot.sampledAt },
      hostname: 'hidden-host', path: '/private/cgroup/path', environment: 'PRIVATE_TOKEN', otherProcesses: 'hidden-process' };
    const rich = statusMessage(input, 'en');
    expect(richText(rich)).toContain('<b>raw</b> @user /secret');
    expect(JSON.stringify(rich)).not.toMatch(/hidden-host|private\/cgroup|PRIVATE_TOKEN|hidden-process|"html"|"markdown"|"bot_command"/);
    expect(rich.skip_entity_detection).toBe(true);
  });
});
