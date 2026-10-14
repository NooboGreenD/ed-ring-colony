import { test, expect } from '@playwright/test';
import type { StationSearchResult } from '../../src/lib/stationSearch';

const result = (station: string, coordinates: boolean = true): StationSearchResult => ({
  system_name: 'Sol', station_name: station, station_type: 'Coriolis', market_id: '42', station_key: station,
  metadata: { distance_to_arrival: 100 }, x: coordinates ? 0 : null,
  y: coordinates ? 0 : null, z: coordinates ? 0 : null, distance: null,
  item: { name: 'Gold', buyPrice: 123, stock: 50, demand: 7 },
  source: 'colonial-helper', observed_at: new Date().toISOString(), stale: false,
});

test('station search renders persisted result fields, pagination and a safe Atlas link', async ({ page }) => {
  const pages: string[] = [];
  await page.route('**/api/stations/search?*', async route => {
    const requestedPage = new URL(route.request().url()).searchParams.get('page') ?? '0';
    pages.push(requestedPage);
    await route.fulfill({ json: { kind: 'market', query: 'Gold', page: Number(requestedPage),
      has_more: requestedPage === '0', results: requestedPage === '0'
        ? [result('Galileo'), result('Unknown coordinates', false)] : [result('Next page')] } });
  });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  await page.getByRole('combobox', { name: 'Товары', exact: true }).fill('Gold');
  await page.getByRole('button', { name: 'Найти станции' }).click();
  await expect(page.getByRole('heading', { name: 'Galileo', exact: true })).toBeVisible();
  await expect(page.locator('.station-report-time').first()).toContainText('Colonial Helper');
  await expect(page.locator('.station-result-card').first().getByText('123 CR', { exact: true })).toBeVisible();
  const atlas = page.getByRole('link', { name: 'Показать систему в Атласе' });
  await expect(atlas).toHaveCount(1);
  await expect(atlas).toHaveAttribute('target', '_blank');
  const focusUrl = new URL((await atlas.getAttribute('href'))!, 'http://localhost');
  expect(focusUrl.searchParams.get('focus_system')).toBe('Sol');
  expect(['x', 'y', 'z'].map(key => focusUrl.searchParams.get(key))).toEqual(['0', '0', '0']);
  await expect(page.getByRole('button', { name: 'Координаты системы неизвестны' })).toBeDisabled();
  await page.getByRole('button', { name: 'Далее →' }).click();
  await expect(page.getByRole('heading', { name: 'Next page', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Galileo', exact: true })).toHaveCount(0);
  expect(pages).toEqual(['0', '1']);
  await page.getByRole('tab', { name: 'Модули', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Next page', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Класс модуля', { exact: true })).toBeVisible();
});

test('changing category cancels an in-flight result and supports keyboard tabs', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => {
    void page.route('**/api/stations/search?*', async route => {
      resolve();
      await pending;
      await route.fulfill({ json: { results: [result('Cancelled result')], has_more: false } }).catch(() => {});
    });
  });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  await page.getByRole('combobox', { name: 'Товары', exact: true }).fill('Gold');
  await page.getByRole('button', { name: 'Найти станции' }).click();
  await started;
  const modules = page.getByRole('tab', { name: 'Модули', exact: true });
  await modules.click();
  release();
  await expect(page.getByRole('button', { name: 'Найти станции' })).toBeEnabled();
  await expect(page.getByRole('heading', { name: 'Cancelled result', exact: true })).toHaveCount(0);
  await modules.press('End');
  await expect(page.getByRole('tab', { name: 'Услуги', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByLabel('Услуга / инженер', { exact: true })).toBeVisible();
});

test('station finder fits a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Поиск по станциям', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Модули', exact: true }).click();
  await expect(page.getByLabel('Класс модуля', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Atlas accepts a focused system including zero coordinates', async ({ page }) => {
  await page.goto('/atlas?tab=nearby&focus_system=Sol&x=0&y=0&z=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.station-atlas-focus')).toBeVisible();
  await expect(page.getByRole('link', { name: '← Вернуться к поиску по станциям' })).toHaveAttribute('href', '/station-search');
});
