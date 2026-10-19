import { z } from 'zod';
import { atlasSystemHref } from './systemIdentity.ts';

export const stationSearchSchema = z.object({
  kind: z.enum(['market', 'outfitting', 'shipyard', 'services']).default('market'),
  q: z.string().trim().min(2).max(120),
  reference: z.string().trim().max(200).default(''),
  radius: z.coerce.number().finite().min(1).max(50000).default(500),
  min_stock: z.coerce.number().int().min(1).max(1e12).default(1),
  module_class: z.coerce.number().int().min(0).max(8).optional(),
  rating: z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']).optional(),
  fresh: z.enum(['true', 'false']).default('false'),
  sort: z.enum(['distance', 'price', 'updated']).default('distance'),
  page: z.coerce.number().int().min(0).max(100).default(0),
  /** Подсказка из быстрого выбора (`market:Steel`, `module:…`): ищется точно она. */
  item: z.string().trim().max(120).regex(/^[a-z]+:[A-Za-z0-9_.\-]+$/).optional(),
  /** `station` — одна строка на станцию со всеми совпадениями (страница поиска). */
  group: z.enum(['station']).optional(),
});
export type StationSearchKind = z.infer<typeof stationSearchSchema>['kind'];
export type StationSearchSort = z.infer<typeof stationSearchSchema>['sort'];

export interface StationSearchItem {
  name: string; symbol?: string; id?: string | number; class?: number | string; rating?: string;
  buyPrice?: number; sellPrice?: number; price?: number; stock?: number; demand?: number;
}
export interface StationMetadata {
  body_name?: string; distance_to_arrival?: number; latitude?: number; longitude?: number; services?: string[]; engineers?: string[];
}
export interface StationSearchResult {
  station_key: string; station_name: string; station_type: string | null; system_name: string;
  market_id: string | null; x: number | null; y: number | null; z: number | null;
  distance: number | null; metadata: StationMetadata;
  item: StationSearchItem;
  item_display?: string; observed_at: string; source: string; stale: boolean;
}

/** Совпадение на станции с подписью для списка (русское название, класс и рейтинг). */
export interface StationMatchedItem extends StationSearchItem {
  display: string;
  hint?: string;
}

/** Строка списка: станция и всё, что на ней совпало с запросом. */
export interface StationSearchStation {
  station_key: string; station_name: string; station_type: string | null; system_name: string;
  market_id: string | null; x: number | null; y: number | null; z: number | null;
  distance: number | null; metadata: StationMetadata;
  observed_at: string; source: string; stale: boolean;
  /** Совпадения (не больше `STATION_ITEM_LIMIT`), полное число — в `item_count`. */
  items: StationMatchedItem[];
  item_count: number;
  best_price: number | null;
}

export interface StationSearchStationsResponse {
  kind: StationSearchKind;
  query: string;
  reference: { name: string; x: number; y: number; z: number } | null;
  page: number;
  has_more: boolean;
  /** Сколько станций нашлось всего; `null` — база без миграции 20261022120000. */
  total: number | null;
  stations: StationSearchStation[];
  pick: { id: string; label: string } | null;
  /** `station` — группирует база; `page` — запасной путь: группировка строк одной страницы. */
  grouping: 'station' | 'page';
  source: 'project-db';
}

export const STATION_PAGE_SIZE = 50;
export const STATION_ITEM_LIMIT = 100;

export const SERVICE_OPTIONS = [
  { label: 'Технологический брокер', value: 'techbroker', aliases: ['technologybroker', 'techbroker', 'техноброкер', 'технологическийброкер'] },
  { label: 'Инженер / мастерская', value: 'engineer', aliases: ['engineer', 'workshop', 'инженер', 'мастерская'] },
  { label: 'Торговец материалами', value: 'materialtrader', aliases: ['materialtrader', 'торговецматериалами'] },
  { label: 'Межзвёздные факторы', value: 'interstellarfactors', aliases: ['interstellarfactors', 'interstellarfactor', 'facilitator', 'межзвёздныефакторы', 'межзвездныефакторы'] },
  { label: 'Рынок товаров', value: 'commodities', aliases: ['commodities', 'commoditymarket', 'рыноктоваров'] },
  { label: 'Оснащение', value: 'outfitting', aliases: ['outfitting', 'оснащение'] },
  { label: 'Верфь', value: 'shipyard', aliases: ['shipyard', 'верфь'] },
  { label: 'Ремонт', value: 'repair', aliases: ['repair', 'ремонт'] },
  { label: 'Заправка', value: 'refuel', aliases: ['refuel', 'заправка'] },
  { label: 'Пополнение боезапаса', value: 'rearm', aliases: ['rearm', 'restock', 'пополнениебоезапаса'] },
  { label: 'Чёрный рынок', value: 'blackmarket', aliases: ['blackmarket', 'чёрныйрынок', 'черныйрынок'] },
  { label: 'Universal Cartographics', value: 'exploration', aliases: ['exploration', 'universalcartographics', 'картография'] },
  { label: 'Vista Genomics', value: 'vistagenomics', aliases: ['vistagenomics', 'genomics'] },
  { label: 'Поиск и спасение', value: 'searchrescue', aliases: ['searchrescue', 'searchandrescue', 'поискиспасение'] },
  { label: 'Комната отдыха экипажа', value: 'crewlounge', aliases: ['crewlounge', 'комнатаотдыхаэкипажа'] },
  { label: 'Тюнинг', value: 'tuning', aliases: ['tuning', 'livery', 'тюнинг'] },
  { label: 'Pioneer Supplies', value: 'pioneersupplies', aliases: ['pioneersupplies'] },
  { label: 'Frontline Solutions', value: 'frontlinesolutions', aliases: ['frontlinesolutions'] },
  { label: 'Apex Interstellar', value: 'apexinterstellar', aliases: ['apexinterstellar'] },
  { label: 'Бармен', value: 'bartender', aliases: ['bartender', 'бармен'] },
  { label: 'Администрация авианосцев', value: 'carriermanagement', aliases: ['carriermanagement', 'carrieradministration', 'администрацияавианосцев'] },
  { label: 'Погашение ваучеров', value: 'voucherredemption', aliases: ['voucherredemption', 'redemptionoffice', 'погашениеваучеров'] },
];
export function searchKey(value: string) { return value.toLowerCase().replace(/[\s_\-.$;()]/g, ''); }
export function serviceAliases(value: string) {
  const key = searchKey(value);
  const option = SERVICE_OPTIONS.find((o) => searchKey(o.label) === key || o.aliases.includes(key));
  return option ? option.aliases : [value];
}
export function serviceLabel(value: string) {
  const key = searchKey(value);
  const option = SERVICE_OPTIONS.find((o) => o.aliases.includes(key))
    // «Interstellar Factors Contact», «Search and Rescue» и т. п. от EDSM и Spansh.
    ?? SERVICE_OPTIONS.find((o) => o.aliases.some((alias) => /^[a-z]+$/.test(alias) && alias.length >= 6 && key.includes(alias)));
  return option?.label || value;
}

/**
 * Ключ точного совпадения — как `station_item_key` в базе и `commodityKey`:
 * без `$…_name;`, только латиница и цифры. `$steel_name;`, `steel` и `Steel`
 * дают один ключ.
 */
export function stationItemKey(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^\$/, '').replace(/_name;?$/, '').replace(/[^a-z0-9]/g, '');
}

/** Совпадает ли позиция ассортимента с ключами точного выбора. */
export function stationItemMatchesKeys(item: Partial<StationSearchItem>, keys: Iterable<string>): boolean {
  const wanted = new Set(keys);
  if (!wanted.size) return true;
  return [item.name, item.symbol, item.id].some((value) => {
    const key = stationItemKey(value);
    return key !== '' && wanted.has(key);
  });
}

function itemPrice(item: StationSearchItem): number | null {
  const value = item.price ?? item.buyPrice;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Запасной путь без миграции 20261022120000: строки прежнего плоского поиска
 * (станция + товар) сводятся в станции в порядке выдачи. Точный выбор
 * дочищается здесь же — прежняя функция ищет только по вхождению.
 */
export function groupStationRows(
  rows: StationSearchResult[],
  options: { exactKeys?: string[]; itemLimit?: number; display?: (item: StationSearchItem) => { display: string; hint?: string } } = {},
): StationSearchStation[] {
  const keys = (options.exactKeys ?? []).map(stationItemKey).filter(Boolean);
  const limit = options.itemLimit ?? STATION_ITEM_LIMIT;
  const stations = new Map<string, StationSearchStation>();
  for (const row of rows) {
    if (keys.length && !stationItemMatchesKeys(row.item, keys)) continue;
    let station = stations.get(row.station_key);
    if (!station) {
      station = {
        station_key: row.station_key, station_name: row.station_name, station_type: row.station_type ?? null,
        system_name: row.system_name, market_id: row.market_id ?? null, x: row.x, y: row.y, z: row.z,
        distance: row.distance, metadata: row.metadata ?? {}, observed_at: row.observed_at,
        source: row.source, stale: row.stale, items: [], item_count: 0, best_price: null,
      };
      stations.set(row.station_key, station);
    }
    station.item_count += 1;
    const price = itemPrice(row.item);
    if (price != null && (station.best_price == null || price < station.best_price)) station.best_price = price;
    if (station.items.length < limit) {
      const label = options.display?.(row.item) ?? { display: row.item_display || row.item.name };
      station.items.push({ ...row.item, ...label });
    }
  }
  return [...stations.values()];
}

export function hasStationCoordinates(row: { x: unknown; y: unknown; z: unknown }): row is { x: number; y: number; z: number } {
  return [row.x, row.y, row.z].every((n) => typeof n === 'number' && Number.isFinite(n));
}
/**
 * Атлас на вкладке «Поблизости» с наведением на систему станции — общей
 * ссылкой `atlasSystemHref` (как из карточки системы). Координаты проверяются
 * строго: `null` — это «неизвестно», а не ноль.
 */
export function stationAtlasLink(row: Pick<StationSearchResult, 'system_name' | 'x' | 'y' | 'z'>): string | null {
  if (!row.system_name.trim() || !hasStationCoordinates(row)) return null;
  return atlasSystemHref(row.system_name, { tab: 'nearby', point: row, from: 'stations' });
}
export function atlasFocusFromParams(params: Pick<URLSearchParams, 'get'>) {
  const name = params.get('focus_system')?.trim();
  const values = ['x', 'y', 'z'].map((key) => params.get(key));
  if (!name || name.length > 200 || values.some((value) => value == null || value.trim() === '')) return null;
  const [x, y, z] = values.map(Number);
  return [x, y, z].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000) ? { name, x, y, z } : null;
}
