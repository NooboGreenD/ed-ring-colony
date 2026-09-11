-- Browser Journal imports and the Colonial Helper can resend a file/batch after
-- a timeout. Store a stable source key for new rows without rewriting every
-- legacy record in a production-sized deliveries table.
--
-- PostgreSQL permits multiple NULLs in a unique index, so legacy rows may stay
-- NULL while every new importer row carries a source_hash. Do not create that
-- potentially expensive unique index inside this transactional deploy
-- migration: use the explicitly named concurrent maintenance script after a
-- duplicate preflight during a quiet production window. Until then the API uses
-- a bounded existing-hash check for safe retry behaviour.
ALTER TABLE public.deliveries
  ADD COLUMN IF NOT EXISTS source_hash TEXT;
