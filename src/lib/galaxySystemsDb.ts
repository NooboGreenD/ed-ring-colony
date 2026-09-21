/**
 * Server-side queries over the `galaxy_systems` table (full Spansh dump).
 * Every function degrades gracefully to "no data" when the import has not
 * run yet, so callers keep their previous online (Spansh/EDSM) behaviour.
 */

import { supabaseAdmin } from './supabaseAdmin';
import {
  normalizeSystemName,
  type StarClass,
} from './galaxySystems';

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
    const v = data?.value as { systems_count?: number; imported_at?: string; source?: string } | null;
    if (v && typeof v.systems_count === 'number') {
      value = { systems_count: v.systems_count, imported_at: v.imported_at ?? null, source: v.source ?? null };
    }
  } catch {
    value = null;
  }
  statsCache = { at: Date.now(), value };
  return value;
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
  const escaped = key.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');

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

const WORLD_TYPE_TO_DB_FILTER: Record<string, string> = {
  neutron_star: 'star_type.eq.neutron',
  black_hole: 'star_type.eq.black_hole',
  white_dwarf: 'star_type.eq.white_dwarf',
  wolf_rayet: 'star_type.eq.wolf_rayet',
  herbig_ae_be: 'star_type.eq.herbig_ae_be',
  t_tauri: 'star_type.eq.t_tauri',
  carbon_star: 'star_type.eq.carbon',
  supergiant: 'star_giant_class.eq.supergiant',
  giant: 'star_giant_class.eq.giant',
};

/** Atlas star-candidate lookup: exotic/giant main stars inside an axis-aligned cube. */
export async function findStarCandidates(params: {
  x: number;
  y: number;
  z: number;
  half: number;
  worldTypes: string[];
  limit?: number;
}): Promise<GalaxySystemRow[]> {
  const filters = params.worldTypes
    .map((t) => WORLD_TYPE_TO_DB_FILTER[t])
    .filter(Boolean);
  if (filters.length === 0) return [];
  const limit = Math.min(params.limit ?? 1000, 1000);

  const { data, error } = await supabaseAdmin
    .from('galaxy_systems')
    .select(SELECT)
    .gte('x', params.x - params.half)
    .lte('x', params.x + params.half)
    .gte('y', params.y - params.half)
    .lte('y', params.y + params.half)
    .gte('z', params.z - params.half)
    .lte('z', params.z + params.half)
    .or(filters.join(','))
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data || []) as GalaxySystemRow[];
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
