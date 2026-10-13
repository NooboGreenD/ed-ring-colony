import { test, expect, type Page } from '@playwright/test';

async function openRing(page: Page) {
  // Layout and controls must be testable without the production catalog.
  await page.route('**/api/**', route => route.fulfill({ json: {} }));
  await page.goto('/atlas?tab=ring-route');
  await expect(page.locator('.atlas-ring-finder')).toBeVisible();
}

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  test(`ring controls do not overlap or overflow at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await openRing(page);
    const panel = page.locator('.atlas-sidebar-body');
    expect(await panel.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
    expect(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const fields = page.locator('.atlas-ring-finder .atlas-range-row');
    for (const field of await fields.all()) {
      const layout = await field.evaluate(el => {
        const [slider, number] = Array.from(el.querySelectorAll('input')).map(input => input.getBoundingClientRect());
        const row = el.getBoundingClientRect();
        return { sliderWidth: slider.width, numberHeight: number.height,
          separated: slider.right < number.left, contained: number.right <= row.right + 1 };
      });
      expect(layout.sliderWidth).toBeGreaterThan(65);
      expect(layout.numberHeight).toBeGreaterThanOrEqual(32);
      expect(layout.separated).toBe(true);
      expect(layout.contained).toBe(true);
    }
    await page.getByRole('button', { name: 'Поперёк −30°', exact: true }).click();
    await expect(page.locator('#ring-tilt-value')).toHaveValue('-30');
    await expect(page.locator('#ring-tilt-axis-value')).toHaveValue('90');
    await expect(page.locator('.atlas-ring-preview-status')).toContainText('наклон -30° · ось 90°');
    await expect(page.locator('label[for="ring-tilt"]')).not.toContainText('св.л.');
    await page.getByRole('button', { name: 'Обратить наклон' }).click();
    await expect(page.locator('#ring-tilt-value')).toHaveValue('30');
    await page.locator('#ring-tilt-axis-value').fill('135');
    await page.locator('#ring-tilt-axis-value').press('Enter');
    await expect(page.locator('.atlas-ring-preview-status')).toContainText('ось 135°');
    // Native disclosure state should survive a parent re-render (no controlled open=false).
    await page.locator('.atlas-ring-geometry > summary').click();
    await page.locator('#ring-radius-value').fill('2000');
    await page.locator('#ring-radius-value').press('Enter');
    await expect(page.locator('.atlas-ring-geometry')).not.toHaveAttribute('open');
    await page.locator('.atlas-ring-geometry > summary').click();
    await page.getByRole('button', { name: 'Сбросить геометрию' }).click();
    await expect(page.locator('#ring-tilt-value')).toHaveValue('0');
    await expect(page.locator('#ring-tilt-axis-value')).toHaveValue('0');
    await expect(page.locator('#ring-height-value')).toHaveValue('0');
    expect(await panel.evaluate(el => getComputedStyle(el).scrollbarColor)).not.toBe('auto');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
    const controls = page.locator('.galaxy-map-controls');
    if (viewport.width <= 768) {
      await expect(page.locator('.galaxy-map-controls-body')).not.toBeVisible();
      const toggle = page.getByRole('button', { name: /Слои и управление картой/ });
      await toggle.click();
      await expect(page.locator('.galaxy-map-controls-body')).toBeVisible();
      const checkbox = await controls.locator('input[type="checkbox"]').first().boundingBox();
      expect(checkbox!.width).toBeLessThanOrEqual(18);
      expect(checkbox!.height).toBeLessThanOrEqual(18);
      const controlBounds = (await controls.boundingBox())!;
      const mapBounds = (await page.locator('.atlas-map-area').boundingBox())!;
      expect(controlBounds.y + controlBounds.height).toBeLessThanOrEqual(mapBounds.y + mapBounds.height + 1);
      await toggle.click();
      await expect(page.locator('.galaxy-map-controls-body')).not.toBeVisible();
    } else {
      await expect(page.locator('.galaxy-map-controls-body')).toBeVisible();
    }
  });
}

test('ring request carries signed tilt and axis; result and modal fit a narrow panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openRing(page);
  await page.getByRole('button', { name: 'Поперёк −30°', exact: true }).click();
  let submitted: Record<string, unknown> | null = null;
  const point = { name: 'Sol', x: 0, y: 0, z: 0, source: 'catalog' };
  const result = {
    sessionId: 'test-ring', route: [point, { ...point, name: 'Next', x: 10 }, point],
    center: point, ringCenter: point, ringRadius: 23000, searchRadius: 500, deviationLimit: 100,
    anchors: [point], keySystems: [],
    totals: { points: 3, anchors: 1, realPoints: 3, syntheticPoints: 0, triangulatedAnchors: 0,
      discovered: 1, deviationAvg: 0, deviationMax: 0 },
    stats: { catalogHits: 1, cacheHits: 0, edsmRequests: 0, spanshRequests: 0, systemsSaved: 1 },
  };
  await page.route('**/api/atlas/ring-route', async route => {
    submitted = route.request().postDataJSON();
    await route.fulfill({ json: { completed: true, session: {
      session_id: 'test-ring', start_system: 'Sol', center: point, ring_radius: 23000,
      search_radius: 500, deviation_limit: 100, sectors: 1, sectors_done: 1, key_systems: [],
    } } });
  });
  await page.route('**/api/atlas/ring-route/finalize', route => route.fulfill({json: {result}}));
  await page.getByRole('button', { name: 'Построить галактическое кольцо', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Результат кольцевого маршрута' })).toBeVisible();
  expect(submitted).toMatchObject({ tilt_degrees: -30, tilt_axis_degrees: 90 });
  expect(await page.locator('.atlas-sidebar-body').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const cells = await page.locator('.atlas-ring-finder .atlas-infograph-cell').all();
  expect(cells).toHaveLength(4);
  for (const cell of cells) expect((await cell.boundingBox())!.width).toBeGreaterThan(100);
  await page.getByRole('button', { name: 'Уточнить с параметрами / Повторный прогон' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const body = page.locator('.atlas-modal-body');
  expect(await body.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  const bounds = (await dialog.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  await page.getByRole('button', { name: 'Закрыть окно' }).click();
  await expect(dialog).not.toBeVisible();
});
