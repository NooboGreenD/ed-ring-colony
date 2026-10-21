'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

type GoalFilter = 'active' | 'colonisation' | 'completed';

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
  const { t, locale } = useI18n();
  const [goals, setGoals] = useState<CommunityGoal[]>([]);
  const [filter, setFilter] = useState<GoalFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(false);

    fetch(`/api/cg?filter=${filter}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Community goals request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        setGoals(Array.isArray(data.goals) ? data.goals : []);
        setLoading(false);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
        setGoals([]);
        setError(true);
        setLoading(false);
      });

    return () => controller.abort();
  }, [filter, reload]);

  const filters: { key: GoalFilter; label: string }[] = [
    { key: 'active', label: t('cg.filter.active') },
    { key: 'colonisation', label: t('cg.filter.colonisation') },
    { key: 'completed', label: t('cg.filter.completed') },
  ];

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <section className="card">
        <h1>{t('cg.title')}</h1>

        <div className="tabs" style={{ margin: '18px 0' }}>
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`tab${filter === item.key ? ' tab-active' : ''}`}
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
            >
              {item.label}
            </button>
          ))}
        </div>

        {loading ? (
          <p role="status" style={{ color: 'var(--muted)' }}>{t('cg.loading')}</p>
        ) : error ? (
          <div role="alert" style={{ color: 'var(--muted)' }}>
            <p>{t('cg.error')}</p>
            <button type="button" className="btn btn-cyan" onClick={() => setReload((value) => value + 1)}>
              {t('cg.retry')}
            </button>
          </div>
        ) : goals.length === 0 ? (
          <p style={{ color: 'var(--muted)' }}>{t('cg.empty')}</p>
        ) : (
          <div className="table-scroll">
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('cg.goal')}</th>
                  <th>{t('cg.system')}</th>
                  <th>{t('cg.progress')}</th>
                  <th>{t('cg.contributors')}</th>
                  <th>{t('cg.expires')}</th>
                </tr>
              </thead>
              <tbody>
                {goals.map((goal) => {
                  const current = Number.isFinite(goal.tier_current) ? Math.max(0, goal.tier_current) : 0;
                  const max = Number.isFinite(goal.tier_max) ? Math.max(0, goal.tier_max) : 0;
                  const percent = max > 0 ? Math.max(0, Math.min(100, (current / max) * 100)) : 0;
                  const expiry = goal.expiry_date ? new Date(goal.expiry_date) : null;
                  return (
                    <tr key={goal.id}>
                      <td style={{ minWidth: 240 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontWeight: 600 }}>
                          {goal.title}
                          {goal.is_colonisation_related && (
                            <span style={{ color: 'var(--orange)', border: '1px solid rgba(230,126,34,.4)', borderRadius: 3, padding: '2px 6px', fontSize: 10, fontWeight: 500 }}>
                              {t('cg.filter.colonisation')}
                            </span>
                          )}
                        </div>
                        {goal.objective && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>{goal.objective}</div>}
                        {goal.reward && <div style={{ color: 'var(--cyan)', fontSize: 11, marginTop: 4 }}>{t('cg.reward')}: {goal.reward}</div>}
                      </td>
                      <td>
                        {goal.system_name || '—'}
                        {goal.station_name && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{goal.station_name}</div>}
                      </td>
                      <td style={{ minWidth: 140 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 72, height: 6, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
                            <div style={{ width: `${percent}%`, height: '100%', borderRadius: 4, background: 'var(--orange)' }} />
                          </div>
                          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, minWidth: 48 }}>
                            {current.toLocaleString(locale)}/{max.toLocaleString(locale)}
                          </span>
                        </div>
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace' }}>
                        {Number.isFinite(goal.contributors) ? goal.contributors.toLocaleString(locale) : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                        {expiry && Number.isFinite(expiry.getTime()) ? expiry.toLocaleDateString(locale) : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
