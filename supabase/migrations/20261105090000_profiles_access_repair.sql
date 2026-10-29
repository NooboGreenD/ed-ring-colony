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
-- 0б. Помощник сравнения: приводит выражение политики к «плоскому» виду,
--     чтобы `(id = auth.uid()) OR request_is_staff()` и
--     `id = auth.uid() OR public.request_is_staff()` считались одним и тем же.
--     Функция временная (pg_temp): в базе после наката ничего не остаётся,
--     и на живые объекты она не влияет.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.edrc_norm_sql(t text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(
    lower(coalesce(t, '')),
    '"[^"]*"', '', 'g'),
    '\mpublic\.', '', 'g'),
    '\s+', '', 'g'),
    '[()]', '', 'g'));
$$;

-- ────────────────────────────────────────────────────────────────────
-- 0в. «Безопасность в порядке?» — по фактическому состоянию каталога, а не
--     по тексту файла. Нужна там, где правильный DDL не удаётся применить
--     из-за занятой базы: пропускать правку можно, только если дыры в
--     доступе при этом не открываются.
--     Проверки: RLS на profiles включён; есть SELECT-политика, которая
--     смотрит на auth.uid(); нет политики «пускать всех» (USING (true));
--     триггер защиты role/email на месте.
-- ────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pg_temp.edrc_security_ok()
RETURNS boolean
LANGUAGE sql
STABLE
AS $$
  SELECT
    coalesce((SELECT c.relrowsecurity FROM pg_class c WHERE c.oid = 'public.profiles'::regclass), false)
    AND EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'profiles'
        AND p.cmd IN ('SELECT', 'ALL')
        AND pg_temp.edrc_norm_sql(p.qual) LIKE '%auth.uid%'
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_policies p
      WHERE p.schemaname = 'public' AND p.tablename = 'profiles'
        AND (pg_temp.edrc_norm_sql(p.qual) IN ('true', '1=1')
             OR pg_temp.edrc_norm_sql(p.with_check) IN ('true', '1=1'))
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger t
      WHERE t.tgrelid = 'public.profiles'::regclass
        AND t.tgname = 'trg_protect_profile_privileged_columns'
        AND NOT t.tgisinternal
    );
$$;


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
--
--    Пересоздание политики = исключительный замок на `profiles`, который
--    держит весь сайт. Поэтому сначала сверяем то, что уже есть: если все три
--    политики ровно такие, шаг не делает ничего (на живой базе это так, и
--    именно этот замок 29.10.2026 превратился в deadlock). Сверяем не текст
--    файла, а разобранные выражения из pg_policies — Postgres печатает их
--    по-своему, но `pg_temp.edrc_norm_sql` уравнивает скобки и схему.
-- ────────────────────────────────────────────────────────────────────
DO $policies$
DECLARE
  spec record;
  cur_cmd text;
  cur_roles name[];
  cur_qual text;
  cur_wc text;
  need boolean := false;
  diff text := '';
BEGIN
  FOR spec IN
    SELECT * FROM (VALUES
      ('profiles_select', 'SELECT',
       'id = auth.uid() OR public.request_is_staff()', NULL),
      ('profiles_insert', 'INSERT',
       NULL, 'id = auth.uid()'),
      ('profiles_update', 'UPDATE',
       'id = auth.uid() OR public.request_is_admin()',
       'id = auth.uid() OR public.request_is_admin()')
    ) AS v(name, cmd, qual, wc)
  LOOP
    cur_cmd := NULL; cur_roles := NULL; cur_qual := NULL; cur_wc := NULL;
    SELECT p.cmd, p.roles, p.qual, p.with_check
      INTO cur_cmd, cur_roles, cur_qual, cur_wc
      FROM pg_policies p
     WHERE p.schemaname = 'public'
       AND p.tablename = 'profiles'
       AND p.policyname = spec.name;

    IF cur_cmd IS NULL THEN
      need := true;
      diff := diff || spec.name || ' отсутствует; ';
    ELSIF cur_cmd <> spec.cmd
       OR cur_roles IS DISTINCT FROM ARRAY['authenticated']::name[]
       OR pg_temp.edrc_norm_sql(cur_qual) IS DISTINCT FROM pg_temp.edrc_norm_sql(spec.qual)
       OR pg_temp.edrc_norm_sql(cur_wc) IS DISTINCT FROM pg_temp.edrc_norm_sql(spec.wc) THEN
      need := true;
      diff := diff || spec.name || ' = ' || spec.cmd || ' TO ' || array_to_string(cur_roles, ',')
              || ' USING ' || coalesce(btrim(cur_qual), '-')
              || ' WITH CHECK ' || coalesce(btrim(cur_wc), '-') || '; ';
    END IF;
  END LOOP;

  IF NOT need THEN
    RETURN;
  END IF;

  RAISE WARNING 'profiles: политики отличаются от нужных → %', left(diff, 600);

  BEGIN
    -- Исключительный замок на profiles: любой читающий сайт держит ACCESS
    -- SHARE, и ожидание здесь — это часы простоя сайта. Ограничиваем.
    EXECUTE 'SET LOCAL lock_timeout = ''8s''';

    EXECUTE 'DROP POLICY IF EXISTS profiles_select ON public.profiles';
    EXECUTE 'CREATE POLICY profiles_select ON public.profiles
               FOR SELECT TO authenticated
               USING (id = auth.uid() OR public.request_is_staff())';

    EXECUTE 'DROP POLICY IF EXISTS profiles_insert ON public.profiles';
    EXECUTE 'CREATE POLICY profiles_insert ON public.profiles
               FOR INSERT TO authenticated
               WITH CHECK (id = auth.uid())';

    EXECUTE 'DROP POLICY IF EXISTS profiles_update ON public.profiles';
    EXECUTE 'CREATE POLICY profiles_update ON public.profiles
               FOR UPDATE TO authenticated
               USING (id = auth.uid() OR public.request_is_admin())
               WITH CHECK (id = auth.uid() OR public.request_is_admin())';
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      -- База занята (21:11:23.10.2026 — импорт галактики держал её часами).
      -- Главное — не оставить базу без защиты и не блокировать обновление
      -- навсегда: если дыры нет, переносим косметическую правку на
      -- следующий прогон (файл идемпотентен и доберёт её сам).
      IF pg_temp.edrc_security_ok() THEN
        RAISE WARNING 'edrc:skipped-lock profiles: база занята, политики не переписаны — '
                      'текущие безопасны, файл не будет отмечен применённым и повторится '
                      'следующим обновлением';
        RETURN;
      END IF;
      RAISE EXCEPTION 'profiles: база занята, а политики НЕ безопасны — '
                      'освободите базу (pg_stat_activity) и повторите обновление. %', left(diff, 600);
  END;
END
$policies$;

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


--    Пересоздание триггера тоже берёт замок на `profiles` (SHARE ROW
--    EXCLUSIVE), поэтому правильный триггер не трогаем: проверяем по
--    каталогу — момент срабатывания (BEFORE INSERT OR UPDATE) и функция.
DO $trigger$
DECLARE
  has_trigger boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
    FROM pg_trigger t
    WHERE t.tgrelid = 'public.profiles'::regclass
      AND t.tgname = 'trg_protect_profile_privileged_columns'
      AND NOT t.tgisinternal
      AND t.tgfoid = 'public.protect_profile_privileged_columns()'::regprocedure
      AND (t.tgtype & 2) = 2   -- BEFORE
      AND (t.tgtype & 4) = 4   -- INSERT
      AND (t.tgtype & 16) = 16 -- UPDATE
  ) INTO has_trigger;

  IF has_trigger THEN
    RETURN;
  END IF;

  BEGIN
    EXECUTE 'SET LOCAL lock_timeout = ''8s''';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_protect_profile_privileged_columns ON public.profiles';
    EXECUTE 'CREATE TRIGGER trg_protect_profile_privileged_columns
               BEFORE INSERT OR UPDATE OF role, email ON public.profiles
               FOR EACH ROW
               EXECUTE FUNCTION public.protect_profile_privileged_columns()';
  EXCEPTION
    WHEN lock_not_available OR deadlock_detected THEN
      -- Триггер — защита от самоназначения админом: его отсутствие это дыра,
      -- поэтому здесь пропуск допустим только если триггер всё-таки есть
      -- (проверка выше его не нашла — значит, его правда нет).
      RAISE EXCEPTION 'profiles: база занята, триггер защиты role/email не создан. '
                      'Освободите базу (pg_stat_activity) и повторите обновление';
  END;
END
$trigger$;

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
