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
  { id: 'overview', label: 'Обзор' },
  { id: 'systems', label: 'Системы' },
  { id: 'leaders', label: 'Лидеры' },
  { id: 'members', label: 'Участники' },
  { id: 'carriers', label: 'Авианосцы' },
  { id: 'settings', label: 'Настройки' },
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
      setDetailError(result.error || 'Не удалось открыть проект');
      return;
    }
    setDetailError('');
    setDetail(result.data);
  }, [base]);

  const loadProgress = useCallback(async () => {
    const result = await apiJson<ProgressResponse>(`${base}/progress`);
    if (!result.ok || !result.data) {
      setProgressError(result.error || 'Не удалось посчитать прогресс');
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
      setLeadersError(result.error || 'Не удалось собрать лидеров');
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
      setProgressError(result.error || 'Raven Colonial не ответил');
      return;
    }
    setProgress(result.data);
    const data = result.data;
    if (data.throttled) setNotice('Обновление уже шло несколько секунд назад — показаны текущие данные.');
    else {
      const parts = [`Из Raven обновлено систем: ${data.refreshed ?? 0}`];
      if (data.failed?.length) parts.push(`без ответа: ${data.failed.join(', ')}`);
      if (data.pending) parts.push(`ещё ждут обновления: ${data.pending} — нажмите ещё раз через 15 секунд`);
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
              <h1 style={{ margin: 0, fontSize: 20 }}>{status === 401 ? 'Нужен вход' : 'Проект недоступен'}</h1>
              <p style={{ ...mutedText, margin: '8px 0 12px' }}>
                {status === 401
                  ? 'Проекты систем видят только их участники — войдите в аккаунт.'
                  : `${detailError}. Возможно, вас ещё не добавили в проект или он удалён.`}
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                {status === 401 && <Link href="/login" style={primaryButton}>Войти</Link>}
                <Link href="/architect/projects" style={ghostButton}>← Все проекты</Link>
              </div>
            </>
          ) : (
            <p style={mutedText}>Открываем проект…</p>
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
              <Link href="/architect/projects" style={{ color: 'var(--muted)' }}>Проекты систем</Link> / {project.name}
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
                  срок {formatDate(project.targetDate)}{days != null ? (days < 0 ? ` · просрочен на ${-days} дн` : ` · ${days} дн`) : ''}
                </Badge>
              )}
              {project.trackingSince && <Badge>вклад с {formatDate(project.trackingSince)}</Badge>}
              <span style={mutedText}>
                {detail.systems.length} систем · {detail.members.length} участников · {detail.carriers.length} авианосцев
                {contributors != null ? ` · пилотов с вкладом: ${contributors}` : ''}
              </span>
            </div>
          </div>
          <div style={{ flex: '0 1 340px', minWidth: 260 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ ...mutedText, textTransform: 'uppercase', letterSpacing: 0.6, fontSize: 10, fontFamily: 'ui-monospace, monospace' }}>
                Общий прогресс
              </span>
              <span style={{ fontSize: 26, fontFamily: 'ui-monospace, monospace', color: headerColor }}>
                {summary ? formatPercent(summary.progress) : '…'}
              </span>
            </div>
            <ProgressBar value={summary?.progress ?? null} tone={headerColor} height={12} />
            <div style={{ ...mutedText, marginTop: 6, display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
              <span>{summary ? `систем готово ${summary.systemsDone}/${summary.systems} · площадок ${summary.sitesComplete}/${summary.sites}` : 'считаем…'}</span>
              <span title={summary?.updatedAt ?? undefined}>данные {formatAgo(summary?.updatedAt)}</span>
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              {viewer.permissions.refresh && (
                <button type="button" style={primaryButton} disabled={refreshing} onClick={() => void refreshFromRaven()}>
                  {refreshing ? 'Опрашиваем Raven…' : 'Обновить из Raven'}
                </button>
              )}
            </div>
          </div>
        </div>
      </header>

      {notice && <p style={{ ...goodText, margin: '0 0 10px' }}>{notice}</p>}
      {progressError && <p style={{ ...errorText, margin: '0 0 10px' }}>{progressError}</p>}

      <nav aria-label="Разделы проекта" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
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
            {item.label}
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
