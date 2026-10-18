/**
 * Эскадренные авианосцы (Javelin) и эскадрильи сайта: регрессия жалобы «все
 * авианосцы эскадрилий на карте отображаются как авианосцы эскадрильи
 * [DNHG] DRUNK HEDGEHOG».
 *
 * Причина была в том, что стыковка к Javelin считалась доказательством
 * членства в его эскадрилье: пилот DNHG, пристыковавшийся к чужому носителю,
 * навсегда приписывал его DNHG. Здесь на настоящем PostgreSQL (PGlite):
 *
 *   1. старая функция создаёт такие привязки, как на рабочей базе;
 *   2. миграция 20261018000000 их чинит (тег-позывной Javelin подтверждает
 *      только настоящие), не трогает ручные и старые табличные;
 *   3. новые правила squadron_claim — на событиях журнала через нормализатор
 *      сервера: стыковка не привязывает, CarrierLocation участника — да; тег,
 *      свежесть, отказ офицеров, перехват непроверенной привязки;
 *   4. повторный прогон миграции ничего не ломает;
 *   5. карта: зритель из DNHG видит чужие Javelin чужими.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { normalizeCarrierEvents, SQUADRON_PROOF_EVENTS } from '../../src/lib/fleetCarriers.ts';
import { carrierSquadronTag } from '../../src/lib/carrierTags.ts';
import { isMapCarrierRow, shapeMapCarriers } from '../../src/lib/carrierMapView.ts';

const MIGRATIONS = new URL('../../supabase/migrations/', import.meta.url);
const migration = (name) => readFileSync(new URL(name, MIGRATIONS), 'utf8');
const FIX = '20261018000000_fleet_carrier_squadron_claims.sql';

const DNHG_PILOT = '00000000-0000-4000-8000-0000000000d1';
const ENEX_PILOT = '00000000-0000-4000-8000-0000000000d2';
// В эскадрилье сайта «Сообщество» (тег не игровой), в игре — в чужой эскадрилье.
const MIXED_PILOT = '00000000-0000-4000-8000-0000000000d3';
const LONER = '00000000-0000-4000-8000-0000000000d4';

const DNHG = 1;
const ENEX = 2;
const COMMUNITY = 3;

const J = {
  dnhg: '3713000001',
  enex: '3713000002',
  anon: '3713000003',
  manual: '3713000004',
  legacy: '3713000005',
  named: '3713000006',
  xray: '3713000010',
  zulu: '3713000011',
  yank: '3713000012',
  old: '3713000013',
  stale: '3713000014',
  shared: '3713000015',
};
const DRAKE = '3700000777';

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
INSERT INTO auth.users VALUES ('${DNHG_PILOT}'), ('${ENEX_PILOT}'), ('${MIXED_PILOT}'), ('${LONER}');
CREATE TABLE public.profiles(id uuid PRIMARY KEY);
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text);
INSERT INTO public.squadrons(name, tag) VALUES
  ('DRUNK HEDGEHOG', 'DNHG'), ('ENDURANCE EXPLORATION', '[enex]'), ('Сообщество', 'COMMUNITY');
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid);
INSERT INTO public.squadron_members VALUES (${DNHG}, '${DNHG_PILOT}'), (${ENEX}, '${ENEX_PILOT}'), (${COMMUNITY}, '${MIXED_PILOT}');
CREATE TABLE colonisation_market_systems(system_name text,x float8,y float8,z float8,has_market boolean,last_checked_at timestamptz);
CREATE TABLE market_search_jobs(id integer);
CREATE TABLE market_search_cache(market_id bigint);
CREATE TABLE market_prices(station_name text,system_name text,commodity_name text,buy_price integer,sell_price integer,stock integer,demand integer,reported_at timestamptz,source text);
`);
await db.exec(migration('20261014000000_station_commerce.sql'));
await db.exec(migration('20261017000000_fleet_carriers.sql'));

const minutesAgo = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();

async function apply(ops, user) {
  const { rows } = await db.query('SELECT apply_fleet_carrier_batch($1::uuid, $2, $3::jsonb) AS r', [user, 'helper', JSON.stringify(ops)]);
  return rows[0].r;
}
/** Журнальные события → нормализатор сервера → функция БД (как POST /api/carriers/sync). */
async function upload(events, user) {
  const { ops } = normalizeCarrierEvents(events, { userId: user, now: new Date() });
  return apply(ops, user);
}
async function carrier(id) {
  return (await db.query('SELECT * FROM fleet_carriers WHERE carrier_id = $1', [id])).rows[0];
}
async function binding(id) {
  const row = await carrier(id);
  return {
    squadron: row.squadron_id == null ? null : Number(row.squadron_id),
    source: row.squadron_source,
    rejected: (row.squadron_rejected ?? []).map(Number),
  };
}

const JAVELIN_SERVICES = ['dock', 'autodock', 'commodities', 'contacts', 'squadronBank', 'refuel', 'flightcontroller'];
const docked = (carrierId, callsign, minutes, system = 'Col 285 Sector FZ-K b23-5') => ({
  timestamp: minutesAgo(minutes), event: 'Docked', StationName: callsign, StationType: 'FleetCarrier', MarketID: Number(carrierId),
  StarSystem: system, SystemAddress: 11664997164513, StationServices: JAVELIN_SERVICES,
});
/** Запуск игры у члена эскадрильи: SquadronStartup и сразу CarrierLocation носителя эскадрильи. */
const login = (carrierId, minutes, system = 'LHS 5333') => [
  { timestamp: minutesAgo(minutes), event: 'SquadronStartup', SquadronID: 75645, SquadronName: 'ANY', CurrentRank: 2 },
  { timestamp: minutesAgo(minutes), event: 'CarrierLocation', CarrierType: 'SquadronCarrier', CarrierID: Number(carrierId),
    StarSystem: system, SystemAddress: 1183364158186, BodyID: 9 },
];

// ── 1. Как было: привязки «по стыковке» старой функцией ─────────────────────
/** То, что старый нормализатор делал из Docked у Javelin: слабое имя и заявка без proof. */
const oldDocking = (carrierId, stationName, minutes) => {
  const at = minutesAgo(minutes);
  return [
    { op: 'identity', carrier_id: carrierId, at, carrier_type: 'SquadronCarrier', ...(stationName ? { name: stationName, weak_name: true } : {}),
      station_services: JAVELIN_SERVICES.map((service) => service.toLowerCase()) },
    { op: 'location', carrier_id: carrierId, at, system_name: 'Col 285 Sector FZ-K b23-5', source_event: 'Docked' },
    { op: 'squadron_claim', carrier_id: carrierId, at },
  ];
};

await apply([
  ...oldDocking(J.dnhg, 'DNHG', 600),
  ...oldDocking(J.enex, 'ENEX', 590),
  ...oldDocking(J.anon, null, 580),
  ...oldDocking(J.manual, 'KILO', 570),
], DNHG_PILOT);
await db.exec(`
UPDATE fleet_carriers SET squadron_source = 'manual' WHERE carrier_id = ${J.manual};
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, name_at, squadron_id, squadron_source, squadron_at, system_name, location_at)
  VALUES (${J.legacy}, 'SquadronCarrier', NULL, 'Old Bank', now() - interval '90 days', ${DNHG}, 'legacy', now() - interval '90 days', 'Sol', now());
INSERT INTO fleet_carriers(carrier_id, carrier_type, name, system_name, location_at) VALUES (${DRAKE}, 'FleetCarrier', 'HOME', 'Sol', now());
`);
// Настоящее имя из CarrierStats (name_at есть) — даже из четырёх букв — не тег.
await apply([
  { op: 'identity', carrier_id: J.named, at: minutesAgo(560), carrier_type: 'SquadronCarrier', callsign: 'WXYZ' },
  { op: 'stats', carrier_id: J.named, at: minutesAgo(560), carrier_type: 'SquadronCarrier', name: 'WOLF', callsign: 'WXYZ' },
], LONER);

// Весь асинхронный код верхнего уровня — до первого test(): тесты начинают
// выполняться сразу после регистрации. Состояние «до миграции» снимается здесь.
const beforeFix = {
  bindings: await Promise.all([J.dnhg, J.enex, J.anon].map(binding)),
  enexName: (await carrier(J.enex)).name,
};

// ── 2. Миграция ─────────────────────────────────────────────────────────────
await db.exec(migration(FIX));

test.after(async () => { await db.close(); });

test('before the fix: docking bound every visited Javelin to the squadron of the pilot (the reported bug)', () => {
  for (const state of beforeFix.bindings) {
    assert.deepEqual(state, { squadron: DNHG, source: 'journal', rejected: [] });
  }
  assert.equal(beforeFix.enexName, 'ENEX', 'тег жил в слабом имени');
});

test('migration repairs the bindings: tag-confirmed stay, docking ones go, manual and legacy are kept', async () => {
  const dnhg = await carrier(J.dnhg);
  assert.deepEqual([dnhg.callsign, dnhg.name], ['DNHG', null], 'имя стоянки из 4 символов переехало в позывной');
  assert.deepEqual(await binding(J.dnhg), { squadron: DNHG, source: 'member', rejected: [] }, 'тег совпал с тегом DNHG');

  const enex = await carrier(J.enex);
  assert.equal(enex.callsign, 'ENEX');
  assert.deepEqual(await binding(J.enex), { squadron: null, source: null, rejected: [] }, 'чужой носитель отвязан');
  assert.equal(enex.squadron_at, null);
  assert.deepEqual(await binding(J.anon), { squadron: null, source: null, rejected: [] }, 'без тега подтвердить нечем');

  assert.deepEqual(await binding(J.manual), { squadron: DNHG, source: 'manual', rejected: [] }, 'ручную привязку решали офицеры');
  assert.equal((await carrier(J.manual)).callsign, 'KILO');
  assert.deepEqual(await binding(J.legacy), { squadron: DNHG, source: 'legacy', rejected: [] });

  const named = await carrier(J.named);
  assert.deepEqual([named.name, named.callsign], ['WOLF', 'WXYZ'], 'настоящее имя не трогаем');
  assert.equal((await carrier(DRAKE)).name, 'HOME', 'имя Drake не тег');
});

test('the SQL proof list matches the server normaliser', () => {
  const sql = migration(FIX);
  const list = sql.match(/coalesce\(op->>'proof', ''\) NOT IN \(([^)]*)\)/);
  assert.ok(list, 'в функции есть проверка proof');
  const inSql = [...list[1].matchAll(/'([A-Za-z]+)'/g)].map((match) => match[1]);
  assert.deepEqual(inSql.sort(), [...SQUADRON_PROOF_EVENTS].sort());
});

// ── 3. Новые правила на журнальных событиях ─────────────────────────────────
test('docking at a foreign Javelin binds nothing; a claim without proof (old server) is ignored', async () => {
  const result = await upload([
    docked(J.enex, 'ENEX', 50),
    { ...docked(J.enex, 'ENEX', 45), event: 'Location', Docked: true },
    { ...docked(J.enex, 'ENEX', 40, 'LHS 5333'), event: 'CarrierJump', Docked: true },
  ], DNHG_PILOT);
  assert.equal(result.ignored, 0);
  assert.deepEqual(await binding(J.enex), { squadron: null, source: null, rejected: [] });
  const row = await carrier(J.enex);
  assert.deepEqual([row.carrier_type, row.callsign, row.system_name], ['SquadronCarrier', 'ENEX', 'LHS 5333']);

  const old = await apply([{ op: 'squadron_claim', carrier_id: J.enex, at: minutesAgo(39) }], DNHG_PILOT);
  assert.equal(old.ignored, 1);
  assert.deepEqual(await binding(J.enex), { squadron: null, source: null, rejected: [] });
});

test('a member\'s CarrierLocation binds the Javelin to their squadron; others cannot take it', async () => {
  await upload(login(J.enex, 30), ENEX_PILOT);
  assert.deepEqual(await binding(J.enex), { squadron: ENEX, source: 'member', rejected: [] }, 'тег «[enex]» на сайте совпал с позывным');

  // Пилот DNHG: и чужая подтверждённая привязка, и тег не совпадает.
  const foreign = await upload(login(J.enex, 20), DNHG_PILOT);
  assert.equal(foreign.ignored, 1);
  assert.deepEqual(await binding(J.enex), { squadron: ENEX, source: 'member', rejected: [] });

  // Повтор от своих обновляет время привязки.
  const before = (await carrier(J.enex)).squadron_at;
  await upload(login(J.enex, 10), ENEX_PILOT);
  assert.ok(new Date((await carrier(J.enex)).squadron_at) > new Date(before));
});

test('the Javelin tag must match the site squadron tag', async () => {
  await upload([docked(J.xray, 'XRAY', 60)], LONER);
  // Пилот на сайте в DNHG, а в игре — в эскадрилье XRAY (её CarrierLocation у него при запуске).
  const result = await upload(login(J.xray, 50), DNHG_PILOT);
  assert.equal(result.ignored, 1);
  assert.deepEqual(await binding(J.xray), { squadron: null, source: null, rejected: [] });
});

test('a tag learned later drops a wrong journal binding', async () => {
  await upload(login(J.zulu, 60), DNHG_PILOT);
  assert.deepEqual(await binding(J.zulu), { squadron: DNHG, source: 'member', rejected: [] }, 'тег ещё неизвестен — проверить нечем');
  await upload([docked(J.zulu, 'ZULU', 50)], LONER);
  assert.equal((await carrier(J.zulu)).callsign, 'ZULU');
  assert.deepEqual(await binding(J.zulu), { squadron: null, source: null, rejected: [] }, 'тег ZULU ≠ DNHG');
  const again = await upload(login(J.zulu, 40), DNHG_PILOT);
  assert.equal(again.ignored, 1);
  assert.deepEqual(await binding(J.zulu), { squadron: null, source: null, rejected: [] });
});

test('without a game tag on the site, officers unbinding is final for journals', async () => {
  await upload(login(J.yank, 60), MIXED_PILOT);
  await upload([docked(J.yank, 'YANK', 55)], LONER);
  assert.deepEqual(await binding(J.yank), { squadron: COMMUNITY, source: 'member', rejected: [] },
    'тег «COMMUNITY» не игровой — тег носителя ему не противоречит');
  // Отвязка офицером (DELETE /api/carriers/bind) запоминает отказ эскадрильи.
  await db.query(`UPDATE fleet_carriers SET squadron_id = NULL, squadron_source = NULL, squadron_at = NULL,
    squadron_rejected = array_append(squadron_rejected, $2::bigint) WHERE carrier_id = $1`, [J.yank, COMMUNITY]);
  const back = await upload(login(J.yank, 50), MIXED_PILOT);
  assert.equal(back.ignored, 1, 'следующий запуск игры не возвращает носитель');
  assert.deepEqual(await binding(J.yank), { squadron: null, source: null, rejected: [COMMUNITY] });
});

test('old journals do not bind: membership may have changed since', async () => {
  const result = await upload(login(J.old, 40 * 24 * 60), ENEX_PILOT);
  assert.equal(result.ignored, 1);
  assert.deepEqual(await binding(J.old), { squadron: null, source: null, rejected: [] });
  assert.equal((await carrier(J.old)).system_name, 'LHS 5333', 'местоположение из старого журнала всё равно учтено');
});

test('a proven claim takes over an unverified legacy journal binding', async () => {
  await db.query(`INSERT INTO fleet_carriers(carrier_id, carrier_type, squadron_id, squadron_source, squadron_at)
    VALUES ($1, 'SquadronCarrier', $2, 'journal', now() - interval '1 day')`, [J.stale, DNHG]);
  await upload(login(J.stale, 15), ENEX_PILOT);
  assert.deepEqual(await binding(J.stale), { squadron: ENEX, source: 'member', rejected: [] });
});

test('a manual binding of the same squadron stays manual when members confirm it', async () => {
  await db.query(`INSERT INTO fleet_carriers(carrier_id, carrier_type, squadron_id, squadron_source, squadron_at)
    VALUES ($1, 'SquadronCarrier', $2, 'manual', now() - interval '2 days')`, [J.shared, DNHG]);
  await upload(login(J.shared, 5), DNHG_PILOT);
  const row = await carrier(J.shared);
  assert.deepEqual(await binding(J.shared), { squadron: DNHG, source: 'manual', rejected: [] });
  assert.ok(Date.now() - new Date(row.squadron_at).getTime() < 10 * 60_000, 'время привязки обновилось');
});

// ── 4. Повторный прогон миграции ────────────────────────────────────────────
test('re-running the migration keeps bindings made by the new rules', async () => {
  await db.exec(migration(FIX));
  assert.deepEqual(await binding(J.enex), { squadron: ENEX, source: 'member', rejected: [] });
  assert.deepEqual(await binding(J.dnhg), { squadron: DNHG, source: 'member', rejected: [] });
  assert.deepEqual(await binding(J.yank), { squadron: null, source: null, rejected: [COMMUNITY] });
  assert.deepEqual(await binding(J.manual), { squadron: DNHG, source: 'manual', rejected: [] });
  const { rows } = await db.query(`SELECT count(*)::int AS n FROM pg_constraint
    WHERE conrelid = 'public.fleet_carriers'::regclass AND pg_get_constraintdef(oid) LIKE '%squadron_source%'`);
  assert.equal(rows[0].n, 1, 'ограничение источника одно');
});

// ── 5. Карта ───────────────────────────────────────────────────────────────
test('map: a DNHG pilot sees only DNHG carriers as squadron ones; foreign Javelins keep their own tag', async () => {
  const now = new Date();
  const plain = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
  const rows = (await db.query('SELECT * FROM fleet_carriers')).rows.map(plain);
  const squadrons = new Map((await db.query('SELECT id, name, tag FROM squadrons')).rows
    .map((row) => [Number(row.id), { name: row.name, tag: row.tag }]));
  const carriers = shapeMapCarriers(rows.filter((row) => isMapCarrierRow(row, now)), {
    viewerId: DNHG_PILOT, viewerSquadronIds: [DNHG], squadronMateIds: new Set(), owners: new Map(),
    squadrons, coordinates: new Map(), now,
  });
  const byId = new Map(carriers.map((item) => [item.id, item]));

  const labelledDnhg = carriers.filter((item) => item.squadron?.id === DNHG).map((item) => item.id).sort();
  assert.deepEqual(labelledDnhg, [J.dnhg, J.manual, J.legacy, J.shared].sort(), 'подпись DNHG — только у носителей DNHG');
  for (const id of labelledDnhg) assert.equal(byId.get(id).relation, 'squadron');

  const enex = byId.get(J.enex);
  assert.equal(enex.relation, 'other');
  assert.deepEqual(enex.squadron, { id: ENEX, name: 'ENDURANCE EXPLORATION', tag: '[enex]', member: false });
  for (const id of [J.xray, J.zulu, J.yank]) {
    const item = byId.get(id);
    assert.equal(item.relation, 'other', id);
    assert.equal(item.squadron, null, id);
  }
  assert.equal(carrierSquadronTag(byId.get(J.xray)), 'XRAY', 'карта подписывает тег эскадрильи из позывного');
});
