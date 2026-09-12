-- Cache of EDSM systems discovered while building the galactic ring route.
CREATE TABLE IF NOT EXISTS public.atlas_ring_system_cache (
  system_name text PRIMARY KEY,
  x double precision NOT NULL,
  y double precision NOT NULL,
  z double precision NOT NULL,
  source text NOT NULL DEFAULT 'edsm',
  raw_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_atlas_ring_cache_coordinates
  ON public.atlas_ring_system_cache (x, y, z);

ALTER TABLE public.atlas_ring_system_cache ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS atlas_ring_cache_select ON public.atlas_ring_system_cache;
CREATE POLICY atlas_ring_cache_select ON public.atlas_ring_system_cache
  FOR SELECT TO anon, authenticated USING (true);
GRANT SELECT ON public.atlas_ring_system_cache TO anon, authenticated;
