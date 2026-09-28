/**
 * Числа для инфографики «Архитектора» (`src/lib/architect/insights.ts`).
 *
 * Графики рисуются по этим значениям, поэтому здесь проверяется главное:
 * доли складываются в 100 %, бюджет очков совпадает с расчётом плана, а
 * «пульс» и рейсы считаются без деления на ноль и без сюрпризов округления.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyLoads,
  cargoShares,
  economyShares,
  effectBars,
  haulTrips,
  planPulse,
  statusBreakdown,
  tierBudgets,
} from '../../src/lib/architect/insights.ts';
import {
  addSite,
  createPlan,
  evaluatePlan,
  fromScanRecords,
  setSiteStatus,
} from '../../src/lib/architect/planner.ts';

const SYSTEM = 'Insightest';

function rows() {
  return [
    {
      body_name: `${SYSTEM} A`, body_id: 0, body_type: 'Star', sub_type: 'K (Yellow-Orange) Star',
      distance_ls: 0, radius_m: 4.8e8, surface_temp_k: 4200, gravity: 0, is_landable: false, rings: [],
    },
    {
      body_name: `${SYSTEM} A 1`, body_id: 1, body_type: 'Planet', sub_type: 'Rocky body',
      distance_ls: 110, radius_m: 3_000_000, gravity: 0.8, surface_temp_k: 240, is_landable: true, rings: [],
    },
    {
      body_name: `${SYSTEM} A 2`, body_id: 2, body_type: 'Planet', sub_type: 'High metal content world',
      distance_ls: 320, radius_m: 4_200_000, gravity: 0.9, surface_temp_k: 280, is_landable: true, rings: [],
    },
  ];
}

/** План: порт на орбите звезды + пара наземных построек. */
function buildPlan() {
  const bodies = fromScanRecords(rows(), SYSTEM);
  let plan = createPlan(SYSTEM);
  plan = addSite(plan, `${SYSTEM} A`, 'no_truss', { primary: true });
  plan = addSite(plan, `${SYSTEM} A 1`, 'consus');
  plan = addSite(plan, `${SYSTEM} A 2`, 'consus');
  return { plan, bodies, evaluation: evaluatePlan(plan, bodies) };
}

test('доли товаров: сумма процентов — 100, «прочее» собирает хвост', () => {
  const { evaluation } = buildPlan();
  const { items, total } = cargoShares(evaluation, 3);

  assert.ok(items.length > 0, 'план возит товары');
  assert.ok(items.length <= 4, 'не больше лимита плюс «прочее»');
  assert.equal(total, Object.values(evaluation.cargo).reduce((sum, tons) => sum + tons, 0));
  const percent = items.reduce((sum, item) => sum + item.percent, 0);
  assert.ok(Math.abs(percent - 100) <= 0.6, `доли должны складываться в 100 %, получилось ${percent}`);
  const rest = items.find((item) => item.key === '__rest__');
  assert.ok(rest, 'хвост свёрнут в «прочее»');
  assert.match(rest.label, /прочее/);
});

test('доли товаров: пустой план не делит на ноль', () => {
  const evaluation = evaluatePlan(createPlan(SYSTEM), []);
  const { items, total } = cargoShares(evaluation);
  assert.deepEqual(items, []);
  assert.equal(total, 0);
});

test('бюджет очков повторяет расчёт плана и находит шаг, где очков не хватило', () => {
  const { evaluation } = buildPlan();
  const [tier2, tier3] = tierBudgets(evaluation);

  assert.equal(tier2.tier, 2);
  assert.equal(tier2.free, evaluation.tierPoints.tier2);
  assert.equal(tier2.spent, evaluation.tierSpent.tier2);
  assert.equal(tier2.given, evaluation.tierGiven.tier2);
  assert.equal(tier3.free, evaluation.tierPoints.tier3);

  // Дефицит ищется по той же шкале времени, что рисует график.
  const deficit = evaluation.timeline.find((step) => step.tier2After < 0);
  assert.equal(tier2.firstDeficitStep, deficit ? deficit.index : null);
  assert.ok(tier2.lowest <= 0 || evaluation.timeline.length === 0);
});

test('бюджет очков: перерасход виден как отрицательный минимум и номер шага', () => {
  const bodies = fromScanRecords(rows(), SYSTEM);
  let plan = createPlan(SYSTEM);
  // Два звёздных порта подряд без источников очков — второй уходит в минус.
  plan = addSite(plan, `${SYSTEM} A`, 'no_truss', { primary: true });
  plan = addSite(plan, `${SYSTEM} A 1`, 'no_truss');
  const evaluation = evaluatePlan(plan, bodies);
  const [tier2] = tierBudgets(evaluation);

  assert.ok(evaluation.timeline.length === 2);
  assert.ok(tier2.firstDeficitStep !== null, 'дефицит очков обязан быть найден');
  assert.ok(tier2.lowest < 0, 'минимум баланса отрицательный');
});

test('статусы построек: план/строится/готово с долями', () => {
  const { plan } = buildPlan();
  const withStatus = setSiteStatus(plan, plan.sites[1].id, 'complete');
  const breakdown = statusBreakdown(withStatus);

  const byStatus = Object.fromEntries(breakdown.map((entry) => [entry.status, entry]));
  assert.equal(byStatus.complete.count, 1);
  assert.equal(byStatus.plan.count, 2);
  const percent = breakdown.reduce((sum, entry) => sum + entry.percent, 0);
  assert.ok(Math.abs(percent - 100) <= 0.6);
});

test('экономики: считаются по постройкам плана и имеют русские подписи', () => {
  const { evaluation } = buildPlan();
  const shares = economyShares(evaluation);
  assert.ok(shares.length > 0);
  for (const share of shares) {
    assert.ok(share.label.length > 0, 'у экономики есть подпись');
    assert.ok(share.value > 0);
  }
});

test('полосы эффектов: масштаб считается от самого большого по модулю', () => {
  const { evaluation } = buildPlan();
  const bars = effectBars(evaluation);
  assert.equal(bars.length, 7, 'семь показателей системы');
  const peak = Math.max(...bars.map((bar) => Math.abs(bar.value)));
  const top = bars.find((bar) => Math.abs(bar.value) === peak);
  if (peak > 0) assert.equal(top.magnitude, 100, 'максимум занимает всю полосу');
  for (const bar of bars) {
    assert.ok(bar.magnitude >= 0 && bar.magnitude <= 100);
  }
});

test('загрузка тел: наземные слоты и орбитальные постройки по каждому телу', () => {
  const { plan, bodies } = buildPlan();
  const loads = bodyLoads(plan, bodies);
  const first = loads.find((entry) => entry.name === `${SYSTEM} A 1`);

  assert.ok(first, 'тело с постройкой попало в список');
  assert.equal(first.used, 1);
  assert.ok(first.limit >= 1);
  assert.equal(first.percent, Math.round((first.used / first.limit) * 100));

  const star = loads.find((entry) => entry.name === `${SYSTEM} A`);
  assert.equal(star.orbital, 1, 'порт у звезды считается орбитальным');
});

test('загрузка тел: имя тела из чужого источника попадает на нужное тело', () => {
  const bodies = fromScanRecords(rows(), SYSTEM);
  let plan = createPlan(SYSTEM);
  plan = addSite(plan, `${SYSTEM}  a 1`, 'consus'); // двойной пробел и иной регистр
  const loads = bodyLoads(plan, bodies);
  const target = loads.find((entry) => entry.name === `${SYSTEM} A 1`);
  assert.equal(target.used, 1, 'написание не должно расщеплять тело надвое');
});

test('рейсы: округление вверх, ноль вместимости — ноль рейсов', () => {
  assert.equal(haulTrips(1000, 400), 3);
  assert.equal(haulTrips(800, 400), 2);
  assert.equal(haulTrips(0, 400), 0);
  assert.equal(haulTrips(1000, 0), 0);
  assert.equal(haulTrips(Number.NaN, 400), 0);
});

test('пульс плана: постройки, тела, тоннаж и рейсы тремя трюмами', () => {
  const { plan, evaluation } = buildPlan();
  const pulse = planPulse(plan, evaluation);

  assert.equal(pulse.sites, 3);
  assert.equal(pulse.bodiesUsed, 3);
  assert.equal(pulse.tons, evaluation.haulTons);
  assert.equal(pulse.trips.length, 3);
  assert.deepEqual(pulse.trips.map((entry) => entry.capacity), [400, 784, 25_000]);
  assert.equal(pulse.trips[0].trips, Math.ceil(evaluation.haulTons / 400));
});
