'use client';

/**
 * Слой «PowerPlay» на 3D-карте Atlas: системы под контролем держав.
 *
 * Одно облако точек (десятки тысяч систем) со своим шейдером: цвет — держава,
 * форма — состояние (звезда — оплот, кольцо — укреплённая, точка —
 * эксплуатируемая), размер в экранных пикселях. Встроенный raycast three.js
 * перебирал бы каждую вершину, поэтому он выключен: клик разбирает
 * `MapClickLayer` по сетке (`lib/galaxyPointsPick.ts`), как облако «все системы».
 *
 * Выбранная система получает маркер и, если это оплот или укреплённая
 * система, — сферу зоны влияния (30 / 20 св. лет).
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { SAGA } from '@/lib/ed3dCanon';
import {
  POWERPLAY_STATE_RANGE_LY,
  hexToRgbUnit,
  powerColor,
  type PowerplayState,
  type PowerplaySystem,
} from '@/lib/powerplay';

/** Размер точки, CSS-пиксели: оплот заметнее, эксплуатируемых — тысячи. */
const STATE_SIZE: Record<PowerplayState, number> = { Stronghold: 13, Fortified: 9, Exploited: 5 };
const STATE_SHAPE: Record<PowerplayState, number> = { Exploited: 0, Fortified: 1, Stronghold: 2 };
/** Поверх туманностей (renderOrder ≤ 6), под значками авианосцев (26–30). */
const RENDER_ORDER = 12;

/** Позиции в кадре карты (центр — Sagittarius A*, ось Z развёрнута), как `eliteToThreeCentered`. */
export function powerplayPositions(systems: PowerplaySystem[]): Float32Array {
  const out = new Float32Array(systems.length * 3);
  for (let index = 0; index < systems.length; index++) {
    const system = systems[index];
    out[index * 3] = system.x - SAGA.x;
    out[index * 3 + 1] = system.y - SAGA.y;
    out[index * 3 + 2] = -system.z + SAGA.z;
  }
  return out;
}

export function usePowerplayPositions(systems: PowerplaySystem[] | null): Float32Array | null {
  return useMemo(() => (systems && systems.length ? powerplayPositions(systems) : null), [systems]);
}

const VERTEX = `
  attribute float aSize;
  attribute float aShape;
  uniform float uPixelRatio;
  varying vec3 vColor;
  varying float vShape;
  void main() {
    vColor = color;
    vShape = aShape;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    // Издалека пузырь держав — несколько сотен световых лет: точки чуть
    // меньше, чтобы он не сливался в одно пятно.
    float depth = max(1.0, -mv.z);
    float k = clamp(2500.0 / depth, 0.55, 1.0);
    gl_PointSize = aSize * uPixelRatio * k;
  }
`;

const FRAGMENT = `
  varying vec3 vColor;
  varying float vShape;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float r = length(c);
    float alpha;
    if (vShape < 0.5) {
      // Эксплуатируемая: залитая точка.
      if (r > 0.5) discard;
      alpha = 0.9;
    } else if (vShape < 1.5) {
      // Укреплённая: кольцо с ядром.
      if (r > 0.5) discard;
      alpha = (r > 0.3 || r < 0.13) ? 1.0 : 0.22;
    } else {
      // Оплот: четырёхлучевая звезда.
      vec2 a = abs(c) * 2.0;
      float star = sqrt(a.x) + sqrt(a.y);
      if (star > 1.0 && r > 0.16) discard;
      alpha = 1.0;
    }
    gl_FragColor = vec4(vColor, alpha);
  }
`;

interface PowerplayPointsProps {
  systems: PowerplaySystem[];
  positions: Float32Array;
}

export function PowerplayPoints({ systems, positions }: PowerplayPointsProps) {
  const { gl, invalidate } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const attributes = useMemo(() => {
    const colors = new Float32Array(systems.length * 3);
    const sizes = new Float32Array(systems.length);
    const shapes = new Float32Array(systems.length);
    const palette = new Map<string, [number, number, number]>();
    for (let index = 0; index < systems.length; index++) {
      const system = systems[index];
      let rgb = palette.get(system.power);
      if (!rgb) {
        rgb = hexToRgbUnit(powerColor(system.power));
        palette.set(system.power, rgb);
      }
      colors[index * 3] = rgb[0];
      colors[index * 3 + 1] = rgb[1];
      colors[index * 3 + 2] = rgb[2];
      sizes[index] = STATE_SIZE[system.state];
      shapes[index] = STATE_SHAPE[system.state];
    }
    return { colors, sizes, shapes };
  }, [systems]);

  const pixelRatio = gl.getPixelRatio ? gl.getPixelRatio() : 1;
  useEffect(() => {
    if (materialRef.current) materialRef.current.uniforms.uPixelRatio.value = pixelRatio;
    invalidate();
  }, [pixelRatio, positions, attributes, invalidate]);

  return (
    <points frustumCulled={false} raycast={() => null} renderOrder={RENDER_ORDER}>
      {/* Новый набор — новая геометрия: размер буферов three.js не меняет на лету. */}
      <bufferGeometry key={`${systems.length}:${positions.length}`}>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[attributes.colors, 3]} />
        <bufferAttribute attach="attributes-aSize" args={[attributes.sizes, 1]} />
        <bufferAttribute attach="attributes-aShape" args={[attributes.shapes, 1]} />
      </bufferGeometry>
      <shaderMaterial
        ref={materialRef}
        vertexShader={VERTEX}
        fragmentShader={FRAGMENT}
        uniforms={{ uPixelRatio: { value: pixelRatio } }}
        vertexColors
        transparent
        depthWrite={false}
        fog={false}
      />
    </points>
  );
}

/** Маркер выбранной системы и сфера её зоны влияния. */
export function PowerplaySelection({ system }: { system: PowerplaySystem }) {
  const markerRef = useRef<THREE.Mesh>(null);
  const { camera, invalidate } = useThree();
  const position = useMemo<[number, number, number]>(
    () => [system.x - SAGA.x, system.y - SAGA.y, -system.z + SAGA.z],
    [system.x, system.y, system.z],
  );
  const color = powerColor(system.power);
  const range = POWERPLAY_STATE_RANGE_LY[system.state];

  useEffect(() => {
    invalidate();
  }, [position, range, invalidate]);

  useFrame(() => {
    const mesh = markerRef.current;
    if (!mesh) return;
    const scale = Math.max(4, camera.position.distanceTo(mesh.position) * 0.012);
    if (Math.abs(mesh.scale.x - scale) > 0.05 * scale) mesh.scale.setScalar(scale);
  });

  return (
    <group>
      <mesh ref={markerRef} position={position} raycast={() => null} renderOrder={RENDER_ORDER + 1}>
        <octahedronGeometry args={[1, 0]} />
        <meshBasicMaterial color={color} wireframe depthTest={false} transparent opacity={0.95} />
      </mesh>
      {range > 0 && (
        <group position={position}>
          <mesh raycast={() => null} renderOrder={RENDER_ORDER - 1}>
            <sphereGeometry args={[range, 32, 16]} />
            <meshBasicMaterial color={color} transparent opacity={0.07} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
          <mesh raycast={() => null} rotation={[-Math.PI / 2, 0, 0]} renderOrder={RENDER_ORDER - 1}>
            <ringGeometry args={[range * 0.985, range, 96]} />
            <meshBasicMaterial color={color} transparent opacity={0.55} depthWrite={false} side={THREE.DoubleSide} />
          </mesh>
        </group>
      )}
    </group>
  );
}
