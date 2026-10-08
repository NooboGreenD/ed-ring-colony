/**
 * Shared logic for the Spansh galaxy-systems pipeline.
 *
 * Used by:
 *  - `scripts/import-spansh-systems.mjs` (Node ≥22.18 type-stripping import)
 *  - API routes (atlas search, /api/galaxy/*) and the GalaxyMap "all systems"
 *    experimental layer.
 *
 * Coordinate frame: the same Sol-centered frame the whole site already uses
 * (ed3dCanon.ts): Sol = (0,0,0), Sagittarius A* = (25.21875, -20.90625, 25899.96875).
 * Spansh/EDSM coordinates live in this frame, so no conversion is needed.
 */

import type { WorldType } from '../types/atlas.ts';

export const SAGA_LY = { x: 25.21875, y: -20.90625, z: 25899.96875 };

export type StarClass =
  | 'o' | 'b' | 'a' | 'f' | 'g' | 'k' | 'm'
  | 'brown_dwarf' | 'neutron' | 'black_hole' | 'white_dwarf'
  | 'wolf_rayet' | 'herbig_ae_be' | 't_tauri' | 'carbon'
  | 'unknown'
  // Append-only. The points file stores this index in one byte.
  | 's_type' | 'ms_type';

export type GiantClass = 'dwarf' | 'giant' | 'supergiant' | null;

export interface StarClassification {
  /** Normalized spectral/exotic class (map color + atlas filters). */
  starType: StarClass;
  /** Luminosity class for ordinary stars; null for exotic objects. */
  giantClass: GiantClass;
  /** Atlas WorldTypes this main star matches (star candidates). */
  worldTypes: WorldType[];
}

const CLASS_BY_PREFIX: Array<[RegExp, StarClass]> = [
  [/^O \(Blue-White\)/, 'o'],
  [/^B \(Blue-White/, 'b'],
  [/^A \(Blue-White/, 'a'],
  [/^F \(White/, 'f'],
  [/^G \(White-Yellow/, 'g'],
  [/^K \(Yellow-Orange/, 'k'],
  [/^M \(Red (?:dwarf|giant|super giant)/, 'm'],
  [/^(?:L|T|Y) \(Brown dwarf\)/, 'brown_dwarf'],
];

/**
 * Map the raw Spansh `mainStar` string (BriefDumpSystem enum) to a normalized
 * class. See systems.schema.json in spansh/elite_dangerous_schemas.
 */
export function classifyStar(mainStar: string | null | undefined): StarClassification {
  const s = (mainStar || '').trim();
  if (!s) return { starType: 'unknown', giantClass: null, worldTypes: [] };

  let starType: StarClass | null = null;

  if (s === 'Neutron Star') starType = 'neutron';
  else if (s === 'Black Hole' || s === 'Supermassive Black Hole') starType = 'black_hole';
  else if (/^White Dwarf \(D/.test(s)) starType = 'white_dwarf';
  else if (/^Wolf-Rayet (?:C|N|NC|O)?-? ?Star$/.test(s)) starType = 'wolf_rayet';
  else if (s === 'Herbig Ae/Be Star') starType = 'herbig_ae_be';
  else if (s === 'T Tauri Star') starType = 't_tauri';
  else if (s === 'C Star' || s === 'CJ Star' || s === 'CN Star' || s === 'C-type Star') starType = 'carbon';
  else if (s === 'S-type Star' || s === 'S Star') starType = 's_type';
  else if (s === 'MS-type Star' || s === 'MS Star') starType = 'ms_type';
  else for (const [re, cls] of CLASS_BY_PREFIX) { if (re.test(s)) { starType = cls; break; } }

  if (!starType) return { starType: 'unknown', giantClass: null, worldTypes: [] };

  // Luminosity only makes sense for ordinary spectral classes.
  let giantClass: GiantClass = 'dwarf';
  if (starType === 'brown_dwarf') giantClass = 'dwarf';
  else if (/(super )?giant/.test(s)) giantClass = /super giant/.test(s) ? 'supergiant' : 'giant';
  else giantClass = 'dwarf';
  if (!/^(?:o|b|a|f|g|k|m)$/.test(starType)) giantClass = null;

  const worldTypes: WorldType[] = [];
  switch (starType) {
    case 'neutron': worldTypes.push('neutron_star'); break;
    case 'black_hole': worldTypes.push('black_hole'); break;
    case 'white_dwarf': worldTypes.push('white_dwarf'); break;
    case 'wolf_rayet': worldTypes.push('wolf_rayet'); break;
    case 'herbig_ae_be': worldTypes.push('herbig_ae_be'); break;
    case 't_tauri': worldTypes.push('t_tauri'); break;
    case 'carbon': worldTypes.push('carbon_star'); break;
    default:
      if (giantClass === 'supergiant') worldTypes.push('supergiant');
      else if (giantClass === 'giant') worldTypes.push('giant');
      break;
  }

  return { starType, giantClass, worldTypes };
}

/** Map color per normalized star class. Index === value stored in the points file. */
export const STAR_CLASS_INDEX: Record<StarClass, number> = {
  o: 0, b: 1, a: 2, f: 3, g: 4, k: 5, m: 6, brown_dwarf: 7,
  neutron: 8, black_hole: 9, white_dwarf: 10, wolf_rayet: 11,
  herbig_ae_be: 12, t_tauri: 13, carbon: 14, unknown: 15,
  s_type: 16, ms_type: 17,
};

export const STAR_CLASS_LIST: StarClass[] = [
  'o', 'b', 'a', 'f', 'g', 'k', 'm', 'brown_dwarf',
  'neutron', 'black_hole', 'white_dwarf', 'wolf_rayet',
  'herbig_ae_be', 't_tauri', 'carbon', 'unknown',
  's_type', 'ms_type',
];

/** [r,g,b] 0..1 per STAR_CLASS_LIST index. */
export const STAR_CLASS_COLORS: Array<[number, number, number]> = [
  [0.61, 0.76, 1.00], // o
  [0.63, 0.78, 1.00], // b
  [0.84, 0.90, 1.00], // a
  [1.00, 0.95, 0.86], // f
  [1.00, 0.88, 0.55], // g
  [1.00, 0.72, 0.44], // k
  [1.00, 0.55, 0.34], // m
  [0.62, 0.32, 0.28], // brown_dwarf
  [0.75, 0.88, 1.00], // neutron
  [0.58, 0.38, 0.85], // black_hole
  [0.85, 0.95, 1.00], // white_dwarf
  [0.55, 0.80, 1.00], // wolf_rayet
  [1.00, 0.70, 0.90], // herbig_ae_be
  [1.00, 0.62, 0.48], // t_tauri
  [1.00, 0.80, 0.58], // carbon
  [0.62, 0.66, 0.74], // unknown
  [1.00, 0.42, 0.22], // s_type
  [0.92, 0.28, 0.32], // ms_type
];

export const STAR_CLASS_LABELS: Record<StarClass, string> = {
  o: 'O-класс', b: 'B-класс', a: 'A-класс', f: 'F-класс', g: 'G-класс',
  k: 'K-класс', m: 'M-класс', brown_dwarf: 'Коричневый карлик',
  neutron: 'Нейтронная звезда', black_hole: 'Чёрная дыра', white_dwarf: 'Белый карлик',
  wolf_rayet: 'Звезда Вольфа–Райе', herbig_ae_be: 'Herbig Ae/Be', t_tauri: 'T Tauri',
  carbon: 'Углеродистая звезда', unknown: 'Не определён',
  s_type: 'S-тип', ms_type: 'MS-тип',
};

/** Normalized search key for a system name (matches galaxy_systems.name_lc). */
export function normalizeSystemName(name: string): string {
  return name.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function distanceFromSols(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

export function distanceFromSgra(x: number, y: number, z: number): number {
  const dx = x - SAGA_LY.x;
  const dy = y - SAGA_LY.y;
  const dz = z - SAGA_LY.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// ════════════════════════════════════════════════════════════════
// Points file (experimental "all systems" galaxy-map layer)
//
// Layout v1 (little-endian):
//   4B  magic 'EDGS'
//   1B  version (=1)
//   3B  reserved (0) — keeps the header 4-byte aligned
//   4B  count (uint32)
//   count * 3 x float32  positions — elite/Sol-centered coords (x,y,z)
//   count x uint32       id64 high 32 bits
//   count x uint32       id64 low 32 bits
//   count x uint8        star class index (STAR_CLASS_LIST)
// (float/uint32 sections start on 4-byte boundaries; the 1-byte section
//  is last so no padding is needed — 29 bytes per point)
// Each point carries its own id64, so a click does not depend on dump order.
// A file built from the table is still emitted `ORDER BY id` so two builds
// of the same catalog compare equal.
// ════════════════════════════════════════════════════════════════

export const POINTS_MAGIC = 'EDGS';
export const POINTS_VERSION = 1;
export const POINTS_HEADER_SIZE = 12;
/** Public bucket the importer uploads the map point cloud into. */
export const POINTS_STORAGE_BUCKET = 'galaxy-data';
export const POINTS_STORAGE_OBJECT = 'galaxy-systems-points.bin';
/** Bytes per point: 3*float32 + 1*uint8 + 2*uint32 = 29. */
export const POINTS_BYTES_PER_POINT = 29;

/**
 * Upper bound for the map point cloud.
 *
 * The catalog is not 1.3M systems — Spansh's `systems.json.gz` (5.9 GiB) holds
 * the whole explored galaxy, ~2×10⁸ systems (EDAstro counts 203.6M). One point
 * per system would be ~5.5 GiB in this format, so the cloud is a uniform
 * sample: {@link PointsBuilder} keeps every `stride`-th system and the sample
 * size is reported in `galaxy_systems_meta`.
 *
 * The number below is the largest cloud that survives every step of the way,
 * measured rather than guessed (2026-10-08, `galaxy-points-scale.test.mjs`
 * pins the arithmetic):
 *
 *  - **transfer** — one file per browser, immutable, so it is downloaded once
 *    and cached: `2,000,000 × 29 B + 12 B` = 58 МБ;
 *  - **tab memory** — the file is kept as an `ArrayBuffer` and the layer adds
 *    map-frame positions (12 B/pt) and colors (12 B/pt) on top, plus the
 *    picking grid (≈14 B/pt, `galaxyPointsPick.ts`): ≈ 67 B/pt ≈ 135 МБ;
 *  - **GPU** — one draw call of N point sprites; a few million is free, the
 *    vertex buffers duplicate 25 B/pt;
 *  - **bucket** — `galaxy-data` accepts 64 МБ (migration
 *    `20261009000000_galaxy_points_scale.sql`) and the build clamps itself to
 *    whatever the bucket actually allows, so a deployment that never ran the
 *    migration still publishes (1.81M points at the old 50 МБ limit) instead of
 *    failing with a 413.
 *
 * `POINTS_FILE_BUDGET` is the hard ceiling of that list: raising
 * `GALAXY_POINTS_MAX` above it is refused, because the next consumer is a phone
 * on a mobile connection.
 */
export const POINTS_MAX_DEFAULT = 2_000_000;

/** Largest cloud we are willing to hand a browser (bytes of `edgs-v1`). */
export const POINTS_FILE_BUDGET = 60 * 1024 * 1024;

/** Points fitting in `bytes` of the `edgs-v1` format (0 when nothing fits). */
export function pointsForBytes(bytes: number): number {
  if (!Number.isFinite(bytes) || bytes <= POINTS_HEADER_SIZE) return 0;
  return Math.max(0, Math.floor((bytes - POINTS_HEADER_SIZE) / POINTS_BYTES_PER_POINT));
}

/** Bytes of the `edgs-v1` file holding `count` points. */
export function bytesForPoints(count: number): number {
  return POINTS_HEADER_SIZE + Math.max(0, count) * POINTS_BYTES_PER_POINT;
}

/** Absolute ceiling implied by {@link POINTS_FILE_BUDGET}. */
export const POINTS_MAX_LIMIT = pointsForBytes(POINTS_FILE_BUDGET);

/**
 * `GALAXY_POINTS_MAX` overrides the cloud size; `0` disables sampling
 * (one point per system — do not do that on a 2×10⁸ catalog).
 * Values above {@link POINTS_MAX_LIMIT} are clamped, not rejected: a typo in
 * `.env` must not turn the map layer into a 600 МБ download.
 */
export function galaxyPointsMax(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.GALAXY_POINTS_MAX?.trim();
  if (!raw) return POINTS_MAX_DEFAULT;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return POINTS_MAX_DEFAULT;
  if (value === 0) return 0;
  return Math.min(POINTS_MAX_LIMIT, Math.floor(value));
}

/** Stride that keeps at most `max` points out of `total` rows (1 = keep all). */
export function pointSampleStride(total: number, max: number): number {
  if (!Number.isFinite(total) || total <= 0) return 1;
  if (!(max > 0) || total <= max) return 1;
  return Math.ceil(total / max);
}

export interface AllSystemsData {
  count: number;
  /** count * 3 float32, elite coords, point order = ORDER BY id. */
  positions: Float32Array;
  /** count uint8 star-class indices. */
  starTypes: Uint8Array;
  /** count uint32 id64 high parts. */
  id64Hi: Uint32Array;
  /** count uint32 id64 low parts. */
  id64Lo: Uint32Array;
}

export interface GalaxySystemPoint {
  x: number;
  y: number;
  z: number;
  /** Spansh id64 as a decimal string (fits unsigned 64-bit). */
  id64: string;
  starType: StarClass;
}

/**
 * Incremental builder: feed rows in `ORDER BY id` without holding them all.
 * Grows on demand.
 *
 * `maxPoints > 0` bounds memory for a full-galaxy catalog. The builder then
 * keeps a **uniform** sample instead of the first N systems (dump order
 * clusters, so "the first N" would light up one corner of the galaxy): rows are
 * accepted every `stride`-th, and when the buffer is full the stride doubles and
 * every second stored point is dropped. Halving an "every `stride`-th" sample
 * gives exactly an "every `2·stride`-th" one, so the sample stays uniform over
 * everything seen so far, at any size of the source table.
 *
 * Doubling only keeps up while the stream is unknown; it converges to
 * `stride ≈ seen/maxPoints`, i.e. to between a half and a full buffer of
 * points. When the caller already knows how many rows the table holds it passes
 * that `stride` to the constructor and feeds only the sampled rows
 * ({@link addSampled}) — then the cloud fills the buffer exactly and the
 * database skips the other rows itself (a `mod(id, stride)` read of 2·10⁸ rows
 * costs minutes, a full read of them costs an hour).
 */
export class PointsBuilder {
  private positions: Float32Array;
  private starTypes: Uint8Array;
  private id64Hi: Uint32Array;
  private id64Lo: Uint32Array;
  private count = 0;
  /** Source rows offered to the builder (stored or skipped). */
  private seen = 0;
  /** Every `stride`-th source row is stored. */
  private stride: number;
  /** Points the typed arrays can hold right now (grows to `maxPoints`). */
  private capacity: number;

  /** Point cap; 0 keeps one point per system. Not a parameter property: Node's
   *  type stripping (how the tests and the CLI load these modules) rejects them. */
  private readonly maxPoints: number;

  constructor(initialCapacity = 1_000_000, maxPoints = 0, stride = 1) {
    this.maxPoints = maxPoints;
    // The cap bounds the cloud; the allocation only has to be big enough for
    // what the caller expects and then grows. Sizing the buffer at
    // `initialCapacity` alone was the bug that made the admin log report
    // "969,102 точек" for a 2,000,000-point ceiling: the buffer overflowed and
    // thinned long before the catalog was exhausted.
    this.stride = Number.isFinite(stride) && stride > 1 ? Math.floor(stride) : 1;
    this.capacity = Math.max(1, Math.floor(maxPoints > 0 ? Math.min(initialCapacity, maxPoints) : initialCapacity));
    this.positions = new Float32Array(this.capacity * 3);
    this.starTypes = new Uint8Array(this.capacity);
    this.id64Hi = new Uint32Array(this.capacity);
    this.id64Lo = new Uint32Array(this.capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Source rows fed to the builder (with a sampled read: the table's rows). */
  get sourceRows(): number {
    return this.seen;
  }

  /**
   * Source rows per stored point (1 = no sampling).
   *
   * The honest ratio of what was read to what survived — never the internal
   * doubling counter, which on a 2·10⁸-row table would be reported as
   * "one point per 3.5e100 rows" (that was the old behaviour: the admin log
   * showed a float in exponential notation instead of a step).
   */
  get sampleStride(): number {
    if (this.count <= 0) return this.stride;
    return Math.max(1, Math.round(this.seen / this.count));
  }

  get sampled(): boolean {
    return this.seen > this.count;
  }

  /** Drop every second stored point; amortised O(n) over the whole stream. */
  private compact(): void {
    const keep = Math.ceil(this.count / 2);
    for (let i = 0; i < keep; i++) {
      const from = i * 2;
      if (from === i) continue;
      this.positions[i * 3] = this.positions[from * 3];
      this.positions[i * 3 + 1] = this.positions[from * 3 + 1];
      this.positions[i * 3 + 2] = this.positions[from * 3 + 2];
      this.starTypes[i] = this.starTypes[from];
      this.id64Hi[i] = this.id64Hi[from];
      this.id64Lo[i] = this.id64Lo[from];
    }
    this.count = keep;
    // Skipped rows and kept ones must stay in step, or the sample stops being
    // uniform (halving "every k-th row" is exactly "every 2k-th row").
    this.stride *= 2;
  }

  private resize(capacity: number): void {
    const next = Math.max(capacity, this.count + 1);
    const positions = new Float32Array(next * 3);
    positions.set(this.positions.subarray(0, this.count * 3));
    this.positions = positions;
    const starTypes = new Uint8Array(next);
    starTypes.set(this.starTypes.subarray(0, this.count));
    this.starTypes = starTypes;
    const hi = new Uint32Array(next);
    hi.set(this.id64Hi.subarray(0, this.count));
    this.id64Hi = hi;
    const lo = new Uint32Array(next);
    lo.set(this.id64Lo.subarray(0, this.count));
    this.id64Lo = lo;
    this.capacity = next;
  }

  /** Buffer full: grow towards the cap, thin only when the cap is reached. */
  private makeRoom(): void {
    if (this.maxPoints > 0 && this.capacity < this.maxPoints) {
      this.resize(Math.min(this.maxPoints, Math.max(this.capacity * 2, 1_000_000)));
      return;
    }
    if (this.maxPoints > 0) {
      this.compact();
      return;
    }
    this.resize(Math.max(this.capacity * 2, 1_000_000));
  }

  private store(row: GalaxySystemPoint): void {
    const i = this.count++;
    this.positions[i * 3] = row.x;
    this.positions[i * 3 + 1] = row.y;
    this.positions[i * 3 + 2] = row.z;
    this.starTypes[i] = STAR_CLASS_INDEX[row.starType] ?? STAR_CLASS_INDEX.unknown;
    let value: bigint;
    try {
      value = BigInt(row.id64);
    } catch {
      value = BigInt(0);
    }
    const U32_MASK = BigInt(4294967295);
    this.id64Hi[i] = Number((value >> BigInt(32)) & U32_MASK);
    this.id64Lo[i] = Number(value & U32_MASK);
  }

  /**
   * One row of the source table, in table order.
   *
   * @returns true when the row was stored (false = skipped by the sampling).
   */
  add(row: GalaxySystemPoint): boolean {
    const at = this.seen++;
    if (this.maxPoints > 0 && this.stride > 1 && at % this.stride !== 0) return false;
    if (this.count >= this.capacity) this.makeRoom();
    this.store(row);
    return true;
  }

  /**
   * One row of an already sampled read (the database applied the stride).
   * `seen` advances by the stride, so {@link sampleStride} and the row count
   * still describe the whole table, not the sample.
   */
  addSampled(row: GalaxySystemPoint): void {
    this.seen += this.stride;
    if (this.count >= this.capacity) this.makeRoom();
    this.store(row);
  }

  build(): ArrayBuffer {
    const buffer = new ArrayBuffer(POINTS_HEADER_SIZE + this.count * POINTS_BYTES_PER_POINT);
    const view = new DataView(buffer);
    const magic = new TextEncoder().encode(POINTS_MAGIC);
    view.setUint8(0, magic[0]);
    view.setUint8(1, magic[1]);
    view.setUint8(2, magic[2]);
    view.setUint8(3, magic[3]);
    view.setUint8(4, POINTS_VERSION);
    // bytes 5..7 reserved
    view.setUint32(8, this.count, true);
    const dst = new Uint8Array(buffer);
    dst.set(new Uint8Array(this.positions.buffer, 0, this.count * 12), POINTS_HEADER_SIZE);
    const hiOff = POINTS_HEADER_SIZE + this.count * 12;
    dst.set(new Uint8Array(this.id64Hi.buffer, 0, this.count * 4), hiOff);
    dst.set(new Uint8Array(this.id64Lo.buffer, 0, this.count * 4), hiOff + this.count * 4);
    dst.set(this.starTypes.subarray(0, this.count), hiOff + this.count * 8);
    return buffer;
  }
}

export function encodePointsFile(rows: GalaxySystemPoint[]): ArrayBuffer {
  const builder = new PointsBuilder(rows.length);
  for (const row of rows) builder.add(row);
  return builder.build();
}

export function parsePointsFile(buffer: ArrayBuffer): AllSystemsData {
  const view = new DataView(buffer);
  if (buffer.byteLength < POINTS_HEADER_SIZE) throw new Error('Points file too small');
  const magic = new TextDecoder().decode(new Uint8Array(buffer, 0, 4));
  if (magic !== POINTS_MAGIC) throw new Error(`Bad points magic: ${magic}`);
  const version = view.getUint8(4);
  if (version !== POINTS_VERSION) throw new Error(`Unsupported points version: ${version}`);
  const count = view.getUint32(8, true);
  const expected = POINTS_HEADER_SIZE + count * POINTS_BYTES_PER_POINT;
  if (buffer.byteLength < expected) throw new Error('Points file truncated');

  const hiOff = POINTS_HEADER_SIZE + count * 12;
  return {
    count,
    positions: new Float32Array(buffer, POINTS_HEADER_SIZE, count * 3),
    id64Hi: new Uint32Array(buffer, hiOff, count),
    id64Lo: new Uint32Array(buffer, hiOff + count * 4, count),
    starTypes: new Uint8Array(buffer, hiOff + count * 8, count),
  };
}

/**
 * Elite/Sol-centered positions → the map frame used by `eliteToThreeCentered`:
 * x' = x − Sgr A*.x, y' = y − Sgr A*.y, z' = −z + Sgr A*.z.
 * Kept here (not in ed3dCanon) so the point cloud does not pull in three.js.
 */
export function toMapPositions(elite: Float32Array, count: number): Float32Array {
  const out = new Float32Array(count * 3);
  const sx = SAGA_LY.x;
  const sy = SAGA_LY.y;
  const sz = SAGA_LY.z;
  const n = Math.min(count, Math.floor(elite.length / 3));
  for (let i = 0; i < n; i++) {
    out[i * 3] = elite[i * 3] - sx;
    out[i * 3 + 1] = elite[i * 3 + 1] - sy;
    out[i * 3 + 2] = -elite[i * 3 + 2] + sz;
  }
  return out;
}

/** Reconstruct the Spansh id64 (decimal string) from the packed halves. */
export function id64FromParts(hi: number, lo: number): string {
  return ((BigInt(hi) << BigInt(32)) | BigInt(lo >>> 0)).toString(10);
}
