import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const category = searchParams.get('category');
  const tag = searchParams.get('tag');
  const status = searchParams.get('status') || 'published';
  const page = parseInt(searchParams.get('page') || '1');
  const limit = parseInt(searchParams.get('limit') || '20');
  const offset = (page - 1) * limit;

  const supabase = await createClient();
  let query = supabase
    .from('wiki_articles')
    .select('id, title, slug, category_id, author_id, status, is_featured, view_count, version, created_at, updated_at, wiki_categories(name, slug)', { count: 'exact' })
    .eq('status', status)
    .order('updated_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (category) {
    query = query.eq('wiki_categories.slug', category);
  }

  const { data, error, count } = await query;
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ articles: data, total: count, page, limit });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { title, slug, content, category_id } = body;
  if (!title || !slug || !content) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
  }

  const { data, error } = await supabase
    .from('wiki_articles')
    .insert({ title, slug, content, category_id: category_id || null, author_id: user.id, last_editor_id: user.id, status: 'published' })
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data, { status: 201 });
}
