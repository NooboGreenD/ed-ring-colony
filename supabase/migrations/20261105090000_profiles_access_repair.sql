-- ════════════════════════════════════════════════════════════════════
-- Ремонт доступа к профилю и админке (идемпотентно, без потери данных)
-- ════════════════════════════════════════════════════════════════════
-- Зачем. После обновления может случиться так, что роль в `profiles`
-- остаётся `admin`, psql это подтверждает, а админка отвечает «Доступ
-- запрещён», и половина сайта показывает пустые имена. Причины у этого
-- класса три, и все три лечатся одним и тем же набором команд:
--
--   1. снятый или не доехавший грант (`GRANT SELECT ON profiles TO
--      authenticated`) — тогда PostgREST отвечает `permission denied for
--      table profiles`, и клиент не видит даже собственную строку;
--   2. отсутствующая или перезаписанная политика `profiles_select` —
--      строки есть, но RLS их не отдаёт;
--   3. устаревший кэш схемы PostgREST — база в порядке, REST-слой
--      описывает её по-старому (в конце файла `NOTIFY pgrst`).
--
-- Файл можно применить двумя способами:
--   • обычным обновлением (`supabase/migrations/` подхватывается само);
--   • вручную в SQL Editor Supabase, если в админку уже не войти:
--     скопировать целиком и выполнить. Ничего не удаляет и не перезаписывает
--     чужие данные: только права, политики, представление и отсутствующие
--     строки профиля.
--
-- Безопасность сохранена: самоназначение админом по-прежнему невозможно —
-- триггер `trg_protect_profile_privileged_columns` восстанавливается ниже,
-- `anon` не получает чтения `profiles`, а запись роли остаётся только у
-- администратора.

-- ────────────────────────────────────────────────────────────────────
-- 0. Функции персонала: SECURITY DEFINER, поэтому политики не заходят в
--    profiles рекурсивно (именно рекурсия раньше давала «нет прав»).
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'admin'
  );
$$;

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

REVOKE ALL ON FUNCTION public.request_is_admin() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_is_staff() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_is_admin() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_is_staff() TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 1. Гранты: без них клиент не читает даже собственную строку.
--    `anon` чтения profiles не получает — это закрытая ранее утечка email.
-- ────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
REVOKE SELECT ON public.profiles FROM anon;

-- ────────────────────────────────────────────────────────────────────
-- 2. Политики profiles: владелец строки и персонал; запись роли — только
--    администратор (и сервер через service_role / psql, где auth.uid()=NULL).
-- ────────────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles
  FOR SELECT TO authenticated
  USING (id = auth.uid() OR public.request_is_staff());

DROP POLICY IF EXISTS profiles_insert ON public.profiles;
CREATE POLICY profiles_insert ON public.profiles
  FOR INSERT TO authenticated
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS profiles_update ON public.profiles;
CREATE POLICY profiles_update ON public.profiles
  FOR UPDATE TO authenticated
  USING (id = auth.uid() OR public.request_is_admin())
  WITH CHECK (id = auth.uid() OR public.request_is_admin());

-- ────────────────────────────────────────────────────────────────────
-- 3. Триггер защиты role/email: без него любой вошедший снова мог бы
--    выписать себе админа прямым PATCH-запросом к /rest/v1/profiles.
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
-- 4. Публичное представление: сайт читает имена авторов, составов и
--    поиска пилотов отсюда, а не из закрытой таблицы.
-- ────────────────────────────────────────────────────────────────────
DROP VIEW IF EXISTS public.public_profiles;
CREATE VIEW public.public_profiles AS
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

-- ────────────────────────────────────────────────────────────────────
-- 5. Таблицы, без чтения которых админка выглядит пустой, а «половина
--    проекта» — сломанной. Грант выдаётся, только если таблица есть:
--    на неполной базе файл не должен падать.
-- ────────────────────────────────────────────────────────────────────
DO $repair$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'hubs', 'route_systems', 'site_content', 'news', 'app_flags',
    'site_settings', 'galnet_news', 'wiki_articles', 'wiki_categories'
  ] LOOP
    IF to_regclass('public.' || t) IS NOT NULL THEN
      EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
    END IF;
  END LOOP;
END
$repair$;

-- ────────────────────────────────────────────────────────────────────
-- 6. Строки профиля, которых нет: аккаунт есть, а `profiles` пуст —
--    тогда ни админки, ни личного кабинета. Существующие строки не
--    трогаются, роли не перезаписываются (вставляется только 'user').
-- ────────────────────────────────────────────────────────────────────
INSERT INTO public.profiles (id, email, cmdr_name, role)
SELECT
  u.id,
  u.email,
  COALESCE(
    NULLIF(u.raw_user_meta_data->>'cmdr_name', ''),
    NULLIF(u.raw_user_meta_data->>'full_name', ''),
    split_part(COALESCE(u.email, u.id::text), '@', 1)
  ),
  'user'
FROM auth.users u
WHERE NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = u.id);

-- ────────────────────────────────────────────────────────────────────
-- 7. Кэш схемы PostgREST: без этого REST-слой продолжает отвечать по
--    старому описанию (новые колонки и представление «не существуют»).
-- ────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
