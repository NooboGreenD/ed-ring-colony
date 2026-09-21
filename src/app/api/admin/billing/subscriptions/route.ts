import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';
import { resolveProfile } from '@/lib/billing/profiles';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const { searchParams } = new URL(req.url);
    const subscriptions = await billingRepo.getSubscriptions({
      status: searchParams.get('status') || undefined,
      planId: searchParams.get('planId') || undefined,
      search: searchParams.get('search') || undefined,
    });
    return NextResponse.json({ success: true, subscriptions });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const body = await req.json();
    const { action = 'grant', planId, durationDays = 30, subscriptionId, notes, autoRenew } = body;

    if (action === 'grant') {
      if (!planId) return NextResponse.json({ error: 'Тарифный план обязателен для выбора' }, { status: 400 });
      const profile = await resolveProfile({ userId: body.userId, cmdrName: body.cmdrName });
      if (!profile) return NextResponse.json({ error: 'Пилот не найден. Укажите точный позывной (cmdr_name) зарегистрированного пользователя или его UUID.' }, { status: 404 });
      const sub = await billingRepo.grantSubscription({
        userId: profile.id,
        cmdrName: profile.cmdr_name || body.cmdrName || 'Командир',
        planId,
        durationDays: Number(durationDays) || 30,
        notes: notes ? `${notes} (${auth.actor.cmdrName})` : `Назначено администратором ${auth.actor.cmdrName}`,
        autoRenew: autoRenew ?? false,
      });
      return NextResponse.json({ success: true, subscription: sub });
    }

    if (action === 'extend') {
      if (!subscriptionId) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });
      const sub = await billingRepo.extendSubscription(subscriptionId, Number(durationDays) || 30);
      if (!sub) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
      return NextResponse.json({ success: true, subscription: sub });
    }

    if (action === 'update') {
      if (!subscriptionId) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });
      const sub = await billingRepo.updateSubscription(subscriptionId, { plan_id: planId, notes, auto_renew: autoRenew });
      if (!sub) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
      return NextResponse.json({ success: true, subscription: sub });
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });
    const canceled = await billingRepo.cancelSubscription(id, searchParams.get('reason') || undefined);
    if (!canceled) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
    return NextResponse.json({ success: true, subscription: canceled });
  } catch (err) {
    return errorResponse(err);
  }
}
