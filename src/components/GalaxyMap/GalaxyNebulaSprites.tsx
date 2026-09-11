'use client';

import { Html } from '@react-three/drei';
import { useMemo } from 'react';
import * as THREE from 'three';
import { SAGA } from '@/lib/ed3dCanon';
import { GALAXY_NEBULAE, type GalaxyNebula } from '@/lib/galaxyNebulae';

function createNebulaTexture(color: string) {
  const canvas = document.createElement('canvas');
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext('2d')!;
  const rgb = new THREE.Color(color);
  const c = `rgb(${Math.round(rgb.r * 255)},${Math.round(rgb.g * 255)},${Math.round(rgb.b * 255)})`;
  const glow = ctx.createRadialGradient(128, 128, 8, 128, 128, 122);
  glow.addColorStop(0, `${c}`);
  glow.addColorStop(0.18, `${c}cc`);
  glow.addColorStop(0.48, `${c}55`);
  glow.addColorStop(0.78, `${c}18`);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 256, 256);
  // Soft irregular wisps give the marker the cloudy appearance of the game map.
  for (let i = 0; i < 28; i++) {
    const x = 35 + ((i * 83) % 190);
    const y = 35 + ((i * 47) % 190);
    const radius = 12 + ((i * 19) % 42);
    const wisp = ctx.createRadialGradient(x, y, 0, x, y, radius);
    wisp.addColorStop(0, `${c}55`); wisp.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = wisp; ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

function NebulaSprite({ nebula }: { nebula: GalaxyNebula }) {
  const position = useMemo(() => new THREE.Vector3(nebula.x - SAGA.x, 0, -(nebula.z - SAGA.z)), [nebula]);
  const texture = useMemo(() => createNebulaTexture(nebula.color), [nebula.color]);
  const material = useMemo(() => new THREE.SpriteMaterial({ map: texture, transparent: true, opacity: 0.72, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending }), [texture]);

  return <group position={position}>
    <sprite material={material} scale={[nebula.size, nebula.size, 1]} renderOrder={5} raycast={() => null} />
    <Html position={[0, nebula.size * 0.48, 0]} distanceFactor={1250} center style={{ pointerEvents: 'none' }}>
      <div style={{ color: nebula.color, fontFamily: 'ui-monospace, monospace', fontSize: 9, whiteSpace: 'nowrap', textShadow: `0 0 5px ${nebula.color}, 0 0 8px #000`, opacity: 0.9 }}>{nebula.name}</div>
    </Html>
  </group>;
}

export function GalaxyNebulaSprites() {
  return <group>{GALAXY_NEBULAE.map((nebula) => <NebulaSprite key={nebula.name} nebula={nebula} />)}</group>;
}
