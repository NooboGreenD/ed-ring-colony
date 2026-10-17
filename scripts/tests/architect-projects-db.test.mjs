import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

/* «Проекты систем» Архитектора в БД
   (supabase/migrations/20261017120000_architect_projects.sql).

   Миграция исполняется настоящим PostgreSQL (PGlite): проверяются создание
   проекта одной транзакцией, единственный создатель и его передача, RLS
   (проект видят только участники), уход участника и удаление аккаунта
   создателя, а также функции вклада пилотов и источников прогресса. */

const db = new PGlite();
const OWNER = '00000000-0000-4000-8000-000000000001';
const MOD = '00000000-0000-4000-8000-000000000002';
const MEMBER = '00000000-0000-4000-8000-000000000003';
const STRANGER = '00000000-0000-4000-8000-000000000004';
const ADMIN = '00000000-0000-4000-8000-000000000005';
const GUEST = '00000000-0000-4000-8000-000000000006';
const FC = '3700005632';
const FC_OTHER = '3700009999';

await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE TABLE auth.users(id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
INSERT INTO auth.users VALUES ('${OWNER}'), ('${MOD}'), ('${MEMBER}'), ('${STRANGER}'), ('${ADMIN}'), ('${GUEST}');
CREATE TABLE public.profiles(id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE, cmdr_name text, role text DEFAULT 'user');
INSERT INTO public.profiles(id, cmdr_name, role) VALUES
  ('${OWNER}', 'Owner', 'user'), ('${MOD}', 'Mod', 'user'), ('${MEMBER}', 'Member', 'user'),
  ('${STRANGER}', 'Stranger', 'user'), ('${ADMIN}', 'Admin', 'admin'), ('${GUEST}', 'Guest', 'user');
CREATE FUNCTION public.request_is_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS
  $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;
GRANT EXECUTE ON FUNCTION public.request_is_admin() TO authenticated;
CREATE TABLE public.system_plans(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), system_name text, title text DEFAULT '', author_id uuid,
  author_name text DEFAULT '', visibility text DEFAULT 'private', plan jsonb, site_count int DEFAULT 0,
  haul_tons bigint DEFAULT 0, catalogue_version int DEFAULT 0, updated_at timestamptz DEFAULT now());
CREATE TABLE public.system_progress(system_name text PRIMARY KEY, progress int, updated_at timestamptz DEFAULT now(), data jsonb);
CREATE TABLE public.colonisation_sites(
  market_id bigint PRIMARY KEY, system_name text NOT NULL, construction_id bigint, construction_name text,
  construction_progress numeric(5,2), resources_total jsonb NOT NULL DEFAULT '[]', event_timestamp timestamptz NOT NULL,
  user_id uuid);
CREATE TABLE public.fleet_carriers(carrier_id bigint PRIMARY KEY);
INSERT INTO public.fleet_carriers VALUES (${FC}), (${FC_OTHER});
CREATE TABLE public.fleet_carrier_events(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, carrier_id bigint REFERENCES public.fleet_carriers(carrier_id),
  event_hash text, user_id uuid, source text DEFAULT 'helper', event text, commodity text, delta int, event_at timestamptz);
CREATE TABLE public.deliveries(
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
  system_name text NOT NULL, commodity text, amount int, delivered_at timestamptz, created_at timestamptz DEFAULT now(),
  market_id text, station_name text, delivery_kind text, is_construction boolean);
`);
await db.exec(readFileSync(new URL('../../supabase/migrations/20261017120000_architect_projects.sql', import.meta.url), 'utf8'));

async function asUser(userId, sql, params = []) {
  await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub', '${userId}', false);`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec(`RESET ROLE; SELECT set_config('request.jwt.claim.sub', '', false);`);
  }
}

async function createProject(owner, name, systems = []) {
  const { rows } = await db.query(
    'SELECT architect_project_create($1::uuid, $2, $3, $4, $5::text[]) AS id',
    [owner, name, 'описание', '#3498DB', systems],
  );
  return rows[0].id;
}

async function members(projectId) {
  const { rows } = await db.query(
    'SELECT user_id, role FROM architect_project_members WHERE project_id = $1 ORDER BY user_id', [projectId]);
  return Object.fromEntries(rows.map((row) => [row.user_id, row.role]));
}

test.after(async () => { await db.close(); });

test('создание проекта: создатель-участник, системы без дублей и в порядке ввода', async () => {
  const id = await createProject(OWNER, '  Кольцо Пегаса  ', ['HIP 1', 'hip  1', ' Col 285 Sector AB-C d1 ', '', 'Synuefe XR-H d11-102']);
  const { rows: [project] } = await db.query('SELECT name, color, status, created_by FROM architect_projects WHERE id = $1', [id]);
  assert.equal(project.name, 'Кольцо Пегаса');
  assert.equal(project.color, '#3498db', 'цвет приводится к нижнему регистру');
  assert.equal(project.status, 'active');
  assert.equal(project.created_by, OWNER);
  assert.deepEqual(await members(id), { [OWNER]: 'owner' });

  const { rows: systems } = await db.query(
    'SELECT system_name, system_name_lc, sort_order FROM architect_project_systems WHERE project_id = $1 ORDER BY sort_order', [id]);
  assert.deepEqual(systems.map((row) => row.system_name), ['HIP 1', 'Col 285 Sector AB-C d1', 'Synuefe XR-H d11-102']);
  assert.equal(systems[0].system_name_lc, 'hip 1');
});

test('создатель один: второй owner запрещён индексом, передача проекта атомарна', async () => {
  const id = await createProject(OWNER, 'Передача', ['Sol']);
  await db.query(`INSERT INTO architect_project_members(project_id, user_id, role) VALUES ($1, $2, 'moderator'), ($1, $3, 'member')`, [id, MOD, MEMBER]);
  await assert.rejects(
    db.query(`UPDATE architect_project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2`, [id, MEMBER]),
    /duplicate key|unique/i,
  );

  await assert.rejects(db.query('SELECT architect_project_transfer($1, $2)', [id, STRANGER]), /not a member/);
  assert.deepEqual(await members(id), { [OWNER]: 'owner', [MOD]: 'moderator', [MEMBER]: 'member' }, 'неудачная передача ничего не меняет');

  await db.query('SELECT architect_project_transfer($1, $2)', [id, MEMBER]);
  assert.deepEqual(await members(id), { [OWNER]: 'moderator', [MOD]: 'moderator', [MEMBER]: 'owner' });
});

test('RLS: проект видят только участники и администратор; писать напрямую нельзя', async () => {
  const id = await createProject(OWNER, 'Приватный', ['Achenar']);
  await db.query(`INSERT INTO architect_project_members(project_id, user_id, role) VALUES ($1, $2, 'member')`, [id, MEMBER]);

  const visible = async (user) => (await asUser(user, 'SELECT id FROM architect_projects WHERE id = $1', [id])).rows.length;
  assert.equal(await visible(OWNER), 1);
  assert.equal(await visible(MEMBER), 1);
  assert.equal(await visible(STRANGER), 0, 'посторонний не видит проект');
  assert.equal(await visible(ADMIN), 1, 'администратор видит для разбора');

  const strangerSystems = await asUser(STRANGER, 'SELECT id FROM architect_project_systems WHERE project_id = $1', [id]);
  assert.equal(strangerSystems.rows.length, 0);
  const memberList = await asUser(MEMBER, 'SELECT user_id FROM architect_project_members WHERE project_id = $1', [id]);
  assert.equal(memberList.rows.length, 2, 'участник видит состав (политика members не рекурсивна)');

  await assert.rejects(
    asUser(OWNER, `INSERT INTO architect_project_systems(project_id, system_name) VALUES ($1, 'Hack')`, [id]),
    /permission denied/i,
    'даже создатель пишет только через маршруты (service_role)',
  );
  await assert.rejects(asUser(MEMBER, 'SELECT architect_project_contributions($1, NULL)', [id]), /permission denied/i);
});

test('уход участника снимает ответственность; удаление аккаунта создателя передаёт проект', async () => {
  const id = await createProject(OWNER, 'Наследование', ['Lave', 'Leesti']);
  await db.query(`INSERT INTO architect_project_members(project_id, user_id, role, created_at) VALUES
    ($1, $2, 'member', now() - interval '3 days'), ($1, $3, 'moderator', now() - interval '1 day')`, [id, MEMBER, MOD]);
  await db.query(`UPDATE architect_project_systems SET responsible_id = $2 WHERE project_id = $1`, [id, MEMBER]);

  await db.query('DELETE FROM architect_project_members WHERE project_id = $1 AND user_id = $2', [id, MEMBER]);
  const { rows } = await db.query('SELECT count(*)::int AS n FROM architect_project_systems WHERE project_id = $1 AND responsible_id IS NOT NULL', [id]);
  assert.equal(rows[0].n, 0, 'ушедший пилот больше не ответственный');

  // Создатель удалил аккаунт: проект переходит модератору, а не исчезает.
  await db.query('DELETE FROM auth.users WHERE id = $1', [OWNER]);
  assert.deepEqual(await members(id), { [MOD]: 'owner' });

  // Ушёл последний — пустой проект удаляется.
  await db.query('DELETE FROM architect_project_members WHERE project_id = $1 AND user_id = $2', [id, MOD]);
  const { rows: left } = await db.query('SELECT count(*)::int AS n FROM architect_projects WHERE id = $1', [id]);
  assert.equal(left[0].n, 0);
  await db.query(`INSERT INTO auth.users VALUES ('${OWNER}')`);
  await db.query(`INSERT INTO public.profiles(id, cmdr_name) VALUES ('${OWNER}', 'Owner')`);
});

test('удаление проекта каскадом не запускает наследование', async () => {
  const id = await createProject(OWNER, 'Под снос', ['Diaguandri']);
  await db.query(`INSERT INTO architect_project_members(project_id, user_id, role) VALUES ($1, $2, 'moderator'), ($1, $3, 'member')`, [id, MOD, MEMBER]);
  await db.query(`INSERT INTO architect_project_carriers(project_id, carrier_id) VALUES ($1, ${FC})`, [id]);
  await db.query('DELETE FROM architect_projects WHERE id = $1', [id]);
  for (const table of ['architect_project_members', 'architect_project_systems', 'architect_project_carriers']) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table} WHERE project_id = $1`, [id]);
    assert.equal(rows[0].n, 0, `${table} очищена каскадом`);
  }
});

test('вклад пилотов: стройка в системах проекта, авианосцы проекта, границы времени', async () => {
  const id = await createProject(OWNER, 'Лидеры', ['HIP 90297', 'Ross 128']);
  await db.query(`INSERT INTO architect_project_carriers(project_id, carrier_id) VALUES ($1, ${FC})`, [id]);
  await db.query(`INSERT INTO deliveries(user_id, system_name, commodity, amount, delivered_at, market_id, station_name, delivery_kind, is_construction) VALUES
    ('${MEMBER}', 'HIP 90297', 'Steel', 500, '2026-10-01T10:00:00Z', '3900000001', 'Orbital Construction Site: Alpha', 'construction_site', true),
    ('${MEMBER}', 'hip 90297', 'Steel', 300, '2026-10-02T10:00:00Z', '3900000001', NULL, 'construction_site', true),
    ('${MEMBER}', 'HIP 90297', 'Titanium', 200, '2026-10-02T11:00:00Z', '3900000002', 'Planetary Construction Site: Beta', 'colonisation_ship', true),
    ('${GUEST}', 'HIP 90297', 'Сталь', 100, '2026-10-03T09:00:00Z', '3900000001', NULL, 'construction_site', true),
    ('${MEMBER}', 'Ross 128', 'Copper', 50, NULL, NULL, NULL, NULL, NULL),
    ('${MEMBER}', 'Ross 128', 'Gold', 999, '2026-10-02T10:00:00Z', NULL, NULL, NULL, false),
    ('${MEMBER}', 'HIP 90297', 'Steel', 700, '2026-10-02T10:00:00Z', '3800000000', NULL, 'market_sale', false),
    ('${MEMBER}', 'Sol', 'Steel', 400, '2026-10-02T10:00:00Z', '3900000009', NULL, 'construction_site', true),
    ('${MEMBER}', 'HIP 90297', 'Steel', 0, '2026-10-02T10:00:00Z', '3900000001', NULL, 'construction_site', true),
    ('${GUEST}', 'Sol', 'Steel', 1000, '2026-10-04T10:00:00Z', '${FC}', 'Carrier', 'fleet_carrier', false),
    ('${GUEST}', 'Sol', 'Steel', 9000, '2026-10-04T10:00:00Z', '${FC_OTHER}', 'Carrier', 'fleet_carrier', false)`);
  await db.query(`UPDATE deliveries SET created_at = '2026-10-06T00:00:00Z' WHERE commodity = 'Copper' AND delivered_at IS NULL`);
  await db.query(`INSERT INTO fleet_carrier_events(carrier_id, event_hash, user_id, event, commodity, delta, event_at) VALUES
    (${FC}, 'a', '${OWNER}', 'CargoTransfer', 'titanium', 800, '2026-10-05T10:00:00Z'),
    (${FC}, 'b', '${OWNER}', 'CargoTransfer', 'titanium', -300, '2026-10-05T11:00:00Z'),
    (${FC}, 'c', '${OWNER}', 'CargoTransfer', 'copper', 100, '2026-10-05T10:00:00Z'),
    (${FC}, 'd', '${OWNER}', 'CargoTransfer', 'copper', -100, '2026-10-05T12:00:00Z'),
    (${FC}, 'e', '${GUEST}', 'MarketSell', 'steel', 1000, '2026-10-04T10:00:00Z')`);

  const rowsFor = async (since = null) => (await db.query(
    `SELECT user_id, target, system_name, market_id, station_name, commodity, tons::int, ops::int
       FROM architect_project_contributions($1, $2) ORDER BY target, user_id, market_id NULLS LAST, commodity`, [id, since])).rows;

  const all = await rowsFor();
  const site = all.filter((row) => row.target === 'site');
  assert.deepEqual(site.map((row) => [row.user_id, row.market_id, row.commodity, row.tons, row.ops]), [
    [MEMBER, '3900000001', 'Steel', 800, 2],
    [MEMBER, '3900000002', 'Titanium', 200, 1],
    [MEMBER, null, 'Copper', 50, 1],
    [GUEST, '3900000001', 'Сталь', 100, 1],
  ], 'регистр имени системы не делит группу; не-стройка, чужие системы и нулевые строки не считаются');
  const alpha = site.find((row) => row.market_id === '3900000001' && row.user_id === MEMBER);
  assert.equal(alpha.station_name, 'Orbital Construction Site: Alpha', 'имя площадки берётся из любой строки группы');
  assert.equal(alpha.system_name.toLowerCase(), 'hip 90297');

  const carrier = all.filter((row) => row.target === 'carrier');
  assert.deepEqual(carrier.map((row) => [row.user_id, row.market_id, row.commodity, row.tons]), [
    [OWNER, FC, 'titanium', 500],
    [GUEST, FC, 'Steel', 1000],
  ], 'продажа на свой носитель проекта и чистая загрузка владельцем; MarketSell из ledger не задваивается, чужой носитель не считается');

  const late = await rowsFor('2026-10-02T10:30:00Z');
  assert.deepEqual(late.filter((row) => row.target === 'site').map((row) => [row.user_id, row.commodity, row.tons]).sort(),
    [[GUEST, 'Сталь', 100], [MEMBER, 'Copper', 50], [MEMBER, 'Titanium', 200]].sort(),
    'p_since отсекает ранние поставки; строка без delivered_at берёт created_at');

  await db.query(`UPDATE architect_projects SET tracking_since = '2026-10-03T00:00:00Z' WHERE id = $1`, [id]);
  const tracked = await rowsFor('2026-09-01T00:00:00Z');
  assert.deepEqual(tracked.filter((row) => row.target === 'site').map((row) => [row.user_id, row.commodity]).sort(),
    [[GUEST, 'Сталь'], [MEMBER, 'Copper']].sort(), 'tracking_since проекта сильнее более раннего p_since');

  const { rows: activity } = await db.query(
    `SELECT day::text, user_id, target, tons::int FROM architect_project_activity($1, NULL) ORDER BY day, user_id, target`, [id]);
  assert.ok(activity.every((row) => row.day >= '2026-10-03'), 'активность тоже уважает tracking_since');
  assert.ok(activity.some((row) => row.target === 'carrier' && row.tons === 1000));
  await db.query(`UPDATE architect_projects SET tracking_since = NULL WHERE id = $1`, [id]);
  const { rows: fullActivity } = await db.query(
    `SELECT day::text, user_id, target, tons::int FROM architect_project_activity($1, NULL) WHERE user_id = $2 AND target = 'site' ORDER BY day`, [id, MEMBER]);
  assert.deepEqual(fullActivity.filter((row) => row.day.startsWith('2026-10-0')).map((row) => [row.day, row.tons]),
    [['2026-10-01', 500], ['2026-10-02', 500], ['2026-10-06', 50]]);
});

test('источники прогресса: кэш Raven и журнальные площадки без учёта регистра, план по ссылке', async () => {
  const id = await createProject(OWNER, 'Источники', ['Pegasi Sector XY', 'Empty System']);
  const { rows: [plan] } = await db.query(
    `INSERT INTO system_plans(system_name, title, author_id, author_name, visibility, plan, site_count, haul_tons)
     VALUES ('Pegasi Sector XY', 'План', $1, 'Owner', 'private', '{"sites": []}', 3, 120000) RETURNING id`, [OWNER]);
  await db.query(`UPDATE architect_project_systems SET plan_id = $2 WHERE project_id = $1 AND system_name = 'Pegasi Sector XY'`, [id, plan.id]);
  await db.query(`INSERT INTO system_progress(system_name, progress, updated_at, data) VALUES
    ('PEGASI SECTOR XY', 40, '2026-10-10T00:00:00Z', '{"projects": []}'),
    ('Pegasi Sector XY', 55, '2026-10-12T00:00:00Z', '{"projects": [{"buildId": "1"}]}'),
    ('Other', 10, now(), '{}')`);
  await db.query(`INSERT INTO colonisation_sites(market_id, system_name, construction_progress, resources_total, event_timestamp) VALUES
    (3900000123, 'pegasi sector xy', 50, '[{"Name": "$steel_name;", "RequiredAmount": 100, "ProvidedAmount": 50}]', '2026-10-11T00:00:00Z'),
    (3900000999, 'Elsewhere', 10, '[]', '2026-10-11T00:00:00Z')`);

  const { rows: [{ sources }] } = await db.query('SELECT architect_project_progress_sources($1, true) AS sources', [id]);
  assert.equal(sources.raven.length, 2, 'оба варианта написания кэша — выбор свежего за кодом');
  assert.ok(sources.raven.every((row) => row.system_key === 'pegasi sector xy'));
  assert.deepEqual(sources.depots.map((row) => row.market_id), ['3900000123'], 'MarketID отдаётся строкой без потери точности');
  assert.equal(sources.plans.length, 1);
  assert.equal(sources.plans[0].site_count, 3);
  assert.deepEqual(sources.plans[0].plan, { sites: [] });

  const { rows: [{ light }] } = await db.query('SELECT architect_project_progress_sources($1, false) AS light', [id]);
  assert.equal(light.plans[0].plan, null, 'лидерборду JSON плана не нужен');
});
