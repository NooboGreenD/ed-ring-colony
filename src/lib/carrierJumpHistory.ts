/**
 * История прыжков авианосцев — вкладка «История» на `/carriers/jumps`.
 *
 * Живая таблица показывает заказы, которые исчезают через минуты после вылета.
 * Здесь — всё, что уже случилось: кто, откуда и куда прыгал за последний час,
 * день, месяц или год, и насколько интенсивно это происходило.
 *
 * Данные берутся из `carrier_jump_history` (миграция
 * `20261113120000_carrier_jump_history.sql`): строки пишут триггеры учёта
 * сайта и реестра EDDN. Сама эта библиотека ничего не знает про БД — только
 * правила: какие окна показывать, как нарезать их на корзины графика, как
 * подписать и отфильтровать строки. Их проверяет
 * `scripts/tests/carrier-jump-history.test.mjs`.
 */

/** Периоды вкладки: час, день, месяц, год. */
export type HistoryPeriod = '1h' | '1d' | '1m' | '1y';
export const HISTORY_PERIODS: readonly HistoryPeriod[] = ['1h', '1d', '1m', '1y'];

/** Насколько подробно режется график. */
export type HistoryGranularity = '5min' | 'hour' | 'day' | 'month';

/** Откуда пришло наблюдение прыжка. */
export type JumpHistorySource = 'site' | 'eddn';

export const HISTORY_GRANULARITY: Record<HistoryPeriod, HistoryGranularity> = {
  '1h': '5min',
  '1d': 'hour',
  '1m': 'day',
  '1y': 'month',
};

/** Сколько корзин в окне: 12 пятиминуток, 24 часа, 30 дней, 12 месяцев. */
export const HISTORY_BUCKET_COUNT: Record<HistoryPeriod, number> = {
  '1h': 12,
  '1d': 24,
  '1m': 30,
  '1y': 12,
};

/** Сколько строк истории отдаёт маршрут: страница табличная, не выгрузка. */
export const HISTORY_ROWS_LIMIT = 200;
/** Поиск идёт по последним строкам окна — столько их максимум в памяти. */
export const HISTORY_SEARCH_SCAN = 500;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Период из адреса или запроса: мусор не должен ломать страницу. */
export function parseHistoryPeriod(value: unknown): HistoryPeriod {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return (HISTORY_PERIODS as readonly string[]).includes(raw) ? raw as HistoryPeriod : '1d';
}

export function historyGranularity(period: HistoryPeriod): HistoryGranularity {
  return HISTORY_GRANULARITY[period];
}

/**
 * Начало корзин окна — все в UTC, по возрастанию.
 *
 * Пятиминутки и часы режутся от эпохи (`floor`), дни и месяцы — календарно:
 * так подпись «14:00» всегда означает ровно 14:00 UTC, а не «час назад».
 * Последняя корзина — текущая, поэтому график заканчивается «сейчас».
 */
export function historyBuckets(period: HistoryPeriod, now = Date.now()): number[] {
  const count = HISTORY_BUCKET_COUNT[period];
  const granularity = historyGranularity(period);
  if (granularity === '5min') {
    const step = 5 * MINUTE;
    const last = Math.floor(now / step) * step;
    return Array.from({ length: count }, (_, index) => last - (count - 1 - index) * step);
  }
  if (granularity === 'hour') {
    const last = Math.floor(now / HOUR) * HOUR;
    return Array.from({ length: count }, (_, index) => last - (count - 1 - index) * HOUR);
  }
  if (granularity === 'day') {
    const last = Date.UTC(
      new Date(now).getUTCFullYear(),
      new Date(now).getUTCMonth(),
      new Date(now).getUTCDate(),
    );
    return Array.from({ length: count }, (_, index) => last - (count - 1 - index) * DAY);
  }
  // Месяцы: 12 последних, включая текущий. Дни не важны — корзина одна на месяц.
  const date = new Date(now);
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  return Array.from({ length: count }, (_, index) => {
    const offset = count - 1 - index;
    return Date.UTC(year, month - offset, 1);
  });
}

/** Начало окна: с этой секунды маршрут запрашивает историю. */
export function historySince(period: HistoryPeriod, now = Date.now()): number {
  const buckets = historyBuckets(period, now);
  return buckets[0];
}

/** Корзина, в которую попало время: индекс в массиве `historyBuckets`. */
export function historyBucketIndex(period: HistoryPeriod, at: number, now = Date.now()): number {
  const buckets = historyBuckets(period, now);
  const granularity = historyGranularity(period);
  const step = granularity === '5min' ? 5 * MINUTE : granularity === 'hour' ? HOUR : DAY;
  if (granularity === 'month') {
    return buckets.findIndex((start, index) => {
      const next = index + 1 < buckets.length
        ? buckets[index + 1]
        : Date.UTC(new Date(buckets[index]).getUTCFullYear(), new Date(buckets[index]).getUTCMonth() + 1, 1);
      return at >= start && at < next;
    });
  }
  if (at < buckets[0] || at >= buckets[buckets.length - 1] + step) return -1;
  return Math.floor((at - buckets[0]) / step);
}

/** Строка истории в том виде, в каком её видит интерфейс. */
export interface CarrierJumpRecord {
  id: string;
  carrierId: string;
  callsign: string | null;
  name: string | null;
  from: string;
  to: string;
  jumpedAt: string;
  source: JumpHistorySource;
}

export interface HistorySummary {
  total: number;
  carriers: number;
  routes: number;
  bySource: { site: number; eddn: number };
  top: Array<{ carrierId: string; callsign: string | null; name: string | null; jumps: number }>;
}

export const EMPTY_HISTORY_SUMMARY: HistorySummary = {
  total: 0,
  carriers: 0,
  routes: 0,
  bySource: { site: 0, eddn: 0 },
  top: [],
};

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asIso(value: unknown): string | null {
  if (value == null || value === '') return null;
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

/** Строка `carrier_jump_history` → запись для клиента. */
export function jumpRecordFromRow(row: Record<string, unknown>): CarrierJumpRecord {
  const source = row.source === 'eddn' ? 'eddn' : 'site';
  return {
    id: String(row.id ?? ''),
    carrierId: String(row.carrier_id ?? ''),
    callsign: text(row.callsign) || null,
    name: text(row.name) || null,
    from: text(row.from_system),
    to: text(row.to_system),
    jumpedAt: asIso(row.jumped_at) ?? '',
    source,
  };
}

/** `jsonb`-сводка из `carrier_jump_history_summary` → объект интерфейса. */
export function historySummaryFromJson(value: unknown): HistorySummary {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...EMPTY_HISTORY_SUMMARY };
  const raw = value as Record<string, unknown>;
  const top = Array.isArray(raw.top) ? raw.top : [];
  return {
    total: number(raw.total),
    carriers: number(raw.carriers),
    routes: number(raw.routes),
    bySource: { site: number(raw.source_site), eddn: number(raw.source_eddn) },
    top: top
      .filter((item) => item && typeof item === 'object')
      .map((item) => {
        const entry = item as Record<string, unknown>;
        return {
          carrierId: String(entry.carrier_id ?? ''),
          callsign: text(entry.callsign) || null,
          name: text(entry.name) || null,
          jumps: number(entry.jumps),
        };
      })
      .filter((item) => item.carrierId),
  };
}

/** Счётчики по корзинам: то, что вернула база, разложенное по сетке окна. */
export function fillHistoryBuckets(
  buckets: readonly number[],
  rows: ReadonlyArray<{ bucket: unknown; jumps: unknown }>,
): number[] {
  const index = new Map<number, number>();
  for (const row of rows) {
    const at = Date.parse(String(row.bucket));
    if (!Number.isFinite(at)) continue;
    index.set(at, (index.get(at) ?? 0) + number(row.jumps));
  }
  return buckets.map((start) => index.get(start) ?? 0);
}

/** Высота столбцов графика в долях (0…1): ноль остаётся нулём, а не «минимумом». */
export function historyBarHeights(values: readonly number[]): number[] {
  const max = values.reduce((best, value) => Math.max(best, value), 0);
  if (!max) return values.map(() => 0);
  return values.map((value) => Math.max(0, value) / max);
}

export interface HistoryBar {
  /** Доля от ширины (0…1): ширина столбца вместе с зазором. */
  x: number;
  /** Доля от высоты (0…1): 0 — у основания. */
  height: number;
  /** Счётчик, по которому строился столбец. */
  value: number;
}

/**
 * Геометрия столбцов в долях контейнера: SVG рисует по `viewBox`, поэтому
 * проценты удобнее пикселей — график одинаково работает на телефоне и на
 * широком экране. Зазор — доля от шага, не меньше 0 и меньше 1.
 */
export function historyBars(values: readonly number[], gap = 0.25): HistoryBar[] {
  const heights = historyBarHeights(values);
  const step = values.length ? 1 / values.length : 1;
  const safeGap = Math.min(0.9, Math.max(0, gap));
  return values.map((value, index) => ({
    x: index * step + (step * safeGap) / 2,
    height: heights[index],
    value,
  }));
}

/** Ширина столбца в долях: шаг минус зазор. */
export function historyBarWidth(count: number, gap = 0.25): number {
  if (count <= 0) return 0;
  const safeGap = Math.min(0.9, Math.max(0, gap));
  return (1 / count) * (1 - safeGap);
}

/**
 * Подпись корзины. Час и день — время, месяц — дата, год — месяц и год:
 * подпись должна читаться без оглядки на соседние столбцы.
 */
export function historyBucketLabel(
  period: HistoryPeriod | HistoryGranularity,
  start: number,
  locale = 'ru',
): string {
  const date = new Date(start);
  const granularity = (HISTORY_PERIODS as readonly string[]).includes(period)
    ? HISTORY_GRANULARITY[period as HistoryPeriod]
    : period as HistoryGranularity;
  try {
    if (granularity === '5min' || granularity === 'hour') {
      return date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
    }
    if (granularity === 'day') {
      return date.toLocaleDateString(locale, { day: '2-digit', month: '2-digit' });
    }
    return date.toLocaleDateString(locale, { month: 'short', year: '2-digit' });
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Поиск по истории: позывной, имя, обе системы и MarketID. */
export function matchesHistoryQuery(row: CarrierJumpRecord, query: unknown): boolean {
  const tokens = text(query).toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const haystack = [
    row.callsign ?? '',
    row.name ?? '',
    row.from,
    row.to,
    row.carrierId,
  ].join(' ').toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

/** Строка истории → «откуда → куда» одной строкой (подсказки, CSV, заголовок). */
export function historyRoute(row: Pick<CarrierJumpRecord, 'from' | 'to'>): string {
  return `${row.from} → ${row.to}`;
}

/** Ответ маршрута `/api/carriers/jumps/history`. */
export interface CarrierJumpHistoryResponse {
  period: HistoryPeriod;
  granularity: HistoryGranularity;
  /** Начало окна (ISO). */
  since: string;
  generatedAt: string;
  /** Счётчики по корзинам окна — ровно `historyBuckets()` штук. */
  chart: Array<{ start: string; jumps: number }>;
  summary: HistorySummary;
  jumps: CarrierJumpRecord[];
  /** Всего прыжков в окне (может быть больше, чем строк в ответе). */
  total: number;
  shown: number;
  truncated: boolean;
}
