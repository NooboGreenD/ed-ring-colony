import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { getDriver } from '@/lib/billing/providers';
import { rubToKopecks } from '@/lib/billing/tbank';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Unified webhook endpoint: /api/billing/webhooks/{provider}
 * Verifies signature via the driver, then fulfils the intent idempotently.
 */
async function handle(req: Request, providerId: string) {
  const provider = await billingRepo.getProvider(providerId);
  const driver = getDriver(providerId);
  if (!provider || !driver) return NextResponse.json({ error: 'Unknown provider' }, { status: 404 });
  // Disabling checkout must not discard confirmations for existing T-Bank orders.
  if (!provider.is_enabled && providerId !== 'tbank') return NextResponse.json({ error: 'Provider disabled' }, { status: 403 });

  if (providerId === 'tbank' && req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
  if (providerId === 'tbank' && !provider.test_mode && await billingRepo.backendKind !== 'supabase') {
    return NextResponse.json({ error: 'Payment storage unavailable' }, { status: 503 });
  }

  const rawBody = req.method === 'GET' ? '' : await req.text();
  const query = new URL(req.url).searchParams;
  let payloadForLog: any = rawBody.length < 20000 ? rawBody : rawBody.slice(0, 20000);
  try {
    payloadForLog = JSON.parse(rawBody);
  } catch {
    /* keep string */
  }

  // T-Bank notifications may contain Token, PAN, expiry, CardId and RebillId.
  // Keep an audit of payment fields only, including for rejected notifications.
  if (providerId === 'tbank') {
    const data = payloadForLog && typeof payloadForLog === 'object' ? payloadForLog : {};
    payloadForLog = Object.fromEntries(['OrderId', 'PaymentId', 'Status', 'Success', 'ErrorCode', 'Amount']
      .filter((key) => ['string', 'number', 'boolean'].includes(typeof data[key]))
      .map((key) => [key, typeof data[key] === 'string' ? data[key].slice(0, 200) : data[key]]));
  }

  const parsed = await driver.parseWebhook(provider, { headers: req.headers, rawBody, query });
  if (!parsed.ok) {
    await billingRepo.logWebhook({ providerId, eventType: parsed.eventType, externalId: parsed.externalId, payload: payloadForLog, processed: false, error: parsed.error });
    return NextResponse.json({ error: parsed.error || 'Rejected' }, { status: 400 });
  }

  let intent = parsed.intentId ? await billingRepo.getIntent(parsed.intentId) : null;
  if (!intent && parsed.externalId) intent = await billingRepo.findIntentByExternal(providerId, parsed.externalId);
  if (!intent) {
    await billingRepo.logWebhook({ providerId, eventType: parsed.eventType, externalId: parsed.externalId, payload: payloadForLog, processed: false, error: 'Intent not found' });
    // T-Bank may notify before Init's external_id has been persisted. Retry,
    // rather than acknowledging an order that cannot yet be reconciled.
    if (providerId === 'tbank') return NextResponse.json({ error: 'Intent not found; retry' }, { status: 503 });
    // 200 so the provider stops retrying for unknown payments
    return NextResponse.json({ ok: true, ignored: true });
  }

  if (providerId === 'tbank') {
    let mismatch: string | undefined;
    if (intent.provider_id !== providerId || parsed.intentId !== intent.id) mismatch = 'Order/provider mismatch';
    else if (!intent.external_id) {
      return NextResponse.json({ error: 'Payment initialization not persisted; retry' }, { status: 503 });
    } else if (intent.external_id !== parsed.externalId) mismatch = 'PaymentId mismatch';
    else if (intent.currency !== parsed.currency || rubToKopecks(intent.amount_rub) !== parsed.amountMinor) mismatch = 'Amount/currency mismatch';
    if (mismatch) {
      await billingRepo.logWebhook({ providerId, eventType: parsed.eventType, externalId: parsed.externalId, payload: payloadForLog, processed: false, error: mismatch });
      return NextResponse.json({ error: mismatch }, { status: 400 });
    }
  }

  let error: string | undefined;
  if (parsed.status === 'paid') {
    const r = await billingRepo.fulfilIntent(intent.id, { externalId: parsed.externalId });
    if (!r.ok) error = r.error;
  } else if (parsed.status === 'failed' || parsed.status === 'canceled') {
    if (intent.status === 'pending') await billingRepo.updatePendingIntent(intent.id, { status: parsed.status });
  }
  await billingRepo.logWebhook({ providerId, eventType: parsed.eventType, externalId: parsed.externalId, payload: payloadForLog, processed: !error, error });

  if (error) return NextResponse.json({ error }, { status: 500 });
  if (providerId === 'tbank') return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  // Robokassa expects "OK{InvId}" as plain text
  if (providerId === 'robokassa') return new Response(`OK${parsed.externalId}`, { status: 200, headers: { 'Content-Type': 'text/plain' } });
  return NextResponse.json({ ok: true });
}

export async function POST(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  try {
    return await handle(req, provider);
  } catch (e: any) {
    console.error('[billing webhook]', provider, e?.message);
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ provider: string }> }) {
  const { provider } = await ctx.params;
  try {
    return await handle(req, provider);
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || 'Internal error' }, { status: 500 });
  }
}
