/**
 * Screen-aware picking for the experimental "all systems" point cloud.
 *
 * Three.js raycasting a Points object walks every vertex. At ~10⁶ points
 * that freezes the tab on hover, so the layer disables built-in raycast and
 * uses this grid instead: only cells the click-ray actually crosses are
 * tested, and the winner is the point closest to the cursor in pixels.
 *
 * The grid is deliberately typed-array only. It used to be a `Map` of one
 * `Uint32Array` per cell plus two more maps — at 1.2M points that is ~1.1M Map
 * entries and ~800 МБ of tab heap (measured in Node, same V8 as Chrome: 133 МБ
 * at 300k points, 456 МБ at 1M, 1090 МБ at 2M), and that heap — not three.js —
 * is what capped the cloud. Points are now counting-sorted into one flat
 * array (CSR, ≈6 МБ per million points), so the map can afford the whole
 * `POINTS_MAX_DEFAULT` budget.
 *
 * Cell keys are a 32-bit hash, so two different cells can share a bucket.
 * That is harmless by construction: a bucket only ever gains candidates, and
 * every candidate still passes the radial and pixel tests below.
 */

/** Smallest cell edge (ly). Below this the buckets stop paying for themselves. */
export const POINT_CELL_MIN_LY = 250;
/** Largest cell edge (ly): keeps one ray traversal to a few thousand points. */
export const POINT_CELL_MAX_LY = 4000;
/** Points per cell the sizing aims at. */
export const POINT_CELL_TARGET = 8;

/** Back-compatible name of the minimum cell edge (a 250 ly grid was the norm). */
export const POINT_CELL_LY = POINT_CELL_MIN_LY;

export function cellHash(ix: number, iy: number, iz: number): number {
  let h = Math.imul(ix | 0, 374761393) ^ Math.imul(iy | 0, 668265263) ^ Math.imul(iz | 0, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  // Stays ≥ 1 and inside int32 so the value can never alias a "no bucket" hole.
  return (h & 0x7fffffff) || 1;
}

export interface PointGrid {
  cellSize: number;
  /** Point indices grouped by cell key, in `order[starts[m] … starts[m+1])`. */
  order: Uint32Array;
  /** Sorted distinct cell keys: a cell is found by binary search. */
  cellKeys: Int32Array;
  /** `cellKeys.length + 1` offsets into `order`. */
  starts: Uint32Array;
  /** Per-cell "already tested during this pick" marks (see `generation`). */
  stamp: Int32Array;
  generation: number;
}

/**
 * Cell edge for a uniform grid of about `target` points per cell over the
 * bounding box of the cloud. Adaptive on purpose: a sample of 2·10⁸ systems in
 * 250 ly cells is a million buckets of one point each — pure overhead, and the
 * ray walks 800 cells to cross the galaxy.
 */
export function choosePointCellSize(positions: Float32Array, count: number, target = POINT_CELL_TARGET): number {
  if (!(count > 0)) return POINT_CELL_MIN_LY;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  const total = Math.min(Math.floor(count), Math.floor(positions.length / 3));
  for (let i = 0; i < total; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const volume = Math.max(1, maxX - minX) * Math.max(1, maxY - minY) * Math.max(1, maxZ - minZ);
  const cells = Math.max(1, total / Math.max(1, target));
  const edge = Math.cbrt(volume / cells);
  if (!Number.isFinite(edge) || edge <= 0) return POINT_CELL_MIN_LY;
  return Math.min(POINT_CELL_MAX_LY, Math.max(POINT_CELL_MIN_LY, edge));
}

/** LSD radix sort of `index` by `keys[index]`: four counting passes, O(n). */
function sortIndicesByKey(keys: Uint32Array, index: Uint32Array): void {
  const total = index.length;
  if (total < 2) return;
  const aux = new Uint32Array(total);
  const counts = new Int32Array(257);
  // Both are annotated as bare `Uint32Array`: the parameter is
  // `Uint32Array<ArrayBufferLike>` while `new Uint32Array(n)` is
  // `Uint32Array<ArrayBuffer>`, and swapping them without the annotation is a
  // type error in TS ≥ 5.7 even though the arrays are interchangeable here.
  let from: Uint32Array = index;
  let to: Uint32Array = aux;
  for (let shift = 0; shift < 32; shift += 8) {
    counts.fill(0);
    for (let i = 0; i < total; i++) counts[(keys[from[i]] >>> shift) & 0xff]++;
    let sum = 0;
    for (let b = 0; b < 256; b++) {
      const at = counts[b];
      counts[b] = sum;
      sum += at;
    }
    for (let i = 0; i < total; i++) {
      const bucket = (keys[from[i]] >>> shift) & 0xff;
      to[counts[bucket]++] = from[i];
    }
    const swap = from;
    from = to;
    to = swap;
  }
  // Even number of passes leaves the result in `index`; odd means one copy.
  if (from !== index) index.set(from);
}

export function buildPointGrid(positions: Float32Array, count: number, cellSize = 0): PointGrid {
  const total = Math.max(0, Math.min(Math.floor(count), Math.floor(positions.length / 3)));
  const cs = cellSize > 0 ? cellSize : choosePointCellSize(positions, total);
  if (total === 0) {
    return {
      cellSize: cs,
      order: new Uint32Array(0),
      cellKeys: new Int32Array(0),
      starts: new Uint32Array(1),
      stamp: new Int32Array(0),
      generation: 0,
    };
  }

  const keys = new Uint32Array(total);
  for (let i = 0; i < total; i++) {
    keys[i] = cellHash(
      Math.floor(positions[i * 3] / cs),
      Math.floor(positions[i * 3 + 1] / cs),
      Math.floor(positions[i * 3 + 2] / cs),
    );
  }
  const order = new Uint32Array(total);
  for (let i = 0; i < total; i++) order[i] = i;
  sortIndicesByKey(keys, order);

  // Run-length encode the sorted keys: one bucket per distinct cell hash.
  let cells = 1;
  for (let i = 1; i < total; i++) if (keys[order[i]] !== keys[order[i - 1]]) cells++;
  const cellKeys = new Int32Array(cells);
  const starts = new Uint32Array(cells + 1);
  let at = 0;
  for (let i = 0; i < total; i++) {
    const key = keys[order[i]];
    if (i === 0 || key !== keys[order[i - 1]]) {
      cellKeys[at] = key;
      starts[at] = i;
      at++;
    }
  }
  starts[cells] = total;

  return { cellSize: cs, order, cellKeys, starts, stamp: new Int32Array(cells), generation: 0 };
}

/** Bucket of one cell, or -1 when nothing was sampled into it. */
export function findPointCell(grid: PointGrid, ix: number, iy: number, iz: number): number {
  const key = cellHash(ix, iy, iz);
  const keys = grid.cellKeys;
  let low = 0;
  let high = keys.length - 1;
  while (low <= high) {
    const mid = (low + high) >>> 1;
    const at = keys[mid];
    if (at === key) return mid;
    if (at < key) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
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
  // A point within `threshold` of the ray can sit in a neighbouring cell: at
  // least one ring is always tested, more when the corridor is wider than a
  // cell. Bigger cells (adaptive sizing) usually mean exactly one ring.
  const expand = Math.min(3, Math.max(1, Math.ceil(threshold / cs)));

  // Neighbourhoods of consecutive steps overlap, so "already tested" is a
  // generation counter rather than a Set — one click must not allocate.
  if (grid.generation >= 0x7ffffffe) {
    grid.stamp.fill(0);
    grid.generation = 0;
  }
  grid.generation += 1;
  const generation = grid.generation;

  let best: PickResult | null = null;

  const considerCell = (ix: number, iy: number, iz: number) => {
    const bucket = findPointCell(grid, ix, iy, iz);
    if (bucket < 0 || grid.stamp[bucket] === generation) return;
    grid.stamp[bucket] = generation;
    const end = grid.starts[bucket + 1];
    for (let n = grid.starts[bucket]; n < end; n++) {
      const index = grid.order[n];
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
