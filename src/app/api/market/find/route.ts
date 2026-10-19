/**
 * GET /api/market/find — прежний поиск рынка, совместимый ответ из БД проекта.
 *
 * Параметры: `commodity` — английское название или символ товара;
 * `reference_system` (или `system`, по умолчанию Sol); `radius` — 1–500 св. лет,
 * по умолчанию 500; `mode=build` — станции со строительными товарами вместо
 * одного товара.
 *
 * До web 2.25.2 маршрут на каждый вызов сам обходил EDSM: куб до 1000 св. лет,
 * население пачками, станции и рынки — сотни запросов без тайм-аутов, цена
 * покупки бралась из `sellPrice`, и ничего не сохранялось. Сайт давно ищет через
 * `/api/market/find/{start,step,status}` и `/api/stations/search`; здесь остался
 * прежний вид ответа, но данные — из `station_commerce` (ARCHITECTURE.md §6.1),
 * без обращений к EDSM. Цена покупки — `buy_price`; `sell_price` — цена, по
 * которой станция покупает товар (как поле `sellPrice` у EDSM).
 */
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { BUILD_COMMODITIES, resolveCommodity } from '@/lib/commodities';
import { referenceSystemCoords } from '@/lib/referenceSystem';
import { STATION_ITEM_LIMIT, stationItemKey, type StationSearchItem, type StationSearchStation } from '@/lib/stationSearch';
import { marketPickByName, stationQueryAliases } from '@/lib/stationSearchCatalog';
import { cleanSystemName } from '@/lib/systemIdentity';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

const LIST_FUNCTION = 'search_station_catalog_stations';
const MAX_RADIUS = 500;
/** Станций в ответе `mode=single` — прежний обход смотрел 25 ближайших рынков. */
const SINGLE_LIMIT = 25;
/** `mode=build`: ближайшие станции хоть с одним товаром, затем — по числу найденных. */
const BUILD_POOL = 50;

interface Goods {
  needles: string[];
  exactKeys: string[];
}

function radiusParam(value: string | null): number {
  const radius = Number.parseInt(value ?? '', 10);
  return Number.isFinite(radius) && radius > 0 ? Math.min(radius, MAX_RADIUS) : MAX_RADIUS;
}

/** Товары запроса: точный выбор по справочнику, неизвестное название — по вхождению. */
function goodsQuery(names: string[]): Goods {
  const needles = new Set<string>();
  const exactKeys = new Set<string>();
  let exact = true;
  for (const name of names) {
    const pick = marketPickByName(name);
    if (pick) {
      pick.needles.forEach((needle) => needles.add(needle));
      pick.exactKeys.forEach((key) => exactKeys.add(key));
    } else {
      exact = false;
      stationQueryAliases('market', resolveCommodity(name)).forEach((needle) => needles.add(needle));
    }
  }
  return { needles: [...needles], exactKeys: exact ? [...exactKeys] : [] };
}

/** Крупнейшая площадка — только где её однозначно задаёт тип станции. */
function landingPad(stationType: string | null): string | null {
  const type = (stationType || '').replace(/\s+/g, '').toLowerCase();
  if (!type) return null;
  if (type === 'outpost') return 'M';
  return /^(fleetcarrier|coriolis|orbis|ocellus|dodec|bernal|asteroidbase|craterport|planetaryport)/.test(type) ? 'L' : null;
}

const price = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

function offer(item: StationSearchItem) {
  return { name: item.name, stock: item.stock ?? 0, buy_price: price(item.buyPrice), sell_price: price(item.sellPrice) };
}

function stationFields(station: StationSearchStation) {
  return {
    station_name: station.station_name,
    system_name: station.system_name,
    distance: station.distance,
    landing_pad: landingPad(station.station_type),
    station_type: station.station_type,
    market_id: station.market_id,
    observed_at: station.observed_at,
    source: station.source,
  };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const mode = params.get('mode') === 'build' ? 'build' : 'single';
  const commodity = (params.get('commodity') || '').trim().slice(0, 120);
  const reference = cleanSystemName(params.get('reference_system') || params.get('system') || 'Sol').slice(0, 120) || 'Sol';
  const radius = radiusParam(params.get('radius'));
  if (mode === 'single' && !commodity) {
    return NextResponse.json({ error: 'Укажите товар: commodity=<название>.' }, { status: 400 });
  }
  try {
    const svc = createServiceClient();
    const center = await referenceSystemCoords(svc, reference);
    if (!center) {
      return NextResponse.json({ error: `Координаты системы ${reference} не найдены в БД.` }, { status: 404 });
    }
    const names = mode === 'build' ? BUILD_COMMODITIES : [commodity];
    const goods = goodsQuery(names);
    const limit = mode === 'build' ? BUILD_POOL : SINGLE_LIMIT;
    const { data, error } = await svc.rpc(LIST_FUNCTION, {
      search_kind: 'market', needles: goods.needles, exact_keys: goods.exactKeys.length ? goods.exactKeys : null,
      cx: center.x, cy: center.y, cz: center.z, radius_ly: radius, minimum_stock: 1,
      filter_class: null, filter_rating: null, fresh_only: false, sort_by: 'distance',
      page_offset: 0, row_limit: limit, item_limit: STATION_ITEM_LIMIT,
    });
    if (error) throw new Error(error.message);
    const found = (data ?? {}) as { stations?: unknown };
    const stations = (Array.isArray(found.stations) ? found.stations : []).slice(0, limit) as StationSearchStation[];
    const itemsOf = (station: StationSearchStation) => (Array.isArray(station.items) ? station.items : []);

    if (mode === 'build') {
      const results = stations
        .map((station) => {
          const offers = itemsOf(station).map(offer);
          const keys = new Set(itemsOf(station).map((item) => stationItemKey(item.name)));
          return { ...stationFields(station), commodities: offers, commodities_found: keys.size, commodities_total: names.length };
        })
        .filter((station) => station.commodities_found > 0)
        .sort((a, b) => b.commodities_found - a.commodities_found || (a.distance ?? Infinity) - (b.distance ?? Infinity));
      return NextResponse.json({
        mode: 'build', reference_system: reference, radius, commodities: names,
        stations: results, count: results.length, source: 'project-db',
      });
    }

    const results = stations.flatMap((station) => {
      const item = itemsOf(station)[0];
      if (!item) return [];
      const { name, ...prices } = offer(item);
      return [{ ...stationFields(station), commodity: name, ...prices, demand: item.demand ?? 0 }];
    });
    return NextResponse.json({
      mode: 'single', commodity, reference_system: reference, radius,
      stations: results, count: results.length, source: 'project-db',
    });
  } catch (error) {
    console.error('[Market Find]', error);
    return NextResponse.json({
      error: 'Поиск рынков временно недоступен. Проверьте подключение БД и миграцию 20261022120000_station_search_by_station.sql.',
    }, { status: 503 });
  }
}
