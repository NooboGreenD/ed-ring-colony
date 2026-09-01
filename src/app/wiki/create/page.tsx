'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getWikiAuthHeaders } from '@/lib/wikiAuth';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

export default function WikiCreatePage() {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const [content, setContent] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/api/wiki/categories')
      .then(r => r.json())
      .then(data => setCategories(data || []))
      .catch(() => {});
  }, []);

  function generateSlug(t: string) {
    return t.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .substring(0, 80);
  }

  async function handleSave() {
    if (!title || !slug || !content) { setError('Заполните все обязательные поля'); return; }
    setSaving(true); setError('');
    const res = await fetch('/api/wiki/articles', {
      method: 'POST',
      headers: getWikiAuthHeaders(),
      body: JSON.stringify({ title, slug, content, category_id: categoryId || null }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Ошибка сохранения'); return; }
    router.push(`/wiki/${slug}`);
  }

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link> / Создать статью
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 24 }}>
        Создать статью
      </h1>

      {error && <div style={{ color: 'var(--red)', marginBottom: 16, fontSize: 14, padding: 12, background: 'rgba(231,76,60,0.08)', border: '1px solid var(--red)', borderRadius: 2 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Заголовок</label>
          <input
            value={title}
            onChange={e => { setTitle(e.target.value); if (!slug) setSlug(generateSlug(e.target.value)); }}
            placeholder="Например: Krait Mk II"
            style={{ width: '100%', margin: 0 }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>URL-идентификатор (slug)</label>
          <input
            value={slug}
            onChange={e => setSlug(e.target.value)}
            placeholder="krait-mk-ii"
            style={{ width: '100%', margin: 0, fontFamily: 'ui-monospace' }}
          />
        </div>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Категория</label>
          <select value={categoryId} onChange={e => setCategoryId(e.target.value)} style={{ width: '100%', margin: 0 }}>
            <option value="">Без категории</option>
            {categories.map((c: any) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Содержание (Markdown)</label>
          <div style={{ display: 'flex', gap: 8, margin: '8px 0' }}>
            <button type="button" onClick={() => setPreview(false)} style={{
              padding: '6px 14px', fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase',
              border: '1px solid var(--line)', background: !preview ? 'var(--orange)' : 'transparent', color: !preview ? '#1e2022' : 'var(--muted)',
              borderRadius: 2, cursor: 'pointer'
            }}>Редактор</button>
            <button type="button" onClick={() => setPreview(true)} style={{
              padding: '6px 14px', fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase',
              border: '1px solid var(--line)', background: preview ? 'var(--orange)' : 'transparent', color: preview ? '#1e2022' : 'var(--muted)',
              borderRadius: 2, cursor: 'pointer'
            }}>Предпросмотр</button>
          </div>
          {!preview ? (
            <textarea
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="# Заголовок\n\nТекст статьи в формате Markdown..."
              style={{ minHeight: 400, fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.6, margin: 0 }}
            />
          ) : (
            <div className="card wiki-content" style={{ minHeight: 400, overflow: 'auto' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>
                {content || '*Нет содержимого для предпросмотра*'}
              </ReactMarkdown>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={handleSave} disabled={saving} className="btn btn-orange" style={{ padding: '12px 28px' }}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <Link href="/wiki" className="btn" style={{ padding: '12px 28px' }}>Отмена</Link>
        </div>
      </div>
    </main>
  );
}
