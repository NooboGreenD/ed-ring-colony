/**
 * Screen-aware picking for the experimental "all systems" point cloud.
 *
 * Three.js raycasting a Points object walks every vertex. At ~10⁶ points
 * that freezes the tab on hover, so the layer disables built-in raycast and
 * uses this grid instead: only cells the click-ray actually crosses are
 * tested, and the winner is the point closest to the cursor in pixels.
 */

export const POINT_CELL_LY = 250;
const PACK_BIAS = 20000;
const PACK_SPAN = 40001;

export function packCell(ix: number, iy: number, iz: number): number {
  return ((ix + PACK_BIAS) * PACK_SPAN + (iy + PACK_BIAS)) * PACK_SPAN + (iz + PACK_BIAS);
}

export interface PointGrid {
  cellSize: number;
  cells: Map<number, Uint32Array>;
}

export function buildPointGrid(positions: Float32Array, count: number, cellSize = POINT_CELL_LY): PointGrid {
  const counts = new Map<number, number>();
  for (let i = 0; i < count; i++) {
    const key = packCell(
      Math.floor(positions[i * 3] / cellSize),
      Math.floor(positions[i * 3 + 1] / cellSize),
      Math.floor(positions[i * 3 + 2] / cellSize),
    );
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const cells = new Map<number, Uint32Array>();
  const fill = new Map<number, number>();
  for (const [key, n] of counts) {
    cells.set(key, new Uint32Array(n));
    fill.set(key, 0);
  }
  for (let i = 0; i < count; i++) {
    const key = packCell(
      Math.floor(positions[i * 3] / cellSize),
      Math.floor(positions[i * 3 + 1] / cellSize),
      Math.floor(positions[i * 3 + 2] / cellSize),
    );
    const bucket = cells.get(key)!;
    const at = fill.get(key)!;
    bucket[at] = i;
    fill.set(key, at + 1);
  }
  return { cellSize, cells };
}

export interface Ray {
  ox: number;
  oy: number;
  oz: number;
  dx: number;
  dy: number;
  dz: number;
}

export interface PickCamera {
  position: { x: number; y: number; z: number };
  right: { x: number; y: number; z: number };
  up: { x: number; y: number; z: number };
  /** World-space direction the camera looks along. */
  forward: { x: number; y: number; z: number };
  fovY: number;
  width: number;
  height: number;
  clickX: number;
  clickY: number;
}

export interface PickResult {
  index: number;
  rayDistance: number;
  /** CSS-pixel distance from the click, when a camera was supplied. */
  screenDistance: number | null;
  radial: number;
}

/** Integer bit test. Must stay equivalent to `shaderMaskVisible` (the GLSL path). */
export function classBitVisible(mask: number, starClass: number): boolean {
  if (!Number.isInteger(starClass) || starClass < 0 || starClass > 23) return false;
  return (mask & (1 << starClass)) !== 0;
}

/**
 * Float reconstruction of the point-cloud fragment discard:
 * `mod(floor(mask / exp2(class)), 2) >= 0.5`.
 * Exact for masks that fit in the float32 mantissa (we use ≤ 18 bits).
 */
export function shaderMaskVisible(mask: number, starClass: number): boolean {
  if (!Number.isInteger(starClass) || starClass < 0 || starClass > 23) return false;
  const bit = 2 ** starClass;
  return Math.floor(mask / bit) % 2 >= 0.5;
}

export function worldUnitsPerPixel(distance: number, fovDeg: number, viewportHeight: number): number {
  const fov = (fovDeg * Math.PI) / 180;
  return (2 * Math.max(0, distance) * Math.tan(fov / 2)) / Math.max(1, viewportHeight);
}

export function screenDistance(camera: PickCamera, x: number, y: number, z: number): number | null {
  const vx = x - camera.position.x;
  const vy = y - camera.position.y;
  const vz = z - camera.position.z;
  const depth = vx * camera.forward.x + vy * camera.forward.y + vz * camera.forward.z;
  if (depth <= 1) return null;
  const rx = vx * camera.right.x + vy * camera.right.y + vz * camera.right.z;
  const uy = vx * camera.up.x + vy * camera.up.y + vz * camera.up.z;
  const halfH = Math.tan(camera.fovY / 2) * depth;
  const halfW = halfH * (camera.width / Math.max(1, camera.height));
  const sx = (rx / halfW) * 0.5 * camera.width + camera.width / 2;
  const sy = (-uy / halfH) * 0.5 * camera.height + camera.height / 2;
  return Math.hypot(sx - camera.clickX, sy - camera.clickY);
}

function normalizeRay(ray: Ray): Ray | null {
  const len = Math.hypot(ray.dx, ray.dy, ray.dz);
  if (!(len > 0)) return null;
  return { ox: ray.ox, oy: ray.oy, oz: ray.oz, dx: ray.dx / len, dy: ray.dy / len, dz: ray.dz / len };
}

export function pickAlongRay(
  grid: PointGrid,
  positions: Float32Array,
  rayIn: Ray,
  options: {
    maxDistance?: number;
    /** World-space corridor around the ray. Candidates outside it are ignored. */
    threshold: number;
    visibleMask?: number;
    starTypes?: Uint8Array;
    camera?: PickCamera;
    pixelRadius?: number;
  },
): PickResult | null {
  const ray = normalizeRay(rayIn);
  if (!ray) return null;
  const maxDistance = options.maxDistance ?? 200_000;
  const threshold = options.threshold;
  if (!(threshold > 0) || !Number.isFinite(threshold)) return null;
  const pixelRadius = options.pixelRadius ?? 12;
  const cs = grid.cellSize;
  const expand = Math.min(3, Math.ceil(threshold / cs));

  let best: PickResult | null = null;
  const visited = new Set<number>();

  const considerCell = (ix: number, iy: number, iz: number) => {
    const key = packCell(ix, iy, iz);
    if (visited.has(key)) return;
    visited.add(key);
    const bucket = grid.cells.get(key);
    if (!bucket) return;
    for (let n = 0; n < bucket.length; n++) {
      const index = bucket[n];
      if (options.visibleMask != null && options.starTypes) {
        if (!classBitVisible(options.visibleMask, options.starTypes[index] ?? 15)) continue;
      }
      const px = positions[index * 3];
      const py = positions[index * 3 + 1];
      const pz = positions[index * 3 + 2];
      const vx = px - ray.ox;
      const vy = py - ray.oy;
      const vz = pz - ray.oz;
      const t = vx * ray.dx + vy * ray.dy + vz * ray.dz;
      if (t < 0 || t > maxDistance) continue;
      const radial = Math.hypot(vx - ray.dx * t, vy - ray.dy * t, vz - ray.dz * t);
      if (radial > threshold) continue;
      const pixels = options.camera ? screenDistance(options.camera, px, py, pz) : null;
      if (options.camera && (pixels == null || pixels > pixelRadius)) continue;
      const closerOnRay = Math.abs((pixels ?? radial) - (best && pixels != null ? (best.screenDistance ?? Infinity) : (best?.radial ?? Infinity))) <= (pixels != null ? 0.05 : 1e-6)
        && t < (best?.rayDistance ?? Infinity);
      const tighter = best == null
        || (pixels != null && best.screenDistance != null && pixels < best.screenDistance - 0.05)
        || (pixels == null && radial < best.radial - 1e-6);
      if (tighter || closerOnRay) best = { index, rayDistance: t, screenDistance: pixels, radial };
    }
  };

  let ix = Math.floor(ray.ox / cs);
  let iy = Math.floor(ray.oy / cs);
  let iz = Math.floor(ray.oz / cs);
  const stepX = ray.dx > 0 ? 1 : ray.dx < 0 ? -1 : 0;
  const stepY = ray.dy > 0 ? 1 : ray.dy < 0 ? -1 : 0;
  const stepZ = ray.dz > 0 ? 1 : ray.dz < 0 ? -1 : 0;
  const tDeltaX = stepX === 0 ? Infinity : Math.abs(cs / ray.dx);
  const tDeltaY = stepY === 0 ? Infinity : Math.abs(cs / ray.dy);
  const tDeltaZ = stepZ === 0 ? Infinity : Math.abs(cs / ray.dz);
  let tMaxX = stepX === 0 ? Infinity : ((stepX > 0 ? (ix + 1) * cs : ix * cs) - ray.ox) / ray.dx;
  let tMaxY = stepY === 0 ? Infinity : ((stepY > 0 ? (iy + 1) * cs : iy * cs) - ray.oy) / ray.dy;
  let tMaxZ = stepZ === 0 ? Infinity : ((stepZ > 0 ? (iz + 1) * cs : iz * cs) - ray.oz) / ray.dz;

  let traveled = 0;
  for (let steps = 0; steps < 4000 && traveled <= maxDistance; steps++) {
    for (let dx = -expand; dx <= expand; dx++) {
      for (let dy = -expand; dy <= expand; dy++) {
        for (let dz = -expand; dz <= expand; dz++) considerCell(ix + dx, iy + dy, iz + dz);
      }
    }
    if (tMaxX <= tMaxY && tMaxX <= tMaxZ) {
      if (!Number.isFinite(tMaxX)) break;
      traveled = tMaxX;
      ix += stepX;
      tMaxX += tDeltaX;
    } else if (tMaxY <= tMaxZ) {
      if (!Number.isFinite(tMaxY)) break;
      traveled = tMaxY;
      iy += stepY;
      tMaxY += tDeltaY;
    } else {
      if (!Number.isFinite(tMaxZ)) break;
      traveled = tMaxZ;
      iz += stepZ;
      tMaxZ += tDeltaZ;
    }
  }
  return best;
}
