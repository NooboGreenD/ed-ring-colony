'use client';

import { useState, useCallback, useEffect, Suspense, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { Canvas } from '@react-three/fiber';
import * as THREE from 'three';
import { Hub, RouteSystem } from '@/types/hub';
import { AtlasCandidate } from '@/types/atlas';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

const GalaxyScene = dynamic(
  () => import('./GalaxyScene').then((m) => m.GalaxyScene),
  { ssr: false }
);

function Loader() {
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#e67e22', fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 2, zIndex: 5 }}>
      Загрузка галактики...
    </div>
  );
}

export interface GalaxyMapProps {
  atlasCandidates?: AtlasCandidate[];
  squadronRouteSystems?: RouteSystem[];
  showOnlyMainRoute?: boolean;
  noMarketSystems?: Array<{ system_name: string; x: number; y: number; z: number }>;
  marketResults?: Array<{ system_name: string; distance: number; station_name?: string; commodities_found?: number }>;
}

export default function GalaxyMap({
  atlasCandidates = [],
  squadronRouteSystems = [],
  showOnlyMainRoute = false,
  noMarketSystems = [],
  marketResults = [],
}: GalaxyMapProps) {
  const [hubs, setHubs] = useState<Hub[]>([]);
  const [allRouteSystems, setAllRouteSystems] = useState<RouteSystem[]>([]);
  const [pilots, setPilots] = useState<any[]>([]);
  const [selectedHub, setSelectedHub] = useState<Hub | null>(null);
  const [selectedRouteSystem, setSelectedRouteSystem] = useState<RouteSystem | null>(null);
  const [selectedAtlasCandidate, setSelectedAtlasCandidate] = useState<AtlasCandidate | null>(null);
  const [selectedPilot, setSelectedPilot] = useState<any | null>(null);
  const [focusTarget, setFocusTarget] = useState<THREE.Vector3 | null>(null);
  const [resetCamera, setResetCamera] = useState(0);

  const [showKnownSystems, setShowKnownSystems] = useState(true);
  const [showMarketResults, setShowMarketResults] = useState(true);
  const [showNoMarketSystems, setShowNoMarketSystems] = useState(true);

  useEffect(() => {
    fetch('/api/hubs')
      .then((r) => r.json())
      .then((data) => setHubs(data.hubs || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/route')
      .then((r) => r.json())
      .then((data) => setAllRouteSystems(data.points || []))
      .catch(() => {});
  }, []);

  useEffect(() => {
    fetch('/api/pilots')
      .then((r) => r.json())
      .then((data) => setPilots(data.pilots || []))
      .catch(() => {});
  }, []);

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

  const handleResetView = useCallback(() => {
    setFocusTarget(null);
    setResetCamera((n) => n + 1);
    setSelectedHub(null);
    setSelectedRouteSystem(null);
    setSelectedAtlasCandidate(null);
    setSelectedPilot(null);
  }, []);

  const displayRouteSystems = allRouteSystems;

  const selected = selectedHub || selectedRouteSystem || selectedAtlasCandidate || selectedPilot;

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      {/* HUD */}
      <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 10, background: 'rgba(13,15,17,0.85)', backdropFilter: 'blur(8px)', border: '1px solid #2d2f33', borderRadius: 8, padding: 12, minWidth: 180, maxWidth: 260, pointerEvents: 'none' }}>
        <div style={{ marginBottom: 8, pointerEvents: 'auto' }}>
          <button onClick={handleResetView} style={{ background: 'rgba(30,41,59,0.8)', border: '1px solid #3a3d40', color: '#9ca3af', padding: '4px 10px', borderRadius: 4, fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' }}>
            ⟲ Сброс вида
          </button>
        </div>
        <div style={{ marginBottom: 8, pointerEvents: 'auto', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <label style={{ fontSize: 11, color: '#eeeeee', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showKnownSystems} onChange={(e) => setShowKnownSystems(e.target.checked)} />
            Все известные системы
          </label>
          <label style={{ fontSize: 11, color: '#22c55e', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showMarketResults} onChange={(e) => setShowMarketResults(e.target.checked)} />
            Системы с маркетами для стройки
          </label>
          <label style={{ fontSize: 11, color: '#8b0000', display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input type="checkbox" checked={showNoMarketSystems} onChange={(e) => setShowNoMarketSystems(e.target.checked)} />
            Системы без рынков
          </label>
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>
          <span style={{ color: '#22c55e' }}>●</span> Завершён
          <span style={{ marginLeft: 8, color: '#e67e22' }}>●</span> Строительство
          <span style={{ marginLeft: 8, color: '#9ca3af' }}>●</span> Запланирован
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af' }}>
          <span style={{ color: '#3b82f6' }}>●</span> Маршрут эскадры
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          <span style={{ color: '#e91e63' }}>●</span> Atlas-кандидаты
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 4 }}>
          <span style={{ color: '#00bcd4' }}>●</span> Пилоты
        </div>
      </div>

      {selected && (
        <div style={{ position: 'absolute', bottom: 12, left: 12, zIndex: 10, background: 'rgba(13,15,17,0.9)', backdropFilter: 'blur(8px)', border: '1px solid #2d2f33', borderRadius: 8, padding: 12, minWidth: 200, maxWidth: 280, pointerEvents: 'auto' }}>
          <div style={{ fontWeight: 700, fontSize: 15, color: '#eeeeee' }}>{(selected as any).system_name || (selected as any).name}</div>
          <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>
            📍 {(selected as any).x?.toFixed(1) || '?'}, {(selected as any).y?.toFixed(1) || '?'}, {(selected as any).z?.toFixed(1) || '?'}
          </div>
          {(selected as any).status && (
            <div style={{ marginTop: 4, fontSize: 12 }}>
              Статус:{' '}
              <span style={{ color: (selected as any).status === 'done' ? '#22c55e' : (selected as any).status === 'building' ? '#e67e22' : '#9ca3af' }}>
                {(selected as any).status === 'done' ? 'Завершён' : (selected as any).status === 'building' ? 'Строительство' : 'Запланирован'}
              </span>
            </div>
          )}
          {(selected as any).progress != null && <div style={{ marginTop: 4, fontSize: 12, color: '#eeeeee' }}>Прогресс: {(selected as any).progress}%</div>}
          {(selected as any).total_delivered != null && <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Доставлено: {Number((selected as any).total_delivered).toLocaleString('ru')} т</div>}
          {(selected as any).distance != null && <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Расстояние: {(selected as any).distance.toFixed(1)} св.лет</div>}
          {(selected as any).type && <div style={{ marginTop: 4, fontSize: 12, color: '#9ca3af' }}>Тип: {(selected as any).type}</div>}
        </div>
      )}

      <Canvas
        camera={{ position: [0, 35000, 0], fov: 45, near: 1, far: 200000 }}
        gl={{ antialias: true, alpha: false, powerPreference: "high-performance" }}
        style={{ background: "#000000", width: '100%', height: '100%' }}
        frameloop="demand"
      >
        <Suspense fallback={null}>
          <GalaxyScene
            hubs={hubs}
            allRouteSystems={displayRouteSystems}
            squadronRouteSystems={squadronRouteSystems}
            atlasCandidates={atlasCandidates}
            pilots={pilots}
            noMarketSystems={noMarketSystems}
            marketResults={marketResults}
            showKnownSystems={showKnownSystems}
            showMarketResults={showMarketResults}
            showNoMarketSystems={showNoMarketSystems}
            onSelectHub={handleSelectHub}
            onSelectRouteSystem={handleSelectRouteSystem}
            onSelectAtlasCandidate={handleSelectAtlasCandidate}
            onSelectPilot={handleSelectPilot}
            focusTarget={focusTarget}
            resetCamera={resetCamera}
          />
        </Suspense>
      </Canvas>
    </div>
  );
}
