/**
 * Сверка тел системы между базой проекта и EDSM (`src/lib/architect/bodySync.ts`).
 *
 * Проверяет ровно то, что просили в задаче: при загрузке системы для
 * «Архитектора» данные не берутся слепо из одного источника — оба
 * сравниваются, и для каждого тела остаётся более точная/свежая запись, а
 * не отбрасывается то, чего не хватает победителю.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareBodyRecords,
  compareSystemBodies,
  normalizeEdsmBody,
  scoreBodyRecord,
} from '../../src/lib/architect/bodySync.ts';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86_400_000;

function dbRow(overrides = {}) {
  return {
    system_name: 'Colonia',
    body_name: 'Colonia 2',
    body_type: 'Planet',
    sub_type: 'High metal content body',
    distance_ls: 120,
    radius_m: 4_000_000,
    gravity: 0.9,
    earth_masses: 0.5,
    surface_temp_k: 210,
    surface_pressure: 0,
    volcanism: null,
    atmosphere: null,
    atmosphere_type: null,
    atmosphere_composition: [],
    solid_composition: {},
    materials: {},
    rings: [],
    is_landable: true,
    bio_signals_count: 0,
    geo_signals_count: 0,
    human_signals_count: 0,
    thargoid_signals_count: 0,
    guardian_signals_count: 0,
    other_signals_count: 0,
    signals: [],
    bio_genuses: [],
    first_discovered_by: null,
    first_mapped_by: null,
    first_footfall_by: null,
    scanned_by_cmdr: null,
    source: 'journal',
    raw_data: {},
    updated_at: new Date(NOW - 5 * DAY).toISOString(),
    ...overrides,
  };
}

function edsmRow(overrides = {}) {
  return normalizeEdsmBody('Colonia', {
    name: 'Colonia 2',
    bodyId: 2,
    type: 'Planet',
    subType: 'High metal content body',
    distanceToArrival: 120,
    radius: 4200,
    gravity: 0.92,
    earthMasses: 0.52,
    surfaceTemperature: 208,
    isLandable: true,
    rings: [],
    ...overrides,
  });
}

test('scoreBodyRecord: сигналы и отметка сканирования командиром весят больше, чем просто заполненные поля', () => {
  const plain = dbRow();
  const scored = scoreBodyRecord(plain, { now: NOW });
  const withSignals = dbRow({ bio_signals_count: 3, scanned_by_cmdr: 'CMDR Test' });
  const scoredWithSignals = scoreBodyRecord(withSignals, { now: NOW });
  assert.ok(scoredWithSignals > scored + 5, 'сигналы и командир должны заметно поднимать счёт');
});

test('scoreBodyRecord: свежая запись получает бонус, старая — нет', () => {
  const fresh = scoreBodyRecord(dbRow({ updated_at: new Date(NOW - 12 * 60 * 60 * 1000).toISOString() }), { now: NOW });
  const stale = scoreBodyRecord(dbRow({ updated_at: new Date(NOW - 400 * DAY).toISOString() }), { now: NOW });
  assert.ok(fresh > stale);
});

test('compareBodyRecords: без второго источника отдаёт то, что есть, без слияния', () => {
  const onlyDb = compareBodyRecords(dbRow(), null, { now: NOW });
  assert.equal(onlyDb.source, 'database');
  assert.equal(onlyDb.edsmScore, null);

  const onlyEdsm = compareBodyRecords(null, edsmRow(), { now: NOW });
  assert.equal(onlyEdsm.source, 'edsm');
  assert.equal(onlyEdsm.dbScore, null);
});

test('compareBodyRecords: реальные сигналы из базы побеждают даже более свежую, но пустую EDSM-запись', () => {
  const withSignals = dbRow({
    bio_signals_count: 4,
    bio_genuses: ['Bacterium'],
    scanned_by_cmdr: 'CMDR Explorer',
    updated_at: new Date(NOW - 200 * DAY).toISOString(),
  });
  const freshButEmpty = edsmRow();
  const result = compareBodyRecords(withSignals, freshButEmpty, { now: NOW });
  assert.equal(result.source, 'database');
  assert.equal(result.record.bio_signals_count, 4);
});

test('compareBodyRecords: пустые поля победителя достраиваются из второго источника (результат — merged)', () => {
  // У базы нет данных об атмосфере и составе, у EDSM — есть; сигналов и
  // отметки командира нет ни там, ни там, поэтому побеждает более свежая
  // и физически более полная EDSM-запись, а не пустая база.
  const sparseDb = dbRow({
    radius_m: 0,
    gravity: 0,
    earth_masses: 0,
    surface_temp_k: 0,
    updated_at: new Date(NOW - 500 * DAY).toISOString(),
  });
  const richEdsm = edsmRow({ atmosphereType: 'Thin nitrogen', volcanismType: 'Minor rocky magma' });
  const result = compareBodyRecords(sparseDb, richEdsm, { now: NOW });
  assert.equal(result.source, 'edsm');
  assert.equal(result.record.atmosphere, 'Thin nitrogen');
});

test('compareBodyRecords: победитель без сигналов дополняется сигналами проигравшей записи', () => {
  // Более полная физически и свежая запись — из EDSM, но у старой записи базы
  // сохранились реальные сигналы тела: они не должны потеряться при сверке.
  const oldWithSignals = dbRow({
    bio_signals_count: 2,
    bio_genuses: ['Bacterium'],
    radius_m: 0,
    gravity: 0,
    updated_at: new Date(NOW - 600 * DAY).toISOString(),
  });
  const freshEdsm = edsmRow({ atmosphereType: 'Thin nitrogen' });
  const result = compareBodyRecords(oldWithSignals, freshEdsm, { now: NOW });
  assert.equal(result.source, 'merged');
  assert.equal(result.record.bio_signals_count, 2);
  assert.equal(result.record.atmosphere, 'Thin nitrogen');
  assert.ok(result.filledFrom.includes('bio_signals_count'));
});

test('compareSystemBodies: считает статистику по источникам и сортирует по расстоянию', () => {
  const dbRows = [
    dbRow({ body_name: 'Colonia 1', distance_ls: 50, bio_signals_count: 1 }),
    dbRow({ body_name: 'Colonia 3', distance_ls: 900 }),
  ];
  const edsmRows = [
    edsmRow({ name: 'Colonia 1', distanceToArrival: 50 }),
    edsmRow({ name: 'Colonia 2', distanceToArrival: 120 }),
  ];
  const { bodies, stats } = compareSystemBodies(dbRows, edsmRows, { now: NOW });
  assert.equal(stats.total, 3);
  assert.equal(stats.edsm, 1); // Colonia 2 — только в EDSM
  assert.deepEqual(bodies.map((b) => b.body_name), ['Colonia 1', 'Colonia 2', 'Colonia 3']);
});

test('compareSystemBodies: список на запись в базу не включает тела, где источник — чистая база без изменений', () => {
  const dbRows = [dbRow({ body_name: 'Colonia 1', bio_signals_count: 5, scanned_by_cmdr: 'CMDR X' })];
  const edsmRows = [edsmRow({ name: 'Colonia 1' })];
  const { toUpsert } = compareSystemBodies(dbRows, edsmRows, { now: NOW });
  assert.equal(toUpsert.length, 0);
});

test('compareSystemBodies: тело, найденное только в EDSM, идёт в список на запись в базу', () => {
  const edsmRows = [edsmRow({ name: 'Colonia 9', distanceToArrival: 5000 })];
  const { toUpsert, stats } = compareSystemBodies([], edsmRows, { now: NOW });
  assert.equal(stats.edsm, 1);
  assert.equal(toUpsert.length, 1);
  assert.equal(toUpsert[0].body_name, 'Colonia 9');
  assert.equal('id' in toUpsert[0], false);
});

test('normalizeEdsmBody: приводит тело EDSM к форме system_scans с честными нулями по сигналам', () => {
  const row = normalizeEdsmBody('Colonia', {
    name: 'Colonia 4 a',
    bodyId: 7,
    subType: 'Icy body',
    distanceToArrival: 300,
    radius: 1000,
    isLandable: true,
    discovery: { commander: 'CMDR First' },
  });
  assert.equal(row.system_name, 'Colonia');
  assert.equal(row.body_name, 'Colonia 4 a');
  assert.equal(row.radius_m, 1_000_000);
  assert.equal(row.bio_signals_count, 0);
  assert.equal(row.first_discovered_by, 'CMDR First');
  assert.equal(row.source, 'edsm');
});
