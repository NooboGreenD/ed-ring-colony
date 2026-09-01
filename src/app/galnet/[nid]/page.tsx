'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useI18n } from '@/lib/i18n/I18nContext';
import CommentSection from '@/components/Comments/CommentSection';

export default function GalnetDetailPage() {
  const { t, locale } = useI18n();
  const params = useParams();
  const [item, setItem] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/galnet/${params.nid}?locale=${locale}`)
      .then(r => r.json())
      .then(data => {
        setItem(data.item || null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [params.nid, locale]);

  if (loading) return <main className="card"><p>{t('common.loading')}</p></main>;
  if (!item) return <main className="card"><p>{t('common.error')}</p></main>;

  return (
    <main className="card">
      <div className="kicker">{t('galnet.kicker')}</div>
      <h1>{item.title}</h1>
      <div className="galnet-date" style={{ marginBottom: 16 }}>
        {new Date(item.published_at).toLocaleDateString(locale, {
          day: 'numeric', month: 'long', year: 'numeric'
        })}
      </div>
      {item.image && (
        <img src={item.image} alt={item.title} className="galnet-cover" style={{ marginBottom: 16 }} />
      )}
      <div className="galnet-body" style={{ lineHeight: 1.7, whiteSpace: 'pre-wrap' }}>
        {item.body}
      </div>
      <div style={{ marginTop: 24 }}>
        <Link href="/galnet" className="btn btn-cyan">
          {t('common.back')} {t('galnet.archive')}
        </Link>
      </div>
      <CommentSection targetType="galnet" targetId={String(params.nid)} />
    </main>
  );
}
