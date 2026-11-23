import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { requireAdmin } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function response(body: unknown, init?: ResponseInit) {
  const headers = new Headers(init?.headers);
  headers.set('Cache-Control', 'no-store, max-age=0');
  return NextResponse.json(body, { ...init, headers });
}

/** PATCH — переназначить лидера эскадрильи (только админ) */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
  } catch {
    return response({ error: 'Unauthorized' }, { status: 401 });
  }

  const svc = createServiceClient();
  const resolvedParams = await params;
  const squadronId = Number.parseInt(resolvedParams.id, 10);
  if (!Number.isSafeInteger(squadronId) || squadronId <= 0) {
    return response({ error: 'Squadron not found' }, { status: 404 });
  }

  const { newLeaderUserId } = await req.json();
  if (!newLeaderUserId || typeof newLeaderUserId !== 'string') {
    return response({ error: 'newLeaderUserId required' }, { status: 400 });
  }

  // Проверяем, что эскадрилья существует
  const { data: squadron, error: sErr } = await svc
    .from('squadrons')
    .select('id, name, created_by')
    .eq('id', squadronId)
    .maybeSingle();
  if (sErr || !squadron) {
    return response({ error: 'Squadron not found' }, { status: 404 });
  }

  // Проверяем, что новый лидер является членом эскадрильи
  const { data: newLeaderMember, error: mErr } = await svc
    .from('squadron_members')
    .select('user_id, role')
    .eq('squadron_id', squadronId)
    .eq('user_id', newLeaderUserId)
    .maybeSingle();
  if (mErr || !newLeaderMember) {
    return response({ error: 'Пилот не является членом эскадрильи' }, { status: 400 });
  }

  const oldLeaderId = squadron.created_by;

  // Меняем created_by на нового лидера
  const { error: updateError } = await svc
    .from('squadrons')
    .update({ created_by: newLeaderUserId })
    .eq('id', squadronId);
  if (updateError) throw updateError;

  // Если был старый лидер и он не совпадает с новым — снимаем с него роль командира
  if (oldLeaderId && oldLeaderId !== newLeaderUserId) {
    await svc
      .from('squadron_members')
      .update({ role: null })
      .eq('squadron_id', squadronId)
      .eq('user_id', oldLeaderId)
      .eq('role', 'commander');
  }

  // Назначаем нового лидера командующим
  await svc
    .from('squadron_members')
    .update({ role: 'commander' })
    .eq('squadron_id', squadronId)
    .eq('user_id', newLeaderUserId);

  return response({
    success: true,
    squadronId,
    oldLeaderId,
    newLeaderUserId,
  });
}
