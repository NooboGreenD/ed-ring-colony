'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function GalnetPage() {
  const { t, locale } = useI18n();
  const [articles, setArticles] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/galnet?locale=${locale}`)
      .then(r => r.json())
      .then(data => {
        setArticles(data.articles || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [locale]);

  if (loading) return <main className="card"><p>{t('common.loading')}</p></main>;

  return (
    <main className="card">
      <div className="kicker">{t('galnet.kicker')}</div>
      <h1>{t('galnet.title')}</h1>
      {(!articles || articles.length === 0) && (
        <p style={{ color: '#9ca3af' }}>{t('galnet.empty')}</p>
      )}
      <div className="news-grid">
        {articles.map((a: any) => (
          <article key={a.id} className="galnet-item">
            {a.image && (
              <img src={a.image} alt={a.title} className="galnet-cover" />
            )}
            <div className="galnet-date">
              {new Date(a.published_at).toLocaleDateString(locale, {
                day: 'numeric', month: 'long', year: 'numeric'
              })}
            </div>
            <h3>{a.title}</h3>
            <div className="galnet-body-truncated">{a.body}</div>
            <Link href={`/galnet/${a.nid}`} className="btn btn-cyan" style={{ fontSize: 12, marginTop: 8 }}>
              {t('common.readFull')} &rarr;
            </Link>
          </article>
        ))}
      </div>
    </main>
  );
}
