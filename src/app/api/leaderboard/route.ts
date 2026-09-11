import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 1000;

type LeaderboardStats = {
  cmdr_name: string;
  total_amount: number;
  hubs_visited: Set<string>;
  systems_visited: Set<string>;
  route_systems_visited: Set<number>;
  deliveries_count: number;
  commodities: Map<string, { commodity: string; amount: number }>;
};

function systemKey(value: unknown): string {
  return String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function validLimit(value: string | null): number {
  const parsed = Number.parseInt(value || '50', 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, 200)) : 50;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const period = searchParams.get('period') || 'all';
  const limit = validLimit(searchParams.get('limit'));
  const supabase = await createClient();
  const since = period === 'week'
    ? new Date(Date.now() - 7 * 86400000).toISOString()
    : period === 'month'
      ? new Date(Date.now() - 30 * 86400000).toISOString()
      : null;

  const byUser = new Map<string, LeaderboardStats>();
  let offset = 0;

  // PostgREST returns at most its configured maximum (commonly 1,000 rows),
  // even when a select has no explicit limit. Aggregate pages instead of
  // silently ranking only the first page of deliveries.
  while (true) {
    let query = supabase
      .from('deliveries')
      .select('id, user_id, system_name, amount, delivered_at, is_hub, route_system_id, commodity, profiles!inner(cmdr_name)')
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);

    if (since) query = query.gte('delivered_at', since);

    const { data: deliveries, error } = await query;
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    for (const delivery of deliveries || []) {
      const userId = String(delivery.user_id || '');
      if (!userId) continue;
      const profile = Array.isArray(delivery.profiles) ? delivery.profiles[0] : delivery.profiles;
      const cmdrName = profile?.cmdr_name || 'Unknown';
      let stats = byUser.get(userId);
      if (!stats) {
        stats = {
          cmdr_name: cmdrName,
          total_amount: 0,
          hubs_visited: new Set(),
          systems_visited: new Set(),
          route_systems_visited: new Set(),
          deliveries_count: 0,
          commodities: new Map(),
        };
        byUser.set(userId, stats);
      } else if (stats.cmdr_name === 'Unknown' && cmdrName !== 'Unknown') {
        stats.cmdr_name = cmdrName;
      }

      const amount = Number(delivery.amount);
      if (!Number.isFinite(amount) || amount <= 0) continue;
      const normalizedSystem = systemKey(delivery.system_name);
      stats.total_amount += amount;
      stats.deliveries_count += 1;
      if (normalizedSystem) {
        stats.systems_visited.add(normalizedSystem);
        if (delivery.is_hub) stats.hubs_visited.add(normalizedSystem);
      }

      const routeSystemId = Number(delivery.route_system_id);
      if (Number.isSafeInteger(routeSystemId) && routeSystemId > 0) {
        stats.route_systems_visited.add(routeSystemId);
      }

      const commodity = String(delivery.commodity || '').trim() || 'Unknown commodity';
      const commodityKey = commodity.toLowerCase();
      const existing = stats.commodities.get(commodityKey);
      if (existing) existing.amount += amount;
      else stats.commodities.set(commodityKey, { commodity, amount });
    }

    if (!deliveries || deliveries.length < PAGE_SIZE) break;
    offset += deliveries.length;
  }

  const leaderboard = Array.from(byUser.entries())
    .map(([user_id, stats]) => ({
      user_id,
      cmdr_name: stats.cmdr_name,
      total_amount: stats.total_amount,
      hubs_visited: stats.hubs_visited.size,
      systems_visited: stats.systems_visited.size,
      route_systems_visited: stats.route_systems_visited.size,
      deliveries_count: stats.deliveries_count,
      commodities: Array.from(stats.commodities.values()).sort((left, right) => right.amount - left.amount),
    }))
    .sort((left, right) => right.total_amount - left.total_amount || left.cmdr_name.localeCompare(right.cmdr_name))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, rank: index + 1 }));

  return NextResponse.json(
    { leaderboard },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
