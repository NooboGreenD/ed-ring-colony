"use client";

import { useRef, useEffect } from "react";
import { OrbitControls } from "@react-three/drei";
import { useThree } from "@react-three/fiber";
import { GalaxyBackground } from "./GalaxyBackground";
import { HubMarkers } from "./HubMarkers";
import { RouteMarkers } from "./RouteMarkers";
import { RouteLine } from "./RouteLine";
import { RingZone } from "./RingZone";
import { LandmarkMarkers } from "./LandmarkMarkers";
import { NebulaClouds } from "./NebulaClouds";
import { AtlasMarkers } from "./AtlasMarkers";
import { PilotMarkers } from "./PilotMarkers";
import { NoMarketMarkers } from "./NoMarketMarkers";
import type { Pilot } from "./PilotMarkers";
import type { Hub, RoutePoint } from "./useGalaxyData";
import type { AtlasCandidate } from "@/types/atlas";
import * as THREE from "three";

interface GalaxySceneProps {
  hubs: Hub[];
  allRoutePoints: RoutePoint[];
  squadronRoutePoints?: RoutePoint[];
  atlasCandidates?: AtlasCandidate[];
  pilots?: Pilot[];
  noMarketSystems?: Array<{ system_name: string; x: number; y: number; z: number }>;
  onSelectHub?: (hub: Hub | null) => void;
  onSelectRoutePoint?: (point: RoutePoint | null) => void;
  onSelectAtlasCandidate?: (candidate: AtlasCandidate | null) => void;
  onSelectPilot?: (pilot: Pilot | null) => void;
  focusTarget?: THREE.Vector3 | null;
  resetCamera?: number;
}

export function GalaxyScene({
  hubs,
  allRoutePoints,
  squadronRoutePoints = [],
  atlasCandidates = [],
  pilots = [],
  noMarketSystems = [],
  onSelectHub,
  onSelectRoutePoint,
  onSelectAtlasCandidate,
  onSelectPilot,
  focusTarget,
  resetCamera,
}: GalaxySceneProps) {
  const controlsRef = useRef<any>(null);
  const { camera, invalidate } = useThree();

  // Плавный фокус на выбранную точку
  useEffect(() => {
    if (!focusTarget || !controlsRef.current) return;

    const target = focusTarget.clone();
    const offset = new THREE.Vector3(0, 120, 250);
    const endPos = target.clone().add(offset);

    const startPos = camera.position.clone();
    const startTarget = controlsRef.current.target.clone();
    let progress = 0;
    let rafId = 0;

    const animate = () => {
      progress += 0.03;
      if (progress > 1) progress = 1;
      const ease = 1 - Math.pow(1 - progress, 3);

      camera.position.lerpVectors(startPos, endPos, ease);
      controlsRef.current.target.lerpVectors(startTarget, target, ease);
      controlsRef.current.update();
      invalidate();

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [focusTarget, camera, invalidate]);

  // Сброс камеры
  useEffect(() => {
    if (!resetCamera || !controlsRef.current) return;

    const startPos = camera.position.clone();
    const startTarget = controlsRef.current.target.clone();
    const endPos = new THREE.Vector3(0, 35000, 0);
    const endTarget = new THREE.Vector3(0, 0, 0);
    let progress = 0;
    let rafId = 0;

    const animate = () => {
      progress += 0.025;
      if (progress > 1) progress = 1;
      const ease = 1 - Math.pow(1 - progress, 3);

      camera.position.lerpVectors(startPos, endPos, ease);
      controlsRef.current.target.lerpVectors(startTarget, endTarget, ease);
      controlsRef.current.update();
      invalidate();

      if (progress < 1) {
        rafId = requestAnimationFrame(animate);
      }
    };
    rafId = requestAnimationFrame(animate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
    };
  }, [resetCamera, camera, invalidate]);

  return (
    <>
      <OrbitControls
        ref={controlsRef}
        enablePan={true}
        enableZoom={true}
        enableRotate={true}
        minDistance={10}
        maxDistance={120000}
        target={[0, 0, 0]}
        dampingFactor={0.08}
        enableDamping={true}
      />

      <ambientLight intensity={0.4} />
      <fog attach="fog" args={["#000000", 40000, 140000]} />

      <GalaxyBackground />
      <NebulaClouds />
      <RingZone />
      <LandmarkMarkers />

      <RouteLine points={allRoutePoints} />
      {squadronRoutePoints.length > 0 && (
        <RouteLine points={squadronRoutePoints} color="#3b82f6" opacity={0.6} />
      )}
      <RouteMarkers points={allRoutePoints} onSelectPoint={onSelectRoutePoint} />
      <HubMarkers hubs={hubs} onSelectHub={onSelectHub} />
      <AtlasMarkers candidates={atlasCandidates} onSelect={onSelectAtlasCandidate} />
      <PilotMarkers pilots={pilots} onSelectPilot={onSelectPilot} />
      <NoMarketMarkers systems={noMarketSystems} />
    </>
  );
}
