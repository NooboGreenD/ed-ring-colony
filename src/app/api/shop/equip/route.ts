import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireUser, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const auth = await requireUser(req);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const { category, itemId } = body;
    if (!category) return NextResponse.json({ error: 'Category required' }, { status: 400 });
    try {
      const equipped = await billingRepo.equipCosmetic(auth.actor.userId, category, itemId || null);
      return NextResponse.json({ success: true, equipped });
    } catch (e: any) {
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
  } catch (err) {
    return errorResponse(err);
  }
}
