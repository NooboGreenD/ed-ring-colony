'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import NewsList from './NewsList';

export default function NewsPage() {
  const { t, locale } = useI18n();
  const [news, setNews] = useState<any[]>([]);

  useEffect(() => {
    fetch(`/api/news?locale=${locale}`)
      .then(r => r.json())
      .then(data => setNews(data.news || []))
      .catch(() => setNews([]));
  }, [locale]);

  return (
    <main className="card">
      <div className="kicker">{t('news.kicker')}</div>
      <h1>{t('news.title')}</h1>
      {(!news || news.length === 0) && (
        <p style={{ color: '#9ca3af' }}>{t('news.empty')}</p>
      )}
      <NewsList news={news || []} />
    </main>
  );
}
