'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { toast } from '@/components/ui/Toaster';
import { IconArrowRight, IconCopy, IconDownload, IconRefresh, IconSearch, IconX } from '@/components/Icons';
import { copyText, downloadCsv, formatCoordinates, formatDistanceLy, routeToCsvRows } from '@/lib/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';

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

export interface RouteSearchProgress {
  active: boolean;
  stage: 'idle' | 'coords' | 'scan' | 'astar' | 'done';
  percent: number;
  message: string;
  elapsedMs: number;
  systemsScanned?: number;
  systemsUsed?: number;
}

interface Props {
  onRouteFound: (route: RoutePoint[]) => void;
  onProgress?: (progress: RouteSearchProgress) => void;
}

type SearchPhase =
  | { stage: 'idle' }
  | { stage: 'coords'; message: string }
  | { stage: 'scan'; message: string; current: number; total: number }
  | { stage: 'astar'; message: string }
  | { stage: 'done'; message: string };

const PHASES: { stage: Exclude<SearchPhase['stage'], 'idle'>; message: string; delay: number }[] = [
  { stage: 'coords', message: 'Получение координат систем из EDSM…', delay: 700 },
  { stage: 'scan', message: 'Сканирование систем вдоль маршрута…', delay: 1200 },
  { stage: 'astar', message: 'Построение оптимального маршрута (A*)…', delay: 900 },
  { stage: 'done', message: 'Финализация результатов…', delay: 500 },
];

const MAX_JUMPS_IN_LIST = 400;

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

export default function AtlasRouteFinder({ onRouteFound, onProgress }: Props) {
  const [fromSystem, setFromSystem] = useState('');
  const [toSystem, setToSystem] = useState('');
  const [maxJump, setMaxJump] = useState(14.99);
  const [radius, setRadius] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [phase, setPhase] = useState<SearchPhase>({ stage: 'idle' });
  const [routeFilter, setRouteFilter] = useState('');
  const [showDetails, setShowDetails] = useState(false);
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
        setPhase({ stage: item.stage, message: item.message, current: index + 1, total: PHASES.length - 1 } as SearchPhase);
        onProgress?.({
          active: true,
          stage: item.stage,
          percent: percentages[index],
          message: item.message,
          elapsedMs: Date.now() - startedAt,
        });
      }, elapsed);
      phaseTimers.current.push(timer);
    });
  }, [clearPhaseTimers, onProgress]);

  const findRoute = useCallback(async () => {
    if (!fromSystem.trim() || !toSystem.trim()) {
      toast('Укажите обе системы', 'error');
      return;
    }
    if (fromSystem.trim().toLowerCase() === toSystem.trim().toLowerCase()) {
      toast('Точка А и точка Б совпадают', 'error');
      return;
    }
    const startedAt = Date.now();
    setLoading(true);
    setResult(null);
    setRouteFilter('');
    setPhase({ stage: 'coords', message: 'Получение координат систем из EDSM…' });
    onProgress?.({ active: true, stage: 'coords', percent: 4, message: 'Получение координат систем из EDSM…', elapsedMs: 0 });
    animatePhases(startedAt);
    // Эндпоинт считает маршрут одним запросом: пока он работает, показываем
    // оценку прогресса, а после ответа подставляем точные цифры из `process`.
    const progressTimer = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const estimatedScanned = Math.max(1, Math.floor(elapsedMs / 180));
      onProgress?.({
        active: true,
        stage: 'scan',
        percent: Math.min(88, 35 + Math.floor(estimatedScanned / 10)),
        message: 'Перебор систем EDSM вдоль трассы…',
        elapsedMs,
        systemsScanned: estimatedScanned,
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
        }),
      });
      const responseText = await res.text();
      let data: any;
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        throw new Error(`Сервер вернул некорректный ответ (${res.status}). Уменьшите радиус сканирования или повторите поиск.`);
      }
      if (!res.ok) {
        throw new Error(data.error || `Маршрут не найден (HTTP ${res.status})`);
      }
      if (!Array.isArray(data.route) || data.route.length === 0) {
        throw new Error('Сервис вернул пустой маршрут — попробуйте увеличить радиус сканирования');
      }
      setPhase({ stage: 'done', message: 'Готово!' });
      setResult(data);
      onProgress?.({
        active: false,
        stage: 'done',
        percent: 100,
        message: data.process?.synthetic_waypoints ? 'Маршрут готов, в него добавлены расчётные точки' : 'Маршрут построен',
        elapsedMs: Date.now() - startedAt,
        systemsScanned: data.process?.systems_scanned,
        systemsUsed: data.process?.systems_used,
      });
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
      toast(`Маршрут найден: ${data.summary.total_jumps} прыжков`, 'success');
    } catch (err: any) {
      onProgress?.({ active: false, stage: 'idle', percent: 0, message: err.message || 'Ошибка поиска', elapsedMs: Date.now() - startedAt });
      toast(err.message || 'Ошибка поиска', 'error');
    } finally {
      window.clearInterval(progressTimer);
      clearPhaseTimers();
      setLoading(false);
      setPhase({ stage: 'idle' });
    }
  }, [animatePhases, clearPhaseTimers, fromSystem, maxJump, onProgress, onRouteFound, radius, toSystem]);

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
        return `${index + 1}. ${point.name} (${formatCoordinates(point, 2)})${jump ? ` — ${jump} св.л.` : ''}`;
      })
      .join('\n');
    const ok = await copyText(text);
    toast(ok ? 'Маршрут скопирован в буфер' : 'Буфер обмена недоступен', ok ? 'success' : 'error');
  }, [result]);

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
        <h3>Поиск маршрута колонизации</h3>
        <p className="atlas-route-desc">
          Оптимальный маршрут между двумя системами с шагом не больше максимального прыжка.
          Расчёт идёт по алгоритму A* на данных EDSM; для длинных трасс автоматически включается
          режим кубов с перекрытием сканирования.
        </p>

        <SystemSearchInput
          label="Точка А (откуда)"
          value={fromSystem}
          onChange={setFromSystem}
          placeholder="например, Sol"
        />
        <div className="atlas-swap-row">
          <button type="button" className="atlas-link-btn" onClick={swapSystems} disabled={!fromSystem && !toSystem}>
            <IconRefresh size={12} /> Поменять точки местами
          </button>
        </div>
        <SystemSearchInput
          label="Точка Б (куда)"
          value={toSystem}
          onChange={setToSystem}
          onSubmit={() => {
            if (fromSystem.trim() && toSystem.trim()) void findRoute();
          }}
          placeholder="например, Colonia"
        />

        <div className="atlas-two-col">
          <div className="atlas-search-field">
            <label htmlFor="atlas-max-jump">
              Макс. прыжок: <strong>{maxJump.toFixed(2)} св.л.</strong>
            </label>
            <input
              id="atlas-max-jump"
              type="range"
              min={5}
              max={14.99}
              step={0.01}
              value={maxJump}
              onChange={(event) => setMaxJump(Number(event.target.value))}
            />
            <div className="atlas-range-scale"><span>5</span><span>14,99 (лимит колонизации)</span></div>
          </div>
        </div>

        <div className="atlas-search-field">
          <label htmlFor="atlas-radius">
            Радиус сканирования: <strong>{radius} св.л.</strong>
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
          <div className="atlas-range-scale"><span>10</span><span>100 (максимум EDSM)</span></div>
        </div>

        <button
          type="button"
          onClick={findRoute}
          disabled={loading || !fromSystem.trim() || !toSystem.trim()}
          className="atlas-scan-btn"
        >
          {loading ? 'Поиск…' : 'Найти маршрут'}
        </button>

        {loading && phase.stage !== 'idle' && (
          <div className="atlas-progress" aria-live="polite">
            <div className="atlas-progress-head">
              <span className="atlas-progress-live">
                <span className="atlas-spinner" /> {phase.message}
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
                      {item.stage === 'coords' && 'Координаты'}
                      {item.stage === 'scan' && 'Сканирование'}
                      {item.stage === 'astar' && 'A*'}
                      {item.stage === 'done' && 'Готово'}
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
            <h4>Результат</h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title="Скопировать маршрут текстом" onClick={() => void copyRoute()}>
                <IconCopy size={12} />
              </button>
              <button type="button" className="atlas-icon-btn" title="Скачать CSV" onClick={downloadRoute}>
                <IconDownload size={12} />
              </button>
            </div>
          </div>

          <div className="atlas-route-summary">
            <div className="stat-box"><div className="num">{result.summary.total_jumps}</div><div className="lbl">Прыжков</div></div>
            <div className="stat-box"><div className="num">{result.summary.total_distance}</div><div className="lbl">Св. лет</div></div>
            <div className="stat-box"><div className="num">{result.summary.max_jump}</div><div className="lbl">Макс. прыжок</div></div>
            <div className="stat-box"><div className="num">{result.summary.avg_jump}</div><div className="lbl">Средний</div></div>
          </div>

          {result.summary.synthetic_waypoints && (
            <p className="atlas-warning">
              Часть точек рассчитана: EDSM не отдал подходящие известные системы вдоль трассы.
            </p>
          )}

          <div className="atlas-section-head">
            <h4>Маршрут</h4>
            <div className="atlas-inline-search compact">
              <IconSearch size={12} />
              <input
                type="search"
                value={routeFilter}
                onChange={(event) => setRouteFilter(event.target.value)}
                placeholder="Найти систему"
                aria-label="Фильтр маршрута"
              />
              {routeFilter && (
                <button type="button" onClick={() => setRouteFilter('')} aria-label="Очистить фильтр">
                  <IconX size={11} />
                </button>
              )}
            </div>
          </div>

          <p className="atlas-list-counter">
            Точек: {result.route.length}
            {routeFilter ? ` · найдено ${filteredRoute.length}` : ''}
            {!routeFilter && result.route.length > MAX_JUMPS_IN_LIST ? ` · показаны первые ${MAX_JUMPS_IN_LIST}` : ''}
          </p>

          <div className="atlas-route-list">
            {filteredRoute.length === 0 && <p className="atlas-muted">В маршруте нет систем по этому фильтру.</p>}
            {filteredRoute.map((point, index) => (
              <div key={`${point.name}-${index}`} className="route-row">
                <span className="route-idx">{index + 1}</span>
                <span className="route-name">{point.name}</span>
                <span className="route-coords">{formatCoordinates(point)}</span>
              </div>
            ))}
          </div>

          <button type="button" className="atlas-secondary-btn" onClick={() => setShowDetails((current) => !current)}>
            {showDetails ? 'Скрыть детали расчёта' : 'Показать детали расчёта'}
          </button>

          {showDetails && result.process && (
            <div className="atlas-details-box">
              <div className="atlas-tag-row">
                <span className="atlas-tag orange">{result.process.strategy === 'cube-systems' ? 'Кубы EDSM' : 'Сферы EDSM'}</span>
                <span className="atlas-tag blue">{formatDuration(result.process.elapsed_ms)}</span>
                <span className="atlas-tag">{result.process.api_requests} API-запросов</span>
              </div>

              <div className="atlas-stat-grid">
                <div>Прямое расстояние</div><div>{formatDistanceLy(result.process.direct_distance, 0)}</div>
                <div>Точек сканирования</div><div>{result.process.scan_points} / {result.process.estimated_steps}</div>
                <div>Шаг сканирования</div><div>~{Math.round(result.process.actual_step).toLocaleString('ru-RU')} св.л.</div>
                <div>Систем просканировано</div><div>{result.process.systems_scanned.toLocaleString('ru-RU')}</div>
                <div>Узлов в графе</div><div>{result.process.graph_nodes.toLocaleString('ru-RU')}</div>
                <div>Рёбер в графе</div><div>{result.process.graph_edges.toLocaleString('ru-RU')}</div>
                <div>Радиус сканирования</div><div>{result.process.radius_around_path.toLocaleString('ru-RU')} св.л.</div>
                <div>Макс. прыжок</div><div>{result.process.max_jump} св.л.</div>
              </div>

              {result.process.systems_per_scan.length > 0 && histogramMax > 0 && (
                <div className="atlas-histogram">
                  <div className="atlas-histogram-title">Систем найдено по точкам сканирования</div>
                  <div className="atlas-histogram-bars">
                    {result.process.systems_per_scan.map((count, index) => (
                      <div
                        key={index}
                        className="atlas-histogram-bar"
                        style={{
                          height: `${Math.max(2, (count / histogramMax) * 100)}%`,
                          background: count > 0 ? '#e67e22' : '#3a3d40',
                        }}
                        title={`Точка ${index + 1}: ${count} систем`}
                      />
                    ))}
                  </div>
                  <div className="atlas-histogram-axis"><span>Начало</span><span>Конец</span></div>
                </div>
              )}

              <div className="atlas-details-footer">
                {result.process.from_system} <IconArrowRight size={11} /> {result.process.to_system} · A* · EDSM API
              </div>
            </div>
          )}

          <h4>Прыжки</h4>
          <div className="atlas-jump-list">
            {result.jumps.slice(0, MAX_JUMPS_IN_LIST).map((jump, index) => {
              const color = jump.distance <= 15 ? '#22c55e' : jump.distance <= 25 ? '#e67e22' : '#e74c3c';
              return (
                <div key={`${jump.from}-${jump.to}-${index}`} className="route-row" style={{ borderLeft: `3px solid ${color}` }}>
                  <span className="route-idx">{index + 1}</span>
                  <span className="route-name">{jump.from} → {jump.to}</span>
                  <span className="route-coords" style={{ color, fontWeight: 600 }}>{jump.distance} св.л.</span>
                </div>
              );
            })}
            {result.jumps.length > MAX_JUMPS_IN_LIST && (
              <p className="atlas-muted">Показаны первые {MAX_JUMPS_IN_LIST} прыжков из {result.jumps.length} — полный список есть в CSV.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
