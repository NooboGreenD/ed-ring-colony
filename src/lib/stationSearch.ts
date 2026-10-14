import { z } from 'zod';

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
});
export type StationSearchKind = z.infer<typeof stationSearchSchema>['kind'];
export interface StationSearchResult {
  station_key: string; station_name: string; station_type: string | null; system_name: string;
  market_id: string | null; x: number | null; y: number | null; z: number | null;
  distance: number | null; metadata: { body_name?: string; distance_to_arrival?: number; latitude?: number; longitude?: number; services?: string[]; engineers?: string[] };
  item: { name: string; symbol?: string; class?: number | string; rating?: string; buyPrice?: number; sellPrice?: number; price?: number; stock?: number; demand?: number };
  item_display?: string; observed_at: string; source: string; stale: boolean;
}

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
  { label: 'Пополнение боезапаса', value: 'rearm', aliases: ['rearm', 'пополнениебоезапаса'] },
  { label: 'Чёрный рынок', value: 'blackmarket', aliases: ['blackmarket', 'чёрныйрынок', 'черныйрынок'] },
  { label: 'Universal Cartographics', value: 'exploration', aliases: ['exploration', 'universalcartographics', 'картография'] },
  { label: 'Vista Genomics', value: 'vistagenomics', aliases: ['vistagenomics', 'genomics'] },
];
export function searchKey(value: string) { return value.toLowerCase().replace(/[\s_\-.$;()]/g, ''); }
export function serviceAliases(value: string) {
  const key = searchKey(value);
  const option = SERVICE_OPTIONS.find((o) => searchKey(o.label) === key || o.aliases.includes(key));
  return option ? option.aliases : [value];
}
export function serviceLabel(value: string) {
  const option = SERVICE_OPTIONS.find((o) => o.aliases.includes(searchKey(value)));
  return option?.label || value;
}
export function hasStationCoordinates(row: { x: unknown; y: unknown; z: unknown }): row is { x: number; y: number; z: number } {
  return [row.x, row.y, row.z].every((n) => typeof n === 'number' && Number.isFinite(n));
}
export function stationAtlasLink(row: Pick<StationSearchResult, 'system_name' | 'x' | 'y' | 'z'>): string | null {
  if (!row.system_name.trim() || !hasStationCoordinates(row)) return null;
  const params = new URLSearchParams({ tab: 'nearby', focus_system: row.system_name, x: String(row.x), y: String(row.y), z: String(row.z) });
  return `/atlas?${params}`;
}
export function atlasFocusFromParams(params: Pick<URLSearchParams, 'get'>) {
  const name = params.get('focus_system')?.trim();
  const values = ['x', 'y', 'z'].map((key) => params.get(key));
  if (!name || name.length > 200 || values.some((value) => value == null || value.trim() === '')) return null;
  const [x, y, z] = values.map(Number);
  return [x, y, z].every((n) => Number.isFinite(n) && Math.abs(n) <= 100000) ? { name, x, y, z } : null;
}
