import { test, expect } from '@playwright/test';
import { mockApi } from './mock.js';
import { languagePreferences, supportedLocales } from '../../shared/schemas/index.js';

for (const [scheme, palette] of Object.entries({
  light: { bg: '#efe8dc', surface: '#faf6ee', accent: '#52684a', danger: '#845b4f' },
  dark: { bg: '#232a2c', surface: '#2c3436', accent: '#aabd99', danger: '#d0a28c' },
})) {
  test(`${scheme} Sisters-inspired Morandi palette keeps controls, text and states readable`, async ({ page }, testInfo) => {
    const mock = await mockApi(page);
    await page.goto('/');
    await page.getByLabel('Appearance').selectOption(scheme);
    const colors = await page.locator('html').evaluate(element => {
      const css = getComputedStyle(element);
      return Object.fromEntries(['bg', 'surface', 'subtle', 'text', 'muted', 'accent', 'accent-hover', 'accent-soft',
        'danger', 'danger-hover', 'danger-soft', 'control-line', 'focus'].map(name => [name, css.getPropertyValue(`--${name}`).trim()]));
    });
    expect(colors).toMatchObject(palette);
    const rgb = (hex: string) => `rgb(${hex.slice(1).match(/../g)!.map(value => parseInt(value, 16)).join(', ')})`;
    const luminance = (hex: string) => {
      const channels = hex.slice(1).match(/../g)!.map(value => parseInt(value, 16) / 255)
        .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
      return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
    };
    for (const [foreground, background, minimum] of [
      ['text', 'bg', 4.5], ['text', 'surface', 4.5], ['muted', 'subtle', 4.5],
      ['accent', 'accent-soft', 4.5], ['danger', 'danger-soft', 4.5],
      ['surface', 'accent', 4.5], ['surface', 'accent-hover', 4.5],
      ['surface', 'danger', 4.5], ['surface', 'danger-hover', 4.5],
      ['control-line', 'surface', 3], ['control-line', 'bg', 3], ['control-line', 'subtle', 3],
      ['focus', 'bg', 3], ['focus', 'surface', 3],
    ] as const) {
      const first = luminance(colors[foreground]!); const second = luminance(colors[background]!);
      expect((Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05), `${scheme}: ${foreground}/${background}`).toBeGreaterThanOrEqual(minimum);
    }
    await expect(page.locator('body')).toHaveCSS('background-color', rgb(palette.bg));
    await expect(page.locator('.workspace')).toHaveCSS('background-color', rgb(palette.surface));
    await expect(page.locator('.state-running')).toHaveCSS('color', rgb(palette.accent));
    await expect(page.locator('.state-failed')).toHaveCSS('color', rgb(palette.danger));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-sisters-${testInfo.project.name}-${scheme}.png`, fullPage: true });
    await page.getByRole('button', { name: 'Groups', exact: true }).click();
    await page.getByLabel('Telegram chat ID', { exact: true }).fill('-1009876543210');
    const primary = page.locator('.authorize-form button.primary');
    await expect(primary).toHaveCSS('background-color', rgb(palette.accent));
    await primary.hover();
    await expect(primary).toHaveCSS('background-color', rgb(colors['accent-hover']!));
    await page.getByRole('button', { name: 'Revoke access', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await page.mouse.move(0, 0);
    const danger = dialog.locator('button.danger');
    await expect(danger).toHaveCSS('background-color', rgb(palette.danger));
    await danger.hover();
    await expect(danger).toHaveCSS('background-color', rgb(colors['danger-hover']!));
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).focus();
    await page.keyboard.press('Tab');
    await expect(danger).toBeFocused();
    await expect(danger).toHaveCSS('outline-color', rgb(colors.focus!));
    if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-sisters-${testInfo.project.name}-${scheme}-dialog.png`, fullPage: true });
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    mock.assertClean();
  });
}

test('browser dashboard reports independent runtime states and stays responsive', async ({ page }, testInfo) => {
  const mock = await mockApi(page);
  const response = await page.goto('/');
  expect(response?.headers()['content-security-policy']).toContain("script-src 'self' https://telegram.org 'unsafe-eval'");
  await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
  await expect(page.getByRole('row', { name: 'HTTP server Running' })).toBeVisible();
  await expect(page.getByRole('row', { name: 'Telegram polling Failed' })).toBeVisible();
  await expect(page.getByText('1,482')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.MISAKA_CAPTURE_UI) await page.screenshot({ path: `/tmp/kilo/misaka-ui-${testInfo.project.name}.png`, fullPage: true });
  await page.getByLabel('Appearance').selectOption('dark');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Appearance').selectOption('light');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByLabel('Appearance').selectOption('auto');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No modules to display' })).toBeVisible();
  await expect(page.getByRole('button', { name: /activate|enable/i })).toHaveCount(0);
  mock.assertClean();
});

test('language preference is saved, translates settings and follows the user', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Preferences', exact: true }).click();
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.getByText('更改已保存。')).toBeVisible();
  await page.getByRole('button', { name: '核心设置', exact: true }).click();
  await expect(page.getByLabel('实例语言')).toBeVisible();
  await expect(page.getByRole('option', { name: '简体中文' })).toBeAttached();
  await page.getByLabel('实例语言').selectOption({ label: '简体中文' });
  await page.getByRole('button', { name: '保存更改' }).click();
  await expect(page.getByText('更改已保存。')).toBeVisible();
  expect(mock.state.language).toBe('zh-CN');
  expect(mock.state.snapshot.saved.defaultLanguage).toBe('zh-CN');
  mock.assertClean();
});

for (const language of [
  { locale: 'zh-TW', browser: 'zh-Hant-HK', preferences: '個人偏好', language: '語言', name: '繁體中文', settings: '核心設定', instance: '執行個體語言', save: '儲存變更', saved: '變更已儲存。', login: '使用 Telegram 登入', modules: '模組', configure: '設定', label: '標籤', invalid: '至少輸入 3 個字元。', add: '新增', up: '上移', secret: '清除已儲存的密鑰', clear: '清除此密鑰？' },
  { locale: 'ja', browser: 'ja-JP', preferences: '個人設定', language: '言語', name: '日本語', settings: 'コア設定', instance: 'インスタンスの言語', save: '変更を保存', saved: '変更を保存しました。', login: 'Telegram でログイン', modules: 'モジュール', configure: '設定', label: 'ラベル', invalid: '3 文字以上で入力してください。', add: '追加', up: '上へ移動', secret: '保存済みシークレットを削除', clear: 'このシークレットを削除しますか？' },
] as const) {
  test(`${language.locale} preference persists and core language choices stay in sync`, async ({ page }) => {
    const mock = await mockApi(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Preferences', exact: true }).click();
    const preference = page.getByLabel('Language', { exact: true });
    expect(await preference.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual([...languagePreferences]);
    await preference.selectOption(language.locale);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
    await expect(page.getByText(language.saved)).toBeVisible();
    await page.getByRole('button', { name: language.settings, exact: true }).click();
    const instance = page.getByLabel(language.instance);
    await expect(instance.locator('option:not([value=""])')).toHaveCount(supportedLocales.length);
    await instance.selectOption({ label: language.name });
    await page.getByRole('button', { name: language.save }).click();
    await expect(page.getByText(language.saved)).toBeVisible();
    expect(mock.state.language).toBe(language.locale);
    expect(mock.state.snapshot.saved.defaultLanguage).toBe(language.locale);
    await page.reload();
    await page.getByRole('button', { name: language.preferences, exact: true }).click();
    await expect(page.getByLabel(language.language, { exact: true })).toHaveValue(language.locale);
    await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mock.assertClean();
  });

  test(`${language.locale} schema validation and confirmation are fully localized`, async ({ page }) => {
    const mock = await mockApi(page, { fixture: true, language: language.locale });
    await page.goto('/');
    await page.getByRole('button', { name: language.modules, exact: true }).click();
    await page.getByRole('button', { name: language.configure, exact: true }).click();
    await page.getByLabel(language.label, { exact: true }).fill('x');
    await page.getByRole('button', { name: language.save }).click();
    await expect(page.getByText(language.invalid)).toBeVisible();
    await page.getByRole('button', { name: language.add, exact: true }).click();
    await expect(page.getByRole('button', { name: language.up, exact: true }).last()).toBeEnabled();
    await page.getByRole('button', { name: language.secret }).click();
    await expect(page.getByRole('dialog')).toContainText(language.clear);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    mock.assertClean();
  });

  test.describe(`${language.browser} browser detection`, () => {
    test.use({ locale: language.browser });
    test('uses the browser language before login and offers every canonical locale', async ({ page }) => {
      const mock = await mockApi(page, { signedOut: true });
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', language.locale);
      await expect(page.getByRole('link', { name: language.login })).toBeVisible();
      const selector = page.getByLabel(language.language, { exact: true });
      expect(await selector.locator('option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual([...supportedLocales]);
      await selector.selectOption('en');
      await expect(page.locator('html')).toHaveAttribute('lang', 'en');
      await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
      mock.assertClean();
    });
  });
}

test('dirty navigation confirms discard, conflicts do not overwrite and reload is explicit', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Core settings', exact: true }).click();
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  mock.state.conflict = true;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('changed elsewhere');
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  expect(mock.state.snapshot.saved.defaultLanguage).toBe('en');
  mock.state.conflict = false;
  await page.getByRole('button', { name: 'Reload latest data' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Reload latest data' }).click();
  await expect(page.getByLabel('Instance language').locator('option:checked')).toHaveText('English');
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('heading', { name: 'No modules to display' })).toBeVisible();
  mock.assertClean();
});

test('group authorization validates IDs and revocation needs a one-time server confirmation', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Groups', exact: true }).click();
  await page.getByLabel('Telegram chat ID').fill('123');
  await page.getByRole('button', { name: 'Authorize group' }).click();
  await expect(page.getByRole('alert')).toContainText('valid negative');
  await page.getByLabel('Telegram chat ID').fill('-1007777');
  await page.getByRole('button', { name: 'Authorize group' }).click();
  await expect(page.getByRole('row', { name: /New group/ })).toBeVisible();
  const revoke = page.getByRole('row', { name: /Engineering/ }).getByRole('button', { name: 'Revoke access' });
  await revoke.click();
  await expect(page.getByRole('dialog')).toContainText('-1001234567890');
  expect(mock.state.confirmations).toBe(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(mock.state.groups).toHaveLength(2);
  await revoke.click();
  await page.getByRole('dialog').getByRole('button', { name: 'Revoke access' }).click();
  await expect(page.getByRole('heading', { name: 'No authorized groups' })).toBeVisible();
  await expect(page.getByRole('status')).toContainText('could not be completed');
  expect(mock.state.confirmations).toBe(1);
  mock.assertClean();
});

test('schema extension handles objects, lists, enums, read-only, errors, secrets and restart state', async ({ page }) => {
  const mock = await mockApi(page, { fixture: true });
  await page.goto('/');
  await page.getByRole('button', { name: 'Modules', exact: true }).click();
  await page.getByRole('button', { name: 'Configure' }).click();
  await expect(page.getByLabel('Identity')).toHaveAttribute('readonly', '');
  await expect(page.getByLabel('Access secret')).toHaveValue('');
  await expect(page.getByText('A value is configured. Leave blank to keep it.')).toBeVisible();
  await page.getByLabel('Label', { exact: true }).fill('x');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Use at least 3 characters.')).toBeVisible();
  await page.getByLabel('Label', { exact: true }).fill('Revised');
  await page.getByLabel('Endpoint').fill('new.test');
  await page.getByLabel('Mode', { exact: true }).selectOption({ label: 'Fast' });
  await page.getByLabel('Workers').fill('2');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('Item', { exact: false }).last().fill('beta');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  const first = mock.state.calls.filter((call) => call.method === 'PUT').at(-1)?.body?.settings as Record<string, unknown>;
  expect(first).toMatchObject({ label: 'Revised', connection: { endpoint: 'new.test' }, tags: ['alpha', 'beta'], mode: 'fast', workers: 2 });
  expect(first).not.toHaveProperty('secret');
  expect(first).not.toHaveProperty('identity');
  await expect(page.getByText('Saved changes are waiting for a restart.', { exact: false })).toBeVisible();
  await page.getByText('Effective values', { exact: true }).click();
  await expect(page.locator('.effective-values')).toContainText('1');
  await page.getByLabel('Access secret').fill('********');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('not a masked placeholder');
  await page.getByLabel('Access secret').fill('new-test-secret');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByLabel('Access secret')).toHaveValue('');
  await page.getByRole('button', { name: 'Clear stored secret' }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Save changes' })).toBeDisabled();
  await page.getByRole('button', { name: 'Clear stored secret' }).click();
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('Will be cleared when saved')).toBeVisible();
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('dialog')).toContainText('Confirm sensitive changes');
  expect(mock.state.calls.filter((call) => call.method === 'PUT').at(-1)?.body?.settings).toHaveProperty('secret', { operation: 'clear' });
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(page.getByText('No value configured')).toBeVisible();
  mock.assertClean();
});

test('saving is disabled while pending and storage errors retain edits', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Core settings', exact: true }).click();
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route('**/api/settings/core', async (route) => { if (route.request().method() === 'PUT') await gate; await route.fallback(); });
  mock.state.storageFailure = true;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('button', { name: 'Saving...' })).toBeDisabled();
  release();
  await expect(page.getByRole('alert')).toContainText('could not be saved');
  await expect(page.getByText('Unsaved changes')).toBeVisible();
  mock.state.storageFailure = false;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved.')).toBeVisible();
  mock.assertClean();
});

test('browser logout clears private state and login uses the OIDC endpoint', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByText('You are signed out. Private data has been cleared.')).toBeVisible();
  await expect(page.getByText('Misaka Operator')).toHaveCount(0);
  await expect(page.getByRole('navigation')).toHaveCount(0);
  expect(mock.state.calls.find((call) => call.path === '/auth/logout')?.headers['x-csrf-token']).toBe('test-csrf');
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  await page.getByRole('link', { name: 'Sign in with Telegram' }).click();
  await expect(page).toHaveURL(/\/auth\/login$/);
  mock.assertClean();
});

test('safe login errors are localized and removed from the address bar', async ({ page }) => {
  const mock = await mockApi(page, { signedOut: true });
  await page.goto('/?auth_error=FORBIDDEN');
  await expect(page.getByRole('alert')).toContainText('do not have permission');
  await expect(page).toHaveURL('http://127.0.0.1:4173/');
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await page.getByLabel('Language', { exact: true }).selectOption('zh-CN');
  await expect(page.getByRole('alert')).toContainText('权限');
  mock.assertClean();
});

test('Mini App uses one in-memory bearer without cookies, reacts to theme/safe area and back', async ({ page, context }) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.setCookieControls', { enableThirdPartyCookieRestriction: true });
  await context.clearCookies();
  const mock = await mockApi(page, { miniapp: true });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((html) => getComputedStyle(html).getPropertyValue('--tg-inset-top'))).toBe('28px');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(35, 42, 44)');
  expect(await page.locator('html').evaluate(html => html.style.getPropertyValue('--accent'))).toBe('');
  await page.evaluate(() => { const host = window as unknown as { Telegram: { WebApp: { colorScheme: string } }; __tg: { trigger(event: string): void } }; host.Telegram.WebApp.colorScheme = 'light'; host.__tg.trigger('themeChanged'); });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(239, 232, 220)');
  await page.getByLabel('Appearance').selectOption('dark');
  await page.evaluate(() => (window as unknown as { __tg: { trigger(event: string): void } }).__tg.trigger('themeChanged'));
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.getByLabel('Appearance').selectOption('auto');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.getByRole('button', { name: 'Core settings', exact: true }).click();
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  await page.evaluate(() => (window as unknown as { __tg: { back(): void } }).__tg.back());
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Discard changes' }).click();
  await expect(page.getByRole('heading', { name: 'Runtime status' })).toBeVisible();
  expect(mock.state.exchanges).toBe(1);
  expect(await context.cookies()).toEqual([]);
  expect(mock.state.calls.filter((call) => call.path.startsWith('/api/')).every((call) => call.headers.authorization === 'Bearer test-memory-bearer' && !call.headers.cookie)).toBe(true);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length }))).toEqual({ local: 0, session: 0 });
  mock.state.expired = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Your session expired. Private data has been cleared.')).toBeVisible();
  await expect(page.getByText('Close and reopen this Mini App to sign in again.')).toBeVisible();
  await expect(page.getByText('Misaka Operator')).toHaveCount(0);
  expect(mock.state.exchanges).toBe(1);
  mock.assertClean();
});

test('Chinese extension labels, enum choices, validation, list buttons and secret confirmation are localized', async ({ page }) => {
  const mock = await mockApi(page, { fixture: true, language: 'zh-CN' });
  await page.goto('/');
  await page.getByRole('button', { name: '模块', exact: true }).click();
  await page.getByRole('button', { name: '配置', exact: true }).click();
  await page.getByLabel('标签', { exact: true }).fill('x');
  await page.getByRole('button', { name: '保存更改' }).click();
  await expect(page.getByText('至少输入 3 个字符。')).toBeVisible();
  await page.getByLabel('模式', { exact: true }).selectOption({ label: '快速' });
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await expect(page.getByRole('button', { name: '上移', exact: true }).last()).toBeEnabled();
  await expect(page.getByRole('button', { name: '下移', exact: true }).first()).toBeEnabled();
  await page.getByRole('button', { name: '移除', exact: true }).last().click();
  await page.getByRole('button', { name: '清除已存储的密钥' }).click();
  await expect(page.getByRole('dialog')).toContainText('清除此密钥？');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  mock.assertClean();
});

test('even a non-JSON 401 clears browser private state and unsaved fields', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Core settings', exact: true }).click();
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  await page.route('**/api/settings/core', async (route) => {
    if (route.request().method() === 'PUT') await route.fulfill({ status: 401, body: '' });
    else await route.fallback();
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your session expired. Private data has been cleared.')).toBeVisible();
  await expect(page.getByText('Misaka Operator')).toHaveCount(0);
  await expect(page.getByLabel('Instance language')).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Sign in with Telegram' })).toBeVisible();
  mock.assertClean();
});

test('a revoked administrator session clears private state while an action denial does not', async ({ page }) => {
  const mock = await mockApi(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'Core settings', exact: true }).click();
  await page.getByLabel('Instance language').selectOption({ label: 'Simplified Chinese' });
  let guard = false;
  await page.route('**/api/settings/core', async route => {
    if (route.request().method() !== 'PUT') { await route.fallback(); return; }
    await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify(guard
      ? { error: { code: 'FORBIDDEN' } }
      : { status: 'rejected', invocationId: 'test-denial', error: { code: 'FORBIDDEN' } }) });
  });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('alert')).toContainText('do not have permission');
  await expect(page.getByLabel('Instance language')).toBeVisible();
  guard = true;
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Your session expired. Private data has been cleared.')).toBeVisible();
  await expect(page.getByText('Misaka Operator')).toHaveCount(0);
  await expect(page.getByLabel('Instance language')).toHaveCount(0);
  mock.assertClean();
});
