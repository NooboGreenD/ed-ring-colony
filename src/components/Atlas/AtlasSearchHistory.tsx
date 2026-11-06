'use client';

import { useMemo, useState } from 'react';
import { useAtlas } from '@/components/Atlas/AtlasContext';
import { CollapsibleSection } from '@/components/Atlas/CollapsibleSection';
import { IconRefresh, IconSearch, IconTrash, IconX } from '@/components/Icons';
import { formatDateTime, relativeTime, worldTypeLabel } from '@/lib/atlas';
import { useI18n } from '@/lib/i18n/I18nContext';
import type { AtlasSearchSession } from '@/types/atlas';

interface Props {
  onSelectSession: (session: AtlasSearchSession) => void;
}

const STATUS_LABELS: Record<string, { text: string; color: string }> = {
  pending: { text: 'atlas.ui.statusPending', color: '#f39c12' },
  running: { text: 'atlas.ui.statusRunning', color: '#60a5fa' },
  completed: { text: 'atlas.ui.statusDone', color: '#4ade80' },
  failed: { text: 'atlas.ui.statusFailed', color: '#e74c3c' },
};

export function AtlasSearchHistory({ onSelectSession }: Props) {
  const { t, locale } = useI18n();
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
      title={t('atlas.ui.historyTitle')}
      count={sessions.length}
      storageKey="history"
      actions={
        <button type="button" className="atlas-icon-btn" onClick={() => void refreshSessions()} title={t('atlas.ui.refreshHistory')}>
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
            placeholder={t('atlas.ui.historyFilterPlaceholder')}
            aria-label={t('atlas.ui.historyFilterAria')}
            />
            {query && (
              <button type="button" onClick={() => setQuery('')} aria-label={t('atlas.clearFilter')}>
                <IconX size={11} />
              </button>
            )}
          </div>
          <label className="atlas-checkbox-row">
            <input type="checkbox" checked={onlyCompleted} onChange={(event) => setOnlyCompleted(event.target.checked)} />
            {t('atlas.ui.onlyCompleted')}
          </label>
        </>
      )}

      {sessionsLoading && sessions.length === 0 && <p className="atlas-muted">{t('atlas.loadingDots')}</p>}
      {!sessionsLoading && sessions.length === 0 && (
        <p className="atlas-muted">
          {sessionsNeedAuth ? t('atlas.ui.historySignIn') : t('atlas.ui.historyEmpty')}
        </p>
      )}
      {sessions.length > 0 && visible.length === 0 && <p className="atlas-muted">{t('atlas.ui.nothingFound')}</p>}

      <div className="atlas-list">
        {visible.map((session) => {
          const meta = STATUS_LABELS[session.status];
          const statusLabel = meta ? t(meta.text) : session.status;
          const statusColor = meta ? meta.color : 'var(--muted)';
          const isLocal = session.id.startsWith('local:');
          return (
            <div key={session.id} className="atlas-history-item">
              <button type="button" className="atlas-history-main" onClick={() => onSelectSession(session)}>
                <span className="row">
                  <span className="ref">{session.reference_system}</span>
                  <span className="status" style={{ color: statusColor }}>{statusLabel}</span>
                </span>
                <span className="meta">
                  {session.cube_size_ly > 0 ? `${t('atlas.ui.cubeSize', { value: session.cube_size_ly })} · ` : ''}
                  {session.world_types.length > 0
                    ? `${t('atlas.ui.worldTypesList', {
                      count: session.world_types.length,
                      types: session.world_types.slice(0, 3).map(worldTypeLabel).join(', '),
                    })}${session.world_types.length > 3 ? '…' : ''}`
                    : t('atlas.ui.noTypeFilter')}
                </span>
                <span className="date" title={formatDateTime(session.created_at, locale)}>
                  {relativeTime(session.created_at, new Date(), t)}
                  {isLocal ? t('atlas.ui.localSuffix') : ''}
                </span>
              </button>
              {isLocal && (
                <button
                  type="button"
                  className="atlas-icon-btn danger"
                  title={t('atlas.ui.deleteLocal')}
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
