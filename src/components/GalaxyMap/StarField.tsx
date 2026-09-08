"use client";

import { useRef, useMemo, useEffect, useState } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import {
  particlesFromHeightmap,
  StarParticles,
  GALAXY_RADIUS_LY,
  GALAXY_PLANE_LY,
} from "@/lib/ed3dCanon";

function createStarTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  // Мягкое круглое свечение
  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.2, "rgba(255,255,255,0.8)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.3)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function StarField() {
  const pointsRef = useRef<THREE.Points>(null);
  const [particles, setParticles] = useState<StarParticles | null>(null);

  useEffect(() => {
    let cancelled = false;
    particlesFromHeightmap("/ed3d/heightmap7.jpg", 12000)
      .then((data) => {
        if (!cancelled) setParticles(data);
      })
      .catch(() => {
        // Fallback: случайное распределение звёзд
        const count = 8000;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        for (let i = 0; i < count; i++) {
          const r = Math.random() * GALAXY_RADIUS_LY;
          const a = Math.random() * Math.PI * 2;
          positions[i * 3] = Math.cos(a) * r;
          positions[i * 3 + 1] = (Math.random() - 0.5) * GALAXY_PLANE_LY * 2;
          positions[i * 3 + 2] = Math.sin(a) * r;
          colors[i * 3] = 0.8 + Math.random() * 0.2;
          colors[i * 3 + 1] = 0.7 + Math.random() * 0.3;
          colors[i * 3 + 2] = 0.9;
        }
        if (!cancelled) setParticles({ positions, colors });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const geometry = useMemo(() => {
    if (!particles) return null;
    const positions = new Float32Array(particles.positions.length);
    for (let i = 0; i < particles.positions.length / 3; i++) {
      positions[i * 3] = particles.positions[i * 3];
      positions[i * 3 + 1] = particles.positions[i * 3 + 1];
      positions[i * 3 + 2] = -particles.positions[i * 3 + 2];
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(particles.colors, 3));
    return geo;
  }, [particles]);

  const material = useMemo(() => {
    const texture = createStarTexture();
    return new THREE.PointsMaterial({
      size: 180,
      sizeAttenuation: true,
      vertexColors: true,
      map: texture,                 // ← круглая текстура свечения
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.01,              // чистые края
    });
  }, []);

  useFrame((state) => {
    if (pointsRef.current)
      material.opacity = 0.75 + Math.sin(state.clock.elapsedTime * 0.3) * 0.08;
  });

  if (!geometry) return null;
  return <points ref={pointsRef} geometry={geometry} material={material} />;
}
