-- =============================================================================
-- Защита хранилищ внешних токенов/ключей и исправление представлений с RLS
-- 1. public.capi_tokens: отзываем прямой доступ у PUBLIC, anon, authenticated
--    (все обращения идут только через серверный service_role, чтобы скомпрометированный
--    клиентский JWT не позволял выгрузить access_token/refresh_token Frontier через PostgREST).
-- 2. public.inara_profiles: отзываем прямой доступ у PUBLIC, anon, authenticated
--    (inara_api_key используется только сервером через service_role).
-- 3. public.api_tokens: запрещаем чтение колонки token_hash и прямые INSERT/UPDATE/DELETE
--    через PostgREST для authenticated/anon (выпуск и отзыв токенов только через API).
-- 4. public.delivery_scope_summary: включаем security_invoker = true и убираем доступ anon,
--    чтобы представление уважало RLS на public.deliveries.
-- 5. public.squadron_member_detail: переключаем JOIN с закрытой таблицы public.profiles
--    на безопасное представление public.public_profiles без изменения набора колонок.
-- =============================================================================

SET client_min_messages TO warning;

-- ── 1. public.capi_tokens: доступ только для service_role ─────────────────────
DO $$
BEGIN
  IF to_regclass('public.capi_tokens') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.capi_tokens ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "capi_tokens_select_own" ON public.capi_tokens';
    EXECUTE 'REVOKE ALL ON public.capi_tokens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON public.capi_tokens TO service_role';
  END IF;
END
$$;

-- ── 2. public.inara_profiles: доступ только для service_role ──────────────────
DO $$
BEGIN
  IF to_regclass('public.inara_profiles') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.inara_profiles ENABLE ROW LEVEL SECURITY';
    EXECUTE 'DROP POLICY IF EXISTS "inara_profiles_select_own" ON public.inara_profiles';
    EXECUTE 'REVOKE ALL ON public.inara_profiles FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT ALL ON public.inara_profiles TO service_role';
  END IF;
END
$$;

-- ── 3. public.api_tokens: скрытие token_hash и запрет прямой записи ───────────
DO $$
BEGIN
  IF to_regclass('public.api_tokens') IS NOT NULL THEN
    EXECUTE 'ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY';
    EXECUTE 'ALTER TABLE public.api_tokens
      ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT ARRAY[''upload'']::text[],
      ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ';

    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_insert" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_update" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "api_tokens_delete" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users insert own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users update own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users delete own api_tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can manage own tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can insert own tokens" ON public.api_tokens';
    EXECUTE 'DROP POLICY IF EXISTS "Users can delete own tokens" ON public.api_tokens';

    EXECUTE 'REVOKE ALL ON public.api_tokens FROM PUBLIC, anon, authenticated';
    EXECUTE 'GRANT SELECT (id, user_id, name, scopes, is_revoked, revoked_at, last_used_at, expires_at, created_at)
      ON public.api_tokens TO authenticated';
    EXECUTE 'GRANT ALL ON public.api_tokens TO service_role';
  END IF;
END
$$;

-- ── 4. public.delivery_scope_summary: уважение RLS таблицы deliveries ─────────
DO $$
BEGIN
  IF to_regclass('public.delivery_scope_summary') IS NOT NULL THEN
    EXECUTE 'ALTER VIEW public.delivery_scope_summary SET (security_invoker = true)';
    EXECUTE 'REVOKE ALL ON public.delivery_scope_summary FROM PUBLIC, anon';
    EXECUTE 'GRANT SELECT ON public.delivery_scope_summary TO authenticated, service_role';
  END IF;
END
$$;

-- ── 5. public.squadron_member_detail: чтение из public_profiles ───────────────
DO $$
DECLARE
  v_def text;
BEGIN
  IF to_regclass('public.squadron_member_detail') IS NOT NULL
     AND to_regclass('public.public_profiles') IS NOT NULL THEN
    v_def := pg_get_viewdef('public.squadron_member_detail'::regclass, true);
    IF v_def ~* '\mprofiles\M' THEN
      v_def := regexp_replace(v_def, '\mpublic\.profiles\M', 'public.public_profiles', 'gi');
      v_def := regexp_replace(v_def, '(?<!\.)\mprofiles\M', 'public.public_profiles', 'gi');
      EXECUTE 'CREATE OR REPLACE VIEW public.squadron_member_detail WITH (security_invoker = true) AS ' || v_def;
    ELSE
      EXECUTE 'ALTER VIEW public.squadron_member_detail SET (security_invoker = true)';
    END IF;
    EXECUTE 'GRANT SELECT ON public.squadron_member_detail TO anon, authenticated, service_role';
  END IF;
END
$$;

NOTIFY pgrst, 'reload schema';
