CREATE TABLE IF NOT EXISTS public.community_goal_progress_history (
  cg_id               INTEGER NOT NULL REFERENCES public.community_goals(cg_id) ON DELETE CASCADE,
  snapshot_hour       TIMESTAMPTZ NOT NULL,
  observed_at         TIMESTAMPTZ NOT NULL,
  source              TEXT NOT NULL CHECK (source IN ('inara', 'capi')),
  tier_current        INTEGER,
  tier_max            INTEGER,
  contributors        INTEGER,
  contributions_total BIGINT NOT NULL CHECK (contributions_total >= 0),
  PRIMARY KEY (cg_id, snapshot_hour)
);

INSERT INTO public.community_goal_progress_history (
  cg_id, snapshot_hour, observed_at, source,
  tier_current, tier_max, contributors, contributions_total
)
SELECT
  cg_id,
  date_trunc('hour', COALESCE(progress_updated_at, source_updated_at, updated_at)),
  COALESCE(progress_updated_at, source_updated_at, updated_at),
  progress_source,
  tier_current,
  tier_max,
  contributors,
  contributions_total
FROM public.community_goals
WHERE progress_source IN ('inara', 'capi')
  AND contributions_total IS NOT NULL
  AND contributions_total >= 0
ON CONFLICT (cg_id, snapshot_hour) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_community_goal_progress_history_time
  ON public.community_goal_progress_history (snapshot_hour, cg_id);

ALTER TABLE public.community_goal_progress_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_goal_progress_history FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.community_goal_progress_history TO service_role;

NOTIFY pgrst, 'reload schema';
