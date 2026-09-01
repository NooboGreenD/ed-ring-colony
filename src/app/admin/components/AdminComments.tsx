'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface Comment {
  id: number;
  target_type: string;
  target_id: string;
  content: string;
  created_at: string;
  author: { cmdr_name: string } | null;
}

export default function AdminComments() {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    loadComments();
  }, []);

  async function loadComments() {
    setLoading(true);
    let query = supabase
      .from('comments')
      .select('*')
      .order('created_at', { ascending: false });

    if (filter !== 'all') {
      query = query.eq('target_type', filter);
    }

    const { data: commentsData, error } = await query;
    if (error) {
      console.error('Failed to load comments:', error);
      setLoading(false);
      return;
    }

    // Load profiles separately (FK may not exist in schema cache)
    const authorIds = [...new Set((commentsData || []).map((c: any) => c.author_id))];
    const { data: profiles } = await supabase
      .from('profiles')
      .select('id, cmdr_name')
      .in('id', authorIds);

    const profileMap = new Map((profiles || []).map((p: any) => [p.id, p.cmdr_name]));

    const enriched: Comment[] = (commentsData || []).map((c: any) => ({
      ...c,
      author: { cmdr_name: profileMap.get(c.author_id) || 'Пилот' },
    }));

    setComments(enriched);
    setLoading(false);
  }

  useEffect(() => {
    loadComments();
  }, [filter]);

  async function deleteComment(id: number) {
    if (!confirm('Удалить комментарий #' + id + '?')) return;
    const { error } = await supabase.from('comments').delete().eq('id', id);
    if (!error) {
      setComments((prev) => prev.filter((c) => c.id !== id));
    } else {
      alert('Ошибка удаления: ' + error.message);
    }
  }

  if (loading) return <p style={{ color: '#9ca3af' }}>Загрузка комментариев...</p>;

  return (
    <div>
      <div style={{ marginBottom: 16, display: 'flex', gap: 8 }}>
        <button
          className={filter === 'all' ? 'tab tab-active' : 'tab'}
          onClick={() => setFilter('all')}
        >
          Все ({comments.length})
        </button>
        <button
          className={filter === 'galnet' ? 'tab tab-active' : 'tab'}
          onClick={() => setFilter('galnet')}
        >
          Galnet
        </button>
        <button
          className={filter === 'news' ? 'tab tab-active' : 'tab'}
          onClick={() => setFilter('news')}
        >
          Новости
        </button>
      </div>

      {comments.length === 0 ? (
        <p style={{ color: '#9ca3af' }}>Комментариев нет.</p>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="admin-comments-table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Тип</th>
                <th>Цель</th>
                <th>Автор</th>
                <th>Комментарий</th>
                <th>Дата</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {comments.map((c) => (
                <tr key={c.id}>
                  <td>{c.id}</td>
                  <td>
                    <span
                      style={{
                        padding: '2px 8px',
                        borderRadius: 4,
                        fontSize: 12,
                        background: c.target_type === 'galnet' ? 'rgba(230,126,34,0.2)' : 'rgba(52,152,219,0.2)',
                        color: c.target_type === 'galnet' ? '#e67e22' : '#3498db',
                      }}
                    >
                      {c.target_type === 'galnet' ? 'Galnet' : 'Новость'}
                    </span>
                  </td>
                  <td className="admin-comment-target">{c.target_id.slice(0, 24)}...</td>
                  <td>{c.author?.cmdr_name || '—'}</td>
                  <td className="admin-comment-content" title={c.content}>
                    {c.content}
                  </td>
                  <td style={{ fontSize: 13, color: '#888', whiteSpace: 'nowrap' }}>
                    {new Date(c.created_at).toLocaleString('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>
                  <td>
                    <button
                      onClick={() => deleteComment(c.id)}
                      className="btn btn-danger"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                    >
                      Удалить
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
