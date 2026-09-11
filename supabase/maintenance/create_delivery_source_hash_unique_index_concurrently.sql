-- Run this manually in the Supabase SQL editor during a quiet maintenance
-- window AFTER 20260911010000_delivery_import_idempotency.sql has deployed.
-- It intentionally lives outside supabase/migrations: CREATE INDEX CONCURRENTLY
-- cannot run in Supabase's transactional migration wrapper.
--
-- Preflight must return no rows. Resolve any non-NULL duplicate source_hashes
-- deliberately before continuing; do not rewrite historical deliveries blindly.
SELECT user_id, source_hash, count(*) AS duplicate_count
FROM public.deliveries
WHERE source_hash IS NOT NULL
GROUP BY user_id, source_hash
HAVING count(*) > 1;

-- Run this only after the preflight above returns no duplicate rows.
-- PostgreSQL continues building concurrently if the command is interrupted, so
-- inspect pg_stat_progress_create_index / pg_indexes before retrying.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS idx_deliveries_user_source_hash_unique
  ON public.deliveries (user_id, source_hash);
