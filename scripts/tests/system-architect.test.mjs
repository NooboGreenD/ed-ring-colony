import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE_VERSION,
  COMMODITY_LABELS_RU,
  INSTALLATIONS,
  PRE_REQS,
  SYSTEM_UNLOCKS,
} from '../../src/lib/architect/catalogue.ts';
import {
  PLAN_FORMAT_VERSION,
  SURFACE_MAX_GRAVITY_G,
  SURFACE_MAX_TEMP_K,
  SURFACE_SLOT_LIMIT,
  addSite,
  cargoList,
  commodityLabel,
  computeBuildOrder,
  createPlan,
  evaluatePlan,
  formatTons,
  fromScanRecords,
  getInstallation,
  listInstallations,
  orbitalLimit,
  parsePlan,
  placementCheck,
  planToStructures,
  portTax,
  predictSurfaceSlots,
  removeSite,
  serializePlan,
  setSiteStatus,
  summarizePlan,
  surfaceSlotReason,
} from '../../src/lib/architect/planner.ts';

/** Строка `system_scans` такой, какой её отдаёт /api/atlas/system-bodies. */
function scanRow(overrides = {}) {
  return {
    system_name: 'Test',
    body_name: 'Test A 1',
    body_id: 2,
    body_type: 'Planet',
    sub_type: 'Rocky body',
    distance_ls: 12,
    parents: [{ Star: 1 }],
    radius_m: 3_000_000,
    gravity: 1.0,
    surface_temp_k: 250,
    surface_pressure: 0,
    volcanism: null,
    atmosphere: null,
    is_landable: true,
    rings: [],
    raw_data: {},
    ...overrides,
  };
}

function bodiesFixture() {
  return fromScanRecords([
    scanRow({ body_name: 'Test A', body_id: 1, body_type: 'Star', sub_type: 'K (Yellow-Orange) Star', is_landable: false, radius_m: 500_000_000 }),
    scanRow(),
    scanRow({ body_name: 'Test A 1 a', body_id: 3, sub_type: 'Rocky body', radius_m: 900_000, parents: [{ Planet: 2 }] }),
  ], 'Test');
}

test('каталог целен: id уникальны, тоннаж совпадает со списком товаров', () => {
  assert.ok(INSTALLATIONS.length >= 55, `ожидали не меньше 55 построек, получили ${INSTALLATIONS.length}`);
  const ids = new Set(INSTALLATIONS.map((installation) => installation.id));
  assert.equal(ids.size, INSTALLATIONS.length);

  for (const installation of INSTALLATIONS) {
    const tons = Object.values(installation.cargo).reduce((sum, value) => sum + value, 0);
    assert.equal(installation.haulTons, tons, `${installation.id}: haulTons не совпадает с суммой cargo`);
    assert.ok(tons > 0, `${installation.id}: пустой список товаров`);
    assert.ok([0, 2, 3].includes(installation.needs.tier), `${installation.id}: странный тир стоимости ${installation.needs.tier}`);
    assert.ok([0, 2, 3].includes(installation.gives.tier), `${installation.id}: странный тир выдачи ${installation.gives.tier}`);
    if (installation.preReq) {
      assert.ok(PRE_REQS[installation.preReq], `${installation.id}: preReq ${installation.preReq} не описан`);
      for (const buildType of PRE_REQS[installation.preReq].buildTypes) {
        assert.ok(getInstallation(buildType), `${installation.id}: предшественник ${buildType} отсутствует в каталоге`);
      }
    }
    for (const key of Object.keys(installation.cargo)) {
      assert.ok(COMMODITY_LABELS_RU[key], `нет русского названия товара ${key}`);
    }
  }
  assert.ok(CATALOGUE_VERSION > 0);
});

test('фильтр каталога режет по расположению, тиру и строке поиска', () => {
  const surface = listInstallations({ location: 'surface' });
  assert.ok(surface.length > 0);
  assert.ok(surface.every((installation) => installation.location === 'surface'));
  assert.ok(listInstallations({ tier: 3 }).every((installation) => installation.tier === 3));
  assert.deepEqual(listInstallations({ query: 'Кориолис' }).map((installation) => installation.id), ['no_truss']);
  assert.equal(listInstallations({ query: 'нет такой постройки' }).length, 0);
});

test('тела разбираются из строк сканов: звезда, планета, луна', () => {
  const bodies = bodiesFixture();
  assert.deepEqual(bodies.map((body) => body.name), ['Test A', 'Test A 1', 'Test A 1 a']);
  assert.equal(bodies[0].kind, 'star');
  assert.equal(bodies[1].kind, 'planet');
  assert.equal(bodies[2].kind, 'moon');
  assert.equal(bodies[1].radiusKm, 3000);
  assert.equal(bodies[1].landable, true);
  assert.equal(fromScanRecords(null).length, 0);
  assert.equal(fromScanRecords([null, 42, 'мусор']).length, 0);
});

test('«No atmosphere» и «No volcanism» не считаются признаками тела', () => {
  const [body] = fromScanRecords([scanRow({ atmosphere: 'No atmosphere', volcanism: 'No volcanism', raw_data: { terraformingState: 'Not terraformable' } })]);
  assert.deepEqual(body.features, ['landable']);
  assert.equal(body.hasAtmosphere, false);
  assert.equal(body.terraformable, false);
});

test('наземные слоты: база по радиусу, бонусы за признаки, потолок 7', () => {
  const [plain] = fromScanRecords([scanRow({ radius_m: 3_000_000 })]);
  assert.equal(predictSurfaceSlots(plain), 2);

  const [big] = fromScanRecords([scanRow({ radius_m: 6_500_000, atmosphere: 'Carbon dioxide', raw_data: { terraformingState: 'Terraformable' } })]);
  assert.equal(predictSurfaceSlots(big), 7, '4 по радиусу + 1 терраформирование + 2 атмосфера');

  const [capped] = fromScanRecords([scanRow({
    radius_m: 7_000_000,
    sub_type: 'High metal content world',
    atmosphere: 'Nitrogen',
    volcanism: 'major water geysers',
    raw_data: { terraformingState: 'Terraformable' },
  })]);
  assert.equal(predictSurfaceSlots(capped), SURFACE_SLOT_LIMIT);

  const [hot] = fromScanRecords([scanRow({ surface_temp_k: SURFACE_MAX_TEMP_K + 1 })]);
  assert.equal(predictSurfaceSlots(hot), 0);
  assert.match(surfaceSlotReason(hot), /Слишком горячо/);

  const [heavy] = fromScanRecords([scanRow({ gravity: SURFACE_MAX_GRAVITY_G + 0.1 })]);
  assert.equal(predictSurfaceSlots(heavy), 0);
  assert.match(surfaceSlotReason(heavy), /Гравитация/);

  const [noLanding] = fromScanRecords([scanRow({ is_landable: false })]);
  assert.equal(predictSurfaceSlots(noLanding), 0);
  assert.equal(surfaceSlotReason(noLanding), 'Нет посадки');
  assert.equal(predictSurfaceSlots(null), 0);
});

test('орбитальные постройки: луны не принимают, астероидная база требует пояс', () => {
  const bodies = bodiesFixture();
  const moon = bodies[2];
  const planet = bodies[1];
  const plan = createPlan('Test');

  assert.equal(orbitalLimit(moon), 0);
  assert.equal(orbitalLimit(planet), null);

  const onMoon = placementCheck(moon, 'vesta', plan);
  assert.equal(onMoon.ok, false);
  assert.match(onMoon.errors[0], /вокруг лун недоступны/);

  const asteroid = placementCheck(planet, 'asteroid', plan);
  assert.equal(asteroid.ok, false);
  assert.match(asteroid.errors[0], /пояса астероидов/);

  const [ringed] = fromScanRecords([scanRow({ rings: [{ name: 'Test A 1 A Ring' }], is_landable: false })]);
  assert.equal(placementCheck(ringed, 'asteroid', plan).ok, true);
});

test('наземную постройку нельзя поставить на звезду и в занятые слоты', () => {
  const bodies = bodiesFixture();
  const star = bodies[0];
  const planet = bodies[1];
  assert.equal(placementCheck(star, 'consus', createPlan('Test')).ok, false);

  // У тела радиусом 3000 км два слота: третий план отклоняется.
  let plan = createPlan('Test');
  plan = addSite(plan, planet.name, 'consus');
  plan = addSite(plan, planet.name, 'ourea');
  const third = placementCheck(planet, 'fontus', plan);
  assert.equal(third.ok, false);
  assert.match(third.errors[0], /Свободных наземных слотов нет/);
});

test('предшественник обязателен: военная установка без военного поселения не ставится', () => {
  const bodies = bodiesFixture();
  const planet = bodies[1];
  const empty = createPlan('Test');

  const blocked = placementCheck(planet, 'vacuna', empty);
  assert.equal(blocked.ok, false);
  assert.match(blocked.errors[0], /Сначала нужен предшественник: военное поселение/);

  const withSettlement = addSite(empty, planet.name, 'ioke');
  assert.equal(placementCheck(planet, 'vacuna', withSettlement).ok, true);
});

test('порядок стройки: первым идёт порт, предшественник раньше зависимой постройки', () => {
  const bodies = bodiesFixture();
  const planet = bodies[1];
  let plan = createPlan('Test');
  plan = addSite(plan, planet.name, 'vacuna');      // зависит от военного поселения
  plan = addSite(plan, 'Test A', 'no_truss');      // порт
  plan = addSite(plan, planet.name, 'ioke');       // предшественник

  const order = computeBuildOrder(plan);
  const types = order.map((id) => plan.sites.find((site) => site.id === id)?.installationId);
  assert.equal(types[0], 'no_truss', 'порт системы строится первым');
  assert.ok(types.indexOf('ioke') < types.indexOf('vacuna'), 'военное поселение раньше военной установки');
  assert.equal(order.length, plan.sites.length);
  assert.equal(computeBuildOrder(createPlan('Test')).length, 0);
});

test('очки системы: первый порт бесплатный, аванпосты T1 дают очки T2', () => {
  const bodies = fromScanRecords([
    scanRow({ body_name: 'Test A', body_type: 'Star', is_landable: false }),
    scanRow({ body_name: 'Test A 1' }),
    scanRow({ body_name: 'Test A 2', body_id: 3 }),
  ], 'Test');

  let plan = createPlan('Test', 'CMDR Tester');
  plan = addSite(plan, 'Test A', 'no_truss');   // порт: бесплатно, даёт 1 очко T3
  plan = addSite(plan, 'Test A 1', 'vesta');    // аванпост T1: даёт 1 очко T2
  plan = addSite(plan, 'Test A 2', 'plutus');   // аванпост T1: даёт 1 очко T2

  const evaluation = evaluatePlan(plan, bodies);
  assert.deepEqual(evaluation.portCosts, [{
    siteId: plan.sites[0].id,
    installationId: 'no_truss',
    tier: 2,
    cost: 0,
    taxed: false,
  }]);
  assert.equal(evaluation.tierPoints.tier2, 2);
  assert.equal(evaluation.tierPoints.tier3, 1);
  assert.equal(evaluation.tierSpent.tier2, 0);
  assert.equal(evaluation.tierGiven.tier2, 2);
  assert.equal(evaluation.tierGiven.tier3, 1);
  assert.equal(evaluation.issues.filter((issue) => issue.level === 'error').length, 0);
});

test('налог на дополнительные порты: третий платный порт вдвое дороже', () => {
  assert.equal(portTax(3, 6, 0), 6);
  assert.equal(portTax(3, 6, 1), 12);
  assert.equal(portTax(3, 6, 2), 18);
  assert.equal(portTax(2, 4, 1), 7);
  assert.equal(portTax(2, 4, 2), 10);
});

test('четыре порта: первый бесплатный, два следующих по 3 очка, четвёртый вдвое дороже', () => {
  const rows = [scanRow({ body_name: 'Test A', body_type: 'Star', is_landable: false })];
  for (let index = 1; index <= 16; index += 1) {
    rows.push(scanRow({ body_name: `Test A ${index}`, body_id: index + 1, is_landable: false }));
  }
  const bodies = fromScanRecords(rows, 'Test');

  let plan = createPlan('Test');
  for (let index = 1; index <= 12; index += 1) {
    plan = addSite(plan, `Test A ${index}`, 'plutus');
  }
  for (let index = 13; index <= 16; index += 1) {
    plan = addSite(plan, `Test A ${index}`, 'no_truss');
  }

  const evaluation = evaluatePlan(plan, bodies);
  // Порт T2 дорожает на 75 % за шаг: 3 → 3 + trunc(3·0.75) = 5 очков.
  assert.deepEqual(evaluation.portCosts.map((port) => port.cost), [0, 3, 3, 5]);
  assert.deepEqual(evaluation.portCosts.map((port) => port.taxed), [false, false, false, true]);
  assert.equal(evaluation.tierPoints.tier2, 1, '12 очков T2 от аванпостов минус 11 на порты');
  assert.equal(evaluation.tierSpent.tier2, 11);
  assert.equal(evaluation.issues.filter((issue) => issue.level === 'error').length, 0);
});

test('нехватка очков — ошибка плана с указанием дефицита', () => {
  const bodies = fromScanRecords([
    scanRow({ body_name: 'Test A', body_type: 'Star', is_landable: false }),
    scanRow({ body_name: 'Test A 1', is_landable: false }),
  ], 'Test');

  let plan = createPlan('Test');
  plan = addSite(plan, 'Test A', 'no_truss');
  plan = addSite(plan, 'Test A 1', 'no_truss');

  const evaluation = evaluatePlan(plan, bodies);
  const errors = evaluation.issues.filter((issue) => issue.level === 'error');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Не хватает 3 очк. T2/);
  assert.equal(evaluation.tierPoints.tier2, -3);
});

test('сводка плана: тоннаж, товары, оценка, эффекты и открытые сервисы', () => {
  const bodies = fromScanRecords([
    scanRow({ body_name: 'Test A', body_type: 'Star', is_landable: false }),
    scanRow({ body_name: 'Test A 1' }),
    scanRow({ body_name: 'Test A 2', body_id: 3 }),
  ], 'Test');

  let plan = createPlan('Test');
  plan = addSite(plan, 'Test A', 'vesta');    // 18 473 т, score 3
  plan = addSite(plan, 'Test A 1', 'ioke');   // 2 842 т, score 1
  plan = addSite(plan, 'Test A 2', 'vacuna'); // 10 080 т, score 4, требует военное поселение

  const evaluation = evaluatePlan(plan, bodies);
  assert.equal(evaluation.haulTons, 31_395);
  assert.equal(evaluation.score, 8);
  assert.equal(evaluation.cargo.steel > 0, true);
  assert.equal(evaluation.effects.sec, -1 + 2 + 7, 'vesta −1, ioke +2, vacuna +7');
  assert.deepEqual(evaluation.economies, { colony: 1, military: 2 });
  assert.equal(evaluation.surfaceUsage['Test A 1'].used, 1);
  assert.equal(evaluation.surfaceUsage['Test A 1'].limit, 2);

  const militaryHub = evaluation.unlocks.find((unlock) => unlock.id === 'military-hub');
  assert.equal(militaryHub?.satisfied, true);
  const explorationHub = evaluation.unlocks.find((unlock) => unlock.id === 'exploration-hub');
  assert.equal(explorationHub?.satisfied, false);

  const cargo = cargoList(evaluation);
  assert.equal(cargo.length, Object.keys(evaluation.cargo).length);
  assert.ok(cargo[0].tons >= cargo[cargo.length - 1].tons, 'товары идут от тяжёлых к лёгким');

  const summary = summarizePlan(plan, evaluation);
  assert.match(summary, /План застройки: Test/);
  assert.match(summary, /Порядок стройки:/);
  assert.match(summary, /Основные грузы:/);
  assert.match(summary, new RegExp(`каталог v${CATALOGUE_VERSION}`));
});

test('план без порта получает предупреждение, неизвестная постройка — ошибку', () => {
  const bodies = bodiesFixture();
  const plan = addSite(createPlan('Test'), 'Test A 1', 'consus');
  const evaluation = evaluatePlan(plan, bodies);
  assert.ok(evaluation.issues.some((issue) => issue.level === 'warning' && /нет ни одного порта/.test(issue.message)));

  const broken = { ...plan, sites: [...plan.sites, { id: 'site-x', bodyName: 'Test A 1', installationId: 'нет_такой', status: 'plan' }] };
  const brokenEvaluation = evaluatePlan(broken, bodies);
  assert.ok(brokenEvaluation.issues.some((issue) => issue.level === 'error' && /Неизвестная постройка/.test(issue.message)));
});

test('удаление записи и смена статуса не ломают расчёт', () => {
  const bodies = bodiesFixture();
  let plan = addSite(createPlan('Test'), 'Test A 1', 'consus');
  const siteId = plan.sites[0].id;
  plan = setSiteStatus(plan, siteId, 'complete');
  assert.equal(plan.sites[0].status, 'complete');
  plan = setSiteStatus(plan, siteId, 'несуществующий');
  assert.equal(plan.sites[0].status, 'complete', 'неизвестный статус игнорируется');
  plan = removeSite(plan, siteId);
  assert.equal(plan.sites.length, 0);
  assert.equal(evaluatePlan(plan, bodies).haulTons, 0);
});

test('экспорт и импорт плана сохраняют записи и честно сообщают о чужой версии', () => {
  const bodies = bodiesFixture();
  let plan = createPlan('Test', 'CMDR Tester');
  plan = addSite(plan, 'Test A 1', 'consus', { note: 'первая очередь' });
  plan = addSite(plan, 'Test A', 'vesta');

  const parsed = parsePlan(serializePlan(plan));
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.warning, undefined);
  assert.equal(parsed.plan.system, 'Test');
  assert.equal(parsed.plan.architect, 'CMDR Tester');
  assert.deepEqual(
    parsed.plan.sites.map((site) => [site.bodyName, site.installationId, site.note]),
    plan.sites.map((site) => [site.bodyName, site.installationId, site.note]),
  );
  assert.equal(evaluatePlan(parsed.plan, bodies).haulTons, evaluatePlan(plan, bodies).haulTons);

  const stale = parsePlan(JSON.stringify({ ...JSON.parse(serializePlan(plan)), version: 99, catalogue: 1 }));
  assert.match(stale.warning, /формате v99/);
  assert.match(stale.warning, /каталогу v1/);

  const foreign = parsePlan('{"sites":{"не":"список"}}');
  assert.equal(foreign.plan, null);
  assert.match(foreign.error, /sites должно быть списком/);
  assert.equal(parsePlan('{не json').error, 'Файл не является JSON');
  assert.equal(parsePlan(null).error, 'Ожидался объект плана');
});

test('импорт отбрасывает мусор и неизвестные постройки, но сохраняет остальное', () => {
  const parsed = parsePlan({
    version: PLAN_FORMAT_VERSION,
    system: 'HIP 90297',
    sites: [
      { bodyName: 'HIP 90297 A 1', installationId: 'consus' },
      { bodyName: '', installationId: 'vesta' },
      { bodyName: 'HIP 90297 A 2', installationId: 'нет_такой' },
      { bodyName: 'HIP 90297 A 3', installationId: 'ioke', status: 'building' },
    ],
  });
  assert.equal(parsed.plan.sites.length, 2);
  assert.equal(parsed.plan.sites[0].installationId, 'consus');
  assert.equal(parsed.plan.sites[0].status, 'plan', 'отсутствующий статус становится «план»');
  assert.equal(parsed.plan.sites[1].status, 'building');
  assert.match(parsed.warning, /неизвестная постройка|Неизвестная постройка/i);
});

test('постройки плана превращаются в структуры оверрея карты системы', () => {
  let plan = createPlan('Test');
  plan = addSite(plan, 'Test A 1', 'consus');
  plan = addSite(plan, 'Test A 1', 'vesta');
  plan = setSiteStatus(plan, plan.sites[0].id, 'complete');

  const structures = planToStructures(plan);
  assert.equal(structures.length, 2);
  const surface = structures.find((structure) => structure.type === 'Agricultural Settlement - Small');
  assert.equal(surface.surface, true);
  assert.equal(surface.complete, true);
  assert.equal(surface.progress, 100);
  assert.equal(surface.requiredTons, getInstallation('consus').haulTons);
  assert.ok(structures.every((structure) => Array.isArray(structure.resources) && structure.resources.length > 0));
  assert.equal(planToStructures({ ...plan, sites: [{ id: 'x', bodyName: 'Test A 1', installationId: 'нет', status: 'plan' }] }).length, 0);
});

test('форматирование тоннажа и названий товаров', () => {
  assert.equal(formatTons(53_723.4), '53\u00a0723 т', 'ru-RU разделяет разряды неразрывным пробелом');
  assert.equal(formatTons(Number.NaN), '—');
  assert.equal(commodityLabel('steel'), 'Сталь');
  assert.equal(commodityLabel('cmmcomposite'), 'CMM-композит');
  assert.equal(commodityLabel('unknownCommodity'), 'Unknown Commodity');
});

test(' unlocks системы описаны и ссылаются на существующие постройки', () => {
  for (const unlock of SYSTEM_UNLOCKS) {
    assert.ok(unlock.buildTypes.length > 0, `${unlock.id}: пустой список построек`);
    for (const buildType of unlock.buildTypes) {
      assert.ok(getInstallation(buildType), `${unlock.id}: неизвестная постройка ${buildType}`);
    }
  }
});
