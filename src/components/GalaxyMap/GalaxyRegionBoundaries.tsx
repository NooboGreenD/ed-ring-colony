'use client';

import { useMemo } from 'react';
import * as THREE from 'three';
import regionPack from '@/lib/galacticRegions.json';

const REGIONS = (regionPack as { regions: Array<{ path: number[][] }> }).regions;

/**
 * Region boundaries from the project's canonical Elite Dangerous region map.
 * `galacticRegions.json` stores points relative to Sagittarius A*; the map
 * already uses that same centered coordinate system, with Z inverted for
 * Three.js. All boundary vertices are deliberately placed at Three Y = 0.
 */
export function GalaxyRegionBoundaries() {
  const geometry = useMemo(() => {
    const positions: number[] = [];
    for (const region of REGIONS) {
      const path = region.path || [];
      if (path.length < 2) continue;
      for (let index = 0; index < path.length; index++) {
        const current = path[index];
        const next = path[(index + 1) % path.length];
        // Region paths are relative to SAGA. The project map's canonical
        // transform is x unchanged, z negated, and no vertical offset.
        positions.push(current[0], 0, -current[1], next[0], 0, -next[1]);
      }
    }
    const result = new THREE.BufferGeometry();
    result.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    return result;
  }, []);

  const material = useMemo(() => new THREE.LineBasicMaterial({
    color: '#00e5ff',
    transparent: true,
    opacity: 0.98,
    depthWrite: false,
    depthTest: false,
  }), []);

  return <lineSegments geometry={geometry} material={material} renderOrder={20} frustumCulled={false} />;
}
