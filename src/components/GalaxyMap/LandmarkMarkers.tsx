"use client";

import { useMemo } from "react";
import { Html } from "@react-three/drei";
import * as THREE from "three";
import { eliteToThreeCentered, LANDMARKS } from "@/lib/ed3dCanon";

function LandmarkSprite({ landmark }: { landmark: typeof LANDMARKS[number] }) {
  const pos = useMemo(() => eliteToThreeCentered(landmark), [landmark]);

  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 64;
    canvas.height = 64;
    const ctx = canvas.getContext("2d")!;

    const grad = ctx.createRadialGradient(32, 32, 2, 32, 32, 32);
    grad.addColorStop(0, landmark.color);
    grad.addColorStop(0.5, landmark.color + "44");
    grad.addColorStop(1, "transparent");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, 64, 64);

    ctx.beginPath();
    ctx.arc(32, 32, 4, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    const tex = new THREE.CanvasTexture(canvas);
    tex.needsUpdate = true;
    return tex;
  }, [landmark.color]);

  const material = useMemo(() => {
    return new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
  }, [texture]);

  return (
    <group position={[pos.x, pos.y, pos.z]}>
      <sprite material={material} scale={[120, 120, 1]} />
      <Html position={[0, 90, 0]} distanceFactor={800} style={{ pointerEvents: "none" }} center>
        <div style={{
          color: landmark.color,
          fontFamily: '"Courier New", monospace',
          fontSize: "13px",
          fontWeight: "bold",
          textShadow: `0 0 6px ${landmark.color}`,
          whiteSpace: "nowrap",
          textAlign: "center",
          letterSpacing: "1px",
          transform: "translateX(-50%)",
        }}>
          {landmark.name}
        </div>
      </Html>
    </group>
  );
}

export function LandmarkMarkers() {
  return (
    <group>
      {LANDMARKS.map((lm) => (
        <LandmarkSprite key={lm.name} landmark={lm} />
      ))}
    </group>
  );
}
