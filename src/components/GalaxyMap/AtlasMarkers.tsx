"use client";

import { useRef, useMemo, useState, useCallback } from "react";
import { useFrame } from "@react-three/fiber";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { eliteToThreeCentered } from "@/lib/ed3dCanon";
import type { AtlasCandidate } from "@/types/atlas";

const TYPE_COLORS: Record<string, string> = {
  earth_like: "#4caf50",
  water_world: "#2196f3",
  ammonia: "#ff9800",
  terraformable: "#8bc34a",
  neutron_star: "#00bcd4",
  black_hole: "#9c27b0",
  white_dwarf: "#e0e0e0",
  wolf_rayet: "#ff5722",
  herbig_ae_be: "#ffeb3b",
  t_tauri: "#ffeb3b",
  proto_star: "#ffeb3b",
  carbon_star: "#f44336",
  supergiant: "#f44336",
  giant: "#ff9800",
  rocky_atmosphere: "#a1887f",
  rocky_bio: "#66bb6a",
  default: "#9ca3af",
};

const TYPE_LABELS: Record<string, string> = {
  earth_like: "🌍 Earth-like",
  water_world: "💧 Water",
  ammonia: "🟠 Ammonia",
  terraformable: "🌱 Terraformable",
  neutron_star: "⚡ Neutron",
  black_hole: "🕳️ Black Hole",
  white_dwarf: "⚪ White Dwarf",
  wolf_rayet: "🔥 Wolf-Rayet",
  herbig_ae_be: "⭐ Herbig",
  t_tauri: "⭐ T Tauri",
  proto_star: "⭐ Proto",
  carbon_star: "🔴 Carbon",
  supergiant: "🔴 Supergiant",
  giant: "🟠 Giant",
  rocky_atmosphere: "🪨 Rocky + Atm",
  rocky_bio: "🌿 Rocky + Bio",
};

/** Текстура точки Atlas — цвет соответствует категории, без свечения */
function createAtlasTexture(color: string): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  // Сплошной круг цвета категории
  ctx.beginPath();
  ctx.arc(32, 32, 6, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();

  // Тонкая обводка
  ctx.beginPath();
  ctx.arc(32, 32, 7.5, 0, Math.PI * 2);
  ctx.strokeStyle = "#ffffff55";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

interface AtlasMarkersProps {
  candidates: AtlasCandidate[];
  onSelect?: (candidate: AtlasCandidate | null) => void;
  selectedId?: string | null;
}

export function AtlasMarkers({ candidates, onSelect }: AtlasMarkersProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const atlasSprites = useMemo(() => {
    return candidates.map((candidate) => {
      const pos = eliteToThreeCentered(candidate);
      const color = TYPE_COLORS[candidate.world_type] || TYPE_COLORS.default;
      const texture = createAtlasTexture(color);
      const material = new THREE.SpriteMaterial({
        map: texture,
        transparent: true,
        opacity: 0.95,
        depthWrite: false,
        blending: THREE.NormalBlending,
      });
      return { candidate, pos, material, color };
    });
  }, [candidates]);

  const handleClick = useCallback(
    (candidate: AtlasCandidate) => {
      const isSame = selectedId === candidate.id;
      setSelectedId(isSame ? null : candidate.id);
      onSelect?.(isSame ? null : candidate);
    },
    [selectedId, onSelect]
  );

  const selectedCandidate =
    selectedId !== null ? candidates.find((c) => c.id === selectedId) : null;

  if (candidates.length === 0) return null;

  return (
    <group>
      {atlasSprites.map(({ candidate, pos, material, color }) => (
        <group key={candidate.id}>
          <AtlasSprite
            candidate={candidate}
            position={pos}
            material={material}
            isSelected={selectedId === candidate.id}
            onClick={() => handleClick(candidate)}
          />
          {selectedId === candidate.id && (
            <SelectionRing position={pos} color={color} />
          )}
        </group>
      ))}
      {selectedCandidate && (
        <AtlasTooltip
          candidate={selectedCandidate}
          onClose={() => {
            setSelectedId(null);
            onSelect?.(null);
          }}
        />
      )}
    </group>
  );
}

function AtlasSprite({
  candidate,
  position,
  material,
  isSelected,
  onClick,
}: {
  candidate: AtlasCandidate;
  position: THREE.Vector3;
  material: THREE.SpriteMaterial;
  isSelected: boolean;
  onClick: () => void;
}) {
  const spriteRef = useRef<THREE.Sprite>(null);

  useFrame((state) => {
    if (spriteRef.current) {
      const baseScale = isSelected ? 50 : 35;
      const pulse = isSelected
        ? 1 + Math.sin(state.clock.elapsedTime * 3) * 0.1
        : 1;
      const s = baseScale * pulse;
      spriteRef.current.scale.set(s, s, 1);
    }
  });

  return (
    <sprite
      ref={spriteRef}
      position={[position.x, position.y, position.z]}
      material={material}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      onPointerOver={() => {
        document.body.style.cursor = "pointer";
      }}
      onPointerOut={() => {
        document.body.style.cursor = "auto";
      }}
    />
  );
}

/** Кольцо-контур при выделении */
function SelectionRing({ position, color }: { position: THREE.Vector3; color: string }) {
  return (
    <mesh position={[position.x, position.y, position.z]} rotation={[Math.PI / 2, 0, 0]}>
      <ringGeometry args={[25, 35, 64]} />
      <meshBasicMaterial color={color} transparent opacity={0.9} side={THREE.DoubleSide} />
    </mesh>
  );
}

function AtlasTooltip({ candidate, onClose }: { candidate: AtlasCandidate; onClose: () => void }) {
  const pos = useMemo(() => eliteToThreeCentered(candidate), [candidate]);
  const color = TYPE_COLORS[candidate.world_type] || TYPE_COLORS.default;
  const label = TYPE_LABELS[candidate.world_type] || candidate.world_type;

  return (
    <Html
      position={[pos.x, pos.y + 140, pos.z]}
      distanceFactor={600}
      style={{ pointerEvents: "auto" }}
      center
    >
      <div className="map-tooltip">
        <button className="map-tooltip-close" onClick={onClose}>
          ×
        </button>
        <div className="map-tooltip-name">{candidate.system_name}</div>
        <div style={{ color, fontSize: 12, marginTop: 4 }}>
          {label}
          {candidate.body_name && candidate.body_name !== candidate.system_name ? ` — ${candidate.body_name}` : ""}
        </div>
        <div className="map-tooltip-coords" style={{ marginTop: 8 }}>
          X: {candidate.x.toFixed(2)} · Y: {candidate.y.toFixed(2)} · Z: {candidate.z.toFixed(2)}
        </div>
        <div style={{ marginTop: 8, fontSize: 12, color: "#9ca3af", fontFamily: "ui-monospace, monospace", lineHeight: 1.6 }}>
          <div>От референса: {candidate.distance_from_ref?.toFixed(1)} ly</div>
          {candidate.distance_to_arrival && <div>До прибытия: {candidate.distance_to_arrival.toFixed(0)} LS</div>}
          {candidate.estimated_value && <div>Стоимость скана: {candidate.estimated_value.toLocaleString("ru")} CR</div>}
        </div>
      </div>
    </Html>
  );
}
