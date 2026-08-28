-- Make source_hash nullable to fix log import when hash is not generated client-side
ALTER TABLE public.deliveries ALTER COLUMN source_hash DROP NOT NULL;
