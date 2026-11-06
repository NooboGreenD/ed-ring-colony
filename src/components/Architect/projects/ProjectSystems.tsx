'use client';

/**
 * Системы проекта: прогресс каждой системы, площадки, что везти, план и
 * управление (этап, приоритет, ответственный, срок, план, заметки).
 *
 * Права приходят с сервера в `system.editable`: ведущие проекта меняют всё,
 * ответственный пилот — этап и заметки, остальные только смотрят.
 */

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useEffect, useMemo, useState } from 'react';
import {
  cardStyle,
  chipActive,
  chipStyle,
  errorText,
  ghostButton,
  inputStyle,
  mutedText,
  primaryButton,
  rowStyle,
  sectionTitle,
  tableStyle,
  tdStyle,
  thStyle,
} from '@/components/Architect/panelStyles';
import {
  PRIORITY_LABELS,
  STAGE_LABELS,
  SYSTEM_STAGES,
  parseSystemList,
  type ProjectSystemView,
  type SystemStage,
} from '@/lib/architect/projects';
import type { ProjectSite, SystemProgressView } from '@/lib/architect/projectProgress';
import type { PlanView } from '@/lib/architect/store';
import {
  Badge,
  EmptyState,
  ProgressBar,
  StageBadge,
  STAGE_TONES,
  apiJson,
  compactTons,
  daysUntil,
  formatAgo,
  formatDate,
  formatPercent,
  formatTons,
  type ProjectDetailResponse,
} from '@/components/Architect/projects/projectUi';
import type { ProgressResponse } from '@/components/Architect/projects/ProjectView';

interface Props {
  base: string;
  detail: ProjectDetailResponse;
  progress: ProgressResponse | null;
  focusSystemId: string | null;
  onChanged: (what?: { leaders?: boolean }) => Promise<void> | void;
  onNotice: (message: string) => void;
}

type SortMode = 'order' | 'progress' | 'remaining' | 'priority';

const BASIS_TEXT: Record<SystemProgressView['basis'], string> = {
  plan: 'psys.basisPlan',
  sites: 'psys.basisSites',
  none: 'psys.basisNone',
};

export default function ProjectSystems({ base, detail, progress, focusSystemId, onChanged, onNotice }: Props) {
  const { t } = useI18n();
  const perms = detail.viewer.permissions;
  const [stageFilter, setStageFilter] = useState<SystemStage | 'all'>('all');
  const [sort, setSort] = useState<SortMode>('order');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(focusSystemId ? [focusSystemId] : []));
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!focusSystemId) return;
    setExpanded((current) => new Set(current).add(focusSystemId));
    const timer = setTimeout(() => {
      document.getElementById(`project-system-${focusSystemId}`)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    }, 50);
    return () => clearTimeout(timer);
  }, [focusSystemId]);

  const progressById = useMemo(() => new Map((progress?.systems ?? []).map((system) => [system.systemId, system])), [progress]);
  const parsed = useMemo(() => parseSystemList(adding, {
    existing: detail.systems.map((system) => system.name),
    limit: Math.max(0, detail.limits.systems - detail.systems.length),
  }), [adding, detail]);

  const systems = useMemo(() => {
    const list = detail.systems.filter((system) => stageFilter === 'all' || system.stage === stageFilter);
    const progressOf = (system: ProjectSystemView) => progressById.get(system.id)?.progress ?? -1;
    const remainingOf = (system: ProjectSystemView) => progressById.get(system.id)?.remaining ?? -1;
    if (sort === 'progress') return list.slice().sort((a, b) => progressOf(b) - progressOf(a));
    if (sort === 'remaining') return list.slice().sort((a, b) => remainingOf(b) - remainingOf(a));
    if (sort === 'priority') return list.slice().sort((a, b) => a.priority - b.priority || a.sortOrder - b.sortOrder);
    return list;
  }, [detail.systems, stageFilter, sort, progressById]);

  const stageCounts = useMemo(() => {
    const counts = new Map<SystemStage, number>();
    for (const system of detail.systems) counts.set(system.stage, (counts.get(system.stage) ?? 0) + 1);
    return counts;
  }, [detail.systems]);

  const add = async () => {
    if (!parsed.names.length) {
      setError(parsed.duplicates.length ? t('psys.dupExists') : t('psys.enterNames'));
      return;
    }
    setBusy(true);
    setError('');
    const result = await apiJson<{ added: unknown[]; duplicates: string[] }>(`${base}/systems`, { method: 'POST', json: { systems: parsed.names } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    setAdding('');
    onNotice(t('psys.addedCount', { count: result.data?.added.length ?? parsed.names.length }));
    await onChanged({ leaders: true });
  };

  const toggle = (id: string) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {perms.manageSystems && (
        <section style={cardStyle} aria-label={t('psys.addTitle')}>
          <h2 style={sectionTitle}>{t('psys.addTitle')}</h2>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-start', marginTop: 8 }}>
            <textarea
              value={adding}
              onChange={(event) => setAdding(event.target.value)}
              rows={3}
              placeholder={t('psys.addPlaceholder')}
              style={{ ...inputStyle, flex: '1 1 360px', fontFamily: 'ui-monospace, monospace', resize: 'vertical' }}
            />
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <button type="button" style={primaryButton} disabled={busy} onClick={() => void add()}>
                {busy ? t('psys.adding') : `${t('psys.add')}${parsed.names.length ? ` (${parsed.names.length})` : ''}`}
              </button>
              <span style={mutedText}>
                {t('psys.systemsOf', { used: detail.systems.length, limit: detail.limits.systems })}
                {parsed.duplicates.length ? t('psys.alreadyThere', { count: parsed.duplicates.length }) : ''}
              </span>
            </div>
          </div>
          {error && <p style={errorText}>{error}</p>}
        </section>
      )}

      <section style={{ ...cardStyle, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={rowStyle} role="group" aria-label={t('psys.editorStage')}>
          <button type="button" style={stageFilter === 'all' ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => setStageFilter('all')}>
            {t('psys.allChip', { count: detail.systems.length })}
          </button>
          {SYSTEM_STAGES.filter((stage) => stageCounts.get(stage)).map((stage) => (
            <button key={stage} type="button" style={stageFilter === stage ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => setStageFilter(stage)}>
              {t(STAGE_LABELS[stage])} · {stageCounts.get(stage)}
            </button>
          ))}
        </div>
        <label style={{ ...mutedText, display: 'flex', gap: 6, alignItems: 'center' }}>
          {t('psys.order')}
          <select value={sort} onChange={(event) => setSort(event.target.value as SortMode)} style={inputStyle}>
            <option value="order">{t('psys.sortOrder')}</option>
            <option value="priority">{t('psys.sortPriority')}</option>
            <option value="progress">{t('psys.sortProgress')}</option>
            <option value="remaining">{t('psys.sortRemaining')}</option>
          </select>
        </label>
      </section>

      {systems.length === 0 ? (
        <EmptyState>{detail.systems.length ? t('psys.noneAtStage') : t('psys.noSystems')}</EmptyState>
      ) : systems.map((system, index) => (
        <SystemCard
          key={system.id}
          base={base}
          system={system}
          view={progressById.get(system.id) ?? null}
          detail={detail}
          expanded={expanded.has(system.id)}
          onToggle={() => toggle(system.id)}
          onChanged={onChanged}
          onNotice={onNotice}
          neighbours={{
            up: sort === 'order' && stageFilter === 'all' && index > 0 ? systems[index - 1] : null,
            down: sort === 'order' && stageFilter === 'all' && index < systems.length - 1 ? systems[index + 1] : null,
          }}
        />
      ))}
    </div>
  );
}

function SystemCard({ base, system, view, detail, expanded, onToggle, onChanged, onNotice, neighbours }: {
  base: string;
  system: ProjectSystemView;
  view: SystemProgressView | null;
  detail: ProjectDetailResponse;
  expanded: boolean;
  onToggle: () => void;
  onChanged: (what?: { leaders?: boolean }) => Promise<void> | void;
  onNotice: (message: string) => void;
  neighbours: { up: ProjectSystemView | null; down: ProjectSystemView | null };
}) {
  const { t } = useI18n();
  const canEdit = system.editable.length > 0;
  const manager = system.editable.includes('priority');
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const days = daysUntil(system.targetDate);
  const tone = view?.status === 'done' ? 'var(--green)' : STAGE_TONES[system.stage] === 'var(--muted)' ? detail.project.color : STAGE_TONES[system.stage];

  const patch = async (body: Record<string, unknown>, message?: string) => {
    setBusy(true);
    setError('');
    const result = await apiJson(`${base}/systems`, { method: 'PATCH', json: { systemId: system.id, ...body } });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return false;
    }
    if (message) onNotice(message);
    await onChanged();
    return true;
  };

  const remove = async () => {
    if (!window.confirm(t('psys.confirmRemove', { name: system.name }))) return;
    setBusy(true);
    const result = await apiJson(`${base}/systems?systemId=${encodeURIComponent(system.id)}`, { method: 'DELETE' });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onNotice(t('psys.removed', { name: system.name }));
    await onChanged({ leaders: true });
  };

  const swap = async (other: ProjectSystemView) => {
    const mine = system.sortOrder;
    const theirs = other.sortOrder === mine ? mine + (neighbours.up?.id === other.id ? -1 : 1) : other.sortOrder;
    setBusy(true);
    const first = await apiJson(`${base}/systems`, { method: 'PATCH', json: { systemId: system.id, sortOrder: theirs } });
    const second = first.ok ? await apiJson(`${base}/systems`, { method: 'PATCH', json: { systemId: other.id, sortOrder: mine } }) : first;
    setBusy(false);
    if (!second.ok) setError(second.error);
    await onChanged();
  };

  return (
    <section id={`project-system-${system.id}`} style={{ ...cardStyle, borderLeftWidth: 3, borderLeftColor: tone }} aria-label={t('psys.systemAria', { name: system.name })}>
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(220px, 1.3fr) minmax(200px, 2fr) auto', gap: 14, alignItems: 'center' }} className="architect-project-system-head">
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button type="button" onClick={onToggle} aria-expanded={expanded} style={{ background: 'none', border: 'none', color: 'var(--text)', cursor: 'pointer', padding: 0, fontSize: 15, fontWeight: 600, textAlign: 'left' }}>
              {expanded ? '▾' : '▸'} {system.name}
            </button>
            <StageBadge stage={system.stage} />
            {system.priority === 1 && <Badge tone="var(--red)">{t('psys.priorityBadge')}</Badge>}
            {system.priority === 3 && <Badge>{t('psys.lowPriority')}</Badge>}
          </div>
          <div style={{ ...mutedText, marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <span>{t('psys.responsible', { name: system.responsibleName ?? '—' })}</span>
            {system.targetDate && (
              <span style={{ color: days != null && days < 0 && view?.status !== 'done' ? 'var(--red)' : undefined }}>{t('psys.deadline', { date: formatDate(system.targetDate) })}</span>
            )}
            {system.plan
              ? <Link href={`/architect?plan=${system.plan.id}`} style={{ color: 'var(--cyan)' }}>{t('psys.planLink', { title: system.plan.title || t('psys.noTitle') })} ({system.plan.siteCount})</Link>
              : <span>{t('psys.planNone')}</span>}
          </div>
        </div>
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
            <span style={{ color: 'var(--muted)' }}>{view ? t(BASIS_TEXT[view.basis]) : t('psys.calculating')}</span>
            <span style={{ fontFamily: 'ui-monospace, monospace' }}>{view?.progress != null ? formatPercent(view.progress) : '—'}</span>
          </div>
          <ProgressBar value={view?.progress ?? null} tone={tone} height={10} />
          <div style={{ ...mutedText, fontSize: 11, marginTop: 4 }}>
            {view
              ? [
                t('psys.sitesProgress', { done: view.sitesComplete, total: view.sites.length }),
                view.totalTons > 0 ? t('psys.tonsProgress', { done: compactTons(view.doneTons), total: compactTons(view.totalTons) }) : null,
                view.remaining ? t('psys.tonsLeft', { tons: compactTons(view.remaining) }) : null,
                view.plan ? t('psys.planMatched', { count: view.plan.siteCount, matched: view.plan.matched }) : null,
              ].filter(Boolean).join(' · ')
              : ''}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <Link href={`/architect?system=${encodeURIComponent(system.name)}`} style={ghostButton} title={t('psys.openInPlanner')}>{t('psys.planner')}</Link>
          <Link href={`/system/${encodeURIComponent(system.name)}`} style={ghostButton}>{t('psys.system')}</Link>
          {canEdit && <button type="button" style={ghostButton} onClick={() => setEditing((value) => !value)}>{editing ? t('psys.saved') : t('psys.change')}</button>}
        </div>
      </div>

      {error && <p style={errorText}>{error}</p>}

      {editing && canEdit && (
        <SystemEditor
          system={system}
          detail={detail}
          busy={busy}
          manager={manager}
          onPatch={patch}
          onRemove={remove}
          onMoveUp={neighbours.up ? () => void swap(neighbours.up!) : null}
          onMoveDown={neighbours.down ? () => void swap(neighbours.down!) : null}
        />
      )}

      {expanded && <SystemDetails system={system} view={view} />}
    </section>
  );
}

function SystemEditor({ system, detail, busy, manager, onPatch, onRemove, onMoveUp, onMoveDown }: {
  system: ProjectSystemView;
  detail: ProjectDetailResponse;
  busy: boolean;
  manager: boolean;
  onPatch: (body: Record<string, unknown>, message?: string) => Promise<boolean>;
  onRemove: () => void;
  onMoveUp: (() => void) | null;
  onMoveDown: (() => void) | null;
}) {
  const { t } = useI18n();
  const [notes, setNotes] = useState(system.notes);
  const [plans, setPlans] = useState<PlanView[] | null>(null);

  useEffect(() => {
    if (!manager) return;
    let alive = true;
    void apiJson<{ plans: PlanView[] }>(`/api/architect/plans?system=${encodeURIComponent(system.name)}`).then((result) => {
      if (alive) setPlans(Array.isArray(result.data?.plans) ? result.data!.plans : []);
    });
    return () => { alive = false; };
  }, [manager, system.name]);

  return (
    <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px dashed var(--line)', display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
      <label style={mutedText}>
        {t('psys.editorStage')}
        <select value={system.stage} disabled={busy} onChange={(event) => void onPatch({ stage: event.target.value }, t('psys.stageChange', { name: system.name, stage: t(STAGE_LABELS[event.target.value as SystemStage]) }))} style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
          {SYSTEM_STAGES.map((stage) => <option key={stage} value={stage}>{t(STAGE_LABELS[stage])}</option>)}
        </select>
      </label>
      {manager && (
        <>
          <label style={mutedText}>
            {t('psys.editorPriority')}
            <select value={system.priority} disabled={busy} onChange={(event) => void onPatch({ priority: Number(event.target.value) })} style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
              {[1, 2, 3].map((value) => <option key={value} value={value}>{t(PRIORITY_LABELS[value])}</option>)}
            </select>
          </label>
          <label style={mutedText}>
            {t('psys.editorResponsible')}
            <select value={system.responsibleId ?? ''} disabled={busy} onChange={(event) => void onPatch({ responsibleId: event.target.value || null }, t('psys.responsibleAssigned'))} style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
              <option value="">{t('psys.unassigned')}</option>
              {detail.members.map((member) => <option key={member.userId} value={member.userId}>{member.name}</option>)}
            </select>
          </label>
          <label style={mutedText}>
            {t('psys.editorDeadline')}
            <input type="date" value={system.targetDate ?? ''} disabled={busy} onChange={(event) => void onPatch({ targetDate: event.target.value || null })} style={{ ...inputStyle, width: '100%', marginTop: 4 }} />
          </label>
          <label style={mutedText}>
            {t('psys.editorPlan')}
            <select value={system.planId ?? ''} disabled={busy || plans === null} onChange={(event) => void onPatch({ planId: event.target.value || null }, event.target.value ? t('psys.planBound') : t('psys.planUnbound'))} style={{ ...inputStyle, width: '100%', marginTop: 4 }}>
              <option value="">{plans === null ? t('psys.plansLoading') : t('psys.noPlan')}</option>
              {system.plan && !(plans ?? []).some((plan) => plan.id === system.plan!.id) && (
                <option value={system.plan.id}>{system.plan.title || t('psys.currentPlan')} · {system.plan.authorName}</option>
              )}
              {(plans ?? []).map((plan) => (
                <option key={plan.id} value={plan.id}>
                  {t('psys.planOption', { title: plan.title || t('psys.noTitle'), author: plan.authorName || t('psys.authorFallback'), count: plan.siteCount })}{plan.own ? t('psys.planOwn') : ''}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <label style={{ ...mutedText, gridColumn: '1 / -1' }}>
        {t('psys.notes')}
        <textarea value={notes} onChange={(event) => setNotes(event.target.value)} rows={3} maxLength={2000} style={{ ...inputStyle, width: '100%', marginTop: 4, resize: 'vertical' }} />
      </label>
      <div style={{ ...rowStyle, gridColumn: '1 / -1' }}>
        <button type="button" style={primaryButton} disabled={busy || notes === system.notes} onClick={() => void onPatch({ notes }, t('psys.notesSaved'))}>{t('psys.saveNotes')}</button>
        {manager && onMoveUp && <button type="button" style={ghostButton} disabled={busy} onClick={onMoveUp}>{t('psys.moveUp')}</button>}
        {manager && onMoveDown && <button type="button" style={ghostButton} disabled={busy} onClick={onMoveDown}>{t('psys.moveDown')}</button>}
        {manager && (
          <button type="button" style={{ ...ghostButton, borderColor: 'var(--red)', color: 'var(--red)', marginLeft: 'auto' }} disabled={busy} onClick={onRemove}>
            {t('psys.removeFromProject')}
          </button>
        )}
      </div>
    </div>
  );
}

function SystemDetails({ system, view }: { system: ProjectSystemView; view: SystemProgressView | null }) {
  const { t } = useI18n();
  if (!view) return <p style={{ ...mutedText, marginTop: 10 }}>{t('psys.detailsCalculating')}</p>;
  const needs = view.needs.slice(0, 14);
  const maxNeed = needs[0]?.remaining ?? 0;
  const pendingPlan = view.plan?.sites.filter((site) => !site.siteKey && site.status !== 'complete') ?? [];
  return (
    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'minmax(0, 1.7fr) minmax(0, 1fr)', gap: 14 }} className="architect-project-system-body">
      <div style={{ minWidth: 0 }}>
        <h3 style={{ ...sectionTitle, fontSize: 13, marginBottom: 6 }}>{t('psys.sitesTitle')}</h3>
        {view.sites.length === 0 ? (
          <EmptyState>
            {t('psys.noSites')}
          </EmptyState>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>{t('psys.colSite')}</th>
                  <th style={{ ...thStyle, minWidth: 120 }}>{t('psys.colProgress')}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{t('psys.colDelivered')}</th>
                  <th style={{ ...thStyle, textAlign: 'right' }}>{t('psys.colRemaining')}</th>
                  <th style={thStyle}>{t('psys.colData')}</th>
                </tr>
              </thead>
              <tbody>
                {view.sites.map((site) => <SiteRow key={site.key} site={site} />)}
              </tbody>
            </table>
          </div>
        )}
        {pendingPlan.length > 0 && (
          <div style={{ marginTop: 10 }}>
            <h3 style={{ ...sectionTitle, fontSize: 13, marginBottom: 6 }}>{t('psys.pendingPlan')}</h3>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {pendingPlan.map((site) => (
                <Badge key={site.siteId} title={`${site.body} · ~${formatTons(site.tons)}`}>
                  {site.name} · {site.body.replace(system.name, '').trim() || site.body} · {t('psys.tonsProgress', { done: '', total: compactTons(site.tons) })}
                </Badge>
              ))}
            </div>
          </div>
        )}
        {system.notes && (
          <p style={{ ...mutedText, whiteSpace: 'pre-wrap', marginTop: 10, borderLeft: '2px solid var(--line)', paddingLeft: 8 }}>{system.notes}</p>
        )}
      </div>
      <div>
        <h3 style={{ ...sectionTitle, fontSize: 13, marginBottom: 6 }}>{t('psys.whatToHaul')}</h3>
        {needs.length === 0 ? (
          <EmptyState>{view.sitesActive ? t('psys.noBreakdown') : t('psys.noActiveSites')}</EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {needs.map((need) => (
              <div key={need.key} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 70px', gap: 8, alignItems: 'center' }}>
                <span>
                  <span style={{ fontSize: 12 }}>{need.label}</span>
                  <ProgressBar value={maxNeed > 0 ? (need.remaining / maxNeed) * 100 : 0} tone="var(--cyan)" height={4} />
                </span>
                <span style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12, textAlign: 'right' }}>{compactTons(need.remaining)}</span>
              </div>
            ))}
          </div>
        )}
        <p style={{ ...mutedText, fontSize: 11, marginTop: 10 }}>
          {t('psys.ravenAgo', { raven: formatAgo(view.ravenUpdatedAt), journals: formatAgo(view.journalUpdatedAt) })}
          {view.architectName ? t('psys.ravenArchitect', { name: view.architectName }) : ''}
        </p>
      </div>
      <style>{`
        @media (max-width: 960px) {
          .architect-project-system-body, .architect-project-system-head { grid-template-columns: minmax(0, 1fr) !important; }
        }
      `}</style>
    </div>
  );
}

function SiteRow({ site }: { site: ProjectSite }) {
  const { t } = useI18n();
  const sourceLabel = site.source === 'both' ? t('psys.sourceBoth') : site.source === 'journal' ? t('psys.sourceJournal') : t('psys.sourceRaven');
  return (
    <tr>
      <td style={tdStyle}>
        <div>{site.name}</div>
        <div style={{ ...mutedText, fontSize: 11 }}>{[site.buildType, site.body].filter(Boolean).join(' · ') || (site.marketId ? `MarketID ${site.marketId}` : '')}</div>
      </td>
      <td style={tdStyle}>
        <ProgressBar value={site.progress} tone={site.complete ? 'var(--green)' : 'var(--orange)'} height={6} />
        <span style={{ fontSize: 11, color: site.complete ? 'var(--green)' : 'var(--muted)' }}>
          {site.complete ? t('psys.complete') : site.progress != null ? formatPercent(site.progress) : '—'}
        </span>
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>
        {site.provided != null ? compactTons(site.provided) : '—'}{site.required != null ? ` / ${compactTons(site.required)}` : ''}
      </td>
      <td style={{ ...tdStyle, textAlign: 'right', fontFamily: 'ui-monospace, monospace' }}>{site.remaining != null ? compactTons(site.remaining) : '—'}</td>
      <td style={{ ...tdStyle, color: 'var(--muted)', fontSize: 11 }} title={site.updatedAt ?? undefined}>{sourceLabel}<br />{formatAgo(site.updatedAt)}</td>
    </tr>
  );
}
