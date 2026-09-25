import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SOURCING_OPTIONS,
  buildOffers,
  commodityNameVariants,
  distanceLy,
  formatCredits,
  normalizeCommodityKey,
  planSourcing,
  resolveSourcingOptions,
} from '../../src/lib/architect/sourcing.ts';

const ORIGIN = { x: 0, y: 0, z: 0 };
const COORDS = new Map([
  ['near', { x: 5, y: 0, z: 0 }],
  ['mid', { x: 0, y: 30, z: 0 }],
  ['far', { x: 0, y: 0, z: 200 }],
]);

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-25T12:00:00Z');

function row(overrides = {}) {
  return {
    station_name: 'Alpha Station',
    system_name: 'Near',
    commodity_name: '$Steel_Name;',
    sell_price: 500,
    stock: 600,
    reported_at: new Date(NOW - 2 * DAY).toISOString(),
    ...overrides,
  };
}

test('имена товаров приводятся к ключу каталога и обратно в варианты', () => {
  assert.equal(normalizeCommodityKey('$Steel_Name;'), 'steel');
  assert.equal(normalizeCommodityKey('CMM Composite'), 'cmmcomposite');
  assert.equal(normalizeCommodityKey('steel'), 'steel');
  assert.equal(normalizeCommodityKey('  Fruit and Vegetables '), 'fruitandvegetables');
  assert.equal(normalizeCommodityKey(null), '');
  assert.deepEqual(commodityNameVariants('steel'), ['$steel_name;', 'steel', 'Steel']);
  assert.deepEqual(commodityNameVariants(''), []);
});

test('расстояние считается по координатам, а без них — null', () => {
  assert.equal(distanceLy(ORIGIN, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(distanceLy(ORIGIN, null), null);
  assert.equal(distanceLy(null, ORIGIN), null);
});

test('предложения строятся только по товарам плана, без пустого стока и нулевой цены', () => {
  const offers = buildOffers(
    { steel: 100 },
    [
      row(),
      row({ commodity_name: 'Titanium', stock: 10 }),              // не в плане
      row({ stock: 0 }),                                            // нет в наличии
      row({ sell_price: 0 }),                                       // цена не указана
      row({ station_name: 'Beta Station', sell_price: 480, stock: 400 }),
    ],
    { origin: ORIGIN, coordsByName: COORDS, now: NOW },
  );

  assert.equal(offers.length, 2);
  assert.deepEqual(offers.map((offer) => offer.stationName), ['Alpha Station', 'Beta Station']);
  assert.equal(offers[0].key, 'steel');
  assert.equal(offers[0].label, 'Сталь');
  assert.equal(offers[0].distanceLy, 5);
  assert.equal(offers[0].ageDays, 2);
});

test('закупки идут с ближайших рынков, пока потребность не закрыта', () => {
  const cargo = { steel: 1000, titanium: 500 };
  const offers = buildOffers(cargo, [
    row(),                                                                     // 600 т по 500
    row({ station_name: 'Beta Station', sell_price: 480, stock: 400 }),        // 400 т по 480, ближе по цене
    row({ station_name: 'Far Base', system_name: 'Far', stock: 9999, sell_price: 100, commodity_name: 'Titanium' }),
    row({ station_name: 'Stale Market', system_name: 'Mid', reported_at: new Date(NOW - 40 * DAY).toISOString() }),
  ], { origin: ORIGIN, coordsByName: COORDS, now: NOW });

  const plan = planSourcing(cargo, offers, { capacityTons: 400, maxDistanceLy: 80, maxAgeDays: 30 });

  const steel = plan.commodities.find((item) => item.key === 'steel');
  assert.equal(steel.neededTons, 1000);
  assert.equal(steel.coveredTons, 1000);
  assert.equal(steel.remainingTons, 0);
  // Сначала дешёвые 400 т по 480, затем 600 т по 500.
  assert.deepEqual(steel.offers.map((offer) => [offer.stationName, offer.tons, offer.price]), [
    ['Beta Station', 400, 480],
    ['Alpha Station', 600, 500],
  ]);
  assert.equal(steel.estimatedCost, 400 * 480 + 600 * 500);
  assert.equal(steel.averagePrice, Math.round((400 * 480 + 600 * 500) / 1000));

  const titanium = plan.commodities.find((item) => item.key === 'titanium');
  assert.equal(titanium.coveredTons, 0, 'единственный рынок титана в 200 св. годах — за пределами поиска');
  assert.equal(titanium.remainingTons, 500);
  assert.equal(titanium.averagePrice, null);

  assert.deepEqual(plan.summary, {
    neededTons: 1500,
    coveredTons: 1000,
    remainingTons: 500,
    coveragePercent: 66.7,
    estimatedCost: 400 * 480 + 600 * 500,
    stationCount: 2,
    trips: 3,
    skipped: 2,
  });
});

test('список остановок группирует товары по станциям и считает рейсы', () => {
  const cargo = { steel: 1000, titanium: 300 };
  const offers = buildOffers(cargo, [
    row(),
    row({ station_name: 'Beta Station', sell_price: 480, stock: 400 }),
    row({ commodity_name: 'Titanium', stock: 300, sell_price: 1200 }),
  ], { origin: ORIGIN, coordsByName: COORDS, now: NOW });

  const plan = planSourcing(cargo, offers, { capacityTons: 400 });
  const alpha = plan.stops.find((stop) => stop.stationName === 'Alpha Station');

  assert.equal(plan.stops.length, 2);
  assert.equal(alpha.totalTons, 900, '600 т стали + 300 т титана одной станцией');
  assert.equal(alpha.trips, 3, '900 т при трюме 400 т — три рейса');
  assert.deepEqual(alpha.items.map((item) => [item.key, item.tons]), [['steel', 600], ['titanium', 300]]);
  assert.equal(alpha.totalCost, 600 * 500 + 300 * 1200);
  assert.equal(plan.summary.trips, 4);
});

test('параметры поиска ограничены снизу и не ломаются на мусоре', () => {
  const resolved = resolveSourcingOptions({ capacityTons: 0, maxDistanceLy: -5, maxAgeDays: 'не число' });
  assert.equal(resolved.capacityTons, 1);
  assert.equal(resolved.maxDistanceLy, 1);
  assert.equal(resolved.maxAgeDays, DEFAULT_SOURCING_OPTIONS.maxAgeDays);
  assert.equal(resolveSourcingOptions().maxOffersPerCommodity, DEFAULT_SOURCING_OPTIONS.maxOffersPerCommodity);
});

test('пустой план и пустая база дают честный пустой расчёт', () => {
  const empty = planSourcing({}, []);
  assert.deepEqual(empty.commodities, []);
  assert.deepEqual(empty.stops, []);
  assert.equal(empty.summary.coveragePercent, 0);
  assert.equal(empty.summary.neededTons, 0);

  const noMarket = planSourcing({ steel: 100 }, []);
  assert.equal(noMarket.commodities[0].coveredTons, 0);
  assert.equal(noMarket.summary.remainingTons, 100);
});

test('форматирование кредитов', () => {
  assert.equal(formatCredits(1_234_567), '1\u00a0234\u00a0567 кр.');
  assert.equal(formatCredits(0), '—');
  assert.equal(formatCredits(Number.NaN), '—');
});
