import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, errorResponse } from '@/lib/billing/auth';
import { getDriver } from '@/lib/billing/providers';
import { getSiteUrl } from '@/lib/siteUrl';
import type { PaymentPurpose } from '@/types/billing';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

function siteUrl(req: Request) {
  try {
    return getSiteUrl();
  } catch {
    return new URL(req.url).origin;
  }
}

/**
 * Creates a payment intent for a real-money purchase and returns the
 * provider's payment URL. Fulfilment happens in the provider webhook.
 *
 * body: { providerId, purpose: 'credit_topup'|'subscription'|'shop_purchase', packId?, planId?, itemId? }
 */
export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ('response' in auth) return auth.response;
    const { actor } = auth;
    if (actor.isPreview) return NextResponse.json({ error: 'Войдите в аккаунт, чтобы оплатить' }, { status: 401 });

    const body = await req.json().catch(() => ({}));
    const purpose = body.purpose as PaymentPurpose;
    const providerId = String(body.providerId || '');
    if (!['credit_topup', 'subscription', 'shop_purchase'].includes(purpose)) return NextResponse.json({ error: 'Неверная цель платежа' }, { status: 400 });

    const provider = await billingRepo.getProvider(providerId);
    const driver = getDriver(providerId);
    if (!provider || !driver || !provider.is_enabled || !driver.isConfigured(provider.config)) {
      return NextResponse.json({ error: 'Платёжная система недоступна' }, { status: 400 });
    }

    // Real T-Bank payments must never run on the development JSON fallback.
    if (providerId === 'tbank' && !provider.test_mode && await billingRepo.backendKind !== 'supabase') {
      return NextResponse.json({ error: 'Для боевых платежей Т-Банка требуется хранилище Supabase' }, { status: 503 });
    }
    if (providerId === 'tbank') {
      const configCheck = await driver.check(provider);
      if (!configCheck.ok) return NextResponse.json({ error: configCheck.message }, { status: 400 });
    }

    let amountRub = 0;
    let amountCredits = 0;
    let targetId: string | null = null;
    let description = '';

    if (purpose === 'credit_topup') {
      const settings = await billingRepo.getSettings();
      const pack = settings.credit_packs.find((p) => p.id === body.packId);
      if (!pack) return NextResponse.json({ error: 'Пакет кредитов не найден' }, { status: 400 });
      amountRub = pack.price_rub;
      amountCredits = Math.round(pack.credits * (1 + (pack.bonus_pct || 0) / 100));
      targetId = pack.id;
      description = `ED Ring Colony: ${amountCredits} кредитов`;
    } else if (purpose === 'subscription') {
      const plan = await billingRepo.getPlanById(String(body.planId || ''));
      if (!plan || !plan.is_active || !plan.price_rub) return NextResponse.json({ error: 'План недоступен для оплаты' }, { status: 400 });
      amountRub = plan.price_rub;
      targetId = plan.id;
      description = `ED Ring Colony: подписка «${plan.name}» ${plan.period_days} дн`;
    } else {
      const item = await billingRepo.getShopItemById(String(body.itemId || ''));
      if (!item || !item.is_active) return NextResponse.json({ error: 'Товар не найден' }, { status: 400 });
      if (await billingRepo.userOwnsItem(actor.userId, item.id)) return NextResponse.json({ error: 'Вы уже владеете этим предметом' }, { status: 400 });
      const price = await billingRepo.priceFor(item, actor.userId);
      if (price.locked) return NextResponse.json({ error: price.lockReason }, { status: 400 });
      if (!price.rub) return NextResponse.json({ error: 'Этот товар продаётся только за кредиты' }, { status: 400 });
      amountRub = price.rub;
      targetId = item.id;
      description = `ED Ring Colony: ${item.title}`;
    }

    if (amountRub <= 0) return NextResponse.json({ error: 'Некорректная сумма' }, { status: 400 });

    const intent = await billingRepo.createIntent({
      userId: actor.userId,
      cmdrName: actor.cmdrName,
      providerId,
      purpose,
      targetId,
      amountRub,
      amountCredits,
      metadata: { description, email: actor.email },
    });

    const returnUrl = `${siteUrl(req)}/premium-shop/pay/${intent.id}`;
    try {
      const created = await driver.createPayment(provider, { intent, description, returnUrl, customerEmail: actor.email });
      const updated = await billingRepo.updateIntent(intent.id, { external_id: created.externalId, payment_url: created.paymentUrl, metadata: { ...intent.metadata, providerRaw: created.raw ? { id: created.raw.id, status: created.raw.status } : undefined } });
      return NextResponse.json({ success: true, intent: updated, paymentUrl: created.paymentUrl });
    } catch (e: any) {
      await billingRepo.updatePendingIntent(intent.id, { status: 'failed', metadata: { ...intent.metadata, error: e?.message } });
      return NextResponse.json({ error: e?.message || 'Не удалось создать платёж' }, { status: 502 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
