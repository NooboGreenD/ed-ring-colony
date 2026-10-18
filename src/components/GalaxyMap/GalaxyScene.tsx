'use client';

import { useRef, useEffect, useMemo } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GalaxyBackground } from './GalaxyBackground';
import { NebulaField } from './NebulaField';
import { RingZone } from './RingZone';
import { LandmarkMarkers } from './LandmarkMarkers';
import { GalaxyRegionMarkers } from './GalaxyRegionMarkers';
import { GalaxyRegionBoundaries } from './GalaxyRegionBoundaries';
import { GalacticRegions } from './GalacticRegions';
import { RouteLine } from './RouteLine';
import { RouteMarkers } from './RouteMarkers';
import { HubMarkers } from './HubMarkers';
import { AtlasMarkers } from './AtlasMarkers';
import { PilotMarkers } from './PilotMarkers';
import { CarrierMarkers } from './CarrierMarkers';
import { NoMarketMarkers } from './NoMarketMarkers';
import { MarketResultMarkers, type MarketResult } from './MarketResultMarkers';
import { AllSystemsPoints, MapClickLayer, SelectedStarRing, useMapPositions, type MapClickPoints } from './AllSystemsPoints';
import { PowerplayPoints, PowerplaySelection, usePowerplayPositions } from './PowerplayPoints';
import { SearchProgressLayer } from './SearchProgressLayer';
import type { Pilot } from './PilotMarkers';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';
import type { AllSystemsData } from '@/lib/galaxySystems';
import type { GalaxyNebula, NebulaKind } from '@/lib/galaxyNebulae';
import type { Hub, RouteSystem } from '@/types/hub';
import type { AtlasCandidate } from '@/types/atlas';
import type { AtlasSearchProgress } from '@/lib/atlasSearchProgress';
import type { CarrierSystemGroup } from '@/lib/carrierMap';
import type { PowerplaySystem } from '@/lib/powerplay';

function DataWatcher({
  routeLinePoints,
  allRouteSystems,
  hubs,
  invalidate,
}: {
  routeLinePoints: RouteSystem[];
  allRouteSystems: RouteSystem[];
  hubs: Hub[];
  invalidate: () => void;
}) {
  const previousHash = useRef('');

  useEffect(() => {
    const hash = JSON.stringify({
      line: routeLinePoints.map((system) => `${system.id}:${system.x}:${system.y}:${system.z}`),
      route: allRouteSystems.map((system) => `${system.id}:${system.status}:${system.progress}`),
      hubs: hubs.map((hub) => `${hub.id}:${hub.status}:${hub.progress}`),
    });

    if (hash !== previousHash.current) {
      previousHash.current = hash;
      invalidate();
    }
  }, [routeLinePoints, allRouteSystems, hubs, invalidate]);

  return null;
}

/**
 * Точка, к которой летит камера. `viewDistance` — с какого расстояния смотреть
 * (обзор набора систем); без него — обычный подлёт к одной системе.
 */
export type FocusTarget = THREE.Vector3 & { viewDistance?: number };

interface GalaxySceneProps {
  hubs: Hub[];
  /** Marker points after the UI status/layer filters have been applied. */
  allRouteSystems: RouteSystem[];
  /** Full ordered main route. It is separate so status filters don't redraw a fake route. */
  routeLinePoints?: RouteSystem[];
  squadronRouteSystems?: RouteSystem[];
  atlasCandidates?: AtlasCandidate[];
  pilots?: Pilot[];
  noMarketSystems?: Array<{ system_name: string; x: number; y: number; z: number }>;
  marketResults?: MarketResult[];
  showKnownSystems?: boolean;
  showSquadronRoute?: boolean;
  showAtlasCandidates?: boolean;
  showPilots?: boolean;
  showMarketResults?: boolean;
  showNoMarketSystems?: boolean;
  /** Авианосцы по системам (уже после фильтра слоя). */
  carrierGroups?: CarrierSystemGroup[];
  showCarriers?: boolean;
  selectedCarrierKey?: string | null;
  onSelectCarrierGroup?: (group: CarrierSystemGroup | null) => void;
  /** Слой PowerPlay (Atlas): системы держав после фильтра вкладки. */
  powerplaySystems?: PowerplaySystem[];
  showPowerplay?: boolean;
  selectedPowerplay?: PowerplaySystem | null;
  onPickPowerplay?: (system: PowerplaySystem) => void;
  /** Курсор над системой слоя PowerPlay (или ушёл с неё): подсказка и «рука». */
  onHoverPowerplay?: (system: PowerplaySystem | null, at: { x: number; y: number } | null) => void;
  showRegionLabels?: boolean;
  showRegionBoundaries?: boolean;
  showNebulae?: boolean;
  /** Типы туманностей, которые остаются на карте. */
  nebulaKinds?: NebulaKind[];
  showNebulaLabels?: boolean;
  selectedNebulaName?: string | null;
  onSelectNebula?: (nebula: GalaxyNebula | null) => void;
  showRingZone?: boolean;
  /** Experimental layer: every known system in the galaxy (Spansh dump). */
  allSystemsData?: AllSystemsData | null;
  showAllSystems?: boolean;
  allSystemsMask?: number;
  selectedAllSystem?: { x: number; y: number; z: number } | null;
  onPickAllSystem?: (id64: string, index: number) => void;
  onEmptyMapClick?: () => void;
  onSelectHub?: (hub: Hub | null) => void;
  onSelectRouteSystem?: (point: RouteSystem | null) => void;
  onSelectAtlasCandidate?: (candidate: AtlasCandidate | null) => void;
  onSelectPilot?: (pilot: Pilot | null) => void;
  selectedHubId?: number | null;
  selectedRouteSystemId?: number | null;
  selectedAtlasCandidateId?: string | null;
  selectedPilotId?: string | null;
  focusTarget?: THREE.Vector3 | null;
  resetCamera?: number;
  /** Прогресс активного поиска Atlas: рисуется поверх остальных слоёв. */
  searchProgress?: AtlasSearchProgress | null;
  /**
   * Закреплённый итог поиска: остаётся на карте после завершения, пока
   * пользователь не уберёт его (см. lib/atlasSearchProgress).
   */
  searchResult?: AtlasSearchProgress | null;
}

export function GalaxyScene({
  hubs,
  allRouteSystems,
  routeLinePoints = allRouteSystems,
  squadronRouteSystems = [],
  atlasCandidates = [],
  pilots = [],
  noMarketSystems = [],
  marketResults = [],
  showKnownSystems = true,
  showSquadronRoute = true,
  showAtlasCandidates = true,
  showPilots = true,
  showMarketResults = true,
  showNoMarketSystems = true,
  carrierGroups = [],
  showCarriers = true,
  selectedCarrierKey = null,
  onSelectCarrierGroup,
  powerplaySystems = [],
  showPowerplay = false,
  selectedPowerplay = null,
  onPickPowerplay,
  onHoverPowerplay,
  showRegionLabels = true,
  showRegionBoundaries = true,
  showNebulae = true,
  nebulaKinds,
  showNebulaLabels = true,
  selectedNebulaName = null,
  onSelectNebula,
  showRingZone = true,
  allSystemsData = null,
  showAllSystems = false,
  allSystemsMask = 0x3ffff,
  selectedAllSystem = null,
  onPickAllSystem,
  onEmptyMapClick,
  onSelectHub,
  onSelectRouteSystem,
  onSelectAtlasCandidate,
  onSelectPilot,
  selectedHubId,
  selectedRouteSystemId,
  selectedAtlasCandidateId,
  selectedPilotId,
  focusTarget,
  resetCamera,
  searchProgress = null,
  searchResult = null,
}: GalaxySceneProps) {
  const controlsRef = useRef<any>(null);
  const { camera, invalidate } = useThree();
  const mapPositions = useMapPositions(showAllSystems ? allSystemsData : null);
  const powerplayVisible = showPowerplay && powerplaySystems.length > 0;
  const powerplayPositions = usePowerplayPositions(powerplayVisible ? powerplaySystems : null);
  const powerplayPick = useMemo<MapClickPoints | null>(() => (
    powerplayVisible && powerplayPositions && onPickPowerplay
      ? {
          positions: powerplayPositions,
          count: powerplaySystems.length,
          pixelRadius: 10,
          onPick: (index: number) => {
            const system = powerplaySystems[index];
            if (system) onPickPowerplay(system);
          },
          onHover: onHoverPowerplay
            ? (index: number | null, at: { x: number; y: number } | null) => {
                onHoverPowerplay(index === null ? null : powerplaySystems[index] ?? null, at);
              }
            : undefined,
        }
      : null
  ), [onHoverPowerplay, onPickPowerplay, powerplayPositions, powerplaySystems, powerplayVisible]);
  const selectedPosition = selectedAllSystem
    ? (() => {
        const p = eliteToThreeCentered(selectedAllSystem);
        return [p.x, p.y, p.z] as [number, number, number];
      })()
    : null;

  useEffect(() => {
    if (!focusTarget || !controlsRef.current) return;

    const target = focusTarget.clone();
    const viewDistance = (focusTarget as FocusTarget).viewDistance;
    const offset = viewDistance && viewDistance > 0
      ? new THREE.Vector3(0, 0.75, 1).normalize().multiplyScalar(viewDistance)
      : new THREE.Vector3(0, 120, 250);
    const endPosition = target.clone().add(offset);
    const startPosition = camera.position.clone();
    const startTarget = controlsRef.current.target.clone();
    let progress = 0;
    let rafId = 0;

    const animate = () => {
      progress = Math.min(1, progress + 0.03);
      const ease = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(startPosition, endPosition, ease);
      controlsRef.current.target.lerpVectors(startTarget, target, ease);
      controlsRef.current.update();
      invalidate();
      if (progress < 1) rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [focusTarget, camera, invalidate]);

  useEffect(() => {
    if (!resetCamera || !controlsRef.current) return;

    const startPosition = camera.position.clone();
    const startTarget = controlsRef.current.target.clone();
    const endPosition = new THREE.Vector3(0, 35000, 0);
    const endTarget = new THREE.Vector3(0, 0, 0);
    let progress = 0;
    let rafId = 0;

    const animate = () => {
      progress = Math.min(1, progress + 0.025);
      const ease = 1 - Math.pow(1 - progress, 3);
      camera.position.lerpVectors(startPosition, endPosition, ease);
      controlsRef.current.target.lerpVectors(startTarget, endTarget, ease);
      controlsRef.current.update();
      invalidate();
      if (progress < 1) rafId = requestAnimationFrame(animate);
    };

    rafId = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(rafId);
  }, [resetCamera, camera, invalidate]);

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        enablePan
        enableZoom
        enableRotate
        minDistance={10}
        maxDistance={120000}
        target={[0, 0, 0]}
        dampingFactor={0.08}
        enableDamping
      />

      <DataWatcher routeLinePoints={routeLinePoints} allRouteSystems={allRouteSystems} hubs={hubs} invalidate={invalidate} />

      <ambientLight intensity={0.4} />
      <fog attach="fog" args={['#000000', 40000, 140000]} />

      <GalaxyBackground />
      {showNebulae && (
        <NebulaField
          showLabels={showNebulaLabels}
          visibleKinds={nebulaKinds}
          selectedName={selectedNebulaName}
          onSelect={onSelectNebula}
        />
      )}
      {showRingZone && <RingZone />}
      {/* Со слоем PowerPlay ориентиры не перехватывают клики: Sol — сама система державы. */}
      <LandmarkMarkers onSelect={onSelectRouteSystem} interactive={!powerplayVisible} />
      <GalacticRegions />
      <GalaxyRegionMarkers showLabels={showRegionLabels} />
      {showRegionBoundaries && <GalaxyRegionBoundaries />}

      <MapClickLayer
        data={showAllSystems ? allSystemsData : null}
        positions={mapPositions}
        visibleMask={allSystemsMask}
        enabled={showAllSystems && !!allSystemsData && !!mapPositions}
        onPick={onPickAllSystem}
        onEmpty={onEmptyMapClick}
        extraPoints={powerplayPick}
      />
      {showAllSystems && allSystemsData && mapPositions && (
        <AllSystemsPoints data={allSystemsData} positions={mapPositions} visibleMask={allSystemsMask} />
      )}
      {selectedPosition && <SelectedStarRing position={selectedPosition} />}
      {powerplayVisible && powerplayPositions && (
        <PowerplayPoints systems={powerplaySystems} positions={powerplayPositions} />
      )}
      {showPowerplay && selectedPowerplay && <PowerplaySelection system={selectedPowerplay} />}

      {showKnownSystems && <RouteLine points={routeLinePoints} />}
      {showSquadronRoute && squadronRouteSystems.length > 1 && (
        <RouteLine points={squadronRouteSystems} color="#3b82f6" opacity={0.6} />
      )}
      {showSquadronRoute && squadronRouteSystems.length > 0 && (
        <RouteMarkers
          points={squadronRouteSystems}
          selectedPointId={selectedRouteSystemId}
          onSelectPoint={onSelectRouteSystem}
        />
      )}
      {showKnownSystems && (
        <RouteMarkers
          points={allRouteSystems}
          selectedPointId={selectedRouteSystemId}
          onSelectPoint={onSelectRouteSystem}
        />
      )}
      {showKnownSystems && (
        <HubMarkers hubs={hubs} selectedHubId={selectedHubId} onSelectHub={onSelectHub} />
      )}
      {showAtlasCandidates && (
        <AtlasMarkers candidates={atlasCandidates} selectedId={selectedAtlasCandidateId} onSelect={onSelectAtlasCandidate} />
      )}
      {showPilots && (
        <PilotMarkers pilots={pilots} selectedPilotId={selectedPilotId} onSelectPilot={onSelectPilot} />
      )}
      {showMarketResults && <MarketResultMarkers systems={marketResults} />}
      {showNoMarketSystems && <NoMarketMarkers systems={noMarketSystems} />}
      {showCarriers && carrierGroups.length > 0 && (
        <CarrierMarkers groups={carrierGroups} selectedKey={selectedCarrierKey} onSelect={onSelectCarrierGroup} />
      )}
      {searchProgress && <SearchProgressLayer progress={searchProgress} result={searchResult} />}
    </>
  );
}
