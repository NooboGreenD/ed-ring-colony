'use client';

import { useRef, useEffect } from 'react';
import { OrbitControls } from '@react-three/drei';
import { useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { GalaxyBackground } from './GalaxyBackground';
import { NebulaClouds } from './NebulaClouds';
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
import { NoMarketMarkers } from './NoMarketMarkers';
import { MarketResultMarkers, type MarketResult } from './MarketResultMarkers';
import type { Pilot } from './PilotMarkers';
import type { Hub, RouteSystem } from '@/types/hub';
import type { AtlasCandidate } from '@/types/atlas';

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
}: GalaxySceneProps) {
  const controlsRef = useRef<any>(null);
  const { camera, invalidate } = useThree();

  useEffect(() => {
    if (!focusTarget || !controlsRef.current) return;

    const target = focusTarget.clone();
    const offset = new THREE.Vector3(0, 120, 250);
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
      <NebulaClouds />
      <RingZone />
      <LandmarkMarkers />
      <GalacticRegions />
      <GalaxyRegionMarkers />
      <GalaxyRegionBoundaries />

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
    </>
  );
}
