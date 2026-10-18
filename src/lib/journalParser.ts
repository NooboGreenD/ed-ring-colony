import {
  CONSTRUCTION_KINDS,
  classifyStation,
  constructionKindForStation,
  deliveryKindForStation,
  isConstructionStationKind,
  type DeliveryKind,
  type StationContext,
  type StationKind,
} from './cargoScope.ts';
import { systemKey as sharedSystemKey } from './systemIdentity.ts';

export type DeliverySource =
  | 'colonisation_contribution'
  | 'cargo_depot'
  | 'cargo_delta'
  /** Продажа груза на авианосце — фактическая отгрузка (как в Colonial Helper). */
  | 'carrier_delivery'
  /** Грузовые миссии: MissionCompleted с CargoDelivered. */
  | 'mission_delivery'
  /** Powerplay-поставки. */
  | 'powerplay_delivery'
  /** Search and Rescue: сдача груза. */
  | 'rescue_delivery';

/** Источники, которые засчитываются как доставка на стройплощадку. */
export const CONSTRUCTION_SOURCES: ReadonlySet<DeliverySource> = new Set<DeliverySource>([
  'colonisation_contribution',
  'cargo_depot',
]);

/**
 * Строка `deliveries.source` приходит из разных клиентов (браузерный
 * загрузчик, Colonial Helper), поэтому проверяется как текст, а не как
 * union-тип. Это fallback сервера для строк, где клиент не прислал ни
 * `is_construction`, ни `delivery_kind` (старые версии загрузчика): тогда
 * `colonisation_contribution` и `cargo_depot` считаются стройкой, как это
 * было до появления классификации станций.
 *
 * Сам парсер так больше не решает: `cargo_depot` — это груз миссий, и
 * строительным он становится только у рынка стройплощадки
 * (см. `classifyStation` в `cargoScope.ts`).
 */
export function isConstructionSourceName(source: string | null | undefined): boolean {
  if (!source) return false;
  return (CONSTRUCTION_SOURCES as ReadonlySet<string>).has(source.trim().toLowerCase());
}

export interface Delivery {
  systemName: string;
  commodity: string;
  amount: number;
  timestamp: string;
  /** Kept as text so 64-bit Elite IDs never pass through a JS Number. */
  marketId?: string | null;
  systemAddress?: string | null;
  source: DeliverySource;
  /** Stable per-journal-event identifier used to make leaderboard imports idempotent. */
  sourceHash: string;
  isHub?: boolean;
  routeSystemId?: number | null;
  /**
   * Доставка именно на стройплощадку (колонизационный проект), а не «вообще
   * куда»: по этому полю досье считает отдельный блок «тоннаж на стройки».
   */
  isConstruction?: boolean;
  /**
   * Куда именно ушёл груз: стройплощадка, колонизационный корабль, авианосец,
   * грузовая миссия, продажа на рынке, Powerplay, SAR. Из него
   * `isConstruction` выводится однозначно, но не наоборот — отсюда отдельное
   * поле в `deliveries` и отдельный блок «структура перевозок» в досье.
   */
  deliveryKind: DeliveryKind;
  /** Станция, у которой сдан груз (имя/тип из `Docked`/`Market`). */
  stationName?: string | null;
  stationKind?: StationKind | null;
}

export interface JournalParseStats {
  eventsParsed: number;
  cargoEvents: number;
  deliveriesFound: number;
  /** Direct, authoritative ColonisationContribution entries. */
  colonisationDeliveries: number;
  /** Direct CargoDepot deliveries, e.g. wing cargo missions. */
  cargoDepotDeliveries: number;
  /** Inventory-diff fallback when the journal has no explicit delivery event. */
  cargoDeltaDeliveries: number;
  /** Всё, что НЕ является доставкой на стройплощадку: продажи, миссии, спасатели. */
  transportDeliveries: number;
  /** Сколько тонн ушло именно на стройплощадки. */
  constructionTons: number;
  /** Сколько тонн перевезено всего (все источники). */
  transportedTons: number;
  /** Тоннаж и число операций по видам сдачи груза (`DeliveryKind`). */
  kindTons: Record<DeliveryKind, number>;
  kindOps: Record<DeliveryKind, number>;
  skippedNoSystem: number;
  skippedMarketTrade: number;
  skippedMining: number;
  skippedEject: number;
  skippedDuplicates: number;
}

export interface ParseResult {
  cmdrName: string | null;
  deliveries: Delivery[];
  stats: JournalParseStats;
  state: JournalParseState;
}

export interface SystemLookup {
  hubs: Set<string>; // lowercase normalized system names that are hubs
  routeSystems: Map<string, number>; // lowercase normalized system name -> route_systems.id
}

type CargoItem = { count: number; display: string };
type CargoInventory = Record<string, CargoItem>;

/**
 * Stateful context for consecutive Journal.*.log files. Journal inventory
 * snapshots and ColonisationContribution counters can span a file boundary,
 * so each selected file must not start from an empty state.
 */
export interface JournalParseState {
  cmdrName: string | null;
  currentSystem: string | null;
  currentSystemAddress: string | null;
  lastCargo: CargoInventory | null;
  contributionTotals: Map<string, number>;
  /** Commodity keys reported explicitly before the next Cargo snapshot. */
  accountedCargoKeys: Set<string>;
  /** A market/trade event changed cargo; don't mistake its next snapshot for delivery. */
  skipNextCargo: boolean;
  /** Delivery fingerprints across all selected files, not every raw journal event. */
  seenDeliveryHashes: Set<string>;
  /**
   * MarketID стройплощадок, замеченных в этом же разборе
   * (`ColonisationConstructionDepot`). Cargo-снимок сам по себе не говорит,
   * куда именно сдали груз, — привязка к рынку и делает доставку
   * «стройковой».
   */
  constructionMarkets: Set<string>;
  /** Рынок, к которому игрока причалил (`Docked`/`Market`), для той же привязки. */
  currentMarketId: string | null;
  /**
   * Станция, у которой стоит игрок: имя, тип и классификация. Именно она
   * решает, стройка это или обычная продажа, когда явного события поставки нет
   * (cargo_delta) или событие ничего не говорит о получателе (CargoDepot).
   */
  station: StationContext | null;
  sequence: number;
}

export function createJournalParseState(): JournalParseState {
  return {
    cmdrName: null,
    currentSystem: null,
    currentSystemAddress: null,
    lastCargo: null,
    contributionTotals: new Map(),
    accountedCargoKeys: new Set(),
    skipNextCargo: false,
    seenDeliveryHashes: new Set(),
    constructionMarkets: new Set(),
    currentMarketId: null,
    station: null,
    sequence: 0,
  };
}

// Ключ системы — общий для всего проекта (`systemIdentity.ts`); в source_hash не входит.
const systemKey = sharedSystemKey;

function commodityKey(value: unknown): string {
  // Ключ инвентаря должен совпадать с Python `build_inventory`:
  // `str(item.get("Name", "")).lower()` — без склейки подчёркиваний/пробелов
  // и без срезания $-префиксов. Любая лишняя нормализация делала source_hash
  // сайта и Helper'а разными, одинаковые поставки дублировались.
  return String(value ?? '').trim().toLowerCase();
}

function displayCommodity(value: unknown, fallback: string): string {
  const result = String(value ?? '').trim();
  if (result) return result;
  const readable = fallback
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  return readable ? readable.replace(/^./, (character) => character.toUpperCase()) : 'Unknown commodity';
}

function finitePositive(value: unknown): number | null {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  return number;
}

function finiteNonNegative(value: unknown): number {
  const number = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

/** Extract an integer token before JSON.parse can round a 64-bit value. */
function rawJournalInteger(line: string, field: string): string | null {
  // Field names are fixed, trusted Journal keys. Looking up the literal key
  // avoids constructing an escaping-sensitive regular expression while still
  // preserving the exact integer token from the original JSON line.
  const marker = `"${field}"`;
  const start = line.indexOf(marker);
  if (start < 0) return null;
  const remainder = line.slice(start + marker.length);
  const match = remainder.match(/^\s*:\s*(?:"(-?\d+)"|(-?\d+))/);
  const value = match?.[1] ?? match?.[2];
  return value && /^-?\d+$/.test(value) ? value : null;
}

function journalId(value: unknown, rawValue: string | null): string | null {
  if (rawValue != null) return rawValue;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

/**
 * Изоморфный SHA-256 в HEX — тот же алгоритм, что и Python `hashlib.sha256`.
 *
 * Исторически в браузере использовался быстрый 64-битный FNV (два 32-битных
 * FNV-lane в base36), а в Colonial Helper — настоящий SHA-256. Из-за этого
 * одна и та же строка журнала, загруженная сначала через сайт, потом через
 * Helper, давала ДВА РАЗНЫХ `source_hash`, и сервер записывал две одинаковые
 * поставки вместо того, чтобы увидеть идемпотентный повтор.
 *
 * Парсер работает и в браузере, и в Node (страница журнала дёргает
 * `parseColonisationEvents` на сервере в Route Handler'е), поэтому берём
 * чистую JS-реализацию, а не `crypto.subtle` (он асинхронный) и не
 * `node:crypto` (он недоступен в браузере).
 */
function sha256Hex(message: string): string {
  const bytes = new TextEncoder().encode(message);
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const rightRotate = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));
  const bitLength = bytes.length * 8;
  // Padding: 0x80, нули до 8-байтной длины с конца.
  const padded = new Uint8Array(((bytes.length + 9 + 63) >>> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  // 64-bit big-endian length — Journal-ы маленькие, старшее слово всегда 0.
  new DataView(padded.buffer).setUint32(padded.length - 4, bitLength >>> 0, false);
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const w = new Array<number>(64);
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) {
      const s0 = rightRotate(w[i - 15], 7) ^ rightRotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rightRotate(w[i - 2], 17) ^ rightRotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i += 1) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0;
      d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  return H.map((w) => (w >>> 0).toString(16).padStart(8, '0')).join('');
}

/** Stable deterministic hash, byte-identical to Python `hashlib.sha256` used by Colonial Helper. */
function fingerprint(value: string): string {
  return sha256Hex(value);
}

function buildInventory(inventory: unknown): CargoInventory | null {
  if (!Array.isArray(inventory)) return null;

  const result: CargoInventory = {};
  for (const item of inventory) {
    if (!item || typeof item !== 'object') continue;
    const rawName = (item as Record<string, unknown>).Name;
    const key = commodityKey(rawName);
    const count = finitePositive((item as Record<string, unknown>).Count);
    if (!key || count == null) continue;
    result[key] = {
      count,
      display: displayCommodity((item as Record<string, unknown>).Name_Localised, String(rawName ?? key)),
    };
  }
  return result;
}

const CARGO_RESET_EVENTS = new Set([
  'MarketBuy',
  'BuyDrones',
  'SellDrones',
  'MiningRefined',
  'EjectCargo',
  'CollectCargo',
  'CollectItems',
  'MissionCompleted',
  'MissionFailed',
  'MissionAbandoned',
  'Died',
  'Interdicted',
  'Interdiction',
  'CommunityGoal',
  'CommunityGoalReward',
  'TransferMicroResources',
  'TransferCargo',
  'CargoTransfer',
  'CarrierDepositFuel',
  'CarrierJumpRequest',
  'CarrierTradeOrder',
  'PowerplayCollect',
  'PowerplayDeliver',
  'PowerplayFastTrack',
  'LaunchSRV',
  'DockSRV',
  'ShipyardTransfer',
  'ShipyardSwap',
]);

/**
 * События, которые одновременно обнуляют трюмный baseline И сами несут
 * поставки. Их нельзя отбрасывать вместе с остальными reset-событиями,
 * иначе «перевезено миссиями/Powerplay» никогда не попадёт в «всего тонн».
 */
const DELIVERY_BEARING_RESET_EVENTS = new Set(['MissionCompleted', 'PowerplayDeliver', 'SearchAndRescue']);

function updateLocation(state: JournalParseState, event: Record<string, unknown>, rawLine: string) {
  const starSystem = typeof event.StarSystem === 'string' ? event.StarSystem.trim() : '';
  const address = journalId(event.SystemAddress, rawJournalInteger(rawLine, 'SystemAddress'));
  if (starSystem) {
    const changedSystem = systemKey(state.currentSystem) !== systemKey(starSystem);
    state.currentSystem = starSystem;
    // Avoid attributing an address from the preceding system when a compact
    // Journal event names a new system but has no SystemAddress field.
    if (changedSystem) {
      if (!address) state.currentSystemAddress = null;
      // Cargo snapshots belong to a location. Do not compare an arrival
      // snapshot with one from the previous system: a delivery just before a
      // jump may not have emitted its own post-delivery Cargo event.
      state.lastCargo = null;
      // Direct delivery events only suppress the following inventory snapshot
      // at that depot, never a later Cargo snapshot after a hyperspace jump.
      state.accountedCargoKeys.clear();
    }
  }
  if (address) state.currentSystemAddress = address;
}

/**
 * Обновить «где стоит игрок» по событию `Docked`/`Location`/`Market`/
 * `CarrierJump`/`FSDJump`/`Undocked`.
 *
 * Имя и тип станции — единственный способ отличить рынок стройплощадки от
 * обычного порта, когда явного события поставки нет. Правила совпадают с
 * `uploader/colonisation.py`, поэтому сайт и Colonial Helper не могут
 * разойтись в том, что считать строительным тоннажом.
 */
function updateStation(
  state: JournalParseState,
  eventName: string,
  event: Record<string, unknown>,
  rawLine: string,
) {
  if (eventName === 'Undocked') {
    state.station = null;
    state.currentMarketId = null;
    return;
  }

  const marketId = journalId(event.MarketID, rawJournalInteger(rawLine, 'MarketID'));
  // `Location` с Docked:false и прыжок без станции — игрок не у рынка.
  const docked = event.Docked === true || eventName === 'Docked' || eventName === 'Market';
  const stationName = typeof event.StationName === 'string' ? event.StationName.trim() : '';

  if (!docked && eventName !== 'CarrierJump') {
    state.station = null;
    state.currentMarketId = null;
    return;
  }

  const previous = state.station;
  const kind = classifyStation({
    name: stationName || previous?.name,
    type: event.StationType,
    services: event.StationServices,
    economy: event.StationEconomy,
    carrierId: event.CarrierID,
  });
  state.station = {
    marketId: marketId ?? previous?.marketId ?? null,
    name: stationName || previous?.name || '',
    type: typeof event.StationType === 'string' && event.StationType.trim()
      ? event.StationType.trim()
      : previous?.type || '',
    kind,
  };
  state.currentMarketId = marketId ?? previous?.marketId ?? null;
}

/**
 * Классификация станции, у которой сдан груз.
 *
 * `ColonisationConstructionDepot` остаётся дополнительным признаком: рынок,
 * про который журнал показывал состояние стройки, — точно стройплощадка, даже
 * если `Docked` пришёл без имени станции (старые записи, ретрансляторы CAPI).
 */
function stationKindAt(state: JournalParseState, marketId: string | null): StationKind {
  const stationKind = state.station?.kind ?? 'unknown';
  if (isConstructionStationKind(stationKind)) return stationKind;
  const market = marketId ?? state.currentMarketId ?? state.station?.marketId ?? null;
  if (market && state.constructionMarkets.has(market)) return 'construction_site';
  if (state.station && state.station.marketId && state.constructionMarkets.has(state.station.marketId)) {
    return 'construction_site';
  }
  return stationKind;
}

function stationNameAt(state: JournalParseState): string | null {
  const name = state.station?.name?.trim();
  return name ? name : null;
}

function tagDelivery(delivery: Delivery, lookup?: SystemLookup): Delivery {
  if (!lookup) return delivery;
  const key = systemKey(delivery.systemName);
  return {
    ...delivery,
    isHub: lookup.hubs.has(key),
    routeSystemId: lookup.routeSystems.get(key) ?? null,
  };
}

function emitDelivery(
  deliveries: Delivery[],
  state: JournalParseState,
  stats: JournalParseStats,
  delivery: Delivery,
  lookup?: SystemLookup,
) {
  if (!delivery.systemName || !delivery.commodity || !Number.isFinite(delivery.amount) || delivery.amount <= 0) return;

  if (state.seenDeliveryHashes.has(delivery.sourceHash)) {
    stats.skippedDuplicates += 1;
    return;
  }
  state.seenDeliveryHashes.add(delivery.sourceHash);
  const withFlag: Delivery = {
    ...delivery,
    // Признак стройки выводится из вида сдачи груза: стройплощадка и
    // колонизационный корабль — стройка, авианосец/миссия/рынок — перевозка.
    // Явно переданный `isConstruction` (тесты, особые случаи) имеет приоритет.
    isConstruction: delivery.isConstruction ?? CONSTRUCTION_KINDS.has(delivery.deliveryKind),
    stationName: delivery.stationName ?? stationNameAt(state),
    stationKind: delivery.stationKind ?? state.station?.kind ?? null,
  };
  deliveries.push(tagDelivery(withFlag, lookup));
  stats.deliveriesFound += 1;
  // Две разные метрики, ради которых и заводился флаг: «всё, что перевезено»
  // (блок «Всего тонн» в досье) и «только на стройплощадки» (новый блок).
  stats.transportedTons += withFlag.amount;
  if (withFlag.isConstruction) stats.constructionTons += withFlag.amount;
  else stats.transportDeliveries += 1;
  stats.kindTons[withFlag.deliveryKind] = (stats.kindTons[withFlag.deliveryKind] ?? 0) + withFlag.amount;
  stats.kindOps[withFlag.deliveryKind] = (stats.kindOps[withFlag.deliveryKind] ?? 0) + 1;
  if (withFlag.source === 'colonisation_contribution') stats.colonisationDeliveries += 1;
  else if (withFlag.source === 'cargo_depot') stats.cargoDepotDeliveries += 1;
  else if (withFlag.source === 'cargo_delta') stats.cargoDeltaDeliveries += 1;
}

/** Нулевые счётчики по видам сдачи груза (см. `DeliveryKind`). */
export function emptyKindRecord(): Record<DeliveryKind, number> {
  return {
    construction_site: 0,
    colonisation_ship: 0,
    fleet_carrier: 0,
    mission_delivery: 0,
    powerplay_delivery: 0,
    rescue_delivery: 0,
    market_sale: 0,
    legacy_site: 0,
  };
}

/** Нормализация FDName ровно как в Python _normalize_name: убрать ведущий $ и
 *  суффикс _name; без lowercasing и склейки подчёркиваний — иначе source_hash
 *  у сайта и у Colonial Helper разойдётся. */
function pyNormalizeName(name: unknown): string {
  const raw = String(name ?? '');
  if (raw.startsWith('$') && raw.includes('_name')) {
    return raw.split(';')[0].replace(/^\$+/, '').replace(/_name$/, '');
  }
  return raw;
}

type Contribution = { key: string; /** имя для source_hash (как в Python) */ hashName: string; display: string; amount: number };

function colonisationContributions(event: Record<string, unknown>): Contribution[] {
  const rawContributions = Array.isArray(event.Contributions)
    ? event.Contributions
    : event.Contribution && typeof event.Contribution === 'object'
      ? [event.Contribution]
      : [];

  const values: Contribution[] = [];
  for (const rawContribution of rawContributions) {
    if (!rawContribution || typeof rawContribution !== 'object') continue;
    const contribution = rawContribution as Record<string, unknown>;
    const rawName = contribution.Name ?? contribution.Commodity;
    const key = commodityKey(rawName);
    // Python для source_hash использует _normalize_name(Name), а не commodityKey.
    const hashName = pyNormalizeName(rawName);
    const amount = finitePositive(contribution.Amount);
    if (!key || amount == null) continue;
    values.push({
      key,
      hashName,
      display: displayCommodity(contribution.Name_Localised ?? contribution.Commodity_Localised, String(rawName)),
      amount,
    });
  }
  return values;
}

/**
 * Хук на каждое корректно разобранное событие журнала.
 *
 * Нужен, чтобы второй проход по тексту (телеметрия: сканы тел, snapshots
 * строек, статистика пилота) не удваивал стоимость разбора всей истории.
 * Исключение из хука не должно ломать импорт, поэтому вызов обёрнут.
 */
export type JournalEventHook = (line: string, event: Record<string, unknown>) => void;

function runHooks(hooks: JournalEventHook[] | undefined, line: string, event: Record<string, unknown>) {
  if (!hooks || hooks.length === 0) return;
  for (const hook of hooks) {
    try {
      hook(line, event);
    } catch {
      // Коллекторы — best-effort: телеметрия не имеет права обрывать импорт.
    }
  }
}

/**
 * Parse one journal text buffer. Pass the `state` returned from the preceding
 * file to preserve inventory and contribution context across a large upload.
 */
export function parseJournal(
  text: string,
  lookup?: SystemLookup,
  state: JournalParseState = createJournalParseState(),
  hooks?: JournalEventHook[],
): ParseResult {
  const deliveries: Delivery[] = [];
  const stats: JournalParseStats = {
    eventsParsed: 0,
    cargoEvents: 0,
    deliveriesFound: 0,
    colonisationDeliveries: 0,
    cargoDepotDeliveries: 0,
    cargoDeltaDeliveries: 0,
    transportDeliveries: 0,
    constructionTons: 0,
    transportedTons: 0,
    kindTons: emptyKindRecord(),
    kindOps: emptyKindRecord(),
    skippedNoSystem: 0,
    skippedMarketTrade: 0,
    skippedMining: 0,
    skippedEject: 0,
    skippedDuplicates: 0,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    state.sequence += 1;
    stats.eventsParsed += 1;
    runHooks(hooks, line, event);
    const eventName = typeof event.event === 'string' ? event.event : 'Unknown';

    if (eventName === 'Commander' && typeof event.Name === 'string' && event.Name.trim()) {
      state.cmdrName = event.Name.trim();
      continue;
    }
    if (eventName === 'LoadGame') {
      if (!state.cmdrName && typeof event.Commander === 'string' && event.Commander.trim()) {
        state.cmdrName = event.Commander.trim();
      }
      updateLocation(state, event, line);
      continue;
    }

    if (eventName === 'Location' || eventName === 'FSDJump' || eventName === 'Docked' || eventName === 'CarrierJump') {
      updateLocation(state, event, line);
      // Догадываться о рынке можно только по самим этим событиям: ветка
      // «Docked/Undocked/Market» ниже до них не доходит (continue здесь).
      // Прыжок без MarketID — это отстыковка, поэтому предыдущий рынок
      // обязательно сбрасывается, иначе cargo_delta записался бы на стройку
      // в системе, где игрока уже нет.
      const arrivedMarketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      if (eventName === 'Docked' || eventName === 'CarrierJump') {
        if (arrivedMarketId) state.currentMarketId = arrivedMarketId;
        updateStation(state, eventName, event, line);
      } else {
        state.currentMarketId = arrivedMarketId ?? null;
        updateStation(state, eventName, event, line);
      }
      continue;
    }

    // Some generated/relayed Journal records include StarSystem directly on a
    // contribution or depot event. Accept that stronger location evidence too.
    if (typeof event.StarSystem === 'string' || event.SystemAddress != null) {
      updateLocation(state, event, line);
    }

    if (CARGO_RESET_EVENTS.has(eventName) && !DELIVERY_BEARING_RESET_EVENTS.has(eventName)) {
      state.skipNextCargo = true;
      if (eventName === 'MarketBuy' || eventName === 'MarketSell' || eventName === 'BuyDrones' || eventName === 'SellDrones') {
        stats.skippedMarketTrade += 1;
      } else if (eventName === 'MiningRefined') {
        stats.skippedMining += 1;
      } else if (eventName === 'EjectCargo' || eventName === 'CollectCargo' || eventName === 'CollectItems') {
        stats.skippedEject += 1;
      }
      continue;
    }

    const systemName = typeof event.StarSystem === 'string' && event.StarSystem.trim()
      ? event.StarSystem.trim()
      : state.currentSystem;
    if (systemName && typeof event.StarSystem === 'string') state.currentSystem = systemName;
    const timestamp = typeof event.timestamp === 'string' && event.timestamp ? event.timestamp : `sequence:${state.sequence}`;

    if (eventName === 'ColonisationContribution') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      const contributions = colonisationContributions(event);
      if (!systemName) {
        if (contributions.length > 0) stats.skippedNoSystem += contributions.length;
        continue;
      }

      for (const contribution of contributions) {
        // Amount в ColonisationContribution — сколько завезено ЭТИМ событием
        // (то же чтение, что и в Uploader: `journal_parser.parse_events`).
        // Прежняя «накопительная» трактовка съедала вторую и последующие
        // поставки на той же стройке. Тоталь всё же копим: он нужен, чтобы
        // отличить повтор строки журнала от новой поставки (sourceHash ниже).
        const contributionKey = `${marketId ?? `system:${systemKey(systemName)}`}:${contribution.key}`;
        state.contributionTotals.set(contributionKey, contribution.amount);
        state.accountedCargoKeys.add(contribution.key);

        const amount = contribution.amount;
        if (amount <= 0) continue;
        // Куда именно сдано: стройплощадка или колонизационный корабль
        // (первый порт системы). Оба — строительный тоннаж.
        emitDelivery(deliveries, state, stats, {
          systemName,
          commodity: contribution.display,
          amount,
          timestamp,
          marketId,
          systemAddress: state.currentSystemAddress,
          isConstruction: true,
          deliveryKind: constructionKindForStation(stationKindAt(state, marketId)),
          source: 'colonisation_contribution',
          // Имя в хеше — как в Python _normalize_name(Name), а не commodityKey.
          sourceHash: `journal-v2-${fingerprint(`contribution\u0000${line}\u0000${contribution.hashName}\u0000${amount}`)}`,
        }, lookup);
      }
      continue;
    }

    if (eventName === 'ColonisationConstructionDepot') {
      // Не доставка, а состояние стройки: рынок, привязанный к ней, делает
      // последующие cargo_delta «поставкой на стройплощадку».
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      if (marketId) state.constructionMarkets.add(marketId);
      continue;
    }

    if (eventName === 'Docked' || eventName === 'Undocked' || eventName === 'Market') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      state.currentMarketId = eventName === 'Undocked' ? null : (marketId ?? state.currentMarketId);
      // `Market` и `Undocked` приходят отдельно от `Docked`: без них рынок
      // стройплощадки остался бы неизвестным, если игрок открыл павильон
      // позже пристыковки или улетел, не дожидаясь нового `Docked`.
      updateStation(state, eventName, event, line);
      continue;
    }

    if (eventName === 'MarketSell') {
      // Продажа груза — тоже перевезённый груз, но не поставка на стройку:
      // на стройплощадке груз сдаётся через вклад в колонизацию
      // (`ColonisationContribution`), а не продажей. На авианосце это
      // фактическая отгрузка (ровно как в Uploader).
      const count = finitePositive(event.Count);
      if (systemName && count != null) {
        const stationType = String(event.StationType ?? '');
        const onCarrier = Boolean(event.CarrierID) || /carrier/i.test(stationType);
        // FDName-токен (Type), приведённый так же, как Python _normalize_name:
        // убираем ведущий $ и суффикс _name;. Пробелы/подчёркивания НЕ трогаем,
        // в нижний регистр НЕ переводим — source_hash должен совпасть байт-в-байт.
        const rawType = String(event.Type ?? event.Commodity ?? '');
        const normalizedType = rawType.startsWith('$') && rawType.includes('_name')
          ? rawType.split(';')[0].replace(/^\$+/, '').replace(/_name$/, '')
          : rawType;
        const rawCommodity = normalizedType;
        // То же имя товара для source_hash, что и в Python-парсере:
        // Type_Localised (если есть), иначе нормализованное FDName.
        const commodityForHash = String(event.Type_Localised ?? normalizedType);
        emitDelivery(deliveries, state, stats, {
          systemName,
          commodity: displayCommodity(event.Type_Localised, String(rawCommodity || 'Unknown commodity')),
          amount: count,
          timestamp,
          marketId: journalId(event.MarketID, rawJournalInteger(line, 'MarketID')),
          systemAddress: state.currentSystemAddress,
          isConstruction: false,
          deliveryKind: onCarrier ? 'fleet_carrier' : 'market_sale',
          source: onCarrier ? 'carrier_delivery' : 'cargo_delta',
          sourceHash: `journal-v2-${fingerprint(`${onCarrier ? 'carrier' : 'sell'}\u0000${line}\u0000${commodityForHash}\u0000${count}`)}`,
        }, lookup);
      }
      state.skipNextCargo = true;
      continue;
    }

    if (eventName === 'MissionCompleted') {
      // Грузовые миссии (в том числе крыльевые Cargo Run): CargoDelivered —
      // самый честный источник «перевезено», пока Cargo-снимок его не удвоил.
      const delivered = Array.isArray(event.CargoDelivered) ? event.CargoDelivered : [];
      const parts: Array<{ commodity: unknown; localised: unknown; amount: unknown }> = delivered.map((item) => {
        const entry = (item ?? {}) as Record<string, unknown>;
        return { commodity: entry.Commodity, localised: entry.Commodity_Localised, amount: entry.Count ?? entry.Delivered };
      });
      if (parts.length === 0 && typeof event.Commodity === 'string') {
        parts.push({ commodity: event.Commodity, localised: event.Commodity_Localised, amount: event.Count });
      }
      for (const part of parts) {
        const count = finitePositive(part.amount);
        const key = commodityKey(part.commodity);
        if (count == null || !key || !systemName) continue;
        emitDelivery(deliveries, state, stats, {
          systemName,
          commodity: displayCommodity(part.localised, String(part.commodity)),
          amount: count,
          timestamp,
          systemAddress: state.currentSystemAddress,
          isConstruction: false,
          deliveryKind: 'mission_delivery',
          source: 'mission_delivery',
          sourceHash: `journal-v2-${fingerprint(`mission\u0000${line}\u0000${key}\u0000${count}`)}`,
        }, lookup);
        state.accountedCargoKeys.add(key);
      }
      state.skipNextCargo = true;
      continue;
    }

    if (eventName === 'PowerplayDeliver' || eventName === 'SearchAndRescue') {
      const count = finitePositive(event.Count);
      const key = commodityKey(event.Commodity ?? event.Type ?? '');
      if (count != null && key && systemName) {
        emitDelivery(deliveries, state, stats, {
          systemName,
          commodity: displayCommodity(event.Commodity_Localised, String(event.Commodity ?? event.Type ?? key)),
          amount: count,
          timestamp,
          systemAddress: state.currentSystemAddress,
          isConstruction: false,
          deliveryKind: eventName === 'PowerplayDeliver' ? 'powerplay_delivery' : 'rescue_delivery',
          source: eventName === 'PowerplayDeliver' ? 'powerplay_delivery' : 'rescue_delivery',
          sourceHash: `journal-v2-${fingerprint(`${eventName.toLowerCase()}\u0000${line}\u0000${key}\u0000${count}`)}`,
        }, lookup);
      }
      state.skipNextCargo = true;
      continue;
    }

    if (eventName === 'CargoDepot') {
      const updateType = typeof event.UpdateType === 'string' ? event.UpdateType.toLowerCase() : '';
      const amount = finitePositive(event.Count);
      const rawCommodity = String(event.CargoType_Localised ?? event.CargoType ?? '');
      const key = commodityKey(rawCommodity);
      if (updateType !== 'deliver' || amount == null || !key) continue;
      if (!systemName) {
        stats.skippedNoSystem += 1;
        continue;
      }

      state.accountedCargoKeys.add(key);
      // `CargoDepot` — это склад грузовой миссии (в том числе крыльевой
      // Cargo Run). Стройкой он становится только тогда, когда сдан у рынка
      // стройплощадки/колонизационного корабля: иначе тоннаж миссий
      // молча записывался колонизационным.
      const stationKind = stationKindAt(state, state.currentMarketId);
      emitDelivery(deliveries, state, stats, {
        systemName,
        commodity: displayCommodity(event.CargoType_Localised, String(rawCommodity)),
        amount,
        timestamp,
        marketId: state.currentMarketId,
        systemAddress: state.currentSystemAddress,
        deliveryKind: deliveryKindForStation(stationKind, 'mission_delivery'),
        stationKind,
        source: 'cargo_depot',
        // Для source_hash используем то же значение имени товара, что и
        // Python-парсер (CargoType_Localised иначе CargoType) — чтобы
        // загрузка через сайт и через Colonial Helper давала идентичные
        // хеши и не дублировала поставки.
        sourceHash: `journal-v2-${fingerprint(`cargo-depot\u0000${line}\u0000${rawCommodity}\u0000${amount}`)}`,
      }, lookup);
      continue;
    }

    if (eventName !== 'Cargo') continue;

    stats.cargoEvents += 1;
    const inventory = buildInventory(event.Inventory);
    if (!inventory) {
      state.skipNextCargo = false;
      state.accountedCargoKeys.clear();
      continue;
    }

    if (state.skipNextCargo) {
      state.skipNextCargo = false;
      state.accountedCargoKeys.clear();
      state.lastCargo = inventory;
      continue;
    }

    if (!state.lastCargo) {
      state.lastCargo = inventory;
      state.accountedCargoKeys.clear();
      continue;
    }

    if (!systemName) {
      stats.skippedNoSystem += 1;
      state.lastCargo = inventory;
      state.accountedCargoKeys.clear();
      continue;
    }

    for (const [key, previous] of Object.entries(state.lastCargo)) {
      const current = inventory[key];
      const currentCount = current?.count ?? 0;
      const amount = previous.count - currentCount;
      if (amount <= 0) continue;

      // Direct ColonisationContribution/CargoDepot events are more reliable.
      // Their accompanying Cargo snapshot must not create a second trip.
      if (state.accountedCargoKeys.has(key)) continue;

      const deltaStationKind = stationKindAt(state, state.currentMarketId);
      emitDelivery(deliveries, state, stats, {
        systemName,
        commodity: previous.display,
        amount,
        timestamp,
        marketId: state.currentMarketId,
        systemAddress: state.currentSystemAddress,
        // Груз «испарился» из трюма, пока игрок стоит у рынка стройплощадки
        // или колонизационного корабля, — значит это поставка на стройку.
        // У авианосца это отгрузка, в обычном павильоне — продажа.
        deliveryKind: deliveryKindForStation(deltaStationKind, 'market_sale'),
        stationKind: deltaStationKind,
        source: 'cargo_delta',
        sourceHash: `journal-v2-${fingerprint(`cargo-delta\u0000${line}\u0000${key}\u0000${previous.count}\u0000${currentCount}`)}`,
      }, lookup);
    }

    state.lastCargo = inventory;
    state.accountedCargoKeys.clear();
  }

  return { cmdrName: state.cmdrName, deliveries, stats, state };
}

export interface ParsedColonisationDepot {
  timestamp: string;
  systemName: string;
  marketId: string | null;
  constructionName: string;
  constructionId: string | null;
  constructionProgress: number;
  constructionComplete: boolean;
  resourcesRequired: {
    name: string;
    nameLocalised: string;
    requiredAmount: number;
    providedAmount: number;
    payment: number;
  }[];
}

export interface ParsedColonisationContribution {
  timestamp: string;
  systemName: string;
  marketId: string | null;
  commodity: string;
  commodityLocalised: string;
  amount: number;
  total: number;
}

function constructionProgress(value: unknown, complete: boolean): number {
  if (complete) return 100;
  const raw = finiteNonNegative(value);
  // Elite journals write 0.222472 for 22.2472%; older integrations may
  // already send 22.2472. Preserve both formats.
  return Math.min(100, raw <= 1 ? raw * 100 : raw);
}

/**
 * Parse construction snapshots for the Journal page/CAPI. IDs stay textual so
 * imported MarketID values continue to match Raven's 64-bit identifiers.
 */
export function parseColonisationEvents(text: string): {
  cmdrName: string | null;
  depotEvents: ParsedColonisationDepot[];
  contributionEvents: ParsedColonisationContribution[];
  stats: {
    eventsParsed: number;
    depotEventsFound: number;
    contributionEventsFound: number;
    fsdJumps: number;
  };
} {
  let cmdrName: string | null = null;
  let currentSystem: string | null = null;
  const depotEvents: ParsedColonisationDepot[] = [];
  const contributionEvents: ParsedColonisationContribution[] = [];
  const seen = new Set<string>();
  const stats = {
    eventsParsed: 0,
    depotEventsFound: 0,
    contributionEventsFound: 0,
    fsdJumps: 0,
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line[0] !== '{') continue;

    let event: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }

    stats.eventsParsed += 1;
    const eventName = typeof event.event === 'string' ? event.event : 'Unknown';
    if (eventName === 'Commander' && typeof event.Name === 'string') {
      cmdrName = event.Name || cmdrName;
      continue;
    }
    if (eventName === 'LoadGame') {
      if (!cmdrName && typeof event.Commander === 'string') cmdrName = event.Commander;
      if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) currentSystem = event.StarSystem.trim();
      continue;
    }
    if (eventName === 'Location' || eventName === 'Docked' || eventName === 'CarrierJump' || eventName === 'FSDJump') {
      if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) currentSystem = event.StarSystem.trim();
      if (eventName === 'FSDJump') stats.fsdJumps += 1;
      continue;
    }

    // CAPI relays and a few journal versions include StarSystem directly on
    // construction events. Retain it for the following compact event too.
    if (typeof event.StarSystem === 'string' && event.StarSystem.trim()) {
      currentSystem = event.StarSystem.trim();
    }

    const timestamp = typeof event.timestamp === 'string' ? event.timestamp : '';
    const systemName = typeof event.StarSystem === 'string' && event.StarSystem.trim()
      ? event.StarSystem.trim()
      : currentSystem || '';
    if (eventName === 'ColonisationConstructionDepot') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      const constructionId = journalId(event.ConstructionID, rawJournalInteger(line, 'ConstructionID'));
      const constructionComplete = event.ConstructionComplete === true;
      const dedupeKey = `depot:${timestamp}:${systemName}:${marketId ?? ''}:${constructionId ?? ''}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      const resources = Array.isArray(event.ResourcesRequired)
        ? event.ResourcesRequired
          .filter((resource): resource is Record<string, unknown> => !!resource && typeof resource === 'object')
          .map((resource) => ({
            name: String(resource.Name || ''),
            nameLocalised: displayCommodity(resource.Name_Localised, String(resource.Name || '')),
            requiredAmount: finiteNonNegative(resource.RequiredAmount),
            providedAmount: finiteNonNegative(resource.ProvidedAmount),
            payment: finiteNonNegative(resource.Payment),
          }))
        : [];

      depotEvents.push({
        timestamp,
        systemName,
        marketId,
        constructionName: String(event.ConstructionName || ''),
        constructionId,
        constructionProgress: constructionProgress(event.ConstructionProgress, constructionComplete),
        constructionComplete,
        resourcesRequired: resources,
      });
      stats.depotEventsFound += 1;
      continue;
    }

    if (eventName === 'ColonisationContribution') {
      const marketId = journalId(event.MarketID, rawJournalInteger(line, 'MarketID'));
      for (const contribution of colonisationContributions(event)) {
        const dedupeKey = `contribution:${timestamp}:${systemName}:${marketId ?? ''}:${contribution.key}:${contribution.amount}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        contributionEvents.push({
          timestamp,
          systemName,
          marketId,
          commodity: contribution.key,
          commodityLocalised: contribution.display,
          amount: contribution.amount,
          total: contribution.amount,
        });
        stats.contributionEventsFound += 1;
      }
    }
  }

  return { cmdrName, depotEvents, contributionEvents, stats };
}
