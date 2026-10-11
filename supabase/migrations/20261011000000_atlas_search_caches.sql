-- Кэши и сессии поисковиков Atlas.
--
-- Зачем: каждый поиск (миры, маршрут A→B, галактическое кольцо) заново
-- выкачивал одни и те же данные из EDSM/Spansh. Из-за этого кольцо упиралось
-- в таймаут соединения («network error» после 3–4 сегментов), а повторные
-- поиски в том же районе не ускорялись.
--
-- Теперь всё полезное, что нашёл поисковик, складывается в БД проекта:
--   • atlas_system_cache — координаты систем (каталог Spansh / EDSM / Spansh API);
--   • atlas_body_cache   — тела с их параметрами (планеты, звёзды);
--   • atlas_ring_sessions — пошаговые сессии построения галактического кольца,
--     которые можно продолжить после обрыва связи или перезагрузки страницы.

-- ════════════════════════════════════════════════════════════════════
-- Общий кэш систем
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_system_cache (
  system_name   TEXT PRIMARY KEY,
  -- Нормализованное имя для поиска без учёта регистра и кратных пробелов.
  name_lc       TEXT NOT NULL,
  x             DOUBLE PRECISION NOT NULL,
  y             DOUBLE PRECISION NOT NULL,
  z             DOUBLE PRECISION NOT NULL,
  id64          TEXT,
  -- Откуда координаты: catalog (ночной дамп Spansh), edsm, spansh, manual.
  source        TEXT NOT NULL DEFAULT 'edsm',
  raw_data      JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_coords
  ON public.atlas_system_cache (x, y, z);
CREATE INDEX IF NOT EXISTS idx_atlas_system_cache_name_lc
  ON public.atlas_system_cache (name_lc);

ALTER TABLE public.atlas_system_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_system_cache_select ON public.atlas_system_cache;
CREATE POLICY atlas_system_cache_select ON public.atlas_system_cache
  FOR SELECT TO anon, authenticated USING (true);
-- Пишет только сервер (service_role): клиенты не должны засорять кэш.
GRANT SELECT ON public.atlas_system_cache TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_system_cache TO service_role;

COMMENT ON TABLE public.atlas_system_cache IS
  'Кэш координат систем, найденных поисковиками Atlas. Повторный поиск в том же районе идёт без внешних запросов.';

-- ════════════════════════════════════════════════════════════════════
-- Кэш тел (планет и звёзд)
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_body_cache (
  body_name            TEXT PRIMARY KEY,
  system_name          TEXT NOT NULL,
  system_lc            TEXT NOT NULL,
  x                    DOUBLE PRECISION NOT NULL,
  y                    DOUBLE PRECISION NOT NULL,
  z                    DOUBLE PRECISION NOT NULL,
  -- Категория Atlas: earth_like, water_world, neutron_star, terraformable …
  world_type           TEXT NOT NULL,
  body_type            TEXT,
  subtype              TEXT,
  distance_from_ref    DOUBLE PRECISION,
  distance_to_arrival  DOUBLE PRECISION,
  estimated_value      DOUBLE PRECISION,
  is_terraformable     BOOLEAN,
  is_main_star         BOOLEAN,
  has_atmosphere       BOOLEAN,
  gravity              DOUBLE PRECISION,
  temperature          DOUBLE PRECISION,
  atmosphere           TEXT,
  metadata             JSONB NOT NULL DEFAULT '{}'::jsonb,
  source               TEXT NOT NULL DEFAULT 'spansh',
  first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_coords
  ON public.atlas_body_cache (x, y, z);
CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_type
  ON public.atlas_body_cache (world_type);
CREATE INDEX IF NOT EXISTS idx_atlas_body_cache_system_lc
  ON public.atlas_body_cache (system_lc);

ALTER TABLE public.atlas_body_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_body_cache_select ON public.atlas_body_cache;
CREATE POLICY atlas_body_cache_select ON public.atlas_body_cache
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.atlas_body_cache TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_body_cache TO service_role;

COMMENT ON TABLE public.atlas_body_cache IS
  'Кэш тел (планет, звёзд) из Spansh/EDSM для поиска миров Atlas. Позволяет повторять поиск без внешних запросов.';

-- ════════════════════════════════════════════════════════════════════
-- Сессии построения галактического кольца
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.atlas_ring_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_by    UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  start_system  TEXT NOT NULL,
  ring_radius   DOUBLE PRECISION NOT NULL,
  search_radius DOUBLE PRECISION NOT NULL,
  -- Сколько сегментов кольца и сколько уже пройдено (шаг за шагом).
  sectors       INTEGER NOT NULL,
  sectors_done  INTEGER NOT NULL DEFAULT 0,
  center        JSONB NOT NULL,
  basis         JSONB NOT NULL,
  anchors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  discovered    INTEGER NOT NULL DEFAULT 0,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  route         JSONB,
  -- scanning → ready (все сегменты) → completed (маршрут собран) | failed
  status        TEXT NOT NULL DEFAULT 'scanning',
  error_message TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_atlas_ring_sessions_created
  ON public.atlas_ring_sessions (created_at DESC);

ALTER TABLE public.atlas_ring_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_ring_sessions_select ON public.atlas_ring_sessions;
CREATE POLICY atlas_ring_sessions_select ON public.atlas_ring_sessions
  FOR SELECT TO authenticated USING (true);
GRANT SELECT ON public.atlas_ring_sessions TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.atlas_ring_sessions TO service_role;

COMMENT ON TABLE public.atlas_ring_sessions IS
  'Пошаговые сессии построения галактического кольца: прогресс сохраняется, поиск продолжается после обрыва связи.';

-- ════════════════════════════════════════════════════════════════════
-- Живой прогресс поиска миров
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE public.atlas_searches
  ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN public.atlas_searches.progress IS
  'Текущий этап поиска: percent/stage/message и последние найденные точки для карты (обновляет сервер).';
