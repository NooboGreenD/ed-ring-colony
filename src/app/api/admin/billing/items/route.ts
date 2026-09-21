import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { requireStaff, requireAdmin, errorResponse } from '@/lib/billing/auth';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

/** Product (shop item) management. */
export async function GET(req: Request) {
  try {
    const auth = await requireStaff(req);
    if ('response' in auth) return auth.response;
    const { searchParams } = new URL(req.url);
    const items = await billingRepo.getShopItems({
      includeInactive: true,
      category: searchParams.get('category') || undefined,
      rarity: searchParams.get('rarity') || undefined,
      search: searchParams.get('search') || undefined,
    });
    const plans = await billingRepo.getPlans(true);
    return NextResponse.json({ success: true, items, plans });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const body = await req.json();
    if (body.action === 'grant') {
      const { userId, cmdrName, itemId } = body;
      if (!userId || !itemId) return NextResponse.json({ error: 'userId и itemId обязательны' }, { status: 400 });
      const r = await billingRepo.grantItem({ userId, cmdrName: cmdrName || '', itemId, adminName: auth.actor.cmdrName });
      if (!r.success) return NextResponse.json({ error: r.error }, { status: 400 });
      return NextResponse.json({ success: true, item: r.item, transaction: r.transaction });
    }
    if (!body?.title || !body?.category) return NextResponse.json({ error: 'Название и категория обязательны' }, { status: 400 });
    const item = await billingRepo.createShopItem(body);
    return NextResponse.json({ success: true, item });
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const { id, ...updates } = await req.json();
    if (!id) return NextResponse.json({ error: 'Item ID required' }, { status: 400 });
    const item = await billingRepo.updateShopItem(id, updates);
    if (!item) return NextResponse.json({ error: 'Item not found' }, { status: 404 });
    return NextResponse.json({ success: true, item });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function DELETE(req: Request) {
  try {
    const auth = await requireAdmin(req);
    if ('response' in auth) return auth.response;
    const id = new URL(req.url).searchParams.get('id');
    if (!id) return NextResponse.json({ error: 'Item ID required' }, { status: 400 });
    const r = await billingRepo.deleteShopItem(id);
    return NextResponse.json({ success: true, ...r, message: r.deleted ? 'Товар удалён' : `Товар архивирован: им владеют ${r.owners} пилот(ов)` });
  } catch (err) {
    return errorResponse(err);
  }
}
