import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIGRATION_PROFILES_PATH = join(ROOT, 'supabase', 'migrations', '20261015000000_profiles_rls_hardening.sql');
const MIGRATION_HARDENING_PATH = join(ROOT, 'supabase', 'migrations', '20261016000000_credentials_and_views_hardening.sql');

let PGlite = null;
try {
  ({ PGlite } = await import('@electric-sql/pglite'));
} catch {
  // PGlite может отсутствовать в минимальном окружении
}
const pgTest = PGlite ? test : test.skip;

const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB   = '22222222-2222-4222-8222-222222222222';
const ADMIN = '99999999-9999-4999-8999-999999999999';

async function createFixtureDb() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE anon NOLOGIN;
    CREATE ROLE authenticated NOLOGIN;
    CREATE ROLE service_role NOLOGIN BYPASSRLS;
    GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

    CREATE SCHEMA auth;
    GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
    CREATE TABLE auth.users (id UUID PRIMARY KEY, email TEXT);

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS UUID
    LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS TEXT
    LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), current_user::text);
    $$;
    GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

    CREATE TABLE public.profiles (
      id UUID PRIMARY KEY,
      email TEXT,
      cmdr_name TEXT,
      avatar_url TEXT,
      squadron TEXT,
      role TEXT DEFAULT 'user',
      forum_posts_count INT DEFAULT 0,
      forum_reputation INT DEFAULT 0,
      is_banned BOOLEAN DEFAULT false,
      discord_id TEXT,
      telegram_chat_id TEXT,
      privacy_settings JSONB DEFAULT '{"ranks": true, "balance": true, "cargo": true, "deliveries": true, "location": true}'::jsonb,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON public.profiles TO anon, authenticated, service_role;

    CREATE TABLE public.deliveries (
      id SERIAL PRIMARY KEY,
      user_id UUID,
      cmdr_name TEXT,
      commodity TEXT NOT NULL,
      amount INT NOT NULL,
      is_construction BOOLEAN DEFAULT true,
      source TEXT DEFAULT 'journal',
      delivery_kind TEXT,
      station_name TEXT,
      station_kind TEXT,
      delivered_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
    GRANT ALL ON public.deliveries TO anon, authenticated, service_role;

    CREATE TABLE public.capi_tokens (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE,
      access_token TEXT NOT NULL,
      refresh_token TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      cmdr_name TEXT,
      frontier_id TEXT,
      is_active BOOLEAN DEFAULT true
    );
    ALTER TABLE public.capi_tokens ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "capi_tokens_select_own" ON public.capi_tokens FOR SELECT USING (auth.uid() = user_id);
    GRANT ALL ON public.capi_tokens TO anon, authenticated, service_role;

    CREATE TABLE public.inara_profiles (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE,
      cmdr_name TEXT NOT NULL,
      inara_api_key TEXT,
      auto_sync BOOLEAN DEFAULT false
    );
    ALTER TABLE public.inara_profiles ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "inara_profiles_select_own" ON public.inara_profiles FOR SELECT USING (auth.uid() = user_id);
    GRANT ALL ON public.inara_profiles TO anon, authenticated, service_role;

    -- Реальная схема api_tokens из 000_base_schema.sql (без scopes/revoked_at/expires_at до нашей миграции)
    CREATE TABLE public.api_tokens (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      name TEXT,
      is_revoked BOOLEAN NOT NULL DEFAULT false,
      last_used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
    CREATE POLICY api_tokens_select ON public.api_tokens FOR SELECT TO authenticated USING (auth.uid() = user_id);
    CREATE POLICY api_tokens_insert ON public.api_tokens FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
    CREATE POLICY api_tokens_update ON public.api_tokens FOR UPDATE TO authenticated USING (auth.uid() = user_id);
    CREATE POLICY api_tokens_delete ON public.api_tokens FOR DELETE TO authenticated USING (auth.uid() = user_id);
    GRANT ALL ON public.api_tokens TO anon, authenticated, service_role;

    -- Реальное представление delivery_scope_summary из 20260918000000_deliveries_cargo_scope.sql
    CREATE OR REPLACE VIEW public.delivery_scope_summary AS
    SELECT
      user_id,
      COALESCE(
        delivery_kind,
        CASE
          WHEN is_construction IS DISTINCT FROM false THEN 'legacy_site'
          WHEN source = 'carrier_delivery' THEN 'fleet_carrier'
          WHEN source IN ('mission_delivery', 'cargo_depot') THEN 'mission_delivery'
          WHEN source = 'powerplay_delivery' THEN 'powerplay_delivery'
          WHEN source = 'rescue_delivery' THEN 'rescue_delivery'
          ELSE 'market_sale'
        END
      ) AS kind,
      COALESCE(SUM(GREATEST(amount, 0)), 0) AS tons,
      COUNT(*) FILTER (WHERE amount > 0) AS ops
    FROM public.deliveries
    GROUP BY 1, 2;
    GRANT SELECT ON public.delivery_scope_summary TO anon, authenticated, service_role;

    CREATE TABLE public.squadron_ranks (
      id SERIAL PRIMARY KEY,
      squadron_id INT NOT NULL,
      name TEXT NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_default BOOLEAN NOT NULL DEFAULT false,
      can_manage_projects BOOLEAN NOT NULL DEFAULT false,
      can_manage_members BOOLEAN NOT NULL DEFAULT false,
      can_manage_ranks BOOLEAN NOT NULL DEFAULT false,
      can_edit_squadron BOOLEAN NOT NULL DEFAULT false
    );
    ALTER TABLE public.squadron_ranks ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "squadron_ranks_select" ON public.squadron_ranks FOR SELECT USING (true);
    GRANT SELECT ON public.squadron_ranks TO anon, authenticated, service_role;

    CREATE TABLE public.squadron_members (
      id SERIAL PRIMARY KEY,
      squadron_id INT NOT NULL,
      user_id UUID NOT NULL,
      rank_id INT,
      callsign TEXT,
      joined_at TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE public.squadron_members ENABLE ROW LEVEL SECURITY;
    CREATE POLICY "squadron_members_select" ON public.squadron_members FOR SELECT USING (true);
    GRANT SELECT ON public.squadron_members TO anon, authenticated, service_role;

    -- Реальное представление squadron_member_detail из 20260911030000_squadron_read_models_and_profile_sync.sql
    CREATE VIEW public.squadron_member_detail
    WITH (security_invoker = true) AS
    SELECT
      sm.id,
      sm.squadron_id,
      sm.user_id,
      sm.rank_id,
      sm.callsign,
      sm.joined_at,
      sr.name AS rank_name,
      sr.sort_order AS rank_order,
      sr.is_default,
      sr.can_manage_projects,
      sr.can_manage_members,
      sr.can_manage_ranks,
      sr.can_edit_squadron,
      p.cmdr_name,
      p.avatar_url
    FROM public.squadron_members AS sm
    LEFT JOIN public.squadron_ranks AS sr ON sr.id = sm.rank_id
    LEFT JOIN public.profiles AS p ON p.id = sm.user_id;
    GRANT SELECT ON public.squadron_member_detail TO anon, authenticated, service_role;

    INSERT INTO public.profiles (id, email, cmdr_name, avatar_url, role) VALUES
      ('${ALICE}', 'alice@secret.example', 'CMDR Alice', 'https://cdn.example/a.png', 'user'),
      ('${BOB}',   'bob@secret.example',   'CMDR Bob',   'https://cdn.example/b.png', 'user'),
      ('${ADMIN}', 'admin@secret.example', 'CMDR Boss',  null,                        'admin');

    INSERT INTO public.capi_tokens (user_id, access_token, refresh_token, expires_at, cmdr_name) VALUES
      ('${ALICE}', 'frontier-access-secret-alice', 'frontier-refresh-secret-alice', NOW() + INTERVAL '4 hours', 'CMDR Alice');

    INSERT INTO public.inara_profiles (user_id, cmdr_name, inara_api_key) VALUES
      ('${ALICE}', 'CMDR Alice', 'inara-secret-key-alice');

    INSERT INTO public.api_tokens (id, user_id, token_hash, name) VALUES
      ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '${ALICE}', 'sha256_secret_hash_alice', 'Colonial Helper');

    INSERT INTO public.deliveries (user_id, cmdr_name, commodity, amount, delivery_kind) VALUES
      ('${ALICE}', 'CMDR Alice', 'Titanium',  500, 'construction_site'),
      ('${BOB}',   'CMDR Bob',   'Aluminium', 300, 'construction_site');

    INSERT INTO public.squadron_ranks (id, squadron_id, name, sort_order) VALUES
      (1, 1, 'Leader', 1),
      (2, 1, 'Member', 2);

    INSERT INTO public.squadron_members (squadron_id, user_id, rank_id) VALUES
      (1, '${ALICE}', 1),
      (1, '${BOB}',   2);
  `);

  await db.exec(readFileSync(MIGRATION_PROFILES_PATH, 'utf8'));
  await db.exec(readFileSync(MIGRATION_HARDENING_PATH, 'utf8'));

  await db.exec(`
    CREATE POLICY "Staff read api_tokens telemetry"
      ON public.api_tokens FOR SELECT TO authenticated
      USING (public.request_is_staff());
  `);

  return db;
}

async function asRole(db, role, uid, sql) {
  await db.exec(`
    RESET ROLE;
    SELECT set_config('request.jwt.claim.role', '${role}', false);
    SELECT set_config('request.jwt.claim.sub', '${uid ?? ''}', false);
    SET ROLE ${role};
  `);
  try {
    return await db.query(sql);
  } finally {
    await db.exec('RESET ROLE;');
  }
}

pgTest('capi_tokens и inara_profiles недоступны через PostgREST ни для anon, ни для authenticated (даже владельцу), но доступны service_role', async () => {
  const db = await createFixtureDb();

  await assert.rejects(
    () => asRole(db, 'anon', null, 'SELECT * FROM public.capi_tokens'),
    /permission denied for table capi_tokens/i,
  );
  await assert.rejects(
    () => asRole(db, 'authenticated', ALICE, 'SELECT access_token, refresh_token FROM public.capi_tokens'),
    /permission denied for table capi_tokens/i,
  );
  await assert.rejects(
    () => asRole(db, 'anon', null, 'SELECT * FROM public.inara_profiles'),
    /permission denied for table inara_profiles/i,
  );
  await assert.rejects(
    () => asRole(db, 'authenticated', ALICE, 'SELECT inara_api_key FROM public.inara_profiles'),
    /permission denied for table inara_profiles/i,
  );

  const svcCapi = await asRole(db, 'service_role', null, 'SELECT access_token FROM public.capi_tokens');
  assert.equal(svcCapi.rows.length, 1);
  assert.equal(svcCapi.rows[0].access_token, 'frontier-access-secret-alice');

  const svcInara = await asRole(db, 'service_role', null, 'SELECT inara_api_key FROM public.inara_profiles');
  assert.equal(svcInara.rows.length, 1);
  assert.equal(svcInara.rows[0].inara_api_key, 'inara-secret-key-alice');
});

pgTest('api_tokens: колонка token_hash и прямая запись закрыты для authenticated, но безопасные поля и телеметрия работают', async () => {
  const db = await createFixtureDb();

  await assert.rejects(
    () => asRole(db, 'anon', null, 'SELECT id FROM public.api_tokens'),
    /permission denied for table api_tokens/i,
  );
  await assert.rejects(
    () => asRole(db, 'authenticated', ALICE, 'SELECT token_hash FROM public.api_tokens'),
    /permission denied for (table|column) api_tokens/i,
  );
  await assert.rejects(
    () => asRole(
      db,
      'authenticated',
      ALICE,
      `INSERT INTO public.api_tokens (id, user_id, token_hash, name) VALUES ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', '${ALICE}', 'custom_hash', ' Forged')`,
    ),
    /permission denied for table api_tokens/i,
  );

  const ownMeta = await asRole(
    db,
    'authenticated',
    ALICE,
    'SELECT id, user_id, name, is_revoked FROM public.api_tokens',
  );
  assert.equal(ownMeta.rows.length, 1);
  assert.equal(ownMeta.rows[0].name, 'Colonial Helper');

  const staffCount = await asRole(
    db,
    'authenticated',
    ADMIN,
    'SELECT id FROM public.api_tokens WHERE revoked_at IS NULL',
  );
  assert.equal(staffCount.rows.length, 1);
});

pgTest('delivery_scope_summary и squadron_member_detail соблюдают RLS и работают с public_profiles', async () => {
  const db = await createFixtureDb();

  await assert.rejects(
    () => asRole(db, 'anon', null, 'SELECT * FROM public.delivery_scope_summary'),
    /permission denied for view delivery_scope_summary/i,
  );

  const aliceSummary = await asRole(db, 'authenticated', ALICE, 'SELECT user_id, kind, tons FROM public.delivery_scope_summary');
  assert.deepEqual(aliceSummary.rows, [{ user_id: ALICE, kind: 'construction_site', tons: 500 }]);

  const adminSummary = await asRole(db, 'authenticated', ADMIN, 'SELECT user_id FROM public.delivery_scope_summary ORDER BY user_id');
  assert.deepEqual(adminSummary.rows.map(r => r.user_id), [ALICE, BOB]);

  const anonMembers = await asRole(db, 'anon', null, 'SELECT cmdr_name, rank_name FROM public.squadron_member_detail ORDER BY cmdr_name');
  assert.deepEqual(anonMembers.rows, [
    { cmdr_name: 'CMDR Alice', rank_name: 'Leader' },
    { cmdr_name: 'CMDR Bob', rank_name: 'Member' },
  ]);

  const aliceMembers = await asRole(db, 'authenticated', ALICE, 'SELECT cmdr_name, avatar_url FROM public.squadron_member_detail ORDER BY cmdr_name');
  assert.deepEqual(aliceMembers.rows, [
    { cmdr_name: 'CMDR Alice', avatar_url: 'https://cdn.example/a.png' },
    { cmdr_name: 'CMDR Bob', avatar_url: 'https://cdn.example/b.png' },
  ]);
});

test('шлюз /api/supabase/*, Nginx, Colonial Helper и Android-клиент защищены от утечки учётных данных', () => {
  const proxy = readFileSync(join(ROOT, 'src', 'proxy.ts'), 'utf8');
  assert.match(proxy, /ALLOWED_SUPABASE_GATEWAY_PREFIX/);
  assert.match(proxy, /status:\s*404/);

  const nginxSelfhost = readFileSync(join(ROOT, 'deploy', 'selfhost', 'nginx-selfhost.conf'), 'utf8');
  assert.match(nginxSelfhost, /location = \/api\/supabase \{ return 404; \}/);
  assert.match(nginxSelfhost, /location \^~ \/api\/supabase\/api\/pg-meta\/ \{ return 404; \}/);

  const installSh = readFileSync(join(ROOT, 'deploy', 'selfhost', 'install.sh'), 'utf8');
  assert.match(installSh, /location \^~ \/api\/pg-meta\/ \{ return 404; \}/);
  assert.match(installSh, /POSTGRES_PORT\s+"127\.0\.0\.1:5432"/);

  const apiClientPy = readFileSync(join(ROOT, 'uploader', 'api_client.py'), 'utf8');
  assert.ok(!apiClientPy.includes('params={"token": self.token}'), 'API-токен не должен передаваться в URL query');
  assert.match(apiClientPy, /headers=\{"Authorization": f"Bearer \{self\.token\}"\}/);

  const retrofitKt = readFileSync(
    join(ROOT, 'android-app/app/src/main/java/com/edringcolony/monitor/data/network/RetrofitClient.kt'),
    'utf8',
  );
  assert.ok(!retrofitKt.includes('Level.BODY'), 'Retrofit не должен логировать тела с паролями и токенами');
  assert.match(retrofitKt, /redactHeader\("Authorization"\)/);

  const backupXml = readFileSync(
    join(ROOT, 'android-app/app/src/main/res/xml/backup_rules.xml'),
    'utf8',
  );
  assert.match(backupXml, /secure_prefs\.xml/);
});
