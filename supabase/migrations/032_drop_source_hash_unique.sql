-- Remove unique constraint from source_hash since not all deliveries have a hash
-- and empty strings collide when multiple deliveries lack a client-side hash
ALTER TABLE public.deliveries DROP CONSTRAINT IF EXISTS deliveries_source_hash_key;
