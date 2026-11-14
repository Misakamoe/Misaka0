import { expect, test, type Page } from '@playwright/test';
import { resources as locales } from '../../shared/locales/index.js';
import { aiDefaults, aiInteractiveBudget, aiInteractiveDailyRuns, aiSettingsSchema } from '../../shared/schemas/ai.js';
import { aiAdminSnapshotSchema, aiPersonalSetupSchema, aiToolCatalogSchema, type AiAdminSnapshot, type AiPersonalSetup, type AiToolCatalog } from '../../shared/schemas/ai-admin.js';
import { aiSkillInstallSchema, aiSkillReviewSchema, aiMcpReviewInputSchema, aiSandboxReviewInputSchema, aiLocalSandboxReviewInputSchema, aiStdioMcpReviewInputSchema } from '../../shared/schemas/ai-extensions.js';
import type { LanguagePreference } from '../../shared/schemas/index.js';
import { mockApi } from './mock.js';

const setupKey = 'test-only-setup-key';
type CatalogTool = AiToolCatalog['items'][number];
function tool(id: string, group: CatalogTool['group'], effect: CatalogTool['effect'] = 'read', scopes: CatalogTool['scopes'] = ['private', 'group'], permission: CatalogTool['permission'] = 'any'): CatalogTool {
  return { id, group, effect, scopes, permission, approval: effect === 'read' ? 'none' : effect === 'personal_write' ? 'conditional' : 'required' };
}
const toolCatalog: AiToolCatalog = { items: [
  tool('ai.fetch', 'search'), tool('ai.search', 'search'), tool('core.info', 'core'), tool('modules.list', 'core'),
  tool('rate.convert', 'rate'), tool('rate.currencies', 'rate'), tool('weather.search', 'weather'), tool('weather.query', 'weather'),
  tool('rss.list', 'rss', 'read', ['private', 'group'], 'chat_manager'), tool('rss.remove', 'rss', 'destructive', ['private', 'group'], 'chat_manager'),
  tool('alias.add', 'alias', 'write', ['private'], 'superadmin'), tool('ai.sandbox.local.execute', 'local', 'write'),
] };
function setupSnapshot(current: AiAdminSnapshot, input: Omit<AiPersonalSetup, 'apiKey'>): AiAdminSnapshot {
  const providerId = 'personal-test'; const presetId = 'text-test'; const ref = 'vault:personal-test';
  return aiAdminSnapshotSchema.parse({ ...current, revision: current.revision + 1,
    settings: { ...current.settings, enabled: true,
      providers: [{ id: providerId, enabled: true, protocol: input.protocol, baseUrl: input.baseUrl, allowedOrigins: [new URL(input.baseUrl).origin], credentialRef: ref }],
      presets: [{ id: presetId, providerId, model: input.model, tools: ['rate.convert', 'rate.currencies', 'weather.search', 'weather.query'],
        inputCapabilities: ['text'], outputCapabilities: ['text'], budgetMode: 'usage',
        budget: aiInteractiveBudget() }],
      grants: [{ id: 'owner-test', kind: 'private', subjectId: 42, presetId }, ...input.groupIds.map((subjectId, index) => ({ id: `group-${index}-test`, kind: 'group', subjectId, presetId }))],
      limits: { ...current.settings.limits, dailyRuns: current.settings.limits.dailyRuns ?? aiInteractiveDailyRuns } },
    credentials: [...current.credentials, { ref, source: 'vault', hasValue: true }],
  });
}
function limitedSnapshot(current: AiAdminSnapshot): AiAdminSnapshot {
  const next = setupSnapshot(current, { revision: current.revision, protocol: 'openai-chat-completions', baseUrl: 'https://api.deepseek.com/v1', model: 'existing-model', groupIds: [-10042] });
  next.settings.presets[0]!.budget = { maxInputTokens: 4096, maxOutputTokens: 1024, maxToolCalls: 4, maxDurationMs: 60_000, maxCostMicros: 123 };
  next.settings.limits.dailyRuns = 50;
  return next;
}

async function openAdvanced(page: Page) {
  const summary = page.locator('#ai-advanced');
  await expect(summary).toBeVisible();
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
  await expect(page.locator('#root_enabled')).toBeVisible();
}
async function openAi(page: Page, advanced = true) {
  await page.goto('/'); await page.getByRole('button', { name: 'AI administration', exact: true }).click();
  if (advanced) await openAdvanced(page);
}

async function mockAi(page: Page, language: LanguagePreference = 'en') {
  const base = await mockApi(page, { language });
  const state = {
    snapshot: {
      revision: 1, settings: aiDefaults(), credentials: [],
      status: { available: true, schemaVersion: 1, conversations: 0, turns: 0, memories: 0, pendingRuns: 0, records: 0, reservedCostMicros: 0, settledCostMicros: 0, storageBytes: 0 },
      sandbox: { qualified: false, reasons: [] },
    } as AiAdminSnapshot,
    failure: '', confirm: false, pending: undefined as AiAdminSnapshot | undefined,
    reads: 0, writes: 0, confirmations: 0, replacements: 0, deletions: 0,
    setupRequests: 0, setupInput: undefined as Omit<AiPersonalSetup, 'apiKey'> | undefined, groupPages: [] as number[],
    localEnabled: false, extensionInputs: [] as { path: string; body: unknown }[],
    toolCatalog: structuredClone(toolCatalog), toolReads: 0, toolFailure: '',
    extensionRequests: 0, installs: 0, discoveries: 0, statusReads: 0, statusFailure: '', skipExtensionApproval: false,
    localProbes: 0, localReviews: 0, stdioDiscoveries: 0, stdioFailure: '', probeReason: 'C_COMPILER_UNAVAILABLE',
    extensionPending: undefined as { kind: string; result: unknown; install?: ReturnType<typeof aiSkillInstallSchema.parse> } | undefined,
    installed: undefined as ReturnType<typeof aiSkillInstallSchema.parse> | undefined,
  };
  await page.route(/\/api\/(?:ai\/.*|confirm|groups(?:\?.*)?)$/, async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const fail = (code: string, status: number) => route.fulfill({ status, json: { status: 'rejected', invocationId: 'ai-test', error: { code } } });
    const success = (data: unknown) => route.fulfill({ json: { status: 'succeeded', invocationId: 'ai-test', data } });
    if (base.state.expired) { await fail('AUTH_EXPIRED', 401); return; }
    if (path === '/api/groups' && request.method() === 'GET') {
      const pageIndex = Number(new URL(request.url()).searchParams.get('page')); state.groupPages.push(pageIndex);
      await success({ items: base.state.groups.slice(pageIndex * 10, (pageIndex + 1) * 10), page: pageIndex, pageSize: 10, total: base.state.groups.length, revision: 1 }); return;
    }
    if (path === '/api/ai/admin/extensions/status') {
      state.statusReads++;
      if (state.statusFailure) { await fail(state.statusFailure, 503); return; }
      await success({ skills: (state.snapshot.settings.skills ?? []).filter(item => item.enabled).length, mcp: (state.snapshot.settings.mcp ?? []).filter(item => item.enabled).length, remoteExecutors: 0, localExecutors: 0, stdioMcp: 0, localEnabled: state.localEnabled, localRunnerImplemented: true, localReason: state.localEnabled ? 'QUALIFIED' : state.probeReason }); return;
    }
    if (path === '/api/ai/admin/tools') {
      expect(request.method()).toBe('GET'); state.toolReads++;
      if (state.toolFailure) { await fail(state.toolFailure, 503); return; }
      await success(aiToolCatalogSchema.parse(state.toolCatalog)); return;
    }
    if (request.method() === 'GET') { state.reads++; await success(state.snapshot); return; }
    expect(request.headers()['x-csrf-token']).toBe('test-csrf');
    expect(request.headers().origin).toBe('http://127.0.0.1:4173');
    if (path === '/api/ai/setup') {
      expect(request.method()).toBe('POST'); state.writes++; state.setupRequests++;
      const { apiKey, ...input } = aiPersonalSetupSchema.parse(request.postDataJSON());
      expect(apiKey).toBe(setupKey); state.setupInput = input;
      if (state.failure) { await fail(state.failure, 409); return; }
      const settings = state.snapshot.settings;
      if (input.revision !== state.snapshot.revision || settings.enabled || settings.providers.length || settings.presets.length || settings.grants.length) { await fail('CONFLICT', 409); return; }
      if (input.groupIds.some(id => !base.state.groups.some(group => group.id === id))) { await fail('FORBIDDEN', 403); return; }
      state.snapshot = setupSnapshot(state.snapshot, input); await success(state.snapshot); return;
    }
    if (path === '/api/confirm') {
      state.confirmations++;
      expect(request.postDataJSON()).toEqual({ token: (state.extensionPending ? 'c' : 'b').repeat(40) });
      if (state.failure) { await fail(state.failure, 409); return; }
      if (state.extensionPending) {
        const pending = state.extensionPending; state.extensionPending = undefined;
        if (pending.kind === 'install') { state.installs++; state.installed = pending.install; }
        else if (pending.kind === 'stdio') { if (state.stdioFailure) { await fail(state.stdioFailure, 503); return; } state.stdioDiscoveries++; }
        else state.discoveries++;
        await success(pending.result); return;
      }
      expect(state.pending).toBeDefined();
      state.snapshot = state.pending!; state.pending = undefined;
      await success(state.snapshot); return;
    }
    if (path.startsWith('/api/ai/admin/extensions/')) {
      state.extensionRequests++;
      state.extensionInputs.push({ path, body: request.postDataJSON() });
      if (state.failure) { await fail(state.failure, 409); return; }
      expect(Buffer.byteLength(request.postData() ?? '')).toBeLessThanOrEqual(32_768);
      const review = (input: ReturnType<typeof aiSkillInstallSchema.parse>) => ({ trust: 'untrusted', id: input.id, digest: 'd'.repeat(64), manifest: input.files.map(file => ({ path: file.path, sha256: 'e'.repeat(64) })), name: '<img src=x onerror=alert(1)>', description: '<script>window.bad=true</script>', body: input.files.map(file => file.text).join('\n'), declaredTools: ['<b>not-authority</b>'], tools: input.tools, scopes: input.scopes });
      if (path.endsWith('/skills/review')) {
        const input = aiSkillReviewSchema.parse(request.postDataJSON());
        if (!state.installed || input.id !== state.installed.id || input.digest !== 'd'.repeat(64)) { await fail('NOT_FOUND', 404); return; }
        await success(review(state.installed)); return;
      }
      if (path.endsWith('/sandbox/review')) {
        const input = aiSandboxReviewInputSchema.parse(request.postDataJSON());
        await success({ profileId: input.profile.id, digest: 'f'.repeat(64), localQualified: false, protocol: 'misaka-remote-executor-v1' }); return;
      }
      if (path.endsWith('/sandbox/local/review')) {
        const input = aiLocalSandboxReviewInputSchema.parse(request.postDataJSON()); state.localReviews++;
        await success({ profileId: input.profile.id, digest: '9'.repeat(64), policyHash: '8'.repeat(64), runtime: 'node' }); return;
      }
      if (path.endsWith('/sandbox/local/probe')) {
        expect(request.postDataJSON()).toEqual({}); state.localProbes++;
        await success({ localRunnerImplemented: true, localEnabled: state.localEnabled, localReason: state.localEnabled ? 'QUALIFIED' : state.probeReason }); return;
      }
      let result: unknown; let kind: string; let install: ReturnType<typeof aiSkillInstallSchema.parse> | undefined;
      if (path.endsWith('/skills/install')) { install = aiSkillInstallSchema.parse(request.postDataJSON()); kind = 'install'; result = review(install); }
      else if (path.endsWith('/mcp/discover')) {
        const { profile } = aiMcpReviewInputSchema.parse(request.postDataJSON()); kind = 'mcp';
        result = { trust: 'untrusted', profileId: profile.id, digest: (profile.endpoint.includes('changed') ? 'b' : 'a').repeat(64), tools: [{ name: '<img src=x onerror=alert(1)>', description: '<script>window.bad=true</script>', inputSchema: { type: 'object', description: '<svg onload=alert(1)>' } }], review: { endpoint: profile.endpoint, credentialAuthority: profile.credentialAuthority, scope: profile.scope } };
      } else if (path.endsWith('/mcp/stdio/discover')) {
        const { profile } = aiStdioMcpReviewInputSchema.parse(request.postDataJSON()); kind = 'stdio';
        result = { trust: 'untrusted', profileId: profile.id, digest: (profile.bundle.args.includes('changed') ? '7' : '6').repeat(64), tools: [{ name: 'read', description: '<svg onload=alert(1)>', inputSchema: { type: 'object' } }], review: { bundle: profile.bundle, runtime: profile.runtime, scope: profile.scope, limits: profile.limits } };
      } else { await fail('NOT_FOUND', 404); return; }
      if (state.skipExtensionApproval) { await success(result); return; }
      state.extensionPending = { kind, result, ...(install ? { install } : {}) };
      await route.fulfill({ json: { status: 'pending_confirmation', invocationId: 'extension-test', confirmation: { token: 'c'.repeat(40), actionId: kind === 'install' ? 'ai.skills.install' : kind === 'stdio' ? 'ai.mcp.stdio.discover' : 'ai.mcp.discover', target: 'Reviewed extension', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); return;
    }
    state.writes++;
    if (state.failure) { await fail(state.failure, 409); return; }
    const body = request.postDataJSON() as { revision: number; settings?: unknown; change?: { operation: string; ref: string; value?: string } };
    expect(body.revision).toBe(state.snapshot.revision);
    const next = structuredClone(state.snapshot); next.revision++;
    if (path === '/api/ai/admin') next.settings = aiSettingsSchema.parse(body.settings);
    else if (path === '/api/ai/disable') { expect(body).toEqual({ revision: state.snapshot.revision }); next.settings.enabled = false; }
    else if (path === '/api/ai/credentials') {
      expect(body.change?.ref).toBe('vault:provider');
      if (body.change?.operation === 'replace') { expect(body.change.value).toBe('test-only-write-only-value'); state.replacements++; }
      else { expect(body.change).toEqual({ operation: 'delete', ref: 'vault:provider' }); state.deletions++; }
      next.credentials = [{ ref: 'vault:provider', source: 'vault', hasValue: body.change?.operation === 'replace' }];
    } else { await fail('NOT_FOUND', 404); return; }
    if (state.confirm) {
      state.pending = next;
      await route.fulfill({ json: { status: 'pending_confirmation', invocationId: 'ai-test', confirmation: { token: 'b'.repeat(40), actionId: 'ai.admin.update', target: 'AI settings', expiresAt: new Date(Date.now() + 60_000).toISOString() } } }); return;
    }
    state.snapshot = next; await success(next);
  });
  return { ...base, state, baseState: base.state };
}

test('AI defaults are disabled, expose safe status only and keep established responsive styling', async ({ page }, info) => {
  const mock = await mockAi(page);
  await openAi(page, false);
  await expect(page.getByRole('heading', { name: 'Safe runtime status' })).toBeVisible();
  await expect(page.getByText('No providers configured.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your AI', exact: true })).toBeVisible();
  await expect(page.getByText('Local sandbox is not qualified.', { exact: false })).toHaveCount(0);
  await expect(page.getByText('256 MiB is a deployment target', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Disable AI', exact: true })).toBeDisabled();
  await expect(page.locator('#root_enabled, #root_providers, #ai-credential-value')).toHaveCount(0);
  await expect(page.locator('#ai-advanced')).toHaveText('Advanced AI settings');
  await expect(page.locator('#ai-advanced').locator('..')).not.toHaveAttribute('open', '');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('Model', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save and enable', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-ai-${info.project.name}.png`, fullPage: true });
  expect(mock.state.reads).toBe(1);
  expect(mock.state.writes).toBe(0);
  expect(mock.state.statusReads).toBe(0);
  expect(mock.state.toolReads).toBe(0);
  expect(mock.state.groupPages).toEqual([]);
  mock.assertClean();
});

test('tool picker adds tools by localized name or ID and saves through one server confirmation', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot); mock.state.confirm = true;
  const before = structuredClone(mock.state.snapshot.settings);
  await openAi(page, false); expect(mock.state.toolReads).toBe(0);
  await openAdvanced(page);
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  const search = picker.getByRole('searchbox', { name: 'Find tools', exact: true });
  await expect(picker.getByRole('checkbox', { name: 'Convert currencies', exact: true })).toBeChecked();
  await expect(picker.getByText('Selected: 4 / 64', { exact: true })).toBeVisible();
  await expect(picker.locator('input[type="text"]')).toHaveCount(0);
  await expect(picker.getByText('Saved search configuration is not ready.', { exact: false })).toBeVisible();
  await search.fill('Search the web');
  const web = picker.getByRole('checkbox', { name: 'Search the web', exact: true });
  await expect(web).toBeEnabled(); await web.focus(); await page.keyboard.press('Space');
  await expect(web).toBeChecked(); await expect(web).toBeFocused(); await expect(search).toHaveValue('Search the web');
  await search.fill('ai.fetch'); await picker.getByRole('checkbox', { name: 'Read a webpage', exact: true }).check();
  await search.fill('');
  await expect(picker.getByText('Selected: 6 / 64', { exact: true })).toBeVisible();
  expect(mock.state.writes).toBe(0); expect(mock.state.toolReads).toBe(1);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  const dialog = page.getByRole('dialog'); await expect(dialog).toBeVisible();
  await expect(picker.getByRole('checkbox', { name: 'Search the web', exact: true })).toBeDisabled();
  expect(mock.state.snapshot.settings).toEqual(before);
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  const expected = structuredClone(before); expected.presets[0]!.tools.push('ai.search', 'ai.fetch');
  expect(mock.state.snapshot.settings).toEqual(expected);
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(1);
  expect(mock.state.discoveries).toBe(0); expect(mock.state.localProbes).toBe(0);
  await openAi(page);
  await expect(page.getByRole('group', { name: 'Allowed tools', exact: true }).getByRole('checkbox', { name: 'Search the web', exact: true })).toBeChecked();
  await expect(page.getByRole('group', { name: 'Allowed tools', exact: true }).getByRole('checkbox', { name: 'Read a webpage', exact: true })).toBeChecked();
  expect(mock.state.writes).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

for (const [language, tab, imageInput, textOutput, imageOutput] of [
  ['en', 'AI administration', 'Image understanding', 'Text answers', 'Image generation'],
  ['zh-CN', 'AI 管理', '图片理解（看图）', '文字回答', '生成图片'],
  ['zh-TW', 'AI 管理', '圖片理解（看圖）', '文字回答', '產生圖片'],
  ['ja', 'AI 管理', '画像理解', '文章回答', '画像生成'],
] as const) test(`vision input is distinct from generated image output in ${language}`, async ({ page }) => {
  const mock = await mockAi(page, language); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const inputGroup = locales[language].web.ai.fields.inputCapabilities;
  const { add: addInput, save } = locales[language].common.actions;
  await page.goto('/'); await page.getByRole('button', { name: tab, exact: true }).click(); await openAdvanced(page);
  await page.getByRole('group', { name: new RegExp(`^${inputGroup}\\*?$`) }).getByRole('button', { name: addInput, exact: true }).click();
  const input = page.locator('#root_presets_0_inputCapabilities_1');
  await expect(input.getByRole('option', { name: imageInput, exact: true })).toHaveCount(1);
  await input.selectOption({ label: imageInput });
  const output = page.locator('#root_presets_0_outputCapabilities_0');
  await expect(output.getByRole('option', { name: textOutput, exact: true })).toHaveCount(1);
  await expect(output.getByRole('option', { name: imageOutput, exact: true })).toHaveCount(1);
  await expect(output.getByRole('option', { name: imageInput, exact: true })).toHaveCount(0);
  await expect(output.locator('option:checked')).toHaveText(textOutput);
  await page.getByRole('button', { name: save, exact: true }).click();
  await expect.poll(() => mock.state.writes).toBe(1);
  expect(mock.state.snapshot.settings.presets[0]!.inputCapabilities).toEqual(['text', 'image']);
  expect(mock.state.snapshot.settings.presets[0]!.outputCapabilities).toEqual(['text']);
  mock.assertClean();
});

test('catalog retry keeps unsaved edits and unknown saved IDs until explicitly removed', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  mock.state.snapshot.settings.presets[0]!.tools = ['rate.convert', 'legacy.custom']; mock.state.toolFailure = 'UNAVAILABLE';
  await openAi(page);
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  await expect(picker.getByRole('alert')).toContainText('Existing selections are unchanged');
  await expect(picker.getByRole('checkbox', { name: 'legacy.custom', exact: true })).toBeChecked();
  expect(mock.state.snapshot.settings.presets[0]!.tools).toEqual(['rate.convert', 'legacy.custom']); expect(mock.state.writes).toBe(0);
  await page.locator('#root_presets_0_model').fill('unsaved-model');
  mock.state.toolFailure = ''; await picker.getByRole('button', { name: 'Reload tools', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'Search the web', exact: true })).toBeVisible();
  await expect(picker.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('#root_presets_0_model')).toHaveValue('unsaved-model');
  await expect(picker.getByRole('heading', { name: 'Saved tools not in this catalog', exact: true })).toBeVisible();
  await picker.getByRole('checkbox', { name: 'Search the web', exact: true }).check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.presets[0]).toMatchObject({ model: 'unsaved-model', tools: ['rate.convert', 'legacy.custom', 'ai.search'] });
  await picker.getByRole('checkbox', { name: 'legacy.custom', exact: true }).click();
  await expect(picker.getByRole('checkbox', { name: 'legacy.custom', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect.poll(() => mock.state.writes).toBe(2);
  expect(mock.state.snapshot.settings.presets[0]!.tools).toEqual(['rate.convert', 'ai.search']);
  expect(mock.state.reads).toBe(1);
  mock.assertClean();
});

test('empty allowlists stay empty until a click and clearing selection never grants defaults', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  mock.state.snapshot.settings.presets[0]!.tools = [];
  await openAi(page);
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  await expect(picker.getByRole('checkbox', { name: 'Search the web', exact: true })).not.toBeChecked();
  await expect(picker.getByText('Selected: 0 / 64', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  await picker.getByRole('checkbox', { name: 'Selected only', exact: true }).check();
  await expect(picker.getByText('No tools match these filters.', { exact: true })).toBeVisible();
  await picker.getByRole('checkbox', { name: 'Selected only', exact: true }).uncheck();
  await picker.getByRole('checkbox', { name: 'Search the web', exact: true }).check();
  await picker.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(picker.getByText('Selected: 0 / 64', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save changes', exact: true })).toBeDisabled();
  expect(mock.state.writes).toBe(0); expect(mock.state.snapshot.settings.presets[0]!.tools).toEqual([]);
  mock.assertClean();
});

test('tool picker enforces the 64-tool cap without blocking removals or reordering retained IDs', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const items = Array.from({ length: 65 }, (_, index) => tool(`fixture.tool_${index}`, 'other'));
  mock.state.toolCatalog = { items }; mock.state.snapshot.settings.presets[0]!.tools = items.slice(0, 64).map(item => item.id);
  await openAi(page);
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  await expect(picker.getByRole('checkbox', { name: 'fixture.tool_64', exact: true })).toBeDisabled();
  await picker.getByRole('checkbox', { name: 'fixture.tool_0', exact: true }).uncheck();
  await expect(picker.getByRole('checkbox', { name: 'fixture.tool_64', exact: true })).toBeEnabled();
  await picker.getByRole('checkbox', { name: 'fixture.tool_64', exact: true }).check();
  await expect(picker.getByText('Selected: 64 / 64', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.presets[0]!.tools).toEqual(items.slice(1).map(item => item.id));
  mock.assertClean();
});

test('preset pickers stay independent and do not replace upstream MCP tool-name fields', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const original = structuredClone(mock.state.snapshot.settings.presets[0]!);
  mock.state.snapshot.settings.presets.push({ ...structuredClone(original), id: 'second-preset', tools: [] });
  mock.state.snapshot.settings.mcp = [{ ...mcpProfile(), tools: ['upstream_only'], readTools: [] }];
  await openAi(page);
  const pickers = page.getByRole('group', { name: 'Allowed tools', exact: true }); await expect(pickers).toHaveCount(2);
  await pickers.nth(1).getByRole('checkbox', { name: 'Search the web', exact: true }).check();
  await expect(pickers.nth(0).getByRole('checkbox', { name: 'Search the web', exact: true })).not.toBeChecked();
  await expect(page.locator('#root_mcp_0_tools_0')).toHaveValue('upstream_only');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.presets[0]).toEqual(original);
  expect(mock.state.snapshot.settings.presets[1]!.tools).toEqual(['ai.search']);
  expect(mock.state.snapshot.settings.mcp?.[0]?.tools).toEqual(['upstream_only']);
  mock.assertClean();
});

test('selecting a local tool does not probe or enable execution and cancelling confirmation retains the draft', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot); mock.state.confirm = true;
  const original = structuredClone(mock.state.snapshot.settings);
  await openAi(page);
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  const local = picker.getByRole('checkbox', { name: 'Run a local task', exact: true });
  await expect(local).toBeEnabled(); await local.check();
  await expect(picker.getByText('The last server snapshot does not confirm local isolation.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(local).toBeChecked();
  expect(mock.state.snapshot.settings).toEqual(original);
  expect(mock.state.localProbes).toBe(0); expect(mock.state.extensionRequests).toBe(0); expect(mock.state.confirmations).toBe(0);
  mock.assertClean();
});

test('loading and malformed catalogs preserve saved tool values without restoring manual ID entry', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const before = [...mock.state.snapshot.settings.presets[0]!.tools];
  const gate = Promise.withResolvers<void>();
  await page.route('**/api/ai/admin/tools', async route => {
    await gate.promise;
    await route.fulfill({ json: { status: 'succeeded', invocationId: 'invalid-catalog', data: { items: [{ id: '<img src=x onerror=alert(1)>' }] } } });
  });
  try {
    await openAi(page);
    const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
    await expect(picker.getByRole('status')).toHaveText('Loading tool catalog...');
    await expect(picker.getByRole('checkbox', { name: 'Convert currencies', exact: true })).toBeChecked();
    await expect(picker.getByRole('checkbox', { name: 'Search the web', exact: true })).toHaveCount(0);
    expect(mock.state.writes).toBe(0);
  } finally { gate.resolve(); }
  const picker = page.getByRole('group', { name: 'Allowed tools', exact: true });
  await expect(picker.getByRole('alert')).toContainText('Could not load the tool catalog');
  await expect(picker.locator('input[type="text"], img, script, svg')).toHaveCount(0);
  expect(mock.state.snapshot.settings.presets[0]!.tools).toEqual(before); expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

for (const [language, tab, group, search, name] of [
  ['en', 'AI administration', 'Allowed tools', 'Find tools', 'Search the web'],
  ['zh-CN', 'AI 管理', '允许的工具', '查找工具', '联网搜索'],
  ['zh-TW', 'AI 管理', '允許的工具', '尋找工具', '網路搜尋'],
  ['ja', 'AI 管理', '許可するツール', 'ツールを検索', 'ウェブを検索'],
] as const) test(`tool picker names and search are localized in ${language}`, async ({ page }) => {
  const mock = await mockAi(page, language); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  await page.goto('/'); await page.getByRole('button', { name: tab, exact: true }).click(); await openAdvanced(page);
  const picker = page.getByRole('group', { name: group, exact: true });
  await picker.getByRole('searchbox', { name: search, exact: true }).fill(name);
  await picker.getByRole('checkbox', { name, exact: true }).check();
  await expect(picker.getByRole('checkbox', { name, exact: true })).toBeChecked();
  expect(mock.state.writes).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

for (const [service, protocol, baseUrl] of [
  ['openai', 'openai-responses', 'https://api.openai.com/v1'],
  ['anthropic', 'anthropic-messages', 'https://api.anthropic.com/v1'],
  ['google', 'google-generate-content', 'https://generativelanguage.googleapis.com/v1beta'],
  ['deepseek', 'openai-chat-completions', 'https://api.deepseek.com/v1'],
  ['custom', 'openai-chat-completions', 'https://custom.example/v1'],
] as const) test(`${service} setup creates private owner access with one exact write and no confirmation`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.confirm = true;
  const providerRequests: string[] = [];
  page.on('request', request => { if (new URL(request.url()).origin === new URL(baseUrl).origin) providerRequests.push(request.url()); });
  await openAi(page, false);
  await page.getByLabel('Service', { exact: true }).selectOption(service);
  if (service === 'custom') {
    await page.locator('#ai-setup-protocol').selectOption(protocol);
    await page.locator('#ai-setup-url').fill(baseUrl);
  }
  await page.getByLabel('API key', { exact: true }).fill(setupKey);
  await page.getByLabel('Model', { exact: true }).fill('explicit-model');
  const outbound = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ai/setup');
  await page.getByRole('button', { name: 'Save and enable', exact: true }).click();
  expect((await outbound).postDataJSON()).toEqual({ revision: 1, protocol, baseUrl, model: 'explicit-model', apiKey: setupKey, groupIds: [] });
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Set up your AI', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('API key', { exact: true })).toHaveCount(0);
  await expect(page.getByText('AI is enabled.', { exact: false })).toBeVisible();
  expect(mock.state.snapshot.settings.providers).toEqual([{ id: 'personal-test', enabled: true, protocol, baseUrl, allowedOrigins: [new URL(baseUrl).origin], credentialRef: 'vault:personal-test' }]);
  expect(mock.state.snapshot.settings.presets[0]).toMatchObject({ id: 'text-test', providerId: 'personal-test', model: 'explicit-model', budgetMode: 'usage', inputCapabilities: ['text'], outputCapabilities: ['text'] });
  expect(mock.state.snapshot.settings.presets[0]?.budget).toEqual(aiInteractiveBudget());
  expect(mock.state.snapshot.settings.limits.dailyRuns).toBe(aiInteractiveDailyRuns);
  await expect(page.getByRole('button', { name: 'Apply recommended limits', exact: true })).toBeDisabled();
  expect(mock.state.snapshot.settings.grants).toEqual([{ id: 'owner-test', kind: 'private', subjectId: 42, presetId: 'text-test' }]);
  expect(mock.state.snapshot.credentials).toEqual([{ ref: 'vault:personal-test', source: 'vault', hasValue: true }]);
  expect(JSON.stringify(mock.state)).not.toContain(setupKey);
  expect(mock.state.writes).toBe(1); expect(mock.state.setupRequests).toBe(1); expect(mock.state.confirmations).toBe(0);
  expect(mock.state.groupPages).toEqual([]); expect(providerRequests).toEqual([]);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  mock.assertClean();
});

test('setup group picker pages authorized groups, preserves selections and renders hostile titles literally', async ({ page }) => {
  const mock = await mockAi(page);
  mock.baseState.groups = Array.from({ length: 11 }, (_, index) => ({ ...mock.baseState.groups[0]!, id: -10000 - index,
    title: index === 0 ? '<img src=x onerror=alert(1)> & private' : `Group ${index}` }));
  await openAi(page, false);
  const setup = page.getByRole('region', { name: 'Set up your AI', exact: true });
  expect(mock.state.groupPages).toEqual([]);
  await page.getByText('Also enable selected groups', { exact: true }).click();
  const hostile = setup.getByRole('checkbox', { name: '<img src=x onerror=alert(1)> & private -10000', exact: true });
  await expect(hostile).toBeVisible(); await hostile.check();
  await expect(setup.locator('img, script, svg')).toHaveCount(0);
  await setup.getByRole('button', { name: 'Next', exact: true }).click();
  await setup.getByRole('checkbox', { name: 'Group 10 -10010', exact: true }).check();
  await expect(setup.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await setup.getByRole('button', { name: 'Previous', exact: true }).click();
  await expect(hostile).toBeChecked();
  await expect(setup.getByText('Selected groups: 2', { exact: true })).toBeVisible();
  await page.getByLabel('API key', { exact: true }).fill(setupKey);
  await page.getByLabel('Model', { exact: true }).fill('explicit-model');
  await page.getByRole('button', { name: 'Save and enable', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.setupInput?.groupIds).toEqual([-10000, -10010]);
  expect(mock.state.groupPages).toEqual([0, 1, 0]);
  expect(mock.state.snapshot.settings.grants).toEqual([
    { id: 'owner-test', kind: 'private', subjectId: 42, presetId: 'text-test' },
    { id: 'group-0-test', kind: 'group', subjectId: -10000, presetId: 'text-test' },
    { id: 'group-1-test', kind: 'group', subjectId: -10010, presetId: 'text-test' },
  ]);
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(0);
  mock.assertClean();
});

test('setup rejects invalid custom input locally and clears credentials before a single pending write', async ({ page }) => {
  const mock = await mockAi(page);
  await openAi(page, false);
  await page.getByLabel('Service', { exact: true }).selectOption('custom');
  await page.locator('#ai-setup-url').fill('http://insecure.example/v1');
  await page.getByLabel('API key', { exact: true }).fill(setupKey);
  await page.getByLabel('Model', { exact: true }).fill('explicit-model');
  await page.getByRole('button', { name: 'Save and enable', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Enter a valid HTTPS service address.');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  expect(mock.state.writes).toBe(0);
  await page.locator('#ai-setup-url').fill('https://custom.example/v1');
  await page.getByLabel('API key', { exact: true }).fill(setupKey);
  let release!: () => void; let requests = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/ai/setup', async route => { requests++; await gate; await route.fallback(); });
  await page.getByRole('button', { name: 'Save and enable', exact: true }).click();
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Save and enable', exact: true })).toBeDisabled();
  try {
    await expect.poll(() => requests).toBe(1);
    await page.getByRole('region', { name: 'Set up your AI', exact: true }).locator('form').evaluate(form => (form as HTMLFormElement).requestSubmit());
    expect(requests).toBe(1);
  } finally { release(); }
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(0);
  mock.assertClean();
});

for (const code of ['CONFLICT', 'OUTCOME_UNKNOWN']) test(`setup ${code} clears its credential and locks until current state is explicitly refreshed`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.failure = code;
  await openAi(page, false);
  await page.getByLabel('API key', { exact: true }).fill(setupKey);
  await page.getByLabel('Model', { exact: true }).fill('explicit-model');
  await page.getByRole('button', { name: 'Save and enable', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Reload and inspect');
  await expect(page.getByLabel('API key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('API key', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save and enable', exact: true })).toBeDisabled();
  expect(mock.state.setupRequests).toBe(1); expect(mock.state.writes).toBe(1);
  mock.state.failure = '';
  mock.state.snapshot = setupSnapshot(mock.state.snapshot, mock.state.setupInput!);
  await page.getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Reloading discards your edits and fetches the latest revision.');
  expect(mock.state.reads).toBe(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await expect(page.getByText('AI is enabled.', { exact: false })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your AI', exact: true })).toHaveCount(0);
  expect(mock.state.reads).toBe(2); expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(0);
  expect(JSON.stringify(mock.state)).not.toContain(setupKey);
  mock.assertClean();
});

test('setup credentials clear on service change, navigation, page hide and logout without browser storage', async ({ page }) => {
  const mock = await mockAi(page); await openAi(page, false);
  const key = page.getByLabel('API key', { exact: true });
  await key.fill(setupKey);
  await page.getByLabel('Service', { exact: true }).selectOption('anthropic');
  await expect(key).toHaveValue('');
  await page.getByLabel('Model', { exact: true }).fill('explicit-model');
  await key.fill(setupKey);
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await expect(key).toHaveValue('');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await key.fill(setupKey);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(key).toHaveValue('');
  await key.fill(setupKey);
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(key).toHaveValue('');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('dialog').getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(key).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  expect(mock.state.setupRequests).toBe(0);
  mock.assertClean();
});

test('existing disabled configuration stays intact and never offers setup', async ({ page }) => {
  const mock = await mockAi(page);
  mock.state.snapshot = setupSnapshot(mock.state.snapshot, { revision: 1, protocol: 'openai-responses', baseUrl: 'https://api.openai.com/v1', model: 'existing-model', groupIds: [] });
  mock.state.snapshot.settings.enabled = false;
  const original = structuredClone(mock.state.snapshot);
  await openAi(page, false);
  await expect(page.getByText('existing-model', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up your AI', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save and enable', exact: true })).toHaveCount(0);
  await openAdvanced(page);
  await expect(page.locator('#root_providers_0_baseUrl')).toHaveValue('https://api.openai.com/v1');
  expect(mock.state.snapshot).toEqual(original); expect(mock.state.setupRequests).toBe(0); expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

test('recommended limits require an explicit write and one server confirmation, preserving cost presets and permissions', async ({ page }) => {
  const mock = await mockAi(page); mock.state.confirm = true;
  mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const settings = mock.state.snapshot.settings;
  settings.enabled = false;
  settings.deniedUserIds = [99];
  settings.search = { enabled: false, providerId: 'personal-test', maxResults: 3 };
  settings.skills = []; settings.mcp = []; settings.sandbox = { enabled: false, profiles: [] };
  settings.presets[0]!.system = 'Keep this instruction';
  settings.presets.push({ ...settings.presets[0]!, id: 'larger-usage', tools: [], budget: { maxInputTokens: 131_072, maxOutputTokens: 2048, maxToolCalls: 12, maxDurationMs: 240_000, maxCostMicros: 777 } });
  settings.presets.push({ ...settings.presets[0]!, id: 'priced', budgetMode: 'cost', pricing: { currency: 'CNY', inputMicrosPerMillion: 100, outputMicrosPerMillion: 200 } });
  settings.presets.push({ ...settings.presets[2]!, id: 'legacy-cost' });
  delete settings.presets[3]!.budgetMode;
  const original = structuredClone(mock.state.snapshot);
  const expected = structuredClone(settings);
  expected.presets[0]!.budget = { ...aiInteractiveBudget(), maxCostMicros: 123 };
  expected.presets[1]!.budget.maxOutputTokens = 8192;
  expected.limits.dailyRuns = aiInteractiveDailyRuns;
  await openAi(page, false);
  const apply = page.getByRole('button', { name: 'Apply recommended limits', exact: true });
  await expect(apply).toBeEnabled();
  const status = page.getByRole('region', { name: 'Safe runtime status', exact: true });
  await expect(status).toContainText('65,536 input and 8,192 output tokens per request');
  await expect(status).toContainText('May increase provider spending.');
  await openAdvanced(page);
  await expect(page.locator('#root_presets_0_budget_maxInputTokens')).toHaveValue('4096');
  expect(mock.state.writes).toBe(0); expect(mock.state.snapshot).toEqual(original);
  const outbound = page.waitForRequest(request => new URL(request.url()).pathname === '/api/ai/admin' && request.method() === 'PUT');
  await apply.click();
  expect((await outbound).postDataJSON()).toEqual({ revision: original.revision, settings: expected });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('one-time server approval');
  await expect(apply).toBeDisabled();
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(0);
  expect(mock.state.snapshot).toEqual(original);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(apply).toBeDisabled();
  await expect(page.locator('#root_presets_0_budget_maxInputTokens')).toHaveValue('65536');
  expect(mock.state.snapshot).toEqual({ ...original, revision: original.revision + 1, settings: expected });
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('recommended limits preserve dirty settings, credentials and extension drafts until explicit refresh', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const original = structuredClone(mock.state.snapshot);
  await openAi(page);
  const apply = page.getByRole('button', { name: 'Apply recommended limits', exact: true });
  const queued = page.locator('#root_limits_maxQueuedRuns');
  await expect(apply).toBeEnabled();
  await queued.fill(String(original.settings.limits.maxQueuedRuns + 1));
  await expect(apply).toBeDisabled();
  await queued.fill(String(original.settings.limits.maxQueuedRuns));
  await expect(apply).toBeEnabled();
  const secret = page.getByLabel('New credential value', { exact: true });
  await secret.fill('test-only-unsaved-value');
  await expect(apply).toBeDisabled();
  await expect(secret).toHaveValue('test-only-unsaved-value');
  await secret.fill('');
  await expect(apply).toBeEnabled();
  await page.getByText('Open extension workflows', { exact: true }).click();
  await page.locator('#extension_id').fill('unsaved-draft');
  await expect(apply).toBeDisabled();
  await expect(page.locator('#extension_id')).toHaveValue('unsaved-draft');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Your edits have not been saved.');
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await expect(apply).toBeEnabled();
  expect(mock.state.snapshot).toEqual(original);
  expect(mock.state.writes).toBe(0); expect(mock.state.reads).toBe(2);
  mock.assertClean();
});

for (const code of ['CONFLICT', 'OUTCOME_UNKNOWN']) test(`recommended limits stay locked while busy and after ${code}, without replay`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot); mock.state.failure = code;
  await openAi(page, false);
  let release!: () => void; let requests = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/api/ai/admin', async route => { if (route.request().method() === 'PUT') { requests++; await gate; } await route.fallback(); });
  const apply = page.getByRole('button', { name: 'Apply recommended limits', exact: true });
  await apply.click();
  try { await expect.poll(() => requests).toBe(1); await expect(apply).toBeDisabled(); }
  finally { release(); }
  await expect(page.getByRole('alert')).toContainText('Reload and inspect');
  await expect(apply).toBeDisabled();
  expect(mock.state.writes).toBe(1);
  mock.state.failure = ''; mock.state.snapshot.revision += 10;
  mock.state.snapshot.settings.presets[0]!.model = 'changed-elsewhere';
  await page.getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await expect(apply).toBeEnabled();
  expect(mock.state.writes).toBe(1);
  await apply.click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.presets[0]!.model).toBe('changed-elsewhere');
  expect(mock.state.writes).toBe(2); expect(mock.state.reads).toBe(2);
  mock.assertClean();
});

for (const dailyRuns of [undefined, 700]) test(`recommended limits handle ${dailyRuns ?? 'missing'} daily runs without lowering a saved limit`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  if (dailyRuns === undefined) delete mock.state.snapshot.settings.limits.dailyRuns;
  else mock.state.snapshot.settings.limits.dailyRuns = dailyRuns;
  await openAi(page, false);
  expect(mock.state.writes).toBe(0);
  await page.getByRole('button', { name: 'Apply recommended limits', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.limits.dailyRuns).toBe(dailyRuns ?? aiInteractiveDailyRuns);
  expect(mock.state.writes).toBe(1);
  mock.assertClean();
});

test('recommended limits are unavailable without storage and absent for cost-only presets', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot); mock.state.snapshot.status.available = false;
  await openAi(page, false);
  const apply = page.getByRole('button', { name: 'Apply recommended limits', exact: true });
  await expect(apply).toBeDisabled();
  mock.state.snapshot.settings.presets[0]!.budgetMode = 'cost';
  mock.state.snapshot.settings.presets[0]!.tools = [];
  mock.state.snapshot.status.available = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await expect(page.getByText('existing-model', { exact: true })).toBeVisible();
  await expect(apply).toHaveCount(0);
  expect(mock.state.snapshot.settings.limits.dailyRuns).toBe(50);
  expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

for (const [state, expected] of [
  ['absent', 'Disabled or not configured'], ['disabled', 'Disabled or not configured'],
  ['nonofficial', 'Provider disabled or not the official DeepSeek service'], ['provider-disabled', 'Provider disabled or not the official DeepSeek service'],
  ['credential-absent', 'Referenced credential is missing'], ['credential-empty', 'Referenced credential is missing'],
  ['no-tools', 'Configured, but no preset allows search or retrieval tools'],
  ['search', 'Configured (not live-validated)'], ['fetch', 'Configured (not live-validated)'],
] as const) test(`search readiness ${state} uses metadata only and opens the existing editor`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot = limitedSnapshot(mock.state.snapshot);
  const settings = mock.state.snapshot.settings;
  if (state !== 'absent') settings.search = { enabled: state !== 'disabled', providerId: 'personal-test', maxResults: 3 };
  if (state === 'nonofficial') { settings.providers[0]!.baseUrl = 'https://api.deepseek.com.example/v1'; settings.providers[0]!.allowedOrigins = ['https://api.deepseek.com.example']; }
  if (state === 'provider-disabled') settings.providers[0]!.enabled = false;
  if (state === 'credential-absent') mock.state.snapshot.credentials = [];
  if (state === 'credential-empty') mock.state.snapshot.credentials[0]!.hasValue = false;
  if (state === 'search' || state === 'fetch') settings.presets[0]!.tools.push(`ai.${state}`);
  const original = structuredClone(mock.state.snapshot);
  const upstream: string[] = []; const aiRequests: string[] = [];
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin !== 'http://127.0.0.1:4173' && url.hostname !== 'telegram.org') upstream.push(request.url());
    if (url.pathname.startsWith('/api/ai/')) aiRequests.push(`${request.method()} ${url.pathname}`);
  });
  await openAi(page, false);
  const status = page.getByRole('region', { name: 'Safe runtime status', exact: true });
  await expect(status.getByText(expected, { exact: true })).toBeVisible();
  await expect(status).toContainText('DeepSeek official search needs its own API key');
  await expect(status).toContainText('https://api.deepseek.com');
  await expect(status).not.toContainText('vault:personal-test');
  expect(mock.state.statusReads).toBe(0);
  expect(aiRequests).toEqual(['GET /api/ai/admin']);
  await page.getByRole('button', { name: 'Review search settings', exact: true }).click();
  await expect(page.locator('#root_enabled')).toBeVisible();
  await expect(status.getByText(expected, { exact: true })).toBeVisible();
  await expect.poll(() => [...aiRequests].sort()).toEqual([
    'GET /api/ai/admin', 'GET /api/ai/admin/extensions/status', 'GET /api/ai/admin/tools',
  ]);
  expect(upstream).toEqual([]); expect(mock.state.snapshot).toEqual(original); expect(mock.state.writes).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

for (const [language, title, service, key, model, groups, save] of [
  ['en', 'Set up your AI', 'Service', 'API key', 'Model', 'Also enable selected groups', 'Save and enable'],
  ['zh-CN', '配置你的 AI', '服务商', 'API Key', '模型', '同时启用选定群组', '保存并启用'],
  ['zh-TW', '設定你的 AI', '服務商', 'API Key', '模型', '同時啟用選定群組', '儲存並啟用'],
  ['ja', 'AI を設定する', 'サービス', 'API キー', 'モデル', '選択したグループでも有効にする', '保存して有効にする'],
] as const) test(`${language} setup labels are localized and responsive without loading advanced controls`, async ({ page }) => {
  const mock = await mockAi(page, language);
  await page.goto('/'); await page.getByRole('button', { name: language === 'en' ? 'AI administration' : 'AI 管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
  await expect(page.getByLabel(service, { exact: true })).toBeVisible();
  await expect(page.getByLabel(key, { exact: true })).toHaveValue('');
  await expect(page.getByLabel(model, { exact: true })).toHaveValue('');
  await expect(page.getByText(groups, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: save, exact: true })).toBeDisabled();
  await expect(page.locator('#root_providers, #ai-credential-value')).toHaveCount(0);
  await expect(page.locator('main')).not.toContainText('ai.setup.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(mock.state.statusReads).toBe(0); expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

test('structured provider, preset and grant forms save through a single-use confirmation', async ({ page }) => {
  const mock = await mockAi(page); mock.state.confirm = true;
  await openAi(page);
  await page.locator('#root_providers').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.locator('#root_providers_0_enabled')).not.toBeChecked();
  await page.locator('#root_providers_0_id').fill('native');
  await page.locator('#root_providers_0_protocol').selectOption({ label: 'OpenAI Responses' });
  await page.locator('#root_providers_0_baseUrl').fill('https://api.example.com/v1');
  await page.locator('#root_providers_0_allowedOrigins_0').fill('https://api.example.com');
  await page.locator('#root_providers_0_credentialRef').fill('env:TEST_PROVIDER');
  await page.locator('#root_providers_0_enabled').check();
  await page.locator('#root_presets').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_presets_0_id').fill('daily');
  await page.locator('#root_presets_0_providerId').fill('native');
  await page.locator('#root_presets_0_model').fill('reviewed-model');
  await page.locator('#root_presets_0_inputCapabilities_0').selectOption({ label: 'Text input' });
  await page.locator('#root_presets_0_outputCapabilities_0').selectOption({ label: 'Text answers' });
  for (const [key, value] of Object.entries({ maxInputTokens: 4096, maxOutputTokens: 1024, maxToolCalls: 0, maxDurationMs: 30000, maxCostMicros: 10000 })) await page.locator(`#root_presets_0_budget_${key}`).fill(String(value));
  await page.locator('#root_grants').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_grants_0_id').fill('owner');
  await page.locator('#root_grants_0_kind').selectOption({ label: 'Private user' });
  await page.locator('#root_grants_0_subjectId').fill('42');
  await page.locator('#root_grants_0_presetId').fill('daily');
  await page.locator('#root_grants').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_grants_1_id').fill('group');
  await page.locator('#root_grants_1_kind').selectOption({ label: 'Shared group' });
  await page.locator('#root_grants_1_subjectId').fill('-10042');
  await page.locator('#root_grants_1_presetId').fill('daily');
  await page.locator('#root_deniedUserIds').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_deniedUserIds_0').fill('99');
  await page.locator('#root_enabled').check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('Changes to a processor, permission or budget invalidate affected work and approvals.');
  expect(mock.state.snapshot.settings.enabled).toBe(false);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.providers[0]?.protocol).toBe('openai-responses');
  expect(mock.state.snapshot.settings.presets[0]?.tools).toEqual([]);
  expect(mock.state.snapshot.settings.grants[0]).toMatchObject({ kind: 'private', subjectId: 42, presetId: 'daily' });
  expect(mock.state.snapshot.settings.grants[1]).toMatchObject({ kind: 'group', subjectId: -10042, presetId: 'daily' });
  expect(mock.state.snapshot.settings.deniedUserIds).toEqual([99]);
  expect(mock.state.confirmations).toBe(1);
  mock.assertClean();
});

test('conflicts lock all writes until explicit refresh without blind retry', async ({ page }) => {
  const mock = await mockAi(page);
  await openAi(page);
  await page.locator('#root_limits_maxQueuedRuns').fill('7');
  mock.state.failure = 'CONFLICT';
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert').first()).toContainText('changed elsewhere');
  await expect(page.locator('#root_limits_maxQueuedRuns')).toBeDisabled();
  expect(mock.state.writes).toBe(1);
  mock.state.failure = ''; mock.state.snapshot.revision = 2; mock.state.snapshot.settings.limits.maxQueuedRuns = 4;
  await page.getByRole('button', { name: 'Reload latest data', exact: true }).first().click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await openAdvanced(page);
  await expect(page.locator('#root_limits_maxQueuedRuns')).toHaveValue('4');
  expect(mock.state.reads).toBe(2); expect(mock.state.writes).toBe(1);
  mock.assertClean();
});

test('reviewed MCP scopes and remote executors use structured controls without enabling local execution', async ({ page }) => {
  const mock = await mockAi(page);
  mock.state.snapshot.settings.mcp = [];
  mock.state.snapshot.settings.sandbox = { enabled: false, profiles: [] };
  await openAi(page);
  await page.locator('#root_mcp').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_mcp_0_id').fill('reviewed');
  await page.locator('#root_mcp_0_endpoint').fill('https://mcp.example.com/rpc');
  await page.locator('#root_mcp_0_allowedOrigins_0').fill('https://mcp.example.com');
  await page.locator('#root_mcp_0_credentialAuthority').selectOption({ label: 'Owner-only authority' });
  await page.locator('#root_mcp_0_credentialRef').fill('vault:owner');
  await page.locator('#root_mcp').getByRole('button', { name: 'Add optional data', exact: true }).click();
  await page.locator('#root_mcp_0_scope_botId').fill('9001');
  await page.locator('#root_mcp_0_scope_ownerId').fill('42');
  await page.locator('#root_mcp').getByLabel('Audience', { exact: true }).selectOption({ label: 'Shared group' });
  await page.locator('#root_mcp_0_scope_audience_kind').selectOption({ label: 'Shared group' });
  await page.locator('#root_mcp_0_scope_audience_chatId').fill('-10042');
  await page.locator('#root_mcp_0_enabled').check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Check the fields');
  expect(mock.state.writes).toBe(0);
  await page.locator('#root_mcp_0_schemaDigest').fill('a'.repeat(64));

  await page.locator('#root_sandbox_profiles').getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator('#root_sandbox_profiles_0_id').fill('remote');
  await page.locator('#root_sandbox_profiles_0_endpoint').fill('https://executor.example.com/run');
  await page.locator('#root_sandbox_profiles_0_allowedOrigins_0').fill('https://executor.example.com');
  await page.locator('#root_sandbox_profiles_0_credentialAuthority').selectOption({ label: 'Reviewed service authority' });
  await page.locator('#root_sandbox_profiles').getByRole('button', { name: 'Add optional data', exact: true }).click();
  await page.locator('#root_sandbox_profiles_0_scope_botId').fill('9001');
  await page.locator('#root_sandbox_profiles_0_scope_ownerId').fill('42');
  await page.locator('#root_sandbox_profiles_0_scope_audience_kind').selectOption({ label: 'Private user' });
  await page.locator('#root_sandbox_profiles_0_scope_audience_userId').fill('42');
  await page.locator('#root_sandbox_profiles_0_languages_0').selectOption({ label: 'Python' });
  await page.locator('#root_sandbox_profiles_0_reviewedDigest').fill('b'.repeat(64));
  for (const [key, value] of Object.entries({ memoryBytes: 8 * 1024 * 1024, cpuMs: 1000, pids: 1, outputBytes: 1024, tempBytes: 1024, wallMs: 2000 })) await page.locator(`#root_sandbox_profiles_0_limits_${key}`).fill(String(value));
  await page.locator('#root_sandbox_profiles_0_enabled').check();
  await page.locator('#root_sandbox_enabled').check();
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.mcp?.[0]?.scope?.audience).toEqual({ kind: 'group', chatId: -10042 });
  expect(mock.state.snapshot.settings.sandbox?.profiles[0]?.scope?.audience).toEqual({ kind: 'private', userId: 42 });
  expect(mock.state.snapshot.sandbox.qualified).toBe(false);
  await page.getByText('Optional local code execution', { exact: true }).click();
  await expect(page.getByText('Local sandbox is not qualified.', { exact: false })).toBeVisible();
  await expect(page.locator('main')).not.toContainText('ai.fields.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('write-only credentials clear on submit, navigation, logout and never enter browser storage', async ({ page }) => {
  const mock = await mockAi(page);
  await openAi(page);
  const value = page.getByLabel('New credential value', { exact: true });
  await page.getByLabel('Vault reference', { exact: true }).fill('vault:provider');
  await value.fill('test-only-write-only-value');
  await page.getByRole('button', { name: 'Replace credential', exact: true }).click();
  await expect(value).toHaveValue('');
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.replacements).toBe(1);
  expect(JSON.stringify(mock.state.snapshot)).not.toContain('test-only-write-only-value');
  await page.getByRole('button', { name: 'Delete credential', exact: true }).click();
  expect(mock.state.deletions).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Delete credential', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Write-only credentials', exact: true }).getByText('Not configured', { exact: false })).toBeVisible();
  expect(mock.state.deletions).toBe(1);
  await value.fill('test-only-write-only-value');
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await expect(value).toHaveValue('');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await value.fill('test-only-write-only-value');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(value).toHaveValue('');
  expect(await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) }))).toEqual({ local: [], session: [] });
  await page.getByRole('dialog').getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  await expect(value).toHaveCount(0);
  mock.assertClean();
});

test('uncertain credential writes clear the secret and require refresh instead of replay', async ({ page }) => {
  const mock = await mockAi(page); mock.state.failure = 'OUTCOME_UNKNOWN';
  await openAi(page);
  await page.getByLabel('Vault reference', { exact: true }).fill('vault:provider');
  await page.getByLabel('New credential value', { exact: true }).fill('test-only-write-only-value');
  await page.getByRole('button', { name: 'Replace credential', exact: true }).click();
  await expect(page.getByLabel('New credential value', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('New credential value', { exact: true })).toBeDisabled();
  await expect(page.getByRole('alert')).toContainText('The result is uncertain');
  expect(mock.state.writes).toBe(1); expect(mock.state.replacements).toBe(0);
  mock.state.failure = '';
  await page.getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await openAdvanced(page);
  await expect(page.getByLabel('New credential value', { exact: true })).toHaveValue('');
  await expect(page.getByRole('button', { name: 'Replace credential', exact: true })).toBeDisabled();
  expect(mock.state.writes).toBe(1);
  mock.assertClean();
});

test('expired approvals require a fresh snapshot and disabling AI requires explicit confirmation', async ({ page }) => {
  const mock = await mockAi(page); mock.state.confirm = true; mock.state.snapshot.settings.enabled = true;
  await openAi(page);
  await page.getByRole('button', { name: 'Disable AI', exact: true }).click();
  expect(mock.state.writes).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Disable AI', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('one-time server approval');
  mock.state.failure = 'CONFIRMATION_EXPIRED';
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('expired or was already used');
  await expect(page.getByRole('button', { name: 'Disable AI', exact: true })).toBeDisabled();
  expect(mock.state.confirmations).toBe(1);
  mock.state.failure = ''; mock.state.confirm = false;
  await page.getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data', exact: true }).click();
  await page.getByRole('button', { name: 'Disable AI', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Disable AI', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Disable AI', exact: true })).toBeDisabled();
  expect(mock.state.snapshot.settings.enabled).toBe(false);
  expect(mock.state.confirmations).toBe(1);
  mock.assertClean();
});

test('authentication expiry clears credentials and hides AI administration', async ({ page }) => {
  const mock = await mockAi(page);
  await openAi(page);
  await page.getByLabel('Vault reference', { exact: true }).fill('vault:provider');
  await page.getByLabel('New credential value', { exact: true }).fill('test-only-write-only-value');
  mock.baseState.expired = true;
  await page.getByRole('button', { name: 'Replace credential', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  await expect(page.getByLabel('New credential value', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'AI administration', exact: true })).toHaveCount(0);
  expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

test('non-administrators never receive AI navigation or fetch an AI snapshot', async ({ page }) => {
  const mock = await mockAi(page);
  await page.route('**/api/me', route => route.fulfill({ status: 403, json: { error: { code: 'FORBIDDEN' } } }));
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'AI administration', exact: true })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  expect(mock.state.reads).toBe(0);
  mock.assertClean();
});

test('missing encrypted storage exposes status but keeps mutations unavailable', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot.status.available = false;
  await openAi(page);
  await expect(page.getByLabel('API key', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save and enable', exact: true })).toBeDisabled();
  await expect(page.getByText('The encrypted AI store is not open.', { exact: false })).toBeVisible();
  await expect(page.locator('#root_enabled')).toBeDisabled();
  await expect(page.getByLabel('New credential value', { exact: true })).toBeDisabled();
  await page.getByText('Open extension workflows', { exact: true }).click();
  await expect(page.getByRole('button', { name: 'Preview request', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check local qualification', exact: true })).toBeDisabled();
  expect(mock.state.statusReads).toBe(0);
  expect(mock.state.writes).toBe(0);
  mock.assertClean();
});

test('AI HTTP routes reject unauthenticated access before executing an Action', async ({ request }) => {
  for (const [method, path] of [['GET', '/api/ai/admin'], ['PUT', '/api/ai/admin'], ['POST', '/api/ai/setup'], ['POST', '/api/ai/disable'], ['POST', '/api/ai/credentials'], ['GET', '/api/ai/admin/extensions/status'], ...['skills/install', 'skills/review', 'mcp/discover', 'sandbox/review', 'sandbox/local/review', 'sandbox/local/probe', 'mcp/stdio/discover'].map(path => ['POST', `/api/ai/admin/extensions/${path}`])]) {
    const response = await request.fetch(path!, { method, ...(method === 'GET' ? {} : { data: {} }) });
    expect(response.status()).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: 'UNAUTHORIZED' } });
  }
});

for (const language of ['zh-CN', 'zh-TW', 'ja'] as const) test(`${language} AI form labels and safety notices are localized`, async ({ page }) => {
  const mock = await mockAi(page, language);
  await page.goto('/'); await page.getByRole('button', { name: 'AI 管理', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'AI 管理', exact: true })).toBeVisible();
  await openAdvanced(page);
  await expect(page.locator('#ai-credential-value')).toHaveValue('');
  await expect(page.locator('main')).not.toContainText('ai.fields.');
  await expect(page.locator('main')).not.toContainText('ai.help.');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

async function openExtensions(page: Page) {
  await openAi(page);
  await page.getByText('Open extension workflows', { exact: true }).click();
  await expect(page.getByLabel('Workflow', { exact: true })).toBeEnabled();
}
async function privateScope(page: Page, prefix: string) {
  if (!await page.locator(`#${prefix}_botId`).count()) await page.locator(`#${prefix.slice(0, -2)}`).getByRole('button', { name: 'Add', exact: true }).click();
  await page.locator(`#${prefix}_botId`).fill('9001');
  await page.locator(`#${prefix}_ownerId`).fill('42');
  await page.locator(`#${prefix}_audience_kind`).selectOption({ label: 'Private user' });
  await page.locator(`#${prefix}_audience_userId`).fill('42');
}
function mcpProfile() {
  return aiMcpReviewInputSchema.parse({ profile: { id: 'reviewed', enabled: false, endpoint: 'https://mcp.example.com/rpc', allowedOrigins: ['https://mcp.example.com'], credentialAuthority: 'owner', credentialRef: 'vault:provider', tools: [], readTools: [], scope: { botId: 9001, ownerId: 42, audience: { kind: 'group', chatId: -10042, threadId: 7 } } } }).profile;
}

test('skill upload needs one server approval and enables the exact reviewed version through settings', async ({ page, context }, info) => {
  const mock = await mockAi(page); mock.state.snapshot.settings.skills = [];
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await openExtensions(page);
  const source = '---\nname: reviewed-skill\ndescription: Test only\n---\n<img src=x onerror=alert(1)>\n';
  await page.locator('#extension_id').fill('reviewed-skill');
  await page.locator('#extension_files_0_text-upload').setInputFiles({ name: 'SKILL.md', mimeType: 'text/markdown', buffer: Buffer.from(source) });
  await expect(page.locator('#extension_files_0_text')).toHaveValue(source);
  await privateScope(page, 'extension_scopes_0');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByRole('dialog')).toContainText('9001');
  await expect(page.getByRole('dialog')).toContainText('42');
  await expect(page.getByRole('dialog').locator('img, script, svg')).toHaveCount(0);
  expect(mock.state.extensionRequests).toBe(1);
  expect(mock.state.confirmations).toBe(0);
  expect(mock.state.extensionInputs).toEqual([{ path: '/api/ai/admin/extensions/skills/install', body: { id: 'reviewed-skill', files: [{ path: 'SKILL.md', text: source }], tools: [], scopes: [{ botId: 9001, ownerId: 42, audience: { kind: 'private', userId: 42 } }] } }]);
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('does not enable the skill');
  expect(mock.state.installs).toBe(0);
  if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-ai-extension-approval-${info.project.name}.png` });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  const result = page.getByRole('region', { name: 'Read-only review result', exact: true });
  await expect(result).toBeVisible();
  await expect(result).toContainText('SKILL.md');
  await expect(result).toContainText('<script>window.bad=true</script>');
  await expect(result.locator('img, script, svg')).toHaveCount(0);
  if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-ai-extension-${info.project.name}.png`, fullPage: true });
  expect(mock.state.installs).toBe(1); expect(mock.state.writes).toBe(0);
  expect(mock.state.snapshot.settings.skills).toEqual([]);
  await page.getByRole('button', { name: 'Copy reviewed digest', exact: true }).click();
  await expect(page.getByText('Digest copied. Settings have not changed.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('d'.repeat(64));
  mock.state.confirm = true;
  await page.getByRole('button', { name: 'Enable reviewed version', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('Changes to a processor, permission or budget invalidate affected work and approvals.');
  expect(mock.state.writes).toBe(1);
  expect(mock.state.snapshot.settings.skills).toEqual([]);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  expect(mock.state.snapshot.settings.skills).toEqual([{ id: 'reviewed-skill', enabled: true, digest: 'd'.repeat(64), tools: [], scopes: [{ botId: 9001, ownerId: 42, audience: { kind: 'private', userId: 42 } }] }]);
  expect(mock.state.snapshot.revision).toBe(2);
  expect(mock.state.confirmations).toBe(2);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('MCP discovery previews credential scope and every changed endpoint needs a new approval', async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot.settings.mcp = [mcpProfile()];
  await openExtensions(page);
  await page.getByLabel('Workflow', { exact: true }).selectOption('mcp');
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByLabel('Saved profile', { exact: true }).selectOption('reviewed');
  await page.getByRole('button', { name: 'Load a copy for review', exact: true }).click();
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('https://mcp.example.com/rpc');
  await expect(page.getByRole('dialog')).toContainText('vault:provider');
  await expect(page.getByRole('dialog')).toContainText('-10042');
  await expect(page.getByRole('dialog')).toContainText('7');
  expect(mock.state.discoveries).toBe(0);
  expect(mock.state.extensionRequests).toBe(1);
  expect(mock.state.extensionInputs[0]).toEqual({ path: '/api/ai/admin/extensions/mcp/discover', body: { profile: mcpProfile() } });
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(page.getByRole('dialog')).toContainText('may send its configured credential');
  expect(mock.state.discoveries).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  const result = page.getByRole('region', { name: 'Read-only review result', exact: true });
  await expect(result).toContainText('<svg onload=alert(1)>');
  await expect(result.locator('img, script, svg')).toHaveCount(0);
  await expect(page.locator('#ai-review-digest')).toHaveValue('a'.repeat(64));
  expect(mock.state.snapshot.settings.mcp?.[0]?.enabled).toBe(false);
  expect(mock.state.writes).toBe(0);
  await page.locator('#extension_profile_endpoint').fill('https://changed.example.com/rpc');
  await expect(result).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable reviewed version', exact: true })).toHaveCount(0);
  await page.locator('#extension_profile_allowedOrigins_0').fill('https://changed.example.com');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('https://changed.example.com/rpc');
  expect(mock.state.discoveries).toBe(1);
  expect(mock.state.extensionRequests).toBe(2);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#ai-review-digest')).toHaveValue('b'.repeat(64));
  expect(mock.state.discoveries).toBe(2); expect(mock.state.confirmations).toBe(2);
  expect(mock.state.snapshot.settings.mcp?.[0]?.endpoint).toBe('https://mcp.example.com/rpc');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('text uploads reject binary and oversized requests before network access', async ({ page }) => {
  const mock = await mockAi(page); await openExtensions(page);
  await page.locator('#extension_id').fill('reviewed-skill');
  await privateScope(page, 'extension_scopes_0');
  await page.locator('#extension_files_0_text-upload').setInputFiles({ name: 'binary.txt', mimeType: 'text/plain', buffer: Buffer.from([0, 255]) });
  await expect(page.getByRole('alert')).toContainText('valid UTF-8 text file');
  await page.locator('#extension_files_0_text-upload').setInputFiles({ name: 'large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(32_769, 65) });
  await expect(page.getByRole('alert')).toContainText('no larger than 32 KiB');
  await page.locator('#extension_files_0_text').fill('"'.repeat(20_000));
  await expect(page.locator('#root_limits_maxQueuedRuns')).toBeDisabled();
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('complete UTF-8 JSON request');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(mock.state.extensionRequests).toBe(0);
  mock.assertClean();
});

test('extension status failure and missing storage keep every workflow disabled', async ({ page }) => {
  const mock = await mockAi(page); mock.state.statusFailure = 'UNAVAILABLE';
  await openAi(page);
  await page.getByText('Open extension workflows', { exact: true }).click();
  await expect(page.getByLabel('Workflow', { exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Preview request', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Check local qualification', exact: true })).toBeDisabled();
  mock.state.statusFailure = '';
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByLabel('Workflow', { exact: true })).toBeEnabled();
  expect(mock.state.extensionRequests).toBe(0);
  mock.assertClean();
});

for (const code of ['CSRF_INVALID', 'CONFIRMATION_EXPIRED', 'OUTCOME_UNKNOWN']) test(`extension ${code} keeps effects blocked until explicit reload`, async ({ page }) => {
  const mock = await mockAi(page); mock.state.snapshot.settings.mcp = [mcpProfile()];
  await openExtensions(page);
  await page.getByLabel('Workflow', { exact: true }).selectOption('mcp');
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByLabel('Saved profile', { exact: true }).selectOption('reviewed');
  await page.getByRole('button', { name: 'Load a copy for review', exact: true }).click();
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  if (code === 'CSRF_INVALID') mock.state.failure = code;
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  if (code !== 'CSRF_INVALID') {
    await expect(page.getByRole('dialog')).toHaveCount(1);
    mock.state.failure = code; await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  }
  await expect(page.getByRole('alert')).toContainText('Reload and inspect');
  await expect(page.getByRole('button', { name: 'Preview request', exact: true })).toBeDisabled();
  expect(mock.state.discoveries).toBe(0); expect(mock.state.extensionRequests).toBe(1);
  mock.assertClean();
});

test('installed skill and remote profile reviews use CSRF POST without activation or write approval', async ({ page }) => {
  const mock = await mockAi(page);
  mock.state.installed = { id: 'reviewed-skill', files: [{ path: 'SKILL.md', text: '<b>reference only</b>' }], tools: [], scopes: [{ botId: 9001, ownerId: 42, audience: { kind: 'private', userId: 42 } }] };
  mock.state.snapshot.settings.sandbox = { enabled: false, profiles: [{ id: 'remote', enabled: false, endpoint: 'https://executor.example.com/run', allowedOrigins: ['https://executor.example.com'], credentialAuthority: 'service', scope: { botId: 9001, ownerId: 42, audience: { kind: 'private', userId: 42 } }, languages: ['python'], limits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 1000, pids: 1, outputBytes: 1024, tempBytes: 4096, wallMs: 2000 } }] };
  await openExtensions(page);
  await page.getByLabel('Workflow', { exact: true }).selectOption('skill');
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.locator('#extension_id').fill('reviewed-skill');
  await page.locator('#extension_digest').fill('d'.repeat(64));
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.locator('#ai-review-digest')).toHaveValue('d'.repeat(64));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(mock.state.confirmations).toBe(0); expect(mock.state.installs).toBe(0);
  await page.getByLabel('Workflow', { exact: true }).selectOption('sandbox');
  await page.getByLabel('Saved profile', { exact: true }).selectOption('remote');
  await page.getByRole('button', { name: 'Load a copy for review', exact: true }).click();
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.locator('#ai-review-digest')).toHaveValue('f'.repeat(64));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Read-only review result', exact: true })).toContainText('https://executor.example.com/run');
  await expect(page.getByRole('region', { name: 'Read-only review result', exact: true })).toContainText('does not run code');
  expect(mock.state.snapshot.settings.sandbox.enabled).toBe(false);
  expect(mock.state.confirmations).toBe(0); expect(mock.state.writes).toBe(0);
  expect(mock.state.extensionRequests).toBe(2);
  mock.assertClean();
});

test('extension protocol violations never bypass the required server approval', async ({ page }) => {
  const mock = await mockAi(page); mock.state.skipExtensionApproval = true;
  await openExtensions(page);
  await page.locator('#extension_id').fill('reviewed-skill');
  await page.locator('#extension_files_0_text').fill('reference');
  await privateScope(page, 'extension_scopes_0');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('invalid result');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Preview request', exact: true })).toBeDisabled();
  await expect(page.locator('#ai-review-digest')).toHaveCount(0);
  expect(mock.state.writes).toBe(0); expect(mock.state.confirmations).toBe(0);
  mock.assertClean();
});

function localProfile() {
  return aiLocalSandboxReviewInputSchema.parse({ profile: { id: 'local', enabled: false, runtime: 'node', scope: { botId: 9001, ownerId: 42, audience: { kind: 'group', chatId: -10042, threadId: 7 } }, limits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 1000, pids: 1, outputBytes: 1024, tempBytes: 4096, wallMs: 2000 } } }).profile;
}
function stdioProfile() {
  return aiStdioMcpReviewInputSchema.parse({ profile: { ...localProfile(), id: 'stdio', bundle: { id: 'reviewed-skill', digest: 'd'.repeat(64), entrypoint: 'worker.js', inputs: ['fixtures/data.json'], args: ['<img src=x onerror=alert(1)>'] }, tools: ['read'], readTools: ['read'] } }).profile;
}
async function loadWorkflow(page: Page, kind: string, id: string) {
  await page.getByLabel('Workflow', { exact: true }).selectOption(kind);
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByLabel('Saved profile', { exact: true }).selectOption(id);
  await page.getByRole('button', { name: 'Load a copy for review', exact: true }).click();
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
}

test('fixed local probes accept no parameters and report compiler or cgroup refusal without enabling profiles', async ({ page }) => {
  const mock = await mockAi(page); const settings = structuredClone(mock.state.snapshot.settings);
  await openAi(page);
  await expect(page.getByRole('button', { name: 'Check local qualification', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Check local qualification', exact: true }).click();
  const result = page.getByRole('region', { name: 'Fixed local probe result', exact: true });
  await expect(result).toContainText('Not qualified. No profile was enabled');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(mock.state.extensionInputs).toEqual([{ path: '/api/ai/admin/extensions/sandbox/local/probe', body: {} }]);
  await expect(result).toContainText('C_COMPILER_UNAVAILABLE');
  expect(mock.state.localProbes).toBe(1); expect(mock.state.confirmations).toBe(0);
  await page.getByText('Open extension workflows', { exact: true }).click();
  await page.getByLabel('Workflow', { exact: true }).selectOption('probe');
  if (await page.getByRole('dialog').count()) await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  mock.state.probeReason = 'CGROUP_DELEGATION_FAILED';
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(result).toContainText('CGROUP_DELEGATION_FAILED');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(result).toContainText('Not qualified. No profile was enabled');
  await expect(page.locator('#ai-review-digest')).toHaveCount(0);
  expect(mock.state.localProbes).toBe(2); expect(mock.state.writes).toBe(0); expect(mock.state.discoveries).toBe(0);
  expect(mock.state.snapshot.settings).toEqual(settings);
  expect(mock.state.snapshot.revision).toBe(1);
  mock.assertClean();
});

test('local profile review shows exact scope and policy pin but does not probe or activate', async ({ page }) => {
  const mock = await mockAi(page); const profile = localProfile();
  mock.state.snapshot.settings.sandbox = { enabled: false, profiles: [], localProfiles: [profile] };
  await openExtensions(page); await loadWorkflow(page, 'local', 'local');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  const result = page.getByRole('region', { name: 'Read-only review result', exact: true });
  await expect(page.locator('#ai-review-digest')).toHaveValue('9'.repeat(64));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(result).toContainText('9001');
  await expect(result).toContainText('-10042');
  await expect(result).toContainText('"tempBytes": 4096');
  await expect(result).toContainText('"policyHash": "' + '8'.repeat(64) + '"');
  await expect(result).toContainText('does not run code');
  expect(mock.state.localReviews).toBe(1); expect(mock.state.confirmations).toBe(0); expect(mock.state.localProbes).toBe(0); expect(mock.state.writes).toBe(0);
  expect(mock.state.snapshot.settings.sandbox.localProfiles?.[0]).toEqual(profile);
  expect(mock.state.snapshot.settings.sandbox.enabled).toBe(false);
  await expect(page.getByRole('button', { name: 'Enable reviewed version', exact: true })).toBeDisabled();
  expect(mock.state.extensionInputs).toEqual([{ path: '/api/ai/admin/extensions/sandbox/local/review', body: { profile } }]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('stdio discovery confirms the exact installed bundle and changed arguments without autoactivation', async ({ page }) => {
  const mock = await mockAi(page); const profile = stdioProfile();
  mock.state.snapshot.settings.sandbox = { enabled: false, profiles: [], stdioProfiles: [profile] };
  await openExtensions(page); await loadWorkflow(page, 'stdio', 'stdio');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('inside a qualified local sandbox');
  await expect(page.getByRole('dialog')).toContainText('worker.js');
  await expect(page.getByRole('dialog')).toContainText('fixtures/data.json');
  await expect(page.getByRole('dialog')).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.getByRole('dialog').locator('img, script, svg')).toHaveCount(0);
  await expect(page.getByRole('dialog')).toContainText('inherited credentials/environment');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(mock.state.extensionInputs).toEqual([{ path: '/api/ai/admin/extensions/mcp/stdio/discover', body: { profile } }]);
  expect(mock.state.stdioDiscoveries).toBe(0);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  const result = page.getByRole('region', { name: 'Read-only review result', exact: true });
  await expect(page.locator('#ai-review-digest')).toHaveValue('6'.repeat(64));
  await expect(result).toContainText('<svg onload=alert(1)>');
  await expect(result.locator('img, script, svg')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable reviewed version', exact: true })).toBeDisabled();
  await page.locator('#extension_profile_bundle_args_0').fill('changed');
  await expect(result).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Enable reviewed version', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(mock.state.stdioDiscoveries).toBe(1);
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.locator('#ai-review-digest')).toHaveValue('7'.repeat(64));
  expect(mock.state.stdioDiscoveries).toBe(2); expect(mock.state.confirmations).toBe(2);
  expect(mock.state.writes).toBe(0); expect(mock.state.discoveries).toBe(0); expect(mock.state.localProbes).toBe(0);
  expect(mock.state.snapshot.settings.sandbox.stdioProfiles?.[0]).toEqual(profile);
  expect(mock.state.snapshot.settings.sandbox.enabled).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  mock.assertClean();
});

test('unqualified stdio discovery refuses after approval and never falls back remotely', async ({ page }) => {
  const mock = await mockAi(page); mock.state.stdioFailure = 'UNAVAILABLE';
  mock.state.snapshot.settings.sandbox = { enabled: false, profiles: [], stdioProfiles: [stdioProfile()] };
  await openExtensions(page); await loadWorkflow(page, 'stdio', 'stdio');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('temporarily unavailable');
  await expect(page.getByRole('button', { name: 'Preview request', exact: true })).toBeDisabled();
  await expect(page.locator('#ai-review-digest')).toHaveCount(0);
  expect(mock.state.extensionRequests).toBe(1); expect(mock.state.stdioDiscoveries).toBe(0); expect(mock.state.discoveries).toBe(0); expect(mock.state.writes).toBe(0);
  expect(mock.state.snapshot.settings.sandbox.enabled).toBe(false);
  mock.assertClean();
});

test('activating one reviewed remote executor does not revive sibling profiles behind a disabled global switch', async ({ page }) => {
  const mock = await mockAi(page); mock.state.confirm = true;
  const remote = aiSandboxReviewInputSchema.parse({ profile: { id: 'remote', enabled: false, endpoint: 'https://executor.example.com/run',
    allowedOrigins: ['https://executor.example.com'], credentialAuthority: 'service',
    scope: { botId: 9001, ownerId: 42, audience: { kind: 'private', userId: 42 } }, languages: ['python'],
    limits: { memoryBytes: 8 * 1024 * 1024, cpuMs: 1000, pids: 1, outputBytes: 1024, tempBytes: 4096, wallMs: 2000 } } }).profile;
  mock.state.snapshot.settings.sandbox = { enabled: false,
    profiles: [remote, { ...remote, id: 'previous-remote', enabled: true, reviewedDigest: '1'.repeat(64) }],
    localProfiles: [{ ...localProfile(), enabled: true, reviewedDigest: '2'.repeat(64) }],
    stdioProfiles: [{ ...stdioProfile(), enabled: true, schemaDigest: '3'.repeat(64) }],
  };
  const original = structuredClone(mock.state.snapshot.settings.sandbox);
  await openExtensions(page); await loadWorkflow(page, 'sandbox', 'remote');
  await page.getByRole('button', { name: 'Preview request', exact: true }).click();
  await expect(page.locator('#ai-review-digest')).toHaveValue('f'.repeat(64));
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(mock.state.writes).toBe(0); expect(mock.state.confirmations).toBe(0);
  expect(mock.state.extensionInputs).toEqual([{ path: '/api/ai/admin/extensions/sandbox/review', body: { profile: remote } }]);
  await expect(page.getByRole('button', { name: 'Enable reviewed version', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Enable reviewed version', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(1);
  expect(mock.state.snapshot.settings.sandbox).toEqual(original);
  expect(mock.state.pending?.settings.sandbox).toEqual({ enabled: true,
    profiles: [{ ...remote, enabled: true, reviewedDigest: 'f'.repeat(64) }, { ...original.profiles[1], enabled: false }],
    localProfiles: original.localProfiles!.map(profile => ({ ...profile, enabled: false })),
    stdioProfiles: original.stdioProfiles!.map(profile => ({ ...profile, enabled: false })),
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Changes saved.', { exact: true })).toBeVisible();
  const saved = mock.state.snapshot.settings.sandbox;
  expect(saved.enabled).toBe(true);
  expect(saved.profiles.filter(profile => profile.enabled).map(profile => profile.id)).toEqual(['remote']);
  expect(saved.localProfiles!.every(profile => !profile.enabled)).toBe(true);
  expect(saved.stdioProfiles!.every(profile => !profile.enabled)).toBe(true);
  expect(mock.state.writes).toBe(1); expect(mock.state.confirmations).toBe(1);
  expect(mock.state.localProbes).toBe(0); expect(mock.state.stdioDiscoveries).toBe(0); expect(mock.state.discoveries).toBe(0);
  mock.assertClean();
});
