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
--    на безопасное представление public.public_profiles.
-- =============================================================================

-- ── 1. public.capi_tokens: доступ только для service_role ─────────────────────
ALTER TABLE public.capi_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "capi_tokens_select_own" ON public.capi_tokens;

REVOKE ALL ON public.capi_tokens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.capi_tokens TO service_role;

-- ── 2. public.inara_profiles: доступ только для service_role ──────────────────
ALTER TABLE public.inara_profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "inara_profiles_select_own" ON public.inara_profiles;

REVOKE ALL ON public.inara_profiles FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.inara_profiles TO service_role;

-- ── 3. public.api_tokens: скрытие token_hash и запрет прямой записи ───────────
ALTER TABLE public.api_tokens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users insert own api_tokens" ON public.api_tokens;
DROP POLICY IF EXISTS "Users update own api_tokens" ON public.api_tokens;
DROP POLICY IF EXISTS "Users delete own api_tokens" ON public.api_tokens;
DROP POLICY IF EXISTS "Users can manage own tokens" ON public.api_tokens;
DROP POLICY IF EXISTS "Users can insert own tokens" ON public.api_tokens;
DROP POLICY IF EXISTS "Users can delete own tokens" ON public.api_tokens;

REVOKE ALL ON public.api_tokens FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, user_id, name, scopes, is_revoked, revoked_at, last_used_at, expires_at, created_at)
  ON public.api_tokens TO authenticated;
GRANT ALL ON public.api_tokens TO service_role;

-- ── 4. public.delivery_scope_summary: уважение RLS таблицы deliveries ─────────
CREATE OR REPLACE VIEW public.delivery_scope_summary
WITH (security_invoker = true) AS
SELECT
  user_id,
  cmdr_name,
  cargo_scope,
  COUNT(*)::bigint AS delivery_count,
  COALESCE(SUM(quantity), 0)::bigint AS total_tons,
  MAX(delivered_at) AS last_delivery_at
FROM public.deliveries
GROUP BY user_id, cmdr_name, cargo_scope;

REVOKE ALL ON public.delivery_scope_summary FROM PUBLIC, anon;
GRANT SELECT ON public.delivery_scope_summary TO authenticated, service_role;

-- ── 5. public.squadron_member_detail: чтение из public_profiles ───────────────
CREATE OR REPLACE VIEW public.squadron_member_detail
WITH (security_invoker = true) AS
SELECT
  sm.id,
  sm.squadron_id,
  sm.user_id,
  sm.role,
  sm.joined_at,
  COALESCE(NULLIF(BTRIM(p.cmdr_name), ''), 'Пилот') AS cmdr_name,
  p.avatar_url
FROM public.squadron_members sm
LEFT JOIN public.public_profiles p ON p.id = sm.user_id;

GRANT SELECT ON public.squadron_member_detail TO anon, authenticated, service_role;

NOTIFY pgrst, 'reload schema';
