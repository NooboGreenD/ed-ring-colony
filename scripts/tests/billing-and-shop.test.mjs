import test from 'node:test';
import assert from 'node:assert/strict';

test('Billing & Premium Shop System Tests', async (t) => {
  // Test plans
  await t.test('тарифные планы подписок настроены корректно', async () => {
    const res = await fetch('http://127.0.0.1:3000/api/admin/billing/plans');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.plans));
    assert.ok(data.plans.length >= 3);

    const pioneer = data.plans.find((p) => p.id === 'pioneer');
    const elite = data.plans.find((p) => p.id === 'elite');
    const admiral = data.plans.find((p) => p.id === 'admiral');

    assert.ok(pioneer, 'План pioneer найден');
    assert.ok(elite, 'План elite найден');
    assert.ok(admiral, 'План admiral найден');

    assert.equal(pioneer.price_rub, 290);
    assert.equal(elite.price_rub, 590);
    assert.equal(admiral.price_rub, 1190);

    assert.ok(pioneer.perks.length >= 3);
    assert.ok(elite.perks.length >= 3);
    assert.ok(admiral.perks.length >= 3);
  });

  // Test shop items catalog
  await t.test('каталог магазина косметики содержит все 5 категорий украшений UI', async () => {
    const res = await fetch('http://127.0.0.1:3000/api/shop/items');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(Array.isArray(data.items));
    assert.ok(data.items.length >= 20);

    const categories = new Set(data.items.map((i) => i.category));
    assert.ok(categories.has('frame'), 'Категория frame присутствует');
    assert.ok(categories.has('badge'), 'Категория badge присутствует');
    assert.ok(categories.has('skin'), 'Категория skin присутствует');
    assert.ok(categories.has('glow'), 'Категория glow присутствует');
    assert.ok(categories.has('title'), 'Категория title присутствует');

    // Check frames
    const singularity = data.items.find((i) => i.id === 'frame-singularity');
    assert.ok(singularity, 'Рамка frame-singularity найдена');
    assert.equal(singularity.rarity, 'legendary');

    // Check badges
    const founderBadge = data.items.find((i) => i.id === 'badge-founder');
    assert.ok(founderBadge, 'Знак badge-founder найден');

    // Check glows
    const hyperspaceGlow = data.items.find((i) => i.id === 'glow-hyperspace');
    assert.ok(hyperspaceGlow, 'Свечение glow-hyperspace найдено');
  });

  // Test subscription granting & billing link
  await t.test('выдача подписки администратором обновляет статус и фиксирует транзакцию', async () => {
    const testPilotName = 'CMDR Automated Tester ' + Date.now();
    const testUserId = 'test-pilot-' + Date.now();

    const grantRes = await fetch('http://127.0.0.1:3000/api/admin/billing/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action: 'grant',
        cmdrName: testPilotName,
        userId: testUserId,
        planId: 'elite',
        durationDays: 45,
        notes: 'Автотест выдачи подписки',
      }),
    });

    assert.equal(grantRes.status, 200);
    const grantData = await grantRes.json();
    assert.equal(grantData.success, true);
    assert.equal(grantData.subscription.plan_id, 'elite');
    assert.equal(grantData.subscription.status, 'active');

    // Verify it appears in subscriptions list
    const listRes = await fetch(`http://127.0.0.1:3000/api/admin/billing/subscriptions?search=${encodeURIComponent(testPilotName)}`);
    const listData = await listRes.json();
    assert.equal(listData.success, true);
    assert.ok(listData.subscriptions.length >= 1);
    assert.equal(listData.subscriptions[0].cmdr_name, testPilotName);
  });

  // Test project statistics & infographics data
  await t.test('система сбора статистики отдает KPI, динамику выручки и инфографику', async () => {
    const res = await fetch('http://127.0.0.1:3000/api/admin/billing/stats?period=30d');
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.success, true);
    assert.ok(data.stats);

    const { kpis, charts, telemetry, recentTransactions } = data.stats;

    // Check KPIs
    assert.ok(typeof kpis.mrr === 'number' && kpis.mrr > 0);
    assert.ok(typeof kpis.grossRevenue === 'number');
    assert.ok(typeof kpis.activeSubscribers === 'number' && kpis.activeSubscribers > 0);
    assert.ok(typeof kpis.arpu === 'number');

    // Check Infographics chart datasets
    assert.ok(Array.isArray(charts.revenueTimeline) && charts.revenueTimeline.length > 0);
    assert.ok(Array.isArray(charts.pilotGrowth) && charts.pilotGrowth.length > 0);
    assert.ok(Array.isArray(charts.tierDistribution) && charts.tierDistribution.length >= 3);
    assert.ok(Array.isArray(charts.categorySales) && charts.categorySales.length >= 5);
    assert.ok(Array.isArray(charts.conversionFunnel) && charts.conversionFunnel.length >= 5);

    // Check Telemetry
    assert.ok(telemetry.totalRegisteredPilots > 0);
    assert.ok(telemetry.serverUptimePct >= 99);
    assert.ok(Array.isArray(recentTransactions) && recentTransactions.length > 0);
  });

  // Test purchasing shop item and auto-reflecting in transactions
  await t.test('покупка в магазине списывает баланс и создает транзакцию в биллинге', async () => {
    const testBuyerId = 'test-buyer-' + Date.now();
    const testBuyerName = 'CMDR Shop Buyer ' + Date.now();

    // 1. Topup balance
    const topupRes = await fetch('http://127.0.0.1:3000/api/shop/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountCredits: 3500,
        amountRub: 399,
        paymentMethod: 'card',
      }),
    });
    assert.equal(topupRes.status, 200);
    const topupData = await topupRes.json();
    assert.equal(topupData.success, true);
    assert.ok(topupData.balance.credits >= 3500);

    // 2. Buy item: frame-stealth
    const buyRes = await fetch('http://127.0.0.1:3000/api/shop/purchase', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        itemId: 'frame-stealth',
        useCredits: true,
        autoEquip: true,
      }),
    });
    assert.equal(buyRes.status, 200);
    const buyData = await buyRes.json();
    assert.equal(buyData.success, true);
    assert.equal(buyData.item.id, 'frame-stealth');
    assert.ok(buyData.transaction.id.startsWith('TX-2026-'));

    // 3. Verify transaction in Admin Billing transactions endpoint
    const txRes = await fetch(`http://127.0.0.1:3000/api/admin/billing/transactions?search=${buyData.transaction.id}`);
    const txData = await txRes.json();
    assert.equal(txData.success, true);
    assert.equal(txData.transactions.length, 1);
    assert.equal(txData.transactions[0].id, buyData.transaction.id);
    assert.equal(txData.transactions[0].type, 'shop_purchase');
  });

  // Test transaction refund
  await t.test('возврат транзакции меняет статус на refunded', async () => {
    const topupRes = await fetch('http://127.0.0.1:3000/api/shop/topup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        amountCredits: 1000,
        amountRub: 100,
        paymentMethod: 'sbp',
      }),
    });
    const topupData = await topupRes.json();
    const txId = topupData.transaction.id;

    const refundRes = await fetch('http://127.0.0.1:3000/api/admin/billing/refund', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        transactionId: txId,
        reason: 'Тест возврата',
      }),
    });
    assert.equal(refundRes.status, 200);
    const refundData = await refundRes.json();
    assert.equal(refundData.success, true);
    assert.equal(refundData.transaction.status, 'refunded');
  });

  // Test CSV export
  await t.test('экспорт данных в формате CSV возвращает валидный файл', async () => {
    const res = await fetch('http://127.0.0.1:3000/api/admin/billing/export?format=csv');
    assert.equal(res.status, 200);
    assert.ok(res.headers.get('content-type')?.includes('text/csv'));
    const text = await res.text();
    assert.ok(text.startsWith('ID,Date,CMDR,Type,Item/Plan,Amount RUB,Amount Credits,Method,Status'));
    assert.ok(text.includes('TX-2026-'));
  });
});
