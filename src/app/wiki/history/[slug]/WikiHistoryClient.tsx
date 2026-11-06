'use client';
import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function WikiHistoryPage({ params }: { params: { slug: string } }) {
  const { t, locale } = useI18n();
  const [revisions, setRevisions] = useState<any[]>([]);
  const [article, setArticle] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const [ar, rr] = await Promise.all([
          fetch(`/api/wiki/articles/${params.slug}`),
          fetch(`/api/wiki/articles/${params.slug}/revisions`)
        ]);
        const ad = await ar.json();
        const rd = await rr.json();
        if (!ad.error) setArticle(ad);
        setRevisions(rd || []);
      } catch {}
      finally { setLoading(false); }
    }
    load();
  }, [params.slug]);

  if (loading) return <main style={{ padding: 40 }}><div style={{ color: 'var(--muted)' }}>{t('common.loading')}</div></main>;

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>{t('wa.wiki')}</Link> /
        {article && <Link href={`/wiki/${article.slug}`} style={{ color: 'var(--muted)' }}> {article.title}</Link>} / {t('wa.history')}
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 24 }}>
        {t('whs.titleVersions', { title: article?.title || params.slug })}
      </h1>

      {revisions.length === 0 ? (
        <div style={{ color: 'var(--muted)', padding: '20px 0' }}>{t('whs.empty')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {revisions.map((rev: any) => (
            <div key={rev.id} className="card" style={{ padding: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>
                  {t('wa.version', { version: rev.revision_number })}
                </div>
                <div style={{ fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)' }}>
                  {new Date(rev.created_at).toLocaleString(locale)}
                </div>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
                {t('whs.editor', { name: rev.profiles?.cmdr_name || t('wa.unknownAuthor') })}
              </div>
              {rev.change_summary && (
                <div style={{ fontSize: 13, color: 'var(--text)', padding: 8, background: 'var(--panel)', borderRadius: 2 }}>
                  {rev.change_summary}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </main>
  );
}
