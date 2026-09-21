import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Manual credit grant/deduction by admin. */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { userId, cmdrName, amountCredits, reason } = await req.json();
    if (!userId || !amountCredits) return NextResponse.json({ error: 'userId и amountCredits обязательны' }, { status: 400 });
    const r = await billingRepo.grantCredits({ userId, cmdrName: cmdrName || '', amountCredits: Number(amountCredits), reason, adminName: auth.actor.cmdrName });
    return NextResponse.json({ success: true, ...r });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
