import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { greedyRoute, weightedAStarRoute } from '@/lib/routeEngine';
import type { RouteWaypoint } from '@/types/atlas';

export const dynamic = 'force-dynamic';
interface CoordPoint {
  system_name: string;
  x: number;
  y: number;
  z: number;
}

export async function POST(req: Request) {
  const body = await req.json();
  const { from_system, to_system, via_candidates, engine = 'greedy', jump_range = 30, name } = body;

  if (!from_system || !to_system || !Array.isArray(via_candidates) || via_candidates.length < 2) {
    return NextResponse.json({ error: 'Invalid parameters' }, { status: 400 });
  }

  const supabase = await createClient();
  const allNames = [...new Set([from_system, to_system, ...via_candidates])];
  const { data: coords } = await supabase.from('atlas_candidates').select('system_name, x, y, z').in('system_name', allNames);
  const coordMap = new Map((coords || []).map(c => [c.system_name, c]));
  const from = coordMap.get(from_system);
  const to = coordMap.get(to_system);
  const points = via_candidates
    .map((n: string) => coordMap.get(n))
    .filter((p): p is CoordPoint => !!p);

  if (!from || !to) {
    return NextResponse.json({ error: 'Coordinates not found for from/to systems' }, { status: 404 });
  }

  let waypoints: RouteWaypoint[] = [];
  if (engine === 'greedy') waypoints = greedyRoute(points, from);
  else if (engine === 'weighted_astar') waypoints = weightedAStarRoute(points, from, to, jump_range);
  else return NextResponse.json({ error: 'Unknown engine' }, { status: 400 });

  const totalDistance = waypoints.length > 0 ? waypoints[waypoints.length - 1].cumulative_distance : 0;
  const estimatedJumps = Math.ceil(totalDistance / jump_range);

  const { supabaseAdmin } = await import('@/lib/supabaseAdmin');
  const { data: routeRow, error } = await supabaseAdmin.from('atlas_routes').insert({
    name: name || `${from_system} → ${to_system}`,
    from_system, to_system, engine, jump_range,
    waypoints: waypoints as any, total_distance_ly: totalDistance, estimated_jumps: estimatedJumps,
  }).select().single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ route_id: routeRow.id, waypoints, total_distance_ly: totalDistance, estimated_jumps: estimatedJumps });
}
