-- Browser Journal imports and the Colonial Helper can resend a file/batch after
-- a timeout. Keep every real delivery once per user without relying on an
-- unstable client-side timestamp-only heuristic.
ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS source_hash TEXT;

-- Legacy rows used an empty source_hash. Give every one a private, durable key
-- before making the conflict target unique. Preserve historical duplicate
-- rows: they are not deleted or silently merged by this migration.
UPDATE public.deliveries
SET source_hash = 'legacy:' || id::text
WHERE source_hash IS NULL OR btrim(source_hash) = '';

-- A few pre-existing helper versions may already have reused a nonempty hash.
-- Retain all rows while freeing the original key for deterministic future
-- imports.
WITH repeated_hashes AS (
  SELECT
    id,
    source_hash,
    row_number() OVER (PARTITION BY user_id, source_hash ORDER BY id) AS duplicate_number
  FROM public.deliveries
)
UPDATE public.deliveries AS delivery
SET source_hash = 'legacy:' || delivery.id::text
FROM repeated_hashes AS repeated
WHERE delivery.id = repeated.id
  AND repeated.duplicate_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deliveries_user_source_hash_unique
  ON public.deliveries (user_id, source_hash);
