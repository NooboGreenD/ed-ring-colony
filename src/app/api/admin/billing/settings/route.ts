import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const settings = await billingRepo.getSettings();
    return NextResponse.json({ success: true, settings, backend: await billingRepo.backendKind });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const body = await req.json();
    const settings = await billingRepo.updateSettings(body);
    return NextResponse.json({ success: true, settings });
  } catch (err) {
    return errorResponse(err);
  }
}
