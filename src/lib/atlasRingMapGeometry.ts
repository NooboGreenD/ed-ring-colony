import { eliteToThreeCentered } from './ed3dCanon';
import { ringPointAtAngle3D } from './atlasRingGeometry';
import type { AtlasSearchRing } from './atlasSearchProgress';

/** Контур, луч и маршрут должны использовать одно преобразование Elite → Three. */
export function atlasRingPointToThree(ring: AtlasSearchRing, angle: number): [number, number, number] {
  const basis = ring.basis || { ux: 1, uy: 0, uz: 0, vx: 0, vy: 0, vz: 1 };
  const point = ringPointAtAngle3D(
    { x: ring.cx, y: ring.cy, z: ring.cz },
    { ...basis, nx: 0, ny: 1, nz: 0 }, ring.radius, angle,
  );
  const vector = eliteToThreeCentered(point);
  return [vector.x, vector.y, vector.z];
}
