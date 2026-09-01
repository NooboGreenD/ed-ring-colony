import { createClient } from '@/lib/supabaseServer';
import Link from 'next/link';
import { IconWiki, IconStats, IconActivity } from '@/components/Icons';
import WikiSearchBox from '@/components/Wiki/WikiSearchBox';


export default async function WikiPage() {
  const supabase = await createClient();

  const { data: categories } = await supabase
    .from('wiki_categories')
    .select('id, name, slug, description, sort_order')
    .order('sort_order', { ascending: true });

  const { data: featured } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, view_count, updated_at, category_id')
    .eq('status', 'published')
    .eq('is_featured', true)
    .limit(3);

  const { data: recent } = await supabase
    .from('wiki_articles')
    .select('id, title, slug, updated_at, category_id')
    .eq('status', 'published')
    .order('updated_at', { ascending: false })
    .limit(8);

  // Load category names for recent
  const catIds = [...new Set((recent || []).map((a: any) => a.category_id).filter(Boolean))];
  const { data: catData } = catIds.length
    ? await supabase.from('wiki_categories').select('id, name, slug').in('id', catIds)
    : { data: [] };
  const catMap = new Map((catData || []).map((c: any) => [c.id, c]));

  // Count articles per category
  const { data: articleCounts } = await supabase
    .from('wiki_articles')
    .select('category_id')
    .eq('status', 'published');
  const countMap = new Map<number, number>();
  (articleCounts || []).forEach((a: any) => {
    countMap.set(a.category_id, (countMap.get(a.category_id) || 0) + 1);
  });

  const { count: totalArticles } = await supabase.from('wiki_articles').select('*', { count: 'exact', head: true }).eq('status', 'published');
  const { count: totalCategories } = await supabase.from('wiki_categories').select('*', { count: 'exact', head: true });

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <IconWiki size={22} />
          ВИКИПЕДИЯ
        </h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <WikiSearchBox />
          <Link href="/wiki/create" className="btn" style={{ padding: '8px 18px', fontSize: 11 }}>
            Создать статью
          </Link>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        {/* Main */}
        <div>
          {/* Categories */}
          <h2 style={{ fontSize: 16, color: 'var(--orange)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>КАТЕГОРИИ</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 16, marginBottom: 32 }}>
            {(categories || []).map((cat: any) => (
              <Link key={cat.id} href={`/wiki/category/${cat.slug}`} style={{ textDecoration: 'none' }}>
                <div className="card" style={{ padding: 20, transition: 'background 0.2s' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{cat.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{cat.description || ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 10, fontFamily: 'ui-monospace', letterSpacing: '1px' }}>
                    {countMap.get(cat.id) || 0} статей
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Featured */}
          {featured && featured.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, color: 'var(--orange)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>ИЗБРАННЫЕ СТАТЬИ</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 16 }}>
                {featured.map((a: any) => (
                  <Link key={a.id} href={`/wiki/${a.slug}`} style={{ textDecoration: 'none' }}>
                    <div className="card" style={{ padding: 20 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{a.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace' }}>
                        {a.view_count} просмотров · {new Date(a.updated_at).toLocaleDateString('ru-RU')}
                      </div>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Sidebar */}
        <aside>
          {/* Stats */}
          <div className="recent-posts-panel" style={{ marginBottom: 16 }}>
            <div className="recent-posts-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconStats size={14} />
              Статистика
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalArticles || 0}</div>
                <div className="lbl">Статей</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalCategories || 0}</div>
                <div className="lbl">Категорий</div>
              </div>
            </div>
          </div>

          {/* Recent updates */}
          <div className="recent-posts-panel">
            <div className="recent-posts-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconActivity size={14} />
              Последние обновления
            </div>
            {(recent || []).map((a: any) => {
              const cat = catMap.get(a.category_id);
              return (
                <div key={a.id} className="recent-post-item" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <div className="recent-post-body">
                    <Link href={`/wiki/${a.slug}`} className="recent-post-thread">{a.title}</Link>
                    <div className="recent-post-author">
                      {cat && <Link href={`/wiki/category/${cat.slug}`} style={{ color: 'var(--orange)' }}>{cat.name}</Link>}
                    </div>
                    <div className="recent-post-time">{new Date(a.updated_at).toLocaleDateString('ru-RU')}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </main>
  );
}
