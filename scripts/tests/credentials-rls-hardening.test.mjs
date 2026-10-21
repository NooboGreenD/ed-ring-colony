import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const db = new PGlite();
const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';

before(async () => {
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
      AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;

    CREATE TABLE public.capi_tokens (id integer PRIMARY KEY, user_id uuid, access_token text, refresh_token text);
    CREATE TABLE public.inara_profiles (id integer PRIMARY KEY, user_id uuid, inara_api_key text);
    CREATE TABLE public.api_tokens (
      id integer PRIMARY KEY, user_id uuid, name text, token_hash text,
      scopes text[], is_revoked boolean, revoked_at timestamptz,
      last_used_at timestamptz, expires_at timestamptz, created_at timestamptz
    );
    CREATE TABLE public.deliveries (id integer PRIMARY KEY, user_id uuid, amount integer);
    CREATE TABLE public.profiles (id uuid PRIMARY KEY, cmdr_name text, email text);
    CREATE VIEW public.delivery_scope_summary AS SELECT user_id, sum(amount) AS amount FROM public.deliveries GROUP BY user_id;
    CREATE VIEW public.squadron_member_detail AS SELECT p.id, p.cmdr_name FROM public.profiles p;
    CREATE VIEW public.public_profiles AS SELECT id, cmdr_name FROM public.profiles;

    INSERT INTO public.capi_tokens VALUES (1, '${USER_A}', 'frontier-access-secret', 'frontier-refresh-secret');
    INSERT INTO public.inara_profiles VALUES (1, '${USER_A}', 'inara-secret');
    INSERT INTO public.api_tokens VALUES (1, '${USER_A}', 'uploader', 'token-hash-secret', ARRAY['upload'], false, null, null, null, now());
    INSERT INTO public.profiles VALUES ('${USER_A}', 'CMDR A', 'a@example.test'), ('${USER_B}', 'CMDR B', 'b@example.test');
    INSERT INTO public.deliveries VALUES (1, '${USER_A}', 10), (2, '${USER_B}', 20);

    ALTER TABLE public.capi_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.inara_profiles ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.deliveries ENABLE ROW LEVEL SECURITY;
    CREATE POLICY deliveries_owner ON public.deliveries FOR SELECT TO authenticated USING (user_id = auth.uid());

    GRANT ALL ON public.capi_tokens, public.inara_profiles, public.api_tokens TO anon, authenticated, service_role;
    GRANT SELECT ON public.delivery_scope_summary, public.squadron_member_detail, public.public_profiles TO anon, authenticated;
    GRANT SELECT ON public.deliveries TO anon, authenticated, service_role;
  `);

  const migration = readFileSync(
    new URL('../../supabase/migrations/20261016000000_credentials_and_views_hardening.sql', import.meta.url),
    'utf8',
  ).replace(/NOTIFY\s+pgrst[^;]*;/g, '');
  await db.exec(migration);
});

after(async () => { await db.close(); });

test('anon/authenticated cannot read stored Frontier/Inara credentials', async () => {
  for (const role of ['anon', 'authenticated']) {
    await db.exec(`SET ROLE ${role}`);
    try {
      await assert.rejects(db.query('SELECT access_token FROM public.capi_tokens'), /permission denied/);
      await assert.rejects(db.query('SELECT inara_api_key FROM public.inara_profiles'), /permission denied/);
    } finally {
      await db.exec('RESET ROLE');
    }
  }
});

test('api_tokens exposes metadata only and never token_hash to browser roles', async () => {
  await db.exec('SET ROLE authenticated');
  try {
    await db.query('SELECT id, name, scopes FROM public.api_tokens');
    await assert.rejects(db.query('SELECT token_hash FROM public.api_tokens'), /permission denied/);
    await assert.rejects(db.query('INSERT INTO public.api_tokens (id) VALUES (2)'), /permission denied/);
  } finally {
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE anon');
  try {
    await assert.rejects(db.query('SELECT id FROM public.api_tokens'), /permission denied/);
  } finally {
    await db.exec('RESET ROLE');
  }
});

test('delivery summary respects table RLS and is not available anonymously', async () => {
  await db.exec('SET ROLE anon');
  try {
    await assert.rejects(db.query('SELECT * FROM public.delivery_scope_summary'), /permission denied/);
  } finally {
    await db.exec('RESET ROLE');
  }

  await db.exec(`SET request.jwt.claim.sub = '${USER_A}'; SET ROLE authenticated`);
  try {
    const { rows } = await db.query('SELECT * FROM public.delivery_scope_summary');
    assert.deepEqual(rows, [{ user_id: USER_A, amount: 10 }]);
  } finally {
    await db.exec('RESET ROLE; RESET request.jwt.claim.sub');
  }
});

test('member detail uses the safe public profile view, not private email columns', async () => {
  await db.exec('SET ROLE anon');
  try {
    const { rows } = await db.query('SELECT * FROM public.squadron_member_detail ORDER BY cmdr_name');
    assert.deepEqual(rows, [{ id: USER_A, cmdr_name: 'CMDR A' }, { id: USER_B, cmdr_name: 'CMDR B' }]);
    await assert.rejects(db.query('SELECT email FROM public.squadron_member_detail'), /column/);
  } finally {
    await db.exec('RESET ROLE');
  }
});
