-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay: чья система на самом деле (web 2.23.0).
--
-- Ночной дамп EDSM `powerPlay.json.gz` — не «система и её держава», а
-- «система и каждая держава в ней». EDSM (EDSM-NET/EDDN-Events,
-- System/PowerPlay.php) пишет по строке на каждую державу из поля журнала
-- `Powers` — все, чьи зоны влияния накрывают систему, — с одним состоянием и
-- датой события, а `ControllingPower` (владельца) не хранит вовсе. Разбор до
-- web 2.23.0 оставлял у системы последнюю строку, и пограничье доставалось
-- державе с самым большим номером в EDSM: у Nakato Kaine (номер 13) на сайте
-- было 3 144 системы при 1 819 в игре, у Aisling Duval (номер 3) — 1 580 при
-- 3 121.
--
-- Теперь у строки слоя есть основание — откуда известен владелец
-- (`power_basis`):
--   journal — поле ControllingPower из журнала (Helper, сайт, CAPI, EDDN);
--   sole    — дамп перечисляет у системы одну державу: она и владелец;
--   kept    — дамп перечисляет несколько, и среди них прежний точный
--             владелец: смена владельца идёт через «свободную» систему
--             (Unoccupied), и такое наблюдение сняло бы строку со слоя;
--   unknown — дамп перечисляет несколько, владелец не определён (power NULL).
-- Державы, которые перечислил дамп, — в колонке `powers` (у журнала — его
-- собственный список `Powers`).
--
-- power теперь может быть NULL — не пустая строка: CHECK миграции
-- 20261020120000 (при повторном прогоне снимка full_schema.sql или
-- update-project.sh) пропускает NULL, но не ''. Старый код строки без
-- державы просто не показывает.
--
-- Миграция идемпотентна (IF NOT EXISTS, CREATE OR REPLACE, DROP … IF EXISTS
-- перед ADD CONSTRAINT).
-- ══════════════════════════════════════════════════════════════════════════

ALTER TABLE public.powerplay_systems ALTER COLUMN power DROP NOT NULL;
ALTER TABLE public.powerplay_systems ADD COLUMN IF NOT EXISTS power_basis TEXT;

-- Строки, записанные до этой миграции: журналы пилотов знают владельца
-- точно. Строки дампа остаются без основания (NULL) до следующей загрузки — она
-- начнётся сама: импорт старым разбором считается устаревшим
-- (`powerplay_sync_state.stats.parser`).
UPDATE public.powerplay_systems
   SET power_basis = 'journal'
 WHERE power_basis IS NULL
   AND source <> 'edsm'
   AND power_state <> 'Unoccupied'
   AND nullif(power, '') IS NOT NULL;

ALTER TABLE public.powerplay_systems DROP CONSTRAINT IF EXISTS powerplay_systems_basis_check;
ALTER TABLE public.powerplay_systems ADD CONSTRAINT powerplay_systems_basis_check
  CHECK (
    (power_basis IS NULL OR power_basis IN ('journal', 'sole', 'kept', 'unknown'))
    AND (power_basis IS DISTINCT FROM 'unknown' OR power IS NULL)
    AND (power IS NOT NULL OR power_basis = 'unknown')
  );

COMMENT ON COLUMN public.powerplay_systems.power IS
  'Держава-владелец, как её пишет журнал игры (ControllingPower): «A. Lavigny-Duval», «Jerome Archer» и т. д. NULL — владелец не определён (power_basis = unknown).';
COMMENT ON COLUMN public.powerplay_systems.power_basis IS
  'Откуда известен владелец: journal (ControllingPower из журнала), sole (в дампе EDSM одна держава), kept (прежний точный владелец всё ещё среди держав дампа), unknown (не определён). NULL — строка импорта до web 2.23.0.';
COMMENT ON COLUMN public.powerplay_systems.powers IS
  'Державы в системе (поле журнала Powers): владелец и те, чьи зоны влияния её накрывают. У строк дампа EDSM — державы, которые он перечислил.';

-- ── Импорт дампа пачкой ───────────────────────────────────────────────────
-- Строка пачки — система целиком (`powerplayDump.ts` собирает записи дампа):
-- power — владелец, если держава в дампе одна (иначе пусто), powers — все
-- державы, которые дамп перечислил. Старые вызовы без powers — одна держава.

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

  WITH incoming AS (
    SELECT DISTINCT ON (r.id64)
      r.id64,
      btrim(r.name) AS name,
      r.x, r.y, r.z,
      nullif(btrim(r.power), '') AS power,
      r.power_state,
      COALESCE(
        (SELECT array_agg(DISTINCT btrim(p) ORDER BY btrim(p))
           FROM unnest(r.powers) AS p
          WHERE nullif(btrim(p), '') IS NOT NULL AND length(btrim(p)) <= 64),
        CASE WHEN nullif(btrim(r.power), '') IS NULL THEN NULL ELSE ARRAY[btrim(r.power)] END
      ) AS powers,
      nullif(btrim(r.allegiance), '') AS allegiance,
      nullif(btrim(r.government), '') AS government,
      r.observed_at
    FROM jsonb_to_recordset(p_rows) AS r(
      id64 BIGINT, name TEXT, x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
      power TEXT, power_state TEXT, powers TEXT[], allegiance TEXT, government TEXT, observed_at TIMESTAMPTZ
    )
    WHERE r.id64 IS NOT NULL AND r.id64 > 0
      AND nullif(btrim(r.name), '') IS NOT NULL
      AND length(btrim(r.name)) <= 120
      AND r.power_state IN ('Stronghold', 'Fortified', 'Exploited')
      AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
      AND (nullif(btrim(r.power), '') IS NULL OR length(btrim(r.power)) <= 64)
    ORDER BY r.id64, r.observed_at DESC NULLS LAST
  ),
  resolved AS (
    SELECT
      i.*,
      -- Держава в дампе одна — владелец она. Несколько — прежний точный
      -- владелец, если он среди них; иначе не определён.
      CASE
        WHEN i.power IS NOT NULL THEN i.power
        WHEN t.power_basis IN ('journal', 'sole', 'kept')
             AND nullif(t.power, '') IS NOT NULL
             AND t.power = ANY(i.powers) THEN t.power
        ELSE NULL
      END AS owner,
      CASE
        WHEN i.power IS NOT NULL THEN 'sole'
        WHEN t.power_basis IN ('journal', 'sole', 'kept')
             AND nullif(t.power, '') IS NOT NULL
             AND t.power = ANY(i.powers) THEN 'kept'
        ELSE 'unknown'
      END AS basis
    FROM incoming AS i
    LEFT JOIN public.powerplay_systems AS t ON t.id64 = i.id64
    WHERE i.power IS NOT NULL OR cardinality(i.powers) > 0
  )
  INSERT INTO public.powerplay_systems AS t (
    id64, name, name_lc, x, y, z, power, power_state, power_basis, powers,
    allegiance, government, observed_at, source, sync_run, updated_at
  )
  SELECT
    r.id64, r.name, lower(r.name), r.x, r.y, r.z, r.owner, r.power_state, r.basis, r.powers,
    r.allegiance, r.government, r.observed_at, 'edsm', p_run, now()
  FROM resolved AS r
  ON CONFLICT (id64) DO UPDATE SET
    name             = EXCLUDED.name,
    name_lc          = EXCLUDED.name_lc,
    x                = EXCLUDED.x,
    y                = EXCLUDED.y,
    z                = EXCLUDED.z,
    power            = EXCLUDED.power,
    power_state      = EXCLUDED.power_state,
    power_basis      = EXCLUDED.power_basis,
    powers           = EXCLUDED.powers,
    allegiance       = EXCLUDED.allegiance,
    government       = EXCLUDED.government,
    -- Счётчики журнала дамп не знает: после более свежего дампа они устарели.
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

-- ── Завершение импорта ───────────────────────────────────────────────────
-- Как раньше: пропавшее из дампа удаляется, кроме наблюдений пилотов, которые
-- новее самого дампа. Плюс итог по основаниям — для журнала админки.

CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_unknown INTEGER;
  v_sole    INTEGER;
  v_kept    INTEGER;
  v_journal INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
  v_dump_at TIMESTAMPTZ;
  v_bases   JSONB;
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

  SELECT
    count(*),
    count(*) FILTER (WHERE power IS NULL),
    count(*) FILTER (WHERE power_basis = 'sole'),
    count(*) FILTER (WHERE power_basis = 'kept'),
    count(*) FILTER (WHERE power_basis = 'journal')
    INTO v_total, v_unknown, v_sole, v_kept, v_journal
    FROM public.powerplay_systems
   WHERE power_state <> 'Unoccupied';
  v_bases := jsonb_build_object('journal', v_journal, 'sole', v_sole, 'kept', v_kept, 'unknown', v_unknown);

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
    stats             = COALESCE(v_state->'stats', '{}'::jsonb)
                        || jsonb_build_object('deleted', v_deleted, 'bases', v_bases)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total) || v_bases;
END;
$$;

-- ── Слой карты ────────────────────────────────────────────────────────────
-- Кортеж: id64, имя, x, y, z, владелец (NULL — не определён), состояние,
-- наблюдение (unix-секунды), основание, державы в системе.

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
        floor(extract(epoch FROM s.observed_at))::bigint, s.power_basis, s.powers
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.powerplay_systems s
  WHERE s.power_state <> 'Unoccupied';
$$;

-- ── Сводка для админки ────────────────────────────────────────────────────
-- По державам: состояния, откуда известен владелец и в скольких системах с
-- неопределённым владельцем держава — среди претендентов.

CREATE OR REPLACE FUNCTION public.powerplay_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH controlled AS (
    SELECT * FROM public.powerplay_systems WHERE power_state <> 'Unoccupied'
  ),
  owned AS (
    SELECT
      s.power,
      count(*) FILTER (WHERE s.power_state = 'Stronghold') AS stronghold,
      count(*) FILTER (WHERE s.power_state = 'Fortified') AS fortified,
      count(*) FILTER (WHERE s.power_state = 'Exploited') AS exploited,
      count(*) AS total,
      count(*) FILTER (WHERE s.power_basis = 'journal') AS journal,
      count(*) FILTER (WHERE s.power_basis = 'sole') AS sole,
      count(*) FILTER (WHERE s.power_basis = 'kept') AS kept,
      count(*) FILTER (WHERE s.power_basis IS NULL) AS legacy
    FROM controlled s
    WHERE nullif(s.power, '') IS NOT NULL
    GROUP BY s.power
  ),
  contested AS (
    SELECT candidate AS power, count(*) AS contested
    FROM controlled s, unnest(s.powers) AS candidate
    WHERE s.power IS NULL
    GROUP BY candidate
  ),
  merged AS (
    SELECT
      COALESCE(o.power, c.power) AS power,
      COALESCE(o.stronghold, 0) AS stronghold,
      COALESCE(o.fortified, 0) AS fortified,
      COALESCE(o.exploited, 0) AS exploited,
      COALESCE(o.total, 0) AS total,
      COALESCE(o.journal, 0) AS journal,
      COALESCE(o.sole, 0) AS sole,
      COALESCE(o.kept, 0) AS kept,
      COALESCE(o.legacy, 0) AS legacy,
      COALESCE(c.contested, 0) AS contested
    FROM owned o
    FULL JOIN contested c ON c.power = o.power
  )
  SELECT json_build_object(
    'total', (SELECT count(*) FROM controlled),
    'powers', COALESCE((
      SELECT json_agg(
        json_build_object(
          'power', m.power,
          'Stronghold', m.stronghold,
          'Fortified', m.fortified,
          'Exploited', m.exploited,
          'total', m.total,
          'journal', m.journal,
          'sole', m.sole,
          'kept', m.kept,
          'legacy', m.legacy,
          'contested', m.contested
        )
        ORDER BY m.total DESC, m.power
      )
      FROM merged m
    ), '[]'::json),
    'unknown', (
      SELECT json_build_object(
        'total', count(*),
        'Stronghold', count(*) FILTER (WHERE power_state = 'Stronghold'),
        'Fortified', count(*) FILTER (WHERE power_state = 'Fortified'),
        'Exploited', count(*) FILTER (WHERE power_state = 'Exploited')
      )
      FROM controlled
      WHERE power IS NULL
    ),
    'bases', COALESCE((
      SELECT json_object_agg(b.basis, b.n)
      FROM (
        SELECT COALESCE(power_basis, 'legacy') AS basis, count(*) AS n
        FROM controlled
        GROUP BY 1
      ) b
    ), '{}'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (SELECT source, count(*) AS n FROM controlled GROUP BY 1) src
    ), '{}'::json),
    'vacated', (SELECT count(*) FROM public.powerplay_systems WHERE power_state = 'Unoccupied'),
    'oldest_observation', (SELECT min(observed_at) FROM controlled),
    'newest_observation', (SELECT max(observed_at) FROM controlled),
    'last_change', (SELECT max(updated_at) FROM public.powerplay_systems)
  );
$$;

-- ── Наблюдения из журналов (Helper, сайт, CAPI, EDDN) ─────────────────────
-- Как в 20261020120000, плюс:
--   * у строк из журнала основание `journal` — владелец из ControllingPower;
--   * наблюдение старше сохранённого всё же называет владельца, если в
--     строке он не определён, журнал видел систему под контролем одной из
--     перечисленных дампом держав и не раньше чем за 7 дней до дампа: смена
--     владельца в PowerPlay 2.0 идёт через «свободную» систему и занимает не
--     меньше двух циклов (основание `kept`).

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
  v_resolved INTEGER := 0;
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

    SELECT s.observed_at, s.power_state, s.power, s.powers INTO v_existing
      FROM public.powerplay_systems AS s
     WHERE s.id64 = v_row.id64
       FOR UPDATE;

    IF FOUND THEN
      IF v_existing.observed_at IS NOT NULL AND v_existing.observed_at >= v_row.observed_at THEN
        IF v_existing.power IS NULL
           AND v_existing.power_state <> 'Unoccupied'
           AND v_row.power_state <> 'Unoccupied'
           AND v_row.power <> ''
           AND v_row.power = ANY(COALESCE(v_existing.powers, ARRAY[]::TEXT[]))
           AND v_row.observed_at >= v_existing.observed_at - interval '7 days' THEN
          UPDATE public.powerplay_systems
             SET power = v_row.power, power_basis = 'kept', updated_at = now()
           WHERE id64 = v_row.id64;
          v_resolved := v_resolved + 1;
          v_applied := v_applied + 1;
        ELSE
          v_stale := v_stale + 1;
          CONTINUE;
        END IF;
      ELSE
        UPDATE public.powerplay_systems AS t SET
          name             = v_row.name,
          name_lc          = lower(v_row.name),
          x                = v_row.x,
          y                = v_row.y,
          z                = v_row.z,
          power            = v_row.power,
          power_state      = v_row.power_state,
          power_basis      = CASE WHEN v_row.power_state = 'Unoccupied' THEN NULL ELSE 'journal' END,
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
        id64, name, name_lc, x, y, z, power, power_state, power_basis, powers, control_progress,
        reinforcement, undermining, allegiance, government, observed_at, source, sync_run, updated_at
      ) VALUES (
        v_row.id64, v_row.name, lower(v_row.name), v_row.x, v_row.y, v_row.z, v_row.power, v_row.power_state, 'journal',
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
    'resolved', v_resolved,
    'systems', to_jsonb(v_systems)
  );
END;
$$;

COMMENT ON FUNCTION public.powerplay_apply_observations(JSONB, TEXT) IS
  'PowerPlay из журналов (Helper, сайт, CAPI, EDDN): применяется наблюдение новее сохранённого; новая система — только если новее дампа; старое наблюдение называет неопределённого владельца, если тот среди держав дампа.';
COMMENT ON FUNCTION public.powerplay_apply_batch(UUID, JSONB) IS
  'Импорт дампа EDSM пачкой: система целиком (все её державы). Одна держава — владелец; несколько — прежний точный владелец, если он среди них, иначе «не определён».';

-- Всё это — только сервером (service_role).
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows(),
  public.powerplay_admin_summary(),
  public.powerplay_apply_observations(JSONB, TEXT)
  TO service_role;

NOTIFY pgrst, 'reload schema';
