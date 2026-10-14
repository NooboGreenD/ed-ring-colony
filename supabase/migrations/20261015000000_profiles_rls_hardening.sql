-- ════════════════════════════════════════════════════════════════════
-- КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ: персональные данные и права в profiles
-- ════════════════════════════════════════════════════════════════════
-- Что было (уязвимость):
--
--   1. profiles_select разрешал роли anon читать ВСЕ профили:
--      `FOR SELECT TO anon, authenticated USING (true)`. Анонимный ключ
--      публикации лежит в браузере каждого посетителя
--      (NEXT_PUBLIC_SUPABASE_ANON_KEY + шлюз /api/supabase), поэтому любой
--      сторонний пользователь мог одним запросом к PostgREST выгрузить
--      таблицу целиком — вместе с email каждого аккаунта, role,
--      privacy_settings и language.
--
--   2. profiles_update проверял только владение СТРОКОЙ
--      (`id = auth.uid()`), но не колонки. RLS — это row-level: WITH CHECK
--      не ограничивает, какие колонки меняет владелец. Любой вошедший
--      пользователь мог прямым PATCH-запросом к /rest/v1/profiles
--      записать себе role = 'admin' — и получить всю админку: список
--      пилотов с email, биллинг, мониторинг, управление контентом.
--
--   3. deliveries читалась кем угодно (`USING (true)` для anon): настройки
--      приватности досье («груз», «доставки») обходились прямым запросом к
--      базе. Ровно это уже чинили для pilot_stats/capi_profiles в
--      миграции 20260917000000 — deliveries осталась незамеченной.
--
-- Что стало:
--
--   • profiles читает только владелец строки и персонал
--     (admin/moderator/support_manager);
--   • публичные места сайта (имена авторов форума/вики/комментариев,
--     список пилотов, поиск друзей, составы эскадрилий и проектов)
--     читают представление public_profiles — те же строки, но только
--     безопасные колонки, без email/role/privacy_settings/language;
--   • role и email в profiles меняет только администратор (или серверный
--     код через service_role, и psql при миграциях, где auth.uid() IS NULL)
--     — триггер protect_profile_privileged_columns;
--   • deliveries читает владелец и персонал; публичный лидерборд и досье
--     командира собирает сервер через service-role клиент и сам решает,
--     что показать (как уже делает /api/cmdr/stats и страница досье для
--     pilot_stats).
--
-- Совместимость: код, который читал profiles через service-role клиент,
-- не меняется (service_role обходит RLS). Код, читавший ЧУЖИЕ профили
-- браузерной сессией, переведён на public_profiles в этом же коммите.

-- ────────────────────────────────────────────────────────────────────
-- 0. Персонал — той же схемой, что request_is_admin() из
--    20261006000000_system_architects.sql (SECURITY DEFINER, поэтому
--    политики ниже не заходят в profiles рекурсивно).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_is_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid()
      AND role IN ('admin', 'moderator', 'support_manager')
  );
$$;

-- ────────────────────────────────────────────────────────────────────
-- 1. profiles: чтение — только владелец и персонал
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.request_is_staff());

REVOKE SELECT ON public.profiles FROM anon;
-- GRANT SELECT для authenticated остаётся: строки теперь фильтрует RLS,
-- а свой профиль (email, language, privacy_settings) владелец видит как раньше.

-- ────────────────────────────────────────────────────────────────────
-- 2. public_profiles: публичное представление без приватных колонок
--
--    Представление выполняется с правами владельца (postgres), поэтому
--    RLS на profiles его не фильтрует — это и нужно: строки видны все,
--    но наружу выходят только безопасные колонки. Запись через
--    представление не выдаётся (GRANT только на SELECT).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE VIEW public.public_profiles AS
SELECT
  p.id,
  p.cmdr_name,
  p.avatar_url,
  p.squadron,
  p.created_at,
  p.updated_at,
  p.forum_posts_count
FROM public.profiles p;

REVOKE ALL ON public.public_profiles FROM PUBLIC;
GRANT SELECT ON public.public_profiles TO anon, authenticated, service_role;

COMMENT ON VIEW public.public_profiles IS
  'Публичные колонки profiles (имена авторов, составы, поиск пилотов). '
  'email/role/privacy_settings/language остаются во внутренней таблице, '
  'которую видит только владелец строки и персонал.';

-- ────────────────────────────────────────────────────────────────────
-- 3. Защита привилегированных колонок: role и email
--
--    RLS не умеет ограничивать колонки, поэтому владельцу строки нужно
--    было НЕЛЬЗЯ менять role (самоназначение админом) и email (подделка
--    адреса в поле, по которому персонал связывается с пилотом).
--    Триггер срабатывает только когда role/email упомянуты в SET
--    (UPDATE OF ...) или в INSERT.
--
--    auth.uid() IS NULL — это service_role и консоль/миграции: им можно.
--    request_is_admin() — администратору через админку: можно.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_profile_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT (auth.uid() IS NULL OR public.request_is_admin()) THEN
    IF TG_OP = 'INSERT' THEN
      IF NEW.role IS DISTINCT FROM 'user' THEN
        RAISE EXCEPTION 'profiles.role может задать только администратор'
          USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.role IS DISTINCT FROM OLD.role THEN
        RAISE EXCEPTION 'profiles.role может изменить только администратор'
          USING ERRCODE = '42501';
      END IF;
      IF NEW.email IS DISTINCT FROM OLD.email THEN
        RAISE EXCEPTION 'profiles.email синхронизируется только сервером'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON public.profiles;
CREATE TRIGGER trg_protect_profile_privileged_columns
  BEFORE INSERT OR UPDATE OF role, email ON public.profiles
  FOR EACH ROW
  EXECUTE FUNCTION public.protect_profile_privileged_columns();

-- ────────────────────────────────────────────────────────────────────
-- 4. deliveries: чтение — владелец и персонал
--
--    Публичный лидерборд и досье переводятся на service-role клиент
--    (сервер сам решает, что показать), агрегат тона админ-панели
--    считается сессией персонала. Писались deliveries и раньше только
--    владельцу (deliveries_insert) и через service-role.
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS deliveries_select ON public.deliveries;
CREATE POLICY deliveries_select ON public.deliveries
  FOR SELECT TO authenticated
  USING (user_id = auth.uid() OR public.request_is_staff());

REVOKE SELECT ON public.deliveries FROM anon;

NOTIFY pgrst, 'reload schema';
