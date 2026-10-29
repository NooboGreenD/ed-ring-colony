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
-- Файл накатывается на РАБОТАЮЩИЙ сайт, поэтому замки здесь — часть логики,
-- а не деталь. 29.10.2026 обновление провисело на нём 54 минуты и упало с
-- `deadlock detected`: файл держал исключительный замок на `profiles` и ждал
-- представление `public_profiles`, а запрос сайта держал представление и ждал
-- `profiles`. Отсюда три правила, которые нельзя менять местами:
--
--   • `lock_timeout` ниже: одна попытка ждёт замки 8 секунд, а не часы.
--     Обновление (deploy/update-project.sh) повторяет файл несколько раз,
--     поэтому короткое ожидание ничего не ломает;
--   • представление трогается ПЕРВЫМ и только если оно действительно
--     другое. На живой базе оно уже точно такое (его создала
--     20261015000000), и тогда на него не берётся ни один замок;
--   • бэкфилл профилей идёт до политик: исключительный замок на `profiles`
--     нужен только политикам и держится считанные миллисекунды.
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
-- 0. Предел ожидания замков. Дальше его видят все команды файла: лучше
--    честно упасть за 8 секунд и повторить попытку, чем держать сайт
--    в ожидании (и получить deadlock, как 29.10.2026).
-- ────────────────────────────────────────────────────────────────────
SET lock_timeout = '8s';

-- ────────────────────────────────────────────────────────────────────
-- 1. Функции персонала: SECURITY DEFINER, поэтому политики не заходят в
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
-- 2. Публичное представление: сайт читает имена авторов, составов и
--    поиска пилотов отсюда, а не из закрытой таблицы.
--
--    Почему не просто `CREATE OR REPLACE VIEW`:
--      • `DROP VIEW` тут невозможен — от представления зависит
--        `public.squadron_member_detail` (его переводит на публичные
--        колонки 20261016000000_credentials_and_views_hardening.sql):
--        «cannot drop view public_profiles because other objects depend on
--        it» (SQLSTATE 2BP01);
--      • `CREATE OR REPLACE VIEW` берёт на представление исключительный
--        замок. Представление читает весь сайт, поэтому замок нужен только
--        тогда, когда определение ДЕЙСТВИТЕЛЬНО другое: на живой базе оно
--        уже такое, и блок ниже не делает ничего (ни одной блокировки).
--
--    Сравнение идёт по тому, что печатает сам Postgres: временное
--    представление с тем же SELECT строится тем же механизмом, поэтому
--    форматирование и кавычки в этом файле на результат не влияют.
--
--    Если представление действительно другое: без зависимых объектов оно
--    пересоздаётся (DROP + CREATE), а при зависимых (`squadron_member_detail`
--    на живой базе) не трогается вообще — удалить его нельзя, а «починить»
--    переименование колонок через CREATE OR REPLACE Postgres всё равно
--    запрещает («cannot change name of view column»). Ремонт прав важнее
--    косметики представления; такой базы в цепочке миграций проекта нет.
-- ────────────────────────────────────────────────────────────────────
DO $views$
DECLARE
  desired CONSTANT text :=
    'SELECT p.id, p.cmdr_name, p.avatar_url, p.squadron, '
    'p.created_at, p.updated_at, p.forum_posts_count '
    'FROM public.profiles p';
  cur_def text;
  want_def text;
BEGIN
  IF to_regclass('public.public_profiles') IS NULL THEN
    EXECUTE 'CREATE VIEW public.public_profiles AS ' || desired;
    RETURN;
  END IF;

  EXECUTE 'DROP VIEW IF EXISTS pg_temp.edrc_public_profiles_probe';
  EXECUTE 'CREATE TEMP VIEW edrc_public_profiles_probe AS ' || desired;
  cur_def  := pg_get_viewdef('public.public_profiles'::regclass);
  want_def := pg_get_viewdef('pg_temp.edrc_public_profiles_probe'::regclass);
  EXECUTE 'DROP VIEW pg_temp.edrc_public_profiles_probe';

  IF regexp_replace(lower(cur_def), '\s+', '', 'g') = regexp_replace(lower(want_def), '\s+', '', 'g') THEN
    -- уже наша: ни замка, ни перезаписи
    RETURN;
  END IF;

  -- Другое определение. Удалять можно только если от представления ничего
  -- не зависит: иначе Postgres ответит 2BP01 (именно на этом падало
  -- обновление до 2.26.2).
  IF EXISTS (
    SELECT 1
    FROM pg_depend d
    JOIN pg_rewrite r ON r.oid = d.objid
    JOIN pg_class dependent ON dependent.oid = r.ev_class
    WHERE d.classid = 'pg_rewrite'::regclass
      AND d.refclassid = 'pg_class'::regclass
      AND d.deptype = 'n'
      AND d.refobjid = 'public.public_profiles'::regclass
      AND dependent.oid <> 'public.public_profiles'::regclass
  ) THEN
    RETURN;
  END IF;

  EXECUTE 'DROP VIEW public.public_profiles';
  EXECUTE 'CREATE VIEW public.public_profiles AS ' || desired;
END
$views$;

REVOKE ALL ON public.public_profiles FROM PUBLIC;
GRANT SELECT ON public.public_profiles TO anon, authenticated, service_role;

-- ────────────────────────────────────────────────────────────────────
-- 3. Строки профиля, которых нет: аккаунт есть, а `profiles` пуст —
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
-- 4. Гранты: без них клиент не читает даже собственную строку.
--    `anon` чтения profiles не получает — это закрытая ранее утечка email.
-- ────────────────────────────────────────────────────────────────────
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
REVOKE SELECT ON public.profiles FROM anon;

-- ────────────────────────────────────────────────────────────────────
-- 5. Политики profiles: владелец строки и персонал; запись роли — только
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
-- 6. Триггер защиты role/email: без него любой вошедший снова мог бы
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
-- 7. Таблицы, без чтения которых админка выглядит пустой, а «половина
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
-- 8. Кэш схемы PostgREST: без этого REST-слой продолжает отвечать по
--    старому описанию (новые колонки и представление «не существуют»).
-- ────────────────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
