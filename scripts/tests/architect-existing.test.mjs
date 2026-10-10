import test from 'node:test';
import assert from 'node:assert/strict';
import {
  adoptExisting,
  installationFromStationType,
  parseExistingStructures,
} from '../../src/lib/architect/existing.ts';
import { addSite, createPlan, evaluatePlan, parsePlan } from '../../src/lib/architect/planner.ts';

const SYSTEM = 'Architest';

function payload() {
  return {
    system: SYSTEM,
    sites: [
      { id: 's1', name: 'Первый порт', buildType: 'no_truss', bodyName: `${SYSTEM} 1`, status: 'complete' },
      { id: 's2', name: 'Аванпост', buildType: 'vulcan', bodyName: `${SYSTEM} 2`, status: 'build', progress: 40 },
      { id: 's3', name: 'Нечто', buildType: 'totally_unknown', bodyName: `${SYSTEM} 3`, status: 'complete' },
    ],
    stations: [
      { id: 10, name: 'Старая база', type: 'Orbis Starport', bodyName: `${SYSTEM} 4` },
      { id: 11, name: 'Перевозчик X1Y-22Z', type: 'Drake-Class Carrier', bodyName: null },
    ],
    warnings: [],
  };
}

test('разбор факта: Raven и EDSM дают один список с опознанными типами', () => {
  const list = parseExistingStructures(payload());
  assert.equal(list.length, 4, 'флотоносец отброшен, остальное попало в список');
  const port = list.find((item) => item.key === 'raven:s1');
  assert.equal(port.installationId, 'no_truss');
  assert.equal(port.status, 'complete');
  const outpost = list.find((item) => item.key === 'raven:s2');
  assert.equal(outpost.status, 'building', 'статус build из Raven — «строится»');
  const unknown = list.find((item) => item.key === 'raven:s3');
  assert.equal(unknown.installationId, null, 'неизвестный тип не выдумывается');
  const edsm = list.find((item) => item.key === 'edsm:10');
  assert.equal(edsm.installationId, 'apollo', 'Orbis Starport из EDSM опознаётся');
  assert.equal(edsm.status, 'complete', 'станция в EDSM существует — значит достроена');
});

test('разбор факта: битый ответ не роняет панель', () => {
  assert.deepEqual(parseExistingStructures(null), []);
  assert.deepEqual(parseExistingStructures({ sites: 'нет', stations: 5 }), []);
});

test('типы станций EDSM сопоставляются с каталогом, флотоносцы — нет', () => {
  assert.equal(installationFromStationType('Coriolis Starport'), 'no_truss');
  assert.equal(installationFromStationType('Planetary Port'), 'zeus');
  assert.equal(installationFromStationType('Odyssey Settlement'), 'consus');
  assert.equal(installationFromStationType('Mega ship'), null);
  assert.equal(installationFromStationType(''), null);
});

test('применение факта: постройки добавляются, дубли не создаются', () => {
  const structures = parseExistingStructures(payload());
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  plan = addSite(plan, `${SYSTEM} 1`, 'no_truss'); // тот же порт уже в плане со статусом «план»

  const result = adoptExisting(plan, structures);
  assert.equal(result.added.length, 2, 'добавлены аванпост и станция EDSM');
  assert.equal(result.updated.length, 1, 'порт уже был в плане — только статус');
  assert.equal(result.unknown.length, 1, 'неопознанный тип отдан отдельно');
  assert.equal(result.plan.sites.length, 3, 'дубль порта не создан');
  const port = result.plan.sites.find((site) => site.installationId === 'no_truss');
  assert.equal(port.status, 'complete', 'статус подтянут к факту');
});

test('применение факта: переносится только отмеченное', () => {
  const structures = parseExistingStructures(payload());
  const plan = createPlan(SYSTEM);
  const result = adoptExisting(plan, structures, { keys: ['raven:s2'] });
  assert.equal(result.plan.sites.length, 1);
  assert.equal(result.plan.sites[0].installationId, 'vulcan');
});

test('применение факта: можно взять только достроенное', () => {
  const structures = parseExistingStructures(payload());
  const result = adoptExisting(createPlan(SYSTEM), structures, { includeUnfinished: false });
  assert.ok(result.added.every((item) => item.status === 'complete'));
  assert.ok(!result.added.some((item) => item.key === 'raven:s2'));
});

test('после применения факта очки тиров считаются от реальной системы', () => {
  const structures = parseExistingStructures(payload());
  const empty = evaluatePlan(createPlan(SYSTEM), []);
  const withFact = evaluatePlan(adoptExisting(createPlan(SYSTEM), structures).plan, []);
  assert.notDeepEqual(withFact.tierPoints, empty.tierPoints, 'существующая застройка меняет бюджет очков');
  assert.ok(withFact.haulTons > 0, 'перенесённые постройки дают тоннаж');
});

// ---------------------------------------------------------------------------
// Синхронизации не должны плодить дубли: одна постройка Raven — одна запись плана.
// ---------------------------------------------------------------------------

function ravenSite(overrides) {
  return {
    buildId: 'b-default',
    name: 'Постройка',
    buildType: 'vulcan',
    bodyName: `${SYSTEM} 2`,
    status: 'build',
    progress: 40,
    ...overrides,
  };
}

test('повторная синхронизация не создаёт дублей и не растит план', () => {
  const source = { system: SYSTEM, sites: [ravenSite({ buildId: 'b-1' }), ravenSite({ buildId: 'b-2', buildType: 'plutus', bodyName: `${SYSTEM} 3` })] };
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  const first = adoptExisting(plan, parseExistingStructures(source));
  assert.equal(first.plan.sites.length, 2);
  const second = adoptExisting(first.plan, parseExistingStructures(source));
  const third = adoptExisting(second.plan, parseExistingStructures(source));
  assert.equal(third.plan.sites.length, 2, 'три синхронизации — те же две постройки');
  assert.equal(third.added.length, 0, 'при повторе ничего не добавляется');
  assert.deepEqual(third.plan.sites.map((s) => s.ravenBuildId).sort(), ['b-1', 'b-2'], 'связи с Raven сохранены');
});

test('переименование тела в источнике не создаёт дубль: постройка узнаётся по buildId', () => {
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  plan = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-7', bodyName: `${SYSTEM} 2` })] })).plan;
  const renamed = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-7', bodyName: `${SYSTEM} 5` })] }));
  assert.equal(renamed.plan.sites.length, 1, 'дубля нет');
  assert.equal(renamed.plan.sites[0].bodyName, `${SYSTEM} 5`, 'тело обновлено на новое');
  assert.equal(renamed.plan.sites[0].ravenBuildId, 'b-7');
});

test('две разные постройки одного типа на одном теле — две записи, не одна', () => {
  const source = {
    system: SYSTEM,
    sites: [
      ravenSite({ buildId: 'b-10', buildType: 'vulcan', bodyName: `${SYSTEM} 2` }),
      ravenSite({ buildId: 'b-11', buildType: 'vulcan', bodyName: `${SYSTEM} 2` }),
    ],
  };
  const result = adoptExisting(createPlan(SYSTEM, 'CMDR Tester'), parseExistingStructures(source));
  assert.equal(result.plan.sites.length, 2, 'обе площадки перенесены');
  assert.deepEqual(result.plan.sites.map((s) => s.ravenBuildId).sort(), ['b-10', 'b-11']);
});

test('запись плана без связи с Raven берётся по типу и телу, а не дублируется', () => {
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  plan = addSite(plan, `${SYSTEM} 2`, 'vulcan'); // записана вручную, связи с Raven ещё нет
  const result = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-20' })] }));
  assert.equal(result.plan.sites.length, 1, 'вручную добавленная постройка получила связь, дубля нет');
  assert.equal(result.plan.sites[0].ravenBuildId, 'b-20');
});

test('запись, связанная с другой постройкой Raven, не перезаписывается', () => {
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  plan = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-30' })] })).plan;
  const result = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-31' })] }));
  assert.equal(result.plan.sites.length, 2, 'новая площадка Raven — отдельная запись');
  assert.deepEqual(result.plan.sites.map((s) => s.ravenBuildId).sort(), ['b-30', 'b-31']);
});

test('связь с Raven переживает сохранение и импорт плана', () => {
  let plan = createPlan(SYSTEM, 'CMDR Tester');
  plan = adoptExisting(plan, parseExistingStructures({ system: SYSTEM, sites: [ravenSite({ buildId: 'b-40' })] })).plan;
  const parsed = parsePlan(JSON.parse(JSON.stringify(plan)));
  assert.equal(parsed.plan.sites[0].ravenBuildId, 'b-40', 'при импорте связь не теряется');
});
