-- ══════════════════════════════════════════════════════════════════════════
-- «Проекты систем» в Архитекторе (/architect/projects).
--
-- Проект — группа систем, которые эскадрилья или команда пилотов строит
-- вместе. К проекту привязываются участники (создатель, модераторы,
-- участники), системы (с планом архитектора и ответственным пилотом) и
-- авианосцы. Прогресс систем и проекта считается из уже существующих данных
-- (кэш Raven Colonial `system_progress`, состояние стройплощадок из журналов
-- `colonisation_sites`, планы `system_plans`), вклад пилотов — из `deliveries`
-- и грузовых дельт авианосцев `fleet_carrier_events`.
--
-- Доступ:
--   * проект видят только его участники (и администратор сайта);
--   * создатель (`owner`) назначает модераторов, передаёт и удаляет проект;
--   * модератор ведёт системы, участников и авианосцы;
--   * участник смотрит прогресс, лидеров и привязывает свой авианосец.
--
-- Запись идёт только через service_role: права решают маршруты Next.js
-- (`src/app/api/architect/projects/**`). Политики SELECT для authenticated —
-- вторая линия защиты на случай прямого чтения таблиц клиентом.
--
-- Вклад пилотов чужим участникам виден только агрегатом: функции
-- architect_project_contributions/activity доступны лишь service_role, а
-- маршрут отдаёт суммы и скрывает имена пилотов вне проекта, закрывших
-- поставки в настройках приватности.
-- ══════════════════════════════════════════════════════════════════════════

-- 1. Проект ─────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_projects (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  description      TEXT NOT NULL DEFAULT '' CHECK (length(description) <= 4000),
  status           TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('planning', 'active', 'paused', 'completed', 'archived')),
  color            TEXT NOT NULL DEFAULT '#e67e22' CHECK (color ~ '^#[0-9a-f]{6}$'),
  target_date      DATE,
  -- С какого момента считать вклад пилотов (NULL — за всё время). Нужен,
  -- когда в систему проекта уже возили груз под прежнюю, чужую стройку.
  tracking_since   TIMESTAMPTZ,
  -- Последняя посчитанная сводка прогресса: список проектов показывает её,
  -- не пересчитывая каждую систему каждого проекта.
  progress_summary JSONB CHECK (progress_summary IS NULL OR jsonb_typeof(progress_summary) = 'object'),
  progress_at      TIMESTAMPTZ,
  created_by       UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.architect_projects IS
  'Проекты систем Архитектора: группа систем под застройку с участниками, ролями и авианосцами.';

-- 2. Участники ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_members (
  project_id  UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'moderator', 'member')),
  -- Обязанность в проекте свободным текстом: «перевозчик», «архитектор HIP 1»…
  duty        TEXT NOT NULL DEFAULT '' CHECK (length(duty) <= 80),
  added_by    UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- Ровно один создатель на проект: передача проекта — функция ниже.
CREATE UNIQUE INDEX IF NOT EXISTS architect_project_members_one_owner
  ON public.architect_project_members(project_id) WHERE role = 'owner';
CREATE INDEX IF NOT EXISTS architect_project_members_user
  ON public.architect_project_members(user_id);

-- 3. Системы проекта ────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_systems (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id      UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  system_name     TEXT NOT NULL CHECK (length(btrim(system_name)) BETWEEN 1 AND 128),
  -- Тот же ключ, что у system_plans: `HIP 1` и `hip 1` — одна система.
  system_name_lc  TEXT GENERATED ALWAYS AS (lower(btrim(system_name))) STORED,
  -- Этап, который ведут люди; фактический прогресс считается из данных.
  stage           TEXT NOT NULL DEFAULT 'planned'
                    CHECK (stage IN ('planned', 'claimed', 'building', 'done', 'on_hold')),
  priority        SMALLINT NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 3),
  plan_id         UUID REFERENCES public.system_plans(id) ON DELETE SET NULL,
  responsible_id  UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  target_date     DATE,
  notes           TEXT NOT NULL DEFAULT '' CHECK (length(notes) <= 2000),
  sort_order      INTEGER NOT NULL DEFAULT 0,
  added_by        UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, system_name_lc)
);

CREATE INDEX IF NOT EXISTS architect_project_systems_lc
  ON public.architect_project_systems(system_name_lc);

-- 4. Авианосцы проекта ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.architect_project_carriers (
  project_id   UUID NOT NULL REFERENCES public.architect_projects(id) ON DELETE CASCADE,
  carrier_id   BIGINT NOT NULL REFERENCES public.fleet_carriers(carrier_id) ON DELETE CASCADE,
  -- Какую систему проекта обслуживает (необязательно).
  system_id    UUID REFERENCES public.architect_project_systems(id) ON DELETE SET NULL,
  purpose      TEXT NOT NULL DEFAULT '' CHECK (length(purpose) <= 80),
  -- Груз носителя виден участникам проекта, только если привязал его тот,
  -- кто и так видит груз: владелец личного носителя или офицер эскадрильи.
  share_cargo  BOOLEAN NOT NULL DEFAULT false,
  added_by     UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, carrier_id)
);

CREATE INDEX IF NOT EXISTS architect_project_carriers_carrier
  ON public.architect_project_carriers(carrier_id);

-- 5. Права и RLS ────────────────────────────────────────────────────────────
-- Роль вызывающего в проекте. SECURITY DEFINER: политика на members сама
-- читает members, без этого RLS ушла бы в бесконечную рекурсию.
CREATE OR REPLACE FUNCTION public.architect_project_role(p_project UUID)
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT m.role
    FROM public.architect_project_members AS m
   WHERE m.project_id = p_project
     AND m.user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.architect_project_role(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.architect_project_role(UUID) TO authenticated, service_role;

ALTER TABLE public.architect_projects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.architect_project_carriers ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.architect_projects, public.architect_project_members,
              public.architect_project_systems, public.architect_project_carriers
  FROM anon, authenticated;
GRANT SELECT ON public.architect_projects, public.architect_project_members,
                public.architect_project_systems, public.architect_project_carriers
  TO authenticated;
GRANT ALL ON public.architect_projects, public.architect_project_members,
             public.architect_project_systems, public.architect_project_carriers
  TO service_role;

DROP POLICY IF EXISTS architect_projects_select ON public.architect_projects;
CREATE POLICY architect_projects_select ON public.architect_projects
  FOR SELECT TO authenticated
  USING (public.architect_project_role(id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_members_select ON public.architect_project_members;
CREATE POLICY architect_project_members_select ON public.architect_project_members
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_systems_select ON public.architect_project_systems;
CREATE POLICY architect_project_systems_select ON public.architect_project_systems
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

DROP POLICY IF EXISTS architect_project_carriers_select ON public.architect_project_carriers;
CREATE POLICY architect_project_carriers_select ON public.architect_project_carriers
  FOR SELECT TO authenticated
  USING (public.architect_project_role(project_id) IS NOT NULL OR public.request_is_admin());

-- 6. Уход участника ─────────────────────────────────────────────────────────
-- Ушедший пилот перестаёт быть ответственным за системы проекта. Если ушёл
-- создатель (удалил аккаунт), проект достаётся старейшему модератору, а без
-- модераторов — старейшему участнику; пустой проект удаляется. При удалении
-- всего проекта (каскад) ничего не делаем: строки проекта уже нет.
CREATE OR REPLACE FUNCTION public.architect_project_member_removed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_heir UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.architect_projects WHERE id = OLD.project_id) THEN
    RETURN OLD;
  END IF;

  UPDATE public.architect_project_systems
     SET responsible_id = NULL,
         updated_at = now()
   WHERE project_id = OLD.project_id
     AND responsible_id = OLD.user_id;

  IF OLD.role = 'owner' THEN
    SELECT m.user_id INTO v_heir
      FROM public.architect_project_members AS m
     WHERE m.project_id = OLD.project_id
     ORDER BY (m.role = 'moderator') DESC, m.created_at, m.user_id
     LIMIT 1;

    IF v_heir IS NULL THEN
      DELETE FROM public.architect_projects WHERE id = OLD.project_id;
    ELSE
      UPDATE public.architect_project_members
         SET role = 'owner',
             updated_at = now()
       WHERE project_id = OLD.project_id
         AND user_id = v_heir;
    END IF;
  END IF;

  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS architect_project_member_removed ON public.architect_project_members;
CREATE TRIGGER architect_project_member_removed
  AFTER DELETE ON public.architect_project_members
  FOR EACH ROW EXECUTE FUNCTION public.architect_project_member_removed();

-- 7. Создание проекта одной транзакцией ─────────────────────────────────────
-- Проект без создателя-участника не должен появиться даже на миг: иначе его
-- никто, кроме администратора, не увидит.
CREATE OR REPLACE FUNCTION public.architect_project_create(
  p_owner       UUID,
  p_name        TEXT,
  p_description TEXT DEFAULT '',
  p_color       TEXT DEFAULT NULL,
  p_systems     TEXT[] DEFAULT '{}'
)
RETURNS UUID
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_id UUID;
BEGIN
  IF p_owner IS NULL THEN
    RAISE EXCEPTION 'architect_project_create: owner is required' USING ERRCODE = '22004';
  END IF;

  INSERT INTO public.architect_projects (name, description, color, created_by)
  VALUES (
    btrim(p_name),
    coalesce(p_description, ''),
    coalesce(nullif(lower(btrim(coalesce(p_color, ''))), ''), '#e67e22'),
    p_owner
  )
  RETURNING id INTO v_id;

  INSERT INTO public.architect_project_members (project_id, user_id, role, added_by)
  VALUES (v_id, p_owner, 'owner', p_owner);

  INSERT INTO public.architect_project_systems (project_id, system_name, sort_order, added_by)
  SELECT v_id, picked.name, picked.ord, p_owner
    FROM (
      SELECT DISTINCT ON (lower(cleaned.name)) cleaned.name, cleaned.ord
        FROM (
          SELECT btrim(regexp_replace(raw.value, '\s+', ' ', 'g')) AS name, raw.ord::int AS ord
            FROM unnest(coalesce(p_systems, '{}'::text[])) WITH ORDINALITY AS raw(value, ord)
        ) AS cleaned
       WHERE cleaned.name <> ''
       ORDER BY lower(cleaned.name), cleaned.ord
    ) AS picked
   ORDER BY picked.ord;

  RETURN v_id;
END;
$$;

-- 8. Передача проекта ───────────────────────────────────────────────────────
-- Прежний создатель становится модератором. Одна функция — одна транзакция:
-- проект не останется без создателя, если что-то пойдёт не так.
CREATE OR REPLACE FUNCTION public.architect_project_transfer(p_project UUID, p_to UUID)
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.architect_project_members
     WHERE project_id = p_project AND user_id = p_to
  ) THEN
    RAISE EXCEPTION 'architect_project_transfer: new owner is not a member' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.architect_project_members
     SET role = 'moderator',
         updated_at = now()
   WHERE project_id = p_project
     AND role = 'owner'
     AND user_id <> p_to;

  UPDATE public.architect_project_members
     SET role = 'owner',
         updated_at = now()
   WHERE project_id = p_project
     AND user_id = p_to;

  UPDATE public.architect_projects SET updated_at = now() WHERE id = p_project;
END;
$$;

-- 9. Источники прогресса одним запросом ─────────────────────────────────────
-- Кэш Raven и журнальные площадки ищутся без учёта регистра (в кэше
-- встречаются варианты написания), планы — по ссылкам систем проекта.
-- Полный JSON плана нужен только сводке прогресса, лидерборду — нет.
CREATE OR REPLACE FUNCTION public.architect_project_progress_sources(
  p_project_id    UUID,
  p_include_plans BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH systems AS (
    SELECT DISTINCT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  )
  SELECT jsonb_build_object(
    'raven', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', systems.key,
               'system_name', sp.system_name,
               'progress', sp.progress,
               'updated_at', sp.updated_at,
               'data', sp.data))
        FROM systems
        JOIN public.system_progress AS sp
          ON lower(btrim(sp.system_name)) = systems.key
    ), '[]'::jsonb),
    'depots', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', systems.key,
               'market_id', cs.market_id::text,
               'system_name', cs.system_name,
               'construction_name', cs.construction_name,
               'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total,
               'event_timestamp', cs.event_timestamp))
        FROM systems
        JOIN public.colonisation_sites AS cs
          ON lower(btrim(cs.system_name)) = systems.key
    ), '[]'::jsonb),
    'plans', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', p.id,
               'system_name', p.system_name,
               'title', p.title,
               'author_id', p.author_id,
               'author_name', p.author_name,
               'visibility', p.visibility,
               'site_count', p.site_count,
               'haul_tons', p.haul_tons,
               'catalogue_version', p.catalogue_version,
               'updated_at', p.updated_at,
               'plan', CASE WHEN p_include_plans THEN p.plan ELSE NULL END))
        FROM public.system_plans AS p
       WHERE p.id IN (
         SELECT s.plan_id
           FROM public.architect_project_systems AS s
          WHERE s.project_id = p_project_id
            AND s.plan_id IS NOT NULL
       )
    ), '[]'::jsonb)
  );
$$;

-- 10. Вклад пилотов ─────────────────────────────────────────────────────────
-- Строки — уже сгруппированные суммы: пилот × цель × площадка × товар.
--   target = 'site'    — строительные поставки в системы проекта (та же
--                         выборка, что «тоннаж на стройплощадки» в досье:
--                         стройплощадка, колонизационный корабль, старые
--                         строки без признака);
--   target = 'carrier' — продажа груза на авианосцы проекта (MarketSell) и
--                         чистая загрузка владельцем/эскадрой (CargoTransfer,
--                         SquadronBankTransfer; выгрузка обратно вычитается,
--                         чтобы перевалка «на борт и обратно» не считалась).
-- Нижняя граница времени — позднейшая из p_since и tracking_since проекта.
CREATE OR REPLACE FUNCTION public.architect_project_contributions(
  p_project_id UUID,
  p_since      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  user_id      UUID,
  target       TEXT,
  system_name  TEXT,
  market_id    TEXT,
  station_name TEXT,
  commodity    TEXT,
  tons         BIGINT,
  ops          BIGINT,
  first_at     TIMESTAMPTZ,
  last_at      TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT greatest(
             coalesce(p_since, '-infinity'::timestamptz),
             coalesce(p.tracking_since, '-infinity'::timestamptz)
           ) AS since
      FROM public.architect_projects AS p
     WHERE p.id = p_project_id
  ),
  systems AS (
    SELECT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  ),
  carriers AS (
    SELECT c.carrier_id
      FROM public.architect_project_carriers AS c
     WHERE c.project_id = p_project_id
  ),
  site_rows AS (
    SELECT d.user_id,
           lower(btrim(d.system_name))                        AS system_key,
           btrim(d.system_name)                               AS system_name,
           nullif(btrim(coalesce(d.market_id, '')), '')       AS market_id,
           nullif(btrim(coalesce(d.station_name, '')), '')    AS station_name,
           coalesce(nullif(btrim(d.commodity), ''), 'unknown') AS commodity,
           d.amount::bigint                                   AS amount,
           coalesce(d.delivered_at, d.created_at)             AS at
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE lower(btrim(d.system_name)) IN (SELECT key FROM systems)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
       AND (
         d.delivery_kind IN ('construction_site', 'colonisation_ship', 'legacy_site')
         OR (d.delivery_kind IS NULL AND d.is_construction IS DISTINCT FROM false)
       )
  ),
  site_groups AS (
    SELECT r.user_id, 'site'::text AS target, max(r.system_name) AS system_name,
           r.market_id, max(r.station_name) AS station_name, r.commodity,
           sum(r.amount)::bigint AS tons, count(*)::bigint AS ops,
           min(r.at) AS first_at, max(r.at) AS last_at
      FROM site_rows AS r
     GROUP BY r.user_id, r.system_key, r.market_id, r.commodity
  ),
  carrier_rows AS (
    SELECT d.user_id,
           btrim(d.market_id)                                   AS market_id,
           nullif(btrim(coalesce(d.station_name, '')), '')      AS station_name,
           coalesce(nullif(btrim(d.commodity), ''), 'unknown')  AS commodity,
           d.amount::bigint                                     AS tons,
           1::bigint                                            AS ops,
           coalesce(d.delivered_at, d.created_at)               AS first_at,
           coalesce(d.delivered_at, d.created_at)               AS last_at
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE d.delivery_kind = 'fleet_carrier'
       AND btrim(d.market_id) IN (SELECT carrier_id::text FROM carriers)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
    UNION ALL
    SELECT e.user_id, e.carrier_id::text, NULL::text, e.commodity,
           sum(e.delta)::bigint, count(*)::bigint, min(e.event_at), max(e.event_at)
      FROM public.fleet_carrier_events AS e
      CROSS JOIN bounds AS b
     WHERE e.carrier_id IN (SELECT carrier_id FROM carriers)
       AND e.event IN ('CargoTransfer', 'SquadronBankTransfer')
       AND e.user_id IS NOT NULL
       AND e.event_at >= b.since
     GROUP BY e.user_id, e.carrier_id, e.commodity
    HAVING sum(e.delta) > 0
  ),
  carrier_groups AS (
    SELECT r.user_id, 'carrier'::text AS target, NULL::text AS system_name,
           r.market_id, max(r.station_name) AS station_name, r.commodity,
           sum(r.tons)::bigint AS tons, sum(r.ops)::bigint AS ops,
           min(r.first_at) AS first_at, max(r.last_at) AS last_at
      FROM carrier_rows AS r
     GROUP BY r.user_id, r.market_id, r.commodity
  )
  -- Ключ (user_id, target, system_name, market_id, commodity) уникален:
  -- маршрут читает результат страницами (PostgREST режет выдачу max_rows)
  -- и сортирует по нему же, поэтому страницы не пересекаются.
  SELECT * FROM site_groups
  UNION ALL
  SELECT * FROM carrier_groups
  ORDER BY 1, 2, 3 NULLS FIRST, 4 NULLS FIRST, 6;
$$;

-- Активность по дням (UTC) для графика: только суммы пилота за день.
CREATE OR REPLACE FUNCTION public.architect_project_activity(
  p_project_id UUID,
  p_since      TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  day     DATE,
  user_id UUID,
  target  TEXT,
  tons    BIGINT,
  ops     BIGINT
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH bounds AS (
    SELECT greatest(
             coalesce(p_since, '-infinity'::timestamptz),
             coalesce(p.tracking_since, '-infinity'::timestamptz)
           ) AS since
      FROM public.architect_projects AS p
     WHERE p.id = p_project_id
  ),
  systems AS (
    SELECT s.system_name_lc AS key
      FROM public.architect_project_systems AS s
     WHERE s.project_id = p_project_id
  ),
  carriers AS (
    SELECT c.carrier_id
      FROM public.architect_project_carriers AS c
     WHERE c.project_id = p_project_id
  ),
  activity_rows AS (
    SELECT (coalesce(d.delivered_at, d.created_at) AT TIME ZONE 'UTC')::date AS day,
           d.user_id, 'site'::text AS target, d.amount::bigint AS amount
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE lower(btrim(d.system_name)) IN (SELECT key FROM systems)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
       AND (
         d.delivery_kind IN ('construction_site', 'colonisation_ship', 'legacy_site')
         OR (d.delivery_kind IS NULL AND d.is_construction IS DISTINCT FROM false)
       )
    UNION ALL
    SELECT (coalesce(d.delivered_at, d.created_at) AT TIME ZONE 'UTC')::date,
           d.user_id, 'carrier'::text, d.amount::bigint
      FROM public.deliveries AS d
      CROSS JOIN bounds AS b
     WHERE d.delivery_kind = 'fleet_carrier'
       AND btrim(d.market_id) IN (SELECT carrier_id::text FROM carriers)
       AND d.amount > 0
       AND coalesce(d.delivered_at, d.created_at) >= b.since
  )
  SELECT r.day, r.user_id, r.target, sum(r.amount)::bigint AS tons, count(*)::bigint AS ops
    FROM activity_rows AS r
   GROUP BY r.day, r.user_id, r.target
   ORDER BY 1, 2, 3;
$$;

REVOKE ALL ON FUNCTION public.architect_project_create(UUID, TEXT, TEXT, TEXT, TEXT[]),
                       public.architect_project_transfer(UUID, UUID),
                       public.architect_project_progress_sources(UUID, BOOLEAN),
                       public.architect_project_contributions(UUID, TIMESTAMPTZ),
                       public.architect_project_activity(UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.architect_project_create(UUID, TEXT, TEXT, TEXT, TEXT[]),
                          public.architect_project_transfer(UUID, UUID),
                          public.architect_project_progress_sources(UUID, BOOLEAN),
                          public.architect_project_contributions(UUID, TIMESTAMPTZ),
                          public.architect_project_activity(UUID, TIMESTAMPTZ)
  TO service_role;

-- 11. Индексы под выборки проекта ───────────────────────────────────────────
-- Поставки ищутся по системе без учёта регистра (имя в проекте вводит
-- человек), продажи на авианосец — по MarketID носителя.
CREATE INDEX IF NOT EXISTS idx_deliveries_system_lc
  ON public.deliveries (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_deliveries_fleet_carrier_market
  ON public.deliveries (btrim(market_id))
  WHERE delivery_kind = 'fleet_carrier';
CREATE INDEX IF NOT EXISTS idx_system_progress_name_lc
  ON public.system_progress (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_colonisation_sites_system_lc
  ON public.colonisation_sites (lower(btrim(system_name)));
