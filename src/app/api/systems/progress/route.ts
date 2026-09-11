import { NextResponse } from 'next/server';
import { createClient, createServiceClient } from '@/lib/supabaseServer';
import { fetchRavenSystemProgress, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';
import {
  latestProgressBySystem,
  persistRavenSystemProgress,
  readableProgress,
  statusFromProgress,
  systemNameKey,
} from '@/lib/systemProgress';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function mergeCached(
  names: { system_name: string; hub_name?: string; status?: string }[],
  cached: { system_name: string; progress: unknown; updated_at: string | null }[] | null,
) {
  const byName = latestProgressBySystem(cached);
  return names.map((system) => {
    const row = byName.get(systemNameKey(system.system_name));
    const progress = row?.progress ?? null;
    return {
      system_name: system.system_name,
      hub_name: system.hub_name,
      status: progress == null ? system.status ?? 'planned' : statusFromProgress(progress),
      progress,
      updated_at: row?.updated_at ?? null,
      found: progress != null,
      data: null,
    };
  });
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const name = url.searchParams.get('name')?.trim();
  const supabase = await createClient();

  if (name) {
    // 1. Пробуем RavenColonial напрямую
    const ravenData = await fetchRavenSystemProgress(name, enrichRavenSystemWithJournalSnapshots);
    if (ravenData.found && !ravenData.error) {
      // A system detail page is also a live Raven read. Store that same read
      // in the map cache so returning to /map cannot show an older 0% row.
      // Cache failures must not make the public detail page unavailable.
      try {
        const cacheResult = await persistRavenSystemProgress(createServiceClient(), name, {
          systemName: ravenData.system_name,
          progress: ravenData.progress,
          siteName: ravenData.data?.siteName || null,
          architectName: ravenData.data?.architectName || null,
          projects: ravenData.data?.projects || [],
          resources: ravenData.data?.resources || [],
          totalRequired: ravenData.data?.totalRequired ?? null,
          totalProvided: ravenData.data?.totalProvided ?? null,
          totalRemaining: ravenData.data?.totalRemaining ?? 0,
        });
        if (cacheResult.warnings.length > 0) {
          console.warn('[systems/progress] Raven result could only be partially cached:', cacheResult.warnings.join(' | '));
        }
      } catch (cacheError: any) {
        console.warn('[systems/progress] Failed to update map cache:', cacheError?.message || cacheError);
      }

      // Раскладываем вложенные data.* на верхний уровень для совместимости с UI
      return NextResponse.json({
        system_name: ravenData.system_name,
        progress: ravenData.progress,
        status: ravenData.status,
        found: ravenData.found,
        siteName: ravenData.data?.siteName || null,
        architectName: ravenData.data?.architectName || null,
        projects: ravenData.data?.projects || [],
        resources: ravenData.data?.resources || [],
        totalRequired: ravenData.data?.totalRequired ?? null,
        totalProvided: ravenData.data?.totalProvided ?? null,
        totalRemaining: ravenData.data?.totalRemaining ?? 0,
        updated_at: ravenData.updated_at,
        error: ravenData.error,
      });
    }

    // 2. Fallback to the newest normalized cache row. Legacy case variants
    // can coexist in this table, so `maybeSingle()` would be ambiguous.
    const { data: cachedRows } = await supabase
      .from('system_progress')
      .select('system_name,progress,updated_at,data')
      .ilike('system_name', name)
      .order('updated_at', { ascending: false })
      .limit(20);
    const cachedByName = latestProgressBySystem(cachedRows);
    const cachedProgress = cachedByName.get(systemNameKey(name));
    const cached = (cachedRows || []).find((row) =>
      systemNameKey(row.system_name) === systemNameKey(name)
      && row.updated_at === cachedProgress?.updated_at,
    ) ?? (cachedRows || []).find((row) => systemNameKey(row.system_name) === systemNameKey(name));

    if (cached) {
      const cachedData = cached.data && typeof cached.data === 'object' ? cached.data as Record<string, any> : {};
      const progress = cachedProgress?.progress ?? cached.progress;
      return NextResponse.json({
        system_name: cached.system_name,
        progress,
        status: statusFromProgress(progress),
        found: progress != null || (Array.isArray(cachedData.projects) && cachedData.projects.length > 0),
        siteName: cachedData.siteName || null,
        architectName: cachedData.architectName || null,
        projects: cachedData.projects || [],
        resources: cachedData.resources || [],
        totalRequired: cachedData.totalRequired ?? null,
        totalProvided: cachedData.totalProvided ?? null,
        totalRemaining: cachedData.totalRemaining ?? 0,
        updated_at: cachedProgress?.updated_at ?? cached.updated_at,
        error: ravenData.error ? ravenData.error + ' Показаны сохранённые данные.' : undefined,
      });
    }

    // 3. Fallback to the map source record. Query an array rather than
    // `maybeSingle()` because old data can contain case variants, and include
    // hubs so a hub marker's detail link behaves just like a route marker.
    const [{ data: routeRows }, { data: hubRows }] = await Promise.all([
      supabase
        .from('route_systems')
        .select('system_name,status,progress')
        .ilike('system_name', name)
        .limit(20),
      supabase
        .from('hubs')
        .select('system_name,status,progress')
        .ilike('system_name', name)
        .limit(20),
    ]);
    const requestedKey = systemNameKey(name);
    const mapSystem = [...(routeRows || []), ...(hubRows || [])]
      .find((row) => systemNameKey(row.system_name) === requestedKey);

    if (mapSystem) {
      const progress = readableProgress(mapSystem.progress);
      return NextResponse.json({
        system_name: mapSystem.system_name,
        progress,
        // When a numeric value is present, use the identical status rule as
        // the map rather than retaining a legacy status column value.
        status: progress == null ? mapSystem.status : statusFromProgress(progress),
        found: progress != null,
        siteName: null,
        architectName: null,
        projects: [],
        resources: [],
        totalRequired: null,
        totalProvided: null,
        totalRemaining: 0,
        error: ravenData.error || 'Данные о постройках не найдены.',
      });
    }

    return NextResponse.json({
      system_name: ravenData.system_name,
      progress: ravenData.progress,
      status: ravenData.status,
      found: ravenData.found,
      siteName: ravenData.data?.siteName || null,
      architectName: ravenData.data?.architectName || null,
      projects: ravenData.data?.projects || [],
      resources: ravenData.data?.resources || [],
      totalRequired: ravenData.data?.totalRequired ?? null,
      totalProvided: ravenData.data?.totalProvided ?? null,
      totalRemaining: ravenData.data?.totalRemaining ?? 0,
      updated_at: ravenData.updated_at,
      error: ravenData.error,
    });
  }

  const scope = url.searchParams.get('scope')?.trim() || 'hubs';

  if (scope === 'route') {
    const [{ data: hubs }, { data: route, error }] = await Promise.all([
      supabase.from('hubs').select('system_name'),
      supabase.from('route_systems').select('system_name,sort_order').order('sort_order').order('id'),
    ]);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    const hubSet = new Set((hubs ?? []).map((hub) => systemNameKey(hub.system_name)));
    const listed = (route ?? []).filter((routeSystem) => !hubSet.has(systemNameKey(routeSystem.system_name)));
    const { data: cached } = await supabase
      .from('system_progress')
      .select('system_name,progress,updated_at');
    return NextResponse.json({
      systems: mergeCached(
        listed.map((r) => ({ system_name: r.system_name })),
        cached,
      ),
      total: listed.length,
      cached: true,
    });
  }

  const { data: hubs, error } = await supabase
    .from('hubs')
    .select('system_name,name,status,segment_order')
    .order('segment_order');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const { data: cached } = await supabase
    .from('system_progress')
    .select('system_name,progress,updated_at');

  return NextResponse.json({
    systems: mergeCached(
      (hubs ?? []).map((h) => ({
        system_name: h.system_name,
        hub_name: h.name,
        status: h.status,
      })),
      cached,
    ),
    cached: true,
  });
}
