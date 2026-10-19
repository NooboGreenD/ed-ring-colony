import { test, expect } from '@playwright/test';
import type { StationSearchStation } from '../../src/lib/stationSearch';

const station = (name: string, coordinates: boolean = true): StationSearchStation => ({
  system_name: 'Sol', station_name: name, station_type: 'Coriolis', market_id: '42', station_key: name,
  metadata: { distance_to_arrival: 100 }, x: coordinates ? 0 : null,
  y: coordinates ? 0 : null, z: coordinates ? 0 : null, distance: null,
  items: [{ name: 'Gold', buyPrice: 123, stock: 50, demand: 7, display: 'Gold' }], item_count: 1, best_price: 123,
  source: 'colonial-helper', observed_at: new Date().toISOString(), stale: false,
});
const body = (page: number, stations: StationSearchStation[], hasMore: boolean) => ({
  kind: 'market', query: 'Gold', page, has_more: hasMore, total: 3, stations, pick: { id: 'market:Gold', label: 'Gold' },
  grouping: 'station', reference: null, source: 'project-db',
});

test('station search lists stations, expands a row with prices and a safe Atlas link, and pages', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/stations/search?*', async route => {
    const url = new URL(route.request().url());
    requests.push(url);
    const requestedPage = Number(url.searchParams.get('page') ?? '0');
    await route.fulfill({ json: requestedPage === 0
      ? body(0, [station('Galileo'), station('Unknown coordinates', false)], true)
      : body(1, [station('Next page')], false) });
  });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  await page.getByRole('combobox', { name: 'Товары', exact: true }).fill('Gold');
  await page.getByRole('button', { name: 'Найти станции' }).click();
  await expect(page.locator('.station-row')).toHaveCount(2);
  // Название целиком — точный выбор из справочника.
  expect(requests[0].searchParams.get('item')).toBe('market:Gold');
  expect(requests[0].searchParams.get('group')).toBe('station');
  const galileo = page.getByRole('button', { name: /Galileo/ });
  await expect(galileo).toHaveAttribute('aria-expanded', 'false');
  await galileo.click();
  await expect(galileo).toHaveAttribute('aria-expanded', 'true');
  const panel = page.getByRole('region', { name: 'Galileo: что найдено' });
  await expect(panel.getByRole('cell', { name: '123 CR', exact: true })).toBeVisible();
  await expect(panel.locator('.station-report-time')).toContainText('Colonial Helper');
  const atlas = panel.getByRole('link', { name: 'Показать систему в Атласе' });
  await expect(atlas).toHaveAttribute('target', '_blank');
  const focusUrl = new URL((await atlas.getAttribute('href'))!, 'http://localhost');
  expect(focusUrl.searchParams.get('focus_system')).toBe('Sol');
  expect(['x', 'y', 'z'].map(key => focusUrl.searchParams.get(key))).toEqual(['0', '0', '0']);
  await page.getByRole('button', { name: 'Развернуть все' }).click();
  await expect(page.getByRole('button', { name: 'Координаты системы неизвестны' })).toBeDisabled();
  await page.getByRole('button', { name: 'Далее →' }).click();
  await expect(page.locator('.station-row')).toHaveCount(1);
  await expect(page.locator('.station-list')).toContainText('Next page');
  expect(requests.map(url => url.searchParams.get('page'))).toEqual(['0', '1']);
  await page.getByRole('tab', { name: 'Модули', exact: true }).click();
  await expect(page.locator('.station-row')).toHaveCount(0);
  await expect(page.getByLabel('Класс модуля', { exact: true })).toBeVisible();
});

test('typing a material offers a quick-pick list and the picked item is searched exactly', async ({ page }) => {
  const requests: URL[] = [];
  await page.route('**/api/stations/search?*', async route => {
    requests.push(new URL(route.request().url()));
    await route.fulfill({ json: body(0, [station('Galileo')], false) });
  });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  const input = page.getByRole('combobox', { name: 'Товары', exact: true });
  await input.fill('ста');
  const steel = page.getByRole('option', { name: /Сталь/ });
  await expect(steel).toBeVisible();
  await steel.click();
  await expect(input).toHaveValue('Сталь');
  await page.getByRole('button', { name: 'Найти станции' }).click();
  await expect(page.locator('.station-row')).toHaveCount(1);
  expect(requests[0].searchParams.get('item')).toBe('market:Steel');
});

test('changing category cancels an in-flight result and supports keyboard tabs', async ({ page }) => {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => {
    void page.route('**/api/stations/search?*', async route => {
      resolve();
      await pending;
      await route.fulfill({ json: body(0, [station('Cancelled result')], false) }).catch(() => {});
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
  await expect(page.getByText('Cancelled result')).toHaveCount(0);
  await modules.press('End');
  await expect(page.getByRole('tab', { name: 'Услуги', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('combobox', { name: 'Услуга / инженер', exact: true })).toBeVisible();
});

test('station finder and its quick-pick list fit a narrow mobile screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/station-search', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Поиск по станциям', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Модули', exact: true }).click();
  await expect(page.getByLabel('Класс модуля', { exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: 'Модули', exact: true }).fill('fsd');
  await expect(page.getByRole('option').first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('Atlas accepts a focused system including zero coordinates', async ({ page }) => {
  await page.goto('/atlas?tab=nearby&focus_system=Sol&x=0&y=0&z=0', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.station-atlas-focus')).toBeVisible();
  await expect(page.getByRole('link', { name: '← Вернуться к поиску по станциям' })).toHaveAttribute('href', '/station-search');
});
