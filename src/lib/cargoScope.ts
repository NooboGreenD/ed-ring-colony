/**
 * Куда именно ушёл груз — единый словарь для парсера журнала, импорта и досье.
 *
 * Зачем отдельный модуль: «завезено на стройку» и «перевезено вообще» — это два
 * разных числа в досье, и раньше признак жил в виде булева `is_construction`
 * плюс набор `source`, из которого смысл восстанавливался догадками. Теперь у
 * каждой доставки есть явный `delivery_kind`, а станция, у которой стоит игрок,
 * классифицируется по тем же правилам, что и в Colonial Helper
 * (`uploader/colonisation.py::is_construction_site`).
 *
 * Три вещи, которые этот модуль гарантирует:
 *
 * 1. **Стройплощадки и колонизационные корабли** (`ColonisationContribution`,
 *    сдача груза у рынка с `Planetary/Orbital Construction Site` или
 *    `System Colonisation Ship`) считаются строительным тоннажом.
 * 2. **Всё остальное** — отгрузка на авианосец, грузовые миссии
 *    (`CargoDepot`/`MissionCompleted`), продажа на обычном рынке, Powerplay,
 *    Search and Rescue — попадает только в «всего тонн».
 * 3. **Исторические строки** (до миграции `deliveries_transport_scope`) без
 *    признака остаются стройкой: до этих правил в таблицу попадали только
 *    колонизационные поставки, иначе существующие досье обнулились бы.
 */

/** Куда именно сдан груз. Значение пишется в `deliveries.delivery_kind`. */
export type DeliveryKind =
  /** Стройплощадка колонизационного проекта (наземная или орбитальная). */
  | 'construction_site'
  /** Колонизационный корабль системы — «System Colonisation Ship». */
  | 'colonisation_ship'
  /** Отгрузка/продажа на авианосце (Fleet Carrier). */
  | 'fleet_carrier'
  /** Грузовая миссия: `CargoDepot` или `MissionCompleted.CargoDelivered`. */
  | 'mission_delivery'
  /** Powerplay-поставка. */
  | 'powerplay_delivery'
  /** Search and Rescue: сдача спасательного груза. */
  | 'rescue_delivery'
  /** Продажа товара на обычном рынке (не стройплощадка, не авианосец). */
  | 'market_sale'
  /** Строка без признака источника: исторический импорт, трактуется как стройка. */
  | 'legacy_site';

export const DELIVERY_KINDS: readonly DeliveryKind[] = [
  'construction_site',
  'colonisation_ship',
  'fleet_carrier',
  'mission_delivery',
  'powerplay_delivery',
  'rescue_delivery',
  'market_sale',
  'legacy_site',
];

/** Виды, которые попадают в блок «завезено на стройплощадки/колонизацию». */
export const CONSTRUCTION_KINDS: ReadonlySet<DeliveryKind> = new Set<DeliveryKind>([
  'construction_site',
  'colonisation_ship',
  'legacy_site',
]);

/** Русские подписи для досье/сводки импорта (UI-слой переиспользует их). */
export const DELIVERY_KIND_LABELS: Record<DeliveryKind, string> = {
  construction_site: 'Стройплощадки колонизации',
  colonisation_ship: 'Колонизационные корабли',
  fleet_carrier: 'Авианосцы',
  mission_delivery: 'Грузовые миссии',
  powerplay_delivery: 'Powerplay',
  rescue_delivery: 'Search and Rescue',
  market_sale: 'Продажа на рынках',
  legacy_site: 'Исторические поставки',
};

/** Краткое описание вида для подсказок в досье. */
export const DELIVERY_KIND_HINTS: Record<DeliveryKind, string> = {
  construction_site: 'ColonisationContribution и сдача груза у рынка стройплощадки',
  colonisation_ship: 'System Colonisation Ship — первый порт системы',
  fleet_carrier: 'Отгрузка на Fleet Carrier, в том числе по торговым ордерам',
  mission_delivery: 'CargoDepot и MissionCompleted: груз миссий, не проекты',
  powerplay_delivery: 'PowerplayDeliver',
  rescue_delivery: 'SearchAndRescue',
  market_sale: 'MarketSell на обычном рынке',
  legacy_site: 'Строки до миграции без признака источника',
};

export type StationKind =
  | 'construction_site'
  | 'colonisation_ship'
  | 'fleet_carrier'
  | 'megaship'
  | 'station'
  | 'outpost'
  | 'surface'
  | 'unknown';

export interface StationSignature {
  name?: unknown;
  type?: unknown;
  services?: unknown;
  economy?: unknown;
  carrierId?: unknown;
  marketId?: unknown;
  docked?: unknown;
}

export interface StationContext {
  /** MarketID станции, к которой причалил игрок (текст: 64-битный ID). */
  marketId: string | null;
  name: string;
  type: string;
  kind: StationKind;
}

/**
 * Признаки стройплощадки в `Docked.StationName`. Игра пишет три варианта:
 * наземная площадка, орбитальная площадка и «System Colonisation Ship»
 * (первый порт системы). Последний в журнале может прийти сырым токеном
 * локализации `$EXT_PANEL_ColonisationShip` без `_Localised`, поэтому
 * проверяем оба написания. Список обязан совпадать с
 * `uploader/colonisation.py::CONSTRUCTION_NAME_PREFIXES`.
 */
export const CONSTRUCTION_NAME_PREFIXES: readonly string[] = [
  'Planetary Construction Site:',
  'Orbital Construction Site:',
  '$EXT_PANEL_ColonisationShip',
];

export const COLONISATION_SHIP_NAMES: readonly string[] = [
  'System Colonisation Ship',
  '$EXT_PANEL_ColonisationShip',
];

/** Сервис станции, который бывает только у колонизационной площадки. */
export const CONSTRUCTION_STATION_SERVICE = 'colonisationcontribution';

/** Типы станций журнала, которые сами по себе говорят «это стройплощадка». */
const CONSTRUCTION_STATION_TYPES = ['planetaryconstructionsite', 'orbitalconstructionsite', 'constructionsite'];

export function isConstructionStationName(stationName: unknown): boolean {
  const name = String(stationName ?? '').trim();
  if (!name) return false;
  const lowered = name.toLowerCase();
  if (COLONISATION_SHIP_NAMES.some((value) => lowered === value.toLowerCase())) return true;
  return CONSTRUCTION_NAME_PREFIXES.some((prefix) => lowered.startsWith(prefix.toLowerCase()));
}

/** «System Colonisation Ship» — первый порт системы, он же колонизационный корабль. */
export function isColonisationShipStation(stationName: unknown): boolean {
  const name = String(stationName ?? '').trim();
  if (!name) return false;
  const lowered = name.toLowerCase();
  return COLONISATION_SHIP_NAMES.some((value) => lowered.startsWith(value.toLowerCase()));
}

function serviceList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item ?? '').trim().toLowerCase()).filter(Boolean);
}

/**
 * Классифицировать станцию, у которой стоит игрок.
 *
 * `services` необязателен: если он передан и непустой, для «площадки по имени»
 * дополнительно требуем сервис `colonisationcontribution` — иначе обычный
 * наземный порт с похожим именем попал бы в строительный тоннаж.
 */
export function classifyStation(signature: StationSignature | null | undefined): StationKind {
  if (!signature) return 'unknown';
  const name = String(signature.name ?? '').trim();
  const type = String(signature.type ?? '').trim();
  const services = serviceList(signature.services);
  const hasCarrierId = signature.carrierId != null && String(signature.carrierId).trim() !== '';

  if (hasCarrierId || /carrier/i.test(type)) return 'fleet_carrier';
  if (!name) {
    // Без имени станции судим только по типу: «PlanetaryConstructionSite»
    // журнал пишет и в `Market`, где имени нет вовсе.
    if (CONSTRUCTION_STATION_TYPES.some((value) => type.toLowerCase().includes(value))) return 'construction_site';
    return 'unknown';
  }

  const matchesName = isConstructionStationName(name);
  if (matchesName) {
    if (services.length > 0 && !services.includes(CONSTRUCTION_STATION_SERVICE)) return 'station';
    return isColonisationShipStation(name) ? 'colonisation_ship' : 'construction_site';
  }

  if (CONSTRUCTION_STATION_TYPES.some((value) => type.toLowerCase().includes(value))) return 'construction_site';
  if (/megaship/i.test(type)) return 'megaship';
  if (/outpost/i.test(type)) return 'outpost';
  if (/planetary|surface|installation/i.test(type)) return 'surface';
  return 'station';
}

/** Виды станции, которые делают доставку строительной. */
export function isConstructionStationKind(kind: StationKind | null | undefined): boolean {
  return kind === 'construction_site' || kind === 'colonisation_ship';
}

/** Стройплощадка/корабль → конкретный вид доставки. */
export function constructionKindForStation(kind: StationKind | null | undefined): DeliveryKind {
  return kind === 'colonisation_ship' ? 'colonisation_ship' : 'construction_site';
}

/**
 * Куда отнести груз, который «исчез» из трюма (cargo_delta) или сдан через
 * `CargoDepot`: решает станция, у которой стоит игрок, а не сам факт события.
 */
export function deliveryKindForStation(
  stationKind: StationKind | null | undefined,
  fallback: DeliveryKind,
): DeliveryKind {
  if (isConstructionStationKind(stationKind)) return constructionKindForStation(stationKind);
  if (stationKind === 'fleet_carrier') return 'fleet_carrier';
  return fallback;
}

/** Нормализовать значение из БД/клиента в известный вид. */
export function normalizeDeliveryKind(value: unknown): DeliveryKind | null {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  return (DELIVERY_KINDS as readonly string[]).includes(raw) ? (raw as DeliveryKind) : null;
}

/** Является ли значение из `deliveries.delivery_kind` строительным. */
export function isConstructionKindValue(value: unknown): boolean {
  const kind = normalizeDeliveryKind(value);
  return kind != null && CONSTRUCTION_KINDS.has(kind);
}
