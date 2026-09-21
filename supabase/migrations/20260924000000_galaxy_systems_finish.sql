-- Finish the Spansh galaxy catalog: nearest-in-cube lookups (atlas + route
-- finder), a trigram index for name autocomplete, and a public bucket the
-- import uploads the map point cloud into (the web image does not contain it).

-- ─── Nearest exotic/giant stars inside an axis-aligned cube ───
CREATE OR REPLACE FUNCTION public.galaxy_star_candidates(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  star_types text[],
  giant_classes text[],
  lim integer
)
RETURNS SETOF public.galaxy_systems
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.galaxy_systems
  WHERE x BETWEEN cx - half AND cx + half
    AND y BETWEEN cy - half AND cy + half
    AND z BETWEEN cz - half AND cz + half
    AND (
      (cardinality(star_types) > 0 AND star_type = ANY(star_types))
      OR (cardinality(giant_classes) > 0 AND star_giant_class = ANY(giant_classes))
    )
  ORDER BY ((x - cx) ^ 2 + (y - cy) ^ 2 + (z - cz) ^ 2)
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 2000), 2000));
$$;

-- ─── Any systems inside a cube, nearest first (route finder) ───
CREATE OR REPLACE FUNCTION public.galaxy_systems_near(
  cx double precision,
  cy double precision,
  cz double precision,
  half double precision,
  lim integer
)
RETURNS TABLE(name text, x double precision, y double precision, z double precision)
LANGUAGE sql
STABLE
AS $$
  SELECT g.name, g.x, g.y, g.z
  FROM public.galaxy_systems g
  WHERE g.x BETWEEN cx - half AND cx + half
    AND g.y BETWEEN cy - half AND cy + half
    AND g.z BETWEEN cz - half AND cz + half
  ORDER BY ((g.x - cx) ^ 2 + (g.y - cy) ^ 2 + (g.z - cz) ^ 2)
  LIMIT GREATEST(1, LEAST(COALESCE(lim, 800), 2000));
$$;

GRANT EXECUTE ON FUNCTION public.galaxy_star_candidates(
  double precision, double precision, double precision, double precision, text[], text[], integer
) TO anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.galaxy_systems_near(
  double precision, double precision, double precision, double precision, integer
) TO anon, authenticated, service_role;

-- Substring autocomplete. Prefix search already uses the name_lc btree.
-- pg_trgm is shipped with Supabase; skip quietly if this Postgres lacks it.
DO $$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_trgm;
  EXECUTE 'CREATE INDEX IF NOT EXISTS idx_galaxy_systems_name_trgm ON public.galaxy_systems USING gin (name_lc gin_trgm_ops)';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy name trigram index skipped: %', SQLERRM;
END $$;

-- Map point cloud (~36 MB). The web image does not contain the file, so the
-- importer uploads it here. Service-role writes bypass RLS; the policy only
-- covers a direct public read. Wrapped so a DB without the storage schema
-- still gets the lookup functions above.
DO $$
BEGIN
  INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
  VALUES (
    'galaxy-data',
    'galaxy-data',
    true,
    52428800,
    ARRAY['application/octet-stream']::text[]
  )
  ON CONFLICT (id) DO UPDATE SET
    public = true,
    file_size_limit = GREATEST(storage.buckets.file_size_limit, EXCLUDED.file_size_limit);

  DROP POLICY IF EXISTS galaxy_data_select ON storage.objects;
  CREATE POLICY galaxy_data_select ON storage.objects
    FOR SELECT TO anon, authenticated
    USING (bucket_id = 'galaxy-data');
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'galaxy-data bucket skipped: %', SQLERRM;
END $$;
