/**
 * «Трафик авианосцев» Atlas: поиск по реестру и личные записи пилота.
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierDirectory.ts`) — из них живёт и панель,
 *      и маршрут: запрос по позывному/имени/системе, MarketID, нормализация
 *      записи, слияние серверного и локального списка, порядок выдачи;
 *   2. `GET /api/atlas/carriers` на настоящем PostgreSQL: ищет по позывному и
 *      по имени, не отдаёт списанных и забытых, `scope=favorites` требует
 *      сессии и показывает только своё;
 *   3. `/api/atlas/carriers/watch` — персональные избранное и комментарии:
 *      гость получает 401, чужой пилот не видит и не меняет записи,
 *      повторный PUT не плодит дублей, DELETE убирает строку.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; клиент — `helpers/pgliteSupabase.mjs`, то есть
 * запросы идут в PGlite с настоящими миграциями.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  CARRIER_NOTE_MAX,
  carrierMatchesQuery,
  carrierQueryTokens,
  countFavorites,
  isFavoriteCarrier,
  localCarrierWatch,
  mergeCarrierWatches,
  normalizeCarrierWatch,
  normalizeCarrierQuery,
  orderCarrierDirectory,
  watchFor,
} from '../../src/lib/carrierDirectory.ts';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const PILOT = '00000000-0000-4000-8000-0000000000a1';
const OTHER = '00000000-0000-4000-8000-0000000000a2';

const FC = {
  trader: '3800000201',
  hauler: '3800000202',
  squadron: '3800000203',
  scrapper: '3800000204',
  forgotten: '3800000205',
  nameless: '3800000206',
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
`;

const ENTRY = `
export * as search from '@/app/api/atlas/carriers/route';
export * as watch from '@/app/api/atlas/carriers/watch/route';
export { state } from '@/lib/supabaseServer';
`;

/* ── чистые правила: те же функции, что в панели и в маршруте ────────────── */

const ROWS = [
  { id: '1', callsign: 'K7Q-BQL', name: 'Hippione', owner: 'CMDR One', system: 'Sol' },
  { id: '2', callsign: 'ABC-123', name: 'Steel Barge', owner: 'CMDR Two', system: 'Lave' },
];

test('поиск: позывной, позывной без дефиса, имя, система и MarketID', () => {
  assert.ok(carrierMatchesQuery(ROWS[0], 'k7q'));
  assert.ok(carrierMatchesQuery(ROWS[0], 'K7QBQL'), 'без дефиса тоже находится');
  assert.ok(carrierMatchesQuery(ROWS[0], 'hippione'));
  assert.ok(carrierMatchesQuery(ROWS[1], 'lave'));
  assert.ok(carrierMatchesQuery(ROWS[1], '2'), 'MarketID ищется строкой');
  assert.ok(!carrierMatchesQuery(ROWS[1], 'hippione'));
});

test('поиск: все слова обязаны найтись, пустой запрос ничего не отбрасывает', () => {
  assert.ok(carrierMatchesQuery(ROWS[1], 'abc steel'));
  assert.ok(!carrierMatchesQuery(ROWS[1], 'abc hippione'));
  assert.ok(carrierMatchesQuery(ROWS[1], '   '));
  assert.deepEqual(carrierQueryTokens('  K7Q   Steel '), ['k7q', 'steel']);
  assert.equal(normalizeCarrierQuery('  K7Q   Steel '), 'k7q steel');
});

test('запись: MarketID обязателен, заметка обрезается, поля чистятся', () => {
  assert.equal(normalizeCarrierWatch({ carrierId: 'abc' }).ok, false);
  assert.equal(normalizeCarrierWatch({}).ok, false);
  const parsed = normalizeCarrierWatch({
    carrierId: ' 42 ',
    callsign: ' K7Q ',
    name: '',
    note: 'x'.repeat(CARRIER_NOTE_MAX + 40),
  });
  assert.ok(parsed.ok);
  assert.equal(parsed.value.carrierId, '42');
  assert.equal(parsed.value.callsign, 'K7Q');
  assert.equal(parsed.value.name, null);
  assert.equal(parsed.value.note.length, CARRIER_NOTE_MAX);
  assert.equal(parsed.value.favorite, true, 'по умолчанию — в избранном');
  assert.equal(normalizeCarrierWatch({ carrierId: '42', favorite: false }).value.favorite, false);
});

test('слияние: сервер главнее, локальные записи не теряются', () => {
  const server = [localCarrierWatch({ carrierId: '1', callsign: 'S-1', name: null, system: 'Sol', favorite: true, note: 'сервер' })];
  const local = [
    localCarrierWatch({ carrierId: '1', callsign: 'S-1', name: null, system: 'Sol', favorite: false, note: 'локально' }),
    localCarrierWatch({ carrierId: '2', callsign: 'S-2', name: null, system: 'Lave', favorite: true, note: null }),
  ];
  const merged = mergeCarrierWatches(server, local);
  assert.deepEqual(merged.map((row) => row.carrierId), ['1', '2']);
  assert.equal(merged[0].note, 'сервер');
  assert.equal(isFavoriteCarrier(merged, '2'), true);
  assert.equal(watchFor(merged, 2)?.carrierId, '2');
  assert.equal(watchFor(merged, '999'), null);
});

test('порядок: избранные, затем записи с заметкой, затем по названию', () => {
  const watches = [
    localCarrierWatch({ carrierId: '2', callsign: 'ABC-123', name: null, system: 'Lave', favorite: false, note: 'возит сталь' }),
    localCarrierWatch({ carrierId: '3', callsign: 'ZZZ-999', name: null, system: 'Sol', favorite: true, note: null }),
  ];
  const rows = [
    { id: '1', callsign: 'AAA-001', name: null, owner: null, system: 'Sol' },
    { id: '2', callsign: 'ABC-123', name: null, owner: null, system: 'Lave' },
    { id: '3', callsign: 'ZZZ-999', name: null, owner: null, system: 'Sol' },
  ];
  assert.deepEqual(orderCarrierDirectory(rows, watches).map((row) => row.id), ['3', '2', '1']);
  assert.equal(countFavorites(rows, watches), 1);
});

/* ── маршруты на PostgreSQL ──────────────────────────────────────────────── */

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
`);
for (const file of ['20261017000000_fleet_carriers.sql', '20261107090000_atlas_carrier_watch.sql']) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, system_name, x, y, z, location_at,
    docking_access, pending_decommission, services) VALUES
  (${FC.trader}, 'FleetCarrier', 'K7Q-BQL', 'Hippione', '${PILOT}', 'Sol', 0, 0, 0, now(), 'all', false, '[]'),
  (${FC.hauler}, 'FleetCarrier', 'STE-777', 'Steel Barge', NULL, 'Lave', 75.75, 48.75, -12.5, now(), 'all', false, '[]'),
  (${FC.squadron}, 'SquadronCarrier', 'SQD-104', 'Wing Bank', NULL, 'Alioth', -33.65, 72.47, -20.66, now(), 'squadron', false, '[]'),
  (${FC.scrapper}, 'FleetCarrier', 'SCR-107', 'Scrapped', NULL, 'Sol', 0, 0, 0, now(), 'all', true, '[]'),
  (${FC.forgotten}, 'FleetCarrier', 'OLD-106', 'Forgotten', NULL, 'Sol', 0, 0, 0, now() - interval '40 days', 'all', false, '[]'),
  (${FC.nameless}, 'FleetCarrier', 'NON-000', NULL, NULL, 'Sol', 0, 0, 0, now(), 'all', false, '[]');
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

// EDSM: у всех тестовых систем координаты есть в реестре, поэтому запрос не
// должен уходить вовсе. Если уйдёт — тест это увидит.
const edsmCalls = [];
const previousFetch = globalThis.fetch;
globalThis.fetch = async (url) => {
  edsmCalls.push(String(url));
  return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } });
};

test.after(async () => {
  globalThis.fetch = previousFetch;
  await db.close();
});

async function search(params, userId = null) {
  mod.state.userId = userId;
  const url = `http://localhost/api/atlas/carriers?${new URLSearchParams(params)}`;
  const response = await mod.search.GET(new Request(url));
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

test('поиск: позывной без дефиса и по имени находят один и тот же носитель', async () => {
  const byCallsign = await search({ q: 'k7qbql' });
  assert.equal(byCallsign.status, 200, byCallsign.text);
  assert.equal(byCallsign.headers.get('cache-control'), 'no-store');
  assert.deepEqual(byCallsign.body.carriers.map((row) => row.id), [FC.trader]);

  const byName = await search({ q: 'hippione' });
  assert.deepEqual(byName.body.carriers.map((row) => row.id), [FC.trader]);

  const bySystem = await search({ q: 'lave' });
  assert.deepEqual(bySystem.body.carriers.map((row) => row.id), [FC.hauler]);
});

test('поиск: MarketID, списанные и забытые не показываются', async () => {
  const byId = await search({ q: FC.squadron });
  assert.deepEqual(byId.body.carriers.map((row) => row.id), [FC.squadron]);

  const all = await search({});
  const ids = all.body.carriers.map((row) => row.id);
  const scrapped = all.body.carriers.find((row) => row.id === FC.scrapper);
  assert.ok(scrapped, 'носитель со свежим флагом списания ещё существует');
  assert.equal(scrapped.decommission, true, 'флаг списания виден интерфейсу');
  assert.ok(!ids.includes(FC.forgotten), 'никем не привязанный носитель старше 30 дней выпадает из реестра');
  assert.ok(ids.includes(FC.nameless), 'безымянный носитель всё равно известен');
});

test('поиск: в ответе нет ни груза, ни финансов, ни имени владельца сверх privacy', async () => {
  const response = await search({ q: 'k7q' });
  for (const secret of ['finance', 'balance', 'carrier_balance', 'cargo', 'space_usage']) {
    assert.ok(!response.text.includes(secret), `в ответе есть «${secret}»`);
  }
  assert.equal(response.body.viewer.signedIn, false);
  // Владелец открыт: наш пилот не скрывал местоположение.
  const signed = await search({ q: 'k7q' }, PILOT);
  assert.equal(signed.body.viewer.signedIn, true);
  assert.equal(signed.body.carriers[0].relation, 'own');
});

test('избранное: гость получает 401, пилот видит только свои записи', async () => {
  const guest = await search({ scope: 'favorites' });
  assert.equal(guest.status, 401);

  await watchApi('PUT', { body: { carrierId: FC.trader, callsign: 'K7Q-BQL', name: 'Hippione', system: 'Sol', favorite: true, note: 'наш склад' } });
  const mine = await search({ scope: 'favorites' }, PILOT);
  assert.deepEqual(mine.body.carriers.map((row) => row.id), [FC.trader]);

  // Второй пилот не видит чужое избранное и не может его изменить.
  const foreign = await search({ scope: 'favorites' }, OTHER);
  assert.deepEqual(foreign.body.carriers, []);
  const hijack = await watchApi('PUT', { body: { carrierId: FC.trader, favorite: false } }, OTHER);
  assert.equal(hijack.status, 200);
  const afterHijack = await search({ scope: 'favorites' }, PILOT);
  assert.deepEqual(afterHijack.body.carriers.map((row) => row.id), [FC.trader], 'чужой PUT не тронул запись пилота');
});

test('личные записи: PUT не плодит дублей, DELETE убирает строку, гость — 401', async () => {
  const guest = await watchApi('PUT', { body: { carrierId: FC.hauler, favorite: true } }, null);
  assert.equal(guest.status, 401);
  const guestList = await watchApi('GET', {}, null);
  assert.equal(guestList.status, 401);

  const first = await watchApi('PUT', { body: { carrierId: FC.hauler, callsign: 'STE-777', name: 'Steel Barge', system: 'Lave', favorite: true } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.watch.favorite, true);
  const second = await watchApi('PUT', { body: { carrierId: FC.hauler, callsign: 'STE-777', favorite: false, note: 'переехал' } });
  assert.equal(second.body.watch.favorite, false);
  assert.equal(second.body.watch.note, 'переехал');

  const list = await watchApi('GET', {});
  const mine = list.body.watches.filter((row) => row.carrierId === FC.hauler);
  assert.equal(mine.length, 1, 'повторный PUT обновил строку, а не добавил вторую');

  const removed = await watchApi('DELETE', { carrierId: FC.hauler });
  assert.equal(removed.status, 200);
  const after = await watchApi('GET', {});
  assert.ok(!after.body.watches.some((row) => row.carrierId === FC.hauler));

  const invalid = await watchApi('DELETE', { carrierId: 'not-a-market-id' });
  assert.equal(invalid.status, 400);
});

test('личные записи: без сессии ничего не пишется и EDSM не дёргается зря', async () => {
  edsmCalls.length = 0;
  await search({ q: 'k7q' });
  assert.equal(edsmCalls.length, 0, 'координаты систем пришли из реестра, EDSM не нужен');
});
