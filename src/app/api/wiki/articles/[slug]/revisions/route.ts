import { NextResponse } from 'next/server';
import { authFromRequest } from '@/lib/supabaseServer';

export async function GET(request: Request, { params }: { params: { slug: string } }) {
  const { user, supabase } = await authFromRequest(request);

  const { data: article } = await supabase
    .from('wiki_articles')
    .select('id')
    .eq('slug', params.slug)
    .single();

  if (!article) return NextResponse.json({ error: 'Not found' }, { status: 404 });

  const { data, error } = await supabase
    .from('wiki_revisions')
    .select('*, profiles!wiki_revisions_editor_id_fkey(cmdr_name, avatar_url)')
    .eq('article_id', article.id)
    .order('revision_number', { ascending: false });

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json(data);
}
