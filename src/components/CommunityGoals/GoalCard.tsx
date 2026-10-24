'use client';

import { useI18n } from '@/lib/i18n/I18nContext';
import styles from './GoalCard.module.css';

export interface CommunityGoal {
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

function finiteNonNegative(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function formatNumber(value: number | null, locale: string): string {
  return value === null ? '—' : new Intl.NumberFormat(locale, { notation: value > 999_999 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

function formatDate(value: string | null, locale: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' }) : null;
}

function ProgressRing({ current, max, label }: { current: number | null; max: number | null; label: string }) {
  const size = 112;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const ratio = current !== null && max !== null && max > 0 ? Math.max(0, Math.min(1, current / max)) : 0;
  const percent = Math.round(ratio * 100);

  return (
    <div className={styles.ringWrap}>
      <svg className={styles.ring} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${label}: ${percent}%`}>
        <circle className={styles.ringTrack} cx={size / 2} cy={size / 2} r={radius} />
        <circle
          className={styles.ringValue}
          cx={size / 2}
          cy={size / 2}
          r={radius}
          strokeDasharray={`${circumference * ratio} ${circumference}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <div className={styles.ringCenter}>
        <strong>{current === null ? '—' : `${current}`}</strong>
        <span>{max === null ? label : `/ ${max} ${label}`}</span>
      </div>
      <span className={styles.ringCaption}>{label}</span>
    </div>
  );
}

export default function GoalCard({ goal }: { goal: CommunityGoal }) {
  const { t, locale } = useI18n();
  const current = finiteNonNegative(goal.tier_current);
  const max = finiteNonNegative(goal.tier_max);
  const participants = finiteNonNegative(goal.contributors);
  const total = finiteNonNegative(goal.contributions_total);
  const reports = goal.commander_reports;
  const reportedCommanders = finiteNonNegative(reports?.commander_count);
  const trackedContribution = finiteNonNegative(reports?.player_contribution_total);
  const journalTotal = finiteNonNegative(reports?.journal_current_total);
  const reportCoverage = participants && reportedCommanders !== null
    ? Math.min(100, (reportedCommanders / participants) * 100)
    : null;
  const expiry = formatDate(goal.expiry_date, locale);
  const sourceUpdated = formatDate(goal.source_updated_at, locale);
  const compareBase = Math.max(total ?? 0, journalTotal ?? 0, 1);
  const journalWidth = journalTotal === null ? 0 : Math.min(100, (journalTotal / compareBase) * 100);
  const inaraWidth = total === null ? 0 : Math.min(100, (total / compareBase) * 100);
  const progressPercent = current !== null && max !== null && max > 0 ? Math.round(Math.min(100, current / max * 100)) : null;

  return (
    <article className={`${styles.card} ${goal.is_complete ? styles.completed : ''}`}>
      <div className={styles.topLine} aria-hidden="true"><span /></div>
      <div className={styles.content}>
        <header className={styles.header}>
          <div className={styles.headingBlock}>
            <div className={styles.eyebrow}>
              <span className={`${styles.statusDot} ${goal.is_complete ? styles.statusDone : ''}`} />
              <span>{goal.is_complete ? t('cg.filter.completed') : t('cg.filter.active')}</span>
              {goal.is_colonisation_related && <span className={styles.colonyTag}>{t('cg.filter.colonisation')}</span>}
              {goal.cg_id > 0 && <span className={styles.goalId}>CG // {goal.cg_id}</span>}
            </div>
            <h2 className={styles.title}>{goal.title}</h2>
            {(goal.system_name || goal.station_name) && (
              <div className={styles.location}>
                <span className={styles.locationGlyph} aria-hidden="true">⌖</span>
                <span>{goal.system_name || '—'}{goal.station_name ? ` · ${goal.station_name}` : ''}</span>
              </div>
            )}
          </div>
          <div className={styles.headerMeta}>
            {expiry && <div className={styles.expiry}><span>{t('cg.expires')}</span><strong>{expiry}</strong></div>}
            {goal.inara_url && <a className={styles.sourceLink} href={goal.inara_url} target="_blank" rel="noreferrer">INARA <span aria-hidden="true">↗</span></a>}
          </div>
        </header>

        {goal.objective && <p className={styles.objective}>{goal.objective}</p>}

        <div className={styles.dashboard}>
          <section className={styles.progressPanel} aria-label={t('cg.progress')}>
            <div className={styles.sectionHeading}><span className={styles.signal} />{t('cg.progress')}<span className={styles.sectionRule} /></div>
            <div className={styles.progressBody}>
              <ProgressRing current={current} max={max} label={t('cg.progress')} />
              <div className={styles.progressDetails}>
                <div className={styles.progressLabelRow}>
                  <span>{t('cg.tierProgress')}</span>
                  <strong>{progressPercent === null ? '—' : `${progressPercent}%`}</strong>
                </div>
                <div
                  className={styles.progressTrack}
                  role="progressbar"
                  aria-label={t('cg.tierProgress')}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={progressPercent ?? 0}
                >
                  <span style={{ width: `${progressPercent ?? 0}%` }} />
                </div>
                <div className={styles.progressMeta}>
                  <span>{t('cg.currentTier')}</span>
                  <span>{current === null ? '—' : `${t('cg.progress')} ${current}`}{max === null ? '' : ` / ${max}`}</span>
                </div>
                {goal.reward && <div className={styles.reward}><span aria-hidden="true">✦</span><div><small>{t('cg.reward')}</small><strong>{goal.reward}</strong></div></div>}
              </div>
            </div>
          </section>

          <section className={styles.metricsPanel} aria-label={t('cg.goalTelemetry')}>
            <div className={styles.sectionHeading}><span className={styles.signal} />{t('cg.goalTelemetry')}<span className={styles.sectionRule} /></div>
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricIcon} aria-hidden="true">◈</span>
                <span className={styles.metricLabel}>{t('cg.contributions')}</span>
                <strong>{formatNumber(total, locale)}</strong>
                <small>{t('cg.goal')}</small>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricIcon} aria-hidden="true">◎</span>
                <span className={styles.metricLabel}>{t('cg.contributors')}</span>
                <strong>{formatNumber(participants, locale)}</strong>
                <small>{t('cg.globalSource')}</small>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricIcon} aria-hidden="true">⌁</span>
                <span className={styles.metricLabel}>{t('cg.commanderReports')}</span>
                <strong>{formatNumber(reportedCommanders, locale)}</strong>
                <small>{t('cg.trackedCommanders')}</small>
              </div>
            </div>
            {reportCoverage !== null && (
              <div className={styles.coverage}>
                <div className={styles.coverageLabel}><span>{t('cg.reportCoverage')}</span><strong>{Math.round(reportCoverage)}%</strong></div>
                <div className={styles.coverageTrack} role="img" aria-label={`${t('cg.reportCoverage')}: ${Math.round(reportCoverage)}%`}>
                  <span style={{ width: `${reportCoverage}%` }} />
                </div>
                <small>{formatNumber(reportedCommanders, locale)} / {formatNumber(participants, locale)} · {t('cg.trackedCommanders')}</small>
              </div>
            )}
          </section>
        </div>

        {(journalTotal !== null || trackedContribution !== null) && (
          <section className={styles.reportPanel}>
            <div className={styles.reportHeader}>
              <div><span className={styles.sectionHeading}><span className={styles.signal} />{t('cg.journalCompare')}</span><small>{t('cg.reportedContribution')}</small></div>
              {reports?.reported_at && <time dateTime={reports.reported_at}>{new Date(reports.reported_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })}</time>}
            </div>
            {journalTotal !== null && total !== null && (
              <div className={styles.compareChart}>
                <div className={styles.compareRow}>
                  <span>{t('cg.journal')}</span>
                  <div className={styles.compareTrack}><span className={styles.journalBar} style={{ width: `${journalWidth}%` }} /></div>
                  <strong>{formatNumber(journalTotal, locale)}</strong>
                </div>
                <div className={styles.compareRow}>
                  <span>Inara</span>
                  <div className={styles.compareTrack}><span className={styles.inaraBar} style={{ width: `${inaraWidth}%` }} /></div>
                  <strong>{formatNumber(total, locale)}</strong>
                </div>
              </div>
            )}
            {trackedContribution !== null && (
              <div className={styles.trackedContribution}>
                <span>{t('cg.trackedContributionTotal')}</span>
                <strong>{formatNumber(trackedContribution, locale)}</strong>
              </div>
            )}
          </section>
        )}

        {(goal.description || sourceUpdated) && (
          <footer className={styles.footer}>
            {goal.description && (
              <details className={styles.details}>
                <summary>{t('cg.details')} <span aria-hidden="true">⌄</span></summary>
                <p>{goal.description}</p>
              </details>
            )}
            {sourceUpdated && <span className={styles.updated}>{t('cg.updated')}: {sourceUpdated}</span>}
          </footer>
        )}
      </div>
    </article>
  );
}
