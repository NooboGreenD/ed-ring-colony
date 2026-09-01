import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { fetchRavenSystemProgress } from '@/lib/ravenColonial';

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
    const data = await fetchRavenSystemProgress(name);
    if (data.found || !data.error?.includes('не ответил')) {
      return NextResponse.json(data);
    }
    const { data: cached } = await supabase
      .from('system_progress')
      .select('system_name,progress,updated_at,data')
      .ilike('system_name', name)
      .maybeSingle();
    if (cached) {
      return NextResponse.json({
        ...cached,
        found: cached.progress != null,
        error: data.error + ' Показаны последние сохранённые данные.',
      });
    }
    return NextResponse.json(data);
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
