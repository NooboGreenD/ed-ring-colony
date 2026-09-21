import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const { user } = await authFromRequest(req);
    const { searchParams } = new URL(req.url);
    const category = searchParams.get('category') || undefined;
    const rarity = searchParams.get('rarity') || undefined;
    const search = searchParams.get('search') || undefined;

    const rawItems = billingRepo.getShopItems({ category, rarity, search });

    // If user is authenticated, check their active subscription for discounts
    let sub = user ? billingRepo.getUserSubscription(user.id) : null;
    let userTier = sub?.plan_id || null;

    const items = rawItems.map((item) => {
      let discountPct = item.subscriber_discount_pct || 0;
      if (sub) {
        if (sub.plan_id === 'admiral') discountPct = Math.max(discountPct, 75);
        else if (sub.plan_id === 'elite') discountPct = Math.max(discountPct, 50);
        else if (sub.plan_id === 'pioneer') discountPct = Math.max(discountPct, 25);
      }

      const discountedCredits = Math.round(item.price_credits * (1 - discountPct / 100));
      const discountedRub = Math.round(item.price_rub * (1 - discountPct / 100));

      return {
        ...item,
        applied_discount_pct: discountPct,
        final_price_credits: discountedCredits,
        final_price_rub: discountedRub,
        is_locked_for_user: item.requires_subscription
          ? !sub || (item.requires_subscription === 'admiral' && sub.plan_id !== 'admiral')
          : false,
      };
    });

    return NextResponse.json({ success: true, items, userTier });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
