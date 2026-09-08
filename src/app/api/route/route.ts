import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export async function GET() {
  const supabase = await createClient();
  const { data: points, error } = await supabase
    .from('route_systems')
    .select('id, system_name, sort_order, x, y, z, status, progress')
    .order('sort_order', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  // Подтягиваем актуальные статусы из system_progress (RavenColonial)
  const { data: progressData, error: progressError } = await supabase
    .from('system_progress')
    .select('system_name, progress');

  const progressMap = new Map<string, number | null>();
  if (!progressError && Array.isArray(progressData)) {
    for (const row of progressData) {
      progressMap.set(String(row.system_name).toLowerCase(), row.progress);
    }
  }

  const enriched = (points || []).map(p => {
    const freshProgress = progressMap.get(p.system_name.toLowerCase());
    const status = freshProgress == null ? p.status : freshProgress >= 100 ? 'done' : freshProgress > 0 ? 'building' : 'planned';
    return {
      ...p,
      status,
      progress: freshProgress ?? p.progress ?? 0,
    };
  });

  return NextResponse.json({ points: enriched });
}
