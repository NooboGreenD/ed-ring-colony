"use client";

import { useMemo } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { eliteToThreeCentered, LANDMARKS } from "@/lib/ed3dCanon";
import type { RouteSystem } from "@/types/hub";

type Landmark = typeof LANDMARKS[number];
type LandmarkSelect = (point: RouteSystem) => void;

function asRoutePoint(landmark: Landmark, index: number): RouteSystem {
  return {
    id: -(index + 1001),
    system_name: landmark.name,
    sort_order: index,
    status: 'planned',
    x: landmark.x,
    y: landmark.y,
    z: landmark.z,
    isHub: false,
  };
}

/**
 * Цель клика — в экранных единицах (`sizeAttenuation: false`): ≈ 25–30 px при
 * любом масштабе. Само свечение — 120 св. лет поперёк, и раньше кликабельным
 * было именно оно: квадрат вокруг Sol перехватывал клики по системам «пузыря»
 * (слой PowerPlay, каталог «Все системы») — `MapClickLayer` считал его маркером.
 */
const LANDMARK_HIT_SCALE = 0.032;

function LandmarkSprite({ landmark, index, onSelect, interactive }: { landmark: Landmark; index: number; onSelect?: LandmarkSelect; interactive: boolean }) {
  const pos = useMemo(() => eliteToThreeCentered(landmark), [landmark]);
  const routePoint = useMemo(() => asRoutePoint(landmark, index), [landmark, index]);

  const texture = useMemo(() => {
    const canvas = document.createElement("canvas"); canvas.width = 64; canvas.height = 64;
    const ctx = canvas.getContext("2d")!;
    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, landmark.color); grad.addColorStop(0.5, landmark.color + "44"); grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad; ctx.fillRect(0, 0, 64, 64);
    ctx.beginPath(); ctx.arc(32, 32, 4, 0, Math.PI * 2); ctx.fillStyle = "#ffffff"; ctx.fill();
    const tex = new THREE.CanvasTexture(canvas); tex.needsUpdate = true; return tex;
  }, [landmark.color]);

  const material = useMemo(() => new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.85, depthWrite: false, blending: THREE.AdditiveBlending }), [texture]);
  const hitMaterial = useMemo(() => new THREE.SpriteMaterial({ transparent: true, opacity: 0, depthWrite: false, depthTest: false, sizeAttenuation: false }), []);
  const select = (event: any) => { event.stopPropagation(); onSelect?.(routePoint); };

  return <group position={[pos.x, pos.y, pos.z]}>
    {/* Свечение — только картинка. */}
    <sprite material={material} scale={[120, 120, 1]} raycast={() => null} />
    {interactive && onSelect && <sprite material={hitMaterial} scale={[LANDMARK_HIT_SCALE, LANDMARK_HIT_SCALE, 1]} onClick={select} />}
    <Html position={[0, 90, 0]} distanceFactor={800} zIndexRange={[8, 7]} style={{ pointerEvents: "none" }} center>
      <div style={{ color: landmark.color, fontFamily: '"Courier New", monospace', fontSize: "18px", fontWeight: "bold", textShadow: `0 0 6px ${landmark.color}`, whiteSpace: "nowrap", textAlign: "center", letterSpacing: "1px", transform: "translateX(-50%)" }}>
        {landmark.name}
      </div>
    </Html>
  </group>;
}

/**
 * `interactive={false}` — ориентиры не перехватывают клики: так делает слой
 * PowerPlay, где Sol — сама система державы со своей карточкой.
 */
export function LandmarkMarkers({ onSelect, interactive = true }: { onSelect?: LandmarkSelect; interactive?: boolean }) {
  return <group>{LANDMARKS.map((landmark, index) => <LandmarkSprite key={landmark.name} landmark={landmark} index={index} onSelect={onSelect} interactive={interactive} />)}</group>;
}
