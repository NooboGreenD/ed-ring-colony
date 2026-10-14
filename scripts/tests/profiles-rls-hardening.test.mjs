/**
 * Функциональная проверка миграции 20261015000000_profiles_rls_hardening.
 *
 * Уязвимость, которую чинит миграция:
 *   • profiles читалась ролью anon (`USING (true)`): публичный anon-ключ
 *     из браузера давал выгрузить email всех аккаунтов напрямую через
 *     PostgREST, минуя сайт;
 *   • profiles_update проверял только владение строкой, поэтому любой
 *     вошедший мог записать себе role = 'admin';
 *   • deliveries читалась кем угодно — настройки приватности досье
 *     обходились прямым запросом к базе.
 *
 * Здесь поднимается настоящая база (pglite), накатывается «уязвимое»
 * состояние политик, затем — сама миграция, и проверяется фактическое
 * поведение ролей: anon, владелец, персонал и service_role.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const STAFF = '00000000-0000-4000-8000-00000000000c';

/** Кто «вошёл» в этом запросе: подменяем sub JWT-клейма, как GoTrue. */
async function signIn(uuid) {
  await db.exec(`SET request.jwt.claim.sub = '${uuid}'`);
}
async function signOut() {
  await db.exec('RESET request.jwt.claim.sub');
}

test.before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;

    -- Минимальный GoTrue: auth.uid() читает sub из JWT-клейма запроса.
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      email TEXT,
      cmdr_name TEXT,
      avatar_url TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      squadron TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      forum_posts_count INTEGER NOT NULL DEFAULT 0,
      privacy_settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      language VARCHAR(10) NOT NULL DEFAULT 'ru'
    );

    CREATE TABLE public.deliveries (
      id BIGSERIAL PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
      system_name TEXT NOT NULL,
      commodity TEXT,
      amount INTEGER,
      delivered_at TIMESTAMPTZ,
      is_hub BOOLEAN DEFAULT false,
      route_system_id BIGINT,
      source_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- ─── «Уязвимое» состояние из 001_rls_policies.sql ───
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY profiles_select ON public.profiles
      FOR SELECT TO anon, authenticated USING (true);
    CREATE POLICY profiles_insert ON public.profiles
      FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
    CREATE POLICY profiles_update ON public.profiles
      FOR UPDATE TO authenticated
      USING (id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'))
      WITH CHECK (id = auth.uid() OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role = 'admin'));
    GRANT SELECT ON public.profiles TO anon, authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.profiles TO authenticated;

    ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY deliveries_select ON public.deliveries
      FOR SELECT TO anon, authenticated USING (true);
    CREATE POLICY deliveries_insert ON public.deliveries
      FOR INSERT TO authenticated WITH CHECK (user_id = auth.uid());
    GRANT SELECT ON public.deliveries TO anon, authenticated;
    GRANT INSERT, UPDATE, DELETE ON public.deliveries TO authenticated;

    -- Supabase по умолчанию даёт service_role полные права на public-таблицы.
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.profiles TO service_role;
    GRANT SELECT, INSERT, UPDATE, DELETE ON public.deliveries TO service_role;

    -- request_is_admin() существует с 20261006000000_system_architects.sql:
    -- триггер миграции на него опирается.
    CREATE OR REPLACE FUNCTION public.request_is_admin()
    RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path = public
    AS $fn$
      SELECT EXISTS (
        SELECT 1 FROM public.profiles
        WHERE id = auth.uid() AND role = 'admin'
      );
    $fn$;
  `);

  // Сама миграция (NOTIFY — транспортный вызов PostgREST, базе не нужен).
  const migration = readFileSync(
    new URL('../../supabase/migrations/20261015000000_profiles_rls_hardening.sql', import.meta.url),
    'utf8',
  ).replace(/NOTIFY\s+pgrst[^;]*;/g, '');
  await db.exec(migration);

  await db.exec(`
    INSERT INTO public.profiles (id, email, cmdr_name, role) VALUES
      ('${USER_A}', 'cmdr-a@example.com', 'CMDR Alice', 'user'),
      ('${USER_B}', 'cmdr-b@example.com', 'CMDR Bob', 'user'),
      ('${STAFF}', 'staff@example.com', 'CMDR Staff', 'admin');
    INSERT INTO public.deliveries (user_id, system_name, commodity, amount) VALUES
      ('${USER_A}', 'Sol', 'Steel', 100),
      ('${USER_B}', 'Achenar', 'Titanium', 50);
  `);
});

test.after(async () => { await db.close(); });

test('до фикса anon видел email всех аккаунтов, после — не может читать profiles вовсе', async () => {
  await signOut();
  await db.exec('SET ROLE anon');
  try {
    // Старая политика пропускала anon; новая сняла GRANT, поэтому запрос
    // отклоняется на этапе привилегий — раньше строки возвращались.
    await assert.rejects(
      db.query('SELECT id, email FROM public.profiles'),
      /permission denied/,
    );
    await assert.rejects(
      db.query('SELECT * FROM public.deliveries'),
      /permission denied/,
    );
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('public_profiles: все строки, но только публичные колонки', async () => {
  await signOut();
  await db.exec('SET ROLE anon');
  try {
    const { rows } = await db.query('SELECT id, cmdr_name, avatar_url, squadron, created_at FROM public.public_profiles ORDER BY cmdr_name');
    assert.equal(rows.length, 3, 'публичное представление отдаёт все профили');
    assert.deepEqual(rows.map((r) => r.cmdr_name), ['CMDR Alice', 'CMDR Bob', 'CMDR Staff']);
    // Приватных колонок в представлении нет вовсе.
    await assert.rejects(db.query('SELECT email FROM public.public_profiles'), /column/);
    await assert.rejects(db.query('SELECT role FROM public.public_profiles'), /column/);
    await assert.rejects(db.query('SELECT privacy_settings FROM public.public_profiles'), /column/);
    await assert.rejects(db.query('SELECT language FROM public.public_profiles'), /column/);
    // Запись через представление недоступна.
    await assert.rejects(
      db.query("UPDATE public.public_profiles SET cmdr_name = 'Hacked'"),
      /permission denied/,
    );
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('вошедший пользователь видит только свой профиль и свои доставки', async () => {
  await signIn(USER_A);
  await db.exec('SET ROLE authenticated');
  try {
    const profiles = (await db.query('SELECT id, email FROM public.profiles')).rows;
    assert.deepEqual(profiles.map((r) => r.id), [USER_A], 'чужие профили не видны');
    assert.equal(profiles[0].email, 'cmdr-a@example.com', 'свой email владелец видит как раньше');

    const deliveries = (await db.query('SELECT user_id FROM public.deliveries')).rows;
    assert.deepEqual(deliveries.map((r) => r.user_id), [USER_A], 'чужие доставки не видны');
  } finally {
    await db.exec('RESET ROLE');
    await signOut();
  }
});

test('персонал (admin/moderator/support_manager) видит все профили и доставки', async () => {
  await signIn(STAFF);
  await db.exec('SET ROLE authenticated');
  try {
    const profiles = (await db.query('SELECT count(*)::int AS n FROM public.profiles')).rows;
    assert.equal(profiles[0].n, 3);
    const deliveries = (await db.query('SELECT count(*)::int AS n FROM public.deliveries')).rows;
    assert.equal(deliveries[0].n, 2);
  } finally {
    await db.exec('RESET ROLE');
    await signOut();
  }
});

test('самоназначение админом невозможно: role защищена триггером', async () => {
  await signIn(USER_A);
  await db.exec('SET ROLE authenticated');
  try {
    // Именно эта строка была эскалацией: UPDATE своей строки проходил RLS.
    await assert.rejects(
      db.query("UPDATE public.profiles SET role = 'admin' WHERE id = '" + USER_A + "'"),
      /profiles\.role/,
    );
    await assert.rejects(
      db.query("UPDATE public.profiles SET role = 'moderator' WHERE id = '" + USER_A + "'"),
      /profiles\.role/,
    );
    // INSERT с чужой ролью (профиль ещё не создан) тоже закрыт.
    await assert.rejects(
      db.query("INSERT INTO public.profiles (id, role) VALUES ('${USER_B}', 'admin')".replace('${USER_B}', '00000000-0000-4000-8000-00000000000d')),
      /profiles\.role/,
    );

    // Обычное редактирование своего профиля работает как раньше.
    await db.query("UPDATE public.profiles SET cmdr_name = 'CMDR Alice R' WHERE id = '" + USER_A + "'");
    const { rows } = await db.query("SELECT cmdr_name, role FROM public.profiles WHERE id = '" + USER_A + "'");
    assert.equal(rows[0].cmdr_name, 'CMDR Alice R');
    assert.equal(rows[0].role, 'user');

    // Подделка email в профиле (персонал ориентируется на него в тикетах) закрыта.
    await assert.rejects(
      db.query("UPDATE public.profiles SET email = 'victim@example.com' WHERE id = '" + USER_A + "'"),
      /profiles\.email/,
    );
  } finally {
    await db.exec('RESET ROLE');
    await signOut();
  }
});

test('администратор по-прежнему назначает роли через админку', async () => {
  await signIn(STAFF);
  await db.exec('SET ROLE authenticated');
  try {
    await db.query("UPDATE public.profiles SET role = 'moderator' WHERE id = '" + USER_B + "'");
    const { rows } = await db.query("SELECT role FROM public.profiles WHERE id = '" + USER_B + "'");
    assert.equal(rows[0].role, 'moderator');
    // и обратно
    await db.query("UPDATE public.profiles SET role = 'user' WHERE id = '" + USER_B + "'");
  } finally {
    await db.exec('RESET ROLE');
    await signOut();
  }
});

test('service_role (серверные маршруты) обходит ограничения как раньше', async () => {
  await signOut();
  await db.exec('SET ROLE service_role');
  try {
    const profiles = (await db.query('SELECT count(*)::int AS n FROM public.profiles')).rows;
    assert.equal(profiles[0].n, 3);
    await db.query("UPDATE public.profiles SET email = 'sync@example.com' WHERE id = '" + USER_B + "'");
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('текст миграции: у profiles и deliveries не осталось anon-политик, приватные колонки не утекли в представление', async () => {
  const migration = readFileSync(
    new URL('../../supabase/migrations/20261015000000_profiles_rls_hardening.sql', import.meta.url),
    'utf8',
  );
  // Новые политики читаются только authenticated + владелец/персонал.
  assert.match(migration, /CREATE POLICY profiles_select ON public\.profiles\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(id = auth\.uid\(\) OR public\.request_is_staff\(\)\)/);
  assert.match(migration, /CREATE POLICY deliveries_select ON public\.deliveries\s*\n\s*FOR SELECT TO authenticated\s*\n\s*USING \(user_id = auth\.uid\(\) OR public\.request_is_staff\(\)\)/);
  assert.match(migration, /REVOKE SELECT ON public\.profiles FROM anon;/);
  assert.match(migration, /REVOKE SELECT ON public\.deliveries FROM anon;/);
  // Представление содержит только безопасные колонки.
  const viewBody = migration.slice(migration.indexOf('CREATE OR REPLACE VIEW public.public_profiles'));
  const viewColumns = viewBody.slice(0, viewBody.indexOf('FROM public.profiles'));
  for (const column of ['p.id', 'p.cmdr_name', 'p.avatar_url', 'p.squadron', 'p.created_at', 'p.updated_at', 'p.forum_posts_count']) {
    assert.ok(viewColumns.includes(column), `представление должно отдавать ${column}`);
  }
  for (const column of ['email', 'role', 'privacy_settings', 'language']) {
    assert.ok(!new RegExp(`p\\.${column}\\b`).test(viewColumns), `представление не должно отдавать ${column}`);
  }
});
