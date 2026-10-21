-- Add a stable Inara-to-journal identity key without changing the previously
-- shipped Inara details migration.
ALTER TABLE public.community_goals
  ADD COLUMN IF NOT EXISTS identity_key TEXT;
