import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') || 'all';
  const limit = Math.min(parseInt(searchParams.get('limit') || '50'), 200);

  const supabase = await createClient();

  // Фильтр по периоду
  let query = supabase.from('deliveries').select('user_id, system_name, amount, delivered_at, is_hub, commodity, profiles!inner(cmdr_name)');
  
  if (period === 'week') {
    const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    query = query.gte('delivered_at', weekAgo);
  } else if (period === 'month') {
    const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString();
    query = query.gte('delivered_at', monthAgo);
  }

  const { data: deliveries, error: dErr } = await query;

  if (dErr) return NextResponse.json({ error: dErr.message }, { status: 500 });

  const byUser = new Map<string, {
    cmdr_name: string;
    total_amount: number;
    hubs_visited: Set<string>;
    systems_visited: Set<string>;
    route_systems_visited: Set<number>;
    deliveries_count: number;
    commodities: Map<string, number>;
  }>();

  (deliveries || []).forEach((d: any) => {
    const uid = d.user_id;
    const name = d.profiles?.cmdr_name || 'Unknown';
    if (!byUser.has(uid)) {
      byUser.set(uid, {
        cmdr_name: name,
        total_amount: 0,
        hubs_visited: new Set(),
        systems_visited: new Set(),
        route_systems_visited: new Set(),
        deliveries_count: 0,
        commodities: new Map(),
      });
    }
    const u = byUser.get(uid)!;
    u.total_amount += d.amount || 0;
    u.deliveries_count += 1;
    u.systems_visited.add(d.system_name);
    if (d.is_hub) u.hubs_visited.add(d.system_name);
    if (d.route_system_id) u.route_systems_visited.add(d.route_system_id);
    u.commodities.set(d.commodity, (u.commodities.get(d.commodity) || 0) + d.amount);
  });

  let leaderboard = Array.from(byUser.entries())
    .map(([user_id, stats]) => ({
      user_id,
      cmdr_name: stats.cmdr_name,
      total_amount: stats.total_amount,
      hubs_visited: stats.hubs_visited.size,
      systems_visited: stats.systems_visited.size,
      route_systems_visited: stats.route_systems_visited.size,
      deliveries_count: stats.deliveries_count,
      commodities: Array.from(stats.commodities.entries()).map(([commodity, amount]) => ({ commodity, amount })),
    }))
    .sort((a, b) => b.total_amount - a.total_amount)
    .slice(0, limit)
    .map((e, i) => ({ ...e, rank: i + 1 }));

  return NextResponse.json({ leaderboard });
}
