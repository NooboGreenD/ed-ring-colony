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
 * One Points object (~1.3M). Built-in raycasting walks every vertex and
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
      <shaderMaterial
        ref={materialRef}
        vertexShader={POINT_VERTEX}
        fragmentShader={POINT_FRAGMENT}
        uniforms={{ uMask: { value: visibleMask } }}
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

interface MapClickLayerProps {
  data: AllSystemsData | null;
  positions: Float32Array | null;
  visibleMask: number;
  enabled: boolean;
  onPick?: (id64: string, index: number) => void;
  onEmpty?: () => void;
}

/** Click handler for the whole map: markers win, then a catalog star, then empty space. */
export function MapClickLayer({ data, positions, visibleMask, enabled, onPick, onEmpty }: MapClickLayerProps) {
  const { camera, gl, raycaster, scene } = useThree();
  const gridRef = useRef<PointGrid | null>(null);

  useEffect(() => {
    if (!enabled || !data || !positions) {
      gridRef.current = null;
      return;
    }
    gridRef.current = buildPointGrid(positions, data.count);
  }, [data, enabled, positions]);

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

      if (enabled && data && positions) {
        const grid = gridRef.current ?? buildPointGrid(positions, data.count);
        gridRef.current = grid;
        if (grid) {
          const origin = raycaster.ray.origin;
          const dir = raycaster.ray.direction;
          let depth = camera.position.length();
          if (Math.abs(dir.y) > 1e-4) {
            const t = -origin.y / dir.y;
            if (t > 10 && t < 200_000) depth = t;
          }
          const perspective = camera as THREE.PerspectiveCamera;
          const fov = perspective.fov || 45;
          const threshold = Math.max(8, worldUnitsPerPixel(depth, fov, rect.height) * 14);
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
          const hit = pickAlongRay(grid, positions, {
            ox: origin.x, oy: origin.y, oz: origin.z, dx: dir.x, dy: dir.y, dz: dir.z,
          }, {
            threshold,
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
  }, [camera, data, enabled, gl, onEmpty, onPick, positions, raycaster, scene, visibleMask]);

  return null;
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
