'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAtlasData } from '@/hooks/useAtlasData';
import { AtlasProvider, useAtlas } from '@/components/Atlas/AtlasContext';
import { AtlasSearchPanel } from '@/components/Atlas/AtlasSearchPanel';
import { AtlasCandidateList } from '@/components/Atlas/AtlasCandidateList';
import { AtlasSearchHistory } from '@/components/Atlas/AtlasSearchHistory';
import { AtlasFavorites } from '@/components/Atlas/AtlasFavorites';
import AtlasRouteFinder, { type RouteSearchProgress } from '@/components/Atlas/AtlasRouteFinder';
import AtlasMarketSearch from '@/components/Atlas/AtlasMarketSearch';
import AtlasRingRouteFinder from '@/components/Atlas/AtlasRingRouteFinder';
import { toast } from '@/components/ui/Toaster';
import {
  IconAtlas,
  IconDownload,
  IconGlobe,
  IconMap,
  IconRoute,
  IconSearch,
  IconStore,
  IconTrash,
  IconX,
} from '@/components/Icons';
import type { AtlasCandidate, AtlasFavorite, AtlasSearchSession, WorldType } from '@/types/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';
import { countByWorldType, downloadCsv, favoriteKey, filterCandidates, formatCoordinates, worldTypeLabel } from '@/lib/atlas';

const GalaxyMap = dynamic(() => import('@/components/GalaxyMap'), {
  ssr: false,
  loading: () => (
    <div className="atlas-map-loading">
      Загрузка 3D-движка…
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

const TABS: { id: AtlasTab; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: 'search', label: 'Поиск', icon: <IconSearch size={14} />, hint: 'Поиск миров по типам (Alt+1)' },
  { id: 'route', label: 'Маршрут', icon: <IconMap size={14} />, hint: 'Маршрут проекта (Alt+2)' },
  { id: 'route-finder', label: 'Маршрут A→B', icon: <IconRoute size={14} />, hint: 'Построение маршрута между системами (Alt+3)' },
  { id: 'ring-route', label: 'Кольцо', icon: <IconGlobe size={14} />, hint: 'Галактическое кольцо колонизации (Alt+4)' },
  { id: 'market', label: 'Рынок', icon: <IconStore size={14} />, hint: 'Поиск товаров для стройки (Alt+5)' },
];

const CANDIDATE_PAGE_SIZE = 200;
const MAX_POLL_ATTEMPTS = 90; // 3 минуты при интервале 2 с

function parseTab(value: string | null): AtlasTab {
  return value === 'market' || value === 'route' || value === 'route-finder' || value === 'ring-route' ? value : 'search';
}

export default function AtlasPage() {
  // useSearchParams в клиентском компоненте требует Suspense-границы:
  // без неё страница не собирается в статический пререндер.
  return (
    <Suspense fallback={<div className="atlas-map-loading">Загрузка атласа…</div>}>
      <AtlasProvider>
        <AtlasPageInner />
      </AtlasProvider>
    </Suspense>
  );
}

function AtlasPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { candidates, error, setCandidates } = useAtlasData();
  const { favorites, sessions, recordSearch, favoriteKeys } = useAtlas();

  const [selectedCandidate, setSelectedCandidate] = useState<AtlasCandidate | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [candidateSearchProgress, setCandidateSearchProgress] = useState({ elapsedMs: 0, phase: 'Подготовка', found: 0, status: 'idle' });
  const [candidateSearchStartedAt, setCandidateSearchStartedAt] = useState<number | null>(null);
  const [candidateTotal, setCandidateTotal] = useState<number | null>(null);
  const [candidatesLoadingMore, setCandidatesLoadingMore] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initialMarketSystem = searchParams.get('system') || '';
  const [activeTab, setActiveTab] = useState<AtlasTab>(() => parseTab(searchParams.get('tab')));

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [squadronRoutePoints, setSquadronRoutePoints] = useState<RoutePoint[]>([]);
  const [routeFinderPoints, setRouteFinderPoints] = useState<RoutePoint[]>([]);
  const [routeSearchProgress, setRouteSearchProgress] = useState<RouteSearchProgress>({
    active: false, stage: 'idle', percent: 0, message: '', elapsedMs: 0,
  });
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [routeFilter, setRouteFilter] = useState('');
  const [marketScanSystems, setMarketScanSystems] = useState<Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>>([]);
  const [marketResults, setMarketResults] = useState<Array<{ system_name: string; distance: number; x?: number; y?: number; z?: number; station_name?: string; commodities_found?: number }>>([]);

  const pollRef = useRef<number | null>(null);
  const searchSessionRef = useRef<string | null>(null);

  /* ── загрузка проектов ── */
  useEffect(() => {
    setProjectsLoading(true);
    fetch('/api/projects')
      .then((response) => response.json())
      .then((data) => {
        setProjects(data.projects || []);
        setProjectsLoading(false);
      })
      .catch(() => setProjectsLoading(false));
  }, []);

  /* ── таймер прогресса поиска кандидатов ── */
  useEffect(() => {
    if (!isSearching || !candidateSearchStartedAt) return;
    const timer = window.setInterval(() => {
      const elapsedMs = Date.now() - candidateSearchStartedAt;
      const phase = elapsedMs < 1500 ? 'Проверка параметров'
        : elapsedMs < 8000 ? 'Поиск в Spansh'
          : elapsedMs < 18000 ? 'Сверка координат EDSM'
            : elapsedMs < 30000 ? 'Фильтрация кандидатов'
              : 'Сохранение результатов';
      setCandidateSearchProgress((current) => ({ ...current, elapsedMs, phase, status: 'running' }));
    }, 250);
    return () => window.clearInterval(timer);
  }, [isSearching, candidateSearchStartedAt]);

  /* ── опрос сессии поиска ── */
  const stopPolling = useCallback(() => {
    if (pollRef.current != null) {
      window.clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  // Раньше интервал опроса не снимался при уходе со страницы и продолжал
  // обращаться к API (и дёргать setState уже размонтированного компонента).
  useEffect(() => stopPolling, [stopPolling]);

  /* ── синхронизация вкладки с URL ── */
  const selectTab = useCallback((tab: AtlasTab) => {
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'search') params.delete('tab');
    else params.set('tab', tab);
    const query = params.toString();
    router.replace(query ? `/atlas?${query}` : '/atlas', { scroll: false });
  }, [router, searchParams]);

  /* ── вкладка следует за URL (назад/вперёд, прямые ссылки) ── */
  useEffect(() => {
    const tab = parseTab(searchParams.get('tab'));
    setActiveTab((current) => (current === tab ? current : tab));
  }, [searchParams]);

  /* ── Alt+1..5 — быстрое переключение вкладок ── */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.altKey || event.ctrlKey || event.metaKey) return;
      const index = Number(event.key);
      if (!Number.isInteger(index) || index < 1 || index > TABS.length) return;
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
      event.preventDefault();
      selectTab(TABS[index - 1].id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [selectTab]);

  /* ── фокус камеры карты ── */
  const focusCandidateOnMap = useCallback((candidate: AtlasCandidate | null) => {
    setSelectedCandidate(candidate);
    if (candidate) {
      window.dispatchEvent(new CustomEvent('atlas-focus-candidate', { detail: candidate }));
    }
  }, []);

  const focusRoutePointOnMap = useCallback((point: RoutePoint | null) => {
    window.dispatchEvent(new CustomEvent('atlas-focus-route-point', { detail: point }));
  }, []);

  /* ── системы проекта как маршрут ── */
  const loadProjectSystems = useCallback(async (projectId: number) => {
    try {
      const res = await fetch(`/api/projects/${projectId}/systems`);
      const data = await res.json();
      if (!res.ok) {
        toast(data.error || 'Не удалось загрузить системы проекта', 'error');
        return;
      }
      const systems = data.systems || [];
      const points: RoutePoint[] = systems
        .filter((system: any) => typeof system.x === 'number' && typeof system.y === 'number' && typeof system.z === 'number')
        .map((system: any, index: number) => {
          const persistedId = Number(system.route_system?.id ?? system.route_system_id ?? system.id);
          return {
            // RoutePoint.id числовой: строкам без связанной системы проекта
            // выдаём стабильный отрицательный идентификатор для ключей React.
            id: Number.isSafeInteger(persistedId) ? persistedId : -(projectId * 1_000_000 + index + 1),
            system_name: system.system_name,
            x: system.x,
            y: system.y,
            z: system.z,
            // /systems уже отдаёт свежий кэш Raven — не подменяем его статусом
            // планирования при отрисовке маршрута.
            status: system.status || system.planned_status || 'planned',
            progress: typeof system.progress === 'number' ? system.progress : 0,
            sort_order: index,
            isHub: false,
          };
        });
      setSquadronRoutePoints(points);
      setSelectedProject(projectId);
      selectTab('route');
      toast(`Загружено систем проекта: ${points.length}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Ошибка загрузки систем проекта', 'error');
    }
  }, [selectTab]);

  const clearProjectRoute = useCallback(() => {
    setSelectedProject(null);
    setSquadronRoutePoints([]);
    setRouteFilter('');
  }, []);

  const handleRouteFound = useCallback((route: RoutePoint[], tab: AtlasTab = 'route-finder') => {
    setRouteFinderPoints(route);
    selectTab(tab);
    toast(`Маршрут построен: ${route.length} систем`, 'success');
  }, [selectTab]);

  /* ── ?project= из URL ── */
  useEffect(() => {
    const projectId = searchParams.get('project');
    if (projectId && projects.length > 0) {
      const id = Number(projectId);
      if (!isNaN(id)) void loadProjectSystems(id);
    }
  }, [searchParams, projects, loadProjectSystems]);

  const selectedProjectName = projects.find((project) => project.id === selectedProject)?.name || '';

  const filteredCandidates = useMemo(
    () => filterCandidates(candidates, { worldTypes: activeFilter === 'all' ? [] : [activeFilter] }),
    [activeFilter, candidates],
  );

  // Скрытый категорией маркер не должен оставаться выделенным: иначе панель
  // и 3D-слой показывают разные наборы данных.
  useEffect(() => {
    if (selectedCandidate && activeFilter !== 'all' && selectedCandidate.world_type !== activeFilter) {
      setSelectedCandidate(null);
    }
  }, [activeFilter, selectedCandidate]);

  const typeCounts = useMemo(() => countByWorldType(candidates), [candidates]);
  const systemCount = useMemo(
    () => new Set(candidates.map((candidate) => candidate.system_name.trim().toLowerCase())).size,
    [candidates],
  );

  /* ── поиск миров ── */
  const collectCandidates = useCallback(async (sessionId: string) => {
    const res = await fetch(`/api/atlas/candidates?search_id=${encodeURIComponent(sessionId)}&limit=${CANDIDATE_PAGE_SIZE}`);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Не удалось загрузить кандидатов');
    setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
    setCandidateTotal(typeof data.total === 'number' ? data.total : null);
  }, [setCandidates]);

  const handleSearch = useCallback(async (params: any) => {
    // Новый набор категорий: старый фильтр и выделение не должны переезжать.
    setActiveFilter('all');
    setSelectedCandidate(null);
    setCandidateTotal(null);
    setIsSearching(true);
    setCandidateSearchStartedAt(Date.now());
    setCandidateSearchProgress({ elapsedMs: 0, phase: 'Подготовка', found: 0, status: 'pending' });
    stopPolling();

    try {
      const res = await fetch('/api/atlas/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        const message = res.status === 429
          ? 'Слишком много поисков подряд — подождите минуту'
          : json.error || 'Не удалось запустить поиск';
        toast(message, 'error');
        setIsSearching(false);
        setCandidateSearchStartedAt(null);
        setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Ошибка' }));
        return;
      }
      if (!json.session_id) {
        toast('Сервер не вернул идентификатор поиска', 'error');
        setIsSearching(false);
        setCandidateSearchStartedAt(null);
        return;
      }

      searchSessionRef.current = json.session_id;
      recordSearch({
        id: json.session_id,
        reference_system: params.reference_system,
        cube_size_ly: params.cube_size_ly,
        world_types: params.world_types,
      });

      let attempts = 0;
      let failures = 0;
      pollRef.current = window.setInterval(async () => {
        attempts += 1;
        if (attempts > MAX_POLL_ATTEMPTS) {
          stopPolling();
          setIsSearching(false);
          setCandidateSearchStartedAt(null);
          setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Таймаут' }));
          toast('Поиск идёт слишком долго — откройте историю позже', 'error');
          return;
        }
        try {
          const check = await fetch(`/api/atlas/search?session_id=${encodeURIComponent(json.session_id)}`);
          const data = await check.json().catch(() => ({}));
          failures = 0;
          setCandidateSearchProgress((current) => ({
            ...current,
            found: Number(data.session?.total_found || 0),
            status: data.session?.status || current.status,
          }));
          if (data.session?.status === 'completed') {
            stopPolling();
            try {
              await collectCandidates(json.session_id);
            } catch {
              setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
            }
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'completed', phase: 'Готово' }));
            toast(`Найдено объектов: ${Number(data.total_candidates || 0).toLocaleString('ru-RU')}`, 'success');
          } else if (data.session?.status === 'failed') {
            stopPolling();
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Ошибка' }));
            toast(data.session.error_message || 'Поиск завершился ошибкой', 'error');
          }
        } catch {
          failures += 1;
          // Пара сетевых сбоев — не повод ронять поиск, который идёт на сервере.
          if (failures >= 5) {
            stopPolling();
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Связь потеряна' }));
            toast('Не удалось получить результат поиска', 'error');
          }
        }
      }, 2000);
    } catch (err: any) {
      toast(err.message || 'Ошибка поиска', 'error');
      setIsSearching(false);
      setCandidateSearchStartedAt(null);
      setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Ошибка' }));
    }
  }, [collectCandidates, recordSearch, setCandidates, stopPolling]);

  const loadMoreCandidates = useCallback(async () => {
    const sessionId = searchSessionRef.current;
    if (!sessionId || candidatesLoadingMore) return;
    setCandidatesLoadingMore(true);
    try {
      const res = await fetch(`/api/atlas/candidates?search_id=${encodeURIComponent(sessionId)}&limit=${CANDIDATE_PAGE_SIZE}&offset=${candidates.length}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось догрузить кандидатов');
      const rows = Array.isArray(data.candidates) ? data.candidates : [];
      setCandidates((current) => [...current, ...rows.filter((row: AtlasCandidate) => !current.some((item) => item.id === row.id))]);
      if (typeof data.total === 'number') setCandidateTotal(data.total);
    } catch (err: any) {
      toast(err.message || 'Ошибка загрузки', 'error');
    } finally {
      setCandidatesLoadingMore(false);
    }
  }, [candidates.length, candidatesLoadingMore, setCandidates]);

  const handleSelectSession = useCallback(async (session: AtlasSearchSession) => {
    if (session.status !== 'completed') {
      toast('Поиск ещё не завершён', 'info');
      return;
    }
    try {
      const res = await fetch(`/api/atlas/search?session_id=${encodeURIComponent(session.id)}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не удалось открыть результаты');
      setActiveFilter('all');
      setSelectedCandidate(null);
      searchSessionRef.current = session.id;
      setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
      setCandidateTotal(typeof data.total_candidates === 'number' ? data.total_candidates : null);
      toast(`Загружены результаты: ${session.reference_system}`, 'success');
    } catch (err: any) {
      toast(err.message || 'Ошибка загрузки результатов', 'error');
    }
  }, [setCandidates]);

  const handleFavoriteSelect = useCallback((favorite: AtlasFavorite) => {
    focusCandidateOnMap({
      id: favorite.candidate_id || favorite.id,
      search_id: favorite.search_id || '',
      system_name: favorite.system_name,
      x: favorite.x,
      y: favorite.y,
      z: favorite.z,
      world_type: favorite.world_type as WorldType,
      body_name: favorite.body_name,
      distance_from_ref: 0,
      created_at: favorite.created_at,
    });
  }, [focusCandidateOnMap]);

  const exportCandidates = useCallback(() => {
    if (filteredCandidates.length === 0) return;
    downloadCsv(`atlas-candidates-${new Date().toISOString().slice(0, 10)}`, [
      ['Система', 'Тело', 'Тип', 'X', 'Y', 'Z', 'Дистанция от точки, св.л.', 'До звезды, св.с.', 'Оценка скана, CR', 'В избранном'],
      ...filteredCandidates.map((candidate) => [
        candidate.system_name,
        candidate.body_name || '',
        worldTypeLabel(candidate.world_type),
        candidate.x.toFixed(6),
        candidate.y.toFixed(6),
        candidate.z.toFixed(6),
        candidate.distance_from_ref?.toFixed(2) ?? '',
        candidate.distance_to_arrival?.toFixed(0) ?? '',
        candidate.estimated_value ?? '',
        favoriteKeys.has(favoriteKey(candidate.system_name, candidate.world_type)) ? 'да' : '',
      ]),
    ]);
  }, [favoriteKeys, filteredCandidates]);

  const clearCandidates = useCallback(() => {
    stopPolling();
    searchSessionRef.current = null;
    setCandidates([]);
    setCandidateTotal(null);
    setSelectedCandidate(null);
    setActiveFilter('all');
    setCandidateSearchProgress({ elapsedMs: 0, phase: 'Подготовка', found: 0, status: 'idle' });
    toast('Список кандидатов очищен', 'info');
  }, [setCandidates, stopPolling]);

  /* ── маршрут проекта: список с фильтром и экспортом ── */
  const filteredRoute = useMemo(() => {
    const query = routeFilter.trim().toLowerCase();
    if (!query) return squadronRoutePoints;
    return squadronRoutePoints.filter((point) => point.system_name.toLowerCase().includes(query));
  }, [routeFilter, squadronRoutePoints]);

  /* ── точки обоих маршрутов для карты ── */
  const allRoutePoints = useMemo(
    () => [...squadronRoutePoints, ...routeFinderPoints],
    [routeFinderPoints, squadronRoutePoints],
  );

  /* ── системы без рынка для слоя карты ── */
  const noMarketSystems = useMemo(() => marketScanSystems
    .filter((system) => system.status === 'no_market'
      && typeof system.x === 'number' && typeof system.y === 'number' && typeof system.z === 'number')
    .map((system) => ({ system_name: system.system_name, x: system.x!, y: system.y!, z: system.z! })),
  [marketScanSystems]);

  const resetMarketMapLayers = useCallback(() => {
    setMarketScanSystems([]);
    setMarketResults([]);
  }, []);

  const mergeMarketScanUpdate = useCallback((updates: Array<{ system_name: string; x?: number; y?: number; z?: number; status: string }>) => {
    // /step отдаёт только «хвост» журнала сканирования: доливаем его в
    // состояние, чтобы ранее найденные точки не исчезали с карты.
    setMarketScanSystems((current) => {
      const bySystem = new Map(current.map((system) => [system.system_name.trim().replace(/\s+/g, ' ').toLowerCase(), system]));
      for (const update of updates) {
        const key = update.system_name.trim().replace(/\s+/g, ' ').toLowerCase();
        if (key) bySystem.set(key, update);
      }
      return Array.from(bySystem.values());
    });
  }, []);

  const favoriteCount = favorites.length;
  const lastSession = sessions[0];

  return (
    <div className={`atlas-page${sidebarOpen ? '' : ' atlas-page-collapsed'}`}>
      {/* ── Панель управления ── */}
      <div className={`atlas-sidebar${sidebarOpen ? '' : ' closed'}`}>
        <div className="atlas-sidebar-header">
          <div className="atlas-brand-row">
            <div>
              <h1>
                <IconAtlas size={18} /> ATLAS
              </h1>
              <p className="kicker">World Finder for Colonization</p>
            </div>
            <button
              type="button"
              className="atlas-icon-btn"
              onClick={() => setSidebarOpen(false)}
              title="Свернуть панель и открыть карту во всю ширину"
              aria-label="Свернуть панель Atlas"
            >
              <IconX size={14} />
            </button>
          </div>

          <div className="atlas-quick-stats">
            <span className="atlas-stat">
              <strong>{candidates.length.toLocaleString('ru-RU')}</strong>
              <span>кандидатов</span>
            </span>
            <span className="atlas-stat">
              <strong>{systemCount.toLocaleString('ru-RU')}</strong>
              <span>систем</span>
            </span>
            <span className="atlas-stat">
              <strong>{favoriteCount.toLocaleString('ru-RU')}</strong>
              <span>в избранном</span>
            </span>
          </div>

          <div className="atlas-header-links">
            <Link href="/atlas/sector" className="btn atlas-sectors-link" title="Реестр 42 секторов галактики">
              Секторы (42)
            </Link>
            {lastSession && (
              <button
                type="button"
                className="atlas-link-btn"
                onClick={() => void handleSelectSession(lastSession)}
                title={`Открыть последний поиск: ${lastSession.reference_system}`}
              >
                Последний поиск: {lastSession.reference_system}
              </button>
            )}
          </div>
        </div>

        <div className="atlas-tabs" role="tablist" aria-label="Разделы Atlas">
          {TABS.map((tab, index) => (
            <button
              key={tab.id}
              role="tab"
              aria-selected={activeTab === tab.id}
              tabIndex={activeTab === tab.id ? 0 : -1}
              className={`atlas-tab${activeTab === tab.id ? ' active' : ''}`}
              onClick={() => selectTab(tab.id)}
              title={`${tab.hint}`}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </div>

        <div className="atlas-sidebar-body">
          {activeTab === 'search' && (
            <>
              <AtlasSearchPanel onSearch={handleSearch} loading={isSearching} progress={candidateSearchProgress} />
              {error && <div className="atlas-error">{error}</div>}
              <AtlasSearchHistory onSelectSession={(session) => void handleSelectSession(session)} />
              <AtlasFavorites onSelect={handleFavoriteSelect} />

              {candidates.length > 0 && (
                <div className="atlas-section">
                  <div className="atlas-section-head">
                    <h4>Кандидаты</h4>
                    <div className="atlas-section-actions">
                      <button type="button" className="atlas-icon-btn" title="Экспорт списка в CSV" onClick={exportCandidates}>
                        <IconDownload size={12} />
                      </button>
                      <button type="button" className="atlas-icon-btn danger" title="Очистить список" onClick={clearCandidates}>
                        <IconTrash size={12} />
                      </button>
                    </div>
                  </div>

                  <div className="atlas-filter-pills">
                    <button
                      type="button"
                      onClick={() => setActiveFilter('all')}
                      className={`atlas-filter-pill${activeFilter === 'all' ? ' active' : ''}`}
                    >
                      Все ({candidates.length})
                    </button>
                    {typeCounts.map(({ type, count }) => (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setActiveFilter(type)}
                        className={`atlas-filter-pill${activeFilter === type ? ' active' : ''}`}
                      >
                        {worldTypeLabel(type)} ({count})
                      </button>
                    ))}
                  </div>

                  <AtlasCandidateList
                    candidates={filteredCandidates}
                    onSelect={focusCandidateOnMap}
                    selectedId={selectedCandidate?.id}
                    total={candidateTotal ?? undefined}
                    onLoadMore={() => void loadMoreCandidates()}
                    loadingMore={candidatesLoadingMore}
                  />
                </div>
              )}
            </>
          )}

          {activeTab === 'route' && (
            <div className="atlas-section">
              <div className="atlas-section-head">
                <h4>Маршрут проекта</h4>
                {squadronRoutePoints.length > 0 && (
                  <div className="atlas-section-actions">
                    <button
                      type="button"
                      className="atlas-icon-btn"
                      title="Экспорт маршрута проекта в CSV"
                      onClick={() => downloadCsv(
                        `project-route-${selectedProjectName || selectedProject || 'atlas'}`,
                        [
                          ['Порядок', 'Система', 'X', 'Y', 'Z', 'Статус'],
                          ...squadronRoutePoints.map((point, index) => [
                            index + 1, point.system_name,
                            point.x.toFixed(6), point.y.toFixed(6), point.z.toFixed(6),
                            point.status || 'planned',
                          ]),
                        ],
                      )}
                    >
                      <IconDownload size={12} />
                    </button>
                  </div>
                )}
              </div>

              <div className="atlas-project-select">
                <label htmlFor="atlas-project">Проект:</label>
                <select
                  id="atlas-project"
                  value={selectedProject || ''}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (!value) {
                      clearProjectRoute();
                      return;
                    }
                    void loadProjectSystems(Number(value));
                  }}
                  disabled={projectsLoading}
                >
                  <option value="">{projectsLoading ? 'Загрузка…' : 'Выберите проект'}</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.squadron_name ? `[${project.squadron_name}] ` : ''}
                      {project.name}
                    </option>
                  ))}
                </select>
              </div>

              {selectedProject && (
                <div className="atlas-project-meta">
                  <span className="atlas-badge">{selectedProjectName || `Проект #${selectedProject}`}: {squadronRoutePoints.length} систем</span>
                  <button type="button" className="atlas-link-btn" onClick={clearProjectRoute}>Сбросить</button>
                </div>
              )}

              {squadronRoutePoints.length === 0 ? (
                <p className="atlas-muted">
                  Маршрут не загружен. Выберите проект или передайте его идентификатор в ссылке: <code>/atlas?project=ID</code>.
                </p>
              ) : (
                <>
                  <div className="atlas-inline-search">
                    <IconSearch size={12} />
                    <input
                      type="search"
                      value={routeFilter}
                      onChange={(event) => setRouteFilter(event.target.value)}
                      placeholder="Найти систему в маршруте"
                      aria-label="Фильтр маршрута проекта"
                    />
                    {routeFilter && (
                      <button type="button" onClick={() => setRouteFilter('')} aria-label="Очистить фильтр">
                        <IconX size={11} />
                      </button>
                    )}
                  </div>
                  <p className="atlas-list-counter">Показано {filteredRoute.length} из {squadronRoutePoints.length}</p>
                  <div className="atlas-route-list">
                    {filteredRoute.map((point, index) => (
                      <button
                        key={point.id}
                        type="button"
                        className="route-row as-button"
                        onClick={() => focusRoutePointOnMap(point)}
                        title="Показать систему на карте"
                      >
                        <span className="route-idx">{index + 1}</span>
                        <span className="route-name">{point.system_name}</span>
                        <span className="route-coords">{formatCoordinates(point)}</span>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {activeTab === 'route-finder' && (
            <AtlasRouteFinder onRouteFound={handleRouteFound} onProgress={setRouteSearchProgress} />
          )}

          {activeTab === 'ring-route' && (
            <AtlasRingRouteFinder onRouteFound={(route) => handleRouteFound(route, 'ring-route')} />
          )}

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

      {/* ── Карта ── */}
      <div className="atlas-map-area">
        {!sidebarOpen && (
          <button
            type="button"
            className="atlas-panel-toggle"
            onClick={() => setSidebarOpen(true)}
            title="Показать панель Atlas"
          >
            <IconAtlas size={14} /> Панель Atlas
          </button>
        )}
        <GalaxyMap
          // 3D-слой синхронизирован с пилюлями категорий, а не только со списком.
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
