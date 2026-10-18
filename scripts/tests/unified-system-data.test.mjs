/**
 * Единый механизм данных о системах (web 2.22.0) на настоящем PostgreSQL
 * (PGlite) с миграциями PowerPlay, фракций и `20261020120000_unified_system_data.sql`.
 *
 * Проверяется, что разделы сайта больше не живут каждый сам по себе:
 *   * одно наблюдение системы из журнала (`POST /api/factions/sync`) обновляет
 *     и фракции, и PowerPlay; старый журнал и PowerPlay 1.0 не принимаются;
 *     ночной дамп EDSM не перетирает свежие данные пилотов, а более свежий
 *     дамп — побеждает; `Unoccupied` снимает систему со слоя;
 *   * журнал CAPI раскладывается тем же путём;
 *   * стройка из журнала продвигает статусы систем проектов эскадрилий
 *     (только вперёд) и уведомляет участников, кроме приславшего;
 *   * карточка системы (`GET /api/systems/overview`) собирает все разделы с
 *     правами зрителя: чужие «Проекты систем» и черновики планов не видны.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { TEST_ROOT, bundleFile } from './helpers/bundle.mjs';

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
delete process.env.VAPID_PRIVATE_KEY;

const PILOT = '11111111-1111-4111-8111-111111111111';
const MEMBER = '22222222-2222-4222-8222-222222222222';
const STRANGER = '33333333-3333-4333-8333-333333333333';
const ADMIN = '44444444-4444-4444-8444-444444444444';
const SYSTEM = 'Col 285 Sector AB-C d14-3';
const ID64 = '36028797018963971';
const NOW = Date.now();
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3600_000;
const DAY = 24 * HOUR;

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
export async function authFromRequest() { return { user: state.userId ? { id: state.userId } : null, supabase: pgliteClient(state) }; }
`;

const HELPER_AUTH_STUB = `
export const helperState = { user: { userId: '${PILOT}', via: 'api_token' } };
export async function resolveRequestUser() { return helperState.user; }
`;

const ENTRY = `
export * as syncRoute from '@/app/api/factions/sync/route';
export * as overviewRoute from '@/app/api/systems/overview/route';
export * as projectProgressRoute from '@/app/api/projects/[id]/progress/route';
export { state, createServiceClient } from '@/lib/supabaseServer';
export { helperState } from '@/lib/helperAuth';
export { applySystemObservations, splitSystemObservations, observationEventsFromJournalText } from '@/lib/systemObservations';
export { journalEventToPowerplay, POWERPLAY_JOURNAL_FIELDS } from '@/lib/powerplayJournal';
export { loadPowerplayLayer, resetPowerplayLayerCache } from '@/lib/powerplayStore';
export { decodePowerplayLayer } from '@/lib/powerplay';
export { projectBgsEvent } from '@/lib/bgsJournal';
export { syncProjectsFromSites } from '@/lib/projects/projectSync';
export { loadSystemOverview, loadSystemsProgress } from '@/lib/systemOverview';
`;

/* ── База: заглушки соседних таблиц + настоящие миграции ───────────────── */

const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE TABLE public.profiles(id uuid PRIMARY KEY, cmdr_name text, role text DEFAULT 'user', privacy_settings jsonb);
CREATE TABLE public.galaxy_systems(id bigserial, id64 text UNIQUE, name text, name_lc text UNIQUE, x float8, y float8, z float8,
  main_star text, star_type text, star_giant_class text, needs_permit boolean, distance_from_sols float8, distance_from_sgra float8);
CREATE TABLE public.system_progress(system_name text PRIMARY KEY, progress int, updated_at timestamptz DEFAULT now(), data jsonb);
CREATE TABLE public.colonisation_sites(market_id bigint PRIMARY KEY, system_name text NOT NULL, construction_id bigint, construction_name text,
  construction_progress numeric(5,2), resources_total jsonb NOT NULL DEFAULT '[]', event_timestamp timestamptz NOT NULL, user_id uuid);
CREATE TABLE public.system_plans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text NOT NULL,
  system_name_lc text GENERATED ALWAYS AS (lower(trim(system_name))) STORED, title text DEFAULT '', author_id uuid NOT NULL,
  author_name text DEFAULT '', visibility text DEFAULT 'private', plan jsonb NOT NULL DEFAULT '{}', site_count int DEFAULT 0,
  haul_tons bigint DEFAULT 0, catalogue_version int DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.system_architects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text, system_name_lc text UNIQUE,
  user_id uuid, architect_name text DEFAULT '', assigned_by_name text DEFAULT '', updated_at timestamptz DEFAULT now());
CREATE TABLE public.squadrons(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, tag text, created_by uuid);
CREATE TABLE public.squadron_members(user_id uuid, squadron_id bigint, rank_id bigint);
CREATE TABLE public.squadron_ranks(id bigint PRIMARY KEY, squadron_id bigint, can_edit_squadron boolean);
CREATE TABLE public.projects(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, status text DEFAULT 'active', color text,
  squadron_id bigint, created_by uuid, created_at timestamptz DEFAULT now());
CREATE TABLE public.project_members(project_id bigint, user_id uuid, role text DEFAULT 'member');
CREATE TABLE public.project_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, project_id bigint, system_name text NOT NULL,
  route_system_id bigint, planned_status text NOT NULL DEFAULT 'planned', priority int DEFAULT 1, target_date date, assigned_to uuid);
CREATE TABLE public.architect_projects(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, status text DEFAULT 'active', color text,
  progress_summary jsonb, progress_at timestamptz, created_at timestamptz DEFAULT now());
CREATE TABLE public.architect_project_members(project_id uuid, user_id uuid, role text DEFAULT 'member');
CREATE TABLE public.architect_project_systems(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), project_id uuid, system_name text NOT NULL,
  system_name_lc text GENERATED ALWAYS AS (lower(btrim(system_name))) STORED, stage text DEFAULT 'planned', priority smallint DEFAULT 2, target_date date);
CREATE TABLE public.route_systems(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, system_name text, sort_order int, status text DEFAULT 'planned',
  progress int DEFAULT 0, x float8, y float8, z float8);
CREATE TABLE public.hubs(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, system_name text NOT NULL, status text, progress int,
  segment_order int, x float8, y float8, z float8);
CREATE TABLE public.station_commerce(station_key text PRIMARY KEY, market_id text, system_name text, system_lc text, station_name text,
  station_type text, metadata jsonb DEFAULT '{}', observed_at timestamptz, source text);
CREATE TABLE public.station_inventory_snapshots(station_key text, kind text, items jsonb, observed_at timestamptz, source text);
CREATE TABLE public.community_goals(id serial, cg_id int, title text, system_name text, station_name text, objective text, tier_current int,
  tier_max int, contributors int, expiry_date timestamptz, is_complete boolean DEFAULT false, is_colonisation_related boolean DEFAULT false);
CREATE TABLE public.deliveries(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid, system_name text, amount int,
  delivered_at timestamptz, is_construction boolean);
CREATE TABLE public.system_scans(id bigserial, system_name text, body_name text, updated_at timestamptz DEFAULT now());
CREATE TABLE public.user_notifications(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid NOT NULL, type text NOT NULL,
  title text NOT NULL, body text, href text, metadata jsonb NOT NULL DEFAULT '{}', is_read boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE public.fleet_carriers(carrier_id bigint PRIMARY KEY, carrier_type text DEFAULT 'FleetCarrier', callsign text, name text,
  owner_id uuid, squadron_id bigint, system_name text, system_address bigint, body_name text, x float8, y float8, z float8,
  location_at timestamptz, location_source text, jump_system_name text, jump_system_address bigint, jump_body_name text,
  jump_departure_at timestamptz, jump_requested_at timestamptz, docking_access text, allow_notorious boolean,
  pending_decommission boolean DEFAULT false, decommission_at timestamptz, services jsonb, station_services jsonb, updated_at timestamptz DEFAULT now());
`);
const migration = (file) => readFileSync(join(TEST_ROOT, 'supabase', 'migrations', file), 'utf8');
await db.exec(migration('20261018120000_powerplay_systems.sql'));
await db.exec(migration('20261018180000_powerplay_sync_progress.sql'));
await db.exec(migration('20261019120000_minor_factions.sql'));
const UNIFIED = migration('20261020120000_unified_system_data.sql');
await db.exec(UNIFIED);
// Снимок full_schema.sql и повторный прогон update-project.sh накатывают миграцию ещё раз.
await db.exec(UNIFIED);

const bundle = await bundleFile({
  entrySource: ENTRY,
  stubs: {
    'next/server': NEXT_SERVER_STUB,
    '@/lib/supabaseServer': SUPABASE_STUB,
    '@/lib/helperAuth': HELPER_AUTH_STUB,
  },
  platform: 'node',
});
const mod = await import(bundle);
mod.state.db = db;
const svc = mod.createServiceClient();

/* ── Журнал ────────────────────────────────────────────────────────────── */

function jump(overrides = {}) {
  return {
    timestamp: iso(-HOUR),
    event: 'FSDJump',
    StarSystem: SYSTEM,
    SystemAddress: ID64,
    StarPos: [-24.53125, -33.78125, 108.8125],
    SystemAllegiance: 'Independent',
    SystemGovernment: '$government_Cooperative;',
    SystemEconomy: '$economy_Colony;',
    SystemSecurity: '$SYSTEM_SECURITY_low;',
    Population: 18457,
    SystemFaction: { Name: 'Ring Colony Pioneers', FactionState: 'Expansion' },
    ControllingPower: 'Jerome Archer',
    Powers: ['Jerome Archer', 'Yuri Grom'],
    PowerplayState: 'Fortified',
    PowerplayStateControlProgress: 0.42,
    PowerplayStateReinforcement: 1200,
    PowerplayStateUndermining: 300,
    Factions: [
      { Name: 'Ring Colony Pioneers', FactionState: 'Expansion', Government: 'Cooperative', Influence: 0.612, Allegiance: 'Independent', Happiness: '$Faction_HappinessBand2;' },
      { Name: 'Col 285 Labour', FactionState: 'None', Government: 'Democracy', Influence: 0.388, Allegiance: 'Federation' },
    ],
    ...overrides,
  };
}

const post = (body) => new Request('https://edringcolony.ru/api/factions/sync', { method: 'POST', body: JSON.stringify(body) });
const ppRow = async (id64) => (await db.query('SELECT name, power, power_state, powers, control_progress, reinforcement, undermining, source, sync_run FROM powerplay_systems WHERE id64 = $1', [id64])).rows[0];

test('PowerPlay из журнала: держава, состояние, отказы старых и PowerPlay 1.0', () => {
  const ok = mod.journalEventToPowerplay(jump(), NOW);
  assert.ok('observation' in ok);
  assert.equal(ok.observation.power, 'Jerome Archer');
  assert.equal(ok.observation.state, 'Fortified');
  assert.deepEqual(ok.observation.powers, ['Jerome Archer', 'Yuri Grom']);
  assert.equal(ok.observation.controlProgress, 0.42);
  assert.equal(ok.observation.id64, ID64);

  const free = mod.journalEventToPowerplay(jump({ PowerplayState: 'Unoccupied', ControllingPower: undefined }), NOW);
  assert.equal(free.observation.state, 'Unoccupied');
  assert.equal(free.observation.power, null);

  // Клиент PowerPlay 2.0 без ControllingPower — единственная держава из Powers.
  const legacy = mod.journalEventToPowerplay(jump({ ControllingPower: undefined, Powers: ['Nakato Kaine'], PowerplayState: 'Exploited' }), NOW);
  assert.equal(legacy.observation.power, 'Nakato Kaine');

  assert.deepEqual(mod.journalEventToPowerplay(jump({ timestamp: '2023-05-01T00:00:00Z' }), NOW), { reject: 'before_pp2' });
  assert.deepEqual(mod.journalEventToPowerplay(jump({ PowerplayState: 'Controlled' }), NOW), { reject: 'state' });
  assert.deepEqual(mod.journalEventToPowerplay(jump({ PowerplayState: undefined }), NOW), { reject: 'no_powerplay' });
  assert.deepEqual(mod.journalEventToPowerplay(jump({ ControllingPower: undefined, Powers: ['A', 'B'] }), NOW), { reject: 'power' });

  // Проекция журнала (сайт) несёт поля PowerPlay, но не прогресс захвата чужими державами.
  const line = JSON.stringify({ ...jump(), PowerplayConflictProgress: [{ Power: 'Yuri Grom', ConflictProgress: 0.1 }] });
  const projected = mod.projectBgsEvent(JSON.parse(line), line);
  for (const field of mod.POWERPLAY_JOURNAL_FIELDS) assert.ok(field in projected, `${field} в проекции`);
  assert.ok(!('PowerplayConflictProgress' in projected));

  const split = mod.splitSystemObservations([projected, { event: 'Docked' }], NOW);
  assert.equal(split.snapshots.length, 1);
  assert.equal(split.powerplay.length, 1);
  assert.equal(split.powerplayCandidates, 1);
});

test('одно наблюдение → фракции и PowerPlay; повтор безопасен; сбой PowerPlay не роняет фракции', async () => {
  // Дамп EDSM уже знает систему как Exploited (наблюдение двухдневной давности).
  const run = '0b8a4c8e-7a7e-4f1a-9a5c-1d1b1c1d1e10';
  await db.query('SELECT public.powerplay_apply_batch($1, $2::jsonb)', [run, JSON.stringify([
    { id64: ID64, name: SYSTEM, x: -24.5, y: -33.8, z: 108.8, power: 'Jerome Archer', power_state: 'Exploited', observed_at: iso(-2 * DAY) },
    { id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, power: 'Jerome Archer', power_state: 'Stronghold', observed_at: iso(-2 * DAY) },
  ])]);
  await db.query(`SELECT public.powerplay_finish_sync($1, jsonb_build_object('dump_generated_at', $2::text))`, [run, iso(-DAY)]);

  const response = await mod.syncRoute.POST(post({ events: [jump()] }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.applied, 1, 'фракции применены (поля ответа — как раньше)');
  assert.equal(body.powerplay.applied, 1);
  assert.equal(body.powerplay.error, null);
  const row = await ppRow(ID64);
  assert.equal(row.power_state, 'Fortified');
  assert.equal(row.source, 'helper');
  assert.deepEqual(row.powers, ['Jerome Archer', 'Yuri Grom']);
  assert.equal(row.reinforcement, 1200);
  const bgs = await db.query('SELECT source FROM bgs_systems WHERE id64 = $1', [ID64]);
  assert.equal(bgs.rows[0].source, 'helper');

  const again = await (await mod.syncRoute.POST(post({ events: [jump()] }))).json();
  assert.equal(again.powerplay.applied, 0);
  assert.equal(again.powerplay.stale, 1);

  // Старый журнал не создаёт систему, о которой дамп уже знает лучше.
  const oldNew = await (await mod.syncRoute.POST(post({ events: [jump({
    timestamp: iso(-3 * DAY), StarSystem: 'Old Jump', SystemAddress: '7267487057317', ControllingPower: 'Yuri Grom',
  })] }))).json();
  assert.equal(oldNew.powerplay.created, 0);
  assert.equal(await ppRow('7267487057317'), undefined);

  // Без функции PowerPlay (миграция не применена) фракции всё равно записываются.
  await db.exec('ALTER FUNCTION public.powerplay_apply_observations(JSONB, TEXT) RENAME TO powerplay_apply_observations_off');
  try {
    const degraded = await (await mod.syncRoute.POST(post({ events: [jump({ timestamp: iso(-30 * 60_000) })] }))).json();
    assert.equal(degraded.applied, 1);
    assert.match(degraded.powerplay.error, /миграцию 20261020120000/);
  } finally {
    await db.exec('ALTER FUNCTION public.powerplay_apply_observations_off(JSONB, TEXT) RENAME TO powerplay_apply_observations');
  }
});

test('ночной дамп не перетирает свежие данные пилотов, более свежий — побеждает; Unoccupied снимает систему', async () => {
  // Пилот увидел новую систему под контролем — новее дампа.
  const fresh = await (await mod.syncRoute.POST(post({ events: [jump({
    timestamp: iso(-20 * 60_000), StarSystem: 'Pilot Find', SystemAddress: '5031654855386', ControllingPower: 'Nakato Kaine', PowerplayState: 'Exploited',
  })] }))).json();
  assert.equal(fresh.powerplay.created, 1);

  // Повтор старого дампа: системы пилотов остаются как есть.
  const run2 = '0b8a4c8e-7a7e-4f1a-9a5c-1d1b1c1d1e11';
  await db.query('SELECT public.powerplay_apply_batch($1, $2::jsonb)', [run2, JSON.stringify([
    { id64: ID64, name: SYSTEM, x: -24.5, y: -33.8, z: 108.8, power: 'Jerome Archer', power_state: 'Exploited', observed_at: iso(-2 * DAY) },
    { id64: '10477373803', name: 'Sol', x: 0, y: 0, z: 0, power: 'Jerome Archer', power_state: 'Stronghold', observed_at: iso(-2 * DAY) },
  ])]);
  await db.query(`SELECT public.powerplay_finish_sync($1, jsonb_build_object('dump_generated_at', $2::text))`, [run2, iso(-DAY)]);
  assert.equal((await ppRow(ID64)).power_state, 'Fortified', 'журнал новее дампа');
  assert.equal((await ppRow('5031654855386')).power, 'Nakato Kaine', 'система пилота пережила импорт');

  // Слой карты видит данные пилотов (пересборка после обновлений — не чаще раза в минуту).
  const layer = await mod.loadPowerplayLayer(svc, { refresh: false, nowMs: Date.now() + 5 * 60_000 });
  const decoded = mod.decodePowerplayLayer(JSON.parse(layer.body));
  const names = decoded.systems.map((system) => system.name);
  assert.ok(names.includes('Pilot Find'));
  assert.equal(decoded.systems.find((system) => system.name === SYSTEM).state, 'Fortified');

  // Пилот увидел систему свободной: слой её больше не показывает, старый дамп не возвращает.
  const vacated = await (await mod.syncRoute.POST(post({ events: [jump({
    timestamp: iso(-10 * 60_000), StarSystem: 'Pilot Find', SystemAddress: '5031654855386', ControllingPower: undefined, PowerplayState: 'Unoccupied', Powers: [],
  })] }))).json();
  assert.equal(vacated.powerplay.vacated, 1);
  const afterVacate = mod.decodePowerplayLayer(JSON.parse((await mod.loadPowerplayLayer(svc, { refresh: false, nowMs: Date.now() + 10 * 60_000 })).body));
  assert.ok(!afterVacate.systems.some((system) => system.name === 'Pilot Find'));
  const summary = (await db.query('SELECT public.powerplay_admin_summary() AS s')).rows[0].s;
  assert.equal(summary.vacated, 1);
  assert.equal(summary.sources.helper, 1);

  // Дамп новее наблюдений пилотов — данные дампа.
  const run3 = '0b8a4c8e-7a7e-4f1a-9a5c-1d1b1c1d1e12';
  await db.query('SELECT public.powerplay_apply_batch($1, $2::jsonb)', [run3, JSON.stringify([
    { id64: ID64, name: SYSTEM, x: -24.5, y: -33.8, z: 108.8, power: 'Jerome Archer', power_state: 'Stronghold', observed_at: iso(-3 * 60_000) },
  ])]);
  const finished = (await db.query(`SELECT public.powerplay_finish_sync($1, jsonb_build_object('dump_generated_at', $2::text)) AS r`, [run3, iso(-2 * 60_000)])).rows[0].r;
  const latest = await ppRow(ID64);
  assert.equal(latest.power_state, 'Stronghold');
  assert.equal(latest.source, 'edsm');
  assert.equal(latest.powers, null, 'счётчики журнала после более свежего дампа устарели');
  assert.equal(await ppRow('5031654855386'), undefined, 'отметка старше дампа удалена');
  assert.ok(finished.deleted >= 2);
});

test('журнал CAPI питает те же слои', async () => {
  const text = [
    JSON.stringify({ timestamp: iso(-60_000), event: 'Fileheader', part: 1 }),
    // Новее последнего дампа (он «сгенерирован» две минуты назад) — система добавится.
    JSON.stringify(jump({ timestamp: iso(-60_000), StarSystem: 'Capi Jump', SystemAddress: '2832765969090', ControllingPower: 'Aisling Duval', PowerplayState: 'Stronghold' })),
    '{битая строка',
    JSON.stringify({ timestamp: iso(-30_000), event: 'Docked', StarSystem: 'Capi Jump' }),
  ].join('\n');
  const events = mod.observationEventsFromJournalText(text);
  assert.equal(events.length, 1);
  const result = await mod.applySystemObservations(svc, events, { source: 'web', userId: PILOT });
  assert.equal(result.factions.applied, 1);
  assert.equal(result.powerplay.created, 1);
  assert.equal((await ppRow('2832765969090')).source, 'web');
});

/* ── Проекты эскадрилий ─────────────────────────────────────────────────── */

test('стройка из журнала → статусы систем проектов эскадрилий и уведомления участникам', async () => {
  await db.exec(`
    INSERT INTO profiles(id, cmdr_name, role) VALUES ('${PILOT}', 'Pilot', 'user'), ('${MEMBER}', 'Member', 'user'),
      ('${STRANGER}', 'Stranger', 'user'), ('${ADMIN}', 'Admin', 'admin');
    INSERT INTO squadrons(name, tag, created_by) VALUES ('Ring Pioneers', 'RING', '${MEMBER}');
    INSERT INTO projects(name, squadron_id, created_by, color) VALUES ('Кольцо', 1, '${MEMBER}', '#e67e22');
    INSERT INTO project_members(project_id, user_id, role) VALUES (1, '${PILOT}', 'member'), (1, '${MEMBER}', 'leader');
    INSERT INTO project_systems(project_id, system_name, planned_status) VALUES
      (1, '${SYSTEM}', 'planned'), (1, 'Done Already', 'done'), (1, 'Untouched', 'planned');
    INSERT INTO colonisation_sites(market_id, system_name, construction_name, construction_progress, resources_total, event_timestamp, user_id) VALUES
      (3956123401, '${SYSTEM}', 'Orbital Construction Site: Ring Hub', 45, '[{"Name":"steel","RequiredAmount":1000,"ProvidedAmount":450}]', now(), '${PILOT}'),
      (3956123402, 'Done Already', 'Planetary Construction Site: Base', 10, '[]', now(), '${PILOT}');
  `);
  const result = await mod.syncProjectsFromSites(svc, [SYSTEM.toUpperCase(), 'done already', 'Untouched'], { actorId: PILOT });
  assert.equal(result.warning, null);
  assert.deepEqual(result.changed.map((change) => [change.system_name, change.status]), [[SYSTEM, 'building']]);
  const statuses = (await db.query('SELECT system_name, planned_status FROM project_systems ORDER BY id')).rows;
  assert.deepEqual(statuses.map((row) => row.planned_status), ['building', 'done', 'planned'], 'только вперёд: «done» не откатывается');

  const notes = (await db.query('SELECT user_id, type, title, href FROM user_notifications')).rows;
  assert.equal(notes.length, 1, 'приславшему журнал уведомление не нужно');
  assert.equal(notes[0].user_id, MEMBER);
  assert.equal(notes[0].type, 'project_system');
  assert.equal(notes[0].href, '/projects/1');
  assert.match(notes[0].title, /Кольцо/);

  await db.query('UPDATE colonisation_sites SET construction_progress = 100 WHERE market_id = 3956123401');
  const done = await mod.syncProjectsFromSites(svc, [SYSTEM], { actorId: MEMBER });
  assert.equal(done.changed[0].status, 'done');
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM user_notifications WHERE user_id = '${PILOT}'`)).rows[0].n, 1);
  await db.query('UPDATE colonisation_sites SET construction_progress = 45 WHERE market_id = 3956123401');
});

/* ── Карточка системы ───────────────────────────────────────────────────── */

async function seedOverview() {
  await db.exec(`
    INSERT INTO galaxy_systems(id64, name, name_lc, x, y, z, main_star, star_type, needs_permit, distance_from_sols, distance_from_sgra)
      VALUES ('${ID64}', '${SYSTEM}', lower('${SYSTEM}'), -24.53125, -33.78125, 108.8125, 'K (Yellow-Orange) Star', 'K', false, 116.1, 25790.2);
    INSERT INTO system_progress(system_name, progress, updated_at, data) VALUES ('${SYSTEM}', 40, now() - interval '2 hours', NULL);
    INSERT INTO system_architects(system_name, system_name_lc, user_id, architect_name, assigned_by_name)
      VALUES ('${SYSTEM}', lower('${SYSTEM}'), '${MEMBER}', 'Member', 'Admin');
    INSERT INTO system_plans(system_name, title, author_id, author_name, visibility, site_count, haul_tons) VALUES
      ('${SYSTEM}', 'Публичный план', '${MEMBER}', 'Member', 'public', 3, 90000),
      ('${SYSTEM}', 'Черновик пилота', '${PILOT}', 'Pilot', 'private', 1, 20000);
    INSERT INTO architect_projects(id, name, color) VALUES ('5f0c3d5e-1111-4a2b-9c3d-000000000001', 'Закрытый проект', '#22c55e');
    INSERT INTO architect_project_members(project_id, user_id, role) VALUES ('5f0c3d5e-1111-4a2b-9c3d-000000000001', '${MEMBER}', 'owner');
    INSERT INTO architect_project_systems(project_id, system_name, stage) VALUES ('5f0c3d5e-1111-4a2b-9c3d-000000000001', '${SYSTEM}', 'building');
    INSERT INTO route_systems(system_name, sort_order, status, progress) VALUES ('${SYSTEM}', 42, 'building', 40);
    INSERT INTO station_commerce(station_key, market_id, system_name, system_lc, station_name, station_type, metadata, observed_at, source) VALUES
      ('m:128000001', '128000001', '${SYSTEM}', lower('${SYSTEM}'), 'Ring Hub', 'Coriolis', '{"distance_to_arrival": 512, "services": ["commodities", "shipyard"]}', now() - interval '30 minutes', 'colonial-helper'),
      ('m:3700000009', '3700000009', '${SYSTEM}', lower('${SYSTEM}'), 'ABC-123', 'FleetCarrier', '{}', now() - interval '3 hours', 'eddn');
    INSERT INTO station_inventory_snapshots(station_key, kind, items, observed_at, source) VALUES
      ('m:128000001', 'market', '[{"name":"steel"},{"name":"water"}]', now() - interval '30 minutes', 'colonial-helper');
    INSERT INTO community_goals(cg_id, title, system_name, station_name, tier_current, tier_max, expiry_date, is_colonisation_related)
      VALUES (777, 'Помощь кольцу', '${SYSTEM}', 'Ring Hub', 2, 5, now() + interval '3 days', true);
    INSERT INTO deliveries(user_id, system_name, amount, delivered_at, is_construction) VALUES
      ('${PILOT}', '${SYSTEM}', 400, now() - interval '1 day', true), ('${MEMBER}', '${SYSTEM}', 600, now() - interval '2 hours', NULL),
      ('${PILOT}', '${SYSTEM}', 999, now(), false);
    INSERT INTO system_scans(system_name, body_name) VALUES ('${SYSTEM}', '${SYSTEM} A'), ('${SYSTEM}', '${SYSTEM} A 1');
    INSERT INTO fleet_carriers(carrier_id, callsign, name, owner_id, system_name, system_address, location_at, location_source, docking_access)
      VALUES (3700000009, 'ABC-123', 'Ring Hauler', '${PILOT}', '${SYSTEM}', ${ID64}, now() - interval '1 hour', 'journal', 'all'),
             (3700000010, 'XYZ-999', 'Elsewhere', '${PILOT}', 'Sol', 10477373803, now() - interval '1 hour', 'journal', 'all');
  `);
}

async function overviewAs(userId, query = `name=${encodeURIComponent(SYSTEM.toLowerCase())}`) {
  mod.state.userId = userId;
  try {
    const response = await mod.overviewRoute.GET(new Request(`https://edringcolony.ru/api/systems/overview?${query}`));
    return { status: response.status, headers: response.headers, body: await response.json() };
  } finally {
    mod.state.userId = null;
  }
}

test('карточка системы: все разделы одним ответом, с правами зрителя', async () => {
  await seedOverview();
  const guest = await overviewAs(null);
  assert.equal(guest.status, 200);
  assert.equal(guest.headers.get('cache-control'), 'private, no-store');
  const o = guest.body;
  assert.equal(o.found, true);
  assert.equal(o.name, SYSTEM, 'имя — как в каталоге, хотя спрашивали строчными');
  assert.equal(o.id64, ID64);
  assert.deepEqual(o.point, { x: -24.53125, y: -33.78125, z: 108.8125 });
  assert.equal(o.catalog.mainStar, 'K (Yellow-Orange) Star');

  // Колонизация — правило «Проектов систем»: журнал (45%) новее кэша Raven.
  assert.equal(o.colonisation.known, true);
  assert.equal(o.colonisation.architect.name, 'Member');
  assert.equal(o.colonisation.progress.sites.length, 1);
  assert.equal(o.colonisation.progress.sites[0].source, 'journal');
  assert.equal(o.colonisation.plans.length, 1, 'гость видит только опубликованный план');
  assert.equal(o.colonisation.plans[0].byArchitect, true);

  assert.equal(o.projects.squadron.length, 1);
  assert.equal(o.projects.squadron[0].squadron.tag, 'RING');
  assert.equal(o.projects.squadron[0].systemStatus, 'done', 'статус продвинут журналом и не откатился, когда прогресс «упал»');
  assert.deepEqual(o.projects.architect, [], 'чужой «Проект системы» не виден');
  assert.ok(!('hiddenArchitect' in o.projects), 'даже числом');
  assert.equal(o.ring.route.order, 42);

  assert.equal(o.stations.total, 2);
  const hub = o.stations.items.find((station) => station.name === 'Ring Hub');
  assert.equal(hub.distanceLs, 512);
  assert.equal(hub.inventories.market.items, 2);
  assert.ok(o.stations.items.find((station) => station.name === 'ABC-123').carrier);

  assert.equal(o.factions.controlling, 'Ring Colony Pioneers');
  assert.equal(o.factions.factions.length, 2);
  assert.equal(o.powerplay.power, 'Jerome Archer');
  assert.equal(o.powerplay.state, 'Stronghold');

  assert.equal(o.carriers.length, 1, 'носитель из другой системы не попал');
  assert.equal(o.carriers[0].callsign, 'ABC-123');

  assert.equal(o.community.goals[0].title, 'Помощь кольцу');
  assert.equal(o.community.deliveries.tons, 1000, 'только стройки и старые строки без признака');
  assert.equal(o.community.deliveries.pilots, 2);
  assert.equal(o.community.scans.bodies, 2);

  const sources = o.freshness.map((item) => item.source);
  for (const source of ['journal', 'stations', 'factions', 'powerplay', 'carriers', 'raven']) assert.ok(sources.includes(source), source);

  const factionsLink = new URL(o.links.factions, 'https://edringcolony.ru').searchParams;
  assert.equal(factionsLink.get('tab'), 'factions');
  assert.equal(factionsLink.get('focus_id64'), ID64);
  assert.equal(o.links.stations, `/station-search?reference=${encodeURIComponent(SYSTEM).replace(/%20/g, '+')}`);
});

test('карточка системы: свои черновики и проекты — своим, админу — всё', async () => {
  const pilot = (await overviewAs(PILOT)).body;
  assert.deepEqual(pilot.colonisation.plans.map((plan) => plan.title).sort(), ['Публичный план', 'Черновик пилота']);
  assert.ok(pilot.colonisation.plans.find((plan) => plan.title === 'Черновик пилота').own);
  assert.deepEqual(pilot.projects.architect, [], 'пилот не участник проекта');

  const member = (await overviewAs(MEMBER)).body;
  assert.equal(member.projects.architect.length, 1);
  assert.equal(member.projects.architect[0].name, 'Закрытый проект');
  assert.equal(member.colonisation.architect.isViewer, true);
  assert.equal(member.colonisation.plans.length, 1, 'чужой черновик не виден и архитектору');

  const admin = (await overviewAs(ADMIN)).body;
  assert.equal(admin.projects.architect.length, 1);

  // Поиск по адресу системы даёт ту же карточку.
  const byId = (await overviewAs(null, `id64=${ID64}`)).body;
  assert.equal(byId.name, SYSTEM);
  assert.equal(byId.factions.controlling, 'Ring Colony Pioneers');
});

test('карточка системы: неизвестная система и пустой запрос', async () => {
  const unknown = await overviewAs(null, 'name=Nowhere%20Sector%20ZZ-Z%20a1');
  assert.equal(unknown.status, 200);
  assert.equal(unknown.body.found, false);
  const empty = await overviewAs(null, 'name=');
  assert.equal(empty.status, 400);
});

test('проект эскадрильи: прогресс каждой системы — тот же расчёт, что у «Проектов систем»', async () => {
  const response = await mod.projectProgressRoute.GET(new Request('https://edringcolony.ru/api/projects/1/progress'), { params: Promise.resolve({ id: '1' }) });
  assert.equal(response.status, 200);
  const { systems } = await response.json();
  const byKey = Object.fromEntries(systems.map((row) => [row.key, row]));
  const ring = byKey[SYSTEM.toLowerCase()];
  assert.equal(ring.progress, 45, 'журнал (45%) новее кэша Raven (40%)');
  assert.equal(ring.sitesActive, 1);
  assert.equal(ring.remaining, 550);
  assert.equal(ring.needs[0].remaining, 550);
  assert.equal(byKey['untouched'].progress, null, 'о системе без строек данных нет');
  assert.equal((await mod.projectProgressRoute.GET(new Request('https://x/api/projects/abc/progress'), { params: Promise.resolve({ id: 'abc' }) })).status, 400);
});
