'use client';

import { useState, useEffect } from 'react';

interface CommunityGoal {
  id: number;
  cg_id: number;
  title: string;
  system_name: string;
  station_name: string;
  objective: string;
  reward: string;
  tier_current: number;
  tier_max: number;
  contributors: number;
  is_colonisation_related: boolean;
  expiry_date: string;
}

export default function CGPage() {
  const [goals, setGoals] = useState<CommunityGoal[]>([]);
  const [filter, setFilter] = useState('active');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/cg?filter=${filter}`).then(r => r.json()).then(d => {
      setGoals(d.goals || []);
      setLoading(false);
    });
  }, [filter]);

  return (
    <div style={{ padding: '24px 20px', maxWidth: 1200 }}>
      <h2 style={{ fontSize: 18, fontWeight: 700, letterSpacing: '2px', textTransform: 'uppercase', marginBottom: 20 }}>
        ОБЩЕСТВЕННЫЕ ЦЕЛИ
      </h2>

      <div className="tabs" style={{ marginBottom: 20 }}>
        {[
          { key: 'active', label: 'Активные' },
          { key: 'colonisation', label: 'Колонизация' },
          { key: 'completed', label: 'Завершённые' },
        ].map((t) => (
          <button key={t.key} className={`tab ${filter === t.key ? 'tab-active' : ''}`} onClick={() => setFilter(t.key)}>
            {t.label}
          </button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)' }}>Загрузка...</p>
      ) : goals.length === 0 ? (
        <p style={{ color: 'var(--muted)' }}>Нет общественных целей</p>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>Название</th><th>Система</th><th>Прогресс</th><th>Участников</th><th>Истекает</th></tr>
            </thead>
            <tbody>
              {goals.map((g) => (
                <tr key={g.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      {g.is_colonisation_related && <span className="cg-badge">Колонизация</span>}
                      {g.title}
                    </div>
                  </td>
                  <td>{g.system_name}<br/><span style={{ color: 'var(--muted)', fontSize: 11 }}>{g.station_name}</span></td>
                  <td>
                    <div className="cg-progress-track">
                      <div className="cg-progress-bar">
                        <div className="cg-progress-fill" style={{ width: `${g.tier_max ? (g.tier_current / g.tier_max) * 100 : 0}%` }} />
                      </div>
                      <span style={{ fontFamily: 'ui-monospace', fontSize: 11, minWidth: 40 }}>{g.tier_current}/{g.tier_max}</span>
                    </div>
                  </td>
                  <td style={{ fontFamily: 'ui-monospace' }}>{g.contributors?.toLocaleString('ru-RU')}</td>
                  <td style={{ fontFamily: 'ui-monospace', fontSize: 11 }}>
                    {g.expiry_date ? new Date(g.expiry_date).toLocaleDateString('ru-RU') : '—'}
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
