/**
 * Строки `fleet_carriers` → отметки карты (`GET /api/map/carriers`).
 * Чистые функции: всё, что решает, какой носитель попадёт на карту и что о нём
 * увидит конкретный зритель.
 *
 * Правила:
 *   * отметка носителя открыта всем — в игре носитель и его имя видит любой
 *     пилот в системе, и публичная карточка (`/api/carriers/{id}`) уже их
 *     показывает; груза и финансов в ответе карты нет никогда;
 *   * имя владельца — только если он не закрыл «местоположение» в настройках
 *     приватности (себя пилот видит всегда) — так же, как слой пилотов;
 *   * «эскадрилья» — носитель привязан к эскадрилье зрителя или принадлежит
 *     её участнику, который не скрыл местоположение;
 *   * местоположение — как в карточке (`buildCarrierView`): через пять минут
 *     после вылета носитель считается в системе назначения (с пометкой «≈»);
 *   * не показываются носители без известной системы, списанные (флаг
 *     списания старше восьми дней — в игре носитель разбирают через неделю)
 *     и «ничьи» носители (без владельца и эскадрильи на сайте), о которых
 *     ничего не слышно дольше 30 дней.
 */

import { buildCarrierView, serviceLabel } from './fleetCarriers.ts';
import { privacyForViewer } from './privacy.ts';
import {
  carrierSystemKey,
  isMapPoint,
  type CarrierJumpHistoryEntry,
  type MapCarrier,
  type MapCarrierRelation,
  type MapPoint,
} from './carrierMap.ts';

/** Через сколько после флага списания носитель считается разобранным. */
export const SCRAP_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
/** Сколько держать на карте носитель без владельца и эскадрильи на сайте. */
export const UNBOUND_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Колонки реестра EDDN для слоя карты. `previous_*` появились вместе с
 * миграцией `20261110090000_carrier_directory_route.sql`; на установке без неё
 * запрос падает целиком, поэтому есть базовый набор и запасной путь
 * (`carrierMapStore.loadDirectoryRows`).
 */
export const DIRECTORY_COLUMNS = [
  'carrier_id', 'callsign', 'name', 'carrier_type', 'system_name', 'system_address', 'body_name',
  'x', 'y', 'z', 'services', 'updated_at', 'last_seen_at',
  'previous_system_name', 'previous_x', 'previous_y', 'previous_z',
].join(', ');
export const DIRECTORY_COLUMNS_BASE = [
  'carrier_id', 'callsign', 'name', 'carrier_type', 'system_name', 'system_address', 'body_name',
  'x', 'y', 'z', 'services', 'updated_at', 'last_seen_at',
].join(', ');

/** Колонки, которые нужны карте (без груза, финансов и ордеров). */
export const MAP_CARRIER_COLUMNS = [
  'carrier_id', 'carrier_type', 'callsign', 'name', 'owner_id', 'squadron_id',
  'system_name', 'system_address', 'body_name', 'x', 'y', 'z', 'location_at', 'location_source',
  'jump_system_name', 'jump_system_address', 'jump_body_name', 'jump_departure_at', 'jump_requested_at',
  'docking_access', 'allow_notorious', 'pending_decommission', 'decommission_at',
  'services', 'station_services', 'updated_at',
].join(', ');

/** Службы, которые стоит показать на карте (капитан и служебные пункты Docked — нет). */
const MAP_SERVICE_ROLES = [
  'commodities', 'refuel', 'repair', 'rearm', 'shipyard', 'outfitting', 'exploration',
  'voucherredemption', 'blackmarket', 'carrierfuel', 'vistagenomics', 'pioneersupplies', 'bartender', 'squadronbank',
];
const MAP_SERVICE_SET = new Set(MAP_SERVICE_ROLES);

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

export interface MapCarrierContext {
  viewerId: string | null;
  viewerSquadronIds: number[];
  /** Участники эскадрилий зрителя (по ним — «носитель эскадрильи»). */
  squadronMateIds: ReadonlySet<string>;
  owners: ReadonlyMap<string, { cmdrName: string | null; privacy: unknown }>;
  squadrons: ReadonlyMap<number, { name: string | null; tag: string | null }>;
  /** Координаты систем по `carrierSystemKey`. */
  coordinates: ReadonlyMap<string, MapPoint>;
  /**
   * История прыжков по MarketID: строки `carrier_jump_history`, свежие сверху.
   * Носителя без записи здесь нет — карта это переживёт, история просто пустая.
   */
  history?: ReadonlyMap<string, readonly CarrierJumpHistoryEntry[]>;
  now: Date;
}

function timeMs(value: unknown): number {
  if (value == null || value === '') return NaN;
  return Date.parse(String(value));
}

function viewOf(row: Row, now: Date) {
  return buildCarrierView(row, { relation: 'public', showFinance: false, now });
}

/** Носитель должен попасть на карту (без учёта зрителя и фильтров). */
export function isMapCarrierRow(row: Row, now: Date): boolean {
  const nowMs = now.getTime();
  if (row.pending_decommission === true) {
    const flaggedAt = timeMs(row.decommission_at);
    if (Number.isFinite(flaggedAt) && nowMs - flaggedAt > SCRAP_AFTER_MS) return false;
  }
  if (!row.owner_id && row.squadron_id == null) {
    const seenAt = timeMs(row.location_at);
    if (!Number.isFinite(seenAt) || nowMs - seenAt > UNBOUND_MAX_AGE_MS) return false;
  }
  return Boolean(viewOf(row, now).location.system);
}

/** Координаты, известные из самих строк: система стоянки → x/y/z журнала. */
export function rowCoordinates(rows: readonly Row[], now: Date): Map<string, MapPoint> {
  const known = new Map<string, MapPoint>();
  for (const row of rows) {
    const view = viewOf(row, now);
    if (view.location.coords && view.location.system) {
      const key = carrierSystemKey(view.location.system);
      if (key && !known.has(key)) known.set(key, view.location.coords);
    }
  }
  return known;
}

/** Системы, чьи координаты нужно найти: стоянка без x/y/z и цели прыжков. */
export function coordinateNamesNeeded(rows: readonly Row[], now: Date, known: ReadonlyMap<string, MapPoint> = new Map()): string[] {
  const names = new Map<string, string>();
  const need = (name: string | null | undefined) => {
    const key = carrierSystemKey(name);
    if (key && !known.has(key) && !names.has(key)) names.set(key, String(name).trim());
  };
  for (const row of rows) {
    const view = viewOf(row, now);
    if (!view.location.coords) need(view.location.system);
    if (view.jump) need(view.jump.system);
    // Откуда носитель пришёл — тоже нужно: по этой точке рисуется линия.
    if (view.location.previousSystem) need(view.location.previousSystem);
  }
  return Array.from(names.values());
}

function services(view: ReturnType<typeof viewOf>): string[] {
  const crew = view.services.filter((service) => service.activated && service.enabled && MAP_SERVICE_SET.has(service.role.toLowerCase()));
  const roles = crew.length
    ? crew.map((service) => service.role.toLowerCase())
    // Службы экипажа приходят из Carrier Management владельца; любой
    // состыковавшийся пилот передаёт хотя бы список станции из Docked.
    : view.stationServices.map((service) => service.toLowerCase()).filter((service) => MAP_SERVICE_SET.has(service));
  const unique = Array.from(new Set(roles));
  unique.sort((left, right) => MAP_SERVICE_ROLES.indexOf(left) - MAP_SERVICE_ROLES.indexOf(right));
  return unique.map(serviceLabel);
}

function relationOf(ownerId: string | null, squadronId: number | null, ownerVisible: boolean, context: MapCarrierContext): MapCarrierRelation {
  if (context.viewerId && ownerId === context.viewerId) return 'own';
  if (squadronId != null && context.viewerSquadronIds.includes(squadronId)) return 'squadron';
  if (ownerId && ownerVisible && context.squadronMateIds.has(ownerId)) return 'squadron';
  return 'other';
}

export function shapeMapCarrier(row: Row, context: MapCarrierContext): MapCarrier | null {
  const view = viewOf(row, context.now);
  const system = view.location.system;
  if (!system) return null;

  const ownerId = row.owner_id ? String(row.owner_id) : null;
  const owner = ownerId ? context.owners.get(ownerId) : undefined;
  const ownerVisible = ownerId ? privacyForViewer(owner?.privacy, context.viewerId, ownerId).location : false;
  const squadronId = row.squadron_id == null || !Number.isFinite(Number(row.squadron_id)) ? null : Number(row.squadron_id);
  const squadron = squadronId == null ? null : context.squadrons.get(squadronId) ?? null;

  const coordinates = (name: string) => context.coordinates.get(carrierSystemKey(name)) ?? null;
  const position = view.location.coords && isMapPoint(view.location.coords) ? view.location.coords : coordinates(system);

  return {
    id: view.carrierId,
    type: view.type,
    callsign: view.callsign,
    name: view.name,
    relation: relationOf(ownerId, squadronId, ownerVisible, context),
    owner: ownerVisible ? owner?.cmdrName?.trim() || null : null,
    ownerHidden: Boolean(ownerId) && !ownerVisible,
    squadron: squadronId == null ? null : {
      id: squadronId,
      name: squadron?.name ?? null,
      tag: squadron?.tag ?? null,
      member: context.viewerSquadronIds.includes(squadronId),
    },
    system,
    body: view.location.body,
    position,
    locationAt: view.location.at,
    estimated: view.location.estimated,
    previousSystem: view.location.previousSystem,
    previousPosition: view.location.previousSystem ? coordinates(view.location.previousSystem) : null,
    jump: view.jump ? {
      system: view.jump.system,
      departureAt: view.jump.departureAt,
      state: view.jump.state,
      position: coordinates(view.jump.system),
    } : null,
    docking: view.status.dockingLabel,
    notorious: view.status.allowNotorious,
    services: services(view),
    decommission: view.status.pendingDecommission,
    origin: 'site',
    history: context.history?.get(view.carrierId) ?? [],
  };
}

export function shapeMapCarriers(rows: readonly Row[], context: MapCarrierContext): MapCarrier[] {
  const carriers: MapCarrier[] = [];
  for (const row of rows) {
    if (!isMapCarrierRow(row, context.now)) continue;
    const carrier = shapeMapCarrier(row, context);
    if (carrier) carriers.push(carrier);
  }
  return carriers;
}

/* ── Реестр EDDN (`carrier_directory`) ─────────────────────────────────────── */

/** Службы реестра — те же подписи, что у носителей сайта. */
function directoryServices(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roles = Array.from(new Set(value
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase() : ''))
    .filter((entry) => entry && MAP_SERVICE_SET.has(entry)))) as string[];
  // Службы экипажа из Carrier Management приходят как `Commodities` — сравнение регистронезависимое.
  roles.sort((left, right) => MAP_SERVICE_ROLES.indexOf(left) - MAP_SERVICE_ROLES.indexOf(right));
  return roles.map(serviceLabel);
}

/** Время строки — ISO; PostgREST отдаёт строку, драйвер теста может отдать `Date`. */
function directoryTime(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function directoryPoint(row: Row, prefix = ''): MapPoint | null {
  const point = { x: Number(row[`${prefix}x`]), y: Number(row[`${prefix}y`]), z: Number(row[`${prefix}z`]) };
  const has = [row[`${prefix}x`], row[`${prefix}y`], row[`${prefix}z`]]
    .every((value) => value != null && Number.isFinite(Number(value)));
  return has && isMapPoint(point) ? point : null;
}

/**
 * Строка реестра EDDN → отметка карты.
 *
 * Отметка честно беднее, чем у носителей сайта: владельца, эскадрильи,
 * стыковки и заказанного прыжка в EDDN нет (`CarrierJump` — это уже
 * случившийся прыжок). Зато есть след: откуда носитель пришёл, — и по нему
 * карта рисует маршрут.
 */
export function shapeDirectoryCarrier(
  row: Row,
  coordinates: ReadonlyMap<string, MapPoint>,
  history: ReadonlyMap<string, readonly CarrierJumpHistoryEntry[]> = new Map(),
): MapCarrier | null {
  const system = typeof row.system_name === 'string' ? row.system_name.trim() : '';
  if (!system) return null;
  const key = carrierSystemKey(system);
  if (!key) return null;
  const position = directoryPoint(row) ?? coordinates.get(key) ?? null;
  const previousSystem = typeof row.previous_system_name === 'string' && row.previous_system_name.trim()
    ? row.previous_system_name.trim()
    : null;
  const previousPosition = previousSystem
    ? directoryPoint(row, 'previous_') ?? coordinates.get(carrierSystemKey(previousSystem)) ?? null
    : null;
  const at = directoryTime(row.last_seen_at) ?? directoryTime(row.updated_at);

  return {
    id: String(row.carrier_id),
    type: row.carrier_type === 'SquadronCarrier' ? 'SquadronCarrier' : 'FleetCarrier',
    callsign: typeof row.callsign === 'string' && row.callsign.trim() ? row.callsign.trim() : null,
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim() : null,
    relation: 'other',
    owner: null,
    ownerHidden: false,
    squadron: null,
    system,
    body: typeof row.body_name === 'string' && row.body_name.trim() ? row.body_name.trim() : null,
    position,
    locationAt: at,
    estimated: false,
    previousSystem,
    previousPosition,
    jump: null,
    docking: null,
    notorious: null,
    services: directoryServices(row.services),
    decommission: false,
    origin: 'eddn',
    history: history.get(String(row.carrier_id)) ?? [],
  };
}

/**
 * Отметки реестра для слоя карты. Записи учёта сайта главнее: носитель,
 * который уже есть на карте, второй раз не появляется.
 */
export function shapeDirectoryCarriers(
  rows: readonly Row[],
  context: {
    coordinates: ReadonlyMap<string, MapPoint>;
    knownIds?: ReadonlySet<string>;
    seenAfter?: number;
    history?: ReadonlyMap<string, readonly CarrierJumpHistoryEntry[]>;
  },
): MapCarrier[] {
  const carriers: MapCarrier[] = [];
  const taken = new Set(context.knownIds ?? []);
  for (const row of rows) {
    if (row?.carrier_id == null) continue;
    const id = String(row.carrier_id);
    if (taken.has(id)) continue;
    const at = Date.parse(String(row.updated_at ?? ''));
    if (context.seenAfter != null && (!Number.isFinite(at) || at < context.seenAfter)) continue;
    const carrier = shapeDirectoryCarrier(row, context.coordinates, context.history);
    if (!carrier) continue;
    taken.add(id);
    carriers.push(carrier);
  }
  return carriers;
}

/** Системы реестра без координат — их стоит поискать в каталогах. */
export function directoryCoordinateNames(rows: readonly Row[], known: ReadonlyMap<string, MapPoint>): string[] {
  const names = new Map<string, string>();
  const need = (value: unknown) => {
    const name = typeof value === 'string' ? value.trim() : '';
    const key = carrierSystemKey(name);
    if (key && !known.has(key) && !names.has(key)) names.set(key, name);
  };
  for (const row of rows) {
    if (!directoryPoint(row)) need(row.system_name);
    if (row.previous_system_name && !directoryPoint(row, 'previous_')) need(row.previous_system_name);
  }
  return Array.from(names.values());
}
