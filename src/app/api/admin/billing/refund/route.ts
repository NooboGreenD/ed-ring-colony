import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { transactionId, reason } = await req.json();
    if (!transactionId) return NextResponse.json({ error: 'Transaction ID required' }, { status: 400 });
    const result = await billingRepo.refundTransaction(transactionId, reason ? `${reason} (${auth.actor.cmdrName})` : undefined);
    if (!result.success) return NextResponse.json({ error: result.error || 'Refund failed' }, { status: 400 });
    return NextResponse.json({ success: true, transaction: result.transaction });
  } catch (err) {
    return errorResponse(err);
  }
}
