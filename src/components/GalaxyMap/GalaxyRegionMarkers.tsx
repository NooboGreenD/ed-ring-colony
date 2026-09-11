'use client';

import { Html } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import regionPack from '@/lib/galacticRegions.json';

const REGIONS = (regionPack as { regions: Array<{ id: number; name: string; cx: number; cz: number }> }).regions;

function RegionMarker({ region }: { region: (typeof REGIONS)[number] }) {
  const position = useMemo(() => new THREE.Vector3(region.cx, 0, -region.cz), [region]);
  const material = useMemo(() => new THREE.SpriteMaterial({ color: '#82b8ff', transparent: true, opacity: 0.92, depthWrite: false, depthTest: false }), []);

  return (
    <group position={[position.x, position.y, position.z]}>
      <sprite material={material} scale={[75, 75, 1]} />
      <Html position={[0, 65, 0]} distanceFactor={950} center style={{ pointerEvents: 'none' }}>
        <div style={{
          color: '#b9d5ff', fontFamily: 'ui-monospace, monospace', fontSize: 14,
          fontWeight: 700, letterSpacing: '.5px', whiteSpace: 'nowrap', textShadow: '0 0 6px #07152d, 0 0 12px #000',
          background: 'rgba(3, 10, 24, .82)', border: '1px solid rgba(130,184,255,.55)',
          borderRadius: 3, padding: '3px 7px', transform: 'translateX(-50%)',
        }}>
          {region.name}
        </div>
      </Html>
    </group>
  );
}

/** Names and canonical centroid markers for the 42 official codex regions. */
export function GalaxyRegionMarkers() {
  return <group>{REGIONS.map((region) => <RegionMarker key={region.id} region={region} />)}</group>;
}
