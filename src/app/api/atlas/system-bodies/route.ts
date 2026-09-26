import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { signalsFromRecord, signalsToColumns } from '@/lib/bodySignals';

export const dynamic = 'force-dynamic';

const EDSM_FETCH_TIMEOUT = 8000;

async function fetchEdsmBodies(systemName: string): Promise<any[] | null> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), EDSM_FETCH_TIMEOUT);
  try {
    const url = `https://www.edsm.net/api-system-v1/bodies?systemName=${encodeURIComponent(systemName)}`;
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json();
    return Array.isArray(data?.bodies) ? data.bodies : null;
  } catch (err: any) {
    console.error(`[system-bodies] EDSM fetch error for ${systemName}:`, err.message);
    return null;
  } finally {
    clearTimeout(id);
  }
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const system = (searchParams.get('system') || searchParams.get('name') || '').trim();
    const forceRefresh = searchParams.get('refresh') === '1';

    if (!system) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }

    // 1. Поиск в БД проекта
    if (!forceRefresh) {
      const { data: dbBodies, error: dbError } = await supabaseAdmin
        .from('system_scans')
        .select('*')
        .ilike('system_name', system)
        .order('distance_ls', { ascending: true });

      if (!dbError && dbBodies && dbBodies.length > 0) {
        return NextResponse.json({
          ok: true,
          system,
          count: dbBodies.length,
          source: 'database',
          bodies: dbBodies,
        });
      }
    }

    // 2. Если в БД нет данных, запрашиваем EDSM
    const edsmBodies = await fetchEdsmBodies(system);
    if (!edsmBodies || edsmBodies.length === 0) {
      return NextResponse.json({
        ok: true,
        system,
        count: 0,
        source: 'none',
        bodies: [],
      });
    }

    // 3. Форматируем и сохраняем тела из EDSM в базу данных проекта
    const rowsToInsert = edsmBodies.map((b: any) => ({
      system_name: system,
      body_name: b.name || `${system} Body`,
      body_id: b.bodyId ?? null,
      body_type: b.type || (b.subType?.toLowerCase().includes('star') ? 'Star' : 'Planet'),
      sub_type: b.subType || null,
      distance_ls: typeof b.distanceToArrival === 'number' ? b.distanceToArrival : 0,
      parents: Array.isArray(b.parents) ? b.parents : [],
      radius_m: typeof b.radius === 'number' ? b.radius * 1000 : (typeof b.solarRadius === 'number' ? b.solarRadius * 6.957e8 : 0),
      gravity: typeof b.gravity === 'number' ? b.gravity : 0,
      earth_masses: typeof b.earthMasses === 'number' ? b.earthMasses : (typeof b.solarMasses === 'number' ? b.solarMasses * 333000 : 0),
      surface_temp_k: typeof b.surfaceTemperature === 'number' ? b.surfaceTemperature : 0,
      surface_pressure: typeof b.surfacePressure === 'number' ? b.surfacePressure : 0,
      volcanism: b.volcanismType || null,
      atmosphere: b.atmosphereType || null,
      atmosphere_type: b.atmosphereType || null,
      atmosphere_composition: Array.isArray(b.atmosphereComposition) ? b.atmosphereComposition : [],
      solid_composition: b.solidComposition && typeof b.solidComposition === 'object' ? b.solidComposition : {},
      materials: b.materials && typeof b.materials === 'object' ? b.materials : {},
      rings: Array.isArray(b.rings) ? b.rings : [],
      is_landable: !!b.isLandable,
      // EDSM сигналы тел не отдаёт: они появляются только из журнала игрока
      // (FSSBodySignals/SAASignalsFound), поэтому здесь честные нули.
      bio_signals_count: 0,
      geo_signals_count: 0,
      human_signals_count: 0,
      thargoid_signals_count: 0,
      guardian_signals_count: 0,
      other_signals_count: 0,
      signals: [],
      bio_genuses: [],
      first_discovered_by: b.discovery?.commander || null,
      first_mapped_by: null,
      first_footfall_by: null,
      scanned_by_cmdr: null,
      source: 'edsm',
      raw_data: b,
      updated_at: new Date().toISOString(),
    }));

    // Фоновая запись в базу данных (не блокируя ответ при сбоях)
    try {
      await supabaseAdmin.from('system_scans').upsert(rowsToInsert, {
        onConflict: 'system_name,body_name',
      });
    } catch (saveErr: any) {
      console.warn('[system-bodies] Failed caching EDSM bodies into DB:', saveErr.message);
    }

    return NextResponse.json({
      ok: true,
      system,
      count: rowsToInsert.length,
      source: 'edsm',
      bodies: rowsToInsert,
    });
  } catch (err: any) {
    console.error('[system-bodies] GET error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    let body: any = {};
    try {
      body = await req.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
    }

    const systemName = (body.system || body.system_name || '').trim();
    const bodies = Array.isArray(body.bodies) ? body.bodies : [];
    const cmdr = (body.cmdr || body.commander || '').trim() || null;

    if (!systemName) {
      return NextResponse.json({ error: 'system parameter is required' }, { status: 400 });
    }
    if (bodies.length === 0) {
      return NextResponse.json({ ok: true, saved: 0, system: systemName });
    }

    const rows = bodies.slice(0, 500).map((b: any) => ({
      system_name: systemName,
      body_name: (b.body_name || b.name || `${systemName} Body`).trim(),
      body_id: typeof b.body_id === 'number' ? b.body_id : (typeof b.bodyId === 'number' ? b.bodyId : null),
      body_type: b.body_type || b.type || null,
      sub_type: b.sub_type || b.subType || b.planet_class || b.star_type || null,
      distance_ls: typeof b.distance_ls === 'number' ? b.distance_ls : (typeof b.distanceToArrival === 'number' ? b.distanceToArrival : 0),
      parents: Array.isArray(b.parents) ? b.parents : [],
      radius_m: typeof b.radius_m === 'number' ? b.radius_m : (typeof b.radius === 'number' ? b.radius : 0),
      gravity: typeof b.gravity === 'number' ? b.gravity : 0,
      earth_masses: typeof b.earth_masses === 'number' ? b.earth_masses : 0,
      surface_temp_k: typeof b.surface_temp_k === 'number' ? b.surface_temp_k : (typeof b.surfaceTemperature === 'number' ? b.surfaceTemperature : 0),
      surface_pressure: typeof b.surface_pressure === 'number' ? b.surface_pressure : (typeof b.surfacePressure === 'number' ? b.surfacePressure : 0),
      volcanism: b.volcanism || null,
      atmosphere: b.atmosphere || null,
      atmosphere_type: b.atmosphere_type || b.atmosphereType || null,
      atmosphere_composition: Array.isArray(b.atmosphere_composition) ? b.atmosphere_composition : [],
      solid_composition: b.solid_composition || {},
      materials: b.materials || {},
      rings: Array.isArray(b.rings) ? b.rings : [],
      is_landable: !!(b.is_landable || b.landable || b.isLandable),
      // Сигналы тела: биология, геология, следы людей, стражи и таргоиды.
      // Помощник присылает либо готовые счётчики, либо сырой список
      // `signals` из события журнала — разбираем оба вида.
      ...signalsToColumns(signalsFromRecord(b)),
      signals: Array.isArray(b.signals) ? b.signals.slice(0, 32) : [],
      first_discovered_by: b.first_discovered_by || null,
      first_mapped_by: b.first_mapped_by || null,
      first_footfall_by: b.first_footfall_by || null,
      scanned_by_cmdr: cmdr,
      source: b.source || 'helper',
      raw_data: b.raw_data || b,
      updated_at: new Date().toISOString(),
    }));

    const { error: upsertError } = await supabaseAdmin
      .from('system_scans')
      .upsert(rows, { onConflict: 'system_name,body_name' });

    if (upsertError) {
      console.error('[system-bodies] POST upsert error:', upsertError.message);
      return NextResponse.json({ error: upsertError.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, saved: rows.length, system: systemName });
  } catch (err: any) {
    console.error('[system-bodies] POST error:', err);
    return NextResponse.json({ error: err.message || 'Internal server error' }, { status: 500 });
  }
}
