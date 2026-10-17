'use client';

/**
 * Обзор проекта: показатели, прогресс по системам, что ещё везти, топ
 * пилотов и лента активности. Всё кликабельно ведёт в подробные вкладки.
 */

import { cardStyle, ghostButton, mutedText, sectionTitle } from '@/components/Architect/panelStyles';
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
  unknown: 'нет данных',
  planned: 'по плану, стройка не начата',
  building: 'строится',
  done: 'готова',
};

interface Props {
  detail: ProjectDetailResponse;
  progress: ProgressResponse | null;
  leaders: LeadersResponse | null;
  onOpenTab: (tab: ProjectTab) => void;
  onOpenSystem: (systemId: string) => void;
}

export default function ProjectOverview({ detail, progress, leaders, onOpenTab, onOpenSystem }: Props) {
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
        <Kpi label="Прогресс проекта" value={summary ? formatPercent(summary.progress) : '…'} tone={color}
          hint={summary && summary.totalTons > 0 ? `${compactTons(summary.doneTons)} из ${compactTons(summary.totalTons)} т` : 'по тоннажу площадок и планов'} />
        <Kpi label="Системы" value={summary ? `${summary.systemsDone} / ${summary.systems}` : detail.systems.length}
          hint={summary ? `строятся ${summary.systemsBuilding} · в плане ${summary.systemsPlanned} · без данных ${summary.systemsUnknown}` : undefined} />
        <Kpi label="Площадки" value={summary ? `${summary.sitesComplete} / ${summary.sites}` : '…'}
          hint={summary ? `в работе ${summary.sitesActive}${summary.plannedSites ? ` · в планах ${summary.plannedSites}` : ''}` : undefined} />
        <Kpi label="Осталось привезти" value={summary?.remaining != null ? formatTons(summary.remaining) : '—'}
          hint="по активным площадкам" />
        <Kpi label="Сдано пилотами" value={leaders ? formatTons(leaders.totals.siteTons) : '…'}
          hint={leaders ? `${leaders.totals.pilots} пилотов · ${leaders.totals.siteOps} поставок` : undefined} />
        <Kpi label="На авианосцы" value={leaders ? formatTons(leaders.totals.carrierTons) : '…'}
          hint={`${detail.carriers.length} привязано`} />
      </section>

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) minmax(0, 1fr)', gap: 12 }} className="architect-project-overview">
        <section style={cardStyle} aria-label="Прогресс по системам">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
            <h2 style={sectionTitle}>Прогресс по системам</h2>
            <button type="button" style={ghostButton} onClick={() => onOpenTab('systems')}>Все системы →</button>
          </div>
          {detail.systems.length === 0 ? (
            <EmptyState>В проекте ещё нет систем. Добавьте их на вкладке «Системы».</EmptyState>
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
                    title={view ? STATUS_TEXT[view.status] : STAGE_LABELS[system.stage]}
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
                          ? `${view.sitesComplete}/${view.sites.length} площадок${view.totalTons > 0 ? ` · ${compactTons(view.doneTons)}/${compactTons(view.totalTons)} т` : ''}${view.plan ? ` · план ${view.plan.siteCount}` : ''}`
                          : 'считаем…'}
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
          <section style={cardStyle} aria-label="Лидеры проекта">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
              <h2 style={sectionTitle}>Лидеры</h2>
              <button type="button" style={ghostButton} onClick={() => onOpenTab('leaders')}>Инфографика →</button>
            </div>
            {topPilots.length === 0 ? (
              <EmptyState>Поставок в системы проекта пока нет.</EmptyState>
            ) : (
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {topPilots.map((pilot, index) => (
                  <li key={pilot.key} style={{ display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) 70px', gap: 8, alignItems: 'center' }}>
                    <span style={{ fontFamily: 'ui-monospace, monospace', color: index < 3 ? 'var(--orange)' : 'var(--muted)' }}>#{pilot.rank}</span>
                    <span style={{ minWidth: 0 }}>
                      <span style={{ fontSize: 13, color: pilot.hidden ? 'var(--muted)' : 'var(--text)' }}>
                        {pilot.name}{pilot.isYou ? ' (вы)' : ''}
                      </span>
                      <ProgressBar value={maxPilot > 0 ? (pilot.siteTons / maxPilot) * 100 : 0} tone={toneAt(index)} height={5} />
                    </span>
                    <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right' }}>{compactTons(pilot.siteTons)} т</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section style={cardStyle} aria-label="Что ещё везти">
            <h2 style={{ ...sectionTitle, marginBottom: 10 }}>Что ещё везти</h2>
            {needs.length === 0 ? (
              <EmptyState>{summary ? 'Открытых потребностей нет или данных площадок ещё нет.' : 'Считаем…'}</EmptyState>
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

      <section style={cardStyle} aria-label="Активность">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 10 }}>
          <h2 style={sectionTitle}>Активность</h2>
          <span style={mutedText}>тонн в день по системам проекта</span>
        </div>
        {leaders && leaders.timeline.points.length > 0
          ? <ActivityChart timeline={leaders.timeline} height={120} />
          : <EmptyState>Поставок пока нет.</EmptyState>}
      </section>
      <style>{`
        @media (max-width: 960px) {
          .architect-project-overview { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}
