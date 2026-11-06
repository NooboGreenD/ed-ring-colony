'use client';

/**
 * Панель планировщика «Проекты систем»: в каких моих проектах есть эта
 * система, добавить её в проект, где я ведущий, и привязать к системе
 * проекта сохранённый план.
 *
 * Гостю панель лишь подсказывает войти: проекты закрытые.
 */

import Link from 'next/link';
import { useI18n } from '@/lib/i18n/I18nContext';
import { useCallback, useEffect, useState } from 'react';
import { cardStyle, errorText, ghostButton, inputStyle, mutedText, primaryButton, rowStyle, sectionTitle } from '@/components/Architect/panelStyles';
import { STAGE_LABELS, isSystemStage } from '@/lib/architect/projects';

interface SystemProject {
  id: string;
  name: string;
  color: string;
  role: 'owner' | 'moderator' | 'member' | null;
  systemId: string;
  stage: string;
  planId: string | null;
}

interface Props {
  systemName: string;
  /** id сохранённого плана, открытого в планировщике. */
  planId: string | null;
  onNotice: (message: string) => void;
}

export default function SystemProjectsPanel({ systemName, planId, onNotice }: Props) {
  const { t } = useI18n();
  const [projects, setProjects] = useState<SystemProject[]>([]);
  const [manageable, setManageable] = useState<Array<{ id: string; name: string }>>([]);
  const [guest, setGuest] = useState(false);
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (system: string) => {
    if (!system.trim()) return;
    try {
      const response = await fetch(`/api/architect/projects?system=${encodeURIComponent(system)}`, { cache: 'no-store' });
      if (response.status === 401) {
        setGuest(true);
        setProjects([]);
        setManageable([]);
        return;
      }
      const data = await response.json().catch(() => null);
      setGuest(false);
      setProjects(Array.isArray(data?.projects) ? data.projects : []);
      setManageable(Array.isArray(data?.manageable) ? data.manageable : []);
    } catch {
      setProjects([]);
      setManageable([]);
    }
  }, []);

  useEffect(() => {
    setError('');
    setTarget('');
    void load(systemName);
  }, [systemName, load]);

  const call = async (url: string, method: string, body: unknown, message: string) => {
    setBusy(true);
    setError('');
    try {
      const response = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        setError(String(data?.error ?? t('spnl.error', { status: response.status })));
        return;
      }
      onNotice(message);
      await load(systemName);
    } finally {
      setBusy(false);
    }
  };

  if (!systemName) return null;

  return (
    <section style={cardStyle} aria-label={t('spnl.title')}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <h3 style={sectionTitle}>{t('spnl.title')}</h3>
        <Link href="/architect/projects" style={{ fontSize: 12, color: 'var(--cyan)' }}>{t('spnl.allProjects')}</Link>
      </div>
      {guest ? (
        <p style={{ ...mutedText, margin: '8px 0 0' }}>{t('spnl.login')}</p>
      ) : (
        <>
          {projects.length === 0 ? (
            <p style={{ ...mutedText, margin: '8px 0 0' }}>{t('spnl.empty')}</p>
          ) : (
            <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {projects.map((project) => {
                const manager = project.role === 'owner' || project.role === 'moderator';
                return (
                  <li key={project.id} style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ width: 9, height: 9, background: project.color, borderRadius: 2, flex: '0 0 auto' }} />
                      <Link href={`/architect/projects/${project.id}#systems`} style={{ color: 'var(--text)', fontSize: 13 }}>{project.name}</Link>
                      <span style={{ ...mutedText, marginLeft: 'auto', fontSize: 11 }}>
                        {isSystemStage(project.stage) ? t(STAGE_LABELS[project.stage]).toLowerCase() : project.stage}
                      </span>
                    </div>
                    {manager && planId && planId !== project.planId && (
                      <button
                        type="button"
                        style={{ ...ghostButton, alignSelf: 'flex-start', padding: '3px 8px' }}
                        disabled={busy}
                        onClick={() => void call(`/api/architect/projects/${project.id}/systems`, 'PATCH', { systemId: project.systemId, planId }, t('spnl.bindNotice', { name: project.name }))}
                      >
                        {t('spnl.bindPlan')}
                      </button>
                    )}
                    {project.planId && project.planId === planId && <span style={{ ...mutedText, fontSize: 11 }}>{t('spnl.isPlan')}</span>}
                  </li>
                );
              })}
            </ul>
          )}
          {manageable.length > 0 && (
            <div style={{ ...rowStyle, marginTop: 10 }}>
              <select value={target} onChange={(event) => setTarget(event.target.value)} style={{ ...inputStyle, flex: '1 1 140px', padding: '5px 8px' }} aria-label={t('spnl.selectProject')}>
                <option value="">{t('spnl.addOption')}</option>
                {manageable.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
              </select>
              <button
                type="button"
                style={primaryButton}
                disabled={busy || !target}
                onClick={() => void call(`/api/architect/projects/${target}/systems`, 'POST', { systems: [systemName] }, t('spnl.addNotice', { name: systemName }))}
              >
                {t('spnl.add')}
              </button>
            </div>
          )}
          {error && <p style={errorText}>{error}</p>}
        </>
      )}
    </section>
  );
}
