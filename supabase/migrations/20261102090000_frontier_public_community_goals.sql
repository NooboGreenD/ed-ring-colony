ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_source_check,
  ADD CONSTRAINT community_goals_source_check
    CHECK (source IN ('inara', 'capi', 'journal', 'frontier', 'manual')),
  ADD COLUMN IF NOT EXISTS contributions_target BIGINT,
  ADD COLUMN IF NOT EXISTS target_source TEXT,
  ADD COLUMN IF NOT EXISTS target_updated_at TIMESTAMPTZ;

ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_progress_source_check,
  ADD CONSTRAINT community_goals_progress_source_check
    CHECK (progress_source IS NULL OR progress_source IN ('inara', 'capi', 'journal', 'frontier', 'manual')),
  DROP CONSTRAINT IF EXISTS community_goals_target_source_check,
  ADD CONSTRAINT community_goals_target_source_check
    CHECK (target_source IS NULL OR target_source = 'frontier'),
  DROP CONSTRAINT IF EXISTS community_goals_contributions_target_check,
  ADD CONSTRAINT community_goals_contributions_target_check
    CHECK (contributions_target IS NULL OR contributions_target >= 0);

ALTER TABLE public.community_goal_progress_history
  DROP CONSTRAINT IF EXISTS community_goal_progress_history_source_check,
  ADD CONSTRAINT community_goal_progress_history_source_check
    CHECK (source IN ('inara', 'capi', 'frontier'));

GRANT SELECT (
  contributions_target
) ON public.community_goals TO anon, authenticated;

NOTIFY pgrst, 'reload schema';
