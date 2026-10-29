/**
 * Ремонт доступа к профилю и админке — на настоящей базе (pglite).
 *
 * Сценарий, ради которого файл существует: после обновления роль в
 * `profiles` остаётся `admin`, psql это подтверждает, а админка пишет
 * «Доступ запрещён» и половина сайта показывает пустые имена. Причина —
 * не данные, а права: снятый грант, потерянная политика или устаревший
 * кэш схемы PostgREST.
 *
 * Здесь поднимается именно такое «сломанное» состояние, затем накатывается
 * `supabase/migrations/20261105090000_profiles_access_repair.sql`, и
 * проверяется фактическое поведение ролей:
 *
 *   • персонал снова читает свой профиль и все строки (админка открывается);
 *   • обычный пользователь видит только свой профиль;
 *   • anon по-прежнему не читает `profiles` (закрытая утечка email не вернулась);
 *   • самоназначение админом отклоняется триггером;
 *   • публичное представление отдаёт имена, но не приватные колонки;
 *   • отсутствующая строка профиля восстанавливается как `user`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const STAFF = '00000000-0000-4000-8000-00000000000c';
const NO_PROFILE = '00000000-0000-4000-8000-00000000000d';

async function signIn(uuid) {
  await db.exec(`SET request.jwt.claim.sub = '${uuid}'`);
  await db.exec('SET ROLE authenticated');
}
async function signOut() {
  await db.exec('RESET ROLE');
  await db.exec('RESET request.jwt.claim.sub');
}

const repairSql = () => readFileSync(
  new URL('../../supabase/migrations/20261105090000_profiles_access_repair.sql', import.meta.url),
  'utf8',
).replace(/NOTIFY\s+pgrst[^;]*;/g, ''); // NOTIFY — транспорт PostgREST, базе не нужен

test.before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;

    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    -- В Supabase схемы auth/public открыты ролям; без USAGE не резолвится auth.uid().
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;

    CREATE TABLE auth.users (
      id uuid PRIMARY KEY,
      email text,
      raw_user_meta_data jsonb NOT NULL DEFAULT '{}'::jsonb
    );

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      email TEXT,
      cmdr_name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      squadron TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      forum_posts_count INTEGER NOT NULL DEFAULT 0
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

    CREATE TABLE public.app_flags (key TEXT PRIMARY KEY, value JSONB NOT NULL DEFAULT '{}'::jsonb);
    CREATE TABLE public.news (id BIGSERIAL PRIMARY KEY, title TEXT);

    INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
      ('${USER_A}', 'cmdr-a@example.com', '{"cmdr_name":"CMDR Alice"}'),
      ('${USER_B}', 'cmdr-b@example.com', '{}'),
      ('${STAFF}', 'staff@example.com', '{"cmdr_name":"CMDR Staff"}'),
      ('${NO_PROFILE}', 'noprofile@example.com', '{}');

    INSERT INTO public.profiles (id, email, cmdr_name, role) VALUES
      ('${USER_A}', 'cmdr-a@example.com', 'CMDR Alice', 'user'),
      ('${USER_B}', 'cmdr-b@example.com', 'CMDR Bob', 'user'),
      ('${STAFF}', 'staff@example.com', 'CMDR Staff', 'admin');
  `);

  // ── «Сломанное» состояние: так выглядит база, где доступ пропал ──
  //  • у authenticated снят SELECT — клиент не читает даже свою строку;
  //  • политика profiles_select потеряна;
  //  • триггер защиты роли отсутствует.
  //
  //  Представления при этом ОСТАЮТСЯ — как на живой базе после
  //  20261015000000 (public_profiles) и 20261016000000, который перевёл
  //  squadron_member_detail на public_profiles. Раньше ремонт делал
  //  `DROP VIEW public_profiles` и падал на зависимости
  //  («cannot drop view public_profiles because other objects depend on it»,
  //  SQLSTATE 2BP01) — обновление останавливалось. Теперь накат обязан
  //  проходить именно на такой базе, поэтому она и воспроизводится здесь.
  await db.exec(`
    REVOKE ALL ON public.profiles FROM authenticated;
    REVOKE ALL ON public.profiles FROM anon;
    DROP POLICY IF EXISTS profiles_select ON public.profiles;
    DROP POLICY IF EXISTS profiles_update ON public.profiles;

    CREATE VIEW public.public_profiles AS
      SELECT id, cmdr_name, avatar_url, squadron, created_at, updated_at, forum_posts_count
      FROM public.profiles;
    CREATE VIEW public.squadron_member_detail WITH (security_invoker = true) AS
      SELECT p.cmdr_name, p.squadron FROM public.public_profiles p;
    GRANT SELECT ON public.public_profiles TO anon, authenticated;
    GRANT SELECT ON public.squadron_member_detail TO anon, authenticated;
  `);
});

test.after(async () => { await db.close(); });

test('до ремонта админ не может прочитать даже свой профиль', async () => {
  await signIn(STAFF);
  try {
    await assert.rejects(
      db.query('SELECT role FROM public.profiles WHERE id = auth.uid()'),
      /permission denied/,
      'именно это браузер видел как «нет прав»',
    );
  } finally {
    await signOut();
  }
});

test('ремонт применяется идемпотентно', async () => {
  await db.exec(repairSql());
  // Повторный накат (как при следующем обновлении) не должен падать.
  await db.exec(repairSql());
});

test('после ремонта персонал снова видит свой профиль и все строки', async () => {
  await signIn(STAFF);
  try {
    const own = (await db.query('SELECT role FROM public.profiles WHERE id = auth.uid()')).rows;
    assert.deepEqual(own, [{ role: 'admin' }], 'админка снова получает роль');

    const all = (await db.query('SELECT count(*)::int AS n FROM public.profiles')).rows;
    assert.equal(all[0].n, 4, 'персонал видит все профили, включая восстановленный');
  } finally {
    await signOut();
  }
});

test('обычный пользователь видит только свой профиль', async () => {
  await signIn(USER_A);
  try {
    const rows = (await db.query('SELECT id FROM public.profiles')).rows;
    assert.deepEqual(rows.map((r) => r.id), [USER_A]);
  } finally {
    await signOut();
  }
});

test('anon по-прежнему не читает profiles, но видит имена в public_profiles', async () => {
  await db.exec('SET ROLE anon');
  try {
    await assert.rejects(
      db.query('SELECT id FROM public.profiles'),
      /permission denied/,
    );
    const names = (await db.query('SELECT cmdr_name FROM public.public_profiles ORDER BY cmdr_name')).rows;
    assert.deepEqual(names.map((r) => r.cmdr_name), ['CMDR Alice', 'CMDR Bob', 'CMDR Staff', 'noprofile']);
    await assert.rejects(db.query('SELECT email FROM public.public_profiles'), /column/);
    await assert.rejects(db.query('SELECT role FROM public.public_profiles'), /column/);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('ремонт не открывает самоназначение админом', async () => {
  await signIn(USER_A);
  try {
    await assert.rejects(
      db.query(`UPDATE public.profiles SET role = 'admin' WHERE id = auth.uid()`),
      /только администратор/,
    );
    await assert.rejects(
      db.query(`UPDATE public.profiles SET email = 'fake@example.com' WHERE id = auth.uid()`),
      /синхронизируется только сервером/,
    );
    // Обычная правка собственного профиля остаётся доступной.
    await db.query(`UPDATE public.profiles SET cmdr_name = 'CMDR Alice II' WHERE id = auth.uid()`);
  } finally {
    await signOut();
  }
});

test('администратор меняет роль другого пилота (то, что делает админка)', async () => {
  await signIn(STAFF);
  try {
    await db.query(`UPDATE public.profiles SET role = 'moderator' WHERE id = '${USER_B}'`);
    const changed = (await db.query(`SELECT role FROM public.profiles WHERE id = '${USER_B}'`)).rows;
    assert.deepEqual(changed, [{ role: 'moderator' }]);
    await db.query(`UPDATE public.profiles SET role = 'user' WHERE id = '${USER_B}'`);
  } finally {
    await signOut();
  }
});

test('таблицы админки снова читаются, а отсутствующий профиль восстановлен', async () => {
  await signIn(STAFF);
  try {
    const flags = (await db.query('SELECT key FROM public.app_flags')).rows;
    assert.deepEqual(flags, []);
    const restored = (await db.query(
      `SELECT cmdr_name, role, email FROM public.profiles WHERE id = '${NO_PROFILE}'`,
    )).rows;
    assert.deepEqual(restored, [{ cmdr_name: 'noprofile', role: 'user', email: 'noprofile@example.com' }]);
  } finally {
    await signOut();
  }
});

test('накат на живой базе: squadron_member_detail зависит от public_profiles', async () => {
  // Регрессия: ремонт не должен удалять представление, на котором висят
  // другие объекты. Именно на этом падала миграция (SQLSTATE 2BP01), и
  // обновление проекта останавливалось на «SQL миграция, код 1».
  await db.exec(repairSql());
  const rows = (await db.query(
    'SELECT cmdr_name FROM public.squadron_member_detail ORDER BY cmdr_name',
  )).rows;
  // Состав важнее точных подписей: выше по файлу пилот переименовывал себя.
  const names = rows.map((r) => r.cmdr_name);
  assert.equal(names.length, 4, 'зависимое представление живо и отдаёт все строки');
  for (const expected of ['CMDR Bob', 'CMDR Staff', 'noprofile']) {
    assert.ok(names.includes(expected), `в представлении есть ${expected}`);
  }
});

test('накат не оставляет базу без представления, если оно уже было', async () => {
  // После ремонта public_profiles обязан существовать и читаться обеими
  // ролями — даже если до наката он уже был.
  await db.exec('SET ROLE anon');
  try {
    const n = (await db.query('SELECT count(*)::int AS n FROM public.public_profiles')).rows;
    assert.equal(n[0].n, 4);
    const dep = (await db.query('SELECT count(*)::int AS n FROM public.squadron_member_detail')).rows;
    assert.equal(dep[0].n, 4);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('представление, которое уже правильное, не пересоздаётся (замка на него нет)', async () => {
  // Живая база: public_profiles создала 20261015000000, и он ровно такой.
  // Пересоздание = исключительный замок на представление, которое читает весь
  // сайт; именно из-за него 29.10.2026 обновление получило deadlock. OID
  // остаётся прежним только если представление не трогали.
  const oidOf = async () => (await db.query("SELECT 'public.public_profiles'::regclass::oid::int AS oid")).rows[0].oid;
  const before = await oidOf();
  await db.exec(repairSql());
  const after = await oidOf();
  assert.equal(after, before, 'представление не пересоздавалось: замка на него не было');
});

test('чужое представление без зависимых объектов чинится пересозданием', async () => {
  // Обратный случай: в базе представление с другими колонками, и от него
  // ничего не зависит. Ремонт обязан вернуть публичный набор колонок —
  // и именно пересозданием: CREATE OR REPLACE не умеет переименовывать
  // колонки («cannot change name of view column»).
  await db.exec(`
    DROP VIEW IF EXISTS public.squadron_member_detail;
    DROP VIEW IF EXISTS public.public_profiles;
    CREATE VIEW public.public_profiles AS SELECT id, email, cmdr_name FROM public.profiles;
  `);

  await db.exec(repairSql());
  const cols = (await db.query(`
    SELECT string_agg(attname, ',' ORDER BY attnum) AS c
    FROM pg_attribute
    WHERE attrelid = 'public.public_profiles'::regclass AND attnum > 0
  `)).rows[0].c;
  assert.equal(cols, 'id,cmdr_name,avatar_url,squadron,created_at,updated_at,forum_posts_count');

  // Возвращаем «живую» схему: squadron_member_detail снова зависит от
  // публичного представления, как на сервере.
  await db.exec(`
    CREATE VIEW public.squadron_member_detail WITH (security_invoker = true) AS
      SELECT p.cmdr_name, p.squadron FROM public.public_profiles p;
    GRANT SELECT ON public.squadron_member_detail TO anon, authenticated;
    GRANT SELECT ON public.public_profiles TO anon, authenticated;
  `);
});

test('правильные политики и триггер не пересоздаются: замка на profiles нет', async () => {
  // Самая дорогая часть ремонта — исключительный замок на profiles (политики)
  // и SHARE ROW EXCLUSIVE (триггер). На живой базе, где права целы, оба шага
  // обязаны быть пустыми: иначе обновление снова ждёт сайт и падает
  // «lock timeout» / «deadlock detected».
  const oids = async () => ({
    policies: (await db.query('SELECT oid::int AS oid, polname FROM pg_policy ORDER BY polname')).rows,
    trigger: (await db.query(
      "SELECT oid::int AS oid FROM pg_trigger WHERE tgname = 'trg_protect_profile_privileged_columns'",
    )).rows,
  });
  const before = await oids();
  assert.equal(before.policies.length, 3, 'три политики на месте');
  assert.equal(before.trigger.length, 1, 'триггер на месте');

  await db.exec(repairSql());

  const after = await oids();
  assert.deepEqual(after.policies, before.policies, 'политики не пересоздавались');
  assert.deepEqual(after.trigger, before.trigger, 'триггер не пересоздавался');
});

test('сломанная политика пересоздаётся, а не остаётся как была', async () => {
  // Обратный случай: политика есть, но пускает всех — ремонт обязан её
  // заменить (и это единственный шаг, которому нужен исключительный замок).
  await db.exec(`
    DROP POLICY profiles_select ON public.profiles;
    CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated USING (true);
  `);
  await db.exec(repairSql());
  const qual = (await db.query(
    "SELECT qual FROM pg_policies WHERE schemaname = 'public' AND tablename = 'profiles' AND policyname = 'profiles_select'",
  )).rows[0].qual.replace(/\s+/g, ' ');
  assert.match(qual, /auth\.uid\(\)/);
  assert.match(qual, /request_is_staff\(\)/);
  assert.doesNotMatch(qual, /^true$/);
});

