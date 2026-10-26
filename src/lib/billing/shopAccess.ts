import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, type BillingActor } from '@/lib/billing/auth';

const SHOP_STAFF_ROLES = ['admin', 'moderator', 'support_manager'];
export const SHOP_SUBSCRIPTION_REQUIRED = 'Для доступа к премиум-магазину нужна активная подписка';

/** Development preview stays usable without a real subscription. */
export async function hasPremiumShopAccess(actor: BillingActor): Promise<boolean> {
  if (actor.isPreview) return true;
  return Boolean(await billingRepo.getUserSubscription(actor.userId));
}

export async function requirePremiumShopAccess(req: Request, options: { allowStaff?: boolean } = {}) {
  const auth = await requireUser(req);
  if ('response' in auth) return auth;
  if (auth.actor.isPreview) return auth;
  if (options.allowStaff && SHOP_STAFF_ROLES.includes(auth.actor.role)) return auth;
  if (!(await hasPremiumShopAccess(auth.actor))) {
    return {
      response: NextResponse.json(
        { error: SHOP_SUBSCRIPTION_REQUIRED, code: 'subscription_required' },
        { status: 403 },
      ),
    };
  }
  return auth;
}
