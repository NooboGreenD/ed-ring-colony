import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export async function GET(request: Request) {
  const { user, supabase } = await authFromRequest(request);
  const { data, error } = await supabase
    .from('wiki_categories')
    .select('*')
    .order('sort_order', { ascending: true });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
