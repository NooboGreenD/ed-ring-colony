import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const { supabase } = await authFromRequest(request);

  const { data: tag } = await supabase
    .from('wiki_tags')
    .select('id, name, slug')
    .eq('slug', params.slug)
    .single();

  if (!tag) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data: links } = await supabase
    .from('wiki_article_tags')
    .select('article_id')
    .eq('tag_id', tag.id);

  const articleIds = (links || []).map((l: any) => l.article_id);

  if (articleIds.length === 0) return NextResponse.json({ tag, articles: [] });

  const { data: articles, error } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, author_id, profiles!wiki_articles_author_id_fkey(cmdr_name)')
    .eq('status', 'published')
    .in('id', articleIds)
    .order('updated_at', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ tag, articles });
}
