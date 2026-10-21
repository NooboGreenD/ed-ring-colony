'use client';

import { GalaxyMapClient } from '@/components/GalaxyMap/GalaxyMapClient';
import Link from 'next/link';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAtlasData } from '@/hooks/useAtlasData';
import { AtlasProvider, useAtlas } from '@/components/Atlas/AtlasContext';
import AtlasNearbySearch from '@/components/Atlas/AtlasNearbySearch';
import { AtlasSearchPanel } from '@/components/Atlas/AtlasSearchPanel';
import { AtlasCandidateList } from '@/components/Atlas/AtlasCandidateList';
import { AtlasSearchHistory } from '@/components/Atlas/AtlasSearchHistory';
import { AtlasFavorites } from '@/components/Atlas/AtlasFavorites';
import AtlasRouteFinder from '@/components/Atlas/AtlasRouteFinder';
import AtlasMarketSearch from '@/components/Atlas/AtlasMarketSearch';
import AtlasRingRouteFinder from '@/components/Atlas/AtlasRingRouteFinder';
import { AtlasPowerplayPanel } from '@/components/Atlas/AtlasPowerplayPanel';
import { useAtlasPowerplay } from '@/hooks/usePowerplayLayer';
import { AtlasFactionsPanel } from '@/components/Atlas/AtlasFactionsPanel';
import { useAtlasFactions } from '@/hooks/useFactionsLayer';
import type { GalaxyMapFactions, GalaxyMapPowerplay } from '@/components/GalaxyMap/GalaxyMap';
import { toast } from '@/components/ui/Toaster';
import {
  IconAtlas,
  IconDownload,
  IconGlobe,
  IconMap,
  IconPower,
  IconRoute,
  IconSearch,
  IconShieldHalf,
  IconStore,
  IconTrash,
  IconX,
} from '@/components/Icons';
import type { AtlasCandidate, AtlasFavorite, AtlasSearchSession, WorldType } from '@/types/atlas';
import type { RoutePoint } from '@/components/GalaxyMap/useGalaxyData';
import {
  finishAtlasSearchProgress,
  publishAtlasSearchPoints,
  publishAtlasSearchProgress,
  startAtlasSearchProgress,
  type AtlasSearchPoint,
} from '@/lib/atlasSearchProgress';
import { countByWorldType, downloadCsv, favoriteKey, filterCandidates, formatCoordinates, worldTypeLabel } from '@/lib/atlas';

import { atlasFocusFromParams } from '@/lib/stationSearch';
import { systemId64, systemPageHref } from '@/lib/systemIdentity';

type ProjectItem = {
  id: number;
  name: string;
  description: string | null;
  color: string;
  squadron_id: number | null;
  squadron_name?: string;
};

type AtlasTab = 'search' | 'route' | 'route-finder' | 'ring-route' | 'market' | 'nearby' | 'powerplay' | 'factions';

const TABS: { id: AtlasTab; label: string; icon: React.ReactNode; hint: string }[] = [
  { id: 'search', label: 'Поиск', icon: <IconSearch size={14} />, hint: 'Поиск миров по типам (Alt+1)' },
  { id: 'route', label: 'Маршрут', icon: <IconMap size={14} />, hint: 'Маршрут проекта (Alt+2)' },
  { id: 'route-finder', label: 'Маршрут A→B', icon: <IconRoute size={14} />, hint: 'Построение маршрута между системами (Alt+3)' },
  { id: 'ring-route', label: 'Кольцо', icon: <IconGlobe size={14} />, hint: 'Галактическое кольцо колонизации (Alt+4)' },
  { id: 'market', label: 'Рынок', icon: <IconStore size={14} />, hint: 'Поиск товаров для стройки (Alt+5)' },
  { id: 'nearby', label: 'Поблизости', icon: <IconGlobe size={14} />, hint: 'Все системы в сфере/кубе 1–50 св.л. (Alt+6)' },
  { id: 'powerplay', label: 'PowerPlay', icon: <IconPower size={14} />, hint: 'Системы под контролем держав PowerPlay (Alt+7)' },
  { id: 'factions', label: 'Фракции', icon: <IconShieldHalf size={14} />, hint: 'Минорные фракции: поиск и их системы на карте (Alt+8)' },
];

const CANDIDATE_PAGE_SIZE = 200;
const MAX_POLL_ATTEMPTS = 90; // 3 минуты при интервале 2 с

const TAB_IDS = new Set<string>(TABS.map((tab) => tab.id));

function parseTab(value: string | null): AtlasTab {
  return value && TAB_IDS.has(value) ? (value as AtlasTab) : 'search';
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
  const stationFocus = useMemo(() => atlasFocusFromParams(searchParams), [searchParams]);
  // Переход из карточки системы (`/system/[name]`) или поиска станций: вкладки
  // PowerPlay и «Фракции» открывают эту систему на своём слое (`focus_id64`).
  const focusId64 = useMemo(() => systemId64(searchParams.get('focus_id64')), [searchParams]);
  const focusFrom = searchParams.get('from') === 'system' ? 'system' : 'stations';
  const layerFocusRequested = Boolean(stationFocus || focusId64);
  const { candidates, error, setCandidates } = useAtlasData();
  const { favorites, sessions, recordSearch, favoriteKeys } = useAtlas();

  const [selectedCandidate, setSelectedCandidate] = useState<AtlasCandidate | null>(null);
  const [activeFilter, setActiveFilter] = useState<string>('all');
  const [isSearching, setIsSearching] = useState(false);
  const [candidateSearchProgress, setCandidateSearchProgress] = useState<{
    elapsedMs: number;
    phase: string;
    found: number;
    status: string;
    serverPercent?: number;
    serverMessage?: string;
  }>({ elapsedMs: 0, phase: 'Подготовка', found: 0, status: 'idle' });
  const [candidateSearchStartedAt, setCandidateSearchStartedAt] = useState<number | null>(null);
  const [candidateTotal, setCandidateTotal] = useState<number | null>(null);
  const [candidatesLoadingMore, setCandidatesLoadingMore] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const initialMarketSystem = searchParams.get('system') || '';
  const [activeTab, setActiveTab] = useState<AtlasTab>(() => parseTab(searchParams.get('tab')));
  // Слой PowerPlay: данные и фильтр общие для вкладки и 3D-карты.
  const powerplay = useAtlasPowerplay({ tabActive: activeTab === 'powerplay' });
  const powerplayLayer = useMemo<GalaxyMapPowerplay>(() => ({
    visible: powerplay.visible,
    systems: powerplay.visibleSystems,
    allSystems: powerplay.systems,
    selected: powerplay.selected,
    onSelect: (system) => powerplay.select(system),
    onVisibleChange: powerplay.setVisible,
    status: powerplay.status,
    overviewRequest: powerplay.overviewRequest,
    onShowSystem: powerplay.showSystem,
  }), [powerplay.visible, powerplay.visibleSystems, powerplay.systems, powerplay.selected, powerplay.select, powerplay.setVisible, powerplay.status, powerplay.overviewRequest, powerplay.showSystem]);
  // Державы — в пузыре вокруг Sol, а карта открывается обзором всей галактики:
  // при первом открытии вкладки камера сама летит к системам слоя.
  const powerplayOverviewShown = useRef(layerFocusRequested);
  const { focusOverview: focusPowerplayOverview } = powerplay;
  useEffect(() => {
    if (activeTab !== 'powerplay' || powerplay.status !== 'ready' || !powerplay.visible || powerplayOverviewShown.current) return;
    if (powerplay.visibleSystems.length === 0) return;
    powerplayOverviewShown.current = true;
    focusPowerplayOverview();
  }, [activeTab, focusPowerplayOverview, powerplay.status, powerplay.visible, powerplay.visibleSystems.length]);

  // Слой «Фракции»: населённые системы и выбранные минорные фракции — общие для вкладки и карты.
  const factions = useAtlasFactions({ tabActive: activeTab === 'factions' });
  const factionsSelectedColors = useMemo(
    () => new Map(factions.selection.map((item) => [item.id, item.color] as [number, string])),
    [factions.selection],
  );
  const factionsCount = useMemo(() => factions.points.reduce((sum, point) => sum + (point.background ? 0 : 1), 0), [factions.points]);
  const factionsLayer = useMemo<GalaxyMapFactions>(() => ({
    visible: factions.visible,
    points: factions.points,
    count: factionsCount,
    selected: factions.selected,
    onSelect: (point) => factions.select(point),
    onVisibleChange: factions.setVisible,
    status: factions.status,
    selectedCount: factions.selection.length,
    selectedColors: factionsSelectedColors,
    onAddFaction: factions.addFaction,
    onRemoveFaction: factions.removeFaction,
    overviewRequest: factions.overviewRequest,
  }), [factions.visible, factions.points, factionsCount, factions.selected, factions.select, factions.setVisible, factions.status, factions.selection.length, factionsSelectedColors, factions.addFaction, factions.removeFaction, factions.overviewRequest]);
  // Населённые системы — в пузыре вокруг Sol: при первом открытии вкладки камера летит к ним.
  const factionsOverviewShown = useRef(layerFocusRequested);
  const { focusOverview: focusFactionsOverview } = factions;
  useEffect(() => {
    if (activeTab !== 'factions' || factionsOverviewShown.current || !factions.visible) return;
    if (factions.points.length === 0) return;
    factionsOverviewShown.current = true;
    focusFactionsOverview();
  }, [activeTab, factions.points.length, factions.visible, focusFactionsOverview]);

  // Система из ссылки открывается на слое, как только слой загрузился.
  const layerFocusDone = useRef<string | null>(null);
  const { showSystem: showPowerplaySystem } = powerplay;
  const { showSystem: showFactionSystem } = factions;
  useEffect(() => {
    if (!layerFocusRequested) return;
    const name = stationFocus?.name ?? '';
    const key = `${activeTab}|${focusId64 ?? ''}|${name}`;
    if (layerFocusDone.current === key) return;
    if (activeTab === 'powerplay' && powerplay.status === 'ready') {
      layerFocusDone.current = key;
      showPowerplaySystem({ id64: focusId64, name });
    } else if (activeTab === 'factions' && factions.status === 'ready') {
      layerFocusDone.current = key;
      showFactionSystem({ id64: focusId64, name, x: stationFocus?.x, y: stationFocus?.y, z: stationFocus?.z });
    }
  }, [activeTab, factions.status, focusId64, layerFocusRequested, powerplay.status, showFactionSystem, showPowerplaySystem, stationFocus]);

  const [projects, setProjects] = useState<ProjectItem[]>([]);
  const [selectedProject, setSelectedProject] = useState<number | null>(null);
  const [squadronRoutePoints, setSquadronRoutePoints] = useState<RoutePoint[]>([]);
  const [routeFinderPoints, setRouteFinderPoints] = useState<RoutePoint[]>([]);
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

  /* ── Alt+1..7 — быстрое переключение вкладок ── */
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

  /**
   * Кольцо сохранено в проект: если этот проект уже открыт на карте,
   * перечитываем его системы, чтобы сохранённый маршрут появился сразу.
   */
  const handleRingSaved = useCallback((projectId: number) => {
    if (selectedProject === projectId) void loadProjectSystems(projectId);
  }, [loadProjectSystems, selectedProject]);

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
    setCandidateSearchProgress({ elapsedMs: 0, phase: 'Подготовка', found: 0, status: 'pending', serverPercent: 0 });
    stopPolling();
    // Новый поиск полностью вытесняет прошлый: точки и счётчики не смешиваются.
    startAtlasSearchProgress({
      kind: 'world',
      title: 'ПОИСК МИРОВ ATLAS',
      stage: 'coords',
      percent: 2,
      message: `Определяем координаты системы ${params.reference_system}`,
      cube: null,
      beam: null,
      counters: { 'Система отсчёта': params.reference_system },
      summary: '',
    });

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
        finishAtlasSearchProgress({ message });
        return;
      }
      if (!json.session_id) {
        toast('Сервер не вернул идентификатор поиска', 'error');
        setIsSearching(false);
        setCandidateSearchStartedAt(null);
        finishAtlasSearchProgress({ message: 'Сервер не вернул идентификатор поиска' });
        return;
      }

      searchSessionRef.current = json.session_id;
      recordSearch({
        id: json.session_id,
        reference_system: params.reference_system,
        cube_size_ly: params.cube_size_ly,
        world_types: params.world_types,
      });

      // Куб поиска и опорная точка — на карту: сразу видно, где идёт работа.
      const reference = json.reference || null;
      publishAtlasSearchProgress({
        active: true,
        kind: 'world',
        stage: 'catalog',
        percent: 5,
        message: `Поиск вокруг ${params.reference_system}`,
        cube: reference
          ? { cx: reference.x, cy: reference.y, cz: reference.z, half: params.cube_size_ly / 2 }
          : null,
        beam: reference ? { x: reference.x, y: reference.y, z: reference.z, label: params.reference_system } : null,
      });

      const startedAt = Date.now();
      let attempts = 0;
      let failures = 0;
      pollRef.current = window.setInterval(async () => {
        attempts += 1;
        if (attempts > MAX_POLL_ATTEMPTS) {
          stopPolling();
          setIsSearching(false);
          setCandidateSearchStartedAt(null);
          setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Таймаут' }));
          finishAtlasSearchProgress({ message: 'Поиск идёт слишком долго — откройте историю позже' });
          toast('Поиск идёт слишком долго — откройте историю позже', 'error');
          return;
        }
        try {
          const check = await fetch(`/api/atlas/search?session_id=${encodeURIComponent(json.session_id)}`);
          const data = await check.json().catch(() => ({}));
          failures = 0;
          const serverProgress = (data.progress || {}) as {
            stage?: string;
            percent?: number;
            message?: string;
            found?: number;
            batch?: Array<Record<string, unknown>>;
            stats?: Record<string, number>;
          };
          const foundNow = Number(data.session?.total_found || serverProgress.found || 0);
          const serverPercent = typeof serverProgress.percent === 'number'
            ? serverProgress.percent
            : Math.min(95, Math.round(((Date.now() - startedAt) / 60_000) * 90));

          setCandidateSearchProgress((current) => ({
            ...current,
            found: foundNow,
            status: data.session?.status || current.status,
            serverPercent,
            serverMessage: typeof serverProgress.message === 'string' && serverProgress.message
              ? serverProgress.message
              : current.serverMessage,
          }));

          // Процесс поиска рисуем на карте: этап, куб, луч и найденные точки.
          if (Array.isArray(serverProgress.batch) && serverProgress.batch.length > 0) {
            const points: AtlasSearchPoint[] = serverProgress.batch
              .filter((point) => Number.isFinite(Number(point?.x)) && Number.isFinite(Number(point?.y)) && Number.isFinite(Number(point?.z)))
              .map((point) => {
                const name = String(point.name || '');
                const bodyName = String(point.body_name || '');
                return {
                  name,
                  x: Number(point.x),
                  y: Number(point.y),
                  z: Number(point.z),
                  kind: 'found' as const,
                  label: bodyName && bodyName !== name
                    ? `${worldTypeLabel(String(point.world_type) as WorldType)} — ${bodyName}`
                    : worldTypeLabel(String(point.world_type) as WorldType),
                };
              });
            publishAtlasSearchPoints(points);
          }
          publishAtlasSearchProgress({
            active: true,
            kind: 'world',
            title: 'ПОИСК МИРОВ ATLAS',
            stage: typeof serverProgress.stage === 'string' ? serverProgress.stage : 'scan',
            percent: serverPercent,
            message: typeof serverProgress.message === 'string' && serverProgress.message
              ? serverProgress.message
              : 'Поиск миров',
            counters: {
              'Найдено': foundNow,
              ...(serverProgress.stats || {}),
            },
          });

          if (data.session?.status === 'completed') {
            stopPolling();
            try {
              await collectCandidates(json.session_id);
            } catch {
              setCandidates(Array.isArray(data.candidates) ? data.candidates : []);
            }
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'completed', phase: 'Готово', serverPercent: 100 }));
            const total = Number(data.total_candidates || 0);
            finishAtlasSearchProgress({
              stage: 'completed',
              percent: 100,
              message: `Поиск завершён: ${total.toLocaleString('ru-RU')} объектов`,
              summary: 'Найденное сохранено в базе проекта — повторный поиск в этом районе пойдёт быстрее.',
              beam: null,
              counters: { 'Найдено': total },
            });
            toast(`Найдено объектов: ${total.toLocaleString('ru-RU')}`, 'success');
          } else if (data.session?.status === 'failed') {
            stopPolling();
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Ошибка' }));
            const message = data.session.error_message || 'Поиск завершился ошибкой';
            finishAtlasSearchProgress({ message });
            toast(message, 'error');
          }
        } catch {
          failures += 1;
          // Пара сетевых сбоев — не повод ронять поиск, который идёт на сервере.
          if (failures >= 5) {
            stopPolling();
            setIsSearching(false);
            setCandidateSearchStartedAt(null);
            setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Связь потеряна' }));
            finishAtlasSearchProgress({ message: 'Не удалось получить результат поиска' });
            toast('Не удалось получить результат поиска', 'error');
          }
        }
      }, 2000);
    } catch (err: any) {
      toast(err.message || 'Ошибка поиска', 'error');
      setIsSearching(false);
      setCandidateSearchStartedAt(null);
      setCandidateSearchProgress((current) => ({ ...current, status: 'failed', phase: 'Ошибка' }));
      finishAtlasSearchProgress({ message: err?.message || 'Ошибка поиска' });
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
            <AtlasRouteFinder onRouteFound={handleRouteFound} />
          )}

          {activeTab === 'ring-route' && (
            <AtlasRingRouteFinder
              onRouteFound={(route) => handleRouteFound(route, 'ring-route')}
              projects={projects}
              onSavedToProject={handleRingSaved}
            />
          )}

          {activeTab === 'nearby' && <AtlasNearbySearch initialSystem={initialMarketSystem || 'Sol'} />}

          {activeTab === 'powerplay' && <AtlasPowerplayPanel powerplay={powerplay} />}

          {activeTab === 'factions' && <AtlasFactionsPanel factions={factions} />}

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
        {stationFocus && (focusFrom === 'system' ? (
          <div className="station-atlas-focus"><strong>{stationFocus.name}</strong> — система из карточки системы
            <Link href={systemPageHref(stationFocus.name)}>← Вернуться к карточке системы</Link>
          </div>
        ) : (
          <div className="station-atlas-focus"><strong>{stationFocus.name}</strong> — система из поиска станций
            <Link href="/station-search">← Вернуться к поиску по станциям</Link>
            <Link href={systemPageHref(stationFocus.name)}>Карточка системы →</Link>
          </div>
        ))}
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
        <GalaxyMapClient
          loadingFallback={(
            <div className="atlas-map-loading">
              Загрузка 3D-движка…
            </div>
          )}
          // 3D-слой синхронизирован с пилюлями категорий, а не только со списком.
          atlasCandidates={filteredCandidates}
          squadronRouteSystems={allRoutePoints}
          noMarketSystems={noMarketSystems}
          focusSystem={stationFocus}
          marketResults={stationFocus ? [...marketResults, { system_name: stationFocus.name, x: stationFocus.x, y: stationFocus.y, z: stationFocus.z, distance: 0 }] : marketResults}
          powerplay={powerplayLayer}
          factions={factionsLayer}
        />
      </div>
    </div>
  );
}
