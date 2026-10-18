import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCarrierEvents, carrierMarketCargo, carrierOpsFromStationReport, buildCarrierView,
  canonicalCommodity, parseCarrierReference, carrierDeltaHash, SQUADRON_PROOF_EVENTS,
} from '../../src/lib/fleetCarriers.ts';
import {
  carrierSquadronTag, gameSquadronTag, looksLikeSquadronCallsign, normalizeSquadronTag, squadronTagConflict,
} from '../../src/lib/carrierTags.ts';
import { CarrierEventCollector } from '../../src/lib/fleetCarrierCollector.ts';

const USER = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2026-03-01T12:00:00Z');
const norm = (events, userId = USER) => normalizeCarrierEvents(events, { userId, now: NOW });
const opsOf = (result, kind) => result.ops.filter((op) => op.op === kind);

const STATS = {
  timestamp: '2026-03-01T10:00:00Z', event: 'CarrierStats', CarrierID: 3700005632, Callsign: 'L14-X1J', Name: 'Spirula',
  DockingAccess: 'all', AllowNotorious: false, FuelLevel: 63, JumpRangeCurr: 81.07, JumpRangeMax: 500, PendingDecommission: false,
  SpaceUsage: { TotalCapacity: 25000, Crew: 5450, Cargo: 0, CargoSpaceReserved: 44, ShipPacks: 774, ModulePacks: 913, FreeSpace: 17379 },
  Finance: { CarrierBalance: 10000000, ReserveBalance: 1800000, AvailableBalance: 8171946, ReservePercent: 18, TaxRate_refuel: 3 },
  Crew: [{ CrewRole: 'Refuel', Activated: true, Enabled: false, CrewName: 'Maricela' }, { CrewRole: 'Captain', Activated: true, Enabled: true }],
  ShipPacks: [{ PackTheme: 'Zorgon Peterson - Exploration', PackTier: 1 }],
};

test('canonical commodity keys match the Helper (event_dispatch.canonical_commodity)', () => {
  assert.equal(canonicalCommodity('$liquidoxygen_name;'), 'liquidoxygen');
  assert.equal(canonicalCommodity('CMM Composite'), 'cmmcomposite');
  assert.equal(canonicalCommodity('Steel'), 'steel');
  assert.equal(canonicalCommodity(''), '');
});

test('CarrierStats: identity, stats, ownership proof and an empty-hold baseline', () => {
  const result = norm([STATS]);
  assert.deepEqual(result.ops.map((op) => op.op), ['identity', 'stats', 'owner', 'baseline']);
  const stats = opsOf(result, 'stats')[0];
  assert.equal(stats.carrier_id, '3700005632');
  assert.equal(stats.space_usage.free_space, 17379);
  assert.equal(stats.finance.carrier_balance, 10000000);
  assert.equal(stats.finance.tax_rate_refuel, 3);
  assert.deepEqual(stats.services[0], { role: 'Refuel', activated: true, enabled: false, crew_name: 'Maricela' });
  assert.equal(opsOf(result, 'owner')[0].proof, 'journal');
  assert.deepEqual(opsOf(result, 'baseline')[0], { op: 'baseline', carrier_id: '3700005632', at: '2026-03-01T10:00:00.000Z', full: true, source_event: 'CarrierStats', items: [] });
  // Non-empty hold: no baseline (the total alone does not say what is aboard).
  const loaded = norm([{ ...STATS, SpaceUsage: { ...STATS.SpaceUsage, Cargo: 440 } }]);
  assert.equal(opsOf(loaded, 'baseline').length, 0);
});

test('squadron carrier stats bind to the squadron, never to the pilot', () => {
  const result = norm([{ ...STATS, CarrierType: 'SquadronCarrier', Callsign: 'ENEX', Name: 'ENDURANCE ENDEAVOUR' }]);
  assert.equal(opsOf(result, 'owner').length, 0);
  assert.deepEqual(opsOf(result, 'squadron_claim'), [
    { op: 'squadron_claim', carrier_id: '3700005632', at: '2026-03-01T10:00:00.000Z', proof: 'CarrierStats' },
  ]);
  assert.equal(opsOf(result, 'identity')[0].carrier_type, 'SquadronCarrier');
  assert.equal(opsOf(result, 'identity')[0].callsign, 'ENEX');
});

test('squadron membership: only CarrierLocation, CarrierStats and CarrierBuy claim a Javelin — docking never does', () => {
  assert.deepEqual([...SQUADRON_PROOF_EVENTS], ['CarrierStats', 'CarrierBuy', 'CarrierLocation']);
  const JAVELIN = 3713124352;
  // Так выглядит запуск игры у члена эскадрильи (реальный журнал, ENDURANCE EXPLORATION).
  const login = norm([
    { timestamp: '2026-03-01T09:00:00Z', event: 'SquadronStartup', SquadronID: 75645, SquadronName: 'ENDURANCE EXPLORATION', CurrentRank: 4 },
    { timestamp: '2026-03-01T09:00:01Z', event: 'CarrierLocation', CarrierType: 'SquadronCarrier', CarrierID: JAVELIN,
      StarSystem: 'Col 285 Sector FZ-K b23-5', SystemAddress: 11664997164513, BodyID: 8 },
  ]);
  assert.deepEqual(opsOf(login, 'squadron_claim').map((op) => op.proof), ['CarrierLocation']);
  assert.equal(opsOf(login, 'owner').length, 0);
  const bought = norm([{ timestamp: '2026-03-01T09:00:00Z', event: 'CarrierBuy', CarrierType: 'SquadronCarrier', CarrierID: JAVELIN,
    Callsign: 'ENEX', Location: 'Sol', SystemAddress: 10477373803 }]);
  assert.deepEqual(opsOf(bought, 'squadron_claim').map((op) => op.proof), ['CarrierBuy']);

  // Стыковка к чужому Javelin (доступ «все пилоты»): носитель, система и тег — да, привязка — нет.
  const docked = { timestamp: '2026-03-01T09:10:00Z', StationName: 'ENEX', StationType: 'FleetCarrier', MarketID: JAVELIN,
    StarSystem: 'Col 285 Sector FZ-K b23-5', SystemAddress: 11664997164513,
    StationServices: ['dock', 'autodock', 'commodities', 'contacts', 'squadronBank', 'flightcontroller'] };
  const visits = norm([
    { ...docked, event: 'Docked' },
    { ...docked, event: 'Location', Docked: true, timestamp: '2026-03-01T09:20:00Z' },
    { ...docked, event: 'CarrierJump', Docked: true, timestamp: '2026-03-01T09:30:00Z', StarSystem: 'LHS 5333' },
  ]);
  assert.equal(opsOf(visits, 'squadron_claim').length, 0, 'стыковка к Javelin не делает его носителем эскадрильи пилота');
  assert.equal(opsOf(visits, 'location').length, 3);
  for (const identity of opsOf(visits, 'identity')) {
    assert.equal(identity.carrier_type, 'SquadronCarrier');
    assert.equal(identity.callsign, 'ENEX', 'имя стоянки Javelin — его позывной, тег эскадрильи');
    assert.equal(identity.name, undefined);
    assert.equal(identity.weak_name, undefined);
  }
});

test('market trades: sale TO the carrier adds cargo, purchase FROM it removes; other markets are ignored', () => {
  const result = norm([
    { timestamp: '2026-03-01T10:01:00Z', event: 'MarketSell', MarketID: 3700005632, Type: 'steel', Type_Localised: 'Steel', Count: 784, SellPrice: 4000, TotalSale: 3136000, AvgPricePaid: 3500 },
    { timestamp: '2026-03-01T10:02:00Z', event: 'MarketBuy', MarketID: 3700005632, Type: 'aluminium', Count: 100, BuyPrice: 500, TotalCost: 50000 },
    { timestamp: '2026-03-01T10:03:00Z', event: 'MarketSell', MarketID: 128666762, Type: 'gold', Count: 10 },
  ]);
  const deltas = opsOf(result, 'delta');
  assert.deepEqual(deltas.map((op) => [op.commodity, op.delta]), [['steel', 784], ['aluminium', -100]]);
  assert.equal(deltas[0].name_localised, 'Steel');
  assert.match(deltas[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(result.skipped, 1);
});

test('delta hashes: same pilot + same event = same hash; another pilot = another hash', () => {
  const sale = { timestamp: '2026-03-01T10:01:00Z', event: 'MarketSell', MarketID: 3700005632, Type: 'steel', Count: 784, SellPrice: 4000, TotalSale: 3136000 };
  const a = opsOf(norm([sale]), 'delta')[0].hash;
  const b = opsOf(norm([{ ...sale, StationName: 'ignored extra field' }]), 'delta')[0].hash;
  const c = opsOf(norm([sale], '00000000-0000-4000-8000-000000000009'), 'delta')[0].hash;
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(carrierDeltaHash(['x', 1]), carrierDeltaHash(['x', 2]));
});

test('CargoTransfer uses the docked carrier from context; tosrv and missing context are skipped', () => {
  const transfer = { timestamp: '2026-03-01T10:05:00Z', event: 'CargoTransfer', Transfers: [
    { Type: 'steel', Count: 700, Direction: 'tocarrier' },
    { Type: 'titanium', Type_Localised: 'Titanium', Count: 50, Direction: 'toship' },
    { Type: 'water', Count: 2, Direction: 'tosrv' },
  ] };
  const withContext = norm([{ ...transfer, _MarketID: 3700005632, _StationType: 'FleetCarrier' }]);
  assert.deepEqual(opsOf(withContext, 'delta').map((op) => [op.commodity, op.delta]), [['steel', 700], ['titanium', -50]]);
  const hashes = new Set(opsOf(withContext, 'delta').map((op) => op.hash));
  assert.equal(hashes.size, 2);
  assert.equal(opsOf(norm([transfer]), 'delta').length, 0);
});

test('docking at a carrier records location, callsign and services, never squadron membership', () => {
  const result = norm([{ timestamp: '2026-03-01T09:00:00Z', event: 'Docked', StationName: 'K7X-B0Z', StationType: 'FleetCarrier',
    MarketID: 3709000001, StarSystem: 'HIP 1', SystemAddress: 123, StationServices: ['dock', 'squadronBank', 'refuel'], _StarPos: [1, 2, 3] }]);
  const identity = opsOf(result, 'identity')[0];
  assert.equal(identity.callsign, 'K7X-B0Z');
  assert.equal(identity.carrier_type, 'SquadronCarrier');
  assert.deepEqual(identity.station_services, ['dock', 'squadronbank', 'refuel']);
  const location = opsOf(result, 'location')[0];
  assert.deepEqual([location.system_name, location.x, location.y, location.z], ['HIP 1', 1, 2, 3]);
  assert.equal(opsOf(result, 'squadron_claim').length, 0);
  // A four-letter name of a Drake (no squadronBank) stays a (weak) name, not a squadron tag.
  const drake = opsOf(norm([{ timestamp: '2026-03-01T09:00:00Z', event: 'Docked', StationName: 'HOME', StationType: 'FleetCarrier',
    MarketID: 3700000077, StarSystem: 'Sol', StationServices: ['dock', 'refuel'] }]), 'identity')[0];
  assert.deepEqual([drake.callsign, drake.name, drake.weak_name], [undefined, 'HOME', true]);
  // Docking at an ordinary station produces nothing.
  assert.equal(norm([{ timestamp: '2026-03-01T09:00:00Z', event: 'Docked', StationType: 'Coriolis', MarketID: 128666762, StarSystem: 'Sol' }]).ops.length, 0);
});

test('squadron tags: the Javelin callsign is its squadron tag; site tags are compared without brackets', () => {
  assert.equal(looksLikeSquadronCallsign('ENEX'), true);
  assert.equal(looksLikeSquadronCallsign(' enex '), true);
  assert.equal(looksLikeSquadronCallsign('K7X-B0Z'), false);
  assert.equal(looksLikeSquadronCallsign('ENEXX'), false);
  assert.equal(normalizeSquadronTag('[dnhg] '), 'DNHG');
  assert.equal(gameSquadronTag('[DNHG]'), 'DNHG');
  assert.equal(gameSquadronTag('DH'), null, 'тег не из четырёх символов ничего не доказывает');
  assert.equal(gameSquadronTag('DRUNKHEDGE'), null);
  assert.equal(carrierSquadronTag({ type: 'SquadronCarrier', callsign: 'enex' }), 'ENEX');
  assert.equal(carrierSquadronTag({ type: 'FleetCarrier', callsign: 'HOME' }), null);
  assert.equal(carrierSquadronTag({ type: 'SquadronCarrier', callsign: null }), null);
  assert.equal(squadronTagConflict('ENEX', '[DNHG]'), true);
  assert.equal(squadronTagConflict('DNHG', 'dnhg'), false);
  assert.equal(squadronTagConflict('ENEX', 'DRUNKHEDGE'), false);
  assert.equal(squadronTagConflict(null, 'DNHG'), false);
  assert.equal(squadronTagConflict('K7X-B0Z', 'DNHG'), false);
});

test('jumps: request with departure time, default countdown for old journals, cancellation', () => {
  const result = norm([
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierJumpRequest', CarrierID: 3700005632, SystemName: 'Alpha', Body: 'Alpha A', SystemAddress: 5, BodyID: 1, DepartureTime: '2026-03-01T10:15:10Z' },
    { timestamp: '2026-03-01T11:00:00Z', event: 'CarrierJumpRequest', CarrierID: 3700005632, SystemName: 'Beta' },
    { timestamp: '2026-03-01T11:01:00Z', event: 'CarrierJumpCancelled', CarrierID: 3700005632 },
  ]);
  const jumps = opsOf(result, 'jump');
  assert.equal(jumps[0].departure_at, '2026-03-01T10:15:10.000Z');
  assert.equal(jumps[1].departure_at, '2026-03-01T11:15:00.000Z');
  assert.equal(opsOf(result, 'jump_cancel').length, 1);
});

test('services, docking permission, trade orders, names and decommission', () => {
  const result = norm([
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierCrewServices', CarrierID: 3700005632, CrewRole: 'VistaGenomics', Operation: 'Activate', CrewName: 'Bob' },
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierDockingPermission', CarrierID: 3700005632, DockingAccess: 'squadron', AllowNotorious: true },
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierTradeOrder', CarrierID: 3700005632, BlackMarket: false, Commodity: 'steel', Commodity_Localised: 'Steel', PurchaseOrder: 1000, Price: 4500 },
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierNameChanged', CarrierID: 3700005632, Name: 'New Name', Callsign: 'L14-X1J' },
    { timestamp: '2026-03-01T10:00:00Z', event: 'CarrierDecommission', CarrierID: 3700005632 },
  ]);
  assert.deepEqual(result.ops.map((op) => op.op), ['service', 'docking', 'order', 'identity', 'decommission']);
  assert.equal(opsOf(result, 'service')[0].operation, 'activate');
  assert.equal(opsOf(result, 'order')[0].purchase, 1000);
  assert.equal(opsOf(result, 'identity')[0].name, 'New Name');
  assert.equal(opsOf(result, 'decommission')[0].pending, true);
});

test('garbage and future events are skipped without throwing', () => {
  const result = norm([null, 42, { event: 'MarketSell' }, { ...STATS, timestamp: '2099-01-01T00:00:00Z' }, { event: 'Scan', timestamp: '2026-03-01T10:00:00Z' }]);
  assert.equal(result.ops.length, 0);
  assert.equal(result.skipped, 5);
});

test('market snapshot → cargo: sell orders are aboard, sold-out items are zero, buy orders say nothing', () => {
  const cargo = carrierMarketCargo([
    { name: '$steel_name;', name_localised: 'Steel', stock: 1200, producer: true, consumer: false },
    { name: 'Titanium', stock: 0, demand: 0, producer: false, consumer: false },
    { name: 'Water', stock: 0, demand: 500, producer: false, consumer: true },
    // Without flags (older Helper): stock > 0 → for sale; demand only → purchase order.
    { name: 'Gold', stock: 10 },
    { name: 'Silver', demand: 40 },
  ]);
  assert.deepEqual(cargo, [
    { commodity: 'steel', qty: 1200, name_localised: 'Steel' },
    { commodity: 'titanium', qty: 0, name_localised: undefined },
    { commodity: 'gold', qty: 10, name_localised: undefined },
  ]);
});

test('station reports from a carrier become identity, location and a market baseline', () => {
  const ops = carrierOpsFromStationReport({
    market_id: '3700005632', station_type: 'FleetCarrier', station_name: 'L14-X1J', system_name: 'Sol', observed_at: '2026-03-01T10:00:00Z',
    x: 0, y: 0, z: 0, metadata: { services: ['dock', 'commodities'] },
    inventories: { market: { observed_at: '2026-03-01T10:00:00Z', items: [{ name: 'Steel', stock: 5 }] } },
  });
  assert.deepEqual(ops.map((op) => op.op), ['identity', 'location', 'baseline']);
  assert.equal(ops[2].full, false);
  assert.deepEqual(ops[2].items, [{ commodity: 'steel', qty: 5, name_localised: undefined }]);
  assert.equal(ops[0].callsign, 'L14-X1J');
  assert.deepEqual(carrierOpsFromStationReport({ market_id: '128666762', station_type: 'Coriolis', station_name: 'Galileo', system_name: 'Sol', observed_at: '2026-03-01T10:00:00Z' }), []);
  // Рынок Javelin: имя станции — тег эскадрильи (позывной); отчёт о рынке привязки не даёт.
  const javelin = carrierOpsFromStationReport({
    market_id: '3713124352', station_type: 'FleetCarrier', station_name: 'ENEX', system_name: 'LHS 5333', observed_at: '2026-03-01T10:00:00Z',
    metadata: { services: ['dock', 'commodities', 'squadronBank'] },
  });
  assert.deepEqual(javelin.map((op) => op.op), ['identity', 'location']);
  assert.deepEqual([javelin[0].carrier_type, javelin[0].callsign, javelin[0].name], ['SquadronCarrier', 'ENEX', undefined]);
});

test('carrier view: estimated arrival after a jump, cargo and finance hidden from the public', () => {
  const row = {
    carrier_id: 3700005632, carrier_type: 'FleetCarrier', callsign: 'L14-X1J', name: 'Spirula', owner_source: 'journal',
    system_name: 'Sol', x: 0, y: 0, z: 0, location_at: '2026-03-01T09:00:00Z',
    jump_system_name: 'Alpha', jump_departure_at: '2026-03-01T11:00:00Z', jump_requested_at: '2026-03-01T10:45:00Z',
    space_usage: { cargo: 440, free_space: 17379, total_capacity: 25000 }, finance: { carrier_balance: 5 },
    services: [{ role: 'Refuel', activated: true, enabled: true }], trade_orders: { steel: { name: 'Steel', purchase: 10, at: '2026-03-01T10:00:00Z' } },
  };
  const cargoRows = [{ commodity: 'steel', name_localised: 'Steel', quantity: 400 }, { commodity: 'gold', quantity: 0 }];
  const own = buildCarrierView(row, { relation: 'own', showFinance: true, cargoRows, now: NOW });
  assert.equal(own.location.system, 'Alpha');
  assert.equal(own.location.estimated, true);
  assert.equal(own.location.previousSystem, 'Sol');
  assert.equal(own.jump, null);
  assert.equal(own.space.cargoCapacity, 17819);
  assert.deepEqual(own.cargo.items.map((item) => [item.commodity, item.quantity]), [['steel', 400]]);
  assert.equal(own.finance.carrier_balance, 5);
  assert.equal(own.services[0].label, 'Заправка');
  const pub = buildCarrierView(row, { relation: 'public', showFinance: false, cargoRows, now: new Date('2026-03-01T10:50:00Z') });
  assert.equal(pub.cargo, null);
  assert.equal(pub.finance, null);
  assert.equal(pub.location.system, 'Sol');
  assert.equal(pub.jump.state, 'scheduled');
  assert.equal(pub.ownerSource, null);
});

test('carrier references: Carrier ID, Drake callsign or Javelin squadron tag', () => {
  assert.deepEqual(parseCarrierReference(' 3700005632 '), { carrierId: '3700005632' });
  assert.deepEqual(parseCarrierReference('l14-x1j'), { callsign: 'L14-X1J' });
  assert.deepEqual(parseCarrierReference(' enex '), { callsign: 'ENEX' });
  assert.equal(parseCarrierReference('hello'), null);
  assert.equal(parseCarrierReference('[ENEX]'), null);
});

test('collector: web upload and Helper-style full events produce identical deltas', () => {
  const journal = [
    { timestamp: '2026-03-01T08:00:00Z', event: 'FSDJump', StarSystem: 'Sol', StarPos: [0, 0, 0], SystemAddress: 1 },
    { timestamp: '2026-03-01T08:10:00Z', event: 'Docked', StationName: 'L14-X1J', StationType: 'FleetCarrier', MarketID: 3700005632, StarSystem: 'Sol', SystemAddress: 1, LandingPads: { Large: 8 } },
    { timestamp: '2026-03-01T08:11:00Z', event: 'MarketSell', MarketID: 3700005632, Type: 'steel', Count: 700, SellPrice: 4000, TotalSale: 2800000, AvgPricePaid: 3000 },
    { timestamp: '2026-03-01T08:12:00Z', event: 'CargoTransfer', Transfers: [{ Type: 'titanium', Count: 20, Direction: 'tocarrier' }] },
    { timestamp: '2026-03-01T08:13:00Z', event: 'Undocked', StationName: 'L14-X1J', MarketID: 3700005632 },
    { timestamp: '2026-03-01T08:14:00Z', event: 'CargoTransfer', Transfers: [{ Type: 'water', Count: 5, Direction: 'tocarrier' }] },
    { timestamp: '2026-03-01T08:20:00Z', event: 'Docked', StationName: 'Galileo', StationType: 'Ocellus', MarketID: 128666762, StarSystem: 'Sol' },
    { timestamp: '2026-03-01T08:21:00Z', event: 'MarketSell', MarketID: 128666762, Type: 'gold', Count: 1 },
  ];
  const collector = new CarrierEventCollector();
  for (const event of journal) collector.feed(JSON.stringify(event), event);
  const collected = collector.drain();
  assert.deepEqual(collected.map((event) => event.event), ['Docked', 'MarketSell', 'CargoTransfer']);
  assert.deepEqual(collected[0]._StarPos, [0, 0, 0]);
  assert.equal(collected[0].LandingPads, undefined, 'unused fields are not uploaded');
  assert.equal(collected[2]._MarketID, 3700005632);

  const web = opsOf(norm(collected), 'delta');
  // The Helper sends full journal events plus the same context fields.
  const helper = opsOf(norm([journal[2], { ...journal[3], _MarketID: 3700005632, _StationType: 'FleetCarrier' }]), 'delta');
  assert.deepEqual(web.map((op) => op.hash), helper.map((op) => op.hash));
  assert.deepEqual(web.map((op) => [op.commodity, op.delta]), [['steel', 700], ['titanium', 20]]);
});
