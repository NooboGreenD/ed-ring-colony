import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireUser(req);
    if ('response' in auth) return auth.response;
    const { searchParams } = new URL(req.url);
    const result = await billingRepo.getTransactions({ userId: auth.actor.userId, limit: Math.min(200, Number(searchParams.get('limit')) || 50), offset: Number(searchParams.get('offset')) || 0 });
    return NextResponse.json({ success: true, ...result });
  } catch (err) {
    return errorResponse(err);
  }
}
