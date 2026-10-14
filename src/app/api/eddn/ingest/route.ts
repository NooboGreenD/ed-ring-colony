import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';
import { findSystemByName } from '@/lib/galaxySystemsDb';
import { saveStationReport, validTime } from '@/lib/stationCommerce';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  const secret = req.headers.get('x-eddn-secret');
  if (!process.env.EDDN_INGEST_SECRET || secret !== process.env.EDDN_INGEST_SECRET)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  try {
    const data = await req.json();
    const msg = data?.message;
    const schema = String(data?.$schemaRef || '');
    if (schema.includes('/test')) return NextResponse.json({ ignored: true });
    const kind = Array.isArray(msg?.commodities) ? 'market'
      : Array.isArray(msg?.modules) ? 'outfitting' : Array.isArray(msg?.ships) ? 'shipyard' : null;
    const observed_at = validTime(msg?.timestamp);
    if (!kind || !observed_at || !msg.systemName || !msg.stationName)
      return NextResponse.json({ error: 'Invalid message' }, { status: 400 });
    const raw = msg[kind === 'market' ? 'commodities' : kind === 'outfitting' ? 'modules' : 'ships'];
    if (raw.length > 5000) return NextResponse.json({ error: 'Inventory too large' }, { status: 413 });
    const svc = createServiceClient();
    const system = await findSystemByName(msg.systemName).catch(() => null);
    const coords = msg.systemCoordinates || (system ? { x: system.x, y: system.y, z: system.z } : {});
    try {
      await saveStationReport(svc, {
        system_name: msg.systemName, station_name: msg.stationName,
        market_id: msg.marketId != null ? String(msg.marketId) : undefined,
        ...coords, observed_at, inventories: {
          [kind]: { observed_at, items: raw.map((item: any) => typeof item === 'string' ? { name: item } : item) },
        },
      }, 'eddn');
    } catch (error: any) {
      if (error?.name === 'ZodError') return NextResponse.json({ error: 'Invalid inventory' }, { status: 400 });
      throw error;
    }
    // Preserve the legacy commodity API for Architect and existing consumers.
    if (kind === 'market' && raw.length) {
      const rows = raw.map((c: any) => ({
        station_name: msg.stationName, system_name: msg.systemName,
        commodity_name: c.name, buy_price: c.buyPrice, sell_price: c.sellPrice,
        demand: c.demand, demand_bracket: c.demandBracket, stock: c.stock,
        stock_bracket: c.stockBracket, mean_price: c.meanPrice, reported_at: observed_at,
      }));
      const { error } = await svc.from('market_prices').upsert(rows, { onConflict: 'station_name,system_name,commodity_name' });
      if (error) throw new Error(error.message);
    }
    return NextResponse.json({ inserted: raw.length, kind });
  } catch (error) {
    console.error('[EDDN Ingest]', error);
    return NextResponse.json({ error: 'Station ingest failed' }, { status: 503 });
  }
}
