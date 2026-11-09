import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSystemCards,
  cardResourceRows,
  cardTotals,
  mergeResourceRows,
  ravenProjectFromCard,
  cardsFromJournalSites,
  cardsFromRavenCache,
  cardsFromStored,
  commodityMap,
  compactProjectResources,
  mergeProjectCards,
  normalizeProjectRegistration,
  projectKey,
  projectNeed,
  projectNeedTotal,
  progressFromResources,
  remainingFromResources,
} from '../../src/lib/siteProjects.ts';

const SYSTEM = 'Ravenless 1';

function depot(resources) {
  return { ConstructionProgress: 0.4, Resources: resources };
}

function storedRow(overrides = {}) {
  return {
    project_key: '28682976:128016640',
    system_name: SYSTEM,
    system_address: 28682976,
    market_id: 128016640,
    build_id: 'build-1',
    build_name: 'Первый порт',
    build_type: 'no_truss',
    body_name: `${SYSTEM} 2`,
    body_num: 2,
    star_pos: [1, 2, 3],
    architect_name: 'Jameson',
    commander: 'Jameson',
    status: 'active',
    commodities: { steel: 900 },
    max_need: 5000,
    resources: [],
    progress: 42,
    is_primary_port: true,
    source: 'helper',
    rc_state: 'unavailable',
    updated_at: '2026-11-09T10:00:00Z',
    ...overrides,
  };
}

test('ключ площадки: адрес и MarketID важнее buildId', () => {
  assert.equal(projectKey({ systemAddress: 10, marketId: 20 }), '10:20');
  assert.equal(projectKey({ buildId: 'abc' }), 'rc:abc');
  assert.equal(projectKey({ systemName: 'HIP 1', buildName: 'Порт' }), 'sys:hip 1:порт');
  assert.equal(projectKey({ marketId: 20 }), 'm:20');
  assert.equal(projectKey({}), '');
});

test('остаток считается из точных ресурсов депота', () => {
  const resources = [
    { Name: 'Steel', RequiredAmount: 1000, ProvidedAmount: 300 },
    { Name: 'Aluminium', RequiredAmount: 500, ProvidedAmount: 500 },
    { Name: 'Titanium', RequiredAmount: 0, ProvidedAmount: 0 },
  ];
  assert.deepEqual(remainingFromResources(resources), { steel: 700 });
  assert.deepEqual(compactProjectResources(resources).map((row) => row.Name),
    ['aluminium', 'steel', 'titanium']);
  assert.equal(progressFromResources(resources), 53.33);
});

test('регистрация: остаток и прогресс берутся из депота, а не из присланного', () => {
  const result = normalizeProjectRegistration({
    systemName: SYSTEM,
    systemAddress: 28682976,
    marketId: 128016640,
    buildName: 'Первый порт',
    buildType: 'no_truss',
    commodities: { steel: 1 },
    colonisationConstructionDepot: depot([
      { Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 250 },
      { Name: 'aluminium', RequiredAmount: 500, ProvidedAmount: 500 },
    ]),
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.project_key, '28682976:128016640');
  assert.deepEqual(result.value.commodities, { steel: 750 });
  // ConstructionProgress журнала (0.4) главнее расчёта по ресурсам.
  assert.equal(result.value.progress, 40);
  assert.equal(result.value.status, 'active');
  assert.equal(result.value.resources.length, 2);
});

test('регистрация без ключа площадки отклоняется', () => {
  const result = normalizeProjectRegistration({ buildName: 'Без адреса' });
  assert.equal(result.ok, false);
  assert.match(result.error, /project key/);
});

test('регистрация: завершённая потребность помечает проект готовым', () => {
  const result = normalizeProjectRegistration({
    systemAddress: 1,
    marketId: 2,
    buildName: 'Порт',
    progress: 100,
  });
  assert.equal(result.ok, true);
  assert.equal(result.value.status, 'complete');
});

test('регистрация: мусор в теле не проходит в строку', () => {
  const result = normalizeProjectRegistration({
    systemName: SYSTEM,
    systemAddress: '12abc',
    marketId: 7,
    buildName: 'x'.repeat(500),
    starPos: ['a', 2, 3],
    commodities: { steel: 'NaN', aluminium: 12 },
    rcState: 'что-то',
    status: 'weird',
  });
  assert.equal(result.ok, true);
  // Адрес не число — ключ собрался по MarketID (`m:7`), а не «12:7».
  assert.equal(result.value.project_key, 'm:7');
  assert.equal(result.value.system_address, null);
  assert.equal(result.value.build_name.length, 200);
  assert.equal(result.value.star_pos, null);
  assert.deepEqual(result.value.commodities, { aluminium: 12 });
  assert.equal(result.value.rc_state, 'unknown');
  assert.equal(result.value.status, 'active');
});

test('карточки из таблицы: точные ресурсы важнее присланного остатка', () => {
  const [card] = cardsFromStored([storedRow({
    commodities: { steel: 900 },
    resources: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 800 }],
    progress: null,
  })]);
  assert.deepEqual(card.commodities, { steel: 200 });
  assert.equal(card.progress, 80);
  assert.equal(card.buildId, 'build-1');
  assert.equal(card.primary, true);
  assert.deepEqual(card.sources, ['site']);
});

test('карточки из кэша Raven и снимков депота', () => {
  const raven = cardsFromRavenCache([{
    system_name: SYSTEM,
    updated_at: '2026-11-09T09:00:00Z',
    data: {
      architectName: 'Jameson',
      projects: [{
        buildId: 'build-1',
        marketId: 128016640,
        buildName: 'Первый порт',
        buildType: 'no_truss',
        progress: 40,
        complete: false,
        resources: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 400 }],
      }],
    },
  }]);
  assert.equal(raven.length, 1);
  assert.deepEqual(raven[0].commodities, { steel: 600 });
  assert.deepEqual(raven[0].sources, ['raven']);

  const journal = cardsFromJournalSites([{
    market_id: 128016640,
    system_name: SYSTEM,
    construction_name: 'Первый порт',
    construction_progress: 60,
    resources_total: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 600 }],
    event_timestamp: '2026-11-09T11:00:00Z',
  }]);
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0].commodities, { steel: 400 });
  assert.equal(journal[0].progress, 60);
});

test('слияние: одна площадка из трёх источников становится одной карточкой', () => {
  const cards = buildSystemCards({
    stored: [storedRow({ rc_state: 'unavailable' })],
    journalSites: [{
      market_id: 128016640,
      system_name: SYSTEM,
      construction_name: 'Первый порт',
      construction_progress: 55,
      resources_total: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 550 }],
      event_timestamp: '2026-11-09T12:00:00Z',
    }],
    ravenCache: [{
      system_name: SYSTEM,
      updated_at: '2026-11-09T09:00:00Z',
      data: {
        architectName: 'Jameson',
        projects: [{
          buildId: 'build-1',
          marketId: 128016640,
          buildName: 'Первый порт',
          progress: 40,
          resources: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 400 }],
        }],
      },
    }],
    now: Date.parse('2026-11-09T12:30:00Z'),
  });

  assert.equal(cards.length, 1, 'одна площадка — одна карточка');
  const card = cards[0];
  assert.deepEqual(card.sources, ['site', 'journal', 'raven']);
  // Депот (12:00) свежее кэша Raven (09:00) и регистрации (10:00).
  assert.deepEqual(card.commodities, { steel: 450 });
  assert.equal(card.progress, 55);
  assert.equal(card.buildId, 'build-1', 'buildId из кэша Raven сохранён');
  assert.equal(card.architectName, 'Jameson');
  assert.equal(card.stale, false);
});

test('слияние: пустые источники не затирают известные значения', () => {
  const merged = mergeProjectCards([
    cardsFromStored([storedRow()])[0],
    {
      key: '28682976:128016640',
      buildId: null,
      systemName: SYSTEM,
      systemAddress: null,
      marketId: 128016640,
      buildName: '',
      buildType: null,
      bodyName: null,
      bodyNum: null,
      starPos: null,
      architectName: null,
      commander: null,
      status: 'active',
      commodities: {},
      maxNeed: null,
      resources: [],
      progress: null,
      primary: false,
      sources: ['journal'],
      updatedAt: '2026-11-09T13:00:00Z',
      stale: false,
      rcState: 'unknown',
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].buildName, 'Первый порт');
  assert.deepEqual(merged[0].commodities, { steel: 900 });
  assert.equal(merged[0].buildId, 'build-1');
});

test('устаревшие данные помечаются, свежие — нет', () => {
  const [fresh] = buildSystemCards({
    stored: [storedRow({ updated_at: '2026-11-09T11:00:00Z' })],
    now: Date.parse('2026-11-09T12:00:00Z'),
  });
  assert.equal(fresh.stale, false);

  const [old] = buildSystemCards({
    stored: [storedRow({ updated_at: '2026-11-08T11:00:00Z' })],
    now: Date.parse('2026-11-09T12:00:00Z'),
  });
  assert.equal(old.stale, true);
});

test('потребность карточки — только положительные остатки', () => {
  const [card] = cardsFromStored([storedRow({ commodities: { steel: 900, aluminium: 0, titanium: 100 } })]);
  assert.deepEqual(projectNeed(card), { steel: 900, titanium: 100 });
  assert.equal(projectNeedTotal(card), 1000);
});

test('карта товаров: мусор и нули отбрасываются', () => {
  assert.deepEqual(commodityMap({ Steel: 5, aluminium: 0, titanium: 'x', '': 4 }), { steel: 5 });
  assert.deepEqual(commodityMap(null), {});
});

test('карточка отдаётся странице системы в форме проекта Raven', () => {
  const [card] = cardsFromStored([storedRow({
    commodities: { steel: 900, aluminium: 100 },
    resources: [
      { Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 100 },
      { Name: 'aluminium', RequiredAmount: 200, ProvidedAmount: 100 },
    ],
    progress: 25,
  })]);
  const project = ravenProjectFromCard(card);

  // Точные строки депота главнее остатка из `commodities`: у них известен
  // и RequiredAmount, и ProvidedAmount.
  assert.equal(project.buildId, 'build-1');
  assert.equal(project.marketId, '128016640');
  assert.equal(project.complete, false);
  assert.equal(project.progress, 25);
  assert.deepEqual(project.resources.map((row) => [row.key, row.remaining, row.exact]), [
    ['steel', 900, true],
    ['aluminium', 100, true],
  ]);
  assert.equal(project.resources[0].name, 'Steel', 'имя товара пригодно для показа');
  assert.equal(project.totalRemaining, 1000);
  assert.equal(project.totalRequired, 1200);
  assert.equal(project.totalProvided, 200);
});

test('остаток из commodities показывается без выдуманной разбивки', () => {
  const [card] = cardsFromStored([storedRow({ commodities: { steel: 900 }, resources: [], max_need: null })]);
  const project = ravenProjectFromCard(card);
  assert.equal(project.resources[0].required, null, 'сколько было нужно — неизвестно');
  assert.equal(project.resources[0].provided, null);
  assert.equal(project.resources[0].exact, false);
  assert.equal(project.totalRemaining, 900);
  assert.equal(project.totalRequired, null, 'объём проекта из commodities не выводится');
});

test('проценты карточки считаются из депота, закрытая стройка — 100', () => {
  const [active] = cardsFromStored([storedRow({
    progress: null,
    resources: [{ Name: 'steel', RequiredAmount: 1000, ProvidedAmount: 250 }],
  })]);
  assert.equal(cardTotals(active).totalProvided, 250);
  assert.equal(ravenProjectFromCard(active).progress, 25);

  const [done] = cardsFromStored([storedRow({ status: 'complete', progress: 40 })]);
  const project = ravenProjectFromCard(done);
  assert.equal(project.complete, true);
  assert.equal(project.progress, 100);
  assert.equal(project.totalRemaining, 0);
});

test('сводка ресурсов системы складывает проекты и честно теряет точность', () => {
  const rows = cardResourceRows(cardsFromStored([storedRow({
    resources: [{ Name: 'steel', RequiredAmount: 100, ProvidedAmount: 40 }],
  })])[0]);
  const exactMerged = mergeResourceRows([...rows, { ...rows[0], remaining: 10, required: 20, provided: 10 }]);
  assert.equal(exactMerged.length, 1);
  assert.equal(exactMerged[0].remaining, 70);
  assert.equal(exactMerged[0].required, 120);
  assert.equal(exactMerged[0].provided, 50);
  assert.equal(exactMerged[0].exact, true);

  const loose = mergeResourceRows([
    { key: 'steel', name: 'Steel', required: null, provided: null, remaining: 900, exact: false },
    { key: 'steel', name: 'Steel', required: 100, provided: 40, remaining: 60, exact: true },
  ]);
  assert.equal(loose[0].remaining, 960);
  assert.equal(loose[0].required, null, 'смешанные данные не выдаются за точные');
  assert.equal(loose[0].exact, false);
});
