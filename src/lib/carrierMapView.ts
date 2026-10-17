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
import { carrierSystemKey, isMapPoint, type MapCarrier, type MapCarrierRelation, type MapPoint } from './carrierMap.ts';

/** Через сколько после флага списания носитель считается разобранным. */
export const SCRAP_AFTER_MS = 8 * 24 * 60 * 60 * 1000;
/** Сколько держать на карте носитель без владельца и эскадрильи на сайте. */
export const UNBOUND_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

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
