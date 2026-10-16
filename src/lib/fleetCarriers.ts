/**
 * Учёт авианосцев (Fleet Carrier / Squadron Carrier) на сервере проекта.
 *
 * Модуль переводит журнальные события, присланные Colonial Helper'ом или
 * загрузчиком журналов на сайте, в операции SQL-функции
 * `apply_fleet_carrier_batch` (supabase/migrations/20261017000000_fleet_carriers.sql)
 * и собирает из строк БД «карточку» носителя для профиля, эскадрильи и
 * оверлея Helper'а.
 *
 * Главное правило — одинаковый результат при любом пути загрузки: хеш грузовой
 * дельты считается здесь, на сервере, из полей самого события. Один и тот же
 * MarketSell, пришедший с сайта и из Helper'а, даёт один хеш и учитывается
 * один раз (ровно та ошибка, из-за которой раньше дублировались поставки).
 */

import { createHash } from 'node:crypto';

export const FC_MARKET_MIN = 3_700_000_000;
export const FC_MARKET_MAX = 3_800_000_000;
/** Защита от мусора: ни одна операция с грузом не двигает больше трюма Javelin. */
const MAX_TONS_PER_EVENT = 60_000;
const MAX_FUTURE_MS = 10 * 60 * 1000;
/** Сколько длится сам прыжок после DepartureTime, пока носитель «в пути». */
export const JUMP_TRANSIT_MS = 5 * 60 * 1000;
/** Если в старом CarrierJumpRequest нет DepartureTime — обычный отсчёт 15 минут. */
const DEFAULT_JUMP_COUNTDOWN_MS = 15 * 60 * 1000;

/** События журнала, из которых складывается состояние носителя. */
export const CARRIER_JOURNAL_EVENTS = new Set([
  'CarrierStats', 'CarrierBuy', 'CarrierLocation', 'CarrierJump', 'CarrierJumpRequest',
  'CarrierJumpCancelled', 'CarrierNameChanged', 'CarrierNameChange', 'CarrierDecommission',
  'CarrierCancelDecommission', 'CarrierDockingPermission', 'CarrierCrewServices',
  'CarrierTradeOrder', 'Docked', 'Location', 'MarketBuy', 'MarketSell', 'CargoTransfer',
  // Синтетическое событие Helper'а: дифф трюма у эскадренного носителя (банк эскадры
  // не пишет в журнал ни CargoTransfer, ни Market*).
  'SquadronBankTransfer',
]);

export type CarrierType = 'FleetCarrier' | 'SquadronCarrier';
export type CarrierSource = 'helper' | 'web' | 'capi' | 'manual';

export interface CarrierOp {
  op: string;
  carrier_id: string;
  at: string;
  [key: string]: unknown;
}

export interface NormalizeResult {
  ops: CarrierOp[];
  /** События, из которых не удалось извлечь ничего полезного. */
  skipped: number;
  /** Носители, затронутые пакетом. */
  carriers: string[];
}

type JournalEvent = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Тот же ключ, что и `canonical_commodity` в uploader/event_dispatch.py. */
export function canonicalCommodity(value: unknown): string {
  let name = String(value ?? '').trim().toLowerCase();
  if (name.startsWith('$')) name = name.slice(1);
  if (name.endsWith('_name;')) name = name.slice(0, -6);
  else if (name.endsWith('_name')) name = name.slice(0, -5);
  return name.replace(/[^a-z0-9]/g, '').slice(0, 80);
}

/** Целое из журнала (MarketID/CarrierID приходят числом или строкой). */
function journalInteger(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d{1,18}$/.test(value.trim())) {
    const parsed = Number(value.trim());
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function positiveId(value: unknown): string | null {
  const parsed = journalInteger(value);
  return parsed != null && parsed > 0 ? String(parsed) : null;
}

export function isCarrierMarketId(value: unknown): boolean {
  const parsed = journalInteger(value);
  return parsed != null && parsed >= FC_MARKET_MIN && parsed < FC_MARKET_MAX;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function integerOf(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  return parsed == null ? undefined : Math.trunc(parsed);
}

function text(value: unknown, max = 200): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function eventTime(event: JournalEvent, nowMs: number): string | null {
  const raw = text(event.timestamp, 40);
  if (!raw) return null;
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms) || ms > nowMs + MAX_FUTURE_MS || ms < Date.UTC(2014, 0, 1)) return null;
  return new Date(ms).toISOString();
}

function isoTime(value: unknown): string | undefined {
  const raw = text(value, 40);
  if (!raw) return undefined;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Позывной FC: «K7X-B0Z». У непереименованного носителя StationName = позывной. */
export function looksLikeCallsign(value: unknown): boolean {
  return typeof value === 'string' && /^[A-Z0-9]{3}-[A-Z0-9]{3}$/.test(value.trim());
}

function carrierTypeOf(event: JournalEvent): CarrierType | undefined {
  const raw = text(event.CarrierType, 40);
  if (raw === 'SquadronCarrier') return 'SquadronCarrier';
  if (raw === 'FleetCarrier') return 'FleetCarrier';
  // Эскадренный Javelin-Class в Docked/CarrierJump виден по службе банка эскадры.
  const services = Array.isArray(event.StationServices) ? event.StationServices : [];
  if (services.some((service) => String(service).toLowerCase() === 'squadronbank')) return 'SquadronCarrier';
  return undefined;
}

function stationServices(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list = value
    .map((entry) => (typeof entry === 'string' ? entry.trim().toLowerCase().slice(0, 60) : ''))
    .filter(Boolean);
  return Array.from(new Set(list)).slice(0, 80);
}

/** Стоянка у авианосца: тип станции из события или контекста, либо MarketID FC. */
function dockedCarrierId(event: JournalEvent): string | null {
  const marketId = event.MarketID ?? event._MarketID;
  const stationType = String(event.StationType ?? event._StationType ?? '');
  if (/carrier/i.test(stationType) || isCarrierMarketId(marketId)) return positiveId(marketId);
  return null;
}

function starPos(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!Array.isArray(value) || value.length !== 3) return undefined;
  const [x, y, z] = value.map((part) => finiteNumber(part));
  if (x == null || y == null || z == null) return undefined;
  if ([x, y, z].some((part) => Math.abs(part) > 100_000)) return undefined;
  return { x, y, z };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Хеш грузовой дельты. Только поля журнального события и id пилота:
 * два пилота, продавших одинаковую партию в одну секунду, не схлопнутся,
 * а одно событие одного пилота с сайта и из Helper'а — схлопнется.
 */
export function carrierDeltaHash(parts: Array<string | number | undefined | null>): string {
  return sha256(['fc1', ...parts.map((part) => (part == null ? '' : String(part)))].join('\u0000'));
}

function compactObject<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

function spaceUsage(value: unknown) {
  if (!isRecord(value)) return undefined;
  const usage = compactObject({
    total_capacity: integerOf(value.TotalCapacity),
    crew: integerOf(value.Crew),
    cargo: integerOf(value.Cargo),
    cargo_space_reserved: integerOf(value.CargoSpaceReserved),
    ship_packs: integerOf(value.ShipPacks),
    module_packs: integerOf(value.ModulePacks),
    free_space: integerOf(value.FreeSpace),
  });
  return Object.keys(usage).length ? usage : undefined;
}

function finance(value: unknown) {
  if (!isRecord(value)) return undefined;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value)) {
    const number = finiteNumber(raw);
    if (number == null) continue;
    const snake = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
    result[snake.slice(0, 60)] = number;
  }
  return Object.keys(result).length ? result : undefined;
}

function crewServices(value: unknown) {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter(isRecord)
    .map((crew) => compactObject({
      role: text(crew.CrewRole, 60),
      activated: typeof crew.Activated === 'boolean' ? crew.Activated : undefined,
      enabled: typeof crew.Enabled === 'boolean' ? crew.Enabled : undefined,
      crew_name: text(crew.CrewName, 120),
    }))
    .filter((crew) => crew.role)
    .slice(0, 60);
}

function cargoDelta(
  ops: CarrierOp[],
  carrierId: string,
  at: string,
  eventName: string,
  commodityRaw: unknown,
  localised: unknown,
  signedDelta: number,
  hashParts: Array<string | number | undefined | null>,
): boolean {
  const commodity = canonicalCommodity(commodityRaw);
  if (!commodity || !Number.isFinite(signedDelta) || signedDelta === 0) return false;
  if (Math.abs(signedDelta) > MAX_TONS_PER_EVENT) return false;
  ops.push(compactObject({
    op: 'delta',
    carrier_id: carrierId,
    at,
    event: eventName,
    commodity,
    name_localised: text(localised, 120),
    delta: Math.trunc(signedDelta),
    hash: carrierDeltaHash([eventName, at, carrierId, commodity, Math.trunc(signedDelta), ...hashParts]),
  }));
  return true;
}

/**
 * Журнальные события → операции для `apply_fleet_carrier_batch`.
 *
 * `userId` участвует в хешах дельт (см. carrierDeltaHash). События без
 * пользы (стыковка к обычной станции, торговля не на авианосце) просто
 * пропускаются: клиенту не нужно фильтровать идеально.
 */
export function normalizeCarrierEvents(
  input: unknown,
  options: { userId: string; now?: Date } ,
): NormalizeResult {
  const nowMs = (options.now ?? new Date()).getTime();
  const events = Array.isArray(input) ? input : [];
  const ops: CarrierOp[] = [];
  let skipped = 0;

  for (const raw of events) {
    if (!isRecord(raw)) { skipped += 1; continue; }
    const event = raw as JournalEvent;
    const name = String(event.event ?? '');
    const at = eventTime(event, nowMs);
    if (!CARRIER_JOURNAL_EVENTS.has(name) || !at) { skipped += 1; continue; }
    const before = ops.length;
    const carrierType = carrierTypeOf(event);
    const squadron = carrierType === 'SquadronCarrier';

    switch (name) {
      case 'CarrierStats': {
        const id = positiveId(event.CarrierID);
        if (!id) break;
        const usage = spaceUsage(event.SpaceUsage);
        ops.push(compactObject({ op: 'identity', carrier_id: id, at, carrier_type: carrierType, callsign: text(event.Callsign, 20) }));
        ops.push(compactObject({
          op: 'stats', carrier_id: id, at, carrier_type: carrierType,
          name: text(event.Name, 120), callsign: text(event.Callsign, 20),
          docking_access: text(event.DockingAccess, 40),
          allow_notorious: typeof event.AllowNotorious === 'boolean' ? event.AllowNotorious : undefined,
          fuel_level: integerOf(event.FuelLevel),
          jump_range_curr: finiteNumber(event.JumpRangeCurr),
          jump_range_max: finiteNumber(event.JumpRangeMax),
          pending_decommission: typeof event.PendingDecommission === 'boolean' ? event.PendingDecommission : undefined,
          space_usage: usage,
          finance: finance(event.Finance),
          services: crewServices(event.Crew),
        }));
        // CarrierStats приходит только тому, кто управляет носителем.
        ops.push(squadron
          ? { op: 'squadron_claim', carrier_id: id, at }
          : { op: 'owner', carrier_id: id, at, proof: 'journal' });
        // Подтверждённо пустой трюм — полный базовый снимок.
        if (usage?.cargo === 0) {
          ops.push({ op: 'baseline', carrier_id: id, at, full: true, source_event: 'CarrierStats', items: [] });
        }
        break;
      }
      case 'CarrierBuy': {
        const id = positiveId(event.CarrierID);
        if (!id) break;
        ops.push(compactObject({ op: 'identity', carrier_id: id, at, carrier_type: carrierType, callsign: text(event.Callsign, 20) }));
        ops.push(squadron
          ? { op: 'squadron_claim', carrier_id: id, at }
          : { op: 'owner', carrier_id: id, at, proof: 'journal' });
        const system = text(event.Location ?? event.StarSystem);
        if (system) {
          ops.push(compactObject({
            op: 'location', carrier_id: id, at, system_name: system,
            system_address: journalInteger(event.SystemAddress) ?? undefined, source_event: 'CarrierBuy',
          }));
        }
        // Только что купленный носитель пуст.
        ops.push({ op: 'baseline', carrier_id: id, at, full: true, source_event: 'CarrierBuy', items: [] });
        break;
      }
      case 'CarrierLocation': {
        const id = positiveId(event.CarrierID);
        const system = text(event.StarSystem);
        if (!id || !system) break;
        if (carrierType) ops.push({ op: 'identity', carrier_id: id, at, carrier_type: carrierType });
        ops.push(compactObject({
          op: 'location', carrier_id: id, at, system_name: system,
          system_address: journalInteger(event.SystemAddress) ?? undefined,
          body_id: integerOf(event.BodyID), source_event: 'CarrierLocation',
        }));
        // Пишется при запуске игры про «свой» носитель — мягкое доказательство.
        ops.push(squadron
          ? { op: 'squadron_claim', carrier_id: id, at }
          : { op: 'owner', carrier_id: id, at, proof: 'soft' });
        break;
      }
      case 'CarrierJump':
      case 'Docked':
      case 'Location': {
        if (name === 'Location' && event.Docked !== true) break;
        const id = dockedCarrierId(event);
        const system = text(event.StarSystem);
        if (!id) break;
        const stationName = text(event.StationName, 120);
        ops.push(compactObject({
          op: 'identity', carrier_id: id, at, carrier_type: carrierType,
          callsign: looksLikeCallsign(stationName) ? stationName : undefined,
          name: stationName && !looksLikeCallsign(stationName) ? stationName : undefined,
          weak_name: stationName && !looksLikeCallsign(stationName) ? true : undefined,
          station_services: stationServices(event.StationServices),
        }));
        if (system) {
          const coords = starPos(event.StarPos) ?? starPos(event._StarPos);
          ops.push(compactObject({
            op: 'location', carrier_id: id, at, system_name: system,
            system_address: journalInteger(event.SystemAddress) ?? undefined,
            body_name: name === 'Docked' ? undefined : text(event.Body),
            body_id: name === 'Docked' ? undefined : integerOf(event.BodyID),
            ...coords, source_event: name,
          }));
        }
        // К эскадренному носителю пускают только членов эскадры.
        if (squadron) ops.push({ op: 'squadron_claim', carrier_id: id, at });
        break;
      }
      case 'CarrierJumpRequest': {
        const id = positiveId(event.CarrierID);
        const system = text(event.SystemName);
        if (!id || !system) break;
        if (carrierType) ops.push({ op: 'identity', carrier_id: id, at, carrier_type: carrierType });
        ops.push(compactObject({
          op: 'jump', carrier_id: id, at, system_name: system,
          system_address: journalInteger(event.SystemAddress) ?? undefined,
          body_name: text(event.Body), body_id: integerOf(event.BodyID),
          departure_at: isoTime(event.DepartureTime) ?? new Date(Date.parse(at) + DEFAULT_JUMP_COUNTDOWN_MS).toISOString(),
        }));
        break;
      }
      case 'CarrierJumpCancelled': {
        const id = positiveId(event.CarrierID);
        if (id) ops.push({ op: 'jump_cancel', carrier_id: id, at });
        break;
      }
      case 'CarrierNameChanged':
      case 'CarrierNameChange': {
        const id = positiveId(event.CarrierID);
        if (!id) break;
        ops.push(compactObject({
          op: 'identity', carrier_id: id, at, carrier_type: carrierType,
          name: text(event.Name, 120), callsign: text(event.Callsign, 20),
        }));
        break;
      }
      case 'CarrierDecommission':
      case 'CarrierCancelDecommission': {
        const id = positiveId(event.CarrierID);
        if (id) ops.push({ op: 'decommission', carrier_id: id, at, pending: name === 'CarrierDecommission' });
        break;
      }
      case 'CarrierDockingPermission': {
        const id = positiveId(event.CarrierID);
        if (!id) break;
        ops.push(compactObject({
          op: 'docking', carrier_id: id, at, docking_access: text(event.DockingAccess, 40),
          allow_notorious: typeof event.AllowNotorious === 'boolean' ? event.AllowNotorious : undefined,
        }));
        break;
      }
      case 'CarrierCrewServices': {
        const id = positiveId(event.CarrierID);
        const role = text(event.CrewRole, 60);
        const operation = text(event.Operation, 30)?.toLowerCase();
        if (!id || !role || !operation) break;
        ops.push(compactObject({ op: 'service', carrier_id: id, at, role, operation, crew_name: text(event.CrewName, 120) }));
        break;
      }
      case 'CarrierTradeOrder': {
        const id = positiveId(event.CarrierID);
        const commodity = canonicalCommodity(event.Commodity);
        if (!id || !commodity) break;
        ops.push(compactObject({
          op: 'order', carrier_id: id, at, commodity,
          name_localised: text(event.Commodity_Localised, 120),
          purchase: integerOf(event.PurchaseOrder), sale: integerOf(event.SaleOrder),
          price: integerOf(event.Price),
          black_market: typeof event.BlackMarket === 'boolean' ? event.BlackMarket : undefined,
          cancel: event.CancelTrade === true ? true : undefined,
        }));
        break;
      }
      case 'MarketBuy':
      case 'MarketSell': {
        // Продажа НА авианосец кладёт груз в его трюм, покупка С авианосца — забирает.
        const id = dockedCarrierId(event);
        const count = integerOf(event.Count);
        if (!id || !count || count <= 0) break;
        const sign = name === 'MarketSell' ? 1 : -1;
        cargoDelta(ops, id, at, name, event.Type, event.Type_Localised, sign * count, [
          options.userId, event.SellPrice as number, event.BuyPrice as number, event.TotalSale as number,
          event.TotalCost as number, event.AvgPricePaid as number,
        ]);
        break;
      }
      case 'CargoTransfer':
      case 'SquadronBankTransfer': {
        // В CargoTransfer нет MarketID: клиент добавляет носитель стоянки (_MarketID).
        const id = name === 'SquadronBankTransfer'
          ? positiveId(event.MarketID ?? event._MarketID)
          : dockedCarrierId({ MarketID: event._MarketID, StationType: event._StationType });
        const transfers = Array.isArray(event.Transfers) ? event.Transfers : [];
        if (!id || !transfers.length) break;
        if (name === 'SquadronBankTransfer') {
          ops.push({ op: 'identity', carrier_id: id, at, carrier_type: 'SquadronCarrier' });
        }
        transfers.forEach((transfer, index) => {
          if (!isRecord(transfer)) return;
          const direction = String(transfer.Direction ?? '').toLowerCase();
          const count = integerOf(transfer.Count);
          if (!count || count <= 0) return;
          const sign = direction === 'tocarrier' ? 1 : direction === 'toship' ? -1 : 0;
          if (!sign) return; // tosrv и прочее к авианосцу не относятся
          cargoDelta(ops, id, at, name, transfer.Type, transfer.Type_Localised, sign * count, [
            options.userId, index, direction, integerOf(transfer.MissionID),
          ]);
        });
        break;
      }
      default:
        break;
    }

    if (ops.length === before) skipped += 1;
  }

  const carriers = Array.from(new Set(ops.map((op) => op.carrier_id)));
  return { ops, skipped, carriers };
}

// ── Рынок авианосца → базовый снимок груза ─────────────────────────────────

export interface CarrierMarketItem {
  name: string;
  name_localised?: string;
  stock?: number;
  demand?: number;
  buyPrice?: number;
  sellPrice?: number;
  producer?: boolean;
  consumer?: boolean;
}

/**
 * Снимок рынка авианосца (Market.json) уточняет груз — по правилу SrvSurvey,
 * которое использует и Raven Colonial: у товаров на продажу (Producer) Stock
 * и есть их количество на борту; распроданная позиция (ни продажи, ни
 * закупки) — ноль. Ордера на закупку (Consumer) о трюме ничего не говорят.
 */
export function carrierMarketCargo(items: CarrierMarketItem[]): Array<{ commodity: string; qty: number; name_localised?: string }> {
  const result = new Map<string, { commodity: string; qty: number; name_localised?: string }>();
  for (const item of items) {
    const commodity = canonicalCommodity(item.name);
    if (!commodity) continue;
    const stock = Math.max(0, Math.trunc(Number(item.stock ?? 0) || 0));
    const demand = Math.max(0, Math.trunc(Number(item.demand ?? 0) || 0));
    const producer = item.producer ?? stock > 0;
    const consumer = item.consumer ?? (!producer && demand > 0);
    if (producer || (!producer && !consumer)) {
      result.set(commodity, { commodity, qty: Math.min(stock, MAX_TONS_PER_EVENT), name_localised: item.name_localised });
    }
  }
  return Array.from(result.values());
}

/** Операции из отчёта о станции-авианосце (маршрут /api/stations/report). */
export function carrierOpsFromStationReport(report: {
  market_id?: string;
  station_type?: string;
  station_name: string;
  system_name: string;
  observed_at: string;
  x?: number; y?: number; z?: number;
  metadata?: { services?: string[] };
  inventories?: { market?: { observed_at: string; items: CarrierMarketItem[] } };
}): CarrierOp[] {
  const id = positiveId(report.market_id);
  if (!id) return [];
  if (!/carrier/i.test(report.station_type ?? '') && !isCarrierMarketId(id)) return [];
  const at = isoTime(report.observed_at);
  if (!at) return [];
  const services = stationServices(report.metadata?.services);
  const type: CarrierType | undefined = services?.includes('squadronbank') ? 'SquadronCarrier' : undefined;
  const ops: CarrierOp[] = [compactObject({
    op: 'identity', carrier_id: id, at, carrier_type: type,
    callsign: looksLikeCallsign(report.station_name) ? report.station_name : undefined,
    name: looksLikeCallsign(report.station_name) ? undefined : report.station_name,
    weak_name: looksLikeCallsign(report.station_name) ? undefined : true,
    station_services: services,
  })];
  const hasCoords = [report.x, report.y, report.z].every((value) => typeof value === 'number' && Number.isFinite(value));
  ops.push(compactObject({
    op: 'location', carrier_id: id, at, system_name: report.system_name,
    ...(hasCoords ? { x: report.x, y: report.y, z: report.z } : {}), source_event: 'Market',
  }));
  const market = report.inventories?.market;
  const marketAt = market ? isoTime(market.observed_at) : undefined;
  if (market && marketAt) {
    ops.push({ op: 'baseline', carrier_id: id, at: marketAt, full: false, source_event: 'Market', items: carrierMarketCargo(market.items) });
  }
  return ops;
}

// ── Карточка носителя для интерфейса и Helper'а ────────────────────────────

export type CarrierRelation = 'own' | 'squadron' | 'public';

const SERVICE_LABELS: Record<string, string> = {
  captain: 'Капитан',
  refuel: 'Заправка',
  repair: 'Ремонт',
  rearm: 'Перевооружение',
  commodities: 'Рынок товаров',
  blackmarket: 'Чёрный рынок',
  voucherredemption: 'Обмен ваучеров',
  exploration: 'Universal Cartographics',
  shipyard: 'Верфь',
  outfitting: 'Снаряжение',
  carrierfuel: 'Склад тритиума',
  vistagenomics: 'Vista Genomics',
  pioneersupplies: 'Pioneer Supplies',
  bartender: 'Бар',
  squadronbank: 'Банк эскадрильи',
};

export function serviceLabel(role: string): string {
  return SERVICE_LABELS[role.toLowerCase()] ?? role;
}

const DOCKING_LABELS: Record<string, string> = {
  all: 'все пилоты',
  none: 'никто',
  friends: 'только друзья',
  squadron: 'только эскадрилья',
  squadronfriends: 'эскадрилья и друзья',
};

export function dockingLabel(access: string | null | undefined): string | null {
  if (!access) return null;
  return DOCKING_LABELS[access.toLowerCase()] ?? access;
}

export interface CarrierCargoView {
  commodity: string;
  name: string;
  quantity: number;
  baselineAt: string | null;
  baselineSource: string | null;
  updatedAt: string | null;
}

export interface CarrierView {
  carrierId: string;
  type: CarrierType;
  callsign: string | null;
  name: string | null;
  relation: CarrierRelation;
  ownerSource: string | null;
  squadronId: number | null;
  location: {
    system: string | null;
    systemAddress: string | null;
    body: string | null;
    coords: { x: number; y: number; z: number } | null;
    at: string | null;
    source: string | null;
    /** Носитель уже должен был прыгнуть, а подтверждения ещё нет. */
    estimated: boolean;
    previousSystem: string | null;
  };
  jump: { system: string; body: string | null; departureAt: string | null; requestedAt: string | null; state: 'scheduled' | 'jumping' } | null;
  status: {
    dockingAccess: string | null;
    dockingLabel: string | null;
    allowNotorious: boolean | null;
    fuelLevel: number | null;
    jumpRangeCurr: number | null;
    jumpRangeMax: number | null;
    pendingDecommission: boolean;
    statsAt: string | null;
  };
  services: Array<{ role: string; label: string; activated: boolean; enabled: boolean }>;
  stationServices: string[];
  space: {
    totalCapacity: number | null;
    cargo: number | null;
    freeSpace: number | null;
    reserved: number | null;
    cargoCapacity: number | null;
    statsAt: string | null;
  } | null;
  finance: Record<string, number> | null;
  cargo: {
    items: CarrierCargoView[];
    trackedTotal: number;
    baselineAt: string | null;
    baselineSource: string | null;
    updatedAt: string | null;
  } | null;
  orders: Array<{ commodity: string; name: string; purchase: number | null; sale: number | null; price: number | null; blackMarket: boolean; at: string | null }>;
  market: { observedAt: string; items: CarrierMarketItem[] } | null;
  updatedAt: string | null;
}

function displayName(commodity: string, localised: unknown): string {
  const name = typeof localised === 'string' && localised.trim() ? localised.trim() : '';
  return name || commodity;
}

function asNumberOrNull(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function asIso(value: unknown): string | null {
  if (value == null) return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/**
 * Строка fleet_carriers (+ груз и снимок рынка) → карточка.
 * `relation` решает маршрут: груз видят владелец и его эскадрилья, финансы —
 * владелец (и офицеры эскадрильи для эскадренного носителя).
 */
export function buildCarrierView(
  row: Record<string, any>,
  options: {
    relation: CarrierRelation;
    showFinance: boolean;
    cargoRows?: Array<Record<string, any>>;
    market?: { observed_at: string; items: CarrierMarketItem[] } | null;
    now?: Date;
  },
): CarrierView {
  const nowMs = (options.now ?? new Date()).getTime();
  const departureMs = row.jump_departure_at ? Date.parse(String(row.jump_departure_at)) : NaN;
  const jumpSystem = typeof row.jump_system_name === 'string' ? row.jump_system_name : null;
  const arrivedEstimated = Boolean(jumpSystem) && Number.isFinite(departureMs) && nowMs >= departureMs + JUMP_TRANSIT_MS;
  const usage = isRecord(row.space_usage) ? row.space_usage : null;
  const showCargo = options.relation !== 'public';

  const cargoItems: CarrierCargoView[] = (options.cargoRows ?? [])
    .filter((cargoRow) => Number(cargoRow.quantity) > 0)
    .map((cargoRow) => ({
      commodity: String(cargoRow.commodity),
      name: displayName(String(cargoRow.commodity), cargoRow.name_localised),
      quantity: Number(cargoRow.quantity),
      baselineAt: asIso(cargoRow.baseline_at),
      baselineSource: cargoRow.baseline_source ?? null,
      updatedAt: asIso(cargoRow.updated_at),
    }))
    .sort((left, right) => right.quantity - left.quantity || left.name.localeCompare(right.name));

  const orders = Object.entries(isRecord(row.trade_orders) ? row.trade_orders : {})
    .filter(([, order]) => isRecord(order))
    .map(([commodity, order]) => {
      const value = order as Record<string, unknown>;
      return {
        commodity,
        name: displayName(commodity, value.name),
        purchase: asNumberOrNull(value.purchase),
        sale: asNumberOrNull(value.sale),
        price: asNumberOrNull(value.price),
        blackMarket: value.black_market === true,
        at: asIso(value.at),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  const services = (Array.isArray(row.services) ? row.services : [])
    .filter(isRecord)
    .map((service) => ({
      role: String(service.role ?? ''),
      label: serviceLabel(String(service.role ?? '')),
      activated: service.activated === true,
      enabled: service.enabled === true,
    }))
    .filter((service) => service.role)
    .sort((left, right) => Number(right.activated) - Number(left.activated) || left.label.localeCompare(right.label));

  const cargoTons = usage ? asNumberOrNull(usage.cargo) : null;
  const freeSpace = usage ? asNumberOrNull(usage.free_space) : null;

  return {
    carrierId: String(row.carrier_id),
    type: row.carrier_type === 'SquadronCarrier' ? 'SquadronCarrier' : 'FleetCarrier',
    callsign: row.callsign ?? null,
    name: row.name ?? null,
    relation: options.relation,
    ownerSource: options.relation === 'own' ? row.owner_source ?? null : null,
    squadronId: row.squadron_id == null ? null : Number(row.squadron_id),
    location: {
      system: arrivedEstimated ? jumpSystem : row.system_name ?? null,
      systemAddress: arrivedEstimated ? (row.jump_system_address == null ? null : String(row.jump_system_address))
        : (row.system_address == null ? null : String(row.system_address)),
      body: arrivedEstimated ? row.jump_body_name ?? null : row.body_name ?? null,
      coords: !arrivedEstimated && [row.x, row.y, row.z].every((value) => value != null && Number.isFinite(Number(value)))
        ? { x: Number(row.x), y: Number(row.y), z: Number(row.z) } : null,
      at: asIso(row.location_at),
      source: row.location_source ?? null,
      estimated: arrivedEstimated,
      previousSystem: arrivedEstimated ? row.system_name ?? null : null,
    },
    jump: jumpSystem && !arrivedEstimated ? {
      system: jumpSystem,
      body: row.jump_body_name ?? null,
      departureAt: asIso(row.jump_departure_at),
      requestedAt: asIso(row.jump_requested_at),
      state: Number.isFinite(departureMs) && nowMs >= departureMs ? 'jumping' : 'scheduled',
    } : null,
    status: {
      dockingAccess: row.docking_access ?? null,
      dockingLabel: dockingLabel(row.docking_access),
      allowNotorious: typeof row.allow_notorious === 'boolean' ? row.allow_notorious : null,
      fuelLevel: asNumberOrNull(row.fuel_level),
      jumpRangeCurr: asNumberOrNull(row.jump_range_curr),
      jumpRangeMax: asNumberOrNull(row.jump_range_max),
      pendingDecommission: row.pending_decommission === true,
      statsAt: asIso(row.stats_at),
    },
    services,
    stationServices: Array.isArray(row.station_services) ? row.station_services.map(String) : [],
    space: usage ? {
      totalCapacity: asNumberOrNull(usage.total_capacity),
      cargo: cargoTons,
      freeSpace,
      reserved: asNumberOrNull(usage.cargo_space_reserved),
      // Под груз доступно занятое + свободное (TotalCapacity включает экипаж и паки).
      cargoCapacity: cargoTons != null && freeSpace != null ? cargoTons + freeSpace : null,
      statsAt: asIso(row.stats_at),
    } : null,
    finance: options.showFinance && isRecord(row.finance) ? row.finance as Record<string, number> : null,
    cargo: showCargo ? {
      items: cargoItems,
      trackedTotal: cargoItems.reduce((sum, item) => sum + item.quantity, 0),
      baselineAt: asIso(row.cargo_baseline_at),
      baselineSource: row.cargo_baseline_source ?? null,
      updatedAt: asIso(row.cargo_updated_at),
    } : null,
    orders,
    market: options.market && Array.isArray(options.market.items)
      ? { observedAt: asIso(options.market.observed_at) ?? String(options.market.observed_at), items: options.market.items }
      : null,
    updatedAt: asIso(row.updated_at),
  };
}

/** Разбор «как пилот ввёл носитель»: Carrier ID (MarketID) или позывной. */
export function parseCarrierReference(value: unknown): { carrierId: string } | { callsign: string } | null {
  const raw = String(value ?? '').trim().toUpperCase();
  if (!raw) return null;
  if (/^\d{6,18}$/.test(raw)) {
    const id = positiveId(raw);
    return id ? { carrierId: id } : null;
  }
  if (looksLikeCallsign(raw)) return { callsign: raw };
  return null;
}
