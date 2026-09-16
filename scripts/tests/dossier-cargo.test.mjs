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
