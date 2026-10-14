import { resolveCommodity } from '@/lib/commodities';
import { marketError } from '@/lib/marketUpstream';
import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const commodity = resolveCommodity(url.searchParams.get('commodity') || '');
    const system = url.searchParams.get('system');
    const requestedLimit = Number(url.searchParams.get('limit') || 50);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.floor(requestedLimit), 100))
      : 50;
    const pattern = commodity
      .replace(/[\\%_]/g, '\\$&')
      .replace(/[\s-]+/g, '%');

    if (!commodity) {
      return NextResponse.json(
        { error: 'commodity required' },
        { status: 400 }
      );
    }

    const svc = createServiceClient();
    // Use complete station snapshots first. Old installations without the
    // commerce migration keep the legacy endpoint until deployment completes.
    try {
      const { data, error } = await svc.rpc('search_station_commodity', {
        search_name: commodity, system_filter: system, row_limit: limit,
      });
      if (!error) return NextResponse.json({ prices: data || [] });
      console.warn('[Market Search] commerce query unavailable:', error.message);
    } catch {
      // Legacy database/client fallback.
    }
    let query = svc
      .from('market_prices')
      .select('*')
      .ilike('commodity_name', `%${pattern}%`)
      .gt('stock', 0)
      .order('buy_price', { ascending: true })
      .limit(limit);

    if (system) {
      query = query.ilike('system_name', `%${system}%`);
    }

    const { data, error } = await query;
    if (error)
      return NextResponse.json(
        { error: marketError(new Error(error.message)) },
        { status: 503 }
      );

    return NextResponse.json({ prices: data });
  } catch (error) {
    return NextResponse.json({ error: marketError(error) }, { status: 503 });
  }
}
