"use client";

import { useMemo } from "react";
import * as THREE from "three";
import { eliteToThreeCentered } from "@/lib/ed3dCanon";
import type { RoutePoint } from "./useGalaxyData";

interface RouteLineProps {
  points: RoutePoint[];
  color?: string;
  opacity?: number;
}

export function RouteLine({ points, color = "#e67e22", opacity = 0.35 }: RouteLineProps) {
  const line = useMemo(() => {
    const valid = points.filter(
      (p) =>
        typeof p.x === "number" &&
        typeof p.y === "number" &&
        typeof p.z === "number"
    );
    if (valid.length < 2) return null;

    const vecs = valid.map((p) => eliteToThreeCentered(p));
    const geometry = new THREE.BufferGeometry().setFromPoints(vecs);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity,
    });

    return new THREE.Line(geometry, material);
  }, [points, color, opacity]);

  if (!line) return null;
  return <primitive object={line} />;
}