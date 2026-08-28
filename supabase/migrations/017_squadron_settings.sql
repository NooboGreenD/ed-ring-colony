-- ============================================================
-- 017_squadron_settings.sql — Настройки эскадрильи
-- ============================================================

ALTER TABLE public.squadrons
  ADD COLUMN IF NOT EXISTS allegiance TEXT DEFAULT 'Independent',
  ADD COLUMN IF NOT EXISTS power TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT DEFAULT 'Russian',
  ADD COLUMN IF NOT EXISTS timezone TEXT DEFAULT 'Moscow',
  ADD COLUMN IF NOT EXISTS member_limit INTEGER DEFAULT 50;

-- Обновляем squadron_summary view: DROP + CREATE (REPLACE не работает при смене колонок)
DROP VIEW IF EXISTS public.squadron_summary;

CREATE VIEW public.squadron_summary AS
SELECT
  s.id,
  s.name,
  s.tag,
  s.description,
  s.color,
  s.icon,
  s.status,
  s.allegiance,
  s.power,
  s.language,
  s.timezone,
  s.member_limit,
  s.created_by,
  s.created_at,
  COUNT(DISTINCT sm.id)::INTEGER AS member_count,
  COUNT(DISTINCT p.id)::INTEGER AS project_count
FROM public.squadrons s
LEFT JOIN public.squadron_members sm ON sm.squadron_id = s.id
LEFT JOIN public.projects p ON p.squadron_id = s.id
GROUP BY s.id;

GRANT SELECT ON public.squadron_summary TO anon, authenticated;
