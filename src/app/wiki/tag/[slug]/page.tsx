import { createServiceClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function WikiTagPage({ params }: { params: { slug: string } }) {
  const supabase = createServiceClient();

  const { data: tag, error: tagError } = await supabase
    .from('wiki_tags')
    .select('id, name, slug')
    .eq('slug', params.slug)
    .maybeSingle();

  if (tagError) {
    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <h1>Ошибка загрузки тега</h1>
        <p>{tagError.message}</p>
      </main>
    );
  }

  if (!tag) return notFound();

  const { data: links } = await supabase
    .from('wiki_article_tags')
    .select('article_id')
    .eq('tag_id', tag.id);

  const articleIds = (links || []).map((l: any) => l.article_id);
  let articles: any[] = [];
  let authorMap: Record<string, string> = {};

  if (articleIds.length > 0) {
    const { data: arts } = await supabase
      .from('wiki_articles')
      .select('id, title, slug, view_count, updated_at, author_id')
      .eq('status', 'published')
      .in('id', articleIds)
      .order('updated_at', { ascending: false });
    articles = arts || [];

    const authorIds = [...new Set(articles.map((a: any) => a.author_id).filter(Boolean))];
    if (authorIds.length > 0) {
      const { data: profiles } = await supabase
        .from('profiles')
        .select('id, cmdr_name')
        .in('id', authorIds);
      (profiles || []).forEach((p: any) => { authorMap[p.id] = p.cmdr_name; });
    }
  }

  const articlesWithAuthors = articles.map((a: any) => ({
    ...a,
    profiles: { cmdr_name: authorMap[a.author_id] || 'Unknown' },
  }));

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link> / Тег: {tag.name}
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 24 }}>
        #{tag.name}
      </h1>

      {articlesWithAuthors.length === 0 ? (
        <div style={{ color: 'var(--muted)', padding: '40px 0', fontSize: 14 }}>По этому тегу пока нет статей.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {articlesWithAuthors.map((a: any) => (
            <Link key={a.id} href={`/wiki/${a.slug}`} style={{ textDecoration: 'none' }}>
              <div className="card" style={{ padding: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center', transition: 'background 0.2s' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{a.title}</div>
                  <div style={{ fontSize: 11, color: 'var(--muted)', marginTop: 4, fontFamily: 'ui-monospace' }}>
                    {a.profiles?.cmdr_name || 'Unknown'} · {a.view_count} просмотров · {new Date(a.updated_at).toLocaleDateString('ru-RU')}
                  </div>
                </div>
                <span style={{ color: 'var(--orange)', fontSize: 20 }}>→</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
