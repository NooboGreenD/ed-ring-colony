-- ══════════════════════════════════════════════════════════════════════════
-- Каталог авианосцев (`/carriers`): все известные носители одной таблицей.
--
-- Зачем
-- -----
-- До сих пор авианосцы можно было увидеть либо на карте (слой «Авианосцы»),
-- либо поштучно — в карточке носителя (`/carriers/<MarketID>`). Списка «кто
-- вообще известен сайту» не было: пилот мог искать носитель только через
-- Атлас, а тот показывает результат по одному запросу и не умеет листать
-- весь реестр.
--
-- Источников два, и они друг друга не заменяют:
--   * `fleet_carriers` — то, что сайт ведёт сам (живёт дольше, знает владельца,
--     эскадрилью и заказ прыжка, но носитель туда попадает, лишь когда его
--     встретил пилот сайта);
--   * `carrier_directory` — реестр EDDN: каждый прыжок носителя уходит в живой
--     поток, поэтому там оказываются и чужие носители, которых сайт не ведёт.
--
-- Что делает эта миграция
-- -----------------------
--   1. `carrier_catalog` — представление-объединение по MarketID. Запись учёта
--      сайта главнее: имя, позывной и службы берутся из неё, реестр лишь
--      дополняет пустые поля. Записи, которых в `fleet_carriers` нет, помечены
--      `origin = 'eddn'`.
--   2. `carrier_catalog_page()` — одна страница каталога: поиск (позывной,
--      имя, система, тело, MarketID), фильтры (источник, «мои», «с заказом
--      прыжка»), три порядка (свежие, по имени, по системе), пагинация и общее
--      число совпадений одним ответом.
--
-- Почему функция, а не запрос из маршрута
-- ---------------------------------------
-- Список объединяет две таблицы, значит сортировка и пагинация должны жить в
-- одном запросе: иначе «страница 3» собиралась бы из двух независимых
-- выборок с разными ключами и могла бы и потерять строку, и показать её
-- дважды. Заодно поиск по склеенному полю (`search_text`) не требует `.or()`
-- из PostgREST, который ломается на запятых и скобках в запросе пилота.
--
-- Доступ
-- ------
-- Ни `anon`, ни `authenticated` не получают ни представления, ни функции:
-- читает только `service_role` через маршрут `/api/carriers/directory`.
-- Приватность владельца здесь не решается вовсе — имён владельцев в ответе
-- нет, есть только отношение (`own`/`squadron`/`other`) и признак «списан».
-- Груза и финансов в представлении нет и быть не может: это данные капитана.
-- ══════════════════════════════════════════════════════════════════════════

-- Порядок по времени наблюдения — самый частый (по умолчанию «свежие сверху»).
CREATE INDEX IF NOT EXISTS fleet_carriers_updated
  ON public.fleet_carriers(updated_at DESC);
CREATE INDEX IF NOT EXISTS carrier_directory_updated
  ON public.carrier_directory(updated_at DESC);

/* Список пересобирается целиком: представление читают только наши маршруты. */
DROP VIEW IF EXISTS public.carrier_catalog;

CREATE VIEW public.carrier_catalog AS
WITH site AS (
  SELECT
    fc.carrier_id,
    coalesce(nullif(btrim(fc.callsign), ''), nullif(btrim(cd.callsign), '')) AS callsign,
    coalesce(nullif(btrim(fc.name), ''), nullif(btrim(cd.name), '')) AS name,
    coalesce(fc.carrier_type, 'FleetCarrier') AS carrier_type,
    'site'::text AS origin,
    coalesce(nullif(btrim(fc.system_name), ''), nullif(btrim(cd.system_name), '')) AS system_name,
    coalesce(nullif(btrim(fc.body_name), ''), nullif(btrim(cd.body_name), '')) AS body_name,
    coalesce(fc.x, cd.x) AS x,
    coalesce(fc.y, cd.y) AS y,
    coalesce(fc.z, cd.z) AS z,
    fc.owner_id,
    fc.squadron_id,
    coalesce(fc.pending_decommission, false) AS decommission,
    nullif(btrim(fc.jump_system_name), '') AS jump_system_name,
    fc.jump_departure_at,
    nullif(btrim(fc.docking_access), '') AS docking_access,
    fc.allow_notorious,
    -- Службы экипажа главнее; если капитан их ещё не присылал, годится список
    -- станции из `Docked` — он тоже честный, просто беднее.
    CASE
      WHEN jsonb_typeof(fc.services) = 'array' AND jsonb_array_length(fc.services) > 0 THEN fc.services
      WHEN jsonb_typeof(cd.services) = 'array' AND jsonb_array_length(cd.services) > 0 THEN cd.services
      ELSE '[]'::jsonb
    END AS services,
    CASE
      WHEN jsonb_typeof(fc.station_services) = 'array' AND jsonb_array_length(fc.station_services) > 0
        THEN fc.station_services
      ELSE NULL::jsonb
    END AS station_services,
    cd.sightings,
    coalesce(fc.location_at, fc.updated_at) AS seen_at,
    fc.updated_at
  FROM public.fleet_carriers fc
  LEFT JOIN public.carrier_directory cd ON cd.carrier_id = fc.carrier_id
), registry AS (
  SELECT
    cd.carrier_id,
    nullif(btrim(cd.callsign), '') AS callsign,
    nullif(btrim(cd.name), '') AS name,
    coalesce(cd.carrier_type, 'FleetCarrier') AS carrier_type,
    'eddn'::text AS origin,
    nullif(btrim(cd.system_name), '') AS system_name,
    nullif(btrim(cd.body_name), '') AS body_name,
    cd.x,
    cd.y,
    cd.z,
    NULL::uuid AS owner_id,
    NULL::bigint AS squadron_id,
    false AS decommission,
    NULL::text AS jump_system_name,
    NULL::timestamptz AS jump_departure_at,
    NULL::text AS docking_access,
    NULL::boolean AS allow_notorious,
    CASE
      WHEN jsonb_typeof(cd.services) = 'array' AND jsonb_array_length(cd.services) > 0 THEN cd.services
      ELSE '[]'::jsonb
    END AS services,
    NULL::jsonb AS station_services,
    cd.sightings,
    coalesce(cd.last_seen_at, cd.updated_at) AS seen_at,
    cd.updated_at
  FROM public.carrier_directory cd
  WHERE NOT EXISTS (
    SELECT 1 FROM public.fleet_carriers fc WHERE fc.carrier_id = cd.carrier_id
  )
), merged AS (
  SELECT * FROM site
  UNION ALL
  SELECT * FROM registry
)
SELECT
  m.carrier_id,
  m.callsign,
  m.name,
  m.carrier_type,
  m.origin,
  m.system_name,
  m.body_name,
  m.x,
  m.y,
  m.z,
  m.owner_id,
  m.squadron_id,
  m.decommission,
  m.jump_system_name,
  m.jump_departure_at,
  m.docking_access,
  m.allow_notorious,
  m.services,
  m.station_services,
  m.sightings,
  m.seen_at,
  m.updated_at,
  -- Одно поле для поиска: как напечатано и слитно. Позывные в игре пишут с
  -- дефисом («K7Q-BQL»), а ищут слитно («k7qbql»), поэтому в хвосте строки
  -- лежит та же тройка без разделителей.
  lower(
    concat_ws(' ', m.callsign, m.name, m.system_name, m.body_name, m.carrier_id::text, m.carrier_type)
    || ' ' || regexp_replace(
      concat_ws(' ', m.callsign, m.name, m.system_name),
      '[^A-Za-z0-9]', '', 'g'
    )
  ) AS search_text,
  lower(coalesce(m.name, m.callsign, m.carrier_id::text)) AS sort_name,
  nullif(lower(btrim(m.system_name)), '') AS sort_system
FROM merged m;

COMMENT ON VIEW public.carrier_catalog IS
  'Каталог авианосцев: учёт сайта + реестр EDDN без дублей. Читает только service_role (маршрут /api/carriers/directory).';

REVOKE ALL ON public.carrier_catalog FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.carrier_catalog TO service_role;

/**
 * Одна страница каталога.
 *
 * `p_search` — строка пилота: слова проверяются по отдельности (каждое должно
 * найтись в `search_text`), поэтому «k7q steel» не выдаёт всё со словом
 * «steel». `p_scope = 'mine'` оставляет носители пилота и его эскадрилий.
 * `p_sort`: `recent` (по умолчанию) — свежие наблюдения сверху, `name` — по
 * имени (без имени — по позывному), `system` — по системе.
 *
 * `total` — сколько всего совпало, а не сколько отдано: по нему страница
 * рисует «страница N из M» и не притворяется, что список кончился.
 */
CREATE OR REPLACE FUNCTION public.carrier_catalog_page(
  p_search    TEXT DEFAULT NULL,
  p_origin    TEXT DEFAULT NULL,
  p_scope     TEXT DEFAULT NULL,
  p_user      UUID DEFAULT NULL,
  p_squadrons BIGINT[] DEFAULT '{}'::BIGINT[],
  p_jump      BOOLEAN DEFAULT false,
  p_sort      TEXT DEFAULT 'recent',
  p_offset    INTEGER DEFAULT 0,
  p_limit     INTEGER DEFAULT 50
) RETURNS JSONB
LANGUAGE sql
STABLE
AS $catalog$
WITH params AS (
  SELECT
    NULLIF(lower(btrim(coalesce(p_search, ''))), '') AS search,
    CASE WHEN p_origin IN ('site', 'eddn') THEN p_origin ELSE NULL END AS origin,
    CASE WHEN p_scope = 'mine' AND p_user IS NOT NULL THEN 'mine' ELSE NULL END AS scope,
    CASE WHEN p_sort IN ('name', 'system') THEN p_sort ELSE 'recent' END AS sort,
    coalesce(p_squadrons, '{}'::BIGINT[]) AS squadrons,
    GREATEST(0, coalesce(p_offset, 0)) AS off,
    GREATEST(1, LEAST(100, coalesce(p_limit, 50))) AS lim
), matched AS (
  SELECT c.*, count(*) OVER () AS total_count
  FROM public.carrier_catalog c, params p
  WHERE (
      p.search IS NULL
      OR NOT EXISTS (
        SELECT 1 FROM unnest(string_to_array(p.search, ' ')) AS token
        WHERE token <> '' AND c.search_text NOT LIKE '%' || token || '%'
      )
    )
    AND (p.origin IS NULL OR c.origin = p.origin)
    AND (NOT coalesce(p_jump, false) OR c.jump_system_name IS NOT NULL)
    AND (
      p.scope IS NULL
      OR (p_user IS NOT NULL AND c.owner_id = p_user)
      OR (c.squadron_id IS NOT NULL AND c.squadron_id = ANY(p.squadrons))
    )
), page AS (
  SELECT
    m.*,
    CASE
      WHEN p_user IS NOT NULL AND m.owner_id = p_user THEN 'own'
      WHEN m.squadron_id IS NOT NULL AND m.squadron_id = ANY(p.squadrons) THEN 'squadron'
      ELSE 'other'
    END AS relation
  FROM matched m, params p
  ORDER BY
    CASE WHEN p.sort = 'name' THEN m.sort_name END ASC NULLS LAST,
    CASE WHEN p.sort = 'system' THEN m.sort_system END ASC NULLS LAST,
    CASE WHEN p.sort = 'recent' THEN m.updated_at END DESC NULLS LAST,
    m.carrier_id DESC
  OFFSET (SELECT off FROM params)
  LIMIT (SELECT lim FROM params)
)
SELECT jsonb_build_object(
  'total', coalesce((SELECT max(total_count) FROM matched), 0),
  'rows', coalesce((
    SELECT jsonb_agg(
      to_jsonb(page)
      - 'total_count' - 'search_text' - 'sort_name' - 'sort_system'
      - 'owner_id' - 'squadron_id'
    )
    FROM page
  ), '[]'::jsonb)
);
$catalog$;

COMMENT ON FUNCTION public.carrier_catalog_page(TEXT, TEXT, TEXT, UUID, BIGINT[], BOOLEAN, TEXT, INTEGER, INTEGER) IS
  'Страница каталога авианосцев `/carriers`: поиск, фильтры, порядок, пагинация и общее число совпадений.';

REVOKE ALL ON FUNCTION public.carrier_catalog_page(TEXT, TEXT, TEXT, UUID, BIGINT[], BOOLEAN, TEXT, INTEGER, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.carrier_catalog_page(TEXT, TEXT, TEXT, UUID, BIGINT[], BOOLEAN, TEXT, INTEGER, INTEGER)
  TO service_role;
