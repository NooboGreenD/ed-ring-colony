import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, { params }: { params: { id: string } }) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin
    .from('project_members')
    .select('*, profile:profiles(cmdr_name, avatar_url, squadron)')
    .eq('project_id', parseInt(params.id))
    .order('role');
  if (error) console.error('[members GET] error:', error);
  return NextResponse.json({ members: data || [] });
}

export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { user_id, role = 'member', callsign } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();

    const { data: project } = await admin
      .from('projects')
      .select('squadron_id, created_by')
      .eq('id', projectId)
      .single();

    let canManage = false;
    if (project?.created_by === user.id) canManage = true;
    else if (project?.squadron_id) {
      const { data: sqPerm } = await admin
        .from('squadron_member_detail')
        .select('can_manage_projects')
        .eq('squadron_id', project.squadron_id)
        .eq('user_id', user.id)
        .single();
      if (sqPerm?.can_manage_projects) canManage = true;
    }

    if (!canManage) {
      const { data: myMembership } = await admin
        .from('project_members')
        .select('role')
        .eq('project_id', projectId)
        .eq('user_id', user.id)
        .single();
      if (!myMembership || !['leader', 'officer'].includes(myMembership.role)) {
        return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
      }
    }

    // Проверяем, что пилот состоит в эскадрилье проекта
    if (project?.squadron_id) {
      const { data: sqMember } = await admin
        .from('squadron_members')
        .select('id')
        .eq('squadron_id', project.squadron_id)
        .eq('user_id', user_id)
        .single();
      if (!sqMember) {
        return NextResponse.json({ error: 'Пилот не состоит в эскадрильи проекта' }, { status: 403 });
      }
    }

    const { data: existing } = await admin
      .from('project_members')
      .select('id')
      .eq('project_id', projectId)
      .eq('user_id', user_id)
      .single();
    if (existing) {
      return NextResponse.json({ error: 'Пилот уже в проекте' }, { status: 409 });
    }

    const { data, error } = await supabase
      .from('project_members')
      .insert({ project_id: projectId, user_id, role, callsign: callsign || null })
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ member: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { user_id, role, callsign } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || membership.role !== 'leader') {
      return NextResponse.json({ error: 'Only leader can change roles' }, { status: 403 });
    }

    const update: Record<string, any> = {};
    if (role) update.role = role;
    if (callsign !== undefined) update.callsign = callsign;

    const { data, error } = await supabase
      .from('project_members')
      .update(update)
      .eq('project_id', projectId)
      .eq('user_id', user_id)
      .select()
      .single();

    if (error) throw error;
    return NextResponse.json({ member: data });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: { id: string } }) {
  try {
    const projectId = parseInt(params.id);
    const { user_id } = await req.json();
    const supabase = await createClient();

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

    const admin = createAdminClient();

    const { data: project } = await admin
      .from('projects')
      .select('created_by')
      .eq('id', projectId)
      .single();

    // Нельзя удалить создателя проекта
    if (user_id === project?.created_by) {
      return NextResponse.json({ error: 'Нельзя удалить создателя проекта' }, { status: 403 });
    }

    // Можно удалить себя или быть удалённым лидером/офицером
    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    const isSelf = user.id === user_id;
    const canManage = membership && ['leader', 'officer'].includes(membership.role);

    if (!isSelf && !canManage) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    await supabase
      .from('project_members')
      .delete()
      .eq('project_id', projectId)
      .eq('user_id', user_id);

    return NextResponse.json({ success: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}
