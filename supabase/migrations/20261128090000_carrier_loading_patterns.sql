-- Template recipes/assignments only. Never persist or publish private stock.
CREATE TABLE IF NOT EXISTS public.carrier_loading_patterns (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  author_name text NOT NULL DEFAULT 'CMDR',
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  visibility text NOT NULL CHECK (visibility IN ('private','public')),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object' AND octet_length(definition::text) <= 131072),
  catalogue_version integer NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS loading_patterns_owner ON public.carrier_loading_patterns(owner_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS loading_patterns_public ON public.carrier_loading_patterns(updated_at DESC) WHERE visibility='public';
ALTER TABLE public.carrier_loading_patterns ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.carrier_loading_patterns FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.carrier_loading_patterns TO service_role;
-- API authenticates website sessions and Helper tokens, checks ownership on
-- EVERY write/read, validates recipes and recomputes cargo server-side.
