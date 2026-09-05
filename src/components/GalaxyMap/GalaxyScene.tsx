'use client';

import { useRef, useEffect } from "react";
import * as THREE from "three";
import { useFrame, useThree } from "@react-three/fiber";
import { RouteLine } from "./RouteLine";
import { RouteMarkers } from "./RouteMarkers";
import { HubMarkers } from "./HubMarkers";
import { AtlasMarkers } from "./AtlasMarkers";
import { PilotMarkers } from "./PilotMarkers";
import { NoMarketMarkers } from "./NoMarketMarkers";
import { MarketResultMarkers } from "./MarketResultMarkers";
import type { Pilot } from "./PilotMarkers";
import type { Hub, RouteSystem } from "@/types/hub";
import type { AtlasCandidate } from "@/types/atlas";

interface GalaxySceneProps {
  hubs: Hub[];
  allRouteSystems: RouteSystem[];
  squadronRouteSystems?: RouteSystem[];
  atlasCandidates?: AtlasCandidate[];
  pilots?: Pilot[];
  noMarketSystems?: Array<{ system_name: string; x: number; y: number; z: number }>;
  marketResults?: Array<{ system_name: string; distance: number; station_name?: string; commodities_found?: number }>;
  showKnownSystems?: boolean;
  showMarketResults?: boolean;
  showNoMarketSystems?: boolean;
  onSelectHub?: (hub: Hub | null) => void;
  onSelectRouteSystem?: (point: RouteSystem | null) => void;
  onSelectAtlasCandidate?: (candidate: AtlasCandidate | null) => void;
  onSelectPilot?: (pilot: Pilot | null) => void;
  focusTarget?: THREE.Vector3 | null;
  resetCamera?: number;
}

function CameraController({
  focusTarget,
  resetCamera,
}: {
  focusTarget?: THREE.Vector3 | null;
  resetCamera?: number;
}) {
  const { camera } = useThree();
  const targetRef = useRef<THREE.Vector3 | null>(null);
  const initialPosition = useRef<THREE.Vector3 | null>(null);
  const initialTarget = useRef(new THREE.Vector3(0, 0, 0));

  useEffect(() => {
    if (camera && !initialPosition.current) {
      initialPosition.current = camera.position.clone();
    }
  }, [camera]);

  useEffect(() => {
    if (focusTarget) {
      targetRef.current = focusTarget.clone();
    }
  }, [focusTarget]);

  useEffect(() => {
    if (resetCamera) {
      targetRef.current = null;
    }
  }, [resetCamera]);

  useFrame(() => {
    if (!initialPosition.current) return;
    if (targetRef.current) {
      const desiredPos = targetRef.current.clone().add(new THREE.Vector3(0, 80, 120));
      camera.position.lerp(desiredPos, 0.05);
      camera.lookAt(targetRef.current);
    } else if (resetCamera) {
      camera.position.lerp(initialPosition.current, 0.05);
      camera.lookAt(initialTarget.current);
    }
  });

  return null;
}

export function GalaxyScene({
  hubs,
  allRouteSystems,
  squadronRouteSystems = [],
  atlasCandidates = [],
  pilots = [],
  noMarketSystems = [],
  marketResults = [],
  showKnownSystems = true,
  showMarketResults = true,
  showNoMarketSystems = true,
  onSelectHub,
  onSelectRouteSystem,
  onSelectAtlasCandidate,
  onSelectPilot,
  focusTarget,
  resetCamera,
}: GalaxySceneProps) {
  return (
    <>
      <CameraController focusTarget={focusTarget} resetCamera={resetCamera} />
      <ambientLight intensity={0.4} />
      <pointLight position={[100, 100, 100]} intensity={0.8} color="#ffffff" />
      <pointLight position={[-100, -100, -100]} intensity={0.3} color="#4466aa" />

      <RouteLine points={allRouteSystems} />
      {showKnownSystems && squadronRouteSystems.length > 0 && (
        <RouteLine points={squadronRouteSystems} color="#3b82f6" opacity={0.6} />
      )}
      {showKnownSystems && <RouteMarkers points={allRouteSystems} onSelectPoint={onSelectRouteSystem} />}
      {showKnownSystems && <HubMarkers hubs={hubs} onSelectHub={onSelectHub} />}
      {showKnownSystems && <AtlasMarkers candidates={atlasCandidates} onSelect={onSelectAtlasCandidate} />}
      {showKnownSystems && <PilotMarkers pilots={pilots} onSelectPilot={onSelectPilot} />}
      {showMarketResults && <MarketResultMarkers systems={marketResults} />}
      {showNoMarketSystems && <NoMarketMarkers systems={noMarketSystems} />}
    </>
  );
}
