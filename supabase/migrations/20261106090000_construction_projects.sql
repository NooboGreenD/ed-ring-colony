-- ══════════════════════════════════════════════════════════════════════════
-- projects: проекты строительства, первичные данные сайта.
--
-- Зачем эта таблица
-- -----------------
-- До сих пор единственным местом, где жил «проект стройки» (название, тип,
-- остаток потребности, buildId), был Raven Colonial. Когда его API отвечает
-- 503 или недоступен, Colonial Helper оставался без списка действующих
-- проектов: вкладка «Колонизатор» пустела, а оверлей CARRIER показывал
-- «Проект не выбран». Данные при этом были — их присылал сам Helper.
--
-- Теперь сайт хранит проект у себя: Helper сначала регистрирует его здесь
-- (`POST /api/projects/register`), и только потом — при наличии ключа RCC —
-- дублирует в Raven Colonial. Если Raven недоступен, проект всё равно
-- существует, виден на сайте, в Архитекторе и в оверлее Helper.
--
-- Что в строке
-- ------------
--   * ключ — `system_address:market_id` (fallback `rc:<buildId>`): площадка
--     опознаётся по MarketID из журнала, а не по имени и не по порядку;
--   * `commodities` — текущий остаток потребности (то, что Helper присылает
--     в Raven как `commodities`), `max_need` — исходный объём;
--   * `resources` — точный список `{Name, RequiredAmount, ProvidedAmount}` из
--     `ColonisationConstructionDepot`, если Helper его прислал. По нему сайт
--     считает остаток сам и не зависит ни от Raven, ни от чужих снимков;
--   * `build_id` и `rc_state` — состояние синхронизации с Raven. `rc_state`
--     не влияет на чтение: это диагностика для интерфейса («Raven: 503»);
--   * `source` — кто создал строку: `helper` (прислал Helper), `site`
--     (создано на сайте), `raven` (пришло из кэша Raven, строку завёл cron).
--
-- Доступ
-- ------
-- Запись — только service_role: её делает маршрут Next.js, проверив токен
-- Helper или сессию пилота. Чтения отдельной политикой не открываем: список
-- активных проектов отдаёт маршрут, который сам решает, что показывать
-- (публично — по системе, приватно — по командиру).
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.construction_projects (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Стабильный ключ площадки. Первичный вариант — `address:marketId`.
  project_key     TEXT NOT NULL UNIQUE CHECK (length(project_key) BETWEEN 1 AND 120),
  system_name     TEXT NOT NULL DEFAULT '' CHECK (length(system_name) <= 128),
  system_name_lc  TEXT GENERATED ALWAYS AS (lower(btrim(system_name))) STORED,
  system_address  BIGINT,
  market_id       BIGINT,
  -- Идентификатор проекта в Raven Colonial; null, пока Raven не подтвердил.
  build_id        TEXT,
  build_name      TEXT NOT NULL DEFAULT '' CHECK (length(build_name) <= 200),
  build_type      TEXT NOT NULL DEFAULT '',
  body_name       TEXT,
  body_num        INTEGER,
  star_pos        JSONB,
  architect_name  TEXT,
  commander       TEXT,
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'complete', 'cancelled')),
  -- Текущий остаток по товарам: {"steel": 900, ...}. Пустой объект — неизвестен.
  commodities     JSONB NOT NULL DEFAULT '{}'::jsonb
                    CHECK (jsonb_typeof(commodities) = 'object'),
  -- Исходная потребность: либо число тонн, либо {"steel": 1200, ...}.
  max_need        JSONB,
  -- Точные ресурсы депота: [{"Name": "steel", "RequiredAmount": 1200,
  -- "ProvidedAmount": 300}]. По ним остаток считается без Raven.
  resources       JSONB NOT NULL DEFAULT '[]'::jsonb
                    CHECK (jsonb_typeof(resources) = 'array'),
  progress        NUMERIC(5,2) CHECK (progress IS NULL OR (progress >= 0 AND progress <= 100)),
  is_primary_port BOOLEAN NOT NULL DEFAULT false,
  source          TEXT NOT NULL DEFAULT 'helper'
                    CHECK (source IN ('helper', 'site', 'raven')),
  -- Состояние синхронизации с Raven: ok | unavailable | no_key | skipped.
  rc_state        TEXT NOT NULL DEFAULT 'unknown'
                    CHECK (rc_state IN ('unknown', 'ok', 'unavailable', 'no_key', 'skipped')),
  rc_checked_at   TIMESTAMPTZ,
  -- С какого момента проект считается активным на сайте (журнальное время
  -- первого снимка либо момент регистрации).
  started_at      TIMESTAMPTZ,
  user_id         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.construction_projects IS
  'Проекты строительства, первичные для сайта: Helper регистрирует проект здесь, затем дублирует в Raven Colonial.';
COMMENT ON COLUMN public.construction_projects.commodities IS
  'Текущий остаток потребности по товарам (то же, что Helper отправляет в Raven как commodities).';
COMMENT ON COLUMN public.construction_projects.resources IS
  'Точный список ресурсов депота (Name/RequiredAmount/ProvidedAmount): по нему остаток считается без Raven.';
COMMENT ON COLUMN public.construction_projects.rc_state IS
  'Результат последней попытки синхронизировать проект с Raven Colonial. На чтение не влияет.';

CREATE INDEX IF NOT EXISTS construction_projects_system_lc
  ON public.construction_projects(system_name_lc);
CREATE INDEX IF NOT EXISTS construction_projects_market
  ON public.construction_projects(market_id) WHERE market_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS construction_projects_build
  ON public.construction_projects(build_id) WHERE build_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS construction_projects_commander
  ON public.construction_projects(lower(btrim(commander)))
  WHERE commander IS NOT NULL AND commander <> '';
CREATE INDEX IF NOT EXISTS construction_projects_active
  ON public.construction_projects(updated_at DESC) WHERE status = 'active';

-- Права: читает и пишет только сервер.
ALTER TABLE public.construction_projects ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.construction_projects FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.construction_projects TO service_role;

-- Отдельная политика service_role — вторая линия защиты, как у остальных
-- служебных таблиц проекта: даже если гранты поменяют, политика без
-- подходящей роли ничего не откроет.
DROP POLICY IF EXISTS construction_projects_service_role ON public.construction_projects;
CREATE POLICY construction_projects_service_role ON public.construction_projects
  FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ─────────────────────────────────────────────────────────────────────────
-- 2. Регистрация проекта из Helper: одна функция вместо «прочитать, сравнить,
--    записать» в маршруте. Правило «новее побеждает» — по updated_at: Helper
--    может досылать очередь с задержкой, и старая копия не должна затирать
--    свежую.
-- ─────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.construction_project_register(p_project JSONB, p_user UUID)
RETURNS public.construction_projects
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_key   TEXT;
  v_updated TIMESTAMPTZ;
  v_row   public.construction_projects;
BEGIN
  v_key := btrim(COALESCE(p_project->>'project_key', ''));
  IF v_key = '' THEN
    RAISE EXCEPTION 'project_key is required';
  END IF;

  v_updated := LEAST(
    COALESCE((p_project->>'updated_at')::timestamptz, now()),
    now()
  );

  INSERT INTO public.construction_projects AS cp (
    project_key, system_name, system_address, market_id, build_id,
    build_name, build_type, body_name, body_num, star_pos,
    architect_name, commander, status, commodities, max_need, resources,
    progress, is_primary_port, source, rc_state, rc_checked_at, started_at,
    user_id, updated_at
  ) VALUES (
    v_key,
    COALESCE(p_project->>'system_name', ''),
    NULLIF(p_project->>'system_address', '')::bigint,
    NULLIF(p_project->>'market_id', '')::bigint,
    NULLIF(p_project->>'build_id', ''),
    COALESCE(p_project->>'build_name', ''),
    COALESCE(p_project->>'build_type', ''),
    NULLIF(p_project->>'body_name', ''),
    NULLIF(p_project->>'body_num', '')::integer,
    CASE WHEN jsonb_typeof(p_project->'star_pos') = 'array' THEN p_project->'star_pos' ELSE NULL END,
    NULLIF(p_project->>'architect_name', ''),
    NULLIF(p_project->>'commander', ''),
    COALESCE(NULLIF(p_project->>'status', ''), 'active'),
    CASE WHEN jsonb_typeof(p_project->'commodities') = 'object' THEN p_project->'commodities' ELSE '{}'::jsonb END,
    CASE WHEN jsonb_typeof(p_project->'max_need') IN ('object', 'number') THEN p_project->'max_need' ELSE NULL END,
    CASE WHEN jsonb_typeof(p_project->'resources') = 'array' THEN p_project->'resources' ELSE '[]'::jsonb END,
    NULLIF(p_project->>'progress', '')::numeric,
    COALESCE((p_project->>'is_primary_port')::boolean, false),
    COALESCE(NULLIF(p_project->>'source', ''), 'helper'),
    COALESCE(NULLIF(p_project->>'rc_state', ''), 'unknown'),
    COALESCE((p_project->>'rc_checked_at')::timestamptz, NULL),
    COALESCE((p_project->>'started_at')::timestamptz, now()),
    p_user,
    v_updated
  )
  ON CONFLICT (project_key) DO UPDATE SET
    system_name     = COALESCE(NULLIF(EXCLUDED.system_name, ''), cp.system_name),
    system_address  = COALESCE(EXCLUDED.system_address, cp.system_address),
    market_id       = COALESCE(EXCLUDED.market_id, cp.market_id),
    build_id        = COALESCE(EXCLUDED.build_id, cp.build_id),
    build_name      = COALESCE(NULLIF(EXCLUDED.build_name, ''), cp.build_name),
    build_type      = COALESCE(NULLIF(EXCLUDED.build_type, ''), cp.build_type),
    body_name       = COALESCE(EXCLUDED.body_name, cp.body_name),
    body_num        = COALESCE(EXCLUDED.body_num, cp.body_num),
    star_pos        = COALESCE(EXCLUDED.star_pos, cp.star_pos),
    architect_name  = COALESCE(EXCLUDED.architect_name, cp.architect_name),
    commander       = COALESCE(EXCLUDED.commander, cp.commander),
    status          = EXCLUDED.status,
    commodities     = CASE WHEN EXCLUDED.commodities <> '{}'::jsonb
                           THEN EXCLUDED.commodities ELSE cp.commodities END,
    max_need        = COALESCE(EXCLUDED.max_need, cp.max_need),
    resources       = CASE WHEN jsonb_array_length(EXCLUDED.resources) > 0
                           THEN EXCLUDED.resources ELSE cp.resources END,
    progress        = COALESCE(EXCLUDED.progress, cp.progress),
    is_primary_port = cp.is_primary_port OR EXCLUDED.is_primary_port,
    source          = EXCLUDED.source,
    rc_state        = EXCLUDED.rc_state,
    rc_checked_at   = COALESCE(EXCLUDED.rc_checked_at, cp.rc_checked_at),
    updated_at      = GREATEST(cp.updated_at, EXCLUDED.updated_at),
    user_id         = COALESCE(EXCLUDED.user_id, cp.user_id)
  WHERE EXCLUDED.updated_at >= cp.updated_at
  RETURNING * INTO v_row;

  -- Старшая копия уже в базе: возвращаем её, а не «ничего».
  IF v_row.id IS NULL THEN
    SELECT * INTO v_row FROM public.construction_projects WHERE project_key = v_key;
  END IF;
  RETURN v_row;
END;
$$;

COMMENT ON FUNCTION public.construction_project_register(JSONB, UUID) IS
  'Регистрация/обновление проекта строительства из Helper: «новее побеждает» по updated_at.';

REVOKE ALL ON FUNCTION public.construction_project_register(JSONB, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.construction_project_register(JSONB, UUID) TO service_role;
