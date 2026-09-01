import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { spanshBodiesSearch, spanshSearch, mapSpanshSubtypeToWorldType, isTerraformable } from '@/lib/spanshClient';
import type { WorldType, AtlasSearchParams } from '@/types/atlas';
import { atlasSearchSchema } from '@/lib/zodSchemas';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
const WORLD_TYPE_TO_SPANSH_FILTER: Record<WorldType, { subtype?: string; type?: string; is_terraformable?: boolean }> = {
  earth_like: { subtype: 'Earth-like world' },
  water_world: { subtype: 'Water world' },
  ammonia: { subtype: 'Ammonia world' },
  terraformable: { is_terraformable: true },
  neutron_star: { subtype: 'Neutron Star' },
  black_hole: { subtype: 'Black Hole' },
  white_dwarf: { subtype: 'White Dwarf' },
  wolf_rayet: { subtype: 'Wolf-Rayet' },
  herbig_ae_be: { subtype: 'Herbig Ae/Be Star' },
  t_tauri: { subtype: 'T Tauri Star' },
  proto_star: { subtype: 'Proto Star' },
  carbon_star: { subtype: 'Carbon Star' },
  supergiant: { subtype: 'Supergiant' },
  giant: { subtype: 'Giant' },
  rocky_atmosphere: { type: 'Planet' },
  rocky_bio: { type: 'Planet' },
};

const EDSM_STAR_TYPE_MAP: Record<string, WorldType[]> = {
  'N': ['neutron_star'], 'H': ['black_hole'], 'D': ['white_dwarf'],
  'W': ['wolf_rayet'], 'WN': ['wolf_rayet'], 'WC': ['wolf_rayet'], 'WO': ['wolf_rayet'],
  'C': ['carbon_star'], 'C-N': ['carbon_star'], 'C-J': ['carbon_star'], 'C-H': ['carbon_star'], 'C-Hd': ['carbon_star'],
  'S': ['supergiant'], 'A_BlueWhiteSuperGiant': ['supergiant'], 'F_WhiteSuperGiant': ['supergiant'], 'G_WhiteSuperGiant': ['supergiant'],
  'K_OrangeGiant': ['giant'], 'M_RedGiant': ['giant'],
};

function mapEdsmStarType(type: string): WorldType | null {
  for (const [prefix, types] of Object.entries(EDSM_STAR_TYPE_MAP)) {
    if (type.startsWith(prefix) || type.includes(prefix)) return types[0];
  }
  return null;
}

async function resolveEdsmCoordinates(names: string[]): Promise<Record<string, { x: number; y: number; z: number }>> {
  const results: Record<string, { x: number; y: number; z: number }> = {};
  const BATCH = 25;
  for (let i = 0; i < names.length; i += BATCH) {
    const batch = names.slice(i, i + BATCH);
    const params = new URLSearchParams();
    params.append('showCoordinates', '1');
    for (const n of batch) params.append('systemName[]', n);
    try {
      const res = await fetch('https://www.edsm.net/api-v1/systems?' + params.toString(), {
        headers: { Accept: 'application/json' },
        next: { revalidate: 86400 },
      });
      const data = await res.json();
      for (const item of data || []) {
        if (item?.name && item.coords) results[item.name] = { x: item.coords.x, y: item.coords.y, z: item.coords.z };
      }
    } catch (e: any) {
      console.error('[Atlas Search] EDSM batch error:', e.message);
    }
  }
  return results;
}

async function edsmSphereSystems(refSystem: string, radius: number) {
  const params = new URLSearchParams();
  params.append('systemName', refSystem);
  params.append('radius', String(Math.min(radius, 100)));
  params.append('showCoordinates', '1');
  params.append('showPrimaryStar', '1');
  try {
    const res = await fetch('https://www.edsm.net/api-v1/sphere-systems?' + params.toString(), {
      headers: { Accept: 'application/json' },
      next: { revalidate: 86400 },
    });
    const data = await res.json();
    return (data || []).filter((s: any) => s?.name && s.coords).map((s: any) => ({
      name: s.name, x: s.coords.x, y: s.coords.y, z: s.coords.z, primaryStar: s.primaryStar,
    }));
  } catch (e: any) {
    console.error('[Atlas Search] EDSM sphere error:', e.message);
    return [];
  }
}

function extractSystemName(bodyName: string): string {
  const parts = bodyName.split(' ');
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    if (/^[0-9A-Za-z]+$/.test(last) && !['A','B','C','D','E','F','G','H'].includes(last)) {
      return parts.slice(0, -1).join(' ');
    }
  }
  return bodyName;
}

export async function POST(req: Request) {
  // Rate limiting
  const ip = req.headers.get('x-forwarded-for') || 'unknown';
  if (!checkRateLimit(ip, 5)) {
    return NextResponse.json({ error: 'Rate limit exceeded' }, { status: 429 });
  }

  const body = await req.json();
  const parse = atlasSearchSchema.safeParse(body);
  if (!parse.success) {
    return NextResponse.json({ error: 'Invalid parameters', details: parse.error.flatten() }, { status: 400 });
  }

  const params = parse.data;
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  let refCoords: { x: number; y: number; z: number } | null = null;
  try {
    const nearest = await spanshSearch({ q: params.reference_system, limit: 1 });
    if (nearest.results?.length > 0 && nearest.results[0].record?.x != null) {
      const sys = nearest.results[0].record;
      refCoords = { x: sys.x!, y: sys.y!, z: sys.z! };
    }
  } catch (err: any) {
    console.error('[Atlas Search] Spansh search error:', err.message);
  }

  if (!refCoords) {
    return NextResponse.json({ error: 'Reference system not found' }, { status: 404 });
  }

  const { data: session, error: sessionError } = await supabaseAdmin
    .from('atlas_searches')
    .insert({
      reference_system: params.reference_system,
      reference_x: refCoords.x, reference_y: refCoords.y, reference_z: refCoords.z,
      cube_size_ly: params.cube_size_ly,
      world_types: params.world_types,
      extra_filters: {
        require_landable: params.require_landable,
        min_value: params.min_estimated_value,
        max_distance_to_arrival: params.max_distance_to_arrival,
      },
      created_by: user?.id || null,
      status: 'pending',
    })
    .select()
    .single();

  if (sessionError || !session) {
    return NextResponse.json({ error: sessionError?.message || 'Failed to create session' }, { status: 500 });
  }

  processSearchAsync(session.id, params as AtlasSearchParams, refCoords).catch(console.error);

  return NextResponse.json({
    session_id: session.id,
    status: 'pending',
    message: 'Search queued. Poll GET /api/atlas/search?session_id=' + session.id,
  });
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const sessionId = searchParams.get('session_id');
  if (!sessionId) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const supabase = await createClient();
  const { data: session } = await supabase
    .from('atlas_searches')
    .select('*')
    .eq('id', sessionId)
    .single();

  if (!session) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  let candidates: any[] = [];
  if (session.status === 'completed') {
    const { data } = await supabase
      .from('atlas_candidates')
      .select('*')
      .eq('search_id', sessionId)
      .order('distance_from_ref', { ascending: true })
      .limit(500);
    candidates = data || [];
  }

  return NextResponse.json({
    session,
    candidates: candidates.slice(0, 200),
    total_candidates: session.total_found || candidates.length,
  });
}

async function processSearchAsync(sessionId: string, params: AtlasSearchParams, refCoords: { x: number; y: number; z: number }) {
  await supabaseAdmin.from('atlas_searches').update({ status: 'running' }).eq('id', sessionId);

  try {
    const candidates: any[] = [];
    const seenSystems = new Set<string>();
    const halfCube = params.cube_size_ly / 2;

    const starTypes = params.world_types.filter(t => ['neutron_star','black_hole','white_dwarf','wolf_rayet','carbon_star','supergiant','giant'].includes(t));
    const planetTypes = params.world_types.filter(t => ['earth_like','water_world','ammonia','terraformable'].includes(t));
    const rockyTypes = params.world_types.filter(t => ['rocky_atmosphere','rocky_bio'].includes(t));

    if (starTypes.length > 0) {
      const systems = await edsmSphereSystems(params.reference_system, halfCube);
      for (const sys of systems) {
        const dist = Math.sqrt((sys.x - refCoords.x)**2 + (sys.y - refCoords.y)**2 + (sys.z - refCoords.z)**2);
        if (dist > halfCube) continue;
        const wt = mapEdsmStarType(sys.primaryStar?.type || '');
        if (!wt || !starTypes.includes(wt)) continue;
        const key = `${sys.name}|${wt}`;
        if (seenSystems.has(key)) continue;
        seenSystems.add(key);
        candidates.push({ id: crypto.randomUUID(), search_id: sessionId, system_name: sys.name, x: sys.x, y: sys.y, z: sys.z, world_type: wt, body_name: sys.name, distance_from_ref: dist, distance_to_arrival: 0, estimated_value: 0, is_main_star: true, metadata: { primaryStarType: sys.primaryStar?.type }, created_at: new Date().toISOString() });
      }
    }

    if (planetTypes.length > 0) {
      for (const worldType of planetTypes) {
        const mapping = WORLD_TYPE_TO_SPANSH_FILTER[worldType];
        if (!mapping) continue;
        const filters: Record<string, unknown> = {};
        if (mapping.subtype) filters.subtype = { value: mapping.subtype };
        if (mapping.is_terraformable) filters.is_terraformable = { value: true };
        if (params.require_landable) filters.is_landable = { value: true };
        if (params.min_estimated_value && params.min_estimated_value > 0) filters.estimated_scan_value = { value: { comparison: '>=', value: params.min_estimated_value } };
        if (params.max_distance_to_arrival && params.max_distance_to_arrival > 0) filters.distance_to_arrival = { value: { comparison: '<=', value: params.max_distance_to_arrival } };

        try {
          const searchResult = await spanshBodiesSearch({ referenceSystem: params.reference_system, filters, sort: [{ distance: { direction: 'asc' } }], size: 2000 });
          const sysNames = new Set<string>();
          for (const b of searchResult.results) sysNames.add(extractSystemName(b.name));
          const coords = await resolveEdsmCoordinates([...sysNames]);

          for (const b of searchResult.results) {
            const sysName = extractSystemName(b.name);
            const coord = coords[sysName];
            if (!coord) continue;
            const dist = Math.sqrt((coord.x - refCoords.x)**2 + (coord.y - refCoords.y)**2 + (coord.z - refCoords.z)**2);
            if (dist > halfCube) continue;
            let wt = mapSpanshSubtypeToWorldType(b.subtype || b.type || '');
            if (!wt && isTerraformable(b)) wt = 'terraformable';
            if (!wt) wt = worldType;
            const key = `${sysName}|${wt}`;
            if (seenSystems.has(key)) continue;
            seenSystems.add(key);
            candidates.push({ id: crypto.randomUUID(), search_id: sessionId, system_name: sysName, x: coord.x, y: coord.y, z: coord.z, world_type: wt, body_name: b.name, distance_from_ref: dist, distance_to_arrival: b.distance_to_arrival, estimated_value: b.estimated_scan_value || b.estimated_mapping_value, is_main_star: b.is_main_star || false, metadata: { subtype: b.subtype, type: b.type, gravity: b.gravity, temperature: b.temperature, atmosphere: b.atmosphere, volcanism: b.volcanism, materials: b.materials, rings: b.rings }, created_at: new Date().toISOString() });
          }
        } catch (err: any) {
          console.error(`[Atlas Search] Spansh error for ${worldType}:`, err.message);
        }
      }
    }

    if (rockyTypes.length > 0) {
      const spanshFilters: Record<string, unknown> = {
        type: { value: 'Planet' },
        subtype: { value: ['Rocky body', 'High metal content world', 'Metal-rich body', 'Rocky ice world'] },
      };
      if (params.require_landable) spanshFilters.is_landable = { value: true };
      if (params.min_estimated_value && params.min_estimated_value > 0) spanshFilters.estimated_scan_value = { value: { comparison: '>=', value: params.min_estimated_value } };
      if (params.max_distance_to_arrival && params.max_distance_to_arrival > 0) spanshFilters.distance_to_arrival = { value: { comparison: '<=', value: params.max_distance_to_arrival } };

      try {
        const searchResult = await spanshBodiesSearch({ referenceSystem: params.reference_system, filters: spanshFilters, sort: [{ distance: { direction: 'asc' } }], size: 2000 });
        const sysNames = new Set<string>();
        for (const b of searchResult.results) sysNames.add(extractSystemName(b.name));
        const coords = await resolveEdsmCoordinates([...sysNames]);

        for (const b of searchResult.results) {
          const sysName = extractSystemName(b.name);
          const coord = coords[sysName];
          if (!coord) continue;
          const dist = Math.sqrt((coord.x - refCoords.x)**2 + (coord.y - refCoords.y)**2 + (coord.z - refCoords.z)**2);
          if (dist > halfCube) continue;
          const hasAtm = !!b.atmosphere && b.atmosphere !== 'No atmosphere';
          const hasBio = b.landmarks?.some((l: string) => l.includes('Biological')) || false;
          let wt: WorldType | null = null;
          if (rockyTypes.includes('rocky_atmosphere') && hasAtm) wt = 'rocky_atmosphere';
          else if (rockyTypes.includes('rocky_bio') && hasBio) wt = 'rocky_bio';
          if (!wt) continue;
          const key = `${sysName}|${wt}`;
          if (seenSystems.has(key)) continue;
          seenSystems.add(key);
          candidates.push({ id: crypto.randomUUID(), search_id: sessionId, system_name: sysName, x: coord.x, y: coord.y, z: coord.z, world_type: wt, body_name: b.name, distance_from_ref: dist, distance_to_arrival: b.distance_to_arrival, estimated_value: b.estimated_scan_value || b.estimated_mapping_value, is_main_star: false, metadata: { subtype: b.subtype, type: b.type, atmosphere: b.atmosphere, landmarks: b.landmarks, gravity: b.gravity, temperature: b.temperature, materials: b.materials }, created_at: new Date().toISOString() });
        }
      } catch (err: any) {
        console.error('[Atlas Search] Spansh rocky error:', err.message);
      }
    }

    if (candidates.length > 0) {
      const { error: insertError } = await supabaseAdmin.from('atlas_candidates').insert(
        candidates.map(c => ({ search_id: c.search_id, system_name: c.system_name, x: c.x, y: c.y, z: c.z, world_type: c.world_type, body_name: c.body_name, distance_from_ref: c.distance_from_ref, distance_to_arrival: c.distance_to_arrival, estimated_value: c.estimated_value, is_main_star: c.is_main_star, metadata: c.metadata }))
      );
      if (insertError) console.error('[Atlas Search] Insert error:', insertError);
    }

    await supabaseAdmin.from('atlas_searches').update({ status: 'completed', completed_at: new Date().toISOString(), total_found: candidates.length }).eq('id', sessionId);
  } catch (err: any) {
    await supabaseAdmin.from('atlas_searches').update({ status: 'failed', error_message: err.message }).eq('id', sessionId);
  }
}
