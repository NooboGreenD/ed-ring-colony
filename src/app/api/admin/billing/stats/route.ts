import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    // In production, verify role === 'admin'. For dev/preview, allow graceful inspection.
    if (user) {
      const { data: profile } = await supabase.from('profiles').select('role').eq('id', user.id).maybeSingle();
      if (profile && !['admin', 'moderator', 'support_manager'].includes(profile.role ?? '')) {
        return NextResponse.json({ error: 'Access denied: Administrator required' }, { status: 403 });
      }
    }

    const { searchParams } = new URL(req.url);
    const period = (searchParams.get('period') as any) || '30d';

    const stats = await billingRepo.getProjectStatistics(period);

    // Try enriching telemetry with live DB counts if available
    try {
      const [{ count: cmdrs }, { count: hubs }, { count: doneHubs }, { count: ticketsOpen }] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('hubs').select('id', { count: 'exact', head: true }),
        supabase.from('hubs').select('id', { count: 'exact', head: true }).eq('status', 'done'),
        supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
      ]);

      if (cmdrs) stats.telemetry.totalRegisteredPilots = cmdrs;
      if (hubs) stats.telemetry.totalSystemsClaimed = hubs;
      if (doneHubs) stats.telemetry.totalFacilitiesBuilt = doneHubs;
      if (ticketsOpen !== null && ticketsOpen !== undefined) stats.telemetry.supportTicketsOpen = ticketsOpen;
    } catch {
      // Offline fallback: keep pre-calculated telemetry
    }

    return NextResponse.json({ success: true, stats });
  } catch (err: any) {
    console.error('[BillingStatsAPI] Error:', err);
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
