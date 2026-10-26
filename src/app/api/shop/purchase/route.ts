import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { errorResponse } from '@/lib/billing/auth';
import { requirePremiumShopAccess } from '@/lib/billing/shopAccess';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Purchase with credits. Card/other real-money purchases go through /api/billing/checkout. */
export async function POST(req: Request) {
  try {
    const access = await requirePremiumShopAccess(req);
    if ('response' in access) return access.response;
    const { actor } = access;
    const body = await req.json().catch(() => ({}));
    const { itemId, autoEquip = true } = body;
    if (!itemId) return NextResponse.json({ error: 'Item ID required' }, { status: 400 });

    const result = await billingRepo.purchaseItem({ userId: actor.userId, cmdrName: actor.cmdrName, itemId, useCredits: true, autoEquip });
    if (!result.success) return NextResponse.json({ error: result.error }, { status: 400 });

    const [equipped, inventory] = await Promise.all([billingRepo.getUserEquippedCosmetics(actor.userId), billingRepo.getUserInventory(actor.userId)]);
    return NextResponse.json({ success: true, item: result.item, balance: result.balance, transaction: result.transaction, equipped, inventory });
  } catch (err) {
    return errorResponse(err);
  }
}
