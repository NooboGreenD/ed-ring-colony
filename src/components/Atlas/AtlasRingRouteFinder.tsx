'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import { toast } from '@/components/ui/Toaster';
import { IconCopy, IconDownload, IconSearch, IconX } from '@/components/Icons';
import { copyText, downloadCsv, formatCoordinates, routeToCsvRows } from '@/lib/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';

interface Props {
  onRouteFound: (route: RoutePoint[]) => void;
}

interface RingPoint {
  name: string;
  x: number;
  y: number;
  z: number;
  source?: string;
}

interface RingResult {
  route: RingPoint[];
  center?: { name?: string; x: number; y: number; z: number };
  ring_radius: number;
  search_radius: number;
  max_jump: number;
  discovered_count: number;
  synthetic_count: number;
  anchors: Array<{ name: string }>;
}

interface RingProgress {
  percent: number;
  stage: string;
  message: string;
  sector: number;
  sectors: number;
  found: number;
  cached: boolean;
  deviation: number;
  point: number;
  total: number;
  replacements: number;
}

const EMPTY_PROGRESS: RingProgress = {
  percent: 0, stage: '', message: '', sector: 0, sectors: 0,
  found: 0, cached: false, deviation: 0, point: 0, total: 0, replacements: 0,
};

/** Разбор NDJSON-потока прогресса: одна битая строка не роняет весь маршрут. */
function parsePacket(line: string): { event: string; data: any } | null {
  if (!line.trim()) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export default function AtlasRingRouteFinder({ onRouteFound }: Props) {
  const [startSystem, setStartSystem] = useState('Sol');
  const [ringRadius, setRingRadius] = useState(23000);
  const [searchRadius, setSearchRadius] = useState(500);
  const [loading, setLoading] = useState(false);
  const [refining, setRefining] = useState(false);
  const [progress, setProgress] = useState<RingProgress>(EMPTY_PROGRESS);
  const [result, setResult] = useState<RingResult | null>(null);
  const [routeFilter, setRouteFilter] = useState('');
  const abortRef = useRef<AbortController | null>(null);

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setLoading(false);
    setRefining(false);
    toast('Поиск остановлен', 'info');
  }, []);

  const runStream = useCallback(async (
    url: string,
    body: unknown,
    onResult: (data: any) => void,
    failureMessage: string,
  ) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      const details = await res.json().catch(() => ({}));
      throw new Error(details.error || failureMessage);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let data: unknown = null;
    let streamError: string | null = null;

    const handlePacket = (line: string) => {
      const packet = parsePacket(line);
      if (!packet) return;
      if (packet.event === 'progress') setProgress((current) => ({ ...current, ...packet.data }));
      if (packet.event === 'error') streamError = packet.data?.message || failureMessage;
      if (packet.event === 'result') data = packet.data;
    };

    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) handlePacket(line);
      if (chunk.done) break;
    }
    buffer += decoder.decode();
    if (buffer.trim()) handlePacket(buffer);

    if (streamError) throw new Error(streamError);
    if (!data) throw new Error(failureMessage);
    onResult(data);
  }, []);

  const search = async () => {
    if (!startSystem.trim()) return;
    setLoading(true);
    setResult(null);
    setRouteFilter('');
    setProgress({ ...EMPTY_PROGRESS, stage: 'start', message: 'Запуск поиска кольцевого маршрута' });
    try {
      await runStream(
        '/api/atlas/ring-route',
        { start_system: startSystem, ring_radius: ringRadius, search_radius: searchRadius },
        (completed: RingResult) => {
          const mapped: RoutePoint[] = completed.route.map((point, index) => ({
            id: -(index + 1), system_name: point.name, x: point.x, y: point.y, z: point.z,
            sort_order: index, status: 'planned', isHub: false,
          }));
          setResult(completed);
          onRouteFound(mapped);
          toast(`Кольцо построено: ${completed.route.length} точек`, 'success');
        },
        'Не удалось запустить поиск кольца',
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast(error instanceof Error ? error.message : 'Ошибка поиска кольца', 'error');
    } finally {
      abortRef.current = null;
      setLoading(false);
    }
  };

  const refine = async () => {
    if (!result || refining) return;
    setRefining(true);
    setProgress({ ...EMPTY_PROGRESS, stage: 'refine', message: 'Подготовка уточнения маршрута', total: result.route.length - 2 });
    try {
      await runStream(
        '/api/atlas/ring-route/refine',
        { route: result.route, center: result.center || { x: 25.21875, y: -20.90625, z: 25899.96875 }, ring_radius: result.ring_radius },
        (refined: { route: RingPoint[]; replacements?: number }) => {
          const mapped: RoutePoint[] = refined.route.map((point, index) => ({
            id: -(index + 1), system_name: point.name, x: point.x, y: point.y, z: point.z,
            sort_order: index, status: 'planned', isHub: false,
          }));
          setResult({ ...result, route: refined.route });
          onRouteFound(mapped);
          toast(`Маршрут уточнён: заменено ${refined.replacements ?? 0} точек`, 'success');
        },
        'Не удалось запустить уточнение маршрута',
      );
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      toast(error instanceof Error ? error.message : 'Ошибка уточнения маршрута', 'error');
    } finally {
      abortRef.current = null;
      setRefining(false);
    }
  };

  const exportRingCsv = () => {
    if (!result) return;
    downloadCsv(
      `galactic-ring-${startSystem}`,
      routeToCsvRows(result.route.map((point) => ({
        ...point,
        source: point.source === 'triangulated' ? 'triangulated' : 'edsm',
      }))),
    );
  };

  const copyRoute = async () => {
    if (!result) return;
    const text = result.route.map((point, index) => `${index + 1}. ${point.name} (${formatCoordinates(point, 2)})`).join('\n');
    const ok = await copyText(text);
    toast(ok ? 'Кольцо скопировано в буфер' : 'Буфер обмена недоступен', ok ? 'success' : 'error');
  };

  const filteredRoute = useMemo(() => {
    if (!result) return [];
    const q = routeFilter.trim().toLowerCase();
    if (!q) return result.route;
    return result.route.filter((point) => point.name.toLowerCase().includes(q));
  }, [result, routeFilter]);

  const busy = loading || refining;

  return (
    <div className="atlas-route-finder">
      <div className="atlas-search-panel">
        <h3>Галактическое кольцо колонизации</h3>
        <p className="atlas-route-desc">
          Замкнутый маршрут вокруг Sagittarius A*. Допустимы переходы от 1 до 14,99 св.л.;
          реальные системы EDSM служат опорными точками, а разрывы заполняются расчётными узлами.
        </p>

        <SystemSearchInput
          label="Начальная система"
          value={startSystem}
          onChange={setStartSystem}
          onSubmit={() => { if (startSystem.trim() && !busy) void search(); }}
          placeholder="Sol"
        />

        <div className="atlas-search-field">
          <label htmlFor="ring-radius">
            Удаление от центра: <strong>{ringRadius.toLocaleString('ru-RU')} св.л.</strong>
          </label>
          <input
            id="ring-radius"
            type="range"
            min={100}
            max={45000}
            step={100}
            value={ringRadius}
            onChange={(event) => setRingRadius(Number(event.target.value))}
          />
          <div className="atlas-range-scale"><span>100</span><span>45 000</span></div>
        </div>

        <div className="atlas-search-field">
          <label htmlFor="ring-search-radius">
            Радиус поиска известных систем: <strong>{searchRadius.toLocaleString('ru-RU')} св.л.</strong>
          </label>
          <input
            id="ring-search-radius"
            type="range"
            min={50}
            max={3000}
            step={50}
            value={searchRadius}
            onChange={(event) => setSearchRadius(Number(event.target.value))}
          />
          <div className="atlas-range-scale"><span>50</span><span>3000</span></div>
        </div>

        <div className="atlas-button-row">
          <button type="button" className="atlas-scan-btn" onClick={search} disabled={busy || !startSystem.trim()}>
            {loading ? 'Поиск систем кольца…' : 'Построить галактическое кольцо'}
          </button>
          {busy && (
            <button type="button" className="atlas-stop-btn" onClick={stop}>Стоп</button>
          )}
        </div>

        {loading && (
          <div className="atlas-progress" aria-live="polite">
            <div className="atlas-progress-head">
              <span>{progress.message || 'Подготовка поиска…'}</span>
              <strong>{Math.round(progress.percent)}%</strong>
            </div>
            <div className="atlas-progress-bar">
              <div style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }} />
            </div>
            {progress.sectors > 0 && (
              <div className="atlas-progress-meta">
                Сегмент {progress.sector} из {progress.sectors} · найдено в сегменте: {progress.found} ·
                {' '}{progress.cached ? 'кэш' : 'EDSM с задержкой'} · отклонение: {progress.deviation.toFixed(1)} св.л.
              </div>
            )}
          </div>
        )}
      </div>

      {result && (
        <div className="atlas-section">
          <div className="atlas-section-head">
            <h4>Результат кольцевого маршрута</h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title="Скопировать кольцо текстом" onClick={() => void copyRoute()}>
                <IconCopy size={12} />
              </button>
              <button type="button" className="atlas-icon-btn" title="Скачать CSV" onClick={exportRingCsv}>
                <IconDownload size={12} />
              </button>
            </div>
          </div>

          <div className="atlas-route-summary">
            <div className="stat-box"><div className="num">{result.route.length}</div><div className="lbl">Точек маршрута</div></div>
            <div className="stat-box"><div className="num">{Math.max(0, result.anchors.length - 1)}</div><div className="lbl">Опорных систем</div></div>
            <div className="stat-box"><div className="num">{result.discovered_count}</div><div className="lbl">Найдено EDSM</div></div>
            <div className="stat-box"><div className="num">{result.synthetic_count}</div><div className="lbl">Расчётных точек</div></div>
          </div>

          <button type="button" className="atlas-secondary-btn" onClick={refine} disabled={busy}>
            {refining ? `Уточнение маршрута: ${Math.round(progress.percent)}%` : 'Уточнить маршрут по известным системам'}
          </button>
          {refining && (
            <p className="atlas-muted">
              {progress.message} · проверено точек: {progress.point} из {progress.total} · заменено: {progress.replacements}
            </p>
          )}

          <div className="atlas-section-head">
            <h4>Точки кольца</h4>
            <div className="atlas-inline-search compact">
              <IconSearch size={12} />
              <input
                type="search"
                value={routeFilter}
                onChange={(event) => setRouteFilter(event.target.value)}
                placeholder="Найти точку"
                aria-label="Фильтр точек кольца"
              />
              {routeFilter && (
                <button type="button" onClick={() => setRouteFilter('')} aria-label="Очистить фильтр">
                  <IconX size={11} />
                </button>
              )}
            </div>
          </div>
          <p className="atlas-list-counter">Показано {filteredRoute.length} из {result.route.length}</p>
          <div className="atlas-route-list">
            {filteredRoute.length === 0 && <p className="atlas-muted">Точек по фильтру нет.</p>}
            {filteredRoute.slice(0, 300).map((point, index) => (
              <div key={`${point.name}-${index}`} className="route-row">
                <span className="route-idx">{index + 1}</span>
                <span className="route-name">{point.name}</span>
                <span className="route-coords">{formatCoordinates(point)}</span>
              </div>
            ))}
            {filteredRoute.length > 300 && <p className="atlas-muted">Показаны первые 300 точек — полный список в CSV.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
