'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { toast } from '@/components/ui/Toaster';
import { IconArrowRight, IconCopy, IconDownload, IconRefresh, IconSearch, IconX } from '@/components/Icons';
import { copyText, downloadCsv, formatCoordinates, formatDistanceLy, routeToCsvRows } from '@/lib/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';
import {
  finishAtlasSearchProgress,
  publishAtlasSearchPoints,
  publishAtlasSearchProgress,
  startAtlasSearchProgress,
} from '@/lib/atlasSearchProgress';
import { useI18n } from '@/lib/i18n/I18nContext';

type TFn = (key: string, params?: Record<string, string | number>) => string;

interface ApiRoutePoint {
  name: string;
  x: number;
  y: number;
  z: number;
}

interface Jump {
  from: string;
  to: string;
  distance: number;
}

interface SearchProcess {
  from_system: string;
  to_system: string;
  direct_distance: number;
  cache_hits?: number;
  scan_centers?: Array<{ x: number; y: number; z: number }>;
  sample_systems?: ApiRoutePoint[];
  max_jump: number;
  radius_around_path: number;
  scan_points: number;
  systems_scanned: number;
  systems_used: number;
  estimated_steps: number;
  actual_step: number;
  api_requests: number;
  graph_nodes: number;
  graph_edges: number;
  elapsed_ms: number;
  strategy: string;
  systems_per_scan: number[];
}

interface RouteResult {
  route: ApiRoutePoint[];
  jumps: Jump[];
  summary: {
    total_systems: number;
    total_jumps: number;
    total_distance: number;
    max_jump: number;
    avg_jump: number;
    synthetic_waypoints?: boolean;
  };
  process?: SearchProcess;
}

interface Props {
  onRouteFound: (route: RoutePoint[]) => void;
  mode?: 'colonisation' | 'ship';
  initialFrom?: string;
  initialTo?: string;
  maxJumpRange?: number;
  rangeDescription?: string;
  rangeIssues?: string[];
}

type SearchPhase =
  | { stage: 'idle' }
  | { stage: 'coords'; message: string }
  | { stage: 'scan'; message: string; current: number; total: number }
  | { stage: 'astar'; message: string }
  | { stage: 'done'; message: string };

const PHASES: { stage: Exclude<SearchPhase['stage'], 'idle'>; message: string; delay: number }[] = [
  { stage: 'coords', message: 'atlas.ui.phaseCoordsMsg', delay: 700 },
  { stage: 'scan', message: 'atlas.ui.phaseScanMsg', delay: 1200 },
  { stage: 'astar', message: 'atlas.ui.phaseAstarMsg', delay: 900 },
  { stage: 'done', message: 'atlas.ui.phaseDoneMsg', delay: 500 },
];

const MAX_JUMPS_IN_LIST = 400;

function formatDuration(ms: number, t: TFn): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return t('atlas.ui.msValue', { value: Math.round(ms) });
  return t('atlas.ui.secondsValue', { value: (ms / 1000).toFixed(1) });
}

export default function AtlasRouteFinder({
  onRouteFound,
  mode = 'colonisation',
  initialFrom = '',
  initialTo = '',
  maxJumpRange,
  rangeDescription,
  rangeIssues = [],
}: Props) {
  const { t, locale } = useI18n();
  const shipMode = mode === 'ship';
  const jumpLimit = shipMode ? Math.max(1, Math.min(100, maxJumpRange ?? 100)) : 14.99;
  const [fromSystem, setFromSystem] = useState(initialFrom);
  const [toSystem, setToSystem] = useState(initialTo);
  const [maxJump, setMaxJump] = useState(shipMode ? jumpLimit : 14.99);
  const [radius, setRadius] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [phase, setPhase] = useState<SearchPhase>({ stage: 'idle' });
  const [routeFilter, setRouteFilter] = useState('');
  const [showDetails, setShowDetails] = useState(false);
  const [sendingRoute, setSendingRoute] = useState(false);
  const phaseTimers = useRef<number[]>([]);

  // Таймеры фаз раньше продолжали жить после размонтирования и дёргали setState.
  const clearPhaseTimers = useCallback(() => {
    phaseTimers.current.forEach((timer) => window.clearTimeout(timer));
    phaseTimers.current = [];
  }, []);

  useEffect(() => clearPhaseTimers, [clearPhaseTimers]);

  const animatePhases = useCallback((startedAt: number) => {
    clearPhaseTimers();
    const percentages = [8, 35, 72, 92];
    let elapsed = 0;
    PHASES.forEach((item, index) => {
      elapsed += item.delay;
      const timer = window.setTimeout(() => {
        setPhase({ stage: item.stage, message: t(item.message), current: index + 1, total: PHASES.length - 1 } as SearchPhase);
        publishAtlasSearchProgress({
          active: true,
          kind: 'route',
          title: shipMode ? t('atlas.ui.routeOverlayShip') : t('atlas.ui.routeOverlayColony'),
          stage: item.stage,
          percent: percentages[index],
          message: t(item.message),
          elapsedMs: Date.now() - startedAt,
        });
      }, elapsed);
      phaseTimers.current.push(timer);
    });
  }, [clearPhaseTimers, shipMode, t]);

  /**
   * Координаты точки маршрута для карты: сначала локальный каталог проекта,
   * только затем EDSM. Ответ кэшируется в замыкании — обе точки нужны лишь
   * один раз за поиск.
   */
  const resolvePointForMap = useCallback(async (name: string) => {
    const query = name.trim();
    if (!query) return null;
    try {
      const res = await fetch(`/api/galaxy/systems/search?q=${encodeURIComponent(query)}&limit=5`);
      const data = await res.json().catch(() => ({}));
      const rows: Array<Record<string, unknown>> = Array.isArray(data?.results) ? data.results : [];
      const exact = rows.find((row) => String(row.name || '').toLowerCase() === query.toLowerCase());
      const row = exact || rows[0];
      const x = Number(row?.x);
      const y = Number(row?.y);
      const z = Number(row?.z);
      if (!row || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null;
      return { name: String(row.name || query), x, y, z };
    } catch {
      return null;
    }
  }, []);

  const findRoute = useCallback(async () => {
    if (!fromSystem.trim() || !toSystem.trim()) {
      toast(t('atlas.ui.errBothSystems'), 'error');
      return;
    }
    if (fromSystem.trim().toLowerCase() === toSystem.trim().toLowerCase()) {
      toast(t('atlas.ui.errSamePoints'), 'error');
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    setResult(null);
    setRouteFilter('');
    setPhase({ stage: 'coords', message: t('atlas.ui.phaseCoordsMsg') });
    startAtlasSearchProgress({
      kind: 'route',
      title: shipMode ? t('atlas.ui.routeOverlayShip') : t('atlas.ui.routeOverlayColony'),
      stage: 'coords',
      percent: 4,
      message: t('atlas.ui.routeDetermining', { from: fromSystem.trim(), to: toSystem.trim() }),
      counters: { [t('atlas.ui.counterPointA')]: fromSystem.trim(), [t('atlas.ui.counterPointB')]: toSystem.trim() },
    });
    animatePhases(startedAt);

    // Коридор A→B на карте: даже до ответа сервера видно, где именно идёт поиск.
    const points = [await resolvePointForMap(fromSystem), await resolvePointForMap(toSystem)];
    const corridor = points[0] && points[1]
      ? { from: points[0], to: points[1], radius }
      : null;
    if (corridor) {
      publishAtlasSearchProgress({
        active: true,
        kind: 'route',
        corridor,
        beam: { ...corridor.from, label: fromSystem.trim() },
        message: t('atlas.ui.routeScanningCorridor', { from: fromSystem.trim(), to: toSystem.trim() }),
      });
    }

    // Эндпоинт считает маршрут одним запросом: пока он работает, показываем
    // оценку прогресса и ведём луч сканирования вдоль коридора, а после ответа
    // подставляем точные цифры из `process`.
    const progressTimer = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const estimatedScanned = Math.max(1, Math.floor(elapsedMs / 180));
      const percent = Math.min(88, 35 + Math.floor(estimatedScanned / 10));
      const beam = corridor && points[0] && points[1]
        ? {
          x: points[0].x + (points[1].x - points[0].x) * Math.min(1, elapsedMs / 6000),
          y: points[0].y + (points[1].y - points[0].y) * Math.min(1, elapsedMs / 6000),
          z: points[0].z + (points[1].z - points[0].z) * Math.min(1, elapsedMs / 6000),
          label: t('atlas.ui.scanningLabel'),
        }
        : null;
      publishAtlasSearchProgress({
        active: true,
        kind: 'route',
        stage: 'scan',
        percent,
        message: t('atlas.ui.routeScanningPath'),
        elapsedMs,
        beam,
        counters: { [t('atlas.ui.counterSystemsChecked')]: estimatedScanned },
      });
    }, 400);

    try {
      const res = await fetch('/api/atlas/route-finder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from_system: fromSystem.trim(),
          to_system: toSystem.trim(),
          max_jump: maxJump,
          radius_around_path: radius,
          route_mode: shipMode ? 'ship' : 'colonisation',
        }),
      });
      const responseText = await res.text();
      let data: any;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(t('atlas.ui.errBadResponse', { status: res.status }));
      }
      if (!res.ok) {
        throw new Error(data.error || t('atlas.ui.errRouteNotFound', { status: res.status }));
      }
      if (!Array.isArray(data.route) || data.route.length === 0) {
        throw new Error(t('atlas.ui.errEmptyRoute'));
      }
      setPhase({ stage: 'done', message: t('atlas.ui.doneExclaim') });
      setResult(data);
      const mappedRoute: RoutePoint[] = data.route.map((point: ApiRoutePoint, index: number) => ({
        id: -(index + 1),
        system_name: point.name,
        sort_order: index,
        status: 'planned' as const,
        x: point.x,
        y: point.y,
        z: point.z,
      }));
      onRouteFound(mappedRoute);

      // Итог поиска — на карту: найденные системы, маршрут и опорные точки сканов.
      const sample = Array.isArray(data.process?.sample_systems) ? data.process.sample_systems : [];
      publishAtlasSearchPoints([
        ...sample.slice(0, 1200).map((point: ApiRoutePoint) => ({ ...point, kind: 'system' as const })),
        ...data.route.slice(0, 1500).map((point: ApiRoutePoint) => ({ ...point, kind: 'found' as const })),
      ]);
      publishAtlasSearchProgress({
        active: true,
        kind: 'route',
        stage: 'done',
        percent: 100,
        message: data.summary.synthetic_waypoints ? t('atlas.ui.routeWithSynthetic') : t('atlas.ui.routeBuilt'),
        elapsedMs: Date.now() - startedAt,
        path: data.route.map((point: ApiRoutePoint) => ({ ...point, kind: 'system' as const })),
        beam: null,
        summary: t('atlas.ui.routeSummary', { jumps: data.summary.total_jumps, systems: data.summary.total_systems, scanned: data.process?.systems_scanned ?? sample.length }),
        counters: {
          [t('atlas.ui.counterJumps')]: data.summary.total_jumps,
          [t('atlas.ui.counterSystemsChecked')]: data.process?.systems_scanned ?? 0,
          [t('atlas.ui.counterCacheHits')]: data.process?.cache_hits ?? 0,
        },
      });
      finishAtlasSearchProgress({ active: false });
      toast(t('atlas.ui.routeFound', { count: data.summary.total_jumps }), 'success');
    } catch (err: any) {
      publishAtlasSearchProgress({
        active: true,
        kind: 'route',
        stage: 'failed',
        percent: 0,
        message: err.message || t('atlas.errSearch'),
        elapsedMs: Date.now() - startedAt,
      });
      finishAtlasSearchProgress({ message: err.message || t('atlas.errSearch') });
      toast(err.message || t('atlas.errSearch'), 'error');
    } finally {
      window.clearInterval(progressTimer);
      clearPhaseTimers();
      setLoading(false);
      setPhase({ stage: 'idle' });
    }
  }, [animatePhases, clearPhaseTimers, fromSystem, locale, maxJump, onRouteFound, radius, resolvePointForMap, shipMode, t, toSystem]);

  const downloadRoute = useCallback(() => {
    if (!result?.route?.length) return;
    downloadCsv(
      `route-${fromSystem}-${toSystem}`,
      routeToCsvRows(result.route.map((point) => ({ ...point, source: result.summary.synthetic_waypoints ? 'synthetic' : undefined }))),
    );
  }, [fromSystem, result, toSystem]);

  const copyRoute = useCallback(async () => {
    if (!result?.route?.length) return;
    const text = result.route
      .map((point, index) => {
        const jump = index > 0 ? result.jumps[index - 1]?.distance : null;
        return `${index + 1}. ${point.name} (${formatCoordinates(point, 2)})${jump ? ` — ${t('atlas.ui.lightYears', { value: jump })}` : ''}`;
      })
      .join('\n');
    const ok = await copyText(text);
    toast(ok ? t('atlas.ui.routeCopied') : t('atlas.ui.clipboardUnavailable'), ok ? 'success' : 'error');
  }, [result, t]);

  const sendRouteToHelper = useCallback(async () => {
    if (!result?.route?.length || !shipMode || sendingRoute) return;
    setSendingRoute(true);
    try {
      const response = await fetch('/api/cmdr/route', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ route: result.route }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || (response.status === 401 ? t('atlas.ui.helperSignIn') : t('atlas.ui.helperSendFailed')));
      toast(t('atlas.ui.helperSent'), 'success');
    } catch (error) {
      toast(error instanceof Error ? error.message : t('atlas.ui.helperSendFailed'), 'error');
    } finally {
      setSendingRoute(false);
    }
  }, [result, sendingRoute, shipMode, t]);

  const swapSystems = () => {
    setFromSystem(toSystem);
    setToSystem(fromSystem);
    setResult(null);
  };

  const filteredRoute = useMemo(() => {
    if (!result) return [];
    const q = routeFilter.trim().toLowerCase();
    if (!q) return result.route.slice(0, MAX_JUMPS_IN_LIST);
    return result.route
      .filter((point) => point.name.toLowerCase().includes(q))
      .slice(0, MAX_JUMPS_IN_LIST);
  }, [result, routeFilter]);

  const histogramMax = useMemo(
    () => (result?.process?.systems_per_scan?.length ? Math.max(...result.process.systems_per_scan) : 0),
    [result],
  );

  const phaseIndex = PHASES.findIndex((item) => item.stage === phase.stage);

  return (
    <div className="atlas-route-finder">
      <div className="atlas-search-panel">
        <h3>{shipMode ? t('atlas.tabShip') : t('atlas.routeFinderTitle')}</h3>
        <p className="atlas-route-desc">
          {shipMode
            ? t('atlas.ui.routeDescShip')
            : t('atlas.ui.routeDescColony')}
        </p>
        {shipMode && rangeDescription && <p className="atlas-list-counter">{rangeDescription}</p>}
        {shipMode && rangeIssues.length > 0 && <div className="atlas-warning">{t('atlas.ui.rangeIssues', { issues: rangeIssues.join(' · ') })}</div>}

        <SystemSearchInput
          label={t('atlas.pointA')}
          value={fromSystem}
          onChange={setFromSystem}
          placeholder={t('atlas.ui.placeholderFrom')}
        />
        <div className="atlas-swap-row">
          <button type="button" className="atlas-link-btn" onClick={swapSystems} disabled={!fromSystem && !toSystem}>
            <IconRefresh size={12} /> {t('atlas.ui.swapPoints')}
          </button>
        </div>
        <SystemSearchInput
          label={t('atlas.pointB')}
          value={toSystem}
          onChange={setToSystem}
          onSubmit={() => {
            if (fromSystem.trim() && toSystem.trim()) void findRoute();
          }}
          placeholder={t('atlas.ui.placeholderTo')}
        />

        <div className="atlas-two-col">
          <div className="atlas-search-field">
            <label htmlFor="atlas-max-jump">
              {shipMode ? t('atlas.ui.jumpLimit') : t('atlas.maxJump')}: <strong>{t('atlas.ui.lightYears', { value: maxJump.toFixed(2) })}</strong>
            </label>
            <input
              id="atlas-max-jump"
              type="range"
              min={1}
              max={jumpLimit}
              step={0.01}
              value={maxJump}
              onChange={(event) => setMaxJump(Number(event.target.value))}
            />
            <div className="atlas-range-scale"><span>1</span><span>{shipMode ? t('atlas.ui.rangeScaleCalc', { value: jumpLimit.toFixed(2) }) : t('atlas.ui.rangeScaleColonyLimit')}</span></div>
          </div>
        </div>

        <div className="atlas-search-field">
          <label htmlFor="atlas-radius">
            {t('atlas.scanRadius')}: <strong>{t('atlas.ui.lightYears', { value: radius })}</strong>
          </label>
          <input
            id="atlas-radius"
            type="range"
            min={10}
            max={100}
            step={5}
            value={radius}
            onChange={(event) => setRadius(Number(event.target.value))}
          />
          <div className="atlas-range-scale"><span>10</span><span>{t('atlas.ui.maxEdsm')}</span></div>
        </div>

        <button
          type="button"
          onClick={findRoute}
          disabled={loading || !fromSystem.trim() || !toSystem.trim()}
          className="atlas-scan-btn"
        >
          {loading ? t('atlas.searching') : t('atlas.findRoute')}
        </button>

        {loading && phase.stage !== 'idle' && (
          <div className="atlas-progress" aria-live="polite">
            <div className="atlas-progress-head">
              <span className="atlas-progress-live">
                <span className="atlas-spinner" /> {t(phase.message)}
              </span>
            </div>
            <div className="atlas-phase-row">
              {PHASES.map((item, index) => {
                const isDone = index < phaseIndex;
                const isActive = index === phaseIndex;
                return (
                  <div key={item.stage} className="atlas-phase">
                    <div className={`atlas-phase-bar${isDone ? ' done' : isActive ? ' active' : ''}`} />
                    <span className={`atlas-phase-label${isDone ? ' done' : isActive ? ' active' : ''}`}>
                      {item.stage === 'coords' && t('atlas.ui.phaseCoords')}
                      {item.stage === 'scan' && t('atlas.ui.phaseScan')}
                      {item.stage === 'astar' && 'A*'}
                      {item.stage === 'done' && t('atlas.ui.phaseDone')}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="atlas-section">
          <div className="atlas-section-head">
            <h4>{t('atlas.result')}</h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title={t('atlas.ui.copyRouteText')} onClick={() => void copyRoute()}>
                <IconCopy size={12} />
              </button>
              <button type="button" className="atlas-icon-btn" title={t('atlas.ui.downloadCsv')} onClick={downloadRoute}>
                <IconDownload size={12} />
              </button>
              {shipMode && <button type="button" className="atlas-secondary-btn" onClick={() => void sendRouteToHelper()} disabled={sendingRoute}>
                {sendingRoute ? t('atlas.ui.sendingHelper') : t('atlas.ui.sendToHelper')}
              </button>}
            </div>
          </div>

          <div className="atlas-route-summary">
            <div className="stat-box"><div className="num">{result.summary.total_jumps}</div><div className="lbl">{t('atlas.jumps')}</div></div>
            <div className="stat-box"><div className="num">{result.summary.total_distance}</div><div className="lbl">{t('atlas.ui.statRange')}</div></div>
            <div className="stat-box"><div className="num">{result.summary.max_jump}</div><div className="lbl">{t('atlas.maxJump')}</div></div>
            <div className="stat-box"><div className="num">{result.summary.avg_jump}</div><div className="lbl">{t('atlas.avgJump')}</div></div>
          </div>

          {result.summary.synthetic_waypoints && (
            <p className="atlas-warning">
              {t('atlas.ui.syntheticWarning')}
            </p>
          )}

          <div className="atlas-section-head">
            <h4>{t('atlas.route')}</h4>
            <div className="atlas-inline-search compact">
              <IconSearch size={12} />
              <input
                type="search"
                value={routeFilter}
                onChange={(event) => setRouteFilter(event.target.value)}
                placeholder={t('atlas.ui.findSystem')}
                aria-label={t('atlas.ui.routeFilterAria')}
              />
              {routeFilter && (
                <button type="button" onClick={() => setRouteFilter('')} aria-label={t('atlas.clearFilter')}>
                  <IconX size={11} />
                </button>
              )}
            </div>
          </div>

          <p className="atlas-list-counter">
            {t('atlas.ui.pointsCount', { count: result.route.length })}
            {routeFilter ? t('atlas.ui.foundSuffix', { count: filteredRoute.length }) : ''}
            {!routeFilter && result.route.length > MAX_JUMPS_IN_LIST ? t('atlas.ui.shownFirstSuffix', { count: MAX_JUMPS_IN_LIST }) : ''}
          </p>

          <div className="atlas-route-list">
            {filteredRoute.length === 0 && <p className="atlas-muted">{t('atlas.ui.noRouteMatches')}</p>}
            {filteredRoute.map((point, index) => (
              <div key={`${point.name}-${index}`} className="route-row">
                <span className="route-idx">{index + 1}</span>
                <span className="route-name">{point.name}</span>
                <span className="route-coords">{formatCoordinates(point)}</span>
              </div>
            ))}
          </div>

          <button type="button" className="atlas-secondary-btn" onClick={() => setShowDetails((current) => !current)}>
            {showDetails ? t('atlas.ui.hideDetails') : t('atlas.ui.showDetails')}
          </button>

          {showDetails && result.process && (
            <div className="atlas-details-box">
              <div className="atlas-tag-row">
                <span className="atlas-tag orange">{result.process.strategy === 'cube-systems' ? t('atlas.cubesEDSM') : t('atlas.spheresEDSM')}</span>
                <span className="atlas-tag blue">{formatDuration(result.process.elapsed_ms, t)}</span>
                <span className="atlas-tag">{result.process.api_requests} {t('atlas.apiRequests')}</span>
              </div>

              <div className="atlas-stat-grid">
                <div>{t('atlas.directDistance')}</div><div>{formatDistanceLy(result.process.direct_distance, 0)}</div>
                <div>{t('atlas.scanPoints')}</div><div>{result.process.scan_points} / {result.process.estimated_steps}</div>
                <div>{t('atlas.scanStep')}</div><div>~{t('atlas.ui.lightYears', { value: Math.round(result.process.actual_step).toLocaleString(locale) })}</div>
                <div>{t('atlas.systemsScanned')}</div><div>{result.process.systems_scanned.toLocaleString(locale)}</div>
                <div>{t('atlas.graphNodes')}</div><div>{result.process.graph_nodes.toLocaleString(locale)}</div>
                <div>{t('atlas.graphEdges')}</div><div>{result.process.graph_edges.toLocaleString(locale)}</div>
                <div>{t('atlas.scanRadius')}</div><div>{t('atlas.ui.lightYears', { value: result.process.radius_around_path.toLocaleString(locale) })}</div>
                <div>{t('atlas.maxJump')}</div><div>{t('atlas.ui.lightYears', { value: result.process.max_jump })}</div>
              </div>

              {result.process.systems_per_scan.length > 0 && histogramMax > 0 && (
                <div className="atlas-histogram">
                  <div className="atlas-histogram-title">{t('atlas.systemsPerScan')}</div>
                  <div className="atlas-histogram-bars">
                    {result.process.systems_per_scan.map((count, index) => (
                      <div
                        key={index}
                        className="atlas-histogram-bar"
                        style={{
                          height: `${Math.max(2, (count / histogramMax) * 100)}%`,
                          background: count > 0 ? '#e67e22' : '#3a3d40',
                        }}
                        title={t('atlas.ui.histogramPoint', { index: index + 1, count })}
                      />
                    ))}
                  </div>
                  <div className="atlas-histogram-axis"><span>{t('atlas.start')}</span><span>{t('atlas.end')}</span></div>
                </div>
              )}

              <div className="atlas-details-footer">
                {result.process.from_system} <IconArrowRight size={11} /> {result.process.to_system} · A* · EDSM API
              </div>
            </div>
          )}

          <h4>{t('atlas.jumpsList')}</h4>
          <div className="atlas-jump-list">
            {result.jumps.slice(0, MAX_JUMPS_IN_LIST).map((jump, index) => {
              const color = jump.distance <= 15 ? '#22c55e' : jump.distance <= 25 ? '#e67e22' : '#e74c3c';
              return (
                <div key={`${jump.from}-${jump.to}-${index}`} className="route-row" style={{ borderLeft: `3px solid ${color}` }}>
                  <span className="route-idx">{index + 1}</span>
                  <span className="route-name">{jump.from} → {jump.to}</span>
                  <span className="route-coords" style={{ color, fontWeight: 600 }}>{t('atlas.ui.lightYears', { value: jump.distance })}</span>
                </div>
              );
            })}
            {result.jumps.length > MAX_JUMPS_IN_LIST && (
              <p className="atlas-muted">{t('atlas.ui.jumpsShown', { shown: MAX_JUMPS_IN_LIST, total: result.jumps.length })}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
