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
      if (path.length < 3) continue;
      // The source map is quantised to a 394/395 ly stair-step grid. Draw a
      // centripetal spline through those exact vertices so the visual border is
      // smooth rather than showing every raster corner as a jagged step.
      const controlPoints = path.map((point) => new THREE.Vector3(point[0], 0, -point[1]));
      const curve = new THREE.CatmullRomCurve3(controlPoints, true, 'centripetal', 0.15);
      const smoothPoints = curve.getPoints(Math.max(128, path.length * 3));
      for (let index = 0; index < smoothPoints.length - 1; index++) {
        const current = smoothPoints[index];
        const next = smoothPoints[index + 1];
        positions.push(current.x, 0, current.z, next.x, 0, next.z);
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
