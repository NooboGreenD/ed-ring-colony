/**
 * Данные слоя «Авианосцы» карты галактики: чтение `fleet_carriers` через
 * service_role и поиск координат систем, где стоят носители.
 *
 * Права и приватность решает `carrierMapView.ts`; здесь — только загрузка.
 *
 * Координаты системы берутся по порядку:
 *   1. x/y/z из самой строки носителя (журнал с StarPos) — и для соседей по
 *      системе тоже;
 *   2. локальные каталоги: `galaxy_systems` (Spansh), `commerce_systems`,
 *      `colonisation_market_systems`, системы маршрута и хабы;
 *   3. EDSM — пачками по 25, не больше 50 систем за запрос.
 * Найденное держится в памяти процесса (координаты систем не меняются);
 * систему, которую не нашёл и EDSM, не спрашиваем повторно 15 минут — карта
 * опрашивает слой раз в минуту у каждого открытого окна.
 */

import { readAllRows } from './readAllRows.ts';
import { viewerContext } from './fleetCarrierStore';
import { carrierSystemKey, isMapPoint, type MapCarriersResponse, type MapPoint } from './carrierMap.ts';
import {
  MAP_CARRIER_COLUMNS,
  coordinateNamesNeeded,
  isMapCarrierRow,
  rowCoordinates,
  shapeMapCarriers,
} from './carrierMapView.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
type Row = Record<string, any>;

const IN_CHUNK = 100;
const EDSM_BATCH = 25;
const EDSM_MAX_NAMES = 50;
const EDSM_TIMEOUT_MS = 5000;
const HIT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MISS_TTL_MS = 15 * 60 * 1000;
const CACHE_LIMIT = 5000;

const coordinateCache = new Map<string, { point: MapPoint | null; at: number }>();

/** Для тестов: забыть найденные координаты. */
export function resetCarrierMapCache(): void {
  coordinateCache.clear();
}

function remember(key: string, point: MapPoint | null, now: number) {
  coordinateCache.delete(key);
  coordinateCache.set(key, { point, at: now });
  while (coordinateCache.size > CACHE_LIMIT) {
    const oldest = coordinateCache.keys().next().value;
    if (oldest === undefined) break;
    coordinateCache.delete(oldest);
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function pointOf(row: Row | null | undefined): MapPoint | null {
  if (!row) return null;
  const point = { x: Number(row.x), y: Number(row.y), z: Number(row.z) };
  return row.x != null && row.y != null && row.z != null && isMapPoint(point) ? point : null;
}

/** Таблица может отсутствовать на старой установке — тогда источник просто пропускается. */
async function safeRows(query: PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await query;
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function lookupLocal(svc: Svc, names: string[]): Promise<Map<string, MapPoint>> {
  const found = new Map<string, MapPoint>();
  if (!names.length) return found;
  const keys = Array.from(new Set(names.map(carrierSystemKey)));
  const exact = Array.from(new Set(names));
  const byKey = (column: string, table: string, values: string[]) => Promise.all(
    chunks(values, IN_CHUNK).map((chunk) => safeRows(svc.from(table).select(`${column}, x, y, z`).in(column, chunk))),
  ).then((parts) => parts.flat());

  // Порядок источников — порядок доверия: каталог Spansh, станции, остальное.
  const sources = await Promise.all([
    byKey('name_lc', 'galaxy_systems', keys),
    byKey('name_lc', 'commerce_systems', keys),
    byKey('system_name', 'colonisation_market_systems', exact),
    byKey('system_name', 'route_systems', exact),
    byKey('system_name', 'hubs', exact),
  ]);
  for (const rows of sources) {
    for (const row of rows) {
      const key = carrierSystemKey(row.name_lc ?? row.system_name);
      const point = pointOf(row);
      if (key && point && !found.has(key)) found.set(key, point);
    }
  }
  return found;
}

async function lookupEdsm(names: string[], fetchImpl: typeof fetch): Promise<Map<string, MapPoint>> {
  const found = new Map<string, MapPoint>();
  for (const batch of chunks(names, EDSM_BATCH)) {
    const params = new URLSearchParams();
    params.append('showCoordinates', '1');
    for (const name of batch) params.append('systemName[]', name);
    try {
      const response = await fetchImpl(`https://www.edsm.net/api-v1/systems?${params.toString()}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(EDSM_TIMEOUT_MS),
        next: { revalidate: 86400 },
      } as RequestInit);
      if (!response.ok) continue;
      const data = await response.json();
      for (const item of Array.isArray(data) ? data : []) {
        const point = pointOf(item?.coords);
        if (item?.name && point) found.set(carrierSystemKey(item.name), point);
      }
    } catch (error) {
      console.error('[map/carriers] EDSM:', error instanceof Error ? error.message : error);
    }
  }
  return found;
}

export interface ResolveOptions {
  /** Подмена `fetch` (тесты); `null` — EDSM не спрашивать. */
  fetchImpl?: typeof fetch | null;
  nowMs?: number;
}

/** Координаты систем по `carrierSystemKey` — то, что удалось найти. */
export async function resolveMapCoordinates(svc: Svc, names: readonly string[], options: ResolveOptions = {}): Promise<Map<string, MapPoint>> {
  const nowMs = options.nowMs ?? Date.now();
  const result = new Map<string, MapPoint>();
  const pending: string[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = carrierSystemKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const cached = coordinateCache.get(key);
    if (cached && nowMs - cached.at < (cached.point ? HIT_TTL_MS : MISS_TTL_MS)) {
      if (cached.point) result.set(key, cached.point);
      continue;
    }
    pending.push(String(name).trim());
  }
  if (!pending.length) return result;

  const local = await lookupLocal(svc, pending);
  const stillMissing: string[] = [];
  for (const name of pending) {
    const key = carrierSystemKey(name);
    const point = local.get(key);
    if (point) {
      result.set(key, point);
      remember(key, point, nowMs);
    } else {
      stillMissing.push(name);
    }
  }

  const fetchImpl = options.fetchImpl === undefined ? (typeof fetch === 'function' ? fetch : null) : options.fetchImpl;
  if (!stillMissing.length || !fetchImpl) return result;
  const asked = stillMissing.slice(0, EDSM_MAX_NAMES);
  const remote = await lookupEdsm(asked, fetchImpl);
  for (const name of asked) {
    const key = carrierSystemKey(name);
    const point = remote.get(key) ?? null;
    if (point) result.set(key, point);
    remember(key, point, nowMs);
  }
  return result;
}

async function loadOwners(svc: Svc, ownerIds: string[]) {
  const owners = new Map<string, { cmdrName: string | null; privacy: unknown }>();
  const rows = (await Promise.all(chunks(ownerIds, IN_CHUNK).map((chunk) => safeRows(
    svc.from('profiles').select('id, cmdr_name, privacy_settings').in('id', chunk),
  )))).flat();
  for (const row of rows) {
    if (row?.id) owners.set(String(row.id), { cmdrName: row.cmdr_name ?? null, privacy: row.privacy_settings });
  }
  return owners;
}

async function loadSquadrons(svc: Svc, squadronIds: number[]) {
  const squadrons = new Map<number, { name: string | null; tag: string | null }>();
  const rows = (await Promise.all(chunks(squadronIds, IN_CHUNK).map((chunk) => safeRows(
    svc.from('squadrons').select('id, name, tag').in('id', chunk),
  )))).flat();
  for (const row of rows) {
    const id = Number(row?.id);
    if (Number.isFinite(id)) squadrons.set(id, { name: row.name ?? null, tag: row.tag ?? null });
  }
  return squadrons;
}

async function loadSquadronMates(svc: Svc, squadronIds: number[], viewerId: string | null) {
  const mates = new Set<string>();
  if (!squadronIds.length) return mates;
  const rows = await safeRows(svc.from('squadron_members').select('user_id').in('squadron_id', squadronIds));
  for (const row of rows) {
    const id = row?.user_id ? String(row.user_id) : '';
    if (id && id !== viewerId) mates.add(id);
  }
  return mates;
}

export interface LoadMapCarriersOptions extends ResolveOptions {
  now?: Date;
}

export async function loadMapCarriers(svc: Svc, viewerId: string | null, options: LoadMapCarriersOptions = {}): Promise<MapCarriersResponse> {
  const now = options.now ?? new Date();
  const read = await readAllRows<Row>((from, to) => svc
    .from('fleet_carriers')
    .select(MAP_CARRIER_COLUMNS)
    .order('carrier_id', { ascending: true })
    .range(from, to));
  if (read.error) throw new Error(read.error.message);

  const rows = read.data.filter((row) => isMapCarrierRow(row, now));
  const response: MapCarriersResponse = { carriers: [], viewer: { signedIn: Boolean(viewerId) }, generatedAt: now.toISOString() };
  if (!rows.length) return response;

  const ownerIds = Array.from(new Set(rows.map((row) => row.owner_id).filter(Boolean).map(String)));
  const squadronIds = Array.from(new Set(rows
    .map((row) => (row.squadron_id == null ? NaN : Number(row.squadron_id)))
    .filter(Number.isFinite)));

  const [viewer, owners, squadrons] = await Promise.all([
    viewerContext(svc, viewerId),
    loadOwners(svc, ownerIds),
    loadSquadrons(svc, squadronIds),
  ]);
  const squadronMateIds = await loadSquadronMates(svc, viewer.squadronIds, viewerId);

  const known = rowCoordinates(rows, now);
  const resolved = await resolveMapCoordinates(svc, coordinateNamesNeeded(rows, now, known), { fetchImpl: options.fetchImpl, nowMs: now.getTime() });
  // Координаты из журнала точнее каталогов — они перекрывают найденное.
  const coordinates = new Map<string, MapPoint>([...resolved, ...known]);

  response.carriers = shapeMapCarriers(rows, {
    viewerId,
    viewerSquadronIds: viewer.squadronIds,
    squadronMateIds,
    owners,
    squadrons,
    coordinates,
    now,
  });
  return response;
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Носители в одной системе — для карточки системы. Права и приватность те же,
 * что у слоя «Авианосцы» карты (`shapeMapCarriers`): чужой личный носитель
 * виден без имени владельца, если тот его скрыл, груза здесь нет вовсе.
 */
export async function loadSystemCarriers(
  svc: Svc,
  viewerId: string | null,
  systemName: string,
  options: { point?: MapPoint | null; now?: Date } = {},
): Promise<MapCarriersResponse['carriers']> {
  const now = options.now ?? new Date();
  const key = carrierSystemKey(systemName);
  if (!key) return [];
  // Носитель «в системе» — как на карте: стоит в ней или уже прилетел по
  // расписанному прыжку (место считает `buildCarrierView`), поэтому берём обе
  // колонки, а отбираем по вычисленной системе ниже.
  const pattern = escapeLike(systemName.trim());
  const [here, arriving] = await Promise.all([
    svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('system_name', pattern).limit(200),
    svc.from('fleet_carriers').select(MAP_CARRIER_COLUMNS).ilike('jump_system_name', pattern).limit(200),
  ]);
  if (here.error) throw new Error(here.error.message);
  const byId = new Map<string, Row>();
  for (const row of [...(Array.isArray(here.data) ? here.data : []), ...(arriving.error || !Array.isArray(arriving.data) ? [] : arriving.data)]) {
    if (row?.carrier_id != null) byId.set(String(row.carrier_id), row);
  }
  const rows = Array.from(byId.values()).filter((row) => isMapCarrierRow(row, now));
  if (!rows.length) return [];

  const ownerIds = Array.from(new Set(rows.map((row: Row) => row.owner_id).filter(Boolean).map(String))) as string[];
  const squadronIds = Array.from(new Set(rows
    .map((row: Row) => (row.squadron_id == null ? NaN : Number(row.squadron_id)))
    .filter(Number.isFinite))) as number[];
  const [viewer, owners, squadrons] = await Promise.all([
    viewerContext(svc, viewerId),
    loadOwners(svc, ownerIds),
    loadSquadrons(svc, squadronIds),
  ]);
  const squadronMateIds = await loadSquadronMates(svc, viewer.squadronIds, viewerId);
  const coordinates = new Map<string, MapPoint>(rowCoordinates(rows, now));
  if (options.point && isMapPoint(options.point) && !coordinates.has(key)) coordinates.set(key, options.point);
  return shapeMapCarriers(rows, {
    viewerId,
    viewerSquadronIds: viewer.squadronIds,
    squadronMateIds,
    owners,
    squadrons,
    coordinates,
    now,
  }).filter((carrier) => carrierSystemKey(carrier.system) === key);
}
