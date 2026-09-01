"use client";

import { useState, useCallback } from "react";
import { Toaster, toast } from "@/components/ui/Toaster";
import type { RoutePoint } from "@/components/GalaxyMap/useGalaxyData";

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
  };
  process?: SearchProcess;
}

interface Props {
  onRouteFound: (route: RoutePoint[]) => void;
}

type SearchPhase =
  | { stage: 'idle' }
  | { stage: 'coords'; message: string }
  | { stage: 'scan'; message: string; current: number; total: number }
  | { stage: 'astar'; message: string }
  | { stage: 'done'; message: string };

const PHASES: { stage: Exclude<SearchPhase['stage'], 'idle'>; message: string; delay: number }[] = [
  { stage: 'coords', message: 'Получение координат систем из EDSM...', delay: 700 },
  { stage: 'scan', message: 'Сканирование систем вдоль маршрута...', delay: 1200 },
  { stage: 'astar', message: 'Построение оптимального маршрута (A*)...', delay: 900 },
  { stage: 'done', message: 'Финализация результатов...', delay: 500 },
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} мс`;
  return `${(ms / 1000).toFixed(1)} с`;
}

export default function AtlasRouteFinder({ onRouteFound }: Props) {
  const [fromSystem, setFromSystem] = useState("");
  const [toSystem, setToSystem] = useState("");
  const [maxJump, setMaxJump] = useState(15);
  const [radius, setRadius] = useState(30);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<RouteResult | null>(null);
  const [phase, setPhase] = useState<SearchPhase>({ stage: 'idle' });

  const animatePhases = useCallback(() => {
    let i = 0;
    const run = () => {
      if (i >= PHASES.length) return;
      const p = PHASES[i];
      setPhase({ stage: p.stage, message: p.message, current: i + 1, total: PHASES.length - 1 } as SearchPhase);
      i++;
      setTimeout(run, p.delay);
    };
    run();
  }, []);

  const findRoute = useCallback(async () => {
    if (!fromSystem.trim() || !toSystem.trim()) {
      toast("Укажите обе системы", "error");
      return;
    }
    setLoading(true);
    setResult(null);
    setPhase({ stage: 'coords', message: 'Получение координат систем из EDSM...' });
    animatePhases();
    try {
      const res = await fetch("/api/atlas/route-finder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          from_system: fromSystem.trim(),
          to_system: toSystem.trim(),
          max_jump: maxJump,
          radius_around_path: radius,
        }),
      });
      const data = await res.json();
      setPhase({ stage: 'done', message: 'Готово!' });
      if (!res.ok) {
        toast(data.error || "Маршрут не найден", "error");
        setLoading(false);
        setPhase({ stage: 'idle' });
        return;
      }
      setResult(data);
      const mappedRoute: RoutePoint[] = data.route.map((rp: ApiRoutePoint, i: number) => ({
        id: -(i + 1),
        system_name: rp.name,
        sort_order: i,
        status: 'planned' as const,
        x: rp.x,
        y: rp.y,
        z: rp.z,
      }));
      onRouteFound(mappedRoute);
      toast(`Маршрут найден: ${data.summary.total_jumps} прыжков`, "success");
    } catch (err: any) {
      toast(err.message || "Ошибка поиска", "error");
    } finally {
      setLoading(false);
      setTimeout(() => setPhase({ stage: 'idle' }), 800);
    }
  }, [fromSystem, toSystem, maxJump, radius, onRouteFound, animatePhases]);

  const radiusLabel = radius <= 100
    ? `${radius} св.г. (сфера)`
    : radius <= 200
      ? `${radius} св.г. (куб)`
      : `${radius} св.г. (куб, шаг ~${Math.round(radius * 0.7)} св.г.)`;

  return (
    <div className="atlas-route-finder">
      <Toaster />

      <div className="atlas-search-panel">
        <h3>Поиск маршрута колонизации</h3>
        <p className="atlas-route-desc">
          Найдите оптимальный маршрут между двумя системами с учётом максимального радиуса прыжка.
          Используется алгоритм A* с данными EDSM. Для больших расстояний (&gt;100 св.г.) автоматически
          переключается на режим cube-systems с перекрытием сканирования.
        </p>

        <div className="atlas-search-field">
          <label>Точка А (откуда)</label>
          <input
            type="text"
            placeholder="например, Sol"
            value={fromSystem}
            onChange={(e) => setFromSystem(e.target.value)}
          />
        </div>

        <div className="atlas-search-field">
          <label>Точка Б (куда)</label>
          <input
            type="text"
            placeholder="например, Colonia"
            value={toSystem}
            onChange={(e) => setToSystem(e.target.value)}
          />
        </div>

        <div className="atlas-two-col">
          <div className="atlas-search-field">
            <label>Макс. прыжок: {maxJump} св.г. (макс. 15 для колонизации)</label>
            <input
              type="range"
              min={5}
              max={15}
              step={1}
              value={maxJump}
              onChange={(e) => setMaxJump(Number(e.target.value))}
            />
          </div>
          <div className="atlas-search-field">
            <label>Радиус сканирования: {radiusLabel}</label>
            <input
              type="range"
              min={10}
              max={50000}
              step={radius < 100 ? 5 : radius < 1000 ? 50 : 500}
              value={radius}
              onChange={(e) => setRadius(Number(e.target.value))}
            />
            <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
              {radius <= 100
                ? 'Режим sphere-systems: сканирует сферу вокруг ближайшей системы'
                : 'Режим cube-systems: сканирует кубы вдоль линии маршрута с перекрытием'}
            </div>
          </div>
        </div>

        <button
          onClick={findRoute}
          disabled={loading || !fromSystem.trim() || !toSystem.trim()}
          className="atlas-scan-btn"
        >
          {loading ? "Поиск..." : "Найти маршрут"}
        </button>

        {/* Прогресс поиска */}
        {loading && phase.stage !== 'idle' && (
          <div style={{ marginTop: 16, background: '#25282b', border: '1px solid #3a3d40', borderRadius: 8, padding: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <div style={{
                width: 16, height: 16,
                border: '2px solid #3a3d40',
                borderTop: '2px solid #e67e22',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
              }} />
              <span style={{ fontSize: 13, color: '#eeeeee' }}>{phase.message}</span>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {PHASES.map((p, idx) => {
                const currentIdx = PHASES.findIndex(pp => pp.stage === phase.stage);
                const isDone = idx < currentIdx;
                const isActive = idx === currentIdx;
                return (
                  <div key={p.stage} style={{ flex: 1 }}>
                    <div style={{
                      height: 4,
                      borderRadius: 2,
                      background: isDone ? '#22c55e' : isActive ? '#e67e22' : '#3a3d40',
                      transition: 'background 0.3s ease',
                    }} />
                    <div style={{
                      fontSize: 10,
                      marginTop: 4,
                      textAlign: 'center',
                      color: isDone ? '#22c55e' : isActive ? '#e67e22' : '#6b7280',
                    }}>
                      {p.stage === 'coords' && 'Координаты'}
                      {p.stage === 'scan' && 'Сканирование'}
                      {p.stage === 'astar' && 'A*'}
                      {p.stage === 'done' && 'Готово'}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {result && (
        <div className="atlas-section">
          <h4>Результат</h4>
          <div className="atlas-route-summary">
            <div className="stat-box" style={{ padding: 10 }}>
              <div className="num">{result.summary.total_jumps}</div>
              <div className="lbl">Прыжков</div>
            </div>
            <div className="stat-box" style={{ padding: 10 }}>
              <div className="num">{result.summary.total_distance}</div>
              <div className="lbl">Св.годов</div>
            </div>
            <div className="stat-box" style={{ padding: 10 }}>
              <div className="num">{result.summary.max_jump}</div>
              <div className="lbl">Макс. прыжок</div>
            </div>
            <div className="stat-box" style={{ padding: 10 }}>
              <div className="num">{result.summary.avg_jump}</div>
              <div className="lbl">Средний</div>
            </div>
          </div>

          {/* Детали процесса поиска */}
          {result.process && (
            <div style={{ marginTop: 12, background: '#1e2124', border: '1px solid #2d3033', borderRadius: 6, padding: 12 }}>
              <h4 style={{ fontSize: 11, letterSpacing: 1, textTransform: 'uppercase', color: '#9ca3af', margin: '0 0 10px 0' }}>
                Детали поиска
              </h4>

              {/* Стратегия и время */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 10, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 11, padding: '3px 10px', background: '#2d3033', borderRadius: 4, color: '#e67e22' }}>
                  {result.process.strategy === 'cube-systems' ? 'Кубы EDSM' : 'Сферы EDSM'}
                </span>
                <span style={{ fontSize: 11, padding: '3px 10px', background: '#2d3033', borderRadius: 4, color: '#60a5fa' }}>
                  {formatDuration(result.process.elapsed_ms)}
                </span>
                <span style={{ fontSize: 11, padding: '3px 10px', background: '#2d3033', borderRadius: 4, color: '#9ca3af' }}>
                  {result.process.api_requests} API-запросов
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px 16px', fontSize: 12 }}>
                <div style={{ color: '#9ca3af' }}>Прямое расстояние:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.direct_distance.toLocaleString('ru')} св.г.</div>

                <div style={{ color: '#9ca3af' }}>Точек сканирования:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.scan_points} / {result.process.estimated_steps}</div>

                <div style={{ color: '#9ca3af' }}>Шаг сканирования:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>~{result.process.actual_step.toLocaleString('ru')} св.г.</div>

                <div style={{ color: '#9ca3af' }}>Систем просканировано:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.systems_scanned.toLocaleString('ru')}</div>

                <div style={{ color: '#9ca3af' }}>Узлов в графе:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.graph_nodes.toLocaleString('ru')}</div>

                <div style={{ color: '#9ca3af' }}>Рёбер в графе:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.graph_edges.toLocaleString('ru')}</div>

                <div style={{ color: '#9ca3af' }}>Радиус сканирования:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.radius_around_path.toLocaleString('ru')} св.г.</div>

                <div style={{ color: '#9ca3af' }}>Макс. прыжок:</div>
                <div style={{ color: '#eeeeee', textAlign: 'right' }}>{result.process.max_jump} св.г.</div>
              </div>

              {/* Гистограмма систем по точкам сканирования */}
              {result.process.systems_per_scan.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 6 }}>Систем найдено по точкам сканирования</div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 40 }}>
                    {result.process.systems_per_scan.map((count, i) => {
                      const max = Math.max(...result.process!.systems_per_scan);
                      const h = max > 0 ? (count / max) * 100 : 0;
                      return (
                        <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
                          <div
                            style={{
                              width: '100%',
                              height: `${h}%`,
                              background: count > 0 ? '#e67e22' : '#3a3d40',
                              borderRadius: '2px 2px 0 0',
                              minHeight: count > 0 ? 2 : 1,
                              transition: 'height 0.3s ease',
                            }}
                            title={`Точка ${i + 1}: ${count} систем`}
                          />
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9, color: '#4b5563', marginTop: 2 }}>
                    <span>Начало</span>
                    <span>Конец</span>
                  </div>
                </div>
              )}

              <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #2d3033', fontSize: 11, color: '#6b7280' }}>
                {result.process.from_system} &#8594; {result.process.to_system}
                <span style={{ marginLeft: 8, color: '#4b5563' }}>|</span>
                <span style={{ marginLeft: 8 }}>A* алгоритм</span>
                <span style={{ marginLeft: 8, color: '#4b5563' }}>|</span>
                <span style={{ marginLeft: 8 }}>EDSM API</span>
              </div>
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <h4 style={{ fontSize: 12, marginBottom: 8 }}>Маршрут</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.route.map((rp, i) => (
                <div key={i} className="route-row" style={{ padding: "6px 8px" }}>
                  <span className="route-idx">{i + 1}</span>
                  <span className="route-name">{rp.name}</span>
                  <span className="route-coords">
                    {rp.x.toFixed(1)}, {rp.y.toFixed(1)}, {rp.z.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ marginTop: 12 }}>
            <h4 style={{ fontSize: 12, marginBottom: 8 }}>Прыжки</h4>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {result.jumps.map((j, i) => (
                <div
                  key={i}
                  className="route-row"
                  style={{
                    padding: "6px 8px",
                    borderLeft: `3px solid ${j.distance <= 15 ? "#22c55e" : j.distance <= 25 ? "#e67e22" : "#e74c3c"}`,
                  }}
                >
                  <span className="route-idx">{i + 1}</span>
                  <span className="route-name" style={{ flex: 1 }}>
                    {j.from} &#8594; {j.to}
                  </span>
                  <span
                    className="route-coords"
                    style={{
                      color: j.distance <= 15 ? "#22c55e" : j.distance <= 25 ? "#e67e22" : "#e74c3c",
                      fontWeight: 600,
                    }}
                  >
                    {j.distance} св.г.
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
