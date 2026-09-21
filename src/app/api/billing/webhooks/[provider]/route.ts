import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { getDriver } from '@/lib/billing/providers';

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
  if (!provider.is_enabled) return NextResponse.json({ error: 'Provider disabled' }, { status: 403 });

  const rawBody = req.method === 'GET' ? '' : await req.text();
  const query = new URL(req.url).searchParams;
  let payloadForLog: any = rawBody.length < 20000 ? rawBody : rawBody.slice(0, 20000);
  try {
    payloadForLog = JSON.parse(rawBody);
  } catch {
    /* keep string */
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
    // 200 so the provider stops retrying for unknown payments
    return NextResponse.json({ ok: true, ignored: true });
  }

  let error: string | undefined;
  if (parsed.status === 'paid') {
    const r = await billingRepo.fulfilIntent(intent.id, { externalId: parsed.externalId });
    if (!r.ok) error = r.error;
  } else if (parsed.status === 'failed' || parsed.status === 'canceled') {
    if (intent.status === 'pending') await billingRepo.updateIntent(intent.id, { status: parsed.status });
  }
  await billingRepo.logWebhook({ providerId, eventType: parsed.eventType, externalId: parsed.externalId, payload: payloadForLog, processed: !error, error });

  if (error) return NextResponse.json({ error }, { status: 500 });
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
