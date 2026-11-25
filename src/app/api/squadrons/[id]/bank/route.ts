import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { buildViews, viewerContext } from '@/lib/fleetCarrierStore';
import { squadronBankCarriers } from '@/lib/squadronBank';

export const dynamic = 'force-dynamic';
const PRIVATE = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };

/** Squadron members of any rank may read tracked bank goods. Never public. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const squadronId = Number(id);
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(squadronId) || squadronId <= 0) {
      return NextResponse.json({ error: 'Invalid squadron' }, { status: 400, headers: PRIVATE });
    }
    const user = await resolveRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401, headers: PRIVATE });
    const svc = createServiceClient();
    const viewer = await viewerContext(svc, user.userId);
    if (!viewer.squadronIds.includes(squadronId)) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403, headers: PRIVATE });
    }
    const { data, error } = await svc.from('fleet_carriers')
      .select('*').eq('squadron_id', squadronId).eq('carrier_type', 'SquadronCarrier')
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    // Finance isn't needed even for officers; the response is an explicit allowlist.
    const views = await buildViews(svc, data ?? [], { ...viewer, officerSquadronIds: [] });
    return NextResponse.json({ ok: true, carriers: squadronBankCarriers(views, squadronId) }, { headers: PRIVATE });
  } catch (error) {
    console.error('[squadrons/:id/bank]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load squadron bank' }, { status: 503, headers: PRIVATE });
  }
}
