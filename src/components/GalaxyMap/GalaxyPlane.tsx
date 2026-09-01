"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { useTexture } from "@react-three/drei";
import { GALAXY_RADIUS_LY } from "@/lib/ed3dCanon";

export function GalaxyPlane() {
  const texture = useTexture("/ed3d/spiral_joe.png");

  const material = useMemo(() => {
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return new THREE.MeshBasicMaterial({
      map: texture, transparent: true, opacity: 0.35,
      side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending,
    });
  }, [texture]);

  const geometry = useMemo(() => new THREE.PlaneGeometry(GALAXY_RADIUS_LY * 2.2, GALAXY_RADIUS_LY * 2.2), []);

  // БЕЗ position! Только rotation. Смещение делает родительская GalaxyBackground.
  return <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} />;
}
