'use client';

/**
 * Туманности на карте галактики.
 *
 * Раньше слой состоял из 15 000 аддитивных точек размером в сотни св. лет —
 * получались «яркие скопления точек» вместо газа, да ещё и по короткому списку
 * из двенадцати туманностей. Теперь облако собирается из крупных мягких
 * билбордов-«клубов»: их много, они перекрываются и вместе дают ту самую
 * полупрозрачную дымку, которая видна на карте в самой игре.
 *
 * Что даёт «игровой» вид:
 *  - клубы большие (0.17–0.37 диаметра облака) — читаются как газ, не как точки;
 *  - яркость копится аддитивно, но с малой альфой на клуб: облако светится
 *    слабее звёзд и не выжигает карту;
 *  - силуэт задаётся шумом и типом объекта (дуга Петли Барнарда, нити Вуали,
 *    силуэт Конской головы, яркое ядро планетарных туманностей);
 *  - тёмные туманности не светятся, а гасят звёзды за собой;
 *  - внутри облака туманность растворяется — как при близком подлёте в игре.
 *
 * Геометрия облаков считается в `@/lib/nebulaClouds` (чистая математика,
 * проверяется тестом), здесь — только материал, текстура и подписи.
 */

import { useMemo } from 'react';
import { Html } from '@react-three/drei';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';
import {
  DARK_OPACITY,
  EMISSIVE_OPACITY,
  buildNebulaBuckets,
  buildPuffAtlasData,
  type PuffBucket,
} from '@/lib/nebulaClouds';
import {
  GALAXY_NEBULAE,
  MAJOR_NEBULAE,
  NEBULA_KIND_LABELS,
  type GalaxyNebula,
  type NebulaKind,
} from '@/lib/galaxyNebulae';

const CORE_OPACITY = 0.3;

/**
 * Минимальный экранный размер облака в пикселях. На карте галактики туманности
 * видны и при полностью отдалённой камере — слабыми цветными дымками. Без этого
 * ограничения в масштабе всей Галактики от них не остаётся ни пикселя.
 */
const MIN_PIXELS = 7;
/**
 * Как гаснет облако, раздутое до минимального размера. Показатель >1 keeps
 * суммарный свет примерно постоянным: иначе на дальнем плане сотни раздутых
 * клубов накладываются друг на друга и карта превращается в цветное пятно.
 */
const DISTANT_FADE_CURVE = 1.5;
const DISTANT_FADE_FLOOR = 0.03;

/** Короткие названия и цвета для фильтров в панели карты. */
export const NEBULA_KIND_SHORT: Record<NebulaKind, string> = {
  emission: 'эмиссионные',
  reflection: 'отражательные',
  cluster: 'скопления',
  planetary: 'планетарные',
  remnant: 'остатки',
  dark: 'тёмные',
};

export const NEBULA_KIND_UI_COLOR: Record<NebulaKind, string> = {
  emission: '#e0629b',
  reflection: '#7fa8e8',
  cluster: '#8fb0e8',
  planetary: '#5fd0a8',
  remnant: '#d97a4a',
  dark: '#6b7280',
};

export const NEBULA_KIND_ORDER: NebulaKind[] = [
  'emission',
  'reflection',
  'cluster',
  'planetary',
  'remnant',
  'dark',
];

/* ── Текстура ────────────────────────────────────────────────────────────── */

function createPuffTexture(): THREE.CanvasTexture {
  const { size, alpha } = buildPuffAtlasData();
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < alpha.length; i++) {
    const value = Math.round(alpha[i] * 255);
    image.data[i * 4] = value;
    image.data[i * 4 + 1] = value;
    image.data[i * 4 + 2] = value;
    image.data[i * 4 + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

/* ── Геометрия ───────────────────────────────────────────────────────────── */

function toInstancedGeometry(bucket: PuffBucket): THREE.InstancedBufferGeometry {
  const geometry = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  geometry.index = plane.index;
  geometry.setAttribute('position', plane.attributes.position);
  geometry.setAttribute('uv', plane.attributes.uv);
  geometry.setAttribute('iCenter', new THREE.InstancedBufferAttribute(new Float32Array(bucket.centers), 3));
  geometry.setAttribute('iSize', new THREE.InstancedBufferAttribute(new Float32Array(bucket.sizes), 1));
  geometry.setAttribute('iColor', new THREE.InstancedBufferAttribute(new Float32Array(bucket.colors), 3));
  geometry.setAttribute('iAlpha', new THREE.InstancedBufferAttribute(new Float32Array(bucket.alphas), 1));
  geometry.setAttribute('iRot', new THREE.InstancedBufferAttribute(new Float32Array(bucket.rotations), 1));
  geometry.setAttribute('iTile', new THREE.InstancedBufferAttribute(new Float32Array(bucket.tiles), 1));
  geometry.instanceCount = bucket.sizes.length;
  // Клубы лежат в мировых координатах, фрустумное отсечение здесь только мешает.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 0, 0), 140000);
  return geometry;
}

const VERTEX_SHADER = /* glsl */ `
  attribute vec3 iCenter;
  attribute float iSize;
  attribute vec3 iColor;
  attribute float iAlpha;
  attribute float iRot;
  attribute float iTile;

  uniform float uPixelScale;
  uniform float uMinPixels;
  uniform float uDistantCurve;
  uniform float uDistantFloor;

  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vUv;
  varying float vTile;

  void main() {
    vec4 mv = modelViewMatrix * vec4(iCenter, 1.0);

    // Далёкое облако раздуваем до минимального экранного размера, чтобы оно не
    // исчезало при отдалении камеры, и слегка приглушаем — иначе вся карта
    // галактики подёрнулась бы цветной дымкой.
    float viewDepth = max(0.001, -mv.z);
    float pixels = iSize * uPixelScale / viewDepth;
    float boost = max(1.0, uMinPixels / max(pixels, 0.0001));
    float distant = clamp(pow(clamp(pixels / uMinPixels, 0.0, 1.0), uDistantCurve), uDistantFloor, 1.0);
    iSize *= boost;
    // Билборд строится в видовых координатах, как у THREE.Sprite: так он
    // остаётся развёрнутым к камере при любом ракурсе — в том числе при
    // взгляде строго сверху, где базис «мирового верха» вырождается.
    float s = sin(iRot);
    float c = cos(iRot);
    vec2 corner = position.xy * iSize;
    vec2 rotated = vec2(corner.x * c - corner.y * s, corner.x * s + corner.y * c);
    mv.xy += rotated;

    // Внутри облака туманность растворяется: иначе один клуб засветил бы экран.
    float nearFade = smoothstep(iSize * 0.35, iSize * 1.5, length(mv.xyz));

    vColor = iColor;
    vAlpha = iAlpha * nearFade * distant;
    vUv = uv;
    vTile = iTile;
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT_SHADER = /* glsl */ `
  uniform sampler2D uMap;
  uniform float uOpacity;

  varying vec3 vColor;
  varying float vAlpha;
  varying vec2 vUv;
  varying float vTile;

  void main() {
    vec2 cell = vec2(mod(vTile, 2.0), floor(vTile / 2.0));
    // Атлас 2×2 с отступом, чтобы не подмешивались соседние плитки.
    vec2 uv = cell * 0.5 + 0.012 + clamp(vUv, 0.0, 1.0) * (0.5 - 0.024);
    float tex = texture2D(uMap, uv).r;

    float alpha = vAlpha * tex * uOpacity;
    if (alpha < 0.0025) discard;

    gl_FragColor = vec4(vColor, alpha);
  }
`;

function createPuffMaterial(texture: THREE.Texture, opacity: number, blending: THREE.Blending) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uOpacity: { value: opacity },
      uPixelScale: { value: 800 },
      uMinPixels: { value: MIN_PIXELS },
      uDistantCurve: { value: DISTANT_FADE_CURVE },
      uDistantFloor: { value: DISTANT_FADE_FLOOR },
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending,
  });
}

/* ── Слой ────────────────────────────────────────────────────────────────── */

export interface NebulaFieldProps {
  /** Показывать подписи крупных туманностей. */
  showLabels?: boolean;
  /** Какие типы туманностей рисовать. */
  visibleKinds?: NebulaKind[];
  /** Выбранная туманность — подсвечивается кольцом. */
  selectedName?: string | null;
  onSelect?: (nebula: GalaxyNebula | null) => void;
}

export function NebulaField({
  showLabels = true,
  visibleKinds = NEBULA_KIND_ORDER,
  selectedName = null,
  onSelect,
}: NebulaFieldProps) {
  // Массив типов приходит новым на каждый рендер — сравниваем по строке.
  const kindKey = [...visibleKinds].sort().join(',');

  const { emissiveGeometry, darkGeometry } = useMemo(() => {
    const { emissive, dark } = buildNebulaBuckets(
      GALAXY_NEBULAE,
      new Set(kindKey.split(',')),
      eliteToThreeCentered,
    );
    return {
      emissiveGeometry: toInstancedGeometry(emissive),
      darkGeometry: toInstancedGeometry(dark),
    };
  }, [kindKey]);

  const texture = useMemo(() => createPuffTexture(), []);
  const emissiveMaterial = useMemo(
    () => createPuffMaterial(texture, EMISSIVE_OPACITY, THREE.AdditiveBlending),
    [texture],
  );
  const darkMaterial = useMemo(
    () => createPuffMaterial(texture, DARK_OPACITY, THREE.NormalBlending),
    [texture],
  );

  // Сколько пикселей занимает один световой год на текущем зуме: нужно, чтобы
  // держать минимальный экранный размер облака при любом отдалении камеры.
  const camera = useThree((state) => state.camera);
  const size = useThree((state) => state.size);
  useFrame(() => {
    const perspective = camera as THREE.PerspectiveCamera;
    const fov = (perspective.fov ?? 45) * (Math.PI / 180);
    const pixelScale = size.height / (2 * Math.tan(fov / 2));
    emissiveMaterial.uniforms.uPixelScale.value = pixelScale;
    darkMaterial.uniforms.uPixelScale.value = pixelScale;
  });

  const selected = useMemo(
    () => GALAXY_NEBULAE.find((nebula) => nebula.name === selectedName) ?? null,
    [selectedName],
  );

  return (
    <group>
      {/* Тёмные облака — поверх звёзд, чтобы гасить их; светящиеся — поверх тёмных. */}
      {darkGeometry.instanceCount > 0 && (
        <mesh geometry={darkGeometry} material={darkMaterial} renderOrder={2} frustumCulled={false} raycast={() => null} />
      )}
      {emissiveGeometry.instanceCount > 0 && (
        <mesh geometry={emissiveGeometry} material={emissiveMaterial} renderOrder={3} frustumCulled={false} raycast={() => null} />
      )}

      <PlanetaryCores visibleKinds={kindKey} />
      {selected && <NebulaSelectionRing nebula={selected} />}
      {showLabels && <NebulaLabels onSelect={onSelect} selectedName={selectedName} />}
    </group>
  );
}

/** Ядра планетарных туманностей и остатков сверхновых: маленькие яркие точки. */
function PlanetaryCores({ visibleKinds }: { visibleKinds: string }) {
  const texture = useMemo(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 62);
    gradient.addColorStop(0, 'rgba(255,255,255,1)');
    gradient.addColorStop(0.22, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.55, 'rgba(255,255,255,0.14)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(canvas);
  }, []);

  const cores = useMemo(() => {
    const allowed = new Set(visibleKinds.split(','));
    return GALAXY_NEBULAE
      .filter((nebula) =>
        allowed.has(nebula.kind) && (nebula.kind === 'planetary' || nebula.kind === 'remnant'))
      .map((nebula) => ({
        nebula,
        position: eliteToThreeCentered(nebula),
        size: Math.max(16, nebula.size * 0.22),
      }));
  }, [visibleKinds]);

  return (
    <group>
      {cores.map(({ nebula, position, size }) => (
        <sprite
          key={nebula.name}
          position={[position.x, position.y, position.z]}
          scale={[size, size, 1]}
          renderOrder={4}
          raycast={() => null}
        >
          <spriteMaterial
            map={texture}
            color={nebula.color}
            transparent
            opacity={CORE_OPACITY * 0.5}
            depthWrite={false}
            blending={THREE.AdditiveBlending}
          />
        </sprite>
      ))}
    </group>
  );
}

/** Кольцо выделения лежит в плоскости Галактики — доворачивать к камере не нужно. */
function NebulaSelectionRing({ nebula }: { nebula: GalaxyNebula }) {
  const position = useMemo(() => eliteToThreeCentered(nebula), [nebula]);
  const geometry = useMemo(
    () => new THREE.RingGeometry(nebula.size * 0.52, nebula.size * 0.56, 72),
    [nebula.size],
  );

  return (
    <mesh
      position={[position.x, position.y, position.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      geometry={geometry}
      renderOrder={6}
      raycast={() => null}
    >
      <meshBasicMaterial color={nebula.color} transparent opacity={0.5} side={THREE.DoubleSide} depthWrite={false} />
    </mesh>
  );
}

/** Подписи: только крупные объекты, иначе диск превратится в список названий. */
function NebulaLabels({
  onSelect,
  selectedName,
}: {
  onSelect?: (nebula: GalaxyNebula | null) => void;
  selectedName: string | null;
}) {
  return (
    <group>
      {MAJOR_NEBULAE.map((nebula) => {
        const position = eliteToThreeCentered(nebula);
        const active = nebula.name === selectedName;
        return (
          <Html
            key={nebula.name}
            position={[position.x, position.y + nebula.size * 0.42, position.z]}
            center
            distanceFactor={1500}
            zIndexRange={[6, 0]}
            style={{ pointerEvents: 'none' }}
          >
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onSelect?.(active ? null : nebula);
              }}
              title={`${NEBULA_KIND_LABELS[nebula.kind]} · ${nebula.distance.toFixed(0)} св. лет от Sol${nebula.refSystem ? ` · ${nebula.refSystem}` : ''}`}
              style={{
                display: 'block',
                pointerEvents: 'auto',
                background: 'transparent',
                border: 'none',
                padding: '1px 6px',
                cursor: 'pointer',
                color: nebula.color,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                fontSize: active ? 15 : 13,
                fontWeight: active ? 800 : 700,
                letterSpacing: '0.04em',
                whiteSpace: 'nowrap',
                textShadow: `0 0 6px ${nebula.color}, 0 0 14px rgba(0,0,0,0.95), 0 1px 2px #000`,
                opacity: active ? 1 : 0.8,
              }}
            >
              {nebula.ru}
            </button>
          </Html>
        );
      })}
    </group>
  );
}
