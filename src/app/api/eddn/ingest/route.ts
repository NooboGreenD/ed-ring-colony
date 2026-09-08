import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = req.headers.get('x-eddn-secret');
  if (secret !== process.env.EDDN_INGEST_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const data = await req.json();
  const msg = data.message;

  if (!msg?.commodities || !msg.systemName || !msg.stationName) {
    return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
  }

  const svc = createServiceClient();
  const rows = msg.commodities.map((c: any) => ({
    station_name: msg.stationName,
    system_name: msg.systemName,
    commodity_name: c.name,
    buy_price: c.buyPrice,
    sell_price: c.sellPrice,
    demand: c.demand,
    demand_bracket: c.demandBracket,
    stock: c.stock,
    stock_bracket: c.stockBracket,
    mean_price: c.meanPrice,
    reported_at: msg.timestamp,
  }));

  const { error } = await svc.from('market_prices').upsert(rows, {
    onConflict: 'station_name,system_name,commodity_name',
  });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ inserted: rows.length });
}
