'use client';

import { useState, useRef, useCallback } from 'react';
import { toast } from '@/components/ui/Toaster';

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

interface AtlasMarketSearchProps {
  onScanUpdate?: (systems: Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>) => void;
}

export default function AtlasMarketSearch({ onScanUpdate }: AtlasMarketSearchProps) {
  const [refSystem, setRefSystem] = useState('Sol');
  const [commodity, setCommodity] = useState('Steel');
  const [radius, setRadius] = useState(50);
  const [mode, setMode] = useState<'single' | 'build'>('single');
  const [singleResults, setSingleResults] = useState<SingleResult[]>([]);
  const [buildResults, setBuildResults] = useState<StationBuildResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<SearchProgress | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [scanLog, setScanLog] = useState<ScanLogEntry[]>([]);
  const [systemsList, setSystemsList] = useState<Array<{ name: string; distance: number; x: number; y: number; z: number }>>([]);
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const stopSearch = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setLoading(false);
  }, []);

  const handleSearch = async () => {
    stopSearch();
    setSingleResults([]);
    setBuildResults([]);
    setScanLog([]);
    setProgress(null);
    setJobId(null);
    setLoading(true);

    try {
      const res = await fetch('/api/market/find/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ref_system: refSystem,
          radius,
          mode,
          commodity: mode === 'single' ? commodity : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start search');

      setJobId(data.job_id);
      setSystemsList(data.systems_list || []);
      setProgress({
        total: data.total_systems,
        scanned: 0,
        found: 0,
        current: '',
      });

      intervalRef.current = setInterval(async () => {
        try {
          const stepRes = await fetch('/api/market/find/step', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ job_id: data.job_id }),
          });
          const stepData = await stepRes.json();
          if (!stepRes.ok) {
            console.error('Step error:', stepData.error);
            return;
          }

          setProgress({
            total: stepData.progress.total,
            scanned: stepData.progress.scanned,
            found: stepData.progress.found,
            current: stepData.progress.current,
          });

          if (stepData.scan_log) {
            setScanLog(stepData.scan_log);
            if (onScanUpdate && systemsList.length > 0) {
              const updated = stepData.scan_log.map((entry: ScanLogEntry) => {
                const sys = systemsList.find((s) => s.name === entry.system);
                return {
                  system_name: entry.system,
                  status: entry.status,
                  x: sys?.x,
                  y: sys?.y,
                  z: sys?.z,
                };
              });
              onScanUpdate(updated);
            }
          }

          if (stepData.is_done) {
            stopSearch();
            if (mode === 'build') {
              setBuildResults(stepData.result || []);
              toast(
                `Поиск завершён! Найдено ${stepData.result?.length || 0} станций`,
                stepData.result?.length > 0 ? 'success' : 'info'
              );
            } else {
              setSingleResults(stepData.result || []);
              toast(
                `Поиск завершён! Найдено ${stepData.result?.length || 0} станций`,
                stepData.result?.length > 0 ? 'success' : 'info'
              );
            }
          }
        } catch (e: any) {
          console.error('Polling error:', e);
        }
      }, 2000);
    } catch (e: any) {
      toast(e.message, 'error');
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
                  {entry.status === 'cached' && '💾 '}
                  {entry.status === 'has_market' && '🏪 '}
                  {entry.status === 'no_market' && '❌ '}
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
                  📍 {r.distance.toFixed(1)} св.лет · 🚀 {r.landing_pad} ·{' '}
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
                <span>📦 {r.stock?.toLocaleString('ru') || '?'} шт.</span>
                <span>💰 {r.sell_price?.toLocaleString('ru') || '?'} CR</span>
                <span>📍 {r.distance?.toFixed(1) || '?'} св.лет</span>
                <span>🚀 Площадка: {r.landing_pad}</span>
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
