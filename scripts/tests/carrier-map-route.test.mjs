/**
 * `GET /api/map/carriers` на настоящем PostgreSQL (PGlite) с миграциями
 * каталога станций и авианосцев.
 *
 * Маршрут собирается esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; service-role клиент — `helpers/pgliteSupabase.mjs`.
 * EDSM — подставной `fetch`. Проверяется, что видит гость и пилот с
 * эскадрильей, приватность владельцев, отсев списанных и забытых носителей,
 * все источники координат (журнал, каталоги, маршрут, хабы, EDSM), кэш
 * промахов EDSM, подмешивание реестра EDDN — с его следом последнего прыжка,
 * и история прыжков носителей (до пяти строк, свежие сверху, с координатами).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const OWNER = '00000000-0000-4000-8000-0000000000c1';
const MATE = '00000000-0000-4000-8000-0000000000c2';
const SHY = '00000000-0000-4000-8000-0000000000c3';
const OTHER = '00000000-0000-4000-8000-0000000000c4';
// В базе один личный носитель на пилота (fleet_carriers_one_personal).
const SCRAPPER = '00000000-0000-4000-8000-0000000000c5';
const ARRIVER = '00000000-0000-4000-8000-0000000000c6';
const DRIFTER = '00000000-0000-4000-8000-0000000000c7';

const FC = {
  own: '3700000101',
  mate: '3700000102',
  shy: '3700000103',
  squad: '3709000104',
  stranger: '3700000105',
  oldStranger: '3700000106',
  scrapped: '3700000107',
  jump: '3700000108',
  arrived: '3700000109',
  nowhere: '3700000110',
  unknown: '3700000111',
};

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
  }),
};
`;

const HELPER = join(TEST_ROOT, 'scripts', 'tests', 'helpers', 'pgliteSupabase.mjs').replace(/\\/g, '/');
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
export async function createClient() { return pgliteClient(state); }
export async function authFromRequest() {
  return { user: state.userId ? { id: state.userId } : null, supabase: pgliteClient(state) };
}
`;

const ENTRY = `
export * as carriers from '@/app/api/map/carriers/route';
export { state } from '@/lib/supabaseServer';
export { resetCarrierMapCache } from '@/lib/carrierMapStore';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${MATE}'), ('${SHY}'), ('${OTHER}'), ('${SCRAPPER}'), ('${ARRIVER}'), ('${DRIFTER}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name, privacy_settings) VALUES
  ('${OWNER}', 'Owner Pilot', '{"location": false}'),
  ('${MATE}', 'Mate Pilot', NULL),
  ('${SHY}', 'Shy Pilot', '{"location": false}'),
  ('${OTHER}', 'Other Pilot', '{"deliveries": false}'),
  ('${SCRAPPER}', 'Scrap Pilot', NULL), ('${ARRIVER}', 'Arriving Pilot', NULL), ('${DRIFTER}', 'Drifting Pilot', NULL);
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
INSERT INTO public.squadrons(name, tag, created_by) VALUES ('Alpha Wing', 'ALP', '${MATE}');
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
INSERT INTO public.squadron_ranks VALUES (10, 1, true), (11, 1, false);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
INSERT INTO public.squadron_members VALUES (1, '${OWNER}', 11), (1, '${MATE}', 10), (1, '${SHY}', 11);
CREATE TABLE colonisation_market_systems(system_name text,x float8,y float8,z float8,has_market boolean,last_checked_at timestamptz);
CREATE TABLE market_search_jobs(id integer);
CREATE TABLE market_search_cache(market_id bigint);
CREATE TABLE market_prices(station_name text,system_name text,commodity_name text,buy_price integer,sell_price integer,stock integer,demand integer,reported_at timestamptz,source text);
CREATE TABLE public.route_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, x float8, y float8, z float8);
CREATE TABLE public.hubs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, x float8, y float8, z float8);
CREATE TABLE public.galaxy_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, name_lc text UNIQUE, x float8 NOT NULL, y float8 NOT NULL, z float8 NOT NULL);
`);
for (const file of [
  '20261014000000_station_commerce.sql',
  '20261017000000_fleet_carriers.sql',
  '20261018000000_fleet_carrier_squadron_claims.sql',
  '20261108120000_carrier_directory.sql',
  '20261110090000_carrier_directory_route.sql',
  '20261113120000_carrier_jump_history.sql',
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

const at = (minutes) => `now() + interval '${minutes} minutes'`;
await db.exec(`
INSERT INTO public.galaxy_systems(name, name_lc, x, y, z) VALUES ('HIP 100', 'hip 100', 10, 1, -20);
INSERT INTO public.commerce_systems(system_name, name_lc, x, y, z, observed_at, source) VALUES ('Lave', 'lave', 75.75, 48.75, -12.5, now(), 'edsm');
INSERT INTO public.route_systems(system_name, x, y, z) VALUES ('Alioth', -33.65, 72.47, -20.66);
INSERT INTO public.hubs(system_name, x, y, z) VALUES ('Achenar', 67.5, -119.47, 24.84);

INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, squadron_id, system_name, x, y, z, location_at,
    docking_access, allow_notorious, services, finance, space_usage, pending_decommission, decommission_at,
    jump_system_name, jump_departure_at) VALUES
  (${FC.own}, 'FleetCarrier', 'OWN-101', 'Owner Hauler', '${OWNER}', NULL, 'Sol', 0, 0, 0, ${at(-60)},
    'all', false, '[{"role":"Commodities","activated":true,"enabled":true},{"role":"Refuel","activated":true,"enabled":true},{"role":"Captain","activated":true,"enabled":true}]',
    '{"carrier_balance": 987654321}', '{"cargo": 4000, "free_space": 21000}', false, NULL, NULL, NULL),
  (${FC.mate}, 'FleetCarrier', 'MAT-102', 'Mate Depot', '${MATE}', NULL, 'HIP 100', NULL, NULL, NULL, ${at(-120)},
    'squadron', NULL, '[]', NULL, NULL, false, NULL, NULL, NULL),
  (${FC.shy}, 'FleetCarrier', 'SHY-103', 'Shy Depot', '${SHY}', NULL, 'Lave', NULL, NULL, NULL, ${at(-30)},
    'friends', NULL, '[]', NULL, NULL, false, NULL, NULL, NULL),
  (${FC.squad}, 'SquadronCarrier', 'SQD-104', 'Wing Bank', NULL, 1, 'Alioth', NULL, NULL, NULL, ${at(-10)},
    'squadron', NULL, '[{"role":"SquadronBank","activated":true,"enabled":true}]', '{"carrier_balance": 5}', NULL, false, NULL, NULL, NULL),
  (${FC.stranger}, 'FleetCarrier', 'STR-105', 'Passing Trader', NULL, NULL, 'Edsm Only', NULL, NULL, NULL, ${at(-2 * 24 * 60)},
    'all', NULL, '[]', NULL, NULL, false, NULL, NULL, NULL),
  (${FC.oldStranger}, 'FleetCarrier', 'OLD-106', 'Forgotten', NULL, NULL, 'Sol', 0, 0, 0, ${at(-40 * 24 * 60)},
    'all', NULL, '[]', NULL, NULL, false, NULL, NULL, NULL),
  (${FC.scrapped}, 'FleetCarrier', 'SCR-107', 'Scrapped', '${SCRAPPER}', NULL, 'Sol', 0, 0, 0, ${at(-20 * 24 * 60)},
    'all', NULL, '[]', NULL, NULL, true, ${at(-10 * 24 * 60)}, NULL, NULL),
  (${FC.jump}, 'FleetCarrier', 'JMP-108', 'Jumper', '${OTHER}', NULL, 'Sol', 0, 0, 0, ${at(-5)},
    'all', NULL, '[]', NULL, NULL, false, NULL, 'HIP 100', ${at(20)}),
  (${FC.arrived}, 'FleetCarrier', 'ARR-109', 'Arrived', '${ARRIVER}', NULL, 'Lave', 75.75, 48.75, -12.5, ${at(-90)},
    'none', NULL, '[]', NULL, NULL, true, ${at(-60)}, 'Achenar', ${at(-30)}),
  (${FC.nowhere}, 'FleetCarrier', 'NOW-110', 'Nowhere', '${DRIFTER}', NULL, NULL, NULL, NULL, NULL, NULL,
    NULL, NULL, '[]', NULL, NULL, false, NULL, NULL, NULL),
  (${FC.unknown}, 'FleetCarrier', 'UNK-111', 'Lost Trader', NULL, NULL, 'Nowhere Known', NULL, NULL, NULL, ${at(-60)},
    'all', NULL, '[]', NULL, NULL, false, NULL, NULL, NULL);
INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, quantity) VALUES
  (${FC.own}, 'steel', 'Steel', 4000, 4000);
`);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

const edsm = { calls: [] };
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  const target = new URL(String(url));
  if (target.hostname !== 'www.edsm.net') throw new Error(`неожиданный запрос ${target}`);
  const names = target.searchParams.getAll('systemName[]');
  edsm.calls.push(names);
  const body = names
    .filter((name) => name.toLowerCase() === 'edsm only')
    .map((name) => ({ name: 'EDSM Only', coords: { x: 100.5, y: -2.25, z: 300 } }));
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

test.after(async () => {
  globalThis.fetch = previousFetch;
  await db.close();
});

async function get(userId, query = '') {
  mod.state.userId = userId;
  const response = await mod.carriers.GET(new Request(`http://localhost/api/map/carriers${query}`));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

const byId = (body) => new Map(body.carriers.map((carrier) => [carrier.id, carrier]));

test('гость: открытые отметки без груза и финансов, владельцы — по приватности, координаты из всех источников', async () => {
  mod.resetCarrierMapCache();
  edsm.calls.length = 0;
  const response = await get(null);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.viewer.signedIn, false);

  const carriers = byId(response.body);
  assert.deepEqual([...carriers.keys()].sort(), [FC.own, FC.mate, FC.shy, FC.squad, FC.stranger, FC.jump, FC.arrived, FC.unknown].sort(),
    'без системы, списанный и забытый «ничей» не показываются');
  for (const carrier of carriers.values()) assert.equal(carrier.relation, 'other', `${carrier.id}: гостю всё чужое`);

  for (const secret of ['987654321', 'finance', 'balance', 'free_space', 'Steel', 'quantity']) {
    assert.ok(!response.text.includes(secret), `в ответе карты есть «${secret}»`);
  }

  const own = carriers.get(FC.own);
  assert.equal(own.owner, null, 'владелец скрыл местоположение');
  assert.equal(own.ownerHidden, true);
  assert.deepEqual(own.position, { x: 0, y: 0, z: 0 }, 'координаты из журнала');
  assert.deepEqual(own.services, ['Рынок товаров', 'Заправка']);
  assert.equal(own.docking, 'все пилоты');

  assert.equal(carriers.get(FC.mate).owner, 'Mate Pilot');
  assert.deepEqual(carriers.get(FC.mate).position, { x: 10, y: 1, z: -20 }, 'каталог Spansh (galaxy_systems)');
  assert.equal(carriers.get(FC.shy).ownerHidden, true);
  assert.deepEqual(carriers.get(FC.shy).position, { x: 75.75, y: 48.75, z: -12.5 }, 'каталог станций (commerce_systems)');

  const squad = carriers.get(FC.squad);
  assert.equal(squad.type, 'SquadronCarrier');
  assert.deepEqual(squad.squadron, { id: 1, name: 'Alpha Wing', tag: 'ALP', member: false });
  assert.deepEqual(squad.position, { x: -33.65, y: 72.47, z: -20.66 }, 'системы маршрута');
  assert.deepEqual(squad.services, ['Банк эскадрильи']);

  assert.deepEqual(carriers.get(FC.stranger).position, { x: 100.5, y: -2.25, z: 300 }, 'EDSM');
  assert.equal(carriers.get(FC.unknown).position, null, 'систему не знает никто — отметка без координат');
  assert.equal(carriers.get(FC.jump).owner, 'Other Pilot', 'закрытые поставки не прячут местоположение');

  assert.equal(edsm.calls.length, 1, 'EDSM спрашивается одной пачкой');
  assert.deepEqual(edsm.calls[0].sort(), ['Edsm Only', 'Nowhere Known']);
});

test('прыжки: заказанный — с координатами цели, завершившийся по времени — в системе назначения', async () => {
  const carriers = byId((await get(null)).body);
  const jumper = carriers.get(FC.jump);
  assert.equal(jumper.system, 'Sol');
  assert.equal(jumper.jump.state, 'scheduled');
  assert.equal(jumper.jump.system, 'HIP 100');
  assert.deepEqual(jumper.jump.position, { x: 10, y: 1, z: -20 });

  const arrived = carriers.get(FC.arrived);
  assert.equal(arrived.system, 'Achenar');
  assert.equal(arrived.estimated, true);
  assert.equal(arrived.previousSystem, 'Lave');
  assert.equal(arrived.jump, null);
  assert.deepEqual(arrived.position, { x: 67.5, y: -119.47, z: 24.84 }, 'хабы; x/y/z строки — от старой системы');
  assert.equal(arrived.decommission, true, 'списывается, но флаг свежий — носитель ещё на карте');
  assert.equal(arrived.docking, 'никто');
});

test('реестр EDDN подмешивается: чужие носители, след прыжка и переключатель ?directory=0', async () => {
  // Носитель, которого сайт не учитывает: его прыжок видел кто-то в EDDN.
  await db.exec(`
    INSERT INTO public.carrier_directory(carrier_id, callsign, name, carrier_type, system_name, system_address,
        body_name, x, y, z, services, updated_at, last_seen_at,
        previous_system_name, previous_x, previous_y, previous_z)
    VALUES
      (3700000501, 'EDD-501', NULL, 'FleetCarrier', 'HIP 100', 10477373803, 'HIP 100 4', 10, 1, -20,
        '["commodities","refuel","dock"]', ${at(-15)}, ${at(-15)}, 'Lave', 75.75, 48.75, -12.5),
      -- Дубль носителя сайта: учёт сайта главнее, вторая отметка не появляется.
      (${FC.mate}, 'MAT-102', NULL, 'FleetCarrier', 'Sol', NULL, NULL, 0, 0, 0,
        '[]', ${at(-5)}, ${at(-5)}, NULL, NULL, NULL, NULL),
      -- Слишком старое наблюдение: на карту не берём.
      (3700000502, 'EDD-502', NULL, 'FleetCarrier', 'Sol', NULL, NULL, 0, 0, 0,
        '[]', ${at(-200 * 24 * 60)}, ${at(-200 * 24 * 60)}, NULL, NULL, NULL, NULL);
  `);
  mod.resetCarrierMapCache();

  try {
    const response = await get(null);
    assert.equal(response.status, 200, response.text);
    const carriers = byId(response.body);
    const guest = await get(null, '?directory=0');

    assert.equal(carriers.size, 9, 'восемь носителей сайта плюс один из реестра');
    assert.equal(guest.body.carriers.length, 8, '?directory=0 — только подтверждённые стоянки сайта');

    const eddn = carriers.get('3700000501');
    assert.equal(eddn.origin, 'eddn');
    assert.equal(eddn.relation, 'other');
    assert.equal(eddn.owner, null);
    assert.equal(eddn.squadron, null);
    assert.equal(eddn.jump, null, 'EDDN не приносит заказанный прыжок');
    assert.equal(eddn.callsign, 'EDD-501');
    assert.deepEqual(eddn.services, ['Рынок товаров', 'Заправка']);
    assert.deepEqual(eddn.position, { x: 10, y: 1, z: -20 });
    assert.match(eddn.locationAt, /^\d{4}-\d{2}-\d{2}T/, 'время наблюдения — ISO, а не Date из драйвера');
    assert.equal(eddn.previousSystem, 'Lave', 'след последнего прыжка');
    assert.deepEqual(eddn.previousPosition, { x: 75.75, y: 48.75, z: -12.5 });
    assert.ok(!carriers.has('3700000502'), 'наблюдение старше срока давности не показывается');
    assert.equal(carriers.get(FC.mate).origin, 'site', 'учёт сайта главнее реестра');

    assert.deepEqual(response.body.directory, {
      shown: 1, truncated: false, since: response.body.directory.since,
    });
    assert.equal(guest.body.directory, undefined, 'без реестра и счётчиков реестра нет');
  } finally {
    await db.exec('DELETE FROM public.carrier_directory');
    mod.resetCarrierMapCache();
  }
});

test('история прыжков: только неделя, свежие сверху, с координатами', async () => {
  const historyRow = (carrierId, from, to, minutesAgo, source = 'site') => `
    (${carrierId}, '${from}', '${to}', ${at(-minutesAgo)}, '${source}')`;
  await db.exec(`
    INSERT INTO public.carrier_jump_history(carrier_id, from_system, to_system, jumped_at, source) VALUES
      ${historyRow(FC.own, 'Lave', 'Achenar', 10, 'eddn')},
      ${historyRow(FC.own, 'Achenar', 'Sol', 2 * 60)},
      ${historyRow(FC.own, 'Sol', 'Lave', 24 * 60)},
      ${historyRow(FC.own, 'Lave', 'HIP 100', 48 * 60)},
      ${historyRow(FC.own, 'HIP 100', 'Sol', 72 * 60)},
      -- Шестой прыжок внутри недели: в истории за неделю остаётся.
      ${historyRow(FC.own, 'Sol', 'Achenar', 96 * 60)},
      -- Восьмые сутки: за окном недели, на карту не попадает.
      ${historyRow(FC.own, 'Achenar', 'Lave', 8 * 24 * 60)},
      -- Две недели: тоже мимо.
      ${historyRow(FC.own, 'Sol', 'HIP 100', 14 * 24 * 60)};
  `);
  mod.resetCarrierMapCache();
  edsm.calls.length = 0;

  try {
    const response = await get(null);
    assert.equal(response.status, 200, response.text);
    const carriers = byId(response.body);

    const own = carriers.get(FC.own);
    assert.equal(own.history.length, 6, 'все прыжки недели, без обрезки по количеству');
    assert.deepEqual(own.history.map((entry) => [entry.from, entry.to]), [
      ['Lave', 'Achenar'], ['Achenar', 'Sol'], ['Sol', 'Lave'], ['Lave', 'HIP 100'], ['HIP 100', 'Sol'], ['Sol', 'Achenar'],
    ], 'свежие сверху; прыжки старше недели отброшены');
    const oldest = Date.parse(own.history[own.history.length - 1].jumpedAt);
    assert.ok(Date.now() - oldest <= 7 * 24 * 60 * 60 * 1000, 'ничего старше недели');
    assert.equal(own.history[0].source, 'eddn');
    assert.equal(own.history[1].source, 'site');
    assert.match(own.history[0].jumpedAt, /^\d{4}-\d{2}-\d{2}T/, 'время — ISO, а не Date из драйвера');
    assert.deepEqual(own.history[0].fromPosition, { x: 75.75, y: 48.75, z: -12.5 }, 'Lave из каталога станций');
    assert.deepEqual(own.history[0].toPosition, { x: 67.5, y: -119.47, z: 24.84 }, 'Achenar из хабов');
    assert.deepEqual(own.history[1].toPosition, { x: 0, y: 0, z: 0 }, 'Sol — из строки носителя');
    assert.deepEqual(own.history[3].toPosition, { x: 10, y: 1, z: -20 }, 'HIP 100 из каталога Spansh');

    assert.deepEqual(carriers.get(FC.mate).history, [], 'у носителя без прыжков истории нет');
    assert.equal(carriers.get(FC.jump).history.length, 0, 'заказ прыжка — не история');

    // История не зависит от переключателя реестра и не тянет EDSM.
    const siteOnly = byId((await get(null, '?directory=0')).body);
    assert.equal(siteOnly.get(FC.own).history.length, 6, 'история есть и без реестра EDDN');
    assert.equal(edsm.calls.length, 1, 'историю ищем только в локальных каталогах');
  } finally {
    await db.exec('DELETE FROM public.carrier_jump_history');
    mod.resetCarrierMapCache();
  }
});

test('пилот с эскадрильей: свой носитель, носители эскадрильи и участников; скрытый участник — чужой', async () => {
  const response = await get(OWNER);
  assert.equal(response.status, 200);
  assert.equal(response.body.viewer.signedIn, true);
  const carriers = byId(response.body);

  const own = carriers.get(FC.own);
  assert.equal(own.relation, 'own');
  assert.equal(own.owner, 'Owner Pilot', 'себя пилот видит со скрытым местоположением');
  assert.equal(own.ownerHidden, false);

  assert.equal(carriers.get(FC.mate).relation, 'squadron');
  assert.equal(carriers.get(FC.squad).relation, 'squadron');
  assert.equal(carriers.get(FC.squad).squadron.member, true);
  assert.equal(carriers.get(FC.shy).relation, 'other', 'участник скрыл местоположение');
  assert.equal(carriers.get(FC.shy).owner, null);
  assert.equal(carriers.get(FC.jump).relation, 'other');
  assert.ok(!response.text.includes('987654321'), 'финансы не уходят даже владельцу');

  const stranger = await get(OTHER);
  const view = byId(stranger.body);
  assert.equal(view.get(FC.jump).relation, 'own');
  assert.equal(view.get(FC.mate).relation, 'other');
  assert.equal(view.get(FC.squad).squadron.member, false);
});

test('координаты кэшируются: повторный опрос не ходит в EDSM ни за найденным, ни за ненайденным', async () => {
  edsm.calls.length = 0;
  await get(null);
  await get(MATE);
  assert.equal(edsm.calls.length, 0);

  mod.resetCarrierMapCache();
  await get(null);
  assert.equal(edsm.calls.length, 1, 'после сброса кэша EDSM спрашивается снова');
});

test('ошибка базы — 503 без подробностей', async () => {
  await db.exec('ALTER TABLE public.fleet_carriers RENAME TO fleet_carriers_hidden');
  const previousError = console.error;
  console.error = () => {};
  try {
    const response = await get(null);
    assert.equal(response.status, 503);
    assert.deepEqual(Object.keys(response.body), ['error']);
  } finally {
    console.error = previousError;
    await db.exec('ALTER TABLE public.fleet_carriers_hidden RENAME TO fleet_carriers');
  }
  assert.equal((await get(null)).status, 200);
});
