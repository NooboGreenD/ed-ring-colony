import { NextResponse } from 'next/server';
import { createServiceClient } from '@/lib/supabaseServer';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const requestedFilter = url.searchParams.get('filter') || 'active';
  const filter = ['active', 'colonisation', 'completed'].includes(requestedFilter)
    ? requestedFilter
    : 'active';

  const svc = createServiceClient();
  let query = svc.from('community_goals').select('*');

  if (filter === 'active') {
    query = query.eq('is_complete', false);
  } else if (filter === 'colonisation') {
    query = query.eq('is_colonisation_related', true).eq('is_complete', false);
  } else if (filter === 'completed') {
    query = query.eq('is_complete', true);
  }

  const { data, error } = await query.order('expiry_date', { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const lastUpdated = (data || [])
    .map((goal) => goal.updated_at || goal.source_updated_at)
    .filter((value): value is string => typeof value === 'string')
    .sort()
    .at(-1) || null;

  return NextResponse.json({ goals: data, updatedAt: lastUpdated });
}
