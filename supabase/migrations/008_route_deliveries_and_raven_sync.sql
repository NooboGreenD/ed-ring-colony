-- ============================================================
-- 008_route_deliveries_and_raven_sync.sql
-- 1. Доставки во все системы маршрута (не только хабы)
-- 2. Связь доставок с route_systems
-- 3. Поля для интеграции RavenColonial
-- ============================================================

ALTER TABLE public.deliveries
ADD COLUMN IF NOT EXISTS route_system_id INTEGER REFERENCES public.route_systems(id) ON DELETE SET NULL;

ALTER TABLE public.deliveries
ADD COLUMN IF NOT EXISTS is_hub BOOLEAN NOT NULL DEFAULT FALSE;

UPDATE public.deliveries d
SET is_hub = TRUE
FROM public.hubs h
WHERE LOWER(d.system_name) = LOWER(h.system_name);

CREATE INDEX IF NOT EXISTS idx_deliveries_route_system ON public.deliveries(route_system_id);
CREATE INDEX IF NOT EXISTS idx_deliveries_is_hub ON public.deliveries(is_hub);

CREATE TABLE IF NOT EXISTS public.raven_sync_log (
  id SERIAL PRIMARY KEY,
  system_name TEXT NOT NULL,
  build_id TEXT,
  build_name TEXT,
  architect_name TEXT,
  progress INTEGER,
  resources JSONB DEFAULT '[]',
  synced_at TIMESTAMPTZ DEFAULT NOW(),
  source TEXT DEFAULT 'ravencolonial_api'
);

CREATE INDEX IF NOT EXISTS idx_raven_sync_system ON public.raven_sync_log(system_name);
CREATE INDEX IF NOT EXISTS idx_raven_sync_time ON public.raven_sync_log(synced_at DESC);

CREATE OR REPLACE FUNCTION public.get_route_delivery_stats()
RETURNS TABLE (
  system_name TEXT,
  total_delivered BIGINT,
  unique_cmdrs BIGINT,
  top_commodity TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    d.system_name,
    COALESCE(SUM(d.amount), 0)::BIGINT as total_delivered,
    COUNT(DISTINCT d.user_id)::BIGINT as unique_cmdrs,
    MODE() WITHIN GROUP (ORDER BY d.commodity) as top_commodity
  FROM public.deliveries d
  WHERE d.route_system_id IS NOT NULL OR d.is_hub = TRUE
  GROUP BY d.system_name
  ORDER BY total_delivered DESC;
END;
$$ LANGUAGE plpgsql STABLE;
