-- Durable station metadata and independently versioned COMPLETE inventories.
CREATE TABLE IF NOT EXISTS public.commerce_systems (
  system_name TEXT NOT NULL,
  name_lc TEXT PRIMARY KEY,
  x DOUBLE PRECISION, y DOUBLE PRECISION, z DOUBLE PRECISION,
  population BIGINT CHECK (population >= 0),
  has_stations BOOLEAN NOT NULL DEFAULT false,
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS commerce_systems_position ON public.commerce_systems (x, y, z)
  WHERE population > 0 OR has_stations;

CREATE TABLE IF NOT EXISTS public.station_commerce (
  station_key TEXT PRIMARY KEY,
  market_id TEXT,
  system_name TEXT NOT NULL,
  system_lc TEXT NOT NULL REFERENCES public.commerce_systems(name_lc),
  station_name TEXT NOT NULL,
  station_type TEXT,
  metadata JSONB NOT NULL DEFAULT '{}',
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS station_commerce_system ON public.station_commerce(system_lc);
CREATE TABLE IF NOT EXISTS public.station_inventory_snapshots (
  station_key TEXT NOT NULL REFERENCES public.station_commerce(station_key) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('market', 'outfitting', 'shipyard')),
  items JSONB NOT NULL CHECK (jsonb_typeof(items) = 'array'),
  observed_at TIMESTAMPTZ NOT NULL,
  source TEXT NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (station_key, kind)
);
CREATE INDEX IF NOT EXISTS station_inventory_items ON public.station_inventory_snapshots USING gin(items jsonb_path_ops);
CREATE INDEX IF NOT EXISTS station_inventory_age ON public.station_inventory_snapshots(observed_at);
ALTER TABLE public.commerce_systems ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_commerce ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.station_inventory_snapshots ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.commerce_systems, public.station_commerce, public.station_inventory_snapshots FROM anon, authenticated;
GRANT ALL ON public.commerce_systems, public.station_commerce, public.station_inventory_snapshots TO service_role;

CREATE OR REPLACE FUNCTION public.commerce_source_rank(source TEXT) RETURNS INTEGER
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT CASE source WHEN 'colonial-helper' THEN 4 WHEN 'eddn' THEN 3 WHEN 'edsm' THEN 2 ELSE 1 END;
$$;

-- One atomic transaction: identity, location and snapshots. Row-level conflict
-- locks prevent an old import from overwriting a newer live docking report.
CREATE OR REPLACE FUNCTION public.save_station_commerce(report JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE
  sys_key TEXT := lower(trim(report->>'system_name'));
  identity_key TEXT := report->>'station_key';
  stamp TIMESTAMPTZ := (report->>'observed_at')::timestamptz;
  origin TEXT := report->>'source';
  inventory RECORD;
  known_identity TEXT;
  previous_station RECORD;
BEGIN
  IF origin NOT IN ('colonial-helper','eddn','edsm','spansh') OR stamp > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid source or observation time';
  END IF;
  IF report->>'market_id' IS NULL THEN
    SELECT station_key INTO known_identity FROM public.station_commerce
      WHERE system_lc = sys_key AND lower(trim(station_name)) = lower(trim(report->>'station_name'))
        AND market_id IS NOT NULL ORDER BY observed_at DESC LIMIT 1;
    identity_key := coalesce(known_identity,identity_key);
  END IF;
  SELECT system_name,station_name,observed_at,source INTO previous_station
    FROM public.station_commerce WHERE station_key = identity_key FOR UPDATE;
  IF FOUND AND lower(previous_station.system_name) <> sys_key AND
      (stamp > previous_station.observed_at OR (stamp = previous_station.observed_at AND
       public.commerce_source_rank(origin) >= public.commerce_source_rank(previous_station.source))) THEN
    -- Old discovery/EDDN rows must not keep a moved carrier trading in the
    -- previous system. Canonical inventories remain attached to MarketID.
    DELETE FROM public.market_prices WHERE lower(system_name) = lower(previous_station.system_name)
      AND lower(station_name) = lower(previous_station.station_name);
    DELETE FROM public.market_search_cache WHERE market_id::text = report->>'market_id';
  END IF;
  INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,population,has_stations,observed_at,source)
    VALUES(report->>'system_name',sys_key,(report->>'x')::float8,(report->>'y')::float8,(report->>'z')::float8,
      (report->>'population')::bigint,true,stamp,origin)
  ON CONFLICT(name_lc) DO UPDATE SET
    has_stations = true,
    x = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.x,commerce_systems.x) ELSE coalesce(commerce_systems.x,EXCLUDED.x) END,
    y = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.y,commerce_systems.y) ELSE coalesce(commerce_systems.y,EXCLUDED.y) END,
    z = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.z,commerce_systems.z) ELSE coalesce(commerce_systems.z,EXCLUDED.z) END,
    population = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.population,commerce_systems.population) ELSE coalesce(commerce_systems.population,EXCLUDED.population) END,
    observed_at = greatest(EXCLUDED.observed_at,commerce_systems.observed_at),
    source = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN EXCLUDED.source ELSE commerce_systems.source END;

  UPDATE public.commerce_systems SET has_stations = true WHERE name_lc = sys_key;

  INSERT INTO public.station_commerce(station_key,market_id,system_name,system_lc,station_name,station_type,metadata,observed_at,source)
    VALUES(identity_key,report->>'market_id',report->>'system_name',sys_key,report->>'station_name',report->>'station_type',
      coalesce(report->'metadata','{}'),stamp,origin)
  ON CONFLICT(station_key) DO UPDATE SET
    system_name = EXCLUDED.system_name, system_lc = EXCLUDED.system_lc,
    station_name = EXCLUDED.station_name, station_type = coalesce(EXCLUDED.station_type,station_commerce.station_type),
    -- Orbital/body metadata from the previous system is not valid after a carrier jump.
    metadata = CASE WHEN station_commerce.system_lc <> EXCLUDED.system_lc THEN EXCLUDED.metadata
      ELSE station_commerce.metadata || EXCLUDED.metadata END,
    observed_at = EXCLUDED.observed_at, source = EXCLUDED.source
  WHERE EXCLUDED.observed_at > station_commerce.observed_at OR
    (EXCLUDED.observed_at = station_commerce.observed_at AND public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_commerce.source));

  -- EDDN may lack MarketID. When EDSM/Helper later supplies it, reconcile
  -- the natural-name identity rather than keeping duplicate legacy stations.
  IF report->>'market_id' IS NOT NULL THEN
    INSERT INTO public.station_inventory_snapshots(station_key,kind,items,observed_at,source)
    SELECT identity_key,s.kind,s.items,s.observed_at,s.source
    FROM public.station_inventory_snapshots s JOIN public.station_commerce st USING(station_key)
    WHERE st.station_key = 'name:' || sys_key || ':' || lower(trim(report->>'station_name'))
      AND st.station_key <> identity_key
    ON CONFLICT(station_key,kind) DO UPDATE SET
      items = EXCLUDED.items, observed_at = EXCLUDED.observed_at, source = EXCLUDED.source, received_at = now()
    WHERE EXCLUDED.observed_at > station_inventory_snapshots.observed_at OR
      (EXCLUDED.observed_at = station_inventory_snapshots.observed_at AND
       public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_inventory_snapshots.source));
    DELETE FROM public.station_commerce
    WHERE station_key = 'name:' || sys_key || ':' || lower(trim(report->>'station_name')) AND station_key <> identity_key;
  END IF;

  FOR inventory IN SELECT key,value FROM jsonb_each(coalesce(report->'inventories','{}')) LOOP
    IF (inventory.value->>'observed_at')::timestamptz > now() + interval '5 minutes' THEN
      RAISE EXCEPTION 'Invalid inventory observation time';
    END IF;
    INSERT INTO public.station_inventory_snapshots(station_key,kind,items,observed_at,source)
      VALUES(identity_key,inventory.key,inventory.value->'items',(inventory.value->>'observed_at')::timestamptz,origin)
    ON CONFLICT(station_key,kind) DO UPDATE SET
      items = EXCLUDED.items, observed_at = EXCLUDED.observed_at, source = EXCLUDED.source, received_at = now()
    WHERE EXCLUDED.observed_at > station_inventory_snapshots.observed_at OR
      (EXCLUDED.observed_at = station_inventory_snapshots.observed_at AND
       public.commerce_source_rank(EXCLUDED.source) >= public.commerce_source_rank(station_inventory_snapshots.source));
  END LOOP;
END;
$$;

-- Indexed box prefilter + exact sphere + nearest-first ordering, not a scan of
-- millions of uninhabited stars. Includes systems learned from station visits.
CREATE OR REPLACE FUNCTION public.nearby_commerce_systems(cx FLOAT8, cy FLOAT8, cz FLOAT8, radius_ly FLOAT8)
RETURNS JSONB
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT coalesce(jsonb_agg(nearby), '[]'::jsonb) FROM (
  SELECT s.system_name,s.x,s.y,s.z,sqrt(power(s.x-cx,2)+power(s.y-cy,2)+power(s.z-cz,2)) AS distance
  FROM public.commerce_systems s
  WHERE (s.population > 0 OR s.has_stations)
    AND s.x BETWEEN cx-radius_ly AND cx+radius_ly
    AND s.y BETWEEN cy-radius_ly AND cy+radius_ly
    AND s.z BETWEEN cz-radius_ly AND cz+radius_ly
    AND power(s.x-cx,2)+power(s.y-cy,2)+power(s.z-cz,2) <= power(radius_ly,2)
  ORDER BY distance LIMIT 5000) nearby;
$$;
REVOKE ALL ON FUNCTION public.save_station_commerce(JSONB), public.nearby_commerce_systems(FLOAT8,FLOAT8,FLOAT8,FLOAT8) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_station_commerce(JSONB), public.nearby_commerce_systems(FLOAT8,FLOAT8,FLOAT8,FLOAT8) TO service_role;

-- Known stations discovered by the old search immediately participate in stage one.
INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,has_stations,observed_at,source)
SELECT system_name,lower(trim(system_name)),x,y,z,true,coalesce(last_checked_at,now()),'edsm'
FROM public.colonisation_market_systems WHERE has_market
ON CONFLICT(name_lc) DO NOTHING;

ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS discovery_complete BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE public.market_search_jobs ADD COLUMN IF NOT EXISTS reference_coords JSONB;
NOTIFY pgrst, 'reload schema';

-- Rich Spansh systems also carry population even when no station has yet been
-- observed. Import one system at a time, without buffering the galaxy in RAM.
CREATE OR REPLACE FUNCTION public.save_spansh_commerce(payload JSONB) RETURNS VOID
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE station JSONB;
BEGIN
  INSERT INTO public.commerce_systems(system_name,name_lc,x,y,z,population,has_stations,observed_at,source)
  VALUES(payload->>'system_name',lower(trim(payload->>'system_name')),
    (payload->>'x')::float8,(payload->>'y')::float8,(payload->>'z')::float8,
    (payload->>'population')::bigint,false,(payload->>'observed_at')::timestamptz,'spansh')
  ON CONFLICT(name_lc) DO UPDATE SET
    x = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.x,commerce_systems.x) ELSE coalesce(commerce_systems.x,EXCLUDED.x) END,
    y = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.y,commerce_systems.y) ELSE coalesce(commerce_systems.y,EXCLUDED.y) END,
    z = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.z,commerce_systems.z) ELSE coalesce(commerce_systems.z,EXCLUDED.z) END,
    population = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN coalesce(EXCLUDED.population,commerce_systems.population) ELSE coalesce(commerce_systems.population,EXCLUDED.population) END,
    observed_at = greatest(EXCLUDED.observed_at,commerce_systems.observed_at),
    source = CASE WHEN EXCLUDED.observed_at >= commerce_systems.observed_at THEN EXCLUDED.source ELSE commerce_systems.source END;
  FOR station IN SELECT value FROM jsonb_array_elements(payload->'reports') LOOP
    PERFORM public.save_station_commerce(station);
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.save_spansh_commerce(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.save_spansh_commerce(JSONB) TO service_role;
NOTIFY pgrst, 'reload schema';

-- The standalone Atlas market page uses the same durable snapshots. JSONB
-- result avoids PostgREST's default row cap; complete empty snapshots exclude
-- obsolete legacy reports for that station as well.
CREATE OR REPLACE FUNCTION public.search_station_commodity(search_name TEXT, system_filter TEXT DEFAULT NULL, row_limit INTEGER DEFAULT 50)
RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH prices AS (
    SELECT st.station_name,st.system_name,item->>'name' AS commodity_name,
      (item->>'buyPrice')::numeric AS buy_price,(item->>'sellPrice')::numeric AS sell_price,
      (item->>'stock')::numeric AS stock,(item->>'demand')::numeric AS demand,
      snap.observed_at AS reported_at,snap.source,
      snap.observed_at < now() - interval '1 hour' AS stale
    FROM public.station_commerce st JOIN public.station_inventory_snapshots snap USING(station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) item
    WHERE snap.kind = 'market'
    UNION ALL
    SELECT p.station_name,p.system_name,p.commodity_name,p.buy_price,p.sell_price,p.stock,p.demand,
      p.reported_at,p.source,p.reported_at < now() - interval '1 hour'
    FROM public.market_prices p
    WHERE NOT EXISTS (
      SELECT 1 FROM public.station_commerce st JOIN public.station_inventory_snapshots snap USING(station_key)
      WHERE snap.kind = 'market' AND lower(st.station_name) = lower(p.station_name)
        AND (lower(st.system_name) = lower(p.system_name) OR st.station_type ILIKE '%carrier%')
    )
  ), matches AS (
    SELECT * FROM prices WHERE stock > 0
      AND lower(regexp_replace(regexp_replace(commodity_name,'_name;?$','','i'),'[^a-z0-9]','','gi')) =
          lower(regexp_replace(regexp_replace(search_name,'_name;?$','','i'),'[^a-z0-9]','','gi'))
      AND (system_filter IS NULL OR position(lower(system_filter) in lower(system_name)) > 0)
    ORDER BY buy_price NULLS LAST,reported_at DESC LIMIT greatest(1,least(row_limit,100))
  ) SELECT coalesce(jsonb_agg(matches),'[]'::jsonb) FROM matches;
$$;
REVOKE ALL ON FUNCTION public.search_station_commodity(TEXT,TEXT,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_commodity(TEXT,TEXT,INTEGER) TO service_role;
NOTIFY pgrst, 'reload schema';
