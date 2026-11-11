/**
 * Каталог авианосцев (`/carriers`).
 *
 * Что проверяется:
 *   1. чистые правила (`src/lib/carrierCatalog.ts`): очистка поиска, разбор
 *      адреса, сборка ссылок, окно страниц, строка базы → строка таблицы;
 *   2. маршрут `GET /api/carriers/directory` на настоящем PostgreSQL (PGlite) с
 *      миграциями авианосцев: объединение учёта сайта и реестра EDDN без
 *      дублей, поиск (в том числе слитным позывным), фильтры, три порядка,
 *      пагинация, «страница за концом списка», «мои и эскадрильи», отсутствие
 *      груза, финансов и имени владельца в ответе;
 *   3. миграция идемпотентна, а без функции маршрут отвечает 503, а не падает.
 *
 * Маршрут собирается esbuild'ом с подменой `next/server` и
 * `@/lib/supabaseServer`; запросы идут в PGlite по настоящим миграциям.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';
import {
  CARRIER_CATALOG_PAGE_SIZE,
  catalogApiHref,
  catalogClampPage,
  catalogHref,
  catalogJumpState,
  catalogPageCount,
  catalogPageNumber,
  catalogPageRange,
  catalogPageWindow,
  catalogQueryString,
  catalogRowFromRow,
  catalogSort,
  normalizeCatalogSearch,
  parseCatalogState,
} from '../../src/lib/carrierCatalog.ts';

/* ── чистые правила ─────────────────────────────────────────────────────── */

test('поиск: служебные символы LIKE и PostgREST выкидываются, регистр не важен', () => {
  assert.equal(normalizeCatalogSearch('  K7Q-BQL  '), 'k7q-bql');
  assert.equal(normalizeCatalogSearch('100%_\\'), '100');
  assert.equal(normalizeCatalogSearch('"Sol", (Lave);'), 'sol lave');
  assert.equal(normalizeCatalogSearch('  a   b  '), 'a b');
  assert.equal(normalizeCatalogSearch('x'.repeat(200)).length, 60);
  assert.equal(normalizeCatalogSearch(null), '');
  assert.equal(normalizeCatalogSearch(3800000001), '3800000001');
  assert.equal(normalizeCatalogSearch('Таб\tи\u0000перевод'), 'таб и перевод');
});

test('адрес: мусор в номере страницы и неизвестные значения фильтров — умолчания', () => {
  const state = parseCatalogState('?q=K7Q&origin=eddn&scope=mine&jump=planned&sort=name&page=4');
  assert.deepEqual(state, { q: 'k7q', origin: 'eddn', scope: 'mine', jump: 'planned', sort: 'name', page: 4 });

  const broken = parseCatalogState('?origin=whatever&scope=my&jump=gone&sort=abc&page=-3');
  assert.deepEqual(broken, { q: '', origin: 'all', scope: 'all', jump: 'all', sort: 'recent', page: 1 });

  assert.equal(catalogPageNumber('12'), 12);
  assert.equal(catalogPageNumber('3.9'), 3);
  assert.equal(catalogPageNumber(undefined), 1);
  assert.equal(catalogSort('SYSTEM'), 'system');
  assert.deepEqual(parseCatalogState(''), { q: '', origin: 'all', scope: 'all', jump: 'all', sort: 'recent', page: 1 });
  assert.deepEqual(parseCatalogState(null), { q: '', origin: 'all', scope: 'all', jump: 'all', sort: 'recent', page: 1 });
});

test('ссылки: умолчания в адрес не попадают, порядок параметров постоянный', () => {
  assert.equal(catalogQueryString({}), '');
  assert.equal(catalogHref({}), '/carriers');
  assert.equal(
    catalogQueryString({ q: 'K7Q BQL', origin: 'eddn', scope: 'mine', jump: 'planned', sort: 'name', page: 3 }),
    'q=k7q+bql&origin=eddn&scope=mine&jump=planned&sort=name&page=3',
  );
  assert.equal(catalogQueryString({ q: '  ', origin: 'all', page: 1 }), '');
  assert.equal(catalogApiHref({ q: 'steel' }), '/api/carriers/directory?q=steel');
  assert.equal(catalogApiHref({}, 20), '/api/carriers/directory?pageSize=20');
});

test('страницы: количество, ограничение и окно номеров с разделителями', () => {
  assert.equal(catalogPageCount(0), 1);
  assert.equal(catalogPageCount(50), 1);
  assert.equal(catalogPageCount(51), 2);
  assert.equal(catalogPageCount(1234, 50), 25);
  assert.equal(catalogClampPage(999, 25), 25);
  assert.equal(catalogClampPage(0, 25), 1);

  assert.deepEqual(catalogPageWindow(1, 1), [1]);
  assert.deepEqual(catalogPageWindow(1, 20), [1, 2, 0, 20]);
  assert.deepEqual(catalogPageWindow(10, 20), [1, 0, 9, 10, 11, 0, 20]);
  assert.deepEqual(catalogPageWindow(20, 20), [1, 0, 19, 20]);
  assert.deepEqual(catalogPageWindow(999, 20), [1, 0, 19, 20], 'страница за концом прижимается к последней');

  assert.deepEqual(catalogPageRange(1, 50, 0), { from: 0, to: 0 });
  assert.deepEqual(catalogPageRange(1, 50, 120), { from: 1, to: 50 });
  assert.deepEqual(catalogPageRange(3, 50, 120), { from: 101, to: 120 });
  assert.deepEqual(catalogPageRange(99, 50, 120), { from: 101, to: 120 });
});

test('строка таблицы: службы двух форматов, заказ прыжка и мусор', () => {
  const now = Date.parse('2026-11-16T12:00:00.000Z');
  const row = catalogRowFromRow({
    carrier_id: 3800000901,
    callsign: 'K7Q-BQL',
    name: 'Hippione',
    carrier_type: 'SquadronCarrier',
    origin: 'eddn',
    system_name: 'Sol',
    body_name: 'Earth',
    x: 0,
    y: 0,
    z: 0,
    relation: 'squadron',
    decommission: true,
    jump_system_name: 'Lave',
    jump_departure_at: '2026-11-16T11:00:00.000+00:00',
    docking_access: 'all',
    allow_notorious: false,
    services: [
      { role: 'Refuel', activated: true, enabled: true },
      { role: 'Shipyard', activated: true, enabled: false },
    ],
    sightings: 12,
    seen_at: '2026-11-16T10:00:00.000+00:00',
    updated_at: '2026-11-16T10:30:00.000+00:00',
    owner_id: '00000000-0000-4000-8000-0000000000ff',
    squadron_id: 1,
  }, now);
  assert.equal(row.id, '3800000901');
  assert.equal(row.type, 'SquadronCarrier');
  assert.equal(row.origin, 'eddn');
  assert.equal(row.relation, 'squadron');
  assert.equal(row.services.active, 1, 'служба на паузе не считается работающей');
  assert.equal(row.services.total, 2);
  assert.equal(row.jump.state, 'jumping', 'время вылета прошло — носитель в прыжке');
  assert.equal(row.docking, 'все пилоты');
  assert.equal(row.seenAt, '2026-11-16T10:00:00.000Z');
  assert.equal(row.updatedAt, '2026-11-16T10:30:00.000Z');
  assert.deepEqual(row.position, { x: 0, y: 0, z: 0 });
  assert.equal('owner' in row, false, 'имени владельца в строке каталога нет');

  const registry = catalogRowFromRow({
    carrier_id: '3800000902',
    origin: 'eddn',
    services: ['commodities', 'pioneersupplies'],
    sightings: 3,
  }, now);
  assert.equal(registry.origin, 'eddn');
  assert.equal(registry.services.total, 2);
  assert.equal(registry.jump, null);
  assert.equal(registry.docking, null);
  assert.equal(registry.position, null);

  const stationOnly = catalogRowFromRow({
    carrier_id: '3800000903',
    services: [],
    station_services: ['refuel', 'repair'],
  }, now);
  assert.equal(stationOnly.services.total, 2, 'пустые службы экипажа уступают списку станции');

  assert.equal(catalogRowFromRow(null), null);
  assert.equal(catalogRowFromRow({ carrier_id: 'abc' }), null, 'MarketID — только цифры');
  assert.equal(catalogRowFromRow({}), null);

  assert.equal(catalogJumpState(null), null);
  assert.equal(catalogJumpState('не дата'), null);
  assert.equal(catalogJumpState('2026-11-16T13:00:00.000Z', now), 'scheduled');
});

test('значок авианосцев один: тот же силуэт в меню и на всех экранах носителей', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const read = (path) => readFileSync(join(root, path), 'utf8');

  // Меню: пункт в разделе сообщества, подпись из словаря, значок — с карты.
  const sidebar = read('src/components/Sidebar.tsx');
  assert.match(sidebar, /href: '\/carriers'/);
  assert.match(sidebar, /translation: 'nav\.carriers'/);
  assert.match(sidebar, /<CarrierGlyph[^>]*className="sidebar-icon"/, 'пункт меню без значка авианосца');

  // Экраны носителей: значок `CarrierGlyph`, а не «якорь» и не самолёт.
  const screens = [
    'src/components/System/SystemOverviewSections.tsx',
    'src/components/Carriers/CarrierCardPage.tsx',
    'src/components/Carriers/CarrierDirectoryPage.tsx',
    'src/components/Atlas/AtlasCarriersPanel.tsx',
    'src/app/atlas/page.tsx',
    'src/app/carriers/page.tsx',
    'src/app/carriers/jumps/page.tsx',
  ];
  for (const file of screens) {
    const source = read(file);
    assert.match(source, /import \{ CarrierGlyph \} from '@\/components\/GalaxyMap\/CarrierGlyph'/, `${file}: нет импорта значка`);
    assert.match(source, /<CarrierGlyph/, `${file}: значок не используется`);
    assert.doesNotMatch(source, /IconAnchor/, `${file}: остался «якорь» вместо силуэта носителя`);
  }
});

/* ── маршрут на PostgreSQL ──────────────────────────────────────────────── */

const OWNER = '00000000-0000-4000-8000-0000000000e1';
const VIEWER = '00000000-0000-4000-8000-0000000000e2';

const FC = {
  own: '3800000901',
  squad: '3800000902',
  other: '3800000903',
  registry: '3800000904',
  named: '3800000905',
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
export * as route from '@/app/api/carriers/directory/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { loadCarrierCatalogPage } from '@/lib/carrierCatalogStore';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${VIEWER}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name) VALUES ('${OWNER}', 'Owner Pilot'), ('${VIEWER}', 'Viewer Pilot');
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
INSERT INTO public.squadrons(name, tag, created_by) VALUES ('Alpha Wing', 'ALP', '${OWNER}');
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
INSERT INTO public.squadron_members VALUES (1, '${VIEWER}', 10);
CREATE TABLE public.galaxy_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, name_lc text UNIQUE, x float8 NOT NULL, y float8 NOT NULL, z float8 NOT NULL);
INSERT INTO public.galaxy_systems(name, name_lc, x, y, z) VALUES ('Sol', 'sol', 0, 0, 0), ('Lave', 'lave', 75.75, 48.75, -12.5);
`);

for (const file of [
  '20261017000000_fleet_carriers.sql',
  '20261108120000_carrier_directory.sql',
  '20261110090000_carrier_directory_route.sql',
  '20261113120000_carrier_jump_history.sql',
  '20261116090000_carrier_catalog.sql',
]) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}

await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, squadron_id, system_name, body_name, x, y, z, location_at,
    docking_access, allow_notorious, services, space_usage, finance, jump_system_name, jump_departure_at, updated_at) VALUES
  (${FC.own}, 'FleetCarrier', 'OWN-201', 'Own Barge', '${VIEWER}', NULL, 'Sol', 'Earth', 0, 0, 0, now() - interval '2 hours',
    'all', false,
    '[{"role":"Refuel","activated":true,"enabled":true},{"role":"Shipyard","activated":true,"enabled":true},{"role":"Bartender","activated":true,"enabled":false}]',
    '{"cargo": 1234, "free_space": 26000}', '{"balance": 9876543}', 'Lave', now() + interval '90 minutes', now() - interval '1 hour'),
  (${FC.squad}, 'SquadronCarrier', 'SQD-301', 'Wing Bank', NULL, 1, 'Lave', NULL, 75.75, 48.75, -12.5, now() - interval '3 days',
    'squadron', true, '[{"role":"SquadronBank","activated":true,"enabled":true}]', NULL, NULL, NULL, NULL, now() - interval '3 days'),
  (${FC.other}, 'FleetCarrier', 'CRD-701', NULL, '${OWNER}', NULL, 'Sol', NULL, 0, 0, 0, now() - interval '4 hours',
    'friends', false, '[]', NULL, NULL, NULL, NULL, now() - interval '4 hours');

-- Тот же MarketID в реестре: имя из реестра дополняет пустое имя учёта сайта,
-- но система и службы остаются сайта.
INSERT INTO carrier_directory(carrier_id, callsign, name, carrier_type, system_name, body_name, x, y, z, services, updated_at, last_seen_at, sightings)
VALUES (${FC.other}, 'CRD-701', 'Named By Visitor', 'FleetCarrier', 'Shinrarta Dezhra', 'Jameson Memorial', 1, 2, 3, '["commodities"]', now(), now(), 4);
-- Носитель, которого сайт не ведёт вовсе.
INSERT INTO carrier_directory(carrier_id, callsign, name, carrier_type, system_name, body_name, x, y, z, services, updated_at, last_seen_at, sightings)
VALUES (${FC.registry}, 'REG-704', NULL, 'FleetCarrier', 'Sol', 'Mars', 0, 0, 0, '["commodities","pioneersupplies"]', now() - interval '1 day', now() - interval '1 day', 12);
INSERT INTO carrier_directory(carrier_id, callsign, carrier_type, system_name, services, updated_at, last_seen_at, sightings)
VALUES (${FC.named}, 'STE-777', 'FleetCarrier', 'Lave', '["refuel"]', now() - interval '10 days', now() - interval '10 days', 1);
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

test.after(async () => {
  await db.close();
});

async function call(userId, query = '') {
  mod.state.userId = userId;
  const response = await mod.route.GET(new Request(`http://localhost/api/carriers/directory${query}`));
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, body: JSON.parse(text) };
}

const ids = (body) => body.carriers.map((carrier) => carrier.id);

test('каталог: учёт сайта и реестр EDDN без дублей, реестр помечен', async () => {
  const response = await call(null);
  assert.equal(response.status, 200, response.text);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.body.ok, true);
  assert.equal(response.body.total, 5, 'три носителя сайта и два реестра');
  assert.equal(response.body.pages, 1);
  assert.equal(response.body.pageSize, CARRIER_CATALOG_PAGE_SIZE);
  assert.deepEqual(ids(response.body).slice().sort(), Object.values(FC).sort(), 'каждый MarketID ровно один раз');

  const other = response.body.carriers.find((carrier) => carrier.id === FC.other);
  assert.equal(other.origin, 'site');
  assert.equal(other.system, 'Sol', 'система — из учёта сайта, реестр её не подменяет');
  assert.equal(other.name, 'Named By Visitor', 'пустое имя учёта дополняется именем реестра');
  assert.equal(other.body, 'Jameson Memorial', 'тело тоже дополняется');
  assert.equal(other.relation, 'other');
  assert.equal(other.docking, 'только друзья');

  const registry = response.body.carriers.find((carrier) => carrier.id === FC.registry);
  assert.equal(registry.origin, 'eddn');
  assert.equal(registry.system, 'Sol');
  assert.equal(registry.body, 'Mars');
  assert.equal(registry.sightings, 12);
  assert.equal(registry.jump, null);
  assert.deepEqual(registry.services, { active: 2, total: 2 });
  assert.equal(registry.relation, 'other');

  for (const secret of ['1234', '26000', 'balance', '9876543', 'Owner Pilot', 'Viewer Pilot', OWNER, VIEWER]) {
    assert.ok(!response.text.includes(secret), `в каталоге есть «${secret}» — это не публичные данные`);
  }
});

test('поиск: позывной слитно, имя, система, MarketID и два слова сразу', async () => {
  const byCompact = await call(null, '?q=reg704');
  assert.deepEqual(ids(byCompact.body), [FC.registry], 'дефис в позывном не мешает слитному поиску');

  const byName = await call(null, '?q=wing%20bank');
  assert.deepEqual(ids(byName.body), [FC.squad]);

  const bySystem = await call(null, '?q=sol');
  assert.deepEqual(ids(bySystem.body).sort(), [FC.own, FC.other, FC.registry].sort());

  const byId = await call(null, `?q=${FC.named}`);
  assert.deepEqual(ids(byId.body), [FC.named]);

  const twoWords = await call(null, '?q=own%20sol');
  assert.deepEqual(ids(twoWords.body), [FC.own], 'слова проверяются по отдельности, а не как фраза');

  const empty = await call(null, '?q=nothing-like-this');
  assert.equal(empty.body.total, 0);
  assert.deepEqual(empty.body.carriers, []);
  assert.equal(empty.body.pages, 1);
});

test('фильтры: источник, заказ прыжка и «мои и эскадрильи»', async () => {
  const registry = await call(null, '?origin=eddn');
  assert.deepEqual(ids(registry.body).sort(), [FC.registry, FC.named].sort());
  assert.ok(registry.body.carriers.every((carrier) => carrier.origin === 'eddn'));

  const site = await call(null, '?origin=site');
  assert.deepEqual(ids(site.body).sort(), [FC.own, FC.squad, FC.other].sort());

  const planned = await call(null, '?jump=planned');
  assert.deepEqual(ids(planned.body), [FC.own], 'заказ прыжка есть только у своего носителя');
  assert.equal(planned.body.carriers[0].jump.system, 'Lave');
  assert.equal(planned.body.carriers[0].jump.state, 'scheduled');

  const mine = await call(VIEWER, '?scope=mine');
  assert.deepEqual(ids(mine.body).sort(), [FC.own, FC.squad].sort(), 'свой носитель и эскадрильи');
  const own = mine.body.carriers.find((carrier) => carrier.id === FC.own);
  assert.equal(own.relation, 'own');
  const squad = mine.body.carriers.find((carrier) => carrier.id === FC.squad);
  assert.equal(squad.relation, 'squadron');

  const guestMine = await call(null, '?scope=mine');
  assert.equal(guestMine.body.total, 5, 'у гостя «мои» не существует — фильтр не сужает список');

  const ownerMine = await call(OWNER, '?scope=mine');
  assert.deepEqual(ids(ownerMine.body), [FC.other], 'чужой пилот видит только свои носители');
});

test('порядок: свежие, по имени, по системе', async () => {
  const recent = await call(null);
  const recentSeen = recent.body.carriers.map((carrier) => carrier.seenAt);
  assert.deepEqual([...recentSeen].sort((a, b) => (a < b ? 1 : -1)), recentSeen, 'свежие наблюдения сверху');
  assert.equal(recent.body.carriers[0].id, FC.own, 'его видели последним');

  const byName = await call(null, '?sort=name');
  const names = byName.body.carriers.map((carrier) => (carrier.name || carrier.callsign || carrier.id).toLowerCase());
  assert.deepEqual([...names].sort(), names, 'по имени, без имени — по позывному');

  const bySystem = await call(null, '?sort=system');
  const systems = bySystem.body.carriers.map((carrier) => (carrier.system || '').toLowerCase());
  assert.deepEqual([...systems].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : a < b ? -1 : 1)), systems,
    'по системе, без системы — в конце');
});

test('пагинация: страницы, размер и прижатие страницы за концом списка', async () => {
  const first = await call(null, '?pageSize=2');
  assert.equal(first.body.total, 5);
  assert.equal(first.body.pages, 3);
  assert.equal(first.body.page, 1);
  assert.equal(first.body.carriers.length, 2);

  const third = await call(null, '?pageSize=2&page=3');
  assert.equal(third.body.page, 3);
  assert.equal(third.body.carriers.length, 1);

  const tooFar = await call(null, '?pageSize=2&page=99');
  assert.equal(tooFar.body.page, 3, 'сервер отдаёт последнюю существующую страницу');
  assert.deepEqual(ids(tooFar.body), ids(third.body));

  const huge = await call(null, '?pageSize=9999');
  assert.equal(huge.body.pageSize, 100, 'размер страницы ограничен сверху');

  const zero = await call(null, '?pageSize=0&page=0');
  assert.equal(zero.body.pageSize, CARRIER_CATALOG_PAGE_SIZE);
  assert.equal(zero.body.page, 1);
});

test('хранилище можно звать напрямую: та же страница и отношения', async () => {
  const page = await mod.loadCarrierCatalogPage(mod.createServiceClient(), VIEWER, { scope: 'mine', sort: 'name' });
  assert.equal(page.total, 2);
  assert.deepEqual(page.rows.map((row) => row.relation).sort(), ['own', 'squadron']);
  assert.equal(page.rows.every((row) => typeof row.id === 'string'), true);
});

test('миграция идемпотентна, а без функции маршрут отвечает 503', async () => {
  const sql = readFileSync(join(TEST_ROOT, 'supabase', 'migrations', '20261116090000_carrier_catalog.sql'), 'utf8');
  await db.exec(sql);
  const again = await call(null);
  assert.equal(again.status, 200);
  assert.equal(again.body.total, 5);

  await db.exec('ALTER FUNCTION public.carrier_catalog_page(TEXT, TEXT, TEXT, UUID, BIGINT[], BOOLEAN, TEXT, INTEGER, INTEGER) RENAME TO carrier_catalog_page_off;');
  const broken = await call(null);
  assert.equal(broken.status, 503);
  assert.match(broken.body.error, /\S/);
  assert.equal(broken.headers.get('cache-control'), 'no-store');

  await db.exec('ALTER FUNCTION public.carrier_catalog_page_off(TEXT, TEXT, TEXT, UUID, BIGINT[], BOOLEAN, TEXT, INTEGER, INTEGER) RENAME TO carrier_catalog_page;');
  const healed = await call(null);
  assert.equal(healed.status, 200);
});
