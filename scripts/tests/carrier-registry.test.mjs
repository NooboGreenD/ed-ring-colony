/**
 * Реестр авианосцев из EDDN и правила имён.
 *
 * Проверяется главное обещание раздела: перепись носителей идёт живым
 * потоком EDDN, а **имя** появляется только от людей — от владельца или от
 * пилота, побывавшего на борту. Если EDDN когда-нибудь начнёт присылать
 * `StationName`, похожий на имя, оно всё равно не должно попасть в колонку
 * `name`: её трогают только `carrier_directory_set_name` и никто больше.
 *
 * Часть тестов — чистые функции (`src/lib/carrierRegistry.ts`), часть —
 * настоящий PostgreSQL (PGlite) с миграцией `20261108120000_carrier_directory`,
 * чтобы триггеры «кто имеет право» проверялись базой, а не договорённостью.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

const {
  eddnCarrierRow,
  carrierVisitsFromJournal,
  carrierNamesFromJournal,
  normalizeCarrierName,
  isCarrierCallsign,
  isCarrierMarketId,
  rememberCarrierJump,
} = await import(await bundleFile({ entrySource: `
export * from '@/lib/carrierRegistry';
` }));

/* ── Чистые правила ─────────────────────────────────────────────────────── */

test('EDDN CarrierJump → строка реестра: позывной, система, координаты, службы', () => {
  const row = eddnCarrierRow({
    event: 'CarrierJump',
    MarketID: 3700000101,
    StationName: 'K7Q-BQL',
    StarSystem: 'Sol',
    SystemAddress: 10477373803,
    StarPos: [0, 0, 0],
    Body: 'Earth',
    StationServices: ['dock', 'commodities', 'Refuel', 'dock'],
    timestamp: '2026-11-09T12:00:00Z',
  });
  assert.ok(row);
  assert.equal(row.carrier_id, '3700000101');
  assert.equal(row.callsign, 'K7Q-BQL');
  assert.equal(row.system_name, 'Sol');
  assert.equal(row.system_address, 10477373803);
  assert.equal(row.x, 0);
  assert.equal(row.body_name, 'Earth');
  assert.deepEqual(row.services, ['dock', 'commodities', 'refuel'], 'службы без повторов, в нижнем регистре');
  assert.equal(row.observed_at, '2026-11-09T12:00:00.000Z');
  // Имени в EDDN нет и в разборе тоже — это не упущение, а правило.
  assert.equal('name' in row, false);
});

test('EDDN: не носитель, мусорная дата и чужая станция отбрасываются', () => {
  const base = {
    event: 'CarrierJump', MarketID: 3700000101, StationName: 'K7Q-BQL',
    StarSystem: 'Sol', StarPos: [0, 0, 0], timestamp: '2026-11-09T12:00:00Z',
  };
  assert.equal(eddnCarrierRow({ ...base, event: 'Docked' }), null, 'обычная стыковка — не наше событие');
  assert.equal(eddnCarrierRow({ ...base, MarketID: 128666762 }), null, 'MarketID обычной станции');
  assert.equal(eddnCarrierRow({ ...base, MarketID: undefined }), null);
  assert.equal(eddnCarrierRow({ ...base, timestamp: '2999-01-01T00:00:00Z' }), null, 'дата из будущего — мусор очереди');
  assert.equal(eddnCarrierRow({ ...base, timestamp: 'not a date' }), null);
  assert.equal(eddnCarrierRow({ ...base, StarSystem: '' }), null, 'без системы строка бесполезна');
  assert.equal(eddnCarrierRow(null), null);
});

test('EDDN: имя в StationName не становится ни именем, ни позывным', () => {
  const row = eddnCarrierRow({
    event: 'CarrierJump', MarketID: 3700000101, StationName: 'Aurora Borealis',
    StarSystem: 'Sol', StarPos: [0, 0, 0], timestamp: '2026-11-09T12:00:00Z',
  });
  assert.equal(row.callsign, null, 'не позывной — значит в позывной не пишем');
  assert.equal(row.name, undefined);
});

test('визиты: Docked/Location/CarrierJump на носителе, по одному на MarketID', () => {
  const visits = carrierVisitsFromJournal([
    { event: 'Docked', MarketID: 3700000101, StationName: 'Aurora Borealis', timestamp: '2026-11-09T10:00:00Z' },
    { event: 'Docked', MarketID: 3700000101, StationName: 'Aurora Borealis', timestamp: '2026-11-09T11:00:00Z' },
    { event: 'Location', MarketID: 3700000102, Docked: true, timestamp: '2026-11-09T09:00:00Z' },
    { event: 'Location', MarketID: 3700000103, Docked: false, timestamp: '2026-11-09T09:00:00Z' },
    { event: 'Docked', MarketID: 128666762, StationName: 'Galileo', timestamp: '2026-11-09T09:00:00Z' },
    { event: 'FSDJump', MarketID: 3700000104, timestamp: '2026-11-09T09:00:00Z' },
  ]);
  assert.deepEqual(visits, [
    { carrier_id: '3700000101', observed_at: '2026-11-09T11:00:00.000Z' },
    { carrier_id: '3700000102', observed_at: '2026-11-09T09:00:00.000Z' },
  ]);
});

test('имена: владелец из CarrierStats, посетитель из Docked, позывной — не имя', () => {
  const names = carrierNamesFromJournal([
    { event: 'CarrierStats', CarrierID: 3700000101, Callsign: 'K7Q-BQL', Name: 'Aurora Borealis', timestamp: '2026-11-09T10:00:00Z' },
    { event: 'Docked', MarketID: 3700000102, StationName: 'Quiet Harbor', timestamp: '2026-11-09T10:00:00Z' },
    { event: 'Docked', MarketID: 3700000103, StationName: 'ABC-123', timestamp: '2026-11-09T10:00:00Z' },
    { event: 'Docked', MarketID: 128666762, StationName: 'Galileo', timestamp: '2026-11-09T10:00:00Z' },
  ]);
  assert.deepEqual(names, [
    { carrier_id: '3700000101', name: 'Aurora Borealis', source: 'owner' },
    { carrier_id: '3700000102', name: 'Quiet Harbor', source: 'visit' },
  ]);
});

test('имена: имя владельца не перебивается более поздним визитом', () => {
  const names = carrierNamesFromJournal([
    { event: 'Docked', MarketID: 3700000101, StationName: 'Old Harbor', timestamp: '2026-11-09T09:00:00Z' },
    { event: 'CarrierNameChanged', CarrierID: 3700000101, Name: 'New Harbor', timestamp: '2026-11-09T10:00:00Z' },
  ]);
  assert.deepEqual(names, [{ carrier_id: '3700000101', name: 'New Harbor', source: 'owner' }]);
});

test('нормализация имени: пробелы, длина, позывной', () => {
  assert.deepEqual(normalizeCarrierName('  Aurora   Borealis '), { ok: true, name: 'Aurora Borealis' });
  assert.equal(normalizeCarrierName('').ok, false);
  assert.equal(normalizeCarrierName('   ').ok, false);
  assert.equal(normalizeCarrierName('K7Q-BQL').ok, false, 'позывной — отдельная колонка');
  assert.equal(normalizeCarrierName('x'.repeat(81)).ok, false);
  assert.equal(normalizeCarrierName('x'.repeat(80)).ok, true);
  assert.equal(normalizeCarrierName(null).ok, false);
});

test('очередь живого слушателя: последний прыжок на носителя, чужие события мимо', () => {
  const queue = new Map();
  const jump = (marketId, system, offsetMs) => ({
    event: 'CarrierJump', MarketID: marketId, StarSystem: system, StarPos: [0, 0, 0],
    timestamp: new Date(Date.now() + offsetMs).toISOString(),
  });
  assert.equal(rememberCarrierJump(queue, jump(3700000101, 'Sol', -60_000)), true);
  assert.equal(rememberCarrierJump(queue, jump(3700000101, 'Lave', -120_000)), false, 'старый прыжок не перебивает новый');
  assert.equal(rememberCarrierJump(queue, jump(3700000102, 'Sol', -30_000)), true, 'в одной системе — два носителя');
  assert.equal(rememberCarrierJump(queue, { event: 'FSDJump', MarketID: 3700000101, timestamp: new Date().toISOString() }), false);
  assert.equal(rememberCarrierJump(queue, { event: 'CarrierJump', MarketID: 128666762, timestamp: new Date().toISOString() }), false);
  assert.equal(rememberCarrierJump(queue, { event: 'CarrierJump', MarketID: 3700000103, timestamp: 'nope' }), false);
  assert.equal(queue.size, 2);
  assert.equal(queue.get('3700000101').event.StarSystem, 'Sol');

  const capped = new Map();
  for (let index = 0; index < 5; index += 1) {
    rememberCarrierJump(capped, jump(3700000200 + index, 'Sol', -index * 1000), { limit: 3 });
  }
  assert.equal(capped.size, 3);
  assert.equal(capped.has('3700000200'), true, 'самый свежий остался');
  assert.equal(capped.has('3700000204'), false, 'самый старый вытеснен');
});

test('диапазоны: позывной и MarketID носителя', () => {
  assert.equal(isCarrierCallsign('K7Q-BQL'), true);
  assert.equal(isCarrierCallsign('k7q-bql'), true);
  assert.equal(isCarrierCallsign('Aurora Borealis'), false);
  assert.equal(isCarrierMarketId('3700000101'), true);
  assert.equal(isCarrierMarketId(128666762), false);
  assert.equal(isCarrierMarketId('abc'), false);
});

/* ── Настоящая база: миграция, права на имя, поиск ───────────────────────── */

const VISITOR = '00000000-0000-4000-8000-0000000000d1';
const STRANGER = '00000000-0000-4000-8000-0000000000d2';
const OWNER = '00000000-0000-4000-8000-0000000000d3';
// Второй владелец: у пилота один личный носитель (`fleet_carriers_one_personal`).
const BOSS = '00000000-0000-4000-8000-0000000000d4';

const HELPER = join(TEST_ROOT, 'scripts', 'tests', 'helpers', 'pgliteSupabase.mjs').replace(/\\/g, '/');
const SUPABASE_STUB = `
import { pgliteClient } from '${HELPER}';
export const state = { db: null, userId: null, log: [] };
export function createServiceClient() { return pgliteClient(state); }
export async function createClient() { return pgliteClient(state); }
export async function authFromRequest() { return { user: state.userId ? { id: state.userId } : null }; }
`;
const ENTRY = `
export * as registry from '@/lib/carrierRegistryStore';
export * as map from '@/lib/carrierMapStore';
export { state } from '@/lib/supabaseServer';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${VISITOR}'), ('${STRANGER}'), ('${OWNER}'), ('${BOSS}');
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name) VALUES ('${VISITOR}', 'Visitor'), ('${STRANGER}', 'Stranger'), ('${OWNER}', 'Owner'), ('${BOSS}', 'Boss');
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
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
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': 'export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };',
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

/** Носитель сайта: `fleet_carriers` знает владельца, реестр — нет. */
await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, system_name, location_at)
VALUES (3700000201, 'FleetCarrier', 'OWN-201', NULL, '${OWNER}', 'Sol', now());
`);

const svc = () => mod.state.db && {
  from: (table) => mod.registry && null,
};

// Клиент «как supabase-js» нужен самому модулю; берём его из стаба.
const client = (await import(bundle)).state;

async function rpcClient() {
  const { pgliteClient } = await import(HELPER);
  return pgliteClient(client);
}

test.after(async () => { await db.close(); });

test('EDDN пишет строку реестра, но не имя', async () => {
  const api = await rpcClient();
  const applied = await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump',
    MarketID: 3700000301,
    StationName: 'K7Q-BQL',
    StarSystem: 'Sol',
    SystemAddress: 10477373803,
    StarPos: [0, 0, 0],
    StationServices: ['dock', 'commodities'],
    timestamp: new Date(Date.now() - 60_000).toISOString(),
  });
  assert.equal(applied, true);
  const { rows } = await db.query('SELECT callsign, name, system_name, services FROM carrier_directory WHERE carrier_id = 3700000301');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].callsign, 'K7Q-BQL');
  assert.equal(rows[0].name, null, 'EDDN имя не приносит');
  assert.equal(rows[0].system_name, 'Sol');
});

test('устаревшее сообщение EDDN не двигает носитель назад', async () => {
  const api = await rpcClient();
  const now = Date.now();
  await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump', MarketID: 3700000302, StationName: 'K7Q-BQ2', StarSystem: 'Lave',
    StarPos: [75, 48, -12], timestamp: new Date(now - 60_000).toISOString(),
  });
  await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump', MarketID: 3700000302, StationName: 'K7Q-BQ2', StarSystem: 'Sol',
    StarPos: [0, 0, 0], timestamp: new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString(),
  });
  const { rows } = await db.query('SELECT system_name, x FROM carrier_directory WHERE carrier_id = 3700000302');
  assert.equal(rows[0].system_name, 'Lave', 'старое сообщение из очереди не перетирает свежее');
  assert.equal(rows[0].x, 75);
  const { rows: sightings } = await db.query('SELECT sightings FROM carrier_directory WHERE carrier_id = 3700000302');
  assert.equal(sightings[0].sightings, 2, 'наблюдения считаются и для старых сообщений');
});

test('след прыжка: смена системы сдвигает прежнюю в previous_*, повтор того же прыжка — нет', async () => {
  const api = await rpcClient();
  const now = Date.now();
  const jump = (minutesAgo, system, pos) => ({
    event: 'CarrierJump',
    MarketID: 3700000303,
    StationName: 'K7Q-BQ3',
    StarSystem: system,
    StarPos: pos,
    timestamp: new Date(now - minutesAgo * 60_000).toISOString(),
  });

  await mod.registry.applyEddnCarrierMessage(api, jump(30, 'Sol', [0, 0, 0]));
  let { rows } = await db.query('SELECT system_name, previous_system_name FROM carrier_directory WHERE carrier_id = 3700000303');
  assert.equal(rows[0].system_name, 'Sol');
  assert.equal(rows[0].previous_system_name, null, 'первое наблюдение — пришёл «ниоткуда»');

  await mod.registry.applyEddnCarrierMessage(api, jump(10, 'Lave', [75.75, 48.75, -12.5]));
  ({ rows } = await db.query(`SELECT system_name, previous_system_name, previous_x, previous_y, previous_z
    FROM carrier_directory WHERE carrier_id = 3700000303`));
  assert.equal(rows[0].system_name, 'Lave');
  assert.equal(rows[0].previous_system_name, 'Sol', 'прежняя стоянка стала следом маршрута');
  assert.equal(rows[0].previous_x, 0);

  // EDDN переотправляет очередь: тот же прыжок не должен затирать след.
  await mod.registry.applyEddnCarrierMessage(api, jump(11, 'Lave', [75.75, 48.75, -12.5]));
  ({ rows } = await db.query('SELECT previous_system_name FROM carrier_directory WHERE carrier_id = 3700000303'));
  assert.equal(rows[0].previous_system_name, 'Sol', 'повтор свежего прыжка не сдвигает маршрут');

  // А вот совсем старое сообщение из другой системы — не повод двигать носитель.
  await mod.registry.applyEddnCarrierMessage(api, jump(120, 'Achenar', [67.5, -119.47, 24.84]));
  ({ rows } = await db.query('SELECT system_name, previous_system_name FROM carrier_directory WHERE carrier_id = 3700000303'));
  assert.equal(rows[0].system_name, 'Lave');
  assert.equal(rows[0].previous_system_name, 'Sol', 'старое сообщение маршрут не переписывает');
});

test('имя: без визита — отказ, после визита — запись, владелец — приоритет', async () => {
  const api = await rpcClient();
  const before = await mod.registry.setCarrierName(api, STRANGER, '3700000301', 'Подмена');
  assert.equal(before.ok, false);
  assert.equal(before.error, 'forbidden', 'чужой пилот не может назвать носитель');

  const visits = await mod.registry.applyCarrierSightings(api, VISITOR, [
    { event: 'Docked', MarketID: 3700000301, StationName: 'Aurora Borealis', timestamp: new Date().toISOString() },
  ]);
  assert.equal(visits.visits, 1);
  // Пилот был на борту: его журнал сразу дал имя.
  let row = (await db.query('SELECT name, name_source FROM carrier_directory WHERE carrier_id = 3700000301')).rows[0];
  assert.equal(row.name, 'Aurora Borealis');
  assert.equal(row.name_source, 'visit');

  const after = await mod.registry.setCarrierName(api, VISITOR, '3700000301', 'Aurora Borealis II');
  assert.equal(after.ok, true);
  row = (await db.query('SELECT name, name_source FROM carrier_directory WHERE carrier_id = 3700000301')).rows[0];
  assert.equal(row.name, 'Aurora Borealis II');
});

test('имя владельца из CarrierStats перекрывает имя, увиденное посетителем', async () => {
  const api = await rpcClient();
  await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump', MarketID: 3700000303, StationName: 'V1S-303', StarSystem: 'Sol',
    StarPos: [0, 0, 0], timestamp: new Date().toISOString(),
  });
  await mod.registry.applyCarrierSightings(api, VISITOR, [
    { event: 'Docked', MarketID: 3700000303, StationName: 'Visitor Guess', timestamp: new Date().toISOString() },
  ]);
  // Владельца записывает учёт сайта (`apply_fleet_carrier_batch`) — и только
  // после этого имя из `CarrierStats` проходит проверку прав.
  await db.exec(`INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, owner_id, system_name, location_at)
    VALUES (3700000303, 'FleetCarrier', 'V1S-303', '${BOSS}', 'Sol', now())
    ON CONFLICT (carrier_id) DO UPDATE SET owner_id = EXCLUDED.owner_id`);
  const fromStranger = await mod.registry.setCarrierName(api, STRANGER, '3700000303', 'Not Mine');
  assert.equal(fromStranger.ok, false, 'CarrierStats без права владения — отказ');
  await mod.registry.applyCarrierSightings(api, BOSS, [
    { event: 'CarrierStats', CarrierID: 3700000303, Name: 'Real Name', timestamp: new Date().toISOString() },
  ]);
  const row = (await db.query('SELECT name, name_source FROM carrier_directory WHERE carrier_id = 3700000303')).rows[0];
  assert.equal(row.name, 'Real Name');
  assert.equal(row.name_source, 'owner');
});

test('повторное наблюдение EDDN не стирает уточнённое имя', async () => {
  const api = await rpcClient();
  const applied = await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump', MarketID: 3700000301, StationName: 'K7Q-BQL', StarSystem: 'Lave',
    StarPos: [75, 48, -12], timestamp: new Date().toISOString(),
  });
  assert.equal(applied, true);
  const row = (await db.query('SELECT name, system_name FROM carrier_directory WHERE carrier_id = 3700000301')).rows[0];
  assert.equal(row.name, 'Aurora Borealis II', 'имя человека неприкосновенно');
  assert.equal(row.system_name, 'Lave', 'локация обновилась');
});

test('поиск Атласа: реестр EDDN дополняет учёт сайта по MarketID', async () => {
  const api = await rpcClient();
  await mod.registry.applyEddnCarrierMessage(api, {
    event: 'CarrierJump', MarketID: 3700000201, StationName: 'OWN-201', StarSystem: 'Shinrarta Dezhra',
    StarPos: [55.7, 17.6, 27.4], timestamp: new Date().toISOString(),
  });
  await mod.registry.setCarrierName(api, OWNER, '3700000201', 'Owner Depot');

  const byCallsign = await mod.map.searchMapCarriers(api, VISITOR, { query: 'k7q-bql' });
  assert.equal(byCallsign.carriers.length, 1);
  assert.equal(byCallsign.carriers[0].id, '3700000301');
  assert.equal(byCallsign.carriers[0].origin, 'eddn', 'запись только из реестра');
  assert.equal(byCallsign.carriers[0].relation, 'other');
  assert.equal(byCallsign.carriers[0].owner, null, 'владельца реестр не знает и не выдумывает');

  // Носитель сайта подтягивает имя из реестра — это имя дал владелец.
  const own = await mod.map.searchMapCarriers(api, OWNER, { query: 'own-201' });
  assert.equal(own.carriers[0].origin, 'site');
  assert.equal(own.carriers[0].name, 'Owner Depot');

  // Поиск по имени, которое дал человек, тоже работает.
  const byName = await mod.map.searchMapCarriers(api, VISITOR, { query: 'aurora borealis' });
  assert.ok(byName.carriers.some((carrier) => carrier.id === '3700000301'));
});

test('воркер EDDN: из журнала отправляет только прыжки авианосцев', async () => {
  const worker = await import(await bundleFile({ entrySource: `export { wantsEddnPayload } from '@/lib/eddn/subscriber';` }));
  const envelope = (schema, message) => ({ $schemaRef: schema, message });
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/commodity/3', { commodities: [] })), true);
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/outfitting/2', { modules: [] })), true);
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/journal/1', { event: 'CarrierJump', MarketID: 3700000101 })), true);
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/journal/1', { event: 'FSDJump' })), false);
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/journal/1', { event: 'Docked' })), false);
  assert.equal(worker.wantsEddnPayload(envelope('https://eddn.edcd.io/schemas/journal/1/test', { event: 'CarrierJump' })), false);
  assert.equal(worker.wantsEddnPayload({}), false);
});

/* ── Маршрут EDDN ────────────────────────────────────────────────────────── */

const ingest = await import(await bundleFile({
  entrySource: `
export * as ingest from '@/app/api/eddn/ingest/route';
export { state as ingestState } from '@/lib/supabaseServer';
`,
  stubs: {
    'next/server': 'export const NextResponse = { json: (body, init) => ({ body, status: (init && init.status) || 200 }) };',
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/galaxySystemsDb': 'export const findSystemByName = async () => ({ x: 0, y: 0, z: 0 });',
  },
}));

// Свой экземпляр заглушки у каждого бандла: клиент ведёт к той же базе PGlite.
ingest.ingestState.db = db;

const eddnRequest = (payload, secret = 'test-secret') => new Request('http://test.local/api/eddn/ingest', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-eddn-secret': secret },
  body: JSON.stringify(payload),
});

test('маршрут EDDN: journal/CarrierJump попадает в реестр, остальной журнал — нет', async () => {
  const previous = process.env.EDDN_INGEST_SECRET;
  process.env.EDDN_INGEST_SECRET = 'test-secret';
  try {
    assert.equal((await ingest.ingest.POST(eddnRequest({ $schemaRef: 'https://eddn.edcd.io/schemas/journal/1', message: {
      event: 'CarrierJump', MarketID: 3700000401, StationName: 'JRN-401', StarSystem: 'Sol',
      StarPos: [0, 0, 0], timestamp: new Date().toISOString(),
    } }, 'wrong'))).status, 401);

    const ok = await ingest.ingest.POST(eddnRequest({ $schemaRef: 'https://eddn.edcd.io/schemas/journal/1', message: {
      event: 'CarrierJump', MarketID: 3700000401, StationName: 'JRN-401', StarSystem: 'Sol',
      StarPos: [0, 0, 0], timestamp: new Date().toISOString(),
    } }));
    assert.equal(ok.status, 200);
    assert.equal(ok.body.kind, 'carrier');
    assert.equal(ok.body.stored, true);
    const { rows } = await db.query('SELECT callsign, name FROM carrier_directory WHERE carrier_id = 3700000401');
    assert.equal(rows[0].callsign, 'JRN-401');
    assert.equal(rows[0].name, null);

    // Остальные события журнала реестру не нужны и станционным отчётом не считаются.
    assert.equal((await ingest.ingest.POST(eddnRequest({ $schemaRef: 'https://eddn.edcd.io/schemas/journal/1', message: {
      event: 'FSDJump', StarSystem: 'Sol', StarPos: [0, 0, 0], timestamp: new Date().toISOString(),
    } }))).status, 400);

    // Тестовая схема не должна ничего писать.
    assert.equal((await ingest.ingest.POST(eddnRequest({ $schemaRef: 'https://eddn.edcd.io/schemas/journal/1/test', message: {
      event: 'CarrierJump', MarketID: 3700000402, StationName: 'JRN-402', StarSystem: 'Sol',
      StarPos: [0, 0, 0], timestamp: new Date().toISOString(),
    } }))).status, 200);
    const test = await db.query('SELECT 1 FROM carrier_directory WHERE carrier_id = 3700000402');
    assert.equal(test.rows.length, 0);
  } finally {
    if (previous == null) delete process.env.EDDN_INGEST_SECRET;
    else process.env.EDDN_INGEST_SECRET = previous;
  }
});
