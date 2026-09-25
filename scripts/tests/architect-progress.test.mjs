import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILD_TYPE_ALIASES,
  matchProgress,
  normalizeBuildType,
  parseActualSites,
} from '../../src/lib/architect/progress.ts';
import { addSite, createPlan, getInstallation } from '../../src/lib/architect/planner.ts';

const SYSTEM = 'Architest';

function planWith(...entries) {
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  for (const [bodyName, installationId] of entries) {
    plan = addSite(plan, bodyName, installationId);
  }
  return plan;
}

function site(overrides = {}) {
  return {
    buildId: 'b1',
    buildName: 'Orbital Construction Site: Test',
    buildType: 'no_truss',
    bodyName: `${SYSTEM} A`,
    complete: false,
    progress: 0,
    resources: [],
    ...overrides,
  };
}

test('buildType из Raven приводится к id каталога: токены, варианты, «primary»', () => {
  assert.equal(normalizeBuildType('$Coriolis_Starport;'), 'no_truss', 'игровой токен с классом в суффиксе');
  assert.equal(normalizeBuildType('$Totally_Unknown_Thing;'), null, 'неизвестный токен не выдумывает тип');
  assert.equal(normalizeBuildType('no_truss'), 'no_truss');
  assert.equal(normalizeBuildType('dual_truss'), 'no_truss');
  assert.equal(normalizeBuildType('coriolis (primary)'), 'no_truss');
  assert.equal(normalizeBuildType('Orbis'), 'apollo');
  assert.equal(normalizeBuildType('annona'), 'picumnus', 'среднее сельхозпоселение — это picumnus');
  assert.equal(normalizeBuildType('fornax'), 'ceres');
  assert.equal(normalizeBuildType('tellus_i'), 'molae', 'индустриальный хаб, а не исследовательский');
  assert.equal(normalizeBuildType('Phoebe'), 'pheobe', 'опечатка игры в id сохраняется');
  assert.equal(normalizeBuildType(''), null);
  assert.equal(normalizeBuildType(null), null);
  assert.equal(normalizeBuildType(undefined), null);

  // Все псевдонимы обязаны указывать на существующую постройку каталога.
  for (const [alias, id] of Object.entries(BUILD_TYPE_ALIASES)) {
    assert.ok(getInstallation(id), `псевдоним ${alias} ведёт на неизвестную постройку ${id}`);
  }
});

test('разбор ответа /api/systems/progress в площадки', () => {
  const sites = parseActualSites({
    found: true,
    projects: [
      site({ progress: 42.5, totalRequired: 1000, totalProvided: 425, totalRemaining: 575 }),
      site({ buildId: 'b2', buildType: 'consus', bodyName: `${SYSTEM} A 1`, complete: true, progress: 0 }),
      null,
      'мусор',
    ],
  });
  assert.equal(sites.length, 2);
  assert.equal(sites[0].progress, 42.5);
  assert.equal(sites[0].totalRemaining, 575);
  assert.equal(sites[1].complete, true);
  assert.equal(sites[1].progress, 100, 'завершённая площадка — 100 %, даже если Raven прислал 0');
  assert.deepEqual(parseActualSites(null), []);
  assert.deepEqual(parseActualSites({ projects: 'не список' }), []);
});

test('точное совпадение: тот же тип на том же теле', () => {
  const plan = planWith([`${SYSTEM} A`, 'no_truss'], [`${SYSTEM} A 1`, 'consus']);
  const report = matchProgress(plan, [
    site({ progress: 30, totalRequired: 53_723, totalProvided: 16_117 }),
    site({ buildId: 'b2', buildType: '$Consus_Settlement;', bodyName: `${SYSTEM} A 1`, progress: 100, complete: true }),
  ]);

  assert.equal(report.matchedCount, 2);
  assert.equal(report.completeCount, 1);
  assert.deepEqual(report.sites.map((entry) => entry.matchKind), ['exact', 'exact']);
  assert.equal(report.sites[0].progress, 30);
  assert.equal(report.sites[0].deliveredTons, 16_117);
  assert.equal(report.unplanned.length, 0);
  assert.equal(report.notStarted.length, 0);
  assert.equal(report.totals.required, 53_723);
  assert.equal(report.totals.provided, 16_117);
  assert.equal(report.totals.remaining, 37_606);
  assert.equal(report.totals.progress, 30);
});

test('совпадение по типу, когда тело в данных не указано, и пометка о расхождении', () => {
  const plan = planWith([`${SYSTEM} A 1`, 'vesta']);
  const report = matchProgress(plan, [site({ buildType: 'vesta', bodyName: null, progress: 12 })]);

  assert.equal(report.matchedCount, 1);
  assert.equal(report.sites[0].matchKind, 'type');
  assert.equal(report.sites[0].progress, 12);
});

test('старый проект с классом вместо типа ловится по телу и классу постройки', () => {
  const plan = planWith([`${SYSTEM} A 1`, 'vesta']);
  const report = matchProgress(plan, [
    site({ buildType: 'outpost', bodyName: `${SYSTEM} A 1`, buildName: 'Civilian Outpost', progress: 55 }),
  ]);

  assert.equal(report.matchedCount, 1);
  assert.equal(report.sites[0].matchKind, 'body');
  assert.match(report.sites[0].mismatch || '', /На площадке outpost, в плане vesta/);
});

test('один факт не приписывается двум записям плана', () => {
  const plan = planWith([`${SYSTEM} A`, 'no_truss'], [`${SYSTEM} A 2`, 'no_truss']);
  const report = matchProgress(plan, [site({ progress: 70 })]);

  assert.equal(report.matchedCount, 1, 'площадка одна — сопоставлена один раз');
  assert.equal(report.sites[0].matchKind, 'exact');
  assert.equal(report.sites[1].matchKind, 'none');
  assert.deepEqual(report.notStarted, [plan.sites[1].id]);
});

test('площадки вне плана и неначатые записи видны отдельно', () => {
  const plan = planWith([`${SYSTEM} A 1`, 'consus'], [`${SYSTEM} A 2`, 'ioke']);
  const report = matchProgress(plan, [
    site({ buildId: 'x1', buildType: 'hermes', bodyName: `${SYSTEM} A`, buildName: 'Satellite' }),
    site({ buildId: 'x2', buildType: 'dionysus', bodyName: `${SYSTEM} A 3`, buildName: 'Space Bar' }),
  ]);

  assert.equal(report.matchedCount, 0);
  assert.equal(report.unplanned.length, 2);
  assert.deepEqual(report.unplanned.map((item) => item.buildId), ['x1', 'x2']);
  assert.deepEqual(report.notStarted, plan.sites.map((entry) => entry.id));
  assert.equal(report.totals.progress, null, 'без тоннажа прогресс системы не выдумывается');
});

test('пустой ответ Raven — честный отчёт без выдуманного прогресса', () => {
  const plan = planWith([`${SYSTEM} A`, 'no_truss']);
  const report = matchProgress(plan, []);
  assert.equal(report.matchedCount, 0);
  assert.equal(report.sites[0].progress, null);
  assert.equal(report.totals.required, null);
  assert.equal(report.totals.progress, null);
});

test('взвешенный прогресс системы считается по тоннажу, а не средним', () => {
  const plan = planWith([`${SYSTEM} A`, 'no_truss'], [`${SYSTEM} A 1`, 'consus']);
  const report = matchProgress(plan, [
    site({ buildId: 'p', totalRequired: 1000, totalProvided: 900 }),
    site({ buildId: 's', buildType: 'consus', bodyName: `${SYSTEM} A 1`, totalRequired: 100, totalProvided: 0 }),
  ]);
  assert.equal(report.totals.progress, 81.82, '900 из 1100 тонн, а не среднее 50 %');
});

test('игровой токен с классом в суффиксе ловится по телу и классу постройки', () => {
  // Raven отдаёт `$Agricultural_Settlement;` — конкретного типа нет, но класс
  // (поселение) в токене есть, поэтому площадку видно рядом с планом.
  const plan = planWith([`${SYSTEM} A 1`, 'consus']);
  const report = matchProgress(plan, [
    site({
      buildId: 'farm',
      buildType: '$Agricultural_Settlement;',
      bodyName: `${SYSTEM} A 1`,
      buildName: 'Agricultural Settlement',
      progress: 42,
      totalRequired: 2839,
      totalProvided: 1200,
    }),
  ]);

  assert.equal(report.matchedCount, 1);
  assert.equal(report.sites[0].matchKind, 'body');
  assert.equal(report.sites[0].progress, 42);
  assert.match(String(report.sites[0].mismatch), /consus/, 'расхождение типа показано пользователю');

  // Тот же токен на другом теле плану не приписывается.
  const otherBody = matchProgress(plan, [
    site({ buildId: 'farm2', buildType: '$Agricultural_Settlement;', bodyName: `${SYSTEM} A 2` }),
  ]);
  assert.equal(otherBody.matchedCount, 0);
});
