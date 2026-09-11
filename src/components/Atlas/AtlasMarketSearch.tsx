'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import { toast } from '@/components/ui/Toaster';
import { IconXCircle, IconMapPin, IconPackage, IconSave, IconStore, IconCoins, IconRocket } from '@/components/Icons';

const COMMODITIES = [
  'Aluminium','Ceramic Composites','CMM Composite','Computer Components',
  'Copper','Food Cartridges','Fruit and Vegetables','Insulating Membrane',
  'Liquid oxygen','Medical Diagnostic Equipment','Non-Lethal Weapons',
  'Polymers','Power Generators','Semiconductors','Steel','Superconductors',
  'Titanium','Water','Water Purifiers','Structural Regulators',
  'Building Fabricators','Thermal Cooling Units',
];

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
  /** Clears stale overlays when a new market scan starts. */
  onScanStart?: () => void;
  onScanUpdate?: (systems: MapSystem[]) => void;
  onMarketResults?: (results: MapMarketResult[]) => void;
}

export default function AtlasMarketSearch({ onScanStart, onScanUpdate, onMarketResults }: AtlasMarketSearchProps) {
  const [refSystem, setRefSystem] = useState('Sol');
  const [commodity, setCommodity] = useState('Steel');
  const [radius, setRadius] = useState(50);
  const [mode, setMode] = useState<'single' | 'build'>('single');
  const [singleResults, setSingleResults] = useState<SingleResult[]>([]);
  const [buildResults, setBuildResults] = useState<StationBuildResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);
  const intervalRef = useRef<number | null>(null);
  const startAbortRef = useRef<AbortController | null>(null);
  const scanGenerationRef = useRef(0);

  const clearPolling = useCallback(() => {
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  const stopSearch = useCallback(() => {
    // Invalidate callbacks already waiting on /step or /start before clearing
    // their timer. This prevents a stopped/old scan from repainting the map.
    scanGenerationRef.current += 1;
    startAbortRef.current?.abort();
    startAbortRef.current = null;
    clearPolling();
    setLoading(false);
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
    stopSearch();
    const generation = scanGenerationRef.current;
    const searchMode = mode;
    setSingleResults([]);
    setBuildResults([]);
    setScanLog([]);
    setProgress(null);
    onScanStart?.();
    setLoading(true);

    const controller = new AbortController();
    startAbortRef.current = controller;

    try {
      const res = await fetch('/api/market/find/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ref_system: refSystem,
          radius,
          mode: searchMode,
          commodity: searchMode === 'single' ? commodity : undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (scanGenerationRef.current !== generation) return;
      if (!res.ok) throw new Error(data.error || 'Failed to start search');

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
          if (!stepRes.ok) throw new Error(stepData.error || 'Search step failed');

          if (stepData.progress) {
            setProgress({
              total: Number(stepData.progress.total) || scanSystems.length,
              scanned: Number(stepData.progress.scanned) || 0,
              found: Number(stepData.progress.found) || 0,
              current: String(stepData.progress.current || ''),
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
              // A result without a known position remains in the textual list,
              // but is rejected by the map marker layer instead of appearing
              // as a false stack at the galactic origin.
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
            if (searchMode === 'build') setBuildResults(results);
            else setSingleResults(results);
            finishCurrentSearch();
            toast(
              `Поиск завершён! Найдено ${results.length} станций`,
              results.length > 0 ? 'success' : 'info',
            );
          } else if (stepData.status === 'error') {
            finishCurrentSearch();
            throw new Error(stepData.error || 'Search failed');
          }
        } catch (error) {
          if (scanGenerationRef.current === generation) {
            finishCurrentSearch();
            console.error('Market-search polling error:', error);
            toast(error instanceof Error ? error.message : 'Ошибка сканирования', 'error');
          }
        } finally {
          requestInFlight = false;
        }
      };

      intervalRef.current = window.setInterval(() => { void poll(); }, 2000);
      void poll();
    } catch (error) {
      if (scanGenerationRef.current !== generation || (error instanceof DOMException && error.name === 'AbortError')) return;
      console.error('Market-search start error:', error);
      toast(error instanceof Error ? error.message : 'Не удалось начать поиск', 'error');
      clearPolling();
      if (startAbortRef.current === controller) startAbortRef.current = null;
      setLoading(false);
    }
  };

  const percent =
    progress && progress.total > 0
      ? Math.round((progress.scanned / progress.total) * 100)
      : 0;

  return (
    <div className="atlas-section">
      <h4>Поиск товаров для стройки</h4>

      <div className="atlas-search-field">
        <label>Reference System</label>
        <input
          value={refSystem}
          onChange={(e) => setRefSystem(e.target.value)}
          placeholder="Sol"
        />
      </div>

      <div className="atlas-search-field">
        <label>Режим поиска</label>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            onClick={() => setMode('single')}
            style={{
              flex: 1,
              padding: '6px 12px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: mode === 'single' ? '#e67e22' : 'transparent',
              color: mode === 'single' ? '#fff' : 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Один товар
          </button>
          <button
            onClick={() => setMode('build')}
            style={{
              flex: 1,
              padding: '6px 12px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: mode === 'build' ? '#e67e22' : 'transparent',
              color: mode === 'build' ? '#fff' : 'inherit',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Все для стройки
          </button>
        </div>
      </div>

      {mode === 'single' && (
        <div className="atlas-search-field">
          <label>Товар</label>
          <select
            value={commodity}
            onChange={(e) => setCommodity(e.target.value)}
            style={{ width: '100%' }}
          >
            {COMMODITIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="atlas-search-field">
        <label>Радиус поиска: {radius} св.лет</label>
        <input
          type="range"
          min={10}
          max={MAX_RADIUS}
          step={10}
          value={radius}
          onChange={(e) => setRadius(Number(e.target.value))}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button
          onClick={handleSearch}
          disabled={loading || !refSystem.trim()}
          className="atlas-scan-btn"
          style={{ flex: 1 }}
        >
          {loading
            ? 'Сканирование...'
            : mode === 'build'
            ? 'Найти все товары'
            : 'Найти товары'}
        </button>
        {loading && (
          <button
            onClick={stopSearch}
            style={{
              padding: '6px 16px',
              borderRadius: 4,
              border: '1px solid #e74c3c',
              background: '#1a1c1e',
              color: '#e74c3c',
              cursor: 'pointer',
              fontSize: 12,
            }}
          >
            Стоп
          </button>
        )}
      </div>

      {loading && progress && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 6,
            }}
          >
            <span style={{ fontSize: 12, color: '#e67e22', fontWeight: 600 }}>
              {progress.current
                ? `Сканирую: ${progress.current}`
                : 'Подготовка...'}
            </span>
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              {progress.scanned} / {progress.total} систем ({percent}%) ·{' '}
              {progress.found} станций
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: 8,
              background: '#1a1c1e',
              borderRadius: 4,
              overflow: 'hidden',
              border: '1px solid #2d2f33',
            }}
          >
            <div
              style={{
                height: '100%',
                width: `${percent}%`,
                background: 'linear-gradient(90deg, #e67e22, #f39c12)',
                borderRadius: 4,
                transition: 'width 0.5s ease',
                minWidth: 4,
              }}
            />
          </div>

          <div
            style={{
              marginTop: 8,
              padding: 8,
              background: '#0d0f11',
              borderRadius: 4,
              maxHeight: 160,
              overflowY: 'auto',
              fontSize: 11,
              fontFamily: 'ui-monospace, monospace',
              lineHeight: 1.6,
            }}
          >
            {scanLog.length === 0 && (
              <div style={{ color: '#666' }}>Ожидание сканирования...</div>
            )}
            {scanLog.map((entry, i) => (
              <div
                key={i}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  opacity: i === scanLog.length - 1 ? 1 : 0.5,
                  color:
                    entry.status === 'cached'
                      ? '#7ee787'
                      : entry.status === 'has_market'
                      ? '#e67e22'
                      : '#666',
                }}
              >
                <span>
                  {entry.status === 'cached' && <IconSave size={10} /> + ' '}
                  {entry.status === 'has_market' && <IconStore size={10} /> + ' '}
                  {entry.status === 'no_market' && <IconXCircle size={10} /> + ' '}
                  {entry.system}
                  {entry.status === 'has_market' && ` (${entry.stations} станций)`}
                </span>
                <span style={{ color: '#666', fontSize: 10 }}>
                  {entry.status === 'cached'
                    ? 'из кэша'
                    : entry.status === 'has_market'
                    ? 'рынок найден'
                    : 'нет рынка'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === 'build' && buildResults.length > 0 && !loading && (
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              marginBottom: 8,
              color: '#e67e22',
            }}
          >
            Станции с товарами для стройки ({buildResults.length})
          </div>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              maxHeight: 500,
              overflowY: 'auto',
            }}
          >
            {buildResults.map((r, i) => (
              <div
                key={i}
                style={{
                  padding: 12,
                  background: '#1a1c1e',
                  borderRadius: 6,
                  fontSize: 12,
                  borderLeft: '3px solid #e67e22',
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>
                    {r.station_name}{' '}
                    <span style={{ color: '#9ca3af', fontWeight: 400 }}>
                      @ {r.system_name}
                    </span>
                  </div>
                  <div
                    style={{ fontSize: 11, color: '#00bcd4', fontWeight: 600 }}
                  >
                    {r.commodities_found}/{r.commodities_total} товаров
                  </div>
                </div>
                <div
                  style={{ color: '#9ca3af', marginTop: 4, fontSize: 11 }}
                >
                  <IconMapPin size={10} /> {r.distance.toFixed(1)} св.лет · <IconRocket size={10} /> {r.landing_pad} ·{' '}
                  {r.station_type}
                </div>
                <div
                  style={{
                    marginTop: 8,
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                  }}
                >
                  {r.commodities.map((c) => (
                    <div
                      key={c.name}
                      style={{
                        padding: '3px 8px',
                        background: '#0d1f0d',
                        border: '1px solid #2d5a2d',
                        borderRadius: 3,
                        fontSize: 11,
                        color: '#7ee787',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 4,
                      }}
                    >
                      <span style={{ fontWeight: 600 }}>{c.name}</span>
                      <span style={{ color: '#9ca3af' }}>
                        {c.stock.toLocaleString('ru')} шт.
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {mode === 'single' && singleResults.length > 0 && !loading && (
        <div
          style={{
            marginTop: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
            maxHeight: 400,
            overflowY: 'auto',
          }}
        >
          {singleResults.map((r, i) => (
            <div
              key={i}
              style={{
                padding: 10,
                background: '#1a1c1e',
                borderRadius: 4,
                fontSize: 12,
                borderLeft: '3px solid #e67e22',
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13 }}>
                {r.station_name}{' '}
                <span style={{ color: '#9ca3af', fontWeight: 400 }}>
                  @ {r.system_name}
                </span>
              </div>
              <div
                style={{
                  color: 'var(--muted)',
                  marginTop: 4,
                  display: 'flex',
                  gap: 12,
                  flexWrap: 'wrap',
                }}
              >
                <span><IconPackage size={10} /> {r.stock?.toLocaleString('ru') || '?'} шт.</span>
                <span><IconCoins size={10} /> {r.sell_price?.toLocaleString('ru') || '?'} CR</span>
                <span><IconMapPin size={10} /> {r.distance?.toFixed(1) || '?'} св.лет</span>
                <span><IconRocket size={10} /> Площадка: {r.landing_pad}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {((mode === 'build' && buildResults.length === 0) ||
        (mode === 'single' && singleResults.length === 0)) &&
        !loading && (
          <div
            style={{
              marginTop: 12,
              fontSize: 12,
              color: '#9ca3af',
              textAlign: 'center',
            }}
          >
            {mode === 'build'
              ? 'Нажмите «Найти все товары» для поиска станций с товарами для стройки'
              : 'Нажмите «Найти товары» для поиска станций'}
          </div>
        )}
    </div>
  );
}
