import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export async function GET(request: Request) {
  const { user, supabase } = await authFromRequest(request);
  
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { data, error } = await supabase
    .from('wiki_favorites')
    .select('*, wiki_articles(id, title, slug)')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function POST(request: Request) {
  const { user, supabase } = await authFromRequest(request);
  
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { article_id } = await request.json();
  const { data, error } = await supabase
    .from('wiki_favorites')
    .insert({ user_id: user.id, article_id })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
