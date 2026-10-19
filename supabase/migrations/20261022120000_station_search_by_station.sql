-- ══════════════════════════════════════════════════════════════════════════
-- Поиск по станциям списком (web 2.25.0).
--
-- `/station-search` показывает станции строками: одна строка — одна станция,
-- по нажатию раскрывается то, что на ней совпало с запросом (товары с ценой и
-- запасом, модули, корабли, услуги). Поэтому выдача группируется по станциям
-- в базе: страница — это 50 станций, а не 50 пар «станция + товар», и общее
-- число найденных станций известно сразу.
--
-- Подбор совпадений вынесен в одну функцию `station_catalog_matches`: её
-- вызывают и прежний плоский поиск `search_station_catalog` (сигнатура и ответ
-- те же — перегрузка сломала бы PostgREST), и новый
-- `search_station_catalog_stations`.
--
-- Точное совпадение. Товар, модуль или корабль, выбранный из списка быстрого
-- выбора, приходит ключами `exact_keys`: английское название и символ
-- Frontier (EDCD/FDevIDs). Позиция совпадает, если ключ её названия, символа
-- или идентификатора равен одному из них. «Water» больше не находит
-- «Water Purifiers», обычный щит — призматический и Bi-Weave. Ключ — как
-- `commodityKey` в TypeScript: без `$…_name;`, только латиница и цифры, так что
-- `$steel_name;` (Colonial Helper), `steel` (EDDN) и `Steel` (Spansh) — одно.
-- Без ключей поиск, как и раньше, ищет вхождение `needles`.
--
-- Миграция идемпотентна: только CREATE OR REPLACE.
-- ══════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.station_item_key(value TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE SET search_path = public AS $$
  SELECT regexp_replace(
    regexp_replace(regexp_replace(lower(btrim(coalesce(value, ''))), '^\$', ''), '_name;?$', ''),
    '[^a-z0-9]', '', 'g');
$$;

COMMENT ON FUNCTION public.station_item_key(TEXT) IS
  'Ключ точного совпадения позиции ассортимента: без $…_name;, только a-z0-9 (как commodityKey в TypeScript).';

-- Совпадения: одна строка на пару «станция + позиция». Общая для обоих поисков.
CREATE OR REPLACE FUNCTION public.station_catalog_matches(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false
) RETURNS TABLE (
  station_key TEXT, station_name TEXT, station_type TEXT, system_name TEXT, market_id TEXT,
  x FLOAT8, y FLOAT8, z FLOAT8, distance FLOAT8, metadata JSONB, item JSONB,
  observed_at TIMESTAMPTZ, source TEXT, stale BOOLEAN
) LANGUAGE sql STABLE SET search_path = public AS $$
  WITH keys AS (
    SELECT
      coalesce((SELECT array_agg(DISTINCT public.station_item_key(k)) FROM unnest(exact_keys) k
        WHERE public.station_item_key(k) <> ''), '{}'::text[]) AS exact,
      coalesce((SELECT array_agg(DISTINCT public.station_search_key(n)) FROM unnest(needles) n
        WHERE length(public.station_search_key(n)) >= 2), '{}'::text[]) AS contains
  ), stations AS (
    SELECT st.station_key, st.station_name, st.station_type, st.system_name, st.market_id, st.metadata,
      st.observed_at, st.source, sys.x, sys.y, sys.z,
      CASE WHEN cx IS NOT NULL AND cy IS NOT NULL AND cz IS NOT NULL AND sys.x IS NOT NULL AND sys.y IS NOT NULL AND sys.z IS NOT NULL
        THEN sqrt(power(sys.x - cx, 2) + power(sys.y - cy, 2) + power(sys.z - cz, 2)) END AS distance
    FROM public.station_commerce st JOIN public.commerce_systems sys ON st.system_lc = sys.name_lc
    WHERE cx IS NULL OR (sys.x BETWEEN cx - radius_ly AND cx + radius_ly AND sys.y BETWEEN cy - radius_ly AND cy + radius_ly
      AND sys.z BETWEEN cz - radius_ly AND cz + radius_ly
      AND power(sys.x - cx, 2) + power(sys.y - cy, 2) + power(sys.z - cz, 2) <= power(radius_ly, 2))
  ), inventory AS (
    SELECT st.*, entry AS item, snap.observed_at AS inventory_at, snap.source AS inventory_source
    FROM stations st JOIN public.station_inventory_snapshots snap USING (station_key)
    CROSS JOIN LATERAL jsonb_array_elements(snap.items) entry
    WHERE search_kind IN ('market', 'outfitting', 'shipyard') AND snap.kind = search_kind
    UNION ALL
    SELECT st.*, jsonb_build_object('name', service), st.observed_at, st.source
    FROM stations st CROSS JOIN LATERAL jsonb_array_elements_text(
      coalesce(st.metadata->'services', '[]'::jsonb) ||
      (SELECT coalesce(jsonb_agg('Engineer: ' || engineer), '[]'::jsonb)
         FROM jsonb_array_elements_text(coalesce(st.metadata->'engineers', '[]'::jsonb)) engineer)
    ) service WHERE search_kind = 'services'
  )
  SELECT DISTINCT inv.station_key, inv.station_name, inv.station_type, inv.system_name, inv.market_id,
    inv.x, inv.y, inv.z, inv.distance, inv.metadata, inv.item,
    inv.inventory_at, inv.inventory_source, inv.inventory_at < now() - interval '1 hour'
  FROM inventory inv CROSS JOIN keys
  WHERE (CASE WHEN cardinality(keys.exact) > 0 THEN
      public.station_item_key(inv.item->>'name') = ANY (keys.exact)
      OR public.station_item_key(inv.item->>'symbol') = ANY (keys.exact)
      OR public.station_item_key(inv.item->>'id') = ANY (keys.exact)
    ELSE EXISTS (
      SELECT 1 FROM unnest(keys.contains) needle
      WHERE position(needle IN public.station_search_key(inv.item->>'name')) > 0
         OR position(needle IN public.station_search_key(inv.item->>'symbol')) > 0)
    END)
    AND (search_kind <> 'market' OR coalesce((inv.item->>'stock')::numeric, 0) >= minimum_stock)
    AND (NOT fresh_only OR inv.inventory_at >= now() - interval '1 hour')
    AND (search_kind <> 'outfitting' OR filter_class IS NULL OR
      coalesce(inv.item->>'class', substring(coalesce(inv.item->>'symbol', inv.item->>'name') FROM '(?i)_size([0-9]+)_')) = filter_class::text)
    AND (search_kind <> 'outfitting' OR filter_rating IS NULL OR
      coalesce(upper(inv.item->>'rating'), CASE substring(coalesce(inv.item->>'symbol', inv.item->>'name') FROM '(?i)_class([1-5])')
        WHEN '5' THEN 'A' WHEN '4' THEN 'B' WHEN '3' THEN 'C' WHEN '2' THEN 'D' WHEN '1' THEN 'E' END) = filter_rating);
$$;

-- Прежний плоский поиск: та же сигнатура и тот же ответ, совпадения — из общей функции.
CREATE OR REPLACE FUNCTION public.search_station_catalog(
  search_kind TEXT, needles TEXT[], cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH page AS (
    SELECT m.* FROM public.station_catalog_matches(search_kind, needles, NULL::text[], cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
    ORDER BY
      CASE WHEN sort_by = 'price' THEN coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) END NULLS LAST,
      CASE WHEN sort_by = 'updated' THEN m.observed_at END DESC NULLS LAST,
      m.distance NULLS LAST, m.station_key, m.item->>'name'
    LIMIT greatest(1, least(row_limit, 100)) + 1 OFFSET greatest(0, least(page_offset, 5000))
  ) SELECT coalesce(jsonb_agg(page), '[]'::jsonb) FROM page;
$$;

-- Поиск списком: одна строка на станцию, совпадения внутри, общее число станций.
-- Страница — `row_limit` станций и ещё одна (по ней видно, что есть следующая).
CREATE OR REPLACE FUNCTION public.search_station_catalog_stations(
  search_kind TEXT, needles TEXT[], exact_keys TEXT[] DEFAULT NULL,
  cx FLOAT8 DEFAULT NULL, cy FLOAT8 DEFAULT NULL, cz FLOAT8 DEFAULT NULL,
  radius_ly FLOAT8 DEFAULT 500, minimum_stock NUMERIC DEFAULT 1, filter_class INTEGER DEFAULT NULL,
  filter_rating TEXT DEFAULT NULL, fresh_only BOOLEAN DEFAULT false, sort_by TEXT DEFAULT 'distance',
  page_offset INTEGER DEFAULT 0, row_limit INTEGER DEFAULT 50, item_limit INTEGER DEFAULT 100
) RETURNS JSONB LANGUAGE sql STABLE SET search_path = public AS $$
  WITH matches AS (
    SELECT m.*, coalesce((m.item->>'price')::numeric, (m.item->>'buyPrice')::numeric) AS price
    FROM public.station_catalog_matches(search_kind, needles, exact_keys, cx, cy, cz, radius_ly,
      minimum_stock, filter_class, filter_rating, fresh_only) m
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

REVOKE ALL ON FUNCTION
  public.station_catalog_matches(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN),
  public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION
  public.station_catalog_matches(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN),
  public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER)
  TO service_role;

COMMENT ON FUNCTION public.search_station_catalog_stations(TEXT, TEXT[], TEXT[], FLOAT8, FLOAT8, FLOAT8, FLOAT8, NUMERIC, INTEGER, TEXT, BOOLEAN, TEXT, INTEGER, INTEGER, INTEGER) IS
  'Поиск по станциям списком (/station-search): {total, stations:[{…станция, items, item_count, best_price}]}. exact_keys — точный выбор из списка.';

NOTIFY pgrst, 'reload schema';
