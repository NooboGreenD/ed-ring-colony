import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CONSTRUCTION_SOURCES,
  createJournalParseState,
  isConstructionSourceName,
  parseJournal,
} from '../../src/lib/journalParser.ts';
import { TelemetryCollector, parseJournalTelemetry, persistJournalTelemetry } from '../../src/lib/journalTelemetry.ts';

/* ── helpers ── */

const line = (event) => JSON.stringify(event);
const TS = '2026-09-14T10:00:00Z';
const SYSTEM = 'Delta Velorum';

function jump(system = SYSTEM, timestamp = TS) {
  return line({ timestamp, event: 'FSDJump', StarSystem: system, SystemAddress: 6474796828161 });
}

function contribution(amount, timestamp = TS, marketId = 9001, commodity = 'Basic Medicines') {
  return line({
    timestamp,
    event: 'ColonisationContribution',
    MarketID: marketId,
    Contributions: [
      { Name: `$${commodity.toLowerCase().replace(/ /g, '')}_name;`, Name_Localised: commodity, Amount: amount },
    ],
  });
}

function depotSnapshot(marketId, progress, timestamp = TS) {
  return line({
    timestamp,
    event: 'ColonisationConstructionDepot',
    MarketID: marketId,
    ConstructionName: 'Ditceford Hub',
    ConstructionProgress: progress,
    ResourcesRequired: [
      { Name: '$titanium_name;', Name_Localised: 'Titanium', ProvidedAmount: 100, TargetAmount: 400 },
    ],
  });
}

function docked(marketId, timestamp = TS) {
  return line({ timestamp, event: 'Docked', MarketID: marketId, StationName: 'Ditceford Hub', Sector: 'Colonisation' });
}

function cargo(titanium, other = 0, timestamp = TS) {
  const inventory = [{ Name: '$titanium_name;', Name_Localised: 'Titanium', Count: titanium }];
  if (other > 0) inventory.push({ Name: '$iron_name;', Name_Localised: 'Iron', Count: other });
  return line({ timestamp, event: 'Cargo', Vessel: 'Ship', Count: inventory.length, Inventory: inventory });
}

function parse(...lines) {
  const lookup = { hubs: new Set(), routeSystems: new Map() };
  return parseJournal(lines.join('\n'), lookup, createJournalParseState());
}

/* ── источники и признак «на стройку» ── */

test('прямые колонизационные поставки помечаются как строительные', () => {
  const { deliveries, stats } = parse(jump(), contribution(250));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source, 'colonisation_contribution');
  assert.equal(deliveries[0].isConstruction, true);
  assert.equal(deliveries[0].amount, 250);
  assert.equal(stats.constructionTons, 250);
  assert.equal(stats.transportedTons, 250);
  assert.equal(stats.transportDeliveries, 0);
});

test('колонизация: каждое событие даёт свой объём, а не накопленный', () => {
  const { deliveries, stats } = parse(
    jump(),
    contribution(120, '2026-09-14T10:00:00Z'),
    contribution(80, '2026-09-14T10:05:00Z'),
  );
  assert.deepEqual(deliveries.map((d) => d.amount), [120, 80]);
  assert.equal(stats.constructionTons, 200);
});

function cargoDepot(count, timestamp = TS) {
  return line({
    timestamp,
    event: 'CargoDepot',
    UpdateType: 'Deliver',
    CargoType: 'basicmedicines',
    CargoType_Localised: 'Basic Medicines',
    Count: count,
    CountTotal: count,
    Need: 100,
    Wing: false,
  });
}

test('CargoDepot без стройплощадки — груз миссии, а не стройка', () => {
  const { deliveries, stats } = parse(jump(), cargoDepot(64));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source, 'cargo_depot');
  assert.equal(deliveries[0].deliveryKind, 'mission_delivery');
  assert.equal(deliveries[0].isConstruction, false);
  assert.equal(stats.constructionTons, 0);
  assert.equal(stats.transportedTons, 64);
  assert.equal(stats.kindTons.mission_delivery, 64);
});

test('CargoDepot у рынка стройплощадки — строительный тоннаж', () => {
  const { deliveries, stats } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 9001,
      StationName: 'Planetary Construction Site: Ditceford Depot',
      StationType: 'PlanetaryInstallation',
      StationServices: ['dock', 'colonisationcontribution', 'missions'],
    }),
    cargoDepot(64, '2026-09-14T10:01:00Z'),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source, 'cargo_depot');
  assert.equal(deliveries[0].deliveryKind, 'construction_site');
  assert.equal(deliveries[0].isConstruction, true);
  assert.equal(stats.constructionTons, 64);
  assert.equal(stats.kindTons.construction_site, 64);
});

test('cargo_delta становится стройкой только у известной площадки', () => {
  // Есть ColonisationConstructionDepot → рынок 9001 помечен строительным.
  const atSite = parse(
    jump(),
    depotSnapshot(9001, 0.25),
    docked(9001),
    cargo(500, 0, '2026-09-14T10:01:00Z'),
    cargo(300, 0, '2026-09-14T10:02:00Z'),
  );
  assert.equal(atSite.deliveries.length, 1);
  assert.equal(atSite.deliveries[0].source, 'cargo_delta');
  assert.equal(atSite.deliveries[0].isConstruction, true);
  assert.equal(atSite.deliveries[0].amount, 200);
  assert.equal(atSite.stats.constructionTons, 200);

  // Тот же трюк, но груз сдан в обычном порту — это перевозка, не стройка.
  const atMarket = parse(
    jump(),
    line({ timestamp: TS, event: 'Docked', MarketID: 4242, StationName: 'Jaeger Hub' }),
    cargo(500, 0, '2026-09-14T10:01:00Z'),
    cargo(300, 0, '2026-09-14T10:02:00Z'),
  );
  assert.equal(atMarket.deliveries.length, 1);
  assert.equal(atMarket.deliveries[0].isConstruction, false);
  assert.equal(atMarket.stats.constructionTons, 0);
  assert.equal(atMarket.stats.transportedTons, 200);
  assert.equal(atMarket.stats.transportDeliveries, 1);
});

test('отгрузка на авианосце — перевозка, а не стройка', () => {
  const { deliveries, stats } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'MarketSell',
      Type: 'titanium',
      Type_Localised: 'Titanium',
      Count: 420,
      MarketID: 1234,
      CarrierID: 'C1',
      StationType: 'Fleet Carrier',
      AvgPrice: 9000,
    }),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source, 'carrier_delivery');
  assert.equal(deliveries[0].isConstruction, false);
  // Продажа не должна съедать следующий Cargo-снимок целиком — дубль режется
  // accountedCargo-логикой парсера, а не подавлением источника.
  assert.equal(stats.transportedTons, 420);
});

test('грузовые миссии, Powerplay и SAR — только перевозка', () => {
  const { deliveries, stats } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'MissionCompleted',
      MissionName: 'Deliver Consumables',
      Commodity: 'foodpurifiers',
      Commodity_Localised: 'Food Purifiers',
      Count: 30,
      CargoDelivered: [{ Commodity: 'foodpurifiers', Commodity_Localised: 'Food Purifiers', Count: 30 }],
      Rewards: [],
    }),
    line({ timestamp: '2026-09-14T10:01:00Z', event: 'PowerplayDeliver', Commodity: 'metal scraps', Count: 12 }),
    line({
      timestamp: '2026-09-14T10:02:00Z',
      event: 'SearchAndRescue',
      Commodity: 'rescuesupplies',
      Count: 7,
      Donated: 7,
    }),
  );
  assert.deepEqual(deliveries.map((d) => d.source), ['mission_delivery', 'powerplay_delivery', 'rescue_delivery']);
  assert.ok(deliveries.every((d) => d.isConstruction === false));
  assert.equal(stats.constructionTons, 0);
  assert.equal(stats.transportedTons, 49);
});

test('«всего тонн» = весь груз, «на стройку» = только площадки', () => {
  const { stats } = parse(
    jump(),
    contribution(100, '2026-09-14T10:00:00Z'),
    line({ timestamp: '2026-09-14T10:01:00Z', event: 'PowerplayDeliver', Commodity: 'metal scraps', Count: 40 }),
  );
  assert.equal(stats.transportedTons, 140);
  assert.equal(stats.constructionTons, 100);
  assert.equal(stats.transportedTons - stats.constructionTons, 40);
});

test('isConstructionSourceName совпадает с множеством источников', () => {
  for (const source of CONSTRUCTION_SOURCES) assert.equal(isConstructionSourceName(source), true);
  for (const source of ['carrier_delivery', 'mission_delivery', 'powerplay_delivery', 'rescue_delivery', 'cargo_delta', '']) {
    assert.equal(isConstructionSourceName(source), false, source);
  }
});

/* ── разделение по получателю груза: стройка/корабль vs авианосец/рынок ── */

test('поставка на колонизационный корабль — отдельный вид, но тоже стройка', () => {
  const { deliveries, stats } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 7001,
      StationName: 'System Colonisation Ship',
      StationType: 'Orbis Starport',
      StationServices: ['dock', 'colonisationcontribution'],
    }),
    contribution(320, '2026-09-14T10:01:00Z', 7001),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliveryKind, 'colonisation_ship');
  assert.equal(deliveries[0].isConstruction, true);
  assert.equal(stats.constructionTons, 320);
  assert.equal(stats.kindTons.colonisation_ship, 320);
  assert.equal(stats.kindTons.construction_site, 0);
});

test('продажа на авианосце и на обычном рынке — разные виды перевозки', () => {
  const carrier = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 5001,
      StationName: 'FC Spirula',
      StationType: 'FleetCarrier',
      CarrierID: '3700005632',
    }),
    line({
      timestamp: '2026-09-14T10:01:00Z',
      event: 'MarketSell',
      MarketID: 5001,
      Type: 'titanium',
      Type_Localised: 'Titanium',
      Count: 100,
      CarrierID: '3700005632',
      StationType: 'FleetCarrier',
    }),
  );
  assert.equal(carrier.deliveries[0].deliveryKind, 'fleet_carrier');
  assert.equal(carrier.deliveries[0].isConstruction, false);
  assert.equal(carrier.stats.kindTons.fleet_carrier, 100);
  assert.equal(carrier.stats.constructionTons, 0);

  const market = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 4242,
      StationName: 'Jaeger Hub',
      StationType: 'Orbis Starport',
    }),
    line({
      timestamp: '2026-09-14T10:01:00Z',
      event: 'MarketSell',
      MarketID: 4242,
      Type: 'titanium',
      Type_Localised: 'Titanium',
      Count: 40,
      StationType: 'Orbis Starport',
    }),
  );
  assert.equal(market.deliveries[0].deliveryKind, 'market_sale');
  assert.equal(market.deliveries[0].isConstruction, false);
  assert.equal(market.stats.kindTons.market_sale, 40);
  assert.equal(market.stats.constructionTons, 0);
});

test('cargo_delta у авианосца — отгрузка на авианосец, а не продажа на рынке', () => {
  const { deliveries } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 5001,
      StationName: 'FC Spirula',
      StationType: 'FleetCarrier',
      CarrierID: '3700005632',
    }),
    cargo(500, 0, '2026-09-14T10:05:00Z'),
    cargo(300, 0, '2026-09-14T10:06:00Z'),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].source, 'cargo_delta');
  assert.equal(deliveries[0].deliveryKind, 'fleet_carrier');
  assert.equal(deliveries[0].isConstruction, false);
  assert.equal(deliveries[0].amount, 200);
});

test('стройплощадка узнаётся по имени станции даже без depot-события', () => {
  // Приложение могло стартовать, когда игрок уже стоит у площадки: журнал в
  // этой сессии `ColonisationConstructionDepot` ещё не показывал.
  const { deliveries, stats } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 9001,
      StationName: 'Orbital Construction Site: Ditceford Hub',
      StationType: 'Orbis Starport',
    }),
    cargo(400, 0, '2026-09-14T10:05:00Z'),
    cargo(150, 0, '2026-09-14T10:06:00Z'),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliveryKind, 'construction_site');
  assert.equal(deliveries[0].isConstruction, true);
  assert.equal(deliveries[0].amount, 250);
  assert.equal(stats.constructionTons, 250);
  assert.equal(stats.transportedTons, 250);
});

test('обычный наземный порт с похожим именем без сервиса — не стройка', () => {
  const { deliveries } = parse(
    jump(),
    line({
      timestamp: TS,
      event: 'Docked',
      MarketID: 4242,
      StationName: 'Planetary Construction Site: Ditceford Depot',
      StationType: 'PlanetaryInstallation',
      StationServices: ['dock', 'missions', 'commodities'],
    }),
    cargo(200, 0, '2026-09-14T10:05:00Z'),
    cargo(50, 0, '2026-09-14T10:06:00Z'),
  );
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliveryKind, 'market_sale');
  assert.equal(deliveries[0].isConstruction, false);
});

test('сводка по видам: стройка, корабль, авианосец, миссии, рынок', () => {
  const { stats } = parse(
    jump(),
    contribution(100, '2026-09-14T10:00:00Z', 9001),
    line({
      timestamp: '2026-09-14T10:01:00Z',
      event: 'Docked',
      MarketID: 5001,
      StationName: 'FC Spirula',
      StationType: 'FleetCarrier',
      CarrierID: 'C1',
    }),
    line({
      timestamp: '2026-09-14T10:02:00Z',
      event: 'MarketSell',
      MarketID: 5001,
      Type: 'titanium',
      Type_Localised: 'Titanium',
      Count: 60,
      CarrierID: 'C1',
      StationType: 'FleetCarrier',
    }),
    line({
      timestamp: '2026-09-14T10:03:00Z',
      event: 'PowerplayDeliver',
      Commodity: 'metal scraps',
      Count: 25,
    }),
  );
  assert.equal(stats.kindTons.construction_site, 100);
  assert.equal(stats.kindTons.fleet_carrier, 60);
  assert.equal(stats.kindTons.powerplay_delivery, 25);
  assert.equal(stats.transportedTons, 185);
  assert.equal(stats.constructionTons, 100);
});

/* ── телеметрия: те же данные, что отправляет Uploader ── */

test('телеметрия собирает snapshot стройки без дублей журнала', () => {
  const text = [
    jump(),
    depotSnapshot(9001, 0.25, '2026-09-14T10:00:00Z'),
    depotSnapshot(9001, 0.25, '2026-09-14T10:00:04Z'),
    depotSnapshot(9001, 0.31, '2026-09-14T10:00:08Z'),
  ].join('\n');
  const telemetry = parseJournalTelemetry(text);
  assert.equal(telemetry.constructionEvents.length, 2, 'одинаковые snapshot' + 'ы схлопываются');
  assert.equal(telemetry.constructionEvents[1].construction_progress, 0.31);
  assert.equal(telemetry.constructionEvents[0].system_name, SYSTEM);
  assert.equal(telemetry.stats.constructionDuplicates, 1);
});

test('телеметрия: scan тела даёт body_type, атмосферу и гейзеры', () => {
  const text = [
    jump(),
    line({
      timestamp: TS,
      event: 'Scan',
      BodyName: `${SYSTEM} 3`,
      BodyID: 12,
      PlanetClass: 'High metal content body',
      StarType: undefined,
      DistanceFromArrivalLS: 420.5,
      SemiMajorAxis: 400.2,
      Radius: 2400000,
      SurfaceGravity: 6.1,
      EarthMasses: 0.8,
      Pressure: 0.5,
      SurfaceTemperature: 280,
      Atmosphere: 'Carbon dioxide',
      AtmosphereComposition: [{ Name: 'CarbonDioxide', Percent: 92 }],
      Volcanism: { Type: 'MinorMagmaFlowsWithWaterVapourGeysers' },
      Landable: true,
      WasDiscovered: false,
      WasMapped: false,
      Parents: [{ Star: 0 }],
    }),
    line({
      timestamp: '2026-09-14T10:01:00Z',
      event: 'FSSBodySignals',
      BodyName: `${SYSTEM} 3`,
      BodyID: 12,
      Signals: [{ Type: '$BiologicalVeganae_type;', Type_Localised: 'Biological signals', Count: 5 }],
    }),
  ].join('\n');
  const telemetry = parseJournalTelemetry(text);
  assert.equal(telemetry.scans.length, 1);
  const scan = telemetry.scans[0];
  assert.equal(scan.body_type, 'Planet');
  assert.equal(scan.sub_type, 'High metal content body');
  assert.equal(scan.is_landable, true);
  assert.equal(scan.semi_major_axis_ls, 400.2);
  assert.equal(scan.earth_masses, 0.8);
  assert.equal(scan.surface_pressure, 0.5);
  assert.equal(scan.atmosphere, 'Carbon dioxide');
  assert.equal(scan.first_discovered_by, 'Вы');
  assert.equal(scan.bio_signals_count, 5, 'сигналы из FSSBodySignals дописываются в тот же ряд');
  assert.equal(telemetry.stats.bioSignals, 5);
});

test('телеметрия: звезда помечается body_type=Star', () => {
  const telemetry = parseJournalTelemetry([
    jump(),
    line({ timestamp: TS, event: 'Scan', BodyName: `${SYSTEM} A`, BodyID: 0, StarType: 'T T Tauri', DistanceFromArrivalLS: 0 }),
  ].join('\n'));
  assert.equal(telemetry.scans.length, 1);
  assert.equal(telemetry.scans[0].body_type, 'Star');
  assert.equal(telemetry.scans[0].sub_type, 'T T Tauri');
});

test('телеметрия: Rank и Statistics попадают в pilot_stats', () => {
  const telemetry = parseJournalTelemetry([
    jump(),
    line({ timestamp: TS, event: 'Rank', Combat: 4, Trade: 6, Explore: 8, Soldier: 5, Exobiologist: 3, CQC: 0, Federation: 4, Empire: 2 }),
    line({
      timestamp: '2026-09-14T10:01:00Z',
      event: 'Statistics',
      Bank_Account: { Current_Wealth: 123456789, General_funds: 123456789 },
      Exobiology: { Organic_Data_Collected: 42, Organic_Species_Encountered: 17, Organic_Data_Profits: 999000 },
    }),
  ].join('\n'));
  assert.equal(telemetry.pilotStats.exobiologist_rank, 3);
  assert.equal(telemetry.pilotStats.mercenary_rank, 5);
  assert.equal(telemetry.pilotStats.credits, 123456789);
  assert.equal(telemetry.pilotStats.bio_samples_count, 42);
  assert.equal(telemetry.pilotStats.bio_species_count, 17);
  assert.equal(telemetry.pilotStats.bio_value_cr, 999000);
});

test('один проход: доставки и телеметрия собираются вместе через hooks', () => {
  const text = [
    jump(),
    depotSnapshot(9001, 0.25, '2026-09-14T10:00:00Z'),
    contribution(150, '2026-09-14T10:00:02Z'),
    line({
      timestamp: '2026-09-14T10:00:03Z',
      event: 'Scan',
      BodyName: `${SYSTEM} 1`,
      BodyID: 5,
      PlanetClass: 'Icy body',
      SurfaceGravity: 1.2,
      Landable: false,
    }),
  ].join('\n');

  const collector = new TelemetryCollector();
  const { deliveries } = parseJournal(
    text,
    { hubs: new Set(), routeSystems: new Map() },
    createJournalParseState(),
    [(rawLine, event) => collector.feed(rawLine, event)],
  );
  const telemetry = collector.finish();

  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].isConstruction, true);
  assert.equal(telemetry.constructionEvents.length, 1);
  assert.equal(telemetry.scans.length, 1);
  assert.equal(telemetry.scans[0].body_name, `${SYSTEM} 1`);
  // Скан не обязан рождать доставку — но и не должен теряться.
  assert.equal(telemetry.currentSystem, SYSTEM);
});

test('хук не может обронить импорт: исключение внутри collector гасится', () => {
  const result = parseJournal(
    [jump(), contribution(10)].join('\n'),
    { hubs: new Set(), routeSystems: new Map() },
    createJournalParseState(),
    [() => { throw new Error('collector упал'); }],
  );
  assert.equal(result.deliveries.length, 1);
});

/* ── сквозная связка: журнал → flag парсера → блоки досье ── */

test('досье из тех же строк журнала: «всего» и «на стройку» сходятся с парсером', async () => {
  const { summarizeCargo } = await import('../../src/lib/dossierCargo.ts');
  const text = [
    jump(),
    depotSnapshot(9001, 0.25, '2026-09-14T10:00:00Z'),
    docked(9001, '2026-09-14T10:00:01Z'),
    contribution(120, '2026-09-14T10:00:02Z'),
    line({
      timestamp: '2026-09-14T10:00:03Z',
      event: 'CargoDepot',
      UpdateType: 'Deliver',
      CargoType: 'titanium',
      CargoType_Localised: 'Titanium',
      Count: 80,
    }),
    line({ timestamp: '2026-09-14T10:00:04Z', event: 'PowerplayDeliver', Commodity: 'metal scraps', Count: 35 }),
    line({
      timestamp: '2026-09-14T10:00:05Z',
      event: 'MarketSell',
      Type: 'titanium',
      Type_Localised: 'Titanium',
      Count: 15,
      StationType: 'Fleet Carrier',
      CarrierID: 'C9',
    }),
  ].join('\n');

  const parsed = parseJournal(text, { hubs: new Set(), routeSystems: new Map() }, createJournalParseState());
  assert.equal(parsed.deliveries.length, 4, parsed.deliveries.map((d) => `${d.source}:${d.amount}`).join(', '));

  // Строки ровно в том виде, в каком они лягут в `deliveries`.
  const summary = summarizeCargo(
    parsed.deliveries.map((delivery) => ({
      amount: delivery.amount,
      system_name: delivery.systemName,
      is_construction: delivery.isConstruction ?? null,
    })),
  );
  // 120 + 80 — стройка; 35 + 15 — только перевозка.
  assert.equal(summary.siteTons, 200);
  assert.equal(summary.totalTons, 250);
  assert.equal(summary.siteOps, 2);
  assert.equal(summary.transportOps, 2);
  assert.deepEqual(summary.siteSystems, [[SYSTEM, 200]]);
  // Досье обязано показывать ровно то, что насчитал парсер.
  assert.equal(summary.totalTons, parsed.stats.transportedTons);
  assert.equal(summary.siteTons, parsed.stats.constructionTons);
});

/* ── запись сканов при statement_timeout ── */

test('пачка сканов не теряется целиком при таймауте базы', async () => {
  // Пачка в 200 сканов несёт тяжёлый JSON, и Supabase обрывает такой запрос по
  // statement_timeout. Раньше вся пачка уходила в warnings и карта с
  // «первооткрытиями» оставалась пустой при формально успешной загрузке.
  const STATEMENT_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
  const written = [];
  const client = {
    from: (table) => ({
      upsert: async (rows) => {
        if (table !== 'system_scans') return { error: null };
        if (rows.length > 4) return { error: STATEMENT_TIMEOUT };
        written.push(...rows);
        return { error: null };
      },
    }),
  };

  const scans = Array.from({ length: 12 }, (_unused, index) => ({
    system_name: 'Delta Velorum',
    body_name: `Body ${index}`,
    body_id: index,
  }));

  const outcome = await persistJournalTelemetry(client, 'user-1', { systemScans: scans }, 'Test Cmdr');

  assert.deepEqual(outcome.warnings, [], 'таймаут не должен был остаться неразрешённым');
  assert.equal(written.length, scans.length, 'часть сканов потеряна вместо записи меньшей пачкой');
  assert.equal(outcome.systemScansInserted, scans.length, 'счётчик записанных сканов расходится с фактом');
});

test('неразрешимый таймаут сканов остаётся в warnings, а не роняет импорт', async () => {
  const STATEMENT_TIMEOUT = { code: '57014', message: 'canceling statement due to statement timeout' };
  const client = { from: () => ({ upsert: async () => ({ error: STATEMENT_TIMEOUT }) }) };

  const outcome = await persistJournalTelemetry(client, 'user-1', {
    systemScans: [{ system_name: 'Sol', body_name: 'Sol A 1', body_id: 1 }],
  }, 'Test Cmdr');

  assert.equal(outcome.systemScansInserted, 0);
  assert.equal(outcome.warnings.length, 1, 'сбой должен быть виден в предупреждениях');
  assert.match(outcome.warnings[0], /statement timeout/);
});
