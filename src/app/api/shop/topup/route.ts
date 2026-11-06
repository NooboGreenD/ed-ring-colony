import { NextResponse } from 'next/server';
import { apiTranslate } from '@/lib/i18n/apiT';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Deprecated: direct top-ups are no longer allowed — money must go through a
 * payment provider. Use POST /api/billing/checkout with purpose=credit_topup.
 */
export async function POST(req: Request) {
  const t = await apiTranslate();
  const url = new URL(req.url);
  return NextResponse.json(
    { error: t('shop.topupViaCheckout'), redirect: `${url.origin}/api/billing/checkout` },
    { status: 410 },
  );
}
