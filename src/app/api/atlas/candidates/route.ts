import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const searchId = searchParams.get('search_id');
  const worldType = searchParams.get('world_type');
  const limit = Math.min(parseInt(searchParams.get('limit') || '100'), 500);
  const offset = Math.max(parseInt(searchParams.get('offset') || '0'), 0);

  const supabase = await createClient();
  let query = supabase
    .from('atlas_candidates')
    .select('*', { count: 'exact' })
    .order('distance_from_ref', { ascending: true })
    .range(offset, offset + limit - 1);

  if (searchId) query = query.eq('search_id', searchId);
  if (worldType) query = query.eq('world_type', worldType);

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  return NextResponse.json({ candidates: data || [], total: count || 0, limit, offset });
}
