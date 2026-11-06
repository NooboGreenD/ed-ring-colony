'use client';
import { useState, useEffect, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { getWikiAuthHeaders } from '@/lib/wikiAuth';
import WikiSearchBox from '@/components/Wiki/WikiSearchBox';
import { useI18n } from '@/lib/i18n/I18nContext';
import { Tr } from '@/components/Translate';

function SearchResults() {
  const { t } = useI18n();
  const searchParams = useSearchParams();
  const q = searchParams.get('q') || '';
  const [results, setResults] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    async function doSearch() {
      if (!q || q.length < 2) { setResults([]); return; }
      setLoading(true);
      try {
        const h = await getWikiAuthHeaders();
        const r = await fetch(`/api/wiki/search?q=${encodeURIComponent(q)}`, { headers: h });
        const data = await r.json();
        setResults(data.results || []);
      } catch {}
      setLoading(false);
    }
    doSearch();
  }, [q]);

  return (
    <div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 24 }}>
        {t('wsearch.title', { query: q })}
      </h1>
      {loading && <div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('fsearch.searching')}</div>}
      {!loading && results.length === 0 && q.length >= 2 && (
        <div style={{ color: 'var(--muted)', fontSize: 14 }}>{t('fsearch.nothing')}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {results.map((r: any) => (
          <Link key={r.id} href={`/wiki/${r.slug}`} style={{ textDecoration: 'none' }}>
            <div className="card" style={{ padding: 16 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{r.title}</div>
              {r.wiki_categories && (
                <div style={{ fontSize: 11, color: 'var(--orange)', marginTop: 4, fontFamily: 'ui-monospace' }}>
                  {r.wiki_categories.name}
                </div>
              )}
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

export default function WikiSearchPage() {
  return (
    <main style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 24 }}>
        <WikiSearchBox />
      </div>
      <Suspense fallback={<div style={{ color: 'var(--muted)' }}><Tr k="common.loading" /></div>}>
        <SearchResults />
      </Suspense>
    </main>
  );
}
