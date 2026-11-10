/**
 * История прыжков авианосцев: чтение из `carrier_jump_history`.
 *
 * Три запроса на страницу: корзины графика, сводка (всего/носителей/топ) и
 * последние строки для таблицы. Считать всё в браузере нельзя — за год это
 * тысячи строк, а маршрут отдаёт максимум `HISTORY_ROWS_LIMIT` записей.
 *
 * Поиск по истории идёт по последним `HISTORY_SEARCH_SCAN` строкам окна: SQL
 * `ilike` по четырём колонкам сразу PostgREST выразить не умеет (а `.or()`
 * ломается на значениях со скобками), поэтому фильтр — тот же, что у живой
 * таблицы, и живёт в `matchesHistoryQuery`. Для окна «час» и «день» это
 * покрывает всё целиком.
 */

import {
  HISTORY_ROWS_LIMIT,
  HISTORY_SEARCH_SCAN,
  fillHistoryBuckets,
  historyBuckets,
  historyGranularity,
  historySummaryFromJson,
  jumpRecordFromRow,
  matchesHistoryQuery,
  parseHistoryPeriod,
  type CarrierJumpHistoryResponse,
  type CarrierJumpRecord,
  type HistoryPeriod,
} from './carrierJumpHistory.ts';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Svc = any;
type Row = Record<string, any>;

export const HISTORY_COLUMNS = 'id, carrier_id, callsign, name, from_system, to_system, jumped_at, source';

/** Сколько носителей показывать в сводке «чаще всех прыгали». */
export const HISTORY_TOP_LIMIT = 5;

export interface LoadJumpHistoryOptions {
  period?: unknown;
  /** Строка поиска: позывной, имя, система или MarketID. */
  query?: unknown;
  /** Сколько строк отдать (по умолчанию `HISTORY_ROWS_LIMIT`). */
  limit?: number;
  /** Точка отсчёта — в тестах и для повторяемости. */
  now?: number;
}

function asRows(value: unknown): Row[] {
  return Array.isArray(value) ? value as Row[] : [];
}

/**
 * История прыжков за период. `now` фиксируется один раз: окно графика, `since`
 * и порядок строк должны считаться от одного момента, иначе последняя корзина
 * успеет «съехать» между запросами.
 */
export async function loadCarrierJumpHistory(
  svc: Svc,
  options: LoadJumpHistoryOptions = {},
): Promise<CarrierJumpHistoryResponse> {
  const period: HistoryPeriod = parseHistoryPeriod(options.period);
  const now = options.now ?? Date.now();
  const granularity = historyGranularity(period);
  const buckets = historyBuckets(period, now);
  const since = new Date(buckets[0]).toISOString();
  const limit = Math.max(1, Math.floor(options.limit ?? HISTORY_ROWS_LIMIT));
  const query = typeof options.query === 'string' ? options.query : '';

  const [bucketResult, summaryResult] = await Promise.all([
    svc.rpc('carrier_jump_history_buckets', { p_since: since, p_granularity: granularity }),
    svc.rpc('carrier_jump_history_summary', { p_since: since, p_top: HISTORY_TOP_LIMIT }),
  ]);
  if (bucketResult.error) throw new Error(bucketResult.error.message);
  if (summaryResult.error) throw new Error(summaryResult.error.message);

  const counts = fillHistoryBuckets(
    buckets,
    asRows(bucketResult.data) as Array<{ bucket: unknown; jumps: unknown }>,
  );
  const summary = historySummaryFromJson(summaryResult.data);

  // С запасом: с поиском нужно просмотреть больше строк, чем показываем.
  const scan = query.trim() ? Math.max(limit, HISTORY_SEARCH_SCAN) : limit + 1;
  const rowsResult = await svc
    .from('carrier_jump_history')
    .select(HISTORY_COLUMNS)
    .gte('jumped_at', since)
    .order('jumped_at', { ascending: false })
    .limit(scan);
  if (rowsResult.error) throw new Error(rowsResult.error.message);

  const scanned: CarrierJumpRecord[] = asRows(rowsResult.data).map(jumpRecordFromRow);
  const matched = query.trim() ? scanned.filter((row) => matchesHistoryQuery(row, query)) : scanned;
  const jumps = matched.slice(0, limit);

  return {
    period,
    granularity,
    since,
    generatedAt: new Date(now).toISOString(),
    chart: buckets.map((start, index) => ({ start: new Date(start).toISOString(), jumps: counts[index] })),
    summary,
    jumps,
    total: summary.total,
    shown: jumps.length,
    truncated: matched.length > limit || (!query.trim() && scanned.length > limit),
  };
}
