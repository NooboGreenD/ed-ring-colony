import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  applyCatalogCommands, catalogSnapshot, EMPTY_CATALOG_STATE, mergeCatalog,
  type CatalogState, type CatalogCommand,
} from '../../src/lib/outfitting/catalog';
import type { OutfittingData } from '../../src/lib/outfitting/types';

const base = JSON.parse(readFileSync('public/data/outfitting.json', 'utf8')) as OutfittingData;
const adminUser = { id: 'browser-test-admin', email: 'admin@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: '2026-10-10T00:00:00Z' };

/** Real UI + domain rules, no real account, database writes or external requests. */
async function fixture(page: Page) {
  let state: CatalogState = structuredClone(EMPTY_CATALOG_STATE);
  let writes = 0;
  let failNext = 0;
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript((user) => {
    const session = { access_token: 'browser-fixture-token', refresh_token: 'browser-fixture-refresh', token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, user };
    document.cookie = `sb-edrc-auth-token=base64-${btoa(JSON.stringify(session))}; path=/; SameSite=Lax`;
    localStorage.setItem('ed-ring-locale', 'ru');
  }, adminUser);
  await page.route('https://supabase.edringcolony.ru/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith('/auth/v1/user')) return route.fulfill({ status: 200, json: adminUser });
    if (url.pathname.endsWith('/rest/v1/profiles')) return route.fulfill({ status: 200, json: url.searchParams.has('id') ? { id: adminUser.id, role: 'admin', cmdr_name: 'CMDR Browser' } : [] });
    return route.fulfill({ status: 200, json: [] });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/admin/outfitting') {
      if (route.request().method() === 'POST') {
        writes++;
        if (failNext) { const status = failNext; failNext = 0; return route.fulfill({ status, json: { error: status === 409 ? 'Каталог изменён другим администратором. Обновите список и повторите действие' : 'Не удалось сохранить. Повторите позже' } }); }
        const body = route.request().postDataJSON() as { revision: number; commands: CatalogCommand[] };
        if (body.revision !== state.revision) return route.fulfill({ status: 409, json: { error: 'Конфликт версии' } });
        try { state = applyCatalogCommands(base, state, body.commands, 'CMDR Browser'); }
        catch (error) { return route.fulfill({ status: 400, json: { error: (error as Error).message } }); }
      }
      return route.fulfill({ status: 200, json: catalogSnapshot(base, state, 'supabase') });
    }
    if (path === '/api/outfitting/catalog') return route.fulfill({ status: 200, json: mergeCatalog(base, state) });
    return route.fulfill({ status: 200, json: {} });
  });
  await page.goto('/admin?tab=outfitting');
  await expect(page.getByRole('heading', { name: 'Управление верфью' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Добавить модуль' })).toBeEnabled();
  return { state: () => state, writes: () => writes, errors, fail: (status: number) => { failNext = status; } };
}

async function addModule(page: Page, name = 'Тестовый реактор') {
  await page.getByRole('button', { name: 'Добавить модуль' }).click();
  const dialog = page.getByRole('dialog', { name: 'Добавление модуля' });
  await dialog.getByLabel('Название', { exact: true }).fill(name);
  await dialog.getByLabel('ID записи').fill('test_reactor');
  await dialog.getByLabel('Группа модулей').selectOption('pp');
  await dialog.getByLabel('Класс', { exact: true }).fill('2');
  await dialog.getByLabel('Масса, t').fill('1.2');
  await dialog.getByLabel('Цена, CR').fill('42000');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: 'pp:test_reactor' })).toContainText(name);
}

test('module CRUD, copying, archive, restoration, public data and export work end to end', async ({ page }) => {
  const app = await fixture(page);
  await addModule(page);
  const row = page.locator('tbody tr').filter({ hasText: 'pp:test_reactor' });
  await row.getByRole('button', { name: 'Редактировать Тестовый реактор' }).click();
  const editor = page.getByRole('dialog', { name: 'Редактирование модуля' });
  await editor.getByLabel('Название', { exact: true }).fill('Переименованный реактор');
  await editor.getByRole('tab', { name: 'Характеристики' }).click();
  await editor.getByLabel('Выработка, MW').fill('25');
  await editor.getByRole('tab', { name: 'JSON', exact: true }).click();
  const field = editor.getByLabel('Данные записи (JSON)');
  const json = JSON.parse(await field.inputValue()); json.requirements = { horizons: true }; json.customStatistic = 2.5;
  await field.fill(JSON.stringify(json));
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(app.state().changes['module/pp:test_reactor'].value).toMatchObject({ name: 'Переименованный реактор', pgen: 25, requirements: { horizons: true }, customStatistic: 2.5 });
  await row.getByRole('button', { name: 'Копировать Переименованный реактор' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('dialog').getByLabel('ID записи').fill('copy_reactor');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByLabel('Поиск по каталогу').fill('pp:test_reactor');
  await row.getByRole('button', { name: 'Удалить Переименованный реактор' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(row).not.toBeVisible();
  await page.getByLabel('Фильтр состояния').selectOption('deleted');
  await row.getByRole('button', { name: 'Восстановить Переименованный реактор' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Восстановить', exact: true }).click();
  await expect(row).not.toBeVisible();
  await page.getByLabel('Фильтр состояния').selectOption('active');
  await expect(row).toContainText('Переименованный реактор');
  expect(app.state().revision).toBe(5);
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Экспорт JSON' }).click();
  const download = await downloadEvent;
  const exported = JSON.parse(readFileSync((await download.path())!, 'utf8')) as OutfittingData;
  expect(exported.catalogRevision).toBe(5);
  expect(exported.modules.pp.find(module => module.id === 'test_reactor')).toMatchObject({ name: 'Переименованный реактор', pgen: 25 });
  await page.getByRole('tab', { name: 'Журнал' }).click();
  await expect(page.getByRole('heading', { name: 'Журнал изменений' })).toBeVisible();
  await expect(page.locator('#shipyard-catalog-panel')).toContainText('CMDR Browser');
  await page.goto('/outfitting');
  await expect(page.getByRole('heading', { name: 'Верфь', exact: true })).toBeVisible();
  const module = await page.evaluate(async () => { const data = await (await fetch('/api/outfitting/catalog')).json(); return data.modules.pp.find((item: { id: string }) => item.id === 'test_reactor'); });
  expect(module).toMatchObject({ name: 'Переименованный реактор', pgen: 25 });
  await page.getByText('2E Реактор', { exact: true }).first().click();
  const picker = page.getByRole('dialog');
  await expect(picker.getByText('2A Переименованный реактор', { exact: true }).first()).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('group names, category changes for new groups and protected groups are handled safely', async ({ page }) => {
  const app = await fixture(page);
  await page.getByRole('tab', { name: 'Группы', exact: true }).click();
  await page.getByLabel('Поиск по каталогу').fill('abl');
  const row = page.locator('tbody tr').filter({ hasText: 'abl' }).first();
  await row.getByRole('button', { name: /Редактировать/ }).click();
  await page.getByRole('dialog').getByLabel('Название', { exact: true }).fill('Особые абразивные орудия');
  await page.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(row).toContainText('Особые абразивные орудия');
  expect(mergeCatalog(base, app.state()).groups.abl.customName).toBe(true);
  await page.getByRole('button', { name: 'Добавить группу' }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Название', { exact: true }).fill('Моя группа');
  await editor.getByLabel('Код группы').fill('testgroup');
  await editor.getByLabel('Категория', { exact: true }).selectOption('utility');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(page.locator('tbody tr').filter({ hasText: 'testgroup' })).toContainText('Моя группа');
  await page.getByLabel('Поиск по каталогу').fill('pp');
  await expect(page.locator('tbody tr').filter({ hasText: 'pp' }).first().getByRole('button', { name: /Удалить/ })).toBeDisabled();
  expect(app.errors).toEqual([]);
});

test('failed saves, revision conflicts and invalid JSON never discard the draft', async ({ page }) => {
  const app = await fixture(page);
  await page.getByRole('button', { name: 'Добавить модуль' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название', { exact: true }).fill('Не потерять черновик');
  await dialog.getByLabel('ID записи').fill('draft');
  app.fail(503);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Не удалось сохранить');
  await expect(dialog.getByLabel('Название', { exact: true })).toHaveValue('Не потерять черновик');
  app.fail(409);
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('другим администратором');
  await expect(dialog.getByLabel('ID записи')).toHaveValue('draft');
  await dialog.getByRole('tab', { name: 'JSON', exact: true }).click();
  await dialog.getByLabel('Данные записи (JSON)').fill('{broken');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('JSON');
  expect(app.writes()).toBe(2);
  page.once('dialog', confirmation => confirmation.dismiss());
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).toBeVisible();
  page.once('dialog', confirmation => confirmation.accept());
  await dialog.getByRole('button', { name: 'Отмена', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(app.errors).toEqual([]);
});

test('mobile layout keeps controls within the screen and dialogs work with keyboard', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const app = await fixture(page);
  const add = page.getByRole('button', { name: 'Добавить модуль' });
  await add.scrollIntoViewIfNeeded();
  const rect = await add.boundingBox();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(390);
  await add.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Название', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).not.toBeVisible();
  await expect(add).toBeFocused();
  await page.screenshot({ path: '.cache/admin-outfitting-mobile.png', fullPage: true });
  expect(app.errors).toEqual([]);
});

test('armour edits and archives preserve saved-build indices', async ({ page }) => {
  const app = await fixture(page);
  await page.getByRole('tab', { name: 'Броня', exact: true }).click();
  await page.getByLabel('Фильтр корабля').selectOption('sidewinder');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.first().getByRole('button', { name: /Удалить/ })).toBeDisabled();
  const row = rows.nth(2);
  await row.getByRole('button', { name: /Редактировать/ }).click();
  const editor = page.getByRole('dialog');
  await editor.getByLabel('Название', { exact: true }).fill('Особая броня');
  await editor.getByRole('tab', { name: 'Характеристики' }).click();
  await editor.getByLabel('Сопр. теплу, %').fill('-15');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).not.toBeVisible();
  await page.getByLabel('Фильтр корабля').selectOption('sidewinder');
  await page.getByLabel('Поиск по каталогу').fill('');
  await page.locator('tbody tr').filter({ hasText: 'Особая броня' }).getByRole('button', { name: /Удалить/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(rows).toHaveCount(4);
  const effective = mergeCatalog(base, app.state());
  expect(effective.ships.sidewinder.bulkheads).toHaveLength(5);
  expect(effective.ships.sidewinder.bulkheads[2]).toMatchObject({ name: 'Особая броня', thermres: -0.15, archived: true });
  expect(effective.ships.sidewinder.bulkheads[3].id).toBe(base.ships.sidewinder.bulkheads[3].id);
  expect(app.errors).toEqual([]);
});

test('admin deep links and browser back retain the requested section', async ({ page }) => {
  const app = await fixture(page);
  await page.getByRole('button', { name: 'Контент сайта' }).click();
  await page.getByRole('button', { name: /^Новости/ }).click();
  await expect(page).toHaveURL(/tab=news/);
  await page.goBack();
  await expect(page).toHaveURL(/tab=content/);
  await page.goBack();
  await expect(page).toHaveURL(/tab=outfitting/);
  await expect(page.getByRole('heading', { name: 'Управление верфью' })).toBeVisible();
  expect(app.errors).toEqual([]);
});

test('factory engineering can be edited and reset to the current source catalogue', async ({ page }) => {
  const app = await fixture(page);
  await page.getByLabel('Поиск по каталогу').fill('fsd:5U');
  const row = page.locator('tbody tr').filter({ hasText: 'fsd:5U' });
  await row.getByRole('button', { name: /^Редактировать/ }).click();
  const editor = page.getByRole('dialog');
  await editor.getByRole('tab', { name: 'Заводская настройка' }).click();
  await expect(editor.getByLabel('Заводской уровень')).toHaveValue('5');
  await editor.getByLabel('Заводской уровень').fill('4');
  await editor.getByLabel('Чертежи', { exact: true }).selectOption(['FSD_LongRange']);
  await editor.getByLabel('Описание заводской настройки').fill('Ручная настройка FSD');
  await editor.getByLabel('Дополнительные заводские модификаторы (JSON)').fill('{"mass": -0.1}');
  await editor.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(editor).not.toBeVisible();
  expect(app.state().changes['module/fsd:5U'].value).toMatchObject({ preEngineered: { grade: 4, blueprints: ['FSD_LongRange'], description: 'Ручная настройка FSD', features: { mass: -0.1 } } });
  await row.getByRole('button', { name: /^Сбросить изменения/ }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Сбросить к исходному' }).click();
  await expect(row).toContainText('Игровой');
  expect(app.state().revision).toBe(2);
  expect(app.state().changes['module/fsd:5U']).toBeUndefined();
  expect(mergeCatalog(base, app.state()).modules.fsd.find(module => module.id === '5U')).toEqual(base.modules.fsd.find(module => module.id === '5U'));
  expect(app.errors).toEqual([]);
});

test('bulk removal is a single atomic revision and leaves recoverable archive entries', async ({ page }) => {
  const app = await fixture(page);
  await page.getByLabel('Фильтр группы').selectOption('abl');
  const checks = page.getByRole('checkbox', { name: /^Выбрать abl:/ });
  const first = (await checks.nth(0).getAttribute('aria-label'))!.replace('Выбрать ', '');
  const second = (await checks.nth(1).getAttribute('aria-label'))!.replace('Выбрать ', '');
  await checks.nth(0).check();
  await checks.nth(1).check();
  await expect(page.getByText('Выбрано: 2')).toBeVisible();
  await page.getByRole('button', { name: 'Удалить выбранные' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить', exact: true }).click();
  await expect(page.getByText('Выбрано: 2')).not.toBeVisible();
  expect(app.writes()).toBe(1);
  expect(app.state().revision).toBe(1);
  expect(app.state().history).toHaveLength(2);
  expect(app.state().changes[`module/${first}`].deleted).toBe(true);
  expect(app.state().changes[`module/${second}`].deleted).toBe(true);
  await page.getByLabel('Фильтр состояния').selectOption('deleted');
  await expect(page.locator('tbody tr')).toHaveCount(2);
  await expect(page.locator('tbody tr').first().getByRole('button', { name: /^Восстановить/ })).toBeEnabled();
  expect(app.errors).toEqual([]);
});
