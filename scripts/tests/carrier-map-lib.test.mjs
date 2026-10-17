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
  carrierIconVariant,
  carrierJumpText,
  carrierListLabel,
  carrierLocationText,
  carrierRelativeTime,
  carrierSystemKey,
  countMapCarriers,
  filterMapCarriers,
  groupCarriersBySystem,
  isDefaultCarrierFilter,
  toggleCarrierRelation,
  toggleCarrierType,
} from '../../src/lib/carrierMap.ts';
import {
  SCRAP_AFTER_MS,
  UNBOUND_MAX_AGE_MS,
  coordinateNamesNeeded,
  isMapCarrierRow,
  rowCoordinates,
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
    'body', 'callsign', 'decommission', 'docking', 'estimated', 'id', 'jump', 'locationAt', 'name', 'notorious',
    'owner', 'ownerHidden', 'position', 'previousSystem', 'relation', 'services', 'squadron', 'system', 'type',
  ]);
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
  assert.deepEqual(coordinateNamesNeeded(rows, NOW, known), ['Lave', 'HIP 100', 'Achenar']);

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

  assert.ok(map.includes('/api/map/carriers'), 'карта не опрашивает слой авианосцев');
  assert.ok(map.includes('<CarrierLayerControls'), 'в панели слоёв нет фильтра авианосцев');
  assert.ok(map.includes('<CarrierSystemCard'), 'нет карточки системы с носителями');
  assert.ok(map.includes('showCarriers={showCarriers}'), 'слой не передаётся в сцену');
  assert.ok(!/showCarriers=\{!compactMap/.test(map), 'слой авианосцев не должен прятаться в компактной карте /map');
  const controls = map.indexOf('<CarrierLayerControls');
  const compactBlock = map.indexOf('{!compactMap && (', map.indexOf('Все системы'));
  assert.ok(controls > 0 && controls < compactBlock, 'фильтр авианосцев должен стоять вне блока, скрытого на /map');

  assert.ok(scene.includes('<CarrierMarkers'), 'сцена не рисует авианосцы');
  assert.ok(markers.includes('sizeAttenuation: false'), 'значок должен держать экранный размер');
  assert.ok(markers.includes('depthTest: false'), 'значок должен быть поверх туманностей');

  assert.ok(read('src/app/map/page.tsx').includes('GalaxyMap'), '/map должна показывать карту');
  assert.ok(read('src/app/atlas/page.tsx').includes('<GalaxyMap'), 'Atlas должен показывать карту');
  assert.ok(read('src/app/squadrons/[id]/page.tsx').includes('requested === "carrier"'), 'ссылка ?tab=carrier на эскадрилью не открывает вкладку');
});
