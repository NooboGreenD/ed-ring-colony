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
    const format = searchParams.get('format') || 'json';

    const stats = await billingRepo.getProjectStatistics('all');
    const { transactions } = billingRepo.getTransactions({ limit: 500 });
    const subscriptions = billingRepo.getSubscriptions();

    if (format === 'csv') {
      const headers = ['ID', 'Date', 'CMDR', 'Type', 'Item/Plan', 'Amount RUB', 'Amount Credits', 'Method', 'Status'];
      const rows = transactions.map((t) => [
        t.id,
        `"${t.created_at}"`,
        `"${t.cmdr_name}"`,
        t.type,
        `"${t.item_title.replace(/"/g, '""')}"`,
        t.amount_rub,
        t.amount_credits,
        t.payment_method,
        t.status,
      ]);

      const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

      return new Response(csvContent, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="billing-export-${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return NextResponse.json({
      exportedAt: new Date().toISOString(),
      stats,
      subscriptions,
      transactions,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
