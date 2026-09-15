-- ═══════════════════════════════════════════════════════════════
-- Migration 036: System Scans Cache & Pilot Dossier Exploration Stats
-- ═══════════════════════════════════════════════════════════════

-- ─── 1. system_scans: Кэш сканирования систем и тел (журнал, EDSM, хелпер) ───
CREATE TABLE IF NOT EXISTS public.system_scans (
  id BIGSERIAL PRIMARY KEY,
  system_name TEXT NOT NULL,
  body_name TEXT NOT NULL,
  body_id INTEGER,
  body_type TEXT,
  sub_type TEXT,
  distance_ls DOUBLE PRECISION DEFAULT 0,
  parents JSONB DEFAULT '[]'::jsonb,
  radius_m DOUBLE PRECISION DEFAULT 0,
  gravity DOUBLE PRECISION DEFAULT 0,
  earth_masses DOUBLE PRECISION DEFAULT 0,
  surface_temp_k DOUBLE PRECISION DEFAULT 0,
  surface_pressure DOUBLE PRECISION DEFAULT 0,
  volcanism TEXT,
  atmosphere TEXT,
  atmosphere_type TEXT,
  atmosphere_composition JSONB DEFAULT '[]'::jsonb,
  solid_composition JSONB DEFAULT '[]'::jsonb,
  materials JSONB DEFAULT '[]'::jsonb,
  rings JSONB DEFAULT '[]'::jsonb,
  is_landable BOOLEAN DEFAULT false,
  bio_signals_count INTEGER DEFAULT 0,
  bio_genuses JSONB DEFAULT '[]'::jsonb,
  first_discovered_by TEXT,
  first_mapped_by TEXT,
  first_footfall_by TEXT,
  scanned_by_cmdr TEXT,
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  source TEXT DEFAULT 'journal',
  raw_data JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  CONSTRAINT system_scans_system_body_uniq UNIQUE (system_name, body_name)
);

CREATE INDEX IF NOT EXISTS idx_system_scans_system_name ON public.system_scans (system_name);
CREATE INDEX IF NOT EXISTS idx_system_scans_scanned_by_cmdr ON public.system_scans (scanned_by_cmdr);
CREATE INDEX IF NOT EXISTS idx_system_scans_updated_at ON public.system_scans (updated_at);

ALTER TABLE public.system_scans ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS system_scans_select ON public.system_scans;
CREATE POLICY system_scans_select ON public.system_scans
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS system_scans_insert ON public.system_scans;
CREATE POLICY system_scans_insert ON public.system_scans
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS system_scans_update ON public.system_scans;
CREATE POLICY system_scans_update ON public.system_scans
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.system_scans TO anon, authenticated;

-- ─── 2. Расширение capi_profiles: Балансы, ARX, Монеты наемников и Статистика находок ───
ALTER TABLE public.capi_profiles
  ADD COLUMN IF NOT EXISTS arx BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mercenary_coins BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mercenary_rank INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exobiologist_rank INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_discoveries_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_mapped_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS first_footfalls_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_samples_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_species_count INTEGER DEFAULT 0,
  ADD COLUMN IF NOT EXISTS bio_value_cr BIGINT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS exploration_stats JSONB DEFAULT '{}'::jsonb;

-- ─── 3. pilot_stats: Автономная таблица статистики пилота для Colonial Helper ───
CREATE TABLE IF NOT EXISTS public.pilot_stats (
  id SERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name TEXT,
  credits BIGINT DEFAULT 0,
  arx BIGINT DEFAULT 0,
  mercenary_coins BIGINT DEFAULT 0,
  mercenary_rank INTEGER DEFAULT 0,
  exobiologist_rank INTEGER DEFAULT 0,
  first_discoveries_count INTEGER DEFAULT 0,
  first_mapped_count INTEGER DEFAULT 0,
  first_footfalls_count INTEGER DEFAULT 0,
  bio_samples_count INTEGER DEFAULT 0,
  bio_species_count INTEGER DEFAULT 0,
  bio_value_cr BIGINT DEFAULT 0,
  exploration_stats JSONB DEFAULT '{}'::jsonb,
  last_updated TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id)
);

CREATE INDEX IF NOT EXISTS idx_pilot_stats_cmdr ON public.pilot_stats (cmdr_name);

ALTER TABLE public.pilot_stats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS pilot_stats_select ON public.pilot_stats;
CREATE POLICY pilot_stats_select ON public.pilot_stats
  FOR SELECT TO anon, authenticated USING (true);

DROP POLICY IF EXISTS pilot_stats_upsert ON public.pilot_stats;
CREATE POLICY pilot_stats_upsert ON public.pilot_stats
  FOR ALL TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);

GRANT SELECT, INSERT, UPDATE ON public.pilot_stats TO anon, authenticated;
