-- Catalogue overlays, separate from the shipped EDCD/Coriolis dataset.
-- One row + revision allows an atomic compare-and-swap for entire edit batches.
-- Includes tombstones and the last 100 audit events; no saved builds are touched.
CREATE TABLE IF NOT EXISTS public.outfitting_catalog (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  changes JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(changes) = 'object'),
  history JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(history) = 'array'),
  updated_at TIMESTAMPTZ
);

INSERT INTO public.outfitting_catalog (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.outfitting_catalog ENABLE ROW LEVEL SECURITY;
-- All access goes through server routes; even admins cannot bypass validation
-- by issuing a direct browser PostgREST write. The public API omits audit data.
REVOKE ALL ON public.outfitting_catalog FROM anon, authenticated;
GRANT SELECT, UPDATE ON public.outfitting_catalog TO service_role;

COMMENT ON TABLE public.outfitting_catalog IS
  'Верфь: изменения модулей, групп и брони, архив и журнал действий; поверх статического справочника. Запись только через admin API с проверкой role=admin и revision.';

NOTIFY pgrst, 'reload schema';
