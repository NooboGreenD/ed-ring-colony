'use client';

import { useMemo, useState } from 'react';
import { useAtlas } from '@/components/Atlas/AtlasContext';
import { CollapsibleSection } from '@/components/Atlas/CollapsibleSection';
import { IconRefresh, IconSearch, IconTrash, IconX } from '@/components/Icons';
import { formatDateTime, relativeTime, worldTypeLabel } from '@/lib/atlas';
import type { AtlasSearchSession } from '@/types/atlas';

interface Props {
  onSelectSession: (session: AtlasSearchSession) => void;
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  pending: { text: 'в очереди', color: '#f39c12' },
  running: { text: 'выполняется', color: '#60a5fa' },
  completed: { text: 'готово', color: '#4ade80' },
  failed: { text: 'ошибка', color: '#e74c3c' },
};

export function AtlasSearchHistory({ onSelectSession }: Props) {
  const { sessions, sessionsLoading, sessionsNeedAuth, refreshSessions, removeSession } = useAtlas();
  const [query, setQuery] = useState('');
  const [onlyCompleted, setOnlyCompleted] = useState(false);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sessions.filter((session) => {
      if (onlyCompleted && session.status !== 'completed') return false;
      if (!q) return true;
      return session.reference_system.toLowerCase().includes(q)
        || session.world_types.some((type) => worldTypeLabel(type).toLowerCase().includes(q));
    });
  }, [onlyCompleted, query, sessions]);

  return (
    <CollapsibleSection
      title="История поисков"
      count={sessions.length}
      storageKey="history"
      actions={
        <button type="button" className="atlas-icon-btn" onClick={() => void refreshSessions()} title="Обновить историю">
          <IconRefresh size={12} />
        </button>
      }
    >
      {sessions.length > 0 && (
        <>
          <div className="atlas-inline-search">
            <IconSearch size={12} />
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Фильтр по системе или типу"
              aria-label="Фильтр истории поисков"
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label="Очистить фильтр">
                <IconX size={11} />
              </button>
            )}
          </div>
          <label className="atlas-checkbox-row">
            <input type="checkbox" checked={onlyCompleted} onChange={(event) => setOnlyCompleted(event.target.checked)} />
            Только завершённые
          </label>
        </>
      )}

      {sessionsLoading && sessions.length === 0 && <p className="atlas-muted">Загрузка…</p>}
      {!sessionsLoading && sessions.length === 0 && (
        <p className="atlas-muted">
          {sessionsNeedAuth
            ? 'Войдите в профиль, чтобы история поисков сохранялась между сессиями.'
            : 'История пуста — запустите первый поиск.'}
        </p>
      )}
      {sessions.length > 0 && visible.length === 0 && <p className="atlas-muted">Ничего не найдено по фильтру.</p>}

      <div className="atlas-list">
        {visible.map((session) => {
          const status = STATUS_LABELS[session.status] || { text: session.status, color: 'var(--muted)' };
          const isLocal = session.id.startsWith('local:');
          return (
            <div key={session.id} className="atlas-history-item">
              <button type="button" className="atlas-history-main" onClick={() => onSelectSession(session)}>
                <span className="row">
                  <span className="ref">{session.reference_system}</span>
                  <span className="status" style={{ color: status.color }}>{status.text}</span>
                </span>
                <span className="meta">
                  {session.cube_size_ly > 0 ? `${session.cube_size_ly} св.л. · ` : ''}
                  {session.world_types.length > 0
                    ? `${session.world_types.length} тип(ов): ${session.world_types.slice(0, 3).map(worldTypeLabel).join(', ')}${session.world_types.length > 3 ? '…' : ''}`
                    : 'без фильтра по типам'}
                </span>
                <span className="date" title={formatDateTime(session.created_at)}>
                  {relativeTime(session.created_at)}
                  {isLocal ? ' · локально' : ''}
                </span>
              </button>
              {isLocal && (
                <button
                  type="button"
                  className="atlas-icon-btn danger"
                  title="Удалить из локальной истории"
                  onClick={() => removeSession(session.id)}
                >
                  <IconTrash size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </CollapsibleSection>
  );
}
