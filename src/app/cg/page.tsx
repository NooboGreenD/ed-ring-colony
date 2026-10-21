'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';

type GoalFilter = 'active' | 'colonisation' | 'completed';

interface CommunityGoal {
  id: number;
  cg_id: number;
  title: string;
  description: string | null;
  system_name: string | null;
  station_name: string | null;
  objective: string | null;
  reward: string | null;
  tier_current: number | null;
  tier_max: number | null;
  contributors: number | null;
  contributions_total: number | string | null;
  commander_reports: {
    commander_count: number;
    player_contribution_total: number;
    journal_current_total: number | null;
    reported_at: string | null;
  } | null;
  is_complete: boolean;
  is_colonisation_related: boolean;
  expiry_date: string | null;
  inara_url: string | null;
  source_updated_at: string | null;
}

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export default function CGPage() {
  const { t, locale } = useI18n();
  const [goals, setGoals] = useState<CommunityGoal[]>([]);
  const [filter, setFilter] = useState<GoalFilter>('active');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [reload, setReload] = useState(0);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const refreshTimer = window.setInterval(() => setReload((value) => value + 1), REFRESH_INTERVAL_MS);
    setLoading(true);
    setError(false);

    fetch(`/api/cg?filter=${filter}`, { signal: controller.signal, cache: 'no-store' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Community goals request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        setGoals(Array.isArray(data.goals) ? data.goals : []);
        setUpdatedAt(typeof data.updatedAt === 'string' ? data.updatedAt : null);
        setLoading(false);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === 'AbortError') return;
        setGoals([]);
        setError(true);
        setLoading(false);
      });

    return () => {
      controller.abort();
      window.clearInterval(refreshTimer);
    };
  }, [filter, reload]);

  const filters: { key: GoalFilter; label: string }[] = [
    { key: 'active', label: t('cg.filter.active') },
    { key: 'colonisation', label: t('cg.filter.colonisation') },
    { key: 'completed', label: t('cg.filter.completed') },
  ];
  const updatedDate = updatedAt ? new Date(updatedAt) : null;

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', width: '100%' }}>
      <section className="card">
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <h1>{t('cg.title')}</h1>
          {updatedDate && Number.isFinite(updatedDate.getTime()) && (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              {t('cg.updated')}: <time dateTime={updatedDate.toISOString()}>{updatedDate.toLocaleString(locale)}</time>
            </span>
          )}
        </div>

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
                  const current = typeof goal.tier_current === 'number' && Number.isFinite(goal.tier_current)
                    ? Math.max(0, goal.tier_current)
                    : null;
                  const max = typeof goal.tier_max === 'number' && Number.isFinite(goal.tier_max)
                    ? Math.max(0, goal.tier_max)
                    : null;
                  const tierPercent = current !== null && max !== null && max > 0
                    ? Math.max(0, Math.min(100, (current / max) * 100))
                    : 0;
                  const expiry = goal.expiry_date ? new Date(goal.expiry_date) : null;
                  const lastSourceUpdate = goal.source_updated_at ? new Date(goal.source_updated_at) : null;
                  return (
                    <tr key={goal.cg_id || goal.id}>
                      <td style={{ minWidth: 250 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontWeight: 600 }}>
                          {goal.title}
                          <span style={{
                            color: goal.is_complete ? 'var(--muted)' : 'var(--green, #7ecb8f)',
                            border: '1px solid var(--line)', borderRadius: 3, padding: '2px 6px', fontSize: 10, fontWeight: 500,
                          }}>
                            {t(goal.is_complete ? 'cg.filter.completed' : 'cg.filter.active')}
                          </span>
                          {goal.is_colonisation_related && (
                            <span style={{ color: 'var(--orange)', border: '1px solid rgba(230,126,34,.4)', borderRadius: 3, padding: '2px 6px', fontSize: 10, fontWeight: 500 }}>
                              {t('cg.filter.colonisation')}
                            </span>
                          )}
                        </div>
                        {goal.objective && <div style={{ color: 'var(--muted)', fontSize: 12, marginTop: 5 }}>{goal.objective}</div>}
                        {goal.reward && <div style={{ color: 'var(--cyan)', fontSize: 11, marginTop: 5 }}>{t('cg.reward')}: {goal.reward}</div>}
                        {goal.description && goal.description !== goal.objective && (
                          <details style={{ marginTop: 7, color: 'var(--muted)', fontSize: 11, lineHeight: 1.5 }}>
                            <summary style={{ cursor: 'pointer' }}>{t('cg.details')}</summary>
                            <div style={{ marginTop: 5, whiteSpace: 'pre-line' }}>{goal.description}</div>
                          </details>
                        )}
                        {goal.inara_url && (
                          <a href={goal.inara_url} target="_blank" rel="noreferrer" style={{ display: 'inline-block', marginTop: 6, color: 'var(--cyan)', fontSize: 11 }}>
                            INARA ↗
                          </a>
                        )}
                      </td>
                      <td>
                        {goal.system_name || '—'}
                        {goal.station_name && <div style={{ color: 'var(--muted)', fontSize: 11 }}>{goal.station_name}</div>}
                      </td>
                      <td style={{ minWidth: 165 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <div style={{ width: 72, height: 6, borderRadius: 4, background: 'var(--line)', overflow: 'hidden' }}>
                            <div style={{ width: `${tierPercent}%`, height: '100%', borderRadius: 4, background: 'var(--orange)' }} />
                          </div>
                          <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, whiteSpace: 'nowrap' }}>
                            {current === null ? '—' : `${current.toLocaleString(locale)}${max && max > 0 ? `/${max.toLocaleString(locale)}` : ''}`}
                          </span>
                        </div>
                        {goal.contributions_total !== null && goal.contributions_total !== undefined && (
                          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 5 }}>
                            {t('cg.contributions')}: {Number(goal.contributions_total).toLocaleString(locale)}
                          </div>
                        )}
                        {goal.commander_reports && goal.commander_reports.commander_count > 0 && (
                          <div style={{ color: 'var(--muted)', fontSize: 11, marginTop: 5, lineHeight: 1.5 }}>
                            <div>
                              {t('cg.commanderReports')}: {goal.commander_reports.commander_count.toLocaleString(locale)} · {t('cg.contributions')}: {goal.commander_reports.player_contribution_total.toLocaleString(locale)}
                            </div>
                            {goal.commander_reports.journal_current_total !== null && goal.contributions_total !== null && goal.contributions_total !== undefined && (
                              <div>
                                {t('cg.journalCompare')}: {goal.commander_reports.journal_current_total.toLocaleString(locale)} / {Number(goal.contributions_total).toLocaleString(locale)}
                                {' · Δ '}
                                {(goal.commander_reports.journal_current_total - Number(goal.contributions_total)).toLocaleString(locale)}
                              </div>
                            )}
                          </div>
                        )}
                      </td>
                      <td style={{ fontFamily: 'ui-monospace, monospace' }}>
                        {typeof goal.contributors === 'number' ? goal.contributors.toLocaleString(locale) : '—'}
                      </td>
                      <td style={{ whiteSpace: 'nowrap', fontFamily: 'ui-monospace, monospace', fontSize: 11 }}>
                        {expiry && Number.isFinite(expiry.getTime()) ? expiry.toLocaleDateString(locale) : '—'}
                        {lastSourceUpdate && Number.isFinite(lastSourceUpdate.getTime()) && (
                          <div style={{ color: 'var(--muted)', fontSize: 10, marginTop: 4 }}>
                            {t('cg.updated')}: {lastSourceUpdate.toLocaleString(locale)}
                          </div>
                        )}
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
