-- Delivery imports used to download every hub and route-system row before each
-- batch. Resolve only the uploaded system names with indexed normalized keys.
-- The function is used by server-side/service-role import routes; normal users
-- cannot call it directly.
CREATE INDEX IF NOT EXISTS idx_hubs_normalized_system_name
  ON public.hubs ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))));

CREATE INDEX IF NOT EXISTS idx_route_systems_normalized_system_name
  ON public.route_systems ((lower(regexp_replace(btrim(system_name), '\s+', ' ', 'g'))));

CREATE OR REPLACE FUNCTION public.resolve_delivery_system_placements(system_names text[])
RETURNS TABLE (
  input_system_name text,
  system_name text,
  is_hub boolean,
  route_system_id bigint
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH raw_input_names AS (
    SELECT
      btrim(raw_name) AS input_system_name,
      lower(regexp_replace(btrim(raw_name), '\s+', ' ', 'g')) AS normalized_name,
      ordinal
    FROM unnest(system_names) WITH ORDINALITY AS names(raw_name, ordinal)
    WHERE raw_name IS NOT NULL AND btrim(raw_name) <> ''
  ),
  input_names AS (
    SELECT DISTINCT ON (normalized_name)
      input_system_name,
      normalized_name,
      ordinal
    FROM raw_input_names
    ORDER BY normalized_name, ordinal
  )
  SELECT
    input_names.input_system_name,
    COALESCE(hub.system_name, route_system.system_name, input_names.input_system_name) AS system_name,
    hub.system_name IS NOT NULL AS is_hub,
    route_system.id::bigint AS route_system_id
  FROM input_names
  LEFT JOIN LATERAL (
    SELECT h.system_name
    FROM public.hubs AS h
    WHERE lower(regexp_replace(btrim(h.system_name), '\s+', ' ', 'g')) = input_names.normalized_name
    ORDER BY h.id
    LIMIT 1
  ) AS hub ON true
  LEFT JOIN LATERAL (
    SELECT rs.id, rs.system_name
    FROM public.route_systems AS rs
    WHERE lower(regexp_replace(btrim(rs.system_name), '\s+', ' ', 'g')) = input_names.normalized_name
    ORDER BY rs.id
    LIMIT 1
  ) AS route_system ON true;
$$;

REVOKE ALL ON FUNCTION public.resolve_delivery_system_placements(text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_delivery_system_placements(text[]) TO service_role;
