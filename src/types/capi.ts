// ═══════════════════════════════════════════════════════════════
// Frontier CAPI Types
// ═══════════════════════════════════════════════════════════════
//
// Здесь ДВА слоя типов, и это принципиально:
//
//   • `CapiRaw*` — то, что реально отдаёт https://companion.orerve.net
//     (см. EDCD/FDevIDs → «Frontier API/FrontierDevelopments-CAPI-endpoints.md»
//     и klightspeed/EliteDangerousCompanionAPI → Profile.md);
//   • `CapiProfile` — плоская нормализованная форма, на которую опирается сайт
//     (`capi_profiles`, досье пилота, карта пилотов, синхронизация локации).
//
// Разделение появилось после разбора живого ответа CAPI: прежние типы
// описывали НЕсуществующие поля верхнего уровня — `credits`, `ranks`,
// `currentShip`, `currentSystem`, `currentStation`. На самом деле Frontier
// отдаёт их внутри `commander.credits`, `commander.rank`, `ship`,
// `lastSystem`, `lastStarport`. Из-за этого привязка «проходила», а в
// `capi_profiles` уходили одни NULL: имя командира ещё попадало, всё
// остальное — нет. Нормализация в `src/lib/capi/profile.ts`.

/* ── Сырые структуры Frontier ──────────────────────────────────── */

/** Ранги. Frontier присылает их в `commander.rank`, ключи — строчными. */
export interface CapiRawRanks {
  combat?: number;
  trade?: number;
  explore?: number;
  crime?: number;
  service?: number;
  empire?: number;
  federation?: number;
  power?: number;
  cqc?: number;
  /** Odyssey: «Mercenary» — на сайте это `mercenary_rank`. */
  soldier?: number;
  /** Odyssey: «Exobiologist». */
  exobiologist?: number;
}

export interface CapiRawCommander {
  id?: number | string;
  name?: string;
  credits?: number;
  debt?: number;
  currentShipId?: number;
  alive?: boolean;
  docked?: boolean;
  onfoot?: boolean;
  rank?: CapiRawRanks;
  capabilities?: Record<string, unknown>;
}

export interface CapiRawNamed {
  id?: number | string;
  name?: string;
  faction?: string;
  systemaddress?: number;
  [key: string]: unknown;
}

export interface CapiRawShip {
  id?: number;
  /** Тип корабля (FDev symbol), например `CobraMkIII`. */
  name?: string;
  /** Имя, данное пилотом. */
  shipName?: string;
  /** Бортовой номер, данный пилотом. */
  shipID?: string;
  value?: { hull?: number; modules?: number; cargo?: number; total?: number; unloaned?: number };
  free?: boolean;
  station?: CapiRawNamed;
  starsystem?: CapiRawNamed;
  alive?: boolean;
  modules?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Ответ `GET /profile` — как он приходит от Frontier. */
export interface CapiRawProfile {
  commander?: CapiRawCommander;
  lastSystem?: CapiRawNamed;
  /** Поля пустые строки, когда командир не пристыкован. */
  lastStarport?: CapiRawNamed;
  ship?: CapiRawShip;
  /**
   * Массив, если индексы кораблей идут подряд от нуля, иначе словарь
   * `{"4": {...}}` со строковыми ключами. Оба варианта нормальны.
   */
  ships?: Record<string, CapiRawShip> | CapiRawShip[];
  [key: string]: unknown;
}

/* ── Нормализованные структуры сайта ───────────────────────────── */

export interface CapiCommander {
  name: string | null;
  /** Frontier ID командира (в БД — текст). */
  id: string | null;
}

export interface CapiRanks {
  combat: number | null;
  trade: number | null;
  explore: number | null;
  empire: number | null;
  federation: number | null;
  cqc: number | null;
  /** «Mercenary» Odyssey. */
  soldier: number | null;
  exobiologist: number | null;
}

export interface CapiShip {
  shipId: number | null;
  shipType: string | null;
  shipName: string | null;
  shipIdent: string | null;
  value: number | null;
  systemName: string | null;
  stationName: string | null;
}

export interface CapiPlace {
  name: string;
  /** id64 системы, если Frontier его прислал. */
  systemAddress: number | null;
}

export interface CapiStation {
  name: string;
  id: number | null;
}

/**
 * Профиль в том виде, в котором его потребляет сайт.
 *
 * Имена полей сохранены со старой версии (`currentShip`, `currentSystem`,
 * `currentStation`, `ranks`, `credits`), поэтому вызывающий код не меняется —
 * меняется только то, что теперь они действительно заполнены.
 */
export interface CapiProfile {
  commander: CapiCommander;
  cmdrName: string | null;
  credits: number | null;
  /** `commander.debt` — «займ» в интерфейсе сайта. */
  loan: number | null;
  ranks: CapiRanks;
  /** Имя корабля, данное пилотом, иначе тип корабля. */
  currentShip: string | null;
  currentShipType: string | null;
  currentShipIdent: string | null;
  currentSystem: CapiPlace | null;
  /** Заполняется, только когда командир действительно пристыкован. */
  currentStation: CapiStation | null;
  /** Последняя известная станция, даже если сейчас в полёте. */
  lastStarport: CapiStation | null;
  docked: boolean;
  onFoot: boolean;
  alive: boolean;
  ships: CapiShip[];
  /** Сырой ответ — на случай диагностики; в БД не пишется. */
  raw?: CapiRawProfile;
}

export interface CapiTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

export interface CapiJournalEntry {
  event: string;
  timestamp: string;
  [key: string]: unknown;
}

/**
 * Результат `GET /journal`.
 *
 * Frontier отдаёт СЫРОЙ журнал — построчный JSON (NDJSON), а не объект
 * `{ events: [...] }`. Поэтому здесь и текст (его понимает
 * `parseColonisationEvents`), и уже разобранные события.
 */
export interface CapiJournal {
  /** Исходные строки журнала, склеенные через \n. */
  text: string;
  events: CapiJournalEntry[];
  /** HTTP 206: Frontier отдал журнал не целиком, стоит повторить позже. */
  partial: boolean;
  /** HTTP 204: в этот день командир не играл. */
  empty: boolean;
  /** Строки, которые не разобрались как JSON (битый хвост файла). */
  malformedLines: number;
}

export interface CapiMarketCommodity {
  id: number;
  name: string;
  category: string;
  buyPrice: number;
  sellPrice: number;
  meanPrice: number;
  stock: number;
  stockBracket: number;
  demand: number;
  demandBracket: number;
}

export interface CapiMarket {
  id: number;
  name: string;
  type: string;
  commodities: CapiMarketCommodity[];
}

export interface CapiFleetCarrierService {
  name: string;
  enabled: boolean;
  crew?: { name: string; faction: string };
}

export interface CapiFleetCarrierItinerary {
  system: string;
  body: string;
  arrival: string;
  departure?: string;
}

export interface CapiFleetCarrier {
  carrierName: string;
  carrierId: string;
  callsign: string;
  currentSystem: string;
  currentBody: string;
  balance: number;
  fuel: number;
  services: CapiFleetCarrierService[];
  market?: { commodities: { name: string; stock: number; buyPrice: number; sellPrice: number }[] };
  itinerary?: CapiFleetCarrierItinerary[];
}

export interface CapiCommunityGoalReward {
  type: string;
  amount: number;
}

export interface CapiCommunityGoal {
  cg_id: number;
  title: string;
  description: string;
  system_name: string;
  station_name: string;
  objective: string;
  reward: string;
  rewards?: CapiCommunityGoalReward[];
  tier_current: number;
  tier_max: number;
  contributors: number;
  contributions_total: number;
  expiry_date: string;
  is_complete: boolean;
}

export interface CapiCommunityGoalsResponse {
  goals: CapiCommunityGoal[];
}
