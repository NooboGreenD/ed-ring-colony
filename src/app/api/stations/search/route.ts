import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { findSystemByName } from '@/lib/galaxySystemsDb';
import { resolveCommodity } from '@/lib/commodities';
import {
  STATION_ITEM_LIMIT, STATION_PAGE_SIZE, groupStationRows, stationItemMatchesKeys, stationSearchSchema,
  type StationSearchResult, type StationSearchStation, type StationSearchStationsResponse,
} from '@/lib/stationSearch';
import { resolveStationPick, stationItemDisplay, stationQueryAliases, type StationPick } from '@/lib/stationSearchCatalog';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type ServiceClient = ReturnType<typeof createServiceClient>;
type Query = ReturnType<typeof stationSearchSchema.parse>;

/** Поиск списком (миграция 20261022120000). Без неё — запасной путь через прежний поиск. */
const LIST_FUNCTION = 'search_station_catalog_stations';
/** Сколько строк прежнего поиска сводить в станции на запасном пути. */
const FALLBACK_ROWS = 100;
const MISSING_TTL_MS = 5 * 60_000;
let listMissingUntil = 0;
let warnedMissing = false;

function isMissingListFunction(error: { code?: string; message?: string }): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
    || new RegExp(`${LIST_FUNCTION}|could not find the function`, 'i').test(error.message || '');
}

export async function GET(request: Request) {
  const parsed = stationSearchSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return NextResponse.json({ error: 'Укажите запрос от 2 до 120 символов и корректные фильтры.' }, { status: 400 });
  const query = parsed.data;
  try {
    const svc = createServiceClient();
    let center: { x: number; y: number; z: number } | null = null;
    if (query.reference) {
      const name = query.reference.toLowerCase();
      const { data, error } = await svc.from('commerce_systems').select('x,y,z').eq('name_lc', name).maybeSingle();
      if (error) throw new Error(error.message);
      if (data && [data.x, data.y, data.z].every((v) => v != null && Number.isFinite(Number(v)))) {
        center = { x: Number(data.x), y: Number(data.y), z: Number(data.z) };
      } else {
        const row = await findSystemByName(query.reference);
        if (row) center = { x: row.x, y: row.y, z: row.z };
      }
      if (!center) return NextResponse.json({ error: 'Координаты опорной системы не найдены в БД. Выберите известную систему или ищите без ограничения расстояния.' }, { status: 404 });
    }
    // Подсказка из быстрого выбора ищется точно; свободный ввод — по вхождению
    // русских и английских названий и символов Frontier.
    const pick = resolveStationPick(query.kind, query.item);
    const text = pick?.label ?? (query.kind === 'market' ? resolveCommodity(query.q) : query.q);
    const filters = {
      search_kind: query.kind, needles: pick?.needles ?? stationQueryAliases(query.kind, text),
      cx: center?.x ?? null, cy: center?.y ?? null, cz: center?.z ?? null,
      radius_ly: query.radius, minimum_stock: query.min_stock, filter_class: query.module_class ?? null,
      filter_rating: query.rating ?? null, fresh_only: query.fresh === 'true', sort_by: query.sort,
    };

    if (query.group === 'station') {
      const found = await searchByStation(svc, query, filters, pick);
      const body: StationSearchStationsResponse = {
        kind: query.kind, query: text,
        reference: center ? { name: query.reference, ...center } : null,
        page: query.page, ...found,
        pick: pick ? { id: pick.id, label: pick.label } : null,
        source: 'project-db',
      };
      return NextResponse.json(body);
    }

    // Плоский ответ (станция + позиция) — прежний контракт API.
    const { data, error } = await svc.rpc('search_station_catalog', {
      ...filters, page_offset: query.page * STATION_PAGE_SIZE, row_limit: STATION_PAGE_SIZE,
    });
    if (error) throw new Error(error.message);
    const rows = (data || []) as unknown as StationSearchResult[];
    const page = rows.slice(0, STATION_PAGE_SIZE).filter((row) => !pick?.exactKeys.length || stationItemMatchesKeys(row.item, pick.exactKeys));
    return NextResponse.json({
      kind: query.kind, query: text, reference: query.reference || null, page: query.page, has_more: rows.length > STATION_PAGE_SIZE,
      results: page.map((row) => ({ ...row, item_display: stationItemDisplay(query.kind, row.item).display })),
      source: 'project-db',
    });
  } catch (error) {
    console.error('[Station Search]', error);
    return NextResponse.json({ error: 'Поиск станций временно недоступен. Проверьте подключение БД и применение миграций справочника станций.' }, { status: 503 });
  }
}

async function searchByStation(
  svc: ServiceClient,
  query: Query,
  filters: Record<string, unknown>,
  pick: StationPick | null,
): Promise<Pick<StationSearchStationsResponse, 'stations' | 'has_more' | 'total' | 'grouping'>> {
  const display = (item: StationSearchResult['item']) => stationItemDisplay(query.kind, item);
  if (Date.now() >= listMissingUntil) {
    const { data, error } = await svc.rpc(LIST_FUNCTION, {
      ...filters,
      exact_keys: pick?.exactKeys.length ? pick.exactKeys : null,
      page_offset: query.page * STATION_PAGE_SIZE, row_limit: STATION_PAGE_SIZE, item_limit: STATION_ITEM_LIMIT,
    });
    if (!error) {
      const result = (data ?? {}) as { total?: unknown; stations?: unknown };
      const stations = (Array.isArray(result.stations) ? result.stations : []) as StationSearchStation[];
      return {
        stations: stations.slice(0, STATION_PAGE_SIZE).map((station) => ({
          ...station,
          items: (Array.isArray(station.items) ? station.items : []).map((item) => ({ ...item, ...display(item) })),
        })),
        has_more: stations.length > STATION_PAGE_SIZE,
        total: Number.isFinite(Number(result.total)) ? Number(result.total) : null,
        grouping: 'station',
      };
    }
    if (!isMissingListFunction(error)) throw new Error(error.message);
    listMissingUntil = Date.now() + MISSING_TTL_MS;
    if (!warnedMissing) {
      warnedMissing = true;
      console.warn('[Station Search] База без миграции 20261022120000_station_search_by_station.sql: станции собираются из страницы прежнего поиска, точный выбор дочищается на сервере.');
    }
  }
  const { data, error } = await svc.rpc('search_station_catalog', {
    ...filters, page_offset: query.page * FALLBACK_ROWS, row_limit: FALLBACK_ROWS,
  });
  if (error) throw new Error(error.message);
  const rows = (data || []) as unknown as StationSearchResult[];
  return {
    stations: groupStationRows(rows.slice(0, FALLBACK_ROWS), { exactKeys: pick?.exactKeys, display }),
    has_more: rows.length > FALLBACK_ROWS,
    total: null,
    grouping: 'page',
  };
}
