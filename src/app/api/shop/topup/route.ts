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
    const { amountCredits, amountRub, paymentMethod = 'sbp' } = body;

    if (!amountCredits || !amountRub) {
      return NextResponse.json({ error: 'Amounts required' }, { status: 400 });
    }

    let userId = user?.id || 'preview-user-guest';
    let cmdrName = 'Пилот';

    if (user) {
      const { data: profile } = await supabase.from('profiles').select('cmdr_name').eq('id', user.id).maybeSingle();
      cmdrName = profile?.cmdr_name || nickFromUser(user, profile);
    } else {
      cmdrName = 'CMDR Guest Navigator';
    }

    const { balance, transaction } = billingRepo.topupBalance({
      userId,
      cmdrName,
      amountCredits: Number(amountCredits),
      amountRub: Number(amountRub),
      paymentMethod,
    });

    return NextResponse.json({ success: true, balance, transaction });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || 'Internal Server Error' }, { status: 500 });
  }
}
