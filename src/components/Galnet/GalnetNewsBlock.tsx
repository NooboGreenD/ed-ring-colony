'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

export default function GalnetNewsBlock() {
  const { t, locale } = useI18n();
  const [articles, setArticles] = useState<any[]>([]);

  useEffect(() => {
    fetch('/api/galnet')
      .then(r => r.json())
      .then(data => setArticles(data.articles?.slice(0, 3) || []))
      .catch(() => setArticles([]));
  }, []);

  return (
    <section className="card">
      <div className="kicker">{t('galnet.kicker')}</div>
      <h2 style={{ marginTop: 10 }}>{t('galnet.title')}</h2>
      {articles.length === 0 && (
        <p style={{ color: '#9ca3af' }}>{t('galnet.empty')}</p>
      )}
      {articles.map((a: any) => (
        <article key={a.id} className="galnet-item" style={{ marginBottom: 20 }}>
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
      <Link href="/galnet" className="btn btn-cyan" style={{ marginTop: 10 }}>
        {t('galnet.archive')}
      </Link>
    </section>
  );
}
