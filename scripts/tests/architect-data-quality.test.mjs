/**
 * Аудит загруженных данных «Архитектора» (`src/lib/architect/dataQuality.ts`).
 *
 * Проверяет ровно то, ради чего модуль появился: найти дубли тел, пустые
 * ключевые поля и невозможные значения раньше, чем пользователь построит по
 * ним план. Отчёт обязан быть честным — если данных мало, оценка низкая, а
 * список замечаний конкретный, с именами тел.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { auditBodyRows, auditPlanData } from '../../src/lib/architect/dataQuality.ts';
import { addSite, createPlan, fromScanRecords } from '../../src/lib/architect/planner.ts';

const SYSTEM = 'Auditest';

function row(overrides = {}) {
  return {
    system_name: SYSTEM,
    body_name: `${SYSTEM} A 1`,
    body_id: 1,
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: 120,
    radius_m: 3_000_000,
    gravity: 0.8,
    surface_temp_k: 240,
    is_landable: true,
    rings: [],
    source: 'helper',
    updated_at: '2026-09-20T10:00:00Z',
    ...overrides,
  };
}

function issueCodes(report) {
  return report.issues.map((entry) => entry.code);
}

test('аудит тел: полные данные дают высокую оценку и пустой список замечаний', () => {
  const report = auditBodyRows([
    row(),
    row({ body_name: `${SYSTEM} A 2`, body_id: 2, distance_ls: 480 }),
  ], { system: SYSTEM });

  assert.equal(report.rawCount, 2);
  assert.equal(report.total, 2);
  assert.deepEqual(report.duplicates, []);
  assert.equal(report.coverage.name, 1);
  assert.equal(report.coverage.subType, 1);
  assert.equal(report.issues.length, 0, `лишние замечания: ${issueCodes(report).join(', ')}`);
  assert.ok(report.score >= 80, `оценка полного набора должна быть высокой, а не ${report.score}`);
});

test('аудит тел: повтор имени с другим регистром и пробелами считается дублем', () => {
  const report = auditBodyRows([
    row(),
    row({ body_name: `${SYSTEM}  a 1` }),
    row({ body_name: `${SYSTEM} A 1 ` }),
  ], { system: SYSTEM });

  assert.equal(report.rawCount, 3);
  assert.equal(report.total, 1, 'три написания одного имени — одно тело');
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].count, 3);
  assert.ok(issueCodes(report).includes('duplicate-bodies'));
  assert.ok(report.score < 100);
});

test('аудит тел: разные тела под одним bodyId помечаются конфликтом', () => {
  const report = auditBodyRows([
    row(),
    row({ body_name: `${SYSTEM} A 2`, body_id: 1 }),
  ], { system: SYSTEM });

  assert.ok(issueCodes(report).includes('body-id-conflict'));
  const conflict = report.issues.find((entry) => entry.code === 'body-id-conflict');
  assert.equal(conflict.level, 'warning');
});

test('аудит тел: посадочное тело без гравитации и радиуса — ошибка расчёта слотов', () => {
  const report = auditBodyRows([
    row({ gravity: 0, radius_m: 0 }),
  ], { system: SYSTEM });

  const codes = issueCodes(report);
  assert.ok(codes.includes('landable-no-gravity'), 'без гравитации нельзя судить о посадке');
  assert.ok(codes.includes('landable-no-radius'), 'без радиуса нельзя посчитать наземные слоты');
  assert.ok(report.score < 70, 'оценка обязана просесть');
});

test('аудит тел: невозможные значения ловятся по физике, а не по «на глаз»', () => {
  const report = auditBodyRows([
    row({ body_name: `${SYSTEM} B 1`, gravity: 44 }),
    row({ body_name: `${SYSTEM} B 2`, surface_temp_k: 9000 }),
    row({ body_name: `${SYSTEM} B 3`, radius_m: 9e11 }),
  ], { system: SYSTEM });

  const codes = issueCodes(report);
  assert.ok(codes.includes('impossible-gravity'));
  assert.ok(codes.includes('impossible-temperature'));
  assert.ok(codes.includes('impossible-radius'));
  const gravity = report.issues.find((entry) => entry.code === 'impossible-gravity');
  assert.match(gravity.bodies[0], new RegExp(`^${SYSTEM} B 1`), 'в замечании названо конкретное тело');
  assert.match(gravity.bodies[0], /44/, 'и показано само подозрительное значение');
});

test('аудит тел: звезде позволено быть горячей и огромной', () => {
  const report = auditBodyRows([
    row({
      body_name: `${SYSTEM} A`,
      body_type: 'Star',
      sub_type: 'K (Yellow-Orange) Star',
      radius_m: 4.8e8,
      surface_temp_k: 4500,
      gravity: 0,
      is_landable: false,
      distance_ls: 0,
    }),
  ], { system: SYSTEM });

  const codes = issueCodes(report);
  assert.ok(!codes.includes('impossible-temperature'), 'звезда в 4500 K — норма');
  assert.ok(!codes.includes('impossible-radius'), 'радиус звезды — норма');
  assert.ok(!codes.includes('landable-no-gravity'), 'у звезды не спрашивают гравитацию');
});

test('аудит тел: пустой ответ — это отдельное замечание, а не оценка 100', () => {
  const report = auditBodyRows([], { system: SYSTEM });
  assert.equal(report.total, 0);
  assert.ok(issueCodes(report).includes('no-bodies'));
  assert.equal(report.score, 0);
});

test('аудит тел: источники строк считаются отдельно', () => {
  const report = auditBodyRows([
    row({ source: 'helper' }),
    row({ body_name: `${SYSTEM} A 2`, body_id: 2, source: 'edsm' }),
    row({ body_name: `${SYSTEM} A 3`, body_id: 3, source: 'spansh' }),
  ], { system: SYSTEM });

  assert.deepEqual(report.sources, { helper: 1, edsm: 1, spansh: 1 });
  assert.equal(report.updatedAt, '2026-09-20T10:00:00Z');
});

test('аудит плана: постройка на неизвестном теле и дубль постройки видны отдельно', () => {
  const bodies = fromScanRecords([row(), row({ body_name: `${SYSTEM} A 2`, body_id: 2 })], SYSTEM);
  let plan = createPlan(SYSTEM);
  plan = addSite(plan, `${SYSTEM} A 1`, 'consus');
  plan = addSite(plan, `${SYSTEM} A 1`, 'consus');
  plan = addSite(plan, 'Другая система B 4', 'consus');

  const report = auditPlanData(plan, bodies);

  assert.equal(report.unknownBodies.length, 1);
  assert.equal(report.unknownBodies[0].bodyName, 'Другая система B 4');
  assert.equal(report.duplicates.length, 1);
  assert.equal(report.duplicates[0].siteIds.length, 2);
  const codes = report.issues.map((entry) => entry.code);
  assert.ok(codes.includes('plan-unknown-body'));
  assert.ok(codes.includes('plan-duplicate-site'));
});

test('аудит плана: имя тела из чужого источника не считается неизвестным телом', () => {
  const bodies = fromScanRecords([row()], SYSTEM);
  let plan = createPlan(SYSTEM);
  // Raven Colonial называет тело коротко — каталог знает его полным именем.
  plan = addSite(plan, 'A 1', 'consus');

  const report = auditPlanData(plan, bodies);
  assert.deepEqual(report.unknownBodies, [], 'короткое имя тела должно опознаваться');
});

test('аудит плана: чистый план не даёт замечаний', () => {
  const bodies = fromScanRecords([row()], SYSTEM);
  let plan = createPlan(SYSTEM);
  plan = addSite(plan, `${SYSTEM} A 1`, 'consus');

  const report = auditPlanData(plan, bodies);
  assert.deepEqual(report.issues, []);
  assert.deepEqual(report.orphanSiteIds, []);
});
