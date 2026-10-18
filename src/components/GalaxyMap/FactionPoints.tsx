'use client';

/**
 * Слой «Фракции» на 3D-карте Atlas: населённые системы с минорными фракциями.
 *
 * Одно облако точек со своим шейдером, как у слоя PowerPlay: цвет, форма и
 * размер приходят из `buildBgsMapPoints` (`lib/bgs.ts`):
 *   * без выбранных фракций — все населённые системы, цвет — принадлежность;
 *   * с выбранными — их системы, цвет — фракция, звезда — у власти выбранная,
 *     кольцо — в системе несколько выбранных, точка — просто присутствует.
 * Встроенный raycast three.js выключен: клик и наведение разбирает
 * `MapClickLayer` по сетке, как облако «все системы».
 */

import { useEffect, useMemo, useRef } from 'react';
import * as THREE from 'three';
import { useFrame, useThree } from '@react-three/fiber';
import { SAGA } from '@/lib/ed3dCanon';
import { hexToRgbUnit } from '@/lib/powerplay';
import type { BgsMapPoint } from '@/lib/bgs';

/** Поверх туманностей и слоя PowerPlay (12), под значками авианосцев (26–30). */
const RENDER_ORDER = 14;

/** Позиции в кадре карты (центр — Sagittarius A*, ось Z развёрнута), как `eliteToThreeCentered`. */
export function factionPositions(points: BgsMapPoint[]): Float32Array {
  const out = new Float32Array(points.length * 3);
  for (let index = 0; index < points.length; index++) {
    const point = points[index];
    out[index * 3] = point.x - SAGA.x;
    out[index * 3 + 1] = point.y - SAGA.y;
    out[index * 3 + 2] = -point.z + SAGA.z;
  }
  return out;
}

export function useFactionPositions(points: BgsMapPoint[] | null): Float32Array | null {
  return useMemo(() => (points && points.length ? factionPositions(points) : null), [points]);
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
    float depth = max(1.0, -mv.z);
    float k = clamp(2500.0 / depth, 0.6, 1.0);
    gl_PointSize = max(2.0, aSize * uPixelRatio * k);
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
      if (r > 0.5) discard;
      alpha = 0.92;
    } else if (vShape < 1.5) {
      if (r > 0.5) discard;
      alpha = (r > 0.3 || r < 0.13) ? 1.0 : 0.22;
    } else {
      vec2 a = abs(c) * 2.0;
      float star = sqrt(a.x) + sqrt(a.y);
      if (star > 1.0 && r > 0.16) discard;
      alpha = 1.0;
    }
    gl_FragColor = vec4(vColor, alpha);
  }
`;

interface FactionPointsProps {
  points: BgsMapPoint[];
  positions: Float32Array;
}

export function FactionPoints({ points, positions }: FactionPointsProps) {
  const { gl, invalidate } = useThree();
  const materialRef = useRef<THREE.ShaderMaterial>(null);

  const attributes = useMemo(() => {
    const colors = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const shapes = new Float32Array(points.length);
    const palette = new Map<string, [number, number, number]>();
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      let rgb = palette.get(point.color);
      if (!rgb) {
        rgb = hexToRgbUnit(point.color);
        palette.set(point.color, rgb);
      }
      colors[index * 3] = rgb[0];
      colors[index * 3 + 1] = rgb[1];
      colors[index * 3 + 2] = rgb[2];
      sizes[index] = point.size;
      shapes[index] = point.shape;
    }
    return { colors, sizes, shapes };
  }, [points]);

  const pixelRatio = gl.getPixelRatio ? gl.getPixelRatio() : 1;
  useEffect(() => {
    if (materialRef.current) materialRef.current.uniforms.uPixelRatio.value = pixelRatio;
    invalidate();
  }, [pixelRatio, positions, attributes, invalidate]);

  return (
    <points frustumCulled={false} raycast={() => null} renderOrder={RENDER_ORDER}>
      {/* Новый набор — новая геометрия: размер буферов three.js не меняет на лету. */}
      <bufferGeometry key={`${points.length}:${positions.length}`}>
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

/** Маркер выбранной системы слоя. */
export function FactionSelection({ point }: { point: BgsMapPoint }) {
  const markerRef = useRef<THREE.Mesh>(null);
  const { camera, invalidate } = useThree();
  const position = useMemo<[number, number, number]>(
    () => [point.x - SAGA.x, point.y - SAGA.y, -point.z + SAGA.z],
    [point.x, point.y, point.z],
  );

  useEffect(() => {
    invalidate();
  }, [position, invalidate]);

  useFrame(() => {
    const mesh = markerRef.current;
    if (!mesh) return;
    const scale = Math.max(4, camera.position.distanceTo(mesh.position) * 0.012);
    if (Math.abs(mesh.scale.x - scale) > 0.05 * scale) mesh.scale.setScalar(scale);
  });

  return (
    <mesh ref={markerRef} position={position} raycast={() => null} renderOrder={RENDER_ORDER + 1}>
      <octahedronGeometry args={[1, 0]} />
      <meshBasicMaterial color={point.background ? '#e5e7eb' : point.color} wireframe depthTest={false} transparent opacity={0.95} />
    </mesh>
  );
}
