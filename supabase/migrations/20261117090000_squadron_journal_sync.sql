-- ══════════════════════════════════════════════════════════════════════════
-- Эскадрилья пилота из журнала игры → профиль, состав эскадрильи и проекты.
--
-- Зачем
-- -----
-- Игра пишет принадлежность к эскадрилье при каждом запуске
-- (`SquadronStartup`: SquadronID, SquadronName, CurrentRank) и при повышении
-- (`SquadronPromotion`). Colonial Helper эти события до сих пор выбрасывал:
-- на сайте эскадрилья пилота была только тем, что он ввёл руками (или создал
-- сам), и в списках участников проектов у половины пилотов стоял прочерк.
--
-- Теперь Helper отгружает сведения из журнала, а сайт сам раскладывает их по
-- местам:
--
--   1. `profiles.game_squadron_*` — «эскадрилья в игре» пилота: ID, имя, ранг.
--      Это отдельные колонки, а не `profiles.squadron`: последняя — витрина
--      состава сайта, её пересобирают триггеры членства, и перетирать её
--      журналом нельзя.
--   2. `squadrons.game_squadron_id` — связь эскадрильи сайта с игровой.
--      Заполняется сама, когда игровое имя совпало с названием эскадрильи
--      сайта (см. `apply_pilot_squadron`), и больше не требует ручной сверки.
--   3. `squadron_members.game_rank*` — ранг, который пилот имеет в игре.
--   4. `apply_pilot_squadron()` — одна серверная точка приёма: нормализация
--      имени, поиск эскадрильи (по game_squadron_id, затем по имени),
--      автоматическое вступление в состав и запись ранга.
--
-- Почему функция, а не запросы из маршрута
-- ----------------------------------------
-- Автовступление — это три записи в разные таблицы, и они должны быть
-- атомарными: иначе пилот «уже в составе», но без ранга, или эскадрилья
-- связана с игровой, а участника нет. Плюс защита от старых журналов
-- (см. `stale` ниже) требует сравнения с текущим состоянием под блокировкой.
--
-- Безопасность автовступления
-- ---------------------------
-- Журнал не даёт прав. Автоматически назначаемый ранг — только тот, у
-- которого нет ни одного права (`can_edit_squadron`, `can_manage_members`,
-- `can_manage_ranks`, `can_manage_projects`), даже если игровой ранг пилота
-- выше: «командир эскадрильи» в игре — это не право менять состав сайта.
-- Уже назначенный на сайте ранг автоматика не меняет никогда: ручное решение
-- офицера главнее журнала.
--
-- Доступ
-- ------
-- Функция доступна только `service_role`: зовут её маршруты Next.js
-- (`/api/cmdr/squadron`, приём журнальной пачки `/api/logs/upload`,
-- `/api/logs/import`) после проверки токена Helper'а или сессии.
-- Прямой вызов из браузера подменить эскадрилью чужому пилоту не может.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Эскадрилья сайта ↔ эскадрилья игры ────────────────────────────────────
ALTER TABLE public.squadrons
  ADD COLUMN IF NOT EXISTS game_squadron_id BIGINT,
  -- Когда игровое имя последний раз подтверждало связь и чем она найдена:
  -- `game_id` (по SquadronID), `name` (по названию), `manual` (вручную).
  ADD COLUMN IF NOT EXISTS game_squadron_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS game_squadron_source TEXT;

-- Один и тот же игровой ID не может быть у двух эскадрилий сайта: иначе
-- автовступление выбирало бы состав по порядку строк. Частичный индекс —
-- потому что у большинства эскадрилий связи ещё нет (NULL).
CREATE UNIQUE INDEX IF NOT EXISTS squadrons_game_squadron_id
  ON public.squadrons(game_squadron_id) WHERE game_squadron_id IS NOT NULL;

COMMENT ON COLUMN public.squadrons.game_squadron_id IS
  'SquadronID из журнала игры; связь ставит apply_pilot_squadron по названию или вручную.';

-- 2. «Эскадрилья в игре» у профиля ──────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS game_squadron_id BIGINT,
  ADD COLUMN IF NOT EXISTS game_squadron_name TEXT,
  ADD COLUMN IF NOT EXISTS game_squadron_tag TEXT,
  ADD COLUMN IF NOT EXISTS game_squadron_rank INTEGER,
  ADD COLUMN IF NOT EXISTS game_squadron_rank_name TEXT,
  -- Когда игра последний раз сообщала эти сведения: по нему видно, что
  -- запись старая, и им же защищается «более свежее не перетирается старым».
  ADD COLUMN IF NOT EXISTS game_squadron_at TIMESTAMPTZ,
  -- `helper` (Colonial Helper), `web` (загрузка журналов в браузере) или
  -- `manual` (пилот указал сам).
  ADD COLUMN IF NOT EXISTS game_squadron_source TEXT,
  -- Эскадрилья сайта, к которой пилот приписан по журналу (NULL — не найдена).
  ADD COLUMN IF NOT EXISTS game_squadron_site_id BIGINT;

COMMENT ON COLUMN public.profiles.game_squadron_name IS
  'Название эскадрильи в игре (SquadronStartup). Не заменяет profiles.squadron — ту пересобирает членство на сайте.';
COMMENT ON COLUMN public.profiles.game_squadron_site_id IS
  'Связанная эскадрилья сайта, найденная по game_squadron_id или названию.';

CREATE INDEX IF NOT EXISTS profiles_game_squadron
  ON public.profiles(game_squadron_id) WHERE game_squadron_id IS NOT NULL;

-- 3. Игровой ранг в составе ─────────────────────────────────────────────────
ALTER TABLE public.squadron_members
  ADD COLUMN IF NOT EXISTS game_rank INTEGER,
  ADD COLUMN IF NOT EXISTS game_rank_name TEXT,
  ADD COLUMN IF NOT EXISTS game_synced_at TIMESTAMPTZ,
  -- `game` — строка появилась автовступлением по журналу, `site` — вручную
  -- (приглашение, создание эскадрильи).
  ADD COLUMN IF NOT EXISTS joined_via TEXT;

COMMENT ON COLUMN public.squadron_members.game_rank IS
  'CurrentRank из журнала игры. Права даёт подпись rank_id, а не это число.';

-- 4. Приём сведений ─────────────────────────────────────────────────────────
-- Возвращает JSONB, чтобы вызывающий маршрут и Helper видели, что именно
-- произошло: связана ли эскадрилья, вступил ли пилот, какой ранг записан и
-- почему ничего не изменилось.
CREATE OR REPLACE FUNCTION public.apply_pilot_squadron(
  p_user            UUID,
  p_game_id         BIGINT,
  p_name            TEXT,
  p_tag             TEXT DEFAULT NULL,
  p_rank            INTEGER DEFAULT NULL,
  p_rank_name       TEXT DEFAULT NULL,
  p_at              TIMESTAMPTZ DEFAULT now(),
  p_source          TEXT DEFAULT 'helper',
  p_join            BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_name        TEXT := btrim(coalesce(p_name, ''));
  v_tag         TEXT := upper(regexp_replace(coalesce(p_tag, ''), '[^A-Za-z0-9]', '', 'g'));
  v_source      TEXT := CASE WHEN p_source IN ('helper', 'web', 'manual') THEN p_source ELSE 'helper' END;
  v_at          TIMESTAMPTZ := coalesce(p_at, now());
  v_prev_at     TIMESTAMPTZ;
  v_squadron_id BIGINT;
  v_squadron_name TEXT;
  v_found_by    TEXT;
  v_rank_id     BIGINT;
  v_rank_name   TEXT;
  v_is_member   BOOLEAN := false;
  v_joined      BOOLEAN := false;
  v_reason      TEXT;
  v_size        INTEGER;
  v_limit       INTEGER;
  v_game_rank   INTEGER := CASE WHEN p_rank IS NULL OR p_rank < 0 THEN NULL ELSE LEAST(p_rank, 99) END;
  v_target_rank BIGINT;
  v_rank_count  INTEGER;
BEGIN
  IF p_user IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'user_required');
  END IF;

  -- Профиль есть у каждого аккаунта; если строки нет (старая база), создать её
  -- здесь нельзя: id ссылается на auth.users, а функция — service_role.
  SELECT game_squadron_at INTO v_prev_at
    FROM public.profiles
   WHERE id = p_user;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'profile_missing');
  END IF;

  -- Пере-импорт истории: старый SquadronStartup не должен возвращать пилота в
  -- прежнюю эскадрилью после того, как он вступил в новую.
  IF v_prev_at IS NOT NULL AND v_at < v_prev_at THEN
    RETURN jsonb_build_object('ok', true, 'skipped', 'stale', 'at', v_prev_at);
  END IF;

  IF v_game_rank IS NOT NULL AND (p_rank_name IS NULL OR btrim(p_rank_name) = '') AND v_game_rank > 8 THEN
    v_game_rank := NULL;
  END IF;

  -- ── Поиск эскадрильи сайта ───────────────────────────────────────────────
  IF p_game_id IS NOT NULL AND p_game_id > 0 THEN
    SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
      FROM public.squadrons AS sq
     WHERE sq.game_squadron_id = p_game_id
     LIMIT 1;
    IF FOUND THEN
      v_found_by := 'game_id';
    END IF;
  END IF;

  IF v_squadron_id IS NULL AND v_name <> '' THEN
    -- Имя — единственное, что журнал даёт о чужой эскадрилье: сравниваем без
    -- регистра и лишних пробелов, как это делает сайт в остальных местах.
    SELECT sq.id, sq.name INTO v_squadron_id, v_squadron_name
      FROM public.squadrons AS sq
     WHERE lower(btrim(sq.name)) = lower(v_name)
     LIMIT 1;
    IF FOUND THEN
      v_found_by := 'name';
    END IF;
  END IF;

  -- Связь выучивается один раз: дальше достаточно SquadronID.
  IF v_squadron_id IS NOT NULL AND p_game_id IS NOT NULL AND p_game_id > 0 THEN
    UPDATE public.squadrons AS sq
       SET game_squadron_id = p_game_id,
           game_squadron_at = greatest(coalesce(sq.game_squadron_at, v_at), v_at),
           game_squadron_source = coalesce(sq.game_squadron_source,
               CASE WHEN v_found_by = 'game_id' THEN 'game_id' ELSE 'name' END)
     WHERE sq.id = v_squadron_id
       AND (sq.game_squadron_id IS NULL OR sq.game_squadron_id = p_game_id);
    -- Конфликт (ID уже занят другой эскадрильей) не ошибка приёма: эскадрилья
    -- остаётся найденной, просто без связи по ID.
  END IF;

  -- ── Профиль ──────────────────────────────────────────────────────────────
  UPDATE public.profiles AS p
     SET game_squadron_id = coalesce(p_game_id, p.game_squadron_id),
         game_squadron_name = CASE WHEN v_name <> '' THEN left(v_name, 120) ELSE p.game_squadron_name END,
         game_squadron_tag = CASE WHEN v_tag <> '' THEN left(v_tag, 8) ELSE p.game_squadron_tag END,
         game_squadron_rank = coalesce(v_game_rank, p.game_squadron_rank),
         game_squadron_rank_name = CASE
             WHEN p_rank_name IS NOT NULL AND btrim(p_rank_name) <> '' THEN left(btrim(p_rank_name), 80)
             ELSE p.game_squadron_rank_name END,
         game_squadron_at = greatest(coalesce(p.game_squadron_at, v_at), v_at),
         game_squadron_source = v_source,
         game_squadron_site_id = coalesce(v_squadron_id, p.game_squadron_site_id),
         updated_at = now()
   WHERE p.id = p_user;

  -- ── Автовступление в состав ──────────────────────────────────────────────
  IF v_squadron_id IS NOT NULL THEN
    SELECT true, sm.rank_id INTO v_is_member, v_target_rank
      FROM public.squadron_members AS sm
     WHERE sm.squadron_id = v_squadron_id AND sm.user_id = p_user
     LIMIT 1;
    v_is_member := coalesce(v_is_member, false);

    IF NOT v_is_member AND coalesce(p_join, true) THEN
      SELECT coalesce(sq.member_limit, 500), (
          SELECT count(*)::integer FROM public.squadron_members AS sm
           WHERE sm.squadron_id = v_squadron_id)
        INTO v_limit, v_size
        FROM public.squadrons AS sq
       WHERE sq.id = v_squadron_id;

      -- Пилот не может быть в двух эскадрильях (UNIQUE(squadron_id, user_id)
      -- этого не требует, но сайт так живёт, см. /api/squadrons/[id]/members).
      IF EXISTS (SELECT 1 FROM public.squadron_members AS sm WHERE sm.user_id = p_user) THEN
        v_reason := 'other_squadron';
      ELSIF v_size >= v_limit THEN
        v_reason := 'full';
      ELSE
        -- Ранг — только без прав. Порядок: по имени (если игра/клиент его дал),
        -- иначе по номеру: игровой 0 — низший, значит самый большой sort_order.
        IF p_rank_name IS NOT NULL AND btrim(p_rank_name) <> '' THEN
          SELECT r.id, r.name INTO v_rank_id, v_rank_name
            FROM public.squadron_ranks AS r
           WHERE r.squadron_id = v_squadron_id
             AND NOT (r.can_edit_squadron OR r.can_manage_members
                      OR r.can_manage_ranks OR r.can_manage_projects)
             AND lower(btrim(r.name)) = lower(btrim(p_rank_name))
           ORDER BY r.sort_order DESC, r.id
           LIMIT 1;
        END IF;

        IF v_rank_id IS NULL THEN
          SELECT count(*)::integer INTO v_rank_count
            FROM public.squadron_ranks AS r
           WHERE r.squadron_id = v_squadron_id
             AND NOT (r.can_edit_squadron OR r.can_manage_members
                      OR r.can_manage_ranks OR r.can_manage_projects);

          IF v_rank_count > 0 THEN
            SELECT r.id, r.name INTO v_rank_id, v_rank_name
              FROM public.squadron_ranks AS r
             WHERE r.squadron_id = v_squadron_id
               AND NOT (r.can_edit_squadron OR r.can_manage_members
                        OR r.can_manage_ranks OR r.can_manage_projects)
             ORDER BY r.sort_order DESC, r.id
             OFFSET LEAST(GREATEST(coalesce(v_game_rank, 0), 0), v_rank_count - 1)
             LIMIT 1;
          END IF;
        END IF;

        INSERT INTO public.squadron_members
          (squadron_id, user_id, rank_id, game_rank, game_rank_name,
           game_synced_at, joined_at, joined_via, created_at)
        VALUES
          (v_squadron_id, p_user, v_rank_id, v_game_rank, left(coalesce(p_rank_name, ''), 80),
           v_at, v_at, 'game', now())
        ON CONFLICT (squadron_id, user_id) DO NOTHING;
        v_joined := FOUND;
      END IF;
    ELSIF v_is_member THEN
      -- Состав уже есть: обновляем только игровые поля. `rank_id` не трогаем —
      -- ручное назначение офицера главнее журнала.
      UPDATE public.squadron_members AS sm
         SET game_rank = coalesce(v_game_rank, sm.game_rank),
             game_rank_name = CASE
                 WHEN p_rank_name IS NOT NULL AND btrim(p_rank_name) <> ''
                   THEN left(btrim(p_rank_name), 80)
                 ELSE sm.game_rank_name END,
             game_synced_at = greatest(coalesce(sm.game_synced_at, v_at), v_at)
       WHERE sm.squadron_id = v_squadron_id AND sm.user_id = p_user;
    ELSE
      v_reason := 'join_disabled';
    END IF;
  ELSE
    v_reason := coalesce(v_reason, 'squadron_not_found');
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'gameSquadronId', p_game_id,
    'gameSquadronName', nullif(v_name, ''),
    'gameRank', v_game_rank,
    'squadronId', v_squadron_id,
    'squadronName', v_squadron_name,
    'foundBy', v_found_by,
    'member', v_is_member,
    'joined', v_joined,
    'rankId', v_rank_id,
    'rankName', v_rank_name,
    'reason', v_reason,
    'at', v_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN)
  TO service_role;

COMMENT ON FUNCTION public.apply_pilot_squadron(UUID, BIGINT, TEXT, TEXT, INTEGER, TEXT, TIMESTAMPTZ, TEXT, BOOLEAN) IS
  'Эскадрилья из журнала → профиль, связь с эскадрильей сайта и автовступление в состав (ранг без прав, ручной ранг не перетирается).';

-- 5. Витрина «эскадрилья пилота» ───────────────────────────────────────────
-- Списки участников проектов (и старых, и «Проектов систем») читают профили
-- через service_role, но публичной витрине эти колонки тоже нужны: карточка
-- командира показывает эскадрилью и без авторизации.
--
-- public_profiles пересобирается безопасно (см. 20261016000000): если от
-- представления что-то зависит, блок ничего не делает.
DO $game_squadron_view$
DECLARE
  desired CONSTANT text :=
    'SELECT p.id, p.cmdr_name, p.avatar_url, p.squadron, '
    'p.created_at, p.updated_at, p.forum_posts_count, '
    'p.game_squadron_id, p.game_squadron_name, p.game_squadron_rank, '
    'p.game_squadron_rank_name, p.game_squadron_at, p.game_squadron_site_id '
    'FROM public.profiles p';
  cur_def text;
  want_def text;
BEGIN
  IF to_regclass('public.public_profiles') IS NULL THEN
    EXECUTE 'CREATE VIEW public.public_profiles AS ' || desired;
    RETURN;
  END IF;

  -- Проба может не собраться, если у profiles нет какой-то из прежних
  -- колонок (частично восстановленная база). Тогда витрину не трогаем вовсе:
  -- косметика представления не повод ронять миграцию.
  BEGIN
    EXECUTE 'DROP VIEW IF EXISTS pg_temp.edrc_public_profiles_probe';
    EXECUTE 'CREATE TEMP VIEW edrc_public_profiles_probe AS ' || desired;
  EXCEPTION WHEN OTHERS THEN
    RETURN;
  END;
  cur_def  := pg_get_viewdef('public.public_profiles'::regclass);
  want_def := pg_get_viewdef('pg_temp.edrc_public_profiles_probe'::regclass);
  EXECUTE 'DROP VIEW pg_temp.edrc_public_profiles_probe';

  IF regexp_replace(lower(cur_def), '\s+', '', 'g')
     = regexp_replace(lower(want_def), '\s+', '', 'g') THEN
    RETURN;
  END IF;

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
$game_squadron_view$;

REVOKE ALL ON public.public_profiles FROM PUBLIC;
GRANT SELECT ON public.public_profiles TO anon, authenticated, service_role;

COMMENT ON VIEW public.public_profiles IS
  'Публичные колонки profiles (имена авторов, составы, поиск пилотов, эскадрилья в игре). '
  'email/role/privacy_settings/language остаются во внутренней таблице.';
