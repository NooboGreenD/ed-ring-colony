import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile && !['admin', 'moderator', 'support_manager'].includes(profile.role ?? '')) {
        return NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 });
      }
    }

    const { searchParams } = new URL(req.url);
    const status = searchParams.get('status') || undefined;
    const planId = searchParams.get('planId') || undefined;
    const search = searchParams.get('search') || undefined;

    const subscriptions = billingRepo.getSubscriptions({ status, planId, search });
    return NextResponse.json({ success: true, subscriptions });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile && profile.role !== 'admin') {
        return NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 });
      }
    }

    const body = await req.json();
    const { action = 'grant', userId, cmdrName, planId, durationDays = 30, subscriptionId, notes, autoRenew } = body;

    if (action === 'grant') {
      if (!planId) {
        return NextResponse.json({ error: 'Тарифный план обязателен для выбора' }, { status: 400 });
      }
      const sub = billingRepo.grantSubscription({
        userId: userId || `user-${Date.now()}`,
        cmdrName: cmdrName || 'Командир',
        planId,
        durationDays: Number(durationDays) || 30,
        notes,
        autoRenew: autoRenew ?? true,
      });
      return NextResponse.json({ success: true, subscription: sub });
    }

    if (action === 'extend') {
      if (!subscriptionId) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });
      const sub = billingRepo.extendSubscription(subscriptionId, Number(durationDays) || 30);
      if (!sub) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
      return NextResponse.json({ success: true, subscription: sub });
    }

    if (action === 'update') {
      if (!subscriptionId) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });
      const sub = billingRepo.updateSubscription(subscriptionId, {
        plan_id: planId,
        notes,
        auto_renew: autoRenew,
      });
      if (!sub) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });
      return NextResponse.json({ success: true, subscription: sub });
    }

    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}

export async function DELETE(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile && profile.role !== 'admin') {
        return NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 });
      }
    }

    const { searchParams } = new URL(req.url);
    const id = searchParams.get('id');
    const reason = searchParams.get('reason') || undefined;

    if (!id) return NextResponse.json({ error: 'ID подписки обязателен' }, { status: 400 });

    const canceled = billingRepo.cancelSubscription(id, reason);
    if (!canceled) return NextResponse.json({ error: 'Подписка не найдена' }, { status: 404 });

    return NextResponse.json({ success: true, subscription: canceled });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
