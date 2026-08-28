import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { createAdminClient } from '@/lib/supabaseAdmin';

export const dynamic = 'force-dynamic';
export async function GET(req: Request, { params }: { params: { id: string } }) {
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

    // Проверка прав
    const { data: membership } = await supabase
      .from('project_members')
      .select('role')
      .eq('project_id', projectId)
      .eq('user_id', user.id)
      .single();

    if (!membership || !['leader', 'officer'].includes(membership.role)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
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
