/**
 * Данные карточки авианосца (`/carriers/<MarketID>`).
 *
 * Три источника, которые до сих пор жили порознь:
 *   * учёт сайта — `fleet_carriers`: стоянка, тело, службы, заказ прыжка,
 *     владелец и эскадрилья, прыжковый диапазон и топливо;
 *   * реестр EDDN — `carrier_directory`: где носитель видели в последний раз,
 *     даже если он не привязан к сайту, и сколько раз его замечали;
 *   * журнал — `carrier_jump_history`: год прыжков, по которым считаются
 *     окна, направления и графики.
 *
 * Карточка публичная, как и отметка носителя в игре: система, тело, службы и
 * прыжки видны всем. Личного здесь нет ничего, кроме разве что имени
 * владельца — оно прячется его же настройками приватности (`privacy_settings`),
 * ровно как на карте. Груза и финансов нет никогда: это данные капитана.
 *
 * Строки базы живут здесь, а не в маршруте, потому что карточку собирают два
 * места — маршрут `/api/carriers/[id]/card` и (при желании) серверный рендер.
 */

import { buildCarrierView } from './fleetCarriers.ts';
import { privacyForViewer } from './privacy.ts';
import {
  CARRIER_CARD_JUMPS_LIMIT,
  carrierCardJumpFromRow,
  carrierCardServices,
  carrierCardSince,
  carrierCardStats,
  orderCarrierCardJumps,
  type CarrierCardJump,
  type CarrierCardService,
  type CarrierCardStats,
} from './carrierCard.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
type Row = Record<string, any>;

/**
 * Колонки реестра EDDN. `previous_*` появились вместе с миграцией
 * `20261110090000_carrier_directory_route.sql`: на установке без неё запрос
 * падает целиком, поэтому есть базовый набор и запасной путь.
 */
const DIRECTORY_COLUMNS = 'carrier_id, callsign, name, carrier_type, system_name, body_name, x, y, z, services, updated_at, last_seen_at, first_seen_at, sightings';
const DIRECTORY_COLUMNS_BASE = 'carrier_id, callsign, name, carrier_type, system_name, body_name, x, y, z, services, updated_at, last_seen_at';

export interface CarrierCardLocation {
  system: string | null;
  systemAddress: string | null;
  /** Тело, у которого стоит носитель: «A 1», «Earth». Бывает не всегда. */
  body: string | null;
  position: { x: number; y: number; z: number } | null;
  /** Когда стоянку подтвердили в последний раз. */
  at: string | null;
  /** Данные из реестра EDDN, а не из учёта сайта. */
  source: 'site' | 'eddn';
  /** Носитель уже должен был прыгнуть, подтверждения ещё нет. */
  estimated: boolean;
  previousSystem: string | null;
}

export interface CarrierCardJumpOrder {
  system: string;
  body: string | null;
  departureAt: string | null;
  requestedAt: string | null;
  state: 'scheduled' | 'jumping';
}

export interface CarrierCardOwner {
  /** Имя командира: `null`, если владелец скрыл местоположение или его нет. */
  name: string | null;
  hidden: boolean;
}

export interface CarrierCardSquadron {
  id: number;
  name: string | null;
  tag: string | null;
  member: boolean;
}

export interface CarrierCardView {
  id: string;
  type: 'FleetCarrier' | 'SquadronCarrier';
  callsign: string | null;
  name: string | null;
  /** `own` — носитель зрителя, `squadron` — его эскадрильи, `other` — чужой. */
  relation: 'own' | 'squadron' | 'other';
  decommission: boolean;
  location: CarrierCardLocation;
  jump: CarrierCardJumpOrder | null;
  owner: CarrierCardOwner;
  squadron: CarrierCardSquadron | null;
  docking: string | null;
  notorious: boolean | null;
  fuelLevel: number | null;
  jumpRange: { current: number | null; max: number | null } | null;
  services: CarrierCardService[];
  /** Сколько раз носитель замечали в реестре EDDN (если он там есть). */
  sightings: number | null;
  /** Журнал прыжков за год и всё, что из него считается. */
  stats: CarrierCardStats;
  jumps: CarrierCardJump[];
  /** Отдельные предупреждения: чего не хватило в данных. */
  warnings: string[];
}

function asIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function text(value: unknown): string | null {
  const clean = typeof value === 'string' ? value.trim() : '';
  return clean ? clean : null;
}

function pointOf(row: Row | null | undefined): { x: number; y: number; z: number } | null {
  if (!row) return null;
  const point = { x: Number(row.x), y: Number(row.y), z: Number(row.z) };
  return [point.x, point.y, point.z].every((axis) => Number.isFinite(axis)) ? point : null;
}

/** Таблица может отсутствовать на старой установке — тогда источник пропускается. */
async function safeRows(query: PromiseLike<{ data: Row[] | null; error: unknown }>): Promise<Row[]> {
  try {
    const { data, error } = await query;
    return !error && Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Одна строка или `null`: PostgREST умеет `maybeSingle`. */
async function safeRow(query: PromiseLike<{ data: Row | null; error: unknown }>): Promise<Row | null> {
  try {
    const { data, error } = await query;
    return !error && data ? data : null;
  } catch {
    return null;
  }
}

/** Реестр EDDN: носитель там может быть, даже если сайт его не знает. */
async function loadDirectoryCarrier(svc: Svc, id: string): Promise<Row | null> {
  const full = await safeRow(svc.from('carrier_directory').select(DIRECTORY_COLUMNS).eq('carrier_id', id).maybeSingle());
  if (full) return full;
  return safeRow(svc.from('carrier_directory').select(DIRECTORY_COLUMNS_BASE).eq('carrier_id', id).maybeSingle());
}

/** Журнал прыжков за год, свежие сверху. Пустой ответ — не ошибка. */
async function loadCardJumps(svc: Svc, id: string, now: number, limit = CARRIER_CARD_JUMPS_LIMIT): Promise<Row[]> {
  return safeRows(
    svc.from('carrier_jump_history')
      .select('id, from_system, to_system, jumped_at, source')
      .eq('carrier_id', id)
      .gte('jumped_at', carrierCardSince(now))
      .order('jumped_at', { ascending: false })
      .limit(Math.max(1, Math.floor(limit))),
  );
}

/** Службы реестра — просто роли в массиве (`CarrierJump` передаёт только работающие). */
function directoryServices(value: unknown): CarrierCardService[] {
  return carrierCardServices(Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);
}

export interface LoadCarrierCardOptions {
  now?: Date;
  /** Сколько строк истории брать (для тестов). */
  jumpLimit?: number;
}

/**
 * Собрать карточку носителя по MarketID.
 *
 * `null` — носитель не найден ни в учёте сайта, ни в реестре EDDN: маршрут
 * отвечает 404. Это честнее, чем показать пустую страницу с нулями.
 */
export async function loadCarrierCard(
  svc: Svc,
  viewerId: string | null,
  carrierId: string,
  options: LoadCarrierCardOptions = {},
): Promise<CarrierCardView | null> {
  const now = options.now ?? new Date();
  const id = String(carrierId).trim();
  if (!/^\d{1,20}$/.test(id)) return null;

  const [fleetRow, directoryRow, jumpRows] = await Promise.all([
    safeRow(svc.from('fleet_carriers').select('*').eq('carrier_id', id).maybeSingle()),
    loadDirectoryCarrier(svc, id),
    loadCardJumps(svc, id, now.getTime(), options.jumpLimit),
  ]);
  if (!fleetRow && !directoryRow) return null;

  const warnings: string[] = [];
  const jumps = orderCarrierCardJumps(
    jumpRows.map((row) => carrierCardJumpFromRow(row)).filter((jump): jump is CarrierCardJump => jump != null),
  );
  const stats = carrierCardStats(jumps, { now: now.getTime() });

  /* ── эскадрилья и владелец ── */
  const squadronId = fleetRow?.squadron_id == null ? null : Number(fleetRow.squadron_id);
  let squadron: CarrierCardSquadron | null = null;
  if (squadronId != null && Number.isFinite(squadronId)) {
    const [row, membership] = await Promise.all([
      safeRow(svc.from('squadrons').select('id, name, tag').eq('id', squadronId).maybeSingle()),
      viewerId
        ? safeRow(svc.from('squadron_members').select('user_id').eq('squadron_id', squadronId).eq('user_id', viewerId).maybeSingle())
        : Promise.resolve(null),
    ]);
    squadron = {
      id: squadronId,
      name: text(row?.name),
      tag: text(row?.tag),
      member: Boolean(membership),
    };
  }

  const ownerId = fleetRow?.owner_id ? String(fleetRow.owner_id) : null;
  let owner: CarrierCardOwner = { name: null, hidden: false };
  if (ownerId) {
    const profile = await safeRow(svc.from('profiles').select('id, cmdr_name, privacy_settings').eq('id', ownerId).maybeSingle());
    // Имя владельца — по тем же правилам, что на карте: скрыл местоположение —
    // не показываем и в карточке. Себя пилот видит всегда.
    const visible = privacyForViewer(profile?.privacy_settings, viewerId, ownerId).location;
    owner = { name: visible ? text(profile?.cmdr_name) : null, hidden: !visible };
  }

  /* ── место и заказ прыжка ── */
  let location: CarrierCardLocation;
  let jump: CarrierCardJumpOrder | null = null;
  let docking: string | null = null;
  let notorious: boolean | null = null;
  let fuelLevel: number | null = null;
  let jumpRange: { current: number | null; max: number | null } | null = null;
  let services: CarrierCardService[] = [];
  let type: 'FleetCarrier' | 'SquadronCarrier' = 'FleetCarrier';

  if (fleetRow) {
    const view = buildCarrierView(fleetRow, { relation: 'public', showFinance: false, now });
    type = view.type;
    location = {
      system: view.location.system,
      systemAddress: view.location.systemAddress,
      body: text(view.location.body),
      position: view.location.coords ?? pointOf(fleetRow),
      at: view.location.at,
      source: 'site',
      estimated: view.location.estimated,
      previousSystem: view.location.previousSystem,
    };
    jump = view.jump
      ? {
        system: view.jump.system,
        body: text(view.jump.body),
        departureAt: view.jump.departureAt,
        requestedAt: view.jump.requestedAt,
        state: view.jump.state,
      }
      : null;
    docking = view.status.dockingLabel;
    notorious = view.status.allowNotorious;
    fuelLevel = view.status.fuelLevel;
    jumpRange = view.status.jumpRangeCurr == null && view.status.jumpRangeMax == null
      ? null
      : { current: view.status.jumpRangeCurr, max: view.status.jumpRangeMax };
    services = carrierCardServices(view.services);
    // Учёт сайта хранит службы капитана; если их ещё не передавали, остаётся
    // список станции из `Docked` — он тоже честный, просто беднее.
    if (!services.length && view.stationServices.length) services = carrierCardServices(view.stationServices);
  } else {
    // Только реестр EDDN: место, службы и имя — то, что видел живой поток.
    location = {
      system: text(directoryRow?.system_name),
      systemAddress: null,
      body: text(directoryRow?.body_name),
      position: pointOf(directoryRow),
      at: asIso(directoryRow?.updated_at) ?? asIso(directoryRow?.last_seen_at),
      source: 'eddn',
      estimated: false,
      previousSystem: null,
    };
    services = directoryServices(directoryRow?.services);
    if (!location.system) warnings.push('registryWithoutSystem');
  }

  const sightings = Number.isFinite(Number(directoryRow?.sightings)) && directoryRow?.sightings != null
    ? Number(directoryRow.sightings)
    : null;

  if (!jumps.length) warnings.push('noJumpHistory');

  return {
    id,
    type,
    callsign: text(fleetRow?.callsign) ?? text(directoryRow?.callsign),
    // Имя — только то, что ввели пользователи сайта, или учёт капитана.
    // Реестр EDDN имени не знает и не пишет (миграция `20261108120000`).
    name: text(fleetRow?.name) ?? text(directoryRow?.name),
    relation: viewerId && ownerId && viewerId === ownerId
      ? 'own'
      : (squadron?.member ? 'squadron' : 'other'),
    decommission: Boolean(fleetRow?.pending_decommission === true),
    location,
    jump,
    owner,
    squadron,
    docking,
    notorious,
    fuelLevel,
    jumpRange,
    services,
    sightings,
    stats,
    jumps,
    warnings,
  };
}
