import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const commodity = url.searchParams.get('commodity');
  const system = url.searchParams.get('system');
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50'), 100);

  if (!commodity) {
    return NextResponse.json({ error: 'commodity required' }, { status: 400 });
  }

  const svc = createServiceClient();
  let query = svc
    .from('market_prices')
    .select('*')
    .ilike('commodity_name', `%${commodity}%`)
    .gt('stock', 0)
    .order('sell_price', { ascending: true })
    .limit(limit);

  if (system) {
    query = query.ilike('system_name', `%${system}%`);
  }

  const { data, error } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ prices: data });
}
