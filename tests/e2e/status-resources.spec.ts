import { test, expect } from '@playwright/test';
import { resources } from '../../shared/locales/index.js';
import { supportedLocales, type RuntimeStatus } from '../../shared/schemas/index.js';
import type { SystemMetricsSnapshot } from '../../shared/schemas/system-metrics.js';
import { mockApi } from './mock.js';

const full: SystemMetricsSnapshot = {
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

for (const language of supportedLocales) {
  test(`${language}: resource status stays scoped, localized and responsive for full, partial, unlimited and absent samples`, async ({ page }) => {
    const mock = await mockApi(page, { language });
    const common = resources[language].common;
    const copy = common.resources;
    const snapshot = structuredClone(full);
    const dto: RuntimeStatus = { uptimeSeconds: 400, updateCount: 42, authorizedGroupCount: 1, polling: 'failed', http: 'running', lastApiError: null, resources: snapshot };
    const requests: string[] = [];
    // Installed after mockApi: all other traffic retains its existing offline/auth mocks.
    await page.route('**/api/status', async route => {
      expect(route.request().method()).toBe('GET');
      expect(route.request().postData()).toBeNull();
      requests.push(new URL(route.request().url()).search);
      await route.fulfill({ json: { status: 'succeeded', invocationId: 'test', data: dto } });
    });
    await page.goto('/');
    const panel = page.getByRole('region', { name: copy.title, exact: true });
    const process = panel.getByRole('region', { name: copy.process, exact: true });
    const system = panel.getByRole('region', { name: copy.system, exact: true });
    const cgroup = panel.getByRole('region', { name: copy.cgroup, exact: true });
    const percent = new Intl.NumberFormat(language, { style: 'percent', maximumFractionDigits: 1 });
    await expect(panel.getByRole('heading', { name: copy.title })).toBeVisible();
    await expect(page.locator('.status-table .state-running')).toHaveText(common.states.running);
    await expect(page.locator('.status-table .state-failed')).toHaveText(common.states.failed);
    await expect(panel.locator('time')).toHaveAttribute('datetime', snapshot.sampledAt);
    await expect(panel).toContainText(new Intl.NumberFormat(language, { style: 'unit', unit: 'second', maximumFractionDigits: 2 }).format(5.25));
    await expect(process).toContainText(percent.format(1.7525));
    await expect(system).toContainText(percent.format(0.355));
    await expect(cgroup).toContainText(percent.format(1.855));
    for (const value of ['80 MiB', '24 MiB', '32 MiB', '108 MiB', '6 MiB', '2 MiB']) await expect(process).toContainText(value);
    for (const value of ['16 GiB', '6 GiB']) await expect(system).toContainText(value);
    for (const value of ['96 MiB', '128 MiB', '256 MiB', '0 B']) await expect(cgroup).toContainText(value);
    const taskRow = cgroup.locator('dl > div').filter({ has: page.getByText(copy.pids, { exact: true }) });
    await expect(taskRow.locator('dd')).toContainText('0');
    await expect(taskRow.locator('dd')).toContainText('64');
    await expect(taskRow).toContainText(copy.scopes.current);
    await expect(cgroup).toContainText(copy.scopes.ancestor);
    for (const note of [copy.cpuNote, copy.systemNote, copy.cgroupNote, copy.qualificationNote]) await expect(panel).toContainText(note);
    await expect(panel).not.toContainText(/NaN|undefined|null|\{\{|common:resources/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const refresh = page.getByRole('button', { name: common.actions.refresh, exact: true });

    snapshot.intervalSeconds = null;
    snapshot.process.cpuPercent = snapshot.system.cpuPercent = null;
    snapshot.cgroup.cpuPercent = snapshot.cgroup.cpuIntervalSeconds = null;
    await refresh.click();
    await expect(process).toContainText(copy.warmup);
    await expect(system).toContainText(copy.warmup);
    await expect(cgroup).toContainText(copy.warmup);
    snapshot.system.loadAverage = snapshot.system.memoryAvailableBytes = null;
    snapshot.system.logicalCpus = snapshot.system.availableCpus = null;
    snapshot.cgroup = { version: 'v2', state: 'partial', cpuPercent: null, cpuIntervalSeconds: null, cpuQuotaCores: null, cpuLimit: 'unavailable', cpuScope: 'current',
      memoryCurrentBytes: null, memoryPeakBytes: null, memoryLimitBytes: null, memoryLimit: 'unavailable', memoryScope: 'unavailable',
      swapCurrentBytes: null, swapLimitBytes: null, swapLimit: 'unavailable', pidsCurrent: null, pidsLimit: null,
      pidsLimitState: 'unavailable', pidsScope: 'unavailable' };
    await refresh.click();
    await expect(process).toContainText(copy.warmup);
    await expect(system).toContainText(copy.unavailable);
    await expect(system).not.toContainText(copy.warmup);
    await expect(cgroup).toContainText(copy.states.partial);
    await expect(cgroup).toContainText(copy.unavailable);
    await expect(cgroup).not.toContainText(copy.warmup);
    await expect(taskRow.locator('dd')).toContainText(copy.unavailable);
    await expect(taskRow.locator('dd')).not.toContainText('0');
    await expect(cgroup).not.toContainText('0 B');

    snapshot.intervalSeconds = 5;
    Object.assign(snapshot.cgroup, { cpuLimit: 'unlimited', memoryLimit: 'unlimited', swapLimit: 'unlimited', pidsLimitState: 'unlimited' });
    await refresh.click();
    await expect(cgroup).toContainText(copy.unlimited);
    await expect(process).toContainText(copy.unavailable);
    await expect(panel).not.toContainText(copy.warmup);
    await expect(cgroup).not.toContainText('0 B');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

    snapshot.cgroup.version = 'v1'; snapshot.cgroup.state = 'unavailable';
    await refresh.click();
    await expect(cgroup).toContainText(copy.v1Unavailable);
    await expect(cgroup.locator('dl > div')).toHaveCount(1);
    snapshot.cgroup.version = 'unavailable';
    await refresh.click();
    await expect(cgroup).not.toContainText(copy.v1Unavailable);
    await expect(cgroup.locator('dd')).toHaveText(copy.unavailable);

    delete dto.resources;
    await refresh.click();
    await expect(page.getByRole('heading', { name: copy.title, exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: copy.process, exact: true })).toHaveCount(0);
    await expect(page.getByText(copy.unavailable, { exact: true })).toBeVisible();
    await expect(page.locator('.status-table .state-running')).toHaveText(common.states.running);
    expect(requests).toEqual(Array.from({ length: 7 }, () => ''));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mock.assertClean();
  });
}

test('signed-out dashboard never requests or exposes resource metrics', async ({ page }) => {
  const mock = await mockApi(page, { signedOut: true });
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Resource snapshot' })).toHaveCount(0);
  expect(mock.state.calls.some(call => call.path === '/api/status')).toBe(false);
  mock.assertClean();
});
