import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const plans = await billingRepo.getPlans(true);
    return NextResponse.json({ success: true, plans });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const body = await req.json();
    if (!body?.name) return NextResponse.json({ error: 'Название обязательно' }, { status: 400 });
    const plan = await billingRepo.createPlan(body);
    return NextResponse.json({ success: true, plan });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { id, ...updates } = await req.json();
    if (!id) return NextResponse.json({ error: 'Plan ID required' }, { status: 400 });
    const updated = await billingRepo.updatePlan(id, updates);
    if (!updated) return NextResponse.json({ error: 'Plan not found' }, { status: 404 });
    return NextResponse.json({ success: true, plan: updated });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Plan ID required' }, { status: 400 });
    const ok = await billingRepo.deletePlan(id);
    return NextResponse.json({ success: ok });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
