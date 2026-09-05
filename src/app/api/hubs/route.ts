import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export async function GET() {
  const supabase = await createClient();
  const { data: hubs, error: hubsError } = await supabase
    .from('hubs')
    .select('*')
    .order('id');

  if (hubsError) return NextResponse.json({ error: hubsError.message }, { status: 500 });

  const { data: goals, error: goalsError } = await supabase
    .from('hub_goals')
    .select('*');

  if (goalsError) return NextResponse.json({ error: goalsError.message }, { status: 500 });

  const goalsByHub = new Map<number, typeof goals>();
  for (const g of (goals || [])) {
    if (!goalsByHub.has(g.hub_id)) goalsByHub.set(g.hub_id, []);
    goalsByHub.get(g.hub_id)!.push(g);
  }

  const enriched = (hubs || []).map(h => ({
    ...h,
    goals: goalsByHub.get(h.id) || [],
    overall_progress: calculateOverallProgress(goalsByHub.get(h.id) || []),
  }));

  return NextResponse.json({ hubs: enriched });
}

function calculateOverallProgress(goals: any[]): number {
  if (!goals.length) return 0;
  const totalTarget = goals.reduce((sum, g) => sum + g.target_amount, 0);
  const totalCurrent = goals.reduce((sum, g) => sum + g.current_amount, 0);
  if (totalTarget === 0) return 0;
  return Math.min(100, Math.round((totalCurrent / totalTarget) * 100));
}
