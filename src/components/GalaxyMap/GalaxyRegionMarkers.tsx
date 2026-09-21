'use client';

import { Html } from '@react-three/drei';
import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import * as THREE from 'three';
import regionPack from '@/lib/galacticRegions.json';

const REGIONS = (regionPack as { regions: Array<{ id: number; name: string; cx: number; cz: number }> }).regions;

function RegionMarker({ region, showLabel }: { region: (typeof REGIONS)[number]; showLabel: boolean }) {
  const router = useRouter();
  const position = useMemo(() => new THREE.Vector3(region.cx, 0, -region.cz), [region]);
  const material = useMemo(
    () =>
      new THREE.SpriteMaterial({
        color: '#e67e22',
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
      }),
    []
  );

  return (
    <group position={[position.x, position.y, position.z]}>
      <sprite material={material} scale={[70, 70, 1]} />
      {showLabel && (
        <Html position={[0, 60, 0]} center style={{ pointerEvents: 'auto', cursor: 'pointer' }} zIndexRange={[100, 0]}>
          <div
            onClick={(event) => {
              event.stopPropagation();
              router.push(`/atlas/sector/${region.id}`);
            }}
            style={{
              color: '#eeeeee',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '2px',
              whiteSpace: 'nowrap',
              textTransform: 'uppercase',
              background: 'rgba(26, 28, 30, 0.88)',
              border: '1px solid #3a3d40',
              padding: '3px 8px',
              borderRadius: '2px',
              boxShadow: 'none',
              transform: 'translateX(-50%)',
              transition: 'border-color 0.15s, color 0.15s',
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.borderColor = '#e67e22';
              e.currentTarget.style.color = '#e67e22';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.borderColor = '#3a3d40';
              e.currentTarget.style.color = '#eeeeee';
            }}
          >
            {region.name}
          </div>
        </Html>
      )}
    </group>
  );
}

/** Names and canonical centroid markers for the 42 official codex regions. */
export function GalaxyRegionMarkers({ showLabels = true }: { showLabels?: boolean }) {
  return (
    <group>
      {REGIONS.map((region) => (
        <RegionMarker key={region.id} region={region} showLabel={showLabels} />
      ))}
    </group>
  );
}
