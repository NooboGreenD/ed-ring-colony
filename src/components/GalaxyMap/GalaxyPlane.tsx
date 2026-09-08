"use client";

import { useMemo, useState, useEffect } from "react";
import * as THREE from "three";
import { GALAXY_RADIUS_LY } from "@/lib/ed3dCanon";

export function GalaxyPlane() {
  const [texture, setTexture] = useState<THREE.Texture | null>(null);

  useEffect(() => {
    const loader = new THREE.TextureLoader();
    loader.load(
      "/ed3d/spiral_joe.png",
      (tex) => {
        tex.minFilter = THREE.LinearFilter;
        tex.magFilter = THREE.LinearFilter;
        setTexture(tex);
      },
      undefined,
      () => setTexture(null)
    );
  }, []);

  const material = useMemo(() => {
    if (!texture) return null;
    return new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: 0.35,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [texture]);

  const geometry = useMemo(
    () => new THREE.PlaneGeometry(GALAXY_RADIUS_LY * 2.2, GALAXY_RADIUS_LY * 2.2),
    []
  );

  if (!material) return null;

  return <mesh geometry={geometry} material={material} rotation={[-Math.PI / 2, 0, 0]} />;
}
