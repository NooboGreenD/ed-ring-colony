import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { resolveRequestUser } from '@/lib/helperAuth';
import { buildViews, viewerContext } from '@/lib/fleetCarrierStore';

export const dynamic = 'force-dynamic';

/**
 * GET /api/carriers?squadron_id=N — носители эскадрильи.
 *
 * Прежний маршрут писал в squadron_carriers, которую не читал ни один экран.
 * Теперь это чтение новой модели (fleet_carriers); привязка — через
 * POST /api/carriers/bind. Посторонний видит открытые поля, участник — груз.
 */
export async function GET(request: Request) {
  try {
    const squadronId = Number(new URL(request.url).searchParams.get('squadron_id'));
    if (!Number.isSafeInteger(squadronId) || squadronId <= 0) {
      return NextResponse.json({ error: 'squadron_id required' }, { status: 400 });
    }
    const svc = createServiceClient();
    const user = await resolveRequestUser(request);
    const viewer = await viewerContext(svc, user?.userId ?? null);
    const { data, error } = await svc
      .from('fleet_carriers')
      .select('*')
      .eq('squadron_id', squadronId)
      .order('carrier_type', { ascending: false })
      .order('updated_at', { ascending: false });
    if (error) throw new Error(error.message);
    const carriers = await buildViews(svc, data ?? [], viewer);
    return NextResponse.json({
      ok: true,
      carriers,
      is_member: viewer.squadronIds.includes(squadronId),
      can_manage: viewer.officerSquadronIds.includes(squadronId),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('[carriers GET]', error instanceof Error ? error.message : error);
    return NextResponse.json({ error: 'Could not load carriers' }, { status: 503 });
  }
}

/** Совместимость со старым клиентом: POST {squadron_id, carrier_id} = привязка к эскадрилье. */
export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  // Только заголовки авторизации: content-length старого тела не подходит новому.
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const name of ['authorization', 'cookie']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  const forwarded = new Request(new URL('/api/carriers/bind', request.url), {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...body, kind: 'squadron', carrier: body?.carrier_id ?? body?.callsign }),
  });
  const { POST: bind } = await import('./bind/route');
  return bind(forwarded);
}
