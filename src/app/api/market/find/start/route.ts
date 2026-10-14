import { marketError } from '@/lib/marketUpstream';
import { constructionCommodities } from '@/lib/constructionBlueprints';
import { resolveCommodity } from '@/lib/commodities';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { saveCachedSystems } from '@/lib/atlasSystemCache';
import { discoverMarketSystems, resolveRefCoords } from '@/lib/marketDiscovery';
import { knownMarketSystems } from '@/lib/stationCommerce';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return NextResponse.json({error:'Некорректные параметры поиска'}, {status:400});
    }
    const ref_system =
      typeof body.ref_system === 'string' ? body.ref_system.trim() : '';
    const radius = body.radius ?? 150;
    const mode = body.mode ?? 'single';
    const commodity = resolveCommodity(
      typeof body.commodity === 'string' ? body.commodity : ''
    );
    const build_type =
      typeof body.build_type === 'string' ? body.build_type : 'all';
    if (
      !Number.isInteger(radius) ||
      radius < 10 ||
      radius > 500 ||
      !['single', 'build'].includes(mode) ||
      (mode === 'single' && !commodity) ||
      (mode === 'build' && !constructionCommodities(build_type).length)
    ) {
      return NextResponse.json(
        {
          error:
            'Укажите корректный товар/тип стройплощадки и радиус 10–500 св.л.',
        },
        { status: 400 }
      );
    }
    const deadline = Date.now() + 45_000;
    if (!ref_system || ref_system.length > 200) {
      return NextResponse.json(
        { error: 'ref_system is required' },
        { status: 400 }
      );
    }

    const svc = createServiceClient();
    const refCoords = await resolveRefCoords(ref_system, deadline);
    let rawSystems: Array<{ name: string; coords?: { x: number; y: number; z: number }; distance?: number }> = [];
    let source = 'populated-db';
    if (refCoords) {
      try {
        rawSystems = await knownMarketSystems(svc, refCoords, radius);
      } catch (error) {
        console.warn('[Market Start] commerce index unavailable:', error);
      }
    }
    const discoveryComplete = rawSystems.length === 0;
    if (discoveryComplete) {
      const discovery = await discoverMarketSystems(ref_system, radius, refCoords, deadline);
      rawSystems = discovery.systems;
      source = discovery.source;
    }

    if (rawSystems.length === 0) {
      return NextResponse.json(
        { error: `No systems found near ${ref_system} within ${radius} ly` },
        { status: 404 }
      );
    }

    // Keep only real, positioned systems and collapse EDSM aliases before a
    // job is stored. Otherwise a duplicate coordinate can later become two
    // interactive markers at one point in the galaxy map.
    const systemsByName = new Map<
      string,
      { name: string; distance: number; x: number; y: number; z: number }
    >();
    for (const rawSystem of rawSystems) {
      const name = String(rawSystem.name || '')
        .trim()
        .replace(/\s+/g, ' ');
      const x = Number(rawSystem.coords?.x);
      const y = Number(rawSystem.coords?.y);
      const z = Number(rawSystem.coords?.z);
      if (
        !name ||
        !Number.isFinite(x) ||
        !Number.isFinite(y) ||
        !Number.isFinite(z)
      )
        continue;
      const positioned = {
        name,
        distance: Number.isFinite(Number(rawSystem.distance))
          ? Number(rawSystem.distance)
          : 0,
        x,
        y,
        z,
      };
      const key = name.toLowerCase();
      const existing = systemsByName.get(key);
      if (!existing || positioned.distance < existing.distance)
        systemsByName.set(key, positioned);
    }
    const inSphere = Array.from(systemsByName.values()).sort(
      (left, right) => left.distance - right.distance
    );

    if (inSphere.length === 0) {
      return NextResponse.json(
        {
          error: `No positioned systems found near ${ref_system} within ${radius} ly`,
        },
        { status: 404 }
      );
    }

    // Список систем — в кэш Atlas: следующий поиск в этом районе не пойдёт в EDSM.
    void saveCachedSystems(
      inSphere.map((system) => ({
        name: system.name,
        x: system.x,
        y: system.y,
        z: system.z,
        source,
      }))
    ).catch(() => 0);

    const { data: job, error } = await svc
      .from('market_search_jobs')
      .insert({
        ref_system,
        radius,
        mode,
        commodity: mode === 'single' ? commodity : null,
        build_type: mode === 'build' ? build_type : null,
        status: 'pending',
        discovery_complete: discoveryComplete,
        reference_coords: refCoords,
        total_systems: inSphere.length,
        scanned_systems: 0,
        found_stations: 0,
        current_system: null,
        systems_list: inSphere,
        result: [],
        scan_log: [],
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json(
        { error: marketError(new Error(error.message)) },
        { status: 503 }
      );
    }

    return NextResponse.json({
      job_id: job.id,
      total_systems: inSphere.length,
      status: 'pending',
      systems_list: inSphere,
      source,
    });
  } catch (e: any) {
    console.error('[Market Start] Error:', e);
    return NextResponse.json(
      { error: marketError(e) || 'Не удалось запустить поиск' },
      { status: 500 }
    );
  }
}
