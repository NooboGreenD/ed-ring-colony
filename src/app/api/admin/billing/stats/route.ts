import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, errorResponse } from '@/lib/billing/auth';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;

    const { searchParams } = new URL(req.url);
    const period = (searchParams.get('period') as any) || '30d';
    const stats = await billingRepo.getProjectStatistics(period);

    // Enrich telemetry with live project counters (best-effort, real DB only)
    try {
      const { supabase } = await authFromRequest(req);
      const [cmdrs, hubs, doneHubs, ticketsOpen, ticketsResolved, tokens, tonnage] = await Promise.all([
        supabase.from('profiles').select('id', { count: 'exact', head: true }),
        supabase.from('hubs').select('id', { count: 'exact', head: true }),
        supabase.from('hubs').select('id', { count: 'exact', head: true }).eq('status', 'done'),
        supabase.from('support_tickets').select('id', { count: 'exact', head: true }).eq('status', 'open'),
        supabase.from('support_tickets').select('id', { count: 'exact', head: true }).in('status', ['resolved', 'closed']),
        supabase.from('api_tokens').select('id', { count: 'exact', head: true }).is('revoked_at', null),
        supabase.from('deliveries').select('amount.sum()').maybeSingle(),
      ]);
      if (cmdrs.count != null) stats.telemetry.totalRegisteredPilots = cmdrs.count;
      if (hubs.count != null) stats.telemetry.totalSystemsClaimed = hubs.count;
      if (doneHubs.count != null) stats.telemetry.totalFacilitiesBuilt = doneHubs.count;
      if (ticketsOpen.count != null) stats.telemetry.supportTicketsOpen = ticketsOpen.count;
      if (ticketsResolved.count != null) stats.telemetry.supportTicketsResolved = ticketsResolved.count;
      if (tokens.count != null) stats.telemetry.apiTokensActive = tokens.count;
      const sum = (tonnage.data as any)?.sum;
      if (typeof sum === 'number') stats.telemetry.totalTonnageHauled = sum;
    } catch {
      /* offline: keep repository values */
    }

    return NextResponse.json({ success: true, stats });
  } catch (err) {
    return errorResponse(err);
  }
}
