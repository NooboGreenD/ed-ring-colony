'use client';

/**
 * Список проектов систем и создание нового (`/architect/projects`).
 *
 * Карточка проекта показывает последнюю посчитанную сводку прогресса
 * (`progress_summary`): страница списка не пересчитывает каждую систему
 * каждого проекта — свежие числа считаются при открытии проекта.
 */

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import ArchitectNav from '@/components/Architect/ArchitectNav';
import { useI18n } from '@/lib/i18n/I18nContext';
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
} from '@/components/Architect/panelStyles';
import {
  DEFAULT_PROJECT_COLOR,
  PROJECT_COLORS,
  PROJECT_LIMITS,
  parseSystemList,
  type ProjectSummary,
} from '@/lib/architect/projects';
import {
  Badge,
  ColorDot,
  EmptyState,
  ProgressBar,
  RoleBadge,
  StatusBadge,
  apiJson,
  compactTons,
  daysUntil,
  formatAgo,
  formatDate,
  formatPercent,
} from '@/components/Architect/projects/projectUi';

interface ListResponse {
  projects: ProjectSummary[];
  isAdmin: boolean;
  all: boolean;
  owned: number;
}

const STATUS_ORDER: Record<string, number> = { active: 0, planning: 1, paused: 2, completed: 3, archived: 4 };

export default function ProjectsHub() {
  const { t } = useI18n();
  const router = useRouter();
  const [data, setData] = useState<ListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [unauthorized, setUnauthorized] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [systems, setSystems] = useState('');
  const [color, setColor] = useState<string>(DEFAULT_PROJECT_COLOR);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async (all: boolean) => {
    setLoading(true);
    setError('');
    const result = await apiJson<ListResponse>(`/api/architect/projects${all ? '?all=1' : ''}`);
    setLoading(false);
    if (result.status === 401) {
      setUnauthorized(true);
      setData(null);
      return;
    }
    if (!result.ok || !result.data) {
      setError(result.error || t('ph.loadFailed'));
      return;
    }
    setUnauthorized(false);
    setData({ ...result.data, projects: Array.isArray(result.data.projects) ? result.data.projects : [] });
  }, []);

  useEffect(() => {
    void load(showAll);
  }, [load, showAll]);

  const parsedSystems = useMemo(() => parseSystemList(systems, { limit: PROJECT_LIMITS.systems }), [systems]);

  const projects = useMemo(() => {
    const list = data?.projects ?? [];
    return list
      .filter((project) => showArchived || project.status !== 'archived')
      .sort((left, right) => (
        (STATUS_ORDER[left.status] ?? 9) - (STATUS_ORDER[right.status] ?? 9)
        || String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''))
      ));
  }, [data, showArchived]);
  const archivedCount = (data?.projects ?? []).filter((project) => project.status === 'archived').length;

  const create = async () => {
    if (!name.trim()) {
      setFormError(t('ph.nameRequired'));
      return;
    }
    setBusy(true);
    setFormError('');
    const result = await apiJson<{ id: string }>('/api/architect/projects', {
      method: 'POST',
      json: { name, description, color, systems: parsedSystems.names },
    });
    setBusy(false);
    if (!result.ok || !result.data?.id) {
      setFormError(result.error || t('ph.createFailed'));
      return;
    }
    router.push(`/architect/projects/${result.data.id}`);
  };

  return (
    <main style={{ maxWidth: 1440, margin: '24px auto', padding: '0 16px' }}>
      <ArchitectNav active="projects" />
      <header style={{ ...cardStyle, marginBottom: 12 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'baseline', justifyContent: 'space-between' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: 24, color: 'var(--text)' }}>{t('ph.title')}</h1>
            <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: 13, maxWidth: 900 }}>
              {t('ph.intro')}
            </p>
          </div>
          <div style={rowStyle}>
            {data?.isAdmin && (
              <button type="button" style={showAll ? { ...chipStyle, ...chipActive } : chipStyle} onClick={() => setShowAll((value) => !value)}>
                {showAll ? t('ph.allProjects') : t('ph.myOnly')}
              </button>
            )}
            {!unauthorized && (
              <button type="button" style={primaryButton} onClick={() => setCreating((value) => !value)}>
                {creating ? t('ph.hideForm') : t('ph.newProject')}
              </button>
            )}
          </div>
        </div>
      </header>

      {unauthorized && (
        <section style={{ ...cardStyle, marginBottom: 12 }}>
          <h2 style={sectionTitle}>{t('ph.loginNeeded')}</h2>
          <p style={{ ...mutedText, margin: '8px 0 12px' }}>
            {t('ph.loginText')}
          </p>
          <Link href="/login" style={primaryButton}>{t('ph.login')}</Link>
        </section>
      )}

      {creating && !unauthorized && (
        <section style={{ ...cardStyle, marginBottom: 12 }} aria-label={t('ph.newProjectAria')}>
          <h2 style={sectionTitle}>{t('ph.formTitle')}</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 12, marginTop: 10 }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={mutedText}>
                {t('ph.nameLabel')}
                <input
                  value={name}
                  maxLength={PROJECT_LIMITS.name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder={t('ph.namePlaceholder')}
                  style={{ ...inputStyle, width: '100%', marginTop: 4 }}
                />
              </label>
              <label style={mutedText}>
                {t('ph.descLabel')}
                <textarea
                  value={description}
                  maxLength={PROJECT_LIMITS.description}
                  onChange={(event) => setDescription(event.target.value)}
                  rows={4}
                  placeholder={t('ph.descPlaceholder')}
                  style={{ ...inputStyle, width: '100%', marginTop: 4, resize: 'vertical' }}
                />
              </label>
              <div style={mutedText}>
                {t('ph.colorLabel')}
                <div style={{ ...rowStyle, marginTop: 4 }}>
                  {PROJECT_COLORS.map((tone) => (
                    <button
                      key={tone}
                      type="button"
                      aria-label={t('ph.colorAria', { tone })}
                      aria-pressed={color === tone}
                      onClick={() => setColor(tone)}
                      style={{
                        width: 22, height: 22, borderRadius: 3, background: tone, cursor: 'pointer',
                        borderWidth: 2, borderStyle: 'solid', borderColor: color === tone ? 'var(--text)' : 'transparent',
                      }}
                    />
                  ))}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <label style={mutedText}>
                {t('ph.systemsLabel')}
                <textarea
                  value={systems}
                  onChange={(event) => setSystems(event.target.value)}
                  rows={8}
                  placeholder={'HIP 90297\nCol 285 Sector AB-C d14-2\nSynuefe XR-H d11-102'}
                  style={{ ...inputStyle, width: '100%', marginTop: 4, resize: 'vertical', fontFamily: 'ui-monospace, monospace' }}
                />
              </label>
              <div style={mutedText}>
                {parsedSystems.names.length
                  ? t('ph.systemsParsed', { count: parsedSystems.names.length })
                  : t('ph.systemsLater')}
                {parsedSystems.duplicates.length > 0 && t('ph.systemsDuplicates', { count: parsedSystems.duplicates.length })}
                {parsedSystems.overflow.length > 0 && t('ph.systemsOverflow', { limit: PROJECT_LIMITS.systems, count: parsedSystems.overflow.length })}
              </div>
            </div>
          </div>
          <div style={{ ...rowStyle, marginTop: 12 }}>
            <button type="button" style={primaryButton} disabled={busy} onClick={() => void create()}>
              {busy ? t('ph.creating') : t('ph.create')}
            </button>
            <button type="button" style={ghostButton} onClick={() => setCreating(false)}>{t('project.cancel')}</button>
            {formError && <span style={errorText}>{formError}</span>}
          </div>
        </section>
      )}

      {error && <p style={errorText}>{error}</p>}
      {loading && !data && <p style={mutedText}>{t('ph.loadingProjects')}</p>}

      {data && !unauthorized && (
        <>
          {projects.length === 0 ? (
            <EmptyState>
              {showAll ? t('ph.emptySite') : t('ph.emptyMine')}
            </EmptyState>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(330px, 1fr))', gap: 12 }}>
              {projects.map((project) => <ProjectCard key={project.id} project={project} />)}
            </div>
          )}
          {archivedCount > 0 && (
            <div style={{ marginTop: 10 }}>
              <button type="button" style={ghostButton} onClick={() => setShowArchived((value) => !value)}>
                {showArchived ? t('ph.hideArchive') : t('ph.showArchive', { count: archivedCount })}
              </button>
            </div>
          )}
        </>
      )}
    </main>
  );
}

function ProjectCard({ project }: { project: ProjectSummary }) {
  const { t } = useI18n();
  const summary = project.progress;
  const days = daysUntil(project.targetDate);
  return (
    <Link
      href={`/architect/projects/${project.id}`}
      style={{
        ...cardStyle,
        display: 'flex', flexDirection: 'column', gap: 8, textDecoration: 'none', color: 'var(--text)',
        borderLeftWidth: 3, borderLeftColor: project.color,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <ColorDot color={project.color} />
        <strong style={{ fontSize: 15, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{project.name}</strong>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          <StatusBadge status={project.status} />
          <RoleBadge role={project.role} />
        </span>
      </div>
      {project.description && (
        <p style={{ ...mutedText, margin: 0, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {project.description}
        </p>
      )}
      <div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, marginBottom: 4 }}>
          <span style={{ color: 'var(--muted)' }}>{t('ph.progress')}</span>
          <span style={{ fontFamily: 'ui-monospace, monospace', color: project.color }}>
            {summary?.progress != null ? formatPercent(summary.progress) : '—'}
          </span>
        </div>
        <ProgressBar value={summary?.progress ?? null} tone={project.color} />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 6, fontSize: 11, color: 'var(--muted)' }}>
        <span title={t('ph.systemsTitle')}>
          <b style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>
            {summary ? `${summary.systemsDone}/${project.counts.systems}` : project.counts.systems}
          </b> {t('ph.systemsSuffix')}
        </span>
        <span title={t('ph.sitesTitle')}>
          <b style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>
            {summary ? `${summary.sitesComplete}/${summary.sites}` : '—'}
          </b> {t('ph.sitesSuffix')}
        </span>
        <span title={t('ph.membersTitle')}>
          <b style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>{project.counts.members}</b> {t('ph.pilotsSuffix')}
        </span>
        <span title={t('ph.carriersTitle')}>
          <b style={{ color: 'var(--text)', fontFamily: 'ui-monospace, monospace' }}>{project.counts.carriers}</b> FC
        </span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', fontSize: 11, color: 'var(--muted)' }}>
        {summary && summary.totalTons > 0 && (
          <span style={{ fontFamily: 'ui-monospace, monospace' }}>
            {t('ph.tonsLine', { done: compactTons(summary.doneTons), total: compactTons(summary.totalTons) })}
          </span>
        )}
        {project.targetDate && (
          <Badge tone={days != null && days < 0 ? 'var(--red)' : days != null && days <= 7 ? 'var(--orange)' : 'var(--muted)'}>
            {t('ph.deadline', { date: formatDate(project.targetDate) })}
          </Badge>
        )}
        {project.ownerName && <span>{t('ph.owner', { name: project.ownerName })}</span>}
        <span style={{ marginLeft: 'auto' }} title={project.progressAt ?? undefined}>
          {project.progressAt ? t('ph.summaryAt', { ago: formatAgo(project.progressAt) }) : t('ph.openToCount')}
        </span>
      </div>
    </Link>
  );
}
