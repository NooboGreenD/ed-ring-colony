'use client';

import { useEffect, useMemo, useState } from 'react';
import { useI18n } from '@/lib/i18n/I18nContext';
import GoalCard, { type CommunityGoal } from '@/components/CommunityGoals/GoalCard';
import styles from './cg.module.css';

type GoalFilter = 'active' | 'colonisation' | 'completed';

const REFRESH_INTERVAL_MS = 10 * 60 * 1000;

export default function CGPage() {
  const { t, locale } = useI18n();
  const [goals, setGoals] = useState<CommunityGoal[]>([]);
  const [filter, setFilter] = useState<GoalFilter>('active');
  const [query, setQuery] = useState('');
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

  const visibleGoals = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    return goals.filter((goal) => !normalized || [goal.title, goal.system_name, goal.station_name, goal.objective]
      .some((value) => value?.toLocaleLowerCase(locale).includes(normalized)));
  }, [goals, locale, query]);

  const filters: { key: GoalFilter; label: string }[] = [
    { key: 'active', label: t('cg.filter.active') },
    { key: 'colonisation', label: t('cg.filter.colonisation') },
    { key: 'completed', label: t('cg.filter.completed') },
  ];
  const updatedDate = updatedAt ? new Date(updatedAt) : null;
  const totalParticipants = goals.reduce((sum, goal) => sum + (typeof goal.contributors === 'number' ? goal.contributors : 0), 0);
  const totalReports = goals.reduce((sum, goal) => sum + (goal.commander_reports?.commander_count ?? 0), 0);

  return (
    <div className={styles.page}>
      <section className={styles.hero}>
        <div className={styles.heroGrid} aria-hidden="true" />
        <div className={styles.heroMain}>
          <div className={styles.kicker}><span /> PILOTS FEDERATION <i>//</i> GALACTIC OPERATIONS</div>
          <h1>{t('cg.title')}</h1>
          <p>{t('cg.subtitle')}</p>
        </div>
        <div className={styles.heroMark} aria-hidden="true">
          <div className={`${styles.orbit} ${styles.orbitOuter}`} /><div className={`${styles.orbit} ${styles.orbitInner}`} />
          <div className={styles.orbitCore}>CG<span>LIVE</span></div>
        </div>
        <div className={styles.heroFooter}>
          <div className={styles.heroStat}><span>{t('cg.goalsVisible')}</span><strong>{goals.length.toLocaleString(locale)}</strong></div>
          <div className={styles.heroDivider} />
          <div className={styles.heroStat}><span>{t('cg.contributors')}</span><strong>{totalParticipants.toLocaleString(locale)}</strong></div>
          <div className={styles.heroDivider} />
          <div className={styles.heroStat}><span>{t('cg.commanderReports')}</span><strong>{totalReports.toLocaleString(locale)}</strong></div>
          {updatedDate && Number.isFinite(updatedDate.getTime()) && (
            <div className={styles.updatedAt}>
              <span className={styles.liveDot} />{t('cg.updated')} <time dateTime={updatedDate.toISOString()}>{updatedDate.toLocaleString(locale)}</time>
            </div>
          )}
        </div>
      </section>

      <section className={styles.controlBar} aria-label={t('cg.filtersAndSearch')}>
        <div className={styles.filters} role="group" aria-label={t('cg.filtersAndSearch')}>
          {filters.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${styles.filterButton}${filter === item.key ? ` ${styles.filterActive}` : ''}`}
              onClick={() => setFilter(item.key)}
              aria-pressed={filter === item.key}
            >
              <span className={styles.filterIndicator} />{item.label}
            </button>
          ))}
        </div>
        <label className={styles.search}>
          <span className={styles.searchIcon} aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t('cg.search')}
            aria-label={t('cg.search')}
          />
          {query && <button type="button" onClick={() => setQuery('')} aria-label={t('cg.clearSearch')}>×</button>}
        </label>
        <div className={styles.resultsCount}>{t('cg.results')}: <strong>{visibleGoals.length}</strong></div>
      </section>

      {loading ? (
        <div className={styles.statePanel} role="status"><span className={styles.loader} />{t('cg.loading')}</div>
      ) : error ? (
        <div className={styles.statePanel} role="alert">
          <div><strong>{t('cg.error')}</strong><p>{t('cg.errorHint')}</p></div>
          <button type="button" className="btn btn-cyan" onClick={() => setReload((value) => value + 1)}>{t('cg.retry')}</button>
        </div>
      ) : visibleGoals.length === 0 ? (
        <div className={styles.statePanel}>
          <div className={styles.emptyGlyph} aria-hidden="true">⌖</div>
          <strong>{query ? t('cg.noSearchResults') : t('cg.empty')}</strong>
          {query && <button type="button" className="btn" onClick={() => setQuery('')}>{t('cg.clearSearch')}</button>}
        </div>
      ) : (
        <div className={styles.goalGrid}>
          {visibleGoals.map((goal) => <GoalCard key={goal.cg_id || goal.id} goal={goal} />)}
        </div>
      )}
    </div>
  );
}
