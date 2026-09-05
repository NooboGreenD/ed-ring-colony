import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
function parseSystemNames(raw: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const part of raw.split(/[\n\r,;]+/)) {
    const name = part.replace(/^["'\s]+|["'\s]+$/g, '').trim();
    if (!name || /^system(_name)?$/i.test(name) || /^#/.test(name)) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); names.push(name);
  }
  return names;
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { names: rawNames } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();

    const { data: membership } = await admin
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const names = parseSystemNames(rawNames || '');
    if (!names.length) return NextResponse.json({ error: 'No valid system names' }, { status: 400 });

    // Проверяем существующие в проекте
    const { data: existingSystems } = await admin
      .from('project_systems')
      .select('system_name')
      .eq('project_id', projectId);
    const existingSet = new Set((existingSystems || []).map(s => s.system_name.toLowerCase()));

    // Проверяем хабы
    const { data: hubs } = await admin.from('hubs').select('system_name');
    const hubSet = new Set((hubs || []).map(h => h.system_name.toLowerCase()));

    // Проверяем route_systems
    const { data: routeSystems } = await admin
      .from('route_systems')
      .select('id, system_name, x, y, z, status, progress')
      .in('system_name', names);
    const routeMap = new Map((routeSystems || []).map(r => [r.system_name.toLowerCase(), r]));

    const toAdd: string[] = [];
    let skippedHub = 0, skippedDup = 0, skippedNoRoute = 0;

    for (const n of names) {
      const key = n.toLowerCase();
      if (hubSet.has(key)) { skippedHub++; continue; }
      if (existingSet.has(key)) { skippedDup++; continue; }
      if (!routeMap.has(key)) { skippedNoRoute++; continue; }
      existingSet.add(key);
      toAdd.push(n);
    }

    if (!toAdd.length) {
      return NextResponse.json({
        error: `Нечего добавлять. Хабов: ${skippedHub}, дубликатов: ${skippedDup}, не в маршруте: ${skippedNoRoute}.`
      }, { status: 400 });
    }

    // Получаем максимальный sort_order
    const { data: maxOrderRow } = await admin
      .from('project_systems')
      .select('sort_order')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();
    let maxOrder = maxOrderRow?.sort_order ?? 0;

    const rows = toAdd.map(name => {
      const rs = routeMap.get(name.toLowerCase())!;
      return {
        project_id: projectId,
        system_name: rs.system_name,
        route_system_id: rs.id,
        sort_order: ++maxOrder,
        planned_status: 'planned',
        priority: 1,
      };
    });

    const { error } = await supabase.from('project_systems').insert(rows);
    if (error) throw error;

    return NextResponse.json({
      added: toAdd.length,
      skippedHub,
      skippedDup,
      skippedNoRoute,
      systems: toAdd,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
