import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const { searchParams } = new URL(req.url);
    const [intents, webhooks] = await Promise.all([
      billingRepo.listIntents({ status: searchParams.get('status') || 'all', limit: Number(searchParams.get('limit')) || 100 }),
      billingRepo.listWebhookEvents(30),
    ]);
    return NextResponse.json({ success: true, intents, webhooks });
  } catch (err) {
    return errorResponse(err);
  }
}

/** POST { id, action: 'confirm' | 'cancel' } — manual confirmation (e.g. bank transfer). */
export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { id, action } = await req.json();
    const intent = await billingRepo.getIntent(id);
    if (!intent) return NextResponse.json({ error: 'Платёж не найден' }, { status: 404 });
    if (action === 'confirm') {
      const r = await billingRepo.fulfilIntent(id, { externalId: intent.external_id || `manual-${auth.actor.cmdrName}`, method: intent.provider_id === 'manual' ? 'manual' : undefined });
      if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 });
      await billingRepo.logWebhook({ providerId: intent.provider_id || 'manual', eventType: 'admin_confirm', externalId: intent.external_id || undefined, payload: { admin: auth.actor.cmdrName }, processed: true });
      return NextResponse.json({ success: true, intent: r.intent, already: r.already });
    }
    if (action === 'cancel') {
      if (intent.status !== 'pending') return NextResponse.json({ error: 'Можно отменить только ожидающий платёж' }, { status: 400 });
      const updated = await billingRepo.updatePendingIntent(id, { status: 'canceled' });
      return NextResponse.json({ success: true, intent: updated });
    }
    return NextResponse.json({ error: 'Неизвестное действие' }, { status: 400 });
  } catch (err) {
    return errorResponse(err);
  }
}
