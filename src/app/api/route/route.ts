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

  return NextResponse.json({ points: points || [] });
}
