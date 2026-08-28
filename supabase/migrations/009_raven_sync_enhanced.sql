-- ============================================================
-- 009_raven_sync_enhanced.sql
-- Улучшение таблицы логов синхронизации RavenColonial
-- ============================================================

-- Добавляем недостающие поля для полного логирования
ALTER TABLE public.raven_sync_log
ADD COLUMN IF NOT EXISTS system_progress INTEGER,
ADD COLUMN IF NOT EXISTS system_status TEXT,
ADD COLUMN IF NOT EXISTS site_name TEXT,
ADD COLUMN IF NOT EXISTS architect_name TEXT,
ADD COLUMN IF NOT EXISTS projects JSONB DEFAULT '[]',
ADD COLUMN IF NOT EXISTS full_data JSONB DEFAULT '{}',
ADD COLUMN IF NOT EXISTS error_message TEXT,
ADD COLUMN IF NOT EXISTS sync_type TEXT DEFAULT 'batch' CHECK (sync_type IN ('batch','single','progress'));

-- Индекс для быстрого поиска по статусу
CREATE INDEX IF NOT EXISTS idx_raven_sync_status ON public.raven_sync_log(system_status);

-- Представление для последней синхронизации каждой системы
CREATE OR REPLACE VIEW public.latest_raven_sync AS
SELECT DISTINCT ON (system_name)
  id,
  system_name,
  build_id,
  build_name,
  architect_name,
  progress,
  system_progress,
  system_status,
  site_name,
  resources,
  projects,
  error_message,
  synced_at,
  sync_type
FROM public.raven_sync_log
ORDER BY system_name, synced_at DESC;

-- Функция для получения сводки по системам маршрута
CREATE OR REPLACE FUNCTION public.get_route_raven_summary()
RETURNS TABLE (
  system_name TEXT,
  last_synced TIMESTAMPTZ,
  progress INTEGER,
  status TEXT,
  site_name TEXT,
  architect_name TEXT,
  project_count BIGINT,
  total_resources_required BIGINT,
  total_resources_provided BIGINT,
  last_error TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    l.system_name,
    MAX(l.synced_at) as last_synced,
    MAX(l.system_progress) as progress,
    MAX(l.system_status) as status,
    MAX(l.site_name) as site_name,
    MAX(l.architect_name) as architect_name,
    COALESCE(SUM(jsonb_array_length(l.projects)), 0)::BIGINT as project_count,
    COALESCE(SUM((r.elem->>'required')::BIGINT), 0)::BIGINT as total_resources_required,
    COALESCE(SUM((r.elem->>'provided')::BIGINT), 0)::BIGINT as total_resources_provided,
    MAX(l.error_message) as last_error
  FROM public.raven_sync_log l
  LEFT JOIN LATERAL jsonb_array_elements(l.projects) as p ON true
  LEFT JOIN LATERAL jsonb_array_elements(
    COALESCE(l.full_data->'resources', l.resources)
  ) as r(elem) ON true
  GROUP BY l.system_name;
END;
$$ LANGUAGE plpgsql STABLE;
