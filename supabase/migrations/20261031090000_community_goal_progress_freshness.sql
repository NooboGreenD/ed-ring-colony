ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS progress_source TEXT,
  ADD COLUMN IF NOT EXISTS progress_updated_at TIMESTAMPTZ;

ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_progress_source_check;

ALTER TABLE public.community_goals
  ADD CONSTRAINT community_goals_progress_source_check
    CHECK (progress_source IS NULL OR progress_source IN ('inara', 'capi', 'journal', 'manual'));

UPDATE public.community_goals
SET progress_source = source,
    progress_updated_at = COALESCE(source_updated_at, updated_at)
WHERE progress_source IS NULL
  AND (tier_current IS NOT NULL OR tier_max IS NOT NULL OR contributors IS NOT NULL OR contributions_total IS NOT NULL);

NOTIFY pgrst, 'reload schema';
