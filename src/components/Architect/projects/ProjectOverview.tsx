'use client';

/**
 * Обзор проекта: показатели, прогресс по системам, что ещё везти, топ
 * пилотов и лента активности. Всё кликабельно ведёт в подробные вкладки.
 */

import { cardStyle, ghostButton, mutedText, sectionTitle } from '@/components/Architect/panelStyles';
import { useI18n } from '@/lib/i18n/I18nContext';
import { STAGE_LABELS } from '@/lib/architect/projects';
import type { SystemProgressView } from '@/lib/architect/projectProgress';
import {
  EmptyState,
  Kpi,
  ProgressBar,
  StageBadge,
  STAGE_TONES,
  compactTons,
  formatPercent,
  formatTons,
  toneAt,
  type ProjectDetailResponse,
} from '@/components/Architect/projects/projectUi';
import { ActivityChart } from '@/components/Architect/projects/ProjectLeaders';
import type { LeadersResponse, ProgressResponse, ProjectTab } from '@/components/Architect/projects/ProjectView';

const STATUS_TEXT: Record<SystemProgressView['status'], string> = {
  unknown: 'pov.statusUnknown',
  planned: 'pov.statusPlanned',
  building: 'pov.statusBuilding',
  done: 'pov.statusDone',
};

interface Props {
  detail: ProjectDetailResponse;
  progress: ProgressResponse | null;
  leaders: LeadersResponse | null;
  onOpenTab: (tab: ProjectTab) => void;
  onOpenSystem: (systemId: string) => void;
}

export default function ProjectOverview({ detail, progress, leaders, onOpenTab, onOpenSystem }: Props) {
  const { t } = useI18n();
  const summary = progress?.summary ?? null;
  const systemsById = new Map((progress?.systems ?? []).map((system) => [system.systemId, system]));
  const color = detail.project.color;
  const topPilots = (leaders?.pilots ?? []).filter((pilot) => pilot.siteTons > 0).slice(0, 6);
  const maxPilot = topPilots[0]?.siteTons ?? 0;
  const needs = (summary?.needs ?? []).slice(0, 10);
  const maxNeed = needs[0]?.remaining ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 8 }}>
        <Kpi label={t('pov.kpiProgress')} value={summary ? formatPercent(summary.progress) : '…'} tone={color}
          hint={summary && summary.totalTons > 0 ? t('pov.tonsOf', { done: compactTons(summary.doneTons), total: compactTons(summary.totalTons) }) : t('pov.kpiProgressHint')} />
        <Kpi label={t('pov.kpiSystems')} value={summary ? `${summary.systemsDone} / ${summary.systems}` : detail.systems.length}
          hint={summary ? t('pov.sysHint', { building: summary.systemsBuilding, planned: summary.systemsPlanned, unknown: summary.systemsUnknown }) : undefined} />
        <Kpi label={t('pov.kpiSites')} value={summary ? `${summary.sitesComplete} / ${summary.sites}` : '…'}
          hint={summary ? `${t('pov.sitesHint', { active: summary.sitesActive })}${summary.plannedSites ? t('pov.sitesPlanTail', { planned: summary.plannedSites }) : ''}` : undefined} />
        <Kpi label={t('pov.kpiRemaining')} value={summary?.remaining != null ? formatTons(summary.remaining) : '—'}
          hint={t('pov.remainingHint')} />
        <Kpi label={t('pov.kpiPilots')} value={leaders ? formatTons(leaders.totals.siteTons) : '…'}
          hint={leaders ? t('pov.pilotsHint', { pilots: leaders.totals.pilots, ops: leaders.totals.siteOps }) : undefined} />
        <Kpi label={t('pov.kpiCarriers')} value={leaders ? formatTons(leaders.totals.carrierTons) : '…'}
          hint={t('pov.carriersHint', { count: detail.carriers.length })} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 12 }} className="architect-project-overview">
        <section style={cardStyle} aria-label={t('pov.ariaSystems')}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <h2 style={sectionTitle}>{t('pov.systemsTitle')}</h2>
            <button type="button" style={ghostButton} onClick={() => onOpenTab('systems')}>{t('pov.allSystems')}</button>
          </div>
          {detail.systems.length === 0 ? (
            <EmptyState>{t('pov.noSystems')}</EmptyState>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {detail.systems.map((system) => {
                const view = systemsById.get(system.id);
                const tone = view?.status === 'done' ? 'var(--green)' : STAGE_TONES[system.stage] === 'var(--muted)' ? color : STAGE_TONES[system.stage];
                return (
                  <button
                    key={system.id}
                    type="button"
                    onClick={() => onOpenSystem(system.id)}
                    style={{
                      display: 'grid', gridTemplateColumns: 'minmax(140px, 1.2fr) minmax(120px, 2fr) 70px', gap: 10, alignItems: 'center',
                      background: 'transparent', border: 'none', padding: '4px 0', cursor: 'pointer', textAlign: 'left', color: 'var(--text)',
                    }}
                    title={view ? t(STATUS_TEXT[view.status]) : t(STAGE_LABELS[system.stage])}
                  >
                    <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                      <span style={{ fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{system.name}</span>
                      <span style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                        <StageBadge stage={system.stage} />
                        {system.responsibleName && <span style={{ ...mutedText, fontSize: 11 }}>{system.responsibleName}</span>}
                      </span>
                    </span>
                    <span>
                      <ProgressBar value={view?.progress ?? null} tone={tone} />
                      <span style={{ ...mutedText, fontSize: 11 }}>
                        {view
                          ? `${t('pov.sitesLine', { done: view.sitesComplete, total: view.sites.length })}${view.totalTons > 0 ? t('pov.tonsTail', { done: compactTons(view.doneTons), total: compactTons(view.totalTons) }) : ''}${view.plan ? t('pov.planTail', { count: view.plan.siteCount }) : ''}`
                          : t('pov.calculating')}
                      </span>
                    </span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 13, textAlign: 'right', color: view?.progress != null ? 'var(--text)' : 'var(--muted)' }}>
                      {view?.progress != null ? formatPercent(view.progress, 0) : '—'}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <section style={cardStyle} aria-label={t('pov.ariaLeaders')}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <h2 style={sectionTitle}>{t('pov.leadersTitle')}</h2>
              <button type="button" style={ghostButton} onClick={() => onOpenTab('leaders')}>{t('pov.infographics')}</button>
            </div>
            {topPilots.length === 0 ? (
              <EmptyState>{t('pov.noDeliveries')}</EmptyState>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {topPilots.map((pilot, index) => (
                  <li key={pilot.key} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 70px', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: index < 3 ? 'var(--orange)' : 'var(--muted)' }}>#{pilot.rank}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, color: pilot.hidden ? 'var(--muted)' : 'var(--text)' }}>
                        {pilot.name}{pilot.isYou ? t('pov.you') : ''}
                      </span>
                      <ProgressBar value={maxPilot > 0 ? (pilot.siteTons / maxPilot) * 100 : 0} tone={toneAt(index)} height={5} />
                    </span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right' }}>{t('pov.tons', { value: compactTons(pilot.siteTons) })}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section style={cardStyle} aria-label={t('pov.ariaNeeds')}>
            <h2 style={{ ...sectionTitle, marginBottom: 10 }}>{t('pov.whatNext')}</h2>
            {needs.length === 0 ? (
              <EmptyState>{summary ? t('pov.noNeeds') : t('pov.counting')}</EmptyState>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {needs.map((need) => (
                  <div key={need.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 80px', gap: 8, alignItems: 'center' }}>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 12 }}>{need.label}</span>
                      <ProgressBar value={maxNeed > 0 ? (need.remaining / maxNeed) * 100 : 0} tone="var(--cyan)" height={5} />
                    </span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right' }}>{formatTons(need.remaining)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      </div>

      <section style={cardStyle} aria-label={t('pov.ariaActivity')}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h2 style={sectionTitle}>{t('pov.activityTitle')}</h2>
          <span style={mutedText}>{t('pov.activityHint')}</span>
        </div>
        {leaders && leaders.timeline.points.length > 0
          ? <ActivityChart timeline={leaders.timeline} height={120} />
          : <EmptyState>{t('pov.noActivity')}</EmptyState>}
      </section>
      <style>{`
        @media (max-width: 960px) {
          .architect-project-overview { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
