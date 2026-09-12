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
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '?';
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
  const [searchSystem, setSearchSystem] = useState<RouteSystem | null>(null);
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
  const [statusFilters, setStatusFilters] = useState<StatusFilters>({
    planned: true,
    building: true,
    done: true,
  });
  const compactMap = showOnlyMainRoute;

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
    () => [...routeMarkerSystems, ...(searchSystem ? [searchSystem] : [])]
      .filter((system) => statusFilters[mapStatus(system)])
      .map((system) => ({ ...system, status: mapStatus(system) })),
    [routeMarkerSystems, searchSystem, statusFilters],
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
    if (hub) setFocusTarget(eliteToThreeCentered(hub));
  }, []);

  const handleSelectRouteSystem = useCallback((point: RouteSystem | null) => {
    setSelectedRouteSystem(point);
    setSelectedHub(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
    if (point) setFocusTarget(eliteToThreeCentered(point));
  }, []);

  const handleSelectAtlasCandidate = useCallback((candidate: AtlasCandidate | null) => {
    setSelectedAtlasCandidate(candidate);
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedPilot(null);
    if (candidate) setFocusTarget(eliteToThreeCentered(candidate));
  }, []);

  const handleSelectPilot = useCallback((pilot: any | null) => {
    setSelectedPilot(pilot);
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    if (pilot) setFocusTarget(eliteToThreeCentered(pilot));
  }, []);

  const searchForSystem = useCallback(async () => {
    const query = systemSearch.trim();
    if (!query) return;
    setSystemSearchLoading(true); setSystemSearchError('');
    const key = systemNameKey(query);
    const knownRoute = uniqueRouteSystems.find((point) => systemNameKey(point.system_name) === key);
    const knownHub = uniqueHubs.find((hub) => systemNameKey(hub.system_name) === key);
    if (knownHub) { handleSelectHub(knownHub); setSystemSearchLoading(false); return; }
    if (knownRoute) { handleSelectRouteSystem({ ...knownRoute, status: mapStatus(knownRoute) }); setSystemSearchLoading(false); return; }
    try {
      const response = await fetch(`/api/edsm/system?name=${encodeURIComponent(query)}`);
      const data = await response.json();
      if (!response.ok || !data.coords) throw new Error(data.error || 'Система не найдена');
      const point: RouteSystem = { id: -900000 - Date.now() % 100000, system_name: data.name || query, sort_order: -1, status: 'planned', x: Number(data.coords.x), y: Number(data.coords.y), z: Number(data.coords.z), isHub: false };
      setSearchSystem(point);
      handleSelectRouteSystem(point);
    } catch (error) { setSystemSearchError(error instanceof Error ? error.message : 'Система не найдена'); }
    finally { setSystemSearchLoading(false); }
  }, [handleSelectHub, handleSelectRouteSystem, systemSearch, uniqueHubs, uniqueRouteSystems]);

  const handleClearSelection = useCallback(() => {
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
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
          <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
            <input value={systemSearch} onChange={(event) => setSystemSearch(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') void searchForSystem(); }} placeholder="Поиск системы..." style={{ minWidth: 0, flex: 1, background: '#323538', border: '1px solid #3a3d40', color: '#eeeeee', padding: '5px 7px', borderRadius: 4, fontSize: 11 }} />
            <button onClick={() => void searchForSystem()} disabled={systemSearchLoading} style={{ background: 'rgba(59,130,246,.18)', border: '1px solid rgba(59,130,246,.5)', color: '#8bbcff', padding: '4px 7px', borderRadius: 4, cursor: 'pointer', fontSize: 11 }}>{systemSearchLoading ? '…' : 'Найти'}</button>
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

      {selected && (
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
        // Clicking open space should close the detail card just like clicking
        // an already selected marker; marker handlers stop propagation first.
        onPointerMissed={handleClearSelection}
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
