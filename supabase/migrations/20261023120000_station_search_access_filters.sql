-- Фильтры доступности станции применяются до группировки, total и LIMIT/OFFSET.
-- Отдельные RPC сохраняют старые сигнатуры и совместимость PostgREST.
-- При отсутствии миграции API не возвращает нефильтрованную выдачу.
CREATE OR REPLACE FUNCTION public.station_access_matches(
  station_type TEXT, metadata JSONB, filter_pad TEXT, filter_carriers TEXT
) RETURNS BOOLEAN LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  WITH normalized AS (
    SELECT regexp_replace(lower(coalesce(station_type, '')), '[^a-z0-9]', '', 'g') AS kind
  ), access AS (
    SELECT kind = 'fleetcarrier' AS carrier,
      CASE
        WHEN metadata->>'max_landing_pad' IN ('S', 'M', 'L') THEN metadata->>'max_landing_pad'
        WHEN kind = 'outpost' THEN 'M'
        WHEN kind ~ '^(fleetcarrier|coriolis|orbis|ocellus|dodec|bernal|asteroidbase|craterport|planetaryport)' THEN 'L'
        ELSE NULL
      END AS pad
    FROM normalized
  )
  SELECT (filter_carriers = 'include' OR (filter_carriers = 'exclude' AND NOT carrier)
      OR (filter_carriers = 'only' AND carrier))
    AND (filter_pad = 'any' OR coalesce(CASE filter_pad
      WHEN 'S' THEN pad IN ('S', 'M', 'L') WHEN 'M' THEN pad IN ('M', 'L') WHEN 'L' THEN pad = 'L'
      ELSE false END, false))
  FROM access;
$$;

CREATE OR REPLACE FUNCTION public.search_station_catalog_filtered(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50,
  filter_pad TEXT DEFAULT 'any', filter_carriers TEXT DEFAULT 'include'
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH page AS (
    SELECT m.* FROM public.station_catalog_matches(search_kind, needles, NULL::text[], cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    WHERE public.station_access_matches(m.station_type, m.metadata, filter_pad, filter_carriers)
    ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN m.observed_at END DESC NULLS LAST,
      m.distance NULLS LAST, m.station_key, m.item->>'name'
    LIMIT greatest(1, least(row_limit, 100)) + 1 OFFSET greatest(0, least(page_offset, 5000))
  ) SELECT coalesce(jsonb_agg(page), '[]'::jsonb) FROM page;
$$;

CREATE OR REPLACE FUNCTION public.search_station_catalog_stations_filtered(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50, item_limit INTEGER DEFAULT 100,
  filter_pad TEXT DEFAULT 'any', filter_carriers TEXT DEFAULT 'include'
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH matches AS (
    SELECT m.*, coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) AS price
    FROM public.station_catalog_matches(search_kind, needles, exact_keys, cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    WHERE public.station_access_matches(m.station_type, m.metadata, filter_pad, filter_carriers)
  ), grouped AS (
    SELECT station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale, count(*)::int AS item_count, min(price) AS best_price,
      -- Модули — от старшего класса и лучшего рейтинга, товары и корабли — по цене.
      array_agg(item ORDER BY item->>'class' DESC NULLS LAST, upper(item->>'rating') NULLS LAST,
        price NULLS LAST, item->>'name') AS items
    FROM matches
    GROUP BY station_key, station_name, station_type, system_name, market_id, x, y, z, distance, metadata,
      observed_at, source, stale
  ), ordered AS (
    SELECT grouped.*, row_number() OVER (ORDER BY
        CASE WHEN sort_by = 'price' THEN best_price END NULLS LAST,
        CASE WHEN sort_by = 'updated' THEN observed_at END DESC NULLS LAST,
        distance NULLS LAST, station_key) AS row_no
    FROM grouped
  ), bounds AS (
    SELECT greatest(0, least(page_offset, 5000)) AS page_skip,
      greatest(1, least(row_limit, 100)) + 1 AS page_take,
      greatest(1, least(item_limit, 200)) AS items_max
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM grouped),
    'stations', coalesce((
      SELECT jsonb_agg(jsonb_build_object(
          'station_key', o.station_key, 'station_name', o.station_name, 'station_type', o.station_type,
          'system_name', o.system_name, 'market_id', o.market_id, 'x', o.x, 'y', o.y, 'z', o.z,
          'distance', o.distance, 'metadata', o.metadata, 'observed_at', o.observed_at,
          'source', o.source, 'stale', o.stale, 'item_count', o.item_count, 'best_price', o.best_price,
          'items', to_jsonb(o.items[1:b.items_max])) ORDER BY o.row_no)
      FROM ordered o CROSS JOIN bounds b
      WHERE o.row_no > b.page_skip AND o.row_no <= b.page_skip + b.page_take), '[]'::jsonb));
$$;

REVOKE ALL ON FUNCTION public.station_access_matches(TEXT, JSONB, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.station_access_matches(TEXT, JSONB, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.search_station_catalog_filtered(TEXT, TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog_filtered(TEXT, TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, TEXT, TEXT) TO service_role;
REVOKE ALL ON FUNCTION public.search_station_catalog_stations_filtered(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog_stations_filtered(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER, TEXT, TEXT) TO service_role;

NOTIFY pgrst, 'reload schema';
