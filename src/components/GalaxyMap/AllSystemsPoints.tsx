'use client';

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import {
  id64FromParts,
  parsePointsFile,
  STAR_CLASS_COLORS,
  toMapPositions,
  type AllSystemsData,
} from '@/lib/galaxySystems';
import {
  buildPointGrid,
  pickAlongRay,
  worldUnitsPerPixel,
  type PickCamera,
  type PointGrid,
} from '@/lib/galaxyPointsPick';

/**
 * Experimental "all systems" layer.
 *
 * One Points object (a uniform sample of the catalog, GALAXY_POINTS_MAX).
 * Built-in raycasting walks every vertex and
 * freezes the tab, so it is disabled. Clicks are resolved by MapClickLayer
 * against a spatial grid, in screen pixels, and only when the pointer
 * barely moved (an orbit drag must not select a star).
 */

let moduleCache: AllSystemsData | null = null;
let inFlight: Promise<AllSystemsData> | null = null;

export function loadAllSystemsData(): Promise<AllSystemsData> {
  if (moduleCache) return Promise.resolve(moduleCache);
  if (!inFlight) {
    inFlight = (async () => {
      const res = await fetch('/api/galaxy/all-systems');
      if (!res.ok) {
        let message = `HTTP ${res.status}`;
        try {
          const body = await res.json();
          if (body?.error) message = body.error;
        } catch {
          // keep default
        }
        throw new Error(message);
      }
      moduleCache = parsePointsFile(await res.arrayBuffer());
      return moduleCache;
    })().finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

const POINT_VERTEX = `
  attribute float starClass;
  varying vec3 vColor;
  varying float vClass;
  void main() {
    vColor = color;
    vClass = starClass;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = 2.4;
  }
`;

const POINT_FRAGMENT = `
  uniform float uMask;
  varying vec3 vColor;
  varying float vClass;
  void main() {
    float bit = exp2(vClass);
    if (mod(floor(uMask / bit), 2.0) < 0.5) discard;
    vec2 c = gl_PointCoord - vec2(0.5);
    if (dot(c, c) > 0.25) discard;
    gl_FragColor = vec4(vColor, 0.9);
  }
`;

interface AllSystemsPointsProps {
  data: AllSystemsData;
  positions: Float32Array;
  visibleMask: number;
}

export function AllSystemsPoints({ data, positions, visibleMask }: AllSystemsPointsProps) {
  const { invalidate } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const colors = useMemo(() => {
    const out = new Float32Array(data.count * 3);
    for (let i = 0; i < data.count; i++) {
      const [r, g, b] = STAR_CLASS_COLORS[data.starTypes[i]] ?? STAR_CLASS_COLORS[15];
      out[i * 3] = r;
      out[i * 3 + 1] = g;
      out[i * 3 + 2] = b;
    }
    return out;
  }, [data]);

  useEffect(() => {
    if (materialRef.current) materialRef.current.uniforms.uMask.value = visibleMask;
    invalidate();
  }, [visibleMask, invalidate, positions]);

  return (
    <points frustumCulled={false} raycast={() => null}>
      <bufferGeometry key={data.count}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        <bufferAttribute attach="attributes-starClass" args={[data.starTypes, 1]} />
      </bufferGeometry>
      {/* ShaderMaterial injects the `color` attribute only when vertexColors is enabled. */}
      <shaderMaterial
        ref={materialRef}
        vertexShader={POINT_VERTEX}
        fragmentShader={POINT_FRAGMENT}
        uniforms={{ uMask: { value: visibleMask } }}
        vertexColors
        transparent
        depthWrite={false}
        fog={false}
        blending={THREE.AdditiveBlending}
      />
    </points>
  );
}

export function useMapPositions(data: AllSystemsData | null): Float32Array | null {
  return useMemo(() => (data ? toMapPositions(data.positions, data.count) : null), [data]);
}

/**
 * Ещё одно облако точек с выбором по клику (слой PowerPlay в Atlas). Его точки
 * крупнее точек каталога и стоят выше в приоритете: клик сначала ищет их.
 */
export interface MapClickPoints {
  positions: Float32Array;
  count: number;
  onPick: (index: number) => void;
  /** Радиус попадания вокруг курсора, CSS-пиксели. */
  pixelRadius?: number;
}

interface MapClickLayerProps {
  data: AllSystemsData | null;
  positions: Float32Array | null;
  visibleMask: number;
  enabled: boolean;
  onPick?: (id64: string, index: number) => void;
  onEmpty?: () => void;
  extraPoints?: MapClickPoints | null;
}

/** Click handler for the whole map: markers win, then extra points (PowerPlay), then a catalog star, then empty space. */
export function MapClickLayer({ data, positions, visibleMask, enabled, onPick, onEmpty, extraPoints = null }: MapClickLayerProps) {
  const { camera, gl, raycaster, scene } = useThree();
  const gridRef = useRef<PointGrid | null>(null);
  const extraGridRef = useRef<PointGrid | null>(null);
  const extraBoundsRef = useRef<Float32Array | null>(null);
  // Обработчик выбора меняется с каждым рендером родителя — держим его в ref,
  // чтобы не переподписывать слушатели canvas на каждый кадр данных.
  const extraPickRef = useRef<MapClickPoints['onPick'] | null>(null);
  extraPickRef.current = extraPoints?.onPick ?? null;
  const extraPositions = extraPoints?.positions ?? null;
  const extraCount = extraPoints?.count ?? 0;
  const extraRadius = extraPoints?.pixelRadius ?? 10;

  useEffect(() => {
    if (!enabled || !data || !positions) {
      gridRef.current = null;
      return;
    }
    gridRef.current = buildPointGrid(positions, data.count);
  }, [data, enabled, positions]);

  useEffect(() => {
    if (!extraPositions || extraCount <= 0) {
      extraGridRef.current = null;
      extraBoundsRef.current = null;
      return;
    }
    extraGridRef.current = buildPointGrid(extraPositions, extraCount);
    extraBoundsRef.current = pointBounds(extraPositions, extraCount);
  }, [extraPositions, extraCount]);

  useEffect(() => {
    const el = gl.domElement;
    let down: { x: number; y: number } | null = null;

    const onDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
    };
    const onUp = (event: PointerEvent) => {
      if (!down || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (moved > 4) return;

      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return;
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
      const hits = raycaster.intersectObjects(scene.children, true);
      const marker = hits.find((hit) => (
        !(hit.object instanceof THREE.Points)
        && !(hit.object instanceof THREE.Line)
        && !(hit.object instanceof THREE.LineSegments)
      ));
      if (marker) return;

      const origin = raycaster.ray.origin;
      const dir = raycaster.ray.direction;
      const ray = { ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z };
      const perspective = camera as THREE.PerspectiveCamera;
      const fov = perspective.fov || 45;
      const e = camera.matrixWorld.elements;
      const pickCamera: PickCamera = {
        position: { x: e[12], y: e[13], z: e[14] },
        right: { x: e[0], y: e[1], z: e[2] },
        up: { x: e[4], y: e[5], z: e[6] },
        forward: { x: -e[8], y: -e[9], z: -e[10] },
        fovY: (fov * Math.PI) / 180,
        width: rect.width,
        height: rect.height,
        clickX: event.clientX - rect.left,
        clickY: event.clientY - rect.top,
      };
      // Коридор вокруг луча: на глубине плоскости галактики (или камеры) —
      // в мировых единицах, с запасом на 14 пикселей. Точный отбор — в пикселях.
      const corridor = (fallbackDepth: number) => {
        let depth = fallbackDepth;
        if (Math.abs(dir.y) > 1e-4) {
          const t = -origin.y / dir.y;
          if (t > 10 && t < 200_000) depth = t;
        }
        return Math.max(8, worldUnitsPerPixel(depth, fov, rect.height) * 14);
      };

      const extraGrid = extraGridRef.current;
      if (extraGrid && extraPositions && extraPickRef.current) {
        // Пузырь держав далеко от центра карты (Sgr A*) и толщиной в сотни
        // световых лет: коридор считаем по самой дальней от камеры точке облака,
        // а не по плоскости галактики, — иначе система ниже плоскости промахнётся.
        const depth = farthestCorner(extraBoundsRef.current, pickCamera.position) ?? camera.position.length();
        const hit = pickAlongRay(extraGrid, extraPositions, ray, {
          threshold: Math.max(8, worldUnitsPerPixel(depth, fov, rect.height) * (extraRadius + 4)),
          camera: pickCamera,
          pixelRadius: extraRadius,
        });
        if (hit) {
          extraPickRef.current(hit.index);
          return;
        }
      }

      if (enabled && data && positions) {
        const grid = gridRef.current ?? buildPointGrid(positions, data.count);
        gridRef.current = grid;
        if (grid) {
          const hit = pickAlongRay(grid, positions, ray, {
            threshold: corridor(camera.position.length()),
            visibleMask,
            starTypes: data.starTypes,
            camera: pickCamera,
            pixelRadius: 12,
          });
          if (hit) {
            onPick?.(id64FromParts(data.id64Hi[hit.index], data.id64Lo[hit.index]), hit.index);
            return;
          }
        }
      }
      onEmpty?.();
    };

    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointerup', onUp);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
    };
  }, [camera, data, enabled, extraPositions, extraRadius, gl, onEmpty, onPick, positions, raycaster, scene, visibleMask]);

  return null;
}

/** Габариты облака точек: [minX, minY, minZ, maxX, maxY, maxZ]. */
function pointBounds(positions: Float32Array, count: number): Float32Array {
  const box = new Float32Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  const total = Math.min(count, Math.floor(positions.length / 3));
  for (let i = 0; i < total; i++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[i * 3 + axis];
      if (value < box[axis]) box[axis] = value;
      if (value > box[axis + 3]) box[axis + 3] = value;
    }
  }
  return box;
}

/** Расстояние от камеры до самого дальнего угла габаритов облака. */
function farthestCorner(box: Float32Array | null, from: { x: number; y: number; z: number }): number | null {
  if (!box || !Number.isFinite(box[0])) return null;
  const dx = Math.max(Math.abs(box[0] - from.x), Math.abs(box[3] - from.x));
  const dy = Math.max(Math.abs(box[1] - from.y), Math.abs(box[4] - from.y));
  const dz = Math.max(Math.abs(box[2] - from.z), Math.abs(box[5] - from.z));
  return Math.min(200_000, Math.hypot(dx, dy, dz));
}

export function SelectedStarRing({ position }: { position: [number, number, number] }) {
  const ref = useRef<THREE.Mesh>(null);
  const { camera, invalidate } = useThree();

  useFrame(() => {
    const mesh = ref.current;
    if (!mesh) return;
    const dist = camera.position.distanceTo(mesh.position);
    const scale = Math.max(18, dist * 0.012);
    if (Math.abs(mesh.scale.x - scale) > 0.5) {
      mesh.scale.setScalar(scale);
    }
  });

  return (
    <mesh ref={ref} position={position} raycast={() => null}>
      <octahedronGeometry args={[1, 0]} />
      <meshBasicMaterial color="#ffd166" wireframe depthTest={false} />
    </mesh>
  );
}
