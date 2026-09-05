import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';
import { z } from 'zod';

export const dynamic = 'force-dynamic';

const patchSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icon: z.string().max(100).optional(),
  status: z.enum(['active', 'paused', 'completed', 'cancelled']).optional(),
});

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const admin = createAdminClient();

    const { data: project, error: pErr } = await admin
      .from('projects')
      .select('*')
      .eq('id', projectId)
      .single();
    if (pErr || !project) {
      console.error('[project GET] project error:', pErr);
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const { data: members, error: mErr } = await admin
      .from('project_members')
      .select('*, profile:profiles(cmdr_name, avatar_url, squadron)')
      .eq('project_id', projectId)
      .order('role');
    if (mErr) console.error('[project GET] members error:', mErr);

    const { data: systems, error: sErr } = await admin
      .from('project_systems')
      .select(`
        *,
        assignee:profiles!assigned_to(cmdr_name),
        route_system:route_systems(status, progress, x, y, z),
        hub:hubs(status, progress, x, y, z)
      `)
      .eq('project_id', projectId)
      .order('sort_order');
    if (sErr) console.error('[project GET] systems error:', sErr);

    const { data: route, error: rErr } = await admin
      .rpc('get_project_route', { project_id: projectId });
    if (rErr) console.error('[project GET] route error:', rErr);

    return NextResponse.json({
      project,
      members: members || [],
      systems: systems || [],
      route: route || [],
    });
  } catch (e: any) {
    console.error('[project GET] exception:', e);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const body = await req.json();
    const supabase = await createClient();

    // Валидация входных данных
    const parseResult = patchSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { error: 'Invalid input', details: parseResult.error.flatten() },
        { status: 400 }
      );
    }
    const validBody = parseResult.data;

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project } = await supabase
      .from('projects')
      .select('squadron_id, created_by')
      .eq('id', projectId)
      .single();

    let canEdit = false;
    if (project?.created_by === user.id) {
      canEdit = true;
    } else if (project?.squadron_id) {
      const { data: sqPerm } = await supabase
        .from('squadron_member_detail')
        .select('can_manage_projects')
        .eq('squadron_id', project.squadron_id)
        .eq('user_id', user.id)
        .single();
      if (sqPerm?.can_manage_projects) canEdit = true;
    }

    if (!canEdit) {
      const { data: member } = await supabase
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .single();
      if (!member || !['leader', 'officer'].includes(member.role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    const update: Record<string, any> = {};
    if (validBody.name !== undefined) update.name = validBody.name;
    if (validBody.description !== undefined) update.description = validBody.description;
    if (validBody.color !== undefined) update.color = validBody.color;
    if (validBody.icon !== undefined) update.icon = validBody.icon;
    if (validBody.status !== undefined) update.status = validBody.status;

    if (Object.keys(update).length === 0) {
      return NextResponse.json({ error: 'No fields to update' }, { status: 400 });
    }

    const { data, error } = await supabase
      .from('projects')
      .update(update)
      .eq('id', projectId)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ project: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: project } = await supabase
      .from('projects')
      .select('created_by')
      .eq('id', projectId)
      .single();

    if (!project || project.created_by !== user.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await supabase.from('projects').delete().eq('id', projectId);
    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
