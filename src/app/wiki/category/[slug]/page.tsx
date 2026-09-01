import { createClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const revalidate = 60;

export default async function WikiCategoryPage({ params }: { params: { slug: string } }) {
  const supabase = await createClient();

  const { data: category } = await supabase
    .from('wiki_categories')
    .select('*')
    .eq('slug', params.slug)
    .single();

  if (!category) return notFound();

  const { data: articles, error } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, author_id, profiles!wiki_articles_author_id_fkey(cmdr_name)')
    .eq('category_id', category.id)
    .eq('status', 'published')
    .order('updated_at', { ascending: false });

  if (error) return notFound();

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link> / {category.name}
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 8 }}>
        {category.name}
      </h1>
      {category.description && <p style={{ color: 'var(--muted)', marginBottom: 24, fontSize: 14 }}>{category.description}</p>}

      {(!articles || articles.length === 0) ? (
        <div style={{ color: 'var(--muted)', padding: '40px 0', fontSize: 14 }}>В этой категории пока нет статей.</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {articles.map((a: any) => (
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
