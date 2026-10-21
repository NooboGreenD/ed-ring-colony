-- Private, per-account snapshots reported by Colonial Helper/CAPI.
-- Public CG totals remain sourced from Inara; this table is only a community
-- sample used for anonymous aggregate comparisons.
CREATE TABLE IF NOT EXISTS public.community_goal_commander_reports (
  user_id               UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  game_cg_id            INTEGER NOT NULL,
  goal_key              TEXT NOT NULL,
  title                 TEXT NOT NULL,
  system_name           TEXT,
  station_name          TEXT,
  expiry_date           TIMESTAMPTZ,
  player_contribution   BIGINT NOT NULL DEFAULT 0,
  current_total         BIGINT,
  tier_reached          INTEGER,
  tier_max              INTEGER,
  contributors_num      INTEGER,
  percentile_band       INTEGER,
  is_top_rank           BOOLEAN,
  is_complete           BOOLEAN,
  observed_at           TIMESTAMPTZ NOT NULL,
  source                TEXT NOT NULL DEFAULT 'helper'
                        CHECK (source IN ('helper', 'capi', 'web')),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, game_cg_id)
);

CREATE INDEX IF NOT EXISTS idx_community_goal_reports_key
  ON public.community_goal_commander_reports (goal_key, observed_at DESC);

ALTER TABLE public.community_goal_commander_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.community_goal_commander_reports FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.community_goal_commander_reports TO service_role;

CREATE OR REPLACE FUNCTION public.upsert_community_goal_commander_reports(p_rows JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE
  affected INTEGER;
BEGIN
  INSERT INTO public.community_goal_commander_reports (
    user_id, game_cg_id, goal_key, title, system_name, station_name, expiry_date,
    player_contribution, current_total, tier_reached, tier_max, contributors_num,
    percentile_band, is_top_rank, is_complete, observed_at, source, updated_at
  )
  SELECT
    r.user_id, r.game_cg_id, r.goal_key, r.title, r.system_name, r.station_name,
    r.expiry_date, r.player_contribution, r.current_total, r.tier_reached,
    r.tier_max, r.contributors_num, r.percentile_band, r.is_top_rank,
    r.is_complete, r.observed_at, r.source, NOW()
  FROM jsonb_to_recordset(COALESCE(p_rows, '[]'::JSONB)) AS r(
    user_id UUID,
    game_cg_id INTEGER,
    goal_key TEXT,
    title TEXT,
    system_name TEXT,
    station_name TEXT,
    expiry_date TIMESTAMPTZ,
    player_contribution BIGINT,
    current_total BIGINT,
    tier_reached INTEGER,
    tier_max INTEGER,
    contributors_num INTEGER,
    percentile_band INTEGER,
    is_top_rank BOOLEAN,
    is_complete BOOLEAN,
    observed_at TIMESTAMPTZ,
    source TEXT
  )
  WHERE r.user_id IS NOT NULL
    AND r.game_cg_id > 0
    AND r.goal_key IS NOT NULL
    AND r.title IS NOT NULL
    AND r.observed_at IS NOT NULL
  ON CONFLICT (user_id, game_cg_id) DO UPDATE SET
    goal_key = EXCLUDED.goal_key,
    title = EXCLUDED.title,
    system_name = EXCLUDED.system_name,
    station_name = EXCLUDED.station_name,
    expiry_date = EXCLUDED.expiry_date,
    player_contribution = EXCLUDED.player_contribution,
    current_total = EXCLUDED.current_total,
    tier_reached = EXCLUDED.tier_reached,
    tier_max = EXCLUDED.tier_max,
    contributors_num = EXCLUDED.contributors_num,
    percentile_band = EXCLUDED.percentile_band,
    is_top_rank = EXCLUDED.is_top_rank,
    is_complete = EXCLUDED.is_complete,
    observed_at = EXCLUDED.observed_at,
    source = EXCLUDED.source,
    updated_at = NOW()
  WHERE EXCLUDED.observed_at >= public.community_goal_commander_reports.observed_at;

  GET DIAGNOSTICS affected = ROW_COUNT;
  RETURN affected;
END;
$$;

REVOKE ALL ON FUNCTION public.upsert_community_goal_commander_reports(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_community_goal_commander_reports(JSONB) TO service_role;
