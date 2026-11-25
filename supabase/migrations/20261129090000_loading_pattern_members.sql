-- Invitations do not grant cargo access. Each pilot explicitly accepts and
-- shares only selected, currently owned carriers within this pattern.
CREATE TABLE IF NOT EXISTS public.carrier_loading_pattern_members (
  pattern_id uuid NOT NULL REFERENCES public.carrier_loading_patterns(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  cmdr_name text NOT NULL,
  accepted_at timestamptz,
  shared_carrier_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pattern_id, user_id),
  CHECK (cardinality(shared_carrier_ids) <= 20),
  CHECK (accepted_at IS NOT NULL OR cardinality(shared_carrier_ids) = 0)
);
CREATE INDEX IF NOT EXISTS loading_pattern_members_user ON public.carrier_loading_pattern_members(user_id, pattern_id);
ALTER TABLE public.carrier_loading_pattern_members ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.carrier_loading_pattern_members FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.carrier_loading_pattern_members TO service_role;
-- All routes authenticate website/Helper identities. Ownership is rechecked
-- at every stock read, so selling/transferring a carrier invalidates the grant.
