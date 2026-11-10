/**
 * Слой «Авианосцы» карты галактики и Atlas: чистые функции.
 *
 *   * `carrierMapView.ts` — какие строки `fleet_carriers` попадают на карту,
 *     что о них видит зритель (свой / эскадрилья / чужой, имя владельца по
 *     настройкам приватности), оценка прибытия после прыжка, координаты;
 *   * `carrierMap.ts` — фильтр слоя, счётчики, группировка по системам,
 *     выбор значка и подписи.
 * Плюс проверка по исходникам, что слой подключён и в компактной карте
 * (`/map`), и в Atlas.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_CARRIER_FILTER,
  carrierBadgeText,
  carrierCountLabel,
  carrierHistoryShown,
  carrierIconVariant,
  carrierJumpText,
  carrierListLabel,
  carrierLocationText,
  carrierRelativeTime,
  carrierSystemKey,
  countMapCarriers,
  filterMapCarriers,
  groupCarriersBySystem,
  carrierSourceOf,
  isDefaultCarrierFilter,
  toggleCarrierHistory,
  toggleCarrierRelation,
  toggleCarrierSource,
  toggleCarrierType,
} from '../../src/lib/carrierMap.ts';
import {
  SCRAP_AFTER_MS,
  UNBOUND_MAX_AGE_MS,
  coordinateNamesNeeded,
  directoryCoordinateNames,
  isMapCarrierRow,
  rowCoordinates,
  shapeDirectoryCarriers,
  shapeMapCarriers,
} from '../../src/lib/carrierMapView.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const NOW = new Date('2026-10-17T12:00:00Z');
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const ago = (ms) => new Date(NOW.getTime() - ms).toISOString();
const later = (ms) => new Date(NOW.getTime() + ms).toISOString();

const VIEWER = 'viewer-0000';
const MATE = 'mate-0000';
const SHY_MATE = 'shy-mate-0000';
const STRANGER = 'stranger-0000';

function row(overrides) {
  return {
    carrier_id: 3700000000,
    carrier_type: 'FleetCarrier',
    callsign: null,
    name: null,
    owner_id: null,
    squadron_id: null,
    system_name: 'Sol',
    system_address: null,
    body_name: null,
    x: null,
    y: null,
    z: null,
    location_at: ago(MIN),
    location_source: 'journal',
    jump_system_name: null,
    jump_system_address: null,
    jump_body_name: null,
    jump_departure_at: null,
    jump_requested_at: null,
    docking_access: 'all',
    allow_notorious: false,
    pending_decommission: false,
    decommission_at: null,
    services: [],
    station_services: null,
    updated_at: ago(MIN),
    // Поля, которых не должно быть в ответе карты ни при каких условиях.
    finance: { carrier_balance: 123456789 },
    space_usage: { cargo: 4000, free_space: 21000 },
    trade_orders: { steel: { sale: 4000, price: 5000 } },
    ...overrides,
  };
}

function context(overrides = {}) {
  return {
    viewerId: VIEWER,
    viewerSquadronIds: [7],
    squadronMateIds: new Set([MATE, SHY_MATE]),
    owners: new Map([
      [VIEWER, { cmdrName: 'Viewer Pilot', privacy: { location: false } }],
      [MATE, { cmdrName: 'Mate Pilot', privacy: null }],
      [SHY_MATE, { cmdrName: 'Shy Pilot', privacy: { location: false } }],
      [STRANGER, { cmdrName: 'Stranger Pilot', privacy: { deliveries: false } }],
    ]),
    squadrons: new Map([[7, { name: 'Alpha Wing', tag: 'ALP' }], [9, { name: 'Other Wing', tag: 'OTH' }]]),
    coordinates: new Map([
      ['hip 100', { x: 10, y: 1, z: -20 }],
      ['achenar', { x: 67.5, y: -119.5, z: 24.8 }],
    ]),
    now: NOW,
    ...overrides,
  };
}

const byId = (carriers) => new Map(carriers.map((carrier) => [carrier.id, carrier]));

test('на карту не попадают носители без системы, списанные и давно забытые «ничьи»', () => {
  assert.equal(isMapCarrierRow(row({ system_name: null }), NOW), false, 'без системы ставить некуда');
  assert.equal(isMapCarrierRow(row({ owner_id: STRANGER, pending_decommission: true, decommission_at: ago(SCRAP_AFTER_MS + DAY) }), NOW), false,
    'флаг списания старше восьми дней — носитель уже разобран');
  assert.equal(isMapCarrierRow(row({ owner_id: STRANGER, pending_decommission: true, decommission_at: ago(2 * DAY) }), NOW), true,
    'списывается, но ещё летает — остаётся (серым)');
  assert.equal(isMapCarrierRow(row({ location_at: ago(UNBOUND_MAX_AGE_MS + DAY) }), NOW), false, 'ничей и не виден месяц — убираем');
  assert.equal(isMapCarrierRow(row({ location_at: null }), NOW), false, 'ничей без времени стоянки — убираем');
  assert.equal(isMapCarrierRow(row({ location_at: ago(3 * DAY) }), NOW), true);
  assert.equal(isMapCarrierRow(row({ owner_id: STRANGER, location_at: ago(100 * DAY) }), NOW), true,
    'носитель владельца с сайта остаётся на последней известной стоянке');
  assert.equal(isMapCarrierRow(row({ squadron_id: 9, location_at: null }), NOW), true);
  assert.equal(isMapCarrierRow(row({ system_name: null, jump_system_name: 'Achenar', jump_departure_at: ago(30 * MIN), owner_id: STRANGER }), NOW), true,
    'после прыжка система известна по цели');
});

test('кто чей: свой, эскадрилья (по привязке и по участнику), чужой; имя владельца — по приватности', () => {
  const carriers = byId(shapeMapCarriers([
    row({ carrier_id: 1, owner_id: VIEWER, name: 'My Hauler', callsign: 'MYC-001' }),
    row({ carrier_id: 2, owner_id: MATE, name: 'Mate Depot' }),
    row({ carrier_id: 3, owner_id: SHY_MATE, name: 'Shy Depot' }),
    row({ carrier_id: 4, carrier_type: 'SquadronCarrier', squadron_id: 7, name: 'Wing Bank' }),
    row({ carrier_id: 5, carrier_type: 'SquadronCarrier', squadron_id: 9, name: 'Foreign Bank' }),
    row({ carrier_id: 6, owner_id: STRANGER, name: 'Stranger Ship' }),
    row({ carrier_id: 7, name: 'Nobody', location_at: ago(DAY) }),
  ], context()));

  const own = carriers.get('1');
  assert.equal(own.relation, 'own');
  assert.equal(own.owner, 'Viewer Pilot', 'себя пилот видит даже со скрытым местоположением');
  assert.equal(own.ownerHidden, false);

  assert.equal(carriers.get('2').relation, 'squadron', 'личный носитель участника эскадрильи');
  assert.equal(carriers.get('2').owner, 'Mate Pilot');

  const shy = carriers.get('3');
  assert.equal(shy.relation, 'other', 'участник скрыл местоположение — носитель не выдаётся за эскадренный');
  assert.equal(shy.owner, null);
  assert.equal(shy.ownerHidden, true);

  assert.equal(carriers.get('4').relation, 'squadron');
  assert.deepEqual(carriers.get('4').squadron, { id: 7, name: 'Alpha Wing', tag: 'ALP', member: true });
  assert.equal(carriers.get('5').relation, 'other');
  assert.deepEqual(carriers.get('5').squadron, { id: 9, name: 'Other Wing', tag: 'OTH', member: false });

  assert.equal(carriers.get('6').relation, 'other');
  assert.equal(carriers.get('6').owner, 'Stranger Pilot', 'закрытые поставки не прячут местоположение');
  assert.equal(carriers.get('7').owner, null);
  assert.equal(carriers.get('7').ownerHidden, false);

  const guest = byId(shapeMapCarriers([row({ carrier_id: 1, owner_id: VIEWER }), row({ carrier_id: 4, squadron_id: 7 })],
    context({ viewerId: null, viewerSquadronIds: [], squadronMateIds: new Set() })));
  assert.equal(guest.get('1').relation, 'other');
  assert.equal(guest.get('1').owner, null, 'гость не видит скрытого владельца');
  assert.equal(guest.get('1').ownerHidden, true);
  assert.equal(guest.get('4').relation, 'other');
  assert.equal(guest.get('4').squadron.member, false);
});

test('в ответе карты нет груза, финансов и ордеров', () => {
  const [carrier] = shapeMapCarriers([row({ carrier_id: 1, owner_id: VIEWER })], context());
  const json = JSON.stringify(carrier);
  for (const secret of ['123456789', 'finance', 'balance', 'cargo', 'free_space', 'trade', 'price']) {
    assert.ok(!json.includes(secret), `в отметке карты есть «${secret}»`);
  }
  assert.deepEqual(Object.keys(carrier).sort(), [
    'body', 'callsign', 'decommission', 'docking', 'estimated', 'history', 'id', 'jump', 'locationAt', 'name', 'notorious',
    'origin', 'owner', 'ownerHidden', 'position', 'previousPosition', 'previousSystem', 'relation', 'services',
    'squadron', 'system', 'type',
  ]);
  // Откуда запись: отметка из учёта сайта, а не из реестра EDDN.
  assert.equal(carrier.origin, 'site');
});

test('прыжок: заказан, в пути, после пяти минут — оценка в системе назначения', () => {
  const carriers = byId(shapeMapCarriers([
    row({ carrier_id: 1, owner_id: STRANGER, x: 0, y: 0, z: 0, jump_system_name: 'HIP 100', jump_departure_at: later(20 * MIN) }),
    row({ carrier_id: 2, owner_id: STRANGER, x: 0, y: 0, z: 0, jump_system_name: 'HIP 100', jump_departure_at: ago(2 * MIN) }),
    row({ carrier_id: 3, owner_id: STRANGER, system_name: 'Lave', x: 75, y: 48, z: -12, jump_system_name: 'Achenar', jump_body_name: 'Achenar 3', jump_departure_at: ago(30 * MIN) }),
  ], context()));

  const scheduled = carriers.get('1');
  assert.equal(scheduled.system, 'Sol');
  assert.deepEqual(scheduled.position, { x: 0, y: 0, z: 0 });
  assert.equal(scheduled.jump.state, 'scheduled');
  assert.deepEqual(scheduled.jump.position, { x: 10, y: 1, z: -20 }, 'цель прыжка — по каталогу координат');

  assert.equal(carriers.get('2').jump.state, 'jumping');
  assert.equal(carriers.get('2').system, 'Sol', 'в пути — ещё на старой отметке');

  const arrived = carriers.get('3');
  assert.equal(arrived.system, 'Achenar');
  assert.equal(arrived.body, 'Achenar 3');
  assert.equal(arrived.estimated, true);
  assert.equal(arrived.previousSystem, 'Lave');
  assert.equal(arrived.jump, null);
  assert.deepEqual(arrived.position, { x: 67.5, y: -119.5, z: 24.8 }, 'x/y/z строки относятся к старой системе и не используются');
});

test('координаты: из строки (и для соседей по системе), какие системы ещё искать', () => {
  const rows = [
    row({ carrier_id: 1, owner_id: STRANGER, system_name: 'Col 285 Sector AB-C d1', x: 1.5, y: 2.5, z: 3.5 }),
    row({ carrier_id: 2, owner_id: STRANGER, system_name: 'col 285  sector ab-c d1' }),
    row({ carrier_id: 3, owner_id: STRANGER, system_name: 'Lave' }),
    row({ carrier_id: 4, owner_id: STRANGER, system_name: 'LAVE', jump_system_name: 'HIP 100', jump_departure_at: later(10 * MIN) }),
    row({ carrier_id: 5, owner_id: STRANGER, system_name: 'Sol', x: 0, y: 0, z: 0, jump_system_name: 'Achenar', jump_departure_at: ago(10 * MIN) }),
  ];
  const known = rowCoordinates(rows, NOW);
  assert.deepEqual([...known.keys()], ['col 285 sector ab-c d1'], 'после прыжка x/y/z строки не относятся к новой системе');
  assert.deepEqual(coordinateNamesNeeded(rows, NOW, known), ['Lave', 'HIP 100', 'Achenar', 'Sol'],
    'плюс система, откуда носитель пришёл: по ней рисуется линия маршрута');

  const carriers = byId(shapeMapCarriers(rows, context({ coordinates: new Map([...known, ['lave', { x: 75, y: 48, z: -12 }]]) })));
  assert.deepEqual(carriers.get('2').position, { x: 1.5, y: 2.5, z: 3.5 }, 'сосед по системе берёт координаты из журнала другого носителя');
  assert.deepEqual(carriers.get('4').position, { x: 75, y: 48, z: -12 });
  assert.equal(carriers.get('4').jump.position, null, 'неизвестная цель прыжка — без пунктира, но с подписью');
  assert.equal(carriers.get('5').position, null);
});

test('службы: работающие службы экипажа, иначе — службы станции из Docked; стыковка подписана', () => {
  const [crew, docked, none] = shapeMapCarriers([
    row({ carrier_id: 1, owner_id: STRANGER, services: [
      { role: 'Captain', activated: true, enabled: true },
      { role: 'Refuel', activated: true, enabled: true },
      { role: 'Commodities', activated: true, enabled: true },
      { role: 'Shipyard', activated: true, enabled: false },
      { role: 'Repair', activated: false, enabled: false },
    ] }),
    row({ carrier_id: 2, owner_id: STRANGER, docking_access: 'squadronfriends', allow_notorious: true,
      station_services: ['dock', 'autodock', 'commodities', 'contacts', 'refuel', 'repair', 'carriermanagement', 'flightcontroller'] }),
    row({ carrier_id: 3, owner_id: STRANGER, docking_access: null }),
  ], context());
  assert.deepEqual(crew.services, ['Рынок товаров', 'Заправка']);
  assert.equal(crew.docking, 'все пилоты');
  assert.deepEqual(docked.services, ['Рынок товаров', 'Заправка', 'Ремонт']);
  assert.equal(docked.docking, 'эскадрилья и друзья');
  assert.equal(docked.notorious, true);
  assert.deepEqual(none.services, []);
  assert.equal(none.docking, null);
});

function carrier(overrides) {
  return {
    id: '1', type: 'FleetCarrier', callsign: null, name: null, relation: 'other', owner: null, ownerHidden: false, squadron: null,
    system: 'Sol', body: null, position: { x: 0, y: 0, z: 0 }, locationAt: ago(MIN), estimated: false, previousSystem: null, jump: null,
    docking: null, notorious: null, services: [], decommission: false,
    ...overrides,
  };
}

test('группы по системам: регистр не важен, свои первыми, Javelin раньше Drake, прыжки без повторов', () => {
  const list = [
    carrier({ id: '1', name: 'Zeta', system: 'HIP 100', position: null }),
    carrier({ id: '2', name: 'Alpha', system: 'hip  100', position: { x: 10, y: 1, z: -20 }, decommission: true }),
    carrier({ id: '3', name: 'Mine', system: 'HIP 100', relation: 'own', position: null,
      jump: { system: 'Achenar', departureAt: later(5 * MIN), state: 'scheduled', position: { x: 67.5, y: -119.5, z: 24.8 } } }),
    carrier({ id: '4', name: 'Bank', type: 'SquadronCarrier', relation: 'squadron', system: 'Lave' }),
    carrier({ id: '5', name: 'Wing', relation: 'squadron', system: 'Lave' }),
    carrier({ id: '6', name: 'Follower', system: 'HIP 100', position: null, jump: { system: 'ACHENAR', departureAt: null, state: 'scheduled', position: null } }),
    carrier({ id: '7', name: 'Solo', system: 'Sol' }),
    carrier({ id: '8', name: 'Circle', system: 'Sol', jump: { system: 'sol', departureAt: null, state: 'scheduled', position: null } }),
  ];
  const groups = groupCarriersBySystem(list);
  assert.deepEqual(groups.map((group) => group.key), ['hip 100', 'lave', 'sol'], 'система со своим носителем первой, дальше эскадрилья');

  const [hip, lave, sol] = groups;
  assert.equal(hip.carriers.length, 4);
  assert.deepEqual(hip.carriers.map((item) => item.id), ['3', '6', '1', '2'], 'свой, затем по имени, списываемый в конце');
  assert.equal(hip.lead.id, '3');
  assert.deepEqual(hip.position, { x: 10, y: 1, z: -20 }, 'координаты группы — от любого носителя системы');
  assert.deepEqual(hip.relations, { own: 1, squadron: 0, other: 3 });
  assert.equal(hip.jumps.length, 1, 'два носителя в одну систему — один пунктир');
  assert.equal(hip.jumps[0].system, 'Achenar');

  assert.deepEqual(lave.carriers.map((item) => item.id), ['4', '5'], 'Javelin раньше Drake');
  assert.equal(sol.jumps.length, 0, 'прыжок в ту же систему не рисуется');
  assert.equal(carrierListLabel(hip), 'Mine, Follower и ещё 2');
  assert.equal(carrierListLabel(sol, 5), 'Circle, Solo');
  assert.equal(carrierSystemKey('  HIP   100 '), 'hip 100');
});

test('фильтр и счётчики слоя', () => {
  const list = [
    carrier({ id: '1', relation: 'own' }),
    carrier({ id: '2', relation: 'squadron', type: 'SquadronCarrier', system: 'Lave', position: null }),
    carrier({ id: '3', relation: 'other', system: 'Lave' }),
    carrier({ id: '4', relation: 'other', system: 'Achenar' }),
  ];
  const counts = countMapCarriers(list);
  assert.deepEqual(counts, {
    total: 4, placed: 3, systems: 3,
    relations: { own: 1, squadron: 1, other: 2 },
    types: { FleetCarrier: 3, SquadronCarrier: 1 },
    sources: { site: 4, eddn: 0 },
  });

  assert.equal(isDefaultCarrierFilter(DEFAULT_CARRIER_FILTER), true);
  const noOthers = toggleCarrierRelation(DEFAULT_CARRIER_FILTER, 'other');
  assert.equal(isDefaultCarrierFilter(noOthers), false);
  assert.equal(DEFAULT_CARRIER_FILTER.relations.other, true, 'исходный фильтр не меняется');
  assert.deepEqual(filterMapCarriers(list, noOthers).map((item) => item.id), ['1', '2']);
  const onlyDrakes = toggleCarrierType(DEFAULT_CARRIER_FILTER, 'SquadronCarrier');
  assert.deepEqual(filterMapCarriers(list, onlyDrakes).map((item) => item.id), ['1', '3', '4']);
  assert.deepEqual(filterMapCarriers(list, toggleCarrierRelation(noOthers, 'other')).map((item) => item.id), ['1', '2', '3', '4']);
});

test('источник отметки: сайт или реестр EDDN — отдельный переключатель слоя', () => {
  const list = [
    carrier({ id: '1', system: 'Sol' }),
    carrier({ id: '2', system: 'Lave', origin: 'eddn', relation: 'other', position: { x: 75, y: 48, z: -12 } }),
  ];
  assert.equal(carrierSourceOf(list[0]), 'site', 'запись без origin — из учёта сайта');
  assert.equal(carrierSourceOf(list[1]), 'eddn');

  const counts = countMapCarriers(list);
  assert.deepEqual(counts.sources, { site: 1, eddn: 1 });

  const noRegistry = toggleCarrierSource(DEFAULT_CARRIER_FILTER, 'eddn');
  assert.deepEqual(filterMapCarriers(list, noRegistry).map((item) => item.id), ['1'], 'реестр EDDN скрыт');
  assert.equal(isDefaultCarrierFilter(noRegistry), false);
  assert.equal(DEFAULT_CARRIER_FILTER.sources.eddn, true, 'исходный фильтр не меняется');

  const onlyRegistry = toggleCarrierSource(DEFAULT_CARRIER_FILTER, 'site');
  assert.deepEqual(filterMapCarriers(list, onlyRegistry).map((item) => item.id), ['2']);
  assert.equal(isDefaultCarrierFilter(toggleCarrierSource(onlyRegistry, 'site')), true, 'оба источника снова включены');
});

test('линии истории: переключатель фильтра не трогает носителей', () => {
  assert.equal(DEFAULT_CARRIER_FILTER.history, true, 'история включена по умолчанию');
  assert.equal(carrierHistoryShown(DEFAULT_CARRIER_FILTER), true);
  assert.equal(carrierHistoryShown({}), true, 'старый фильтр без поля — история включена');
  assert.equal(carrierHistoryShown(null), true);

  const off = toggleCarrierHistory(DEFAULT_CARRIER_FILTER);
  assert.equal(off.history, false);
  assert.equal(carrierHistoryShown(off), false);
  assert.equal(DEFAULT_CARRIER_FILTER.history, true, 'исходный фильтр не меняется');
  assert.equal(toggleCarrierHistory(off).history, true, 'переключатель возвращает обратно');

  const list = [carrier({ id: '1' }), carrier({ id: '2', origin: 'eddn' })];
  assert.deepEqual(filterMapCarriers(list, off).map((item) => item.id), ['1', '2'],
    'выключенная история не прячет ни одного носителя');
  assert.equal(countMapCarriers(list).total, 2);
  assert.equal(isDefaultCarrierFilter(off), true,
    'счётчик «видно/всего» меняется только от отбора носителей, а не от линий');
});

test('реестр EDDN: отметка без владельца и прыжка, но со следом последнего прыжка', () => {
  const coordinates = new Map([
    ['lave', { x: 75, y: 48, z: -12 }],
    ['hip 100', { x: 10, y: 1, z: -20 }],
  ]);
  const rows = [
    {
      carrier_id: 3700000901, callsign: 'K7Q-BQL', name: null, carrier_type: 'FleetCarrier',
      system_name: 'HIP 100', body_name: 'HIP 100 4', x: 10, y: 1, z: -20, services: ['commodities', 'refuel', 'dock'],
      updated_at: ago(3 * MIN), last_seen_at: ago(3 * MIN),
      previous_system_name: 'Lave', previous_x: 75, previous_y: 48, previous_z: -12,
    },
    {
      carrier_id: 3700000902, callsign: 'K7Q-BQ2', name: 'Уточнено пилотом', carrier_type: 'SquadronCarrier',
      system_name: 'Achenar', x: null, y: null, z: null, services: null,
      updated_at: ago(MIN), last_seen_at: ago(MIN),
      // Предыдущей системы нет — так выглядят строки до миграции истории.
    },
    {
      carrier_id: 3700000901, callsign: 'K7Q-BQL', system_name: 'HIP 100', x: 10, y: 1, z: -20,
      updated_at: ago(MIN), last_seen_at: ago(MIN), previous_system_name: null,
    },
    { carrier_id: 3700000903, system_name: null, updated_at: ago(MIN) },
    { carrier_id: 3700000904, system_name: 'Sol', updated_at: ago(200 * DAY), last_seen_at: ago(200 * DAY) },
  ];
  const carriers = shapeDirectoryCarriers(rows, {
    coordinates,
    knownIds: new Set(['3700000902']),
    seenAfter: NOW.getTime() - 90 * DAY,
  });
  assert.deepEqual(carriers.map((item) => item.id), ['3700000901'], 'повтор, запись сайта, без системы и слишком старая отсеяны');

  const [carrier] = carriers;
  assert.equal(carrier.origin, 'eddn');
  assert.equal(carrier.relation, 'other', 'чужой: владельца у реестра нет');
  assert.equal(carrier.owner, null);
  assert.equal(carrier.squadron, null);
  assert.equal(carrier.jump, null, 'EDDN не приносит заказанный прыжок');
  assert.equal(carrier.name, null, 'имя из реестра не выдумываем');
  assert.deepEqual(carrier.services, ['Рынок товаров', 'Заправка'], 'службы — как у носителей сайта');
  assert.deepEqual(carrier.position, { x: 10, y: 1, z: -20 });
  assert.equal(carrier.locationAt, ago(3 * MIN));

  assert.equal(carrier.previousSystem, 'Lave');
  assert.deepEqual(carrier.previousPosition, { x: 75, y: 48, z: -12 }, 'откуда пришёл — для линии маршрута');

  const [group] = groupCarriersBySystem(carriers);
  assert.equal(group.routes.length, 1);
  assert.equal(group.routes[0].system, 'Lave');
  assert.equal(group.routes[0].key, 'lave>hip 100');
  assert.deepEqual(group.routes[0].position, { x: 75, y: 48, z: -12 });
  assert.equal(group.routes[0].target, 'HIP 100', 'куда пришёл — система самой отметки');
  assert.deepEqual(group.routes[0].targetPosition, { x: 10, y: 1, z: -20 });
  assert.equal(group.routes[0].jumpedAt, null, 'даты у следа реестра нет');
  assert.equal(group.routes[0].source, 'eddn');
  assert.equal(group.jumps.length, 0, 'запланированных прыжков у реестра нет');

  assert.deepEqual(directoryCoordinateNames(rows, new Map([['lave', { x: 75, y: 48, z: -12 }]])), ['Achenar', 'Sol'],
    'искать надо и систему стоянки, и систему, откуда носитель пришёл');
});

test('маршрут в группе: по одной линии на пару систем, без петли и повторов', () => {
  const list = [
    carrier({ id: '1', system: 'HIP 100', position: { x: 10, y: 1, z: -20 }, previousSystem: 'Lave', previousPosition: { x: 75, y: 48, z: -12 } }),
    carrier({ id: '2', system: 'hip 100', position: { x: 10, y: 1, z: -20 }, previousSystem: 'lave', previousPosition: { x: 75, y: 48, z: -12 } }),
    carrier({ id: '3', system: 'HIP 100', previousSystem: 'Achenar', previousPosition: null }),
    carrier({ id: '4', system: 'HIP 100', position: { x: 10, y: 1, z: -20 }, previousSystem: 'HIP 100', previousPosition: { x: 10, y: 1, z: -20 } }),
  ];
  const [group] = groupCarriersBySystem(list);
  assert.deepEqual(group.routes.map((route) => route.key), ['lave>hip 100'],
    'без координат, без повторов и без петли в саму себя');
});

/** Прыжок для истории: позиции есть только там, где карта знает координаты. */
function jump(from, to, minutesAgo, overrides = {}) {
  return {
    from,
    to,
    jumpedAt: ago(minutesAgo * MIN),
    source: 'site',
    fromPosition: { x: 1, y: 2, z: 3 },
    toPosition: { x: 4, y: 5, z: 6 },
    ...overrides,
  };
}

test('история прыжков в группе: все прыжки недели, свежие первыми', () => {
  const history = [
    jump('Sol', 'Lave', 10),
    jump('Lave', 'HIP 100', 30),
    jump('HIP 100', 'Achenar', 90),
    jump('Achenar', 'Sol', 300),
    jump('Sol', 'Lave', 900), // повтор первой пары — вторая линия не нужна
    jump('Lave', 'Achenar', 24 * 60), // сутки назад — ещё в неделе
  ];
  const [group] = groupCarriersBySystem([
    carrier({ id: '1', system: 'Sol', position: { x: 0, y: 0, z: 0 }, history }),
  ]);

  assert.deepEqual(group.routes.map((route) => route.key), [
    'sol>lave', 'lave>hip 100', 'hip 100>achenar', 'achenar>sol', 'lave>achenar',
  ], 'все прыжки недели по порядку, без повтора «Sol → Lave»');
  assert.deepEqual(group.routes.map((route) => route.age), [0, 1, 2, 3, 4],
    'age — порядковый номер прыжка: по нему гаснут старые линии');
  assert.equal(group.routes[0].jumpedAt, ago(10 * MIN));
  assert.deepEqual(group.routes[0].targetPosition, { x: 4, y: 5, z: 6 });
  assert.equal(group.routes[0].source, 'site');

  // Неделя не режет по количеству: десять разных прыжков — десять линий.
  const week = [
    jump('Sol', 'Lave', 30), jump('Lave', 'HIP 100', 60), jump('HIP 100', 'Achenar', 90),
    jump('Achenar', 'Sol', 120), jump('Sol', 'HIP 100', 150), jump('HIP 100', 'Sol', 180),
    jump('Lave', 'Achenar', 210), jump('Achenar', 'HIP 100', 240), jump('HIP 100', 'Lave', 270),
    jump('Sol', 'Achenar', 300),
  ];
  const [full] = groupCarriersBySystem([carrier({ id: '1', system: 'Sol', history: week })]);
  assert.equal(full.routes.length, 10, 'за неделю показываем все отрезки, без обрезки по числу');
  assert.deepEqual(full.routes.map((route) => route.age), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  // История важнее старого следа реестра: одна и та же линия не рисуется дважды.
  const [withBoth] = groupCarriersBySystem([
    carrier({ id: '1', system: 'Sol', position: { x: 0, y: 0, z: 0 }, previousSystem: 'Lave',
      previousPosition: { x: 1, y: 1, z: 1 }, history: [jump('Lave', 'Sol', 20)] }),
  ]);
  assert.deepEqual(withBoth.routes.map((route) => route.key), ['lave>sol']);
  assert.equal(withBoth.routes[0].age, 0, 'строка из истории, а не след реестра');

  // Без координат линии нет; петля не рисуется.
  const [partial] = groupCarriersBySystem([
    carrier({ id: '1', system: 'Sol', position: { x: 0, y: 0, z: 0 }, history: [
      jump('Nowhere', 'Sol', 5, { fromPosition: null }),
      jump('Sol', 'Sol', 9),
      jump('Lave', 'Sol', 12),
    ] }),
  ]);
  assert.deepEqual(partial.routes.map((route) => route.key), ['lave>sol']);

  // Одинаковые листья разных носителей дают одну линию.
  const [shared] = groupCarriersBySystem([
    carrier({ id: '1', system: 'Sol', history: [jump('Lave', 'Sol', 5)] }),
    carrier({ id: '2', system: 'Sol', history: [jump('lave', 'sol', 7)] }),
  ]);
  assert.deepEqual(shared.routes.map((route) => route.key), ['lave>sol']);
});

test('история приходит в отметку из контекста карты и не течёт в чужие носители', () => {
  const history = new Map([
    ['3700000000', [
      { from: 'Lave', to: 'Sol', jumpedAt: ago(20 * MIN), source: 'eddn', fromPosition: { x: 75, y: 48, z: -12 }, toPosition: null },
    ]],
  ]);
  const [known, other] = shapeMapCarriers([
    row({ carrier_id: 3700000000, owner_id: STRANGER }),
    row({ carrier_id: 3700000001, owner_id: STRANGER }),
  ], context({ history }));

  assert.equal(known.history.length, 1);
  assert.equal(known.history[0].from, 'Lave');
  assert.equal(known.history[0].source, 'eddn');
  assert.deepEqual(known.history[0].fromPosition, { x: 75, y: 48, z: -12 });
  assert.deepEqual(other.history, [], 'у носителя без записи — пустая история, а не чужая');

  // Контекст без истории (старые вызовы) не ломает отметку.
  const [plain] = shapeMapCarriers([row({ carrier_id: 3700000000, owner_id: STRANGER })], context());
  assert.deepEqual(plain.history, []);
});

test('значок группы: класс ведущего носителя, тон, бледность и счётчик', () => {
  const now = NOW.getTime();
  const [own] = groupCarriersBySystem([carrier({ id: '1', relation: 'own' }), carrier({ id: '2' }), carrier({ id: '3' })]);
  assert.deepEqual(carrierIconVariant(own, now), { glyph: 'drake', tone: 'own', count: 3, fade: 'fresh' });

  const [javelin] = groupCarriersBySystem([carrier({ id: '1', type: 'SquadronCarrier', relation: 'squadron', estimated: true, locationAt: ago(30 * DAY) })]);
  assert.deepEqual(carrierIconVariant(javelin, now), { glyph: 'javelin', tone: 'squadron', count: 1, fade: 'estimated' });

  const [scrapping] = groupCarriersBySystem([carrier({ id: '1', decommission: true })]);
  assert.equal(carrierIconVariant(scrapping, now).tone, 'decommission');

  const [old] = groupCarriersBySystem([carrier({ id: '1', locationAt: ago(20 * DAY) }), carrier({ id: '2', locationAt: null })]);
  assert.equal(carrierIconVariant(old, now).fade, 'stale', 'все стоянки старше двух недель — значок бледный');
  const [mixed] = groupCarriersBySystem([carrier({ id: '1', locationAt: ago(20 * DAY) }), carrier({ id: '2', locationAt: ago(DAY) })]);
  assert.equal(carrierIconVariant(mixed, now).fade, 'fresh');
});

test('подписи: склонение, бейдж, относительное время, прыжок и стоянка', () => {
  assert.deepEqual([1, 2, 4, 5, 11, 12, 21, 22, 25, 101, 111].map(carrierCountLabel), [
    '1 носитель', '2 носителя', '4 носителя', '5 носителей', '11 носителей', '12 носителей',
    '21 носитель', '22 носителя', '25 носителей', '101 носитель', '111 носителей',
  ]);
  assert.deepEqual([1, 9, 10, 42].map(carrierBadgeText), ['1', '9', '9+', '9+']);

  const now = NOW.getTime();
  assert.equal(carrierRelativeTime(ago(5 * MIN), now), '5 мин назад');
  assert.equal(carrierRelativeTime(later(12 * MIN), now), 'через 12 мин');
  assert.equal(carrierRelativeTime(ago(3 * 60 * MIN), now), '3 ч назад');
  assert.equal(carrierRelativeTime(ago(5 * DAY), now), '5 дн назад');
  assert.equal(carrierRelativeTime(null, now), '');

  assert.equal(carrierJumpText({ jump: null }, now), null);
  assert.equal(carrierJumpText({ jump: { system: 'HIP 100', departureAt: later(12 * MIN), state: 'scheduled', position: null } }, now),
    'прыжок → HIP 100, вылет через 12 мин');
  assert.equal(carrierJumpText({ jump: { system: 'HIP 100', departureAt: null, state: 'scheduled', position: null } }, now), 'прыжок → HIP 100');
  assert.equal(carrierJumpText({ jump: { system: 'HIP 100', departureAt: ago(MIN), state: 'jumping', position: null } }, now), 'в прыжке → HIP 100');

  assert.equal(carrierLocationText({ estimated: false, previousSystem: null, locationAt: ago(2 * 60 * MIN) }, now), 'данные 2 ч назад');
  assert.equal(carrierLocationText({ estimated: true, previousSystem: 'Lave', locationAt: ago(DAY) }, now),
    '≈ прибыл после прыжка из Lave, подтверждения ещё нет');
  assert.equal(carrierLocationText({ estimated: false, previousSystem: null, locationAt: null }, now), 'время стоянки неизвестно');
});

test('слой подключён к карте: и в компактной /map, и в Atlas; значок постоянного размера поверх слоёв', () => {
  const read = (path) => readFileSync(join(ROOT, path), 'utf8');
  const map = read('src/components/GalaxyMap/GalaxyMap.tsx');
  const scene = read('src/components/GalaxyMap/GalaxyScene.tsx');
  const markers = read('src/components/GalaxyMap/CarrierMarkers.tsx');
  const layer = read('src/hooks/useCarrierLayer.ts');

  assert.ok(layer.includes('/api/map/carriers'), 'слой авианосцев не опрашивает маршрут');
  assert.ok(map.includes('useCarrierLayer('), 'карта не поднимает слой авианосцев');
  assert.ok(map.includes('<CarrierLayerControls'), 'в панели слоёв нет фильтра авианосцев');
  assert.ok(map.includes('<CarrierSystemCard'), 'нет карточки системы с носителями');
  assert.ok(map.includes('showCarriers={showCarriers}'), 'слой не передаётся в сцену');
  assert.ok(!/showCarriers=\{!compactMap/.test(map), 'слой авианосцев не должен прятаться в компактной карте /map');
  // С 10.11.2026 фильтр слоя переехал во вкладку «Авианосцы»: карта показывает
  // его только когда слой ведёт сама (компактная «Карта кольца»).
  const controlsBlock = map.indexOf('{!carrierLayerProp && (');
  assert.ok(controlsBlock > 0 && controlsBlock < map.indexOf('<CarrierLayerControls'),
    'панель слоёв карты не должна дублировать фильтр в Atlas');
  const atlas = read('src/app/atlas/page.tsx');
  const panel = read('src/components/Atlas/AtlasCarriersPanel.tsx');
  assert.ok(atlas.includes('useCarrierLayer('), 'Atlas не поднимает состояние слоя авианосцев');
  assert.ok(atlas.includes('carriers={carrierLayer}'), 'слой не доходит до 3D-карты');
  assert.ok(atlas.includes('<AtlasCarriersPanel carrierLayer={carrierLayer}'), 'вкладка не получает слой');
  assert.ok(panel.includes('<CarrierLayerControls'), 'во вкладке «Авианосцы» нет фильтра слоя');
  assert.ok(panel.includes('atlas-select-carrier-group'), 'строка списка не ведёт камеру карты');
  assert.ok(map.includes("'atlas-select-carrier-group'"), 'карта не слушает выбор системы из вкладки');

  assert.ok(scene.includes('<CarrierMarkers'), 'сцена не рисует авианосцы');
  // История недели: фильтр гасит линии, но не носителей; выключатель доходит
  // от панели слоя через карту и сцену до самого слоя линий.
  assert.ok(map.includes('carrierHistoryShown(carrierFilter)'), 'карта не читает переключатель истории из фильтра');
  assert.ok(map.includes('showCarrierHistory={carrierHistory}'), 'карта не передаёт переключатель истории в сцену');
  assert.ok(scene.includes('showCarrierHistory'), 'сцена не принимает переключатель истории');
  assert.ok(scene.includes('showHistory={showCarrierHistory}'), 'сцена не передаёт историю в слой авианосцев');
  assert.ok(markers.includes('if (!showHistory) return result'), 'слой линий не умеет выключаться');

  assert.ok(markers.includes('sizeAttenuation: false'), 'значок должен держать экранный размер');
  assert.ok(markers.includes('depthTest: false'), 'значок должен быть поверх туманностей');

  assert.ok(read('src/app/map/page.tsx').includes('GalaxyMap'), '/map должна показывать карту');
  assert.ok(read('src/app/atlas/page.tsx').includes('<GalaxyMap'), 'Atlas должен показывать карту');
  assert.ok(read('src/app/squadrons/[id]/page.tsx').includes('requested === "carrier"'), 'ссылка ?tab=carrier на эскадрилью не открывает вкладку');
});
