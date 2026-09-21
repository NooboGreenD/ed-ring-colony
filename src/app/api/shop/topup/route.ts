import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/**
 * Deprecated: direct top-ups are no longer allowed — money must go through a
 * payment provider. Use POST /api/billing/checkout with purpose=credit_topup.
 */
export async function POST(req: Request) {
  const url = new URL(req.url);
  return NextResponse.json(
    { error: 'Пополнение выполняется через платёжную систему: POST /api/billing/checkout { purpose: "credit_topup", packId, providerId }', redirect: `${url.origin}/api/billing/checkout` },
    { status: 410 },
  );
}
