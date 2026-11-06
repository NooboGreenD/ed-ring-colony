'use client';

import Link from 'next/link';
import { IconWiki, IconStats, IconActivity } from '@/components/Icons';
import WikiSearchBox from '@/components/Wiki/WikiSearchBox';
import { useI18n } from '@/lib/i18n/I18nContext';

interface WikiCategoryLite {
  id: string | number;
  name: string;
  slug: string;
  description?: string | null;
}

interface WikiArticleLite {
  id: string | number;
  title: string;
  slug: string;
  view_count?: number | null;
  updated_at: string;
  category_id?: string | number | null;
}

interface WikiHomeProps {
  categories: WikiCategoryLite[];
  featured: WikiArticleLite[];
  recent: WikiArticleLite[];
  catNames: Record<string, { name: string; slug: string }>;
  counts: Record<string, number>;
  totalArticles: number;
  totalCategories: number;
}

export default function WikiHome({
  categories,
  featured,
  recent,
  catNames,
  counts,
  totalArticles,
  totalCategories,
}: WikiHomeProps) {
  const { t, locale } = useI18n();

  return (
    <main className="wiki-page" style={{ padding: '24px 28px', maxWidth: 1400, margin: '0 auto' }}>
      {/* Header */}
      <div style={{ marginBottom: 24, display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
        <h1 style={{ margin: 0, fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', display: 'flex', alignItems: 'center', gap: 10 }}>
          <IconWiki size={22} />
          {t('wh.kicker')}
        </h1>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 12, alignItems: 'center' }}>
          <WikiSearchBox />
          <Link href="/wiki/create" className="btn" style={{ padding: '8px 18px', fontSize: 11 }}>
            {t('wh.create')}
          </Link>
        </div>
      </div>

      <div className="wiki-layout" style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 24 }}>
        {/* Main */}
        <div>
          {/* Categories */}
          <h2 style={{ fontSize: 16, color: 'var(--orange)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>{t('wh.categories')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 260px), 1fr))', gap: 16, marginBottom: 32 }}>
            {categories.map((cat) => (
              <Link key={cat.id} href={`/wiki/category/${cat.slug}`} style={{ textDecoration: 'none' }}>
                <div className="card" style={{ padding: 20, transition: 'background 0.2s' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 4 }}>{cat.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>{cat.description || ''}</div>
                  <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 10, fontFamily: 'ui-monospace', letterSpacing: '1px' }}>
                    {t('wh.articlesCount', { count: counts[String(cat.id)] || 0 })}
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Featured */}
          {featured.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 16, color: 'var(--orange)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 16 }}>{t('wh.featured')}</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 280px), 1fr))', gap: 16 }}>
                {featured.map((a) => (
                  <Link key={a.id} href={`/wiki/${a.slug}`} style={{ textDecoration: 'none' }}>
                    <div className="card" style={{ padding: 20 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)', marginBottom: 8 }}>{a.title}</div>
                      <div style={{ fontSize: 11, color: 'var(--muted)', fontFamily: 'ui-monospace' }}>
                        {t('wh.views', { count: a.view_count || 0 })} · {new Date(a.updated_at).toLocaleDateString(locale)}
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
              {t('wh.stats')}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 12 }}>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalArticles || 0}</div>
                <div className="lbl">{t('wh.articles')}</div>
              </div>
              <div className="stat-box" style={{ padding: 12 }}>
                <div className="num" style={{ fontSize: 20 }}>{totalCategories || 0}</div>
                <div className="lbl">{t('wh.categoriesLabel')}</div>
              </div>
            </div>
          </div>

          {/* Recent updates */}
          <div className="recent-posts-panel">
            <div className="recent-posts-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <IconActivity size={14} />
              {t('wh.recent')}
            </div>
            {recent.map((a) => {
              const cat = a.category_id != null ? catNames[String(a.category_id)] : undefined;
              return (
                <div key={a.id} className="recent-post-item" style={{ padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
                  <div className="recent-post-body">
                    <Link href={`/wiki/${a.slug}`} className="recent-post-thread">{a.title}</Link>
                    <div className="recent-post-author">
                      {cat && <Link href={`/wiki/category/${cat.slug}`} style={{ color: 'var(--orange)' }}>{cat.name}</Link>}
                    </div>
                    <div className="recent-post-time">{new Date(a.updated_at).toLocaleDateString(locale)}</div>
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
