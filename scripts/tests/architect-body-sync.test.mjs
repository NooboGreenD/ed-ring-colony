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
  compareBodySources,
  compareSystemBodies,
  normalizeEdsmBody,
  normalizeSpanshBody,
  parseSyncReport,
  scoreBodyRecord,
} from '../../src/lib/architect/bodySync.ts';

const NOW = Date.parse('2026-09-26T12:00:00Z');
const DAY = 86_400_000;

function dbRow(overrides = {}) {
  return {
    system_name: 'Colonia',
    body_name: 'Colonia 2',
    // Номер тела в записи базы заполнен: иначе сверка справедливо дополнит
    // его из EDSM, и запись перестанет быть «чистой базой без изменений».
    body_id: 2,
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

/* --- Третий источник: Spansh (тот же, из которого импортирует Raven Colonial) --- */

function spanshBody(overrides = {}) {
  return normalizeSpanshBody('Colonia', {
    name: 'Colonia 2',
    bodyId: 12,
    type: 'Planet',
    subType: 'High metal content world',
    distanceToArrival: 120,
    radius: 4000,
    gravity: 0.9,
    surfaceTemperature: 210,
    isLandable: true,
    terraformingState: 'Candidate for terraforming',
    signals: { signals: { '$SAA_SignalType_Biological;': 3, '$SAA_SignalType_Geological;': 2 }, genuses: ['Bacterium'] },
    updateTime: '2026-09-25 04:46:07',
    ...overrides,
  });
}

test('normalizeSpanshBody: сигналы, терраформирование и время обновления читаются из дампа', () => {
  const row = spanshBody();
  assert.equal(row.system_name, 'Colonia');
  assert.equal(row.body_name, 'Colonia 2');
  assert.equal(row.body_id, 12);
  assert.equal(row.radius_m, 4_000_000);
  assert.equal(row.bio_signals_count, 3, 'биологические сигналы Spansh отдаёт словарём');
  assert.equal(row.geo_signals_count, 2);
  assert.equal(row.is_terraformable, true);
  assert.deepEqual(row.bio_genuses, ['Bacterium']);
  assert.equal(row.source, 'spansh');
  assert.equal(row.updated_at, '2026-09-25T04:46:07.000Z', 'время дампа приводится к ISO');
});

test('normalizeSpanshBody: звезда переводится из солнечных радиусов в метры', () => {
  const row = spanshBody({ name: 'Colonia A', type: 'Star', subType: 'K (Yellow-Orange) Star', radius: undefined, solarRadius: 0.8, signals: undefined });
  assert.ok(Math.abs(row.radius_m - 0.8 * 6.957e8) < 1);
  assert.equal(row.bio_signals_count, 0, 'без сигналов — честный ноль');
});

test('compareBodySources: три источника сверяются по точности, а не по порядку', () => {
  const dbRows = [dbRow({ body_name: 'Colonia 2', sub_type: null, gravity: 0, bio_signals_count: 0, updated_at: new Date(NOW - 400 * DAY).toISOString() })];
  const edsmRows = [edsmRow({ name: 'Colonia 2', subType: 'High metal content body', gravity: 0.9 })];
  const spanshRows = [spanshBody()];

  const { bodies, stats } = compareBodySources({ database: dbRows, edsm: edsmRows, spansh: spanshRows }, { now: NOW });

  assert.equal(stats.total, 1, 'одно тело, а не три строки');
  const body = bodies[0];
  assert.equal(body.bio_signals_count, 3, 'сигналы пришли из Spansh');
  assert.ok(body.sub_type, 'класс тела не потерялся');
  assert.ok(body.gravity > 0, 'гравитация подтянулась из источника, где она есть');
});

test('compareBodySources: сигналы из базы игрока сильнее пустого Spansh', () => {
  const dbRows = [dbRow({ body_name: 'Colonia 2', bio_signals_count: 6, scanned_by_cmdr: 'CMDR X' })];
  const spanshRows = [spanshBody({ signals: undefined })];
  const { bodies } = compareBodySources({ database: dbRows, spansh: spanshRows }, { now: NOW });
  assert.equal(bodies[0].bio_signals_count, 6);
});

test('compareBodySources: дубли внутри одного источника схлопываются, а не дублируют тело', () => {
  const dbRows = [
    dbRow({ body_name: 'Colonia 2', bio_signals_count: 4, sub_type: null }),
    dbRow({ body_name: 'Colonia  2 ', sub_type: 'High metal content body' }),
  ];
  const { bodies, stats, duplicates } = compareBodySources({ database: dbRows }, { now: NOW });

  assert.equal(stats.total, 1, 'два написания одного имени — одно тело');
  assert.equal(duplicates.database, 1, 'дубль посчитан и показан пользователю');
  assert.equal(bodies[0].bio_signals_count, 4, 'сигналы победившей записи сохранены');
  assert.equal(bodies[0].sub_type, 'High metal content body', 'класс достроен из дубля');
});

test('compareBodySources: порядок тел — по расстоянию, затем по номеру тела', () => {
  const rows = [
    dbRow({ body_name: 'Colonia 3', distance_ls: 900, body_id: 3 }),
    dbRow({ body_name: 'Colonia 1', distance_ls: 10, body_id: 1 }),
    dbRow({ body_name: 'Colonia 2', distance_ls: 10, body_id: 2 }),
  ];
  const { bodies } = compareBodySources({ database: rows }, { now: NOW });
  assert.deepEqual(bodies.map((b) => b.body_name), ['Colonia 1', 'Colonia 2', 'Colonia 3']);
});

test('parseSyncReport: ответ маршрута превращается в состояние источников для панели', () => {
  const report = parseSyncReport({
    sources: { database: 4, edsm: 1, spansh: 2, merged: 3, total: 10 },
    sync: {
      database: { status: 'ok', count: 7, updatedAt: '2026-09-27T08:00:00Z' },
      edsm: { status: 'unavailable', count: 0, updatedAt: null, note: 'HTTP 500' },
      spansh: { status: 'skipped', count: 0, updatedAt: null, note: 'too-large' },
      cached: 5,
      duplicates: { database: 2, edsm: 0 },
    },
  });

  assert.deepEqual(report.sources.map((entry) => entry.id), ['database', 'edsm', 'spansh']);
  assert.equal(report.sources[0].label, 'База проекта');
  assert.equal(report.sources[1].status, 'unavailable');
  assert.equal(report.sources[1].note, 'HTTP 500');
  assert.equal(report.sources[2].status, 'skipped');
  assert.equal(report.cached, 5);
  assert.deepEqual(report.duplicates, { database: 2 }, 'нулевые дубли не показываем');
  assert.equal(report.winners.total, 10);
});

test('parseSyncReport: мусор на входе не роняет панель', () => {
  const report = parseSyncReport(null);
  assert.deepEqual(report.sources, []);
  assert.equal(report.cached, 0);
  assert.equal(report.winners.total, 0);
});
