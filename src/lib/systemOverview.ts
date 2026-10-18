/**
 * Карточка системы — всё, что проект знает о звёздной системе, одним ответом
 * (`GET /api/systems/overview`, страница `/system/[name]`).
 *
 * До неё каждый раздел жил своей картиной системы: кольцо — кэшем Raven,
 * «Проекты систем» — своими таблицами, Атлас — слоями фракций и PowerPlay,
 * поиск станций — своей базой, авианосцы — своей. Страница системы показывала
 * только стройку и тела, а слои Атласа ссылались на неё и оставались
 * тупиками. Здесь все разделы сведены к одной системе:
 *
 *   * каталог (координаты, звезда, permit);
 *   * колонизация — прогресс по тому же правилу, что у «Проектов систем»
 *     (`buildSystemProgress`: кэш Raven + площадки из журналов + план),
 *     архитектор и опубликованные планы;
 *   * проекты эскадрилий и «Проекты систем» (последние — только участникам),
 *     кольцо колонизации (маршрут, хаб);
 *   * станции и свежесть их рынков, верфей и модулей;
 *   * минорные фракции и PowerPlay (в том числе из журналов пилотов);
 *   * авианосцы в системе — с правами и приватностью слоя карты;
 *   * цели сообщества, суммарные поставки и сканы тел;
 *   * ссылки в разделы сайта, где эту систему можно открыть дальше.
 *
 * Источник — одна SQL-функция `system_overview_sources` (миграция
 * 20261020120000) плюс авианосцы (`carrierMapStore.loadSystemCarriers`).
 */

import {
  buildSystemProgress,
  pickRavenRow,
  type DepotRow,
  type PlanRow,
  type RavenCacheRow,
  type SystemProgressView,
} from './architect/projectProgress.ts';
import { decodeSystemDetail, type BgsSystemDetail } from './bgs.ts';
import type { MapCarrier } from './carrierMap.ts';
import { loadSystemCarriers } from './carrierMapStore';
import {
  atlasSystemHref,
  cleanSystemName,
  externalSystemLinks,
  stationSearchHref,
  systemId64,
  systemKey,
  type SystemPoint,
} from './systemIdentity.ts';

type Svc = any;
type Row = Record<string, any>;

export interface SystemOverviewViewer {
  userId: string | null;
  isAdmin: boolean;
}

export interface OverviewCatalog {
  id64: string;
  name: string;
  mainStar: string | null;
  starType: string | null;
  starGiantClass: string | null;
  needsPermit: boolean | null;
  distanceFromSol: number | null;
  distanceFromSgrA: number | null;
}

export interface OverviewPlan {
  id: string;
  title: string;
  authorName: string;
  visibility: string;
  siteCount: number;
  haulTons: number;
  updatedAt: string | null;
  own: boolean;
  byArchitect: boolean;
}

export interface OverviewSquadronProject {
  id: number;
  name: string;
  status: string;
  color: string | null;
  squadron: { id: number; name: string | null; tag: string | null } | null;
  systemStatus: string;
  priority: number | null;
  targetDate: string | null;
}

export interface OverviewArchitectProject {
  id: string;
  name: string;
  status: string;
  color: string | null;
  stage: string;
  priority: number | null;
  targetDate: string | null;
  progress: number | null;
}

export interface OverviewStation {
  key: string;
  marketId: string | null;
  name: string;
  type: string | null;
  distanceLs: number | null;
  body: string | null;
  services: string[];
  engineers: string[];
  observedAt: string | null;
  source: string;
  inventories: Partial<Record<'market' | 'outfitting' | 'shipyard', { observedAt: string | null; items: number; source: string | null }>>;
  carrier: boolean;
}

export interface OverviewPowerplay {
  power: string | null;
  state: string;
  powers: string[];
  controlProgress: number | null;
  reinforcement: number | null;
  undermining: number | null;
  observedAt: string | null;
  source: string;
}

export interface OverviewGoal {
  id: number;
  title: string;
  station: string | null;
  objective: string | null;
  tier: number | null;
  tierMax: number | null;
  contributors: number | null;
  expiresAt: string | null;
  complete: boolean;
  colonisation: boolean;
}

export interface OverviewFreshness {
  source: 'raven' | 'journal' | 'stations' | 'factions' | 'powerplay' | 'carriers' | 'scans';
  label: string;
  at: string | null;
}

export interface SystemOverview {
  found: boolean;
  query: string;
  key: string;
  name: string;
  id64: string | null;
  point: SystemPoint | null;
  catalog: OverviewCatalog | null;
  colonisation: {
    progress: SystemProgressView;
    architect: { name: string; userId: string | null; isViewer: boolean } | null;
    plans: OverviewPlan[];
    /** Что-то о стройке вообще известно (Raven, журнал или план). */
    known: boolean;
  };
  projects: {
    squadron: OverviewSquadronProject[];
    /**
     * «Проекты систем», где зритель участник (админ видит все). Чужие не
     * видны совсем — даже числом: само существование закрытого проекта —
     * тоже информация (то же правило, что 404 у `/api/architect/projects/[id]`).
     */
    architect: OverviewArchitectProject[];
  };
  ring: {
    route: { id: number; order: number; status: string | null; progress: number | null } | null;
    hub: { id: number; name: string; status: string | null; progress: number | null; segment: number | null } | null;
  };
  stations: { total: number; items: OverviewStation[] };
  factions: BgsSystemDetail | null;
  powerplay: OverviewPowerplay | null;
  carriers: MapCarrier[];
  community: {
    goals: OverviewGoal[];
    deliveries: { tons: number; pilots: number; lastAt: string | null };
    scans: { bodies: number; updatedAt: string | null };
  };
  freshness: OverviewFreshness[];
  links: {
    atlas: string;
    factions: string;
    powerplay: string;
    nearby: string;
    market: string;
    stations: string;
    architect: string;
    external: ReturnType<typeof externalSystemLinks>;
  };
  warnings: string[];
}

/* ── Помощники разбора ─────────────────────────────────────────────────── */

function num(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function iso(value: unknown): string | null {
  if (!value) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function strings(value: unknown, limit = 40): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, limit) : [];
}

function rows(value: unknown): Row[] {
  return Array.isArray(value) ? value.filter((item): item is Row => !!item && typeof item === 'object') : [];
}

function newest(...values: Array<string | null | undefined>): string | null {
  let best: number | null = null;
  for (const value of values) {
    const ms = value ? Date.parse(value) : NaN;
    if (Number.isFinite(ms) && (best == null || ms > best)) best = ms;
  }
  return best == null ? null : new Date(best).toISOString();
}

const FLEET_CARRIER_MIN = 3_700_000_000;
const FLEET_CARRIER_MAX = 3_800_000_000;

function isCarrierStation(row: Row): boolean {
  const type = String(row.station_type ?? '').toLowerCase();
  if (type.includes('fleetcarrier') || type.includes('fleet carrier')) return true;
  const market = num(row.market_id);
  return market != null && market >= FLEET_CARRIER_MIN && market < FLEET_CARRIER_MAX;
}

/** План-ориентир для прогресса: архитектора, иначе свежий опубликованный, иначе свой. */
export function pickReferencePlan(plans: Row[], architectId: string | null, viewerId: string | null): Row | null {
  if (plans.length === 0) return null;
  const byArchitect = architectId ? plans.find((plan) => plan.author_id === architectId) : undefined;
  if (byArchitect) return byArchitect;
  const published = plans.find((plan) => plan.visibility === 'public');
  if (published) return published;
  return viewerId ? plans.find((plan) => plan.author_id === viewerId) ?? null : null;
}

/* ── Сборка ────────────────────────────────────────────────────────────── */

/** Сырой ответ `system_overview_sources` → карточка для зрителя (чистая функция). */
export function shapeSystemOverview(
  query: string,
  raw: Row,
  viewer: SystemOverviewViewer,
  carriers: MapCarrier[] = [],
  warnings: string[] = [],
): SystemOverview {
  const catalogRow = raw.catalog && typeof raw.catalog === 'object' ? (raw.catalog as Row) : null;
  const factions = raw.factions ? decodeSystemDetail(raw.factions) : null;
  const ppRow = raw.powerplay && typeof raw.powerplay === 'object' ? (raw.powerplay as Row) : null;

  const name = cleanSystemName(catalogRow?.name ?? factions?.name ?? ppRow?.name ?? query);
  const key = systemKey(name) || systemKey(query);
  const id64 = systemId64(raw.id64 ?? catalogRow?.id64 ?? factions?.id64 ?? ppRow?.id64);

  const pointFrom = (row: Row | null): SystemPoint | null => {
    if (!row) return null;
    const x = num(row.x);
    const y = num(row.y);
    const z = num(row.z);
    return x == null || y == null || z == null ? null : { x, y, z };
  };
  const routeRow = raw.route && typeof raw.route === 'object' ? (raw.route as Row) : null;
  const hubRow = raw.hub && typeof raw.hub === 'object' ? (raw.hub as Row) : null;
  const point = pointFrom(catalogRow) ?? (factions ? { x: factions.x, y: factions.y, z: factions.z } : null)
    ?? pointFrom(hubRow) ?? pointFrom(routeRow);

  // Колонизация: одно правило прогресса для всего сайта.
  const architectRow = raw.architect && typeof raw.architect === 'object' ? (raw.architect as Row) : null;
  const architectId = str(architectRow?.user_id);
  const planRows = rows(raw.plans);
  const reference = pickReferencePlan(planRows, architectId, viewer.userId);
  const ravenRows = rows(raw.raven) as RavenCacheRow[];
  const depotRows = rows(raw.depots) as DepotRow[];
  const progress = buildSystemProgress({
    systemId: id64 ?? key,
    systemName: name,
    raven: pickRavenRow(ravenRows),
    depots: depotRows,
    plan: reference as PlanRow | null,
  });
  const plans: OverviewPlan[] = planRows.map((plan) => ({
    id: String(plan.id),
    title: String(plan.title || '') || 'План без названия',
    authorName: String(plan.author_name || '') || 'Командир',
    visibility: String(plan.visibility || 'public'),
    siteCount: num(plan.site_count) ?? 0,
    haulTons: num(plan.haul_tons) ?? 0,
    updatedAt: iso(plan.updated_at),
    own: Boolean(viewer.userId && plan.author_id === viewer.userId),
    byArchitect: Boolean(architectId && plan.author_id === architectId),
  }));

  // Проекты.
  const squadron: OverviewSquadronProject[] = rows(raw.squadron_projects).map((row) => ({
    id: Number(row.project_id),
    name: String(row.name || '') || `Проект #${row.project_id}`,
    status: String(row.status || 'active'),
    color: str(row.color),
    squadron: row.squadron_id == null ? null : { id: Number(row.squadron_id), name: str(row.squadron_name), tag: str(row.squadron_tag) },
    systemStatus: String(row.system_status || 'planned'),
    priority: num(row.priority),
    targetDate: str(row.target_date),
  }));
  const architectAll = rows(raw.architect_projects);
  const visible = architectAll.filter((row) => viewer.isAdmin || row.is_member === true);
  const architect: OverviewArchitectProject[] = visible.map((row) => {
    const summary = row.progress_summary && typeof row.progress_summary === 'object' ? (row.progress_summary as Row) : null;
    return {
      id: String(row.project_id),
      name: String(row.name || '') || 'Проект системы',
      status: String(row.status || 'active'),
      color: str(row.color),
      stage: String(row.stage || 'planned'),
      priority: num(row.priority),
      targetDate: str(row.target_date),
      progress: num(summary?.progress),
    };
  });

  // Станции: свежие наблюдения первыми, авианосцы отдельно помечены.
  const stationRows = rows(raw.stations);
  const stations: OverviewStation[] = stationRows.map((row) => {
    const inventories: OverviewStation['inventories'] = {};
    const inv = row.inventories && typeof row.inventories === 'object' ? (row.inventories as Row) : {};
    for (const kind of ['market', 'outfitting', 'shipyard'] as const) {
      const item = inv[kind];
      if (item && typeof item === 'object') {
        inventories[kind] = { observedAt: iso(item.observed_at), items: num(item.items) ?? 0, source: str(item.source) };
      }
    }
    return {
      key: String(row.station_key),
      marketId: row.market_id == null ? null : String(row.market_id),
      name: String(row.station_name || ''),
      type: str(row.station_type),
      distanceLs: num(row.distance_to_arrival),
      body: str(row.body_name),
      services: strings(row.services),
      engineers: strings(row.engineers, 10),
      observedAt: iso(row.observed_at),
      source: String(row.source || ''),
      inventories,
      carrier: isCarrierStation(row),
    };
  });

  const powerplay: OverviewPowerplay | null = ppRow && ppRow.state !== 'Unoccupied'
    ? {
      power: str(ppRow.power),
      state: String(ppRow.state),
      powers: strings(ppRow.powers, 16),
      controlProgress: num(ppRow.control_progress),
      reinforcement: num(ppRow.reinforcement),
      undermining: num(ppRow.undermining),
      observedAt: iso(ppRow.observed_at),
      source: String(ppRow.source || 'edsm'),
    }
    : null;

  const goals: OverviewGoal[] = rows(raw.goals).map((row) => ({
    id: Number(row.cg_id),
    title: String(row.title || ''),
    station: str(row.station_name),
    objective: str(row.objective),
    tier: num(row.tier_current),
    tierMax: num(row.tier_max),
    contributors: num(row.contributors),
    expiresAt: iso(row.expiry_date),
    complete: row.is_complete === true,
    colonisation: row.is_colonisation_related === true,
  }));
  const deliveriesRow = raw.deliveries && typeof raw.deliveries === 'object' ? (raw.deliveries as Row) : {};
  const scansRow = raw.scans && typeof raw.scans === 'object' ? (raw.scans as Row) : {};

  const catalog: OverviewCatalog | null = catalogRow ? {
    id64: String(catalogRow.id64),
    name: String(catalogRow.name),
    mainStar: str(catalogRow.main_star),
    starType: str(catalogRow.star_type),
    starGiantClass: str(catalogRow.star_giant_class),
    needsPermit: typeof catalogRow.needs_permit === 'boolean' ? catalogRow.needs_permit : null,
    distanceFromSol: num(catalogRow.distance_from_sols),
    distanceFromSgrA: num(catalogRow.distance_from_sgra),
  } : null;

  const colonisationKnown = progress.sites.length > 0 || Boolean(progress.plan) || ravenRows.length > 0;
  const deliveries = {
    tons: num(deliveriesRow.tons) ?? 0,
    pilots: num(deliveriesRow.pilots) ?? 0,
    lastAt: iso(deliveriesRow.last_at),
  };
  const scans = { bodies: num(scansRow.bodies) ?? 0, updatedAt: iso(scansRow.updated_at) };

  const freshness: OverviewFreshness[] = [
    { source: 'raven' as const, label: 'Raven Colonial', at: progress.ravenUpdatedAt },
    { source: 'journal' as const, label: 'Журналы пилотов (стройки)', at: progress.journalUpdatedAt },
    { source: 'stations' as const, label: 'Станции и рынки', at: newest(...stations.map((station) => station.observedAt)) },
    { source: 'factions' as const, label: 'Минорные фракции', at: factions?.observedAt ?? null },
    { source: 'powerplay' as const, label: 'PowerPlay', at: powerplay?.observedAt ?? null },
    { source: 'carriers' as const, label: 'Авианосцы', at: newest(...carriers.map((carrier) => carrier.locationAt)) },
    { source: 'scans' as const, label: 'Сканы тел', at: scans.updatedAt },
  ].filter((item) => item.at);

  const found = Boolean(
    catalog || factions || powerplay || colonisationKnown || squadron.length || architect.length
    || routeRow || hubRow || stations.length || carriers.length || goals.length || deliveries.tons > 0 || scans.bodies > 0,
  );

  return {
    found,
    query,
    key,
    name,
    id64,
    point,
    catalog,
    colonisation: {
      progress,
      architect: architectRow ? {
        name: String(architectRow.name || '') || 'Архитектор',
        userId: architectId,
        isViewer: Boolean(viewer.userId && architectId === viewer.userId),
      } : null,
      plans,
      known: colonisationKnown,
    },
    projects: { squadron, architect },
    ring: {
      route: routeRow ? { id: Number(routeRow.id), order: num(routeRow.sort_order) ?? 0, status: str(routeRow.status), progress: num(routeRow.progress) } : null,
      hub: hubRow ? { id: Number(hubRow.id), name: String(hubRow.name || ''), status: str(hubRow.status), progress: num(hubRow.progress), segment: num(hubRow.segment_order) } : null,
    },
    stations: { total: stations.length, items: stations },
    factions,
    powerplay,
    carriers,
    community: { goals, deliveries, scans },
    freshness,
    links: {
      atlas: atlasSystemHref(name, { point, id64, from: 'system' }),
      factions: atlasSystemHref(name, { tab: 'factions', point, id64, from: 'system' }),
      powerplay: atlasSystemHref(name, { tab: 'powerplay', point, id64, from: 'system' }),
      nearby: atlasSystemHref(name, { tab: 'nearby', point, from: 'system' }),
      market: atlasSystemHref(name, { tab: 'market' }),
      stations: stationSearchHref(name),
      architect: `/architect?system=${encodeURIComponent(name)}`,
      external: externalSystemLinks(name, id64),
    },
    warnings,
  };
}

/** Прочитать всё о системе и собрать карточку для зрителя. */
export async function loadSystemOverview(
  svc: Svc,
  query: { name?: string | null; id64?: string | null },
  viewer: SystemOverviewViewer,
): Promise<SystemOverview | null> {
  const name = cleanSystemName(query.name ?? '');
  const id64 = systemId64(query.id64 ?? null);
  if (!name && !id64) return null;

  const { data, error } = await svc.rpc('system_overview_sources', {
    p_key: systemKey(name),
    p_id64: id64,
    p_names: name ? [name] : [],
    p_viewer: viewer.userId,
  });
  if (error) throw new Error(error.message);
  const raw = (typeof data === 'string' ? JSON.parse(data) : data ?? {}) as Row;

  const warnings: string[] = [];
  const preliminary = shapeSystemOverview(name || id64 || '', raw, viewer);
  let carriers: MapCarrier[] = [];
  try {
    carriers = await loadSystemCarriers(svc, viewer.userId, preliminary.name, { point: preliminary.point });
  } catch (carrierError) {
    warnings.push(`Авианосцы не загружены: ${carrierError instanceof Error ? carrierError.message : String(carrierError)}`);
  }
  return shapeSystemOverview(name || id64 || '', raw, viewer, carriers, warnings);
}
