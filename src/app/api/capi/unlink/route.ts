import { NextResponse } from 'next/server';
import { authFromRequest, createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

/**
 * Отвязать аккаунт Frontier.
 *
 * Удаляем всё, что относится к живой привязке: токены, кэш профиля CAPI и
 * опубликованное положение в эскадрильях — иначе после отвязки пилот
 * продолжал светиться на карте эскадрильи последней известной системой.
 *
 * `pilot_stats` и события колонизации остаются: это история пилота, а не
 * данные доступа, и её пересобирают импорты журналов.
 */
export async function DELETE(req: Request) {
  const { user } = await authFromRequest(req);
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const svc = createServiceClient();

  const { error } = await svc.from('capi_tokens').delete().eq('user_id', user.id);
  if (error) {
    console.error('[CAPI Unlink]', error);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const { error: profileError } = await svc.from('capi_profiles').delete().eq('user_id', user.id);
  if (profileError) console.error('[CAPI Unlink] profile:', profileError.message);

  const { error: locationError } = await svc
    .from('squadron_member_locations')
    .delete()
    .eq('user_id', user.id);
  if (locationError) console.error('[CAPI Unlink] location:', locationError.message);

  return NextResponse.json({ unlinked: true });
}
