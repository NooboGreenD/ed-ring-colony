import test from 'node:test';
import assert from 'node:assert/strict';
import { amountOf, isConstructionRow, summarizeCargo } from '../../src/lib/dossierCargo.ts';

test('«всего тонн» считает весь груз, «на стройку» — только площадки', () => {
  const summary = summarizeCargo([
    { amount: 100, system_name: 'Delta Velorum', is_construction: true },
    { amount: 40, system_name: 'Delta Velorum', is_construction: false },
    { amount: 25, system_name: 'Shinrarta Dezhra', is_construction: false },
  ]);
  assert.equal(summary.totalTons, 165);
  assert.equal(summary.siteTons, 100);
  assert.equal(summary.siteOps, 1);
  assert.equal(summary.transportOps, 2);
  assert.deepEqual(summary.siteSystems, [['Delta Velorum', 100]]);
  assert.equal(Math.round(summary.siteSharePercent), 61);
});

test('исторические строки без признака остаются стройкой', () => {
  // Иначе все досье, загруженные до миграции, обнулились бы.
  const summary = summarizeCargo([
    { amount: 70, system_name: 'Sol' },
    { amount: 30, system_name: 'Sol', is_construction: null },
    { amount: 10, system_name: 'Sol', is_construction: false },
  ]);
  assert.equal(summary.totalTons, 110);
  assert.equal(summary.siteTons, 100);
  assert.equal(summary.siteOps, 2);
});

test('битые и отрицательные значения не уменьшают чужой тоннаж', () => {
  assert.equal(amountOf('-12'), 0);
  assert.equal(amountOf(undefined), 0);
  assert.equal(amountOf(NaN), 0);
  assert.equal(amountOf(12.7), 12.7);
  const summary = summarizeCargo([
    { amount: 50, system_name: 'Sol', is_construction: true },
    { amount: -50, system_name: 'Sol', is_construction: true },
    { amount: 0, system_name: 'Sol', is_construction: true },
    null,
    undefined,
  ].filter((row) => row !== null && row !== undefined));
  assert.equal(summary.totalTons, 50);
  assert.equal(summary.siteTons, 50);
  assert.equal(summary.siteOps, 1);
});

test('пустое и отсутствие строк — ноль, а не NaN', () => {
  for (const rows of [[], null, undefined]) {
    const summary = summarizeCargo(rows);
    assert.equal(summary.totalTons, 0);
    assert.equal(summary.siteTons, 0);
    assert.equal(summary.siteSharePercent, 0);
    assert.deepEqual(summary.siteSystems, []);
  }
});

test('системы сортируются по тоннажу, имя нормализуется', () => {
  const summary = summarizeCargo([
    { amount: 10, system_name: '  delta   velorum ', is_construction: true },
    { amount: 30, system_name: 'Sol', is_construction: true },
  ]);
  assert.deepEqual(summary.siteSystems, [['Sol', 30], ['delta velorum', 10]]);
});

test('isConstructionRow: только явный false вычитает поставку', () => {
  assert.equal(isConstructionRow({ is_construction: true }), true);
  assert.equal(isConstructionRow({ is_construction: null }), true);
  assert.equal(isConstructionRow({}), true);
  assert.equal(isConstructionRow({ is_construction: false }), false);
  assert.equal(isConstructionRow(undefined), false);
});

/* ── структура перевозок: куда именно ушёл груз ── */

test('тоннаж раскладывается по получателю груза', () => {
  const summary = summarizeCargo([
    { amount: 100, system_name: 'Delta Velorum', commodity: 'Titanium', delivery_kind: 'construction_site' },
    { amount: 60, system_name: 'Delta Velorum', commodity: 'Steel', delivery_kind: 'colonisation_ship' },
    { amount: 40, system_name: 'Shinrarta Dezhra', commodity: 'Tritium', delivery_kind: 'fleet_carrier' },
    { amount: 30, system_name: 'Deciat', commodity: 'Basic Medicines', delivery_kind: 'mission_delivery' },
    { amount: 20, system_name: 'Sol', commodity: 'Gold', delivery_kind: 'market_sale' },
    { amount: 5, system_name: 'Achenar', commodity: 'Meta Alloys', delivery_kind: 'powerplay_delivery' },
    { amount: 3, system_name: 'Epsilon Indi', commodity: 'Rescue Supplies', delivery_kind: 'rescue_delivery' },
  ]);

  assert.equal(summary.totalTons, 258);
  assert.equal(summary.siteTons, 160);
  assert.equal(summary.transportTons, 98);
  assert.equal(summary.siteOps, 2);
  assert.equal(summary.transportOps, 5);
  assert.deepEqual(
    summary.kinds.map((entry) => [entry.kind, entry.tons]),
    [
      ['construction_site', 100],
      ['colonisation_ship', 60],
      ['fleet_carrier', 40],
      ['mission_delivery', 30],
      ['powerplay_delivery', 5],
      ['rescue_delivery', 3],
      ['market_sale', 20],
    ],
  );
  assert.deepEqual(summary.siteSystems, [['Delta Velorum', 160]]);
  assert.deepEqual(summary.siteCommodities, [['Titanium', 100], ['Steel', 60]]);
  assert.deepEqual(summary.transportSystems, [
    ['Shinrarta Dezhra', 40],
    ['Deciat', 30],
    ['Sol', 20],
    ['Achenar', 5],
    ['Epsilon Indi', 3],
  ]);
  assert.equal(Math.round(summary.siteSharePercent), 62);
});

test('строки без delivery_kind разбираются по источнику журнала', () => {
  const summary = summarizeCargo([
    { amount: 70, system_name: 'Sol', source: 'colonisation_contribution', is_construction: true },
    { amount: 40, system_name: 'Sol', source: 'carrier_delivery', is_construction: false },
    { amount: 25, system_name: 'Sol', source: 'cargo_depot', is_construction: false },
    { amount: 10, system_name: 'Sol', source: 'cargo_delta', is_construction: false },
    { amount: 5, system_name: 'Sol' },
  ]);
  assert.equal(summary.kindTons.construction_site, 70);
  assert.equal(summary.kindTons.fleet_carrier, 40);
  assert.equal(summary.kindTons.mission_delivery, 25);
  assert.equal(summary.kindTons.market_sale, 10);
  assert.equal(summary.kindTons.legacy_site, 5);
  assert.equal(summary.siteTons, 75);
  assert.equal(summary.transportTons, 75);
});

test('груз миссий больше не попадает в строительный тоннаж', () => {
  const summary = summarizeCargo([
    { amount: 200, system_name: 'Sol', delivery_kind: 'mission_delivery' },
    { amount: 50, system_name: 'Sol', delivery_kind: 'construction_site' },
  ]);
  assert.equal(summary.siteTons, 50);
  assert.equal(summary.transportTons, 200);
  assert.equal(summary.siteOps, 1);
});

test('битый delivery_kind игнорируется, строка решается по остальным полям', () => {
  const summary = summarizeCargo([
    { amount: 10, system_name: 'Sol', delivery_kind: 'whatever', is_construction: true },
    { amount: 4, system_name: 'Sol', delivery_kind: '  ', is_construction: false },
  ]);
  assert.equal(summary.kindTons.legacy_site, 10);
  assert.equal(summary.kindTons.market_sale, 4);
});
