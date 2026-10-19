/** Canonical station reports. Missing inventory is unknown, [] is a complete empty snapshot. */
import { z } from 'zod';
import { resolveCommodity } from './commodities.ts';
import { ENGINEERS } from './engineers/data.ts';
import { parseSymbol } from './outfitting/fdnames.ts';
import { moduleGrade } from './outfitting/moduleGrades.ts';

const name = z.string().trim().min(1).max(200);
const time = z.string().datetime({ offset: true }).refine((s) => Date.parse(s) <= Date.now() + 300_000, 'Future observation');
const quantity = z.number().finite().nonnegative().max(1e15);
const item = z.object({
  name,
  buyPrice: quantity.optional(), sellPrice: quantity.optional(),
  stock: quantity.optional(), demand: quantity.optional(), price: quantity.optional(),
  symbol: z.string().max(200).optional(),
  class: z.union([z.string().max(10), z.number().int()]).optional(),
  rating: z.string().max(10).optional(), category: z.string().max(100).optional(),
  ship: z.string().max(100).optional(),
  id: z.union([z.string().max(100), z.number().int().safe()]).optional(),
});
const snapshot = z.object({ observed_at: time, items: z.array(item).max(5000) });
export const stationReportSchema = z.object({
  system_name: name, station_name: name,
  market_id: z.string().regex(/^\d{1,20}$/).optional(),
  x: z.number().finite().min(-100000).max(100000).optional(),
  y: z.number().finite().min(-100000).max(100000).optional(),
  z: z.number().finite().min(-100000).max(100000).optional(),
  population: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  station_type: z.string().max(100).optional(),
  metadata: z.object({
    body_name: z.string().max(200).optional(), body_id: z.number().int().optional(),
    distance_to_arrival: quantity.optional(),
    latitude: z.number().min(-90).max(90).optional(), longitude: z.number().min(-180).max(180).optional(),
    local_position: z.object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() }).optional(),
    services: z.array(z.string().max(100)).max(100).optional(),
    engineers: z.array(z.string().max(200)).max(20).optional(),
  }).default({}),
  observed_at: time,
  inventories: z.object({ market: snapshot.optional(), outfitting: snapshot.optional(), shipyard: snapshot.optional() }).default({}),
});
export type StationReport = z.infer<typeof stationReportSchema>;
export type CommerceSource = 'colonial-helper' | 'edsm' | 'spansh' | 'eddn';
export const COMMERCE_SOURCE_RANK: Record<string, number> = { 'colonial-helper': 4, eddn: 3, edsm: 2, spansh: 1 };
export const INVENTORY_TTL_MS = 60 * 60 * 1000;

export function stationKey(report: Pick<StationReport, 'market_id' | 'system_name' | 'station_name'>): string {
  return report.market_id ? `market:${report.market_id}`
    : `name:${report.system_name.trim().toLowerCase()}:${report.station_name.trim().toLowerCase()}`;
}

export function canonicalReport(input: unknown, source: CommerceSource) {
  const report = stationReportSchema.parse(input);
  const stationNameKey = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const known = ENGINEERS.filter((engineer) => engineer.system.toLowerCase() === report.system_name.toLowerCase()
    && stationNameKey(engineer.station) === stationNameKey(report.station_name));
  if (known.length) report.metadata.engineers = Array.from(new Set([...(report.metadata.engineers || []), ...known.map((engineer) => engineer.name)]));
  if (report.inventories.market) {
    report.inventories.market.items = report.inventories.market.items.map((item) => ({ ...item, name: resolveCommodity(item.name) }));
  }
  if (report.inventories.outfitting) {
    report.inventories.outfitting.items = report.inventories.outfitting.items.map((item) => {
      // Справочник FDevIDs раньше разбора символа: у орудий в символе нет рейтинга.
      const symbol = item.symbol || item.name;
      const grade = moduleGrade(symbol) ?? parseSymbol(symbol);
      return grade ? { ...item, class: item.class ?? grade.class, rating: item.rating ?? grade.rating } : item;
    });
  }
  return { ...report, station_key: stationKey(report), source };
}

interface CommerceClient {
  rpc(name: string, params: Record<string, unknown>): PromiseLike<{ data?: any; error?: { message: string } | null }>;
}
export async function saveStationReport(client: CommerceClient, input: unknown, source: CommerceSource) {
  const report = canonicalReport(input, source);
  const { error } = await client.rpc('save_station_commerce', { report });
  if (error) throw new Error(`Station commerce: ${error.message}`);
  return report;
}

export async function knownMarketSystems(client: CommerceClient, center: { x: number; y: number; z: number }, radius: number) {
  const { data, error } = await client.rpc('nearby_commerce_systems', { cx: center.x, cy: center.y, cz: center.z, radius_ly: radius });
  if (error) throw new Error(error.message);
  return (data || []).map((row: any) => ({ name: row.system_name, coords: { x: row.x, y: row.y, z: row.z }, distance: row.distance }));
}

/** Normalize EDSM metadata; updateTime is observation time, never the HTTP fetch time. */
export function edsmStationReport(system: { name: string; x: number; y: number; z: number }, station: any): StationReport {
  const date = station.updateTime?.information || station.updateTime?.market || station.updateTime;
  const observed_at = validTime(date) || new Date().toISOString();
  return stationReportSchema.parse({
    system_name: system.name, station_name: station.name,
    market_id: station.marketId != null ? String(station.marketId) : undefined,
    x: system.x, y: system.y, z: system.z, station_type: station.type,
    observed_at,
    metadata: {
      body_name: station.body?.name, body_id: station.body?.id,
      latitude: station.body?.latitude ?? station.latitude ?? undefined, longitude: station.body?.longitude ?? station.longitude ?? undefined,
      distance_to_arrival: station.distanceToArrival ?? undefined,
      services: Array.from(new Set([...(station.otherServices || []), ...(station.haveMarket ? ['commodities'] : []), ...(station.haveOutfitting ? ['outfitting'] : []), ...(station.haveShipyard ? ['shipyard'] : [])])),
    },
  });
}

type InventoryItem = z.infer<typeof item>;

/**
 * Список модулей или кораблей из ответа EDSM `/api-system-v1/stations/{outfitting|shipyard}`.
 * Модули лежат в `outfitting: [{ id: 'int_hyperdrive_size5_class5', name: '5A Frame Shift Drive' }]`
 * (id — игровой символ, бывает null), корабли — в `ships: [{ id: 128049249, name: 'Sidewinder' }]`
 * (id — FDevID). Символ модуля идёт в `symbol`: по нему `canonicalReport` берёт класс и рейтинг,
 * а поиск по станциям — точное совпадение. Без списка в ответе — null (данных нет), [] — пустой снимок.
 */
export function edsmInventoryItems(kind: 'outfitting' | 'shipyard', response: unknown): InventoryItem[] | null {
  const list = (response as Record<string, unknown> | null)?.[kind === 'outfitting' ? 'outfitting' : 'ships'];
  if (!Array.isArray(list)) return null;
  return list.flatMap((entry: any): InventoryItem[] => {
    if (typeof entry === 'string') return entry.trim() ? [{ name: entry.trim().slice(0, 200) }] : [];
    const symbol = kind === 'outfitting' && typeof entry?.id === 'string' && /^[A-Za-z0-9_]{1,200}$/.test(entry.id) ? entry.id : undefined;
    const name = (typeof entry?.name === 'string' && entry.name.trim() ? entry.name.trim() : symbol ?? '').slice(0, 200);
    if (!name) return [];
    if (kind === 'outfitting') return [{ name, ...(symbol ? { symbol } : {}) }];
    return [{ name, ...(Number.isSafeInteger(entry?.id) ? { id: entry.id as number } : {}) }];
  });
}

export function validTime(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  // EDSM uses UTC dates without an explicit zone.
  const normalized = /Z$|[+-]\d\d:\d\d$/.test(value) ? value : value.replace(' ', 'T') + 'Z';
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) && ms <= Date.now() + 300_000 ? new Date(ms).toISOString() : undefined;
}

/** Rich Spansh records. Brief systems.json.gz has no station/inventory fields. */
export function spanshStationReports(system: any): StationReport[] {
  const coords = system.coords;
  if (!system.name || !coords || ![coords.x, coords.y, coords.z].every(Number.isFinite)) return [];
  const stations = [...(Array.isArray(system.stations) ? system.stations : []),
    ...(Array.isArray(system.bodies) ? system.bodies.flatMap((body: any) =>
      (Array.isArray(body.stations) ? body.stations : []).map((s: any) => ({ ...s, bodyName: body.name, bodyId: body.bodyId }))) : [])];
  return stations.flatMap((station: any) => {
    const observed_at = validTime(station.updateTime || system.updateTime || system.date);
    if (!observed_at || !station.name) return [];
    const inventories: StationReport['inventories'] = {};
    for (const [kind, field] of [['market', 'market'], ['outfitting', 'outfitting'], ['shipyard', 'shipyard']] as const) {
      const raw = station[field];
      const list = Array.isArray(raw) ? raw : raw?.[kind === 'market' ? 'commodities' : kind === 'outfitting' ? 'modules' : 'ships'];
      const stamp = validTime(raw?.updateTime || station[`${field}UpdateTime`] || station.updateTime || system.updateTime || system.date);
      if (Array.isArray(list) && stamp) {
        inventories[kind] = { observed_at: stamp, items: list.map((i: any) => typeof i === 'string' ? { name: i } : ({
          name: i.name || i.symbol, symbol: i.symbol, id: i.commodityId ?? i.moduleId ?? i.shipId,
          class: i.class, rating: i.rating, category: typeof i.category === 'string' ? i.category : undefined, ship: i.ship ?? undefined, ...(kind === 'market' ? {
            buyPrice: i.buyPrice, sellPrice: i.sellPrice, stock: i.supply ?? i.stock, demand: i.demand,
          } : { price: i.price }),
        })) };
      }
    }
    const parsed = stationReportSchema.safeParse({
      system_name: system.name, station_name: station.name, market_id: (station.marketId ?? station.id) != null ? String(station.marketId ?? station.id) : undefined,
      ...coords, population: system.population ?? undefined, station_type: station.type, observed_at, inventories,
      metadata: { body_name: station.bodyName, body_id: station.bodyId, // Spansh's published full-dump schema specifies kilometres; our field is light-seconds.
        distance_to_arrival: station.distanceToArrival != null ? station.distanceToArrival / 299792.458 : undefined,
        latitude: station.latitude ?? undefined, longitude: station.longitude ?? undefined, services: station.services },
    });
    return parsed.success ? [parsed.data] : [];
  });
}

/** A single rich system transaction; returns null for the brief/uninhabited dump. */
export function spanshCommercePayload(system: any) {
  const reports = spanshStationReports(system).map((report) => canonicalReport(report, 'spansh'));
  const observed_at = validTime(system.date || system.updateTime);
  const population = Number.isSafeInteger(system.population) && system.population >= 0 ? system.population : undefined;
  if (!reports.length && !(population && population > 0)) return null;
  if (!observed_at || !system.name || !system.coords || ![system.coords.x, system.coords.y, system.coords.z].every(Number.isFinite)) return null;
  return { system_name: system.name, ...system.coords, population, observed_at, reports };
}
