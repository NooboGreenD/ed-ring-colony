/**
 * Разгрузка «тоннажа» для досье пилота.
 *
 * Досье показывает два разных числа, и их нельзя получить одним и тем же
 * запросом: «весь перевозимый груз» — это каждая строка `deliveries`, а
 * «тоннаж на стройплощадки» — только те, что парсер журнала признал
 * поставкой на площадку колонизационного проекта. Флаг ставится на стороне
 * разбора (`src/lib/journalParser.ts`), потому что только там известно, КОДА
 * именно ушёл груз: у рынка стройки, на авианосце или в павильоне станции.
 *
 * Исторические строки (до миграции 20260917000000) не имеют признака вообще:
 * они считались стройкой всегда, поэтому `null`/`undefined` = стройка, а вот
 * явный `false` — уже перевозка. Иначе профили существующих игроков
 * обнулились бы после применения миграции.
 */

export type CargoDeliveryRow = {
  amount?: unknown;
  system_name?: unknown;
  /** `deliveries.is_construction`: true/false = журнал, null = историческая строка. */
  is_construction?: boolean | null;
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
  /** Тоннаж по системам, только строительные поставки, по убыванию. */
  siteSystems: [string, number][];
  /** Доля стройки в общем тоннаже, 0…100 (0 если тоннажа нет вовсе). */
  siteSharePercent: number;
};

/** Отрицательные/битые значения не должны уметь уменьшать чужой тоннаж. */
export function amountOf(value: unknown): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function isConstructionRow(row: CargoDeliveryRow | null | undefined): boolean {
  if (!row) return false;
  return row.is_construction !== false;
}

export function summarizeCargo(rows: readonly CargoDeliveryRow[] | null | undefined): CargoSummary {
  let totalTons = 0;
  let siteTons = 0;
  let siteOps = 0;
  let transportOps = 0;
  const siteSystems = new Map<string, number>();

  for (const row of rows ?? []) {
    const amount = amountOf(row?.amount);
    totalTons += amount;
    if (!isConstructionRow(row)) {
      if (amount > 0) transportOps += 1;
      continue;
    }
    if (amount <= 0) continue;
    siteTons += amount;
    siteOps += 1;
    const systemName = String(row.system_name ?? '').trim().replace(/\s+/g, ' ') || 'Unknown system';
    siteSystems.set(systemName, (siteSystems.get(systemName) ?? 0) + amount);
  }

  return {
    totalTons,
    siteTons,
    siteOps,
    transportOps,
    siteSystems: Array.from(siteSystems.entries()).sort((left, right) => right[1] - left[1]),
    siteSharePercent: totalTons > 0 ? (siteTons / totalTons) * 100 : 0,
  };
}
