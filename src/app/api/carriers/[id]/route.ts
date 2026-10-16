import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { parseCarrierReference } from '@/lib/fleetCarriers';
import { buildViews, findCarrier, viewerContext } from '@/lib/fleetCarrierStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers/{carrierId | callsign}
 *
 * Карточка одного носителя. Посторонним — только открытое (имя, система,
 * службы, рынок); груз — владельцу и его эскадрилье.
 */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const reference = parseCarrierReference(decodeURIComponent(id));
    if (!reference) return NextResponse.json({ error: 'Укажите Carrier ID или позывной вида ABC-123' }, { status: 400 });
    const svc = createServiceClient();
    const row = await findCarrier(svc, reference);
    if (!row) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    const user = await resolveRequestUser(request);
    const viewer = await viewerContext(svc, user?.userId ?? null);
    const [carrier] = await buildViews(svc, [row], viewer);
    return NextResponse.json({ ok: true, carrier }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers/:id]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load carrier' }, { status: 503 });
  }
}
