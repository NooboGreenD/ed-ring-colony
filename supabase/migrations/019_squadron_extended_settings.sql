-- ============================================================
-- 019_squadron_extended_settings.sql — Расширенные настройки эскадрильи
-- ============================================================

ALTER TABLE public.squadrons
  ADD COLUMN IF NOT EXISTS name_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discord_url TEXT,
  ADD COLUMN IF NOT EXISTS website_url TEXT,
  ADD COLUMN IF NOT EXISTS recruitment_message TEXT,
  ADD COLUMN IF NOT EXISTS activity_type TEXT DEFAULT 'Mixed',
  ADD COLUMN IF NOT EXISTS is_open_recruitment BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS home_system TEXT;

-- Обновляем squadron_summary view
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
  s.discord_url,
  s.website_url,
  s.recruitment_message,
  s.activity_type,
  s.is_open_recruitment,
  s.home_system,
  s.created_by,
  s.created_at,
  COUNT(DISTINCT sm.id)::INTEGER AS member_count,
  COUNT(DISTINCT p.id)::INTEGER AS project_count
FROM public.squadrons s
LEFT JOIN public.squadron_members sm ON sm.squadron_id = s.id
LEFT JOIN public.projects p ON p.squadron_id = s.id
GROUP BY s.id;

GRANT SELECT ON public.squadron_summary TO anon, authenticated;
