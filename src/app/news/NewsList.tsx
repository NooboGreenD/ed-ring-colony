'use client';

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';

interface NewsItem {
  id: number;
  title: string;
  body: string;
  cover_url: string | null;
  published_at: string;
  author: string | null;
}

export default function NewsList({ news }: { news: NewsItem[] }) {
  const { t, locale } = useI18n();

  return (
    <div className="news-grid">
      {news.map((n) => (
        <article key={n.id} className="news-item">
          {n.cover_url && (
            <img src={n.cover_url} alt={n.title} className="news-cover" />
          )}
          <div className="news-date">
            {new Date(n.published_at).toLocaleString(locale)}
            {n.author ? ' · ' + n.author : ''}
          </div>
          <h3>{n.title}</h3>
          <div className="news-body-truncated">{n.body}</div>
          <Link href={`/news/${n.id}`} className="btn btn-cyan" style={{ fontSize: 12, marginTop: 8 }}>
            {t('news.readMore')} &rarr;
          </Link>
        </article>
      ))}
    </div>
  );
}
