import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient();

  // Упрощённый select без relationships (избегаем PostgREST relationship errors)
  const { data: systems, error: sErr } = await admin
    .from('project_systems')
    .select('*')
    .eq('project_id', parseInt(params.id))
    .order('sort_order');
  if (sErr) console.error('[systems GET] systems error:', sErr);

  // Подтягиваем route_systems координаты отдельно
  const systemNames = (systems || []).map((s: any) => s.system_name);
  let routeMap = new Map();
  if (systemNames.length) {
    const { data: routeSystems } = await admin
      .from('route_systems')
      .select('id, system_name, x, y, z, status, progress')
      .in('system_name', systemNames);
    routeMap = new Map((routeSystems || []).map((r: any) => [r.system_name, r]));
  }

  // Подтягиваем hubs отдельно
  let hubMap = new Map();
  if (systemNames.length) {
    const { data: hubs } = await admin
      .from('hubs')
      .select('id, system_name, x, y, z, status, progress')
      .in('system_name', systemNames);
    hubMap = new Map((hubs || []).map((h: any) => [h.system_name, h]));
  }

  // Подтягиваем assignee имена отдельно
  const assigneeIds = (systems || []).map((s: any) => s.assigned_to).filter(Boolean);
  let assigneeMap = new Map();
  if (assigneeIds.length) {
    const { data: profiles } = await admin
      .from('profiles')
      .select('id, cmdr_name')
      .in('id', assigneeIds);
    assigneeMap = new Map((profiles || []).map((p: any) => [p.id, p.cmdr_name]));
  }

  const enriched = (systems || []).map((s: any) => {
    const rs = routeMap.get(s.system_name);
    const h = hubMap.get(s.system_name);
    return {
      ...s,
      x: h?.x ?? rs?.x ?? s.x ?? null,
      y: h?.y ?? rs?.y ?? s.y ?? null,
      z: h?.z ?? rs?.z ?? s.z ?? null,
      status: h?.status ?? rs?.status ?? s.planned_status ?? 'planned',
      progress: h?.progress ?? rs?.progress ?? 0,
      route_system: rs || null,
      hub: h || null,
      assignee: s.assigned_to ? { cmdr_name: assigneeMap.get(s.assigned_to) || 'Unknown' } : null,
    };
  });

  return NextResponse.json({ systems: enriched });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const body = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Получаем максимальный sort_order
    const { data: maxOrder } = await supabase
      .from('project_systems')
      .select('sort_order')
      .eq('project_id', projectId)
      .order('sort_order', { ascending: false })
      .limit(1)
      .single();

    const nextOrder = (maxOrder?.sort_order ?? 0) + 1;

    const { data, error } = await supabase
      .from('project_systems')
      .insert({
        project_id: projectId,
        system_name: body.system_name,
        route_system_id: body.route_system_id || null,
        hub_id: body.hub_id || null,
        sort_order: body.sort_order ?? nextOrder,
        planned_status: body.planned_status || 'planned',
        priority: body.priority || 1,
        notes: body.notes || null,
        assigned_to: body.assigned_to || null,
        target_date: body.target_date || null,
      })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ system: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { system_id, ...updates } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = ['planned_status', 'priority', 'notes', 'assigned_to', 'target_date', 'sort_order'];
    const update: Record<string, any> = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) update[key] = updates[key];
    }

    const { data, error } = await supabase
      .from('project_systems')
      .update(update)
      .eq('id', system_id)
      .eq('project_id', projectId)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ system: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const body = await req.json().catch(() => ({}));
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Если передан system_id — удаляем одну систему, иначе — очищаем весь маршрут
    if (body.system_id) {
      await supabase
        .from('project_systems')
        .delete()
        .eq('id', body.system_id)
        .eq('project_id', projectId);
      return NextResponse.json({ success: true, deleted: 1 });
    } else {
      const { error } = await supabase
        .from('project_systems')
        .delete()
        .eq('project_id', projectId);
      if (error) throw error;
      return NextResponse.json({ success: true, cleared: true });
    }
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
