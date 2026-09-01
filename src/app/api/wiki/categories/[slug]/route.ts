import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabaseServer';

export async function GET(_request: Request, { params }: { params: { slug: string } }) {
  const supabase = await createClient();

  const { data: category } = await supabase
    .from('wiki_categories')
    .select('*')
    .eq('slug', params.slug)
    .single();

  if (!category) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: articles, error } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, author_id, profiles!wiki_articles_author_id_fkey(cmdr_name)')
    .eq('category_id', category.id)
    .eq('status', 'published')
    .order('updated_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ category, articles });
}
