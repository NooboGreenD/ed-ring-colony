import { createClient } from '@/lib/supabaseServer';
import { notFound, redirect } from 'next/navigation';
import WikiArticleContent from '@/components/Wiki/WikiArticleContent';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `${params.slug} — ED Ring Colony Wiki` };
}

export default async function WikiArticlePage({ params }: { params: { slug: string } }) {
  const supabase = createClient();

  // Check redirect
  const { data: redirectData } = await supabase
    .from('wiki_redirects')
    .select('to_slug')
    .eq('from_slug', params.slug)
    .single();

  if (redirectData) {
    redirect(`/wiki/${redirectData.to_slug}`);
  }

  const { data: article, error } = await supabase
    .from('wiki_articles')
    .select('*, wiki_categories(id, name, slug), profiles!wiki_articles_author_id_fkey(cmdr_name, avatar_url)')
    .eq('slug', params.slug)
    .eq('status', 'published')
    .single();

  if (error || !article) return notFound();

  // Tags
  const { data: tagData } = await supabase
    .from('wiki_article_tags')
    .select('wiki_tags(name, slug)')
    .eq('article_id', article.id);
  const tags = tagData?.map((t: any) => t.wiki_tags) || [];

  // Related articles (same category)
  const { data: related } = await supabase
    .from('wiki_articles')
    .select('id, title, slug')
    .eq('category_id', article.category_id)
    .eq('status', 'published')
    .neq('id', article.id)
    .limit(5);

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <WikiArticleContent article={article} tags={tags} related={related || []} />
    </main>
  );
}
