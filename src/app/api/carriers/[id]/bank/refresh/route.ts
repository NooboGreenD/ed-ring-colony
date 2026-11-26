import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/helperAuth';
import { createServiceClient } from '@/lib/supabaseServer';
import { findCarrier, viewerContext } from '@/lib/fleetCarrierStore';
import { checkRateLimit } from '@/lib/rateLimit';
import { capiSession } from '@/lib/capi/session';
import { squadronBankSnapshot } from '@/lib/capi/squadronBank';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;
const PRIVATE = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
const reply = (body: Record<string, unknown>, status = 200) => NextResponse.json(body, { status, headers: PRIVATE });

/** No inventory/body accepted: credentials and /squadron data stay server-side. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await resolveRequestUser(request);
    if (!user) return reply({ error: 'Unauthorized' }, 401);
    const { id } = await params;
    if (!/^[1-9]\d{0,17}$/.test(id)) return reply({ error: 'Invalid carrier' }, 404);
    const svc = createServiceClient();
    const viewer = await viewerContext(svc, user.userId);
    const car = await findCarrier(svc, { carrierId: id });
    if (!car || car.carrier_type !== 'SquadronCarrier' || !car.squadron_id || !car.callsign
        || !viewer.squadronIds.includes(Number(car.squadron_id))) return reply({ error: 'Squadron membership required' }, 403);
    if (!checkRateLimit(`bank-capi:${user.userId}`, 1) || !checkRateLimit(`bank-capi-carrier:${id}`, 1))
      return reply({ error: 'Retry later' }, 429);
    const { data: token, error: tokenError } = await svc.from('capi_tokens').select('*').eq('user_id', user.userId).maybeSingle();
    if (tokenError) throw new Error('Binding lookup failed');
    if (!token || token.is_active === false) return reply({ error: 'Link Frontier on the website to refresh bank stock', needsSiteLink: true }, 409);
    // The CAPI source is Live only: never import Legacy's bank into Live.
    if (['xbox', 'psn', 'console', 'legacy'].includes(token.platform)) return reply({ error: 'Live Frontier binding required' }, 409);
    const session = await capiSession(svc, user.userId, token);
    const requestedAt = new Date();
    const raw = await session.run(client => client.getSquadron());
    const snapshot = squadronBankSnapshot(raw, { callsign: car.callsign, carrierId: id }, requestedAt, new Date());
    if (!snapshot) return reply({ error: 'Frontier did not return a verifiable complete shared bank; existing stock unchanged', unavailable: true }, 422);
    const { data, error } = await svc.rpc('sync_squadron_bank_from_capi', {
      p_actor_id: user.userId, p_squadron_id: Number(car.squadron_id), p_carrier_id: id,
      p_expected_callsign: car.callsign, p_observed_at: snapshot.observedAt, p_items: snapshot.items,
    });
    if (error?.code === '42501') return reply({ error: 'Squadron membership changed' }, 403);
    if (error?.code === 'P0001') return reply({ error: 'Inventory changed; retry with a fresh snapshot' }, 409);
    if (error || !data?.ok) throw new Error('Snapshot not acknowledged');
    return reply({ ok: true, carrierId: id, observedAt: snapshot.observedAt,
      total: snapshot.items.reduce((n, item) => n + item.qty, 0), duplicate: data.duplicate === true });
  } catch {
    // Never expose Frontier payloads, finance, members or credentials in errors.
    return reply({ error: 'Bank refresh unavailable; existing stock unchanged' }, 503);
  }
}
