import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { latestProgressBySystem, readableProgress, statusFromProgress, systemNameKey } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const admin = createAdminClient();
  const projectId = Number.parseInt(params.id, 10);
  if (!Number.isSafeInteger(projectId)) {
    return NextResponse.json({ error: 'Invalid project id' }, { status: 400 });
  }

  // Keep project-system metadata independent from PostgREST relationships;
  // those relations are optional in older deployments.
  // PostgREST commonly caps one response at 1,000 rows. Page explicitly so
  // large squadron projects can display up to 15,000 systems.
  const systems: any[] = [];
  const PAGE_SIZE = 1000;
  for (let offset = 0; offset < 15_000; offset += PAGE_SIZE) {
    const { data: page, error: systemsError } = await admin
      .from('project_systems')
      .select('*')
      .eq('project_id', projectId)
      .order('sort_order')
      .range(offset, offset + PAGE_SIZE - 1);
    if (systemsError) {
      console.error('[project systems] Could not load systems:', systemsError);
      return NextResponse.json({ error: systemsError.message }, { status: 500 });
    }
    systems.push(...(page || []));
    if (!page || page.length < PAGE_SIZE) break;
  }

  const requestedKeys = new Set((systems || []).map((system: any) => systemNameKey(system.system_name)).filter(Boolean));
  const [{ data: routeRows, error: routeError }, { data: hubRows, error: hubError }, { data: cacheRows, error: cacheError }] = await Promise.all([
    admin.from('route_systems').select('id, system_name, x, y, z, status, progress'),
    admin.from('hubs').select('id, system_name, x, y, z, status, progress'),
    admin.from('system_progress').select('system_name, progress, updated_at'),
  ]);
  if (routeError) console.warn('[project systems] Could not load route rows:', routeError.message);
  if (hubError) console.warn('[project systems] Could not load hub rows:', hubError.message);
  if (cacheError) console.warn('[project systems] Could not load Raven cache:', cacheError.message);

  const routeMap = new Map(
    (routeRows || [])
      .filter((routeSystem: any) => requestedKeys.has(systemNameKey(routeSystem.system_name)))
      .map((routeSystem: any) => [systemNameKey(routeSystem.system_name), routeSystem]),
  );
  const hubMap = new Map(
    (hubRows || [])
      .filter((hub: any) => requestedKeys.has(systemNameKey(hub.system_name)))
      .map((hub: any) => [systemNameKey(hub.system_name), hub]),
  );
  const progressBySystem = latestProgressBySystem(cacheError ? [] : cacheRows);

  const assigneeIds = Array.from(new Set((systems || []).map((system: any) => system.assigned_to).filter(Boolean)));
  let assigneeMap = new Map<string, string>();
  if (assigneeIds.length > 0) {
    const { data: profiles, error: profilesError } = await admin
      .from('profiles')
      .select('id, cmdr_name')
      .in('id', assigneeIds);
    if (profilesError) console.warn('[project systems] Could not load assignees:', profilesError.message);
    assigneeMap = new Map((profiles || []).map((profile: any) => [profile.id, profile.cmdr_name]));
  }

  const enriched = (systems || []).map((system: any) => {
    const key = systemNameKey(system.system_name);
    const routeSystem = routeMap.get(key);
    const hub = hubMap.get(key);
    const cached = progressBySystem.get(key);
    const baseProgress = readableProgress(hub?.progress ?? routeSystem?.progress);
    const progress = cached?.progress ?? baseProgress;
    const baseStatus = hub?.status ?? routeSystem?.status ?? system.planned_status ?? 'planned';

    return {
      ...system,
      // Project coordinates are authoritative for project systems. Global map
      // coordinates are only a fallback for legacy rows that do not have their
      // own coordinates yet. Keeping this order lets the project EDSM updater
      // correctly detect and fill missing project coordinates.
      x: system.x ?? hub?.x ?? routeSystem?.x ?? null,
      y: system.y ?? hub?.y ?? routeSystem?.y ?? null,
      z: system.z ?? hub?.z ?? routeSystem?.z ?? null,
      status: progress == null ? baseStatus : statusFromProgress(progress),
      progress: progress ?? 0,
      route_system: routeSystem || null,
      hub: hub || null,
      assignee: system.assigned_to ? { cmdr_name: assigneeMap.get(system.assigned_to) || 'Unknown' } : null,
    };
  });

  return NextResponse.json(
    { systems: enriched },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
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

    const { data: project } = await supabase
      .from('projects')
      .select('created_by')
      .eq('id', projectId)
      .maybeSingle();
    const canManage = Boolean(
      (membership && ['leader', 'officer'].includes(membership.role))
      || project?.created_by === user.id,
    );
    if (!canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const allowed = ['planned_status', 'priority', 'notes', 'assigned_to', 'target_date', 'sort_order', 'x', 'y', 'z'];
    const update: Record<string, any> = {};
    for (const key of allowed) {
      if (updates[key] !== undefined) update[key] = updates[key];
    }
    for (const axis of ['x', 'y', 'z']) {
      if (update[axis] !== undefined) {
        const value = Number(update[axis]);
        if (!Number.isFinite(value)) {
          return NextResponse.json({ error: `Invalid coordinate ${axis}` }, { status: 400 });
        }
        update[axis] = value;
      }
    }

    const admin = createAdminClient();
    const { data, error } = await admin
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
      .maybeSingle();
    const admin = createAdminClient();
    const { data: project } = await admin
      .from('projects')
      .select('created_by')
      .eq('id', projectId)
      .maybeSingle();
    const isProjectOwner = project?.created_by === user.id;

    // Project owners can administer their own route even when a legacy
    // deployment has no corresponding project_members row.
    if ((!membership || !['leader', 'officer'].includes(membership.role)) && !isProjectOwner) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // The API authorizes both leaders and officers. Use the admin client for
    // the actual delete because older RLS policies allowed only leaders and
    // otherwise made the UI report a generic "clear route" error.
    const linkedQuery = admin.from('project_systems').select('id, route_system_id').eq('project_id', projectId);
    const { data: linkedRows, error: linkedError } = body.system_id
      ? await linkedQuery.eq('id', body.system_id)
      : await linkedQuery.limit(15_000);
    if (linkedError) throw linkedError;
    const routeIds = (linkedRows || []).map((row: any) => row.route_system_id).filter(Boolean);

    const deleteQuery = admin.from('project_systems').delete().eq('project_id', projectId);
    const { error } = body.system_id
      ? await deleteQuery.eq('id', body.system_id)
      : await deleteQuery;
    if (error) throw error;

    // Remove orphaned route rows too, otherwise the global Atlas map keeps
    // drawing systems that were just removed from the project.
    if (routeIds.length) {
      const { data: stillLinked } = await admin.from('project_systems').select('route_system_id').in('route_system_id', routeIds);
      const orphaned = routeIds.filter((routeId: number) => !(stillLinked || []).some((row: any) => row.route_system_id === routeId));
      if (orphaned.length) await admin.from('route_systems').delete().in('id', orphaned);
    }
    return NextResponse.json({ success: true, deleted: linkedRows?.length || 0, cleared: !body.system_id });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
