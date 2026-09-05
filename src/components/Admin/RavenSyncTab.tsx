'use client';

import { useEffect, useState, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface SyncResult {
  system_name: string;
  progress: number | null;
  status: string;
  found: boolean;
  siteName: string | null;
  architectName: string | null;
  projects: any[];
  resources: any[];
  error?: string;
}

interface SyncLog {
  id: number;
  system_name: string;
  system_progress: number | null;
  system_status: string;
  site_name: string | null;
  architect_name: string | null;
  projects: any[];
  resources: any[];
  error_message: string | null;
  synced_at: string;
  sync_type: string;
}

interface RouteSystem {
  id: number;
  system_name: string;
  status: string;
  progress: number;
  x?: number;
  y?: number;
  z?: number;
}

export default function RavenSyncTab() {
  const [routeSystems, setRouteSystems] = useState<RouteSystem[]>([]);
  const [logs, setLogs] = useState<SyncLog[]>([]);
  const [latestBySystem, setLatestBySystem] = useState<Record<string, SyncLog>>({});
  const [loading, setLoading] = useState(false);
  const [currentSystem, setCurrentSystem] = useState<string>('');
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<SyncResult[]>([]);
  const [message, setMessage] = useState('');
  const [isError, setIsError] = useState(false);
  const [detailSystem, setDetailSystem] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    const sup = supabase;
    const [{ data: rs }, logRes] = await Promise.all([
      sup.from('route_systems').select('id,system_name,status,progress,x,y,z').order('sort_order'),
      fetch('/api/ravencolonial/sync/log?limit=100').then(r => r.json()).catch(() => ({ logs: [] }))
    ]);

    setRouteSystems(rs || []);
    setLogs(logRes?.logs || []);

    const map: Record<string, SyncLog> = {};
    (logRes?.latestBySystem || []).forEach((log: SyncLog) => {
      map[log.system_name.toLowerCase()] = log;
    });
    setLatestBySystem(map);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  const runFullSync = async () => {
    if (!routeSystems.length) { setMessage('Нет систем для синхронизации'); return; }
    setLoading(true);
    setProgress(0);
    setResults([]);
    setMessage('');
    setIsError(false);

    const batchSize = 3;
    const allResults: SyncResult[] = [];
    let updated = 0;

    try {
      for (let i = 0; i < routeSystems.length; i += batchSize) {
        const batch = routeSystems.slice(i, i + batchSize);
        const currentNames = batch.map(r => r.system_name);
        setCurrentSystem(currentNames.join(', '));

        const res = await fetch('/api/ravencolonial/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ system_names: currentNames }),
        });

        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status);

        allResults.push(...(data.results || []));
        updated += data.updated || 0;

        setProgress(Math.round(((i + batch.length) / routeSystems.length) * 100));
      }

      setResults(allResults);
      const foundCount = allResults.filter(r => r.found).length;
      const errorCount = allResults.filter(r => r.error).length;
      setMessage(`Синхронизация завершена. Найдено: ${foundCount}, обновлено: ${updated}, ошибок: ${errorCount}`);
      setIsError(false);
      loadData();
    } catch (e: any) {
      setMessage('Ошибка: ' + e.message);
      setIsError(true);
    } finally {
      setLoading(false);
      setCurrentSystem('');
    }
  };

  const getSystemStatus = (name: string) => {
    const log = latestBySystem[name.toLowerCase()];
    if (!log) return { label: 'Не синхронизировано', color: '#9ca3af' };
    if (log.error_message) return { label: 'Ошибка', color: '#e74c3c' };
    if (log.system_status === 'done') return { label: 'Завершено', color: '#22c55e' };
    if (log.system_status === 'building') return { label: 'Строительство', color: '#e67e22' };
    return { label: 'Запланировано', color: '#3b82f6' };
  };

  const formatDate = (d: string) => new Date(d).toLocaleString('ru-RU');

  return (
    <div>
      <h2>🛰️ Синхронизация с RavenColonial</h2>

      <div style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 16, marginBottom: 20 }}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
          <button
            disabled={loading}
            onClick={runFullSync}
            style={{
              padding: '10px 20px',
              background: loading ? '#3a3d40' : 'rgba(139,92,246,0.15)',
              border: '1px solid rgba(139,92,246,0.4)',
              color: '#a78bfa',
              borderRadius: 6,
              cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: 14,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontWeight: 600
            }}
          >
            🔄 Синхронизировать весь маршрут с RavenColonial
          </button>
          <span style={{ fontSize: 12, color: '#9ca3af' }}>
            {routeSystems.length} систем в маршруте
          </span>
        </div>

        {loading && (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6, fontSize: 12, color: '#9ca3af' }}>
              <span>🔄 Обрабатывается: <strong style={{ color: '#e67e22' }}>{currentSystem}</strong></span>
              <span>{progress}%</span>
            </div>
            <div style={{ background: '#323538', borderRadius: 4, height: 8, overflow: 'hidden' }}>
              <div style={{ width: progress + '%', background: 'linear-gradient(90deg, #3b82f6, #8b5cf6)', height: '100%', borderRadius: 4, transition: 'width 0.3s ease' }} />
            </div>
          </div>
        )}

        {message && (
          <div style={{ padding: '10px 14px', borderRadius: 6, background: isError ? 'rgba(239,68,68,0.1)' : 'rgba(34,197,94,0.1)', border: `1px solid ${isError ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`, color: isError ? '#e74c3c' : '#4ade80', fontSize: 13, fontWeight: 500 }}>
            {message}
          </div>
        )}
      </div>

      {results.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ fontSize: 15, color: '#eeeeee', marginBottom: 12 }}>
            📊 Результаты последнего запроса ({results.length} систем)
          </h3>
          <div style={{ display: 'grid', gap: 10 }}>
            {results.map((res) => (
              <div key={res.system_name} onClick={() => setDetailSystem(detailSystem === res.system_name ? null : res.system_name)} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 8, padding: 12, cursor: 'pointer', transition: 'border-color 0.2s', borderLeft: `3px solid ${res.error ? '#e74c3c' : res.status === 'done' ? '#22c55e' : res.status === 'building' ? '#e67e22' : '#3b82f6'}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, color: '#eeeeee', fontSize: 14 }}>{res.system_name}</div>
                    <div style={{ fontSize: 12, color: '#9ca3af', marginTop: 2 }}>
                      {res.found ? (
                        <span>{res.siteName && `📍 ${res.siteName} · `}{res.architectName && `👷 ${res.architectName} · `}📦 Проектов: {res.projects?.length || 0}</span>
                      ) : (
                        <span style={{ color: '#e74c3c' }}>❌ {res.error || 'Не найдено'}</span>
                      )}
                    </div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    {res.found && (
                      <>
                        <div style={{ fontSize: 18, fontWeight: 700, color: res.progress === 100 ? '#22c55e' : '#e67e22' }}>{res.progress}%</div>
                        <div style={{ fontSize: 10, textTransform: 'uppercase', color: res.status === 'done' ? '#22c55e' : '#9ca3af' }}>{res.status === 'done' ? 'Завершён' : res.status === 'building' ? 'Строительство' : 'Запланирован'}</div>
                      </>
                    )}
                  </div>
                </div>

                {detailSystem === res.system_name && res.found && (
                  <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid #323538' }}>
                    {res.projects && res.projects.length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 6, fontWeight: 600 }}>🏗️ Проекты</div>
                        {res.projects.map((proj: any) => (
                          <div key={proj.buildId} style={{ background: '#323538', borderRadius: 6, padding: 10, marginBottom: 8, fontSize: 12 }}>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
                              <span style={{ color: '#eeeeee', fontWeight: 600 }}>{proj.buildName}</span>
                              <span style={{ color: proj.complete ? '#22c55e' : '#e67e22', fontWeight: 600 }}>{proj.complete ? '✅ Завершён' : `${proj.progress}%`}</span>
                            </div>
                            {proj.buildType && <div style={{ color: '#9ca3af', fontSize: 11 }}>Тип: {proj.buildType}</div>}
                            {proj.bodyName && <div style={{ color: '#9ca3af', fontSize: 11 }}>Тело: {proj.bodyName}</div>}
                            {proj.resources && proj.resources.length > 0 && (
                              <div style={{ marginTop: 8 }}>
                                <div style={{ fontSize: 10, color: '#9ca3af', marginBottom: 4 }}>Ресурсы:</div>
                                {proj.resources.map((r: any) => (
                                  <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                                    <span style={{ color: '#eeeeee', minWidth: 100 }}>{r.name}</span>
                                    <div style={{ flex: 1, background: '#3a3d40', borderRadius: 3, height: 6, overflow: 'hidden' }}>
                                      <div style={{ width: `${Math.min(100, (r.provided / Math.max(r.required, 1)) * 100)}%`, background: r.remaining === 0 ? '#22c55e' : '#3b82f6', height: '100%' }} />
                                    </div>
                                    <span style={{ color: '#9ca3af', fontSize: 10, minWidth: 80, textAlign: 'right' }}>{r.provided.toLocaleString()} / {r.required.toLocaleString()}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        ))}
                      </div>
                    )}

                    {res.resources && res.resources.length > 0 && (
                      <div>
                        <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 6, fontWeight: 600 }}>📦 Общие ресурсы системы</div>
                        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                          {res.resources.map((r: any) => (
                            <div key={r.key} style={{ background: '#323538', borderRadius: 6, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                              <span style={{ color: '#eeeeee', fontSize: 12 }}>{r.name}</span>
                              <span style={{ color: r.remaining === 0 ? '#22c55e' : '#e67e22', fontSize: 12, fontWeight: 600 }}>{r.provided.toLocaleString()} / {r.required.toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <h3 style={{ fontSize: 15, color: '#eeeeee', marginBottom: 12 }}>🕐 История синхронизаций</h3>
        {logs.length === 0 ? (
          <div style={{ color: '#9ca3af', fontSize: 13, padding: 20, textAlign: 'center', background: '#25282b', borderRadius: 8 }}>
            История синхронизаций пуста. Выполните первую синхронизацию.
          </div>
        ) : (
          <div className='table-scroll'>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ borderBottom: '1px solid #323538', textAlign: 'left' }}>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Система</th>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Статус RC</th>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Прогресс</th>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Архитектор</th>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Проекты</th>
                  <th style={{ padding: '10px 12px', color: '#9ca3af', fontWeight: 600 }}>Последняя синхронизация</th>
                </tr>
              </thead>
              <tbody>
                {routeSystems.map((rs) => {
                  const log = latestBySystem[rs.system_name.toLowerCase()];
                  const status = getSystemStatus(rs.system_name);
                  return (
                    <tr key={rs.id} style={{ borderBottom: '1px solid #25282b' }}>
                      <td style={{ padding: '10px 12px', color: '#eeeeee', fontWeight: 500 }}>{rs.system_name}</td>
                      <td style={{ padding: '10px 12px' }}>
                        <span style={{ color: status.color, fontSize: 12, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 8, height: 8, borderRadius: '50%', background: status.color, display: 'inline-block' }} />
                          {status.label}
                        </span>
                      </td>
                      <td style={{ padding: '10px 12px', color: '#eeeeee' }}>{log?.system_progress != null ? `${log.system_progress}%` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>{log?.architect_name || '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>{log?.projects ? `${log.projects.length} проект(ов)` : '—'}</td>
                      <td style={{ padding: '10px 12px', color: '#9ca3af', fontSize: 12 }}>{log ? formatDate(log.synced_at) : 'Никогда'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
