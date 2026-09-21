import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { errorResponse } from '@/lib/billing/auth';
import { PROVIDER_DRIVERS } from '@/lib/billing/providers';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  try {
    const providers = await billingRepo.getEnabledProviders();
    return NextResponse.json({
      success: true,
      providers: providers.map((p) => ({ id: p.id, name: p.name, methods: p.methods, test_mode: p.test_mode, description: PROVIDER_DRIVERS[p.id]?.description || '' })),
    });
  } catch (err) {
    return errorResponse(err);
  }
}
