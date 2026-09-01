"use client";

import { useState } from 'react';

interface Props {
  postId?: number;
  threadId?: number;
}

export function ForumReportButton({ postId, threadId }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState(false);

  const submit = async () => {
    if (!reason.trim()) return;
    const res = await fetch('/api/forum/report', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ post_id: postId, thread_id: threadId, reason }),
    });
    if (res.ok) {
      setSent(true);
      setTimeout(() => { setOpen(false); setSent(false); setReason(''); }, 2000);
    }
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        style={{
          background: 'none',
          border: 'none',
          color: '#9ca3af',
          fontSize: 11,
          cursor: 'pointer',
        }}
      >
        🚩 Пожаловаться
      </button>
    );
  }

  return (
    <div style={{ marginTop: 8, padding: 8, background: '#323538', borderRadius: 6 }}>
      {sent ? (
        <p style={{ color: '#4ade80', fontSize: 12 }}>Жалоба отправлена</p>
      ) : (
        <>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Причина жалобы..."
            style={{
              width: '100%',
              padding: 6,
              background: '#25282b',
              border: '1px solid #3a3d40',
              color: '#eeeeee',
              borderRadius: 4,
              fontSize: 12,
              minHeight: 60,
              resize: 'vertical',
            }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              onClick={submit}
              style={{
                padding: '4px 10px',
                background: '#e74c3c',
                border: 'none',
                color: '#fff',
                borderRadius: 4,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Отправить
            </button>
            <button
              onClick={() => setOpen(false)}
              style={{
                padding: '4px 10px',
                background: 'transparent',
                border: '1px solid #3a3d40',
                color: '#9ca3af',
                borderRadius: 4,
                fontSize: 12,
                cursor: 'pointer',
              }}
            >
              Отмена
            </button>
          </div>
        </>
      )}
    </div>
  );
}
