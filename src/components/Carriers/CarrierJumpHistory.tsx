'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconRefresh, IconSearch, IconX } from '@/components/Icons';
import { useI18n } from '@/lib/i18n/I18nContext';
import { carrierAtlasHref, systemPageHref } from '@/lib/systemIdentity';
import {
  HISTORY_PERIODS,
  historyBarWidth,
  historyBars,
  historyBucketLabel,
  historyBuckets,
  historyGranularity,
  matchesHistoryQuery,
  parseHistoryPeriod,
  type CarrierJumpHistoryResponse,
  type CarrierJumpRecord,
  type HistoryPeriod,
  type HistorySummary,
  EMPTY_HISTORY_SUMMARY,
} from '@/lib/carrierJumpHistory';

/** История меняется медленно: лишние запросы за год только греют базу. */
const REFRESH_MS = 120_000;

const PERIOD_KEY: Record<HistoryPeriod, string> = {
  '1h': 'cjh.period1h',
  '1d': 'cjh.period1d',
  '1m': 'cjh.period1m',
  '1y': 'cjh.period1y',
};

/** Подсказка под графиком: за какой шаг один столбец. */
const STEP_KEY = {
  '5min': 'cjh.step5min',
  hour: 'cjh.stepHour',
  day: 'cjh.stepDay',
  month: 'cjh.stepMonth',
} as const;

export interface CarrierJumpHistoryProps {
  /** Вкладка «История» открыта: только тогда и грузим. */
  active?: boolean;
  /** Период из адреса (`?period=1m`); страница держит его в адресе. */
  period?: unknown;
  /** Период сменился — страница обновляет адрес. */
  onPeriodChange?: (period: HistoryPeriod) => void;
}

interface HistoryState {
  period: HistoryPeriod;
  chart: Array<{ start: string; jumps: number }>;
  summary: HistorySummary;
  jumps: CarrierJumpRecord[];
  total: number;
  truncated: boolean;
  generatedAt: string;
}

/**
 * Сводка из ответа маршрута. Это уже поля интерфейса, а не snake_case базы:
 * пересобираем поштучно, чтобы битый ответ не ронял панель.
 */
function summaryFromResponse(value: HistorySummary | undefined): HistorySummary {
  if (!value || typeof value !== 'object') return { ...EMPTY_HISTORY_SUMMARY };
  const top = Array.isArray(value.top) ? value.top : [];
  return {
    total: Number(value.total) || 0,
    carriers: Number(value.carriers) || 0,
    routes: Number(value.routes) || 0,
    bySource: {
      site: Number(value.bySource?.site) || 0,
      eddn: Number(value.bySource?.eddn) || 0,
    },
    top: top
      .filter((item) => item && item.carrierId)
      .map((item) => ({
        carrierId: String(item.carrierId),
        callsign: item.callsign ?? null,
        name: item.name ?? null,
        jumps: Number(item.jumps) || 0,
      })),
  };
}

/** Ответ маршрута в состояние: то же самое, но прощает отсутствующие поля. */
function stateFromResponse(payload: CarrierJumpHistoryResponse, fallbackPeriod: HistoryPeriod): HistoryState {
  return {
    period: parseHistoryPeriod(payload.period ?? fallbackPeriod),
    chart: Array.isArray(payload.chart) ? payload.chart : [],
    summary: summaryFromResponse(payload.summary),
    jumps: Array.isArray(payload.jumps) ? payload.jumps : [],
    total: Number(payload.total) || 0,
    truncated: Boolean(payload.truncated),
    generatedAt: payload.generatedAt ?? '',
  };
}

/** Когда прыгнули: у часа — часы и минуты, у года — дата и часы. */
function jumpedLabel(value: string, period: HistoryPeriod, locale: string): string {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  try {
    if (period === '1y') {
      return date.toLocaleString(locale, { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
    }
    return date.toLocaleString(locale, { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/**
 * Вкладка «История» на `/carriers/jumps`: все прыжки всех авианосцев за час,
 * день, месяц или год.
 *
 * Вверху — график интенсивности за выбранный период: по нему видно, когда
 * авианосцы прыгали чаще всего. Ниже сводка, топ носителей и таблица прыжков.
 *
 * Данные публичные, как и отметки носителей на карте: прыжок виден в игре
 * каждому. Здесь нет ни груза, ни финансов, ни владельцев — только «кто,
 * откуда, куда и когда». Историю наполняют учёт сайта и EDDN, страница её
 * только читает.
 */
export function CarrierJumpHistory({ active = true, period: periodProp, onPeriodChange }: CarrierJumpHistoryProps) {
  const { t, locale } = useI18n();
  const [ownPeriod, setOwnPeriod] = useState<HistoryPeriod>(() => parseHistoryPeriod(periodProp));
  const period = useMemo(() => parseHistoryPeriod(periodProp ?? ownPeriod), [ownPeriod, periodProp]);
  const [state, setState] = useState<HistoryState | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (nextPeriod: HistoryPeriod, quiet = false) => {
    const request = ++requestRef.current;
    if (quiet) setRefreshing(true);
    else setStatus((current) => (current === 'ready' ? current : 'loading'));
    try {
      const response = await fetch(`/api/carriers/jumps/history?period=${nextPeriod}`, {
        headers: { accept: 'application/json' },
        cache: 'no-store',
      });
      const payload = await response.json().catch(() => ({})) as CarrierJumpHistoryResponse & { error?: string };
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`);
      if (request !== requestRef.current) return;
      setState(stateFromResponse(payload, nextPeriod));
      setStatus('ready');
    } catch (error) {
      if (request !== requestRef.current) return;
      console.error('[carriers/jumps/history]', error);
      setStatus('error');
    } finally {
      if (request === requestRef.current) setRefreshing(false);
    }
  }, []);

  // Пока вкладку не открыли — не грузим: сводку за год считает база, а не браузер.
  useEffect(() => {
    if (!active) return;
    void load(period);
  }, [active, load, period]);

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void load(period, true); }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [active, load, period]);

  const selectPeriod = useCallback((next: HistoryPeriod) => {
    if (next === period) return;
    setOwnPeriod(next);
    setStatus('loading');
    setState(null);
    onPeriodChange?.(next);
  }, [onPeriodChange, period]);

  // Окно графика считаем от момента снимка: корзины должны совпадать с базой.
  const generatedAt = state?.generatedAt ? Date.parse(state.generatedAt) : NaN;
  const chartPeriod = state?.period ?? period;
  const buckets = useMemo(
    () => historyBuckets(chartPeriod, Number.isFinite(generatedAt) ? generatedAt : Date.now()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chartPeriod, generatedAt],
  );
  const values = useMemo(
    () => buckets.map((start) => {
      const iso = new Date(start).toISOString();
      return state?.chart.find((item) => item.start === iso)?.jumps ?? 0;
    }),
    [buckets, state?.chart],
  );
  const bars = useMemo(() => historyBars(values), [values]);
  const barWidth = historyBarWidth(values.length);
  const granularity = historyGranularity(state?.period ?? period);
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));

  const summary = state?.summary ?? EMPTY_HISTORY_SUMMARY;
  const rows = useMemo(() => {
    const list = state?.jumps ?? [];
    return query.trim() ? list.filter((row) => matchesHistoryQuery(row, query)) : list;
  }, [state?.jumps, query]);

  const peak = values.reduce((best, value) => Math.max(best, value), 0);
  const chartLabel = t('cjh.chartAria', {
    period: t(PERIOD_KEY[state?.period ?? period]),
    total: summary.total,
  });

  return (
    <div className="cjh" data-period={state?.period ?? period}>
      <div className="cjh-head">
        <div>
          <h2>{t('cjh.title')}</h2>
          <p className="cj-dim">{t('cjh.intro')}</p>
        </div>
        <div className="cjh-actions">
          <div className="cjh-periods" role="group" aria-label={t('cjh.periodAria')}>
            {HISTORY_PERIODS.map((item) => (
              <button
                key={item}
                type="button"
                className={`cjh-period${(state?.period ?? period) === item ? ' active' : ''}`}
                aria-pressed={(state?.period ?? period) === item}
                onClick={() => selectPeriod(item)}
              >
                {t(PERIOD_KEY[item])}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="cj-btn"
            onClick={() => void load(period, true)}
            disabled={refreshing || status === 'loading'}
            title={t('cjh.refreshTitle')}
          >
            <IconRefresh size={13} />
            {t('cj.refresh')}
          </button>
        </div>
      </div>

      {status === 'error' ? (
        <div className="cj-error" role="alert">
          <span>{t('cjh.loadFailed')}</span>
          <button type="button" className="cj-btn" onClick={() => void load(period)}>{t('cj.retry')}</button>
        </div>
      ) : null}

      {status === 'loading' ? (
        <div className="cj-state-block" aria-live="polite">
          <b>{t('cjh.loading')}</b>
          <span>{t('cjh.loadingDetail')}</span>
        </div>
      ) : null}

      {status === 'ready' ? (
        <>
          {/* График интенсивности — вверху вкладки, как просили. */}
          <section className="cjh-chart-card" aria-label={t('cjh.chartTitle')}>
            <header className="cjh-chart-head">
              <b>{t('cjh.chartTitle')}</b>
              <span className="cjh-chart-meta">
                {t('cjh.chartTotal', { total: summary.total })} · {t(STEP_KEY[granularity])} · {t('cjh.utc')}
              </span>
            </header>
            {summary.total > 0 || peak > 0 ? (
              <>
                <svg
                  className="cjh-chart"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                  role="img"
                  aria-label={chartLabel}
                >
                  {[25, 50, 75].map((line) => (
                    <line key={line} className="cjh-grid-line" x1="0" x2="100" y1={100 - line} y2={100 - line} />
                  ))}
                  {bars.map((bar, index) => (
                    <g key={buckets[index]}>
                      <rect
                        className={`cjh-bar${bar.value ? '' : ' empty'}`}
                        x={bar.x * 100}
                        y={100 - Math.max(bar.height * 100, bar.value ? 2 : 0)}
                        width={Math.max(barWidth * 100, 0.4)}
                        height={Math.max(bar.height * 100, bar.value ? 2 : 0)}
                      >
                        <title>
                          {t('cjh.bucketTooltip', {
                            time: historyBucketLabel(granularity, buckets[index], locale),
                            jumps: bar.value,
                          })}
                        </title>
                      </rect>
                    </g>
                  ))}
                </svg>
                <div
                  className="cjh-axis"
                  style={{ gridTemplateColumns: `repeat(${buckets.length}, minmax(0, 1fr))` }}
                  aria-hidden="true"
                >
                  {buckets.map((start, index) => (
                    <span key={start} className={index % labelStep === 0 || index === buckets.length - 1 ? '' : 'quiet'}>
                      {historyBucketLabel(granularity, start, locale)}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <div className="cjh-chart-empty">{t('cjh.chartEmpty')}</div>
            )}
          </section>

          <div className="cjh-stats">
            <div className="cjh-stat">
              <b>{summary.total}</b>
              <span>{t('cjh.statTotal')}</span>
            </div>
            <div className="cjh-stat">
              <b>{summary.carriers}</b>
              <span>{t('cjh.statCarriers')}</span>
            </div>
            <div className="cjh-stat">
              <b>{summary.routes}</b>
              <span>{t('cjh.statRoutes')}</span>
            </div>
            <div className="cjh-stat">
              <b>{summary.bySource.site} / {summary.bySource.eddn}</b>
              <span>{t('cjh.statSources')}</span>
            </div>
          </div>

          {summary.top.length ? (
            <section className="cjh-top">
              <b>{t('cjh.topTitle')}</b>
              <ul>
                {summary.top.map((item) => (
                  <li key={item.carrierId}>
                    <Link
                      className="cj-carrier-link"
                      href={carrierAtlasHref(item.carrierId)}
                      title={t('cj.openCarrier')}
                    >
                      <span className="cj-callsign">{item.callsign || t('cj.noCallsign')}</span>
                      {item.name ? <span className="cj-name">{item.name}</span> : null}
                    </Link>
                    <span className="cjh-top-count">{t('cjh.topJumps', { count: item.jumps })}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="cjh-list">
            <div className="cjh-list-head">
              <b>{t('cjh.listTitle')}</b>
              <label className="cjh-search">
                <IconSearch size={13} />
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('cjh.searchPlaceholder')}
                  aria-label={t('cjh.searchPlaceholder')}
                />
                {query ? (
                  <button type="button" onClick={() => setQuery('')} title={t('cj.clearSearch')} aria-label={t('cj.clearSearch')}>
                    <IconX size={12} />
                  </button>
                ) : null}
              </label>
            </div>

            {rows.length === 0 ? (
              <div className="cj-state-block">
                <b>{t('cjh.emptyTitle')}</b>
                <span>{query.trim() ? t('cjh.emptySearch') : t('cjh.emptyHint')}</span>
              </div>
            ) : (
              <>
                <div className="cj-scroll">
                  <table className="cj-table cjh-table" aria-label={t('cjh.listTitle')}>
                    <thead>
                      <tr>
                        <th scope="col">{t('cjh.colTime')}</th>
                        <th scope="col">{t('cj.colCarrier')}</th>
                        <th scope="col">{t('cj.colRoute')}</th>
                        <th scope="col">{t('cjh.colSource')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr key={row.id}>
                          <td data-label={t('cjh.colTime')}>
                            <span className="cj-time">{jumpedLabel(row.jumpedAt, state?.period ?? period, locale)}</span>
                          </td>
                          <td data-label={t('cj.colCarrier')}>
                            <Link
                              className="cj-carrier-link"
                              href={carrierAtlasHref(row.carrierId, { system: row.to })}
                              title={t('cj.openCarrier')}
                            >
                              <span className="cj-callsign">{row.callsign || t('cj.noCallsign')}</span>
                              {row.name ? <span className="cj-name">{row.name}</span> : null}
                            </Link>
                          </td>
                          <td data-label={t('cj.colRoute')}>
                            <span className="cj-route">
                              <span className="cj-system">{row.from}</span>
                              <span className="cj-arrow" aria-hidden="true">→</span>
                              <Link
                                className="cj-system cj-target"
                                href={systemPageHref(row.to)}
                                title={t('cj.openSystem', { system: row.to })}
                              >
                                {row.to}
                              </Link>
                            </span>
                          </td>
                          <td data-label={t('cjh.colSource')}>
                            <span className={`cjh-source ${row.source}`}>
                              {row.source === 'eddn' ? t('cjh.sourceEddn') : t('cjh.sourceSite')}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="cjh-foot">
                  {state?.truncated ? <span>{t('cjh.truncated', { shown: rows.length })} </span> : null}
                  <span className="cj-dim">{t('cjh.footnote')}</span>
                </p>
              </>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}

export default CarrierJumpHistory;
