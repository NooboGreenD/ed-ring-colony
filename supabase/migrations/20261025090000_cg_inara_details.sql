-- Retain the source link and source-side timestamp returned by Inara.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS inara_url TEXT,
  ADD COLUMN IF NOT EXISTS source_updated_at TIMESTAMPTZ;
