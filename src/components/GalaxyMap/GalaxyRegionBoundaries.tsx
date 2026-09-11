'use client';

import { useEffect, useMemo, useState } from 'react';
import * as THREE from 'three';
import { SAGA } from '@/lib/ed3dCanon';

const MAP_SIZE = 2048;
const GALAXY_X0 = -49985;
const GALAXY_Z0 = -24105;
const PIXEL_SCALE = 4096 / 83; // 49.349397... ly, source map grid

function regionId(value: number) {
  // Source raster uses 168, 164, ... 4 for regions 1 ... 42 and black for outside.
  return value > 0 && value <= 168 && value % 4 === 0 ? 1 + (168 - value) / 4 : 0;
}

function centered(x: number, z: number) {
  return [x - SAGA.x, -(z - SAGA.z)];
}

/**
 * Draws the exact X/Z boundaries from the open EliteDangerousRegionMap raster.
 * The map is deliberately kept as a small asset rather than approximating
 * regions with circular polygons. Each raster edge is converted to a 3D line.
 */
export function GalaxyRegionBoundaries() {
  const [vertices, setVertices] = useState<Float32Array | null>(null);
  const material = useMemo(() => new THREE.LineBasicMaterial({
    color: '#00e5ff',
    transparent: true,
    opacity: 0.96,
    depthWrite: false,
    depthTest: false,
  }), []);

  useEffect(() => {
    let cancelled = false;
    const image = new Image();
    image.src = '/ed3d/galaxy-region-map.png';
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = MAP_SIZE; canvas.height = MAP_SIZE;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context || cancelled) return;
      context.drawImage(image, 0, 0, MAP_SIZE, MAP_SIZE);
      const pixels = context.getImageData(0, 0, MAP_SIZE, MAP_SIZE).data;
      const lines: number[] = [];
      const addLine = (x1: number, z1: number, x2: number, z2: number) => {
        const a = centered(x1, z1); const b = centered(x2, z2);
        lines.push(a[0], 0, a[1], b[0], 0, b[1]);
      };
      const valueAt = (x: number, y: number) => pixels[(y * MAP_SIZE + x) * 4];
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          const current = regionId(valueAt(x, y));
          if (x + 1 < MAP_SIZE) {
            const right = regionId(valueAt(x + 1, y));
            if (current !== right && (current !== 0 || right !== 0)) {
              const gx = GALAXY_X0 + (x + 1) * PIXEL_SCALE;
              const gz1 = GALAXY_Z0 + y * PIXEL_SCALE;
              addLine(gx, gz1, gx, gz1 + PIXEL_SCALE);
            }
          }
          if (y + 1 < MAP_SIZE) {
            const below = regionId(valueAt(x, y + 1));
            if (current !== below && (current !== 0 || below !== 0)) {
              const gz = GALAXY_Z0 + (y + 1) * PIXEL_SCALE;
              const gx1 = GALAXY_X0 + x * PIXEL_SCALE;
              addLine(gx1, gz, gx1 + PIXEL_SCALE, gz);
            }
          }
        }
      }
      if (!cancelled) setVertices(new Float32Array(lines));
    };
    return () => { cancelled = true; };
  }, []);

  useEffect(() => () => material.dispose(), [material]);
  if (!vertices) return null;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
  return <lineSegments geometry={geometry} material={material} renderOrder={20} frustumCulled={false} />;
}
