"use client";

import * as THREE from "three";

export const SAGA = { x: 25.21875, y: -20.90625, z: 25899.96875 };
export const SOL = { x: 0, y: 0, z: 0 };
export const COLONIA = { x: -9530.5, y: -910.28125, z: 19808.125 };
export const GALAXY_PLANE_LY = 2000;
export const GALAXY_RADIUS_LY = 50000;

export const LANDMARKS = [
  { name: "Sol", ...SOL, color: "#4fc3f7" },
  { name: "Colonia", ...COLONIA, color: "#ff6b6b" },
  { name: "Sagittarius A*", ...SAGA, color: "#ffd700" },
] as const;

export function eliteToThree(coords: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(coords.x, coords.y, -coords.z);
}

export function eliteToThreeCentered(coords: { x: number; y: number; z: number }): THREE.Vector3 {
  const v = eliteToThree(coords);
  const center = eliteToThree(SAGA);
  return v.sub(center);
}

export function threeToElite(v: THREE.Vector3): { x: number; y: number; z: number } {
  const center = eliteToThree(SAGA);
  const world = v.clone().add(center);
  return { x: world.x, y: world.y, z: -world.z };
}

export function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load image: ${url}`));
    img.src = url;
  });
}

export interface StarParticles {
  positions: Float32Array;
  colors: Float32Array;
}

export async function particlesFromHeightmap(
  url: string = "/ed3d/heightmap7.jpg",
  count: number = 12000,
  onProgress?: (progress: number) => void
): Promise<StarParticles> {
  const img = await loadImage(url);
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  canvas.width = img.width;
  canvas.height = img.height;
  ctx.drawImage(img, 0, 0);

  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);

  const w = canvas.width;
  const h = canvas.height;
  const radius = GALAXY_RADIUS_LY;

  for (let i = 0; i < count; i++) {
    if (onProgress && i % 500 === 0) onProgress(i / count);

    const angle = Math.random() * Math.PI * 2;
    const r = Math.sqrt(Math.random()) * radius;
    const px = Math.floor(((Math.cos(angle) * r) / radius + 1) / 2 * w);
    const py = Math.floor(((Math.sin(angle) * r) / radius + 1) / 2 * h);

    const idx = (Math.max(0, Math.min(h - 1, py)) * w + Math.max(0, Math.min(w - 1, px))) * 4;
    const brightness = data[idx] / 255;
    const y = (brightness - 0.5) * GALAXY_PLANE_LY * 2;

    const idx3 = i * 3;
    positions[idx3] = Math.cos(angle) * r;
    positions[idx3 + 1] = y;
    positions[idx3 + 2] = Math.sin(angle) * r;

    const temp = 0.3 + brightness * 0.7;
    colors[idx3] = 0.8 + temp * 0.2;
    colors[idx3 + 1] = 0.7 + temp * 0.3;
    colors[idx3 + 2] = 0.9 - temp * 0.3;
  }

  if (onProgress) onProgress(1);
  return { positions, colors };
}

export function dist3(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number }
): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}
