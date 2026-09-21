import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const plans = await billingRepo.getPlans();
    return NextResponse.json({ success: true, plans });
  } catch (err) {
    return errorResponse(err);
  }
}
