'use client';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';
import { IconHistory, IconStar } from '@/components/Icons';
import { useState, useEffect } from 'react';

interface WikiArticleContentProps {
  article: any;
  tags: any[];
  related: any[];
}

export default function WikiArticleContent({ article, tags, related }: WikiArticleContentProps) {
  const [isFav, setIsFav] = useState(false);
  const [favId, setFavId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/wiki/favorites', { credentials: 'include' })
      .then(r => r.json())
      .then(data => {
        const fav = (data || []).find((f: any) => f.article_id === article.id);
        if (fav) { setIsFav(true); setFavId(fav.id); }
      })
      .catch(() => {});
  }, [article.id]);

  async function toggleFav() {
    if (isFav && favId) {
      await fetch(`/api/wiki/favorites/${favId}`, { method: 'DELETE', credentials: 'include' });
      setIsFav(false); setFavId(null);
    } else {
      const res = await fetch('/api/wiki/favorites', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ article_id: article.id })
      });
      const data = await res.json();
      if (res.ok) { setIsFav(true); setFavId(data.id); }
    }
  }

  return (
    <div>
      {/* Breadcrumbs */}
      <div style={{ marginBottom: 16, fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--muted)' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link>
        {' / '}
        {article.wiki_categories && (
          <Link href={`/wiki/category/${article.wiki_categories.slug}`} style={{ color: 'var(--muted)' }}>
            {article.wiki_categories.name}
          </Link>
        )}
      </div>

      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <h1 style={{ fontSize: 'clamp(24px, 5vw, 42px)', fontWeight: 800, letterSpacing: '3px', textTransform: 'uppercase', margin: '0 0 12px 0' }}>
          {article.title}
        </h1>
        <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 12, fontFamily: 'ui-monospace', color: 'var(--muted)' }}>
          <span>Автор: {article.profiles?.cmdr_name || 'Unknown'}</span>
          <span>·</span>
          <span>Версия {article.version}</span>
          <span>·</span>
          <span>{article.view_count} просмотров</span>
          <span>·</span>
          <span>{new Date(article.updated_at).toLocaleDateString('ru-RU')}</span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={toggleFav} className="btn" style={{ padding: '6px 14px', fontSize: 11 }}>
              <IconStar size={12} color={isFav ? 'var(--orange)' : 'var(--muted)'} style={{ marginRight: 4 }} />
              {isFav ? 'В избранном' : 'В избранное'}
            </button>
            <Link href={`/wiki/edit/${article.slug}`} className="btn" style={{ padding: '6px 14px', fontSize: 11 }}>Редактировать</Link>
            <Link href={`/wiki/history/${article.slug}`} className="btn" style={{ padding: '6px 14px', fontSize: 11 }}>
              <IconHistory size={12} style={{ marginRight: 4 }} />
              История
            </Link>
          </div>
        </div>
      </div>

      {/* Tags */}
      {tags.length > 0 && (
        <div style={{ marginBottom: 20, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {tags.map((tag: any) => (
            <Link key={tag.slug} href={`/wiki/tag/${tag.slug}`} style={{
              background: 'var(--panel)', border: '1px solid var(--line)', padding: '4px 12px',
              borderRadius: 999, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--orange)'
            }}>
              #{tag.name}
            </Link>
          ))}
        </div>
      )}

      {/* Content */}
      <div className="wiki-content" style={{ lineHeight: 1.7, fontSize: 15, color: 'var(--text)' }}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
          {article.content}
        </ReactMarkdown>
      </div>

      {/* Related */}
      {related.length > 0 && (
        <div style={{ marginTop: 40, paddingTop: 24, borderTop: '1px solid var(--line)' }}>
          <h3 style={{ fontSize: 14, color: 'var(--orange)', letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 12 }}>
            СВЯЗАННЫЕ СТАТЬИ
          </h3>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {related.map((r: any) => (
              <Link key={r.id} href={`/wiki/${r.slug}`} style={{ fontSize: 14, color: 'var(--text)' }}>
                → {r.title}
              </Link>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
