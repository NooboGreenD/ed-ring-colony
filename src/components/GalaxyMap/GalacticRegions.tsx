"use client";

import { useMemo, useRef, useState, useCallback } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { eliteToThreeCentered, SAGA } from "@/lib/ed3dCanon";
import regionPack from "@/lib/galacticRegions.json";

// ─── Типы ───────────────────────────────────────────────────────────────────

export interface GalacticRegion {
  id: number;
  name: string;
  cx: number;
  cz: number;
  path: number[][];
}

const REGIONS = (regionPack as any).regions as GalacticRegion[];

// ─── Цвета ──────────────────────────────────────────────────────────────────

const BASE_COLOR = new THREE.Color("#1e3a5f");
const HOVER_COLOR = new THREE.Color("#e67e22");
const SELECTED_COLOR = new THREE.Color("#ff6b35");
const BASE_OPACITY = 0.1;
const HOVER_OPACITY = 0.28;
const SELECTED_OPACITY = 0.38;

// ─── Декоративная сетка: концентрические круги ──────────────────────────────

function RingGrid() {
  const lineObj = useMemo(() => {
    const pts: THREE.Vector3[] = [];
    const segs = 128;
    const radii = [3500, 7500, 13000, 19000, 26000];
    for (const r of radii) {
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
      }
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(pts);
    const material = new THREE.LineBasicMaterial({
      color: "#8cb4e0",
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    return new THREE.Line(geometry, material);
  }, []);

  return <primitive object={lineObj} />;
}

// ─── Декоративная сетка: радиальные лучи ────────────────────────────────────

function RadialGrid() {
  const lineObj = useMemo(() => {
    const positions: number[] = [];
    const rays = 24;
    const maxR = 26000;
    for (let i = 0; i < rays; i++) {
      const a = (i / rays) * Math.PI * 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      positions.push(0, 0, 0, cos * maxR, 0, sin * maxR);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.BufferAttribute(new Float32Array(positions), 3)
    );
    const material = new THREE.LineBasicMaterial({
      color: "#8cb4e0",
      transparent: true,
      opacity: 0.12,
      depthWrite: false,
    });
    return new THREE.LineSegments(geometry, material);
  }, []);

  return <primitive object={lineObj} />;
}

// ─── Геометрия региона из path ──────────────────────────────────────────────

function createRegionGeometry(path: number[][]): THREE.ShapeGeometry {
  const shape = new THREE.Shape();
  if (!path.length) return new THREE.ShapeGeometry();

  const first = eliteToThreeCentered({
    x: SAGA.x + path[0][0],
    y: 0,
    z: SAGA.z + path[0][1],
  });
  shape.moveTo(first.x, first.z);

  for (let i = 1; i < path.length; i++) {
    const pt = eliteToThreeCentered({
      x: SAGA.x + path[i][0],
      y: 0,
      z: SAGA.z + path[i][1],
    });
    shape.lineTo(pt.x, pt.z);
  }
  shape.closePath();

  return new THREE.ShapeGeometry(shape, 24);
}

// ─── Компонент региона ──────────────────────────────────────────────────────

function RegionMesh({
  region,
  isSelected,
  onSelect,
  onHover,
}: {
  region: GalacticRegion;
  isSelected: boolean;
  onSelect: (region: GalacticRegion) => void;
  onHover: (id: number | null) => void;
}) {
  const meshRef = useRef<THREE.Mesh>(null);
  const [hovered, setHovered] = useState(false);

  const geometry = useMemo(
    () => createRegionGeometry(region.path),
    [region]
  );

  const material = useMemo(
    () =>
      new THREE.MeshBasicMaterial({
        color: BASE_COLOR,
        transparent: true,
        opacity: BASE_OPACITY,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
      }),
    []
  );

  const active = hovered || isSelected;
  material.color.copy(
    isSelected ? SELECTED_COLOR : hovered ? HOVER_COLOR : BASE_COLOR
  );
  material.opacity = isSelected
    ? SELECTED_OPACITY
    : hovered
    ? HOVER_OPACITY
    : BASE_OPACITY;

  const handlePointerOver = useCallback(
    (e: any) => {
      e.stopPropagation();
      setHovered(true);
      onHover(region.id);
      document.body.style.cursor = "pointer";
    },
    [region.id, onHover]
  );

  const handlePointerOut = useCallback(
    (e: any) => {
      e.stopPropagation();
      setHovered(false);
      onHover(null);
      document.body.style.cursor = "auto";
    },
    [onHover]
  );

  const handleClick = useCallback(
    (e: any) => {
      e.stopPropagation();
      onSelect(region);
    },
    [region, onSelect]
  );

  return (
    <mesh
      ref={meshRef}
      geometry={geometry}
      material={material}
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 8, 0]}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
      onClick={handleClick}
    />
  );
}

// ─── Лейбл региона ──────────────────────────────────────────────────────────

function RegionLabel({
  region,
  visible,
}: {
  region: GalacticRegion;
  visible: boolean;
}) {
  const pos = useMemo(() => {
    return eliteToThreeCentered({
      x: SAGA.x + region.cx,
      y: 0,
      z: SAGA.z + region.cz,
    });
  }, [region]);

  if (!visible) return null;

  return (
    <Html
      position={[pos.x, 50, pos.z]}
      distanceFactor={1000}
      style={{ pointerEvents: "none" }}
      center
    >
      <div
        style={{
          textAlign: "center",
          userSelect: "none",
        }}
      >
        <div
          style={{
            color: "#e67e22",
            fontFamily: '"Courier New", monospace',
            fontSize: region.id === 1 ? "16px" : "13px",
            fontWeight: "bold",
            textShadow: "0 0 8px #e67e22, 0 0 16px #000",
            letterSpacing: "1px",
            lineHeight: 1.1,
          }}
        >
          {region.id}
        </div>
        <div
          style={{
            color: "rgba(180, 200, 230, 0.75)",
            fontFamily: '"Segoe UI", system-ui, sans-serif',
            fontSize: "9px",
            fontWeight: 500,
            textShadow: "0 0 4px #000",
            marginTop: 2,
            maxWidth: 140,
            lineHeight: 1.15,
          }}
        >
          {region.name}
        </div>
      </div>
    </Html>
  );
}

// ─── Главный компонент ──────────────────────────────────────────────────────

interface GalacticRegionsProps {
  onSelectRegion?: (region: GalacticRegion | null) => void;
  selectedRegionId?: number | null;
}

export function GalacticRegions({
  onSelectRegion,
  selectedRegionId,
}: GalacticRegionsProps) {
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const handleSelect = useCallback(
    (region: GalacticRegion) => {
      onSelectRegion?.(region);
    },
    [onSelectRegion]
  );

  return (
    <group>
      {/* Декоративная сетка */}
      <RingGrid />
      <RadialGrid />

      {/* Регионы */}
      {REGIONS.map((region) => (
        <RegionMesh
          key={region.id}
          region={region}
          isSelected={selectedRegionId === region.id}
          onSelect={handleSelect}
          onHover={setHoveredId}
        />
      ))}

      {/* Лейблы */}
      {REGIONS.map((region) => (
        <RegionLabel
          key={`lbl-${region.id}`}
          region={region}
          visible={
            hoveredId === region.id || selectedRegionId === region.id
          }
        />
      ))}
    </group>
  );
}
