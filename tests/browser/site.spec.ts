import { test, expect } from '@playwright/test';
import sharp from 'sharp';

// No real login/mail or data writes. All browser data APIs are fixtures; use a
// local production build to exercise the actual Next/React/R3F bundles.
test.beforeEach(async ({ page }) => {
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const data: Record<string, unknown> = {
      '/api/hubs': { hubs: [{ id: 1, name: 'Солнечная система', system_name: 'Sol', x: 0, y: 0, z: 0, status: 'done' }] },
      '/api/route': { points: [] }, '/api/map/pilots': { pilots: [] },
      '/api/auth/providers': { providers: ['discord'] },
    };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data[path] || {}) });
  });
  await page.route('https://supabase.edringcolony.ru/**', route => route.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
});

test('login retains password entry and exposes recovery, confirmation and Discord', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Забыли пароль?' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Подтвердить почту' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Войти через Discord' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('registration waits for email instead of signing in automatically', async ({ page }) => {
  let signupCalls = 0;
  await page.route('**/api/auth/register', async route => {
    signupCalls++;
    await route.fulfill({ status: 202, json: { ok: true, confirmationRequired: true, message: 'Проверьте письмо.' } });
  });
  await page.goto('/register');
  await page.getByLabel('Никнейм / CMDR').fill('Test Commander');
  await page.getByLabel('Email', { exact: true }).fill('browser-test@example.net');
  await page.getByLabel('Пароль', { exact: true }).fill('a safe test passphrase');
  await page.getByLabel('Повтор пароля', { exact: true }).fill('a safe test passphrase');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await expect(page.getByRole('status')).toContainText('Автоматического входа до подтверждения почты нет');
  expect(signupCalls).toBe(1);
  await expect(page).toHaveURL(/\/register$/);
});

test('opening email link strips the token but does not consume it before explicit consent', async ({ page }) => {
  let verifyCalls = 0;
  await page.route('**/api/auth/email/verify', async route => {
    verifyCalls++;
    await route.fulfill({ status: 400, json: { error: 'Тестовая ссылка.' } });
  });
  await page.goto('/auth/email#token_hash=' + 'a'.repeat(64) + '&type=recovery');
  const button = page.getByRole('button', { name: 'Перейти к новому паролю' });
  await expect(button).toBeVisible();
  await expect(page).toHaveURL(/\/auth\/email$/);
  expect(verifyCalls).toBe(0);
  await button.click();
  await expect(page.locator('.auth-error[role=alert]')).toHaveText('Тестовая ссылка.');
  expect(verifyCalls).toBe(1);
});

test('production galaxy map mounts the actual React 19 / R3F renderer with WebGL2', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/map');
  await expect(page.locator('canvas')).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.width)).toBeGreaterThan(0);
  expect(await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => !!canvas.getContext('webgl2'))).toBe(true);
  // Exercise resize and camera input, then let React flush renderer updates.
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.mouse.move(600, 420);
  await page.mouse.wheel(0, 200);
  await expect.poll(async () => {
    const image = sharp(await page.locator('canvas').screenshot());
    const metadata = await image.metadata();
    const stats = await image.extract({ left: 5, top: Math.floor(metadata.height! / 2),
      width: Math.min(300, metadata.width! - 10), height: 100 }).stats();
    return Math.max(...stats.channels.slice(0, 3).map(channel => channel.max));
  }, { timeout: 30_000, intervals: [250, 500, 1000] }).toBeGreaterThan(10);
  await page.screenshot({ path: '.cache/galaxy-smoke.png' });
  expect(errors).toEqual([]);
});


test('stored non-default language does not cause hydration errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => window.localStorage.setItem('ed-ring-locale', 'en'));
  await page.goto('/login');
  await expect(page.locator('aside').getByRole('link', { name: 'Home', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
