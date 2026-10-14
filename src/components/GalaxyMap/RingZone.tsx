"use client";

import * as THREE from "three";

export function RingZone({
  innerRadius = 24500,
  outerRadius = 25500,
  segments = 256,
}: {
  innerRadius?: number;
  outerRadius?: number;
  segments?: number;
}) {
  // The map origin is Sagittarius A*. Keep the tube in the galactic XZ
  // plane, with fixed radial bounds (no scale pulse moving the boundaries).
  const radius = (innerRadius + outerRadius) / 2;
  const tubeRadius = (outerRadius - innerRadius) / 2;

  return (
    <mesh
      rotation={[-Math.PI / 2, 0, 0]}
      position={[0, 0, 0]}
      raycast={() => null}
    >
      <torusGeometry args={[radius, tubeRadius, 32, segments]} />
      <meshBasicMaterial
        color="#e67e22"
        transparent
        opacity={0.035}
        side={THREE.DoubleSide}
        depthWrite={false}
        blending={THREE.AdditiveBlending}
      />
    </mesh>
  );
}
