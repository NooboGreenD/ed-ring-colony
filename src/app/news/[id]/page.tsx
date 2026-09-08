'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/I18nContext';
import CommentSection from '@/components/Comments/CommentSection';

export default function NewsDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams();
  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(`/api/news/${params.id}?locale=${locale}`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(data => {
        setItem(data.item || null);
        setLoading(false);
      })
      .catch((err) => { if (err.name !== 'AbortError') setLoading(false); });
    return () => ctrl.abort();
  }, [params.id, locale]);

  if (loading) return <main className="card"><p>{t('common.loading')}</p></main>;
  if (!item) return <main className="card"><p>{t('common.error')}</p></main>;

  return (
    <main className="card">
      <div className="kicker">{t('news.kicker')}</div>
      <h1>{item.title}</h1>
      <div className="news-date" style={{ marginBottom: 16 }}>
        {new Date(item.published_at).toLocaleString(locale)}
      </div>
      {item.cover_url && (
        <img src={item.cover_url} alt={item.title} className="news-cover" style={{ marginBottom: 16 }} />
      )}
      <div className="news-body" style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {item.body}
      </div>
      <div style={{ marginTop: 24 }}>
        <Link href="/news" className="btn btn-cyan">
          {t('common.back')} {t('news.archive')}
        </Link>
      </div>
      <CommentSection targetType="news" targetId={String(params.id)} />
    </main>
  );
}
