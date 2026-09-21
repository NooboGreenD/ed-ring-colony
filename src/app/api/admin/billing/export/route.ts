import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;

    const { searchParams } = new URL(req.url);
    const format = searchParams.get('format') || 'json';

    const stats = await billingRepo.getProjectStatistics('all');
    const { transactions } = await billingRepo.getTransactions({ limit: 5000 });
    const subscriptions = await billingRepo.getSubscriptions();

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
  } catch (err) {
    return errorResponse(err);
  }
}
