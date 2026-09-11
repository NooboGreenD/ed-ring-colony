'use client';

import { Html } from '@react-three/drei';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import regionPack from '@/lib/galacticRegions.json';

const REGIONS = (regionPack as { regions: Array<{ id: number; name: string; cx: number; cz: number }> }).regions;

function RegionMarker({ region }: { region: (typeof REGIONS)[number] }) {
  const router = useRouter();
  const position = useMemo(() => new THREE.Vector3(region.cx, 0, -region.cz), [region]);
  const material = useMemo(() => new THREE.SpriteMaterial({ color: '#82b8ff', transparent: true, opacity: 0.92, depthWrite: false, depthTest: false }), []);

  return (
    <group position={[position.x, position.y, position.z]}>
      <sprite material={material} scale={[75, 75, 1]} />
      <Html position={[0, 65, 0]} center style={{ pointerEvents: 'auto', cursor: 'pointer' }} zIndexRange={[100, 0]}>
        <div onClick={(event) => { event.stopPropagation(); router.push(`/atlas/sector/${region.id}`); }} style={{
          color: '#d8e8ff', fontFamily: '"Eurostile", "Orbitron", "Rajdhani", "Trebuchet MS", sans-serif', fontSize: 16,
          fontWeight: 700, letterSpacing: '1.2px', whiteSpace: 'nowrap', textTransform: 'uppercase',
          textShadow: '0 0 5px #4c9dff, 0 0 12px #07152d, 0 2px 4px #000',
          transform: 'translateX(-50%)',
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
