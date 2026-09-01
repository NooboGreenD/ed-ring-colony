'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { useI18n } from '@/lib/i18n/I18nContext';

interface CommentAuthor {
  id: string;
  cmdr_name: string;
  avatar_url: string | null;
}

interface Comment {
  id: number;
  content: string;
  created_at: string;
  updated_at: string;
  author_id: string;
  author: CommentAuthor | null;
}

interface CommentSectionProps {
  targetType: 'galnet' | 'news';
  targetId: string;
}

export default function CommentSection({ targetType, targetId }: CommentSectionProps) {
  const { t, locale } = useI18n();
  const [comments, setComments] = useState<Comment[]>([]);
  const [total, setTotal] = useState(0);
  const [newComment, setNewComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [user, setUser] = useState<any>(null);
  const [userRole, setUserRole] = useState<string>('');

  useEffect(() => {
    loadComments();
    checkUser();
  }, [targetType, targetId]);

  async function checkUser() {
    const { data: { user } } = await supabase.auth.getUser();
    if (user) {
      setUser(user);
      const { data: profile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', user.id)
        .single();
      setUserRole(profile?.role || '');
    }
  }

  async function loadComments() {
    setLoading(true);
    try {
      const res = await fetch(`/api/comments?target_type=${targetType}&target_id=${targetId}`);
      const data = await res.json();
      setComments(data.comments || []);
      setTotal(data.total || 0);
    } catch (e) {
      console.error('Failed to load comments:', e);
    } finally {
      setLoading(false);
    }
  }

  async function submitComment() {
    if (!newComment.trim()) return;
    
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      alert(t('comments.loginHint'));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch('/api/comments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          target_type: targetType,
          target_id: targetId,
          content: newComment.trim(),
        }),
      });

      if (res.ok) {
        setNewComment('');
        await loadComments();
      } else {
        const err = await res.json();
        alert(err.error || t('comments.submitError'));
      }
    } catch (e) {
      alert(t('comments.networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function deleteComment(id: number) {
    if (!confirm(t('comments.deleteConfirm'))) return;

    const { data: { session } } = await supabase.auth.getSession();
    if (!session) return;

    try {
      const res = await fetch(`/api/comments/${id}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${session.access_token}`,
        },
      });

      if (res.ok) {
        await loadComments();
      } else {
        alert(t('comments.deleteError'));
      }
    } catch (e) {
      alert(t('comments.networkError'));
    }
  }

  const canDelete = (comment: Comment) => {
    if (!user) return false;
    if (user.id === comment.author_id) return true;
    if (['admin', 'moderator'].includes(userRole)) return true;
    return false;
  };

  return (
    <div className="comments-section">
      <h4 className="comments-title">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
        {t('comments.title')} ({total})
      </h4>

      {user ? (
        <div className="comment-form">
          <textarea
            value={newComment}
            onChange={(e) => setNewComment(e.target.value)}
            placeholder={t('comments.placeholder')}
            maxLength={2000}
            rows={3}
          />
          <div className="comment-form-footer">
            <span className="char-count">{newComment.length}/2000</span>
            <button
              onClick={submitComment}
              disabled={submitting || !newComment.trim()}
              className="btn btn-primary"
            >
              {submitting ? t('comments.submitting') : t('comments.submit')}
            </button>
          </div>
        </div>
      ) : (
        <p className="comment-login-hint">
          <a href="/login">{t('account.login')}</a>, {t('comments.loginHint')}
        </p>
      )}

      {loading ? (
        <p className="comments-loading">{t('comments.loading')}</p>
      ) : comments.length === 0 ? (
        <p className="comments-empty">{t('comments.empty')}</p>
      ) : (
        <div className="comments-list">
          {comments.map((comment) => (
            <div key={comment.id} className="comment">
              <div className="comment-header">
                <span className="comment-author">
                  {comment.author?.cmdr_name || t('comments.anonymous')}
                </span>
                <span className="comment-date">
                  {new Date(comment.created_at).toLocaleString(locale, {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
                {canDelete(comment) && (
                  <button
                    onClick={() => deleteComment(comment.id)}
                    className="comment-delete-btn"
                    title={t('comments.delete')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <polyline points="3 6 5 6 21 6"/>
                      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                    </svg>
                  </button>
                )}
              </div>
              <p className="comment-content">{comment.content}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
