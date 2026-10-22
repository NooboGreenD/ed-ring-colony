-- Admin lifecycle controls for the Community Goals catalog.
-- Source data remains intact: moderator edits to Inara records live as JSON
-- overrides, so the scheduled sync cannot erase them.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inara'
    CHECK (source IN ('inara', 'manual')),
  ADD COLUMN IF NOT EXISTS moderation_status TEXT NOT NULL DEFAULT 'approved'
    CHECK (moderation_status IN ('approved', 'hidden', 'rejected')),
  ADD COLUMN IF NOT EXISTS manual_overrides JSONB NOT NULL DEFAULT '{}'::JSONB
    CHECK (jsonb_typeof(manual_overrides) = 'object'),
  ADD COLUMN IF NOT EXISTS admin_note TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_community_goals_moderation_expiry
  ON public.community_goals (moderation_status, is_complete, expiry_date);

DROP POLICY IF EXISTS community_goals_public ON public.community_goals;
CREATE POLICY community_goals_public ON public.community_goals
  FOR SELECT USING (moderation_status = 'approved');

-- The catalog is displayed through the filtered server API. Do not expose
-- moderator notes, overrides, or account IDs via direct PostgREST table reads.
REVOKE SELECT ON public.community_goals FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, cg_id, title, description, system_name, station_name, objective, reward,
  tier_current, tier_max, contributors, contributions_total, expiry_date,
  is_complete, is_colonisation_related, inara_url, source_updated_at,
  updated_at, created_at
) ON public.community_goals TO anon, authenticated;
GRANT ALL ON public.community_goals TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.community_goals_id_seq TO service_role;
