import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';
import { mergeProgressIntoMap } from '@/lib/systemProgress';

export const dynamic = 'force-dynamic';

export async function GET() {
  const supabase = await createClient();
  const [{ data: points, error }, { data: progressData, error: progressError }] = await Promise.all([
    supabase
      .from('route_systems')
      .select('id, system_name, sort_order, x, y, z, status, progress')
      .order('sort_order', { ascending: true }),
    supabase
      .from('system_progress')
      .select('system_name, progress, updated_at'),
  ]);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  if (progressError) {
    console.warn('[route] Failed to read system_progress:', progressError.message);
  }

  // `mergeProgressIntoMap` keeps a genuine 0% value, resolves legacy
  // case-variant cache rows by updated_at, and derives the status from the
  // same percentage shown by the marker.
  const enriched = mergeProgressIntoMap(points, progressError ? [] : progressData);

  return NextResponse.json(
    { points: enriched },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
