"use client";

import { useEffect } from 'react';
import { useAtlasHistory } from '@/hooks/useAtlasHistory';
import type { AtlasSearchSession } from '@/types/atlas';

interface Props {
  onSelectSession: (session: AtlasSearchSession) => void;
}

export function AtlasSearchHistory({ onSelectSession }: Props) {
  const { sessions, loading, fetchSessions } = useAtlasHistory();

  useEffect(() => { fetchSessions(); }, [fetchSessions]);

  const statusColors: Record<string, string> = {
    pending: '#f39c12',
    running: '#60a5fa',
    completed: '#4ade80',
    failed: '#e74c3c',
  };

  return (
    <div className="atlas-section">
      <h4>История поисков</h4>
      {loading && <p className="empty">Загрузка...</p>}
      {sessions.length === 0 && !loading && (
        <p className="empty">История пуста</p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {sessions.map((s) => (
          <button
            key={s.id}
            onClick={() => onSelectSession(s)}
            className="atlas-history-item"
          >
            <div className="row">
              <span className="ref">{s.reference_system}</span>
              <span className="status" style={{ color: statusColors[s.status] || 'var(--muted)' }}>
                {s.status}
              </span>
            </div>
            <div className="meta">
              {s.cube_size_ly} ly · {s.world_types.length} типов
            </div>
            <div className="date">
              {new Date(s.created_at).toLocaleString('ru-RU')}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
