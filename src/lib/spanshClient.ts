import type { SpanshBodiesSearchResult, SpanshSystem } from '@/types/atlas';

const SPANSH_BASE = 'https://spansh.co.uk/api';

export interface SpanshSearchOptions { q: string; limit?: number; }
export interface SpanshBodiesSearchOptions {
  referenceSystem?: string;
  filters?: Record<string, unknown>;
  sort?: Array<Record<string, { direction: string }>>;
  size?: number;
  page?: number;
}
export interface SpanshNearestOptions { x: number; y: number; z: number; }

export async function spanshSearch(options: SpanshSearchOptions) {
  const url = new URL(`${SPANSH_BASE}/search`);
  url.searchParams.set('q', options.q);
  if (options.limit) url.searchParams.set('limit', String(options.limit));
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, next: { revalidate: 3600 } });
  if (!res.ok) throw new Error(`Spansh search error: ${res.status}`);
  return res.json();
}

export async function spanshNearest(coords: SpanshNearestOptions): Promise<SpanshSystem> {
  const url = new URL(`${SPANSH_BASE}/nearest`);
  url.searchParams.set('x', String(coords.x));
  url.searchParams.set('y', String(coords.y));
  url.searchParams.set('z', String(coords.z));
  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' }, next: { revalidate: 86400 } });
  if (!res.ok) throw new Error(`Spansh nearest error: ${res.status}`);
  const data = await res.json();
  return data.system;
}

export async function spanshBodiesSearch(options: SpanshBodiesSearchOptions): Promise<SpanshBodiesSearchResult> {
  const payload: Record<string, unknown> = {
    filters: options.filters || {},
    sort: options.sort || [{ distance: { direction: 'asc' } }],
    size: Math.min(options.size || 100, 5000),
    page: options.page || 0,
  };

  if (options.referenceSystem) {
    payload.reference_system = options.referenceSystem;
  }

  const res = await fetch(`${SPANSH_BASE}/bodies/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Spansh bodies search error: ${res.status} ${text.slice(0, 200)}`);
  }

  return res.json();
}

const SPANSH_TO_WORLD_TYPE: Record<string, string> = {
  'Earth-like world': 'earth_like',
  'Water world': 'water_world',
  'Ammonia world': 'ammonia',
  'Neutron Star': 'neutron_star',
  'Black Hole': 'black_hole',
  'White Dwarf': 'white_dwarf',
  'Wolf-Rayet': 'wolf_rayet',
  'Herbig Ae/Be Star': 'herbig_ae_be',
  'T Tauri Star': 't_tauri',
  'Proto Star': 'proto_star',
  'Carbon Star': 'carbon_star',
  'Supergiant': 'supergiant',
  'Giant': 'giant',
};

export function mapSpanshSubtypeToWorldType(subtype: string): string | null {
  return SPANSH_TO_WORLD_TYPE[subtype] || null;
}

export function isTerraformable(body: { is_terraformable?: boolean; subtype?: string }): boolean {
  if (body.is_terraformable) return true;
  return ['High metal content world','Rocky body','Rocky ice world','Icy body','Metal-rich body'].includes(body.subtype || '');
}
