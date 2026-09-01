'use client';

import Link from 'next/link';
import Starfield from '@/components/Starfield';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useEffect, useState } from 'react';

export default function Home() {
  const { t, locale } = useI18n();
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    fetch(`/api/home-data?locale=${locale}`)
      .then(r => r.json())
      .then(setData)
      .catch(() => setData({}));
  }, [locale]);

  const c = data?.content ?? {};
  const news = data?.news ?? [];
  const galnet = data?.galnet ?? [];
  const cmdrs = data?.cmdrs ?? 0;
  const systems = data?.systems ?? 0;
  const built = data?.built ?? 0;

  const kicker = c?.kicker || '';
  const title1 = c?.title1 || '';
  const title2 = c?.title2 || '';
  const manifest = c?.manifest || '';

  const dateOpts: Intl.DateTimeFormatOptions = {
    day: 'numeric', month: 'long', year: 'numeric'
  };

  return (
    <>
      <section className="hero">
        <Starfield />
        <div className="corner tl" />
        <div className="corner br" />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <div className="kicker">{kicker}</div>
          <h1>
            {title1}
            <br />
            {title2}
          </h1>
          <p className="sub">{manifest}</p>
          <div className="btn-row">
            <Link href="/login" className="btn btn-orange">
              &#9656; {t('home.btnMission')}
            </Link>
            <Link href="/map" className="btn btn-cyan">
              &#8857; {t('home.btnMap')}
            </Link>
          </div>
        </div>
        <div className="stats">
          <div>
            {t('home.statsCmdrs')}:<b>{cmdrs.toLocaleString(locale)}</b>
          </div>
          <div>
            {t('home.statsSystems')}:<b>{systems.toLocaleString(locale)}</b>
          </div>
          <div>
            {t('home.statsBuilt')}:<b>{built.toLocaleString(locale)}</b>
          </div>
        </div>
        <div className="initiate">{t('home.initiate')}</div>
      </section>

      <section className="card">
        <div className="kicker">{t('news.kicker')}</div>
        <h2 style={{ marginTop: 10 }}>{t('news.title')}</h2>
        {(!news || news.length === 0) && (
          <p style={{ color: '#9ca3af' }}>{t('news.empty')}</p>
        )}
        {(news ?? []).map((n: any) => (
          <article key={n.id} className="news-item" style={{ marginBottom: 20 }}>
            {n.cover_url && <img src={n.cover_url} alt={n.title} className="news-cover" />}
            <div className="news-date">{new Date(n.published_at).toLocaleString(locale)}</div>
            <h3>{n.title}</h3>
            <div className="news-body-truncated">{n.body}</div>
            <Link href={`/news/${n.id}`} className="btn btn-cyan" style={{ fontSize: 12, marginTop: 8 }}>
              {t('news.readMore')} &rarr;
            </Link>
          </article>
        ))}
        <Link href="/news" className="btn btn-cyan" style={{ marginTop: 10 }}>
          {t('news.archive')}
        </Link>
      </section>

      <section className="card">
        <div className="kicker">{t('galnet.kicker')}</div>
        <h2 style={{ marginTop: 10 }}>{t('galnet.title')}</h2>
        {(!galnet || galnet.length === 0) && (
          <p style={{ color: '#9ca3af' }}>{t('galnet.empty')}</p>
        )}
        {(galnet ?? []).map((a: any) => (
          <article key={a.id} className="galnet-item" style={{ marginBottom: 20 }}>
            {a.image && <img src={a.image} alt={a.title} className="galnet-cover" />}
            <div className="galnet-date">{new Date(a.published_at).toLocaleDateString(locale, dateOpts)}</div>
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
    </>
  );
}
