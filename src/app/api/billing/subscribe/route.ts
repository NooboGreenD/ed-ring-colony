import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Buy a subscription plan with credits. Real-money — via /api/billing/checkout. */
export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ('response' in auth) return auth.response;
    const { planId } = await req.json().catch(() => ({}));
    if (!planId) return NextResponse.json({ error: 'planId required' }, { status: 400 });
    const r = await billingRepo.subscribeWithCredits({ userId: auth.actor.userId, cmdrName: auth.actor.cmdrName, planId });
    if (!r.success) return NextResponse.json({ error: r.error }, { status: 400 });
    return NextResponse.json({ success: true, subscription: r.subscription, balance: r.balance });
  } catch (err) {
    return errorResponse(err);
  }
}
