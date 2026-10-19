import { test, expect } from '@playwright/test';

for (const width of [320, 390, 768, 1024, 1280]) {
  test(`responsive home and navigation at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    await page.route('**/api/home-data?*', route => route.fulfill({ json: {
      content: { kicker: 'ED Ring Colony', title1: 'Ваш курс.', title2: 'Общий горизонт.', manifest: 'Галактика огромна. Но строить в ней будущее лучше вместе.\nКомандир свободен выбирать свой путь.' },
      news: [], galnet: [], cmdrs: 1234, systems: 250, built: 32,
    } }));
    await page.route('**/api/shop/user-state', route => route.fulfill({ json: {} }));
    await page.route('https://supabase.*/**', route => route.abort());
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('.hero .sub')).toContainText('Галактика огромна');
    const centered = await page.locator('.hero .sub').evaluate(el => {
      const a = el.getBoundingClientRect(), b = el.parentElement!.getBoundingClientRect();
      return Math.abs((a.left + a.right) / 2 - (b.left + b.right) / 2) < 2;
    });
    expect(centered).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    if (width <= 1024) {
      await expect(page.locator('.mobile-nav')).toBeVisible();
      await expect(page.locator('.sidebar')).toBeHidden();
      const menu = page.locator('.mobile-nav button');
      await menu.click();
      const drawer = page.locator('#sidebar-drawer');
      await expect(drawer).toBeVisible();
      await expect(drawer).toHaveAttribute('aria-modal', 'true');
      await expect(page.locator('.site-content')).toHaveAttribute('inert', '');
      await expect(drawer.getByRole('link', { name: 'Поиск по станциям', exact: true })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(drawer).toBeHidden();
      await expect(menu).toBeFocused();
      await expect(page.locator('.site-content')).not.toHaveAttribute('inert', '');
    } else {
      await expect(page.locator('.mobile-nav')).toBeHidden();
      await expect(page.locator('.sidebar')).toBeVisible();
    }
  });
}

test('mobile shop: preview, equip, reload and unequip use persisted state', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const item = { id: 'skin-test', title: 'Test HUD', category: 'skin', rarity: 'rare', price_credits: 100,
    price_rub: 0, description: 'Theme regression fixture', preview_data: { color: '#00aaff', theme: { panel: '#142836' } } };
  let equipped: string | null = null;
  await page.route('https://supabase.*/**', route => route.abort());
  await page.route('**/api/shop/items', route => route.fulfill({ json: { success: true, items: [item] } }));
  await page.route('**/api/shop/user-state', route => route.fulfill({ json: { success: true, authenticated: true,
    userId: 'pilot', cmdrName: 'Commander', inventory: [{ id: 'owned', item_id: item.id, item }],
    equipped: { user_id: 'pilot', skin_id: equipped }, balance: { credits: 1000 } } }));
  await page.route('**/api/billing/cosmetics', route => route.fulfill({ json: { cosmetics: { pilot: {
    user_id: 'pilot', skin: equipped ? { id: item.id, preview: item.preview_data } : null,
  } } } }));
  await page.route('**/api/shop/equip', async route => {
    equipped = route.request().postDataJSON().itemId;
    await route.fulfill({ json: { equipped: { user_id: 'pilot', skin_id: equipped } } });
  });
  await page.goto('/premium-shop');
  await expect(page.getByRole('button', { name: 'Надеть', exact: true })).toBeVisible();
  await expect.poll(() => page.locator('.shop-page').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
  await page.getByRole('button', { name: 'Примерить', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-hud-skin', item.id);
  await page.getByRole('button', { name: 'Сбросить к текущему', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-hud-skin');
  await page.getByRole('button', { name: 'Надеть', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-hud-skin', item.id);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-hud-skin', item.id);
  await page.screenshot({ path: '.cache/mobile-shop.png', fullPage: true });
  await page.getByRole('button', { name: 'Снять', exact: true }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-hud-skin');
});

test('phone station filters stack and menu traps focus, then closes on desktop resize', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('https://supabase.*/**', route => route.abort());
  await page.route('**/api/shop/user-state', route => route.fulfill({ json: {} }));
  await page.goto('/station-search');
  await expect(page.locator('#station-pad')).toBeVisible();
  const boxes = await page.locator('.station-search-form').evaluate(el => {
    const a = el.getBoundingClientRect();
    return [...el.children].every(child => { const b = child.getBoundingClientRect(); return b.left >= a.left && b.right <= a.right; });
  });
  expect(boxes).toBe(true);
  await page.locator('.mobile-nav button').click();
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#sidebar-drawer'))).toBe(true);
  await page.keyboard.press('Tab');
  await expect(page.locator('.mobile-menu-heading button')).toBeFocused();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(page.locator('#sidebar-drawer')).toBeHidden();
  await expect(page.locator('.site-content')).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Control+k');
  await expect(page.locator('.sidebar .sidebar-search input')).toBeFocused();
});
