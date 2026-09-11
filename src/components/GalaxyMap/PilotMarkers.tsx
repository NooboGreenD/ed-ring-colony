'use client';

import React, { useMemo } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

export interface Pilot {
  user_id: string;
  cmdr_name: string;
  system_name: string;
  x: number;
  y: number;
  z: number;
  ship_name?: string | null;
  last_updated?: string;
}

interface PilotMarkersProps {
  pilots: Pilot[];
  selectedPilotId?: string | null;
  onSelectPilot?: (pilot: Pilot | null) => void;
}

function PilotSphere({ pilot, isSelected, onClick }: { pilot: Pilot; isSelected: boolean; onClick: () => void }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const glowRef = React.useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = React.useState(false);
  const pos = eliteToThreeCentered(pilot);

  useFrame((_, delta) => {
    const alpha = 1 - Math.exp(-8 * delta);
    const target = isSelected ? 1.45 : hovered ? 1.2 : 1;
    const targetScale = new THREE.Vector3(target, target, target);
    meshRef.current?.scale.lerp(targetScale, alpha);
    glowRef.current?.scale.lerp(targetScale, alpha);
  });

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      <mesh ref={glowRef} raycast={() => null}>
        <sphereGeometry args={[4.5, 16, 16]} />
        <meshBasicMaterial color="#00bcd4" transparent opacity={0.1} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh
        ref={meshRef}
        onClick={(event) => {
          event.stopPropagation();
          onClick();
        }}
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
        <meshStandardMaterial color="#00bcd4" emissive="#00bcd4" emissiveIntensity={0.6} transparent opacity={0.9} />
      </mesh>
      {isSelected && (
        <mesh raycast={() => null}>
          <ringGeometry args={[5, 5.8, 32]} />
          <meshBasicMaterial color="#e67e22" side={THREE.DoubleSide} transparent opacity={0.8} />
        </mesh>
      )}
      <Text position={[0, 5, 0]} fontSize={2.5} color="#eeeeee" anchorX="center" anchorY="bottom" visible={hovered || isSelected} raycast={() => null}>
        {pilot.cmdr_name}
      </Text>
    </group>
  );
}

export function PilotMarkers({ pilots, selectedPilotId, onSelectPilot }: PilotMarkersProps) {
  const byId = useMemo(() => new Map(pilots.map((pilot) => [pilot.user_id, pilot])), [pilots]);

  return (
    <group>
      {pilots.map((pilot) => (
        <PilotSphere
          key={pilot.user_id}
          pilot={pilot}
          isSelected={selectedPilotId === pilot.user_id}
          onClick={() => onSelectPilot?.(selectedPilotId === pilot.user_id ? null : (byId.get(pilot.user_id) || pilot))}
        />
      ))}
    </group>
  );
}
