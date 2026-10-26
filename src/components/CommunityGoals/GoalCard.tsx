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
  contributions_target: number | string | null;
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
  progress_source: 'inara' | 'capi' | 'frontier' | 'journal' | 'manual' | null;
  progress_updated_at: string | null;
  contribution_history: {
    snapshot_hour: string;
    observed_at: string;
    source: 'inara' | 'capi' | 'frontier';
    contributions_total: number | string;
  }[];
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

function progressSourceLabel(source: CommunityGoal['progress_source']): string {
  switch (source) {
    case 'capi': return 'Frontier CAPI';
    case 'frontier': return 'Frontier';
    case 'inara': return 'INARA';
    case 'journal': return 'Journal';
    case 'manual': return 'Manual';
    default: return '—';
  }
}

function ContributionHistory({
  history,
  goalId,
  title,
  locale,
}: {
  history: CommunityGoal['contribution_history'];
  goalId: number;
  title: string;
  locale: string;
}) {
  const { t } = useI18n();
  const points = history.flatMap((point) => {
    const value = finiteNonNegative(point.contributions_total);
    const time = Date.parse(point.observed_at || point.snapshot_hour);
    return value === null || !Number.isFinite(time) ? [] : [{ time, value }];
  }).sort((a, b) => a.time - b.time);
  const formatPointDate = (time: number, withTime = false) => new Date(time).toLocaleString(locale,
    withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { day: 'numeric', month: 'short' },
  );

  return (
    <section className={styles.historyPanel} aria-label={`${t('cg.historyTitle')}: ${title}`}>
      <div className={styles.historyHeader}>
        <div className={styles.sectionHeading}><span className={styles.signal} />{t('cg.historyTitle')}<span className={styles.sectionRule} /></div>
        {points.length > 0 && <strong>{formatNumber(points[points.length - 1].value, locale)}</strong>}
      </div>
      {points.length < 2 ? (
        <p className={styles.historyEmpty}>
          {points.length === 1
            ? `${t('cg.historyOnePoint')} ${formatPointDate(points[0].time, true)}`
            : t('cg.historyNoData')}
        </p>
      ) : (() => {
        const width = 760;
        const height = 220;
        const left = 78;
        const right = 16;
        const top = 16;
        const bottom = 38;
        const plotWidth = width - left - right;
        const plotHeight = height - top - bottom;
        const firstTime = points[0].time;
        const lastTime = points[points.length - 1].time;
        const timeSpan = Math.max(1, lastTime - firstTime);
        const maxValue = Math.max(1, ...points.map((point) => point.value));
        const coords = points.map((point) => ({
          ...point,
          x: left + ((point.time - firstTime) / timeSpan) * plotWidth,
          y: top + (1 - point.value / maxValue) * plotHeight,
        }));
        const linePath = coords.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`).join(' ');
        const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(2)} ${(top + plotHeight).toFixed(2)} L ${coords[0].x.toFixed(2)} ${(top + plotHeight).toFixed(2)} Z`;
        const labelIndexes = new Set([0, Math.floor((coords.length - 1) / 2), coords.length - 1]);
        const labelPoints = coords.filter((_, index) => labelIndexes.has(index));
        const gradientId = `cg-history-gradient-${goalId}`;

        return (
          <>
            <svg className={styles.historySvg} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${t('cg.historyTitle')}: ${title}`}>
              <defs>
                <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0%" stopColor="var(--cg-accent)" stopOpacity=".28" />
                  <stop offset="100%" stopColor="var(--cg-accent)" stopOpacity="0" />
                </linearGradient>
              </defs>
              {[0, 0.5, 1].map((fraction) => {
                const y = top + plotHeight * (1 - fraction);
                return (
                  <g key={fraction}>
                    <line className={styles.historyGridline} x1={left} x2={width - right} y1={y} y2={y} />
                    <text className={styles.historyAxisLabel} x={left - 9} y={y + 4} textAnchor="end">
                      {formatNumber(maxValue * fraction, locale)}
                    </text>
                  </g>
                );
              })}
              <path d={areaPath} fill={`url(#${gradientId})`} />
              <path className={styles.historyLine} d={linePath} />
              {labelPoints.map((point) => (
                <circle key={`${point.time}-${point.value}`} className={styles.historyPoint} cx={point.x} cy={point.y} r="3.5">
                  <title>{`${formatPointDate(point.time, true)} · ${formatNumber(point.value, locale)}`}</title>
                </circle>
              ))}
              <text className={styles.historyAxisLabel} x={left} y={height - 8} textAnchor="start">{formatPointDate(firstTime)}</text>
              <text className={styles.historyAxisLabel} x={width - right} y={height - 8} textAnchor="end">{formatPointDate(lastTime)}</text>
            </svg>
            <div className={styles.historyFootnote}>{t('cg.historySince')} {formatPointDate(firstTime, true)}</div>
          </>
        );
      })()}
    </section>
  );
}

export default function GoalCard({ goal }: { goal: CommunityGoal }) {
  const { t, locale } = useI18n();
  const current = finiteNonNegative(goal.tier_current);
  const max = finiteNonNegative(goal.tier_max);
  const participants = finiteNonNegative(goal.contributors);
  const total = finiteNonNegative(goal.contributions_total);
  const target = finiteNonNegative(goal.contributions_target);
  const reports = goal.commander_reports;
  const reportedCommanders = finiteNonNegative(reports?.commander_count);
  const trackedContribution = finiteNonNegative(reports?.player_contribution_total);
  const journalTotal = finiteNonNegative(reports?.journal_current_total);
  const maximumTier = max !== null && Math.floor(max) > 0 ? Math.floor(max) : null;
  const reachedTier = current === null
    ? null
    : Math.min(Math.max(0, Math.floor(current)), maximumTier ?? Math.floor(current));
  const nextTier = maximumTier !== null && reachedTier !== null && reachedTier < maximumTier
    ? reachedTier + 1
    : null;
  const tierSegmentCount = maximumTier === null ? 0 : Math.min(maximumTier, 12);
  const tierSegments = Array.from({ length: tierSegmentCount }, (_, index) => {
    const startTier = Math.floor(index * maximumTier! / tierSegmentCount) + 1;
    const endTier = Math.floor((index + 1) * maximumTier! / tierSegmentCount);
    const reached = reachedTier !== null && endTier <= reachedTier;
    const next = !reached && nextTier !== null && nextTier >= startTier && nextTier <= endTier;
    return { tier: endTier, reached, next };
  });
  const expiry = formatDate(goal.expiry_date, locale);
  const progressUpdated = goal.progress_updated_at
    ? new Date(goal.progress_updated_at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
    : null;
  const compareBase = Math.max(total ?? 0, journalTotal ?? 0, 1);
  const journalWidth = journalTotal === null ? 0 : Math.min(100, (journalTotal / compareBase) * 100);
  const sourceWidth = total === null ? 0 : Math.min(100, (total / compareBase) * 100);
  const objectiveText = goal.objective?.trim() || null;
  const descriptionText = goal.description?.trim() || null;
  // Keep the narrative description on the left and the actionable objective
  // on the right. If both upstream fields contain the same text, show it once.
  const distinctDescription = descriptionText && descriptionText !== objectiveText
    ? descriptionText
    : null;

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

        {distinctDescription || objectiveText || goal.reward ? (
          <section className={styles.goalInfo} aria-label={t('cg.goalInformation')}>
            {distinctDescription && (
              <div className={`${styles.infoBlock} ${styles.descriptionBlock}`}>
                <div className={styles.infoTitle}><span className={styles.infoIcon} aria-hidden="true">▤</span>{t('cg.details')}</div>
                <p>{distinctDescription}</p>
              </div>
            )}
            {objectiveText && (
              <div className={`${styles.infoBlock} ${styles.taskBlock}`}>
                <div className={styles.infoTitle}><span className={styles.infoIcon} aria-hidden="true">◈</span>{t('cg.objective')}</div>
                <p>{objectiveText}</p>
              </div>
            )}
            {goal.reward && (
              <div className={`${styles.infoBlock} ${styles.rewardBlock}`}>
                <div className={styles.infoTitle}><span className={styles.rewardIcon} aria-hidden="true">✦</span>{t('cg.reward')}</div>
                <p>{goal.reward}</p>
              </div>
            )}
          </section>
        ) : null}

        <div className={styles.dashboard}>
          <section className={styles.progressPanel} aria-label={t('cg.progress')}>
            <div className={styles.sectionHeading}><span className={styles.signal} />{t('cg.progress')}<span className={styles.sectionRule} /></div>
            <div className={styles.tierProgress}>
              <div className={styles.tierProgressLabels}>
                <strong className={styles.tierValue}>{reachedTier ?? '—'}<span> / {maximumTier ?? '—'}</span></strong>
                {nextTier !== null
                  ? <span className={styles.nextTier}>{t('cg.nextTier')} <strong>{nextTier}</strong></span>
                  : reachedTier !== null && maximumTier !== null
                    ? <span className={styles.nextTier}>{t('cg.tiersComplete')}</span>
                    : null}
              </div>
              {tierSegments.length > 0 && (
                <div
                  className={styles.tierTrack}
                  role="img"
                  aria-label={`${t('cg.progress')}: ${reachedTier ?? '—'} / ${maximumTier}; ${nextTier !== null ? `${t('cg.nextTier')} ${nextTier}` : reachedTier !== null ? t('cg.tiersComplete') : ''}`}
                >
                  {tierSegments.map((segment, index) => (
                    <span
                      key={`${segment.tier}-${index}`}
                      className={`${styles.tierSegment} ${segment.reached ? styles.tierSegmentReached : ''} ${segment.next ? styles.tierSegmentNext : ''}`}
                    />
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className={styles.metricsPanel} aria-label={t('cg.goalTelemetry')}>
            <div className={styles.metrics}>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>{t('cg.contributions')}</span>
                <strong>{formatNumber(total, locale)}{target !== null ? ` / ${formatNumber(target, locale)}` : ''}</strong>
              </div>
              <div className={styles.metric}>
                <span className={styles.metricLabel}>{t('cg.contributors')}</span>
                <strong>{formatNumber(participants, locale)}</strong>
              </div>
            </div>
          </section>
        </div>

        <details className={styles.extraData}>
          <summary>
            <span>{t('cg.moreData')}</span>
            {reportedCommanders !== null && <small>{formatNumber(reportedCommanders, locale)} · {t('cg.commanderReports')}</small>}
          </summary>
          <ContributionHistory
            history={goal.contribution_history || []}
            goalId={goal.cg_id}
            title={goal.title}
            locale={locale}
          />

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
                    <span>{progressSourceLabel(goal.progress_source)}</span>
                    <div className={styles.compareTrack}><span className={styles.sourceBar} style={{ width: `${sourceWidth}%` }} /></div>
                    <strong>{formatNumber(total, locale)}{target !== null ? ` / ${formatNumber(target, locale)}` : ''}</strong>
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
        </details>

        {progressUpdated && (
          <footer className={styles.footer}>
            <span className={styles.updated}>{t('cg.progressSource')}: {progressSourceLabel(goal.progress_source)} · {progressUpdated}</span>
          </footer>
        )}
      </div>
    </article>
  );
}
