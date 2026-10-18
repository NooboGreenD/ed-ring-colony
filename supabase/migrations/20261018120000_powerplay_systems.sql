-- ══════════════════════════════════════════════════════════════════════════
-- PowerPlay 2.0: системы под контролем держав для карты Atlas.
--
-- Источник — ночной дамп EDSM `powerPlay.json.gz` (≈3,5 МБ, обновляется раз
-- в сутки): все системы, чьё состояние PowerPlay пилоты присылали в EDDN за
-- последние ~30 дней. Импорт — `src/lib/powerplaySync.ts` (задача
-- `powerplay-sync` и ленивое обновление из `GET /api/powerplay/systems`).
--
-- Хранится только «под контролем»: Stronghold, Fortified, Exploited. Состояние
-- Unoccupied в дампе приходит с одной державой из нескольких претендентов,
-- поэтому оно отбрасывается ещё в разборе.
--
-- Полная пересборка: каждая строка импорта помечается `sync_run`, а
-- `powerplay_finish_sync` удаляет всё, чего в новом дампе не было (держава
-- потеряла систему или про неё месяц никто не сообщал).
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.powerplay_systems (
  id64         BIGINT PRIMARY KEY,
  name         TEXT NOT NULL,
  -- Имя в нижнем регистре: сортировка слоя и поиск без учёта регистра.
  name_lc      TEXT NOT NULL,
  x            DOUBLE PRECISION NOT NULL,
  y            DOUBLE PRECISION NOT NULL,
  z            DOUBLE PRECISION NOT NULL,
  power        TEXT NOT NULL,
  power_state  TEXT NOT NULL,
  allegiance   TEXT,
  government   TEXT,
  -- Когда источник видел систему в этом состоянии (поле `date` дампа EDSM).
  observed_at  TIMESTAMPTZ,
  source       TEXT NOT NULL DEFAULT 'edsm',
  -- Импорт, который последним видел строку: остальное удаляется в конце импорта.
  sync_run     UUID,
  -- Когда строка последний раз изменилась (держава, состояние, имя или координаты).
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT powerplay_systems_state_check
    CHECK (power_state IN ('Stronghold', 'Fortified', 'Exploited')),
  CONSTRAINT powerplay_systems_name_check
    CHECK (length(name) BETWEEN 1 AND 120 AND length(power) BETWEEN 1 AND 64)
);

CREATE INDEX IF NOT EXISTS idx_powerplay_systems_power
  ON public.powerplay_systems (power, power_state);
CREATE INDEX IF NOT EXISTS idx_powerplay_systems_name_lc
  ON public.powerplay_systems (name_lc);
CREATE INDEX IF NOT EXISTS idx_powerplay_systems_sync_run
  ON public.powerplay_systems (sync_run);

ALTER TABLE public.powerplay_systems ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS powerplay_systems_select ON public.powerplay_systems;
-- Публичные игровые данные (как каталог систем): читать может кто угодно.
CREATE POLICY powerplay_systems_select ON public.powerplay_systems
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.powerplay_systems TO anon, authenticated;
-- Пишет только сервер.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.powerplay_systems TO service_role;

COMMENT ON TABLE public.powerplay_systems IS
  'PowerPlay 2.0: системы под контролем держав (ночной дамп EDSM powerPlay.json.gz). Слой «PowerPlay» карты Atlas.';
COMMENT ON COLUMN public.powerplay_systems.power IS
  'Держава, как её пишет журнал игры (ControllingPower): «A. Lavigny-Duval», «Jerome Archer» и т. д.';
COMMENT ON COLUMN public.powerplay_systems.power_state IS
  'Stronghold (зона 30 св. лет), Fortified (20 св. лет) или Exploited.';

-- ── Состояние импорта: одна строка ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.powerplay_sync_state (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'idle',
  source_url         TEXT,
  -- Заголовки последнего удачного ответа: повторный запрос условный (304).
  etag               TEXT,
  last_modified      TEXT,
  dump_generated_at  TIMESTAMPTZ,
  -- Последний завершённый импорт; он же версия (ETag) ответа API слоя.
  run_id             UUID,
  rows_total         INTEGER NOT NULL DEFAULT 0,
  stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  attempt_at         TIMESTAMPTZ,
  checked_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT powerplay_sync_state_singleton CHECK (id = 1),
  CONSTRAINT powerplay_sync_state_status_check
    CHECK (status IN ('idle', 'running', 'ok', 'error'))
);

INSERT INTO public.powerplay_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.powerplay_sync_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: состояние читает и пишет только сервер (service_role).
GRANT SELECT, INSERT, UPDATE ON public.powerplay_sync_state TO service_role;

COMMENT ON TABLE public.powerplay_sync_state IS
  'Состояние импорта PowerPlay: условный запрос к EDSM (ETag/Last-Modified), время, счётчики и последняя ошибка.';

-- ── Импорт пачкой ─────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.powerplay_apply_batch(p_run UUID, p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_run IS NULL OR p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'powerplay_apply_batch: нужны идентификатор импорта и массив строк';
  END IF;

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
    name        = EXCLUDED.name,
    name_lc     = EXCLUDED.name_lc,
    x           = EXCLUDED.x,
    y           = EXCLUDED.y,
    z           = EXCLUDED.z,
    power       = EXCLUDED.power,
    power_state = EXCLUDED.power_state,
    allegiance  = EXCLUDED.allegiance,
    government  = EXCLUDED.government,
    observed_at = EXCLUDED.observed_at,
    source      = EXCLUDED.source,
    sync_run    = EXCLUDED.sync_run,
    updated_at  = CASE
      WHEN (t.power, t.power_state, t.name, t.x, t.y, t.z)
           IS DISTINCT FROM (EXCLUDED.power, EXCLUDED.power_state, EXCLUDED.name, EXCLUDED.x, EXCLUDED.y, EXCLUDED.z)
      THEN now()
      ELSE t.updated_at
    END;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Завершение импорта: удалить пропавшее и записать состояние ────────────

CREATE OR REPLACE FUNCTION public.powerplay_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_deleted INTEGER;
  v_total   INTEGER;
  v_state   JSONB := COALESCE(p_state, '{}'::jsonb);
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'powerplay_finish_sync: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.powerplay_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'powerplay_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  DELETE FROM public.powerplay_systems WHERE sync_run IS DISTINCT FROM p_run;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  SELECT count(*) INTO v_total FROM public.powerplay_systems;

  INSERT INTO public.powerplay_sync_state AS s (id, status, run_id, rows_total, synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_total, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, rows_total = v_total,
    synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.powerplay_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = (v_state->>'dump_generated_at')::timestamptz,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb) || jsonb_build_object('deleted', v_deleted)
  WHERE id = 1;

  RETURN jsonb_build_object('deleted', v_deleted, 'total', v_total);
END;
$$;

-- ── Слой карты одной выборкой ─────────────────────────────────────────────
-- PostgREST режет обычные выборки по max_rows; ~50 тысяч систем одним JSON
-- приходят за один запрос. Порядок — по имени: панель Atlas не сортирует
-- десятки тысяч строк в браузере.

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
  FROM public.powerplay_systems s;
$$;

-- Импорт и выборка слоя — только сервером (service_role); клиенты идут через API.
REVOKE ALL ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.powerplay_apply_batch(UUID, JSONB),
  public.powerplay_finish_sync(UUID, JSONB),
  public.powerplay_layer_rows()
  TO service_role;

NOTIFY pgrst, 'reload schema';
