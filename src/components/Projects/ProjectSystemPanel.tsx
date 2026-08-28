"use client";

import { useState } from 'react';
import type { ProjectSystem } from '@/types/project';

interface Props {
  system: ProjectSystem;
  onUpdate: () => void;
  canEdit: boolean;
}

export default function ProjectSystemPanel({ system, onUpdate, canEdit }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [syncing, setSyncing] = useState(false);

  // Парсим кэш RavenColonial из notes
  let ravenData: any = null;
  try {
    if (system.notes?.startsWith('{')) {
      ravenData = JSON.parse(system.notes);
    }
  } catch {}

  const syncSystem = async () => {
    setSyncing(true);
    try {
      const res = await fetch(`/api/ravencolonial/sync/single`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ system_name: system.system_name }),
      });
      if (!res.ok) throw new Error('Sync failed');
      onUpdate();
    } catch (e: any) {
      alert(e.message);
    } finally {
      setSyncing(false);
    }
  };

  const statusColors: Record<string, string> = {
    planned: '#3b82f6',
    preparing: '#a78bfa',
    building: '#e67e22',
    done: '#22c55e',
    on_hold: '#e74c3c',
  };

  return (
    <div style={{
      background: '#25282b',
      border: '1px solid #323538',
      borderRadius: 10,
      overflow: 'hidden',
      borderLeft: `3px solid ${statusColors[system.planned_status]}`,
    }}>
      <div 
        onClick={() => setExpanded(!expanded)}
        style={{
          padding: '14px 16px',
          cursor: 'pointer',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            padding: '3px 10px',
            borderRadius: 12,
            fontSize: 11,
            fontWeight: 600,
            background: `${statusColors[system.planned_status]}20`,
            color: statusColors[system.planned_status],
          }}>
            {system.planned_status}
          </span>
          <div>
            <div style={{ color: '#eeeeee', fontWeight: 600, fontSize: 14 }}>
              {system.system_name}
            </div>
            {system.assignee && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                Назначен: {system.assignee.cmdr_name}
              </div>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          {system.priority > 1 && (
            <span style={{ fontSize: 11, color: '#e67e22' }}>
              {'⭐'.repeat(system.priority)}
            </span>
          )}
          {system.target_date && (
            <span style={{ fontSize: 11, color: '#9ca3af' }}>
              🎯 {new Date(system.target_date).toLocaleDateString('ru-RU')}
            </span>
          )}
          <span style={{ color: '#9ca3af', fontSize: 12 }}>
            {expanded ? '▲' : '▼'}
          </span>
        </div>
      </div>

      {expanded && (
        <div style={{ padding: '0 16px 16px', borderTop: '1px solid #323538' }}>
          {ravenData && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 12, color: '#9ca3af' }}>
                  {ravenData.siteName && <span>📍 {ravenData.siteName} · </span>}
                  {ravenData.architectName && <span>👷 {ravenData.architectName} · </span>}
                  <span>📦 {ravenData.projects?.length || 0} проектов</span>
                </div>
                {ravenData.progress != null && (
                  <div style={{ fontSize: 18, fontWeight: 700, color: ravenData.progress === 100 ? '#22c55e' : '#e67e22' }}>
                    {ravenData.progress}%
                  </div>
                )}
              </div>

              {ravenData.projects?.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                  {ravenData.projects.map((proj: any) => (
                    <div key={proj.buildId} style={{
                      background: '#323538',
                      borderRadius: 6,
                      padding: 10,
                      fontSize: 12,
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                        <span style={{ color: '#eeeeee', fontWeight: 600 }}>{proj.buildName}</span>
                        <span style={{ color: proj.complete ? '#22c55e' : '#e67e22', fontWeight: 600 }}>
                          {proj.complete ? '✅' : `${proj.progress}%`}
                        </span>
                      </div>
                      {proj.resources?.length > 0 && (
                        <div style={{ marginTop: 6 }}>
                          {proj.resources.map((r: any) => (
                            <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
                              <span style={{ color: '#9ca3af', minWidth: 100, fontSize: 11 }}>{r.name}</span>
                              <div style={{ flex: 1, background: '#3a3d40', borderRadius: 3, height: 5 }}>
                                <div style={{
                                  width: `${Math.min(100, (r.provided / Math.max(r.required, 1)) * 100)}%`,
                                  background: r.remaining === 0 ? '#22c55e' : '#3b82f6',
                                  height: '100%',
                                  borderRadius: 3,
                                }} />
                              </div>
                              <span style={{ color: '#9ca3af', fontSize: 10, minWidth: 70, textAlign: 'right' }}>
                                {r.provided.toLocaleString()}/{r.required.toLocaleString()}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {ravenData.resources?.length > 0 && !ravenData.projects?.length && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {ravenData.resources.map((r: any) => (
                    <div key={r.key} style={{
                      background: '#323538',
                      borderRadius: 6,
                      padding: '8px 12px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      fontSize: 12,
                    }}>
                      <span style={{ color: '#eeeeee' }}>{r.name}</span>
                      <span style={{ color: r.remaining === 0 ? '#22c55e' : '#e67e22', fontWeight: 600 }}>
                        {r.provided}/{r.required}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 10, fontSize: 11, color: '#9ca3af' }}>
                Синхронизировано: {ravenData.synced_at ? new Date(ravenData.synced_at).toLocaleString('ru-RU') : '—'}
              </div>
            </div>
          )}

          {!ravenData && (
            <div style={{ padding: '20px 0', textAlign: 'center', color: '#9ca3af', fontSize: 13 }}>
              Нет данных RavenColonial. Выполните синхронизацию.
            </div>
          )}

          {canEdit && (
            <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
              <button
                onClick={syncSystem}
                disabled={syncing}
                style={{
                  padding: '6px 12px',
                  background: syncing ? '#3a3d40' : 'rgba(59,130,246,0.15)',
                  border: '1px solid rgba(59,130,246,0.4)',
                  color: '#60a5fa',
                  borderRadius: 6,
                  fontSize: 12,
                  cursor: syncing ? 'not-allowed' : 'pointer',
                }}
              >
                {syncing ? '🔄 Синхронизация...' : '🔄 Синхронизировать RC'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
