-- Project systems need their own coordinates. They must not depend on the
-- global route_systems table: a squadron project can contain systems that are
-- not part of the global route.
ALTER TABLE public.project_systems
  ADD COLUMN IF NOT EXISTS x NUMERIC,
  ADD COLUMN IF NOT EXISTS y NUMERIC,
  ADD COLUMN IF NOT EXISTS z NUMERIC;
