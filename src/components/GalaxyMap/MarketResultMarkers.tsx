'use client';

import React from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

export interface MarketResult {
  system_name: string;
  distance: number;
  x?: number;
  y?: number;
  z?: number;
  station_name?: string;
  commodities_found?: number;
}

interface MarketResultMarkersProps {
  systems: MarketResult[];
}

function hasCoordinates(result: MarketResult): result is MarketResult & { x: number; y: number; z: number } {
  return Number.isFinite(result.x) && Number.isFinite(result.y) && Number.isFinite(result.z);
}

function MarketResultPoint({ result }: { result: MarketResult & { x: number; y: number; z: number } }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const glowRef = React.useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = React.useState(false);
  const pos = eliteToThreeCentered(result);

  useFrame((_, delta) => {
    const alpha = 1 - Math.exp(-8 * delta);
    const target = hovered ? 1.2 : 1;
    const targetScale = new THREE.Vector3(target, target, target);
    meshRef.current?.scale.lerp(targetScale, alpha);
    glowRef.current?.scale.lerp(targetScale, alpha);
  });

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      <mesh ref={glowRef} raycast={() => null}>
        <sphereGeometry args={[4, 16, 16]} />
        <meshBasicMaterial color="#22c55e" transparent opacity={0.15} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh
        ref={meshRef}
        onPointerOver={(event) => {
          event.stopPropagation();
          setHovered(true);
          document.body.style.cursor = 'pointer';
        }}
        onPointerOut={(event) => {
          event.stopPropagation();
          setHovered(false);
          document.body.style.cursor = 'auto';
        }}
      >
        <sphereGeometry args={[2.5, 16, 16]} />
        <meshStandardMaterial color="#22c55e" emissive="#22c55e" emissiveIntensity={0.6} transparent opacity={0.9} />
      </mesh>
      <Text position={[0, 5, 0]} fontSize={2.5} color="#22c55e" anchorX="center" anchorY="bottom" visible={hovered} raycast={() => null}>
        {result.system_name}{result.station_name ? ` — ${result.station_name}` : ''}
      </Text>
    </group>
  );
}

export function MarketResultMarkers({ systems }: MarketResultMarkersProps) {
  // Older search results did not include coordinates. Rendering them at
  // [0, 0, 0] created a stack of interactive spheres at one point. Skip such
  // rows rather than inventing a position.
  const positionedSystems = systems.filter(hasCoordinates);
  if (positionedSystems.length === 0) return null;

  return (
    <group>
      {positionedSystems.map((result) => (
        <MarketResultPoint key={`${result.system_name}-${result.station_name ?? ''}`} result={result} />
      ))}
    </group>
  );
}
