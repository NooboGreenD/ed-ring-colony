import { NextResponse } from 'next/server';
import { createRouteClient } from '@/lib/supabaseServer';

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const supabase = createRouteClient(request);

  // Check redirect first
  const { data: redirect } = await supabase
    .from('wiki_redirects')
    .select('to_slug')
    .eq('from_slug', params.slug)
    .single();

  if (redirect) {
    return NextResponse.json({ redirect: redirect.to_slug }, { status: 307 });
  }

  const { data: article, error } = await supabase
    .from('wiki_articles')
    .select('*, wiki_categories(id, name, slug), profiles!wiki_articles_author_id_fkey(cmdr_name, avatar_url)')
    .eq('slug', params.slug)
    .single();

  if (error || !article) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  // Increment view count
  await supabase
    .from('wiki_articles')
    .update({ view_count: (article.view_count || 0) + 1 })
    .eq('id', article.id);

  // Load tags
  const { data: tagData } = await supabase
    .from('wiki_article_tags')
    .select('tag_id, wiki_tags(name, slug)')
    .eq('article_id', article.id);

  article.tags = tagData?.map((t: any) => t.wiki_tags) || [];

  return NextResponse.json(article);
}

export async function PATCH(request: Request, { params }: { params: { slug: string } }) {
  const supabase = createRouteClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const body = await request.json();
  const { title, content, category_id, status, change_summary } = body;

  // Get current article
  const { data: current } = await supabase
    .from('wiki_articles')
    .select('*')
    .eq('slug', params.slug)
    .single();

  if (!current) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  // Save revision
  await supabase.from('wiki_revisions').insert({
    article_id: current.id,
    content: current.content,
    editor_id: user.id,
    revision_number: current.version,
    change_summary: change_summary || 'Редактирование',
  });

  // Update article
  const { data, error } = await supabase
    .from('wiki_articles')
    .update({
      title: title ?? current.title,
      content: content ?? current.content,
      category_id: category_id ?? current.category_id,
      status: status ?? current.status,
      last_editor_id: user.id,
      version: current.version + 1,
    })
    .eq('slug', params.slug)
    .select()
    .single();

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}

export async function DELETE(request: Request, { params }: { params: { slug: string } }) {
  const supabase = createRouteClient(request);
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { error } = await supabase.from('wiki_articles').delete().eq('slug', params.slug);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ success: true });
}
