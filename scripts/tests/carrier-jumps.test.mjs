/**
 * «Авианосцы перед прыжком» (`/carriers/jumps`).
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierJumps.ts`) — «готовится к прыжку»,
 *      дистанция, сравнение живого плана со снимком подписки, порядок таблицы,
 *      поиск и нормализация снимка: ими живут и страница, и маршрут;
 *   2. `GET /api/carriers/jumps` на настоящем PostgreSQL: в ответ попадают
 *      только несостоявшиеся заказы, ближайший вылет сверху, уже прибывшие и
 *      старые заказы отбрасываются, ответ не кэшируется;
 *   3. `/api/atlas/carriers/watch` хранит снимок плана: подписка пишет
 *      `jump_*`, обычное избранное их не затирает, снятие подписки очищает.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server`, `next/headers` и
 * `@/lib/supabaseServer`; запросы идут в PGlite с настоящими миграциями.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  JUMP_LOOKBACK_MS,
  JUMP_PLAN_DRIFT_MS,
  buildJumpBoard,
  buildJumpWatchRows,
  isJumpPending,
  jumpDistanceLy,
  jumpPlanView,
  jumpSnapshot,
  matchesJumpQuery,
} from '../../src/lib/carrierJumps.ts';
import { localCarrierWatch } from '../../src/lib/carrierDirectory.ts';
import { WATCH_COLUMNS, watchFromRow, watchToRow } from '../../src/lib/carrierWatch.ts';
import { pgliteClient } from './helpers/pgliteSupabase.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const PILOT = '00000000-0000-4000-8000-0000000000b1';
const OTHER = '00000000-0000-4000-8000-0000000000b2';
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const MIN = 60_000;

const FC = {
  soon: '3800000301',
  later: '3800000302',
  noTime: '3800000303',
  jumping: '3800000304',
  arrived: '3800000305',
  old: '3800000306',
  idle: '3800000307',
};

/** Носитель в том виде, в каком его отдаёт маршрут карты. */
function carrier(overrides = {}) {
  return {
    id: '1',
    type: 'FleetCarrier',
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    relation: 'other',
    owner: null,
    ownerHidden: false,
    squadron: null,
    system: 'Sol',
    body: null,
    position: { x: 0, y: 0, z: 0 },
    locationAt: new Date(NOW).toISOString(),
    estimated: false,
    previousSystem: null,
    jump: {
      system: 'Lave',
      departureAt: new Date(NOW + 20 * MIN).toISOString(),
      state: 'scheduled',
      position: { x: 75.75, y: 48.75, z: -12.5 },
    },
    docking: null,
    notorious: null,
    services: [],
    decommission: false,
    origin: 'site',
    ...overrides,
  };
}

/* ── чистые правила ──────────────────────────────────────────────────────── */

test('«готовится к прыжку»: будущий и недавний заказ — да, старый и пустой — нет', () => {
  assert.equal(isJumpPending(carrier(), NOW), true);
  assert.equal(isJumpPending(carrier({ jump: null }), NOW), false);
  const late = carrier({ jump: { ...carrier().jump, departureAt: new Date(NOW - 29 * MIN).toISOString() } });
  assert.equal(isJumpPending(late, NOW), true, 'полчаса назад — ещё «в прыжке»');
  const stale = carrier({ jump: { ...carrier().jump, departureAt: new Date(NOW - 45 * MIN).toISOString() } });
  assert.equal(isJumpPending(stale, NOW), false);
  const unknown = carrier({ jump: { ...carrier().jump, departureAt: null } });
  assert.equal(isJumpPending(unknown, NOW), true, 'без времени заказ всё равно заказ');
  assert.equal(JUMP_LOOKBACK_MS, 30 * MIN);
});

test('дистанция прыжка: координаты Elite — уже световые годы', () => {
  assert.equal(jumpDistanceLy({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0 }), 5);
  assert.equal(jumpDistanceLy({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), 1.41);
  assert.equal(jumpDistanceLy(null, { x: 1, y: 1, z: 1 }), null);
  assert.equal(jumpDistanceLy({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }), 1.41, 'округление до сотых');
  assert.equal(jumpDistanceLy({ x: 0, y: 0, z: 0 }, { x: 3, y: 4, z: 0.0001 }), 5, 'мусор в хвосте не мешает');
});

test('план подписки: none / same / changed / arrived / gone', () => {
  const snapshot = { jumpSystem: 'Lave', jumpDepartureAt: new Date(NOW + 20 * MIN).toISOString() };
  assert.equal(jumpPlanView(null, carrier()).state, 'none');
  assert.equal(jumpPlanView(snapshot, carrier()).state, 'same');
  // Время уточнили на полминуты — это тот же план.
  const drifted = { ...snapshot, jumpDepartureAt: new Date(NOW + 20 * MIN + 30_000).toISOString() };
  assert.equal(jumpPlanView(drifted, carrier()).state, 'same');
  assert.equal(JUMP_PLAN_DRIFT_MS, MIN);
  const rescheduled = { ...snapshot, jumpDepartureAt: new Date(NOW + 40 * MIN).toISOString() };
  assert.equal(jumpPlanView(rescheduled, carrier()).state, 'changed');
  const retarget = { ...snapshot, jumpSystem: 'Alioth' };
  assert.equal(jumpPlanView(retarget, carrier()).state, 'changed');

  const arrived = jumpPlanView(snapshot, { jump: null, system: 'Lave' });
  assert.equal(arrived.state, 'arrived');
  const gone = jumpPlanView(snapshot, { jump: null, system: 'Sol' });
  assert.equal(gone.state, 'gone');
  assert.equal(arrived.to, null);
  assert.equal(arrived.from, 'Lave');
});

test('таблица: только заказы, ближайший вылет сверху, личная запись приложена', () => {
  const watch = localCarrierWatch({
    carrierId: '2',
    callsign: 'STE-777',
    name: null,
    system: 'Lave',
    favorite: true,
    note: null,
    jumpSystem: 'Sol',
    jumpDepartureAt: new Date(NOW + 10 * MIN).toISOString(),
    jumpSeenAt: new Date(NOW).toISOString(),
  });
  const rows = buildJumpBoard([
    carrier({ id: '1', callsign: 'K7Q-BQL', jump: { ...carrier().jump, departureAt: new Date(NOW + 20 * MIN).toISOString() } }),
    carrier({ id: '2', callsign: 'STE-777', name: null, system: 'Lave', jump: { system: 'Sol', departureAt: new Date(NOW + 10 * MIN).toISOString(), state: 'scheduled', position: { x: 0, y: 0, z: 0 } } }),
    carrier({ id: '3', callsign: 'NON-000', jump: { ...carrier().jump, departureAt: null } }),
    carrier({ id: '4', callsign: 'IDL-000', jump: null }),
  ], { now: NOW, watches: [watch] });

  assert.deepEqual(rows.map((row) => row.id), ['2', '1', '3'], 'без времени — в конце');
  assert.equal(rows[0].plan.state, 'same');
  assert.equal(rows[0].watch?.carrierId, '2');
  assert.equal(rows[0].label, 'STE-777', 'имени нет — подпись по позывному');
  assert.equal(rows[1].plan.state, 'none');
  assert.ok(rows[1].distanceLy > 90, 'координаты цели дают дистанцию');
  assert.equal(buildJumpBoard([carrier()], { now: NOW, limit: 0 }).length, 0);
});

test('поиск по таблице: позывной, имя, обе системы и MarketID', () => {
  const row = buildJumpBoard([carrier()], { now: NOW })[0];
  assert.ok(matchesJumpQuery(row, ''));
  assert.ok(matchesJumpQuery(row, 'k7q'));
  assert.ok(matchesJumpQuery(row, 'hippione'));
  assert.ok(matchesJumpQuery(row, 'sol lave'));
  assert.ok(matchesJumpQuery(row, '1'));
  assert.ok(!matchesJumpQuery(row, 'alioth'));
  assert.ok(!matchesJumpQuery(row, 'k7q alioth'), 'все слова обязаны найтись');
});

test('снимок подписки: пишем только то, что передали, и не верим мусору', () => {
  assert.equal(jumpSnapshot({}, NOW), null, 'обычное избранное снимок не трогает');
  const snap = jumpSnapshot({ jumpSystem: ' Lave ', jumpDepartureAt: new Date(NOW + 15 * MIN).toISOString() }, NOW);
  assert.equal(snap.jumpSystem, 'Lave');
  assert.equal(snap.jumpDepartureAt, new Date(NOW + 15 * MIN).toISOString());
  assert.equal(snap.jumpSeenAt, new Date(NOW).toISOString());

  const garbage = jumpSnapshot({ jumpSystem: 'Lave', jumpDepartureAt: 'не дата' }, NOW);
  assert.equal(garbage.jumpSystem, 'Lave');
  assert.equal(garbage.jumpDepartureAt, null);

  const farFuture = jumpSnapshot({ jumpDepartureAt: new Date(NOW + 48 * 60 * MIN).toISOString() }, NOW);
  assert.equal(farFuture.jumpDepartureAt, null, 'дата из будущего дальше суток — мусор');

  const cleared = jumpSnapshot({ jumpSystem: null, jumpDepartureAt: null }, NOW);
  assert.deepEqual([cleared.jumpSystem, cleared.jumpDepartureAt], [null, null]);
});

test('запись в базу: снимок прыжка не появляется сам по себе', () => {
  const plain = watchToRow({
    carrierId: '42', callsign: 'K7Q-BQL', name: null, system: 'Sol', favorite: true, note: null, userId: PILOT,
  });
  for (const key of Object.keys(plain)) assert.ok(!key.startsWith('jump_'), `лишняя колонка ${key}`);
  assert.ok(WATCH_COLUMNS.includes('jump_system_name'));

  const withJump = watchToRow({
    carrierId: '42',
    callsign: 'K7Q-BQL',
    name: null,
    system: 'Sol',
    favorite: true,
    note: null,
    userId: PILOT,
    jumpSystem: 'Lave',
    jumpDepartureAt: new Date(NOW + MIN).toISOString(),
    jumpSeenAt: new Date(NOW).toISOString(),
  });
  assert.equal(withJump.jump_system_name, 'Lave');
  // Драйвер может вернуть Date — наружу всё равно уходит ISO.
  const parsed = watchFromRow({
    id: '7',
    carrier_id: '42',
    jump_system_name: 'Lave',
    jump_departure_at: new Date(NOW + MIN),
    jump_seen_at: new Date(NOW),
  });
  assert.equal(parsed.jumpDepartureAt, new Date(NOW + MIN).toISOString());
  assert.equal(parsed.jumpSeenAt, new Date(NOW).toISOString());
});

test('«мои подписки»: без живого плана остаётся снимок, порядок — по времени', () => {
  const rows = buildJumpBoard([carrier({ id: '1' })], { now: NOW });
  const watches = [
    localCarrierWatch({
      carrierId: '9', callsign: 'GON-999', name: 'Lost', system: 'Sol', favorite: true, note: null,
      jumpSystem: 'Alioth', jumpDepartureAt: new Date(NOW + 90 * MIN).toISOString(), jumpSeenAt: new Date(NOW).toISOString(),
    }),
    localCarrierWatch({
      carrierId: '1', callsign: 'K7Q-BQL', name: 'Hippione', system: 'Sol', favorite: true, note: null,
      jumpSystem: 'Lave', jumpDepartureAt: new Date(NOW + 20 * MIN).toISOString(), jumpSeenAt: new Date(NOW).toISOString(),
    }),
    // Обычное избранное без снимка в «подписки» не попадает.
    localCarrierWatch({ carrierId: '5', callsign: 'FAV-000', name: null, system: 'Sol', favorite: true, note: null }),
  ];
  const list = buildJumpWatchRows(watches, rows);
  assert.deepEqual(list.map((row) => row.watch.carrierId), ['1', '9']);
  assert.equal(list[0].live?.id, '1');
  assert.equal(list[0].plan.state, 'same');
  assert.equal(list[1].live, null);
  assert.equal(list[1].plan.state, 'gone', 'заказа больше нет и система не та');
});

/* ── маршруты на PostgreSQL ──────────────────────────────────────────────── */

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json', ...((init && init.headers) || {}) },
  }),
};
`;

const NEXT_HEADERS_STUB = `
export async function cookies() {
  // Вне запроса Next cookie недоступны — apiTranslate уходит на русский текст.
  throw new Error('no request scope');
}
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
export * as jumps from '@/app/api/carriers/jumps/route';
export * as watch from '@/app/api/atlas/carriers/watch/route';
export { state } from '@/lib/supabaseServer';
export { JUMP_ROWS_LIMIT, loadCarrierJumps } from '@/lib/carrierMapStore';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${PILOT}'), ('${OTHER}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name, privacy_settings) VALUES
  ('${PILOT}', 'Pilot One', NULL), ('${OTHER}', 'Pilot Two', NULL);
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
CREATE TABLE public.galaxy_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, name_lc text UNIQUE, x float8 NOT NULL, y float8 NOT NULL, z float8 NOT NULL);
INSERT INTO public.galaxy_systems(name, name_lc, x, y, z) VALUES
  ('Sol', 'sol', 0, 0, 0), ('Lave', 'lave', 75.75, 48.75, -12.5), ('Alioth', 'alioth', -33.65, 72.47, -20.66);
`);
for (const file of [
  '20261017000000_fleet_carriers.sql',
  '20261107090000_atlas_carrier_watch.sql',
  '20261110190000_carrier_watch_jump.sql',
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, system_name, x, y, z, location_at,
    docking_access, pending_decommission, services,
    jump_system_name, jump_departure_at, jump_requested_at) VALUES
  (${FC.soon}, 'FleetCarrier', 'K7Q-BQL', 'Hippione', '${PILOT}', 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    'Lave', now() + interval '20 minutes', now()),
  (${FC.later}, 'FleetCarrier', 'STE-777', 'Steel Barge', NULL, 'Lave', 75.75, 48.75, -12.5, now(), 'all', false, '[]',
    'Sol', now() + interval '2 hours', now()),
  (${FC.noTime}, 'FleetCarrier', 'NON-000', 'No Time', NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    'Alioth', NULL, now()),
  (${FC.jumping}, 'FleetCarrier', 'JMP-001', 'In Transit', NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    'Lave', now() - interval '2 minutes', now()),
  (${FC.arrived}, 'FleetCarrier', 'ARR-002', 'Arrived', NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    'Lave', now() - interval '10 minutes', now()),
  (${FC.old}, 'FleetCarrier', 'OLD-003', 'Forgotten Order', NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    'Lave', now() - interval '3 hours', now()),
  (${FC.idle}, 'FleetCarrier', 'IDL-004', 'Idle', NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]',
    NULL, NULL, NULL);
`);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    'next/headers': NEXT_HEADERS_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

// Цели прыжков есть в реестре систем — EDSM не нужен. Если запрос уйдёт, тест увидит.
const outbound = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  outbound.push(String(url));
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};

test.after(async () => {
  globalThis.fetch = previousFetch;
  await db.close();
});

async function jumpsApi(userId = null) {
  mod.state.userId = userId;
  const response = await mod.jumps.GET(new Request('http://localhost/api/carriers/jumps'));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

async function watchApi(method, { body, carrierId } = {}, userId = PILOT) {
  mod.state.userId = userId;
  const query = carrierId ? `?carrierId=${encodeURIComponent(carrierId)}` : '';
  const request = new Request(`http://localhost/api/atlas/carriers/watch${query}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const response = await mod.watch[method](request);
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text) };
}

test('маршрут: только несостоявшиеся заказы, ближайший вылет сверху', async () => {
  outbound.length = 0;
  const response = await jumpsApi();
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.viewer.signedIn, false);
  assert.equal(response.body.truncated, false);

  const ids = response.body.carriers.map((row) => row.id);
  assert.deepEqual(ids, [FC.jumping, FC.soon, FC.later, FC.noTime]);
  assert.ok(!ids.includes(FC.arrived), 'носитель уже в прыжке дольше пяти минут — это не «перед прыжком»');
  assert.ok(!ids.includes(FC.old), 'заказ трёхчасовой давности не показываем');
  assert.ok(!ids.includes(FC.idle), 'без заказа в таблицу не попадает');
  assert.equal(response.body.total, 4);

  const soon = response.body.carriers.find((row) => row.id === FC.soon);
  assert.equal(soon.jump.system, 'Lave');
  assert.equal(soon.system, 'Sol');
  const jumping = response.body.carriers.find((row) => row.id === FC.jumping);
  assert.equal(jumping.jump.state, 'jumping');
  const noTime = response.body.carriers.find((row) => row.id === FC.noTime);
  assert.equal(noTime.jump.departureAt, null);

  for (const secret of ['finance', 'cargo', 'space_usage', 'jump_range_max']) {
    assert.ok(!response.text.includes(secret), `в ответе есть «${secret}»`);
  }
  assert.equal(outbound.length, 0, 'координаты пришли из реестра систем');
});

test('маршрут: вошедший пилот отмечен, гость — нет', async () => {
  const guest = await jumpsApi();
  assert.equal(guest.body.viewer.signedIn, false);
  const signed = await jumpsApi(PILOT);
  assert.equal(signed.body.viewer.signedIn, true);
});

test('подписка: снимок плана пишется в личную запись и виден в списке', async () => {
  const saved = await watchApi('PUT', {
    body: {
      carrierId: FC.soon,
      callsign: 'K7Q-BQL',
      name: 'Hippione',
      system: 'Sol',
      favorite: true,
      note: null,
      jumpSystem: 'Lave',
      jumpDepartureAt: new Date(NOW + 20 * MIN).toISOString(),
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.watch.jumpSystem, 'Lave');
  assert.ok(saved.body.watch.jumpDepartureAt, 'время вылета сохранено');
  assert.ok(saved.body.watch.jumpSeenAt, 'видно, когда сделан снимок');

  const list = await watchApi('GET');
  const mine = list.body.watches.find((row) => row.carrierId === FC.soon);
  assert.equal(mine.jumpSystem, 'Lave');

  // Обычное избранное Атласа не затирает подписку.
  const favorite = await watchApi('PUT', {
    body: { carrierId: FC.soon, callsign: 'K7Q-BQL', favorite: true, note: 'возит сталь' },
  });
  assert.equal(favorite.body.watch.jumpSystem, 'Lave', 'снимок остался');
  assert.equal(favorite.body.watch.note, 'возит сталь');

  // Снятие подписки очищает снимок, но запись с заметкой остаётся.
  const cleared = await watchApi('PUT', {
    body: { carrierId: FC.soon, callsign: 'K7Q-BQL', favorite: true, note: 'возит сталь', jumpSystem: null, jumpDepartureAt: null },
  });
  assert.equal(cleared.body.watch.jumpSystem, null);
  assert.equal(cleared.body.watch.jumpDepartureAt, null);
  assert.equal(cleared.body.watch.note, 'возит сталь');
});

test('подписка: чужой пилот снимок не видит и не меняет', async () => {
  await watchApi('PUT', {
    body: { carrierId: FC.later, favorite: true, jumpSystem: 'Sol', jumpDepartureAt: new Date(NOW + 2 * 60 * MIN).toISOString() },
  });
  const foreign = await watchApi('GET', {}, OTHER);
  assert.ok(!foreign.body.watches.some((row) => row.carrierId === FC.later), 'чужих записей не видно');
});

test('маршрут: лимит строк, total до обрезки и признак truncated', async () => {
  // Маршрут лимит не принимает — проверяем саму загрузку: на узком экране и в
  // тестах нужен короткий ответ, но `total` обязан остаться честным.
  const svc = pgliteClient({ db, userId: null, log: [] });
  const page = await mod.loadCarrierJumps(svc, null, { limit: 2 });
  assert.equal(mod.JUMP_ROWS_LIMIT, 200);
  assert.equal(page.total, 4);
  assert.equal(page.truncated, true);
  assert.equal(page.carriers.length, 2);
  assert.equal(page.viewer.signedIn, false);
  assert.ok(!outbound.length, 'цели прыжков нашлись в реестре систем');
});
