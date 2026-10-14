-- Unified station search: only observed project-DB availability, never the
-- static outfitting/engineer catalogue as a substitute for a station report.
CREATE OR REPLACE FUNCTION public.station_search_key(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(lower(coalesce(value,'')), '[[:space:]_\-.$;()]', '', 'g');
$$;
CREATE OR REPLACE FUNCTION public.search_station_catalog(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH stations AS (
    SELECT st.*,sys.x,sys.y,sys.z,
      CASE WHEN cx IS NOT NULL AND cy IS NOT NULL AND cz IS NOT NULL AND sys.x IS NOT NULL AND sys.y IS NOT NULL AND sys.z IS NOT NULL
        THEN sqrt(power(sys.x-cx,2)+power(sys.y-cy,2)+power(sys.z-cz,2)) END AS distance
    FROM public.station_commerce st JOIN public.commerce_systems sys ON st.system_lc = sys.name_lc
    WHERE cx IS NULL OR (sys.x BETWEEN cx-radius_ly AND cx+radius_ly AND sys.y BETWEEN cy-radius_ly AND cy+radius_ly
      AND sys.z BETWEEN cz-radius_ly AND cz+radius_ly AND power(sys.x-cx,2)+power(sys.y-cy,2)+power(sys.z-cz,2) <= power(radius_ly,2))
  ), inventory AS (
    SELECT st.*,item,snap.observed_at AS inventory_at,snap.source AS inventory_source
    FROM stations st JOIN public.station_inventory_snapshots snap USING(station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) item
    WHERE search_kind IN ('market','outfitting','shipyard') AND snap.kind = search_kind
    UNION ALL
    SELECT st.*,jsonb_build_object('name',service),st.observed_at,st.source
    FROM stations st CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(st.metadata->'services','[]'::jsonb) ||
      (SELECT coalesce(jsonb_agg('Engineer: ' || engineer),'[]'::jsonb) FROM jsonb_array_elements_text(coalesce(st.metadata->'engineers','[]'::jsonb)) engineer)
    ) service WHERE search_kind = 'services'
  ), matches AS (
    SELECT DISTINCT station_key,station_name,station_type,system_name,market_id,x,y,z,distance,metadata,item,
      inventory_at AS observed_at,inventory_source AS source,inventory_at < now()-interval '1 hour' AS stale
    FROM inventory WHERE EXISTS (
      SELECT 1 FROM unnest(needles) needle WHERE length(public.station_search_key(needle)) >= 2 AND
      (position(public.station_search_key(needle) in public.station_search_key(item->>'name')) > 0 OR
       position(public.station_search_key(needle) in public.station_search_key(item->>'symbol')) > 0)
    ) AND (search_kind <> 'market' OR coalesce((item->>'stock')::numeric,0) >= minimum_stock)
    AND (NOT fresh_only OR inventory_at >= now()-interval '1 hour')
    AND (search_kind <> 'outfitting' OR filter_class IS NULL OR
      coalesce(item->>'class',substring(coalesce(item->>'symbol',item->>'name') FROM '(?i)_size([0-9]+)_')) = filter_class::text)
    AND (search_kind <> 'outfitting' OR filter_rating IS NULL OR
      coalesce(upper(item->>'rating'),CASE substring(coalesce(item->>'symbol',item->>'name') FROM '(?i)_class([1-5])')
        WHEN '5' THEN 'A' WHEN '4' THEN 'B' WHEN '3' THEN 'C' WHEN '2' THEN 'D' WHEN '1' THEN 'E' END) = filter_rating)
  ), page AS (
    SELECT * FROM matches ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((item->>'price')::numeric,(item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN observed_at END DESC NULLS LAST,
      distance NULLS LAST,station_key,item->>'name'
    LIMIT greatest(1,least(row_limit,100))+1 OFFSET greatest(0,least(page_offset,5000))
  ) SELECT coalesce(jsonb_agg(page),'[]'::jsonb) FROM page;
$$;
REVOKE ALL ON FUNCTION public.search_station_catalog(TEXT,TEXT[],FLOAT8,FLOAT8,FLOAT8,FLOAT8,NUMERIC,INTEGER,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.search_station_catalog(TEXT,TEXT[],FLOAT8,FLOAT8,FLOAT8,FLOAT8,NUMERIC,INTEGER,TEXT,BOOLEAN,TEXT,INTEGER,INTEGER) TO service_role;
NOTIFY pgrst, 'reload schema';

-- Named engineers annotate only station rows already reported to this DB.
UPDATE public.station_commerce st SET metadata = st.metadata || jsonb_build_object('engineers',jsonb_build_array(ref.engineer))
FROM (VALUES
  ('Deciat','Farseer Inc','Felicity Farseer'),
  ('Khun','Long Sight Base','Elvira Martuuk'),
  ('Wyrd','Black Hide','The Dweller'),
  ('Wolf 397','Trophy Camp','Tod "The Blaster" McQuinn'),
  ('Eurybia','Demolition Unlimited','Liz Ryder'),
  ('Giryak','Pater''s Memorial','Juri Ishmaak'),
  ('Yoru','Nemo Cyber Party Base','Zacariah Nemo'),
  ('Sirius','Qwent Research Base','Marco Qwent'),
  ('Laksak','Trader''s Rest','Lei Cheung'),
  ('Kuk','Prospector''s Rest','Selene Jean'),
  ('Kuwemaki','The Jet''s Hole','Hera Tani'),
  ('Arque','Abel Laboratory','Professor Palin'),
  ('Shenve','Cinder Dock','Chloe Sedesi'),
  ('Shinrarta Dezhra','Jameson Base','Lori Jameson'),
  ('Meene','Phoenix Base','Ram Tah'),
  ('Sol','Dekker''s Yard','Colonel Bris Dekker'),
  ('Beta-3 Tucani','The Beach','The Sarge'),
  ('Leesti','Vatermann LLC','Didi Vatermann'),
  ('Alioth','Turner Metallics Inc','Bill Turner'),
  ('Muang','Broo''s Legacy','Broo Tarquin'),
  ('Achenar','Fortune''s Loss','Tiana Fortune'),
  ('Luchtaine','The Brig','Mel Brandon'),
  ('Tir','The Watchtower','Marsha Hicks'),
  ('Asura','Sanctuary','Petra Olmanova'),
  ('Los','Kraken''s Retreat','Etienne Dorn'),
  ('Aurai','Marshall''s Drift','Jude Navarro'),
  ('Shou Xing','Rascal''s Choice','Terra Velasquez'),
  ('Candiaei','Ankh''s Promise','Oden Geiger'),
  ('Siris','Nevermore Terrace','Hero Ferrari'),
  ('Jolapa','Beck Facility','Wellington Beck'),
  ('Xuane','Laszlo''s Resolve','Uma Laszlo'),
  ('Orishis','The Jackrabbit','Domino Green'),
  ('Capoya','The Last Call','Kit Fowler'),
  ('Bayan','Salamander Bank','Yarden Bond'),
  ('Deriso','The Divine Apparatus','Baltanos'),
  ('Desy','Bresa Modifications','Eleanor Bresa'),
  ('Kojeara','Rosa''s Shop','Rosa Dayette'),
  ('Einheriar','Eidolon Hold','Yi Shen')
) AS ref(system_name,station_name,engineer)
WHERE lower(st.system_name) = lower(ref.system_name) AND regexp_replace(lower(st.station_name),'[^a-z0-9]','','g') = regexp_replace(lower(ref.station_name),'[^a-z0-9]','','g');
