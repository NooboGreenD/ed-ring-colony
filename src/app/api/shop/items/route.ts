import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { billingActor, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const actor = await billingActor(req);
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category') || undefined;
    const rarity = searchParams.get('rarity') || undefined;
    const search = searchParams.get('search') || undefined;

    const [rawItems, plans, discount] = await Promise.all([
      billingRepo.getShopItems({ category, rarity, search }),
      billingRepo.getPlans(),
      billingRepo.getUserDiscountPct(actor?.userId),
    ]);
    const sub = discount.sub;
    const haveOrder = sub?.plan?.display_order ?? -1;

    const items = rawItems.map((item) => {
      const discountPct = Math.min(100, Math.max(sub && item.subscriber_discount_pct ? item.subscriber_discount_pct : 0, discount.pct));
      let locked = false;
      if (item.requires_subscription) {
        const req = plans.find((p) => p.id === item.requires_subscription);
        locked = !sub || haveOrder < (req?.display_order ?? 0);
      }
      return {
        ...item,
        applied_discount_pct: discountPct,
        final_price_credits: Math.round(item.price_credits * (1 - discountPct / 100)),
        final_price_rub: Math.round(item.price_rub * (1 - discountPct / 100)),
        is_locked_for_user: locked,
      };
    });

    return NextResponse.json({ success: true, items, userTier: sub?.plan_id || null, plans });
  } catch (err) {
    return errorResponse(err);
  }
}
