'use client';

import dynamic from 'next/dynamic';
import { useState, useCallback, useEffect, Suspense, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import { useAtlasData } from '@/hooks/useAtlasData';
import { useAtlasHistory } from '@/hooks/useAtlasHistory';
import { AtlasSearchPanel } from '@/components/Atlas/AtlasSearchPanel';
import { AtlasCandidateList } from '@/components/Atlas/AtlasCandidateList';
import { AtlasSearchHistory } from '@/components/Atlas/AtlasSearchHistory';
import { AtlasFavorites } from '@/components/Atlas/AtlasFavorites';
import AtlasRouteFinder, { type RouteSearchProgress } from '@/components/Atlas/AtlasRouteFinder';
import AtlasMarketSearch from '@/components/Atlas/AtlasMarketSearch';
import AtlasRingRouteFinder from '@/components/Atlas/AtlasRingRouteFinder';
import { Toaster, toast } from '@/components/ui/Toaster';
import type { AtlasCandidate, AtlasSearchSession } from '@/types/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';

const GalaxyMap = dynamic(() => import('@/components/GalaxyMap'), {
  ssr: false,
  loading: () => (
    <div style={{ color: 'var(--muted)', padding: 40, fontFamily: 'ui-monospace, monospace', letterSpacing: 2, textTransform: 'uppercase', fontSize: 12 }}>
      Loading 3D engine...
    </div>
  ),
});

type ProjectItem = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  squadron_id: number | null;
  squadron_name?: string;
};

type AtlasTab = 'search' | 'route' | 'route-finder' | 'ring-route' | 'market';

export default function AtlasPage() {
  return (
    <Suspense
      fallback={
        <div style={{ color: 'var(--muted)', padding: 40, fontFamily: 'ui-monospace, monospace', letterSpacing: 2, textTransform: 'uppercase', fontSize: 12 }}>
          Загрузка атласа...
        </div>
      }
    >
      <AtlasPageInner />
    </Suspense>
  );
}

function AtlasPageInner() {
  const searchParams = useSearchParams();
  const { candidates, error, setCandidates } = useAtlasData();
  const { addFavorite } = useAtlasHistory();

  const [selectedCandidate, setSelectedCandidate] = useState<AtlasCandidate | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [isSearching, setIsSearching] = useState(false);
  const initialMarketSystem = searchParams.get('system') || '';
  const requestedTab = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState<AtlasTab>(
    requestedTab === 'market' || requestedTab === 'route' || requestedTab === 'route-finder' || requestedTab === 'ring-route' ? requestedTab : 'search'
  );

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [squadronRoutePoints, setSquadronRoutePoints] = useState<RoutePoint[]>([]);
  const [routeFinderPoints, setRouteFinderPoints] = useState<RoutePoint[]>([]);
  const [routeSearchProgress, setRouteSearchProgress] = useState<RouteSearchProgress>({
    active: false, stage: 'idle', percent: 0, message: '', elapsedMs: 0,
  });
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [marketScanSystems, setMarketScanSystems] = useState<Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>>([]);
  const [marketResults, setMarketResults] = useState<Array<{ system_name: string; distance: number; x?: number; y?: number; z?: number; station_name?: string; commodities_found?: number }>>([]);

  /* ── load projects ── */
  useEffect(() => {
    setProjectsLoading(true);
    fetch('/api/projects')
      .then((r) => r.json())
      .then((d) => {
        setProjects(d.projects || []);
        setProjectsLoading(false);
      })
      .catch(() => setProjectsLoading(false));
  }, []);

  /* ── focus camera helpers ── */
  const focusCandidateOnMap = useCallback((candidate: AtlasCandidate | null) => {
    setSelectedCandidate(candidate);
    if (candidate) {
      window.dispatchEvent(new CustomEvent('atlas-focus-candidate', { detail: candidate }));
    }
  }, []);

  const focusRoutePointOnMap = useCallback((point: RoutePoint | null) => {
    window.dispatchEvent(new CustomEvent('atlas-focus-route-point', { detail: point }));
  }, []);

  /* ── load project systems ── */
  const loadProjectSystems = useCallback(
    async (projectId: number) => {
      try {
        const res = await fetch(`/api/projects/${projectId}/systems`);
        const data = await res.json();
        if (!res.ok) {
          toast(data.error || 'Ошибка загрузки систем', 'error');
          return;
        }
        const systems = data.systems || [];
        const points: RoutePoint[] = systems
          .filter((s: any) => typeof s.x === 'number' && typeof s.y === 'number' && typeof s.z === 'number')
          .map((s: any, i: number) => {
            const persistedId = Number(s.route_system?.id ?? s.route_system_id ?? s.id);
            return {
              // RoutePoint IDs are numeric. Project rows without a linked
              // route-system get a stable negative local ID for React keys.
              id: Number.isSafeInteger(persistedId) ? persistedId : -(projectId * 1_000_000 + i + 1),
              system_name: s.system_name,
              x: s.x,
              y: s.y,
              z: s.z,
              // /systems already merges the newest Raven cache; do not replace
              // it with the project-planning default when drawing this route.
              status: s.status || s.planned_status || 'planned',
              progress: typeof s.progress === 'number' ? s.progress : 0,
              sort_order: i,
              isHub: false,
            };
          });
        setSquadronRoutePoints(points);
        setSelectedProject(projectId);
        setActiveTab('route');
        toast(`Загружено ${points.length} систем проекта`, 'success');
      } catch (err: any) {
        toast(err.message, 'error');
      }
    },
    []
  );

  const clearProjectRoute = useCallback(() => {
    setSelectedProject(null);
    setSquadronRoutePoints([]);
  }, []);

  /* ── handle route-finder result ── */
  const handleRouteFound = useCallback((route: RoutePoint[], tab: AtlasTab = 'route-finder') => {
    setRouteFinderPoints(route);
    setActiveTab(tab);
    toast(`Маршрут построен: ${route.length} систем`, 'success');
  }, []);

  /* ── URL ?project= ── */
  useEffect(() => {
    const projectId = searchParams.get('project');
    if (projectId && projects.length > 0) {
      const id = Number(projectId);
      if (!isNaN(id)) loadProjectSystems(id);
    }
  }, [searchParams, projects, loadProjectSystems]);

  const selectedProjectName = projects.find((p) => p.id === selectedProject)?.name || '';

  const filteredCandidates =
    activeFilter === 'all' ? candidates : candidates.filter((c) => c.world_type === activeFilter);

  // A selected marker should never survive after its category has been hidden.
  // Otherwise the sidebar and 3D layer can appear to disagree about filtering.
  useEffect(() => {
    if (selectedCandidate && activeFilter !== 'all' && selectedCandidate.world_type !== activeFilter) {
      setSelectedCandidate(null);
    }
  }, [activeFilter, selectedCandidate]);

  const typeCounts = candidates.reduce((acc, c) => {
    acc[c.world_type] = (acc[c.world_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  /* ── search ── */
  const handleSearch = useCallback(
    async (params: any) => {
      // New searches have a different category set; keep their filter and
      // selection from inheriting stale state from the previous result set.
      setActiveFilter('all');
      setSelectedCandidate(null);
      setIsSearching(true);
      try {
        const res = await fetch('/api/atlas/search', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        });
        const json = await res.json();
        if (!res.ok) {
          toast(json.error || 'Search failed', 'error');
          setIsSearching(false);
          return;
        }
        const poll = setInterval(async () => {
          const check = await fetch(`/api/atlas/search?session_id=${json.session_id}`);
          const data = await check.json();
          if (data.session.status === 'completed') {
            clearInterval(poll);
            setCandidates(data.candidates || []);
            setIsSearching(false);
            toast(`Найдено ${data.total_candidates} объектов`, 'success');
          } else if (data.session.status === 'failed') {
            clearInterval(poll);
            toast(data.session.error_message || 'Search failed', 'error');
            setIsSearching(false);
          }
        }, 2000);
      } catch (err: any) {
        toast(err.message, 'error');
        setIsSearching(false);
      }
    },
    [setCandidates]
  );

  const handleSelectSession = useCallback(
    async (session: AtlasSearchSession) => {
      if (session.status !== 'completed') {
        toast('Поиск ещё выполняется', 'info');
        return;
      }
      const res = await fetch(`/api/atlas/search?session_id=${session.id}`);
      const data = await res.json();
      setActiveFilter('all');
      setSelectedCandidate(null);
      setCandidates(data.candidates || []);
    },
    [setCandidates]
  );

  const handleAddFavorite = useCallback(
    async (candidate: AtlasCandidate) => {
      const ok = await addFavorite(candidate);
      if (ok) toast('Добавлено в избранное', 'success');
      else toast('Ошибка добавления', 'error');
    },
    [addFavorite]
  );

  /* ── combined route points for map ── */
  const allRoutePoints = [...squadronRoutePoints, ...routeFinderPoints];

  /* ── no-market systems for map visualization ── */
  const noMarketSystems = useMemo(() => {
    return marketScanSystems
      .filter((system) => system.status === 'no_market' && typeof system.x === 'number' && typeof system.y === 'number' && typeof system.z === 'number')
      .map((system) => ({ system_name: system.system_name, x: system.x!, y: system.y!, z: system.z! }));
  }, [marketScanSystems]);

  const resetMarketMapLayers = useCallback(() => {
    setMarketScanSystems([]);
    setMarketResults([]);
  }, []);

  const mergeMarketScanUpdate = useCallback((updates: Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>) => {
    // /step intentionally returns only a recent tail of the scan log. Merge
    // it instead of replacing state so previous no-market points keep their
    // filterable markers for the whole scan.
    setMarketScanSystems((current) => {
      const bySystem = new Map(current.map((system) => [system.system_name.trim().replace(/\s+/g, ' ').toLowerCase(), system]));
      for (const update of updates) {
        const key = update.system_name.trim().replace(/\s+/g, ' ').toLowerCase();
        if (key) bySystem.set(key, update);
      }
      return Array.from(bySystem.values());
    });
  }, []);

  return (
    <div className="atlas-page">
      <Toaster />

      {/* ── Sidebar ── */}
      <div className="atlas-sidebar">
        <div className="atlas-sidebar-header">
          <h1>ATLAS</h1>
          <p className="kicker">World Finder for Colonization</p>
        </div>

        <div className="atlas-tabs">
          <button
            className={`atlas-tab${activeTab === 'search' ? ' active' : ''}`}
            onClick={() => setActiveTab('search')}
          >
            Поиск
          </button>
          <button
            className={`atlas-tab${activeTab === 'route' ? ' active' : ''}`}
            onClick={() => setActiveTab('route')}
          >
            Маршрут
          </button>
          <button
            className={`atlas-tab${activeTab === 'route-finder' ? ' active' : ''}`}
            onClick={() => setActiveTab('route-finder')}
          >
            Поиск маршрута
          </button>
          <button
            className={`atlas-tab${activeTab === 'ring-route' ? ' active' : ''}`}
            onClick={() => setActiveTab('ring-route')}
          >
            Галактическое кольцо
          </button>
          <button
            className={`atlas-tab${activeTab === 'market' ? ' active' : ''}`}
            onClick={() => setActiveTab('market')}
          >
            Рынок
          </button>
        </div>

        <div className="atlas-sidebar-body">
          {/* Tab: Search */}
          {activeTab === 'search' && (
            <>
              <AtlasSearchPanel onSearch={handleSearch} loading={isSearching} />
              {error && <div className="atlas-error">{error}</div>}
              <AtlasSearchHistory onSelectSession={handleSelectSession} />
              <AtlasFavorites onSelect={(f) => focusCandidateOnMap(f as any)} />

              {candidates.length > 0 && (
                <div className="atlas-section">
                  <div className="atlas-filter-pills">
                    <button
                      onClick={() => setActiveFilter('all')}
                      className={`atlas-filter-pill${activeFilter === 'all' ? ' active' : ''}`}
                    >
                      All ({candidates.length})
                    </button>
                    {Object.entries(typeCounts).map(([type, count]) => (
                      <button
                        key={type}
                        onClick={() => setActiveFilter(type)}
                        className={`atlas-filter-pill${activeFilter === type ? ' active' : ''}`}
                      >
                        {type.replace('_', ' ')} ({count})
                      </button>
                    ))}
                  </div>
                  <AtlasCandidateList
                    candidates={filteredCandidates}
                    onSelect={focusCandidateOnMap}
                    selectedId={selectedCandidate?.id}
                  />
                </div>
              )}
            </>
          )}

          {/* Tab: Route */}
          {activeTab === 'route' && (
            <div className="atlas-section">
              <h4>Маршрут проекта</h4>

              <div className="atlas-project-select" style={{ marginBottom: 12 }}>
                <label>Маршрут:</label>
                <select
                  value={selectedProject || ''}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (!val) {
                      clearProjectRoute();
                      return;
                    }
                    loadProjectSystems(Number(val));
                  }}
                  disabled={projectsLoading}
                >
                  <option value="">{projectsLoading ? 'Загрузка...' : 'Выберите проект'}</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.squadron_name ? `[${p.squadron_name}] ` : ''}
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedProject && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <span className="atlas-badge">
                    {selectedProjectName} ({squadronRoutePoints.length} систем)
                  </span>
                  <button
                    onClick={clearProjectRoute}
                    className="btn"
                    style={{ fontSize: 11, padding: '4px 10px' }}
                  >
                    &#10005; Сбросить
                  </button>
                </div>
              )}

              {squadronRoutePoints.length === 0 ? (
                <p className="empty">Маршрут не загружен. Выберите проект из списка.</p>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {squadronRoutePoints.map((rp, i) => (
                    <div
                      key={rp.id}
                      className="route-row"
                      style={{ padding: '6px 8px', cursor: 'pointer' }}
                      onClick={() => focusRoutePointOnMap(rp)}
                      title="Кликните для фокуса на карте"
                    >
                      <span className="route-idx">{i + 1}</span>
                      <span className="route-name">{rp.system_name}</span>
                      <span className="route-coords">
                        {rp.x.toFixed(1)}, {rp.y.toFixed(1)}, {rp.z.toFixed(1)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Tab: Route Finder */}
          {activeTab === 'route-finder' && (
            <AtlasRouteFinder onRouteFound={handleRouteFound} onProgress={setRouteSearchProgress} />
          )}

          {activeTab === 'ring-route' && (
            <AtlasRingRouteFinder onRouteFound={(route) => handleRouteFound(route, 'ring-route')} />
          )}
          {/* Tab: Market */}
          {activeTab === 'market' && (
            <AtlasMarketSearch
              initialSystem={initialMarketSystem}
              onScanStart={resetMarketMapLayers}
              onScanUpdate={mergeMarketScanUpdate}
              onMarketResults={setMarketResults}
            />
          )}
        </div>
      </div>

      {/* ── Map ── */}
      <div className="atlas-map-area">
        <GalaxyMap
          // Keep the 3D layer in sync with the Atlas category pills, rather
          // than filtering only the adjacent result list.
          atlasCandidates={filteredCandidates}
          squadronRouteSystems={allRoutePoints}
          noMarketSystems={noMarketSystems}
          marketResults={marketResults}
          routeSearchProgress={routeSearchProgress}
        />
      </div>
    </div>
  );
}
