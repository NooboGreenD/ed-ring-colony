'use client';

/**
 * Страница проекта систем (`/architect/projects/[id]`).
 *
 * Вкладки: Обзор · Системы · Лидеры · Участники · Авианосцы · Настройки.
 * Данные три: карточка проекта (участники, системы, авианосцы, права),
 * прогресс (кэш Raven + журналы + планы) и лидеры (вклад пилотов). Прогресс
 * и лидеры грузятся параллельно с карточкой, обзор показывает их выжимку.
 */

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ArchitectNav from '@/components/Architect/ArchitectNav';
import { useI18n } from '@/lib/i18n/I18nContext';
import { cardStyle, errorText, ghostButton, goodText, mutedText, primaryButton } from '@/components/Architect/panelStyles';
import type { ProjectProgressView } from '@/lib/architect/projectProgress';
import type { LeaderPeriod, LeaderScope, ProjectLeadersView } from '@/lib/architect/projectLeaders';
import {
  Badge,
  ColorDot,
  ProgressBar,
  RoleBadge,
  StatusBadge,
  apiJson,
  daysUntil,
  formatAgo,
  formatDate,
  formatPercent,
  type ProjectDetailResponse,
} from '@/components/Architect/projects/projectUi';
import ProjectOverview from '@/components/Architect/projects/ProjectOverview';
import ProjectSystems from '@/components/Architect/projects/ProjectSystems';
import ProjectLeaders from '@/components/Architect/projects/ProjectLeaders';
import ProjectMembers from '@/components/Architect/projects/ProjectMembers';
import ProjectCarriers from '@/components/Architect/projects/ProjectCarriers';
import ProjectSettings from '@/components/Architect/projects/ProjectSettings';

export type ProjectTab = 'overview' | 'systems' | 'leaders' | 'members' | 'carriers' | 'settings';

const TABS: Array<{ id: ProjectTab; label: string }> = [
  { id: 'overview', label: 'pv.tabOverview' },
  { id: 'systems', label: 'pv.tabSystems' },
  { id: 'leaders', label: 'pv.tabLeaders' },
  { id: 'members', label: 'pv.tabMembers' },
  { id: 'carriers', label: 'pv.tabCarriers' },
  { id: 'settings', label: 'pv.tabSettings' },
];

export type ProgressResponse = ProjectProgressView & {
  computedAt?: string;
  refreshed?: number;
  failed?: string[];
  pending?: number | null;
  throttled?: boolean;
};

export type LeadersResponse = ProjectLeadersView & { trackingSince?: string | null; generatedAt?: string };

function tabFromHash(): ProjectTab {
  if (typeof window === 'undefined') return 'overview';
  const hash = window.location.hash.replace('#', '');
  return TABS.some((tab) => tab.id === hash) ? hash as ProjectTab : 'overview';
}

export default function ProjectView({ projectId }: { projectId: string }) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<ProjectDetailResponse | null>(null);
  const [detailError, setDetailError] = useState('');
  const [status, setStatus] = useState<number | null>(null);
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [progressError, setProgressError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [leaders, setLeaders] = useState<LeadersResponse | null>(null);
  const [leadersError, setLeadersError] = useState('');
  const [leadersLoading, setLeadersLoading] = useState(false);
  const [period, setPeriod] = useState<LeaderPeriod>('all');
  const [scope, setScope] = useState<LeaderScope>('all');
  const [tab, setTabState] = useState<ProjectTab>('overview');
  const [focusSystem, setFocusSystem] = useState<string | null>(null);
  const [notice, setNotice] = useState('');

  const base = `/api/architect/projects/${encodeURIComponent(projectId)}`;

  useEffect(() => {
    setTabState(tabFromHash());
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  const setTab = useCallback((next: ProjectTab) => {
    setTabState(next);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}#${next}`);
    }
  }, []);

  const loadDetail = useCallback(async () => {
    const result = await apiJson<ProjectDetailResponse>(base);
    setStatus(result.status);
    if (!result.ok || !result.data) {
      setDetailError(result.error || t('pv.openFailed'));
      return;
    }
    setDetailError('');
    setDetail(result.data);
  }, [base]);

  const loadProgress = useCallback(async () => {
    const result = await apiJson<ProgressResponse>(`${base}/progress`);
    if (!result.ok || !result.data) {
      setProgressError(result.error || t('pv.progressFailed'));
      return;
    }
    setProgressError('');
    setProgress(result.data);
  }, [base]);

  const loadLeaders = useCallback(async (nextPeriod: LeaderPeriod, nextScope: LeaderScope) => {
    setLeadersLoading(true);
    const result = await apiJson<LeadersResponse>(`${base}/leaderboard?period=${nextPeriod}&scope=${nextScope}`);
    setLeadersLoading(false);
    if (!result.ok || !result.data) {
      setLeadersError(result.error || t('pv.leadersFailed'));
      return;
    }
    setLeadersError('');
    setLeaders(result.data);
  }, [base]);

  useEffect(() => {
    void loadDetail();
    void loadProgress();
  }, [loadDetail, loadProgress]);

  useEffect(() => {
    void loadLeaders(period, scope);
  }, [loadLeaders, period, scope]);

  const refreshFromRaven = useCallback(async () => {
    setRefreshing(true);
    setNotice('');
    const result = await apiJson<ProgressResponse>(`${base}/progress`, { method: 'POST' });
    setRefreshing(false);
    if (!result.ok || !result.data) {
      setProgressError(result.error || t('pv.ravenNoAnswer'));
      return;
    }
    setProgress(result.data);
    const data = result.data;
    if (data.throttled) setNotice(t('pv.throttled'));
    else {
      const parts = [t('pv.refreshedSystems', { count: data.refreshed ?? 0 })];
      if (data.failed?.length) parts.push(t('pv.noAnswer', { list: data.failed.join(', ') }));
      if (data.pending) parts.push(t('pv.waiting', { count: data.pending }));
      setNotice(parts.join(' · '));
    }
  }, [base]);

  /** После изменений: карточка всегда, прогресс и лидеры — если затронуты системы/авианосцы. */
  const reload = useCallback(async (what: { progress?: boolean; leaders?: boolean } = {}) => {
    await loadDetail();
    if (what.progress) await loadProgress();
    if (what.leaders) await loadLeaders(period, scope);
  }, [loadDetail, loadProgress, loadLeaders, period, scope]);

  const openSystem = useCallback((systemId: string) => {
    setFocusSystem(systemId);
    setTab('systems');
  }, [setTab]);

  const summary = progress?.summary ?? null;
  const days = daysUntil(detail?.project.targetDate);
  const contributors = leaders?.totals.pilots ?? null;
  const headerColor = detail?.project.color ?? 'var(--orange)';
  const tabs = useMemo(() => TABS, []);

  if (!detail) {
    return (
      <main style={{ maxWidth: 1440, margin: '24px auto', padding: '0 16px' }}>
        <ArchitectNav active="projects" />
        <section style={cardStyle}>
          {detailError ? (
            <>
              <h1 style={{ margin: 0, fontSize: 20 }}>{status === 401 ? t('pv.loginNeeded') : t('pv.projectUnavailable')}</h1>
              <p style={{ ...mutedText, margin: '8px 0 12px' }}>
                {status === 401
                  ? t('pv.membersOnly')
                  : t('pv.maybeNotAdded', { error: detailError })}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {status === 401 && <Link href="/login" style={primaryButton}>{t('pv.signIn')}</Link>}
                <Link href="/architect/projects" style={ghostButton}>{t('pv.allProjects')}</Link>
              </div>
            </>
          ) : (
            <p style={mutedText}>{t('pv.opening')}</p>
          )}
        </section>
      </main>
    );
  }

  const { project, viewer } = detail;

  return (
    <main style={{ maxWidth: 1440, margin: '24px auto', padding: '0 16px' }}>
      <ArchitectNav active="projects" />
      <header style={{ ...cardStyle, marginBottom: 12, borderTopWidth: 3, borderTopColor: headerColor }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16, alignItems: 'flex-start', justifyContent: 'space-between' }}>
          <div style={{ minWidth: 0, flex: '1 1 480px' }}>
            <div style={{ ...mutedText, marginBottom: 6 }}>
              <Link href="/architect/projects" style={{ color: 'var(--muted)' }}>{t('pv.systemsProjects')}</Link> / {project.name}
            </div>
            <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text)', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <ColorDot color={project.color} size={14} />
              {project.name}
              <StatusBadge status={project.status} />
              <RoleBadge role={viewer.role} />
            </h1>
            {project.description && (
              <p style={{ margin: '8px 0 0', color: 'var(--muted)', fontSize: 13, whiteSpace: 'pre-wrap', maxWidth: 900 }}>{project.description}</p>
            )}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10, alignItems: 'center' }}>
              {project.targetDate && (
                <Badge tone={days != null && days < 0 ? 'var(--red)' : days != null && days <= 7 ? 'var(--orange)' : 'var(--muted)'}>
                  {t('pv.deadline', { date: formatDate(project.targetDate) })}{days != null ? (days < 0 ? t('pv.overdueBy', { days: -days }) : t('pv.days', { days })) : ''}
                </Badge>
              )}
              {project.trackingSince && <Badge>{t('pv.contributionSince', { date: formatDate(project.trackingSince) })}</Badge>}
              <span style={mutedText}>
                {t('pv.counts', { systems: detail.systems.length, members: detail.members.length, carriers: detail.carriers.length })}
                {contributors != null ? t('pv.contributors', { count: contributors }) : ''}
              </span>
            </div>
          </div>
          <div style={{ flex: '0 1 340px', minWidth: 260 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
                {t('pv.totalProgress')}
              </span>
              <span style={{ fontSize: 26, fontFamily: 'ui-monospace, monospace', color: headerColor }}>
                {summary ? formatPercent(summary.progress) : '…'}
              </span>
            </div>
            <ProgressBar value={summary?.progress ?? null} tone={headerColor} height={12} />
            <div style={{ ...mutedText, marginTop: 6, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>{summary ? t('pv.systemsDone', { done: summary.systemsDone, total: summary.systems, sitesDone: summary.sitesComplete, sites: summary.sites }) : t('pv.calculating')}</span>
              <span title={summary?.updatedAt ?? undefined}>{t('pv.dataAt', { ago: formatAgo(summary?.updatedAt) })}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {viewer.permissions.refresh && (
                <button type="button" style={primaryButton} disabled={refreshing} onClick={() => void refreshFromRaven()}>
                  {refreshing ? t('pv.pollingRaven') : t('pv.refreshRaven')}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {notice && <p style={{ ...goodText, margin: '0 0 10px' }}>{notice}</p>}
      {progressError && <p style={{ ...errorText, margin: '0 0 10px' }}>{progressError}</p>}

      <nav aria-label={t('pv.sectionsAria')} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            onClick={() => setTab(item.id)}
            style={{
              background: tab === item.id ? 'var(--panel)' : 'transparent',
              borderWidth: 1,
              borderStyle: 'solid',
              borderColor: tab === item.id ? headerColor : 'var(--line)',
              color: tab === item.id ? 'var(--text)' : 'var(--muted)',
              padding: '7px 14px',
              borderRadius: 3,
              cursor: 'pointer',
              fontSize: 13,
              fontFamily: 'ui-monospace, monospace',
            }}
          >
            {t(item.label)}
            {item.id === 'systems' && ` · ${detail.systems.length}`}
            {item.id === 'members' && ` · ${detail.members.length}`}
            {item.id === 'carriers' && ` · ${detail.carriers.length}`}
          </button>
        ))}
      </nav>

      {tab === 'overview' && (
        <ProjectOverview
          detail={detail}
          progress={progress}
          leaders={leaders}
          onOpenTab={setTab}
          onOpenSystem={openSystem}
        />
      )}
      {tab === 'systems' && (
        <ProjectSystems
          base={base}
          detail={detail}
          progress={progress}
          focusSystemId={focusSystem}
          onChanged={(what) => reload({ progress: true, leaders: what?.leaders })}
          onNotice={setNotice}
        />
      )}
      {tab === 'leaders' && (
        <ProjectLeaders
          leaders={leaders}
          loading={leadersLoading}
          error={leadersError}
          period={period}
          scope={scope}
          color={project.color}
          onPeriod={setPeriod}
          onScope={setScope}
        />
      )}
      {tab === 'members' && (
        <ProjectMembers
          base={base}
          detail={detail}
          leaders={leaders}
          onChanged={(what) => reload({ leaders: what?.leaders })}
          onNotice={setNotice}
          onLeft={() => { window.location.href = '/architect/projects'; }}
        />
      )}
      {tab === 'carriers' && (
        <ProjectCarriers
          base={base}
          detail={detail}
          leaders={leaders}
          onChanged={() => reload({ leaders: true })}
          onNotice={setNotice}
        />
      )}
      {tab === 'settings' && (
        <ProjectSettings
          base={base}
          detail={detail}
          onChanged={(what) => reload({ leaders: what?.leaders })}
          onNotice={setNotice}
          onGone={() => { window.location.href = '/architect/projects'; }}
        />
      )}
    </main>
  );
}
