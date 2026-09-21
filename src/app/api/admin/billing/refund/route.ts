import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile && profile.role !== 'admin') {
        return NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 });
      }
    }

    const { transactionId, reason } = await req.json();
    if (!transactionId) return NextResponse.json({ error: 'Transaction ID required' }, { status: 400 });

    const result = billingRepo.refundTransaction(transactionId, reason);
    if (!result.success) {
      return NextResponse.json({ error: result.error || 'Refund failed' }, { status: 400 });
    }

    return NextResponse.json({ success: true, transaction: result.transaction });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
