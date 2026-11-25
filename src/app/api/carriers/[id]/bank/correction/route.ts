import { NextResponse } from 'next/server';
import { resolveRequestUser } from '@/lib/helperAuth';
import { createServiceClient } from '@/lib/supabaseServer';
import { findCarrier, viewerContext } from '@/lib/fleetCarrierStore';
import { validBankInventory } from '@/lib/bankCorrection';
import { apiTranslate } from '@/lib/i18n/apiT';
import { checkRateLimit } from '@/lib/rateLimit';

export const dynamic = 'force-dynamic';
const PRIVATE = { 'Cache-Control': 'private, no-store', Vary: 'Authorization, Cookie' };
const MAX_BYTES = 128 * 1024;
class AccessError extends Error { constructor(public status: number) { super('Access denied'); } }
async function access(request: Request, id: string) {
  const user = await resolveRequestUser(request);
  if (!user) throw new AccessError(401);
  if (!/^\d{1,18}$/.test(id)) throw new AccessError(404);
  const svc = createServiceClient();
  const viewer = await viewerContext(svc, user.userId);
  const row = await findCarrier(svc, { carrierId: id });
  if (!row || row.carrier_type !== 'SquadronCarrier' || !viewer.squadronIds.includes(Number(row.squadron_id))) throw new AccessError(403);
  return { svc, row, user, canCorrect: viewer.officerSquadronIds.includes(Number(row.squadron_id)) };
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  try {
    const { svc, row, canCorrect } = await access(request, (await params).id);
    if (!canCorrect) return NextResponse.json({ ok: true, canCorrect: false }, { headers: PRIVATE });
    const { data, error } = await svc.from('squadron_bank_reconciliations')
      .select('id, observed_at, recorded_at, reason, items, actor_id').eq('carrier_id', row.carrier_id)
      .order('recorded_at', { ascending: false }).limit(10);
    if (error) throw new Error('Bank correction history unavailable');
    const actorIds = [...new Set((data ?? []).map(item => item.actor_id).filter((id): id is string => typeof id === 'string'))];
    const names = new Map<string, string>();
    if (actorIds.length) {
      const profiles = await svc.from('public_profiles').select('id, cmdr_name').in('id', actorIds);
      if (profiles.error) throw new Error('Bank correction authors unavailable');
      for (const profile of profiles.data ?? []) names.set(profile.id, profile.cmdr_name);
    }
    const history = (data ?? []).map(item => ({ id: item.id, observedAt: item.observed_at, recordedAt: item.recorded_at,
      reason: item.reason, total: Array.isArray(item.items) ? item.items.reduce((n: number, good: { qty: number }) => n + Number(good.qty || 0), 0) : 0,
      author: names.get(item.actor_id ?? '') ?? t('bc.operator'),
    }));
    return NextResponse.json({ ok: true, canCorrect: true, serverNow: new Date().toISOString(), history }, { headers: PRIVATE });
  } catch (error) {
    return NextResponse.json({ error: t(error instanceof AccessError ? 'bc.forbidden' : 'bc.unavailable') }, { status: error instanceof AccessError ? error.status : 503, headers: PRIVATE });
  }
}

/** Bounded JSON reads: do not trust Content-Length, including chunked uploads. */
async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BYTES) throw new AccessError(413);
  const reader = request.body?.getReader();
  if (!reader) throw new AccessError(400);
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    size += next.value.byteLength;
    if (size > MAX_BYTES) { await reader.cancel(); throw new AccessError(413); }
    chunks.push(next.value);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new AccessError(400); }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const t = await apiTranslate();
  try {
    const { svc, row, user, canCorrect } = await access(request, (await params).id);
    if (!canCorrect) throw new AccessError(403);
    if (!checkRateLimit(`bank-correction:${user.userId}`, 10)) throw new AccessError(429);
    const body = await readBody(request) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || body.confirmComplete !== true
      || typeof body.callsign !== 'string' || !row.callsign || body.callsign.trim().toUpperCase() !== row.callsign.toUpperCase()
      || typeof body.reason !== 'string' || body.reason.trim().length < 10 || body.reason.trim().length > 1000
      || typeof body.observedAt !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(body.observedAt)
      || !Number.isFinite(Date.parse(body.observedAt)) || Date.parse(body.observedAt) > Date.now()
      || !validBankInventory(body.items)) throw new AccessError(400);
    // Pass ONLY whitelisted fields, and derive actor/squadron identity server-side.
    const { data, error } = await svc.rpc('correct_squadron_bank_as_officer', {
      p_actor_id: user.userId, p_squadron_id: Number(row.squadron_id), p_carrier_id: String(row.carrier_id),
      p_expected_callsign: row.callsign, p_observed_at: new Date(body.observedAt).toISOString(),
      p_items: body.items.map(item => ({ commodity: item.commodity, qty: item.qty, ...(item.name_localised ? { name_localised: item.name_localised } : {}) })),
      p_reason: body.reason.trim(),
    });
    if (error) {
      if (error.code === '42501') throw new AccessError(403);
      if (error.code === 'P0001') return NextResponse.json({ error: t('bc.conflict') }, { status: 409, headers: PRIVATE });
      throw new Error('Bank correction RPC unavailable');
    }
    if (!data?.ok) throw new Error('Bank correction not acknowledged');
    return NextResponse.json({ ok: true, id: data.id, duplicate: data.duplicate }, { headers: PRIVATE });
  } catch (error) {
    const status = error instanceof AccessError ? error.status : 503;
    return NextResponse.json({ error: t(status === 400 || status === 413 ? 'bc.invalid' : status === 429 ? 'bc.rate' : status === 401 || status === 403 || status === 404 ? 'bc.forbidden' : 'bc.unavailable') }, { status, headers: PRIVATE });
  }
}
