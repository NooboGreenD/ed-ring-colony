import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { greedyRoute } from '@/lib/routeEngine';

export const dynamic = 'force-dynamic';
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { start_system } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();

    // Проверка прав
    const { data: membership } = await admin
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Получаем системы проекта с координатами
    const { data: systems } = await admin
      .from('project_systems')
      .select(`
        id, system_name, sort_order,
        route_system:route_systems(x, y, z),
        hub:hubs(x, y, z)
      `)
      .eq('project_id', projectId);

    if (!systems?.length) return NextResponse.json({ error: 'No systems' }, { status: 400 });

    const points = systems.map((s: any) => ({
      system_name: s.system_name,
      x: s.hub?.x ?? s.route_system?.x ?? 0,
      y: s.hub?.y ?? s.route_system?.y ?? 0,
      z: s.hub?.z ?? s.route_system?.z ?? 0,
      id: s.id,
    }));

    const start = start_system 
      ? points.find((p: any) => p.system_name.toLowerCase() === start_system.toLowerCase())
      : undefined;

    const route = greedyRoute(points, start);

    // Обновляем sort_order на основе оптимального маршрута
    const updates = route.map((point, idx) => ({
      id: (points.find((p: any) => p.system_name === point.system_name) as any).id,
      sort_order: idx + 1,
    }));

    for (const u of updates) {
      await supabase
        .from('project_systems')
        .update({ sort_order: u.sort_order })
        .eq('id', u.id);
    }

    return NextResponse.json({ route, updated: updates.length });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
