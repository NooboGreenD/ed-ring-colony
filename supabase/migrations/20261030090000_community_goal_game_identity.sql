-- Preserve Frontier's in-game CG ID separately from the public catalogue key.
-- `cg_id` is a stable catalogue identifier and may be a generated hash when a
-- source omits its game ID; this column lets CAPI, Inara, and Helper journal
-- observations converge even when titles, location strings, or expiry formats
-- differ slightly between sources.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS game_cg_id INTEGER;

-- Backfill source IDs already present in normalized raw payloads. Guard casts
-- so malformed historical JSON can never fail a migration.
UPDATE public.community_goals
SET game_cg_id = CASE
  WHEN COALESCE(raw_data->>'cg_id', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'cg_id')::NUMERIC <= 2147483647
    THEN (raw_data->>'cg_id')::INTEGER
  WHEN COALESCE(raw_data->>'communitygoalGameID', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'communitygoalGameID')::NUMERIC <= 2147483647
    THEN (raw_data->>'communitygoalGameID')::INTEGER
  WHEN COALESCE(raw_data->>'cgID', '') ~ '^[1-9][0-9]*$'
    AND (raw_data->>'cgID')::NUMERIC <= 2147483647
    THEN (raw_data->>'cgID')::INTEGER
  ELSE NULL
END
WHERE game_cg_id IS NULL AND raw_data IS NOT NULL;

-- Older journal catalogue rows intentionally kept private totals out of
-- raw_data. Their game IDs can be recovered from the private reports table
-- when exactly one game ID was reported for that normalized goal identity.
WITH journal_ids AS (
  SELECT goal_key, MIN(game_cg_id) AS game_cg_id
  FROM public.community_goal_commander_reports
  GROUP BY goal_key
  HAVING COUNT(DISTINCT game_cg_id) = 1
)
UPDATE public.community_goals AS goal
SET game_cg_id = journal_ids.game_cg_id
FROM journal_ids
WHERE goal.source = 'journal'
  AND goal.game_cg_id IS NULL
  AND goal.identity_key = journal_ids.goal_key;

CREATE INDEX IF NOT EXISTS idx_community_goals_game_cg_id
  ON public.community_goals (game_cg_id)
  WHERE game_cg_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
