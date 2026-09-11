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
  const pos = eliteToThreeCentered(hub);
  const color = hub.status === 'done' ? '#22c55e' : hub.status === 'building' ? '#e67e22' : '#3b82f6';

  useFrame((_, delta) => {
    // The previous `delta * 6` lerp factor could exceed 1 on a slow frame and
    // overshoot dramatically. This damping factor never overshoots.
    const alpha = 1 - Math.exp(-8 * delta);
    const target = isSelected ? 1.45 : hovered ? 1.2 : 1;
    const targetScale = new THREE.Vector3(target, target, target);
    meshRef.current?.scale.lerp(targetScale, alpha);
    glowRef.current?.scale.lerp(targetScale, alpha);
  });

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      <mesh ref={glowRef} raycast={() => null}>
        <sphereGeometry args={[5.5, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.12}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
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
        <sphereGeometry args={[3, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.6} transparent opacity={0.9} />
      </mesh>
      {isSelected && (
        <mesh raycast={() => null}>
          <ringGeometry args={[5.5, 6.4, 32]} />
          <meshBasicMaterial color="#e67e22" side={THREE.DoubleSide} transparent opacity={0.8} />
        </mesh>
      )}
      <Text
        position={[0, 6, 0]}
        fontSize={3}
        color="#eeeeee"
        anchorX="center"
        anchorY="bottom"
        visible={hovered || isSelected}
        raycast={() => null}
      >
        {hub.name}
      </Text>
    </group>
  );
}

export function HubMarkers({ hubs, onSelectHub, selectedHubId }: HubMarkersProps) {
  const byId = useMemo(() => new Map(hubs.map((hub) => [hub.id, hub])), [hubs]);

  return (
    <group>
      {hubs.map((hub) => (
        <HubSphere
          key={hub.id}
          hub={hub}
          isSelected={selectedHubId === hub.id}
          onClick={() => onSelectHub?.(selectedHubId === hub.id ? null : (byId.get(hub.id) || hub))}
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
          {hub.goals.map((goal: any) => (
            <div key={goal.id} style={{ fontSize: 12, color: '#eeeeee', marginBottom: 2 }}>
              {goal.commodity}: {goal.current_amount}/{goal.target_amount} {goal.unit}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
