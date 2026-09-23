'use client';

import { IconMapPin, IconPlane, IconGlobe, IconRefresh, IconCircleFill, IconExternalLink } from '@/components/Icons';
import { useState, useCallback, useEffect, Suspense, useMemo } from 'react';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import type { Hub, RouteSystem } from '@/types/hub';
import type { AtlasCandidate } from '@/types/atlas';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';
import { readableProgress, statusFromProgress, systemNameKey } from '@/lib/systemProgress';
import type { MarketResult } from './MarketResultMarkers';
import type { RouteSearchProgress } from '@/components/Atlas/AtlasRouteFinder';
import { loadAllSystemsData } from './AllSystemsPoints';
import { catalogNote, fetchGalaxyCatalogStatus } from '@/lib/galaxyCatalogStatus';
import { STAR_CLASS_COLORS, STAR_CLASS_LABELS, STAR_CLASS_LIST, type AllSystemsData } from '@/lib/galaxySystems';

const GalaxyScene = dynamic(
  () => import('./GalaxyScene').then((module) => module.GalaxyScene),
  { ssr: false },
);

type MapStatus = 'planned' | 'building' | 'done';
type StatusFilters = Record<MapStatus, boolean>;

type CoordinateSystem = {
  system_name: string;
  x?: number | null;
  y?: number | null;
  z?: number | null;
};

function hasCoordinates(item: CoordinateSystem): item is CoordinateSystem & { x: number; y: number; z: number } {
  return Number.isFinite(item.x) && Number.isFinite(item.y) && Number.isFinite(item.z);
}

function mapStatus(item: { status?: unknown; progress?: unknown }): MapStatus {
  // A non-null percentage is the source of truth everywhere Raven data is
  // available. This protects marker color/filtering from legacy rows whose
  // stored status was not updated alongside their progress value.
  if (readableProgress(item.progress) != null) return statusFromProgress(item.progress);
  if (item.status === 'done' || item.status === 'building' || item.status === 'planned') return item.status;
  return 'planned';
}

/** Render a physical system only once even if a legacy route contains duplicates. */
function uniqueBySystemName<T extends CoordinateSystem>(items: T[]): T[] {
  const byName = new Map<string, T>();

  for (const item of items) {
    const key = systemNameKey(item.system_name);
    if (!key) continue;

    const current = byName.get(key);
    if (!current) {
      byName.set(key, item);
      continue;
    }

    // Prefer a record with coordinates, then the lower route order. It keeps a
    // map point stable while still repairing a duplicate/partial row.
    const shouldReplace = (!hasCoordinates(current) && hasCoordinates(item))
      || (
        hasCoordinates(current) === hasCoordinates(item)
        && typeof (item as any).sort_order === 'number'
        && typeof (current as any).sort_order === 'number'
        && (item as any).sort_order < (current as any).sort_order
      );
    if (shouldReplace) byName.set(key, item);
  }

  return Array.from(byName.values());
}

function formatCoordinate(value: unknown): string {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
  return Number.isFinite(n) ? n.toFixed(1) : '?';
}

type GalaxyPick = {
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  main_star: string | null;
  star_type: string;
  star_giant_class: string | null;
  needs_permit: boolean | null;
  distance_from_sols: number | null;
  distance_from_sgra: number | null;
  source?: 'spansh' | 'edsm';
};

const ALL_CLASS_MASK = (1 << STAR_CLASS_LIST.length) - 1;
const EXOTIC_CLASSES = new Set([
  'brown_dwarf', 'neutron', 'black_hole', 'white_dwarf', 'wolf_rayet',
  'herbig_ae_be', 't_tauri', 'carbon', 's_type', 'ms_type',
]);
const EXOTIC_CLASS_MASK = STAR_CLASS_LIST.reduce(
  (mask, cls, index) => (EXOTIC_CLASSES.has(cls) ? mask | (1 << index) : mask),
  0,
);

function cssColor(rgb: [number, number, number]): string {
  return `rgb(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)})`;
}

function formatProgress(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? value.toLocaleString('ru-RU', { maximumFractionDigits: 2 })
    : '0';
}

export interface GalaxyMapProps {
  atlasCandidates?: AtlasCandidate[];
  squadronRouteSystems?: RouteSystem[];
  showOnlyMainRoute?: boolean;
  noMarketSystems?: Array<{ system_name: string; x: number; y: number; z: number }>;
  marketResults?: MarketResult[];
  routeSearchProgress?: RouteSearchProgress;
}

export default function GalaxyMap({
  atlasCandidates = [],
  squadronRouteSystems = [],
  showOnlyMainRoute = false,
  noMarketSystems = [],
  marketResults = [],
  routeSearchProgress,
}: GalaxyMapProps) {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [allRouteSystems, setAllRouteSystems] = useState<RouteSystem[]>([]);
  const [pilots, setPilots] = useState<any[]>([]);
  const [selectedHub, setSelectedHub] = useState<Hub | null>(null);
  const [selectedRouteSystem, setSelectedRouteSystem] = useState<RouteSystem | null>(null);
  const [systemSearch, setSystemSearch] = useState('');
  const [systemSearchLoading, setSystemSearchLoading] = useState(false);
  const [systemSearchError, setSystemSearchError] = useState('');
  const [selectedAtlasCandidate, setSelectedAtlasCandidate] = useState<AtlasCandidate | null>(null);
  const [selectedPilot, setSelectedPilot] = useState<any | null>(null);
  const [focusTarget, setFocusTarget] = useState<THREE.Vector3 | null>(null);
  const [resetCamera, setResetCamera] = useState(0);

  // Layer filters. In the old map the "known systems" checkbox hid markers
  // but not the orange line, while it also unexpectedly hid Atlas/pilots.
  const [showKnownSystems, setShowKnownSystems] = useState(true);
  const [showProjectRoute, setShowProjectRoute] = useState(true);
  const [showAtlasCandidates, setShowAtlasCandidates] = useState(true);
  const [showPilots, setShowPilots] = useState(true);
  const [showMarketResults, setShowMarketResults] = useState(true);
  const [showNoMarketSystems, setShowNoMarketSystems] = useState(true);
  const [showRegionLabels, setShowRegionLabels] = useState(true);
  const [showRegionBoundaries, setShowRegionBoundaries] = useState(true);
  const [showNebulae, setShowNebulae] = useState(true);
  const [showRingZone, setShowRingZone] = useState(true);
  // Экспериментальный слой «все системы» (данные: Spansh-дамп в БД).
  const [showAllSystems, setShowAllSystems] = useState(false);
  const [allSystemsData, setAllSystemsData] = useState<AllSystemsData | null>(null);
  const [allSystemsLoading, setAllSystemsLoading] = useState(false);
  const [allSystemsError, setAllSystemsError] = useState('');
  const [allSystemsInfo, setAllSystemsInfo] = useState('');
  const [galaxyPick, setGalaxyPick] = useState<GalaxyPick | null>(null);
  const [classMask, setClassMask] = useState(ALL_CLASS_MASK);
  const [suggestions, setSuggestions] = useState<GalaxyPick[]>([]);
  const [suggestOpen, setSuggestOpen] = useState(false);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [statusFilters, setStatusFilters] = useState<StatusFilters>({
    planned: true,
    building: true,
    done: true,
  });
  const compactMap = showOnlyMainRoute;

  // Ленивая загрузка облака точек (~36 МБ). Сначала спрашиваем статус каталога:
  // пока таблица пуста или идёт импорт, тянуть бинарник бессмысленно — вместо
  // 404 в консоли показываем, что именно происходит и где это исправить.
  useEffect(() => {
    if (!showAllSystems || allSystemsData) return;
    let cancelled = false;
    let timer: number | undefined;

    const attempt = async () => {
      setAllSystemsLoading(true);
      let retry = false;
      try {
        const status = await fetchGalaxyCatalogStatus();
        if (cancelled) return;
        const note = catalogNote(status);
        setAllSystemsError(note.error);
        setAllSystemsInfo(note.info);
        retry = note.retry;
        if (status.points.available) {
          const data = await loadAllSystemsData();
          if (!cancelled) {
            setAllSystemsData(data);
            setAllSystemsError('');
            setAllSystemsInfo('');
          }
          return;
        }
      } catch (err: any) {
        if (!cancelled) setAllSystemsError(err?.message || 'Не удалось загрузить все системы');
      } finally {
        if (!cancelled) setAllSystemsLoading(false);
      }
      // Импорт идёт фоном: раз в 20 секунд проверяем, не пора ли грузить облако.
      if (!cancelled && retry) timer = window.setTimeout(attempt, 20_000);
    };

    void attempt();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [showAllSystems, allSystemsData]);

  useEffect(() => {
    const query = systemSearch.trim();
    if (query.length < 2) {
      setSuggestions([]);
      setSuggestOpen(false);
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/galaxy/systems/search?q=${encodeURIComponent(query)}&limit=8`, { signal: ctrl.signal })
        .then((response) => response.json())
        .then((data) => {
          const rows = Array.isArray(data?.results) ? data.results as GalaxyPick[] : [];
          setSuggestions(rows);
          setSuggestIndex(0);
          setSuggestOpen(rows.length > 0);
        })
        .catch(() => undefined);
    }, 180);
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
  }, [systemSearch]);

  useEffect(() => {
    const loadHubs = async () => {
      try {
        const response = await fetch(`/api/hubs?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        setHubs(data.hubs || []);
      } catch {
        // Keep the last successful map state while a polling request fails.
      }
    };

    void loadHubs();
    const interval = window.setInterval(loadHubs, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadRoute = async () => {
      try {
        const response = await fetch(`/api/route?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        setAllRouteSystems(data.points || []);
      } catch {
        // Keep the last successful map state while a polling request fails.
      }
    };

    void loadRoute();
    const interval = window.setInterval(loadRoute, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const loadPilots = async () => {
      try {
        const response = await fetch(`/api/map/pilots?t=${Date.now()}`, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        setPilots(data.pilots || []);
      } catch {
        // Pilots are an optional layer; a failure should not break the map.
      }
    };

    void loadPilots();
    const interval = window.setInterval(loadPilots, 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const uniqueRouteSystems = useMemo(
    () => uniqueBySystemName(allRouteSystems).filter(hasCoordinates) as RouteSystem[],
    [allRouteSystems],
  );
  const uniqueHubs = useMemo(
    () => uniqueBySystemName(hubs).filter(hasCoordinates) as Hub[],
    [hubs],
  );
  const hubSystemNames = useMemo(
    () => new Set(uniqueHubs.map((hub) => systemNameKey(hub.system_name))),
    [uniqueHubs],
  );
  const knownSystemNames = useMemo(
    () => new Set([
      ...uniqueRouteSystems.map((system) => systemNameKey(system.system_name)),
      ...uniqueHubs.map((hub) => systemNameKey(hub.system_name)),
    ]),
    [uniqueRouteSystems, uniqueHubs],
  );

  // A hub is already a clickable known-system marker. Do not place a second
  // route sphere at exactly the same location, which caused duplicate pointer
  // events and additive glow/scale on one dot.
  const routeMarkerSystems = useMemo(
    () => uniqueRouteSystems.filter((system) => !hubSystemNames.has(systemNameKey(system.system_name))),
    [uniqueRouteSystems, hubSystemNames],
  );
  const visibleRouteMarkers = useMemo(
    () => routeMarkerSystems
      .filter((system) => statusFilters[mapStatus(system)])
      .map((system) => ({ ...system, status: mapStatus(system) })),
    [routeMarkerSystems, statusFilters],
  );
  const visibleHubs = useMemo(
    () => uniqueHubs
      .filter((hub) => statusFilters[mapStatus(hub)])
      .map((hub) => ({ ...hub, status: mapStatus(hub) })),
    [uniqueHubs, statusFilters],
  );
  const uniqueProjectRoute = useMemo(
    () => uniqueBySystemName(squadronRouteSystems).filter(hasCoordinates) as RouteSystem[],
    [squadronRouteSystems],
  );

  // Market-search overlays are informational only. When their system is
  // already represented by a route/hub marker, omit the duplicate visual dot.
  // Most importantly, never render a result without coordinates at [0,0,0].
  const visibleMarketResults = useMemo(
    () => uniqueBySystemName(marketResults)
      .filter(hasCoordinates)
      .filter((result) => !knownSystemNames.has(systemNameKey(result.system_name))) as MarketResult[],
    [marketResults, knownSystemNames],
  );
  const visibleNoMarketSystems = useMemo(
    () => uniqueBySystemName(noMarketSystems)
      .filter(hasCoordinates)
      .filter((system) => !knownSystemNames.has(systemNameKey(system.system_name))) as Array<{ system_name: string; x: number; y: number; z: number }>,
    [noMarketSystems, knownSystemNames],
  );

  // Polling replaces data objects every 30 seconds. Refresh a selected item
  // from the visible source so the detail card cannot retain an older Raven
  // percentage/status, and close it when a filter removes its marker.
  useEffect(() => {
    setSelectedHub((selected) => {
      if (!selected) return selected;
      if (!showKnownSystems) return null;
      return visibleHubs.find((hub) => hub.id === selected.id) || null;
    });
    setSelectedRouteSystem((selected) => {
      if (!selected) return selected;
      if (!showKnownSystems) return null;
      return visibleRouteMarkers.find((system) => system.id === selected.id) || null;
    });
  }, [showKnownSystems, visibleHubs, visibleRouteMarkers]);

  useEffect(() => {
    setSelectedAtlasCandidate((selected) => {
      if (!selected) return selected;
      if (compactMap || !showAtlasCandidates) return null;
      return atlasCandidates.find((candidate) => candidate.id === selected.id) || null;
    });
  }, [atlasCandidates, compactMap, showAtlasCandidates]);

  useEffect(() => {
    setSelectedPilot((selected: any) => {
      if (!selected) return selected;
      if (compactMap || !showPilots) return null;
      return pilots.find((pilot) => pilot.user_id === selected.user_id) || null;
    });
  }, [pilots, compactMap, showPilots]);

  const handleSelectHub = useCallback((hub: Hub | null) => {
    setSelectedHub(hub);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
    setGalaxyPick(null);
    if (hub) setFocusTarget(eliteToThreeCentered(hub));
  }, []);

  const handleSelectRouteSystem = useCallback((point: RouteSystem | null) => {
    setSelectedRouteSystem(point);
    setSelectedHub(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
    setGalaxyPick(null);
    if (point) setFocusTarget(eliteToThreeCentered(point));
  }, []);

  const handleSelectAtlasCandidate = useCallback((candidate: AtlasCandidate | null) => {
    setSelectedAtlasCandidate(candidate);
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedPilot(null);
    setGalaxyPick(null);
    if (candidate) setFocusTarget(eliteToThreeCentered(candidate));
  }, []);

  const handleSelectPilot = useCallback((pilot: any | null) => {
    setSelectedPilot(pilot);
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setGalaxyPick(null);
    if (pilot) setFocusTarget(eliteToThreeCentered(pilot));
  }, []);

  const openGalaxy = useCallback((data: GalaxyPick) => {
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
    setGalaxyPick(data);
    setFocusTarget(eliteToThreeCentered(data));
    setSuggestOpen(false);
    setAllSystemsError('');
  }, []);

  // Клик по точке облака «все системы»: id64 → карточка каталога, не «запланировано».
  const handlePickAllSystem = useCallback(async (id64: string) => {
    try {
      const response = await fetch(`/api/galaxy/systems/${encodeURIComponent(id64)}`);
      const data = await response.json();
      if (!response.ok || !data.name) throw new Error(data.error || 'Система не найдена');
      openGalaxy(data);
    } catch (error: any) {
      setAllSystemsError(error?.message || 'Не удалось открыть систему');
    }
  }, [openGalaxy]);

  const searchForSystem = useCallback(async () => {
    const query = systemSearch.trim();
    if (!query) return;
    setSystemSearchLoading(true); setSystemSearchError('');
    const key = systemNameKey(query);
    const knownRoute = uniqueRouteSystems.find((point) => systemNameKey(point.system_name) === key);
    const knownHub = uniqueHubs.find((hub) => systemNameKey(hub.system_name) === key);
    if (knownHub) { handleSelectHub(knownHub); setSystemSearchLoading(false); return; }
    if (knownRoute) { handleSelectRouteSystem({ ...knownRoute, status: mapStatus(knownRoute) }); setSystemSearchLoading(false); return; }
    // Сначала локальная таблица Spansh (все системы галактики), затем EDSM.
    try {
      const local = await fetch(`/api/galaxy/systems/search?q=${encodeURIComponent(query)}`);
      const localData = await local.json();
      const best = localData?.results?.[0];
      // Prefix hits belong in the dropdown. The Find button opens a system only
      // when the name matches, otherwise EDSM — never a fake "planned" marker.
      if (local.ok && best?.name && systemNameKey(best.name) === key) {
        openGalaxy(best);
        setSystemSearchLoading(false);
        return;
      }
    } catch {
      // local systems table is optional — fall through to EDSM
    }
    try {
      const response = await fetch(`/api/edsm/system?name=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok || !data.coords) throw new Error(data.error || 'Система не найдена');
      openGalaxy({
        id64: data.id64 != null ? String(data.id64) : '',
        name: data.name || query,
        x: Number(data.coords.x),
        y: Number(data.coords.y),
        z: Number(data.coords.z),
        main_star: typeof data.primaryStar?.type === 'string' ? data.primaryStar.type : null,
        star_type: 'unknown',
        star_giant_class: null,
        needs_permit: !!data.requirePermit,
        distance_from_sols: typeof data.distanceToSol === 'number' ? data.distanceToSol : null,
        distance_from_sgra: null,
        source: 'edsm',
      });
    } catch (error) { setSystemSearchError(error instanceof Error ? error.message : 'Система не найдена'); }
    finally { setSystemSearchLoading(false); }
  }, [handleSelectHub, handleSelectRouteSystem, openGalaxy, systemSearch, uniqueHubs, uniqueRouteSystems]);

  const handleClearSelection = useCallback(() => {
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
    setGalaxyPick(null);
  }, []);

  const handleResetView = useCallback(() => {
    setFocusTarget(null);
    setResetCamera((value) => value + 1);
    handleClearSelection();
  }, [handleClearSelection]);

  const focusLastProgressPoint = useCallback(() => {
    const progressed = uniqueRouteSystems
      .filter((point) => mapStatus(point) !== 'planned' || readableProgress(point.progress) != null)
      .sort((left, right) => Number((right as any).sort_order ?? 0) - Number((left as any).sort_order ?? 0));
    const point = progressed[0] || uniqueRouteSystems[uniqueRouteSystems.length - 1];
    if (point) handleSelectRouteSystem({ ...point, status: mapStatus(point) });
  }, [handleSelectRouteSystem, uniqueRouteSystems]);

  useEffect(() => {
    const focusLast = () => focusLastProgressPoint();
    window.addEventListener('atlas-focus-last-route', focusLast);
    return () => window.removeEventListener('atlas-focus-last-route', focusLast);
  }, [focusLastProgressPoint]);

  // Atlas sidebar rows dispatch these events so their advertised “focus on
  // map” behavior works without threading callbacks through every tab.
  useEffect(() => {
    const focusAtlasCandidate = (event: Event) => {
      const candidate = (event as CustomEvent<AtlasCandidate | null>).detail;
      if (candidate && hasCoordinates(candidate)) handleSelectAtlasCandidate(candidate);
      else if (!candidate) handleClearSelection();
    };
    const focusRoutePoint = (event: Event) => {
      const point = (event as CustomEvent<RouteSystem | null>).detail;
      if (point && hasCoordinates(point)) handleSelectRouteSystem(point);
      else if (!point) handleClearSelection();
    };

    window.addEventListener('atlas-focus-candidate', focusAtlasCandidate);
    window.addEventListener('atlas-focus-route-point', focusRoutePoint);
    return () => {
      window.removeEventListener('atlas-focus-candidate', focusAtlasCandidate);
      window.removeEventListener('atlas-focus-route-point', focusRoutePoint);
    };
  }, [handleClearSelection, handleSelectAtlasCandidate, handleSelectRouteSystem]);

  const selected = selectedHub || selectedRouteSystem || selectedAtlasCandidate || selectedPilot;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {routeSearchProgress?.active && (
        <div style={{ position: 'absolute', top: 14, left: 14, zIndex: 12, width: 290, padding: 12, borderRadius: 8, background: 'rgba(13,15,17,0.92)', border: '1px solid rgba(230,126,34,0.55)', boxShadow: '0 8px 24px rgba(0,0,0,0.35)', pointerEvents: 'none' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: '#eeeeee', fontSize: 12, fontWeight: 700 }}>
            <span>ПОИСК МАРШРУТА</span><span style={{ color: '#e67e22' }}>{routeSearchProgress.percent}%</span>
          </div>
          <div style={{ height: 6, margin: '9px 0 8px', borderRadius: 4, background: '#323538', overflow: 'hidden' }}>
            <div style={{ width: `${routeSearchProgress.percent}%`, height: '100%', background: 'linear-gradient(90deg,#e67e22,#22c55e)', transition: 'width .35s ease' }} />
          </div>
          <div style={{ color: '#d1d5db', fontSize: 11 }}>{routeSearchProgress.message}</div>
          <div style={{ display: 'flex', gap: 10, marginTop: 7, color: '#9ca3af', fontSize: 10, flexWrap: 'wrap' }}>
            <span>Этап: {routeSearchProgress.stage}</span>
            <span>{(routeSearchProgress.elapsedMs / 1000).toFixed(1)} с</span>
            {routeSearchProgress.systemsScanned != null && <span>Проверено: {routeSearchProgress.systemsScanned.toLocaleString('ru-RU')}</span>}
          </div>
          <div style={{ marginTop: 8, color: '#6b7280', fontSize: 10 }}>Карта обновится после получения координат EDSM</div>
        </div>
      )}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, background: 'rgba(13,15,17,0.85)', backdropFilter: 'blur(8px)', border: '1px solid #2d2f33', borderRadius: 8, padding: 12, minWidth: 220, maxWidth: 300, pointerEvents: 'none' }}>
        <div style={{ marginBottom: 8, pointerEvents: 'auto' }}>
          <button onClick={handleResetView} style={{ background: 'rgba(30,41,59,0.8)', border: '1px solid #3a3d40', color: '#9ca3af', padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', width: '100%' }}>
            <IconRefresh size={12} /> Сброс вида
          </button>
          <button onClick={focusLastProgressPoint} style={{ marginTop: 6, background: 'rgba(230,126,34,0.14)', border: '1px solid rgba(230,126,34,0.45)', color: '#e67e22', padding: '5px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit', width: '100%' }}>
            <IconMapPin size={12} /> Последняя стройка
          </button>
          <div style={{ display: 'flex', gap: 4, marginTop: 6, position: 'relative' }}>
            <input
              value={systemSearch}
              onChange={(event) => setSystemSearch(event.target.value)}
              onFocus={() => { if (suggestions.length > 0) setSuggestOpen(true); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') {
                  event.preventDefault();
                  setSuggestOpen(true);
                  setSuggestIndex((index) => Math.min(suggestions.length - 1, index + 1));
                } else if (event.key === 'ArrowUp') {
                  event.preventDefault();
                  setSuggestIndex((index) => Math.max(0, index - 1));
                } else if (event.key === 'Escape') {
                  setSuggestOpen(false);
                } else if (event.key === 'Enter') {
                  if (suggestOpen && suggestions[suggestIndex]) openGalaxy(suggestions[suggestIndex]);
                  else void searchForSystem();
                }
              }}
              placeholder="Поиск системы..."
              style={{ minWidth: 0, flex: 1, background: '#323538', border: '1px solid #3a3d40', color: '#eeeeee', padding: '5px 7px', borderRadius: 4, fontSize: 11 }}
            />
            <button onClick={() => void searchForSystem()} disabled={systemSearchLoading} style={{ background: 'rgba(59,130,246,.18)', border: '1px solid rgba(59,130,246,.5)', color: '#8bbcff', padding: '4px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>{systemSearchLoading ? '…' : 'Найти'}</button>
            {suggestOpen && suggestions.length > 0 && (
              <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, zIndex: 20, marginTop: 4, background: '#1a1c1f', border: '1px solid #3a3d40', borderRadius: 4, maxHeight: 220, overflow: 'auto' }}>
                {suggestions.map((hit, index) => (
                  <button
                    key={hit.id64 || hit.name}
                    type="button"
                    onMouseDown={(event) => { event.preventDefault(); openGalaxy(hit); }}
                    style={{ display: 'block', width: '100%', textAlign: 'left', background: index === suggestIndex ? 'rgba(230,126,34,0.16)' : 'transparent', border: 'none', color: '#eeeeee', padding: '6px 8px', cursor: 'pointer', fontSize: 11 }}
                  >
                    <div>{hit.name}</div>
                    <div style={{ color: '#9ca3af', fontSize: 10 }}>{hit.main_star || STAR_CLASS_LABELS[hit.star_type as keyof typeof STAR_CLASS_LABELS] || hit.star_type}</div>
                  </button>
                ))}
              </div>
            )}
          </div>
          {systemSearchError && <div style={{ color: '#f87171', fontSize: 10, marginTop: 4 }}>{systemSearchError}</div>}
        </div>

        <div style={{ marginBottom: 12, pointerEvents: 'auto' }}>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4, textTransform: 'uppercase' }}>Выбор точки маршрута</div>
          <select
            value={selectedRouteSystem?.system_name || ''}
            onChange={(event) => {
              const system = uniqueRouteSystems.find((point) => point.system_name === event.target.value);
              if (system) handleSelectRouteSystem({ ...system, status: mapStatus(system) });
            }}
            style={{ background: '#323538', border: '1px solid #3a3d40', color: '#eeeeee', padding: '6px 8px', borderRadius: 4, fontSize: 12, width: '100%', cursor: 'pointer' }}
          >
            <option value="">Выберите систему...</option>
            {uniqueRouteSystems.map((system) => (
              <option key={system.id} value={system.system_name}>{system.sort_order}. {system.system_name}</option>
            ))}
          </select>
        </div>

        <div style={{ marginBottom: 9, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: '#eeeeee', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showKnownSystems} onChange={(event) => setShowKnownSystems(event.target.checked)} />
            Маршрут и хабы ({routeMarkerSystems.length + uniqueHubs.length})
          </label>
          <label style={{ fontSize: 11, color: '#ffd166', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }} title="Экспериментально: известные системы галактики (Spansh). Каталог — ~2×10⁸ систем, в слое показана равномерная выборка; первое включение скачивает ~35 МБ.">
            <input type="checkbox" checked={showAllSystems} onChange={(event) => setShowAllSystems(event.target.checked)} />
            Все системы{allSystemsData ? ` (${(allSystemsData.count / 1000).toFixed(0)}k)` : ''} ⚗
          </label>
          {showAllSystems && allSystemsData && (
            <div style={{ paddingLeft: 22, display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
              <button type="button" onClick={() => setClassMask(ALL_CLASS_MASK)} style={{ fontSize: 9, color: '#ffd166', background: 'transparent', border: '1px solid #3a3d40', borderRadius: 3, cursor: 'pointer' }}>Все</button>
              <button type="button" onClick={() => setClassMask(EXOTIC_CLASS_MASK)} style={{ fontSize: 9, color: '#c4b5fd', background: 'transparent', border: '1px solid #3a3d40', borderRadius: 3, cursor: 'pointer' }}>Редкие</button>
              {STAR_CLASS_LIST.map((cls, index) => (
                <label key={cls} title={STAR_CLASS_LABELS[cls]} style={{ display: 'flex', alignItems: 'center', gap: 2, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={(classMask & (1 << index)) !== 0}
                    onChange={() => setClassMask((mask) => mask ^ (1 << index))}
                  />
                  <span style={{ width: 8, height: 8, borderRadius: 8, background: cssColor(STAR_CLASS_COLORS[index]), display: 'inline-block' }} />
                </label>
              ))}
            </div>
          )}
          {(allSystemsLoading || allSystemsError || allSystemsInfo) && (
            <div style={{ fontSize: 10, color: allSystemsError ? '#f87171' : '#ffd166', paddingLeft: 22 }}>
              {allSystemsError
                ? allSystemsError
                : allSystemsInfo
                  ? allSystemsInfo
                  : 'Загрузка всех систем…'}
            </div>
          )}
          {!compactMap && (
            <>
              <label style={{ fontSize: 11, color: '#60a5fa', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showProjectRoute} onChange={(event) => setShowProjectRoute(event.target.checked)} />
                Маршрут проекта
              </label>
              <label style={{ fontSize: 11, color: '#e91e63', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showAtlasCandidates} onChange={(event) => setShowAtlasCandidates(event.target.checked)} />
                Atlas-кандидаты ({atlasCandidates.length})
              </label>
              <label style={{ fontSize: 11, color: '#00bcd4', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showPilots} onChange={(event) => setShowPilots(event.target.checked)} />
                Пилоты ({pilots.length})
              </label>
              <label style={{ fontSize: 11, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showMarketResults} onChange={(event) => setShowMarketResults(event.target.checked)} />
                Системы с рынками ({visibleMarketResults.length})
              </label>
              <label style={{ fontSize: 11, color: '#ef4444', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                <input type="checkbox" checked={showNoMarketSystems} onChange={(event) => setShowNoMarketSystems(event.target.checked)} />
                Системы без рынков ({visibleNoMarketSystems.length})
              </label>
              <div style={{ borderTop: '1px solid #2d2f33', marginTop: 5, paddingTop: 5 }}>
                <label style={{ fontSize: 11, color: '#d8e8ff', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={showRegionLabels} onChange={(event) => setShowRegionLabels(event.target.checked)} /> Имена секторов</label>
                <label style={{ fontSize: 11, color: '#ff9a3d', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={showRegionBoundaries} onChange={(event) => setShowRegionBoundaries(event.target.checked)} /> Границы секторов</label>
                <label style={{ fontSize: 11, color: '#b48cff', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={showNebulae} onChange={(event) => setShowNebulae(event.target.checked)} /> Туманности</label>
                <label style={{ fontSize: 11, color: '#e67e22', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={showRingZone} onChange={(event) => setShowRingZone(event.target.checked)} /> Оранжевый пояс</label>
              </div>
            </>
          )}
        </div>

        <div style={{ borderTop: '1px solid #2d2f33', paddingTop: 8, marginBottom: 8, pointerEvents: 'auto' }}>
          <div style={{ fontSize: 10, color: '#6b7280', marginBottom: 4, textTransform: 'uppercase' }}>Фильтр точек по статусу</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {([
              ['planned', 'Запланировано', '#9ca3af'],
              ['building', 'Строительство', '#e67e22'],
              ['done', 'Завершено', '#22c55e'],
            ] as Array<[MapStatus, string, string]>).map(([status, label, color]) => (
              <label key={status} style={{ fontSize: 10, color, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={statusFilters[status]}
                  onChange={(event) => setStatusFilters((current) => ({ ...current, [status]: event.target.checked }))}
                />
                {label}
              </label>
            ))}
          </div>
        </div>

        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>
          <span style={{ color: '#22c55e' }}><IconCircleFill size={8} /></span> Завершён
          <span style={{ marginLeft: 8, color: '#e67e22' }}><IconCircleFill size={8} /></span> Строительство
          <span style={{ marginLeft: 8, color: '#9ca3af' }}><IconCircleFill size={8} /></span> Запланирован
        </div>
        {!compactMap && (
          <div style={{ fontSize: 11, color: '#9ca3af' }}>
            <span style={{ color: '#3b82f6' }}><IconCircleFill size={8} /></span> Маршрут проекта
          </div>
        )}
      </div>

      {galaxyPick && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.92)', backdropFilter: 'blur(8px)', border: '1px solid #3a3d40', borderRadius: 8, padding: 12, minWidth: 240, maxWidth: 320, pointerEvents: 'auto' }}>
          <Link href={`/system/${encodeURIComponent(galaxyPick.name)}`} style={{ textDecoration: 'none' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#ffd166', display: 'flex', alignItems: 'center', gap: 6 }}>
              {galaxyPick.name}
              <IconExternalLink size={12} />
            </div>
          </Link>
          <div style={{ marginTop: 6, fontSize: 12, color: '#eeeeee' }}>
            {STAR_CLASS_LABELS[galaxyPick.star_type as keyof typeof STAR_CLASS_LABELS] || galaxyPick.star_type}
            {galaxyPick.star_giant_class && galaxyPick.star_giant_class !== 'dwarf' ? ` · ${galaxyPick.star_giant_class === 'supergiant' ? 'сверхгигант' : 'гигант'}` : ''}
          </div>
          {galaxyPick.main_star && <div style={{ marginTop: 2, fontSize: 11, color: '#9ca3af' }}>{galaxyPick.main_star}</div>}
          <div style={{ marginTop: 6, fontSize: 12, color: '#9ca3af' }}>
            <IconMapPin size={12} /> {formatCoordinate(galaxyPick.x)}, {formatCoordinate(galaxyPick.y)}, {formatCoordinate(galaxyPick.z)}
          </div>
          <div style={{ marginTop: 4, fontSize: 11, color: '#9ca3af' }}>
            До Sol: {galaxyPick.distance_from_sols != null ? `${Number(galaxyPick.distance_from_sols).toFixed(1)} св.лет` : '—'}
            {' · '}до Sgr A*: {galaxyPick.distance_from_sgra != null ? `${Number(galaxyPick.distance_from_sgra).toFixed(1)} св.лет` : '—'}
          </div>
          {galaxyPick.needs_permit && <div style={{ marginTop: 4, fontSize: 11, color: '#f87171' }}>Нужен permit</div>}
          <div style={{ marginTop: 4, fontSize: 10, color: '#6b7280' }}>{galaxyPick.source === 'edsm' ? 'EDSM' : 'Каталог Spansh'} · не стройка маршрута</div>
          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(galaxyPick.name)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none' }}>EDSM</a>
            <a href={`https://ravencolonial.com/#sys=${encodeURIComponent(galaxyPick.name)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#e67e22', textDecoration: 'none' }}>Raven</a>
            {galaxyPick.id64 && <a href={`https://spansh.co.uk/system/${encodeURIComponent(galaxyPick.id64)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#ffd166', textDecoration: 'none' }}>Spansh</a>}
            <a href={`https://inara.cz/elite/starsystem/?search=${encodeURIComponent(galaxyPick.name)}`} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#9ca3af', textDecoration: 'none' }}>Inara</a>
          </div>
        </div>
      )}

      {selected && !galaxyPick && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.9)', backdropFilter: 'blur(8px)', border: '1px solid #2d2f33', borderRadius: 8, padding: 12, minWidth: 220, maxWidth: 300, pointerEvents: 'auto' }}>
          <Link href={`/system/${encodeURIComponent((selected as any).system_name || (selected as any).name)}`} style={{ textDecoration: 'none' }}>
            <div style={{ fontWeight: 700, fontSize: 15, color: '#e67e22', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6 }}>
              {(selected as any).system_name || (selected as any).name}
              <span style={{ fontSize: 12 }}><IconExternalLink size={12} /></span>
            </div>
          </Link>
          <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>
            <IconMapPin size={12} /> {formatCoordinate((selected as any).x)}, {formatCoordinate((selected as any).y)}, {formatCoordinate((selected as any).z)}
          </div>
          {(selected as any).status && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Статус: {' '}
              <span style={{ color: (selected as any).status === 'done' ? '#22c55e' : (selected as any).status === 'building' ? '#e67e22' : '#9ca3af' }}>
                {(selected as any).status === 'done' ? 'Завершён' : (selected as any).status === 'building' ? 'Строительство' : 'Запланирован'}
              </span>
            </div>
          )}
          {(selected as any).progress != null && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#eeeeee' }}>Прогресс: {formatProgress((selected as any).progress)}%</div>
          )}
          {(selected as any).total_delivered != null && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Доставлено: {Number((selected as any).total_delivered).toLocaleString('ru')}</div>
          )}
          {(selected as any).distance != null && (
            <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Расстояние: {Number((selected as any).distance).toFixed(1)} св.лет</div>
          )}
          {(selected as any).type && <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Тип: {(selected as any).type}</div>}

          <div style={{ marginTop: 10, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <a
              href={`https://ravencolonial.com/#sys=${encodeURIComponent((selected as any).system_name || (selected as any).name)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: '#e67e22', textDecoration: 'none', padding: '3px 8px', background: 'rgba(230,126,34,0.1)', borderRadius: 4, border: '1px solid rgba(230,126,34,0.3)' }}
            >
              <IconPlane size={10} /> Raven <IconExternalLink size={12} />
            </a>
            <a
              href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent((selected as any).system_name || (selected as any).name)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{ fontSize: 11, color: '#3b82f6', textDecoration: 'none', padding: '3px 8px', background: 'rgba(59,130,246,0.1)', borderRadius: 4, border: '1px solid rgba(59,130,246,0.3)' }}
            >
              <IconGlobe size={10} /> EDSM <IconExternalLink size={12} />
            </a>
          </div>
        </div>
      )}

      <Canvas
        camera={{ position: [0, 35000, 0], fov: 45, near: 1, far: 200000 }}
        gl={{ antialias: true, alpha: false, powerPreference: 'high-performance' }}
        style={{ background: '#000000', width: '100%', height: '100%' }}
        frameloop="demand"
      >
        <Suspense fallback={null}>
          <GalaxyScene
            hubs={visibleHubs}
            allRouteSystems={visibleRouteMarkers}
            routeLinePoints={uniqueRouteSystems}
            squadronRouteSystems={uniqueProjectRoute}
            atlasCandidates={atlasCandidates}
            pilots={pilots}
            noMarketSystems={visibleNoMarketSystems}
            marketResults={visibleMarketResults}
            showKnownSystems={showKnownSystems}
            showSquadronRoute={!compactMap && showProjectRoute}
            showAtlasCandidates={!compactMap && showAtlasCandidates}
            showPilots={!compactMap && showPilots}
            showMarketResults={!compactMap && showMarketResults}
            showNoMarketSystems={!compactMap && showNoMarketSystems}
            showRegionLabels={showRegionLabels}
            showRegionBoundaries={showRegionBoundaries}
            showNebulae={showNebulae}
            showRingZone={showRingZone}
            allSystemsData={allSystemsData}
            showAllSystems={showAllSystems && !!allSystemsData}
            allSystemsMask={classMask}
            selectedAllSystem={galaxyPick}
            onPickAllSystem={handlePickAllSystem}
            onEmptyMapClick={handleClearSelection}
            onSelectHub={handleSelectHub}
            onSelectRouteSystem={handleSelectRouteSystem}
            onSelectAtlasCandidate={handleSelectAtlasCandidate}
            onSelectPilot={handleSelectPilot}
            selectedHubId={selectedHub?.id ?? null}
            selectedRouteSystemId={selectedRouteSystem?.id ?? null}
            selectedAtlasCandidateId={selectedAtlasCandidate?.id ?? null}
            selectedPilotId={selectedPilot?.user_id ?? null}
            focusTarget={focusTarget}
            resetCamera={resetCamera}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
