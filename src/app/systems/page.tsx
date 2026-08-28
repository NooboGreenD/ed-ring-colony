'use client';
import { useEffect, useMemo, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Toaster, toast } from '@/components/ui/Toaster';

type Resource = { name: string; key?: string; required: number; provided: number; remaining?: number };
type Project = {
  buildId: string;
  buildName: string;
  buildType: string | null;
  complete: boolean;
  progress: number;
  sumNeed: number;
  sumTotal: number;
  architectName: string | null;
  bodyName: string | null;
  resources: Resource[];
};
type DeliveryStat = { system_name: string; total_delivered: number; unique_cmdrs: number; top_commodity: string };
type ProgressRow = {
  system_name: string;
  hub_name?: string;
  status?: string;
  progress: number | null;
  updated_at: string | null;
  found?: boolean;
  error?: string;
  data: {
    siteName?: string | null;
    architectName?: string | null;
    projects?: Project[];
    resources?: Resource[];
  } | null;
};

/* ── EDSM Types ── */
type EdsmSystem = {
  id: number;
  name: string;
  coords: { x: number; y: number; z: number } | null;
  distance: number | null;
  bodyCount: number | null;
  requirePermit: boolean;
  permitName: string | null;
};

type EdsmStar = {
  id: number;
  name: string;
  bodyId: number;
  type: string;
  subType: string;
  spectralClass?: string;
  luminosity?: string;
  absoluteMagnitude?: number;
  solarMasses?: number;
  solarRadius?: number;
  age?: number;
  surfaceTemperature?: number;
  distanceToArrival?: number;
  belts?: any[];
  parents?: any[];
};

type EdsmPlanet = {
  id: number;
  name: string;
  bodyId: number;
  type: string;
  subType: string;
  distanceToArrival?: number;
  isLandable?: boolean;
  gravity?: number;
  earthMasses?: number;
  radius?: number;
  surfaceTemperature?: number;
  surfacePressure?: number;
  volcanismType?: string;
  atmosphereType?: string;
  atmosphereComposition?: Record<string, number>;
  solidComposition?: Record<string, number>;
  terraformingState?: string;
  orbitalPeriod?: number;
  semiMajorAxis?: number;
  orbitalEccentricity?: number;
  orbitalInclination?: number;
  argOfPeriapsis?: number;
  rotationalPeriod?: number;
  rotationalPeriodTidallyLocked?: boolean;
  axialTilt?: number;
  materials?: Record<string, number>;
  rings?: any[];
  reserveLevel?: string;
  parents?: any[];
};

type EdsmSystemDetail = {
  name: string;
  id: number;
  id64: number | null;
  coords: { x: number; y: number; z: number } | null;
  distanceToSol: number | null;
  bodyCount: number | null;
  requirePermit: boolean;
  permitName: string | null;
  information: any;
  primaryStar: any;
  stars: EdsmStar[];
  planets: EdsmPlanet[];
  edsmUrl: string;
};

type Tab = 'hubs' | 'route' | 'deliveries' | 'search';

/* ── Body grouping helpers ── */
function sortByArrival<T extends { distanceToArrival?: number }>(arr: T[]): T[] {
  return [...arr].sort((a, b) => (a.distanceToArrival ?? Infinity) - (b.distanceToArrival ?? Infinity));
}

function groupPlanetsByType(planets: EdsmPlanet[]): Record<string, EdsmPlanet[]> {
  const groups: Record<string, EdsmPlanet[]> = {};
  for (const p of planets) {
    const key = p.subType || 'Unknown';
    if (!groups[key]) groups[key] = [];
    groups[key].push(p);
  }
  // Sort each group by distance
  for (const k of Object.keys(groups)) {
    groups[k] = sortByArrival(groups[k]);
  }
  return groups;
}

function planetTypeColor(subType: string): string {
  const map: Record<string, string> = {
    'Earth-like world': '#22c55e',
    'Water world': '#3b82f6',
    'Ammonia world': '#a855f7',
    'Gas giant': '#e67e22',
    'Class I gas giant': '#f39c12',
    'Class II gas giant': '#f39c12',
    'Class III gas giant': '#d35400',
    'Class IV gas giant': '#d35400',
    'Class V gas giant': '#d35400',
    'Helium rich gas giant': '#e74c3c',
    'Helium gas giant': '#e74c3c',
    'High metal content world': '#60a5fa',
    'Metal-rich body': '#fbbf24',
    'Rocky body': '#9ca3af',
    'Rocky ice world': '#93c5fd',
    'Icy body': '#bfdbfe',
    'Ice world': '#bfdbfe',
  };
  for (const [k, v] of Object.entries(map)) {
    if (subType.toLowerCase().includes(k.toLowerCase())) return v;
  }
  return '#9ca3af';
}

function bodyStats(planets: EdsmPlanet[]) {
  const landable = planets.filter((p) => p.isLandable).length;
  const withRings = planets.filter((p) => p.rings && p.rings.length > 0).length;
  const withAtmo = planets.filter((p) => p.atmosphereType && p.atmosphereType !== 'No atmosphere').length;
  const terraformable = planets.filter((p) => p.terraformingState && p.terraformingState !== 'Not terraformable').length;
  return { landable, withRings, withAtmo, terraformable };
}

function PlanetCard({ planet }: { planet: EdsmPlanet }) {
  const [expanded, setExpanded] = useState(false);
  const color = planetTypeColor(planet.subType);

  return (
    <div style={{
      background: '#1e2124',
      border: '1px solid #2d3033',
      borderLeft: `3px solid ${color}`,
      borderRadius: 6,
      padding: '10px 12px',
    }}>
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
          cursor: 'pointer',
        }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 600, color: '#eeeeee', fontSize: 13 }}>{planet.name}</span>
          {planet.isLandable && (
            <span style={{
              fontSize: 10, color: '#22c55e',
              background: 'rgba(34,197,94,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              🚀 Пригодна
            </span>
          )}
          {planet.rings && planet.rings.length > 0 && (
            <span style={{
              fontSize: 10, color: '#fbbf24',
              background: 'rgba(251,191,36,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              💍 Кольца
            </span>
          )}
          {planet.terraformingState && planet.terraformingState !== 'Not terraformable' && (
            <span style={{
              fontSize: 10, color: '#3b82f6',
              background: 'rgba(59,130,246,0.12)',
              padding: '1px 6px', borderRadius: 4,
            }}>
              🌍 {planet.terraformingState}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
            {planet.distanceToArrival != null ? `${planet.distanceToArrival.toFixed(1)} св.с.` : '—'}
          </span>
          <span style={{ fontSize: 11, color: '#6b7280' }}>{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      {/* Quick stats row (always visible) */}
      <div style={{
        display: 'flex',
        gap: 16,
        marginTop: 6,
        flexWrap: 'wrap',
        fontSize: 11,
        color: '#9ca3af',
      }}>
        {planet.gravity != null && (
          <span>g: <strong style={{ color: '#eeeeee' }}>{planet.gravity.toFixed(2)}</strong></span>
        )}
        {planet.surfaceTemperature != null && (
          <span>Т: <strong style={{ color: '#eeeeee' }}>{planet.surfaceTemperature.toFixed(0)} K</strong></span>
        )}
        {planet.earthMasses != null && (
          <span>М: <strong style={{ color: '#eeeeee' }}>{planet.earthMasses.toFixed(3)} M⊕</strong></span>
        )}
        {planet.radius != null && (
          <span>R: <strong style={{ color: '#eeeeee' }}>{planet.radius.toFixed(0)} км</strong></span>
        )}
        {planet.atmosphereType && planet.atmosphereType !== 'No atmosphere' && (
          <span>Атм: <strong style={{ color: '#eeeeee' }}>{planet.atmosphereType}</strong></span>
        )}
      </div>

      {/* Expanded details */}
      {expanded && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid #2d3033' }}>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
            gap: '4px 16px',
            fontSize: 12,
          }}>
            {planet.earthMasses != null && (
              <><span style={{ color: '#6b7280' }}>Масса:</span><span style={{ color: '#eeeeee' }}>{planet.earthMasses.toFixed(4)} M⊕</span></>
            )}
            {planet.radius != null && (
              <><span style={{ color: '#6b7280' }}>Радиус:</span><span style={{ color: '#eeeeee' }}>{planet.radius.toFixed(1)} км</span></>
            )}
            {planet.gravity != null && (
              <><span style={{ color: '#6b7280' }}>Гравитация:</span><span style={{ color: '#eeeeee' }}>{planet.gravity.toFixed(2)} g</span></>
            )}
            {planet.surfaceTemperature != null && (
              <><span style={{ color: '#6b7280' }}>Температура:</span><span style={{ color: '#eeeeee' }}>{planet.surfaceTemperature.toFixed(1)} K</span></>
            )}
            {planet.surfacePressure != null && (
              <><span style={{ color: '#6b7280' }}>Давление:</span><span style={{ color: '#eeeeee' }}>{planet.surfacePressure.toFixed(2)} атм.</span></>
            )}
            {planet.distanceToArrival != null && (
              <><span style={{ color: '#6b7280' }}>До входа:</span><span style={{ color: '#eeeeee' }}>{planet.distanceToArrival.toFixed(1)} св.с.</span></>
            )}
            {planet.orbitalPeriod != null && (
              <><span style={{ color: '#6b7280' }}>Орбитальный период:</span><span style={{ color: '#eeeeee' }}>{planet.orbitalPeriod.toFixed(2)} д</span></>
            )}
            {planet.semiMajorAxis != null && (
              <><span style={{ color: '#6b7280' }}>Большая полуось:</span><span style={{ color: '#eeeeee' }}>{(planet.semiMajorAxis / 149597870.7).toFixed(3)} а.е.</span></>
            )}
            {planet.orbitalEccentricity != null && (
              <><span style={{ color: '#6b7280' }}>Эксцентриситет:</span><span style={{ color: '#eeeeee' }}>{planet.orbitalEccentricity.toFixed(4)}</span></>
            )}
            {planet.orbitalInclination != null && (
              <><span style={{ color: '#6b7280' }}>Наклонение:</span><span style={{ color: '#eeeeee' }}>{planet.orbitalInclination.toFixed(2)}°</span></>
            )}
            {planet.rotationalPeriod != null && (
              <><span style={{ color: '#6b7280' }}>Период вращения:</span><span style={{ color: '#eeeeee' }}>{planet.rotationalPeriod.toFixed(2)} д {planet.rotationalPeriodTidallyLocked ? '(захвачена)' : ''}</span></>
            )}
            {planet.axialTilt != null && (
              <><span style={{ color: '#6b7280' }}>Наклон оси:</span><span style={{ color: '#eeeeee' }}>{planet.axialTilt.toFixed(2)}°</span></>
            )}
          </div>

          {planet.atmosphereType && planet.atmosphereType !== 'No atmosphere' && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Атмосфера: </span>
              <span style={{ fontSize: 12, color: '#eeeeee' }}>{planet.atmosphereType}</span>
              {planet.atmosphereComposition && (
                <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                  {Object.entries(planet.atmosphereComposition)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
                    .join(', ')}
                </div>
              )}
            </div>
          )}

          {planet.volcanismType && planet.volcanismType !== 'No volcanism' && (
            <div style={{ marginTop: 6 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Вулканизм: </span>
              <span style={{ fontSize: 12, color: '#e74c3c' }}>{planet.volcanismType}</span>
            </div>
          )}

          {planet.materials && Object.keys(planet.materials).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Материалы: </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px 10px', marginTop: 2 }}>
                {Object.entries(planet.materials)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <span key={k} style={{ fontSize: 11, color: '#9ca3af' }}>
                      {k} <strong style={{ color: '#eeeeee' }}>{(v * 100).toFixed(1)}%</strong>
                    </span>
                  ))}
              </div>
            </div>
          )}

          {planet.rings && planet.rings.length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Кольца: </span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                {planet.rings.map((ring: any, i: number) => (
                  <span key={i} style={{
                    fontSize: 11,
                    color: '#fbbf24',
                    background: 'rgba(251,191,36,0.1)',
                    padding: '2px 8px',
                    borderRadius: 4,
                  }}>
                    {ring.name}
                  </span>
                ))}
              </div>
            </div>
          )}

          {planet.solidComposition && Object.keys(planet.solidComposition).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 11, color: '#6b7280' }}>Состав: </span>
              <span style={{ fontSize: 11, color: '#9ca3af' }}>
                {Object.entries(planet.solidComposition)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => `${k} ${(v * 100).toFixed(1)}%`)
                  .join(', ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function SystemsPage() {
  const [tab, setTab] = useState<Tab>('search');
  const [hubs, setHubs] = useState<{ system_name: string; name: string; status: string }[]>([]);
  const [current, setCurrent] = useState('');
  const [info, setInfo] = useState<ProgressRow | null>(null);
  const [hubRows, setHubRows] = useState<ProgressRow[]>([]);
  const [routeRows, setRouteRows] = useState<ProgressRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingHubs, setLoadingHubs] = useState(false);
  const [loadingRoute, setLoadingRoute] = useState(false);
  const [routeQuery, setRouteQuery] = useState('');
  const [deliveryStats, setDeliveryStats] = useState<DeliveryStat[]>([]);
  const [loadingDeliveries, setLoadingDeliveries] = useState(false);

  /* ── EDSM Search State ── */
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<EdsmSystem[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedSystem, setSelectedSystem] = useState<EdsmSystemDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchHistory, setSearchHistory] = useState<string[]>([]);

  useEffect(() => {
    const loadHubs = async () => {
      const { data } = await supabase
        .from('hubs')
        .select('system_name,name,status')
        .order('segment_order');
      setHubs(data ?? []);
    };
    loadHubs();
  }, []);

  useEffect(() => {
    setLoadingHubs(true);
    fetch('/api/systems/progress')
      .then((r) => r.json())
      .then((json) => setHubRows(Array.isArray(json.systems) ? json.systems : []))
      .catch(() => setHubRows([]))
      .finally(() => setLoadingHubs(false));
  }, []);

  useEffect(() => {
    setLoadingRoute(true);
    fetch('/api/systems/progress?scope=route')
      .then((r) => r.json())
      .then((json) => setRouteRows(Array.isArray(json.systems) ? json.systems : []))
      .catch(() => setRouteRows([]))
      .finally(() => setLoadingRoute(false));
  }, []);

  useEffect(() => {
    const loadStats = async () => {
      setLoadingDeliveries(true);
      try {
        const { data, error } = await supabase.rpc('get_route_delivery_stats');
        if (!error && Array.isArray(data)) setDeliveryStats(data);
        else setDeliveryStats([]);
      } catch {
        setDeliveryStats([]);
      } finally {
        setLoadingDeliveries(false);
      }
    };
    loadStats();
  }, []);

  const listRows = tab === 'hubs' ? hubRows : routeRows;

  useEffect(() => {
    if (!current) {
      setInfo(null);
      return;
    }
    const cached = listRows.find((r) => r.system_name === current);
    if (cached) setInfo(cached);
    setLoading(true);
    fetch('/api/systems/progress?name=' + encodeURIComponent(current))
      .then((r) => r.json())
      .then((data) => setInfo(data))
      .catch(() => setInfo(null))
      .finally(() => setLoading(false));
  }, [current, listRows]);

  const resources: Resource[] = Array.isArray(info?.data?.resources) ? info!.data!.resources! : [];
  const projects: Project[] = Array.isArray(info?.data?.projects) ? info!.data!.projects! : [];
  const pct = (r: Resource) => {
    if (typeof r.remaining === 'number' && r.required > 0) {
      return Math.min(100, Math.round(((r.required - r.remaining) / r.required) * 100));
    }
    return r.required > 0 ? Math.min(100, Math.round((r.provided / r.required) * 100)) : 0;
  };

  const bySystem = useMemo(() => {
    const m = new Map<string, ProgressRow>();
    for (const r of listRows) m.set(r.system_name, r);
    return m;
  }, [listRows]);

  const filteredRoute = useMemo(() => {
    const q = routeQuery.trim().toLowerCase();
    if (!q) return routeRows;
    return routeRows.filter((r) => r.system_name.toLowerCase().includes(q));
  }, [routeRows, routeQuery]);

  const routeStats = useMemo(() => {
    const withPct = routeRows.filter((r) => r.progress != null);
    const avg =
      withPct.length > 0
        ? Math.round(
            (withPct.reduce((s, r) => s + (r.progress ?? 0), 0) / withPct.length) * 10,
          ) / 10
        : null;
    const done = withPct.filter((r) => (r.progress ?? 0) >= 100).length;
    return { avg, done, known: withPct.length };
  }, [routeRows]);

  const switchTab = (next: Tab) => {
    setTab(next);
    setCurrent('');
    setInfo(null);
  };

  /* ── EDSM Search ── */
  const doSearch = useCallback(async () => {
    const q = searchQuery.trim();
    if (!q || q.length < 2) {
      toast?.('Введите минимум 2 символа', 'error');
      return;
    }
    setSearchLoading(true);
    setSelectedSystem(null);
    try {
      const res = await fetch(`/api/edsm/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (!res.ok) {
        toast?.(data.error || 'Ошибка поиска', 'error');
        setSearchResults([]);
        return;
      }
      setSearchResults(data.systems || []);
      setSearchHistory((prev) => {
        const next = [q, ...prev.filter((h) => h !== q)].slice(0, 10);
        return next;
      });
    } catch (err: any) {
      toast?.(err.message || 'Ошибка поиска', 'error');
    } finally {
      setSearchLoading(false);
    }
  }, [searchQuery]);

  const loadSystemDetail = useCallback(async (name: string) => {
    console.log('[SystemDetail] Loading:', name);
    setDetailLoading(true);
    setSelectedSystem(null);
    try {
      const url = `/api/edsm/system?name=${encodeURIComponent(name)}`;
      console.log('[SystemDetail] Fetch:', url);
      const res = await fetch(url);
      console.log('[SystemDetail] Response status:', res.status);
      const data = await res.json();
      console.log('[SystemDetail] Response data keys:', data ? Object.keys(data) : 'null');
      if (!res.ok) {
        const msg = data.error || `Ошибка загрузки системы (HTTP ${res.status})`;
        console.error('[SystemDetail] API error:', msg);
        toast(msg, 'error');
        // Fallback: show basic info from search results
        const basic = searchResults.find((s) => s.name === name);
        if (basic) {
          setSelectedSystem({
            name: basic.name,
            id: basic.id,
            id64: null,
            coords: basic.coords,
            distanceToSol: basic.distance ?? null,
            bodyCount: basic.bodyCount,
            requirePermit: basic.requirePermit,
            permitName: basic.permitName,
            information: null,
            primaryStar: null,
            stars: [],
            planets: [],
            edsmUrl: `https://www.edsm.net/en/system/id/${basic.id}/name/${encodeURIComponent(basic.name)}`,
          } as EdsmSystemDetail);
        }
        return;
      }
      setSelectedSystem(data);
      console.log('[SystemDetail] Loaded successfully:', data.name);
    } catch (err: any) {
      console.error('[SystemDetail] Fetch error:', err);
      toast(err.message || 'Ошибка загрузки', 'error');
      // Fallback: show basic info from search results
      const basic = searchResults.find((s) => s.name === name);
      if (basic) {
        setSelectedSystem({
          name: basic.name,
          id: basic.id,
          id64: null,
          coords: basic.coords,
          distanceToSol: basic.distance ?? null,
          bodyCount: basic.bodyCount,
          requirePermit: basic.requirePermit,
          permitName: basic.permitName,
          information: null,
          primaryStar: null,
          stars: [],
          planets: [],
          edsmUrl: `https://www.edsm.net/en/system/id/${basic.id}/name/${encodeURIComponent(basic.name)}`,
        } as EdsmSystemDetail);
      }
    } finally {
      setDetailLoading(false);
    }
  }, [searchResults]);

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') doSearch();
  };

  return (
    <main className="card" style={{ width: "100%" }}>
      <Toaster />
      <h1>Прогресс систем</h1>
      <p style={{ color: '#9ca3af', fontSize: 14 }}>
        Данные строительства подтягиваются с{' '}
        <a href="https://ravencolonial.com" target="_blank" rel="noreferrer" style={{ color: '#e67e22' }}>
          Raven Colonial
        </a>
        . Поиск систем работает через{' '}
        <a href="https://www.edsm.net" target="_blank" rel="noreferrer" style={{ color: '#e67e22' }}>
          EDSM
        </a>
        . Нужно, чтобы стройка системы была заведена на их сайте (SrvSurvey / EDMC).
      </p>

      <div className="tabs">
        <button className={tab === 'search' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('search')}>
          🔍 Поиск систем
        </button>
        <button className={tab === 'hubs' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('hubs')}>
          Хабы
        </button>
        <button className={tab === 'route' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('route')}>
          Маршрут ({routeRows.length})
        </button>
        <button className={tab === 'deliveries' ? 'tab tab-active' : 'tab'} onClick={() => switchTab('deliveries')}>
          Доставки
        </button>
      </div>

      {/* ═══════════════════════════════════════════════════════════
          TAB: EDSM Search
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'search' && (
        <div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
            <input
              style={{ flex: 1, minWidth: 200 }}
              placeholder="Введите название системы (например, Sol, Colonia, Sagittarius A*)"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
            />
            <button
              onClick={doSearch}
              disabled={searchLoading || searchQuery.trim().length < 2}
              className="btn btn-cyan"
            >
              {searchLoading ? 'Поиск...' : 'Найти'}
            </button>
          </div>

          {searchHistory.length > 0 && (
            <div style={{ marginBottom: 12, display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span style={{ fontSize: 12, color: '#6b7280' }}>История:</span>
              {searchHistory.map((h) => (
                <button
                  key={h}
                  onClick={() => { setSearchQuery(h); }}
                  style={{
                    fontSize: 11,
                    padding: '3px 10px',
                    background: '#2d3033',
                    border: '1px solid #3a3d40',
                    borderRadius: 4,
                    color: '#9ca3af',
                    cursor: 'pointer',
                  }}
                >
                  {h}
                </button>
              ))}
            </div>
          )}

          {/* Результаты поиска */}
          {searchResults.length > 0 && !selectedSystem && (
            <div className="table-scroll" style={{ marginBottom: 20 }}>
              <table>
                <thead>
                  <tr>
                    <th>Система</th>
                    <th>Координаты</th>
                    <th>До Sol</th>
                    <th>Тел</th>
                    <th>Пермит</th>
                  </tr>
                </thead>
                <tbody>
                  {searchResults.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => loadSystemDetail(s.name)}
                      style={{ cursor: 'pointer' }}
                    >
                      <td>
                        <span style={{ color: '#eeeeee', fontWeight: 600 }}>{s.name}</span>
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                        {s.coords
                          ? `${s.coords.x.toFixed(2)}, ${s.coords.y.toFixed(2)}, ${s.coords.z.toFixed(2)}`
                          : '—'}
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12 }}>
                        {s.distance != null ? `${s.distance.toFixed(2)} св.г.` : '—'}
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        {s.bodyCount ?? '—'}
                      </td>
                      <td>
                        {s.requirePermit ? (
                          <span style={{ color: '#e74c3c', fontSize: 12 }}>⚠ {s.permitName || 'Требуется'}</span>
                        ) : (
                          <span style={{ color: '#22c55e', fontSize: 12 }}>✓ Нет</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p style={{ fontSize: 12, color: '#6b7280', marginTop: 8 }}>
                Найдено {searchResults.length} систем. Кликните по строке для детальной информации.
              </p>
            </div>
          )}

          {searchResults.length === 0 && !searchLoading && searchQuery.trim().length >= 2 && (
            <p style={{ color: '#9ca3af' }}>Системы не найдены. Попробуйте изменить запрос.</p>
          )}

          {/* Детальная карточка системы */}
          {detailLoading && (
            <div style={{ padding: 40, textAlign: 'center', color: '#9ca3af' }}>
              <div style={{
                width: 32, height: 32,
                border: '3px solid #3a3d40',
                borderTop: '3px solid #e67e22',
                borderRadius: '50%',
                animation: 'spin 1s linear infinite',
                margin: '0 auto 12px',
              }} />
              Загрузка данных системы из EDSM...
            </div>
          )}

          {selectedSystem && (
            <div>
              {/* Навигация назад */}
              <button
                onClick={() => setSelectedSystem(null)}
                style={{ fontSize: 12, marginBottom: 12, color: '#9ca3af', background: 'none', border: 'none', cursor: 'pointer' }}
              >
                ← Назад к результатам
              </button>

              {/* Заголовок системы */}
              <div style={{
                background: '#1e2124',
                border: '1px solid #2d3033',
                borderRadius: 8,
                padding: 16,
                marginBottom: 16,
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12 }}>
                  <div>
                    <h2 style={{ margin: 0, color: '#eeeeee', fontSize: 22 }}>{selectedSystem.name}</h2>
                    <div style={{ display: 'flex', gap: 16, marginTop: 8, flexWrap: 'wrap' }}>
                      {selectedSystem.coords && (
                        <span style={{ fontSize: 12, color: '#9ca3af', fontFamily: 'ui-monospace, monospace' }}>
                          📍 {selectedSystem.coords.x.toFixed(2)}, {selectedSystem.coords.y.toFixed(2)}, {selectedSystem.coords.z.toFixed(2)}
                        </span>
                      )}
                      {selectedSystem.distanceToSol != null && (
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          ☉ До Sol: <strong style={{ color: '#e67e22' }}>{selectedSystem.distanceToSol.toLocaleString('ru')} св.г.</strong>
                        </span>
                      )}
                      {selectedSystem.bodyCount != null && (
                        <span style={{ fontSize: 12, color: '#9ca3af' }}>
                          🪐 Тел: <strong style={{ color: '#eeeeee' }}>{selectedSystem.bodyCount}</strong>
                        </span>
                      )}
                      {selectedSystem.requirePermit && (
                        <span style={{ fontSize: 12, color: '#e74c3c' }}>
                          🔒 Пермит: {selectedSystem.permitName || 'Требуется'}
                        </span>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    <a
                      href={selectedSystem.edsmUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-cyan"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      EDSM ↗
                    </a>
                    <a
                      href={`https://ravencolonial.com/#sys=${encodeURIComponent(selectedSystem.name)}`}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-orange"
                      style={{ fontSize: 11, padding: '6px 14px' }}
                    >
                      RavenColonial ↗
                    </a>
                  </div>
                </div>
              </div>

              {/* ── System Summary ── */}
              {(selectedSystem.stars.length > 0 || selectedSystem.planets.length > 0) && (
                <div style={{
                  background: '#1e2124',
                  border: '1px solid #2d3033',
                  borderRadius: 8,
                  padding: 14,
                  marginBottom: 16,
                  display: 'flex',
                  gap: 16,
                  flexWrap: 'wrap',
                }}>
                  <div style={{ textAlign: 'center', minWidth: 80 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#f39c12' }}>{selectedSystem.stars.length}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Звёзд</div>
                  </div>
                  <div style={{ textAlign: 'center', minWidth: 80 }}>
                    <div style={{ fontSize: 20, fontWeight: 700, color: '#60a5fa' }}>{selectedSystem.planets.length}</div>
                    <div style={{ fontSize: 11, color: '#9ca3af' }}>Планет/тел</div>
                  </div>
                  {(() => {
                    const stats = bodyStats(selectedSystem.planets);
                    return (
                      <>
                        {stats.landable > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#22c55e' }}>{stats.landable}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>Пригодных</div>
                          </div>
                        )}
                        {stats.withAtmo > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#a855f7' }}>{stats.withAtmo}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>С атмосферой</div>
                          </div>
                        )}
                        {stats.withRings > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#fbbf24' }}>{stats.withRings}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>С кольцами</div>
                          </div>
                        )}
                        {stats.terraformable > 0 && (
                          <div style={{ textAlign: 'center', minWidth: 80 }}>
                            <div style={{ fontSize: 20, fontWeight: 700, color: '#3b82f6' }}>{stats.terraformable}</div>
                            <div style={{ fontSize: 11, color: '#9ca3af' }}>Терраформ.</div>
                          </div>
                        )}
                      </>
                    );
                  })()}
                </div>
              )}

              {/* ── Stars Table ── */}
              {selectedSystem.stars.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', color: '#f39c12', margin: '0 0 10px 0' }}>
                    ★ Звёзды ({selectedSystem.stars.length})
                  </h3>
                  <div className="table-scroll">
                    <table style={{ fontSize: 12 }}>
                      <thead>
                        <tr>
                          <th>Название</th>
                          <th>Класс</th>
                          <th>Масса M☉</th>
                          <th>Радиус R☉</th>
                          <th>Темп. K</th>
                          <th>Возраст</th>
                          <th>До входа</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sortByArrival(selectedSystem.stars).map((star) => (
                          <tr key={star.id}>
                            <td style={{ fontWeight: 600, color: '#eeeeee' }}>{star.name}</td>
                            <td>
                              <span style={{
                                color: '#f39c12',
                                background: 'rgba(243,156,18,0.12)',
                                padding: '2px 6px',
                                borderRadius: 4,
                                fontSize: 11,
                              }}>
                                {star.spectralClass || '—'}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.solarMasses?.toFixed(3) ?? '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.solarRadius?.toFixed(3) ?? '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.surfaceTemperature?.toLocaleString('ru') ?? '—'}</td>
                            <td>{star.age != null ? `${star.age.toFixed(1)} млрд` : '—'}</td>
                            <td style={{ fontFamily: 'ui-monospace, monospace' }}>{star.distanceToArrival?.toFixed(1) ?? '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── Planets by Type ── */}
              {selectedSystem.planets.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <h3 style={{ fontSize: 13, letterSpacing: 1, textTransform: 'uppercase', color: '#60a5fa', margin: '0 0 10px 0' }}>
                    🪐 Планеты и тела ({selectedSystem.planets.length})
                  </h3>
                  {(() => {
                    const groups = groupPlanetsByType(selectedSystem.planets);
                    const groupKeys = Object.keys(groups).sort();
                    return (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                        {groupKeys.map((typeName) => {
                          const planets = groups[typeName];
                          const color = planetTypeColor(typeName);
                          return (
                            <div key={typeName}>
                              <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                marginBottom: 8,
                              }}>
                                <span style={{
                                  width: 10, height: 10, borderRadius: '50%',
                                  background: color,
                                  display: 'inline-block',
                                }} />
                                <span style={{ fontSize: 12, fontWeight: 600, color: '#eeeeee' }}>
                                  {typeName}
                                </span>
                                <span style={{ fontSize: 11, color: '#6b7280' }}>({planets.length})</span>
                              </div>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                                {planets.map((planet) => (
                                  <PlanetCard key={planet.id} planet={planet} />
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })()}
                </div>
              )}

              {selectedSystem.stars.length === 0 && selectedSystem.planets.length === 0 && (
                <p style={{ color: '#9ca3af', textAlign: 'center', padding: 20 }}>
                  Данные о телах в системе отсутствуют в EDSM.
                </p>
              )}
            </div>
          )}
        </div>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Hubs
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'hubs' && (
        <>
          {loadingHubs && <p>Загрузка списка хабов...</p>}
          {hubs.length > 0 && (
            <table>
              <thead>
                <tr>
                  <th>Хаб</th>
                  <th>Система</th>
                  <th>Статус</th>
                  <th>Прогресс</th>
                </tr>
              </thead>
              <tbody>
                {hubs.map((h) => {
                  const row = bySystem.get(h.system_name);
                  const p = row?.progress;
                  return (
                    <tr
                      key={h.system_name}
                      onClick={() => setCurrent(h.system_name)}
                      style={{
                        cursor: 'pointer',
                        background: current === h.system_name ? 'rgba(255,157,46,0.12)' : undefined,
                      }}
                    >
                      <td>{h.name}</td>
                      <td>
                        <a
                          href={`https://ravencolonial.com/#sys=${encodeURIComponent(h.system_name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#e67e22", textDecoration: "none" }}
                          title="Открыть в RavenColonial"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {h.system_name} ↗
                        </a>
                      </td>
                      <td>{h.status}</td>
                      <td>{p == null ? (row && !row.found ? 'нет данных' : '…') : p + '%'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          <select value={current} onChange={(e) => setCurrent(e.target.value)} style={{ marginTop: 16 }}>
            <option value="">— выберите систему —</option>
            {hubs.map((h) => (
              <option key={h.system_name} value={h.system_name}>
                {h.name} ({h.system_name})
              </option>
            ))}
          </select>
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Route
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'route' && (
        <>
          <p style={{ color: '#9ca3af', fontSize: 14 }}>
            Все системы маршрута без хабов. Процент в таблице — кэш (обновляется кроном каждые
            30 мин). Клик по строке подтягивает свежие данные с Raven Colonial.
          </p>
          {loadingRoute && <p>Загрузка списка маршрута...</p>}
          <p style={{ color: '#9ca3af', fontSize: 13 }}>
            Всего: {routeRows.length}
            {routeStats.known > 0 ? ` · с данными: ${routeStats.known}` : ''}
            {routeStats.done > 0 ? ` · готово: ${routeStats.done}` : ''}
            {routeStats.avg != null ? ` · средний прогресс: ${routeStats.avg}%` : ''}
          </p>
          <input
            style={{ width: '100%', maxWidth: 420 }}
            placeholder="Поиск по названию системы"
            value={routeQuery}
            onChange={(e) => setRouteQuery(e.target.value)}
          />
          {filteredRoute.length === 0 && !loadingRoute ? (
            <p>Список пуст. Добавьте системы во вкладке «Маршрут» в админке.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Система</th>
                    <th>Прогресс</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredRoute.map((r) => {
                    const p = r.progress;
                    const n = routeRows.findIndex((x) => x.system_name === r.system_name) + 1;
                    return (
                      <tr
                        key={r.system_name}
                        onClick={() => setCurrent(r.system_name)}
                        style={{
                          cursor: 'pointer',
                          background: current === r.system_name ? 'rgba(255,157,46,0.12)' : undefined,
                        }}
                      >
                        <td>{n}</td>
                        <td>
                          <a
                            href={`https://ravencolonial.com/#sys=${encodeURIComponent(r.system_name)}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            style={{ color: "#e67e22", textDecoration: "none" }}
                            title="Открыть в RavenColonial"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.system_name} ↗
                          </a>
                        </td>
                        <td>{p == null ? 'нет данных' : p + '%'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          TAB: Deliveries
         ═══════════════════════════════════════════════════════════ */}
      {tab === 'deliveries' && (
        <>
          <h3>Статистика доставок по системам</h3>
          {loadingDeliveries && <p>Загрузка статистики...</p>}
          {deliveryStats.length === 0 && !loadingDeliveries ? (
            <p>Доставок пока нет. Загрузите журналы через Uploader.</p>
          ) : (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Система</th>
                    <th>Всего тонн</th>
                    <th>Пилотов</th>
                    <th>Топ-товар</th>
                  </tr>
                </thead>
                <tbody>
                  {deliveryStats.map((s) => (
                    <tr key={s.system_name}>
                      <td>
                        <a
                          href={`https://ravencolonial.com/#sys=${encodeURIComponent(s.system_name)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#e67e22", textDecoration: "none" }}
                        >
                          {s.system_name} ↗
                        </a>
                      </td>
                      <td>{Number(s.total_delivered).toLocaleString('ru-RU')}</td>
                      <td>{s.unique_cmdrs}</td>
                      <td>{s.top_commodity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* ═══════════════════════════════════════════════════════════
          Detail panel for Hubs / Route tabs
         ═══════════════════════════════════════════════════════════ */}
      {!current && tab !== 'deliveries' && tab !== 'search' && <p>Выберите систему, чтобы увидеть состав стройки.</p>}
      {current && loading && !info && <p>Загрузка...</p>}
      {info && tab !== 'deliveries' && tab !== 'search' && (
        <div>
          <h2>
            {info.system_name}
            {info.data?.siteName ? ' — ' + info.data.siteName : ''}
          </h2>
          {info.data?.architectName && (
            <p style={{ color: '#9ca3af' }}>Архитектор: {info.data.architectName}</p>
          )}
          {info.error && <p style={{ color: '#e74c3c' }}>{info.error}</p>}
          <div style={{ background: '#323538', borderRadius: 8, height: 22 }}>
            <div
              style={{
                width: (info.progress ?? 0) + '%',
                background: '#22c55e',
                height: '100%',
                borderRadius: 8,
                transition: 'width 0.5s',
                textAlign: 'center',
                color: '#052e16',
                fontSize: 13,
                lineHeight: '22px',
                fontWeight: 700,
              }}
            >
              {info.progress ?? 0}%
            </div>
          </div>
          {info.updated_at && (
            <p style={{ color: '#9ca3af', fontSize: 13 }}>
              Обновлено: {new Date(info.updated_at).toLocaleString('ru-RU')} · источник: Raven
              Colonial
            </p>
          )}

          {projects.length > 1 && (
            <>
              <h3>Площадки</h3>
              <table>
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Тип</th>
                    <th>Тело</th>
                    <th>%</th>
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.buildId || p.buildName}>
                      <td>{p.buildName}</td>
                      <td>{p.buildType ?? '—'}</td>
                      <td>{p.bodyName ?? '—'}</td>
                      <td>{p.complete ? 'готово' : p.progress + '%'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}

          {resources.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Ресурс</th>
                  <th>Доставлено</th>
                  <th>Нужно</th>
                  <th>Осталось</th>
                  <th>%</th>
                </tr>
              </thead>
              <tbody>
                {resources.map((r) => (
                  <tr key={r.key || r.name}>
                    <td>{r.name}</td>
                    <td>{Number(r.provided).toLocaleString('ru-RU')}</td>
                    <td>{Number(r.required).toLocaleString('ru-RU')}</td>
                    <td>
                      {Number(
                        Math.max(0, r.remaining ?? r.required - r.provided),
                      ).toLocaleString('ru-RU')}
                    </td>
                    <td>{pct(r)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            current &&
            !loading && (
              <p>
                Список ресурсов пуст — в Raven Colonial для этой системы нет активной стройки или
                ещё нет списка товаров.
              </p>
            )
          )}
        </div>
      )}
    </main>
  );
}


