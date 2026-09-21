import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

test('Billing & Premium Shop System Data & Migration Tests', async (t) => {
  const storePath = path.join(process.cwd(), 'data', 'billing_store.json');
  const migrationPath = path.join(process.cwd(), 'supabase', 'migrations', '20260921000000_billing_and_premium_shop.sql');

  await t.test('файл миграции схемы базы данных существует и содержит все необходимые таблицы', () => {
    assert.ok(fs.existsSync(migrationPath), 'SQL-миграция найдена');
    const sql = fs.readFileSync(migrationPath, 'utf-8');

    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.billing_plans'), 'Таблица billing_plans');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.user_subscriptions'), 'Таблица user_subscriptions');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.shop_items'), 'Таблица shop_items');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.user_inventory'), 'Таблица user_inventory');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.user_cosmetics_equipped'), 'Таблица user_cosmetics_equipped');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.billing_transactions'), 'Таблица billing_transactions');
    assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS public.user_balances'), 'Таблица user_balances');
    assert.ok(sql.includes('ENABLE ROW LEVEL SECURITY'), 'RLS политики включены');
  });

  await t.test('персистентное хранилище содержит 3 преднастроенных тарифа подписки', () => {
    assert.ok(fs.existsSync(storePath), 'Файл billing_store.json существует');
    const raw = fs.readFileSync(storePath, 'utf-8');
    const store = JSON.parse(raw);

    assert.ok(Array.isArray(store.plans), 'plans - массив');
    assert.ok(store.plans.length >= 3, 'Не менее 3 планов');

    const pioneer = store.plans.find((p) => p.id === 'pioneer');
    const elite = store.plans.find((p) => p.id === 'elite');
    const admiral = store.plans.find((p) => p.id === 'admiral');

    assert.ok(pioneer, 'План pioneer найден');
    assert.ok(elite, 'План elite найден');
    assert.ok(admiral, 'План admiral найден');

    assert.equal(pioneer.price_rub, 290);
    assert.equal(elite.price_rub, 590);
    assert.equal(admiral.price_rub, 1190);

    assert.ok(pioneer.perks.length >= 4);
    assert.ok(elite.perks.length >= 5);
    assert.ok(admiral.perks.length >= 5);
  });

  await t.test('каталог магазина содержит все 5 категорий украшений UI (23 предмета)', () => {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const store = JSON.parse(raw);

    assert.ok(Array.isArray(store.shopItems), 'shopItems - массив');
    assert.ok(store.shopItems.length >= 20, 'Не менее 20 предметов косметики');

    const categories = new Set(store.shopItems.map((i) => i.category));
    assert.ok(categories.has('frame'), 'Категория frame');
    assert.ok(categories.has('badge'), 'Категория badge');
    assert.ok(categories.has('skin'), 'Категория skin');
    assert.ok(categories.has('glow'), 'Категория glow');
    assert.ok(categories.has('title'), 'Категория title');

    // Frames
    const frames = store.shopItems.filter((i) => i.category === 'frame');
    assert.equal(frames.length, 5, 'Ровно 5 рамок аватара');

    // Badges
    const badges = store.shopItems.filter((i) => i.category === 'badge');
    assert.equal(badges.length, 5, 'Ровно 5 знаков отличия');

    // Skins
    const skins = store.shopItems.filter((i) => i.category === 'skin');
    assert.equal(skins.length, 5, 'Ровно 5 тем интерфейса');

    // Glows
    const glows = store.shopItems.filter((i) => i.category === 'glow');
    assert.equal(glows.length, 4, 'Ровно 4 свечения позывного');

    // Titles
    const titles = store.shopItems.filter((i) => i.category === 'title');
    assert.equal(titles.length, 4, 'Ровно 4 почетных титула');
  });

  await t.test('история транзакций содержит зафиксированные финансовые операции', () => {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const store = JSON.parse(raw);

    assert.ok(Array.isArray(store.transactions), 'transactions - массив');
    assert.ok(store.transactions.length >= 50, 'Свыше 50 транзакций для аналитики');

    const sampleTx = store.transactions[0];
    assert.ok(sampleTx.id.startsWith('TX-2026-'), 'Префикс ID транзакции');
    assert.ok(sampleTx.created_at, 'Дата транзакции');
    assert.ok(sampleTx.type, 'Тип транзакции');
    assert.ok(sampleTx.status, 'Статус транзакции');
  });

  await t.test('активные подписчики корректно связаны с тарифами', () => {
    const raw = fs.readFileSync(storePath, 'utf-8');
    const store = JSON.parse(raw);

    assert.ok(Array.isArray(store.subscriptions), 'subscriptions - массив');
    assert.ok(store.subscriptions.length >= 10, 'База подписчиков сформирована');

    const activeSubs = store.subscriptions.filter((s) => s.status === 'active');
    assert.ok(activeSubs.length > 0, 'Есть активные подписки');

    for (const sub of activeSubs) {
      assert.ok(sub.plan_id, 'Каждая подписка имеет plan_id');
      assert.ok(['pioneer', 'elite', 'admiral'].includes(sub.plan_id), 'План валиден');
    }
  });
});
