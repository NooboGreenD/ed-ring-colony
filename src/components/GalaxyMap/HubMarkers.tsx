'use client';
import React, { useMemo } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { Hub } from '@/types/hub';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

interface HubMarkersProps {
  hubs: Hub[];
  onSelectHub?: (hub: Hub | null) => void;
  selectedHubId?: number | null;
}

function HubSphere({ hub, isSelected, onClick }: { hub: Hub; isSelected: boolean; onClick: () => void }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const glowRef = React.useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = React.useState(false);

  useFrame((_, delta) => {
    if (!meshRef.current) return;
    const targetScale = isSelected ? 1.6 : hovered ? 1.3 : 1;
    meshRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 6);
    if (glowRef.current) {
      glowRef.current.scale.lerp(new THREE.Vector3(targetScale, targetScale, targetScale), delta * 6);
    }
  });

  const color = hub.status === 'done' ? '#22c55e' : hub.status === 'building' ? '#e67e22' : '#3b82f6';
  const pos = eliteToThreeCentered(hub);

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      {/* Свечение (ореол) */}
      <mesh ref={glowRef}>
        <sphereGeometry args={[isSelected ? 8 : 6, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* Основная сфера */}
      <mesh ref={meshRef} onClick={onClick} onPointerOver={() => setHovered(true)} onPointerOut={() => setHovered(false)}>
        <sphereGeometry args={[isSelected ? 5 : 3, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} transparent opacity={0.9} />
      </mesh>
      {isSelected && (
        <mesh>
          <ringGeometry args={[6, 7, 32]} />
          <meshBasicMaterial color="#e67e22" side={THREE.DoubleSide} transparent opacity={0.8} />
        </mesh>
      )}
      <Text position={[0, 6, 0]} fontSize={3} color="#eeeeee" anchorX="center" anchorY="bottom" visible={hovered || isSelected}>
        {hub.name}
      </Text>
    </group>
  );
}

export function HubMarkers({ hubs, onSelectHub, selectedHubId }: HubMarkersProps) {
  const byId = useMemo(() => new Map(hubs.map((h) => [h.id, h])), [hubs]);

  return (
    <group>
      {hubs.map((hub) => (
        <HubSphere
          key={hub.id}
          hub={hub}
          isSelected={selectedHubId === hub.id}
          onClick={() => onSelectHub?.(byId.get(hub.id) || hub)}
        />
      ))}
    </group>
  );
}

export function HubTooltip({ hub }: { hub: Hub }) {
  return (
    <div style={{ background: '#25282b', border: '1px solid #3a3d40', borderRadius: 8, padding: 12, minWidth: 220, pointerEvents: 'auto' }}>
      <div style={{ fontWeight: 700, fontSize: 16, color: '#eeeeee' }}>{hub.name}</div>
      <div style={{ fontSize: 13, color: '#9ca3af' }}>{hub.system_name}</div>
      <div style={{ marginTop: 6, fontSize: 13, color: '#eeeeee' }}>
        Статус: <span style={{ color: hub.status === 'done' ? '#22c55e' : hub.status === 'building' ? '#e67e22' : '#3b82f6' }}>
          {hub.status === 'done' ? 'Завершён' : hub.status === 'building' ? 'Строительство' : 'Запланирован'}
        </span>
      </div>
      {hub.progress != null && (
        <div style={{ marginTop: 6, fontSize: 13, color: '#eeeeee' }}>Прогресс: {hub.progress}%</div>
      )}
      {hub.goals && hub.goals.length > 0 && (
        <div style={{ marginTop: 8, borderTop: '1px solid #3a3d40', paddingTop: 6 }}>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 4 }}>Цели:</div>
          {hub.goals.map((g: any) => (
            <div key={g.id} style={{ fontSize: 12, color: '#eeeeee', marginBottom: 2 }}>
              {g.commodity}: {g.current_amount}/{g.target_amount} {g.unit}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
