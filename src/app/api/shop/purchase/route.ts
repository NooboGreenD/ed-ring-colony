import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';
import { nickFromUser } from '@/lib/authProfile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    const body = await req.json();
    const { itemId, useCredits = true, autoEquip = true } = body;

    if (!itemId) {
      return NextResponse.json({ error: 'Item ID required' }, { status: 400 });
    }

    let userId = user?.id || 'preview-user-guest';
    let cmdrName = 'Пилот';

    if (user) {
      const { data: profile } = await supabase.from('profiles').select('cmdr_name').eq('id', user.id).maybeSingle();
      cmdrName = profile?.cmdr_name || nickFromUser(user, profile);
    } else {
      cmdrName = 'CMDR Guest Navigator';
    }

    const result = billingRepo.purchaseItem({
      userId,
      cmdrName,
      itemId,
      useCredits,
      autoEquip,
    });

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    const equipped = billingRepo.getUserEquippedCosmetics(userId);
    const inventory = billingRepo.getUserInventory(userId);

    return NextResponse.json({
      success: true,
      item: result.item,
      balance: result.balance,
      transaction: result.transaction,
      equipped,
      inventory,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
