-- ══════════════════════════════════════════════════════════════════════════
-- Единый механизм данных о системах (web 2.22.0).
--
-- До этой миграции каждый раздел сайта держал свою картину одной и той же
-- звёздной системы: каталог, кольцо, проекты эскадрилий, «Проекты систем»,
-- Архитектор, станции, фракции, PowerPlay, авианосцы — и почти ничего не
-- знал о соседях. Здесь общие для всех разделов SQL-функции:
--
--   1. Индексы ключа системы `lower(btrim(system_name))` там, где их не было:
--      все разделы ищут систему одним ключом (`src/lib/systemIdentity.ts`).
--
--   2. PowerPlay из журналов пилотов. Одно наблюдение системы (FSDJump /
--      Location / CarrierJump) уже обновляло слой фракций; теперь то же
--      наблюдение обновляет и слой PowerPlay (`powerplay_apply_observations`).
--      Правило то же, что у фракций: побеждает более свежее наблюдение.
--      Ночной дамп EDSM больше не перетирает свежие данные пилотов, а
--      `Unoccupied` из журнала снимает систему со слоя (строка-отметка с
--      power_state = 'Unoccupied' не даёт более старому дампу её вернуть).
--
--   3. Прогресс системы одним правилом. `system_progress_sources(keys)` —
--      те же источники (кэш Raven + журнальные площадки), что у «Проектов
--      систем», но для любого набора систем: их читают карточка системы и
--      проекты эскадрилий, и проценты везде считаются одинаково
--      (`src/lib/architect/projectProgress.ts → buildSystemProgress`).
--
--   4. Журнал → проекты эскадрилий. `sync_project_systems_from_sites(keys)`
--      продвигает статус систем проектов (planned → building → done) по
--      площадкам из журнала, когда журнал прислал Helper или сайт, а не
--      только CAPI, как раньше. Только вперёд: ручной статус не откатывается.
--
--   5. Карточка системы. `system_overview_sources(key, id64, names, viewer)` —
--      всё, что проект знает о системе, одним запросом: каталог, Raven,
--      площадки, планы и архитектор, проекты обоих видов, кольцо, станции,
--      фракции, PowerPlay, цели сообщества, поставки и сканы.
--
-- Миграция идемпотентна (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- перед ADD CONSTRAINT): снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh ничего не ломают.
-- ══════════════════════════════════════════════════════════════════════════

-- ── 1. Индексы ключа системы ──────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_system_progress_system_lc
  ON public.system_progress (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_project_systems_system_lc
  ON public.project_systems (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_hubs_system_lc
  ON public.hubs (lower(btrim(system_name)));
CREATE INDEX IF NOT EXISTS idx_community_goals_system_lc
  ON public.community_goals (lower(btrim(system_name)));

-- ── 2. PowerPlay из журналов пилотов ──────────────────────────────────────

ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS powers TEXT[];
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS control_progress DOUBLE PRECISION;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS reinforcement BIGINT;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS undermining BIGINT;

COMMENT ON COLUMN public.powerplay_systems.powers IS
  'Державы в системе по журналу (Powers): контролирующая и те, что ведут захват. Дамп EDSM их не знает — NULL.';
COMMENT ON COLUMN public.powerplay_systems.control_progress IS
  'PowerplayStateControlProgress из журнала: доля шкалы контроля (у оплота может быть больше 1).';
COMMENT ON COLUMN public.powerplay_systems.reinforcement IS
  'PowerplayStateReinforcement из журнала: очки подкрепления за цикл.';
COMMENT ON COLUMN public.powerplay_systems.undermining IS
  'PowerplayStateUndermining из журнала: очки подрыва за цикл.';
COMMENT ON COLUMN public.powerplay_systems.source IS
  'Откуда наблюдение: edsm (ночной дамп), helper (Colonial Helper), web (журнал или CAPI через сайт), eddn.';

-- 'Unoccupied' — отметка «система больше не под контролем» из журнала: слой
-- её не показывает, а дамп с более старым наблюдением не возвращает.
ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_state_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_state_check
  CHECK (power_state IN ('Stronghold', 'Fortified', 'Exploited', 'Unoccupied'));
ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_name_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_name_check
  CHECK (
    length(name) BETWEEN 1 AND 120
    AND length(power) <= 64
    AND (power_state = 'Unoccupied' OR length(power) >= 1)
  );

CREATE INDEX IF NOT EXISTS idx_powerplay_systems_source
  ON public.powerplay_systems (source) WHERE source <> 'edsm';

-- Импорт дампа пачкой: свежее наблюдение пилота не перетирается.
CREATE OR REPLACE FUNCTION public.powerplay_apply_batch(p_run UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
  v_kept  INTEGER;
BEGIN
  IF p_run IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_batch: нужны идентификатор импорта и массив строк';
  END IF;

  -- Журнал пилота новее дампа: строка остаётся как есть, но помечается этим
  -- импортом, чтобы его завершение её не удалило.
  WITH incoming AS (
    SELECT DISTINCT ON (r.id64) r.id64, r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(id64 BIGINT, observed_at TIMESTAMPTZ)
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
    ORDER BY r.id64, r.observed_at DESC NULLS LAST
  )
  UPDATE public.powerplay_systems AS t
     SET sync_run = p_run
    FROM incoming AS i
   WHERE t.id64 = i.id64
     AND t.source <> 'edsm'
     AND t.observed_at IS NOT NULL
     AND (i.observed_at IS NULL OR t.observed_at > i.observed_at);
  GET DIAGNOSTICS v_kept = ROW_COUNT;

  INSERT INTO public.powerplay_systems AS t (
    id64, name, name_lc, x, y, z, power, power_state,
    allegiance, government, observed_at, source, sync_run, updated_at
  )
  SELECT DISTINCT ON (r.id64)
    r.id64, btrim(r.name), lower(btrim(r.name)), r.x, r.y, r.z, btrim(r.power), r.power_state,
    nullif(btrim(r.allegiance), ''), nullif(btrim(r.government), ''), r.observed_at, 'edsm', p_run, now()
  FROM jsonb_to_recordset(p_rows) AS r(
    id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
    power TEXT, power_state TEXT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
  )
  WHERE r.id64 IS NOT NULL AND r.id64 > 0
    AND nullif(btrim(r.name), '') IS NOT NULL
    AND nullif(btrim(r.power), '') IS NOT NULL
    AND r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
    AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
  ORDER BY r.id64, r.observed_at DESC NULLS LAST
  ON CONFLICT (id64) DO UPDATE SET
    name             = EXCLUDED.name,
    name_lc          = EXCLUDED.name_lc,
    x                = EXCLUDED.x,
    y                = EXCLUDED.y,
    z                = EXCLUDED.z,
    power            = EXCLUDED.power,
    power_state      = EXCLUDED.power_state,
    allegiance       = EXCLUDED.allegiance,
    government       = EXCLUDED.government,
    -- Счётчики журнала дамп не знает: после более свежего дампа они устарели.
    powers           = NULL,
    control_progress = NULL,
    reinforcement    = NULL,
    undermining      = NULL,
    observed_at      = EXCLUDED.observed_at,
    source           = EXCLUDED.source,
    sync_run         = EXCLUDED.sync_run,
    updated_at       = CASE
      WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
           IS DISTINCT FROM (EXCLUDED.power, EXCLUDED.power_state, EXCLUDED.name, EXCLUDED.x, EXCLUDED.y, EXCLUDED.z)
      THEN now()
      ELSE t.updated_at
    END
  WHERE NOT (
    t.source <> 'edsm'
    AND t.observed_at IS NOT NULL
    AND (EXCLUDED.observed_at IS NULL OR t.observed_at > EXCLUDED.observed_at)
  );

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count + v_kept;
END;
$$;

-- Завершение импорта: пропавшее из дампа удаляется, кроме наблюдений пилотов,
-- которые новее самого дампа (дамп о них ещё не знает).
CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
  v_dump_at TIMESTAMPTZ;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'powerplay_finish_sync: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.powerplay_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'powerplay_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  BEGIN
    v_dump_at := nullif(v_state->>'dump_generated_at', '')::timestamptz;
  EXCEPTION WHEN others THEN
    v_dump_at := NULL;
  END;

  DELETE FROM public.powerplay_systems
   WHERE sync_run IS DISTINCT FROM p_run
     AND NOT (
       source <> 'edsm'
       AND observed_at IS NOT NULL
       AND observed_at > COALESCE(v_dump_at, now() - interval '1 day')
     );
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_total FROM public.powerplay_systems WHERE power_state <> 'Unoccupied';

  INSERT INTO public.powerplay_sync_state AS s (id, status, run_id, rows_total, synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_total, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, rows_total = v_total,
    synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.powerplay_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = v_dump_at,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb) || jsonb_build_object('deleted', v_deleted)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total);
END;
$$;

-- Слой карты: только системы под контролем.
CREATE OR REPLACE FUNCTION public.powerplay_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.power, s.power_state,
        floor(extract(epoch FROM s.observed_at))::bigint
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.powerplay_systems s
  WHERE s.power_state <> 'Unoccupied';
$$;

-- Сводка для админки: системы под контролем и откуда пришли данные.
CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'total', (SELECT count(*) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', p.power,
          'Stronghold', p.stronghold,
          'Fortified', p.fortified,
          'Exploited', p.exploited,
          'total', p.total
        )
        ORDER BY p.total DESC, p.power
      )
      FROM (
        SELECT
          s.power,
          count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
          count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
          count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
          count(*) AS total
        FROM public.powerplay_systems s
        WHERE s.power_state <> 'Unoccupied'
        GROUP BY s.power
      ) p
    ), '[]'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (
        SELECT source, count(*) AS n
        FROM public.powerplay_systems
        WHERE power_state <> 'Unoccupied'
        GROUP BY 1
      ) src
    ), '{}'::json),
    'vacated', (SELECT count(*) FROM public.powerplay_systems WHERE power_state = 'Unoccupied'),
    'oldest_observation', (SELECT min(observed_at) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'newest_observation', (SELECT max(observed_at) FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- Наблюдения пилотов (Helper, сайт, CAPI через сайт) → слой PowerPlay.
-- Возвращает счётчики для ответа маршрута и журнала админки.
CREATE OR REPLACE FUNCTION public.powerplay_apply_observations(p_rows JSONB, p_source TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dump_at  TIMESTAMPTZ;
  v_row      RECORD;
  v_existing RECORD;
  v_received INTEGER := 0;
  v_applied  INTEGER := 0;
  v_stale    INTEGER := 0;
  v_created  INTEGER := 0;
  v_vacated  INTEGER := 0;
  v_systems  TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_source IS NULL OR p_source NOT IN ('helper', 'web', 'eddn') THEN
    RAISE EXCEPTION 'powerplay_apply_observations: неизвестный источник %', p_source;
  END IF;
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_observations: нужен массив наблюдений';
  END IF;

  SELECT dump_generated_at INTO v_dump_at FROM public.powerplay_sync_state WHERE id = 1;

  FOR v_row IN
    SELECT DISTINCT ON (r.id64)
      r.id64,
      btrim(r.name) AS name,
      r.x, r.y, r.z,
      COALESCE(nullif(btrim(r.power), ''), '') AS power,
      r.power_state,
      r.powers,
      r.control_progress,
      r.reinforcement,
      r.undermining,
      nullif(btrim(r.allegiance), '') AS allegiance,
      nullif(btrim(r.government), '') AS government,
      r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(
      id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
      power TEXT, power_state TEXT, powers TEXT[], control_progress DOUBLE PRECISION,
      reinforcement BIGINT, undermining BIGINT, allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
    )
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
      AND nullif(btrim(r.name), '') IS NOT NULL
      AND length(btrim(r.name)) <= 120
      AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
      AND r.observed_at IS NOT NULL
      -- PowerPlay 2.0 (29.10.2024): раньше те же поля значили другое.
      AND r.observed_at >= '2024-10-29T00:00:00Z'::timestamptz
      AND r.observed_at <= now() + interval '1 hour'
      AND (
        (r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
          AND nullif(btrim(r.power), '') IS NOT NULL AND length(btrim(r.power)) <= 64)
        OR r.power_state = 'Unoccupied'
      )
    ORDER BY r.id64, r.observed_at DESC
  LOOP
    v_received := v_received + 1;

    SELECT s.observed_at, s.power_state INTO v_existing
      FROM public.powerplay_systems AS s
     WHERE s.id64 = v_row.id64
       FOR UPDATE;

    IF FOUND THEN
      IF v_existing.observed_at IS NOT NULL AND v_existing.observed_at >= v_row.observed_at THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;
      UPDATE public.powerplay_systems AS t SET
        name             = v_row.name,
        name_lc          = lower(v_row.name),
        x                = v_row.x,
        y                = v_row.y,
        z                = v_row.z,
        power            = v_row.power,
        power_state      = v_row.power_state,
        powers           = v_row.powers,
        control_progress = v_row.control_progress,
        reinforcement    = v_row.reinforcement,
        undermining      = v_row.undermining,
        allegiance       = COALESCE(v_row.allegiance, t.allegiance),
        government       = COALESCE(v_row.government, t.government),
        observed_at      = v_row.observed_at,
        source           = p_source,
        updated_at       = CASE
          WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
               IS DISTINCT FROM (v_row.power, v_row.power_state, v_row.name, v_row.x, v_row.y, v_row.z)
          THEN now()
          ELSE t.updated_at
        END
      WHERE t.id64 = v_row.id64;
      v_applied := v_applied + 1;
      IF v_row.power_state = 'Unoccupied' AND v_existing.power_state <> 'Unoccupied' THEN
        v_vacated := v_vacated + 1;
      END IF;
    ELSE
      -- Неизвестную систему добавляем только под контролем и только если
      -- наблюдение новее дампа: старый журнал не рисует на карте то, чего уже нет.
      IF v_row.power_state = 'Unoccupied'
         OR (v_dump_at IS NOT NULL AND v_row.observed_at <= v_dump_at) THEN
        v_stale := v_stale + 1;
        CONTINUE;
      END IF;
      INSERT INTO public.powerplay_systems (
        id64, name, name_lc, x, y, z, power, power_state, powers, control_progress,
        reinforcement, undermining, allegiance, government, observed_at, source, sync_run, updated_at
      ) VALUES (
        v_row.id64, v_row.name, lower(v_row.name), v_row.x, v_row.y, v_row.z, v_row.power, v_row.power_state,
        v_row.powers, v_row.control_progress, v_row.reinforcement, v_row.undermining,
        v_row.allegiance, v_row.government, v_row.observed_at, p_source, NULL, now()
      );
      v_applied := v_applied + 1;
      v_created := v_created + 1;
    END IF;

    IF array_length(v_systems, 1) IS NULL OR array_length(v_systems, 1) < 20 THEN
      v_systems := array_append(v_systems, v_row.name);
    END IF;
  END LOOP;

  RETURN jsonb_build_object(
    'received', v_received,
    'applied', v_applied,
    'stale', v_stale,
    'created', v_created,
    'vacated', v_vacated,
    'systems', to_jsonb(v_systems)
  );
END;
$$;

COMMENT ON FUNCTION public.powerplay_apply_observations(JSONB, TEXT) IS
  'PowerPlay из журналов пилотов: применяется только наблюдение новее сохранённого; новая система — только если новее дампа.';

-- ── 3. Прогресс любых систем одним правилом ───────────────────────────────

CREATE OR REPLACE FUNCTION public.system_progress_sources(p_keys TEXT[])
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH keys AS (
    SELECT DISTINCT lower(btrim(k)) AS key
      FROM unnest(COALESCE(p_keys, ARRAY[]::TEXT[])) AS k
     WHERE nullif(btrim(k), '') IS NOT NULL
     LIMIT 1000
  )
  SELECT jsonb_build_object(
    'raven', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', keys.key,
               'system_name', sp.system_name,
               'progress', sp.progress,
               'updated_at', sp.updated_at,
               'data', sp.data))
        FROM keys
        JOIN public.system_progress AS sp
          ON lower(btrim(sp.system_name)) = keys.key
    ), '[]'::jsonb),
    'depots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', keys.key,
               'market_id', cs.market_id::text,
               'system_name', cs.system_name,
               'construction_name', cs.construction_name,
               'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total,
               'event_timestamp', cs.event_timestamp))
        FROM keys
        JOIN public.colonisation_sites AS cs
          ON lower(btrim(cs.system_name)) = keys.key
    ), '[]'::jsonb)
  );
$$;

COMMENT ON FUNCTION public.system_progress_sources(TEXT[]) IS
  'Источники прогресса систем (кэш Raven + площадки из журнала) — те же, что у «Проектов систем», для любого набора систем.';

-- ── 4. Журнал → статусы систем в проектах эскадрилий ─────────────────────

CREATE OR REPLACE FUNCTION public.sync_project_systems_from_sites(p_keys TEXT[])
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_changed JSONB;
BEGIN
  WITH keys AS (
    SELECT DISTINCT lower(btrim(k)) AS key
      FROM unnest(COALESCE(p_keys, ARRAY[]::TEXT[])) AS k
     WHERE nullif(btrim(k), '') IS NOT NULL
     LIMIT 1000
  ),
  sites AS (
    SELECT keys.key,
           count(*) AS total,
           count(*) FILTER (WHERE cs.construction_progress >= 100) AS complete
      FROM keys
      JOIN public.colonisation_sites AS cs
        ON lower(btrim(cs.system_name)) = keys.key
     GROUP BY keys.key
  ),
  target AS (
    SELECT ps.id,
           CASE WHEN s.complete = s.total THEN 'done' ELSE 'building' END AS status
      FROM public.project_systems AS ps
      JOIN sites AS s ON lower(btrim(ps.system_name)) = s.key
  ),
  changed AS (
    UPDATE public.project_systems AS ps
       SET planned_status = t.status
      FROM target AS t
     WHERE ps.id = t.id
       -- Только вперёд: planned → building → done. Ручной статус не откатывается.
       AND (CASE ps.planned_status WHEN 'done' THEN 2 WHEN 'building' THEN 1 ELSE 0 END)
         < (CASE t.status WHEN 'done' THEN 2 WHEN 'building' THEN 1 ELSE 0 END)
    RETURNING ps.id, ps.project_id, ps.system_name, ps.planned_status
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'id', c.id,
           'project_id', c.project_id,
           'project_name', p.name,
           'system_name', c.system_name,
           'status', c.planned_status)), '[]'::jsonb)
    INTO v_changed
    FROM changed AS c
    JOIN public.projects AS p ON p.id = c.project_id;

  RETURN jsonb_build_object('changed', v_changed);
END;
$$;

COMMENT ON FUNCTION public.sync_project_systems_from_sites(TEXT[]) IS
  'Статус систем проектов эскадрилий по площадкам из журнала (Helper, сайт, CAPI): только вперёд planned → building → done.';

-- ── 5. Карточка системы одним запросом ────────────────────────────────────

CREATE OR REPLACE FUNCTION public.system_overview_sources(
  p_key    TEXT,
  p_id64   TEXT DEFAULT NULL,
  p_names  TEXT[] DEFAULT NULL,
  p_viewer UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_key      TEXT := lower(btrim(COALESCE(p_key, '')));
  v_id64     TEXT := nullif(btrim(COALESCE(p_id64, '')), '');
  v_catalog  JSONB;
  v_names    TEXT[];
  v_bgs_id64 BIGINT;
  v_out      JSONB;
BEGIN
  -- Адрес системы — только цифры в пределах BIGINT, иначе ищем по имени.
  IF v_id64 IS NOT NULL AND (
       v_id64 !~ '^[0-9]{1,19}$'
       OR (length(v_id64) = 19 AND v_id64 > '9223372036854775807')
     ) THEN
    v_id64 := NULL;
  END IF;
  IF v_key = '' AND v_id64 IS NULL THEN
    RETURN '{}'::jsonb;
  END IF;

  -- Каталог: по адресу системы, иначе по имени.
  SELECT to_jsonb(c) INTO v_catalog
    FROM (
      SELECT g.id64, g.name, g.x, g.y, g.z, g.main_star, g.star_type, g.star_giant_class,
             g.needs_permit, g.distance_from_sols, g.distance_from_sgra
        FROM public.galaxy_systems AS g
       WHERE (v_id64 IS NOT NULL AND g.id64 = v_id64)
          OR (v_key <> '' AND g.name_lc = v_key)
       ORDER BY (v_id64 IS NOT NULL AND g.id64 = v_id64) DESC
       LIMIT 1
    ) AS c;

  IF v_catalog IS NOT NULL THEN
    IF v_key = '' THEN v_key := lower(btrim(v_catalog->>'name')); END IF;
    IF v_id64 IS NULL THEN v_id64 := v_catalog->>'id64'; END IF;
  END IF;

  -- Точные написания имени: поставки и сканы хранят имя как в журнале.
  SELECT array_agg(DISTINCT n) INTO v_names
    FROM unnest(COALESCE(p_names, ARRAY[]::TEXT[]) || ARRAY[v_catalog->>'name']) AS n
   WHERE nullif(btrim(n), '') IS NOT NULL;
  v_names := COALESCE(v_names, ARRAY[]::TEXT[]);

  SELECT b.id64 INTO v_bgs_id64
    FROM public.bgs_systems AS b
   WHERE (v_id64 IS NOT NULL AND b.id64 = v_id64::BIGINT)
      OR (v_key <> '' AND b.name_lc = v_key)
   ORDER BY (v_id64 IS NOT NULL AND b.id64 = v_id64::BIGINT) DESC
   LIMIT 1;

  v_out := jsonb_build_object(
    'key', v_key,
    'id64', v_id64,
    'catalog', v_catalog,

    'raven', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', v_key, 'system_name', sp.system_name, 'progress', sp.progress,
               'updated_at', sp.updated_at, 'data', sp.data))
        FROM public.system_progress AS sp
       WHERE lower(btrim(sp.system_name)) = v_key
    ), '[]'::jsonb),

    'depots', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'system_key', v_key, 'market_id', cs.market_id::text, 'system_name', cs.system_name,
               'construction_name', cs.construction_name, 'construction_progress', cs.construction_progress,
               'resources_total', cs.resources_total, 'event_timestamp', cs.event_timestamp)
               ORDER BY cs.event_timestamp DESC)
        FROM public.colonisation_sites AS cs
       WHERE lower(btrim(cs.system_name)) = v_key
    ), '[]'::jsonb),

    -- Планы: опубликованные и свои (черновики «по ссылке» в списках не светятся).
    'plans', COALESCE((
      SELECT jsonb_agg(row_to_json(pl)::jsonb ORDER BY pl.updated_at DESC)
        FROM (
          SELECT p.id, p.system_name, p.title, p.author_id, p.author_name, p.visibility, p.site_count,
                 p.haul_tons, p.catalogue_version, p.updated_at, p.plan
            FROM public.system_plans AS p
           WHERE p.system_name_lc = v_key
             AND (p.visibility = 'public' OR (p_viewer IS NOT NULL AND p.author_id = p_viewer))
           ORDER BY p.updated_at DESC
           LIMIT 5
        ) AS pl
    ), '[]'::jsonb),

    'architect', (
      SELECT jsonb_build_object(
               'system_name', a.system_name, 'user_id', a.user_id, 'name', a.architect_name,
               'assigned_by_name', a.assigned_by_name, 'updated_at', a.updated_at)
        FROM public.system_architects AS a
       WHERE a.system_name_lc = v_key
       LIMIT 1
    ),

    'squadron_projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'name', p.name, 'status', p.status, 'color', p.color,
               'squadron_id', p.squadron_id, 'squadron_name', sq.name, 'squadron_tag', sq.tag,
               'system_status', ps.planned_status, 'priority', ps.priority,
               'target_date', ps.target_date, 'assigned_to', ps.assigned_to)
               ORDER BY p.created_at DESC)
        FROM public.project_systems AS ps
        JOIN public.projects AS p ON p.id = ps.project_id
        LEFT JOIN public.squadrons AS sq ON sq.id = p.squadron_id
       WHERE lower(btrim(ps.system_name)) = v_key
    ), '[]'::jsonb),

    -- «Проекты систем» закрыты для посторонних: имя видят участники, остальным — только число.
    'architect_projects', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'project_id', p.id, 'name', p.name, 'status', p.status, 'color', p.color,
               'stage', s.stage, 'priority', s.priority, 'target_date', s.target_date,
               'progress_summary', p.progress_summary, 'progress_at', p.progress_at,
               'is_member', (p_viewer IS NOT NULL AND EXISTS (
                 SELECT 1 FROM public.architect_project_members AS m
                  WHERE m.project_id = p.id AND m.user_id = p_viewer)))
               ORDER BY p.created_at DESC)
        FROM public.architect_project_systems AS s
        JOIN public.architect_projects AS p ON p.id = s.project_id
       WHERE s.system_name_lc = v_key
    ), '[]'::jsonb),

    'route', (
      SELECT jsonb_build_object(
               'id', rs.id, 'system_name', rs.system_name, 'sort_order', rs.sort_order,
               'status', rs.status, 'progress', rs.progress, 'x', rs.x, 'y', rs.y, 'z', rs.z)
        FROM public.route_systems AS rs
       WHERE lower(rs.system_name) = v_key
       LIMIT 1
    ),

    'hub', (
      SELECT jsonb_build_object(
               'id', h.id, 'name', h.name, 'system_name', h.system_name, 'status', h.status,
               'progress', h.progress, 'segment_order', h.segment_order, 'x', h.x, 'y', h.y, 'z', h.z)
        FROM public.hubs AS h
       WHERE lower(btrim(h.system_name)) = v_key
       LIMIT 1
    ),

    'stations', COALESCE((
      SELECT jsonb_agg(row_to_json(st)::jsonb ORDER BY st.observed_at DESC)
        FROM (
          SELECT sc.station_key, sc.market_id, sc.station_name, sc.station_type, sc.observed_at, sc.source,
                 sc.metadata->'distance_to_arrival' AS distance_to_arrival,
                 sc.metadata->'body_name' AS body_name,
                 sc.metadata->'services' AS services,
                 sc.metadata->'engineers' AS engineers,
                 (SELECT jsonb_object_agg(inv.kind, jsonb_build_object(
                           'observed_at', inv.observed_at,
                           'items', jsonb_array_length(inv.items),
                           'source', inv.source))
                    FROM public.station_inventory_snapshots AS inv
                   WHERE inv.station_key = sc.station_key) AS inventories
            FROM public.station_commerce AS sc
           WHERE sc.system_lc = v_key
           ORDER BY sc.observed_at DESC
           LIMIT 60
        ) AS st
    ), '[]'::jsonb),

    'powerplay', (
      SELECT jsonb_build_object(
               'id64', pp.id64::text, 'name', pp.name, 'power', pp.power, 'state', pp.power_state,
               'powers', pp.powers, 'control_progress', pp.control_progress,
               'reinforcement', pp.reinforcement, 'undermining', pp.undermining,
               'allegiance', pp.allegiance, 'government', pp.government,
               'observed_at', pp.observed_at, 'source', pp.source, 'updated_at', pp.updated_at)
        FROM public.powerplay_systems AS pp
       WHERE (v_id64 IS NOT NULL AND pp.id64 = v_id64::BIGINT)
          OR (v_key <> '' AND pp.name_lc = v_key)
       ORDER BY pp.observed_at DESC NULLS LAST
       LIMIT 1
    ),

    'factions', CASE WHEN v_bgs_id64 IS NULL THEN NULL ELSE public.bgs_system_detail(v_bgs_id64)::jsonb END,

    'goals', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'cg_id', cg.cg_id, 'title', cg.title, 'station_name', cg.station_name,
               'objective', cg.objective, 'tier_current', cg.tier_current, 'tier_max', cg.tier_max,
               'contributors', cg.contributors, 'expiry_date', cg.expiry_date,
               'is_complete', cg.is_complete, 'is_colonisation_related', cg.is_colonisation_related)
               ORDER BY cg.expiry_date DESC NULLS LAST)
        FROM public.community_goals AS cg
       WHERE lower(btrim(cg.system_name)) = v_key
         AND (cg.expiry_date IS NULL OR cg.expiry_date > now() - interval '30 days')
    ), '[]'::jsonb),

    -- Поставки: только суммы, без имён (приватность пилотов решает досье).
    'deliveries', (
      SELECT jsonb_build_object(
               'tons', COALESCE(sum(d.amount) FILTER (WHERE d.is_construction IS DISTINCT FROM false), 0),
               'pilots', count(DISTINCT d.user_id) FILTER (WHERE d.is_construction IS DISTINCT FROM false),
               'last_at', max(d.delivered_at) FILTER (WHERE d.is_construction IS DISTINCT FROM false))
        FROM public.deliveries AS d
       WHERE d.system_name = ANY (v_names)
    ),

    'scans', (
      SELECT jsonb_build_object('bodies', count(DISTINCT s.body_name), 'updated_at', max(s.updated_at))
        FROM public.system_scans AS s
       WHERE s.system_name = ANY (v_names)
    )
  );

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.system_overview_sources(TEXT, TEXT, TEXT[], UUID) IS
  'Карточка системы: всё, что проект знает о системе, одним запросом (каталог, колонизация, проекты, кольцо, станции, фракции, PowerPlay, цели, поставки).';

-- Всё это — только сервером (service_role): маршруты сами решают, что показать зрителю.
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT),
  public.system_progress_sources(TEXT[]),
  public.sync_project_systems_from_sites(TEXT[]),
  public.system_overview_sources(TEXT, TEXT, TEXT[], UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT),
  public.system_progress_sources(TEXT[]),
  public.sync_project_systems_from_sites(TEXT[]),
  public.system_overview_sources(TEXT, TEXT, TEXT[], UUID)
  TO service_role;

NOTIFY pgrst, 'reload schema';
