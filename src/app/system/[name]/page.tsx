'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';

interface SystemData {
  system_name: string;
  progress: number | null;
  status: string;
  found: boolean;
  siteName: string | null;
  architectName: string | null;
  projects: any[];
  resources: any[];
  bodies?: any[];
  error?: string;
}

export default function SystemPage() {
  const { name } = useParams();
  const systemName = decodeURIComponent(name as string);
  const [system, setSystem] = useState<SystemData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/systems/progress?name=${encodeURIComponent(systemName)}`)
      .then(r => r.json())
      .then(data => setSystem(data))
      .catch(() => setSystem(null))
      .finally(() => setLoading(false));
  }, [systemName]);

  if (loading) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40, textAlign: 'center' }}>
        <div style={{ color: '#e67e22', fontFamily: 'ui-monospace, monospace', fontSize: 14, letterSpacing: 2 }}>
          Загрузка системы...
        </div>
      </main>
    );
  }

  if (!system || system.error) {
    return (
      <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 40 }}>
        <h1 style={{ color: '#e74c3c' }}>❌ Система не найдена</h1>
        <p style={{ color: '#9ca3af' }}>{system?.error || 'Не удалось загрузить данные системы'}</p>
        <Link href="/map" style={{ color: '#3b82f6', textDecoration: 'none' }}>← Вернуться к карте</Link>
      </main>
    );
  }

  return (
    <main className="card" style={{ maxWidth: 900, margin: '40px auto', padding: 32 }}>
      <div style={{ marginBottom: 24 }}>
        <Link href="/map" style={{ color: '#9ca3af', textDecoration: 'none', fontSize: 13 }}>← Назад к карте</Link>
      </div>

      <h1 style={{ fontSize: 28, color: '#eeeeee', marginBottom: 8 }}>{systemName}</h1>

      <div style={{ display: 'flex', gap: 10, marginBottom: 24, flexWrap: 'wrap' }}>
        <a
          href={`https://ravencolonial.com/#sys=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: 'rgba(230,126,34,0.15)',
            border: '1px solid rgba(230,126,34,0.4)',
            color: '#e67e22',
            borderRadius: 6,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          🦅 RavenColonial ↗
        </a>
        <a
          href={`https://www.edsm.net/en/system?systemName=${encodeURIComponent(systemName)}`}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            padding: '8px 16px',
            background: 'rgba(59,130,246,0.15)',
            border: '1px solid rgba(59,130,246,0.4)',
            color: '#3b82f6',
            borderRadius: 6,
            textDecoration: 'none',
            fontSize: 13,
            fontWeight: 600,
            display: 'flex',
            alignItems: 'center',
            gap: 6
          }}
        >
          🌌 EDSM ↗
        </a>
      </div>

      {system.found && (
        <>
          <div style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 20, marginBottom: 24 }}>
            <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}>📊 Статус строительства</h2>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
              <div>
                <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Прогресс</div>
                <div style={{ fontSize: 32, fontWeight: 700, color: system.progress === 100 ? '#22c55e' : '#e67e22' }}>
                  {system.progress ?? 0}%
                </div>
              </div>
              <div>
                <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Статус</div>
                <div style={{
                  fontSize: 16,
                  fontWeight: 600,
                  color: system.status === 'done' ? '#22c55e' : system.status === 'building' ? '#e67e22' : '#3b82f6'
                }}>
                  {system.status === 'done' ? '✅ Завершён' : system.status === 'building' ? '🏗️ Строительство' : '📋 Запланирован'}
                </div>
              </div>
              {system.siteName && (
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Сайт</div>
                  <div style={{ fontSize: 16, color: '#eeeeee' }}>{system.siteName}</div>
                </div>
              )}
              {system.architectName && (
                <div>
                  <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 4 }}>Архитектор</div>
                  <div style={{ fontSize: 16, color: '#eeeeee' }}>{system.architectName}</div>
                </div>
              )}
            </div>
          </div>

          {system.projects && system.projects.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}>🏗️ Проекты</h2>
              <div style={{ display: 'grid', gap: 12 }}>
                {system.projects.map((proj: any) => (
                  <div key={proj.buildId} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 10, padding: 16 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                      <span style={{ fontSize: 16, fontWeight: 600, color: '#eeeeee' }}>{proj.buildName}</span>
                      <span style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: proj.complete ? '#22c55e' : '#e67e22',
                        padding: '4px 10px',
                        background: proj.complete ? 'rgba(34,197,94,0.1)' : 'rgba(230,126,34,0.1)',
                        borderRadius: 4
                      }}>
                        {proj.complete ? '✅ Завершён' : `${proj.progress}%`}
                      </span>
                    </div>
                    {proj.buildType && <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Тип: {proj.buildType}</div>}
                    {proj.bodyName && <div style={{ fontSize: 13, color: '#9ca3af', marginBottom: 4 }}>Тело: {proj.bodyName}</div>}

                    {proj.resources && proj.resources.length > 0 && (
                      <div style={{ marginTop: 12 }}>
                        <div style={{ fontSize: 11, color: '#9ca3af', textTransform: 'uppercase', marginBottom: 8, fontWeight: 600 }}>Ресурсы</div>
                        {proj.resources.map((r: any) => (
                          <div key={r.key} style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
                            <span style={{ color: '#eeeeee', fontSize: 13, minWidth: 120 }}>{r.name}</span>
                            <div style={{ flex: 1, background: '#3a3d40', borderRadius: 4, height: 8, overflow: 'hidden' }}>
                              <div style={{
                                width: `${Math.min(100, (r.provided / Math.max(r.required, 1)) * 100)}%`,
                                background: r.remaining === 0 ? '#22c55e' : '#3b82f6',
                                height: '100%',
                                borderRadius: 4
                              }} />
                            </div>
                            <span style={{ color: '#9ca3af', fontSize: 12, minWidth: 100, textAlign: 'right' }}>
                              {r.provided.toLocaleString()} / {r.required.toLocaleString()}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {system.resources && system.resources.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h2 style={{ fontSize: 18, color: '#eeeeee', marginBottom: 16 }}>📦 Общие ресурсы системы</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(250px, 1fr))', gap: 10 }}>
                {system.resources.map((r: any) => (
                  <div key={r.key} style={{ background: '#25282b', border: '1px solid #323538', borderRadius: 8, padding: '12px 16px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ color: '#eeeeee', fontSize: 14 }}>{r.name}</span>
                    <span style={{ color: r.remaining === 0 ? '#22c55e' : '#e67e22', fontSize: 14, fontWeight: 600 }}>
                      {r.provided.toLocaleString()} / {r.required.toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {!system.found && (
        <div style={{ background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 10, padding: 20, textAlign: 'center' }}>
          <div style={{ fontSize: 18, color: '#e74c3c', marginBottom: 8 }}>❌ Система не найдена в RavenColonial</div>
          <div style={{ fontSize: 13, color: '#9ca3af' }}>
            Возможно, строительство ещё не начато или данные не синхронизированы.
          </div>
        </div>
      )}
    </main>
  );
}
