'use client';

/**
 * Слой «Авианосцы» на 3D-карте галактики.
 *
 * Одна отметка на систему: значок носителя (как в игре) постоянного экранного
 * размера — не теряется на масштабе галактики и не раздувается вблизи; при
 * двух и более носителях в системе — бейдж со счётчиком. Значок всегда поверх
 * туманностей и секторов (как метки на карте галактики в игре).
 *
 * Запланированный прыжок — пунктир к системе назначения и бледный значок там.
 * Наведение показывает подпись, клик выбирает систему (карточка — в GalaxyMap).
 */

import { useEffect, useMemo, useState } from 'react';
import { Html } from '@react-three/drei';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import * as THREE from 'three';
import { eliteToThreeCentered } from '@/lib/ed3dCanon';
import {
  CARRIER_FADE_OPACITY,
  CARRIER_TONE_COLOR,
  carrierBadgeText,
  carrierCountLabel,
  carrierIconVariant,
  carrierJumpText,
  carrierListLabel,
  carrierTone,
  type CarrierFade,
  type CarrierSystemGroup,
  type CarrierTone,
} from '@/lib/carrierMap';
import { drawCarrierGlyph, type CarrierGlyphKind } from './CarrierGlyph';

const TEXTURE = 128;
const GLYPH_SIZE = 84;
const GLYPH_OFFSET = (TEXTURE - GLYPH_SIZE) / 2;
const BADGE = { x: 104, y: 24, r: 21 } as const;
/** Сторона спрайта на экране, CSS-пиксели (сам значок — ~2/3 спрайта). */
const SPRITE_PX = 42;
const GHOST_SCALE = 0.72;
const RING_SCALE = 1.4;
const HOVER_SCALE = 1.18;
const SELECTED_SCALE = 1.12;
const RENDER_ORDER = { line: 26, ghost: 27, ring: 28, icon: 30 } as const;
/**
 * На масштабе галактики значки соседних систем ложатся друг на друга: сверху
 * должен оказаться свой носитель, затем эскадрильи, затем остальные;
 * списываемые и давно не обновлявшиеся — снизу.
 */
const TONE_PRIORITY: Record<CarrierTone, number> = { own: 3, squadron: 2, other: 1, decommission: 0 };

const textures = new Map<string, THREE.CanvasTexture | null>();
const materials = new Map<string, THREE.SpriteMaterial | null>();

function newCanvas(): { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const canvas = document.createElement('canvas');
  canvas.width = TEXTURE;
  canvas.height = TEXTURE;
  const ctx = canvas.getContext('2d');
  return ctx ? { canvas, ctx } : null;
}

function finishTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

/** Текстура значка: вариант × тон × бейдж. Кэш на весь сеанс — вариантов мало. */
function iconTexture(glyph: CarrierGlyphKind, tone: CarrierTone, count: number): THREE.CanvasTexture | null {
  const badge = count > 1 ? carrierBadgeText(count) : '';
  const key = `${glyph}|${tone}|${badge}`;
  if (textures.has(key)) return textures.get(key) ?? null;
  const surface = newCanvas();
  if (!surface) {
    textures.set(key, null);
    return null;
  }
  const { canvas, ctx } = surface;
  const color = CARRIER_TONE_COLOR[tone];
  drawCarrierGlyph(ctx, { glyph, color, size: GLYPH_SIZE, x: GLYPH_OFFSET, y: GLYPH_OFFSET, decommission: tone === 'decommission' });
  if (badge) {
    ctx.beginPath();
    ctx.arc(BADGE.x, BADGE.y, BADGE.r, 0, Math.PI * 2);
    ctx.fillStyle = '#0d0f11';
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold ${badge.length > 1 ? 22 : 27}px "DejaVu Sans", "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(badge, BADGE.x, BADGE.y + 1);
  }
  const texture = finishTexture(canvas);
  textures.set(key, texture);
  return texture;
}

function ringTexture(): THREE.CanvasTexture | null {
  const key = 'ring';
  if (textures.has(key)) return textures.get(key) ?? null;
  const surface = newCanvas();
  if (!surface) {
    textures.set(key, null);
    return null;
  }
  const { canvas, ctx } = surface;
  ctx.beginPath();
  ctx.arc(TEXTURE / 2, TEXTURE / 2, TEXTURE / 2 - 6, 0, Math.PI * 2);
  ctx.lineWidth = 7;
  ctx.strokeStyle = '#e67e22';
  ctx.stroke();
  const texture = finishTexture(canvas);
  textures.set(key, texture);
  return texture;
}

function spriteMaterial(key: string, texture: THREE.Texture | null, opacity: number): THREE.SpriteMaterial | null {
  if (materials.has(key)) return materials.get(key) ?? null;
  const material = texture ? new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false,
    sizeAttenuation: false,
    toneMapped: false,
  }) : null;
  materials.set(key, material);
  return material;
}

function iconMaterial(glyph: CarrierGlyphKind, tone: CarrierTone, count: number, fade: CarrierFade) {
  const texture = iconTexture(glyph, tone, count);
  return spriteMaterial(`${glyph}|${tone}|${carrierBadgeText(count)}|${fade}`, texture, CARRIER_FADE_OPACITY[fade]);
}

function setCursor(value: string) {
  if (typeof document !== 'undefined') document.body.style.cursor = value;
}

interface PlacedGroup {
  group: CarrierSystemGroup;
  position: THREE.Vector3;
  material: THREE.SpriteMaterial | null;
  color: string;
  priority: number;
}

interface JumpTrail {
  key: string;
  line: THREE.Line;
  target: THREE.Vector3;
  ghost: THREE.SpriteMaterial | null;
}

export interface CarrierMarkersProps {
  groups: CarrierSystemGroup[];
  selectedKey?: string | null;
  onSelect?: (group: CarrierSystemGroup | null) => void;
}

export function CarrierMarkers({ groups, selectedKey = null, onSelect }: CarrierMarkersProps) {
  const height = useThree((state) => state.size.height);
  const camera = useThree((state) => state.camera);
  const invalidate = useThree((state) => state.invalidate);
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);
  const fov = camera instanceof THREE.PerspectiveCamera ? camera.fov : 45;
  // sizeAttenuation=false: масштаб спрайта — доля высоты экрана (после проекции).
  const pixel = useMemo(() => (2 * Math.tan(THREE.MathUtils.degToRad(fov / 2))) / Math.max(1, height), [fov, height]);

  const placed = useMemo<PlacedGroup[]>(() => {
    const now = Date.now();
    return groups
      .filter((group) => group.position)
      .map((group) => {
        const variant = carrierIconVariant(group, now);
        return {
          group,
          position: eliteToThreeCentered(group.position!),
          material: iconMaterial(variant.glyph, variant.tone, variant.count, variant.fade),
          color: CARRIER_TONE_COLOR[variant.tone],
          priority: variant.fade === 'stale' ? 0 : TONE_PRIORITY[variant.tone],
        };
      });
  }, [groups]);

  const trails = useMemo<JumpTrail[]>(() => {
    const result: JumpTrail[] = [];
    for (const { group, position } of placed) {
      for (const jump of group.jumps) {
        if (!jump.position) continue;
        const target = eliteToThreeCentered(jump.position);
        const distance = position.distanceTo(target);
        if (distance < 0.01) continue;
        const tone = carrierTone(jump.carrier);
        const geometry = new THREE.BufferGeometry().setFromPoints([position, target]);
        const material = new THREE.LineDashedMaterial({
          color: CARRIER_TONE_COLOR[tone],
          dashSize: Math.max(0.5, distance / 18),
          gapSize: Math.max(0.35, distance / 30),
          transparent: true,
          opacity: jump.state === 'jumping' ? 0.95 : 0.7,
          depthTest: false,
          depthWrite: false,
          toneMapped: false,
        });
        const line = new THREE.Line(geometry, material);
        line.computeLineDistances();
        line.renderOrder = RENDER_ORDER.line;
        line.raycast = () => undefined;
        const glyph: CarrierGlyphKind = jump.carrier.type === 'SquadronCarrier' ? 'javelin' : 'drake';
        result.push({ key: `${group.key}>${jump.key}`, line, target, ghost: iconMaterial(glyph, tone, 1, 'ghost') });
      }
    }
    return result;
  }, [placed]);

  useEffect(() => () => {
    for (const trail of trails) {
      trail.line.geometry.dispose();
      (trail.line.material as THREE.Material).dispose();
    }
  }, [trails]);

  useEffect(() => {
    invalidate();
  }, [placed, trails, selectedKey, hoveredKey, pixel, invalidate]);

  useEffect(() => () => setCursor('auto'), []);

  const hovered = hoveredKey && hoveredKey !== selectedKey
    ? placed.find((item) => item.group.key === hoveredKey) ?? null
    : null;
  const selected = selectedKey ? placed.find((item) => item.group.key === selectedKey) ?? null : null;
  const ring = selected ? spriteMaterial('ring', ringTexture(), 0.95) : null;

  if (!placed.length) return null;

  const scaleFor = (key: string) => SPRITE_PX * pixel * (key === hoveredKey ? HOVER_SCALE : key === selectedKey ? SELECTED_SCALE : 1);

  return (
    <group name="carrier-markers">
      {trails.map((trail) => (
        <group key={trail.key}>
          <primitive object={trail.line} />
          {trail.ghost && (
            <sprite
              position={[trail.target.x, trail.target.y, trail.target.z]}
              material={trail.ghost}
              scale={[SPRITE_PX * pixel * GHOST_SCALE, SPRITE_PX * pixel * GHOST_SCALE, 1]}
              renderOrder={RENDER_ORDER.ghost}
              raycast={() => undefined}
            />
          )}
        </group>
      ))}

      {selected && ring && (
        <sprite
          position={[selected.position.x, selected.position.y, selected.position.z]}
          material={ring}
          scale={[SPRITE_PX * pixel * RING_SCALE, SPRITE_PX * pixel * RING_SCALE, 1]}
          renderOrder={RENDER_ORDER.ring}
          raycast={() => undefined}
        />
      )}

      {placed.map(({ group, position, material, priority }) => material && (
        <sprite
          key={group.key}
          position={[position.x, position.y, position.z]}
          material={material}
          scale={[scaleFor(group.key), scaleFor(group.key), 1]}
          renderOrder={RENDER_ORDER.icon + (group.key === selectedKey || group.key === hoveredKey ? 4 : priority)}
          onClick={(event: ThreeEvent<MouseEvent>) => {
            event.stopPropagation();
            onSelect?.(selectedKey === group.key ? null : group);
          }}
          onPointerOver={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            setHoveredKey(group.key);
            setCursor('pointer');
          }}
          onPointerOut={(event: ThreeEvent<PointerEvent>) => {
            event.stopPropagation();
            setHoveredKey((current) => (current === group.key ? null : current));
            setCursor('auto');
          }}
        />
      ))}

      {hovered && (
        <Html
          position={[hovered.position.x, hovered.position.y, hovered.position.z]}
          // Над подписями секторов и туманностей, но под панелью слоёв и карточками (z-index 10).
          zIndexRange={[9, 9]}
          style={{ pointerEvents: 'none' }}
        >
          <CarrierHoverLabel group={hovered.group} color={hovered.color} />
        </Html>
      )}
    </group>
  );
}

function CarrierHoverLabel({ group, color }: { group: CarrierSystemGroup; color: string }) {
  const count = group.carriers.length;
  const jump = group.carriers.map((carrier) => carrierJumpText(carrier)).find(Boolean);
  return (
    <div style={{
      transform: 'translate(-50%, calc(-100% - 26px))',
      background: 'rgba(13,15,17,0.94)',
      border: `1px solid ${color}66`,
      borderRadius: 3,
      padding: '4px 8px',
      color: '#eeeeee',
      fontSize: 11,
      lineHeight: 1.35,
      whiteSpace: 'nowrap',
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    }}>
      <div style={{ color, fontWeight: 700 }}>
        {group.system}
        <span style={{ color: '#9ca3af', fontWeight: 400 }}> · {carrierCountLabel(count)}</span>
      </div>
      <div style={{ color: '#d1d5db', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{carrierListLabel(group, 3)}</div>
      {jump && <div style={{ color: '#ffd166' }}>{jump}</div>}
    </div>
  );
}
