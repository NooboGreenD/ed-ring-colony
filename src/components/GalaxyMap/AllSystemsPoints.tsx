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
  /**
   * Наведение мыши: индекс точки под курсором (или null) и положение курсора
   * в координатах canvas. Пока курсор над точкой, он становится «рукой» —
   * видно, что систему можно выбрать кликом.
   */
  onHover?: (index: number | null, at: { x: number; y: number } | null) => void;
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
  const extraHoverRef = useRef<MapClickPoints['onHover'] | null>(null);
  extraHoverRef.current = extraPoints?.onHover ?? null;
  const hasHover = Boolean(extraPoints?.onHover);
  // Наведение переживает движение камеры (колесо, облёт): кадр с новой камерой
  // перепроверяет точку под неподвижным курсором. После клика подсказка молчит,
  // пока мышь снова не сдвинется, — иначе во время перелёта она мигала бы.
  const hoverRef = useRef<{
    lastPointer: { x: number; y: number } | null;
    suppressed: boolean;
    matrix: Float64Array;
    repick: (() => void) | null;
  }>({ lastPointer: null, suppressed: false, matrix: new Float64Array(16), repick: null });
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

  useFrame(() => {
    const hover = hoverRef.current;
    if (!hover.repick || !hover.lastPointer || hover.suppressed) return;
    // Управление камерой уже сдвинуло её в этом кадре, а matrixWorld обновится
    // только при отрисовке: без этого выбор отставал бы на кадр, и после
    // последнего кадра перелёта подсказка показывала бы соседнюю систему.
    camera.updateMatrixWorld();
    const e = camera.matrixWorld.elements;
    let changed = false;
    for (let i = 0; i < 16; i++) {
      if (hover.matrix[i] !== e[i]) {
        hover.matrix[i] = e[i];
        changed = true;
      }
    }
    if (changed) hover.repick();
  });

  useEffect(() => {
    const el = gl.domElement;
    const hover = hoverRef.current;
    let down: { x: number; y: number } | null = null;
    let hovered: number | null = null;
    let frame = 0;
    let cursorBefore: string | null = null;

    /** Луч и «камера выбора» для точки экрана; null — canvas ещё без размера. */
    const castAt = (clientX: number, clientY: number) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      const ndc = new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      );
      raycaster.setFromCamera(ndc, camera);
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
        clickX: clientX - rect.left,
        clickY: clientY - rect.top,
      };
      return { rect, origin, dir, ray, fov, pickCamera };
    };

    /** Точка дополнительного облака (PowerPlay) под курсором. */
    const pickExtra = (cast: NonNullable<ReturnType<typeof castAt>>): number | null => {
      const extraGrid = extraGridRef.current;
      if (!extraGrid || !extraPositions) return null;
      // Пузырь держав далеко от центра карты (Sgr A*) и толщиной в сотни
      // световых лет: коридор считаем по самой дальней от камеры точке облака,
      // а не по плоскости галактики, — иначе система ниже плоскости промахнётся.
      const depth = farthestCorner(extraBoundsRef.current, cast.pickCamera.position) ?? camera.position.length();
      const hit = pickAlongRay(extraGrid, extraPositions, cast.ray, {
        threshold: Math.max(8, worldUnitsPerPixel(depth, cast.fov, cast.rect.height) * (extraRadius + 4)),
        camera: cast.pickCamera,
        pixelRadius: extraRadius,
      });
      return hit ? hit.index : null;
    };

    const setHovered = (index: number | null, at: { x: number; y: number } | null) => {
      if (index !== null) {
        if (cursorBefore === null) cursorBefore = el.style.cursor;
        el.style.cursor = 'pointer';
      } else if (cursorBefore !== null) {
        el.style.cursor = cursorBefore;
        cursorBefore = null;
      }
      if (index === null && hovered === null) return;
      hovered = index;
      extraHoverRef.current?.(index, at);
    };

    /** Точка под последним положением курсора — по текущей камере. */
    const repick = () => {
      const at = hover.lastPointer;
      if (!at || hover.suppressed || !extraHoverRef.current) return;
      const cast = castAt(at.x, at.y);
      if (!cast) return;
      const index = pickExtra(cast);
      setHovered(index, index === null ? null : { x: at.x - cast.rect.left, y: at.y - cast.rect.top });
    };
    hover.repick = hasHover ? repick : null;

    const onDown = (event: PointerEvent) => {
      // Клик или начало облёта: подсказка прячется до следующего движения мыши.
      hover.suppressed = true;
      if (hovered !== null || cursorBefore !== null) setHovered(null, null);
      if (event.button !== 0) return;
      down = { x: event.clientX, y: event.clientY };
    };
    // Наведение — раз в кадр и только по своему облаку: без перебора сцены.
    const onMove = (event: PointerEvent) => {
      if (!extraHoverRef.current) return;
      if (event.buttons !== 0) {
        // Камеру тащат — подсказка только мешает.
        hover.lastPointer = null;
        if (hovered !== null || cursorBefore !== null) setHovered(null, null);
        return;
      }
      hover.suppressed = false;
      hover.lastPointer = { x: event.clientX, y: event.clientY };
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        repick();
      });
    };
    const onLeave = () => {
      hover.lastPointer = null;
      if (hovered !== null || cursorBefore !== null) setHovered(null, null);
    };
    const onUp = (event: PointerEvent) => {
      if (!down || event.button !== 0) return;
      const moved = Math.hypot(event.clientX - down.x, event.clientY - down.y);
      down = null;
      if (moved > 4) return;

      const cast = castAt(event.clientX, event.clientY);
      if (!cast) return;
      const { rect, origin, dir, ray, fov, pickCamera } = cast;
      const hits = raycaster.intersectObjects(scene.children, true);
      const marker = hits.find((hit) => (
        !(hit.object instanceof THREE.Points)
        && !(hit.object instanceof THREE.Line)
        && !(hit.object instanceof THREE.LineSegments)
      ));
      if (marker) return;

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

      if (extraPickRef.current) {
        const index = pickExtra(cast);
        if (index !== null) {
          extraPickRef.current(index);
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
    if (hasHover) {
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerleave', onLeave);
    }
    return () => {
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', onLeave);
      if (frame) cancelAnimationFrame(frame);
      hover.repick = null;
      // Облако сменилось или слой выключен: «рука» и подсказка не должны залипнуть.
      if (cursorBefore !== null) el.style.cursor = cursorBefore;
      if (hovered !== null) extraHoverRef.current?.(null, null);
    };
  }, [camera, data, enabled, extraPositions, extraRadius, gl, hasHover, onEmpty, onPick, positions, raycaster, scene, visibleMask]);

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
