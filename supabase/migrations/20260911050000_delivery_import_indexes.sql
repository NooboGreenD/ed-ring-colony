-- Keep retry/idempotency lookups bounded for large delivery histories.
-- The importer falls back to checking existing source hashes when the optional
-- unique constraint is not present; without this index that query scans the
-- entire deliveries table and can hit the database statement timeout.
CREATE INDEX IF NOT EXISTS idx_deliveries_user_source_hash
  ON public.deliveries (user_id, source_hash)
  WHERE source_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_deliveries_user_delivered_at
  ON public.deliveries (user_id, delivered_at);
