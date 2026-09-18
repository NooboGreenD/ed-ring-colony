/**
 * Разгрузка «тоннажа» для досье пилота.
 *
 * Досье показывает несколько разных чисел, и их нельзя получить одним и тем же
 * запросом: «весь перевозимый груз» — это каждая строка `deliveries`,
 * «тоннаж на стройплощадки» — только поставки колонизационным проектам, а
 * «структура перевозок» — разбивка того же тоннажа по получателю
 * (стройплощадка, колонизационный корабль, авианосец, грузовая миссия,
 * продажа на рынке, Powerplay, Search and Rescue).
 *
 * Признак ставится на стороне разбора (`src/lib/journalParser.ts` +
 * `uploader/journal_parser.py`), потому что только там известно, КОДА именно
 * ушёл груз: у рынка стройки, на авианосце или в павильоне станции. Словарь
 * видов — `src/lib/cargoScope.ts`, общий для парсера, импорта и досье.
 *
 * Исторические строки (до миграции 20260917000000) не имеют признака вообще:
 * они считались стройкой всегда, поэтому `null`/`undefined` = стройка, а вот
 * явный `false` — уже перевозка. Иначе профили существующих игроков
 * обнулились бы после применения миграции.
 */

import {
  CONSTRUCTION_KINDS,
  DELIVERY_KINDS,
  normalizeDeliveryKind,
  type DeliveryKind,
} from './cargoScope.ts';

export type CargoDeliveryRow = {
  amount?: unknown;
  system_name?: unknown;
  commodity?: unknown;
  /** `deliveries.is_construction`: true/false = журнал, null = историческая строка. */
  is_construction?: boolean | null;
  /** `deliveries.delivery_kind` — куда именно сдан груз. */
  delivery_kind?: unknown;
  /** `deliveries.source` — колонка журнала-источник (для старых строк). */
  source?: unknown;
  station_kind?: unknown;
};

export type CargoKindStat = {
  kind: DeliveryKind;
  tons: number;
  ops: number;
};

export type CargoSummary = {
  /** Сумма всех строк: весь перевозимый груз за всё время. */
  totalTons: number;
  /** Сумма только строительных поставок. */
  siteTons: number;
  /** Число поставок (не тонн) на стройплощадки. */
  siteOps: number;
  /** Число поставок, которые стройкой не были. */
  transportOps: number;
  /** Тоннаж перевозок, не относящихся к проектам. */
  transportTons: number;
  /** Тоннаж по системам, только строительные поставки, по убыванию. */
  siteSystems: [string, number][];
  /** Тоннаж по системам, только перевозки (авианосцы/миссии/рынки). */
  transportSystems: [string, number][];
  /** Топ товаров, сданных на стройплощадки. */
  siteCommodities: [string, number][];
  /** Разбивка тоннажа по получателю груза, только непустые виды. */
  kinds: CargoKindStat[];
  /** Тоннаж по видам (включая нули) — удобно для таблиц и тестов. */
  kindTons: Record<DeliveryKind, number>;
  kindOps: Record<DeliveryKind, number>;
  /** Доля стройки в общем тоннаже, 0…100 (0 если тоннажа нет вовсе). */
  siteSharePercent: number;
};

/** Отрицательные/битые значения не должны уметь уменьшать чужой тоннаж. */
export function amountOf(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

/**
 * Вид сдачи груза для строки `deliveries`.
 *
 * Порядок важности: явный `delivery_kind` → вывод из `source` у строк,
 * записанных до миграции → признак `is_construction` (исторические строки
 * считались стройкой).
 */
export function kindOfRow(row: CargoDeliveryRow | null | undefined): DeliveryKind {
  const explicit = normalizeDeliveryKind(row?.delivery_kind);
  if (explicit) return explicit;

  switch (String(row?.source ?? '').trim().toLowerCase()) {
    case 'colonisation_contribution':
      return 'construction_site';
    case 'carrier_delivery':
      return 'fleet_carrier';
    case 'mission_delivery':
    case 'cargo_depot':
      return 'mission_delivery';
    case 'powerplay_delivery':
      return 'powerplay_delivery';
    case 'rescue_delivery':
      return 'rescue_delivery';
    case 'cargo_delta':
      return row?.is_construction === false ? 'market_sale' : 'legacy_site';
    default:
      break;
  }

  return isConstructionRow(row) ? 'legacy_site' : 'market_sale';
}

export function isConstructionRow(row: CargoDeliveryRow | null | undefined): boolean {
  if (!row) return false;
  return row.is_construction !== false;
}

function emptyKindRecord(): Record<DeliveryKind, number> {
  const record = {} as Record<DeliveryKind, number>;
  for (const kind of DELIVERY_KINDS) record[kind] = 0;
  return record;
}

function sortedEntries(map: Map<string, number>): [string, number][] {
  return Array.from(map.entries()).sort((left, right) => right[1] - left[1]);
}

function bump(map: Map<string, number>, key: string, amount: number) {
  const normalized = key.trim().replace(/\s+/g, ' ') || 'Unknown';
  map.set(normalized, (map.get(normalized) ?? 0) + amount);
}

export function summarizeCargo(rows: readonly CargoDeliveryRow[] | null | undefined): CargoSummary {
  let totalTons = 0;
  let siteTons = 0;
  let siteOps = 0;
  let transportOps = 0;
  let transportTons = 0;
  const siteSystems = new Map<string, number>();
  const transportSystems = new Map<string, number>();
  const siteCommodities = new Map<string, number>();
  const kindTons = emptyKindRecord();
  const kindOps = emptyKindRecord();

  for (const row of rows ?? []) {
    const amount = amountOf(row?.amount);
    totalTons += amount;
    if (amount <= 0) continue;

    const kind = kindOfRow(row);
    kindTons[kind] += amount;
    kindOps[kind] += 1;

    const systemName = String(row?.system_name ?? '').trim().replace(/\s+/g, ' ');
    if (CONSTRUCTION_KINDS.has(kind)) {
      siteTons += amount;
      siteOps += 1;
      bump(siteSystems, systemName || 'Unknown system', amount);
      const commodity = String(row?.commodity ?? '').trim();
      if (commodity) bump(siteCommodities, commodity, amount);
      continue;
    }

    transportTons += amount;
    transportOps += 1;
    bump(transportSystems, systemName || 'Unknown system', amount);
  }

  return {
    totalTons,
    siteTons,
    siteOps,
    transportOps,
    transportTons,
    siteSystems: sortedEntries(siteSystems),
    transportSystems: sortedEntries(transportSystems),
    siteCommodities: sortedEntries(siteCommodities),
    kinds: DELIVERY_KINDS
      .filter((kind) => kindTons[kind] > 0 || kindOps[kind] > 0)
      .map((kind) => ({ kind, tons: kindTons[kind], ops: kindOps[kind] })),
    kindTons,
    kindOps,
    siteSharePercent: totalTons > 0 ? (siteTons / totalTons) * 100 : 0,
  };
}
