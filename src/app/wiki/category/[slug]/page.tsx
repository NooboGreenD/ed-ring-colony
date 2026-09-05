import { createServiceClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function WikiCategoryPage({ params }: { params: { slug: string } }) {
  const supabase = createServiceClient();

  const { data: category, error: catError } = await supabase
    .from('wiki_categories')
    .select('*')
    .eq('slug', params.slug)
    .maybeSingle();

  if (catError) {
    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <h1>Ошибка загрузки категории</h1>
        <p>{catError.message}</p>
      </main>
    );
  }

  if (!category) return notFound();

  const { data: articles, error: artError } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, author_id')
    .eq('category_id', category.id)
    .eq('status', 'published')
    .order('updated_at', { ascending: false });

  if (artError) {
    return (
      <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
        <h1>Ошибка загрузки статей</h1>
        <p>{artError.message}</p>
      </main>
    );
  }

  // Fetch author names separately
  const authorIds = [...new Set((articles || []).map((a: any) => a.author_id).filter(Boolean))];
  let authorMap: Record<string, string> = {};
  if (authorIds.length > 0) {
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, cmdr_name')
      .in('id', authorIds);
    (profiles || []).forEach((p: any) => { authorMap[p.id] = p.cmdr_name; });
  }

  const articlesWithAuthors = (articles || []).map((a: any) => ({
    ...a,
    profiles: { cmdr_name: authorMap[a.author_id] || 'Unknown' },
  }));

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link> / {category.name}
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 8 }}>
        {category.name}
      </h1>
      {category.description && <p style={{ color: 'var(--muted)', marginBottom: 24, fontSize: 14 }}>{category.description}</p>}

      {(!articlesWithAuthors || articlesWithAuthors.length === 0) ? (
        <div style={{ color: 'var(--muted)', padding: '40px 0', fontSize: 14 }}>В этой категории пока нет статей.</div>
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
