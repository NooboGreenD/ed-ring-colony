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
import AtlasRouteFinder from '@/components/Atlas/AtlasRouteFinder';
import AtlasMarketSearch from '@/components/Atlas/AtlasMarketSearch';
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

type AtlasTab = 'search' | 'route' | 'route-finder' | 'market';

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
  const [activeTab, setActiveTab] = useState<AtlasTab>('search');

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [squadronRoutePoints, setSquadronRoutePoints] = useState<RoutePoint[]>([]);
  const [routeFinderPoints, setRouteFinderPoints] = useState<RoutePoint[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [marketScanSystems, setMarketScanSystems] = useState<Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>>([]);
  const [marketResults, setMarketResults] = useState<Array<{ system_name: string; distance: number; station_name?: string; commodities_found?: number }>>([]);

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
          .map((s: any, i: number) => ({
            id: `proj-${projectId}-${s.id}`,
            system_name: s.system_name,
            x: s.x,
            y: s.y,
            z: s.z,
            status: s.planned_status || 'planned',
            progress: s.progress || 0,
            sort_order: i,
            isHub: false,
          }));
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
  const handleRouteFound = useCallback((route: RoutePoint[]) => {
    setRouteFinderPoints(route);
    setActiveTab('route-finder');
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

  const typeCounts = candidates.reduce((acc, c) => {
    acc[c.world_type] = (acc[c.world_type] || 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  /* ── search ── */
  const handleSearch = useCallback(
    async (params: any) => {
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
      .filter((s) => s.status === 'no_market' && typeof s.x === 'number')
      .map((s) => ({ system_name: s.system_name, x: s.x!, y: s.y!, z: s.z! }));
  }, [marketScanSystems]);

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
            <AtlasRouteFinder onRouteFound={handleRouteFound} />
          )}

          {/* Tab: Market */}
          {activeTab === 'market' && (
            <AtlasMarketSearch
              onScanUpdate={setMarketScanSystems}
              onMarketResults={setMarketResults}
            />
          )}
        </div>
      </div>

      {/* ── Map ── */}
      <div className="atlas-map-area">
        <GalaxyMap
          atlasCandidates={candidates}
          squadronRouteSystems={allRoutePoints}
          noMarketSystems={noMarketSystems}
          marketResults={marketResults}
        />
      </div>
    </div>
  );
}
