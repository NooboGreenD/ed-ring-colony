'use client';

import { useEffect, useMemo } from 'react';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';
import type { RoutePoint } from './useGalaxyData';

interface RouteLineProps {
  points: RoutePoint[];
  color?: string;
  opacity?: number;
}

export function RouteLine({ points, color = '#e67e22', opacity = 0.35 }: RouteLineProps) {
  const line = useMemo(() => {
    const valid = points.filter(
      (point) => typeof point.x === 'number' && typeof point.y === 'number' && typeof point.z === 'number',
    );
    if (valid.length < 2) return null;

    // Duplicate database rows or a route that references a hub twice produce
    // zero-length segments. Apart from looking brighter, those segments make
    // transparent lines appear as an oversized dot at a waypoint.
    const vectors: THREE.Vector3[] = [];
    for (const point of valid) {
      const vector = eliteToThreeCentered(point);
      const previous = vectors[vectors.length - 1];
      if (previous && previous.distanceToSquared(vector) < 0.000001) continue;
      vectors.push(vector);
    }
    if (vectors.length < 2) return null;

    const geometry = new THREE.BufferGeometry().setFromPoints(vectors);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
      depthWrite: false,
    });
    return new THREE.Line(geometry, material);
  }, [points, color, opacity]);

  useEffect(() => {
    return () => {
      line?.geometry.dispose();
      (line?.material as THREE.Material | undefined)?.dispose();
    };
  }, [line]);

  if (!line) return null;
  return <primitive object={line} />;
}
