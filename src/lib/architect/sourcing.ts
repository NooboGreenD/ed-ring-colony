/**
 * «Где купить»: расчёт закупок под план застройки по данным рынков.
 *
 * Источник цен — своя база EDDN (`market_prices`, см. миграцию
 * `20260904010000_eddn_market_data.sql` и `/api/eddn/ingest`): строки
 * «станция + система + товар + цена + сток + время». Модуль сам в сеть не
 * ходит — строки ему передаёт `/api/architect/sourcing`, поэтому расчёт
 * проверяется тестами без сети.
 *
 * Что считается:
 *
 *  1. **Привязка товара.** EDDN пишет имя товара игровым токеном
 *     (`$Steel_Name;`), каталог плана — ключом (`steel`). Обе стороны
 *     приводятся к одному ключу (`normalizeCommodityKey`).
 *  2. **Расстояние.** Координаты систем берутся из каталога галактики
 *     (`galaxy_systems`), поэтому закупки сортируются «сначала ближе».
 *  3. **Раскладка по станциям.** По каждому товару берутся ближайшие рынки со
 *     стоком, пока потребность не закрыта; затем закупки группируются по
 *     станциям — получается список остановок с тоннажом, ценой и числом
 *     рейсов под выбранную вместимость.
 *
 * Модуль чистый: ни Supabase, ни fetch, ни React.
 */

import { commodityLabel } from './planner.ts';

export const DEFAULT_SOURCING_OPTIONS = {
  /** Дальше этого рынки не рассматриваются, световые годы. */
  maxDistanceLy: 80,
  /** Вместимость перевозчика для оценки числа рейсов, тонн. */
  capacityTons: 400,
  /** Сколько рынков учитывать на один товар. */
  maxOffersPerCommodity: 8,
  /** Сток меньше этого игнорируется — рейс того не стоит. */
  minStockTons: 1,
  /** Цены старше этого числа дней считаются протухшими. */
  maxAgeDays: 30,
} as const;

export interface ResolvedSourcingOptions {
  maxDistanceLy: number;
  capacityTons: number;
  maxOffersPerCommodity: number;
  minStockTons: number;
  maxAgeDays: number;
}

/** `$Steel_Name;` / `Steel` / `steel` → `steel`. */
export function normalizeCommodityKey(value: unknown): string {
  return String(value ?? '')
    .replace(/^\$+/, '')
    .replace(/_name;?$/i, '')
    .replace(/[^a-z0-9]+/gi, '')
    .toLowerCase();
}

/** Варианты имени товара для запроса к базе (точное совпадение, без LIKE). */
export function commodityNameVariants(key: string): string[] {
  const normalized = normalizeCommodityKey(key);
  if (!normalized) return [];
  const capitalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return Array.from(new Set([`$${normalized}_name;`, normalized, capitalized]));
}

export interface SystemCoords {
  x: number;
  y: number;
  z: number;
}

/** Строка `market_prices` — только нужные поля. */
export interface MarketPriceRow {
  station_name: string;
  system_name: string;
  commodity_name: string;
  sell_price: number | null;
  stock: number | null;
  reported_at?: string | null;
}

export interface MarketOffer {
  /** Ключ товара из каталога плана. */
  key: string;
  label: string;
  stationName: string;
  systemName: string;
  /** Цена продажи рынком, кр. за тонну. */
  price: number;
  stock: number;
  /** До целевой системы, св. лет; null — координат нет. */
  distanceLy: number | null;
  reportedAt: string | null;
  /** Возраст цены в днях; null — время не указано. */
  ageDays: number | null;
}

function num(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function distanceLy(a: SystemCoords | null | undefined, b: SystemCoords | null | undefined): number | null {
  if (!a || !b) return null;
  const dx = num(a.x) - num(b.x);
  const dy = num(a.y) - num(b.y);
  const dz = num(a.z) - num(b.z);
  return Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 100) / 100;
}

/**
 * Строки рынков → предложения по товарам плана.
 *
 * Товары, которых нет в плане, отбрасываются: расчёт отвечает ровно на вопрос
 * «что везти под эту стройку».
 */
export function buildOffers(
  cargo: Record<string, number>,
  rows: MarketPriceRow[],
  context: {
    origin?: SystemCoords | null;
    coordsByName?: Map<string, SystemCoords> | null;
    now?: number;
  } = {},
): MarketOffer[] {
  const wanted = new Set(Object.keys(cargo).map(normalizeCommodityKey).filter(Boolean));
  const now = context.now ?? Date.now();
  const coords = context.coordsByName ?? null;
  const offers: MarketOffer[] = [];

  for (const row of rows ?? []) {
    if (!row || typeof row !== 'object') continue;
    const key = normalizeCommodityKey(row.commodity_name);
    if (!key || !wanted.has(key)) continue;
    const price = num(row.sell_price);
    const stock = Math.floor(num(row.stock));
    if (stock <= 0 || price <= 0) continue;
    const systemName = String(row.system_name ?? '').trim();
    const reportedAt = typeof row.reported_at === 'string' ? row.reported_at : null;
    const reportedMs = reportedAt ? Date.parse(reportedAt) : Number.NaN;
    offers.push({
      key,
      label: commodityLabel(key),
      stationName: String(row.station_name ?? '').trim() || 'Неизвестная станция',
      systemName,
      price,
      stock,
      distanceLy: distanceLy(context.origin ?? null, coords?.get(systemName.toLowerCase()) ?? null),
      reportedAt,
      ageDays: Number.isFinite(reportedMs) ? Math.max(0, Math.round(((now - reportedMs) / 86_400_000) * 10) / 10) : null,
    });
  }

  return offers;
}

export function resolveSourcingOptions(options: Partial<ResolvedSourcingOptions> = {}): ResolvedSourcingOptions {
  const pick = (value: number | undefined, fallback: number, min: number): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
    return Math.max(min, value);
  };
  return {
    maxDistanceLy: pick(options.maxDistanceLy, DEFAULT_SOURCING_OPTIONS.maxDistanceLy, 1),
    capacityTons: Math.round(pick(options.capacityTons, DEFAULT_SOURCING_OPTIONS.capacityTons, 1)),
    maxOffersPerCommodity: Math.round(pick(options.maxOffersPerCommodity, DEFAULT_SOURCING_OPTIONS.maxOffersPerCommodity, 1)),
    minStockTons: Math.round(pick(options.minStockTons, DEFAULT_SOURCING_OPTIONS.minStockTons, 0)),
    maxAgeDays: pick(options.maxAgeDays, DEFAULT_SOURCING_OPTIONS.maxAgeDays, 1),
  };
}

export interface CommoditySourcing {
  key: string;
  label: string;
  neededTons: number;
  coveredTons: number;
  remainingTons: number;
  estimatedCost: number;
  averagePrice: number | null;
  offers: {
    stationName: string;
    systemName: string;
    price: number;
    tons: number;
    stock: number;
    distanceLy: number | null;
    ageDays: number | null;
  }[];
}

export interface ShoppingStop {
  stationName: string;
  systemName: string;
  distanceLy: number | null;
  items: { key: string; label: string; tons: number; price: number; cost: number }[];
  totalTons: number;
  totalCost: number;
  /** Рейсов при выбранной вместимости. */
  trips: number;
}

export interface SourcingPlan {
  commodities: CommoditySourcing[];
  stops: ShoppingStop[];
  summary: {
    neededTons: number;
    coveredTons: number;
    remainingTons: number;
    coveragePercent: number;
    estimatedCost: number;
    stationCount: number;
    trips: number;
    /** Сколько предложений отброшено как слишком дальние/старые. */
    skipped: number;
  };
  options: ResolvedSourcingOptions;
}

/**
 * Раскладка закупок по рынкам.
 *
 * Товары идут в порядке убывания тоннажа — так список читается как план
 * рейсов: сначала то, что занимает трюм. Рынки внутри товара сортируются по
 * расстоянию, при равенстве — по цене.
 */
export function planSourcing(
  cargo: Record<string, number>,
  offers: MarketOffer[],
  options: Partial<ResolvedSourcingOptions> = {},
): SourcingPlan {
  const resolved = resolveSourcingOptions(options);
  const stopMap = new Map<string, ShoppingStop>();
  const commodities: CommoditySourcing[] = [];
  let skipped = 0;

  const entries = Object.entries(cargo)
    .filter(([, tons]) => num(tons) > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));

  for (const [rawKey, needed] of entries) {
    const key = normalizeCommodityKey(rawKey);
    const candidates = offers
      .filter((offer) => offer.key === key)
      .filter((offer) => {
        const tooFar = offer.distanceLy != null && offer.distanceLy > resolved.maxDistanceLy;
        const tooOld = offer.ageDays != null && offer.ageDays > resolved.maxAgeDays;
        const tooSmall = offer.stock < resolved.minStockTons;
        if (tooFar || tooOld || tooSmall) skipped += 1;
        return !tooFar && !tooOld && !tooSmall;
      })
      .sort((left, right) => {
        const leftDistance = left.distanceLy ?? Number.POSITIVE_INFINITY;
        const rightDistance = right.distanceLy ?? Number.POSITIVE_INFINITY;
        if (leftDistance !== rightDistance) return leftDistance - rightDistance;
        return left.price - right.price || left.stationName.localeCompare(right.stationName);
      })
      .slice(0, resolved.maxOffersPerCommodity);

    let remaining = Math.ceil(num(needed));
    let covered = 0;
    let cost = 0;
    const chosen: CommoditySourcing['offers'] = [];

    for (const offer of candidates) {
      if (remaining <= 0) break;
      const tons = Math.min(offer.stock, remaining);
      if (tons <= 0) continue;
      remaining -= tons;
      covered += tons;
      cost += tons * offer.price;
      chosen.push({
        stationName: offer.stationName,
        systemName: offer.systemName,
        price: offer.price,
        tons,
        stock: offer.stock,
        distanceLy: offer.distanceLy,
        ageDays: offer.ageDays,
      });

      const stopKey = `${offer.systemName.toLowerCase()}::${offer.stationName.toLowerCase()}`;
      const stop = stopMap.get(stopKey) ?? {
        stationName: offer.stationName,
        systemName: offer.systemName,
        distanceLy: offer.distanceLy,
        items: [],
        totalTons: 0,
        totalCost: 0,
        trips: 0,
      };
      const existing = stop.items.find((item) => item.key === key);
      if (existing) {
        existing.tons += tons;
        existing.cost += tons * offer.price;
      } else {
        stop.items.push({ key, label: offer.label, tons, price: offer.price, cost: tons * offer.price });
      }
      stop.totalTons += tons;
      stop.totalCost += tons * offer.price;
      stopMap.set(stopKey, stop);
    }

    commodities.push({
      key,
      label: commodityLabel(key),
      neededTons: Math.ceil(num(needed)),
      coveredTons: covered,
      remainingTons: Math.max(0, remaining),
      estimatedCost: Math.round(cost),
      averagePrice: covered > 0 ? Math.round(cost / covered) : null,
      offers: chosen,
    });
  }

  const stops = Array.from(stopMap.values())
    .map((stop) => ({
      ...stop,
      totalCost: Math.round(stop.totalCost),
      trips: Math.max(1, Math.ceil(stop.totalTons / resolved.capacityTons)),
      items: stop.items.sort((left, right) => right.tons - left.tons || left.label.localeCompare(right.label)),
    }))
    .sort((left, right) => {
      const leftDistance = left.distanceLy ?? Number.POSITIVE_INFINITY;
      const rightDistance = right.distanceLy ?? Number.POSITIVE_INFINITY;
      if (leftDistance !== rightDistance) return leftDistance - rightDistance;
      return right.totalTons - left.totalTons;
    });

  const neededTons = commodities.reduce((sum, item) => sum + item.neededTons, 0);
  const coveredTons = commodities.reduce((sum, item) => sum + item.coveredTons, 0);

  return {
    commodities,
    stops,
    summary: {
      neededTons,
      coveredTons,
      remainingTons: Math.max(0, neededTons - coveredTons),
      coveragePercent: neededTons > 0 ? Math.round((coveredTons / neededTons) * 1000) / 10 : 0,
      estimatedCost: stops.reduce((sum, stop) => sum + stop.totalCost, 0),
      stationCount: stops.length,
      trips: stops.reduce((sum, stop) => sum + stop.trips, 0),
      skipped,
    },
    options: resolved,
  };
}

/** Форматирование кредитов: 12 345 678 кр. */
export function formatCredits(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—';
  return `${Math.round(value).toLocaleString('ru-RU')} кр.`;
}
