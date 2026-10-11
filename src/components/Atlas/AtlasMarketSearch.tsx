'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from '@/components/ui/Toaster';
import { SystemSearchInput } from '@/components/Atlas/SystemSearchInput';
import {
  finishAtlasSearchProgress,
  publishAtlasSearchPoints,
  publishAtlasSearchProgress,
  startAtlasSearchProgress,
} from '@/lib/atlasSearchProgress';
import {
  IconAlert,
  IconCoins,
  IconCrosshair,
  IconDownload,
  IconMapPin,
  IconPackage,
  IconRocket,
  IconSave,
  IconSearch,
  IconStore,
  IconX,
  IconXCircle,
} from '@/components/Icons';
import { downloadCsv } from '@/lib/atlas';
import { BUILD_COMMODITIES as COMMODITIES, resolveCommodity } from '@/lib/commodities';

const MAX_RADIUS = 500;

interface StationCommodity {
  name: string;
  stock: number;
  sell_price: number;
}

interface StationBuildResult {
  station_name: string;
  system_name: string;
  distance: number;
  landing_pad: string;
  station_type: string;
  commodities: StationCommodity[];
  commodities_found: number;
  commodities_total: number;
}

interface SingleResult {
  station_name: string;
  system_name: string;
  distance: number;
  commodity: string;
  sell_price: number;
  stock: number;
  demand: number;
  landing_pad: string;
  station_type: string;
}

interface SearchProgress {
  total: number;
  scanned: number;
  found: number;
  current: string;
  startedAt: number;
}

interface ScanLogEntry {
  system: string;
  status: 'cached' | 'has_market' | 'no_market';
  stations?: number;
  timestamp: string;
}

interface MapSystem {
  system_name: string;
  x?: number;
  y?: number;
  z?: number;
  status: string;
}

interface MapMarketResult {
  system_name: string;
  distance: number;
  x?: number;
  y?: number;
  z?: number;
  station_name?: string;
  commodities_found?: number;
}

interface AtlasMarketSearchProps {
  initialSystem?: string;
  /** Clears stale overlays when a new market scan starts. */
  onScanStart?: () => void;
  onScanUpdate?: (systems: MapSystem[]) => void;
  onMarketResults?: (results: MapMarketResult[]) => void;
}

function formatRemaining(progress: SearchProgress): string {
  if (progress.scanned <= 0) return '';
  const elapsed = Date.now() - progress.startedAt;
  const perSystem = elapsed / progress.scanned;
  const remaining = Math.max(0, progress.total - progress.scanned) * perSystem;
  if (remaining <= 0) return 'завершается…';
  const seconds = Math.round(remaining / 1000);
  if (seconds < 60) return `~${seconds} с`;
  return `~${Math.round(seconds / 60)} мин`;
}

export default function AtlasMarketSearch({ initialSystem = '', onScanStart, onScanUpdate, onMarketResults }: AtlasMarketSearchProps) {
  const [refSystem, setRefSystem] = useState(initialSystem || 'Sol');
  const [commodity, setCommodity] = useState('Steel');
  const [radius, setRadius] = useState(50);
  const [mode, setMode] = useState<'single' | 'build'>('single');
  const [singleResults, setSingleResults] = useState<SingleResult[]>([]);
  const [buildResults, setBuildResults] = useState<StationBuildResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);
  const [resultFilter, setResultFilter] = useState('');
  const [resultSort, setResultSort] = useState<'distance' | 'stock' | 'price'>('distance');
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<number | null>(null);
  const startAbortRef = useRef<AbortController | null>(null);
  const scanGenerationRef = useRef(0);

  // Система из ?system= приходит позже первого рендера (родитель читает URL).
  useEffect(() => {
    if (initialSystem) setRefSystem(initialSystem);
  }, [initialSystem]);

  const clearPolling = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stopSearch = useCallback((options: { silent?: boolean } = {}) => {
    // Останавливаем опрос и обесцениваем ответы уже запущенных /step-запросов,
    // чтобы остановленное сканирование не дорисовало маркеры на карте.
    scanGenerationRef.current += 1;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    clearPolling();
    setLoading(false);
    if (!options.silent) {
      finishAtlasSearchProgress({ message: 'Сканирование остановлено пользователем' });
    }
  }, [clearPolling]);

  useEffect(() => {
    return () => {
      scanGenerationRef.current += 1;
      startAbortRef.current?.abort();
      startAbortRef.current = null;
      clearPolling();
    };
  }, [clearPolling]);

  const handleSearch = async () => {
    stopSearch({ silent: true });
    if (!refSystem.trim()) {
      setError('Укажите систему отсчёта');
      return;
    }
    const generation = scanGenerationRef.current;
    const searchMode = mode;
    setError(null);
    setSingleResults([]);
    setBuildResults([]);
    setScanLog([]);
    setProgress(null);
    setResultFilter('');
    onScanStart?.();
    setLoading(true);
    startAtlasSearchProgress({
      kind: 'market',
      title: mode === 'build' ? 'ПОИСК СТАНЦИЙ ДЛЯ СТРОЙКИ' : 'ПОИСК РЫНКА ATLAS',
      stage: 'coords',
      percent: 2,
      message: `Определяем системы вокруг ${refSystem.trim()}`,
      counters: { 'Система': refSystem.trim(), 'Радиус': `${radius} св.л.` },
    });

    const controller = new AbortController();
    startAbortRef.current = controller;

    try {
      const res = await fetch('/api/market/find/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ref_system: refSystem.trim(),
          radius,
          mode: searchMode,
          commodity: searchMode === 'single' ? resolveCommodity(commodity) : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (scanGenerationRef.current !== generation) return;
      if (!res.ok) throw new Error(data.error || 'Не удалось запустить сканирование');

      const rawScanSystems = Array.isArray(data.systems_list) ? data.systems_list : [];
      const scanSystems: Array<{ name: string; distance: number; x: number; y: number; z: number }> = [];
      const coordinatesBySystem = new Map<string, { name: string; distance: number; x: number; y: number; z: number }>();
      for (const rawSystem of rawScanSystems) {
        if (!rawSystem || typeof rawSystem !== 'object') continue;
        const system = rawSystem as Record<string, unknown>;
        const name = String(system.name ?? '').trim().replace(/\s+/g, ' ');
        const x = Number(system.x);
        const y = Number(system.y);
        const z = Number(system.z);
        if (!name || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
        const positioned = {
          name,
          distance: Number.isFinite(Number(system.distance)) ? Number(system.distance) : 0,
          x,
          y,
          z,
        };
        const key = name.toLowerCase();
        if (!coordinatesBySystem.has(key)) {
          coordinatesBySystem.set(key, positioned);
          scanSystems.push(positioned);
        }
      }

      setProgress({
        total: Number(data.total_systems) || scanSystems.length,
        scanned: 0,
        found: 0,
        current: '',
        startedAt: Date.now(),
      });

      // Системы, которые предстоит просканировать, показываем на карте сразу:
      // пользователь видит область поиска, а не пустой экран.
      const scanCenter = scanSystems.find((system) => system.distance === 0) || scanSystems[0];
      publishAtlasSearchPoints(
        scanSystems.slice(0, 1500).map((system) => ({
          name: system.name,
          x: system.x,
          y: system.y,
          z: system.z,
          kind: 'scanned' as const,
          label: 'В очереди на сканирование',
        })),
      );
      publishAtlasSearchProgress({
        active: true,
        kind: 'market',
        stage: 'scan',
        percent: 3,
        message: `Сканируем ${scanSystems.length} систем вокруг ${refSystem.trim()}`,
        beam: scanCenter ? { x: scanCenter.x, y: scanCenter.y, z: scanCenter.z, label: refSystem.trim() } : null,
        counters: { 'Систем в очереди': scanSystems.length },
      });

      let requestInFlight = false;
      const finishCurrentSearch = () => {
        if (scanGenerationRef.current !== generation) return;
        clearPolling();
        if (startAbortRef.current === controller) startAbortRef.current = null;
        setLoading(false);
      };

      const poll = async () => {
        if (requestInFlight || scanGenerationRef.current !== generation) return;
        requestInFlight = true;
        try {
          const stepRes = await fetch('/api/market/find/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: data.job_id }),
          });
          const stepData = await stepRes.json().catch(() => ({}));
          if (scanGenerationRef.current !== generation) return;
          if (!stepRes.ok) throw new Error(stepData.error || 'Шаг сканирования не выполнен');

          if (stepData.progress) {
            const scanned = Number(stepData.progress.scanned) || 0;
            const total = Number(stepData.progress.total) || scanSystems.length;
            const found = Number(stepData.progress.found) || 0;
            const currentSystem = String(stepData.progress.current || '');
            setProgress((current) => ({
              total,
              scanned,
              found,
              current: currentSystem,
              startedAt: current?.startedAt ?? Date.now(),
            }));

            // Курсор сканирования на карте + счётчики прогресса.
            const beamSystem = coordinatesBySystem.get(currentSystem.trim().replace(/\s+/g, ' ').toLowerCase());
            const scanLogEntries: unknown[] = Array.isArray(stepData.scan_log) ? stepData.scan_log : [];
            const explored = scanLogEntries
              .filter((entry): entry is ScanLogEntry => !!entry && typeof entry === 'object' && typeof (entry as ScanLogEntry).system === 'string')
              .slice(-40)
              .flatMap((entry) => {
                const system = coordinatesBySystem.get(entry.system.trim().replace(/\s+/g, ' ').toLowerCase());
                if (!system) return [];
                return [{
                  name: entry.system,
                  x: system.x,
                  y: system.y,
                  z: system.z,
                  kind: (entry.status === 'has_market' ? 'station' : 'no-market') as 'station' | 'no-market',
                  label: entry.status === 'has_market' ? 'Есть рынок' : 'Рынка нет',
                }];
              });
            if (explored.length > 0) publishAtlasSearchPoints(explored);
            publishAtlasSearchProgress({
              active: true,
              kind: 'market',
              stage: 'scan',
              percent: total > 0 ? Math.round((scanned / total) * 100) : 0,
              message: currentSystem ? `Сканируем: ${currentSystem}` : 'Сканирование систем',
              beam: beamSystem
                ? { x: beamSystem.x, y: beamSystem.y, z: beamSystem.z, label: currentSystem }
                : null,
              counters: {
                'Проверено': `${scanned}/${total}`,
                'Станций найдено': found,
              },
            });
          }

          if (Array.isArray(stepData.scan_log)) {
            setScanLog(stepData.scan_log);
            if (onScanUpdate && scanSystems.length > 0) {
              const logEntries: unknown[] = stepData.scan_log;
              const updated: MapSystem[] = logEntries
                .filter((entry): entry is ScanLogEntry => !!entry && typeof entry === 'object' && typeof (entry as ScanLogEntry).system === 'string')
                .map((entry) => {
                  const system = coordinatesBySystem.get(entry.system.trim().replace(/\s+/g, ' ').toLowerCase());
                  return {
                    system_name: entry.system,
                    status: entry.status,
                    x: system?.x,
                    y: system?.y,
                    z: system?.z,
                  };
                });
              onScanUpdate(updated);
            }
          }

          const isDone = stepData.is_done === true || stepData.status === 'done';
          if (isDone) {
            const results = Array.isArray(stepData.result) ? stepData.result : [];
            const uniqueSystems = new Map<string, MapMarketResult>();
            for (const result of results) {
              if (!result || typeof result !== 'object') continue;
              const row = result as Record<string, any>;
              const systemName = String(row.system_name ?? '').trim().replace(/\s+/g, ' ');
              const key = systemName.toLowerCase();
              if (!key || uniqueSystems.has(key)) continue;
              const system = coordinatesBySystem.get(key);
              // Результат без координат остаётся в списке, но не попадает на карту:
              // иначе маркеры собирались бы в ложный столб в центре галактики.
              uniqueSystems.set(key, {
                system_name: systemName,
                distance: Number.isFinite(Number(row.distance)) ? Number(row.distance) : 0,
                x: system?.x,
                y: system?.y,
                z: system?.z,
                station_name: typeof row.station_name === 'string' ? row.station_name : undefined,
                commodities_found: Number.isFinite(Number(row.commodities_found)) ? Number(row.commodities_found) : 1,
              });
            }
            onMarketResults?.(Array.from(uniqueSystems.values()));
            publishAtlasSearchPoints(Array.from(uniqueSystems.values()).flatMap((system) => (
              Number.isFinite(system.x) && Number.isFinite(system.y) && Number.isFinite(system.z)
                ? [{
                  name: system.system_name,
                  x: Number(system.x),
                  y: Number(system.y),
                  z: Number(system.z),
                  kind: 'station' as const,
                  label: system.station_name ? `Станция: ${system.station_name}` : 'Найдена станция',
                }]
                : []
            )));
            finishAtlasSearchProgress({
              stage: 'done',
              percent: 100,
              message: `Сканирование завершено: станций найдено ${results.length}`,
              summary: searchMode === 'build'
                ? 'Найденные станции сохранены в кэш рынка проекта — повторный поиск пойдёт быстрее.'
                : 'Результаты сохранены в кэше проекта.',
              beam: null,
              counters: { 'Станций найдено': results.length },
            });
            if (searchMode === 'build') setBuildResults(results);
            else setSingleResults(results);
            finishCurrentSearch();
            toast(
              `Сканирование завершено: найдено станций ${results.length}`,
              results.length > 0 ? 'success' : 'info',
            );
          } else if (stepData.status === 'error') {
            finishCurrentSearch();
            throw new Error(stepData.error || 'Сканирование прервано ошибкой');
          }
        } catch (pollError) {
          if (scanGenerationRef.current === generation) {
            finishCurrentSearch();
            const message = pollError instanceof Error ? pollError.message : 'Ошибка сканирования';
            setError(message);
            finishAtlasSearchProgress({ stage: 'failed', message });
            toast(message, 'error');
          }
        } finally {
          requestInFlight = false;
        }
      };

      intervalRef.current = window.setInterval(() => { void poll(); }, 2000);
      void poll();
    } catch (startError) {
      if (scanGenerationRef.current !== generation || (startError instanceof DOMException && startError.name === 'AbortError')) return;
      const message = startError instanceof Error ? startError.message : 'Не удалось начать поиск';
      setError(message);
      finishAtlasSearchProgress({ stage: 'failed', message, percent: 0 });
      toast(message, 'error');
      clearPolling();
      if (startAbortRef.current === controller) startAbortRef.current = null;
      setLoading(false);
    }
  };

  const percent = progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0;

  const filterText = resultFilter.trim().toLowerCase();

  const visibleSingleResults = useMemo(() => {
    const rows = singleResults.filter((row) => {
      if (!filterText) return true;
      return row.station_name.toLowerCase().includes(filterText)
        || row.system_name.toLowerCase().includes(filterText)
        || row.landing_pad?.toLowerCase().includes(filterText);
    });
    return [...rows].sort((a, b) => {
      if (resultSort === 'stock') return (b.stock || 0) - (a.stock || 0);
      if (resultSort === 'price') return (b.sell_price || 0) - (a.sell_price || 0);
      return (a.distance || 0) - (b.distance || 0);
    });
  }, [filterText, resultSort, singleResults]);

  const visibleBuildResults = useMemo(() => {
    const rows = buildResults.filter((row) => {
      if (!filterText) return true;
      return row.station_name.toLowerCase().includes(filterText)
        || row.system_name.toLowerCase().includes(filterText);
    });
    return [...rows].sort((a, b) => {
      if (resultSort === 'price') return (b.commodities_found || 0) - (a.commodities_found || 0);
      if (resultSort === 'stock') return (b.commodities_total || 0) - (a.commodities_total || 0);
      return (a.distance || 0) - (b.distance || 0);
    });
  }, [buildResults, filterText, resultSort]);

  const exportResults = () => {
    if (mode === 'single') {
      downloadCsv(`market-${refSystem}-${commodity}`, [
        ['Станция', 'Система', 'Расстояние, св.л.', 'Товар', 'Продажа, CR', 'Запас', 'Спрос', 'Площадка'],
        ...visibleSingleResults.map((row) => [
          row.station_name, row.system_name, row.distance?.toFixed(1) ?? '',
          row.commodity || commodity, row.sell_price ?? '', row.stock ?? '', row.demand ?? '', row.landing_pad ?? '',
        ]),
      ]);
      return;
    }
    downloadCsv(`market-build-${refSystem}`, [
      ['Станция', 'Система', 'Расстояние, св.л.', 'Товаров найдено', 'Всего товаров', 'Товары'],
      ...visibleBuildResults.map((row) => [
        row.station_name, row.system_name, row.distance?.toFixed(1) ?? '',
        row.commodities_found, row.commodities_total,
        row.commodities.map((item) => `${item.name}: ${item.stock}`).join(', '),
      ]),
    ]);
  };

  const hasResults = mode === 'build' ? buildResults.length > 0 : singleResults.length > 0;

  return (
    <div className="atlas-section">
      <h4>Поиск товаров для стройки</h4>

      <SystemSearchInput
        label="Система отсчёта"
        value={refSystem}
        onChange={setRefSystem}
        placeholder="Sol"
      />

      <div className="atlas-search-field">
        <span className="atlas-field-label-row"><span>Режим поиска</span></span>
        <div className="atlas-segmented" role="group" aria-label="Режим поиска">
          <button
            type="button"
            className={mode === 'single' ? 'active' : ''}
            aria-pressed={mode === 'single'}
            onClick={() => setMode('single')}
          >
            Один товар
          </button>
          <button
            type="button"
            className={mode === 'build' ? 'active' : ''}
            aria-pressed={mode === 'build'}
            onClick={() => setMode('build')}
          >
            Всё для стройки
          </button>
        </div>
      </div>

      {mode === 'single' && (
        <div className="atlas-search-field">
          <label htmlFor="atlas-commodity">Товар</label>
          <input
            id="atlas-commodity"
            list="atlas-commodities"
            value={commodity}
            onChange={(event) => setCommodity(event.target.value)}
            placeholder="Начните вводить название"
          />
          <datalist id="atlas-commodities">
            {COMMODITIES.map((item) => <option key={item} value={item} />)}
          </datalist>
        </div>
      )}

      <div className="atlas-search-field">
        <label htmlFor="atlas-market-radius">
          Радиус поиска: <strong>{radius} св.л.</strong>
        </label>
        <input
          id="atlas-market-radius"
          type="range"
          min={10}
          max={MAX_RADIUS}
          step={10}
          value={radius}
          onChange={(event) => setRadius(Number(event.target.value))}
        />
        <div className="atlas-range-scale"><span>10</span><span>{MAX_RADIUS}</span></div>
      </div>

      <div className="atlas-button-row">
        <button
          type="button"
          onClick={handleSearch}
          disabled={loading || !refSystem.trim() || (mode === 'single' && !commodity.trim())}
          className="atlas-scan-btn"
        >
          {loading ? 'Сканирование…' : mode === 'build' ? 'Найти все товары' : 'Найти товары'}
        </button>
        {loading && <button type="button" className="atlas-stop-btn" onClick={() => stopSearch()}>Стоп</button>}
      </div>

      {error && (
        <p className="atlas-inline-error" role="alert">
          <IconAlert size={12} /> {error}
        </p>
      )}

      {loading && progress && (
        <div className="atlas-progress" aria-live="polite">
          <div className="atlas-progress-head">
            <span className="atlas-progress-live">
              {progress.current ? <>Сканирую: {progress.current}</> : 'Подготовка…'}
            </span>
            <span>{progress.scanned} / {progress.total} ({percent}%) · {progress.found} станций · осталось {formatRemaining(progress)}</span>
          </div>
          <div className="atlas-progress-bar"><div style={{ width: `${percent}%` }} /></div>

          <div className="atlas-scan-log">
            {scanLog.length === 0 && <div className="atlas-muted">Ожидание данных сканирования…</div>}
            {scanLog.map((entry, index) => (
              <div key={`${entry.system}-${index}`} className={`atlas-scan-log-row ${entry.status}`}>
                <span className="system">
                  {entry.status === 'cached' && <IconSave size={10} />}
                  {entry.status === 'has_market' && <IconStore size={10} />}
                  {entry.status === 'no_market' && <IconXCircle size={10} />}
                  <span>{entry.system}</span>
                  {entry.status === 'has_market' && typeof entry.stations === 'number' && (
                    <span className="stations">({entry.stations} станций)</span>
                  )}
                </span>
                <span className="status">
                  {entry.status === 'cached' ? 'из кэша' : entry.status === 'has_market' ? 'рынок найден' : 'нет рынка'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasResults && !loading && (
        <>
          <div className="atlas-section-head">
            <h4>
              {mode === 'build'
                ? `Станции с товарами (${buildResults.length})`
                : `Станции с товаром (${singleResults.length})`}
            </h4>
            <div className="atlas-section-actions">
              <button type="button" className="atlas-icon-btn" title="Экспорт результатов в CSV" onClick={exportResults}>
                <IconDownload size={12} />
              </button>
            </div>
          </div>

          <div className="atlas-list-toolbar-row">
            <div className="atlas-inline-search">
              <IconSearch size={12} />
              <input
                type="search"
                value={resultFilter}
                onChange={(event) => setResultFilter(event.target.value)}
                placeholder="Фильтр: станция, система"
                aria-label="Фильтр результатов"
              />
              {resultFilter && (
                <button type="button" onClick={() => setResultFilter('')} aria-label="Очистить фильтр">
                  <IconX size={11} />
                </button>
              )}
            </div>
            <select
              value={resultSort}
              onChange={(event) => setResultSort(event.target.value as 'distance' | 'stock' | 'price')}
              aria-label="Сортировка результатов"
            >
              <option value="distance">Ближе к системе</option>
              <option value="stock">Больше запаса</option>
              <option value="price">{mode === 'build' ? 'Больше товаров' : 'Выгоднее цена'}</option>
            </select>
          </div>

          {mode === 'build' ? (
            <div className="atlas-result-list">
              {visibleBuildResults.length === 0 && <p className="atlas-muted">По фильтру станций не найдено.</p>}
              {visibleBuildResults.map((row, index) => (
                <article key={`${row.station_name}-${index}`} className="atlas-station-card">
                  <header>
                    <span className="station">{row.station_name}</span>
                    <span className="system">@ {row.system_name}</span>
                    <span className="badge">{row.commodities_found}/{row.commodities_total} товаров</span>
                  </header>
                  <div className="meta">
                    <span><IconMapPin size={10} /> {row.distance.toFixed(1)} св.л.</span>
                    <span><IconRocket size={10} /> {row.landing_pad}</span>
                    <span>{row.station_type}</span>
                  </div>
                  <div className="commodities">
                    {row.commodities.map((item) => (
                      <span key={item.name} className="commodity">
                        <strong>{item.name}</strong>
                        <span>{item.stock.toLocaleString('ru-RU')} шт.</span>
                        {item.sell_price ? <span>{item.sell_price.toLocaleString('ru-RU')} CR</span> : null}
                      </span>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="atlas-result-list">
              {visibleSingleResults.length === 0 && <p className="atlas-muted">По фильтру станций не найдено.</p>}
              {visibleSingleResults.map((row, index) => (
                <article key={`${row.station_name}-${index}`} className="atlas-station-card compact">
                  <header>
                    <span className="station">{row.station_name}</span>
                    <span className="system">@ {row.system_name}</span>
                  </header>
                  <div className="meta">
                    <span><IconPackage size={10} /> {row.stock?.toLocaleString('ru-RU') ?? '?'} шт.</span>
                    <span><IconCoins size={10} /> {row.sell_price?.toLocaleString('ru-RU') ?? '?'} CR</span>
                    <span><IconMapPin size={10} /> {row.distance?.toFixed(1) ?? '?'} св.л.</span>
                    <span><IconRocket size={10} /> {row.landing_pad}</span>
                    {row.demand ? <span>спрос: {row.demand.toLocaleString('ru-RU')}</span> : null}
                  </div>
                </article>
              ))}
            </div>
          )}
        </>
      )}

      {!loading && !hasResults && (
        <p className="atlas-muted">
          {mode === 'build'
            ? 'Нажмите «Найти все товары», чтобы собрать станции с ресурсами для строительства.'
            : 'Нажмите «Найти товары», чтобы найти станции с выбранным товаром.'}
        </p>
      )}

      {!loading && scanLog.length > 0 && !hasResults && (
        <p className="atlas-muted">
          <IconCrosshair size={11} /> Сканирование завершено без подходящих станций — увеличьте радиус или смените товар.
        </p>
      )}
    </div>
  );
}
