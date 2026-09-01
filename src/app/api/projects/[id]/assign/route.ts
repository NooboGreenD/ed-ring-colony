import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
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

    if (user_id === project?.created_by) {
      return NextResponse.json({ error: 'Нельзя удалить создателя проекта' }, { status: 403 });
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
