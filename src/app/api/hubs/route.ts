import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { mergeProgressIntoMap } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const [{ data: hubs, error: hubsError }, { data: goals, error: goalsError }, { data: progressData, error: progressError }] = await Promise.all([
    supabase.from('hubs').select('*').order('id'),
    supabase.from('hub_goals').select('*'),
    supabase.from('system_progress').select('system_name, progress, updated_at'),
  ]);

  if (hubsError) return NextResponse.json({ error: hubsError.message }, { status: 500 });
  if (goalsError) return NextResponse.json({ error: goalsError.message }, { status: 500 });

  if (progressError) {
    console.warn('[hubs] Failed to read system_progress:', progressError.message);
  }

  const goalsByHub = new Map<number, typeof goals>();
  for (const goal of goals || []) {
    if (!goalsByHub.has(goal.hub_id)) goalsByHub.set(goal.hub_id, []);
    goalsByHub.get(goal.hub_id)!.push(goal);
  }

  const withProgress = mergeProgressIntoMap(hubs, progressError ? [] : progressData);
  const enriched = withProgress.map((hub) => ({
    ...hub,
    goals: goalsByHub.get(hub.id) || [],
    overall_progress: calculateOverallProgress(goalsByHub.get(hub.id) || []),
  }));

  return NextResponse.json(
    { hubs: enriched },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}

function calculateOverallProgress(goals: any[]): number {
  if (!goals.length) return 0;
  const totalTarget = goals.reduce((sum, goal) => sum + goal.target_amount, 0);
  const totalCurrent = goals.reduce((sum, goal) => sum + goal.current_amount, 0);
  if (totalTarget === 0) return 0;
  return Math.min(100, Math.round((totalCurrent / totalTarget) * 100));
}
