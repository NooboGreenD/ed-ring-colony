'use client';

import React, { useMemo } from 'react';
import { Text } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { RouteSystem } from '@/types/hub';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';

interface RouteMarkersProps {
  points: RouteSystem[];
  onSelectPoint?: (point: RouteSystem | null) => void;
  selectedPointId?: number | null;
}

/**
 * Сколько интерактивных маркеров карта выдерживает без тормозов.
 *
 * Маршрут галактического кольца — это 5–15 тысяч точек (прыжок ≤ 14,99 св.л.
 * на окружности в 23 000 св.л.), а каждый маркер — это группа из трёх мешей
 * плюс подпись. На длинном маршруте такой слой не отрисовывался вовсе: вкладка
 * зависала ещё до первого кадра. Поэтому свыше порога точки рисуются одним
 * облаком THREE.Points, а кликабельными остаются только равномерно выбранные.
 */
const DENSE_ROUTE_LIMIT = 250;

function smoothScale(mesh: THREE.Object3D | null, target: number, delta: number) {
  if (!mesh) return;
  // `delta * rate` can be greater than 1 while the heavy 3D scene is loading.
  // Vector3.lerp then overshoots, which made one hovered marker balloon far
  // beyond the intended size. Exponential damping is always in [0, 1].
  const alpha = 1 - Math.exp(-8 * delta);
  mesh.scale.lerp(new THREE.Vector3(target, target, target), alpha);
}

const STATUS_COLORS: Record<string, string> = {
  done: '#22c55e',
  building: '#e67e22',
  planned: '#9ca3af',
};

function RoutePoint({ point, isSelected, onClick }: { point: RouteSystem; isSelected: boolean; onClick: () => void }) {
  const meshRef = React.useRef<THREE.Mesh>(null);
  const glowRef = React.useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = React.useState(false);
  const pos = eliteToThreeCentered(point);
  const color = STATUS_COLORS[point.status] || STATUS_COLORS.planned;

  useFrame((_, delta) => {
    const targetScale = isSelected ? 1.45 : hovered ? 1.2 : 1;
    smoothScale(meshRef.current, targetScale, delta);
    smoothScale(glowRef.current, targetScale, delta);
  });

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      {/* Visual-only meshes must not participate in raycasting. */}
      <mesh ref={glowRef} raycast={() => null}>
        <sphereGeometry args={[4.5, 16, 16]} />
        <meshBasicMaterial
          color={color}
          transparent
          opacity={0.10}
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
        <sphereGeometry args={[2.5, 16, 16]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={0.5} transparent opacity={0.85} />
      </mesh>
      {isSelected && (
        <mesh raycast={() => null}>
          <ringGeometry args={[5, 5.8, 32]} />
          <meshBasicMaterial color="#e67e22" side={THREE.DoubleSide} transparent opacity={0.7} />
        </mesh>
      )}
      {/* Подпись строится только для видимой точки: троика генерирует SDF-текст
          на каждую строку, и тысячи невидимых подписей тормозили сцену. */}
      {(hovered || isSelected) && (
        <Text
          font="/fonts/DejaVuSans.ttf"
          position={[0, 5, 0]}
          fontSize={2.5}
          color="#9ca3af"
          anchorX="center"
          anchorY="bottom"
          raycast={() => null}
        >
          {point.system_name}
        </Text>
      )}
    </group>
  );
}

/**
 * Длинные маршруты (кольцо, маршрут через тысячи систем) одним облаком точек:
 * геометрия собирается один раз и не создаёт React-компонент на точку.
 */
function DenseRoutePoints({ points }: { points: RouteSystem[] }) {
  const geometry = useMemo(() => {
    const positions = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      const vector = eliteToThreeCentered(point);
      positions[index * 3] = vector.x;
      positions[index * 3 + 1] = vector.y;
      positions[index * 3 + 2] = vector.z;
    });
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    return buffer;
  }, [points]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        color: '#3b82f6',
        size: 14,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
      }),
    [],
  );

  React.useEffect(
    () => () => {
      geometry.dispose();
      material.dispose();
    },
    [geometry, material],
  );

  return <points geometry={geometry} material={material} raycast={() => null} />;
}

export function RouteMarkers({ points, onSelectPoint, selectedPointId }: RouteMarkersProps) {
  const byId = useMemo(() => new Map(points.map((point) => [point.id, point])), [points]);

  // Равномерная выборка: интерактивные маркеры распределяются по всему
  // маршруту, поэтому кликабельные точки есть и в начале, и в середине, и в
  // конце кольца, а не только в первых 250 системах.
  const interactive = useMemo(() => {
    if (points.length <= DENSE_ROUTE_LIMIT) return points;
    const stride = points.length / DENSE_ROUTE_LIMIT;
    const sampled: RouteSystem[] = [];
    for (let index = 0; index < DENSE_ROUTE_LIMIT; index++) {
      sampled.push(points[Math.min(points.length - 1, Math.round(index * stride))]);
    }
    return sampled;
  }, [points]);

  const dense = points.length > DENSE_ROUTE_LIMIT;

  return (
    <group>
      {dense && <DenseRoutePoints points={points} />}
      {interactive.map((point) => (
        <RoutePoint
          // A stable key keeps a selected/hovered marker from being recreated
          // during each 30-second data refresh.
          key={point.id}
          point={point}
          isSelected={selectedPointId === point.id}
          onClick={() => onSelectPoint?.(selectedPointId === point.id ? null : (byId.get(point.id) || point))}
        />
      ))}
    </group>
  );
}

export function RouteTooltip({ point }: { point: RouteSystem }) {
  return (
    <div style={{ background: '#25282b', border: '1px solid #3a3d40', borderRadius: 8, padding: 12, minWidth: 200, pointerEvents: 'auto' }}>
      <div style={{ fontWeight: 700, fontSize: 15, color: '#eeeeee' }}>{point.system_name}</div>
      <div style={{ marginTop: 4, fontSize: 13, color: '#9ca3af' }}>
        Статус: <span style={{ color: point.status === 'done' ? '#22c55e' : point.status === 'building' ? '#e67e22' : '#9ca3af' }}>
          {point.status === 'done' ? 'Завершён' : point.status === 'building' ? 'Строительство' : 'Запланирован'}
        </span>
      </div>
      {point.progress != null && (
        <div style={{ marginTop: 4, fontSize: 13, color: '#eeeeee' }}>
          Прогресс: {point.progress}%
        </div>
      )}
      {point.total_delivered != null && (
        <div style={{ marginTop: 6, fontSize: 12, color: '#9ca3af' }}>
          Доставлено: {Number(point.total_delivered).toLocaleString('ru')} т
        </div>
      )}
    </div>
  );
}
