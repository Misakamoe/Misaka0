import { test, expect } from '@playwright/test';
import { mockApi } from './mock.js';

test('browser without OIDC offers localized Telegram instructions instead of a broken login link', async ({ page }) => {
  const mock = await mockApi(page, { signedOut: true, oidc: false });
  await page.goto('/');
  for (const [locale, message] of [
    ['en', 'Browser sign-in is not configured. Open a private chat with this bot in Telegram, send /webui, and open the Mini App.'],
    ['zh-CN', '尚未配置浏览器登录。请在 Telegram 中私聊此机器人，发送 /webui 并打开小程序。'],
    ['zh-TW', '尚未設定瀏覽器登入。請在 Telegram 中私訊此機器人，傳送 /webui 並開啟迷你應用程式。'],
    ['ja', 'ブラウザーログインは未設定です。Telegram でこのボットとの個人チャットを開き、/webui を送信してミニアプリを開いてください。'],
  ]) {
    await page.locator('#login-language').selectOption(locale!);
    await expect(page.getByText(message!, { exact: true })).toBeVisible();
    await expect(page.locator('a[href="/auth/login"]')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  expect(mock.state.calls.filter(call => call.path === '/auth/methods')).toHaveLength(1);
  expect(mock.state.calls.some(call => call.path === '/auth/login')).toBe(false);
  expect(mock.state.exchanges).toBe(0);
  mock.assertClean();
});

for (const [name, metadata] of [
  ['string flag', { oidc: 'true', miniapp: true }],
  ['missing flag', { oidc: true }],
  ['extra authority', { oidc: true, miniapp: true, admin: true }],
  ['disabled Mini App', { oidc: true, miniapp: false }],
  ['null', null],
] as const) {
  test(`browser rejects malformed login metadata: ${name}`, async ({ page }) => {
    const mock = await mockApi(page, { signedOut: true });
    await page.route('**/auth/methods', route => route.fulfill({ json: metadata }));
    await page.goto('/');
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('a[href="/auth/login"]')).toHaveCount(0);
    await expect(page.getByRole('navigation')).toHaveCount(0);
    mock.assertClean();
  });
}

test('failed Mini App bootstrap never falls back to browser login or repeats initData', async ({ page }) => {
  const mock = await mockApi(page, { miniapp: true, oidc: true });
  let exchanges = 0;
  await page.route('**/auth/miniapp', async route => {
    exchanges += 1;
    await route.fulfill({ status: 401, json: { error: { code: 'AUTH_INVALID' } } });
  });
  await page.goto('/');
  await expect(page.getByText('Close and reopen this Mini App to sign in again.')).toBeVisible();
  await expect(page.getByRole('alert')).toBeVisible();
  await expect(page.locator('a[href="/auth/login"]')).toHaveCount(0);
  await page.locator('#login-language').selectOption('ja');
  await expect(page.getByText('再度ログインするには、このミニアプリを閉じて開き直してください。')).toBeVisible();
  expect(exchanges).toBe(1);
  expect(mock.state.calls.some(call => call.path === '/auth/methods' || call.path.startsWith('/api/'))).toBe(false);
  mock.assertClean();
});
