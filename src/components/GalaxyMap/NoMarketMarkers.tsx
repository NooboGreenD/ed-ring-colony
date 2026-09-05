'use client';
import { useMemo } from 'react';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

interface NoMarketSystem {
  system_name: string;
  x: number;
  y: number;
  z: number;
}

interface NoMarketMarkersProps {
  systems: NoMarketSystem[];
}

export function NoMarketMarkers({ systems }: NoMarketMarkersProps) {
  const texture = useMemo(() => {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const ctx = canvas.getContext('2d')!;
    ctx.strokeStyle = '#8b0000';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(4, 4);
    ctx.lineTo(28, 28);
    ctx.moveTo(4, 28);
    ctx.lineTo(28, 4);
    ctx.stroke();
    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, []);

  if (!texture || systems.length === 0) return null;

  return (
    <group>
      {systems.map((sys) => {
        const pos = eliteToThreeCentered(sys);
        return (
          <sprite key={sys.system_name} position={[pos.x, pos.y, pos.z]} scale={[8, 8, 1]}>
            <spriteMaterial map={texture} color="#8b0000" transparent opacity={0.7} depthWrite={false} />
          </sprite>
        );
      })}
    </group>
  );
}
