import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { buildViews, viewerContext } from '@/lib/fleetCarrierStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/mine — личный авианосец пилота и носители его эскадрильи.
 *
 * Источник для профиля, страницы эскадрильи и оверлея Colonial Helper
 * (API-токен в `Authorization: Bearer rc_…`). Оверлей больше не зависит от
 * доступности Raven Colonial: груз, службы и система берутся отсюда.
 */
export async function GET(request: Request) {
  try {
    const user = await resolveRequestUser(request);
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    const svc = createServiceClient();
    const viewer = await viewerContext(svc, user.userId);

    const { data: ownRows, error: ownError } = await svc
      .from('fleet_carriers')
      .select('*')
      .eq('owner_id', user.userId);
    if (ownError) throw new Error(ownError.message);
    let squadronRows: Array<Record<string, any>> = [];
    if (viewer.squadronIds.length) {
      const { data, error } = await svc
        .from('fleet_carriers')
        .select('*')
        .in('squadron_id', viewer.squadronIds)
        .order('carrier_type', { ascending: false })
        .order('updated_at', { ascending: false });
      if (error) throw new Error(error.message);
      squadronRows = data ?? [];
    }

    const rows = new Map<string, Record<string, any>>();
    for (const row of [...(ownRows ?? []), ...squadronRows]) rows.set(String(row.carrier_id), row);
    const views = await buildViews(svc, Array.from(rows.values()), viewer);
    const own = views.find((view) => view.relation === 'own' && view.type === 'FleetCarrier') ?? null;
    const squadron = views.filter((view) => view !== own && view.squadronId != null
      && viewer.squadronIds.includes(view.squadronId));
    squadron.sort((left, right) => Number(right.type === 'SquadronCarrier') - Number(left.type === 'SquadronCarrier'));

    return NextResponse.json({
      ok: true,
      own,
      squadron,
      squadron_id: viewer.squadronIds[0] ?? null,
      can_manage_squadron: viewer.squadronIds.length > 0 && viewer.officerSquadronIds.includes(viewer.squadronIds[0]),
      server_time: new Date().toISOString(),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/mine]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load carriers' }, { status: 503 });
  }
}
