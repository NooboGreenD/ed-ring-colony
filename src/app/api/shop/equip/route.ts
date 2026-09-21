import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const { user } = await authFromRequest(req);
    const body = await req.json();
    const { category, itemId } = body;

    if (!category) return NextResponse.json({ error: 'Category required' }, { status: 400 });

    const userId = user?.id || 'preview-user-guest';
    const equipped = billingRepo.equipCosmetic(userId, category, itemId || null);

    return NextResponse.json({ success: true, equipped });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
