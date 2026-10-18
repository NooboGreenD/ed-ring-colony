-- ══════════════════════════════════════════════════════════════════════════
-- Минорные фракции (BGS) для карты Atlas: вкладка «Фракции».
--
-- Что хранится:
--   * bgs_systems          — населённые системы (есть хотя бы одна фракция):
--                            координаты, принадлежность, правительство,
--                            экономика, безопасность, население, контролирующая
--                            фракция, когда наблюдали и откуда взято;
--   * bgs_factions         — словарь минорных фракций (имя уникально без учёта
--                            регистра — так их различает и сама игра);
--   * bgs_faction_presence — какая фракция в какой системе: влияние, состояние,
--                            активные / ожидающие / затухающие состояния;
--   * bgs_sync_state       — импорт дампа EDSM: условный запрос, ход и журнал;
--   * bgs_updates          — обновления от пилотов (Colonial Helper и загрузчик
--                            журналов на сайте) для раздела админки.
--
-- Источники:
--   * ночной дамп EDSM `systemsPopulated.json.gz` (≈0,5 ГБ gzip) — полный набор
--     населённых систем с фракциями; импорт — `src/lib/bgsSync.ts`, запускает
--     администратор (Админка → Игровые данные → Фракции) и задача
--     `factions-sync`;
--   * журналы пилотов: FSDJump / Location / CarrierJump со списком `Factions`
--     присылают Colonial Helper и загрузчик журналов на сайте
--     (`POST /api/factions/sync`).
--
-- Правило слияния: побеждает более свежее наблюдение (`observed_at`). Свежие
-- данные пилота не затираются вчерашним дампом, а дамп обновляет системы,
-- где пилоты давно не были. Состав фракций системы заменяется целиком.
--
-- Каждая функция укладывается в короткий statement_timeout PostgREST: запись —
-- пачками по ~250 систем, завершение импорта — несколькими вызовами в цикле.
--
-- Миграция идемпотентна: снимок full_schema.sql и повторный прогон
-- deploy/update-project.sh не ломают уже созданные объекты.
-- ══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.bgs_factions (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL,
  -- Ключ уникальности и поиска: имя в нижнем регистре.
  name_lc           TEXT NOT NULL,
  allegiance        TEXT,
  government        TEXT,
  -- Фракция игроков (PMF). Журнал этого не сообщает — флаг приходит из EDSM.
  is_player         BOOLEAN NOT NULL DEFAULT false,
  edsm_id           BIGINT,
  -- Денормализованные счётчики для поиска и сортировки (bgs_recount_factions).
  systems_count     INTEGER NOT NULL DEFAULT 0,
  controlled_count  INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_factions_name_check CHECK (length(name) BETWEEN 1 AND 160)
);

CREATE UNIQUE INDEX IF NOT EXISTS bgs_factions_name_lc_key ON public.bgs_factions (name_lc);
CREATE INDEX IF NOT EXISTS idx_bgs_factions_systems ON public.bgs_factions (systems_count DESC, name_lc);

CREATE TABLE IF NOT EXISTS public.bgs_systems (
  id64                    BIGINT PRIMARY KEY,
  name                    TEXT NOT NULL,
  name_lc                 TEXT NOT NULL,
  x                       DOUBLE PRECISION NOT NULL,
  y                       DOUBLE PRECISION NOT NULL,
  z                       DOUBLE PRECISION NOT NULL,
  allegiance              TEXT,
  government              TEXT,
  economy                 TEXT,
  second_economy          TEXT,
  security                TEXT,
  state                   TEXT,
  population              BIGINT,
  controlling_faction_id  BIGINT REFERENCES public.bgs_factions (id) ON DELETE SET NULL,
  factions_count          INTEGER NOT NULL DEFAULT 0,
  -- Когда состояние фракций системы видели в игре (журнал пилота или EDSM).
  observed_at             TIMESTAMPTZ,
  -- Откуда последнее применённое наблюдение: edsm | helper | web | eddn.
  source                  TEXT NOT NULL DEFAULT 'edsm',
  -- Импорт дампа EDSM, который последним видел систему.
  sync_run                UUID,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_systems_source_check CHECK (source IN ('edsm', 'helper', 'web', 'eddn')),
  CONSTRAINT bgs_systems_name_check CHECK (length(name) BETWEEN 1 AND 120)
);

CREATE INDEX IF NOT EXISTS idx_bgs_systems_name_lc ON public.bgs_systems (name_lc);
CREATE INDEX IF NOT EXISTS idx_bgs_systems_controlling ON public.bgs_systems (controlling_faction_id);
CREATE INDEX IF NOT EXISTS idx_bgs_systems_sync_run ON public.bgs_systems (sync_run);

CREATE TABLE IF NOT EXISTS public.bgs_faction_presence (
  system_id64        BIGINT NOT NULL REFERENCES public.bgs_systems (id64) ON DELETE CASCADE,
  faction_id         BIGINT NOT NULL REFERENCES public.bgs_factions (id) ON DELETE CASCADE,
  -- Доля 0…1, как в журнале игры (0.452 = 45,2 %).
  influence          REAL,
  state              TEXT,
  active_states      TEXT[] NOT NULL DEFAULT '{}',
  pending_states     TEXT[] NOT NULL DEFAULT '{}',
  recovering_states  TEXT[] NOT NULL DEFAULT '{}',
  happiness          TEXT,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (system_id64, faction_id)
);

CREATE INDEX IF NOT EXISTS idx_bgs_presence_faction ON public.bgs_faction_presence (faction_id);

ALTER TABLE public.bgs_factions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bgs_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bgs_faction_presence ENABLE ROW LEVEL SECURITY;
-- Публичные игровые данные (как каталог систем и PowerPlay): читать может кто угодно.
DROP POLICY IF EXISTS bgs_factions_select ON public.bgs_factions;
CREATE POLICY bgs_factions_select ON public.bgs_factions FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS bgs_systems_select ON public.bgs_systems;
CREATE POLICY bgs_systems_select ON public.bgs_systems FOR SELECT TO anon, authenticated USING (true);
DROP POLICY IF EXISTS bgs_faction_presence_select ON public.bgs_faction_presence;
CREATE POLICY bgs_faction_presence_select ON public.bgs_faction_presence FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.bgs_factions, public.bgs_systems, public.bgs_faction_presence TO anon, authenticated;
-- Пишет только сервер.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bgs_factions, public.bgs_systems, public.bgs_faction_presence TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bgs_factions_id_seq TO service_role;

COMMENT ON TABLE public.bgs_factions IS
  'Минорные фракции (BGS): словарь для вкладки «Фракции» карты Atlas. Источники — дамп EDSM systemsPopulated и журналы пилотов.';
COMMENT ON TABLE public.bgs_systems IS
  'Населённые системы с фракциями: принадлежность, правительство, контролирующая фракция, время наблюдения и источник.';
COMMENT ON TABLE public.bgs_faction_presence IS
  'Присутствие фракции в системе: влияние (0…1), состояние и списки состояний. Состав системы заменяется целиком более свежим наблюдением.';

-- ── Состояние импорта дампа EDSM: одна строка ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.bgs_sync_state (
  id                 SMALLINT PRIMARY KEY DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'idle',
  source_url         TEXT,
  -- Заголовки дампа последнего удачного импорта: тот же дамп второй раз не качается.
  etag               TEXT,
  last_modified      TEXT,
  dump_generated_at  TIMESTAMPTZ,
  dump_bytes         BIGINT,
  run_id             UUID,
  systems_total      INTEGER NOT NULL DEFAULT 0,
  factions_total     INTEGER NOT NULL DEFAULT 0,
  presence_total     INTEGER NOT NULL DEFAULT 0,
  stats              JSONB NOT NULL DEFAULT '{}'::jsonb,
  error              TEXT,
  attempt_at         TIMESTAMPTZ,
  checked_at         TIMESTAMPTZ,
  synced_at          TIMESTAMPTZ,
  -- Ход последнего импорта (этапы, проценты) и журнал процесса для админки.
  progress           JSONB,
  log                JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT bgs_sync_state_singleton CHECK (id = 1),
  CONSTRAINT bgs_sync_state_status_check CHECK (status IN ('idle', 'running', 'ok', 'error'))
);

INSERT INTO public.bgs_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.bgs_sync_state ENABLE ROW LEVEL SECURITY;
-- Политик нет: состояние читает и пишет только сервер (service_role).
GRANT SELECT, INSERT, UPDATE ON public.bgs_sync_state TO service_role;

COMMENT ON TABLE public.bgs_sync_state IS
  'Импорт минорных фракций из дампа EDSM systemsPopulated: заголовки, счётчики, ход этапов и журнал процесса.';

-- ── Обновления от пилотов ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.bgs_updates (
  id           BIGSERIAL PRIMARY KEY,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id      UUID,
  source       TEXT NOT NULL,
  received     INTEGER NOT NULL DEFAULT 0,
  applied      INTEGER NOT NULL DEFAULT 0,
  stale        INTEGER NOT NULL DEFAULT 0,
  created      INTEGER NOT NULL DEFAULT 0,
  invalid      INTEGER NOT NULL DEFAULT 0,
  -- Несколько обновлённых систем — для списка «последние обновления».
  systems      TEXT[] NOT NULL DEFAULT '{}',
  CONSTRAINT bgs_updates_source_check CHECK (source IN ('helper', 'web', 'eddn'))
);

CREATE INDEX IF NOT EXISTS idx_bgs_updates_received ON public.bgs_updates (received_at DESC);

ALTER TABLE public.bgs_updates ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, DELETE ON public.bgs_updates TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.bgs_updates_id_seq TO service_role;

COMMENT ON TABLE public.bgs_updates IS
  'Пачки наблюдений фракций от пилотов (Colonial Helper, загрузчик журналов на сайте): сколько пришло, применено и устарело.';

-- ── Разбор пачки наблюдений ───────────────────────────────────────────────
-- Одна система — одна строка (самое свежее наблюдение из пачки). Значения уже
-- проверены сервером (`src/lib/bgs.ts`), здесь — только приведение типов.

CREATE OR REPLACE FUNCTION public.bgs_parse_rows(p_rows JSONB)
RETURNS TABLE (
  id64            BIGINT,
  name            TEXT,
  x               DOUBLE PRECISION,
  y               DOUBLE PRECISION,
  z               DOUBLE PRECISION,
  allegiance      TEXT,
  government      TEXT,
  economy         TEXT,
  second_economy  TEXT,
  security        TEXT,
  state           TEXT,
  population      BIGINT,
  controlling_lc  TEXT,
  observed_at     TIMESTAMPTZ,
  factions        JSONB
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  -- Каждое приведение типа под CASE: одна кривая строка не должна ронять
  -- всю пачку (порядок вычисления условий WHERE планировщик не обещает).
  SELECT DISTINCT ON (r.id64)
    r.id64, r.name, r.x, r.y, r.z, r.allegiance, r.government, r.economy, r.second_economy,
    r.security, r.state, r.population, r.controlling_lc, r.observed_at, r.factions
  FROM (
    SELECT
      CASE WHEN (e.item->>'id64') ~ '^[0-9]{1,18}$' THEN (e.item->>'id64')::bigint END AS id64,
      btrim(e.item->>'name') AS name,
      CASE WHEN (e.item->>'x') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'x')::double precision END AS x,
      CASE WHEN (e.item->>'y') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'y')::double precision END AS y,
      CASE WHEN (e.item->>'z') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$' THEN (e.item->>'z')::double precision END AS z,
      nullif(btrim(e.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(e.item->>'government'), '') AS government,
      nullif(btrim(e.item->>'economy'), '') AS economy,
      nullif(btrim(e.item->>'second_economy'), '') AS second_economy,
      nullif(btrim(e.item->>'security'), '') AS security,
      nullif(btrim(e.item->>'state'), '') AS state,
      CASE WHEN (e.item->>'population') ~ '^[0-9]{1,18}$' THEN (e.item->>'population')::bigint END AS population,
      lower(nullif(btrim(e.item->>'controlling'), '')) AS controlling_lc,
      CASE WHEN (e.item->>'observed_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
        THEN (e.item->>'observed_at')::timestamptz END AS observed_at,
      CASE WHEN jsonb_typeof(e.item->'factions') = 'array' THEN e.item->'factions' ELSE '[]'::jsonb END AS factions,
      e.ord
    FROM jsonb_array_elements(COALESCE(p_rows, '[]'::jsonb)) WITH ORDINALITY AS e(item, ord)
    WHERE jsonb_typeof(e.item) = 'object'
  ) r
  WHERE r.id64 IS NOT NULL AND r.id64 > 0
    AND r.name IS NOT NULL AND length(r.name) BETWEEN 1 AND 120
    AND r.x IS NOT NULL AND r.y IS NOT NULL AND r.z IS NOT NULL
  -- Свежее наблюдение побеждает; при равных — то, что в пачке позже.
  ORDER BY r.id64, r.observed_at DESC NULLS LAST, r.ord DESC;
$$;

-- ── Счётчики фракций ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_recount_factions(p_ids BIGINT[] DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH ids AS (
    SELECT f.id FROM public.bgs_factions f WHERE p_ids IS NULL OR f.id = ANY (p_ids)
  ),
  presence AS (
    SELECT p.faction_id, count(*)::integer AS n
    FROM public.bgs_faction_presence p
    WHERE p_ids IS NULL OR p.faction_id = ANY (p_ids)
    GROUP BY p.faction_id
  ),
  controlled AS (
    SELECT s.controlling_faction_id AS faction_id, count(*)::integer AS n
    FROM public.bgs_systems s
    WHERE s.controlling_faction_id IS NOT NULL AND (p_ids IS NULL OR s.controlling_faction_id = ANY (p_ids))
    GROUP BY s.controlling_faction_id
  ),
  totals AS (
    SELECT ids.id, COALESCE(presence.n, 0) AS systems_n, COALESCE(controlled.n, 0) AS controlled_n
    FROM ids
    LEFT JOIN presence ON presence.faction_id = ids.id
    LEFT JOIN controlled ON controlled.faction_id = ids.id
  )
  UPDATE public.bgs_factions f
  SET systems_count = t.systems_n, controlled_count = t.controlled_n
  FROM totals t
  WHERE f.id = t.id AND (f.systems_count <> t.systems_n OR f.controlled_count <> t.controlled_n);
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- ── Применение пачки наблюдений (дамп EDSM и журналы пилотов) ─────────────
-- p_rows   — массив систем: id64, name, x, y, z, allegiance, government,
--            economy, second_economy, security, state, population,
--            controlling (имя фракции), observed_at, factions[{name,
--            allegiance, government, is_player, edsm_id, influence, state,
--            active_states[], pending_states[], recovering_states[], happiness}];
-- p_source — edsm | helper | web | eddn;
-- p_run    — импорт дампа: система помечается «видели в этом дампе», даже если
--            её данные не применились (у пилота наблюдение свежее);
-- p_recount — пересчитать счётчики затронутых фракций (импорт дампа делает это
--            один раз в конце).

CREATE OR REPLACE FUNCTION public.bgs_apply_snapshots(
  p_rows JSONB,
  p_source TEXT,
  p_run UUID DEFAULT NULL,
  p_recount BOOLEAN DEFAULT true
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_received   INTEGER := 0;
  v_ids        BIGINT[] := '{}';
  v_new_ids    BIGINT[] := '{}';
  v_old_ctrl   BIGINT[] := '{}';
  v_removed    BIGINT[] := '{}';
  v_touched    BIGINT[] := '{}';
  v_names      TEXT[] := '{}';
  v_factions   INTEGER := 0;
BEGIN
  IF p_rows IS NULL OR jsonb_typeof(p_rows) <> 'array' THEN
    RAISE EXCEPTION 'bgs_apply_snapshots: нужен массив систем';
  END IF;
  IF p_source IS NULL OR p_source NOT IN ('edsm', 'helper', 'web', 'eddn') THEN
    RAISE EXCEPTION 'bgs_apply_snapshots: неизвестный источник %', p_source;
  END IF;

  SELECT count(*) INTO v_received FROM public.bgs_parse_rows(p_rows);
  IF v_received = 0 THEN
    RETURN jsonb_build_object('received', 0, 'applied', 0, 'stale', 0, 'created', 0, 'factions_new', 0, 'systems', '[]'::jsonb);
  END IF;

  -- 1. Фракции из пачки: у известных уточняются принадлежность и
  --    правительство, новые добавляются. Флаг «фракция игроков» и id EDSM
  --    приходят только из дампа (у журнала их нет). Обновляется только то, что
  --    изменилось, а вставка не трогает уже известные имена — иначе каждый
  --    импорт сжигал бы значения последовательности id на десятки тысяч.
  WITH incoming AS (
    SELECT DISTINCT ON (lower(btrim(f.item->>'name')))
      btrim(f.item->>'name') AS name,
      lower(btrim(f.item->>'name')) AS name_lc,
      nullif(btrim(f.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(f.item->>'government'), '') AS government,
      CASE WHEN f.item->>'is_player' IN ('true', 'false') THEN (f.item->>'is_player')::boolean END AS is_player,
      CASE WHEN (f.item->>'edsm_id') ~ '^[0-9]{1,18}$' THEN (f.item->>'edsm_id')::bigint END AS edsm_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS f(item)
    WHERE jsonb_typeof(f.item) = 'object'
      AND nullif(btrim(f.item->>'name'), '') IS NOT NULL
      AND length(btrim(f.item->>'name')) <= 160
    ORDER BY lower(btrim(f.item->>'name')), (f.item->>'edsm_id') IS NULL, s.observed_at DESC NULLS LAST
  )
  UPDATE public.bgs_factions t SET
    name       = i.name,
    allegiance = COALESCE(i.allegiance, t.allegiance),
    government = COALESCE(i.government, t.government),
    is_player  = COALESCE(i.is_player, t.is_player),
    edsm_id    = COALESCE(i.edsm_id, t.edsm_id),
    updated_at = now()
  FROM incoming i
  WHERE t.name_lc = i.name_lc
    AND (
      t.name IS DISTINCT FROM i.name
      OR (i.allegiance IS NOT NULL AND t.allegiance IS DISTINCT FROM i.allegiance)
      OR (i.government IS NOT NULL AND t.government IS DISTINCT FROM i.government)
      OR (i.is_player IS NOT NULL AND t.is_player IS DISTINCT FROM i.is_player)
      OR (i.edsm_id IS NOT NULL AND t.edsm_id IS DISTINCT FROM i.edsm_id)
    );

  WITH incoming AS (
    SELECT DISTINCT ON (lower(btrim(f.item->>'name')))
      btrim(f.item->>'name') AS name,
      lower(btrim(f.item->>'name')) AS name_lc,
      nullif(btrim(f.item->>'allegiance'), '') AS allegiance,
      nullif(btrim(f.item->>'government'), '') AS government,
      CASE WHEN f.item->>'is_player' IN ('true', 'false') THEN (f.item->>'is_player')::boolean END AS is_player,
      CASE WHEN (f.item->>'edsm_id') ~ '^[0-9]{1,18}$' THEN (f.item->>'edsm_id')::bigint END AS edsm_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS f(item)
    WHERE jsonb_typeof(f.item) = 'object'
      AND nullif(btrim(f.item->>'name'), '') IS NOT NULL
      AND length(btrim(f.item->>'name')) <= 160
    ORDER BY lower(btrim(f.item->>'name')), (f.item->>'edsm_id') IS NULL, s.observed_at DESC NULLS LAST
  ),
  inserted AS (
    INSERT INTO public.bgs_factions (name, name_lc, allegiance, government, is_player, edsm_id)
    SELECT i.name, i.name_lc, i.allegiance, i.government, COALESCE(i.is_player, false), i.edsm_id
    FROM incoming i
    WHERE NOT EXISTS (SELECT 1 FROM public.bgs_factions t WHERE t.name_lc = i.name_lc)
    ON CONFLICT (name_lc) DO NOTHING
    RETURNING 1
  )
  SELECT count(*) INTO v_factions FROM inserted;

  -- 2. Какие системы применяются: новых нет в таблице, у известных
  --    наблюдение не старше сохранённого.
  SELECT
    COALESCE(array_agg(s.id64), '{}'),
    COALESCE(array_agg(s.id64) FILTER (WHERE e.id64 IS NULL), '{}'),
    COALESCE(array_agg(s.name ORDER BY s.name), '{}')
  INTO v_ids, v_new_ids, v_names
  FROM public.bgs_parse_rows(p_rows) s
  LEFT JOIN public.bgs_systems e ON e.id64 = s.id64
  WHERE e.id64 IS NULL
     OR e.observed_at IS NULL
     OR (s.observed_at IS NOT NULL AND s.observed_at >= e.observed_at);

  SELECT COALESCE(array_agg(DISTINCT controlling_faction_id), '{}') INTO v_old_ctrl
  FROM public.bgs_systems
  WHERE id64 = ANY (v_ids) AND controlling_faction_id IS NOT NULL;

  -- 3. Сами системы.
  INSERT INTO public.bgs_systems AS t (
    id64, name, name_lc, x, y, z, allegiance, government, economy, second_economy, security, state,
    population, controlling_faction_id, observed_at, source, sync_run, updated_at
  )
  SELECT
    s.id64, s.name, lower(s.name), s.x, s.y, s.z, s.allegiance, s.government, s.economy, s.second_economy,
    s.security, s.state, s.population, f.id, s.observed_at, p_source, p_run, now()
  FROM public.bgs_parse_rows(p_rows) s
  LEFT JOIN public.bgs_factions f ON f.name_lc = s.controlling_lc
  WHERE s.id64 = ANY (v_ids)
  ON CONFLICT (id64) DO UPDATE SET
    name                   = EXCLUDED.name,
    name_lc                = EXCLUDED.name_lc,
    x                      = EXCLUDED.x,
    y                      = EXCLUDED.y,
    z                      = EXCLUDED.z,
    allegiance             = EXCLUDED.allegiance,
    government             = EXCLUDED.government,
    economy                = COALESCE(EXCLUDED.economy, t.economy),
    second_economy         = COALESCE(EXCLUDED.second_economy, t.second_economy),
    security               = COALESCE(EXCLUDED.security, t.security),
    state                  = EXCLUDED.state,
    population             = COALESCE(EXCLUDED.population, t.population),
    controlling_faction_id = EXCLUDED.controlling_faction_id,
    observed_at            = EXCLUDED.observed_at,
    source                 = EXCLUDED.source,
    sync_run               = COALESCE(p_run, t.sync_run),
    updated_at             = now();

  -- Импорт дампа: система была в дампе, даже если у пилота данные свежее —
  -- в конце импорта её нельзя удалять как «пропавшую».
  IF p_run IS NOT NULL THEN
    UPDATE public.bgs_systems t
    SET sync_run = p_run
    FROM public.bgs_parse_rows(p_rows) s
    WHERE t.id64 = s.id64 AND t.sync_run IS DISTINCT FROM p_run;
  END IF;

  -- 4. Состав фракций применённых систем заменяется целиком.
  WITH incoming AS (
    SELECT DISTINCT ON (s.id64, f.id) s.id64 AS system_id64, f.id AS faction_id
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
    JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
    WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object'
  ),
  removed AS (
    DELETE FROM public.bgs_faction_presence p
    WHERE p.system_id64 = ANY (v_ids)
      AND NOT EXISTS (
        SELECT 1 FROM incoming i WHERE i.system_id64 = p.system_id64 AND i.faction_id = p.faction_id
      )
    RETURNING p.faction_id
  )
  SELECT COALESCE(array_agg(DISTINCT faction_id), '{}') INTO v_removed FROM removed;

  INSERT INTO public.bgs_faction_presence AS t (
    system_id64, faction_id, influence, state, active_states, pending_states, recovering_states, happiness, updated_at
  )
  SELECT DISTINCT ON (s.id64, f.id)
    s.id64,
    f.id,
    CASE WHEN (fe.item->>'influence') ~ '^-?[0-9]+(\.[0-9]+)?([eE][-+]?[0-9]+)?$'
      THEN greatest(0, least(1, (fe.item->>'influence')::real)) END,
    nullif(btrim(fe.item->>'state'), ''),
    CASE WHEN jsonb_typeof(fe.item->'active_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'active_states')) ELSE '{}'::text[] END,
    CASE WHEN jsonb_typeof(fe.item->'pending_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'pending_states')) ELSE '{}'::text[] END,
    CASE WHEN jsonb_typeof(fe.item->'recovering_states') = 'array'
      THEN ARRAY(SELECT jsonb_array_elements_text(fe.item->'recovering_states')) ELSE '{}'::text[] END,
    nullif(btrim(fe.item->>'happiness'), ''),
    now()
  FROM public.bgs_parse_rows(p_rows) s
  CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
  JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
  WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object'
  ORDER BY s.id64, f.id
  ON CONFLICT (system_id64, faction_id) DO UPDATE SET
    influence         = EXCLUDED.influence,
    state             = EXCLUDED.state,
    active_states     = EXCLUDED.active_states,
    pending_states    = EXCLUDED.pending_states,
    recovering_states = EXCLUDED.recovering_states,
    happiness         = EXCLUDED.happiness,
    updated_at        = now();

  UPDATE public.bgs_systems t
  SET factions_count = c.n
  FROM (
    SELECT ids.id64, COALESCE(counted.n, 0) AS n
    FROM unnest(v_ids) AS ids(id64)
    LEFT JOIN (
      SELECT p.system_id64, count(*)::integer AS n
      FROM public.bgs_faction_presence p
      WHERE p.system_id64 = ANY (v_ids)
      GROUP BY p.system_id64
    ) counted ON counted.system_id64 = ids.id64
  ) c
  WHERE t.id64 = c.id64 AND t.factions_count IS DISTINCT FROM c.n;

  -- 5. Счётчики фракций: пришедших, ушедших из систем и прежних хозяев систем.
  IF p_recount THEN
    SELECT COALESCE(array_agg(DISTINCT f.id), '{}') INTO v_touched
    FROM public.bgs_parse_rows(p_rows) s
    CROSS JOIN LATERAL jsonb_array_elements(s.factions) AS fe(item)
    JOIN public.bgs_factions f ON f.name_lc = lower(btrim(fe.item->>'name'))
    WHERE s.id64 = ANY (v_ids) AND jsonb_typeof(fe.item) = 'object';
    PERFORM public.bgs_recount_factions(v_touched || v_removed || v_old_ctrl);
  END IF;

  RETURN jsonb_build_object(
    'received', v_received,
    'applied', COALESCE(array_length(v_ids, 1), 0),
    'stale', v_received - COALESCE(array_length(v_ids, 1), 0),
    'created', COALESCE(array_length(v_new_ids, 1), 0),
    'factions_new', v_factions,
    'systems', to_jsonb(v_names[1:20])
  );
END;
$$;

-- ── Завершение импорта дампа ─────────────────────────────────────────────
-- PostgREST даёт запросу лишь несколько секунд (statement_timeout), поэтому
-- завершение — несколько коротких вызовов, которые сервер повторяет в цикле:
--   1. bgs_delete_missing      — удалить системы, которых не было в новом дампе,
--                                если пилоты не присылали их p_keep_days дней
--                                (депопуляция, скрытые EDSM системы), пачкой;
--   2. bgs_recount_factions_batch — пересчитать счётчики фракций пачкой по id;
--   3. bgs_prune_factions      — удалить фракции без систем, пачкой;
--   4. bgs_finish_sync         — записать состояние и итоговые числа.

CREATE OR REPLACE FUNCTION public.bgs_delete_missing(
  p_run UUID,
  p_keep_days INTEGER DEFAULT 30,
  p_limit INTEGER DEFAULT 2000
)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'bgs_delete_missing: нужен идентификатор импорта';
  END IF;
  -- Пустой импорт не должен стереть карту: такой дамп отсекается ещё в коде,
  -- здесь — последняя страховка.
  IF NOT EXISTS (SELECT 1 FROM public.bgs_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'bgs_delete_missing: импорт % не записал ни одной системы', p_run;
  END IF;

  WITH doomed AS (
    SELECT s.id64
    FROM public.bgs_systems s
    WHERE s.sync_run IS DISTINCT FROM p_run
      AND (
        s.source = 'edsm'
        OR s.observed_at IS NULL
        OR s.observed_at < now() - make_interval(days => greatest(1, COALESCE(p_keep_days, 30)))
      )
    LIMIT greatest(1, COALESCE(p_limit, 2000))
  )
  DELETE FROM public.bgs_systems s
  USING doomed d
  WHERE s.id64 = d.id64;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_recount_factions_batch(p_after BIGINT DEFAULT 0, p_limit INTEGER DEFAULT 5000)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_ids     BIGINT[];
  v_changed INTEGER;
BEGIN
  -- Следующие p_limit фракций по id (keyset): дыры в последовательности id не
  -- превращаются в тысячи пустых вызовов.
  SELECT array_agg(page.id ORDER BY page.id) INTO v_ids
  FROM (
    SELECT f.id FROM public.bgs_factions f
    WHERE f.id > COALESCE(p_after, 0)
    ORDER BY f.id
    LIMIT greatest(1, COALESCE(p_limit, 5000))
  ) page;
  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('rows', 0, 'changed', 0, 'last_id', NULL);
  END IF;
  v_changed := public.bgs_recount_factions(v_ids);
  RETURN jsonb_build_object('rows', array_length(v_ids, 1), 'changed', v_changed, 'last_id', v_ids[array_length(v_ids, 1)]);
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_prune_factions(p_limit INTEGER DEFAULT 5000)
RETURNS INTEGER
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  WITH doomed AS (
    SELECT f.id
    FROM public.bgs_factions f
    WHERE f.systems_count = 0
      AND f.controlled_count = 0
      AND NOT EXISTS (SELECT 1 FROM public.bgs_faction_presence p WHERE p.faction_id = f.id)
      AND NOT EXISTS (SELECT 1 FROM public.bgs_systems s WHERE s.controlling_faction_id = f.id)
    LIMIT greatest(1, COALESCE(p_limit, 5000))
  )
  DELETE FROM public.bgs_factions f
  USING doomed d
  WHERE f.id = d.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.bgs_finish_sync(p_run UUID, p_state JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_systems  INTEGER;
  v_factions INTEGER;
  v_presence INTEGER;
  v_state    JSONB := COALESCE(p_state, '{}'::jsonb);
BEGIN
  IF p_run IS NULL THEN
    RAISE EXCEPTION 'bgs_finish_sync: нужен идентификатор импорта';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.bgs_systems WHERE sync_run = p_run) THEN
    RAISE EXCEPTION 'bgs_finish_sync: импорт % не записал ни одной системы', p_run;
  END IF;

  SELECT count(*) INTO v_systems FROM public.bgs_systems;
  SELECT count(*) INTO v_factions FROM public.bgs_factions;
  SELECT count(*) INTO v_presence FROM public.bgs_faction_presence;

  INSERT INTO public.bgs_sync_state AS st (id, status, run_id, systems_total, factions_total, presence_total,
                                           synced_at, checked_at, error, updated_at)
  VALUES (1, 'ok', p_run, v_systems, v_factions, v_presence, now(), now(), NULL, now())
  ON CONFLICT (id) DO UPDATE SET
    status = 'ok', run_id = p_run, systems_total = v_systems, factions_total = v_factions,
    presence_total = v_presence, synced_at = now(), checked_at = now(), error = NULL, updated_at = now();

  UPDATE public.bgs_sync_state SET
    source_url        = COALESCE(v_state->>'source_url', source_url),
    etag              = v_state->>'etag',
    last_modified     = v_state->>'last_modified',
    dump_generated_at = (v_state->>'dump_generated_at')::timestamptz,
    dump_bytes        = (v_state->>'dump_bytes')::bigint,
    stats             = COALESCE(v_state->'stats', '{}'::jsonb)
  WHERE id = 1;

  RETURN jsonb_build_object('systems', v_systems, 'factions', v_factions, 'presence', v_presence);
END;
$$;

-- ── Слой карты одной выборкой ─────────────────────────────────────────────
-- PostgREST режет обычные выборки по max_rows; десятки тысяч систем приходят
-- одним JSON. Порядок — по имени: панель Atlas не сортирует их в браузере.

CREATE OR REPLACE FUNCTION public.bgs_layer_rows()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_array(
        s.id64::text, s.name, s.x, s.y, s.z, s.allegiance, s.government,
        s.controlling_faction_id, f.name, s.population, s.factions_count,
        floor(extract(epoch FROM s.observed_at))::bigint, s.source
      )
      ORDER BY s.name_lc, s.id64
    ),
    '[]'::json
  )
  FROM public.bgs_systems s
  LEFT JOIN public.bgs_factions f ON f.id = s.controlling_faction_id;
$$;

-- ── Поиск фракций по имени ────────────────────────────────────────────────
-- Сначала точное совпадение, затем начало имени, затем вхождение; внутри —
-- по числу систем. Пустой запрос — самые распространённые фракции.

CREATE OR REPLACE FUNCTION public.bgs_search_factions(
  p_query TEXT,
  p_limit INTEGER DEFAULT 20,
  p_player BOOLEAN DEFAULT false
)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH q AS (
    SELECT
      lower(btrim(COALESCE(p_query, ''))) AS q,
      replace(replace(replace(lower(btrim(COALESCE(p_query, ''))), '\', '\\'), '%', '\%'), '_', '\_') AS pattern
  )
  SELECT COALESCE(json_agg(row_to_json(r)), '[]'::json)
  FROM (
    SELECT
      f.id, f.name, f.allegiance, f.government, f.is_player,
      f.systems_count AS systems, f.controlled_count AS controlled
    FROM public.bgs_factions f, q
    WHERE (q.q = '' OR f.name_lc LIKE '%' || q.pattern || '%')
      AND (NOT COALESCE(p_player, false) OR f.is_player)
      AND f.systems_count > 0
    ORDER BY
      (q.q <> '' AND f.name_lc = q.q) DESC,
      (q.q <> '' AND f.name_lc LIKE q.pattern || '%') DESC,
      f.systems_count DESC,
      f.name_lc
    LIMIT greatest(1, least(COALESCE(p_limit, 20), 50))
  ) r;
$$;

-- ── Присутствие выбранных фракций ─────────────────────────────────────────
-- Кортеж системы: [id64, имя, x, y, z, влияние, состояние, контролирует,
-- наблюдение (unix-секунды), активные, ожидающие, затухающие, настроение,
-- население, принадлежность системы].

CREATE OR REPLACE FUNCTION public.bgs_faction_presence_rows(p_ids BIGINT[])
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT COALESCE(
    json_agg(
      json_build_object(
        'id', f.id,
        'name', f.name,
        'allegiance', f.allegiance,
        'government', f.government,
        'is_player', f.is_player,
        'systems_count', f.systems_count,
        'controlled_count', f.controlled_count,
        'systems', COALESCE((
          SELECT json_agg(
            json_build_array(
              s.id64::text, s.name, s.x, s.y, s.z, p.influence, p.state,
              s.controlling_faction_id IS NOT DISTINCT FROM f.id,
              floor(extract(epoch FROM s.observed_at))::bigint,
              p.active_states, p.pending_states, p.recovering_states, p.happiness,
              s.population, s.allegiance
            )
            ORDER BY p.influence DESC NULLS LAST, s.name_lc
          )
          FROM public.bgs_faction_presence p
          JOIN public.bgs_systems s ON s.id64 = p.system_id64
          WHERE p.faction_id = f.id
        ), '[]'::json)
      )
      ORDER BY array_position(p_ids, f.id)
    ),
    '[]'::json
  )
  FROM public.bgs_factions f
  WHERE f.id = ANY (COALESCE(p_ids, '{}'::bigint[]));
$$;

-- ── Карточка системы ──────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_system_detail(p_id64 BIGINT)
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'system', (
      SELECT row_to_json(sys)
      FROM (
        SELECT
          s.id64::text AS id64, s.name, s.x, s.y, s.z, s.allegiance, s.government, s.economy,
          s.second_economy, s.security, s.state, s.population, s.controlling_faction_id,
          f.name AS controlling_faction, s.factions_count, s.observed_at, s.source, s.updated_at
        FROM public.bgs_systems s
        LEFT JOIN public.bgs_factions f ON f.id = s.controlling_faction_id
        WHERE s.id64 = p_id64
      ) sys
    ),
    'factions', COALESCE((
      SELECT json_agg(
        json_build_object(
          'id', f.id, 'name', f.name, 'allegiance', f.allegiance, 'government', f.government,
          'is_player', f.is_player, 'influence', p.influence, 'state', p.state,
          'active_states', p.active_states, 'pending_states', p.pending_states,
          'recovering_states', p.recovering_states, 'happiness', p.happiness,
          'systems_count', f.systems_count, 'controlled_count', f.controlled_count
        )
        ORDER BY p.influence DESC NULLS LAST, f.name_lc
      )
      FROM public.bgs_faction_presence p
      JOIN public.bgs_factions f ON f.id = p.faction_id
      WHERE p.system_id64 = p_id64
    ), '[]'::json)
  );
$$;

-- ── Сводка для админки ────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.bgs_admin_summary()
RETURNS JSON
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT json_build_object(
    'systems', (SELECT count(*) FROM public.bgs_systems),
    'factions', (SELECT count(*) FROM public.bgs_factions),
    'player_factions', (SELECT count(*) FROM public.bgs_factions WHERE is_player),
    'presence', (SELECT count(*) FROM public.bgs_faction_presence),
    'allegiances', COALESCE((
      SELECT json_object_agg(a.allegiance, a.n)
      FROM (
        SELECT COALESCE(allegiance, 'None') AS allegiance, count(*) AS n
        FROM public.bgs_systems GROUP BY 1
      ) a
    ), '{}'::json),
    'sources', COALESCE((
      SELECT json_object_agg(src.source, src.n)
      FROM (SELECT source, count(*) AS n FROM public.bgs_systems GROUP BY 1) src
    ), '{}'::json),
    'oldest_observation', (SELECT min(observed_at) FROM public.bgs_systems),
    'newest_observation', (SELECT max(observed_at) FROM public.bgs_systems),
    'fresh_7d', (SELECT count(*) FROM public.bgs_systems WHERE observed_at > now() - interval '7 days'),
    'updates_24h', (SELECT count(*) FROM public.bgs_updates WHERE received_at > now() - interval '24 hours'),
    'applied_24h', (SELECT COALESCE(sum(applied), 0) FROM public.bgs_updates WHERE received_at > now() - interval '24 hours'),
    'updates_7d', (SELECT count(*) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'applied_7d', (SELECT COALESCE(sum(applied), 0) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'reporters_7d', (SELECT count(DISTINCT user_id) FROM public.bgs_updates WHERE received_at > now() - interval '7 days'),
    'last_update', (SELECT max(received_at) FROM public.bgs_updates)
  );
$$;

-- Импорт, выборки слоя и сводка — только сервером (service_role); клиенты идут через API.
REVOKE ALL ON FUNCTION
  public.bgs_parse_rows(JSONB),
  public.bgs_recount_factions(BIGINT[]),
  public.bgs_apply_snapshots(JSONB, TEXT, UUID, BOOLEAN),
  public.bgs_delete_missing(UUID, INTEGER, INTEGER),
  public.bgs_recount_factions_batch(BIGINT, INTEGER),
  public.bgs_prune_factions(INTEGER),
  public.bgs_finish_sync(UUID, JSONB),
  public.bgs_layer_rows(),
  public.bgs_search_factions(TEXT, INTEGER, BOOLEAN),
  public.bgs_faction_presence_rows(BIGINT[]),
  public.bgs_system_detail(BIGINT),
  public.bgs_admin_summary()
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.bgs_parse_rows(JSONB),
  public.bgs_recount_factions(BIGINT[]),
  public.bgs_apply_snapshots(JSONB, TEXT, UUID, BOOLEAN),
  public.bgs_delete_missing(UUID, INTEGER, INTEGER),
  public.bgs_recount_factions_batch(BIGINT, INTEGER),
  public.bgs_prune_factions(INTEGER),
  public.bgs_finish_sync(UUID, JSONB),
  public.bgs_layer_rows(),
  public.bgs_search_factions(TEXT, INTEGER, BOOLEAN),
  public.bgs_faction_presence_rows(BIGINT[]),
  public.bgs_system_detail(BIGINT),
  public.bgs_admin_summary()
  TO service_role;

NOTIFY pgrst, 'reload schema';
