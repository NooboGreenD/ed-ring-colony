/**
 * Маршруты «Проектов систем» (`/api/architect/projects/**`) на настоящем
 * PostgreSQL.
 *
 * Маршруты собираются esbuild'ом с подменой `next/server`,
 * `@/lib/supabaseServer` и `@/lib/ravenColonial` (только сетевой запрос к
 * Raven), а service-role клиент — `helpers/pgliteSupabase.mjs`: запросы
 * построителя PostgREST исполняются в PGlite с миграциями авианосцев и
 * проектов. Так проверяются права маршрутов вместе с ограничениями,
 * триггерами и SQL-функциями базы.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';

const OWNER = '00000000-0000-4000-8000-0000000000a1';
const MOD = '00000000-0000-4000-8000-0000000000a2';
const MEMBER = '00000000-0000-4000-8000-0000000000a3';
const OTHER = '00000000-0000-4000-8000-0000000000a4';
const ADMIN = '00000000-0000-4000-8000-0000000000a5';
const SECRET = '00000000-0000-4000-8000-0000000000a6';
const FC_OWNER = '3700000001';
const FC_MEMBER = '3700000002';
const FC_OTHER = '3700000003';
const FC_SQUAD = '3709000001';

const NEXT_SERVER_STUB = `
export const NextResponse = {
  json: (body, init) => new Response(JSON.stringify(body), {
    status: (init && init.status) || 200,
    headers: { 'content-type': 'application/json' },
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

const RAVEN_REAL = join(TEST_ROOT, 'src', 'lib', 'ravenColonial.ts').replace(/\\/g, '/');
const RAVEN_STUB = `
export * from '${RAVEN_REAL}';
export const ravenFake = { calls: [], systems: {} };
export async function fetchRavenSystemV2(name) {
  ravenFake.calls.push(name);
  const found = ravenFake.systems[String(name).toLowerCase()];
  if (found) return found;
  return { systemName: name, siteName: null, architectName: null, progress: null, projects: [], resources: [],
    totalRequired: null, totalProvided: null, totalRemaining: 0, error: 'Система не найдена в RavenColonial' };
}
`;

const ENTRY = `
export * as list from '@/app/api/architect/projects/route';
export * as project from '@/app/api/architect/projects/[id]/route';
export * as members from '@/app/api/architect/projects/[id]/members/route';
export * as systems from '@/app/api/architect/projects/[id]/systems/route';
export * as carriers from '@/app/api/architect/projects/[id]/carriers/route';
export * as progress from '@/app/api/architect/projects/[id]/progress/route';
export * as leaderboard from '@/app/api/architect/projects/[id]/leaderboard/route';
export { state } from '@/lib/supabaseServer';
export { ravenFake } from '@/lib/ravenColonial';
`;

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${MOD}'), ('${MEMBER}'), ('${OTHER}'), ('${ADMIN}'), ('${SECRET}');
CREATE TABLE public.profiles(
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, avatar_url text, squadron text,
  role text DEFAULT 'user', privacy_settings jsonb);
INSERT INTO public.profiles(id, cmdr_name, role, privacy_settings, squadron) VALUES
  ('${OWNER}', 'Owner Pilot', 'user', NULL, 'ALPHA'), ('${MOD}', 'Mod Pilot', 'user', NULL, NULL),
  ('${MEMBER}', 'Member Pilot', 'user', '{"deliveries": false}', NULL), ('${OTHER}', 'Other Pilot', 'user', NULL, NULL),
  ('${ADMIN}', 'Admin Pilot', 'admin', NULL, NULL), ('${SECRET}', 'Secret Pilot', 'user', '{"deliveries": false}', NULL);
CREATE VIEW public.public_profiles AS SELECT id, cmdr_name, avatar_url, squadron FROM public.profiles;
CREATE FUNCTION public.request_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;
CREATE TABLE public.squadrons(id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
INSERT INTO public.squadrons(name, tag, created_by) VALUES ('Alpha', 'ALP', '${OWNER}');
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
INSERT INTO public.squadron_ranks VALUES (10, 1, true), (11, 1, false);
CREATE TABLE public.squadron_members(squadron_id bigint, user_id uuid, rank_id bigint);
INSERT INTO public.squadron_members VALUES (1, '${MEMBER}', 10), (1, '${MOD}', 11);
CREATE TABLE colonisation_market_systems(system_name text,x float8,y float8,z float8,has_market boolean,last_checked_at timestamptz);
CREATE TABLE market_search_jobs(id integer);
CREATE TABLE market_search_cache(market_id bigint);
CREATE TABLE market_prices(station_name text,system_name text,commodity_name text,buy_price integer,sell_price integer,stock integer,demand integer,reported_at timestamptz,source text);
CREATE TABLE public.system_plans(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text NOT NULL,
  system_name_lc text GENERATED ALWAYS AS (lower(btrim(system_name))) STORED,
  title text DEFAULT '', author_id uuid, author_name text DEFAULT '', visibility text DEFAULT 'private', plan jsonb,
  site_count int DEFAULT 0, haul_tons bigint DEFAULT 0, catalogue_version int DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.system_progress(system_name text PRIMARY KEY, progress int, updated_at timestamptz DEFAULT now(), data jsonb);
CREATE TABLE public.route_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, progress int, status text);
CREATE TABLE public.hubs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, progress int, status text);
CREATE TABLE public.colonisation_sites(
  market_id bigint PRIMARY KEY, system_name text NOT NULL, construction_id bigint, construction_name text,
  construction_progress numeric(5,2), resources_total jsonb NOT NULL DEFAULT '[]', event_timestamp timestamptz NOT NULL, user_id uuid);
CREATE TABLE public.deliveries(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  system_name text NOT NULL, commodity text, amount int, delivered_at timestamptz, created_at timestamptz DEFAULT now(),
  market_id text, station_name text, delivery_kind text, is_construction boolean);
`);
for (const file of ['20261014000000_station_commerce.sql', '20261017000000_fleet_carriers.sql', '20261017120000_architect_projects.sql']) {
  await db.exec(readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8'));
}
await db.exec(`
INSERT INTO fleet_carriers(carrier_id, carrier_type, callsign, name, owner_id, squadron_id, system_name, finance) VALUES
  (${FC_OWNER}, 'FleetCarrier', 'OWN-001', 'Owner Hauler', '${OWNER}', NULL, 'Sol', '{"balance": 999}'),
  (${FC_MEMBER}, 'FleetCarrier', 'MEM-002', 'Member Depot', '${MEMBER}', NULL, 'Achenar', '{"balance": 5}'),
  (${FC_OTHER}, 'FleetCarrier', 'OTH-003', 'Other Ship', '${OTHER}', NULL, 'Lave', NULL),
  (${FC_SQUAD}, 'SquadronCarrier', 'SQD-777', 'Squad Bank', NULL, 1, 'Alioth', NULL);
INSERT INTO fleet_carrier_cargo(carrier_id, commodity, name_localised, baseline_qty, quantity) VALUES
  (${FC_MEMBER}, 'steel', 'Steel', 4000, 4000), (${FC_OTHER}, 'gold', 'Gold', 10, 10);
`);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/ravenColonial': RAVEN_STUB,
  },
});
const mod = await import(bundle);
mod.state.db = db;

test.after(async () => { await db.close(); });

function as(userId) { mod.state.userId = userId; }

async function call(handler, method, path, { body, id } = {}) {
  const request = new Request(`http://localhost${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const context = { params: Promise.resolve({ id }) };
  const response = await handler(request, context);
  return { status: response.status, body: await response.json() };
}

let projectId = null;
const api = () => `/api/architect/projects/${projectId}`;

test('создание и список: гость 401, проект создаётся с системами без дублей', async () => {
  as(null);
  assert.equal((await call(mod.list.GET, 'GET', '/api/architect/projects')).status, 401);
  assert.equal((await call(mod.list.POST, 'POST', '/api/architect/projects', { body: { name: 'X' } })).status, 401);

  as(OWNER);
  const bad = await call(mod.list.POST, 'POST', '/api/architect/projects', { body: { name: '   ' } });
  assert.equal(bad.status, 400);

  const created = await call(mod.list.POST, 'POST', '/api/architect/projects', {
    body: { name: 'Кольцо Пегаса', description: 'Стройка', color: '#3498DB', systems: 'HIP 100\nhip 100\nHIP 200' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.systems, 2);
  assert.deepEqual(created.body.skipped.duplicates, ['hip 100']);
  projectId = created.body.id;

  const list = await call(mod.list.GET, 'GET', '/api/architect/projects');
  assert.equal(list.status, 200);
  assert.equal(list.body.projects.length, 1);
  const [card] = list.body.projects;
  assert.equal(card.role, 'owner');
  assert.equal(card.color, '#3498db');
  assert.deepEqual(card.counts, { systems: 2, members: 1, carriers: 0 });
  assert.equal(card.ownerName, 'Owner Pilot');
  assert.equal(card.progress, null, 'сводка появится после первого расчёта');

  as(OTHER);
  const foreign = await call(mod.list.GET, 'GET', '/api/architect/projects');
  assert.deepEqual(foreign.body.projects, [], 'чужие проекты в списке не видны');
  assert.equal((await call(mod.project.GET, 'GET', api(), { id: projectId })).status, 404, 'посторонний получает 404');
  assert.equal((await call(mod.project.GET, 'GET', '/api/architect/projects/not-a-uuid', { id: 'not-a-uuid' })).status, 404);

  as(ADMIN);
  const all = await call(mod.list.GET, 'GET', '/api/architect/projects?all=1');
  assert.equal(all.body.all, true);
  assert.equal(all.body.projects.length, 1, 'администратор видит все проекты');
});

test('участники: модераторов назначает только создатель, передача проекта, выход', async () => {
  as(OWNER);
  const search = await call(mod.members.GET, 'GET', `${api()}/members?search=pilot`, { id: projectId });
  assert.equal(search.status, 200);
  assert.ok(search.body.candidates.some((candidate) => candidate.name === 'Mod Pilot'));
  assert.ok(search.body.candidates.find((candidate) => candidate.name === 'Owner Pilot').member, 'уже участник помечен');

  const addMod = await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { cmdr: 'mod pilot', role: 'moderator', duty: 'логист' } });
  assert.equal(addMod.status, 201, JSON.stringify(addMod.body));
  assert.equal((await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { userId: MOD } })).status, 409);
  assert.equal((await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { cmdr: 'Nobody' } })).status, 404);

  as(MOD);
  assert.equal((await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { userId: MEMBER, role: 'moderator' } })).status, 403,
    'модератор не назначает модераторов');
  const addMember = await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { userId: MEMBER } });
  assert.equal(addMember.status, 201);
  assert.equal((await call(mod.members.PATCH, 'PATCH', `${api()}/members`, { id: projectId, body: { userId: MEMBER, role: 'moderator' } })).status, 403);

  as(MEMBER);
  assert.equal((await call(mod.members.POST, 'POST', `${api()}/members`, { id: projectId, body: { userId: OTHER } })).status, 403);
  assert.equal((await call(mod.members.DELETE, 'DELETE', `${api()}/members?userId=${MOD}`, { id: projectId })).status, 403);
  const duty = await call(mod.members.PATCH, 'PATCH', `${api()}/members`, { id: projectId, body: { userId: MEMBER, duty: 'вожу сталь' } });
  assert.equal(duty.status, 200, 'свою обязанность участник подписывает сам');

  as(OWNER);
  const detail = await call(mod.project.GET, 'GET', api(), { id: projectId });
  assert.deepEqual(detail.body.members.map((member) => [member.name, member.role, member.duty]), [
    ['Owner Pilot', 'owner', ''], ['Mod Pilot', 'moderator', 'логист'], ['Member Pilot', 'member', 'вожу сталь'],
  ]);
  assert.equal(detail.body.viewer.permissions.deleteProject, true);

  // Создатель уйти не может, а передать — да.
  const leave = await call(mod.members.DELETE, 'DELETE', `${api()}/members?userId=${OWNER}`, { id: projectId });
  assert.equal(leave.status, 403);
  assert.match(leave.body.error, /передайте/);

  const transfer = await call(mod.members.PATCH, 'PATCH', `${api()}/members`, { id: projectId, body: { userId: MOD, role: 'owner' } });
  assert.equal(transfer.status, 200, JSON.stringify(transfer.body));
  const roles = await db.query('SELECT user_id, role FROM architect_project_members WHERE project_id = $1', [projectId]);
  assert.deepEqual(Object.fromEntries(roles.rows.map((row) => [row.user_id, row.role])), { [OWNER]: 'moderator', [MOD]: 'owner', [MEMBER]: 'member' });

  as(MOD);
  const back = await call(mod.members.PATCH, 'PATCH', `${api()}/members`, { id: projectId, body: { userId: OWNER, role: 'owner' } });
  assert.equal(back.status, 200, 'новый создатель возвращает проект');
});

test('системы: ведущие добавляют, ответственный меняет только этап и заметки, план — своей системы', async () => {
  as(MEMBER);
  assert.equal((await call(mod.systems.POST, 'POST', `${api()}/systems`, { id: projectId, body: { systems: 'Sol' } })).status, 403);

  as(MOD);
  const added = await call(mod.systems.POST, 'POST', `${api()}/systems`, { id: projectId, body: { systems: ['HIP 300', 'hip 100'] } });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.deepEqual(added.body.added.map((system) => system.name), ['HIP 300']);
  assert.deepEqual(added.body.duplicates, ['hip 100']);

  const detail = await call(mod.project.GET, 'GET', api(), { id: projectId });
  const hip100 = detail.body.systems.find((system) => system.name === 'HIP 100');
  assert.ok(hip100);

  const assign = await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, responsibleId: MEMBER, priority: 1 } });
  assert.equal(assign.status, 200, JSON.stringify(assign.body));
  assert.equal(assign.body.system.responsibleName, 'Member Pilot');
  assert.equal((await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, responsibleId: OTHER } })).status, 400,
    'ответственным может быть только участник');

  as(MEMBER);
  const stage = await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, stage: 'building', notes: 'везём' } });
  assert.equal(stage.status, 200);
  assert.deepEqual(stage.body.system.editable, ['stage', 'notes']);
  assert.equal((await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, priority: 3 } })).status, 403);
  const hip200 = detail.body.systems.find((system) => system.name === 'HIP 200');
  assert.equal((await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip200.id, stage: 'done' } })).status, 403,
    'чужую систему участник не трогает');

  // Планы: чужой приватный — не найден, чужой системы — отказ, свой — привязывается.
  const plans = await db.query(`INSERT INTO system_plans(system_name, title, author_id, author_name, visibility, site_count, haul_tons, plan) VALUES
    ('HIP 100', 'Приватный чужой', '${OTHER}', 'Other Pilot', 'private', 1, 1000, '{"sites": []}'),
    ('HIP 999', 'Другая система', '${MOD}', 'Mod Pilot', 'public', 1, 1000, '{"sites": []}'),
    ('hip 100', 'План модератора', '${MOD}', 'Mod Pilot', 'private', 2, 60000, '{"sites": []}') RETURNING id`);
  const [privateForeign, otherSystem, own] = plans.rows.map((row) => row.id);
  as(MOD);
  assert.equal((await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, planId: privateForeign } })).status, 404);
  assert.equal((await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, planId: otherSystem } })).status, 400);
  const linked = await call(mod.systems.PATCH, 'PATCH', `${api()}/systems`, { id: projectId, body: { systemId: hip100.id, planId: own } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.system.plan.title, 'План модератора');

  const forPlanner = await call(mod.list.GET, 'GET', '/api/architect/projects?system=HIP%20100');
  assert.equal(forPlanner.body.projects.length, 1);
  assert.equal(forPlanner.body.projects[0].planId, own);
  assert.equal(forPlanner.body.projects[0].stage, 'building');

  const hip300 = (await call(mod.project.GET, 'GET', api(), { id: projectId })).body.systems.find((system) => system.name === 'HIP 300');
  assert.equal((await call(mod.systems.DELETE, 'DELETE', `${api()}/systems?systemId=${hip300.id}`, { id: projectId })).status, 200);
  assert.equal((await call(mod.systems.DELETE, 'DELETE', `${api()}/systems?systemId=${hip300.id}`, { id: projectId })).status, 404);
});

test('авианосцы: участник привязывает свой (груз виден проекту), чужой — только ведущие, финансов нет', async () => {
  as(MEMBER);
  const foreign = await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: 'OTH-003' } });
  assert.equal(foreign.status, 403, 'чужой носитель участник не привязывает');
  const own = await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: 'mem-002', purpose: 'склад стали' } });
  assert.equal(own.status, 201, JSON.stringify(own.body));
  assert.equal(own.body.shareCargo, true);
  const squad = await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: FC_SQUAD } });
  assert.equal(squad.status, 201, 'офицер эскадрильи привязывает носитель эскадрильи');
  assert.equal((await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: 'MEM-002' } })).status, 409);

  as(MOD);
  const any = await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: 'OTH-003' } });
  assert.equal(any.status, 201);
  assert.equal(any.body.shareCargo, false, 'чужой груз модератор не открывает');
  const share = await call(mod.carriers.PATCH, 'PATCH', `${api()}/carriers`, { id: projectId, body: { carrierId: FC_OTHER, shareCargo: true } });
  assert.equal(share.status, 403);
  assert.equal((await call(mod.carriers.POST, 'POST', `${api()}/carriers`, { id: projectId, body: { carrier: 'XYZ-404' } })).status, 404);

  as(OWNER);
  const detail = await call(mod.project.GET, 'GET', api(), { id: projectId });
  const byId = Object.fromEntries(detail.body.carriers.map((link) => [link.carrierId, link]));
  assert.equal(byId[FC_MEMBER].carrier.cargo.items[0].commodity, 'steel', 'груз носителя участника виден создателю проекта');
  assert.equal(byId[FC_MEMBER].carrier.finance, null, 'финансы в проекте не показываются');
  assert.equal(byId[FC_MEMBER].purpose, 'склад стали');
  assert.equal(byId[FC_OTHER].carrier.cargo, null, 'груз чужого носителя скрыт');
  assert.equal(byId[FC_OTHER].canShare, false);
  assert.equal(byId[FC_MEMBER].canManage, true, 'ведущие проекта могут отвязать');

  as(MEMBER);
  const hide = await call(mod.carriers.PATCH, 'PATCH', `${api()}/carriers`, { id: projectId, body: { carrierId: FC_MEMBER, shareCargo: false } });
  assert.equal(hide.status, 200);
  assert.equal((await call(mod.carriers.DELETE, 'DELETE', `${api()}/carriers?carrierId=${FC_OTHER}`, { id: projectId })).status, 403);
  assert.equal((await call(mod.carriers.PATCH, 'PATCH', `${api()}/carriers`, { id: projectId, body: { carrierId: FC_MEMBER, shareCargo: true } })).status, 200);
});

test('прогресс: кэш Raven и журнальные площадки, сводка для списка, обновление из Raven', async () => {
  await db.query(`INSERT INTO system_progress(system_name, progress, updated_at, data) VALUES ('HIP 100', 50, now() - interval '1 hour', $1)`, [{
    architectName: 'CMDR Arch',
    projects: [{ buildId: 'b1', marketId: '3900000001', buildName: 'Alpha Port', buildType: 'coriolis', complete: false, progress: 50, bodyName: 'HIP 100 A',
      resources: [{ name: 'Steel', key: 'steel', required: null, provided: null, remaining: 500, exact: false }],
      totalRequired: 1000, totalProvided: 500, totalRemaining: 500 }],
  }]);
  await db.query(`INSERT INTO colonisation_sites(market_id, system_name, construction_name, construction_progress, resources_total, event_timestamp) VALUES
    (3900000002, 'HIP 200', 'Planetary Construction Site: Beta', 25, '[{"Name":"$titanium_name;","RequiredAmount":400,"ProvidedAmount":100}]', now())`);

  as(MEMBER);
  const progress = await call(mod.progress.GET, 'GET', `${api()}/progress`, { id: projectId });
  assert.equal(progress.status, 200, JSON.stringify(progress.body));
  const byName = Object.fromEntries(progress.body.systems.map((system) => [system.systemName, system]));
  assert.equal(byName['HIP 100'].progress, 50);
  assert.equal(byName['HIP 100'].sites[0].name, 'Alpha Port');
  assert.equal(byName['HIP 200'].sites[0].source, 'journal');
  assert.equal(byName['HIP 200'].progress, 25);
  assert.equal(progress.body.summary.totalTons, 1400);
  assert.equal(progress.body.summary.doneTons, 600);

  const list = await call(mod.list.GET, 'GET', '/api/architect/projects');
  assert.equal(list.body.projects[0].progress.progress, progress.body.summary.progress, 'сводка сохранена для списка');

  // Обновление: устаревшие системы перечитываются из Raven (заглушка сети).
  mod.ravenFake.systems['hip 200'] = {
    systemName: 'HIP 200', siteName: null, architectName: null, progress: 30,
    projects: [{ buildId: 'b2', marketId: '3900000002', buildName: 'Beta Base', buildType: 'outpost', complete: false, progress: 30, bodyName: 'HIP 200 1',
      resources: [{ name: 'Titanium', key: 'titanium', required: 400, provided: 120, remaining: 280, exact: true }],
      totalRequired: 400, totalProvided: 120, totalRemaining: 280 }],
    resources: [], totalRequired: 400, totalProvided: 120, totalRemaining: 280,
  };
  const refreshed = await call(mod.progress.POST, 'POST', `${api()}/progress`, { id: projectId });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.ok(mod.ravenFake.calls.map((name) => name.toLowerCase()).includes('hip 200'));
  assert.equal(refreshed.body.refreshed >= 1, true);
  const cached = await db.query(`SELECT progress FROM system_progress WHERE lower(system_name) = 'hip 200'`);
  assert.equal(cached.rows[0].progress, 30, 'свежий ответ Raven лёг в общий кэш');
  const again = await call(mod.progress.POST, 'POST', `${api()}/progress`, { id: projectId });
  assert.equal(again.body.throttled, true, 'повтор чаще раза в 15 секунд не дёргает Raven');
});

test('лидеры: кто сколько куда привёз, скрытые гости, только участники, авианосцы отдельно', async () => {
  await db.query(`INSERT INTO deliveries(user_id, system_name, commodity, amount, delivered_at, market_id, station_name, delivery_kind, is_construction) VALUES
    ('${MEMBER}', 'HIP 100', 'Steel', 800, now() - interval '2 days', '3900000001', 'Orbital Construction Site: Alpha', 'construction_site', true),
    ('${MEMBER}', 'hip 100', 'Сталь', 200, now() - interval '1 day', '3900000001', NULL, 'construction_site', true),
    ('${OWNER}', 'HIP 200', 'Titanium', 300, now() - interval '40 days', '3900000002', NULL, 'construction_site', true),
    ('${SECRET}', 'HIP 100', 'Steel', 50, now() - interval '1 day', '3900000001', NULL, 'construction_site', true),
    ('${OTHER}', 'HIP 100', 'Copper', 20, now() - interval '1 day', '3900000001', NULL, 'construction_site', true),
    ('${OTHER}', 'Sol', 'Steel', 5000, now() - interval '1 day', '3900000099', NULL, 'construction_site', true),
    ('${MOD}', 'Achenar', 'Steel', 700, now() - interval '1 day', '${FC_MEMBER}', 'Member Depot', 'fleet_carrier', false)`);

  as(OWNER);
  const all = await call(mod.leaderboard.GET, 'GET', `${api()}/leaderboard`, { id: projectId });
  assert.equal(all.status, 200, JSON.stringify(all.body));
  assert.deepEqual(all.body.pilots.map((pilot) => [pilot.name, pilot.siteTons]), [
    ['Member Pilot', 1000], ['Owner Pilot', 300], ['Скрытый командир 1', 50], ['Other Pilot', 20], ['Mod Pilot', 0],
  ], 'участник со скрытыми поставками виден команде; посторонний скрытый — нет');
  assert.equal(all.body.pilots.find((pilot) => pilot.name === 'Mod Pilot').carrierTons, 700);
  assert.equal(all.body.totals.siteTons, 1370);
  assert.equal(all.body.commodities[0].key, 'steel');
  assert.equal(all.body.commodities[0].tons, 1050, 'Steel и Сталь — один товар');
  assert.equal(all.body.sites[0].name, 'Alpha Port', 'площадка подписана по данным Raven');
  assert.equal(all.body.carriers[0].name, 'Member Depot · MEM-002');
  assert.ok(!JSON.stringify(all.body).includes(SECRET), 'id скрытого пилота не уходит в ответ');

  const week = await call(mod.leaderboard.GET, 'GET', `${api()}/leaderboard?period=7d`, { id: projectId });
  assert.equal(week.body.pilots.find((pilot) => pilot.name === 'Owner Pilot'), undefined, 'поставка 40-дневной давности вне периода');

  const members = await call(mod.leaderboard.GET, 'GET', `${api()}/leaderboard?scope=members`, { id: projectId });
  assert.deepEqual(members.body.pilots.map((pilot) => pilot.name), ['Member Pilot', 'Owner Pilot', 'Mod Pilot']);

  as(SECRET);
  assert.equal((await call(mod.leaderboard.GET, 'GET', `${api()}/leaderboard`, { id: projectId })).status, 404, 'лидеров видят только участники');

  // Отсчёт вклада проекта отсекает старые поставки.
  as(MOD);
  const since = await call(mod.project.PATCH, 'PATCH', api(), { id: projectId, body: { trackingSince: new Date(Date.now() - 10 * 86_400_000).toISOString() } });
  assert.equal(since.status, 200);
  const tracked = await call(mod.leaderboard.GET, 'GET', `${api()}/leaderboard`, { id: projectId });
  assert.equal(tracked.body.pilots.find((pilot) => pilot.name === 'Owner Pilot'), undefined);
});

test('проект: модератор правит, но не удаляет; создатель удаляет', async () => {
  as(MEMBER);
  assert.equal((await call(mod.project.PATCH, 'PATCH', api(), { id: projectId, body: { name: 'Хак' } })).status, 403);
  as(MOD);
  const renamed = await call(mod.project.PATCH, 'PATCH', api(), { id: projectId, body: { name: 'Кольцо Пегаса II', status: 'paused', targetDate: '2026-12-31' } });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
  assert.equal(renamed.body.project.name, 'Кольцо Пегаса II');
  assert.equal(renamed.body.project.targetDate, '2026-12-31');
  assert.equal((await call(mod.project.PATCH, 'PATCH', api(), { id: projectId, body: { status: 'nope' } })).status, 400);
  assert.equal((await call(mod.project.DELETE, 'DELETE', api(), { id: projectId })).status, 403);

  as(MEMBER);
  const left = await call(mod.members.DELETE, 'DELETE', `${api()}/members?userId=${MEMBER}`, { id: projectId });
  assert.equal(left.status, 200);
  assert.equal(left.body.left, true);
  assert.equal((await call(mod.project.GET, 'GET', api(), { id: projectId })).status, 404, 'вышедший больше не видит проект');

  as(OWNER);
  assert.equal((await call(mod.project.DELETE, 'DELETE', api(), { id: projectId })).status, 200);
  assert.equal((await call(mod.project.GET, 'GET', api(), { id: projectId })).status, 404);
  const rest = await db.query('SELECT count(*)::int AS n FROM architect_project_carriers');
  assert.equal(rest.rows[0].n, 0, 'привязки авианосцев ушли каскадом');
  const carriers = await db.query('SELECT count(*)::int AS n FROM fleet_carriers');
  assert.equal(carriers.rows[0].n, 4, 'сами авианосцы остались');
});
