'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useThree } from '@react-three/fiber';
import {
  parsePointsFile,
  id64FromParts,
  STAR_CLASS_COLORS,
  SAGA_LY,
  type AllSystemsData,
} from '@/lib/galaxySystems';

/**
 * Экспериментальный слой «все системы галактики» на 3D-карте.
 *
 * Один THREE.Points на ~1.3M систем: позиции ( elite-координаты в frame
 * карты ), цвет по классу главной звезды, клик по точке → id64 → карточка
 * системы. Данные — бинарный файл edgs-v1 из /api/galaxy/all-systems
 * (собирается импортом Spansh или на лету из таблицы galaxy_systems).
 */

let moduleCache: AllSystemsData | null = null;
let inFlight: Promise<AllSystemsData> | null = null;

export function loadAllSystemsData(): Promise<AllSystemsData> {
  if (moduleCache) return Promise.resolve(moduleCache);
  if (!inFlight) {
    inFlight = (async () => {
      const res = await fetch('/api/galaxy/all-systems', { cache: 'force-cache' });
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // keep default
        }
        if (res.status === 404) {
          message = 'Системы ещё не импортированы (npm run spansh:import)';
        }
        throw new Error(message);
      }
      const buffer = await res.arrayBuffer();
      moduleCache = parsePointsFile(buffer);
      return moduleCache;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

interface AllSystemsPointsProps {
  data: AllSystemsData;
  onPick?: (id64: string, index: number) => void;
}

export function AllSystemsPoints({ data, onPick }: AllSystemsPointsProps) {
  const { raycaster, invalidate } = useThree();

  // Elite (Sol-centered) → centered three-frame: x' = x - SAGA.x,
  // y' = y + |SAGA.y|… — the exact same math as ed3dCanon.eliteToThreeCentered.
  const positions = useMemo(() => {
    const src = data.positions;
    const out = new Float32Array(src.length);
    for (let i = 0; i < data.count; i++) {
      const x = src[i * 3];
      const y = src[i * 3 + 1];
      const z = src[i * 3 + 2];
      out[i * 3] = x - SAGA_LY.x;
      out[i * 3 + 1] = y - SAGA_LY.y;
      out[i * 3 + 2] = -z + SAGA_LY.z;
    }
    return out;
  }, [data]);

  const colors = useMemo(() => {
    const out = new Float32Array(data.count * 3);
    for (let i = 0; i < data.count; i++) {
      const [r, g, b] = STAR_CLASS_COLORS[data.starTypes[i]] ?? STAR_CLASS_COLORS[15];
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }, [data]);

  // Points raycasting needs a distance threshold in world units (ly).
  const savedThreshold = useRef<number | null>(null);
  useEffect(() => {
    savedThreshold.current = raycaster.params.Points.threshold;
    raycaster.params.Points.threshold = 60;
    return () => {
      if (savedThreshold.current != null) raycaster.params.Points.threshold = savedThreshold.current;
    };
  }, [raycaster]);

  useEffect(() => {
    invalidate();
  }, [positions, invalidate]);

  return (
    <points
      frustumCulled={false}
      onPointerDown={(event) => {
        event.stopPropagation();
        const index = (event as unknown as { index?: number }).index;
        if (index == null || index >= data.count) return;
        onPick?.(id64FromParts(data.id64Hi[index], data.id64Lo[index]), index);
      }}
    >
      <bufferGeometry key={`${data.count}-${positions.length}`}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial
        size={1.4}
        sizeAttenuation={false}
        vertexColors
        transparent
        opacity={0.85}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}
