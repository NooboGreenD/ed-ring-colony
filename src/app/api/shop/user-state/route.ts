import { NextResponse } from 'next/server';
import { billingRepo } from '@/lib/billingData';
import { authFromRequest } from '@/lib/requestUser';
import { nickFromUser } from '@/lib/authProfile';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(req: Request) {
  try {
    const { user, supabase } = await authFromRequest(req);
    let userId = user?.id || 'preview-user-guest';
    let cmdrName = 'Пилот';
    let role = 'user';

    if (user) {
      const { data: profile } = await supabase.from('profiles').select('cmdr_name, role').eq('id', user.id).maybeSingle();
      cmdrName = profile?.cmdr_name || nickFromUser(user, profile);
      role = profile?.role || 'user';
    } else {
      cmdrName = 'CMDR Guest Navigator';
    }

    const balance = billingRepo.getUserBalance(userId);
    const subscription = billingRepo.getUserSubscription(userId);
    const inventory = billingRepo.getUserInventory(userId);
    const equipped = billingRepo.getUserEquippedCosmetics(userId);

    return NextResponse.json({
      success: true,
      userId,
      cmdrName,
      role,
      balance,
      subscription,
      inventory,
      equipped,
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
