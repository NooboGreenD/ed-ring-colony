-- This migration was originally committed as a single malformed SQL line, so
-- fresh deployments could not progress to the later Journal/CAPI migrations.
--
-- The complete, hardened squadron profile synchronization is installed by
-- 20260911030000_squadron_read_models_and_profile_sync.sql. Keep this earlier
-- migration deliberately side-effect-free: it preserves the historical
-- migration version for projects that already recorded it, lets fresh projects
-- migrate successfully, and avoids a large unconditional profiles backfill.
DO $$
BEGIN
  RAISE NOTICE 'Squadron profile synchronization is installed by migration 20260911030000.';
END $$;
