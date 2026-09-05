import { createServiceClient } from '@/lib/supabaseServer';
import { notFound, redirect } from 'next/navigation';
import WikiArticleContent from '@/components/Wiki/WikiArticleContent';

export const dynamic = 'force-dynamic';

export async function generateMetadata({ params }: { params: { slug: string } }) {
  return { title: `${params.slug} — ED Ring Colony Wiki` };
}

export default async function WikiArticlePage({ params }: { params: { slug: string } }) {
  console.log('[WikiArticlePage] slug param:', params.slug);
  
  let supabase;
  try {
    supabase = createServiceClient();
    console.log('[WikiArticlePage] createServiceClient OK');
  } catch (e: any) {
    console.error('[WikiArticlePage] createServiceClient FAILED:', e.message);
    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <h1>Ошибка подключения к базе данных</h1>
        <p>{e.message}</p>
      </main>
    );
  }

  try {
    // Check redirects
    const { data: redirectData } = await supabase
      .from('wiki_redirects')
      .select('to_slug')
      .eq('from_slug', params.slug)
      .maybeSingle();

    if (redirectData?.to_slug) {
      redirect(`/wiki/${redirectData.to_slug}`);
    }

    // Fetch article WITHOUT joins first
    const { data: article, error } = await supabase
      .from('wiki_articles')
      .select('*')
      .eq('slug', params.slug)
      .eq('status', 'published')
      .maybeSingle();

    console.log('[WikiArticlePage] article query error:', error?.message || 'none');
    console.log('[WikiArticlePage] article found:', !!article);

    if (error) {
      return (
        <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
          <h1>Ошибка загрузки статьи</h1>
          <p>{error.message}</p>
        </main>
      );
    }

    if (!article) return notFound();

    // Fetch related data separately
    const { data: category } = await supabase
      .from('wiki_categories')
      .select('id, name, slug')
      .eq('id', article.category_id)
      .maybeSingle();

    const { data: author } = await supabase
      .from('profiles')
      .select('cmdr_name, avatar_url')
      .eq('id', article.author_id)
      .maybeSingle();

    const { data: tagData } = await supabase
      .from('wiki_article_tags')
      .select('wiki_tags(name, slug)')
      .eq('article_id', article.id);
    const tags = tagData?.map((t: any) => t.wiki_tags) || [];

    const { data: related } = await supabase
      .from('wiki_articles')
      .select('id, title, slug')
      .eq('category_id', article.category_id)
      .eq('status', 'published')
      .neq('id', article.id)
      .limit(5);

    // Attach related data to article
    const articleWithJoins = {
      ...article,
      wiki_categories: category,
      profiles: author,
    };

    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <WikiArticleContent article={articleWithJoins} tags={tags} related={related || []} />
      </main>
    );
  } catch (e: any) {
    console.error('[WikiArticlePage] UNEXPECTED ERROR:', e.message);
    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <h1>Неожиданная ошибка</h1>
        <p>{e.message}</p>
      </main>
    );
  }
}
