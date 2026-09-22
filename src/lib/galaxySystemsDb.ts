/**
 * Server-side queries over the `galaxy_systems` table (full Spansh dump).
 * Every function degrades gracefully to "no data" when the import has not
 * run yet, so callers keep their previous online (Spansh/EDSM) behaviour.
 */

// Explicit `.ts` extensions: the galaxy import tests execute these modules
// directly with `node --test`, and ESM does not complete extensions itself.
import { supabaseAdmin } from './supabaseAdmin.ts';
import {
  normalizeSystemName,
  type StarClass,
} from './galaxySystems.ts';

export interface GalaxySystemRow {
  id: number;
  id64: string;
  name: string;
  x: number;
  y: number;
  z: number;
  main_star: string | null;
  star_type: StarClass;
  star_giant_class: 'dwarf' | 'giant' | 'supergiant' | null;
  needs_permit: boolean | null;
  distance_from_sols: number | null;
  distance_from_sgra: number | null;
}

const SELECT = 'id,id64,name,x,y,z,main_star,star_type,star_giant_class,needs_permit,distance_from_sols,distance_from_sgra';

let statsCache: { at: number; value: GalaxyStats | null } | null = null;

export interface GalaxyStats {
  systems_count: number;
  imported_at: string | null;
  source: string | null;
  points_uploaded?: boolean;
  points_bytes?: number | null;
  points_count?: number | null;
  /** True when the last import used --limit and must not replace live EDSM scans. */
  partial?: boolean;
}

/** A --limit import is a sample. Cube scans must not replace EDSM until the dump is complete. */
export const FULL_CATALOG_MIN = 1_000_000;

export function catalogIsComplete(stats: GalaxyStats | null | undefined): boolean {
  return !!stats && stats.partial !== true && stats.systems_count >= FULL_CATALOG_MIN;
}

/** Drop the cached stats — call right after an import wrote new ones. */
export function invalidateGalaxyStatsCache(): void {
  statsCache = null;
}

/** How many systems the import has loaded (5-minute in-memory cache). */
export async function getGalaxyStats(): Promise<GalaxyStats | null> {
  if (statsCache && Date.now() - statsCache.at < 5 * 60_000) return statsCache.value;
  let value: GalaxyStats | null = null;
  try {
    const { data } = await supabaseAdmin
      .from('galaxy_systems_meta')
      .select('value')
      .eq('key', 'stats')
      .maybeSingle();
    const v = data?.value as {
      systems_count?: number;
      imported_at?: string;
      source?: string;
      points_uploaded?: boolean;
      points_bytes?: number;
      points_count?: number;
      partial?: boolean;
    } | null;
    if (v && typeof v.systems_count === 'number') {
      value = {
        systems_count: v.systems_count,
        imported_at: v.imported_at ?? null,
        source: v.source ?? null,
        points_uploaded: v.points_uploaded === true,
        points_bytes: typeof v.points_bytes === 'number' ? v.points_bytes : null,
        points_count: typeof v.points_count === 'number' ? v.points_count : null,
        partial: v.partial === true,
      };
    }
  } catch {
    value = null;
  }
  statsCache = { at: Date.now(), value };
  return value;
}

/**
 * Record that a complete point cloud now lives in the `galaxy-data` bucket, so
 * every process prefers it over a local file or a fresh table scan. Merged into
 * the existing stats document: an import must not lose the catalog counters.
 */
export async function markPointsUploaded(points: { count: number; bytes: number }): Promise<void> {
  const { data } = await supabaseAdmin
    .from('galaxy_systems_meta')
    .select('value')
    .eq('key', 'stats')
    .maybeSingle();
  const raw = (data as { value?: unknown } | null)?.value;
  const previous = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const value = {
    ...previous,
    points_uploaded: true,
    points_count: points.count,
    points_bytes: points.bytes,
  };
  const { error } = await supabaseAdmin
    .from('galaxy_systems_meta')
    .upsert({ key: 'stats', value }, { onConflict: 'key' });
  if (error) throw new Error(error.message);
  invalidateGalaxyStatsCache();
}

export async function findSystemByName(name: string): Promise<GalaxySystemRow | null> {
  const key = normalizeSystemName(name);
  if (!key) return null;
  const { data, error } = await supabaseAdmin
    .from('galaxy_systems')
    .select(SELECT)
    .eq('name_lc', key)
    .maybeSingle();
  if (error) throw error;
  return (data as GalaxySystemRow | null) ?? null;
}

export async function systemById64(id64: string): Promise<GalaxySystemRow | null> {
  if (!/^\d{1,20}$/.test(id64)) return null;
  const { data, error } = await supabaseAdmin
    .from('galaxy_systems')
    .select(SELECT)
    .eq('id64', id64)
    .maybeSingle();
  if (error) throw error;
  return (data as GalaxySystemRow | null) ?? null;
}

/** Batched name lookup; returns rows keyed by normalized name. */
export async function findSystemsByNames(names: string[]): Promise<Map<string, GalaxySystemRow>> {
  const result = new Map<string, GalaxySystemRow>();
  const unique = Array.from(new Set(names.map(normalizeSystemName).filter(Boolean)));
  if (unique.length === 0) return result;
  const BATCH = 200;
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const { data, error } = await supabaseAdmin
      .from('galaxy_systems')
      .select(SELECT)
      .in('name_lc', chunk);
    if (error) throw error;
    for (const row of (data || []) as GalaxySystemRow[]) result.set(normalizeSystemName(row.name), row);
  }
  return result;
}

/**
 * Autocomplete: exact match first, then prefix, then substring.
 * Returns up to `limit` candidates, best first.
 */
export async function searchSystems(q: string, limit = 8): Promise<GalaxySystemRow[]> {
  const key = normalizeSystemName(q);
  if (!key) return [];
  // `%`, `_` and `*` are LIKE wildcards (PostgREST also treats `*` as `%`).
  // System names do not contain them; stripping is safer than a backslash
  // escape that PostgREST does not honour.
  const escaped = key.replace(/[%_*]/g, '');
  if (!escaped) return [];

  const exact = await supabaseAdmin
    .from('galaxy_systems').select(SELECT).eq('name_lc', key).limit(1);
  if (exact.error) throw exact.error;
  if (exact.data && exact.data.length > 0) return exact.data as GalaxySystemRow[];

  const prefix = await supabaseAdmin
    .from('galaxy_systems').select(SELECT).like('name_lc', `${escaped}%`).limit(limit);
  if (prefix.error) throw prefix.error;
  const rows = (prefix.data || []) as GalaxySystemRow[];
  if (rows.length >= limit) return rows;

  const substring = await supabaseAdmin
    .from('galaxy_systems').select(SELECT).like('name_lc', `%${escaped}%`).limit(limit);
  if (substring.error) throw substring.error;
  const extra = ((substring.data || []) as GalaxySystemRow[])
    .filter((r) => !rows.some((r2) => r2.id === r.id));
  return [...rows, ...extra].slice(0, limit);
}

const STAR_TYPE_BY_WORLD: Record<string, string> = {
  neutron_star: 'neutron',
  black_hole: 'black_hole',
  white_dwarf: 'white_dwarf',
  wolf_rayet: 'wolf_rayet',
  herbig_ae_be: 'herbig_ae_be',
  t_tauri: 't_tauri',
  carbon_star: 'carbon',
};

function splitWorldFilters(worldTypes: string[]): { starTypes: string[]; giantClasses: string[] } {
  const starTypes: string[] = [];
  const giantClasses: string[] = [];
  for (const worldType of worldTypes) {
    if (worldType === 'supergiant' || worldType === 'giant') giantClasses.push(worldType);
    else if (STAR_TYPE_BY_WORLD[worldType]) starTypes.push(STAR_TYPE_BY_WORLD[worldType]);
  }
  return { starTypes, giantClasses };
}

/**
 * Atlas star-candidate lookup: exotic/giant main stars inside an axis-aligned
 * cube, nearest first. Throws when the SQL function is missing so the caller
 * can fall back to EDSM instead of treating an unordered row cap as complete.
 */
export async function findStarCandidates(params: {
  x: number;
  y: number;
  z: number;
  half: number;
  worldTypes: string[];
  limit?: number;
}): Promise<GalaxySystemRow[]> {
  const { starTypes, giantClasses } = splitWorldFilters(params.worldTypes);
  if (starTypes.length === 0 && giantClasses.length === 0) return [];
  const limit = Math.min(params.limit ?? 2000, 2000);

  const rpc = await supabaseAdmin.rpc('galaxy_star_candidates', {
    cx: params.x,
    cy: params.y,
    cz: params.z,
    half: params.half,
    star_types: starTypes,
    giant_classes: giantClasses,
    lim: limit,
  });
  if (rpc.error) throw new Error(rpc.error.message);
  if (!Array.isArray(rpc.data)) return [];
  return rpc.data as GalaxySystemRow[];
}

/** Systems inside a cube, nearest first. Empty when the catalog or function is missing. */
export async function findSystemsInCube(params: {
  x: number;
  y: number;
  z: number;
  half: number;
  limit?: number;
}): Promise<Array<{ name: string; x: number; y: number; z: number }>> {
  const limit = Math.min(params.limit ?? 800, 2000);
  const rpc = await supabaseAdmin.rpc('galaxy_systems_near', {
    cx: params.x,
    cy: params.y,
    cz: params.z,
    half: params.half,
    lim: limit,
  });
  if (rpc.error) throw new Error(rpc.error.message);
  if (!Array.isArray(rpc.data)) return [];
  return (rpc.data as Array<{ name: string; x: number; y: number; z: number }>).map((row) => ({
    name: row.name,
    x: Number(row.x),
    y: Number(row.y),
    z: Number(row.z),
  }));
}

/**
 * World type a stored system matches, given the requested set.
 * Mirrors classifyStar() so star candidates get the right atlas category.
 */
export function rowWorldType(row: GalaxySystemRow, requested: string[]): string | null {
  const cls =
    row.star_type === 'neutron' ? 'neutron_star'
    : row.star_type === 'black_hole' ? 'black_hole'
    : row.star_type === 'white_dwarf' ? 'white_dwarf'
    : row.star_type === 'wolf_rayet' ? 'wolf_rayet'
    : row.star_type === 'herbig_ae_be' ? 'herbig_ae_be'
    : row.star_type === 't_tauri' ? 't_tauri'
    : row.star_type === 'carbon' ? 'carbon_star'
    : row.star_giant_class === 'supergiant' ? 'supergiant'
    : row.star_giant_class === 'giant' ? 'giant'
    : null;
  return cls && requested.includes(cls) ? cls : null;
}
