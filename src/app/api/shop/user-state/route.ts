import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { billingActor, errorResponse } from '@/lib/billing/auth';
import { PROVIDER_DRIVERS } from '@/lib/billing/providers';
import { apiTranslate } from '@/lib/i18n/apiT';
import { DEFAULT_BONUS } from '@/lib/billing/subscriptionBonus';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  const t = await apiTranslate();
  try {
    const actor = await billingActor(req);
    if (!actor) {
      const [plans, settings] = await Promise.all([billingRepo.getPlans(), billingRepo.getSettings()]);
      return NextResponse.json({ success: true, authenticated: false, userId: null, cmdrName: t('shop.guest'), role: 'guest', balance: null, subscription: null, inventory: [], equipped: null, plans, settings: publicSettings(settings), providers: [], subscriptionBonus: DEFAULT_BONUS });
    }
    const [balance, subscription, inventory, equipped, plans, settings, providers, pending] = await Promise.all([
      billingRepo.getUserBalance(actor.userId),
      billingRepo.getUserSubscription(actor.userId),
      billingRepo.getUserInventory(actor.userId),
      billingRepo.getUserEquippedCosmetics(actor.userId),
      billingRepo.getPlans(),
      billingRepo.getSettings(),
      billingRepo.getEnabledProviders(),
      billingRepo.listIntents({ userId: actor.userId, status: 'pending', limit: 5 }),
    ]);

    const bonus = actor.isPreview
      ? DEFAULT_BONUS
      : await billingRepo.getUserSubscriptionBonus(actor.userId);

    return NextResponse.json({
      success: true,
      authenticated: !actor.isPreview,
      isPreview: actor.isPreview,
      userId: actor.userId,
      cmdrName: actor.cmdrName,
      role: actor.role,
      balance,
      subscription,
      inventory,
      equipped,
      plans,
      settings: publicSettings(settings),
      providers: providers.map((p) => ({ id: p.id, name: p.name, methods: p.methods, test_mode: p.test_mode, description: PROVIDER_DRIVERS[p.id]?.description || '' })),
      pendingPayments: pending.map((p) => ({ id: p.id, purpose: p.purpose, amount_rub: p.amount_rub, payment_url: p.payment_url, provider_id: p.provider_id, created_at: p.created_at })),
      subscriptionBonus: {
        planId: bonus.planId,
        planName: bonus.planName,
        color: bonus.color,
        atlasFavoritesLimit: bonus.atlasFavoritesLimit,
        squadronMemberLimitBonus: bonus.squadronMemberLimitBonus,
        topupCreditBonusPct: bonus.topupCreditBonusPct,
        deliveryTonnageBonusPct: bonus.deliveryTonnageBonusPct,
        shopDiscountPct: bonus.shopDiscountPct,
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}

function publicSettings(s: Awaited<ReturnType<typeof billingRepo.getSettings>>) {
  return { credit_packs: s.credit_packs, currency: s.currency, shop_enabled: s.shop_enabled, welcome_credits: s.welcome_credits };
}
