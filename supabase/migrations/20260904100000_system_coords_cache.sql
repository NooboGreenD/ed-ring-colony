-- ════════════════════════════════════════════════════════════════
-- Migration 026: System Coordinates Cache + Map Pilots Support
--
-- ⚠ Файл восстановлен 2026-09-25. Прежняя версия лежала одной строкой без
--   переводов строк: первый комментарий съедал весь остаток файла, поэтому
--   миграция не создавала ни таблицы, ни индексов (psql считает пустой
--   скрипт успешным — поломка была незаметна).
-- ════════════════════════════════════════════════════════════════

-- ─── system_coords: кэш координат систем для карты и пилотов ───
CREATE TABLE IF NOT EXISTS public.system_coords (
  id          SERIAL PRIMARY KEY,
  system_name TEXT NOT NULL UNIQUE,
  x           NUMERIC(10,4),
  y           NUMERIC(10,4),
  z           NUMERIC(10,4),
  source      TEXT DEFAULT 'edsm',
  updated_at  TIMESTAMPTZ DEFAULT NOW(),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.system_coords ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename  = 'system_coords'
       AND policyname = 'system_coords_public'
  ) THEN
    CREATE POLICY system_coords_public ON public.system_coords
      FOR SELECT USING (true);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_system_coords_name ON public.system_coords(system_name);

-- ─── Индексы для быстрого поиска пилотов на карте ───
-- capi_profiles создаётся в 20260904000000_capi_journal_base.sql — раньше
-- по порядку версий, поэтому здесь таблица уже есть.
CREATE INDEX IF NOT EXISTS idx_capi_profiles_current_system ON public.capi_profiles(current_system);
CREATE INDEX IF NOT EXISTS idx_capi_profiles_last_updated ON public.capi_profiles(last_updated DESC);
