'use client';

/**
 * Слой визуализации процесса поиска Atlas на 3D-карте.
 *
 * Раньше прогресс поиска был виден только полоской внутри формы, а карта
 * оживала лишь после ответа сервера. Теперь карта показывает сам процесс:
 *   • сегмент кольца со «лучом» сканирования и опорными точками;
 *   • коридор A→B и точки, найденные по ходу перебора;
 *   • куб поиска миров вокруг опорной системы;
 *   • найденные системы, расчётные (триангулированные) точки и станции.
 *
 * Слой читает состояние канала прогресса (lib/atlasSearchProgress) и включается
 * только во время активного поиска, поэтому обычная карта не тяжелеет.
 */

import { useMemo, useRef } from 'react';
import { Line } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { eliteToThree, eliteToThreeCentered } from '@/lib/ed3dCanon';
import type { AtlasSearchPoint, AtlasSearchPointKind, AtlasSearchProgress } from '@/lib/atlasSearchProgress';

/** Цвета маркеров процесса поиска. */
const KIND_COLORS: Record<AtlasSearchPointKind, string> = {
  found: '#4dd0e1',
  system: '#8bc34a',
  anchor: '#e67e22',
  triangulated: '#9ca3af',
  station: '#f1c40f',
  'no-market': '#e74c3c',
  scanned: '#546e7a',
  'hub-found': '#22c55e',     // зелёный: хаб-кандидат найден
  'hub-missing': '#ef4444',   // красный: хаб не найден, нужна разведка
  'key-system': '#60a5fa',    // синий: пользовательская ключевая система
};

/** Размер маркера в мировых единицах (кластеры растут вместе с зумом). */
const KIND_SIZES: Record<AtlasSearchPointKind, number> = {
  found: 30,
  system: 22,
  anchor: 40,
  triangulated: 14,
  station: 32,
  'no-market': 20,
  scanned: 14,
  'hub-found': 36,
  'hub-missing': 28,
  'key-system': 44,
};

const PROGRESS_ORANGE = '#e67e22';
const PROGRESS_GREEN = '#22c55e';

function toVector(point: { x: number; y: number; z: number }): THREE.Vector3 {
  return eliteToThreeCentered(point);
}

/** Одна группа точек одного типа — рисуется одним THREE.Points (быстро). */
function PointCloud({ points, color, size }: { points: AtlasSearchPoint[]; color: string; size: number }) {
  const geometry = useMemo(() => {
    const array = new Float32Array(points.length * 3);
    points.forEach((point, index) => {
      const vector = toVector(point);
      array[index * 3] = vector.x;
      array[index * 3 + 1] = vector.y;
      array[index * 3 + 2] = vector.z;
    });
    const buffer = new THREE.BufferGeometry();
    buffer.setAttribute('position', new THREE.BufferAttribute(array, 3));
    return buffer;
  }, [points]);

  const material = useMemo(
    () =>
      new THREE.PointsMaterial({
        color,
        size,
        sizeAttenuation: true,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
      }),
    [color, size],
  );

  return <points geometry={geometry} material={material} raycast={() => null} />;
}

/** Точки прогресса, разложенные по типам: у каждого свой цвет и размер. */
function ProgressPoints({ points }: { points: AtlasSearchPoint[] }) {
  const byKind = useMemo(() => {
    const map = new Map<AtlasSearchPointKind, AtlasSearchPoint[]>();
    for (const point of points) {
      const kind = (point.kind || 'system') as AtlasSearchPointKind;
      const list = map.get(kind);
      if (list) list.push(point);
      else map.set(kind, [point]);
    }
    return map;
  }, [points]);

  if (points.length === 0) return null;

  return (
    <group>
      {Array.from(byKind.entries()).map(([kind, list]) => (
        <PointCloud key={kind} points={list} color={KIND_COLORS[kind] || KIND_COLORS.system} size={KIND_SIZES[kind] || 20} />
      ))}
    </group>
  );
}

/** Кольцо поиска: контур, вращающийся луч и «прогресс» яркой дугой. */
function RingGuide({ ring, percent }: { ring: NonNullable<AtlasSearchProgress['ring']>; percent: number }) {
  const center = useMemo(() => toVector({ x: ring.cx, y: ring.cy, z: ring.cz }), [ring.cx, ring.cy, ring.cz]);

  const ringPoints = useMemo(() => {
    const SEGMENTS = 256;
    const points: [number, number, number][] = [];
    for (let index = 0; index <= SEGMENTS; index++) {
      const angle = (index / SEGMENTS) * Math.PI * 2;
      points.push([
        center.x + Math.cos(angle) * ring.radius,
        center.y,
        center.z + Math.sin(angle) * ring.radius,
      ]);
    }
    return points;
  }, [center, ring.radius]);

  const sweep = useMemo(() => {
    const angle = (Math.min(100, Math.max(0, percent)) / 100) * Math.PI * 2;
    return [
      [center.x, center.y, center.z] as [number, number, number],
      [center.x + Math.cos(angle) * ring.radius, center.y, center.z + Math.sin(angle) * ring.radius] as [number, number, number],
    ];
  }, [center, percent, ring.radius]);

  return (
    <group>
      <Line points={ringPoints} color={PROGRESS_ORANGE} lineWidth={1.5} transparent opacity={0.55} />
      <Line points={[sweep[0], sweep[1]]} color="#ffd166" lineWidth={2} transparent opacity={0.8} />
      <CentralPulse position={center} color={PROGRESS_ORANGE} />
    </group>
  );
}

/** Полоса сканирования A→B и границы радиуса перебора. */
function CorridorGuide({ corridor }: { corridor: NonNullable<AtlasSearchProgress['corridor']> }) {
  const from = useMemo(() => toVector(corridor.from), [corridor.from]);
  const to = useMemo(() => toVector(corridor.to), [corridor.to]);

  return (
    <group>
      <Line
        points={[[from.x, from.y, from.z], [to.x, to.y, to.z]]}
        color={PROGRESS_ORANGE}
        lineWidth={1.5}
        dashed
        dashSize={400}
        gapSize={260}
        transparent
        opacity={0.7}
      />
      <ScanMarker position={from} color={PROGRESS_GREEN} />
      <ScanMarker position={to} color="#3498db" />
    </group>
  );
}

/** Куб поиска миров: рамка вокруг опорной системы. */
function CubeGuide({ cube }: { cube: NonNullable<AtlasSearchProgress['cube']> }) {
  const center = useMemo(() => toVector({ x: cube.cx, y: cube.cy, z: cube.cz }), [cube.cx, cube.cy, cube.cz]);
  const geometry = useMemo(() => {
    const box = new THREE.BoxGeometry(cube.half * 2, cube.half * 2, cube.half * 2);
    const edges = new THREE.EdgesGeometry(box);
    box.dispose();
    return edges;
  }, [cube.half]);

  return (
    <lineSegments geometry={geometry} position={[center.x, center.y, center.z]} raycast={() => null}>
      <lineBasicMaterial color={PROGRESS_ORANGE} transparent opacity={0.35} />
    </lineSegments>
  );
}

/** Готовый/растущий маршрут поиска. */
function PathGuide({ path }: { path: AtlasSearchPoint[] }) {
  const points = useMemo(
    () => path.map((point) => {
      const vector = toVector(point);
      return [vector.x, vector.y, vector.z] as [number, number, number];
    }),
    [path],
  );
  if (points.length < 2) return null;
  return <Line points={points} color={PROGRESS_GREEN} lineWidth={1.6} transparent opacity={0.85} />;
}

/** Пульсирующий маркер текущей точки сканирования. */
function ScanBeam({ beam }: { beam: NonNullable<AtlasSearchProgress['beam']> }) {
  const position = useMemo(() => toVector(beam), [beam]);
  const ringRef = useRef<THREE.Mesh>(null);
  const columnRef = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    const scale = 1 + Math.sin(time * 3) * 0.25;
    ringRef.current?.scale.set(scale, scale, 1);
    if (columnRef.current) {
      const material = columnRef.current.material as THREE.MeshBasicMaterial;
      material.opacity = 0.25 + Math.abs(Math.sin(time * 2)) * 0.35;
    }
  });

  return (
    <group position={[position.x, position.y, position.z]}>
      <mesh ref={ringRef} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
        <ringGeometry args={[60, 90, 48]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.9} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <mesh ref={columnRef} raycast={() => null}>
        <cylinderGeometry args={[6, 6, 900, 8, 1, true]} />
        <meshBasicMaterial color="#ffd166" transparent opacity={0.4} depthWrite={false} />
      </mesh>
    </group>
  );
}

/** Статичный маркер важной точки (центр кольца, концы коридора). */
function ScanMarker({ position, color }: { position: THREE.Vector3; color: string }) {
  return (
    <mesh position={[position.x, position.y, position.z]} rotation={[Math.PI / 2, 0, 0]} raycast={() => null}>
      <ringGeometry args={[30, 55, 40]} />
      <meshBasicMaterial color={color} transparent opacity={0.85} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

/** Пульс в центре кольца — видно, вокруг чего строится маршрут. */
function CentralPulse({ position, color }: { position: THREE.Vector3; color: string }) {
  return <ScanMarker position={position} color={color} />;
}

/**
 * Закреплённый итог поиска: контур кольца, линия маршрута и найденные точки.
 *
 * Рисуется без анимаций и без луча: поиск уже закончился, а результат должен
 * оставаться на карте, пока пользователь его не уберёт. Раньше слой исчезал
 * вместе с оверлеем прогресса, и найденное кольцо пропадало с карты через
 * 30 секунд после сборки маршрута.
 */
function ResultGeometry({ result }: { result: AtlasSearchProgress }) {
  return (
    <group>
      {result.ring && <RingOutline ring={result.ring} />}
      {result.corridor && <CorridorGuide corridor={result.corridor} />}
      {result.cube && <CubeGuide cube={result.cube} />}
      <ProgressPoints points={result.points} />
      {result.path.length > 1 && <PathGuide path={result.path} />}
    </group>
  );
}

/** Контур кольца без вращающегося луча и пульса — для готового результата. */
function RingOutline({ ring }: { ring: NonNullable<AtlasSearchProgress['ring']> }) {
  const center = useMemo(() => toVector({ x: ring.cx, y: ring.cy, z: ring.cz }), [ring.cx, ring.cy, ring.cz]);
  const ringPoints = useMemo(() => {
    const SEGMENTS = 256;
    const points: [number, number, number][] = [];
    for (let index = 0; index <= SEGMENTS; index++) {
      const angle = (index / SEGMENTS) * Math.PI * 2;
      points.push([
        center.x + Math.cos(angle) * ring.radius,
        center.y,
        center.z + Math.sin(angle) * ring.radius,
      ]);
    }
    return points;
  }, [center, ring.radius]);

  return (
    <group>
      <Line points={ringPoints} color={PROGRESS_ORANGE} lineWidth={1.2} transparent opacity={0.4} />
      <ScanMarker position={center} color={PROGRESS_ORANGE} />
    </group>
  );
}

export function SearchProgressLayer({
  progress,
  result = null,
}: {
  progress: AtlasSearchProgress;
  /** Итог последнего поиска: остаётся на карте после того, как оверлей погас. */
  result?: AtlasSearchProgress | null;
}) {
  const { invalidate } = useThree();
  const active = progress.active;

  // Карта работает в режиме frameloop="demand": пока идёт поиск, сами просим
  // кадры, чтобы пульс и луч двигались, а после завершения — перестаём.
  useFrame(() => {
    if (active) invalidate();
  });

  // Пока идёт поиск, показываем живой процесс; как только он закончился —
  // закреплённый итог, чтобы найденное не исчезало вместе с оверлеем.
  if (active) {
    return (
      <group>
        {progress.ring && <RingGuide ring={progress.ring} percent={progress.percent} />}
        {progress.corridor && <CorridorGuide corridor={progress.corridor} />}
        {progress.cube && <CubeGuide cube={progress.cube} />}
        <ProgressPoints points={progress.points} />
        {progress.path.length > 1 && <PathGuide path={progress.path} />}
        {progress.beam && <ScanBeam beam={progress.beam} />}
      </group>
    );
  }

  if (result) return <ResultGeometry result={result} />;
  return null;
}

/** Позиция в мировых координатах three для точки каталога (для тестов/отладки). */
export function atlasPointToThree(point: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  const vector = eliteToThree(point);
  return { x: vector.x, y: vector.y, z: vector.z };
}
