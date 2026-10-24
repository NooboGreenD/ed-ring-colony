-- Community Goals can be discovered from authenticated Frontier CAPI sessions
-- and Elite journal uploads when the Inara API is unavailable. Journal-only
-- rows wait for moderator approval; the official CAPI/Inara sources are public.
ALTER TABLE public.community_goals
  DROP CONSTRAINT IF EXISTS community_goals_source_check,
  DROP CONSTRAINT IF EXISTS community_goals_moderation_status_check;

ALTER TABLE public.community_goals
  ADD CONSTRAINT community_goals_source_check
    CHECK (source IN ('inara', 'capi', 'journal', 'manual')),
  ADD CONSTRAINT community_goals_moderation_status_check
    CHECK (moderation_status IN ('pending', 'approved', 'hidden', 'rejected'));

CREATE INDEX IF NOT EXISTS idx_community_goals_pending_source
  ON public.community_goals (source, source_updated_at DESC)
  WHERE moderation_status = 'pending';

NOTIFY pgrst, 'reload schema';
