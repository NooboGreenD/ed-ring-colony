"use client";

import { useRef, useMemo } from "react";
import { useFrame } from "@react-three/fiber";
import * as THREE from "three";
import { GALAXY_RADIUS_LY, GALAXY_PLANE_LY } from "@/lib/ed3dCanon";

const NEBULA_COLORS = [
  "#7c3aed", // фиолетовый
  "#dc2626", // красный
  "#2563eb", // синий
  "#059669", // зелёный
  "#ea580c", // оранжевый
  "#db2777", // розовый
  "#4f46e5", // индиго
  "#0891b2", // бирюзовый
  "#b45309", // коричневый
  "#7c2d12", // тёмно-красный
];

const TOTAL_PARTICLES = 15000;

function createNebulaTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;

  const grad = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,1)");
  grad.addColorStop(0.25, "rgba(255,255,255,0.5)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.1)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 64, 64);

  const tex = new THREE.CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

export function NebulaClouds() {
  const pointsRef = useRef<THREE.Points>(null);

  const { geometry, material } = useMemo(() => {
    const positions = new Float32Array(TOTAL_PARTICLES * 3);
    const colors = new Float32Array(TOTAL_PARTICLES * 3);
    const sizes = new Float32Array(TOTAL_PARTICLES);

    const tempColor = new THREE.Color();
    const seed = 42;
    let rng = seed;
    const rnd = () => {
      rng = (rng * 16807) % 2147483647;
      return (rng - 1) / 2147483646;
    };

    for (let i = 0; i < TOTAL_PARTICLES; i++) {
      // Равномерное распределение по диску: sqrt(random) для равномерности по площади
      const angle = rnd() * Math.PI * 2;
      const r = Math.sqrt(rnd()) * GALAXY_RADIUS_LY * 0.95;

      // Высота: гауссово распределение около плоскости галактики
      const y = (rnd() + rnd() + rnd() - 1.5) * GALAXY_PLANE_LY * 0.8;

      positions[i * 3] = Math.cos(angle) * r;
      positions[i * 3 + 1] = y;
      positions[i * 3 + 2] = Math.sin(angle) * r;

      // Цвет зависит от угла — создаём цветовые полосы как в спиральных рукавах
      const colorIndex = Math.floor(
        ((Math.sin(angle * 2.5 + r * 0.0003) + 1) / 2) * NEBULA_COLORS.length
      ) % NEBULA_COLORS.length;

      tempColor.set(NEBULA_COLORS[colorIndex]);
      // Вариация цвета
      tempColor.offsetHSL(
        (rnd() - 0.5) * 0.08,
        (rnd() - 0.5) * 0.2,
        (rnd() - 0.5) * 0.15
      );
      colors[i * 3] = tempColor.r;
      colors[i * 3 + 1] = tempColor.g;
      colors[i * 3 + 2] = tempColor.b;

      // Размер частицы — больше к центру, меньше на краях
      const centerBias = 1 - r / GALAXY_RADIUS_LY;
      sizes[i] = 180 + centerBias * 400 + rnd() * 200;
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.setAttribute("color", new THREE.BufferAttribute(colors, 3));
    geo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));

    const tex = createNebulaTexture();
    const mat = new THREE.PointsMaterial({
      size: 300,
      sizeAttenuation: true,
      vertexColors: true,
      map: tex,
      transparent: true,
      opacity: 0.45,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      alphaTest: 0.01,
    });

    return { geometry: geo, material: mat };
  }, []);

  // Медленное дыхание всего поля
  useFrame((state) => {
    if (pointsRef.current) {
      const t = state.clock.elapsedTime;
      material.opacity = 0.4 + Math.sin(t * 0.15) * 0.08;
    }
  });

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      material={material}
    />
  );
}
