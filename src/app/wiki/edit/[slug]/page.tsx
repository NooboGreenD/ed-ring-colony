'use client';
import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getWikiAuthHeaders } from '@/lib/wikiAuth';
import Link from 'next/link';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize from 'rehype-sanitize';

export default function WikiEditPage({ params }: { params: { slug: string } }) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [categories, setCategories] = useState<any[]>([]);
  const [summary, setSummary] = useState('');
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/wiki/categories')
      .then(r => r.json())
      .then(data => setCategories(data || []))
      .catch(() => {});

    fetch(`/api/wiki/articles/${params.slug}`)
      .then(r => r.json())
      .then(data => {
        if (data.error) { setError(data.error); setLoading(false); return; }
        setTitle(data.title);
        setContent(data.content);
        setCategoryId(data.category_id || '');
        setLoading(false);
      })
      .catch(() => { setError('Ошибка загрузки'); setLoading(false); });
  }, [params.slug]);

  async function handleSave() {
    if (!title || !content) { setError('Заполните все обязательные поля'); return; }
    setSaving(true); setError('');
    const res = await fetch(`/api/wiki/articles/${params.slug}`, {
      method: 'PATCH',
      headers: getWikiAuthHeaders(),
      body: JSON.stringify({ title, content, category_id: categoryId || null, change_summary: summary }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error || 'Ошибка сохранения'); return; }
    router.push(`/wiki/${params.slug}`);
  }

  if (loading) return <main style={{ padding: 40 }}><div style={{ color: 'var(--muted)', fontSize: 14 }}>Загрузка...</div></main>;

  return (
    <main style={{ padding: '24px 28px', maxWidth: 1000, margin: '0 auto' }}>
      <div style={{ marginBottom: 8, fontSize: 11, fontFamily: 'ui-monospace', color: 'var(--muted)', textTransform: 'uppercase' }}>
        <Link href="/wiki" style={{ color: 'var(--muted)' }}>Вики</Link> / <Link href={`/wiki/${params.slug}`} style={{ color: 'var(--muted)' }}>{title}</Link> / Редактирование
      </div>
      <h1 style={{ fontSize: 22, letterSpacing: 4, textTransform: 'uppercase', color: 'var(--orange)', marginBottom: 24 }}>
        Редактировать: {title}
      </h1>

      {error && <div style={{ color: 'var(--red)', marginBottom: 16, fontSize: 14, padding: 12, background: 'rgba(231,76,60,0.08)', border: '1px solid var(--red)', borderRadius: 2 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Заголовок</label>
          <input value={title} onChange={e => setTitle(e.target.value)} style={{ width: '100%', margin: 0 }} />
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
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Описание изменений</label>
          <input value={summary} onChange={e => setSummary(e.target.value)} placeholder="Например: исправил опечатки, добавил раздел о вооружении" style={{ width: '100%', margin: 0 }} />
        </div>
        <div>
          <label style={{ fontSize: 11, fontFamily: 'ui-monospace', letterSpacing: '2px', textTransform: 'uppercase', color: 'var(--muted)', display: 'block', marginBottom: 6 }}>Содержание</label>
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
            <textarea value={content} onChange={e => setContent(e.target.value)} style={{ minHeight: 400, fontFamily: 'ui-monospace, monospace', fontSize: 13, lineHeight: 1.6, margin: 0 }} />
          ) : (
            <div className="card wiki-content" style={{ minHeight: 400, overflow: 'auto' }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeSanitize]}>{content || '*Нет содержимого*'}</ReactMarkdown>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <button onClick={handleSave} disabled={saving} className="btn btn-orange" style={{ padding: '12px 28px' }}>
            {saving ? 'Сохранение...' : 'Сохранить'}
          </button>
          <Link href={`/wiki/${params.slug}`} className="btn" style={{ padding: '12px 28px' }}>Отмена</Link>
        </div>
      </div>
    </main>
  );
}
