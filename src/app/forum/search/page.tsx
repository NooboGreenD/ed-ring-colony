'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ForumBreadcrumbs } from '@/components/Forum/ForumBreadcrumbs';
import { IconSearch } from '@/components/Icons';

interface SearchResult {
  id: number;
  title?: string;
  content?: string;
  author_name: string;
  created_at: string;
  type: 'thread' | 'post';
  thread_id?: number;
  thread_title?: string;
  category_slug?: string;
  category_name?: string;
}

export default function ForumSearchPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);

  const search = async () => {
    if (!query.trim() || query.trim().length < 2) return;
    setLoading(true);
    setSearched(true);
    try {
      const res = await fetch(`/api/forum/search?q=${encodeURIComponent(query.trim())}`);
      const data = await res.json();
      const mapped: SearchResult[] = [
        ...(data.threads || []).map((t: any) => ({
          id: t.id,
          title: t.title,
          author_name: t.author_name || 'Unknown',
          created_at: t.created_at,
          type: 'thread' as const,
          category_slug: t.forum_categories?.slug,
          category_name: t.forum_categories?.name,
        })),
        ...(data.posts || []).map((p: any) => ({
          id: p.id,
          content: p.content,
          author_name: p.author_name || 'Unknown',
          created_at: p.created_at,
          type: 'post' as const,
          thread_id: p.forum_threads?.id,
          thread_title: p.forum_threads?.title,
        })),
      ];
      setResults(mapped);
    } catch (e) {
      console.error(e);
    }
    setLoading(false);
  };

  return (
    <main className="forum-layout" style={{ padding: '24px 28px', maxWidth: 1200, margin: '0 auto' }}>
      <ForumBreadcrumbs items={[
        { label: 'Форум', href: '/forum' },
        { label: 'Поиск' },
      ]} />

      <h1 style={{ margin: '0 0 20px', fontSize: 20, color: 'var(--orange)', letterSpacing: 3, textTransform: 'uppercase' }}>
        Поиск по форуму
      </h1>

      <div className="card" style={{ padding: 20, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12 }}>
          <input
            type="text"
            placeholder="Введите запрос (мин. 2 символа)…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && search()}
            style={{ flex: 1, fontSize: 14 }}
          />
          <button onClick={search} disabled={loading} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <IconSearch size={14} />
            {loading ? 'Поиск…' : 'Найти'}
          </button>
        </div>
      </div>

      {searched && results.length === 0 && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 40, color: 'var(--muted)' }}>
          Ничего не найдено
        </div>
      )}

      {results.length > 0 && (
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <table className="forum-table">
            <thead>
              <tr>
                <th className="col-topic">Результат</th>
                <th className="col-replies">Автор</th>
                <th className="col-last">Дата</th>
              </tr>
            </thead>
            <tbody>
              {results.map((r) => (
                <tr key={`${r.type}-${r.id}`}>
                  <td className="col-topic">
                    {r.type === 'thread' ? (
                      <>
                        <Link href={`/forum/thread/${r.id}`} className="forum-topic-title">
                          {r.title}
                        </Link>
                        <span style={{ color: 'var(--orange)', fontSize: 11, marginLeft: 8 }}>Тема</span>
                        {r.category_name && (
                          <div className="forum-cat-desc">
                            <Link href={`/forum/${r.category_slug}`} style={{ color: 'var(--orange)' }}>{r.category_name}</Link>
                          </div>
                        )}
                      </>
                    ) : (
                      <>
                        <Link href={`/forum/thread/${r.thread_id}#post-${r.id}`} className="forum-topic-title">
                          {r.thread_title || '…'}
                        </Link>
                        <span style={{ color: 'var(--muted)', fontSize: 11, marginLeft: 8 }}>Пост</span>
                        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--muted)', lineHeight: 1.5 }}>
                          {r.content?.slice(0, 200)}{r.content && r.content.length > 200 ? '…' : ''}
                        </div>
                      </>
                    )}
                  </td>
                  <td className="col-replies" style={{ whiteSpace: 'nowrap' }}>
                    <span style={{ color: 'var(--text)' }}>{r.author_name}</span>
                  </td>
                  <td className="col-last" style={{ whiteSpace: 'nowrap' }}>
                    <span className="forum-last-time">{new Date(r.created_at).toLocaleDateString('ru-RU')}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
