import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenSystemProgress, deriveStatusFromProgress } from '@/lib/ravenColonial';
import { enrichRavenSystemWithJournalSnapshots } from '@/lib/ravenDepotSnapshots';

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

function mergeCached(
  names: { system_name: string; hub_name?: string; status?: string }[],
  cached: { system_name: string; progress: number | null; updated_at: string | null }[] | null,
) {
  const byName = new Map(
    (cached ?? []).map((r) => [String(r.system_name).toLowerCase(), r] as const),
  );
  return names.map((n) => {
    const row = byName.get(n.system_name.toLowerCase());
    return {
      system_name: n.system_name,
      hub_name: n.hub_name,
      status: n.status,
      progress: row?.progress ?? null,
      updated_at: row?.updated_at ?? null,
      found: row?.progress != null,
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
    if (ravenData.found && !ravenData.error?.includes('не ответил')) {
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

    // 2. Fallback на кэш system_progress
    const { data: cached } = await supabase
      .from('system_progress')
      .select('system_name,progress,updated_at,data')
      .ilike('system_name', name)
      .maybeSingle();

    if (cached && cached.data) {
      return NextResponse.json({
        system_name: cached.system_name,
        progress: cached.progress,
        status: deriveStatusFromProgress(cached.progress),
        found: cached.progress != null || (Array.isArray(cached.data.projects) && cached.data.projects.length > 0),
        siteName: cached.data.siteName || null,
        architectName: cached.data.architectName || null,
        projects: cached.data.projects || [],
        resources: cached.data.resources || [],
        totalRequired: cached.data.totalRequired ?? null,
        totalProvided: cached.data.totalProvided ?? null,
        totalRemaining: cached.data.totalRemaining ?? 0,
        updated_at: cached.updated_at,
        error: ravenData.error ? ravenData.error + ' Показаны сохранённые данные.' : undefined,
      });
    }

    // 3. Fallback на route_systems (базовые данные)
    const { data: routeSys } = await supabase
      .from('route_systems')
      .select('system_name,status,progress')
      .ilike('system_name', name)
      .maybeSingle();

    if (routeSys) {
      return NextResponse.json({
        system_name: routeSys.system_name,
        progress: routeSys.progress,
        status: routeSys.status,
        found: routeSys.progress != null,
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

    const hubSet = new Set((hubs ?? []).map((h) => String(h.system_name).toLowerCase()));
    const listed = (route ?? []).filter((r) => !hubSet.has(String(r.system_name).toLowerCase()));
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
